//! Vault lifecycle actions: open, create, delete.
//! All operations validate `.notology` presence before proceeding.

use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;

use sha2::{Sha256, Digest};

use crate::core::sync_provider::SyncProvider;

/// Verify that a remote path is a valid Notology vault (.notology exists).
pub async fn verify_vault(
    provider: &Arc<dyn SyncProvider>,
    remote_path: &str,
) -> Result<bool, String> {
    let children = provider.list_children(remote_path).await
        .map_err(|e| format!("verify_vault list_children: {}", e))?;
    Ok(children.iter().any(|c| c.name == ".notology" && c.is_collection))
}

/// Open a vault from a known NAS path.
/// Validates .notology presence + computes deterministic local path + ensures local dir exists.
pub async fn open_vault_from_path(
    provider: &Arc<dyn SyncProvider>,
    remote_path: &str,
    local_data_dir: &Path,
    nas_url: &str,
) -> Result<VaultOpenResult, String> {
    let remote = remote_path.trim_end_matches('/');

    // Verify .notology exists
    if !verify_vault(provider, remote).await? {
        return Err(format!(
            "Not a Notology vault: {} (missing .notology directory)", remote
        ));
    }

    let name = remote.rsplit('/').next().unwrap_or(remote).to_string();
    let local_path = compute_local_path(local_data_dir, nas_url, &name);

    // Ensure local directory exists (sync engine will populate via reconciliation)
    std::fs::create_dir_all(&local_path)
        .map_err(|e| format!("create local dir: {}", e))?;

    Ok(VaultOpenResult {
        name,
        remote_path: remote.to_string(),
        local_path: local_path.to_string_lossy().to_string(),
    })
}

/// Result of opening a vault.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultOpenResult {
    pub name: String,
    pub remote_path: String,
    pub local_path: String,
}

/// Compute deterministic local path for a vault.
/// Pattern: {local_data_dir}/vaults/{url_hash}/{vault_name}
pub fn compute_local_path(local_data_dir: &Path, url: &str, vault_name: &str) -> PathBuf {
    let mut hasher = Sha256::new();
    hasher.update(url.as_bytes());
    let hash = hasher.finalize();
    let url_hash = format!("{:016x}", u64::from_be_bytes(hash[..8].try_into().unwrap()));
    local_data_dir.join("vaults").join(url_hash).join(vault_name)
}

/// Create a new vault on NAS.
/// Creates the directory + `.notology/` marker + local dir. NAS must be online.
pub async fn create_vault(
    provider: &Arc<dyn SyncProvider>,
    remote_path: &str,
    local_data_dir: &Path,
    nas_url: &str,
    device_id: &str,
) -> Result<VaultOpenResult, String> {
    let remote = remote_path.trim_end_matches('/');
    log::info!("[create_vault] starting: remote={}, device={}", remote, device_id);

    // Check NAS reachability
    provider.test_connection().await
        .map_err(|e| {
            log::error!("[create_vault] NAS unreachable: {}", e);
            format!("NAS not reachable: {}", e)
        })?;

    // Create .notology marker directory (put_md with a marker file)
    let marker_path = format!("{}/.notology/vault.json", remote);
    log::info!("[create_vault] PUT marker: {}", marker_path);
    let marker_content = serde_json::json!({
        "created_at": chrono::Utc::now().to_rfc3339(),
        "created_by_device_id": device_id,
        "schema_version": "2",
    });
    let bytes = serde_json::to_vec_pretty(&marker_content)
        .map_err(|e| format!("serialize marker: {}", e))?;
    provider.put_md(&marker_path, &bytes).await
        .map_err(|e| {
            log::error!("[create_vault] put_md failed for {}: {}", marker_path, e);
            format!("create vault marker: {}", e)
        })?;
    log::info!("[create_vault] marker PUT success");

    let name = remote.rsplit('/').next().unwrap_or(remote).to_string();
    let local_path = compute_local_path(local_data_dir, nas_url, &name);
    std::fs::create_dir_all(&local_path)
        .map_err(|e| format!("create local dir: {}", e))?;

    log::info!("[vault_actions] created vault: {} at {} (local: {})", name, remote, local_path.display());
    Ok(VaultOpenResult {
        name,
        remote_path: remote.to_string(),
        local_path: local_path.to_string_lossy().to_string(),
    })
}

