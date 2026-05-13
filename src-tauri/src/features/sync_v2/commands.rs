//! Tauri commands exposing SyncEngine to frontend.
//!
//! All commands require SyncEngineState to be initialized (4.10 handles init).
//! Before init, commands return "Sync engine not initialized" error.

use std::sync::{Arc, Mutex};
use tauri::Emitter;
use crate::features::sync_v2::sync_engine::{SyncEngine, SyncState, SyncReport};
use crate::features::sync_v2::branch_manager::NoteWithConflicts;
use crate::features::sync_v2::config::SyncV2Config;
use crate::LibraryState;

const ERR_NOT_INIT: &str = "Sync engine not initialized. Select a vault first.";

/// Tauri-managed state for SyncEngine. None until vault is selected (4.10).
pub struct SyncEngineState(pub Mutex<Option<Arc<SyncEngine>>>);

impl SyncEngineState {
    pub fn new() -> Self { Self(Mutex::new(None)) }

    pub fn get(&self) -> Option<Arc<SyncEngine>> {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    pub fn set(&self, engine: Arc<SyncEngine>) {
        *self.0.lock().unwrap_or_else(|e| e.into_inner()) = Some(engine);
    }

    pub fn clear(&self) {
        *self.0.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }
}

impl Default for SyncEngineState {
    fn default() -> Self { Self::new() }
}

fn engine(state: &SyncEngineState) -> Result<Arc<SyncEngine>, String> {
    state.get().ok_or_else(|| ERR_NOT_INIT.to_string())
}

/// Manually trigger one sync cycle.
#[tauri::command]
pub async fn sync_v2_now(
    state: tauri::State<'_, SyncEngineState>,
) -> Result<SyncReport, String> {
    engine(&state)?.sync_once().await
}

/// Get current sync state.
#[tauri::command]
pub async fn sync_v2_get_state(
    state: tauri::State<'_, SyncEngineState>,
) -> Result<SyncState, String> {
    Ok(engine(&state)?.state().await)
}

/// List all unresolved conflicts.
#[tauri::command]
pub async fn sync_v2_list_conflicts(
    state: tauri::State<'_, SyncEngineState>,
) -> Result<Vec<NoteWithConflicts>, String> {
    engine(&state)?.list_conflicts().await
}

/// Resolve a conflict by picking a branch.
#[tauri::command]
pub async fn sync_v2_resolve_conflict(
    note_id: String,
    branch_id: String,
    state: tauri::State<'_, SyncEngineState>,
) -> Result<(), String> {
    engine(&state)?.resolve_conflict(&note_id, &branch_id).await
}

/// Get raw content of a branch for preview.
#[tauri::command]
pub async fn sync_v2_get_branch_content(
    note_id: String,
    branch_id: String,
    state: tauri::State<'_, SyncEngineState>,
) -> Result<String, String> {
    let eng = engine(&state)?;
    let conflicts = eng.list_conflicts().await?;
    let note = conflicts.iter()
        .find(|n| n.note_id == note_id)
        .ok_or_else(|| format!("Note {} not in conflicts", note_id))?;
    let branch = note.branches.iter()
        .find(|b| b.branch_id == branch_id)
        .ok_or_else(|| format!("Branch {} not found", branch_id))?;
    let bytes = eng.cas_store().read_object(&branch.head_hash)
        .map_err(|e| format!("Read content: {}", e))?
        .ok_or_else(|| format!("Content {} not in CAS", branch.head_hash))?;
    String::from_utf8(bytes).map_err(|e| format!("Not UTF-8: {}", e))
}

// ── Config commands (4.10) ───────────────────────────────

fn get_vault_path(library_state: &LibraryState) -> Result<std::path::PathBuf, String> {
    let guard = library_state.lock().unwrap_or_else(|e| e.into_inner());
    let library = guard.as_ref().ok_or("Library not initialized")?;
    Ok(library.vault_path().to_path_buf())
}

fn get_config_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    use tauri::Manager;
    app.path().app_config_dir().map_err(|e| format!("app_config_dir: {}", e))
}

#[tauri::command]
pub fn sync_v2_get_config(
    app: tauri::AppHandle,
    library_state: tauri::State<'_, LibraryState>,
) -> Result<SyncV2Config, String> {
    let vault_path = get_vault_path(&library_state)?;
    let config_dir = get_config_dir(&app)?;
    crate::features::sync_v2::config::load_config(&config_dir, &vault_path)
}

#[tauri::command]
pub fn sync_v2_save_config(
    app: tauri::AppHandle,
    library_state: tauri::State<'_, LibraryState>,
    config: SyncV2Config,
) -> Result<(), String> {
    let vault_path = get_vault_path(&library_state)?;
    let config_dir = get_config_dir(&app)?;
    crate::features::sync_v2::config::save_config(&config_dir, &vault_path, &config)
}

#[tauri::command]
pub async fn sync_v2_test_connection(
    url: String,
    username: String,
    password: String,
    remote_base: String,
) -> Result<(), String> {
    use crate::core::sync_provider::SyncProvider;
    use crate::features::sync_v2::webdav_provider::WebDavProvider;
    use crate::core::webdav::WebDavClient;

    let client = WebDavClient::new(&url, &username, &password)
        .map_err(|e| format!("WebDAV client init failed: {}", e))?;
    let provider = WebDavProvider::new(client, remote_base);
    provider.test_connection().await
        .map_err(|e| format!("Connection test failed: {}", e))?
        .then_some(())
        .ok_or_else(|| "Connection test returned false".to_string())
}

/// Re-create SyncEngine after config change. Called by frontend after save.
#[tauri::command]
pub async fn sync_v2_apply_config(
    app: tauri::AppHandle,
    library_state: tauri::State<'_, LibraryState>,
    sync_v2_state: tauri::State<'_, SyncEngineState>,
    heartbeat_state: tauri::State<'_, crate::features::sync_v2::bootstrap::HeartbeatState>,
) -> Result<(), String> {
    use crate::features::sync_v2::bootstrap;

    // Teardown current engine + heartbeat
    bootstrap::teardown_previous_sync(&sync_v2_state, &heartbeat_state);

    // Get vault path from library
    let vault_path = get_vault_path(&library_state)?;

    // Load config
    let config_dir = get_config_dir(&app)?;
    let config = crate::features::sync_v2::config::load_config(&config_dir, &vault_path)
        .unwrap_or_default();

    if config.enabled && config.is_complete() {
        // Need Library ref for building engine — get it from state
        let guard = library_state.lock().unwrap_or_else(|e| e.into_inner());
        let library = guard.as_ref().ok_or("Library not initialized")?;
        let engine = bootstrap::build_and_start_sync_engine(library, &config)?;
        sync_v2_state.set(engine);
        log::info!("[sync_v2] engine restarted after config change");
    } else {
        log::info!("[sync_v2] disabled or incomplete after config change");
    }

    Ok(())
}

// ── Signal commands (3-Tier Tier 2) ─────────────────────

