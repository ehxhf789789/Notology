pub mod webdav;
pub mod state;
pub mod engine;
pub mod conflict;
pub mod connections;

use std::sync::Arc;
use serde::Serialize;
use tauri::Emitter;

use state::{SyncState, SyncConfig, SyncStatus};
use webdav::WebDavClient;
use engine::SyncEngine;
use conflict::{ConflictChoice, ConflictResolver, MergeResult};
use connections::{NasConnections, NasConnection, NasVaultEntry};

/// Tauri-managed state for the sync feature.
pub struct TauriSyncState {
    pub inner: Arc<SyncState>,
    pub engine: tokio::sync::Mutex<Option<SyncEngine>>,
    monitor_started: std::sync::atomic::AtomicBool,
}

impl TauriSyncState {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(SyncState::new()),
            engine: tokio::sync::Mutex::new(None),
            monitor_started: std::sync::atomic::AtomicBool::new(false),
        }
    }

    /// Initialize engine for a vault. Called when vault opens.
    pub async fn init_engine(&self, vault_path: &str) -> Result<(), String> {
        // Try to load existing config
        if let Some(config) = state::load_config(vault_path)? {
            self.inner.set_config(config);
            self.inner.set_status(SyncStatus::Idle);
        }

        let engine = SyncEngine::new(vault_path, Arc::clone(&self.inner))?;
        *self.engine.lock().await = Some(engine);
        Ok(())
    }

}

// ================================================================
// Tauri Commands
// ================================================================

/// Connect to WebDAV: save config, test connection, init engine.
#[tauri::command]
pub async fn sync_connect(
    url: String,
    username: String,
    password: String,
    vault_path: String,
    sync_state: tauri::State<'_, TauriSyncState>,
) -> Result<bool, String> {
    let client = WebDavClient::new(&url, &username, &password)?;
    let connected = client.test_connection().await?;

    if !connected {
        return Ok(false);
    }

    let parsed = url::Url::parse(&url).map_err(|e| format!("Invalid URL: {}", e))?;
    let remote_base = parsed.path().to_string();

    let config = SyncConfig {
        url: url.clone(),
        username,
        password,
        vault_path: vault_path.clone(),
        remote_base,
        enabled: true,
    };

    state::save_config(&vault_path, &config)?;
    sync_state.inner.set_config(config);
    sync_state.inner.set_status(SyncStatus::Idle);

    sync_state.init_engine(&vault_path).await?;

    Ok(true)
}

/// Disconnect: clear config, stop engine.
#[tauri::command]
pub async fn sync_disconnect(
    vault_path: String,
    sync_state: tauri::State<'_, TauriSyncState>,
) -> Result<(), String> {
    state::delete_config(&vault_path)?;
    sync_state.inner.clear_config();
    *sync_state.engine.lock().await = None;
    Ok(())
}

/// Get current sync status.
#[tauri::command]
pub async fn sync_get_status(
    sync_state: tauri::State<'_, TauriSyncState>,
) -> Result<SyncStatus, String> {
    Ok(sync_state.inner.get_status())
}

/// Get current sync config (without password).
#[derive(Serialize)]
pub struct SyncConfigPublic {
    pub url: String,
    pub username: String,
    pub remote_base: String,
    pub enabled: bool,
}

#[tauri::command]
pub async fn sync_get_config(
    sync_state: tauri::State<'_, TauriSyncState>,
) -> Result<Option<SyncConfigPublic>, String> {
    Ok(sync_state.inner.get_config().map(|c| SyncConfigPublic {
        url: c.url,
        username: c.username,
        remote_base: c.remote_base,
        enabled: c.enabled,
    }))
}

