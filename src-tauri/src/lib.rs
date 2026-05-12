// Allow unused code for future features
#![allow(dead_code)]

pub mod core;
pub mod features;
pub mod search;
pub mod vault_lock;
mod frontmatter;
mod memo;

#[cfg(test)]
mod lib_test;

#[cfg(test)]
mod search_latency_test;

#[cfg(test)]
mod attachment_edge_cases_test;

#[cfg(test)]
mod wikilink_rename_test;

#[cfg(test)]
mod massive_rename_test;

#[cfg(test)]
mod massive_search_test;

#[cfg(test)]
mod wikilink_update_massive_test;

#[cfg(test)]
mod html_span_wikilink_test;

#[cfg(test)]
mod canvas_functionality_test;

#[cfg(test)]
mod attachment_cleanup_test;

#[cfg(test)]
mod memo_bottleneck_test;

#[cfg(test)]
mod canvas_memo_test;

#[cfg(test)]
mod indent_integration_test;

#[cfg(test)]
mod attachment_wikilink_sync_test;

// Temporarily disabled: broken imports after core::file_io refactor
// #[cfg(test)]
// mod synology_safety_test;

use std::sync::{Arc, Mutex};
use std::sync::atomic::AtomicBool;

use search::SearchIndex;
#[cfg(desktop)]
use search::watcher::VaultWatcher;
use memo::MemoIndex;
use core::library::Library;

/// Tauri managed state for the Library version control layer.
/// `None` before vault is opened or if Library init fails (graceful degradation).
pub type LibraryState = Mutex<Option<Library>>;

/// State for cancellable bulk tag operations
pub struct BulkOperationState {
    pub cancel_requested: AtomicBool,
}

pub(crate) struct SearchState {
    index: Option<Arc<SearchIndex>>,
    #[cfg(desktop)]
    _watcher: Option<VaultWatcher>,
    memo_index: Option<Arc<MemoIndex>>,
    init_in_progress: bool,
    vault_path: Option<String>,
}

// Re-export frontmatter module for features that need it
use frontmatter::FrontmatterParser;

// Frontmatter commands (kept here as they use the private frontmatter module)
#[tauri::command]
fn parse_frontmatter(content: String) -> Result<serde_json::Value, String> {
    let (frontmatter, body) = FrontmatterParser::parse(&content)?;
    Ok(serde_json::json!({
        "frontmatter": frontmatter,
        "body": body
    }))
}

#[tauri::command]
fn validate_frontmatter(frontmatter_json: String) -> Result<Vec<frontmatter::types::ValidationError>, String> {
    let fm: frontmatter::types::Frontmatter = serde_json::from_str(&frontmatter_json)
        .map_err(|e| format!("Invalid frontmatter JSON: {}", e))?;
    FrontmatterParser::validate(&fm)
}

#[tauri::command]
fn frontmatter_to_yaml(frontmatter_json: String) -> Result<String, String> {
    let fm: frontmatter::types::Frontmatter = serde_json::from_str(&frontmatter_json)
        .map_err(|e| format!("Invalid frontmatter JSON: {}", e))?;
    FrontmatterParser::to_yaml(&fm)
}

#[tauri::command]
fn yaml_to_frontmatter(yaml_str: String) -> Result<frontmatter::types::Frontmatter, String> {
    FrontmatterParser::parse_yaml(&yaml_str)
}

#[tauri::command]
fn generate_suggestions(
    frontmatter_json: String,
    all_notes_json: String,
) -> Result<Vec<frontmatter::suggestions::Suggestion>, String> {
    let fm: frontmatter::types::Frontmatter = serde_json::from_str(&frontmatter_json)
        .map_err(|e| format!("Invalid frontmatter JSON: {}", e))?;
    let all_notes: Vec<frontmatter::types::Frontmatter> = serde_json::from_str(&all_notes_json)
        .map_err(|e| format!("Invalid all_notes JSON: {}", e))?;
    let suggestions = frontmatter::suggestions::SuggestionEngine::generate_suggestions(&fm, &all_notes);
    Ok(suggestions)
}