#[tauri::command]
pub async fn sync_v2_signal_visibility(
    visible: bool,
    state: tauri::State<'_, SyncEngineState>,
) -> Result<(), String> {
    if let Some(engine) = state.get() {
        engine.signal_visibility(visible).await;

        // On focus return, trigger one immediate reconciliation so incoming
        // changes from other devices appear without waiting for the next
        // adaptive_poller tick. Skip while offline — the upcoming online
        // recovery transition will trigger its own flush.
        if visible && engine.is_online() {
            engine.trigger_reconciliation_now();
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn sync_v2_signal_activity(
    state: tauri::State<'_, SyncEngineState>,
) -> Result<(), String> {
    if let Some(engine) = state.get() {
        engine.signal_activity().await;
    }
    Ok(())
}

#[tauri::command]
pub fn sync_v2_get_queue_count(
    state: tauri::State<'_, SyncEngineState>,
) -> Result<usize, String> {
    Ok(state.get().map(|e| e.queue_count()).unwrap_or(0))
}

#[tauri::command]
pub async fn sync_v2_set_realtime(
    enabled: bool,
    state: tauri::State<'_, SyncEngineState>,
) -> Result<(), String> {
    if let Some(engine) = state.get() {
        engine.set_realtime_enabled(enabled).await;
    }
    Ok(())
}

#[tauri::command]
pub async fn sync_v2_get_realtime(
    state: tauri::State<'_, SyncEngineState>,
) -> Result<bool, String> {
    Ok(match state.get() {
        Some(engine) => engine.realtime_enabled().await,
        None => false,
    })
}

// ── Reconciliation commands ─────────────────────────────

#[tauri::command]
pub fn sync_v2_scan_reconciliation(
    library_state: tauri::State<'_, LibraryState>,
) -> Result<crate::features::sync_v2::reconciliation::ReconciliationReport, String> {
    let guard = library_state.lock().unwrap_or_else(|e| e.into_inner());
    let library = guard.as_ref().ok_or("Library not initialized")?;
    crate::features::sync_v2::reconciliation::scan_local(library.vault_path(), library)
}

#[tauri::command]
pub fn sync_v2_auto_resolve(
    library_state: tauri::State<'_, LibraryState>,
) -> Result<crate::features::sync_v2::reconciliation::AutoResolveResult, String> {
    let guard = library_state.lock().unwrap_or_else(|e| e.into_inner());
    let library = guard.as_ref().ok_or("Library not initialized")?;
    crate::features::sync_v2::reconciliation::auto_resolve_local(library.vault_path(), library)
}

// ── Global connection info ──────────────────────────────

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalConnectionInfo {
    url: String,
    username: String,
    password: String,
    label: String,
}

#[tauri::command]
pub fn sync_v2_get_global_connection(
    app: tauri::AppHandle,
) -> Result<Option<GlobalConnectionInfo>, String> {
    use tauri::Manager;
    let config_dir = app.path().app_config_dir().map_err(|e| format!("app_config_dir: {}", e))?;
    match crate::features::connection::store::load(&config_dir)? {
        Some(wc) => Ok(Some(GlobalConnectionInfo {
            url: wc.url,
            username: wc.username,
            password: wc.password,
            label: wc.label,
        })),
        None => Ok(None),
    }
}

// ── NAS reconciliation (K-Pre: zombie cleanup) ─────────

#[tauri::command]
pub async fn sync_v2_cleanup_zombies(
    library_state: tauri::State<'_, LibraryState>,
    state: tauri::State<'_, SyncEngineState>,
) -> Result<ZombieCleanupReport, String> {
    let engine = state.get().ok_or("Sync engine not initialized")?;

    let (vault_path, refs) = {
        let guard = library_state.lock().unwrap_or_else(|e| e.into_inner());
        let lib = guard.as_ref().ok_or("Library not initialized")?;
        (lib.vault_path().to_path_buf(), lib.refs().list().unwrap_or_default())
    };

    let mut report = ZombieCleanupReport::default();

    for note_ref in &refs {
        // Check if .md exists on NAS
        let normalized = note_ref.relative_path.replace('\\', "/");
        match engine.provider().has_md(&normalized).await {
            Ok(true) => { /* .md exists on NAS, all good */ }
            Ok(false) => {
                // NAS .md missing → zombie. Clean up.
                log::info!("[zombie_cleanup] NAS .md missing for {}: {}", note_ref.note_id, normalized);

                // Move local .md to trash (if it exists locally)
                let local_path = vault_path.join(&note_ref.relative_path);
                if local_path.exists() {
                    match crate::features::sync_v2::trash::move_to_trash(
                        &vault_path, &local_path, &note_ref.note_id, &normalized,
                    ) {
                        Ok(_) => {
                            log::info!("[zombie_cleanup] trashed local: {}", normalized);
                            // Clean up empty parent directory (not vault root, not .notology, not _att)
                            if let Some(parent) = local_path.parent() {
                                if parent != vault_path
                                    && parent.is_dir()
                                    && !parent.file_name().unwrap_or_default().to_string_lossy().starts_with('.')
                                    && !parent.file_name().unwrap_or_default().to_string_lossy().ends_with("_att")
                                {
                                    if let Ok(mut entries) = std::fs::read_dir(parent) {
                                        if entries.next().is_none() {
                                            let _ = std::fs::remove_dir(parent);
                                            log::info!("[zombie_cleanup] removed empty dir: {:?}", parent);
                                        }
                                    }
                                }
                            }
                        }
                        Err(e) => {
                            log::warn!("[zombie_cleanup] trash failed, deleting: {}", e);
                            let _ = std::fs::remove_file(&local_path);
                        }
                    }
                }

                // Delete local ref
                {
                    let guard = library_state.lock().unwrap_or_else(|e| e.into_inner());
                    if let Some(lib) = guard.as_ref() {
                        let _ = lib.refs().delete(&note_ref.note_id);
                    }
                }

                // Delete NAS ref (orphan cleanup)
                let _ = engine.provider().delete_ref(&note_ref.note_id).await;

                report.zombies_cleaned += 1;
                report.cleaned_notes.push(normalized);
            }
            Err(e) => {
                log::warn!("[zombie_cleanup] has_md check failed for {}: {}", note_ref.note_id, e);
                report.errors.push(format!("{}: {}", note_ref.note_id, e));
            }
        }
    }

    log::info!("[zombie_cleanup] complete: {} zombies cleaned, {} errors",
        report.zombies_cleaned, report.errors.len());

    Ok(report)
}

#[derive(Debug, Clone, serde::Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ZombieCleanupReport {
    pub zombies_cleaned: usize,
    pub cleaned_notes: Vec<String>,
    pub errors: Vec<String>,
}

// ── Vault migration commands ────────────────────────────

#[tauri::command]
pub fn sync_v2_check_vault_migration(
    library_state: tauri::State<'_, LibraryState>,
) -> Result<Option<crate::features::sync_v2::vault_migrator::MigrationReport>, String> {
    let guard = library_state.lock().unwrap_or_else(|e| e.into_inner());
    let library = guard.as_ref().ok_or("Library not initialized")?;
    let report = crate::features::sync_v2::vault_migrator::detect(library.vault_path(), library)?;
    if report.uncommitted_count > 0 {
        Ok(Some(report))
    } else {
        Ok(None)
    }
}

#[tauri::command]
pub fn sync_v2_run_vault_migration(
    library_state: tauri::State<'_, LibraryState>,
) -> Result<crate::features::sync_v2::vault_migrator::MigrationResult, String> {
    let guard = library_state.lock().unwrap_or_else(|e| e.into_inner());
    let library = guard.as_ref().ok_or("Library not initialized")?;
    crate::features::sync_v2::vault_migrator::migrate_all(library.vault_path(), library)
}

// ── Trash commands ──────────────────────────────────────

#[tauri::command]
pub fn sync_v2_list_trash(
    library_state: tauri::State<'_, LibraryState>,
) -> Result<Vec<crate::features::sync_v2::trash::TrashEntry>, String> {
    let guard = library_state.lock().unwrap_or_else(|e| e.into_inner());
    let library = guard.as_ref().ok_or("Library not initialized")?;
    crate::features::sync_v2::trash::list_trash(library.vault_path())
}

#[tauri::command]
pub fn sync_v2_restore_from_trash(
    note_id: String,
    library_state: tauri::State<'_, LibraryState>,
    state: tauri::State<'_, SyncEngineState>,
) -> Result<(), String> {
    let guard = library_state.lock().unwrap_or_else(|e| e.into_inner());
    let library = guard.as_ref().ok_or("Library not initialized")?;
    let entry = crate::features::sync_v2::trash::restore_from_trash(library.vault_path(), &note_id)?;

    // Re-commit to library + enqueue push
    let restored_path = library.vault_path().join(&entry.original_path);
    if let Ok(content) = std::fs::read(&restored_path) {
        let rel = entry.original_path.replace('\\', "/");
        match library.commit_version(&entry.note_id, &content, &rel, vec![]) {
            Ok(Some(hash)) => {
                log::info!("[trash restore] committed: {} -> {}", entry.note_id, &hash[..16]);
                if let Some(engine) = state.get() {
                    engine.enqueue_dirty(DirtyOperation::NoteUpsert {
                        note_id: entry.note_id.clone(),
                        relative_path: rel,
                    });
                }
            }
            Ok(None) => log::debug!("[trash restore] unchanged: {}", entry.note_id),
            Err(e) => log::warn!("[trash restore] commit failed: {} - {}", entry.note_id, e),
        }
    }

    Ok(())
}

// ── Enqueue commands (3-Tier Tier 1) ────────────────────

use crate::features::sync_v2::dirty_queue::DirtyOperation;

#[tauri::command]
pub fn sync_v2_enqueue_delete(
    path: String,
    library_state: tauri::State<'_, LibraryState>,
    state: tauri::State<'_, SyncEngineState>,
) -> Result<(), String> {
    let note_id = extract_note_id_from_path(&path, &library_state)?;
    let relative = compute_relative(&path, &library_state)?;
    if let Some(engine) = state.get() {
        engine.enqueue_dirty(DirtyOperation::NoteDelete { note_id, relative_path: relative });
    }
    Ok(())
}

#[tauri::command]
pub fn sync_v2_enqueue_move(
    old_path: String,
    new_path: String,
    library_state: tauri::State<'_, LibraryState>,
    state: tauri::State<'_, SyncEngineState>,
) -> Result<(), String> {
    let note_id = extract_note_id_from_path(&new_path, &library_state)?;
    let old_rel = compute_relative(&old_path, &library_state)?;
    let new_rel = compute_relative(&new_path, &library_state)?;
    if let Some(engine) = state.get() {
        engine.enqueue_dirty(DirtyOperation::NoteMove {
            note_id, old_path: old_rel, new_path: new_rel,
        });
    }
    Ok(())
}

#[tauri::command]
pub fn sync_v2_enqueue_attachment(
    path: String,
    library_state: tauri::State<'_, LibraryState>,
    state: tauri::State<'_, SyncEngineState>,
) -> Result<(), String> {
    let relative = compute_relative(&path, &library_state)?;
    if let Some(engine) = state.get() {
        engine.enqueue_dirty(DirtyOperation::AttachmentUpsert { relative_path: relative });
    }
    Ok(())
}

// ── Track B Phase B-2: Attachment commands ──────────────────────────────────

/// DTO of `AttachmentRef` for frontend consumption (camelCase). Mirrors the
/// Rust struct field-for-field; serde rename keeps the wire format ergonomic.
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentRefDto {
    pub attachment_id: String,
    pub original_name: String,
    pub mime_type: String,
    pub size_bytes: u64,
    pub sha256: String,
    pub tier: String,
    pub display_path: String,
    pub linked_notes: Vec<String>,
    pub sync_etag: Option<String>,
}

impl From<crate::features::sync_v2::attachment_types::AttachmentRef> for AttachmentRefDto {
    fn from(r: crate::features::sync_v2::attachment_types::AttachmentRef) -> Self {
        Self {
            attachment_id: r.attachment_id,
            original_name: r.original_name,
            mime_type: r.mime_type,
            size_bytes: r.size_bytes,
            sha256: r.sha256,
            tier: serde_json::to_string(&r.tier)
                .unwrap_or_else(|_| "\"other\"".into())
                .trim_matches('"')
                .to_string(),
            display_path: r.display_path,
            linked_notes: r.linked_notes,
            sync_etag: r.sync_etag,
        }
    }
}

fn require_vault(library_state: &LibraryState) -> Result<std::path::PathBuf, String> {
    let guard = library_state.lock().unwrap_or_else(|e| e.into_inner());
    let library = guard.as_ref().ok_or("Library not initialized")?;
    Ok(library.vault_path().to_path_buf())
}

/// Import a file as an attachment for a note. Routes to Fast or Slow lane
/// based on size (threshold = 100 MB per HanBin 2026-05-12).
///
/// Accepts either `notePath` (absolute path to the .md file — preferred for
/// frontend callers since drag-drop already knows the path) **or** `noteId`
/// (the 14-digit frontmatter id — preferred for backend callers). At least
/// one must be supplied; `notePath` is read first to extract the id.
#[tauri::command]
pub async fn attachment_add(
    app: tauri::AppHandle,
    source_path: String,
    note_path: Option<String>,
    note_id: Option<String>,
    library_state: tauri::State<'_, LibraryState>,
    sync_state: tauri::State<'_, SyncEngineState>,
) -> Result<AttachmentRefDto, String> {
    let vault = require_vault(&library_state)?;
    let src = std::path::Path::new(&source_path);
    let name = src
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| "invalid source file name".to_string())?
        .to_string();

    // Resolve note_id: caller may pass either directly, or supply notePath
    // and we extract from frontmatter. Falls back to filename stem if the
    // .md file has no id (matches extract_note_id_from_path semantics).
    let resolved_note_id = match (note_id, note_path.as_deref()) {
        (Some(id), _) => id,
        (None, Some(path)) => extract_note_id_from_path(path, &library_state)?,
        (None, None) => {
            return Err("attachment_add requires note_path or note_id".to_string());
        }
    };

    let mut store =
        crate::features::sync_v2::attachment_store::AttachmentStore::new(vault)?;
    let outcome = store.add_attachment(src, &name, &resolved_note_id)?;
    let r = outcome.attachment_ref;

    // Enqueue for sync. Lane chosen by size (Fast <100 MB, Slow ≥100 MB).
    let lane = crate::features::sync_v2::attachment_sync::lane_for_size(r.size_bytes);
    if let Some(engine) = sync_state.get() {
        let relative = format!(".notology/attachments/refs/{}.json", r.attachment_id);
        engine.enqueue_dirty_with_lane(
            DirtyOperation::AttachmentUpsert { relative_path: relative },
            lane,
        );
        log::info!(
            "[attachment_add] enqueued {} ({} bytes, lane={:?})",
            r.attachment_id, r.size_bytes, lane
        );
    } else {
        log::warn!(
            "[attachment_add] sync engine not active — attachment {} added locally but not enqueued",
            r.attachment_id
        );
    }

    let dto: AttachmentRefDto = r.into();
    // Track B Phase B-3 hotfix (2026-05-13): emit a *global* Tauri event so
    // every open webview (main + hover windows) can refresh its
    // attachmentStore. The frontend wrapper's `EventBus.emit` only fires
    // in the JS context that initiated the drop — if the user closed that
    // window before `attachment_add` resolved, no other webview ever heard
    // about the new ref, and chip in a freshly-opened hover stayed gray.
    let _ = app.emit("attachment:saved", &dto);
    Ok(dto)
}

/// Delete an attachment by id. Removes ref + display + (orphan) blob locally
/// and enqueues a NAS delete.
#[tauri::command]
pub async fn attachment_delete(
    app: tauri::AppHandle,
    attachment_id: String,
    library_state: tauri::State<'_, LibraryState>,
    sync_state: tauri::State<'_, SyncEngineState>,
) -> Result<(), String> {
    let vault = require_vault(&library_state)?;
    let mut store =
        crate::features::sync_v2::attachment_store::AttachmentStore::new(vault)?;

    // Snapshot size before delete so we can lane-route correctly.
    let lane = store
        .get_by_id(&attachment_id)
        .map(|r| crate::features::sync_v2::attachment_sync::lane_for_size(r.size_bytes))
        .unwrap_or(crate::features::sync_v2::dirty_queue::Lane::Fast);

    store.delete_attachment(&attachment_id)?;

    if let Some(engine) = sync_state.get() {
        let relative = format!(".notology/attachments/refs/{}.json", attachment_id);
        engine.enqueue_dirty_with_lane(
            DirtyOperation::AttachmentDelete { relative_path: relative },
            lane,
        );
    }
    let _ = app.emit("attachment:deleted", &attachment_id);
    Ok(())
}

#[tauri::command]
pub async fn attachment_link_to_note(
    attachment_id: String,
    note_id: String,
    library_state: tauri::State<'_, LibraryState>,
    sync_state: tauri::State<'_, SyncEngineState>,
) -> Result<(), String> {
    let vault = require_vault(&library_state)?;
    let mut store =
        crate::features::sync_v2::attachment_store::AttachmentStore::new(vault)?;
    store.link_to_note(&attachment_id, &note_id)?;
    if let Some(engine) = sync_state.get() {
        let relative = format!(".notology/attachments/refs/{}.json", attachment_id);
        engine.enqueue_dirty(DirtyOperation::AttachmentUpsert { relative_path: relative });
    }
    Ok(())
}

#[tauri::command]
pub async fn attachment_unlink_from_note(
    attachment_id: String,
    note_id: String,
    library_state: tauri::State<'_, LibraryState>,
    sync_state: tauri::State<'_, SyncEngineState>,
) -> Result<(), String> {
    let vault = require_vault(&library_state)?;
    let mut store =
        crate::features::sync_v2::attachment_store::AttachmentStore::new(vault)?;
    store.unlink_from_note(&attachment_id, &note_id)?;
    if let Some(engine) = sync_state.get() {
        let relative = format!(".notology/attachments/refs/{}.json", attachment_id);
        engine.enqueue_dirty(DirtyOperation::AttachmentUpsert { relative_path: relative });
    }
    Ok(())
}

#[tauri::command]
pub async fn attachment_list_for_note(
    note_id: String,
    library_state: tauri::State<'_, LibraryState>,
) -> Result<Vec<AttachmentRefDto>, String> {
    let vault = require_vault(&library_state)?;
    let store = crate::features::sync_v2::attachment_store::AttachmentStore::new(vault)?;
    Ok(store
        .list_for_note(&note_id)
        .into_iter()
        .cloned()
        .map(Into::into)
        .collect())
}

/// Track B Phase B-3: return every AttachmentRef in the vault so the frontend
/// can build a name→id index (wikilink resolver) and power the redesigned
/// Attachments tab (no more `_att/` folder walking).
#[tauri::command]
pub async fn attachment_list_all(
    library_state: tauri::State<'_, LibraryState>,
) -> Result<Vec<AttachmentRefDto>, String> {
    let vault = require_vault(&library_state)?;
    let store = crate::features::sync_v2::attachment_store::AttachmentStore::new(vault)?;
    Ok(store.all_refs().cloned().map(Into::into).collect())
}

/// Track B Phase B-3: resolve an attachment_id to a user-droppable absolute
/// path for `startDrag`.
///
/// Returns `vault/.attachments/<display_name>` when present — that hardlink
/// preserves the original filename and extension, so when the user drops
/// onto Explorer / KakaoTalk / etc. the OS copies the file under a
/// meaningful name (`Report.pdf`, not the sha256 `7da354a9....`).
///
/// Falls back to the raw CAS blob path only when the display hardlink is
/// missing (rare — happens for a pull-only state where the local
/// `.attachments/` rebuild hasn't run yet). The OS still copies the bytes
/// correctly; only the destination filename is degraded in that edge case.
#[tauri::command]
pub async fn attachment_local_path(
    attachment_id: String,
    library_state: tauri::State<'_, LibraryState>,
) -> Result<String, String> {
    let vault = require_vault(&library_state)?;
    let store = crate::features::sync_v2::attachment_store::AttachmentStore::new(vault.clone())?;
    let r = store
        .get_by_id(&attachment_id)
        .ok_or_else(|| format!("attachment_id {} not found", attachment_id))?;

    // Preferred: `.attachments/<display>` (hardlink → CAS blob, but with
    // user-friendly filename + extension).
    let display_abs = vault.join(&r.display_path);
    if display_abs.is_file() {
        return Ok(display_abs.to_string_lossy().to_string());
    }

    // Fallback: raw CAS blob (sha256-named — produces "7da354a9..." on drop).
    let blob = store
        .find_by_sha(&r.sha256)
        .ok_or_else(|| format!("blob for sha {} missing", r.sha256))?;
    if !blob.local_path.is_file() {
        return Err(format!("blob file does not exist locally: {:?}", blob.local_path));
    }
    log::warn!(
        "[attachment_local_path] display hardlink missing for {}, falling back to CAS blob (name will be sha256)",
        attachment_id
    );
    Ok(blob.local_path.to_string_lossy().to_string())
}

#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MigrationStatusDto {
    pub needs_migration: bool,
}

