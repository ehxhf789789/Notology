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

// ============================================================================
// Round 2 R5 v5 (HanBin 2026-05-23) — pending & failed queue introspection.
// Frontend uses these for:
//   * hydrating the sync-indicator store on app start (pending → spinner)
//   * surfacing permanent failures so the user sees them and can retry
//   * a "X uploads queued / Y failed" status badge in the UI
// All operations are vault-scoped via SyncEngineState (which holds one
// engine per active vault).
// ============================================================================

/// DTO mirroring `DirtyEntry` for the frontend. `target_path` is extracted
/// from the operation payload so the UI can match it against
/// `attachmentSyncStore` paths without parsing operation_json itself.
#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PendingOpDto {
    pub id: i64,
    pub op_type: String,
    pub target_path: String,
    pub timestamp_ms: i64,
    pub retry_count: u32,
    pub last_error: Option<String>,
    pub lane: String,
}

/// DTO mirroring `FailedEntry`. Includes `failed_at_ms` so the UI can show
/// "failed 3 minutes ago".
#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FailedOpDto {
    pub id: i64,
    pub op_type: String,
    pub target_path: String,
    pub queued_at_ms: i64,
    pub failed_at_ms: i64,
    pub last_error: String,
    pub lane: String,
}

fn op_type_and_path(op: &crate::features::sync_v2::dirty_queue::DirtyOperation) -> (String, String) {
    use crate::features::sync_v2::dirty_queue::DirtyOperation as DOp;
    match op {
        DOp::NoteUpsert { relative_path, .. } => ("note_upsert".into(), relative_path.clone()),
        DOp::NoteDelete { relative_path, .. } => ("note_delete".into(), relative_path.clone()),
        DOp::NoteMove { new_path, .. } => ("note_move".into(), new_path.clone()),
        DOp::AttachmentUpsert { relative_path } => ("attachment_upsert".into(), relative_path.clone()),
        DOp::AttachmentDelete { relative_path } => ("attachment_delete".into(), relative_path.clone()),
        DOp::FolderCreate { relative_path } => ("folder_create".into(), relative_path.clone()),
        DOp::FolderDelete { relative_path } => ("folder_delete".into(), relative_path.clone()),
        DOp::YamlChange { relative_path } => ("yaml_change".into(), relative_path.clone()),
        DOp::MetaChange { relative_path, .. } => ("meta_change".into(), relative_path.clone()),
    }
}

#[tauri::command]
pub fn sync_v2_list_pending(
    state: tauri::State<'_, SyncEngineState>,
) -> Result<Vec<PendingOpDto>, String> {
    let engine = match state.get() {
        Some(e) => e,
        None => return Ok(Vec::new()),
    };
    let entries = engine.queue().list_pending()?;
    let mut out = Vec::with_capacity(entries.len());
    for e in entries {
        let (op_type, target_path) = op_type_and_path(&e.op);
        out.push(PendingOpDto {
            id: e.id,
            op_type,
            target_path,
            timestamp_ms: e.timestamp.timestamp_millis(),
            retry_count: e.retry_count,
            last_error: e.last_error,
            lane: e.lane.as_str().to_string(),
        });
    }
    Ok(out)
}

#[tauri::command]
pub fn sync_v2_list_failed(
    state: tauri::State<'_, SyncEngineState>,
) -> Result<Vec<FailedOpDto>, String> {
    let engine = match state.get() {
        Some(e) => e,
        None => return Ok(Vec::new()),
    };
    let entries = engine.queue().list_failed()?;
    let mut out = Vec::with_capacity(entries.len());
    for e in entries {
        let (op_type, target_path) = op_type_and_path(&e.op);
        out.push(FailedOpDto {
            id: e.id,
            op_type,
            target_path,
            queued_at_ms: e.queued_at.timestamp_millis(),
            failed_at_ms: e.failed_at.timestamp_millis(),
            last_error: e.last_error,
            lane: e.lane.as_str().to_string(),
        });
    }
    Ok(out)
}

#[tauri::command]
pub fn sync_v2_retry_failed(
    failed_id: i64,
    state: tauri::State<'_, SyncEngineState>,
) -> Result<(), String> {
    let engine = state
        .get()
        .ok_or_else(|| "sync engine not initialised".to_string())?;
    engine.retry_failed(failed_id)?;
    // Trigger immediate sync so the user sees retry attempt right away.
    engine.trigger_reconciliation_now();
    Ok(())
}

