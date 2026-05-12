//! SyncEngine bootstrap: create, start, and teardown sync engine lifecycle.
//! Used by init_library_for_vault (lib.rs) and sync_v2_apply_config (commands.rs).

use std::path::Path;
use std::sync::Arc;

use tokio::sync::Notify;

use crate::core::library::Library;
use crate::core::sync_provider::SyncProvider;
use crate::features::sync_v2::commands::SyncEngineState;
use crate::features::sync_v2::config::SyncV2Config;
use crate::features::sync_v2::migration_manager::MigrationManager;
use crate::features::sync_v2::sync_engine::SyncEngine;
use crate::features::sync_v2::webdav_provider::WebDavProvider;
use crate::core::webdav::WebDavClient;

/// Managed state for heartbeat task lifecycle. Shared stop signal allows
/// vault-transition teardown and app-shutdown logout.
pub struct HeartbeatState {
    stop: std::sync::Mutex<Option<Arc<Notify>>>,
}

impl HeartbeatState {
    pub fn new() -> Self { Self { stop: std::sync::Mutex::new(None) } }

    /// Signal the running heartbeat task to stop.
    pub fn stop(&self) {
        if let Some(notify) = self.stop.lock().unwrap_or_else(|e| e.into_inner()).take() {
            notify.notify_one();
        }
    }

    fn set(&self, notify: Arc<Notify>) {
        *self.stop.lock().unwrap_or_else(|e| e.into_inner()) = Some(notify);
    }
}

/// Stop and clear previous SyncEngine + heartbeat task (vault change safety).
pub fn teardown_previous_sync(state: &SyncEngineState, heartbeat: &HeartbeatState) {
    // Stop heartbeat first
    heartbeat.stop();

    if let Some(engine) = state.get() {
        let engine_clone = engine.clone();
        tokio::spawn(async move {
            engine_clone.stop_polling().await;
        });
        log::info!("[sync_v2] previous engine stop signaled");
    }
    state.clear();
}

/// Run legacy sync migration if needed. Best-effort, never blocks vault open.
pub async fn run_migration_if_needed(vault_path: &Path) {
    let mgr = MigrationManager::new(vault_path);
    match mgr.migrate().await {
        Ok(status) => match &status {
            crate::features::sync_v2::migration_manager::MigrationStatus::Migrated { .. } =>
                log::info!("[sync_v2] legacy migrated to .sync.legacy/"),
            crate::features::sync_v2::migration_manager::MigrationStatus::NoLegacy |
            crate::features::sync_v2::migration_manager::MigrationStatus::Cleaned => {}
            other => log::debug!("[sync_v2] migration status: {:?}", other),
        }
        Err(e) => log::warn!("[sync_v2] migration error: {}", e),
    }
}

/// Spawn a 10-second heartbeat task that updates last_seen_at on NAS.
/// Returns immediately; the task runs until `HeartbeatState::stop()` is called.
pub fn spawn_heartbeat(
    config_dir: std::path::PathBuf,
    provider: Arc<dyn SyncProvider>,
    heartbeat_state: &HeartbeatState,
) {
    let stop = Arc::new(Notify::new());
    heartbeat_state.set(stop.clone());

    tokio::spawn(async move {
        log::info!("[heartbeat] task started (10s interval)");
        loop {
            tokio::select! {
                _ = stop.notified() => {
                    log::info!("[heartbeat] stop signal received");
                    break;
                }
                _ = tokio::time::sleep(std::time::Duration::from_secs(10)) => {
                    match crate::features::connection::device_registry::heartbeat(
                        &config_dir, &provider,
                    ).await {
                        Ok(_) => log::debug!("[heartbeat] tick → NAS updated"),
                        Err(e) => log::warn!("[heartbeat] failed (non-fatal): {}", e),
                    }
                }
            }
        }
    });
}