#[tauri::command]
pub async fn attachment_migration_status(
    library_state: tauri::State<'_, LibraryState>,
) -> Result<MigrationStatusDto, String> {
    let vault = require_vault(&library_state)?;
    let m = crate::features::sync_v2::attachment_migration::AttachmentMigration::new(vault);
    Ok(MigrationStatusDto {
        needs_migration: m.needs_migration()?,
    })
}

#[tauri::command]
pub async fn attachment_migration_run(
    library_state: tauri::State<'_, LibraryState>,
) -> Result<crate::features::sync_v2::attachment_migration::MigrationReport, String> {
    let vault = require_vault(&library_state)?;
    let mut m = crate::features::sync_v2::attachment_migration::AttachmentMigration::new(vault);
    m.run()
}

#[tauri::command]
pub fn sync_v2_enqueue_folder_create(
    path: String,
    library_state: tauri::State<'_, LibraryState>,
    state: tauri::State<'_, SyncEngineState>,
) -> Result<(), String> {
    let relative = compute_relative(&path, &library_state)?;
    if let Some(engine) = state.get() {
        engine.enqueue_dirty(DirtyOperation::FolderCreate { relative_path: relative });
    }
    Ok(())
}

#[tauri::command]
pub fn sync_v2_enqueue_folder_delete(
    path: String,
    library_state: tauri::State<'_, LibraryState>,
    state: tauri::State<'_, SyncEngineState>,
) -> Result<(), String> {
    let relative = compute_relative(&path, &library_state)?;
    if let Some(engine) = state.get() {
        engine.enqueue_dirty(DirtyOperation::FolderDelete { relative_path: relative });
    }
    Ok(())
}