/// Initialize the Library version control layer for a vault.
/// Called by frontend on vault open. Failure is non-fatal (graceful degradation).
/// Also bootstraps sync_v2 engine if configured (4.10).
#[tauri::command]
async fn init_library_for_vault(
    app: tauri::AppHandle,
    vault_path: String,
    library_state: tauri::State<'_, LibraryState>,
    sync_v2_state: tauri::State<'_, features::sync_v2::commands::SyncEngineState>,
    heartbeat_state: tauri::State<'_, features::sync_v2::bootstrap::HeartbeatState>,
) -> Result<(), String> {
    use features::sync_v2::bootstrap;
    use tauri::Manager;

    let path = std::path::PathBuf::from(&vault_path);

    // 0. Connection migration (v1 → unified webdav-config, runs once)
    {
        let config_dir = app.path().app_config_dir()
            .map_err(|e| format!("app_config_dir: {}", e))?;
        match features::connection::migrator::migrate_if_needed(&config_dir) {
            Ok(report) if report.migrated => {
                log::info!("[connection] migrated from {}: {} vaults simplified",
                    report.source, report.vaults_simplified);
            }
            Ok(_) => {}
            Err(e) => log::warn!("[connection] migration failed (non-fatal): {}", e),
        }
    }

    // 1. Teardown previous SyncEngine + heartbeat (vault change safety)
    bootstrap::teardown_previous_sync(&sync_v2_state, &heartbeat_state);

    // 2. Library init (sync, fast)
    let library = Library::new(&path)
        .map_err(|e| {
            log::warn!("Library init failed for {}: {}", vault_path, e);
            e
        })?;

    // 3. Legacy sync migration (best-effort)
    bootstrap::run_migration_if_needed(&path).await;

    // 3b. Vault migration: detect un-committed .md files → auto-commit to Library
    {
        use features::sync_v2::vault_migrator;
        match vault_migrator::detect(&path, &library) {
            Ok(report) if report.uncommitted_count > 0 => {
                log::info!("[vault_migrator] detected {} uncommitted notes out of {} total",
                    report.uncommitted_count, report.total_md_files);
                match vault_migrator::migrate_all(&path, &library) {
                    Ok(result) => {
                        log::info!("[vault_migrator] migration complete: {} migrated, {} skipped, {} ids created, {} errors",
                            result.migrated_count, result.skipped_count, result.id_created_count, result.errors.len());
                    }
                    Err(e) => log::error!("[vault_migrator] migration failed: {}", e),
                }
            }
            Ok(_) => log::debug!("[vault_migrator] all notes already committed"),
            Err(e) => log::warn!("[vault_migrator] detect failed: {}", e),
        }
    }

    // 3c. Reconciliation: auto-resolve local consistency issues (Q21=C startup)
    {
        use features::sync_v2::reconciliation;
        match reconciliation::scan_local(&path, &library) {
            Ok(report) if !report.all_consistent => {
                log::info!("[reconciliation] issues found: untracked={}, orphan_refs={}, trash_expired={}",
                    report.untracked_local_count, report.orphan_refs_count, report.trash_expired_count);
                match reconciliation::auto_resolve_local(&path, &library) {
                    Ok(result) => {
                        log::info!("[reconciliation] auto-resolved: committed={}, refs_cleaned={}, trash_cleaned={}",
                            result.untracked_committed, result.orphan_refs_cleaned, result.trash_cleaned);
                    }
                    Err(e) => log::warn!("[reconciliation] auto-resolve failed: {}", e),
                }
            }
            Ok(_) => log::debug!("[reconciliation] vault consistent"),
            Err(e) => log::warn!("[reconciliation] scan failed: {}", e),
        }
    }

    // 4. sync_v2 config → SyncEngine
    //    Try global WebDavConfig first, fall back to per-vault legacy credentials
    {
        let config_dir = app.path().app_config_dir()
            .map_err(|e| format!("app_config_dir: {}", e));
        if let Ok(config_dir) = config_dir {
            // Auto-create per-vault sync config if missing but global WebDavConfig exists.
            // Looks up vault discovery cache to find matching remote_path by vault name.
            {
                let existing = features::sync_v2::config::load_config(&config_dir, &path).ok();
                let needs_create = match &existing {
                    Some(c) => !c.is_complete() && !c.has_legacy_credentials(),
                    None => true,
                };
                if needs_create {
                    if let Some(wc) = features::connection::store::load(&config_dir).ok().flatten() {
                        let vault_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
                        if !vault_name.is_empty() {
                            // Look up remote_path from discovery cache
                            let remote_path = features::connection::vault_discovery::load_cache(&config_dir)
                                .and_then(|cache| cache.vaults.into_iter()
                                    .find(|v| v.name == vault_name)
                                    .map(|v| v.remote_path));
                            if let Some(remote_path) = remote_path {
                                let new_config = features::sync_v2::config::SyncV2Config {
                                    enabled: true,
                                    remote_base: remote_path.trim_end_matches('/').to_string(),
                                    url: None,
                                    username: None,
                                    password: None,
                                };
                                if let Err(e) = features::sync_v2::config::save_config(&config_dir, &path, &new_config) {
                                    log::warn!("[sync_v2 auto-config] save failed: {}", e);
                                } else {
                                    log::info!("[sync_v2 auto-config] created config for vault '{}': remote_base={}",
                                        vault_name, new_config.remote_base);
                                }
                            } else {
                                log::warn!("[sync_v2 auto-config] no matching vault in discovery cache for '{}' (NAS may need scan first)", vault_name);
                                let _ = wc; // suppress unused warning
                            }
                        }
                    }
                }
            }

            match features::sync_v2::config::load_config(&config_dir, &path) {
                // Build the engine whenever sync is *configured* (has a remote_base).
                // The runtime `sync_enabled` flag below honours `config.enabled` —
                // paused vaults still construct the engine so the UI indicator and
                // offline monitor work, but `sync_once` short-circuits and
                // push_worker idles.
                Ok(config) if config.is_complete() => {
                    // Try global WebDavConfig for credentials
                    // 1. Migrate device_id if old format (timestamp-based) → deterministic
                    // 2. mark_login: status=Online + bumped session, persist
                    let webdav_config = features::connection::store::load(&config_dir).ok().flatten()
                        .map(|mut wc| {
                            // Migrate device_id (preserve session_count, first_login_at)
                            let template = features::connection::device::collect();
                            if wc.device.device_id != template.device_id {
                                log::info!("[device] migrating device_id: {} → {}",
                                    wc.device.device_id, template.device_id);
                                wc.device.device_id = template.device_id;
                                wc.device.machine_id = template.machine_id;
                                wc.device.hostname = template.hostname;
                                wc.device.os = template.os;
                                // session_count, first_login_at, login_at preserved
                            }
                            wc.device.mark_login();
                            if let Err(e) = features::connection::store::save(&config_dir, &wc) {
                                log::warn!("[sync_v2] mark_login save failed: {}", e);
                            } else {
                                log::info!("[sync_v2] device session started: id={}, status={:?}",
                                    wc.device.device_id, wc.device.status);
                            }
                            wc
                        });

                    let engine_result = if let Some(ref wc) = webdav_config {
                        // New model: credentials from global config
                        log::info!("[sync_v2] using global WebDavConfig: url={}", wc.url);
                        bootstrap::build_with_connection(&library, &config, wc, app.clone())
                    } else if config.has_legacy_credentials() {
                        // Legacy model: credentials in per-vault config
                        log::info!("[sync_v2] using legacy per-vault credentials");
                        bootstrap::build_and_start_sync_engine(&library, &config)
                    } else {
                        Err("No WebDAV credentials available".into())
                    };

                    match engine_result {
                        Ok(engine) => {
                            // Spawn heartbeat task (10s interval, NAS last_seen_at update)
                            bootstrap::spawn_heartbeat(
                                config_dir.clone(),
                                engine.provider().clone(),
                                &heartbeat_state,
                            );
                            sync_v2_state.set(engine);
                            // Background vault discovery (M-3)
                            // Derive scan_root from remote_base parent (e.g., "/Colony/Test" → "/Colony")
                            if let Some(ref wc) = webdav_config {
                                let scan_root = config.remote_base
                                    .trim_end_matches('/')
                                    .rfind('/')
                                    .map(|i| &config.remote_base[..i])
                                    .unwrap_or("/")
                                    .to_string();
                                bootstrap::spawn_vault_discovery(
                                    config_dir.clone(), wc, scan_root, app.clone(),
                                );
                            }
                            log::info!("[sync_v2] engine + heartbeat started for vault: {}", vault_path);
                        }
                        Err(e) => {
                            log::error!("[sync_v2] start failed: {}", e);
                        }
                    }
                }
                Ok(_) => {
                    log::info!("[sync_v2] disabled or incomplete config, skipping");
                }
                Err(e) => {
                    log::warn!("[sync_v2] config load failed: {}", e);
                }
            }
        }
    }

    // 5. Register Library state (last)
    {
        let mut guard = library_state.lock()
            .map_err(|e| format!("Library state lock poisoned: {}", e))?;
        *guard = Some(library);
    }

    // 6. Sync WindowDispatcher's mode so subsequent lifecycle events
    //    (main close in particular) emit the correct effects. This is
    //    a migration shim — once Stage B is complete, the dispatcher
    //    will receive the AppStart/VaultSelected events directly and
    //    set its own mode via transition().
    if let Some(dispatcher) = app
        .try_state::<features::window_lifecycle::WindowDispatcherState>()
    {
        let d = (*dispatcher.inner()).clone();
        let vault = vault_path.clone();
        tauri::async_runtime::spawn(async move {
            d.set_mode(features::window_lifecycle::WindowMode::MainOnly {
                vault,
                hovers: vec![],
            })
            .await;
        });
    }

    log::info!("Library initialized for vault: {}", vault_path);
    Ok(())
}