/// Delete local vault data (does NOT delete NAS data).
/// Removes local sync config for this vault.
pub fn delete_vault_locally(
    config_dir: &Path,
    vault_path: &Path,
) -> Result<(), String> {
    // Remove per-vault sync_v2 config
    let config_result = crate::features::sync_v2::config::delete_config(config_dir, vault_path);
    if let Err(e) = config_result {
        log::warn!("[vault_actions] delete local config failed: {}", e);
    }
    log::info!("[vault_actions] deleted local vault config for {:?}", vault_path);
    Ok(())
}

// ── Phase 3-B: rename + full delete ──────────────────────────

/// Number of retry attempts for rename/delete against a directory that
/// may still hold residual OS handles from a recently-torn-down sync
/// engine. 6 × 500ms = 3s total, which empirically covers SQLite WAL
/// connection drop + Tantivy mmap release + in-flight tokio task wind-down.
const LOCAL_FS_RETRY_COUNT: u32 = 6;
const LOCAL_FS_RETRY_DELAY_MS: u64 = 500;

/// Try `std::fs::rename` with brief backoff for ERROR_ACCESS_DENIED / EACCES.
/// Other errors fail fast. See `LOCAL_FS_RETRY_COUNT` for context.
fn rename_with_backoff(from: &Path, to: &Path) -> std::io::Result<()> {
    let mut last_err: Option<std::io::Error> = None;
    for attempt in 0..LOCAL_FS_RETRY_COUNT {
        match std::fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(e) => {
                let kind = e.kind();
                let retryable = matches!(
                    kind,
                    std::io::ErrorKind::PermissionDenied
                        | std::io::ErrorKind::AlreadyExists  // Windows reports busy-as-AlreadyExists in some cases
                ) || e.raw_os_error() == Some(5)             // ERROR_ACCESS_DENIED
                  || e.raw_os_error() == Some(32);           // ERROR_SHARING_VIOLATION
                if !retryable {
                    return Err(e);
                }
                log::warn!(
                    "[vault_actions] rename retry {}/{}: {} ({:?})",
                    attempt + 1, LOCAL_FS_RETRY_COUNT, e, kind
                );
                last_err = Some(e);
                std::thread::sleep(std::time::Duration::from_millis(LOCAL_FS_RETRY_DELAY_MS));
            }
        }
    }
    Err(last_err.unwrap_or_else(|| std::io::Error::other("rename retries exhausted")))
}

/// Try `std::fs::remove_dir_all` with the same backoff policy as
/// `rename_with_backoff`. Used by `delete_vault_full` since the same
/// residual-handle problem applies on delete.
fn remove_dir_all_with_backoff(path: &Path) -> std::io::Result<()> {
    let mut last_err: Option<std::io::Error> = None;
    for attempt in 0..LOCAL_FS_RETRY_COUNT {
        match std::fs::remove_dir_all(path) {
            Ok(()) => return Ok(()),
            Err(e) => {
                let kind = e.kind();
                let retryable = matches!(kind, std::io::ErrorKind::PermissionDenied)
                    || e.raw_os_error() == Some(5)
                    || e.raw_os_error() == Some(32);
                if !retryable {
                    return Err(e);
                }
                log::warn!(
                    "[vault_actions] remove_dir_all retry {}/{}: {} ({:?})",
                    attempt + 1, LOCAL_FS_RETRY_COUNT, e, kind
                );
                last_err = Some(e);
                std::thread::sleep(std::time::Duration::from_millis(LOCAL_FS_RETRY_DELAY_MS));
            }
        }
    }
    Err(last_err.unwrap_or_else(|| std::io::Error::other("remove_dir_all retries exhausted")))
}

/// Outcome of `rename_vault` — returned to the UI so it can re-open the
/// vault under its new local path / re-run discovery against the new
/// remote path.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameOutcome {
    pub new_local_path: PathBuf,
    pub new_remote_path: String,
}

/// Tri-state report for `delete_vault_full`. The UI surfaces each flag so
/// the user can tell what survived (e.g. NAS preserved when they only
/// asked for local removal, or local stuck because of a file lock).
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteOutcome {
    pub local_removed: bool,
    pub remote_removed: bool,
    pub config_removed: bool,
}