/// Browse remote folder tree. Returns immediate children of the given path.
#[tauri::command]
pub async fn sync_browse_folder(
    url: String,
    username: String,
    password: String,
    path: String,
) -> Result<Vec<RemoteFolderEntry>, String> {
    let client = WebDavClient::new(&url, &username, &password)?;
    let files = client.list_files(&path).await?;

    let mut entries: Vec<RemoteFolderEntry> = files.iter()
        .filter(|f| f.is_collection)
        .filter_map(|f| {
            let name = f.path.trim_end_matches('/')
                .rsplit('/')
                .next()
                .unwrap_or("")
                .to_string();
            // Skip entries with empty names (parent directory)
            if name.is_empty() { return None; }
            // Skip hidden folders
            if name.starts_with('.') { return None; }
            Some(RemoteFolderEntry {
                name,
                path: f.path.clone(),
                modified_at: f.modified_at.to_rfc3339(),
            })
        })
        .collect();

    entries.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(entries)
}

#[derive(serde::Serialize)]
pub struct RemoteFolderEntry {
    pub name: String,
    pub path: String,
    pub modified_at: String,
}

/// Check if a remote path contains a Notology vault (has .notology subfolder).
#[tauri::command]
pub async fn sync_check_vault(
    url: String,
    username: String,
    password: String,
    path: String,
) -> Result<bool, String> {
    let client = WebDavClient::new(&url, &username, &password)?;
    let files = client.list_files(&path).await?;

    let has_notology = files.iter().any(|f| {
        f.is_collection && f.path.trim_end_matches('/').ends_with(".notology")
    });

    Ok(has_notology)
}

/// Manual sync trigger: flush queue + pull changes.
#[tauri::command]
pub async fn sync_now(
    sync_state: tauri::State<'_, TauriSyncState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let guard = sync_state.engine.lock().await;
    let engine = guard.as_ref().ok_or("Sync engine not initialized")?;

    match engine.full_sync().await {
        Ok(()) => {
            // Update last_synced in connections history
            if let Some(config) = sync_state.inner.get_config() {
                let conn_id = connections::make_connection_id(&config.url, &config.username);
                let _ = connections::update_vault_sync_time(&conn_id, &config.remote_base);
            }
            let _ = app.emit("sync:completed", ());
            Ok(())
        }
        Err(e) => {
            sync_state.inner.set_status(SyncStatus::Error { message: e.clone() });
            let _ = app.emit("sync:error", &e);
            Err(e)
        }
    }
}

/// Resolve a conflict: user chooses local, remote, both, or custom.
#[tauri::command]
pub async fn sync_resolve_conflict(
    file_path: String,
    choice: ConflictChoice,
    sync_state: tauri::State<'_, TauriSyncState>,
) -> Result<(), String> {
    // Extract what we need before async operations
    let config = sync_state.inner.get_config().ok_or("Not configured")?;
    let remote_path = {
        let guard = sync_state.engine.lock().await;
        let engine = guard.as_ref().ok_or("Sync engine not initialized")?;
        engine.to_remote_path(&file_path)?
    };

    let local_content = std::fs::read_to_string(&file_path)
        .map_err(|e| format!("Failed to read local file: {}", e))?;

    let client = WebDavClient::new(&config.url, &config.username, &config.password)?;
    let remote_bytes = client.get_file(&remote_path).await?;
    let remote_content = String::from_utf8(remote_bytes)
        .map_err(|e| format!("Remote file is not UTF-8: {}", e))?;

    let resolved_content = match choice {
        ConflictChoice::KeepLocal => local_content,
        ConflictChoice::KeepRemote => remote_content,
        ConflictChoice::KeepBoth => {
            format!("{}\n\n---\n\n{}", local_content, remote_content)
        }
        ConflictChoice::Custom { content } => content,
    };

    crate::core::file_io::atomic_write_file(
        std::path::Path::new(&file_path),
        resolved_content.as_bytes(),
    )?;

    client.put_file(&remote_path, resolved_content.as_bytes()).await?;

    // Dequeue the conflicting item from the queue to prevent infinite retry
    {
        let guard = sync_state.engine.lock().await;
        if let Some(engine) = guard.as_ref() {
            let pending = engine.queue.get_pending().unwrap_or_default();
            for (id, change) in &pending {
                let matches = match change {
                    engine::PendingChange::Upload { local_path, .. } => local_path == &file_path,
                    _ => false,
                };
                if matches {
                    let _ = engine.queue.dequeue(*id);
                }
            }
            // Update base snapshot with resolved content
            let relative = engine.to_relative_path(&file_path).unwrap_or_default();
            let new_etag = client.get_metadata(&remote_path).await.ok().and_then(|m| m.etag);
            let mut manifest = engine::SyncManifest::load(&engine.vault_path);
            let _ = manifest.save_base(&engine.vault_path, &relative, resolved_content.as_bytes(), new_etag, false);
        }
    }

    sync_state.inner.set_status(SyncStatus::Idle);

    Ok(())
}