/// Check if vault migration is needed.
#[tauri::command]
fn check_migration_needed(vault_path: String) -> Result<core::migration::PreMigrationReport, String> {
    core::migration::pre_migration_check(std::path::Path::new(&vault_path))
}

/// Run vault migration from v1 to v2 (CAS + DAG + Refs).
#[tauri::command]
async fn run_vault_migration(
    vault_path: String,
    app_handle: tauri::AppHandle,
    library_state: tauri::State<'_, LibraryState>,
) -> Result<core::migration::MigrationState, String> {
    use tauri::Emitter;
    let path = std::path::PathBuf::from(&vault_path);

    // Determine device_id from existing library or create new
    let device_id = {
        let guard = library_state.lock()
            .map_err(|e| format!("run_vault_migration: lock failed: {}", e))?;
        match guard.as_ref() {
            Some(lib) => lib.device_id().to_string(),
            None => {
                // Create temporary library just for device_id
                drop(guard);
                let temp_lib = Library::new(&path)
                    .map_err(|e| format!("run_vault_migration: library init for device_id failed: {}", e))?;
                temp_lib.device_id().to_string()
            }
        }
    };

    let app_clone = app_handle.clone();
    let on_progress = move |completed: usize, total: usize| {
        let _ = app_clone.emit("migration:progress", serde_json::json!({
            "completed": completed,
            "total": total,
        }));
    };

    // Check for in-progress migration (resume scenario)
    let result = match core::migration::get_migration_state(&path)? {
        Some(state) if state.status == core::migration::MigrationStatus::InProgress => {
            core::migration::resume_migration(&path, &device_id, on_progress)
        }
        _ => core::migration::run_migration(&path, &device_id, on_progress),
    };

    match result {
        Ok(final_state) => {
            if final_state.status == core::migration::MigrationStatus::Completed {
                if let Ok(library) = Library::new(&path) {
                    if let Ok(mut guard) = library_state.lock() {
                        *guard = Some(library);
                    }
                }
            }
            let _ = app_handle.emit("migration:complete", &final_state);
            Ok(final_state)
        }
        Err(e) => {
            let _ = app_handle.emit("migration:error", &e);
            Err(e)
        }
    }
}