/// Validate a proposed vault name. Bans path separators, `.notology`,
/// leading dots, empty strings, and overly long names. Mirrors NAS
/// filesystem constraints — Synology rejects most of these too, but we
/// reject early so the user sees a clear message instead of an opaque
/// WebDAV 4xx.
pub fn validate_vault_name(name: &str) -> Result<(), String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("이름이 비어있습니다".into());
    }
    if trimmed.len() > 100 {
        return Err("이름이 너무 깁니다 (100자 이하)".into());
    }
    if trimmed.starts_with('.') {
        return Err("이름은 마침표(.)로 시작할 수 없습니다".into());
    }
    if trimmed == ".notology" {
        return Err("'.notology'는 예약된 이름입니다".into());
    }
    if trimmed.contains('/') || trimmed.contains('\\') {
        return Err("이름에 슬래시(/, \\)를 사용할 수 없습니다".into());
    }
    if trimmed.chars().any(|c| matches!(c, ':' | '*' | '?' | '"' | '<' | '>' | '|')) {
        return Err("이름에 사용할 수 없는 문자가 포함되어 있습니다 (: * ? \" < > |)".into());
    }
    Ok(())
}

/// Rename a vault: NAS folder MOVE → local directory rename → per-vault
/// sync config rewrite. The sync engine MUST be stopped before the caller
/// invokes this — otherwise running tasks may write into the old
/// directory mid-rename.
///
/// Order matters: NAS first because rolling back a successful local
/// rename + failed NAS rename would leave the local watcher pointing at a
/// stale directory while the user expects sync to continue.
pub async fn rename_vault(
    provider: &Arc<dyn SyncProvider>,
    remote_parent: &str,
    old_name: &str,
    new_name: &str,
    old_local_path: &Path,
    app_config_dir: &Path,
) -> Result<RenameOutcome, String> {
    validate_vault_name(new_name)?;
    if old_name == new_name {
        return Err("새 이름이 기존 이름과 같습니다".into());
    }

    let parent = remote_parent.trim_end_matches('/');
    let old_remote = format!("{}/{}", parent, old_name);
    let new_remote = format!("{}/{}", parent, new_name);

    let new_local_path = old_local_path
        .parent()
        .ok_or_else(|| format!("부모 디렉토리를 찾을 수 없습니다: {:?}", old_local_path))?
        .join(new_name);

    // Pre-check: if the local destination already exists, decide between
    // "real collision" (a different vault genuinely lives there) vs "stale
    // orphan" (leftover from an earlier failed rename — NAS has no vault
    // there anymore). NAS is source of truth: if NAS lacks `.notology` at
    // the target, the local dir is an orphan and we quarantine it instead
    // of refusing the operation. We never delete user data; the orphan is
    // renamed to `<name>.orphan-<timestamp>` so the user can inspect or
    // remove it later.
    if new_local_path.exists() {
        let nas_target_exists = verify_vault(provider, &new_remote).await.unwrap_or(false);
        if nas_target_exists {
            return Err(format!(
                "NAS에 이미 '{}' 이름의 보관소가 존재합니다. 다른 이름을 사용하세요.",
                new_name
            ));
        }
        let ts = chrono::Utc::now().format("%Y%m%d-%H%M%S");
        let quarantine = new_local_path
            .with_file_name(format!("{}.orphan-{}", new_name, ts));
        rename_with_backoff(&new_local_path, &quarantine).map_err(|e| {
            format!(
                "기존 로컬 폴더({:?})를 격리하지 못했습니다: {}. \
                 다른 프로그램이 사용 중일 수 있으니 잠시 후 다시 시도하세요.",
                new_local_path, e
            )
        })?;
        log::warn!(
            "[vault_actions] quarantined orphan local dir before rename: {:?} → {:?}",
            new_local_path, quarantine
        );
        // Drop the orphan's stale per-vault sync config so it doesn't get
        // re-picked up; failure here is non-fatal (config may not exist).
        let _ = crate::features::sync_v2::config::delete_config(
            app_config_dir, &new_local_path,
        );
    }

    // 1. NAS rename.
    provider.move_collection(&old_remote, &new_remote).await
        .map_err(|e| format!("NAS 이름 변경 실패: {}", e))?;

    // 2. Local rename with retry-and-rollback. A vault that was active a
    //    few seconds ago still has live OS file handles (SQLite WAL on
    //    queue.db, Tantivy index mmaps, in-flight tokio tasks holding
    //    refs into the Arc<SyncEngine>). Teardown only signals stop —
    //    actual handle release is async. Retry briefly to ride that out;
    //    on exhaustion roll the NAS rename back so we don't leave the
    //    user in a half-renamed state.
    if let Err(e) = rename_with_backoff(old_local_path, &new_local_path) {
        log::error!(
            "[vault_actions] NAS rename succeeded but local rename failed after retries: \
             from={:?} to={:?}: {}. Rolling NAS back to '{}'.",
            old_local_path, new_local_path, e, old_remote
        );
        // Best-effort rollback. If this also fails, surface both errors
        // so the user knows exactly what state things are in.
        match provider.move_collection(&new_remote, &old_remote).await {
            Ok(()) => {
                return Err(format!(
                    "로컬 디렉토리 이름 변경 실패: {}. NAS 변경은 자동으로 되돌렸습니다.",
                    e
                ));
            }
            Err(rollback_err) => {
                log::error!(
                    "[vault_actions] NAS rollback ALSO failed: {}. NAS={}, local={}.",
                    rollback_err, new_remote, old_name
                );
                return Err(format!(
                    "로컬 변경 실패: {}. NAS 자동 복구도 실패: {}. \
                     수동 복구: NAS '{}' 를 '{}' 으로 되돌리거나, 로컬 디렉토리를 '{}' 로 변경하세요.",
                    e, rollback_err, new_remote, old_remote, new_name
                ));
            }
        }
    }

    // 3. Migrate per-vault sync config (its file path is keyed by vault
    //    hash, so a renamed vault gets a new hash → new file). Update
    //    `remote_base` to point at the new NAS path.
    if let Ok(cfg) = crate::features::sync_v2::config::load_config(app_config_dir, old_local_path) {
        let mut new_cfg = cfg.clone();
        new_cfg.remote_base = new_remote.clone();
        if let Err(e) = crate::features::sync_v2::config::save_config(app_config_dir, &new_local_path, &new_cfg) {
            log::warn!("[vault_actions] save new config failed (non-fatal): {}", e);
        }
        let _ = crate::features::sync_v2::config::delete_config(app_config_dir, old_local_path);
    }

    log::info!(
        "[vault_actions] renamed: {:?} → {:?} (NAS: {} → {})",
        old_local_path, new_local_path, old_remote, new_remote
    );

    Ok(RenameOutcome { new_local_path, new_remote_path: new_remote })
}