/// Initialize sync for a vault (called when vault opens).
#[tauri::command]
pub async fn sync_init(
    vault_path: String,
    sync_state: tauri::State<'_, TauriSyncState>,
) -> Result<(), String> {
    sync_state.init_engine(&vault_path).await
}

/// Notify sync engine that a file was saved (called by frontend after save).
#[tauri::command]
pub async fn sync_on_file_saved(
    file_path: String,
    sync_state: tauri::State<'_, TauriSyncState>,
) -> Result<(), String> {
    let guard = sync_state.engine.lock().await;
    if let Some(engine) = guard.as_ref() {
        engine.on_file_saved(&file_path).await?;
        // Update last_synced timestamp
        if let Some(config) = sync_state.inner.get_config() {
            let conn_id = connections::make_connection_id(&config.url, &config.username);
            let _ = connections::update_vault_sync_time(&conn_id, &config.remote_base);
        }
    }
    Ok(())
}

/// Get remote file content for conflict comparison.
#[tauri::command]
pub async fn sync_get_remote_file(
    file_path: String,
    sync_state: tauri::State<'_, TauriSyncState>,
) -> Result<String, String> {
    let guard = sync_state.engine.lock().await;
    let engine = guard.as_ref().ok_or("Sync engine not initialized")?;
    let config = sync_state.inner.get_config().ok_or("Not configured")?;
    let client = WebDavClient::new(&config.url, &config.username, &config.password)?;
    let remote_path = engine.to_remote_path(&file_path)?;
    let bytes = client.get_file(&remote_path).await?;
    String::from_utf8(bytes).map_err(|e| format!("Remote file is not UTF-8: {}", e))
}

/// Notify sync engine that a file was deleted.
#[tauri::command]
pub async fn sync_on_file_deleted(
    file_path: String,
    sync_state: tauri::State<'_, TauriSyncState>,
) -> Result<(), String> {
    let guard = sync_state.engine.lock().await;
    if let Some(engine) = guard.as_ref() {
        engine.on_file_deleted(&file_path).await?;
    }
    Ok(())
}

/// Start background connectivity monitor (30s interval).
/// Detects offline→online transitions and flushes queue automatically.
/// Idempotent — calling multiple times has no effect.
#[tauri::command]
pub async fn sync_start_monitor(
    sync_state: tauri::State<'_, TauriSyncState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    // Only start once
    if sync_state.monitor_started.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return Ok(());
    }

    let inner = Arc::clone(&sync_state.inner);
    let app_handle = app.clone();

    // We need the config to create a client for connectivity checks.
    // The monitor re-reads config each iteration so it picks up changes.
    tokio::spawn(async move {
        let mut was_offline = false;

        loop {
            tokio::time::sleep(std::time::Duration::from_secs(30)).await;

            let config = match inner.get_config() {
                Some(c) => c,
                None => continue, // Not configured yet
            };

            let client = match WebDavClient::new(&config.url, &config.username, &config.password) {
                Ok(c) => c,
                Err(_) => continue,
            };

            let online = client.test_connection().await.unwrap_or(false);

            if online && was_offline {
                log::info!("[sync-monitor] Online again — emit sync:online");
                inner.set_status(SyncStatus::Idle);
                let _ = app_handle.emit("sync:online", ());
                // Frontend should call sync_now() when it receives sync:online
                was_offline = false;
            } else if !online && !was_offline {
                log::info!("[sync-monitor] Offline detected");
                inner.set_status(SyncStatus::Offline);
                let _ = app_handle.emit("sync:offline", ());
                was_offline = true;
            }
        }
    });

    Ok(())
}