/// Get current migration state for a vault.
#[tauri::command]
fn get_vault_migration_state(vault_path: String) -> Result<Option<core::migration::MigrationState>, String> {
    core::migration::get_migration_state(std::path::Path::new(&vault_path))
}

/// Decline migration for a vault (don't ask again).
#[tauri::command]
fn decline_vault_migration(vault_path: String) -> Result<(), String> {
    core::migration::decline_migration(std::path::Path::new(&vault_path))
}

/// Clear the Library state (e.g., on vault switch).
#[tauri::command]
fn clear_library(
    library_state: tauri::State<'_, LibraryState>,
) -> Result<(), String> {
    let mut guard = library_state.lock()
        .map_err(|e| format!("Library state lock poisoned: {}", e))?;
    *guard = None;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "windows")]
    features::system::apply_gpu_config();

    let builder = tauri::Builder::default();

    // Single-instance and updater are desktop-only
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            use tauri::Manager;
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
                let _ = window.unminimize();
            }
        }))
        .plugin(tauri_plugin_updater::Builder::new().build());

    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        // Track B Phase B-3: native drag-out (file-promise / IDataObject).
        // Powers `attachmentStartDrag` for single + multi-chip drag-out.
        .plugin(tauri_plugin_drag::init())
        .manage(Mutex::new(SearchState {
            index: None,
            #[cfg(desktop)]
            _watcher: None,
            memo_index: None,
            init_in_progress: false,
            vault_path: None,
        }))
        .manage(BulkOperationState {
            cancel_requested: AtomicBool::new(false),
        })
        .manage(features::sync_v2::commands::SyncEngineState::new())
        .manage(features::sync_v2::bootstrap::HeartbeatState::new())
        .manage(features::connection::window::SelectorContext::new())
        .manage(Mutex::new(None::<Library>) as LibraryState)
        // Stage A: WindowDispatcher will be created and managed inside
        // setup() because it needs an AppHandle. It's not pre-managed
        // here. See the .setup(...) hook below for registration.
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // Stage A: register the WindowDispatcher. It owns the
            // canonical WindowMode. Ad-hoc handlers (lib.rs's
            // on_window_event, App.tsx's "보관소 변경" useEffect, etc.)
            // continue to work during the migration; PART B wires them
            // through this dispatcher one by one.
            {
                use std::sync::Arc;
                use tauri::Manager;
                let dispatcher: features::window_lifecycle::WindowDispatcherState = Arc::new(
                    features::window_lifecycle::WindowDispatcher::new(app.handle().clone()),
                );
                app.manage(dispatcher);
            }

            // === Desktop-only setup ===
            #[cfg(desktop)]
            {
                // Close any leftover hover windows from previous session
                {
                    use tauri::Manager;
                    let windows: Vec<String> = app.webview_windows()
                        .keys()
                        .filter(|label| label.starts_with("hover-"))
                        .cloned()
                        .collect();
                    for label in &windows {
                        if let Some(win) = app.get_webview_window(label) {
                            log::info!("[setup] Closing leftover hover window: {}", label);
                            let _ = win.close();
                        }
                    }
                }

                // Timeout fallback: if frontend doesn't show main window within 5s,
                // force-show it as safety net (e.g., JS fails to load).
                // The frontend now shows NasVaultSelector inline when no vault is saved,
                // so we just need to ensure the window becomes visible.
                {
                    let app_timeout = app.handle().clone();
                    tauri::async_runtime::spawn(async move {
                        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                        if let Some(main) = tauri::Manager::get_webview_window(&app_timeout, "main") {
                            if !main.is_visible().unwrap_or(true) {
                                log::info!("[setup] Timeout: main window still hidden after 5s, force-showing");
                                let _ = main.show();
                                let _ = main.set_focus();
                            }
                        }
                    });
                }

                // Listen for vault-selected event → dispatch to lifecycle
                //
                // The event payload doesn't carry the vault path on the
                // current code path (frontend emits it but Rust-side we
                // don't read it; the canonical source is the subsequent
                // init_library_for_vault call). So we dispatch with a
                // sentinel and let init_library_for_vault sync the mode
                // afterwards. PART B.3 cleanup target: thread the vault
                // path through the payload once frontend is updated.
                {
                    use tauri::Listener;
                    let app_handle2 = app.handle().clone();
                    app.handle().listen_any("vault-selected", move |_event| {
                        log::info!("[setup] vault-selected event received");

                        if let Some(dispatcher) = tauri::Manager::try_state::<
                            features::window_lifecycle::WindowDispatcherState,
                        >(&app_handle2)
                        {
                            let d = (*dispatcher.inner()).clone();
                            tauri::async_runtime::spawn(async move {
                                // We don't have the new vault path in the
                                // event payload; use a placeholder. The
                                // mode is overwritten by
                                // init_library_for_vault::set_mode shortly
                                // after this completes. The transition
                                // here is what triggers CloseSelector +
                                // ShowMain side effects.
                                let _ = d.dispatch(
                                    features::window_lifecycle::Event::VaultSelected {
                                        vault: String::from("<pending>"),
                                    },
                                ).await;
                            });
                        }
                    });
                }

                // Set main window theme before it loads (Windows APPDATA)
                if let Some(main) = tauri::Manager::get_webview_window(app, "main") {
                    let _ = main.hide();

                    let saved_theme = {
                        let mut theme = String::from("dark");
                        if let Ok(appdata) = std::env::var("APPDATA") {
                            let p = std::path::PathBuf::from(&appdata).join("com.notology.app").join("settings.json");
                            if let Ok(content) = std::fs::read_to_string(&p) {
                                if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
                                    if let Some(t) = json.get("last_theme").and_then(|v| v.as_str()) {
                                        theme = t.to_string();
                                    }
                                }
                            }
                        }
                        theme
                    };

                    if saved_theme == "light" {
                        let _ = main.eval(&format!(
                            "document.documentElement.setAttribute('data-theme','light');\
                             document.documentElement.style.backgroundColor='#f5f5f5';\
                             document.body.style.backgroundColor='#f5f5f5';"
                        ));
                    }
                }
            }

            // === Mobile setup ===
            #[cfg(mobile)]
            {
                // On mobile, window is visible by default (no vault-selector window)
                // No desktop-only .show() call needed
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                use tauri::Manager;

                let label = window.label();

                // ── vault-selector close → dispatcher ─────────────
                // The dispatcher handles the three cases (programmatic
                // self-close / user-cancel-restore-main / startup-X-exit)
                // via the SelectorOnly transitions in state.rs. Here we
                // just filter out programmatic-flag closes (those were
                // initiated by Rust itself; no further action) and
                // forward everything else to the dispatcher.
                if label == "vault-selector" {
                    if let Some(ctx) = window.app_handle()
                        .try_state::<features::connection::window::SelectorContext>()
                    {
                        if ctx.take_programmatic_flag() {
                            log::info!("[shutdown] selector programmatic close — no-op");
                            return;
                        }
                    }

                    // User-initiated close. Block default close so the
                    // dispatcher can finish its work (restore main or
                    // exit) before the window actually goes away.
                    log::info!("[shutdown] selector user-close — dispatching");
                    api.prevent_close();

                    if let Some(dispatcher) = window.app_handle()
                        .try_state::<features::window_lifecycle::WindowDispatcherState>()
                    {
                        let d = (*dispatcher.inner()).clone();
                        tauri::async_runtime::spawn(async move {
                            let _ = d
                                .dispatch(features::window_lifecycle::Event::SelectorCloseRequested)
                                .await;
                        });
                    } else {
                        // Dispatcher missing — fallback to direct close.
                        log::error!("[shutdown] dispatcher missing — fallback close");
                        if let Some(w) = window.app_handle().get_webview_window("vault-selector") {
                            let _ = w.destroy();
                        }
                    }
                    return;
                }

                // ── hover-* close: dispatch state tracking ──
                if label != "main" {
                    log::debug!("[shutdown] window '{}' CloseRequested — letting it close", label);
                    // Dispatch HoverCloseRequested so the dispatcher
                    // removes it from MainOnly.hovers. Letting the close
                    // proceed naturally (no prevent_close) — the OS
                    // closes the window; dispatcher just updates state.
                    if label.starts_with("hover-") {
                        if let Some(dispatcher) = window.app_handle()
                            .try_state::<features::window_lifecycle::WindowDispatcherState>()
                        {
                            let d = (*dispatcher.inner()).clone();
                            let label_owned = label.to_string();
                            tauri::async_runtime::spawn(async move {
                                let _ = d
                                    .dispatch(features::window_lifecycle::Event::HoverCloseRequested {
                                        label: label_owned,
                                    })
                                    .await;
                            });
                        }
                    }
                    return;
                }

                // ── main close: dispatch to WindowDispatcher ──────
                // The dispatcher's MainCloseRequested transition emits
                // FlushSaves → CloseHover* → CloseSelector → TeardownSync
                // → ExitApp in the right order. We block the default
                // close so the dispatcher can run flush/teardown to
                // completion before app.exit() fires.
                log::info!("[shutdown] main window CloseRequested — dispatching to lifecycle");
                api.prevent_close();

                if let Some(dispatcher) = window.app_handle()
                    .try_state::<features::window_lifecycle::WindowDispatcherState>()
                {
                    let d = (*dispatcher.inner()).clone();
                    tauri::async_runtime::spawn(async move {
                        let _ = d.dispatch(features::window_lifecycle::Event::MainCloseRequested).await;
                    });
                } else {
                    // Defensive fallback: dispatcher not registered (shouldn't
                    // happen post-Stage-A). Exit directly so the user isn't stuck.
                    log::error!("[shutdown] dispatcher missing — fallback exit");
                    window.app_handle().exit(0);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            // Frontmatter commands (local to lib.rs)
            parse_frontmatter,
            validate_frontmatter,
            frontmatter_to_yaml,
            yaml_to_frontmatter,
            // Note / file commands
            features::note::read_directory,
            features::note::read_file,
            features::note::read_text_file,
            features::note::write_file,
            features::note::create_note,
            features::note::create_folder,
            features::note::ensure_directory,
            features::note::list_files_in_directory,
            features::note::move_file,
            features::note::move_note,
            features::note::check_file_exists,
            features::note::delete_file,
            features::note::delete_folder,
            features::note::import_file,
            features::note::import_attachment,
            features::note::create_note_with_template,
            features::note::delete_note,
            features::note::update_note_frontmatter,
            features::note::touch_note_modified,
            features::note::open_in_default_app,
            features::note::reveal_in_explorer,
            features::note::read_binary_file,
            // Wikilink commands
            features::wikilink::rename_file_with_links,
            features::wikilink::search_backlinks,
            // Attachment commands
            features::attachment::read_attachment_folder,
            features::attachment::search_attachments,
            features::attachment::delete_multiple_files,
            features::attachment::delete_attachments_with_links,
            features::attachment::check_attachment_references,
            // Track B Phase B-1 POC — drag-out probe (dev-only)
            features::attachment_drag::attachment_drag_poc_prepare,
            // Tag commands
            features::tags::bulk_delete_tag,
            features::tags::bulk_rename_tag,
            features::tags::bulk_add_tags,
            features::tags::cancel_bulk_operation,
            // Preview commands
            features::preview::check_preview_engine,
            features::preview::convert_to_preview_pdf,
            features::preview::cleanup_preview_cache,
            features::preview::render_hwp_to_svg,
            // Note lock commands
            features::note_lock::acquire_note_lock,
            features::note_lock::release_note_lock,
            features::note_lock::update_note_lock_heartbeat,
            features::note_lock::check_note_lock,
            // Cache commands
            features::cache::get_files_mtime,
            features::cache::get_file_mtime,
            features::cache::read_meta_cache,
            features::cache::write_meta_cache,
            features::cache::read_frontmatters_batch,
            // Comment commands
            features::comments::read_comments,
            features::comments::write_comments,
            features::comments::index_note_memos,
            features::comments::collect_calendar_memos,
            // System commands
            features::system::fetch_url_metadata,
            features::system::open_url_in_browser,
            features::system::detect_nas_platform,
            features::system::cleanup_old_backups,
            features::system::set_window_icon,
            features::system::create_hover_window,
            features::system::get_gpu_config,
            features::system::set_gpu_config,
            features::system::toggle_devtools,
            features::system::open_mobile_test_window,
            // Search commands
            features::search_commands::init_search_index,
            features::search_commands::reset_search_state,
            features::search_commands::clear_search_index,
            features::search_commands::full_text_search,
            features::search_commands::query_notes,
            features::search_commands::get_relationships,
            features::search_commands::get_graph_data,
            features::search_commands::reindex_vault,
            features::search_commands::get_all_used_tags,
            features::search_commands::get_suggestion_terms,
            features::search_commands::index_note,
            features::search_commands::remove_note_from_index,
            // Window lifecycle (Stage A)
            features::window_lifecycle::commands::dispatch_window_event,
            features::window_lifecycle::commands::get_window_mode,
            // Vault lock commands
            vault_lock::check_vault_lock,
            vault_lock::acquire_lock,
            vault_lock::release_lock,
            vault_lock::get_machine_info,
            // Schedule commands (calendar events)
            features::schedule::schedule_list,
            features::schedule::schedule_create,
            features::schedule::schedule_update,
            features::schedule::schedule_delete,
            features::schedule::schedule_get,
            // Share commands (mobile native sharing)
            features::share::share_file,
            features::share::share_text,
            // Library commands (version control)
            init_library_for_vault,
            clear_library,
            // sync_v2 commands (4.8)
            features::sync_v2::commands::sync_v2_now,
            features::sync_v2::commands::sync_v2_get_state,
            features::sync_v2::commands::sync_v2_list_conflicts,
            features::sync_v2::commands::sync_v2_resolve_conflict,
            features::sync_v2::commands::sync_v2_get_branch_content,
            // sync_v2 config commands (4.10)
            features::sync_v2::commands::sync_v2_get_config,
            features::sync_v2::commands::sync_v2_save_config,
            features::sync_v2::commands::sync_v2_test_connection,
            features::sync_v2::commands::sync_v2_apply_config,
            // sync_v2 signal + enqueue commands (3-Tier)
            features::sync_v2::commands::sync_v2_signal_visibility,
            features::sync_v2::commands::sync_v2_signal_activity,
            features::sync_v2::commands::sync_v2_get_queue_count,
            features::sync_v2::commands::sync_v2_set_realtime,
            features::sync_v2::commands::sync_v2_get_realtime,
            features::sync_v2::commands::sync_v2_scan_reconciliation,
            features::sync_v2::commands::sync_v2_auto_resolve,
            features::sync_v2::commands::sync_v2_get_global_connection,
            features::sync_v2::commands::sync_v2_cleanup_zombies,
            features::sync_v2::commands::sync_v2_check_vault_migration,
            features::sync_v2::commands::sync_v2_run_vault_migration,
            features::sync_v2::commands::sync_v2_list_trash,
            features::sync_v2::commands::sync_v2_restore_from_trash,
            features::sync_v2::commands::sync_v2_enqueue_delete,
            features::sync_v2::commands::sync_v2_enqueue_move,
            features::sync_v2::commands::sync_v2_enqueue_attachment,
            features::sync_v2::commands::sync_v2_enqueue_folder_create,
            features::sync_v2::commands::sync_v2_enqueue_folder_delete,
            // Track B Phase B-2 — attachment + migration commands
            features::sync_v2::commands::attachment_add,
            features::sync_v2::commands::attachment_delete,
            features::sync_v2::commands::attachment_link_to_note,
            features::sync_v2::commands::attachment_unlink_from_note,
            features::sync_v2::commands::attachment_list_for_note,
            features::sync_v2::commands::attachment_list_all,
            features::sync_v2::commands::attachment_local_path,
            features::sync_v2::commands::attachment_migration_status,
            features::sync_v2::commands::attachment_migration_run,
            // WebDAV auth commands (M-4a)
            features::sync_v2::commands::webdav_test_connection,
            features::sync_v2::commands::webdav_login,
            features::sync_v2::commands::webdav_logout,
            features::sync_v2::commands::webdav_get_status,
            features::connection::window::open_vault_selector,
            features::connection::window::close_vault_selector,
            features::sync_v2::commands::list_connected_devices,
            features::sync_v2::commands::delete_connected_device,
            // Vault discovery commands (M-3)
            features::sync_v2::commands::sync_v2_list_discovered_vaults,
            features::sync_v2::commands::sync_v2_refresh_vault_discovery,
            features::sync_v2::commands::sync_v2_open_vault_from_path,
            features::sync_v2::commands::sync_v2_create_vault,
            features::sync_v2::commands::remote_import_scan,
            features::sync_v2::commands::sync_v2_get_online,
            features::sync_v2::commands::sync_v2_get_enabled,
            features::sync_v2::commands::sync_v2_set_enabled,
            features::sync_v2::commands::sync_v2_browse_nas_folder,
            features::sync_v2::commands::sync_v2_rename_vault_at_path,
            features::sync_v2::commands::sync_v2_delete_vault_at_path,
            features::sync_v2::commands::sync_v2_active_vault_remote_path,
            features::sync_v2::commands::sync_v2_list_orphan_local_dirs,
            features::sync_v2::commands::sync_v2_delete_orphan_local_dirs,
            features::sync_v2::commands::sync_v2_smart_merge,
            features::sync_v2::commands::sync_v2_smart_merge_branch,
            features::sync_v2::commands::sync_v2_list_pending_nas_deletions,
            features::sync_v2::commands::sync_v2_confirm_nas_deletions_trash,
            features::sync_v2::commands::sync_v2_confirm_nas_deletions_reject,
            features::sync_v2::commands::sync_v2_purge_trash_entry,
            features::sync_v2::commands::sync_v2_purge_expired_trash,
            features::sync_v2::commands::sync_v2_cleanup_stale_refs,
            // Migration commands
            check_migration_needed,
            run_vault_migration,
            get_vault_migration_state,
            decline_vault_migration,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