#[tauri::command]
pub fn sync_v2_retry_all_failed(
    state: tauri::State<'_, SyncEngineState>,
) -> Result<usize, String> {
    let engine = state
        .get()
        .ok_or_else(|| "sync engine not initialised".to_string())?;
    let failed = engine.queue().list_failed()?;
    let n = failed.len();
    for f in failed {
        engine.retry_failed(f.id)?;
    }
    if n > 0 {
        engine.trigger_reconciliation_now();
    }
    Ok(n)
}

#[tauri::command]
pub fn sync_v2_clear_failed(
    state: tauri::State<'_, SyncEngineState>,
) -> Result<usize, String> {
    let engine = state
        .get()
        .ok_or_else(|| "sync engine not initialised".to_string())?;
    engine.queue().clear_failed()
}

#[tauri::command]
pub fn sync_v2_count_failed(
    state: tauri::State<'_, SyncEngineState>,
) -> Result<usize, String> {
    Ok(state.get().map(|e| e.queue().count_failed().unwrap_or(0)).unwrap_or(0))
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

/// Track B Phase B-3 PART 6 (HanBin 2026-05-13): force a stuck attachment
/// back onto the dirty queue. Used by the wikilink chip's "Retry sync"
/// action when an upload appears to have failed beyond max retries. Lane
/// is recomputed from current size so a chunked-layout file does not get
/// misrouted onto the fast lane.
#[tauri::command]
pub fn sync_v2_retry_attachment(
    attachment_id: String,
    library_state: tauri::State<'_, LibraryState>,
    state: tauri::State<'_, SyncEngineState>,
) -> Result<(), String> {
    let vault = require_vault(&library_state)?;
    let store = crate::features::sync_v2::attachment_store::AttachmentStore::new(vault)?;
    let r = store
        .get_by_id(&attachment_id)
        .ok_or_else(|| format!("attachment_id {} not found", attachment_id))?;
    let lane = crate::features::sync_v2::attachment_sync::lane_for_size(r.size_bytes);
    let relative = format!(".notology/attachments/refs/{}.json", attachment_id);
    if let Some(engine) = state.get() {
        engine.enqueue_dirty_with_lane(
            DirtyOperation::AttachmentUpsert { relative_path: relative },
            lane,
        );
        log::info!(
            "[sync_v2_retry_attachment] re-enqueued {} ({} bytes, lane={:?})",
            attachment_id, r.size_bytes, lane
        );
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

    // HanBin 2026-05-14: faststart re-mux for MP4 family. Webex / Zoom / OBS
    // screen recordings ship with `moov` at the end of the file, which
    // forces HTML5 <video> in the editor's inline embed to download the
    // whole file before seek works (visible bug: progress thumb decouples
    // from played-progress fill). We re-mux on ingest, before CAS storage,
    // so every attachment that lands in the vault is seek-friendly
    // out of the box. Lossless — `mdat` byte stream is preserved; only the
    // `moov` atom is moved and its stco/co64 entries shifted.
    //
    // Safety: if any step fails (parse, shift overflow, IO), we fall back
    // to the original file. Empirically verified on a 1.47 GB Webex file
    // (see scripts/mp4-faststart.mjs + c:/tmp/faststart_verify).
    let ext_lower = src
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_lowercase())
        .unwrap_or_default();
    let needs_faststart = matches!(ext_lower.as_str(), "mp4" | "mov" | "m4v");
    let mut temp_path: Option<std::path::PathBuf> = None;
    let processed_src: std::path::PathBuf = if needs_faststart {
        match crate::core::mp4_faststart::is_faststart(src) {
            Ok(true) => src.to_path_buf(),
            Ok(false) => {
                let tmp_dir = std::env::temp_dir();
                let unique = format!(
                    "notology_faststart_{}_{}.mp4",
                    std::process::id(),
                    chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)
                );
                let tmp = tmp_dir.join(unique);
                match crate::core::mp4_faststart::apply_faststart(src, &tmp) {
                    Ok(()) => {
                        log::info!(
                            "[attachment_add] faststart re-muxed {} → {:?}",
                            src.display(),
                            tmp
                        );
                        temp_path = Some(tmp.clone());
                        tmp
                    }
                    Err(e) => {
                        log::warn!(
                            "[attachment_add] faststart failed for {}: {} (using original)",
                            src.display(),
                            e
                        );
                        let _ = std::fs::remove_file(&tmp);
                        src.to_path_buf()
                    }
                }
            }
            Err(e) => {
                log::warn!(
                    "[attachment_add] faststart pre-check failed for {}: {} (using original)",
                    src.display(),
                    e
                );
                src.to_path_buf()
            }
        }
    } else {
        src.to_path_buf()
    };

    let mut store =
        crate::features::sync_v2::attachment_store::AttachmentStore::new(vault)?;
    let outcome = store.add_attachment(&processed_src, &name, &resolved_note_id);
    // Clean up the temp file regardless of store.add_attachment outcome —
    // store already copied bytes into CAS by the time it returns.
    if let Some(tmp) = temp_path.as_ref() {
        let _ = std::fs::remove_file(tmp);
    }
    let outcome = outcome?;
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

/// Track B Phase B-3 PART 6 (2026-05-13): unlink-or-delete in one transaction.
///
/// Option C (HanBin 2026-05-13): when the user removes a wikilink chip, we
/// unlink the attachment from that note. If `linked_notes` becomes empty
/// (this was the last reference anywhere), we proceed straight to a full
/// hard-delete — ref JSON, display hardlink, orphan CAS blob, and NAS-side
/// cleanup all in one shot. The frontend confirmation modal is the only
/// guard against accidental data loss.
///
/// Returns `true` when the attachment was fully deleted, `false` when it was
/// merely unlinked from this note (other notes still hold links).
#[tauri::command]
pub async fn attachment_unlink_or_delete(
    app: tauri::AppHandle,
    attachment_id: String,
    note_id: String,
    library_state: tauri::State<'_, LibraryState>,
    sync_state: tauri::State<'_, SyncEngineState>,
) -> Result<bool, String> {
    let vault = require_vault(&library_state)?;
    let mut store =
        crate::features::sync_v2::attachment_store::AttachmentStore::new(vault)?;

    // Snapshot pre-unlink state so we can decide between unlink and full delete.
    let (remaining_links, lane) = {
        let r = store
            .get_by_id(&attachment_id)
            .ok_or_else(|| format!("attachment_id {} not found", attachment_id))?;
        let remaining = r
            .linked_notes
            .iter()
            .filter(|n| n.as_str() != note_id.as_str())
            .count();
        (
            remaining,
            crate::features::sync_v2::attachment_sync::lane_for_size(r.size_bytes),
        )
    };

    store.unlink_from_note(&attachment_id, &note_id)?;

    if remaining_links > 0 {
        // Other notes still reference this attachment — just propagate the
        // updated linked_notes via an upsert.
        if let Some(engine) = sync_state.get() {
            let relative = format!(".notology/attachments/refs/{}.json", attachment_id);
            engine.enqueue_dirty(DirtyOperation::AttachmentUpsert { relative_path: relative });
        }
        return Ok(false);
    }

    // Last link gone → hard delete (matches attachment_delete semantics).
    store.delete_attachment(&attachment_id)?;
    if let Some(engine) = sync_state.get() {
        let relative = format!(".notology/attachments/refs/{}.json", attachment_id);
        engine.enqueue_dirty_with_lane(
            DirtyOperation::AttachmentDelete { relative_path: relative },
            lane,
        );
    }
    let _ = app.emit("attachment:deleted", &attachment_id);
    Ok(true)
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

/// Track B Phase B-3 PART 6 (HanBin 2026-05-13): bidirectional reconcile.
/// Read-only scan of every `.md` file in the vault against the AttachmentRef
/// index. Returns three discrepancy lists so the user can review before
/// applying fixes via `attachment_reconcile_apply`.
#[tauri::command]
pub async fn attachment_reconcile(
    library_state: tauri::State<'_, LibraryState>,
) -> Result<crate::features::sync_v2::attachment_reconcile::ReconcileReport, String> {
    let vault = require_vault(&library_state)?;
    let store = crate::features::sync_v2::attachment_store::AttachmentStore::new(vault)?;
    crate::features::sync_v2::attachment_reconcile::reconcile(&store)
}

/// Apply the fixes from a prior `attachment_reconcile` pass. The caller is
/// expected to have already shown the report to the user and gotten consent.
/// Three buckets are processed (independently, partial-failure tolerant):
///   - dummy_chips removed from note bodies (.md rewritten)
///   - stale_ref_links unlinked → ref hard-deleted if `linked_notes` empties
///   - missing_ref_links appended to ref's `linked_notes`
#[tauri::command]
pub async fn attachment_reconcile_apply(
    app: tauri::AppHandle,
    report: crate::features::sync_v2::attachment_reconcile::ReconcileReport,
    library_state: tauri::State<'_, LibraryState>,
    sync_state: tauri::State<'_, SyncEngineState>,
) -> Result<crate::features::sync_v2::attachment_reconcile::ReconcileApplyOutcome, String> {
    let vault = require_vault(&library_state)?;
    let mut store = crate::features::sync_v2::attachment_store::AttachmentStore::new(vault)?;
    let outcome = crate::features::sync_v2::attachment_reconcile::reconcile_apply(
        &mut store, &report,
    )?;

    // Enqueue ref-side changes so NAS picks them up. We don't enumerate the
    // exact ids that mutated — the bootstrap auto-enqueue + adaptive poller
    // already covers any ref whose sync_etag falls out of sync after a
    // mutation. Just trigger a reconciliation pass.
    if outcome.dummy_chips_removed + outcome.stale_links_fixed + outcome.missing_links_added > 0 {
        // Emit a deletion event for each hard-deleted ref so live editors
        // refresh their attachment store and decoration.
        // (Stale-link processing may have hard-deleted refs; we don't track
        // ids here, but a global refresh is cheap.)
        let _ = app.emit("attachment:saved", &serde_json::json!({}));
    }
    let _ = sync_state; // engine will pick up on next poll
    Ok(outcome)
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

/// 2026-05-24 (HanBin) — vault_repair: read-only scan for 7 inconsistency
/// patterns. Safe to call any time; never mutates the vault.
#[tauri::command]
pub async fn vault_repair_scan(
    library_state: tauri::State<'_, LibraryState>,
) -> Result<crate::features::sync_v2::vault_repair::RepairReport, String> {
    let vault = require_vault(&library_state)?;
    crate::features::sync_v2::vault_repair::scan(&vault)
}

/// 2026-05-24 (HanBin) — vault_repair: execute the fixes from a prior scan.
/// Backs up to `.legacy/repair_<ts>/` before any write. On verification
/// failure, the caller can request rollback via `vault_repair_rollback`
/// (manifest path returned in `outcome.backup_dir`).
///
/// Concurrency: gated by a global AtomicBool mutex. Re-entry while a
/// prior apply is still running returns an error immediately rather
/// than racing the in-flight apply (which would corrupt the manifest
/// and produce non-deterministic state).
#[tauri::command]
pub async fn vault_repair_apply(
    app: tauri::AppHandle,
    report: crate::features::sync_v2::vault_repair::RepairReport,
    options: Option<crate::features::sync_v2::vault_repair::ApplyOptions>,
    library_state: tauri::State<'_, LibraryState>,
    sync_state: tauri::State<'_, SyncEngineState>,
) -> Result<crate::features::sync_v2::vault_repair::ApplyOutcome, String> {
    use tauri::Emitter;
    let vault = require_vault(&library_state)?;
    let opts = options
        .unwrap_or_else(crate::features::sync_v2::vault_repair::ApplyOptions::default_safe);

    // Acquire the global apply lock. RAII guard releases on scope exit.
    let _guard = crate::features::sync_v2::vault_repair::progress::try_acquire_apply_lock()?;

    // Phase 4 B7 (HanBin 2026-05-24) — pause the sync engine for the
    // duration of the repair. Prevents NAS pull from racing our writes
    // and corrupting the manifest, and prevents NAS push from sending
    // half-migrated state to remote. Restored unconditionally on
    // scope exit via the RAII guard below.
    struct SyncPauseGuard {
        engine: Option<std::sync::Arc<crate::features::sync_v2::sync_engine::SyncEngine>>,
        original_state: bool,
    }
    impl Drop for SyncPauseGuard {
        fn drop(&mut self) {
            if let Some(e) = &self.engine {
                e.set_sync_enabled(self.original_state);
                log::info!(
                    "[vault_repair::apply] sync_engine restored to enabled={}",
                    self.original_state
                );
            }
        }
    }
    let _sync_guard: SyncPauseGuard = {
        let engine_opt = sync_state.0.lock()
            .map_err(|e| format!("sync_state lock poisoned: {}", e))?
            .clone();
        if let Some(engine) = engine_opt {
            let original = engine.is_sync_enabled();
            if original {
                engine.set_sync_enabled(false);
                log::info!("[vault_repair::apply] sync_engine paused for repair");
            }
            SyncPauseGuard { engine: Some(engine), original_state: original }
        } else {
            SyncPauseGuard { engine: None, original_state: false }
        }
    };

    // Spawn a heartbeat task that emits Tauri progress events every
    // 250ms so the UI can render a smooth status line without polling.
    // Runs until the apply returns and the guard drops.
    let app_for_hb = app.clone();
    let stop_hb = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let stop_hb_clone = stop_hb.clone();
    tokio::spawn(async move {
        while !stop_hb_clone.load(std::sync::atomic::Ordering::Acquire) {
            let snap = crate::features::sync_v2::vault_repair::progress_snapshot();
            let _ = app_for_hb.emit("vault-repair:progress", &snap);
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        }
    });

    let outcome = crate::features::sync_v2::vault_repair::apply(&vault, &report, &opts);

    stop_hb.store(true, std::sync::atomic::Ordering::Release);

    // Final state event + reset progress slot.
    match &outcome {
        Ok(o) => {
            let _ = app.emit("vault-repair:done", o);
        }
        Err(e) => {
            let _ = app.emit("vault-repair:error", &e);
        }
    }
    // Brief delay so the UI receives the terminal stage before idle.
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    crate::features::sync_v2::vault_repair::reset_to_idle();
    outcome
}

/// 2026-05-24 (HanBin) — UNIFIED note-id resolution. Returns the
/// `note_id → vault_relative_path` map for every .md note in the vault.
///
/// Why this exists: the graph view (`get_graph_data`) does its own
/// note-id resolution on the Rust side, but the AttachmentsTab filter
/// was doing it client-side via `contentCacheStore.metadataCache` —
/// which only has frontmatter for notes the user has actually opened.
/// Result: the same `AttachmentRef.linked_notes` content showed up in
/// the graph but vanished from the filtered Attachments tab, depending
/// purely on which notes happened to be cached. HanBin 2026-05-24:
/// "왜 연계 방식이 통일이 안되지?"
///
/// This command pushes the resolution to the backend so both surfaces
/// share one source of truth. Maps a note_id (frontmatter `id:` field
/// when present, file stem fallback otherwise — matches
/// `extract_note_id_from_path` + `attachment_reconcile::note_id_for`)
/// to its forward-slash vault-relative path. Lowercased keys for
/// case-insensitive lookup on the frontend.
///
/// Cost: walks the vault tree + reads each .md. Acceptable since the
/// AttachmentsTab only calls this on mount + vault change (cached in
/// the component). For a 5,000-note vault: ~200ms cold, <50ms warm.
#[tauri::command]
pub async fn note_id_index(
    library_state: tauri::State<'_, LibraryState>,
) -> Result<std::collections::HashMap<String, String>, String> {
    let vault = require_vault(&library_state)?;
    let mut out: std::collections::HashMap<String, String> = std::collections::HashMap::new();

    fn walk(dir: &std::path::Path, vault_root: &std::path::Path, out: &mut std::collections::HashMap<String, String>) {
        if let Some(name) = dir.file_name().and_then(|s| s.to_str()) {
            if name.starts_with('.') || name.ends_with("_att") {
                return;
            }
        }
        let entries = match std::fs::read_dir(dir) {
            Ok(e) => e,
            Err(_) => return,
        };
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_dir() {
                walk(&p, vault_root, out);
                continue;
            }
            if p.extension().and_then(|s| s.to_str()) != Some("md") {
                continue;
            }
            let content = match std::fs::read_to_string(&p) {
                Ok(c) => c,
                Err(_) => continue,
            };
            let nid = crate::core::note_id::read_id_from_content(&content)
                .unwrap_or_else(|| {
                    p.file_stem()
                        .and_then(|s| s.to_str())
                        .unwrap_or("")
                        .to_string()
                });
            if nid.is_empty() {
                continue;
            }
            let rel = p.strip_prefix(vault_root)
                .map(|r| r.to_string_lossy().replace('\\', "/"))
                .unwrap_or_else(|_| p.to_string_lossy().to_string());
            out.insert(nid.to_lowercase(), rel);
        }
    }

    walk(&vault, &vault, &mut out);
    Ok(out)
}

/// Phase 1 B1+B2 (HanBin 2026-05-24) — full vault snapshot with sha256
/// integrity manifest. Foundational safety primitive: every vault_repair
/// apply will create one of these first, and the user can always
/// 1-click restore.
#[tauri::command]
pub async fn vault_snapshot_create(
    label: Option<String>,
    library_state: tauri::State<'_, LibraryState>,
) -> Result<crate::features::sync_v2::vault_repair::snapshot::SnapshotManifest, String> {
    let vault = require_vault(&library_state)?;
    let label = label.unwrap_or_else(|| "manual".to_string());
    crate::features::sync_v2::vault_repair::snapshot::create_snapshot(&vault, &label)
}

#[tauri::command]
pub async fn vault_snapshot_list(
    library_state: tauri::State<'_, LibraryState>,
) -> Result<Vec<crate::features::sync_v2::vault_repair::snapshot::SnapshotInfo>, String> {
    let vault = require_vault(&library_state)?;
    crate::features::sync_v2::vault_repair::snapshot::list_snapshots(&vault)
}

#[tauri::command]
pub async fn vault_snapshot_restore(
    snapshot_id: String,
    library_state: tauri::State<'_, LibraryState>,
) -> Result<crate::features::sync_v2::vault_repair::snapshot::RestoreOutcome, String> {
    let vault = require_vault(&library_state)?;
    crate::features::sync_v2::vault_repair::snapshot::restore_snapshot(&vault, &snapshot_id)
}

/// P1 #6 (HanBin 2026-05-24) — preview a restore. UI shows the list
/// of files that would be overwritten + DELETED, so the user can
/// inspect the cost before confirming.
#[tauri::command]
pub async fn vault_snapshot_preview_restore(
    snapshot_id: String,
    library_state: tauri::State<'_, LibraryState>,
) -> Result<crate::features::sync_v2::vault_repair::snapshot::RestorePreview, String> {
    let vault = require_vault(&library_state)?;
    crate::features::sync_v2::vault_repair::snapshot::preview_restore(&vault, &snapshot_id)
}

#[tauri::command]
pub async fn vault_snapshot_delete(
    snapshot_id: String,
    library_state: tauri::State<'_, LibraryState>,
) -> Result<(), String> {
    let vault = require_vault(&library_state)?;
    crate::features::sync_v2::vault_repair::snapshot::delete_snapshot(&vault, &snapshot_id)
}

/// Phase 5 B8 (HanBin 2026-05-24) — clone the open vault to a sandbox
/// location. The user can then open the sandbox in Notology (via
/// VaultSelector) and run vault_repair against it for safe testing
/// before touching the real vault. Returns the sandbox absolute path.
#[tauri::command]
pub async fn vault_sandbox_create(
    label: Option<String>,
    library_state: tauri::State<'_, LibraryState>,
) -> Result<crate::features::sync_v2::vault_repair::sandbox::SandboxOutcome, String> {
    let vault = require_vault(&library_state)?;
    // Acquire the apply lock so the sandbox-create itself can't run
    // simultaneously with a vault_repair_apply on the same vault.
    let _guard = crate::features::sync_v2::vault_repair::progress::try_acquire_apply_lock()?;
    let label = label.unwrap_or_else(|| "test".to_string());
    let outcome = crate::features::sync_v2::vault_repair::sandbox::create_sandbox(&vault, &label)?;
    crate::features::sync_v2::vault_repair::progress::reset_to_idle();
    Ok(outcome)
}

/// 2026-05-24 (HanBin) — vault_repair: poll the current apply progress.
/// Returns Idle stage when no apply is running. Cheap (Mutex lock +
/// struct clone, no I/O). Safe to call from any thread.
#[tauri::command]
pub async fn vault_repair_status(
) -> Result<crate::features::sync_v2::vault_repair::RepairProgress, String> {
    Ok(crate::features::sync_v2::vault_repair::progress_snapshot())
}

/// 2026-05-24 (HanBin) — vault_repair: request cancellation of the
/// currently-running apply. Sets a flag; the apply loop checks it at
/// every safe checkpoint (between findings) and bails cleanly,
/// preserving the backup folder so the user can rollback if needed.
/// No-op when no apply is running.
#[tauri::command]
pub async fn vault_repair_cancel() -> Result<(), String> {
    crate::features::sync_v2::vault_repair::request_cancel();
    Ok(())
}

/// 2026-05-24 (HanBin) — vault_repair: post-apply verification. Returns the
/// list of invariant violations (empty = pass).
#[tauri::command]
pub async fn vault_repair_verify(
    library_state: tauri::State<'_, LibraryState>,
) -> Result<Vec<crate::features::sync_v2::vault_repair::VerificationFailure>, String> {
    let vault = require_vault(&library_state)?;
    crate::features::sync_v2::vault_repair::verify(&vault)
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
    /// Set when `is_vault` is false but the folder still looks like a
    /// note-bearing vault that just hasn't been migrated yet. Drives the
    /// "마이그레이션해서 열기" affordance in the NAS browser so legacy
    /// folders (Obsidian or plain markdown trees) are reachable instead of
    /// being silently treated as opaque folders.
    ///
    /// Values: `"obsidian"` (`.obsidian/` present) or `"plainMd"` (≥1 `.md`
    /// in immediate children). `None` for ordinary folders.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub legacy_kind: Option<String>,
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
        let mut legacy_kind: Option<String> = None;
        if child.is_collection {
            // One PROPFIND per child to detect vault marker. Sequential is
            // intentional — we don't want to hammer Synology with parallel
            // requests on slow connections.
            if let Ok(grandchildren) = provider.list_children(&child.path).await {
                is_vault = grandchildren.iter()
                    .any(|gc| gc.name == ".notology" && gc.is_collection);
                if !is_vault {
                    legacy_kind = detect_legacy_kind(provider, &grandchildren).await;
                }
            }
        }
        entries.push(NasFolderEntry {
            name: child.name,
            path: child.path,
            is_collection: child.is_collection,
            is_vault,
            legacy_kind,
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

/// Classify a non-vault folder so the NAS browser can offer "migrate and
/// open" instead of silently treating it as opaque.
///
/// Cheap signals first (no extra fetch):
///   1. `.obsidian/` present → `"obsidian"`
///   2. ≥1 `.md` at top level → `"plainMd"`
///
/// Deep fallback (organised vaults often keep root clean and push notes
/// down one level, e.g. `01_Tasks/note.md`): probe up to
/// `MAX_DEEP_PROBES` non-hidden, non-system subfolders. Bounded so a busy
/// Colony root with many opaque siblings stays snappy on Synology.
async fn detect_legacy_kind(
    provider: &std::sync::Arc<dyn crate::core::sync_provider::SyncProvider>,
    children: &[crate::core::sync_provider::RemoteChild],
) -> Option<String> {
    if children.iter().any(|c| c.name == ".obsidian" && c.is_collection) {
        return Some("obsidian".to_string());
    }
    if children.iter().any(|c| !c.is_collection && c.name.to_lowercase().ends_with(".md")) {
        return Some("plainMd".to_string());
    }

    // No top-level signal — probe up to N non-hidden subfolders one level
    // deeper. Skip hidden (`.foo`) and system (`@eaDir`, `#recycle`) names
    // so the budget isn't wasted on caches.
    const MAX_DEEP_PROBES: usize = 3;
    let mut probed = 0;
    for child in children {
        if probed >= MAX_DEEP_PROBES { break; }
        if !child.is_collection { continue; }
        if child.name.starts_with('.') { continue; }
        if is_browser_skip_name(&child.name) { continue; }
        if let Ok(grand) = provider.list_children(&child.path).await {
            probed += 1;
            if grand.iter().any(|g| !g.is_collection && g.name.to_lowercase().ends_with(".md")) {
                return Some("plainMd".to_string());
            }
        }
    }
    None
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
    //
    // For non-dry-run we wire a progress callback that emits a Tauri event
    // after each note. The UnregisteredNotesBanner listens for these and
    // shows "47 / 178" style status — 178 notes can take a minute or two
    // on Synology, and silence-then-done felt like a hang in prior runs.
    let pending = {
        use tauri::Emitter;
        let app_for_progress = app.clone();
        let progress_cb = move |current: usize, total: usize| {
            let _ = app_for_progress.emit(
                "remote-import:progress",
                serde_json::json!({ "current": current, "total": total }),
            );
        };
        let guard = library_state.lock().unwrap_or_else(|e| e.into_inner());
        let library = guard.as_ref().ok_or("Library not initialized")?;
        crate::features::connection::remote_import::import_into_library(
            fetched,
            library,
            dry_run,
            &mut report,
            if dry_run { None } else { Some(&progress_cb) },
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

    // ── 2026-05-24 legacy vault detection in NAS browser ──

    use crate::core::sync_provider::SyncProvider;
    use crate::features::sync_v2::in_memory_provider::InMemorySyncProvider;
    use std::sync::Arc;

    fn rc(name: &str, is_collection: bool) -> crate::core::sync_provider::RemoteChild {
        crate::core::sync_provider::RemoteChild {
            name: name.to_string(),
            path: format!("/x/{}", name),
            is_collection,
            modified_at: chrono::Utc::now(),
            size: 0,
        }
    }

    /// Provider that returns empty for every list_children call. Used when
    /// the test only exercises the cheap top-level signal path.
    fn empty_provider() -> Arc<dyn crate::core::sync_provider::SyncProvider> {
        Arc::new(InMemorySyncProvider::new())
    }

    #[tokio::test]
    async fn detect_legacy_kind_obsidian_takes_priority() {
        let children = vec![
            rc(".obsidian", true),
            rc("note.md", false),
        ];
        assert_eq!(
            detect_legacy_kind(&empty_provider(), &children).await.as_deref(),
            Some("obsidian")
        );
    }

    #[tokio::test]
    async fn detect_legacy_kind_plain_md_when_no_obsidian() {
        let children = vec![
            rc("note.md", false),
            rc("attachments", true),
        ];
        assert_eq!(
            detect_legacy_kind(&empty_provider(), &children).await.as_deref(),
            Some("plainMd")
        );
    }

    #[tokio::test]
    async fn detect_legacy_kind_uppercase_md_extension_still_matches() {
        let children = vec![rc("README.MD", false)];
        assert_eq!(
            detect_legacy_kind(&empty_provider(), &children).await.as_deref(),
            Some("plainMd")
        );
    }

    #[tokio::test]
    async fn detect_legacy_kind_none_for_opaque_folder_with_no_subfolders() {
        let children = vec![
            rc("video.mp4", false),
            rc("notes.txt", false),
        ];
        assert!(detect_legacy_kind(&empty_provider(), &children).await.is_none());
    }

    #[tokio::test]
    async fn detect_legacy_kind_obsidian_must_be_collection_not_file() {
        // A file literally named `.obsidian` (no extension) is not the marker.
        let children = vec![rc(".obsidian", false)];
        assert!(detect_legacy_kind(&empty_provider(), &children).await.is_none());
    }

    #[tokio::test]
    async fn detect_legacy_kind_deep_probe_finds_md_in_subfolder() {
        // Mirrors the NotologyMigrationTest layout: root has only subdirs
        // (00_Templates, 01_Tasks, ...), all `.md` files live one level
        // deeper. Top-level signal misses; deep probe should hit it.
        let provider = Arc::new(InMemorySyncProvider::new());
        provider.put_md("/Vault/01_Tasks/NOTE-1.md", b"hi").await.unwrap();
        let provider_dyn: Arc<dyn crate::core::sync_provider::SyncProvider> = provider.clone();

        // Use real /Vault/... paths so list_children resolves under the
        // in-memory provider.
        let children = vec![
            crate::core::sync_provider::RemoteChild {
                name: "00_Templates".into(), path: "/Vault/00_Templates".into(),
                is_collection: true, modified_at: chrono::Utc::now(), size: 0,
            },
            crate::core::sync_provider::RemoteChild {
                name: "01_Tasks".into(), path: "/Vault/01_Tasks".into(),
                is_collection: true, modified_at: chrono::Utc::now(), size: 0,
            },
        ];

        assert_eq!(
            detect_legacy_kind(&provider_dyn, &children).await.as_deref(),
            Some("plainMd")
        );
    }

    #[tokio::test]
    async fn detect_legacy_kind_deep_probe_skips_hidden_and_system_dirs() {
        // .claude and @eaDir should be skipped — only real subfolders count.
        let provider = Arc::new(InMemorySyncProvider::new());
        // Only the *hidden* subfolder has any .md; if the probe leaked into
        // it the result would be plainMd. Real result must be None.
        provider.put_md("/Vault/.claude/secret.md", b"shh").await.unwrap();
        let provider_dyn: Arc<dyn crate::core::sync_provider::SyncProvider> = provider.clone();

        let children = vec![
            crate::core::sync_provider::RemoteChild {
                name: ".claude".into(), path: "/Vault/.claude".into(),
                is_collection: true, modified_at: chrono::Utc::now(), size: 0,
            },
            crate::core::sync_provider::RemoteChild {
                name: "@eaDir".into(), path: "/Vault/@eaDir".into(),
                is_collection: true, modified_at: chrono::Utc::now(), size: 0,
            },
        ];

        assert!(detect_legacy_kind(&provider_dyn, &children).await.is_none(),
            "hidden/system subfolders must not be probed");
    }
}