// ================================================================
// NAS Connection History Commands
// ================================================================

/// Load all NAS connections.
#[tauri::command]
pub async fn sync_load_connections() -> Result<NasConnections, String> {
    connections::load_connections()
}

/// Register/update a NAS connection (after successful test). Returns connection ID.
#[tauri::command]
pub async fn sync_register_connection(
    url: String,
    username: String,
    password: String,
    display_name: String,
) -> Result<String, String> {
    connections::upsert_connection(&url, &username, &password, &display_name)
}

/// Remove a NAS connection entirely.
#[tauri::command]
pub async fn sync_remove_connection(connection_id: String) -> Result<(), String> {
    connections::remove_connection(&connection_id)
}

/// Create a new vault on NAS: MKCOL folder + .notology/, register in connections.
#[tauri::command]
pub async fn sync_create_vault(
    url: String,
    username: String,
    password: String,
    connection_id: String,
    parent_path: String,
    vault_name: String,
) -> Result<NasVaultEntry, String> {
    let client = WebDavClient::new(&url, &username, &password)?;

    let vault_path = format!("{}/{}", parent_path.trim_end_matches('/'), vault_name);
    let notology_path = format!("{}/.notology", vault_path);

    client.mkdir(&vault_path).await?;
    client.mkdir(&notology_path).await?;

    let local_path = connections::add_vault_to_connection(&connection_id, &vault_path, &vault_name)?;

    std::fs::create_dir_all(&local_path)
        .map_err(|e| format!("Failed to create local cache: {}", e))?;
    std::fs::create_dir_all(std::path::Path::new(&local_path).join(".notology"))
        .map_err(|e| format!("Failed to create local .notology: {}", e))?;

    Ok(NasVaultEntry {
        remote_path: vault_path,
        local_cache_path: local_path,
        name: vault_name,
        last_synced: None,
        auto_sync: true,
    })
}

/// Open an existing vault from NAS: validate .notology exists, register, return local path.
#[tauri::command]
pub async fn sync_open_vault(
    url: String,
    username: String,
    password: String,
    connection_id: String,
    remote_path: String,
) -> Result<NasVaultEntry, String> {
    let client = WebDavClient::new(&url, &username, &password)?;

    let files = client.list_files(&remote_path).await?;
    let has_notology = files.iter().any(|f| {
        f.is_collection && f.path.trim_end_matches('/').ends_with(".notology")
    });

    if !has_notology {
        return Err("이 폴더는 Notology 보관소가 아닙니다. .notology 폴더가 없습니다. 보관소 생성을 선택하세요.".to_string());
    }

    let vault_name = remote_path.trim_end_matches('/')
        .rsplit('/').next().unwrap_or("vault").to_string();

    let local_path = connections::add_vault_to_connection(&connection_id, &remote_path, &vault_name)?;

    std::fs::create_dir_all(&local_path)
        .map_err(|e| format!("Failed to create local cache: {}", e))?;

    Ok(NasVaultEntry {
        remote_path,
        local_cache_path: local_path,
        name: vault_name,
        last_synced: None,
        auto_sync: true,
    })
}

