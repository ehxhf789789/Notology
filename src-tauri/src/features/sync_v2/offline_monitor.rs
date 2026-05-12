//! Periodic NAS reachability probe.
//!
//! Toggles a shared `online: AtomicBool` based on whether the provider can
//! reach the remote vault root. Two consecutive failures flip to offline; one
//! success flips back to online.
//!
//! The bool is the single source of truth shared across the engine:
//!   - PushWorker reads it to skip queueing attempts during outages
//!     (avoids retry/error log spam).
//!   - SyncEngine emits a Tauri event on each transition for the UI indicator.
//!   - On online recovery we trigger one immediate reconciliation so queued
//!     dirty operations + missing remote refs flush without the user waiting
//!     for the next adaptive_poller tick.
//!
//! Probe is `list_children(remote_base)` since every provider already
//! implements it and Synology returns quickly on a depth=1 call.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use crate::core::sync_provider::SyncProvider;

/// How often to probe NAS reachability while running.
pub const PROBE_INTERVAL: Duration = Duration::from_secs(30);

/// Per-probe timeout. Synology PROPFIND on a small dir typically <1s; 10s is
/// generous enough to absorb transient slowness without false-flagging Offline.
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(10);

/// Number of consecutive failures required before flipping Online → Offline.
/// Single-failure hysteresis would false-flag on transient packet loss.
pub const FAILURE_THRESHOLD: u32 = 2;

/// Number of consecutive successes required to flip Offline → Online.
/// One success is enough — the UI should react quickly when NAS comes back.
pub const RECOVERY_THRESHOLD: u32 = 1;

/// Outcome of one transition decision, returned to the caller so they can
/// emit events / trigger reconciliation on online-recovery.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Transition {
    /// Status unchanged.
    None,
    /// Just went offline.
    BecameOffline,
    /// Just came back online.
    BecameOnline,
}

/// Probe the provider once and update `online`. Returns the transition that
/// occurred (if any) so the caller can react.
///
/// Pure function-on-state — no spawning, no awaits beyond the probe itself —
/// so the run loop and tests can drive it identically.
pub async fn probe_and_update(
    provider: &Arc<dyn SyncProvider>,
    remote_base: &str,
    online: &AtomicBool,
    consecutive_failures: &mut u32,
    consecutive_successes: &mut u32,
) -> Transition {
    let probe = tokio::time::timeout(
        PROBE_TIMEOUT,
        provider.list_children(remote_base),
    )
    .await;
    let success = matches!(probe, Ok(Ok(_)));

    if success {
        *consecutive_failures = 0;
        *consecutive_successes = consecutive_successes.saturating_add(1);
        let was_online = online.load(Ordering::SeqCst);
        if !was_online && *consecutive_successes >= RECOVERY_THRESHOLD {
            online.store(true, Ordering::SeqCst);
            log::info!("[offline_monitor] → Online (recovered)");
            return Transition::BecameOnline;
        }
    } else {
        *consecutive_successes = 0;
        *consecutive_failures = consecutive_failures.saturating_add(1);
        let was_online = online.load(Ordering::SeqCst);
        if was_online && *consecutive_failures >= FAILURE_THRESHOLD {
            online.store(false, Ordering::SeqCst);
            log::warn!(
                "[offline_monitor] → Offline ({} consecutive probe failures)",
                *consecutive_failures
            );
            return Transition::BecameOffline;
        }
    }
    Transition::None
}

/// Long-running task: probe every PROBE_INTERVAL, update `online`, invoke
/// `on_transition` on each flip. Stops when `stop_signal` is set.
pub async fn run_monitor(
    provider: Arc<dyn SyncProvider>,
    remote_base: String,
    online: Arc<AtomicBool>,
    stop_signal: Arc<AtomicBool>,
    on_transition: impl Fn(Transition) + Send + Sync + 'static,
) {
    run_monitor_with_interval(
        provider, remote_base, online, stop_signal, PROBE_INTERVAL, on_transition,
    ).await
}