// ── Helpers ─────────────────────────────────────────────

fn extract_note_id_from_path(path: &str, library_state: &LibraryState) -> Result<String, String> {
    // Read note_id from the .md file's frontmatter
    if let Ok(content) = std::fs::read_to_string(path) {
        if let Some(id) = crate::core::note_id::read_id_from_content(&content) {
            return Ok(id);
        }
    }
    // Fallback: use filename stem as ID approximation
    let stem = std::path::Path::new(path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("unknown");
    Ok(stem.to_string())
}

fn compute_relative(path: &str, library_state: &LibraryState) -> Result<String, String> {
    let guard = library_state.lock().unwrap_or_else(|e| e.into_inner());
    let library = guard.as_ref().ok_or("Library not initialized")?;
    let vault_root = library.vault_path();
    let abs = std::path::Path::new(path);
    let relative = abs.strip_prefix(vault_root)
        .map_err(|_| format!("path {} not in vault {:?}", path, vault_root))?;
    relative.to_str()
        .map(|s| s.replace('\\', "/"))
        .ok_or_else(|| "path not UTF-8".into())
}

// ── WebDAV auth commands (M-4a) ────────────────────────

#[tauri::command]
pub async fn webdav_test_connection(
    url: String,
    username: String,
    password: String,
) -> Result<crate::features::connection::auth::ConnectionTestResult, String> {
    crate::features::connection::auth::test_connection(&url, &username, &password).await
}

#[tauri::command]
pub async fn webdav_login(
    app: tauri::AppHandle,
    url: String,
    username: String,
    password: String,
    label: String,
    remember_password: bool,
) -> Result<crate::features::connection::device::DeviceInfo, String> {
    let config_dir = get_config_dir(&app)?;
    crate::features::connection::auth::first_login(
        &config_dir, url, username, password, label, remember_password,
    ).await
}

#[tauri::command]
pub async fn webdav_logout(
    app: tauri::AppHandle,
    remove_from_nas: bool,
    state: tauri::State<'_, SyncEngineState>,
    heartbeat_state: tauri::State<'_, crate::features::sync_v2::bootstrap::HeartbeatState>,
) -> Result<(), String> {
    use crate::features::sync_v2::bootstrap;

    let config_dir = get_config_dir(&app)?;

    // Get provider before teardown (for NAS logout push)
    let provider = state.get().map(|e| e.provider().clone());

    // Stop engine + heartbeat
    bootstrap::teardown_previous_sync(&state, &heartbeat_state);

    // Logout (mark offline on NAS + delete config)
    crate::features::connection::auth::logout(
        &config_dir, remove_from_nas, provider.as_ref(),
    ).await
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebDavStatus {
    pub connected: bool,
    pub url: Option<String>,
    pub username: Option<String>,
    pub label: Option<String>,
    pub device: Option<crate::features::connection::device::DeviceInfo>,
}

#[tauri::command]
pub fn webdav_get_status(
    app: tauri::AppHandle,
) -> Result<WebDavStatus, String> {
    let config_dir = get_config_dir(&app)?;
    match crate::features::connection::store::load(&config_dir)? {
        Some(wc) => Ok(WebDavStatus {
            connected: true,
            url: Some(wc.url),
            username: Some(wc.username),
            label: Some(wc.label),
            device: Some(wc.device),
        }),
        None => Ok(WebDavStatus {
            connected: false,
            url: None,
            username: None,
            label: None,
            device: None,
        }),
    }
}

#[tauri::command]
pub async fn list_connected_devices(
    state: tauri::State<'_, SyncEngineState>,
) -> Result<Vec<crate::features::connection::device::DeviceInfo>, String> {
    let engine = engine(&state)?;
    crate::features::connection::device_registry::list_all_devices(engine.provider()).await
}

#[tauri::command]
pub async fn delete_connected_device(
    device_id: String,
    state: tauri::State<'_, SyncEngineState>,
) -> Result<(), String> {
    let engine = engine(&state)?;
    crate::features::connection::device_registry::delete_device(&device_id, engine.provider()).await
}

// ── Vault discovery commands (M-3) ─────────────────────

use crate::features::connection::vault_discovery::{DiscoveredVault, VaultDiscoveryCache};

/// List discovered vaults (cache-first, returns cached if available).
#[tauri::command]
pub fn sync_v2_list_discovered_vaults(
    app: tauri::AppHandle,
) -> Result<Option<VaultDiscoveryCache>, String> {
    let config_dir = get_config_dir(&app)?;
    Ok(crate::features::connection::vault_discovery::load_cache(&config_dir))
}

/// Refresh vault discovery from NAS (background scan).
/// Builds a temporary WebDavProvider from global config, scans NAS root.
#[tauri::command]
pub async fn sync_v2_refresh_vault_discovery(
    app: tauri::AppHandle,
    scan_root: String,
) -> Result<VaultDiscoveryCache, String> {
    use tauri::Manager;

    let config_dir = get_config_dir(&app)?;
    let wc = crate::features::connection::store::load(&config_dir)?
        .ok_or("No WebDAV connection configured")?;

    // Build temporary provider for scanning
    let client = crate::core::webdav::WebDavClient::new(&wc.url, &wc.username, &wc.password)
        .map_err(|e| format!("WebDAV client: {}", e))?;
    let provider: std::sync::Arc<dyn crate::core::sync_provider::SyncProvider> = std::sync::Arc::new(
        crate::features::sync_v2::webdav_provider::WebDavProvider::new(client, String::new()),
    );

    let cache = crate::features::connection::vault_discovery::refresh_with_cache(
        &config_dir, &provider, &wc.url, &scan_root,
    ).await?;

    // Emit event so frontend updates
    {
        use tauri::Emitter;
        let _ = app.emit("vault-discovery:updated", &cache);
    }

    Ok(cache)
}

/// Open a vault by NAS path (validates .notology presence).
/// Auto-creates per-vault sync_v2 config if missing (so sync engine starts on entry).
#[tauri::command]
pub async fn sync_v2_open_vault_from_path(
    app: tauri::AppHandle,
    remote_path: String,
) -> Result<crate::features::connection::vault_actions::VaultOpenResult, String> {
    use tauri::Manager;
    log::info!("[sync_v2_open_vault_from_path] remote_path={}", remote_path);
    let config_dir = get_config_dir(&app)?;
    let local_data_dir = app.path().app_local_data_dir()
        .map_err(|e| format!("app_local_data_dir: {}", e))?;
    let wc = crate::features::connection::store::load(&config_dir)?
        .ok_or("No WebDAV connection configured")?;

    let client = crate::core::webdav::WebDavClient::new(&wc.url, &wc.username, &wc.password)
        .map_err(|e| format!("WebDAV client: {}", e))?;
    let provider: std::sync::Arc<dyn crate::core::sync_provider::SyncProvider> = std::sync::Arc::new(
        crate::features::sync_v2::webdav_provider::WebDavProvider::new(client, remote_path.clone()),
    );

    let result = crate::features::connection::vault_actions::open_vault_from_path(
        &provider, &remote_path, &local_data_dir, &wc.url,
    ).await?;

    // Ensure per-vault sync_v2 config exists (so sync engine starts)
    ensure_vault_sync_config(&config_dir, &result.local_path, &remote_path)?;

    Ok(result)
}

/// Create a new vault on NAS.
/// Also writes per-vault sync_v2 config so sync engine starts immediately on entry.
#[tauri::command]
pub async fn sync_v2_create_vault(
    app: tauri::AppHandle,
    remote_path: String,
) -> Result<crate::features::connection::vault_actions::VaultOpenResult, String> {
    use tauri::Manager;
    log::info!("[sync_v2_create_vault] remote_path={}", remote_path);
    let config_dir = get_config_dir(&app)?;
    let local_data_dir = app.path().app_local_data_dir()
        .map_err(|e| format!("app_local_data_dir: {}", e))?;
    let wc = crate::features::connection::store::load(&config_dir)?
        .ok_or("No WebDAV connection configured")?;

    let client = crate::core::webdav::WebDavClient::new(&wc.url, &wc.username, &wc.password)
        .map_err(|e| format!("WebDAV client: {}", e))?;
    // Use empty remote_base — vault_actions handles full paths via put_md
    let provider: std::sync::Arc<dyn crate::core::sync_provider::SyncProvider> = std::sync::Arc::new(
        crate::features::sync_v2::webdav_provider::WebDavProvider::new(client, String::new()),
    );

    let result = crate::features::connection::vault_actions::create_vault(
        &provider, &remote_path, &local_data_dir, &wc.url, &wc.device.device_id,
    ).await?;

    // Write per-vault sync_v2 config so sync engine starts on next vault entry
    ensure_vault_sync_config(&config_dir, &result.local_path, &remote_path)?;

    log::info!("[sync_v2_create_vault] success: name={}, local={}, remote={}",
        result.name, result.local_path, result.remote_path);
    Ok(result)
}

/// Ensure a per-vault sync_v2 config exists with sync enabled.
/// If config already exists, leave it alone. If not, write defaults.
fn ensure_vault_sync_config(
    config_dir: &std::path::Path,
    vault_local_path: &str,
    remote_path: &str,
) -> Result<(), String> {
    use crate::features::sync_v2::config::{load_config, save_config, SyncV2Config};
    let vault_path = std::path::Path::new(vault_local_path);
    let existing = load_config(config_dir, vault_path)?;
    if existing.is_complete() {
        log::debug!("[ensure_vault_sync_config] config already exists for {}", vault_local_path);
        return Ok(());
    }
    let cfg = SyncV2Config {
        enabled: true,
        remote_base: remote_path.trim_end_matches('/').to_string(),
        url: None,
        username: None,
        password: None,
    };
    save_config(config_dir, vault_path, &cfg)?;
    log::info!("[ensure_vault_sync_config] created sync config for {} → {}",
        vault_local_path, remote_path);
    Ok(())
}

// ── NAS folder browser ───────────────────────────────────────

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NasFolderEntry {
    pub name: String,
    pub path: String,
    pub is_collection: bool,
    /// True when this directory contains a `.notology/` subdir — i.e., it
    /// is itself a Notology vault root the user can open directly.
    pub is_vault: bool,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NasFolderListing {
    pub path: String,
    pub children: Vec<NasFolderEntry>,
}

/// Core browse logic — shared by the Tauri command and unit tests.
/// Lists immediate children of `path` and probes each subfolder for the
/// `.notology/` vault marker. Skip filter mirrors `remote_import` so the
/// picker stays free of test-artifact directories.
pub async fn browse_folder_with_provider(
    provider: &std::sync::Arc<dyn crate::core::sync_provider::SyncProvider>,
    path: &str,
) -> Result<NasFolderListing, String> {
    let normalized = path.trim_end_matches('/');
    let lookup = if normalized.is_empty() { "/".to_string() } else { normalized.to_string() };

    let raw_children = provider.list_children(&lookup).await
        .map_err(|e| format!("list_children({}): {}", lookup, e))?;

    let mut entries: Vec<NasFolderEntry> = Vec::with_capacity(raw_children.len());
    for child in raw_children {
        if child.is_collection && is_browser_skip_name(&child.name) {
            continue;
        }
        let mut is_vault = false;
        if child.is_collection {
            // One PROPFIND per child to detect vault marker. Sequential is
            // intentional — we don't want to hammer Synology with parallel
            // requests on slow connections.
            if let Ok(grandchildren) = provider.list_children(&child.path).await {
                is_vault = grandchildren.iter()
                    .any(|gc| gc.name == ".notology" && gc.is_collection);
            }
        }
        entries.push(NasFolderEntry {
            name: child.name,
            path: child.path,
            is_collection: child.is_collection,
            is_vault,
        });
    }

    // Folders first, then files; alphabetical within each group.
    entries.sort_by(|a, b| {
        b.is_collection.cmp(&a.is_collection)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(NasFolderListing { path: lookup, children: entries })
}

/// Browse a NAS directory at `path`, returning its immediate children plus
/// a per-child `is_vault` flag.
///
/// Uses the global WebDAV connection (no active engine required), so the user
/// can navigate the NAS tree even before opening a vault.
#[tauri::command]
pub async fn sync_v2_browse_nas_folder(
    app: tauri::AppHandle,
    path: String,
) -> Result<NasFolderListing, String> {
    use crate::core::sync_provider::SyncProvider;

    let config_dir = get_config_dir(&app)?;
    let wc = crate::features::connection::store::load(&config_dir)?
        .ok_or("No WebDAV connection configured")?;

    let client = crate::core::webdav::WebDavClient::new(&wc.url, &wc.username, &wc.password)
        .map_err(|e| format!("WebDAV client: {}", e))?;
    let provider: std::sync::Arc<dyn SyncProvider> = std::sync::Arc::new(
        crate::features::sync_v2::webdav_provider::WebDavProvider::new(client, String::new()),
    );

    browse_folder_with_provider(&provider, &path).await
}

/// Skip system folders + test artifacts in the NAS browser UI. Mirrors the
/// remote_import skip set so the user doesn't see ephemeral test directories
/// when trying to find a vault.
fn is_browser_skip_name(name: &str) -> bool {
    matches!(name, ".notology" | "@eaDir" | "#recycle" | "#snapshot")
        || name.starts_with("obj_test_")
        || name.starts_with("ref_test_")
        || name.starts_with("notif_test_")
        || name.starts_with("branch_test_")
        || name.starts_with("engine_")
        || name.starts_with("e2e_")
        || name == "_sync_v2_test"
        || name.starts_with("_sync_v2_test")
}

// ── NAS reachability ─────────────────────────────────────────

/// Current NAS reachability for the active vault.
/// Returns `true` (Online) when no engine is initialized so the UI doesn't
/// flag a vault-less state as Offline.
#[tauri::command]
pub fn sync_v2_get_online(
    sync_v2_state: tauri::State<'_, SyncEngineState>,
) -> bool {
    sync_v2_state.get().map(|e| e.is_online()).unwrap_or(true)
}

// ── Stale duplicate ref cleanup ──────────────────────────────

/// Manually triggered cleanup of refs whose `relative_path` collides with
/// another ref's. See `reconciliation::cleanup_stale_duplicate_refs` for
/// the policy. Cleans both local and NAS so the next sync cycle doesn't
/// re-import the zombies.
#[tauri::command]
pub async fn sync_v2_cleanup_stale_refs(
    library_state: tauri::State<'_, LibraryState>,
    sync_v2_state: tauri::State<'_, SyncEngineState>,
) -> Result<crate::features::sync_v2::reconciliation::StaleRefCleanupReport, String> {
    // Snapshot the RefStore Arc + (optional) provider Arc, then drop the
    // library guard so we don't hold a non-Send MutexGuard across awaits.
    let ref_store = {
        let guard = library_state.lock().unwrap_or_else(|e| e.into_inner());
        let library = guard.as_ref().ok_or("Library not initialized")?;
        library.arc_refs()
    };
    let provider = sync_v2_state.get().map(|e| e.provider().clone());
    crate::features::sync_v2::reconciliation::cleanup_stale_duplicate_refs(
        &ref_store, provider.as_ref(),
    ).await
}

// ── Smart text merge ─────────────────────────────────────────

/// Suggest a 3-way merge of two diverged versions of a note. Reads `local_hash`
/// and `remote_hash` from CAS and computes their LCA via the per-note DAG.
/// The result is *only a suggestion* — the UI shows it in the conflict
/// dialog and the user must explicitly accept (or edit) before commit.
#[tauri::command]
pub async fn sync_v2_smart_merge(
    note_id: String,
    local_hash: String,
    remote_hash: String,
    library_state: tauri::State<'_, LibraryState>,
) -> Result<crate::features::sync_v2::text_merge::MergeResult, String> {
    let guard = library_state.lock().unwrap_or_else(|e| e.into_inner());
    let library = guard.as_ref().ok_or("Library not initialized")?;

    let dag = crate::core::version_dag::VersionDag::load(library.vault_path(), &note_id)
        .map_err(|e| format!("load DAG: {}", e))?;

    let lca_hash = dag.find_lca(&local_hash, &remote_hash)
        .ok_or("no common ancestor — manual resolution required")?;

    let read_text = |hash: &str| -> Result<String, String> {
        let bytes = library.cas().read_object(hash)
            .map_err(|e| format!("CAS read {}: {}", hash, e))?
            .ok_or_else(|| format!("CAS object missing: {}", hash))?;
        String::from_utf8(bytes)
            .map_err(|e| format!("not valid UTF-8 ({}): {}", hash, e))
    };

    let base = read_text(&lca_hash)?;
    let local = read_text(&local_hash)?;
    let remote = read_text(&remote_hash)?;

    Ok(crate::features::sync_v2::text_merge::three_way_merge(&base, &local, &remote))
}

/// One-click smart merge with an explicit branch. Computes the 3-way
/// merge between the local head and the chosen branch's head (LCA from
/// the DAG); if the merge is clean, commits it locally, deletes all
/// remote branches, and pushes the merged version. If the merge has
/// any conflict regions, returns `Conflict` so the UI can fall back to
/// the manual 2-way pick.
#[tauri::command]
pub async fn sync_v2_smart_merge_branch(
    note_id: String,
    branch_id: String,
    library_state: tauri::State<'_, LibraryState>,
    sync_v2_state: tauri::State<'_, SyncEngineState>,
) -> Result<SmartMergeBranchResultDto, String> {
    let engine = sync_v2_state.get().ok_or("sync engine not running")?;

    // 1. Get branch's head_hash (async — may touch NAS via provider).
    let branch = engine
        .branch_mgr_ref()
        .get_branch(engine.provider().as_ref(), &note_id, &branch_id)
        .await?
        .ok_or_else(|| format!("branch {} not found for note {}", branch_id, note_id))?;
    let branch_hash = branch.head_hash.clone();

    // 2. Read texts + compute merge (synchronous, via Library mutex).
    let computed = {
        let guard = library_state.lock().unwrap_or_else(|e| e.into_inner());
        let library = guard.as_ref().ok_or("Library not initialized")?;

        let local_ref = library
            .refs()
            .get(&note_id)
            .map_err(|e| format!("get ref: {}", e))?
            .ok_or_else(|| format!("no local ref for {}", note_id))?;
        let local_hash = local_ref.head_hash.clone();
        let relative_path = local_ref.relative_path.clone();

        let dag = crate::core::version_dag::VersionDag::load(library.vault_path(), &note_id)
            .map_err(|e| format!("load DAG: {}", e))?;

        let lca_hash = match dag.find_lca(&local_hash, &branch_hash) {
            Some(h) => h,
            None => {
                return Ok(SmartMergeBranchResultDto::NoCommonAncestor);
            }
        };

        let read_text = |hash: &str| -> Result<String, String> {
            let bytes = library
                .cas()
                .read_object(hash)
                .map_err(|e| format!("CAS read {}: {}", hash, e))?
                .ok_or_else(|| format!("CAS object missing: {}", hash))?;
            String::from_utf8(bytes)
                .map_err(|e| format!("not valid UTF-8 ({}): {}", hash, e))
        };

        let base = read_text(&lca_hash)?;
        let local = read_text(&local_hash)?;
        let remote = read_text(&branch_hash)?;

        let result = crate::features::sync_v2::text_merge::three_way_merge(&base, &local, &remote);
        (result, relative_path)
    }; // drop library guard before async work
    let (result, relative_path) = computed;

    if !result.clean {
        return Ok(SmartMergeBranchResultDto::Conflict {
            conflict_count: result.conflict_count,
        });
    }

    // 3. Apply merged result: commit + delete branches + push.
    let merged_hash = engine
        .smart_merge_resolve(&note_id, &branch_id, result.merged.into_bytes(), &relative_path)
        .await?;

    Ok(SmartMergeBranchResultDto::Success { merged_hash })
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SmartMergeBranchResultDto {
    /// Merge succeeded and was applied. `merged_hash` is the new local head.
    Success { merged_hash: String },
    /// Merge had conflict regions; UI should fall back to manual 2-way.
    Conflict { conflict_count: usize },
    /// Local and branch have no common ancestor — can't auto-merge,
    /// user must pick a side manually.
    NoCommonAncestor,
}

// ── Trash UI commands (purge — list/restore already exist above) ────

/// Permanently delete one trash entry. Cannot be undone.
#[tauri::command]
pub async fn sync_v2_purge_trash_entry(
    note_id: String,
    library_state: tauri::State<'_, LibraryState>,
) -> Result<(), String> {
    let guard = library_state.lock().unwrap_or_else(|e| e.into_inner());
    let library = guard.as_ref().ok_or("Library not initialized")?;
    crate::features::sync_v2::trash::purge_one(library.vault_path(), &note_id)
}

/// Permanently delete every trash entry older than the retention
/// period (30 days). Returns the count of purged entries.
#[tauri::command]
pub async fn sync_v2_purge_expired_trash(
    library_state: tauri::State<'_, LibraryState>,
) -> Result<usize, String> {
    let guard = library_state.lock().unwrap_or_else(|e| e.into_inner());
    let library = guard.as_ref().ok_or("Library not initialized")?;
    crate::features::sync_v2::trash::purge_expired(library.vault_path())
}

// ── Track H: NAS-deletion pending confirm ────────────────────

/// Return the list of NAS-deleted refs awaiting user confirmation
/// (filled when a sync cycle detected ≥ `NAS_DELETION_BULK_THRESHOLD`
/// removals). Empty if no batch is pending.
#[tauri::command]
pub async fn sync_v2_list_pending_nas_deletions(
    state: tauri::State<'_, SyncEngineState>,
) -> Result<Vec<crate::features::sync_v2::ref_sync::NasDeletionCandidate>, String> {
    Ok(match state.get() {
        Some(engine) => engine.list_pending_nas_deletions().await,
        None => vec![],
    })
}

/// User chose to apply the bulk deletion: move all pending notes to
/// Trash and drop their local refs. Returns count actually trashed.
#[tauri::command]
pub async fn sync_v2_confirm_nas_deletions_trash(
    state: tauri::State<'_, SyncEngineState>,
) -> Result<usize, String> {
    engine(&state)?.confirm_nas_deletions_trash().await
}

/// User rejected the bulk deletion: keep all pending notes, clear
/// their sync_etag so the next sync cycle re-pushes them to NAS.
/// Returns count of refs prepared for re-push.
#[tauri::command]
pub async fn sync_v2_confirm_nas_deletions_reject(
    state: tauri::State<'_, SyncEngineState>,
) -> Result<usize, String> {
    engine(&state)?.confirm_nas_deletions_reject().await
}

// ── Vault rename / delete ────────────────────────────────────

/// Rename a vault by explicit paths. The vault MUST NOT be the
/// currently-open one — the engine + Tantivy index hold file handles
/// that block Windows directory rename. Frontend enforces this by
/// disabling the buttons on the active vault item.
///
/// Builds a one-shot WebDAV provider from the global connection config.
#[tauri::command]
pub async fn sync_v2_rename_vault_at_path(
    app: tauri::AppHandle,
    remote_path: String,
    local_path: String,
    new_name: String,
    sync_v2_state: tauri::State<'_, SyncEngineState>,
) -> Result<crate::features::connection::vault_actions::RenameOutcome, String> {
    use crate::core::sync_provider::SyncProvider;

    // Defense in depth: if the engine is currently running for THIS vault,
    // refuse — frontend should already have disabled the button, but a
    // failed-soft message here is better than corrupting state.
    if let Some(engine) = sync_v2_state.get() {
        if let Some(active_base) = engine.active_remote_base().await {
            let target = remote_path.trim_end_matches('/');
            if active_base.trim_end_matches('/') == target {
                return Err("이 보관소가 현재 열려 있어 이름을 바꿀 수 없습니다. 다른 보관소를 먼저 선택하세요.".into());
            }
        }
    }

    let config_dir = get_config_dir(&app)?;
    let wc = crate::features::connection::store::load(&config_dir)?
        .ok_or("No WebDAV connection configured")?;
    let client = crate::core::webdav::WebDavClient::new(&wc.url, &wc.username, &wc.password)
        .map_err(|e| format!("WebDAV client: {}", e))?;
    let provider: std::sync::Arc<dyn SyncProvider> = std::sync::Arc::new(
        crate::features::sync_v2::webdav_provider::WebDavProvider::new(client, String::new()),
    );

    let local = std::path::PathBuf::from(&local_path);
    let remote_norm = remote_path.trim_end_matches('/');
    let (parent, old_name) = remote_norm.rsplit_once('/')
        .ok_or_else(|| format!("invalid remote_path: {}", remote_path))?;
    let parent = if parent.is_empty() { "/".to_string() } else { parent.to_string() };

    crate::features::connection::vault_actions::rename_vault(
        &provider, &parent, old_name, &new_name, &local, &config_dir,
    ).await
}

/// Delete a vault by explicit paths. Same activeness gate as rename.
#[tauri::command]
pub async fn sync_v2_delete_vault_at_path(
    app: tauri::AppHandle,
    remote_path: String,
    local_path: String,
    delete_remote: bool,
    sync_v2_state: tauri::State<'_, SyncEngineState>,
) -> Result<crate::features::connection::vault_actions::DeleteOutcome, String> {
    use crate::core::sync_provider::SyncProvider;

    if let Some(engine) = sync_v2_state.get() {
        if let Some(active_base) = engine.active_remote_base().await {
            let target = remote_path.trim_end_matches('/');
            if active_base.trim_end_matches('/') == target {
                return Err("이 보관소가 현재 열려 있어 삭제할 수 없습니다. 다른 보관소를 먼저 선택하세요.".into());
            }
        }
    }

    let config_dir = get_config_dir(&app)?;
    let wc = crate::features::connection::store::load(&config_dir)?
        .ok_or("No WebDAV connection configured")?;
    let client = crate::core::webdav::WebDavClient::new(&wc.url, &wc.username, &wc.password)
        .map_err(|e| format!("WebDAV client: {}", e))?;
    let provider: std::sync::Arc<dyn SyncProvider> = std::sync::Arc::new(
        crate::features::sync_v2::webdav_provider::WebDavProvider::new(client, String::new()),
    );

    let local = std::path::PathBuf::from(&local_path);
    crate::features::connection::vault_actions::delete_vault_full(
        &provider, remote_path.trim_end_matches('/'), &local, &config_dir, delete_remote,
    ).await
}

/// Returns the `remote_base` of the currently-open vault, or `None` if no
/// vault is open. The frontend uses this to disable rename/delete buttons
/// on the matching vault item in the selector.
#[tauri::command]
pub async fn sync_v2_active_vault_remote_path(
    sync_v2_state: tauri::State<'_, SyncEngineState>,
) -> Result<Option<String>, String> {
    Ok(match sync_v2_state.get() {
        Some(engine) => engine.active_remote_base().await,
        None => None,
    })
}

// ── Orphan local-cache cleanup ──────────────────────────────

/// List local vault dirs that don't correspond to any known NAS vault.
/// `known_nas_vault_names` is the list of vault names currently visible
/// in the selector (from vault_discovery). The currently-open vault is
/// skipped automatically. Result is safe to show as a confirmation
/// dialog: nothing is deleted until `sync_v2_delete_orphan_local_dirs`.
#[tauri::command]
pub async fn sync_v2_list_orphan_local_dirs(
    app: tauri::AppHandle,
    known_nas_vault_names: Vec<String>,
    sync_v2_state: tauri::State<'_, SyncEngineState>,
) -> Result<Vec<crate::features::connection::vault_actions::OrphanLocalVault>, String> {
    use tauri::Manager;
    let local_data_dir = app.path().app_local_data_dir()
        .map_err(|e| format!("app_local_data_dir: {}", e))?;
    let config_dir = get_config_dir(&app)?;
    let wc = crate::features::connection::store::load(&config_dir)?
        .ok_or("No WebDAV connection configured")?;

    let active_local: Option<std::path::PathBuf> = match sync_v2_state.get() {
        Some(engine) => Some(engine.vault_path().to_path_buf()),
        None => None,
    };

    crate::features::connection::vault_actions::list_orphan_local_dirs(
        &local_data_dir,
        &wc.url,
        &known_nas_vault_names,
        active_local.as_deref(),
    )
}

/// Delete the given orphan local vault directories. Per-vault sync
/// configs are also cleaned. Returns per-path success/failure so the UI
/// can show partial outcomes (e.g., one dir locked by another process).
#[tauri::command]
pub async fn sync_v2_delete_orphan_local_dirs(
    app: tauri::AppHandle,
    paths: Vec<String>,
    sync_v2_state: tauri::State<'_, SyncEngineState>,
) -> Result<Vec<crate::features::connection::vault_actions::OrphanDeleteOutcome>, String> {
    let config_dir = get_config_dir(&app)?;

    // Defense in depth: if the engine is currently open on any of the
    // requested paths, refuse the whole batch. The frontend already
    // excludes the active vault, but a stale list could slip through.
    if let Some(engine) = sync_v2_state.get() {
        let active = engine.vault_path().to_path_buf();
        if paths.iter().any(|p| std::path::PathBuf::from(p) == active) {
            return Err("현재 열려 있는 보관소는 정리 대상에 포함될 수 없습니다.".into());
        }
    }

    let path_bufs: Vec<std::path::PathBuf> = paths.into_iter()
        .map(std::path::PathBuf::from).collect();
    Ok(crate::features::connection::vault_actions::delete_orphan_local_dirs(
        &path_bufs, &config_dir,
    ))
}

// ── User-facing pause toggle ─────────────────────────────────

/// Whether sync is currently active for the open vault. `true` if no engine
/// (treat as "default-on") so the UI shows the toggle in its enabled state
/// before a vault is opened.
#[tauri::command]
pub fn sync_v2_get_enabled(
    sync_v2_state: tauri::State<'_, SyncEngineState>,
) -> bool {
    sync_v2_state.get().map(|e| e.is_sync_enabled()).unwrap_or(true)
}

/// Pause or resume sync for the active vault. Paused vaults keep the engine
/// alive but skip all NAS push/pull. Persists `enabled` to per-vault config
/// so the choice survives app restart. On resume, immediately triggers one
/// reconciliation to flush queued changes + pull missed remote refs.
#[tauri::command]
pub async fn sync_v2_set_enabled(
    app: tauri::AppHandle,
    enabled: bool,
    library_state: tauri::State<'_, LibraryState>,
    sync_v2_state: tauri::State<'_, SyncEngineState>,
) -> Result<(), String> {
    let engine = sync_v2_state.get().ok_or("Sync engine not initialized")?;
    engine.set_sync_enabled(enabled);

    // Persist `enabled` so the toggle state survives restart.
    let vault_path = get_vault_path(&library_state)?;
    let config_dir = get_config_dir(&app)?;
    if let Ok(mut cfg) = crate::features::sync_v2::config::load_config(&config_dir, &vault_path) {
        if cfg.enabled != enabled {
            cfg.enabled = enabled;
            if let Err(e) = crate::features::sync_v2::config::save_config(&config_dir, &vault_path, &cfg) {
                log::warn!("[sync_v2_set_enabled] persist failed: {}", e);
            }
        }
    }

    // Tell the UI immediately so the indicator updates without a roundtrip.
    {
        use tauri::Emitter;
        let _ = app.emit("sync-v2:enabled-changed", enabled);
    }

    // On resume, drain the queue + pull missed refs without waiting for the
    // next adaptive_poller tick. Skip when paused (sync_once would no-op).
    if enabled && engine.is_online() {
        engine.trigger_reconciliation_now();
    }

    Ok(())
}

// ── Remote import (scan unregistered NAS .md and register) ─────────

/// Scan NAS for .md files not yet registered in the sync model.
/// `dryRun=true` reports counts without modifying the sync model.
/// `dryRun=false` performs the registration and triggers a reconciliation.
#[tauri::command]
pub async fn remote_import_scan(
    app: tauri::AppHandle,
    dry_run: bool,
    library_state: tauri::State<'_, LibraryState>,
    sync_v2_state: tauri::State<'_, SyncEngineState>,
) -> Result<crate::features::connection::remote_import::ImportReport, String> {
    let engine = sync_v2_state.get()
        .ok_or("Sync engine not initialized. Open a vault first.")?;
    let provider = engine.provider().clone();

    // Resolve remote_base from per-vault config
    let vault_path = get_vault_path(&library_state)?;
    let config_dir = get_config_dir(&app)?;
    let v2_config = crate::features::sync_v2::config::load_config(&config_dir, &vault_path)?;
    let remote_base = v2_config.remote_base.clone();
    if remote_base.is_empty() {
        return Err("Vault has no NAS remote_base configured".into());
    }

    // Phase 1 (async): scan NAS + download .md to memory
    let (fetched, mut report) =
        crate::features::connection::remote_import::scan_remote(&provider, &remote_base).await?;

    // Phase 2 (sync, holding library lock): register each fetched note.
    // Returns pending NAS write-backs for notes whose id we generated.
    let pending = {
        let guard = library_state.lock().unwrap_or_else(|e| e.into_inner());
        let library = guard.as_ref().ok_or("Library not initialized")?;
        crate::features::connection::remote_import::import_into_library(
            fetched, library, dry_run, &mut report,
        )
    };

    // Phase 3 (async, no library lock): PUT id-injected content back to NAS so
    // the next scan recognizes the file via its frontmatter id (idempotency).
    if !dry_run && !pending.is_empty() {
        crate::features::connection::remote_import::write_back_ids(
            &provider, pending, &mut report,
        ).await;
    }

    // Trigger a sync cycle so newly-registered refs propagate to NAS.
    if !dry_run && report.newly_registered > 0 {
        let _ = engine.sync_once().await;
    }

    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_uninitialized_errors() {
        let state = SyncEngineState::new();
        let result = engine(&state);
        assert!(result.is_err());
        let err = result.err().unwrap();
        assert!(err.contains("not initialized"));
    }

    #[test]
    fn test_set_and_get() {
        let state = SyncEngineState::new();
        assert!(state.get().is_none());
        // Can't easily create SyncEngine without deps, but verify None→Some→None lifecycle
        state.clear();
        assert!(state.get().is_none());
    }

    #[test]
    fn test_default_impl() {
        let state = SyncEngineState::default();
        assert!(state.get().is_none());
    }
}