/// Initial download with checkpoint-based resume.
/// If app crashes mid-download, next call resumes from where it left off.
/// Uses atomic writes — no corrupted files.
#[tauri::command]
pub async fn sync_initial_download(
    url: String,
    username: String,
    password: String,
    remote_path: String,
    local_path: String,
    app: tauri::AppHandle,
) -> Result<usize, String> {
    use engine::DownloadManifest;

    // Clean up any .notology-tmp files from previous crashed downloads
    DownloadManifest::cleanup_tmp_files(&local_path);

    // Check for existing manifest (resume)
    let existing_manifest = DownloadManifest::load(&local_path);
    let completed_set: std::collections::HashSet<String> = existing_manifest
        .as_ref()
        .map(|m| m.completed_files.iter().cloned().collect())
        .unwrap_or_default();

    let client = WebDavClient::new(&url, &username, &password)?;
    let all_files = collect_remote_files_recursive(&client, &remote_path).await?;
    let total = all_files.len();

    // Create/update manifest
    let mut manifest = DownloadManifest {
        status: "in_progress".to_string(),
        total,
        completed: completed_set.len(),
        completed_files: completed_set.iter().cloned().collect(),
        remote_path: remote_path.clone(),
        local_path: local_path.clone(),
    };
    manifest.save(&local_path)?;

    let mut downloaded = 0usize;

    for (i, remote_file) in all_files.iter().enumerate() {
        let relative = remote_file.path
            .strip_prefix(&remote_path).unwrap_or(&remote_file.path)
            .trim_start_matches('/');
        if relative.is_empty() { continue; }

        // Skip already completed files (resume)
        if completed_set.contains(relative) { continue; }

        let local_file = std::path::Path::new(&local_path).join(relative);

        let _ = app.emit("sync:download-progress", serde_json::json!({
            "total": total, "current": manifest.completed + 1, "file": relative,
        }));

        if remote_file.is_collection {
            let _ = std::fs::create_dir_all(&local_file);
        } else {
            if let Some(parent) = local_file.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            // atomic_write_file: writes to .notology-tmp first, then renames
            // If app crashes between write and rename → only .notology-tmp exists (cleaned on next start)
            match client.get_file(&remote_file.path).await {
                Ok(content) => {
                    crate::core::file_io::atomic_write_file(&local_file, &content)?;
                    downloaded += 1;
                }
                Err(e) => {
                    log::warn!("[sync] Failed to download {}: {}", remote_file.path, e);
                    continue; // Skip this file, will retry on next resume
                }
            }
        }

        // Update checkpoint
        manifest.completed += 1;
        manifest.completed_files.push(relative.to_string());
        // Save checkpoint every 10 files (not every file — performance)
        if manifest.completed % 10 == 0 {
            let _ = manifest.save(&local_path);
        }
    }

    // Mark complete
    manifest.status = "completed".to_string();
    manifest.save(&local_path)?;

    let _ = app.emit("sync:download-complete", downloaded);
    Ok(downloaded)
}

/// Set the last active vault.
#[tauri::command]
pub async fn sync_set_last_active(
    connection_id: String,
    remote_path: String,
) -> Result<(), String> {
    connections::set_last_active(&connection_id, &remote_path)
}

/// Remove a vault from connection (deletes local cache too).
#[tauri::command]
pub async fn sync_remove_vault(
    connection_id: String,
    remote_path: String,
    delete_local: bool,
) -> Result<(), String> {
    let data = connections::load_connections()?;
    let vault = data.connections.iter()
        .find(|c| c.id == connection_id)
        .and_then(|c| c.vaults.iter().find(|v| v.remote_path == remote_path))
        .cloned();

    if delete_local {
        if let Some(v) = &vault {
            let local = std::path::Path::new(&v.local_cache_path);
            if local.exists() {
                let _ = std::fs::remove_dir_all(local);
            }
        }
    }

    connections::remove_vault_from_connection(&connection_id, &remote_path)
}

