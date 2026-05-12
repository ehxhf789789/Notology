//! Tier 2 Adaptive Poller: detect remote changes with variable interval.
//! Realtime (1.5s) → Active (5s) → Idle (60s) → Background (120s).
//! Triggers Tier 3 full reconciliation on remote change detection.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use chrono::{DateTime, Utc};
use tokio::sync::RwLock;

use crate::core::sync_provider::SyncProvider;

const REALTIME_INTERVAL_MS: u64 = 1500;
const ACTIVE_INTERVAL_MS: u64 = 5000;
const IDLE_INTERVAL_SECS: u64 = 60;
const BACKGROUND_INTERVAL_SECS: u64 = 120;
const IDLE_THRESHOLD_SECS: u64 = 300; // 5 minutes

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum PollerMode {
    Realtime,
    Active,
    Idle,
    Background,
}

impl PollerMode {
    pub fn interval(&self) -> Duration {
        match self {
            Self::Realtime => Duration::from_millis(REALTIME_INTERVAL_MS),
            Self::Active => Duration::from_millis(ACTIVE_INTERVAL_MS),
            Self::Idle => Duration::from_secs(IDLE_INTERVAL_SECS),
            Self::Background => Duration::from_secs(BACKGROUND_INTERVAL_SECS),
        }
    }
}

pub struct AdaptivePoller {
    provider: Arc<dyn SyncProvider>,
    device_id: String,
    mode: RwLock<PollerMode>,
    is_visible: AtomicBool,
    realtime_enabled: AtomicBool,
    last_activity: RwLock<Instant>,
    last_remote_states: RwLock<HashMap<String, DateTime<Utc>>>,
    stop_signal: Arc<AtomicBool>,
    /// Called when remote changes detected — triggers Tier 3.
    on_remote_change: Box<dyn Fn() + Send + Sync>,
}

impl AdaptivePoller {
    pub fn new(
        provider: Arc<dyn SyncProvider>,
        device_id: String,
        stop_signal: Arc<AtomicBool>,
        on_remote_change: impl Fn() + Send + Sync + 'static,
    ) -> Self {
        Self {
            provider,
            device_id,
            mode: RwLock::new(PollerMode::Active),
            is_visible: AtomicBool::new(true),
            realtime_enabled: AtomicBool::new(false),
            last_activity: RwLock::new(Instant::now()),
            last_remote_states: RwLock::new(HashMap::new()),
            stop_signal,
            on_remote_change: Box::new(on_remote_change),
        }
    }

    /// Start the adaptive polling loop. Call inside tokio::spawn.
    pub async fn run(self: Arc<Self>) {
        log::info!("[adaptive_poller] started (mode=Active)");
        loop {
            if self.stop_signal.load(Ordering::Relaxed) { break; }

            let interval = {
                let mode = self.mode.read().await;
                mode.interval()
            };
            tokio::time::sleep(interval).await;
            if self.stop_signal.load(Ordering::Relaxed) { break; }

            // Auto-transition Active → Idle
            self.update_mode().await;

            // Check remote changes
            let poller = Arc::clone(&self);
            match tokio::spawn(async move { poller.check_remote_changes().await }).await {
                Ok(Ok(true)) => {
                    log::info!("[adaptive_poller] remote change detected, triggering reconciliation");
                    (self.on_remote_change)();
                }
                Ok(Ok(false)) => {
                    log::debug!("[adaptive_poller] no remote changes");
                }
                Ok(Err(e)) => {
                    log::warn!("[adaptive_poller] check failed: {}", e);
                }
                Err(e) => {
                    log::error!("[adaptive_poller] check PANICKED: {:?}", e);
                }
            }
        }
        log::info!("[adaptive_poller] stopped");
    }

    /// Signal user activity → switch to Active (or Realtime if enabled).
    pub async fn signal_activity(&self) {
        *self.last_activity.write().await = Instant::now();
        let new_mode = self.foreground_mode();
        let mut mode = self.mode.write().await;
        if *mode != new_mode && *mode != PollerMode::Background {
            log::debug!("[adaptive_poller] → {:?} (user activity)", new_mode);
            *mode = new_mode;
        }
    }

    /// Signal app visibility change.
    pub async fn signal_visibility(&self, visible: bool) {
        self.is_visible.store(visible, Ordering::Relaxed);
        let mut mode = self.mode.write().await;
        if visible {
            *self.last_activity.write().await = Instant::now();
            let new_mode = self.foreground_mode();
            log::info!("[adaptive_poller] → {:?} (foreground)", new_mode);
            *mode = new_mode;
        } else {
            log::info!("[adaptive_poller] → Background (hidden)");
            *mode = PollerMode::Background;
        }
    }

    /// Enable/disable realtime mode.
    pub fn set_realtime_enabled(&self, enabled: bool) {
        self.realtime_enabled.store(enabled, Ordering::Relaxed);
        log::info!("[adaptive_poller] realtime_enabled={}", enabled);
    }

    pub fn realtime_enabled(&self) -> bool {
        self.realtime_enabled.load(Ordering::Relaxed)
    }

    pub async fn current_mode(&self) -> PollerMode {
        *self.mode.read().await
    }

    /// Determine the correct foreground mode based on realtime setting.
    fn foreground_mode(&self) -> PollerMode {
        if self.realtime_enabled.load(Ordering::Relaxed) {
            PollerMode::Realtime
        } else {
            PollerMode::Active
        }
    }

    async fn update_mode(&self) {
        if !self.is_visible.load(Ordering::Relaxed) { return; }
        let elapsed = self.last_activity.read().await.elapsed();
        let mut mode = self.mode.write().await;
        let fg = self.foreground_mode();
        // Only transition fg → Idle if not realtime and idle threshold exceeded
        if (*mode == PollerMode::Active || *mode == PollerMode::Realtime)
            && !self.realtime_enabled.load(Ordering::Relaxed)
            && elapsed > Duration::from_secs(IDLE_THRESHOLD_SECS)
        {
            log::info!("[adaptive_poller] → Idle ({}s inactive)", elapsed.as_secs());
            *mode = PollerMode::Idle;
        }
        // If realtime enabled but mode is Active/Idle, switch to Realtime
        if self.realtime_enabled.load(Ordering::Relaxed)
            && (*mode == PollerMode::Active || *mode == PollerMode::Idle)
        {
            log::info!("[adaptive_poller] → Realtime (realtime enabled)");
            *mode = PollerMode::Realtime;
        }
    }

    async fn check_remote_changes(&self) -> Result<bool, String> {
        let states = self.provider.list_device_states().await
            .map_err(|e| format!("list_device_states: {}", e))?;

        let mut prev = self.last_remote_states.write().await;
        let mut changed = false;

        for info in &states {
            // Skip our own device
            if info.device_id == self.device_id { continue; }

            match prev.get(&info.device_id) {
                Some(prev_modified) if *prev_modified == info.last_modified => {}
                _ => {
                    log::debug!("[adaptive_poller] device {} state changed", info.device_id);
                    changed = true;
                }
            }
            prev.insert(info.device_id.clone(), info.last_modified);
        }

        Ok(changed)
    }
}