// ── Orphan local-dir cleanup ─────────────────────────────────

/// One stale local vault cache surfaced to the UI for confirmation.
/// `name` is the directory name (e.g. "한글-테스트"); `file_count`/`size_bytes`
/// help the user judge whether to delete (small + stale = safe).
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrphanLocalVault {
    pub local_path: PathBuf,
    pub name: String,
    pub file_count: usize,
    pub size_bytes: u64,
    /// True iff this dir was already quarantined by an earlier failed
    /// rename (its name ends in `.orphan-<ts>`). UI can pre-check these
    /// since the user already implicitly accepted them as disposable.
    pub already_quarantined: bool,
}

fn compute_dir_stats(path: &Path) -> std::io::Result<(usize, u64)> {
    let mut count = 0usize;
    let mut size = 0u64;
    let mut stack = vec![path.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir)? {
            let entry = entry?;
            let ft = entry.file_type()?;
            if ft.is_dir() {
                stack.push(entry.path());
            } else if ft.is_file() {
                count += 1;
                if let Ok(m) = entry.metadata() {
                    size += m.len();
                }
            }
        }
    }
    Ok((count, size))
}

/// Resolve the per-NAS-URL local vault parent: `<local_data_dir>/vaults/<url_hash>`.
/// Returns the path even if it doesn't exist (caller decides what to do).
pub fn vault_parent_for_url(local_data_dir: &Path, nas_url: &str) -> PathBuf {
    let mut hasher = Sha256::new();
    hasher.update(nas_url.as_bytes());
    let hash = hasher.finalize();
    let url_hash = format!("{:016x}", u64::from_be_bytes(hash[..8].try_into().unwrap()));
    local_data_dir.join("vaults").join(url_hash)
}