/// Build SyncEngine using global WebDavConfig + per-vault SyncV2Config.
pub fn build_with_connection(
    library: &Library,
    config: &SyncV2Config,
    webdav: &crate::features::connection::store::WebDavConfig,
    app: tauri::AppHandle,
) -> Result<Arc<SyncEngine>, String> {
    log::info!("[sync_v2 bootstrap] building engine (connection model): url={}, remote_base={}, device={}",
        webdav.url, config.remote_base, library.device_id());
    let client = WebDavClient::new(&webdav.url, &webdav.username, &webdav.password)
        .map_err(|e| format!("WebDAV client: {}", e))?;
    let provider: Arc<dyn SyncProvider> = Arc::new(
        WebDavProvider::new(client, config.remote_base.clone()),
    );

    let engine = SyncEngine::new(
        library.device_id().to_string(),
        provider,
        library.arc_cas(),
        library.arc_refs(),
        library.vault_path().to_path_buf(),
    );
    // Honor the persisted user toggle. Paused vaults still build the engine
    // (so offline_monitor + heartbeat keep the indicator accurate), they just
    // don't push or pull until the user resumes.
    engine.set_sync_enabled(config.enabled);
    let engine_arc = Arc::new(engine);

    // Inject AppHandle so background sync cycles can emit
    // `sync-v2:report` to the frontend.
    {
        let e = Arc::clone(&engine_arc);
        let app_for_handle = app.clone();
        tauri::async_runtime::spawn(async move {
            e.set_app_handle(app_for_handle).await;
        });
    }

    // Configure the remote base + spawn offline_monitor BEFORE starting 3-Tier
    // so push_worker sees a meaningful online flag from cycle one.
    let engine_for_setup = Arc::clone(&engine_arc);
    let remote_base = config.remote_base.clone();
    let app_for_monitor = app.clone();
    tokio::spawn(async move {
        engine_for_setup.set_remote_base(remote_base).await;
        let app = app_for_monitor;
        let engine_for_recovery = Arc::clone(&engine_for_setup);
        engine_for_setup.spawn_offline_monitor(move |t| {
            use crate::features::sync_v2::offline_monitor::Transition;
            use tauri::Emitter;
            match t {
                Transition::BecameOffline => {
                    let _ = app.emit("sync-v2:online-changed", false);
                }
                Transition::BecameOnline => {
                    let _ = app.emit("sync-v2:online-changed", true);
                    // Flush queued operations + pull missed remote refs —
                    // but only if the user hasn't paused this vault. If
                    // paused, sync_once short-circuits anyway, so skipping
                    // the trigger just avoids a useless task spawn.
                    if engine_for_recovery.is_sync_enabled() {
                        engine_for_recovery.trigger_reconciliation_now();
                    }
                }
                Transition::None => {}
            }
        }).await;
    });

    let engine_for_start = Arc::clone(&engine_arc);
    tokio::spawn(async move {
        engine_for_start.start_3tier().await;
    });

    // Register device on NAS (Q-M2-4=A: each vault entry) + orphan cleanup
    let provider_for_register = engine_arc.provider().clone();
    let device_info = webdav.device.clone();
    tokio::spawn(async move {
        if let Err(e) = crate::features::connection::device_registry::register_device(
            &device_info, &provider_for_register,
        ).await {
            log::warn!("[bootstrap] device register failed (non-fatal): {}", e);
        }
        // Clean orphan device.json (same PC, old device_id) — best-effort
        if let Err(e) = crate::features::connection::orphan_cleaner::clean_orphans(
            &provider_for_register, &device_info,
        ).await {
            log::debug!("[bootstrap] orphan cleanup non-fatal: {}", e);
        }
    });

    Ok(engine_arc)
}

/// Spawn background vault discovery scan after first login.
/// Non-blocking, emits `vault-discovery:updated` event when done.
/// `scan_root`: parent directory to scan (e.g., "/Colony" derived from remote_base "/Colony/Test").
pub fn spawn_vault_discovery(
    config_dir: std::path::PathBuf,
    webdav: &crate::features::connection::store::WebDavConfig,
    scan_root: String,
    app: tauri::AppHandle,
) {
    let url = webdav.url.clone();
    let username = webdav.username.clone();
    let password = webdav.password.clone();

    tokio::spawn(async move {
        let scan_root = &scan_root;

        let client = match WebDavClient::new(&url, &username, &password) {
            Ok(c) => c,
            Err(e) => {
                log::warn!("[vault_discovery] background scan failed: {}", e);
                return;
            }
        };
        let provider: Arc<dyn SyncProvider> = Arc::new(
            WebDavProvider::new(client, String::new()),
        );

        match crate::features::connection::vault_discovery::refresh_with_cache(
            &config_dir, &provider, &url, scan_root,
        ).await {
            Ok(cache) => {
                use tauri::Emitter;
                log::info!("[vault_discovery] background scan complete: {} vaults", cache.vaults.len());
                let _ = app.emit("vault-discovery:updated", &cache);
            }
            Err(e) => {
                log::warn!("[vault_discovery] background scan failed: {}", e);
            }
        }
    });
}

/// Build SyncEngine from Library + config (legacy: credentials in per-vault config).
pub fn build_and_start_sync_engine(
    library: &Library,
    config: &SyncV2Config,
) -> Result<Arc<SyncEngine>, String> {
    // Try to get credentials from per-vault config (legacy) or fallback
    let url = config.url.as_deref().unwrap_or("").to_string();
    let username = config.username.as_deref().unwrap_or("").to_string();
    let password = config.password.as_deref().unwrap_or("").to_string();

    if url.is_empty() || username.is_empty() || password.is_empty() {
        return Err("WebDAV credentials not available (use build_with_connection instead)".into());
    }

    log::info!("[sync_v2 bootstrap] building engine: url={}, remote_base={}, device={}",
        url, config.remote_base, library.device_id());
    let client = WebDavClient::new(&url, &username, &password)
        .map_err(|e| format!("WebDAV client: {}", e))?;
    let provider: Arc<dyn SyncProvider> = Arc::new(
        WebDavProvider::new(client, config.remote_base.clone()),
    );

    let engine = SyncEngine::new(
        library.device_id().to_string(),
        provider,
        library.arc_cas(),
        library.arc_refs(),
        library.vault_path().to_path_buf(),
    );
    engine.set_sync_enabled(config.enabled);
    let engine_arc = Arc::new(engine);
    // Start 3-Tier sync architecture (Tier 1 push + Tier 2 poll + Tier 3 reconciliation)
    let engine_for_start = Arc::clone(&engine_arc);
    tokio::spawn(async move {
        engine_for_start.start_3tier().await;
    });
    Ok(engine_arc)
}