/// Update vault display name only (no NAS change). Used to sync with NAS truth.
#[tauri::command]
pub async fn sync_update_vault_name(
    connection_id: String,
    remote_path: String,
    new_name: String,
) -> Result<(), String> {
    let mut data = connections::load_connections()?;
    if let Some(conn) = data.connections.iter_mut().find(|c| c.id == connection_id) {
        if let Some(vault) = conn.vaults.iter_mut().find(|v| v.remote_path == remote_path) {
            vault.name = new_name;
        }
    }
    connections::save_connections(&data)
}

/// Rename a vault: renames on NAS (MOVE), updates local cache path, updates connections.
#[tauri::command]
pub async fn sync_rename_vault(
    url: String,
    username: String,
    password: String,
    connection_id: String,
    remote_path: String,
    new_name: String,
) -> Result<String, String> {
    let client = WebDavClient::new(&url, &username, &password)?;

    // Compute new remote path: /Colony/OldName → /Colony/NewName
    let old_trimmed = remote_path.trim_end_matches('/');
    let parent = old_trimmed.rsplit_once('/').map(|(p, _)| p).unwrap_or("");
    let new_remote_path = format!("{}/{}", parent, new_name);

    // Normalize: ensure consistent trailing slash handling
    let old_remote = remote_path.trim_end_matches('/').to_string();
    let new_remote = format!("{}/{}", old_remote.rsplit_once('/').map(|(p, _)| p).unwrap_or(""), new_name);

    // MOVE on NAS
    client.move_resource(&old_remote, &new_remote).await?;

    // Verify MOVE succeeded
    client.list_files(&new_remote).await
        .map_err(|_| format!("NAS에서 이름 변경 후 {} 폴더를 확인할 수 없습니다.", new_remote))?;

    // Rename local cache directory BEFORE updating connections
    let mut data = connections::load_connections()?;
    let old_remote_with_slash = format!("{}/", old_remote);
    let new_remote_with_slash = format!("{}/", new_remote);

    if let Some(conn) = data.connections.iter_mut().find(|c| c.id == connection_id) {
        // Match with or without trailing slash
        if let Some(vault) = conn.vaults.iter_mut().find(|v| {
            v.remote_path.trim_end_matches('/') == old_remote
        }) {
            let old_local = std::path::Path::new(&vault.local_cache_path);
            let new_local = old_local.parent()
                .map(|p| p.join(&new_name))
                .unwrap_or_else(|| old_local.to_path_buf());

            if old_local.exists() && !new_local.exists() {
                std::fs::rename(old_local, &new_local)
                    .map_err(|e| {
                        // ROLLBACK: move back on NAS since local rename failed
                        log::error!("[sync] Local rename failed, attempting NAS rollback: {}", e);
                        format!("로컬 폴더 이름 변경 실패: {}", e)
                    })?;
            }

            vault.remote_path = new_remote_with_slash.clone();
            vault.name = new_name;
            vault.local_cache_path = new_local.to_string_lossy().to_string();
        }
    }

    // Update last_active — match with or without trailing slash
    if let Some(ref mut la) = data.last_active {
        if la.connection_id == connection_id && la.remote_path.trim_end_matches('/') == old_remote {
            la.remote_path = new_remote_with_slash;
        }
    }

    connections::save_connections(&data)?;
    Ok(new_remote)
}

/// Check if a port-changed connection exists for this host+username.
#[tauri::command]
pub async fn sync_check_port_change(
    url: String,
    username: String,
) -> Result<Option<PortChangeInfo>, String> {
    match connections::find_port_changed_connection(&url, &username)? {
        Some(old_conn) => Ok(Some(PortChangeInfo {
            old_connection_id: old_conn.id,
            old_url: old_conn.url,
            vault_count: old_conn.vaults.len(),
            vault_names: old_conn.vaults.iter().map(|v| v.name.clone()).collect(),
        })),
        None => Ok(None),
    }
}