/// Scan the per-URL vault parent for dirs that don't correspond to any
/// known NAS vault. The local vault dir is a sync cache, so anything not
/// represented on NAS is dead weight from a previous rename/delete that
/// didn't fully tear down. Caller passes the active vault's local_path
/// so the currently-open one is never offered for deletion.
pub fn list_orphan_local_dirs(
    local_data_dir: &Path,
    nas_url: &str,
    known_nas_vault_names: &[String],
    active_local_path: Option<&Path>,
) -> Result<Vec<OrphanLocalVault>, String> {
    let parent = vault_parent_for_url(local_data_dir, nas_url);
    if !parent.exists() {
        return Ok(vec![]);
    }
    let known: std::collections::HashSet<&str> =
        known_nas_vault_names.iter().map(|s| s.as_str()).collect();

    let mut orphans = Vec::new();
    for entry in std::fs::read_dir(&parent).map_err(|e| format!("read_dir: {}", e))? {
        let entry = entry.map_err(|e| format!("entry: {}", e))?;
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let name = match path.file_name().and_then(|n| n.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        if let Some(active) = active_local_path {
            if path == active {
                continue;
            }
        }
        // A `.orphan-<ts>` suffix means a previous rename quarantined it
        // — definitely not on NAS, always an orphan. For everything else,
        // match against the known NAS names. The `<base>.orphan-` prefix
        // check handles arbitrary-base names.
        let already_quarantined = name
            .rsplit_once(".orphan-")
            .map(|(_, ts)| !ts.is_empty() && ts.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'))
            .unwrap_or(false);
        if !already_quarantined && known.contains(name.as_str()) {
            continue;
        }

        let (file_count, size_bytes) = compute_dir_stats(&path).unwrap_or((0, 0));
        orphans.push(OrphanLocalVault {
            local_path: path,
            name,
            file_count,
            size_bytes,
            already_quarantined,
        });
    }
    // Stable order: name asc — keeps the dialog list deterministic across calls.
    orphans.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(orphans)
}

/// Delete the given orphan local vault directories. Each is removed with
/// the same retry-on-EACCES backoff as `delete_vault_full`. Per-vault
/// sync configs are also cleaned. Returns per-path success/failure so
/// the UI can show partial outcomes.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrphanDeleteOutcome {
    pub local_path: PathBuf,
    pub removed: bool,
    pub error: Option<String>,
}

pub fn delete_orphan_local_dirs(
    paths: &[PathBuf],
    app_config_dir: &Path,
) -> Vec<OrphanDeleteOutcome> {
    paths.iter().map(|p| {
        if !p.exists() {
            return OrphanDeleteOutcome {
                local_path: p.clone(),
                removed: true,  // already gone, treat as success
                error: None,
            };
        }
        match remove_dir_all_with_backoff(p) {
            Ok(()) => {
                let _ = crate::features::sync_v2::config::delete_config(app_config_dir, p);
                log::info!("[vault_actions] orphan removed: {:?}", p);
                OrphanDeleteOutcome { local_path: p.clone(), removed: true, error: None }
            }
            Err(e) => {
                log::warn!("[vault_actions] orphan delete failed: {:?}: {}", p, e);
                OrphanDeleteOutcome {
                    local_path: p.clone(),
                    removed: false,
                    error: Some(e.to_string()),
                }
            }
        }
    }).collect()
}

/// Delete a vault end-to-end. `delete_remote=true` also wipes the NAS
/// copy — only pass true when the user explicitly opted in (the dialog
/// keeps the checkbox unchecked by default).
///
/// Returns a per-step report rather than a single Result so the UI can
/// tell the user what survived (e.g., NAS still there because they kept
/// the checkbox off, or local stuck because of a file lock).
pub async fn delete_vault_full(
    provider: &Arc<dyn SyncProvider>,
    remote_path: &str,
    local_path: &Path,
    app_config_dir: &Path,
    delete_remote: bool,
) -> Result<DeleteOutcome, String> {
    let mut outcome = DeleteOutcome {
        local_removed: false,
        remote_removed: false,
        config_removed: false,
    };

    // 1. Remote delete (opt-in). Failure here is logged but doesn't abort
    //    the local cleanup — the user already committed to removal.
    if delete_remote {
        match provider.delete_collection(remote_path).await {
            Ok(()) => {
                outcome.remote_removed = true;
                log::info!("[vault_actions] NAS deleted: {}", remote_path);
            }
            Err(e) => {
                log::warn!("[vault_actions] NAS delete failed: {}", e);
            }
        }
    }

    // 2. Local delete. Same residual-handle concerns as rename — retry
    //    briefly on ACCESS_DENIED / SHARING_VIOLATION before giving up.
    if local_path.exists() {
        match remove_dir_all_with_backoff(local_path) {
            Ok(()) => {
                outcome.local_removed = true;
                log::info!("[vault_actions] local deleted: {:?}", local_path);
            }
            Err(e) => {
                log::error!("[vault_actions] local delete failed after retries: {:?}: {}", local_path, e);
                return Err(format!("로컬 디렉토리 삭제 실패: {}", e));
            }
        }
    }

    // 3. Per-vault config cleanup.
    if let Err(e) = crate::features::sync_v2::config::delete_config(app_config_dir, local_path) {
        log::warn!("[vault_actions] config delete failed (non-fatal): {}", e);
    } else {
        outcome.config_removed = true;
    }

    Ok(outcome)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::sync_v2::in_memory_provider::InMemorySyncProvider;

    #[test]
    fn validate_rejects_empty() {
        assert!(validate_vault_name("").is_err());
        assert!(validate_vault_name("   ").is_err());
    }

    #[test]
    fn validate_rejects_path_separators() {
        assert!(validate_vault_name("foo/bar").is_err());
        assert!(validate_vault_name("foo\\bar").is_err());
    }

    #[test]
    fn validate_rejects_dot_prefix_and_notology() {
        assert!(validate_vault_name(".hidden").is_err());
        assert!(validate_vault_name(".notology").is_err());
    }

    #[test]
    fn validate_rejects_special_chars() {
        for c in [':', '*', '?', '"', '<', '>', '|'] {
            assert!(validate_vault_name(&format!("foo{}bar", c)).is_err(), "char {}", c);
        }
    }

    #[test]
    fn validate_accepts_normal_names() {
        assert!(validate_vault_name("MyVault").is_ok());
        assert!(validate_vault_name("프로젝트").is_ok());
        assert!(validate_vault_name("notes-2026").is_ok());
        assert!(validate_vault_name("a.b").is_ok()); // dot allowed mid-name
    }

    #[tokio::test]
    async fn rename_moves_nas_folder_and_config() {
        let tmp = tempfile::tempdir().unwrap();
        let cfg_dir = tmp.path().join("config");
        std::fs::create_dir_all(&cfg_dir).unwrap();
        let parent_local = tmp.path().join("vaults").join("hash1");
        let old_local = parent_local.join("OldName");
        std::fs::create_dir_all(&old_local).unwrap();
        std::fs::write(old_local.join("note.md"), b"hi").unwrap();

        let provider = Arc::new(InMemorySyncProvider::new());
        let provider_dyn: Arc<dyn SyncProvider> = provider.clone();
        provider.put_md("/Colony/OldName/note.md", b"hi").await.unwrap();

        crate::features::sync_v2::config::save_config(&cfg_dir, &old_local,
            &crate::features::sync_v2::config::SyncV2Config {
                enabled: true,
                remote_base: "/Colony/OldName".into(),
                ..Default::default()
            }).unwrap();

        let outcome = rename_vault(
            &provider_dyn, "/Colony", "OldName", "NewName",
            &old_local, &cfg_dir,
        ).await.unwrap();

        assert!(provider.get_md("/Colony/OldName/note.md").await.unwrap().is_none());
        assert!(provider.get_md("/Colony/NewName/note.md").await.unwrap().is_some());
        assert!(!old_local.exists());
        assert!(outcome.new_local_path.exists());
        assert_eq!(outcome.new_remote_path, "/Colony/NewName");

        let new_cfg = crate::features::sync_v2::config::load_config(&cfg_dir, &outcome.new_local_path).unwrap();
        assert_eq!(new_cfg.remote_base, "/Colony/NewName");
    }

    #[test]
    fn rename_backoff_succeeds_on_first_try_for_normal_case() {
        let tmp = tempfile::tempdir().unwrap();
        let from = tmp.path().join("a");
        let to = tmp.path().join("b");
        std::fs::create_dir_all(&from).unwrap();
        rename_with_backoff(&from, &to).unwrap();
        assert!(!from.exists());
        assert!(to.exists());
    }

    #[test]
    fn rename_backoff_fails_fast_on_non_retryable_error() {
        // Source missing → NotFound, which is not in the retry list — must
        // fail immediately rather than waste 3s retrying. We assert the
        // call returns quickly by checking the error kind, not by timing.
        let tmp = tempfile::tempdir().unwrap();
        let from = tmp.path().join("missing");
        let to = tmp.path().join("dest");
        let err = rename_with_backoff(&from, &to).unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::NotFound);
    }

    #[test]
    fn remove_dir_all_backoff_succeeds_on_normal_case() {
        let tmp = tempfile::tempdir().unwrap();
        let target = tmp.path().join("x");
        std::fs::create_dir_all(target.join("sub")).unwrap();
        std::fs::write(target.join("sub/f.txt"), b"hi").unwrap();
        remove_dir_all_with_backoff(&target).unwrap();
        assert!(!target.exists());
    }

    #[test]
    fn list_orphan_skips_known_nas_vaults_and_active() {
        let tmp = tempfile::tempdir().unwrap();
        let url = "https://nas.test:8080";
        let parent = vault_parent_for_url(tmp.path(), url);
        std::fs::create_dir_all(parent.join("Test")).unwrap();
        std::fs::create_dir_all(parent.join("KeepMe")).unwrap();
        std::fs::create_dir_all(parent.join("StaleA")).unwrap();
        std::fs::create_dir_all(parent.join("Active")).unwrap();
        std::fs::write(parent.join("StaleA/note.md"), b"old").unwrap();

        let known = vec!["Test".to_string(), "KeepMe".to_string(), "Active".to_string()];
        let active = parent.join("Active");
        let orphans = list_orphan_local_dirs(tmp.path(), url, &known, Some(&active)).unwrap();
        assert_eq!(orphans.len(), 1, "only StaleA should be reported, got {:?}",
            orphans.iter().map(|o| &o.name).collect::<Vec<_>>());
        assert_eq!(orphans[0].name, "StaleA");
        assert_eq!(orphans[0].file_count, 1);
        assert!(orphans[0].size_bytes > 0);
        assert!(!orphans[0].already_quarantined);
    }

    #[test]
    fn list_orphan_flags_quarantined_dirs_even_if_basename_matches_known() {
        let tmp = tempfile::tempdir().unwrap();
        let url = "https://nas.test:8080";
        let parent = vault_parent_for_url(tmp.path(), url);
        std::fs::create_dir_all(parent.join("MyVault")).unwrap();
        std::fs::create_dir_all(parent.join("MyVault.orphan-20260505-110900")).unwrap();

        let known = vec!["MyVault".to_string()];
        let orphans = list_orphan_local_dirs(tmp.path(), url, &known, None).unwrap();
        assert_eq!(orphans.len(), 1);
        assert_eq!(orphans[0].name, "MyVault.orphan-20260505-110900");
        assert!(orphans[0].already_quarantined,
            "quarantine suffix must be detected so UI can pre-check");
    }

    #[test]
    fn list_orphan_returns_empty_when_parent_does_not_exist() {
        let tmp = tempfile::tempdir().unwrap();
        let orphans = list_orphan_local_dirs(
            tmp.path(), "https://never-used.test", &[], None,
        ).unwrap();
        assert!(orphans.is_empty());
    }

    #[test]
    fn delete_orphan_removes_dirs_and_reports_per_path() {
        let tmp = tempfile::tempdir().unwrap();
        let cfg_dir = tmp.path().join("cfg");
        std::fs::create_dir_all(&cfg_dir).unwrap();
        let a = tmp.path().join("orphans").join("A");
        let b = tmp.path().join("orphans").join("B");
        let missing = tmp.path().join("orphans").join("Missing");  // never created
        std::fs::create_dir_all(a.join("sub")).unwrap();
        std::fs::write(a.join("sub/f.md"), b"hi").unwrap();
        std::fs::create_dir_all(&b).unwrap();

        let outcomes = delete_orphan_local_dirs(
            &[a.clone(), b.clone(), missing.clone()],
            &cfg_dir,
        );
        assert_eq!(outcomes.len(), 3);
        assert!(outcomes.iter().all(|o| o.removed),
            "all three should report removed (missing one is treated as already-gone)");
        assert!(!a.exists());
        assert!(!b.exists());
    }

    #[tokio::test]
    async fn rename_rejects_when_nas_has_real_collision_at_target() {
        // Both local AND NAS have a vault at the target name → real
        // collision, must refuse (otherwise NAS MOVE would clobber a real
        // vault).
        let tmp = tempfile::tempdir().unwrap();
        let cfg_dir = tmp.path().join("config");
        std::fs::create_dir_all(&cfg_dir).unwrap();
        let parent = tmp.path().join("vaults");
        let old = parent.join("OldName");
        let collision = parent.join("NewName");
        std::fs::create_dir_all(&old).unwrap();
        std::fs::create_dir_all(&collision).unwrap();

        let provider = Arc::new(InMemorySyncProvider::new());
        let provider_dyn: Arc<dyn SyncProvider> = provider.clone();
        // NAS also has a real vault at /Colony/NewName
        provider.put_md("/Colony/NewName/.notology/vault.json", b"{}").await.unwrap();

        let res = rename_vault(
            &provider_dyn, "/Colony", "OldName", "NewName",
            &old, &cfg_dir,
        ).await;
        assert!(res.is_err(), "should reject when NAS already has vault at target");
        let msg = res.unwrap_err();
        assert!(msg.contains("NAS에 이미"), "expected NAS-collision message, got: {}", msg);
    }

    #[tokio::test]
    async fn rename_quarantines_local_orphan_and_proceeds() {
        // Local target dir exists (orphan from a previous failed rename),
        // but NAS has nothing there → quarantine the orphan and continue.
        let tmp = tempfile::tempdir().unwrap();
        let cfg_dir = tmp.path().join("config");
        std::fs::create_dir_all(&cfg_dir).unwrap();
        let parent = tmp.path().join("vaults").join("hash");
        let old = parent.join("OldName");
        let orphan = parent.join("NewName");
        std::fs::create_dir_all(&old).unwrap();
        std::fs::create_dir_all(&orphan).unwrap();
        std::fs::write(orphan.join("stale.md"), b"old data").unwrap();

        let provider = Arc::new(InMemorySyncProvider::new());
        let provider_dyn: Arc<dyn SyncProvider> = provider.clone();
        provider.put_md("/Colony/OldName/.notology/vault.json", b"{}").await.unwrap();
        provider.put_md("/Colony/OldName/note.md", b"hi").await.unwrap();

        let outcome = rename_vault(
            &provider_dyn, "/Colony", "OldName", "NewName",
            &old, &cfg_dir,
        ).await.expect("rename should succeed by quarantining orphan");

        // The orphan got moved aside, not deleted — its file must still
        // be reachable via the quarantine path.
        let quarantine_glob = std::fs::read_dir(&parent).unwrap()
            .filter_map(|e| e.ok())
            .find(|e| {
                let n = e.file_name().to_string_lossy().to_string();
                n.starts_with("NewName.orphan-")
            });
        assert!(quarantine_glob.is_some(), "orphan should have been moved to NewName.orphan-<ts>");
        let q = quarantine_glob.unwrap().path();
        assert!(q.join("stale.md").exists(), "orphan data must be preserved");

        // Rename target itself now exists with the moved old vault.
        assert!(outcome.new_local_path.exists());
        assert_eq!(outcome.new_remote_path, "/Colony/NewName");
        assert!(provider.get_md("/Colony/NewName/note.md").await.unwrap().is_some());
    }

    #[tokio::test]
    async fn delete_local_only_preserves_nas() {
        let tmp = tempfile::tempdir().unwrap();
        let cfg_dir = tmp.path().join("config");
        std::fs::create_dir_all(&cfg_dir).unwrap();
        let local = tmp.path().join("vaults").join("hash1").join("MyVault");
        std::fs::create_dir_all(&local).unwrap();
        std::fs::write(local.join("note.md"), b"hi").unwrap();

        let provider = Arc::new(InMemorySyncProvider::new());
        let provider_dyn: Arc<dyn SyncProvider> = provider.clone();
        provider.put_md("/Colony/MyVault/note.md", b"hi").await.unwrap();

        let outcome = delete_vault_full(
            &provider_dyn, "/Colony/MyVault", &local, &cfg_dir, false,
        ).await.unwrap();

        assert!(outcome.local_removed);
        assert!(!outcome.remote_removed, "delete_remote=false → NAS preserved");
        assert!(!local.exists());
        assert!(provider.get_md("/Colony/MyVault/note.md").await.unwrap().is_some(),
            "NAS file must still exist");
    }

    #[tokio::test]
    async fn delete_with_remote_wipes_nas_and_preserves_siblings() {
        let tmp = tempfile::tempdir().unwrap();
        let cfg_dir = tmp.path().join("config");
        std::fs::create_dir_all(&cfg_dir).unwrap();
        let local = tmp.path().join("vaults").join("hash2").join("MyVault");
        std::fs::create_dir_all(&local).unwrap();

        let provider = Arc::new(InMemorySyncProvider::new());
        let provider_dyn: Arc<dyn SyncProvider> = provider.clone();
        provider.put_md("/Colony/MyVault/a.md", b"a").await.unwrap();
        provider.put_md("/Colony/MyVault/sub/b.md", b"b").await.unwrap();
        provider.put_md("/Colony/Other/keep.md", b"k").await.unwrap();

        let outcome = delete_vault_full(
            &provider_dyn, "/Colony/MyVault", &local, &cfg_dir, true,
        ).await.unwrap();

        assert!(outcome.local_removed);
        assert!(outcome.remote_removed);
        assert!(provider.get_md("/Colony/MyVault/a.md").await.unwrap().is_none());
        assert!(provider.get_md("/Colony/MyVault/sub/b.md").await.unwrap().is_none());
        assert!(provider.get_md("/Colony/Other/keep.md").await.unwrap().is_some());
    }
}
