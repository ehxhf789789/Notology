//! WindowDispatcher — single source of truth for window lifecycle.
//!
//! All lifecycle events flow through [`WindowDispatcher::dispatch`].
//! The inner `Mutex<WindowMode>` serializes state transitions so that
//! concurrent events from React, OS close buttons, vault-selected
//! emits, etc. can never interleave half-way through a transition.
//!
//! The pure state machine in [`super::state`] decides the next mode
//! and the ordered list of `SideEffect`s; the dispatcher then runs
//! those effects against the real Tauri `AppHandle`. The mutex is
//! intentionally dropped before effects run so that an effect that
//! re-enters `dispatch` (rare but possible — e.g. a hover close
//! triggered by main close) doesn't deadlock.

use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Mutex;

use super::state::{transition, Event, SideEffect, WindowMode};

/// Owned, app-wide. Register via `app.manage(Arc::new(WindowDispatcher::new(...)))`
/// and retrieve via `app.state::<WindowDispatcherState>()`.
pub struct WindowDispatcher {
    mode: Mutex<WindowMode>,
    app: AppHandle,
}

impl WindowDispatcher {
    pub fn new(app: AppHandle) -> Self {
        Self {
            mode: Mutex::new(WindowMode::Splash),
            app,
        }
    }

    /// Dispatch one event. Returns once all side effects have been
    /// kicked off (which for blocking effects like `FlushSaves` means
    /// after the wait completes). Effects that fail are logged but do
    /// not abort remaining effects — partial cleanup is better than
    /// none on shutdown paths.
    pub async fn dispatch(&self, event: Event) -> Result<(), String> {
        let mut mode_guard = self.mode.lock().await;
        let current = mode_guard.clone();
        log::info!("[dispatcher] event={:?} from mode={:?}", event, current);

        let (next, effects) = transition(&current, event);
        log::info!(
            "[dispatcher] → next={:?}, {} effect(s)",
            next,
            effects.len()
        );
        *mode_guard = next;
        // Critical: release the lock BEFORE running effects. Some effects
        // (FlushSaves: emits + sleeps; TeardownSync: awaits) take time,
        // and we don't want concurrent dispatch() calls to block on the
        // mutex during that window. State has already advanced atomically.
        drop(mode_guard);

        for effect in effects {
            if let Err(e) = self.execute_effect(effect).await {
                log::warn!("[dispatcher] effect failed (continuing): {}", e);
            }
        }
        Ok(())
    }

    /// Read-only snapshot of the current mode. Useful for debugging UI
    /// and for the `get_window_mode` Tauri command (Stage C.2).
    pub async fn current_mode(&self) -> WindowMode {
        self.mode.lock().await.clone()
    }

    /// Direct mode override — bypasses [`transition`] and runs no
    /// effects. Used during the Stage A → B migration so the ad-hoc
    /// startup flow (lib.rs setup + frontend `init_library_for_vault`)
    /// can keep the dispatcher's mode in sync without re-running
    /// `ShowMain` etc. side effects that the ad-hoc code already did.
    ///
    /// Once all event sources go through `dispatch`, this method
    /// becomes redundant and can be removed (Stage B cleanup).
    pub async fn set_mode(&self, mode: WindowMode) {
        log::info!("[dispatcher] set_mode={:?}", mode);
        *self.mode.lock().await = mode;
    }

    async fn execute_effect(&self, effect: SideEffect) -> Result<(), String> {
        use SideEffect::*;
        match effect {
            ShowMain => {
                if let Some(w) = self.app.get_webview_window("main") {
                    w.show().map_err(|e| format!("show main: {}", e))?;
                    let _ = w.set_focus();
                }
                Ok(())
            }
            HideMain => {
                if let Some(w) = self.app.get_webview_window("main") {
                    w.hide().map_err(|e| format!("hide main: {}", e))?;
                }
                Ok(())
            }
            ShowSelector { return_to } => {
                // Write the return_to into SelectorContext *before* opening
                // the window. This way if the user closes immediately, the
                // CloseRequested handler sees the correct context.
                if let Some(ctx) = self.app
                    .try_state::<crate::features::connection::window::SelectorContext>()
                {
                    ctx.set_return_to(return_to);
                }
                // open_vault_selector reads SelectorContext internally for
                // its own bookkeeping; that's redundant once dispatcher is
                // canonical but harmless during the migration.
                crate::features::connection::window::open_vault_selector(self.app.clone())
                    .await
            }
            CloseSelector => {
                // Mark programmatic so the close handler treats this as
                // a self-close (no restore-main, no app-exit).
                if let Some(ctx) = self.app
                    .try_state::<crate::features::connection::window::SelectorContext>()
                {
                    ctx.mark_programmatic();
                }
                if let Some(w) = self.app.get_webview_window("vault-selector") {
                    let _ = w.close();
                }
                Ok(())
            }
            CreateHoverWithParent { label: _, parent: _ } => {
                // Hover windows are still created via the existing
                // `create_hover_window` Tauri command (called from
                // frontend's multiWindow.ts), which now sets
                // parent=main internally. This effect is a state-only
                // record — the actual window already exists by the
                // time `HoverOpenRequested` is dispatched (Stage B.5
                // wires this side; for now the effect is a no-op so
                // we don't double-create).
                Ok(())
            }
            CloseHover { label } => {
                if let Some(w) = self.app.get_webview_window(&label) {
                    let _ = w.close();
                }
                Ok(())
            }
            FlushSaves => {
                // Emit a global event for the frontend's flush-saves
                // listener (PART D.3). 200ms wait is an estimate of
                // how long dirty editors need to write to disk;
                // calibrate if data loss occurs.
                self.app
                    .emit("flush-saves", ())
                    .map_err(|e| format!("emit flush-saves: {}", e))?;
                tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                Ok(())
            }
            TeardownSync => {
                // Stop heartbeat first so it doesn't try to PUT after
                // we mark logout.
                if let Some(hb) = self.app
                    .try_state::<crate::features::sync_v2::bootstrap::HeartbeatState>()
                {
                    hb.stop();
                }
                // Mark device offline on NAS (best-effort).
                if let Some(engine_state) = self.app
                    .try_state::<crate::features::sync_v2::commands::SyncEngineState>()
                {
                    if let Some(engine) = engine_state.get() {
                        let provider = engine.provider().clone();
                        if let Ok(config_dir) = self.app.path().app_config_dir() {
                            if let Err(e) = crate::features::connection::device_registry::mark_logout(
                                &config_dir,
                                &provider,
                            )
                            .await
                            {
                                log::warn!("[dispatcher] mark_logout failed (non-fatal): {}", e);
                            }
                        }
                        // Stop the engine's polling/push tasks.
                        engine.stop_polling().await;
                    }
                }
                Ok(())
            }
            ExitApp => {
                log::info!("[dispatcher] exiting app");
                // Brief delay so any in-flight blocking close-anim or
                // logout PUT can settle before the process dies.
                tokio::time::sleep(std::time::Duration::from_millis(80)).await;
                self.app.exit(0);
                Ok(())
            }
        }
    }
}

/// Tauri state type alias. Stored as `Arc<WindowDispatcher>` so
/// effects can spawn detached tasks that own a clone of the handle.
pub type WindowDispatcherState = Arc<WindowDispatcher>;