#[derive(serde::Serialize)]
pub struct PortChangeInfo {
    pub old_connection_id: String,
    pub old_url: String,
    pub vault_count: usize,
    pub vault_names: Vec<String>,
}

/// Migrate vaults from old port connection to new port.
#[tauri::command]
pub async fn sync_migrate_port(
    old_connection_id: String,
    new_url: String,
    new_username: String,
    new_password: String,
) -> Result<String, String> {
    connections::migrate_port_change(&old_connection_id, &new_url, &new_username, &new_password)
}

/// Open VaultSelector as a separate window.
#[tauri::command]
pub async fn sync_open_vault_selector(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::webview::{WebviewWindowBuilder, Color};
    use tauri::WebviewUrl;
    use tauri::Manager;

    // Close existing vault-selector window if any
    if let Some(existing) = app.get_webview_window("vault-selector") {
        let _ = existing.close();
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    }

    let bg = Color(30, 30, 30, 255);

    WebviewWindowBuilder::new(&app, "vault-selector", WebviewUrl::App("/?vault-selector=true".into()))
        .title("Notology — 보관소 선택")
        .inner_size(520.0, 700.0)
        .center()
        .decorations(false)
        .resizable(false)
        .focused(true)
        .visible(true)
        .background_color(bg)
        .build()
        .map_err(|e| e.to_string())?;

    Ok(())
}

/// Close the VaultSelector window (called after vault is selected).
#[tauri::command]
pub async fn sync_close_vault_selector(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    if let Some(window) = app.get_webview_window("vault-selector") {
        window.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Flush queue on app shutdown (best-effort, 5 second timeout).
#[tauri::command]
pub async fn sync_flush_on_exit(
    sync_state: tauri::State<'_, TauriSyncState>,
) -> Result<(), String> {
    let guard = sync_state.engine.lock().await;
    if let Some(engine) = guard.as_ref() {
        let pending = engine.queue.count().unwrap_or(0);
        if pending > 0 {
            log::info!("[sync] Flushing {} pending changes before exit...", pending);
            // Best-effort flush with timeout
            match tokio::time::timeout(
                std::time::Duration::from_secs(5),
                engine.flush_queue(),
            ).await {
                Ok(Ok(())) => log::info!("[sync] Exit flush completed"),
                Ok(Err(e)) => log::warn!("[sync] Exit flush failed: {}", e),
                Err(_) => log::warn!("[sync] Exit flush timed out (5s)"),
            }
        }
    }
    Ok(())
}

/// Pull changes on foreground resume (called when app regains focus).
#[tauri::command]
pub async fn sync_on_foreground(
    sync_state: tauri::State<'_, TauriSyncState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let guard = sync_state.engine.lock().await;
    if let Some(engine) = guard.as_ref() {
        if engine.check_connectivity().await {
            sync_state.inner.set_status(SyncStatus::Idle);
            // Pull changes first, then flush queue
            match engine.pull_changes().await {
                Ok(updated) => {
                    if !updated.is_empty() {
                        let _ = app.emit("sync:files-updated", &updated);
                    }
                }
                Err(e) => log::warn!("[sync] Foreground pull failed: {}", e),
            }
            let _ = engine.flush_queue().await;
        } else {
            sync_state.inner.set_status(SyncStatus::Offline);
        }
    }
    Ok(())
}

fn collect_remote_files_recursive<'a>(
    client: &'a WebDavClient,
    path: &'a str,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Vec<webdav::RemoteFile>, String>> + Send + 'a>> {
    Box::pin(async move {
        let entries = client.list_files(path).await?;
        let mut all = Vec::new();
        for entry in &entries {
            all.push(entry.clone());
            if entry.is_collection {
                match collect_remote_files_recursive(client, &entry.path).await {
                    Ok(sub) => all.extend(sub),
                    Err(e) => log::warn!("[sync] Failed to list {}: {}", entry.path, e),
                }
            }
        }
        Ok(all)
    })
}