/// Same as `run_monitor` but with an injectable probe interval. Tests use a
/// short interval (e.g., 50ms) to drive the state machine deterministically
/// without sleeping the full 30 s.
pub async fn run_monitor_with_interval(
    provider: Arc<dyn SyncProvider>,
    remote_base: String,
    online: Arc<AtomicBool>,
    stop_signal: Arc<AtomicBool>,
    interval: std::time::Duration,
    on_transition: impl Fn(Transition) + Send + Sync + 'static,
) {
    log::info!(
        "[offline_monitor] task started (interval={:?}, base={})",
        interval,
        remote_base
    );

    let mut consecutive_failures: u32 = 0;
    let mut consecutive_successes: u32 = 0;

    loop {
        if stop_signal.load(Ordering::Relaxed) {
            break;
        }
        tokio::time::sleep(interval).await;
        if stop_signal.load(Ordering::Relaxed) {
            break;
        }

        let transition = probe_and_update(
            &provider,
            &remote_base,
            &online,
            &mut consecutive_failures,
            &mut consecutive_successes,
        )
        .await;

        if transition != Transition::None {
            on_transition(transition);
        }
    }

    log::info!("[offline_monitor] task stopped");
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::sync_v2::in_memory_provider::InMemorySyncProvider;

    fn online_box() -> Arc<AtomicBool> { Arc::new(AtomicBool::new(true)) }

    #[tokio::test]
    async fn online_persists_when_provider_succeeds() {
        let provider: Arc<dyn SyncProvider> = Arc::new(InMemorySyncProvider::new());
        let online = online_box();
        let mut fails = 0u32;
        let mut succs = 0u32;

        // 5 successful probes — must stay online with no transitions.
        for _ in 0..5 {
            let t = probe_and_update(&provider, "/", &online, &mut fails, &mut succs).await;
            assert_eq!(t, Transition::None);
        }
        assert!(online.load(Ordering::SeqCst));
        assert_eq!(fails, 0);
    }

    #[tokio::test]
    async fn flips_to_offline_after_failure_threshold() {
        let p = Arc::new(InMemorySyncProvider::new());
        p.partition_network();
        let provider: Arc<dyn SyncProvider> = p.clone();
        let online = online_box();
        let mut fails = 0u32;
        let mut succs = 0u32;

        // First failure: not yet at threshold.
        let t1 = probe_and_update(&provider, "/", &online, &mut fails, &mut succs).await;
        assert_eq!(t1, Transition::None);
        assert!(online.load(Ordering::SeqCst), "still online after 1 failure");
        assert_eq!(fails, 1);

        // Second failure: hits threshold, flips to offline.
        let t2 = probe_and_update(&provider, "/", &online, &mut fails, &mut succs).await;
        assert_eq!(t2, Transition::BecameOffline);
        assert!(!online.load(Ordering::SeqCst));
        assert_eq!(fails, 2);
    }

    #[tokio::test]
    async fn recovers_to_online_after_one_success() {
        let p = Arc::new(InMemorySyncProvider::new());
        p.partition_network();
        let provider: Arc<dyn SyncProvider> = p.clone();
        let online = online_box();
        let mut fails = 0u32;
        let mut succs = 0u32;

        // Drive offline.
        probe_and_update(&provider, "/", &online, &mut fails, &mut succs).await;
        let t = probe_and_update(&provider, "/", &online, &mut fails, &mut succs).await;
        assert_eq!(t, Transition::BecameOffline);

        // Heal network; next probe should recover.
        p.heal_network();
        let t = probe_and_update(&provider, "/", &online, &mut fails, &mut succs).await;
        assert_eq!(t, Transition::BecameOnline);
        assert!(online.load(Ordering::SeqCst));
        assert_eq!(succs, 1);
    }

    #[tokio::test]
    async fn single_transient_failure_does_not_flip() {
        let p = Arc::new(InMemorySyncProvider::new());
        let provider: Arc<dyn SyncProvider> = p.clone();
        let online = online_box();
        let mut fails = 0u32;
        let mut succs = 0u32;

        // succeed, fail once (transient blip), succeed — must never flip.
        probe_and_update(&provider, "/", &online, &mut fails, &mut succs).await;
        p.fail_next(crate::core::sync_provider::SyncProviderError::NetworkError("blip".into()));
        probe_and_update(&provider, "/", &online, &mut fails, &mut succs).await;
        probe_and_update(&provider, "/", &online, &mut fails, &mut succs).await;

        assert!(online.load(Ordering::SeqCst), "single failure must not flip");
    }
}
