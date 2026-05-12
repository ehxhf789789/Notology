//! Vault migration from v1 (sync-only) to v2 (CAS + Version DAG + Refs).
//!
//! Converts existing Notology vaults by:
//! 1. Backing up `.notology/sync/` to `.notology/sync-v1-backup/`
//! 2. Ensuring every note has a frontmatter `id` field
//! 3. Creating CAS objects, Version DAG entries, and Refs for each note
//! 4. Optionally incorporating base snapshots from sync as version 0
//! 5. Verifying all refs point to valid CAS objects
//!
//! Migration is idempotent: already-migrated notes are skipped.
//! State is checkpointed to disk for resume after interruption.

use std::fs;
use std::path::{Path, PathBuf};
use serde::{Serialize, Deserialize};
use chrono::{DateTime, Utc};
use walkdir::WalkDir;

use crate::core::file_io::{atomic_write_file, copy_dir_recursive};
use crate::core::library::Library;
use crate::core::note_id;
use crate::core::refs::NoteRef;
use crate::core::version_dag::VersionDag;

/// Migration state persisted to disk for resume support.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MigrationState {
    /// Target migration version.
    pub version: u32,
    /// Current status.
    pub status: MigrationStatus,
    /// Total number of notes to migrate.
    pub total_notes: usize,
    /// Number of notes successfully migrated so far.
    pub migrated_notes: usize,
    /// Notes that failed migration (after retries).
    pub failed_notes: Vec<FailedNote>,
    /// Last successfully migrated path (for resume).
    pub last_migrated_path: Option<String>,
    /// When migration started.
    pub started_at: DateTime<Utc>,
    /// When migration completed (if finished).
    pub completed_at: Option<DateTime<Utc>>,
    /// Reason for catastrophic failure (if any).
    pub last_failure_reason: Option<String>,
}

/// A note that failed migration.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FailedNote {
    /// Relative path within the vault.
    pub path: String,
    /// Error message from last attempt.
    pub reason: String,
    /// Number of attempts made.
    pub attempts: u32,
}

/// Migration status.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum MigrationStatus {
    NotStarted,
    InProgress,
    Completed,
    Failed,
    Declined,
}

/// Pre-migration report (informational, no side effects).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PreMigrationReport {
    pub needs_migration: bool,
    pub total_notes: usize,
    pub has_sync_backup: bool,
}

// ═══ Public API ════════════════════════════════════════════════════

/// Get the migration version of a vault. Returns 0 if not migrated, 2 if complete.
pub fn get_migration_version(vault_path: &Path) -> u32 {
    let path = vault_path.join(".notology").join("migration-version");
    fs::read_to_string(&path)
        .ok()
        .and_then(|s| s.trim().parse::<u32>().ok())
        .unwrap_or(0)
}

/// Check if migration is needed for this vault.
pub fn needs_migration(vault_path: &Path) -> bool {
    if get_migration_version(vault_path) >= 2 {
        return false;
    }
    if vault_path.join(".notology").join("migration-declined").is_file() {
        return false;
    }
    has_any_md_file(vault_path)
}

/// Pre-migration check: returns report without starting migration.
pub fn pre_migration_check(vault_path: &Path) -> Result<PreMigrationReport, String> {
    let notes = enumerate_notes(vault_path);
    let has_sync_backup = vault_path.join(".notology").join("sync-v1-backup").is_dir();
    Ok(PreMigrationReport {
        needs_migration: needs_migration(vault_path),
        total_notes: notes.len(),
        has_sync_backup,
    })
}

/// Run the full migration. Blocking. Emits progress via callback.
pub fn run_migration(
    vault_path: &Path,
    device_id: &str,
    on_progress: impl Fn(usize, usize),
) -> Result<MigrationState, String> {
    let notes = enumerate_notes(vault_path);
    let total = notes.len();

    let mut state = MigrationState {
        version: 2,
        status: MigrationStatus::InProgress,
        total_notes: total,
        migrated_notes: 0,
        failed_notes: Vec::new(),
        last_migrated_path: None,
        started_at: Utc::now(),
        completed_at: None,
        last_failure_reason: None,
    };
    save_state(vault_path, &state)?;

    // Phase 1: Backup
    create_backup(vault_path)?;

    // Phase 2: Initialize library (creates objects/, history/, refs/)
    let library = Library::new_with_device_id(vault_path, device_id.to_string())
        .map_err(|e| format!("run_migration: library init failed: {}", e))?;

    // Phase 3: Per-note migration
    let batch_size = progress_batch_size(total);
    migrate_notes(vault_path, &library, &notes, &mut state, batch_size, &on_progress)?;

    // Phase 4: Verification
    let issues = verify_migration_internal(vault_path, &library)?;
    for issue in &issues {
        state.failed_notes.push(FailedNote {
            path: issue.clone(),
            reason: "Verification failed: CAS object or DAG entry missing".into(),
            attempts: 0,
        });
    }

    // Phase 5: Finalize
    set_migration_version(vault_path, 2)?;
    state.status = MigrationStatus::Completed;
    state.completed_at = Some(Utc::now());
    save_state(vault_path, &state)?;
    on_progress(total, total);

    Ok(state)
}

/// Resume an interrupted migration.
pub fn resume_migration(
    vault_path: &Path,
    device_id: &str,
    on_progress: impl Fn(usize, usize),
) -> Result<MigrationState, String> {
    let mut state = load_state(vault_path)?
        .ok_or("resume_migration: no migration state found")?;

    if state.status != MigrationStatus::InProgress {
        return Err(format!("resume_migration: state is {:?}, not InProgress", state.status));
    }

    let notes = enumerate_notes(vault_path);
    state.total_notes = notes.len();

    // Skip notes already migrated (before last_migrated_path)
    let resume_from = state.last_migrated_path.as_deref();
    let remaining: Vec<PathBuf> = if let Some(last_path) = resume_from {
        let last_abs = vault_path.join(last_path);
        let mut found = false;
        notes.into_iter().filter(|p| {
            if found { return true; }
            if *p == last_abs { found = true; }
            false
        }).collect()
    } else {
        notes
    };

    let library = Library::new_with_device_id(vault_path, device_id.to_string())
        .map_err(|e| format!("resume_migration: library init failed: {}", e))?;

    let batch_size = progress_batch_size(state.total_notes);
    migrate_notes(vault_path, &library, &remaining, &mut state, batch_size, &on_progress)?;

    // Verification + finalize
    let issues = verify_migration_internal(vault_path, &library)?;
    for issue in &issues {
        state.failed_notes.push(FailedNote {
            path: issue.clone(),
            reason: "Verification failed".into(),
            attempts: 0,
        });
    }

    set_migration_version(vault_path, 2)?;
    state.status = MigrationStatus::Completed;
    state.completed_at = Some(Utc::now());
    save_state(vault_path, &state)?;
    on_progress(state.total_notes, state.total_notes);

    Ok(state)
}

/// Mark migration as declined for this vault.
pub fn decline_migration(vault_path: &Path) -> Result<(), String> {
    let dir = vault_path.join(".notology");
    fs::create_dir_all(&dir)
        .map_err(|e| format!("decline_migration: failed to create .notology: {}", e))?;
    let path = dir.join("migration-declined");
    fs::write(&path, "declined")
        .map_err(|e| format!("decline_migration: failed to write marker: {}", e))
}

/// Verify migration integrity. Returns list of note IDs with issues.
pub fn verify_migration(vault_path: &Path) -> Result<Vec<String>, String> {
    let library = Library::new(vault_path)
        .map_err(|e| format!("verify_migration: library init failed: {}", e))?;
    verify_migration_internal(vault_path, &library)
}

/// Get current migration state from disk.
pub fn get_migration_state(vault_path: &Path) -> Result<Option<MigrationState>, String> {
    load_state(vault_path)
}

// ═══ Internal helpers ══════════════════════════════════════════════

/// Migrate a list of notes, updating state and emitting progress.
fn migrate_notes(
    vault_path: &Path,
    library: &Library,
    notes: &[PathBuf],
    state: &mut MigrationState,
    batch_size: usize,
    on_progress: &impl Fn(usize, usize),
) -> Result<(), String> {
    for note_path in notes {
        // Idempotent skip: already has id + ref
        if is_already_migrated(note_path, library.refs()) {
            state.migrated_notes += 1;
            if state.migrated_notes % batch_size == 0 {
                on_progress(state.migrated_notes, state.total_notes);
            }
            continue;
        }

        match migrate_single_note(vault_path, note_path, library) {
            Ok(_) => {
                state.migrated_notes += 1;
                if let Ok(rel) = note_path.strip_prefix(vault_path) {
                    state.last_migrated_path = rel.to_str().map(|s| s.to_string());
                }
            }
            Err(e) => {
                let rel_path = note_path.strip_prefix(vault_path)
                    .map(|p| p.to_string_lossy().to_string())
                    .unwrap_or_else(|_| note_path.to_string_lossy().to_string());
                state.failed_notes.push(FailedNote {
                    path: rel_path,
                    reason: e,
                    attempts: 3,
                });
            }
        }

        if state.migrated_notes % batch_size == 0 {
            save_state(vault_path, state)?;
            on_progress(state.migrated_notes, state.total_notes);
        }
    }
    Ok(())
}

/// Migrate a single note: ensure id, create CAS object + DAG + Ref.
fn migrate_single_note(
    vault_path: &Path,
    note_path: &Path,
    library: &Library,
) -> Result<(), String> {
    // Step 1: Ensure id (3 retries)
    let id = ensure_id_with_retry(note_path)?;

    // Step 2: Read current content (with id now in frontmatter)
    let content = fs::read(note_path)
        .map_err(|e| format!("migrate_single_note: read failed for {:?}: {}", note_path, e))?;

    let relative_path = note_path.strip_prefix(vault_path)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();

    // Step 3: Check for base snapshot
    let base_path = vault_path.join(".notology").join("sync").join("base").join(&relative_path);
    if base_path.is_file() {
        // Has base snapshot → create 2-version DAG (base → current)
        let base_content = fs::read(&base_path)
            .map_err(|e| format!("migrate_single_note: read base failed: {}", e))?;
        let base_hash = library.cas().write_object(&base_content)
            .map_err(|e| format!("migrate_single_note: CAS write base failed: {}", e))?;

        let current_hash = library.cas().write_object(&content)
            .map_err(|e| format!("migrate_single_note: CAS write current failed: {}", e))?;

        // Create DAG with two entries
        let mut dag = VersionDag::load(vault_path, &id)
            .map_err(|e| format!("migrate_single_note: DAG load failed: {}", e))?;

        if dag.is_empty() {
            dag.append(base_hash.clone(), None, library.device_id().to_string(), vec![]);
            dag.append(current_hash.clone(), Some(base_hash), library.device_id().to_string(), vec![]);
        }
        dag.save(vault_path, &id)
            .map_err(|e| format!("migrate_single_note: DAG save failed: {}", e))?;

        // Create ref pointing to current
        let etag = get_manifest_etag(vault_path, &relative_path);
        let note_ref = NoteRef {
            note_id: id,
            head_hash: current_hash,
            relative_path,
            updated_at: Utc::now(),
            sync_etag: etag,
        };
        library.refs().set(&note_ref)
            .map_err(|e| format!("migrate_single_note: ref set failed: {}", e))?;
    } else {
        // No base → single-version commit via library
        library.commit_version(&id, &content, &relative_path, vec![])
            .map_err(|e| format!("migrate_single_note: commit failed: {}", e))?;

        // Carry over etag from sync manifest if available
        let etag = get_manifest_etag(vault_path, &relative_path);
        if etag.is_some() {
            if let Err(e) = library.update_sync_etag(&id, etag) {
                log::warn!("migrate_single_note: etag update failed: {}", e);
            }
        }
    }

    Ok(())
}

/// Check if a note is already migrated (has id + ref).
fn is_already_migrated(note_path: &Path, ref_store: &crate::core::refs::RefStore) -> bool {
    let id = match note_id::read_id_from_file(note_path) {
        Ok(Some(id)) => id,
        _ => return false,
    };
    matches!(ref_store.get(&id), Ok(Some(_)))
}

/// Ensure a note has an id, with 3 retries and 100ms delay.
fn ensure_id_with_retry(note_path: &Path) -> Result<String, String> {
    const MAX_ATTEMPTS: u32 = 3;
    const RETRY_DELAY_MS: u64 = 100;

    let mut last_error = String::new();
    for attempt in 1..=MAX_ATTEMPTS {
        match note_id::ensure_id_in_file(note_path) {
            Ok(id) => return Ok(id),
            Err(e) => {
                last_error = e;
                if attempt < MAX_ATTEMPTS {
                    std::thread::sleep(std::time::Duration::from_millis(RETRY_DELAY_MS));
                }
            }
        }
    }
    Err(format!("ensure_id failed after {} attempts: {}", MAX_ATTEMPTS, last_error))
}

/// Look up ETag from sync manifest for a relative path.
fn get_manifest_etag(vault_path: &Path, relative_path: &str) -> Option<String> {
    let manifest_path = vault_path.join(".notology").join("sync").join("manifest.json");
    if !manifest_path.is_file() {
        return None;
    }
    let content = fs::read_to_string(&manifest_path).ok()?;
    let json: serde_json::Value = serde_json::from_str(&content).ok()?;
    let entries = json.get("entries")?.as_object()?;
    // Normalize path separators for lookup
    let normalized = relative_path.replace('\\', "/");
    let entry = entries.get(&normalized)
        .or_else(|| entries.get(relative_path))?;
    entry.get("etag")?.as_str().map(|s| s.to_string())
}

/// Verify all refs point to valid CAS objects and DAG entries.
fn verify_migration_internal(vault_path: &Path, library: &Library) -> Result<Vec<String>, String> {
    let refs = library.refs().list()?;
    let mut issues = Vec::new();

    for note_ref in &refs {
        if !library.cas().has_object(&note_ref.head_hash) {
            issues.push(format!("{}: CAS object missing for {}", note_ref.note_id, note_ref.head_hash));
            continue;
        }
        let dag = VersionDag::load(vault_path, &note_ref.note_id)?;
        if dag.get(&note_ref.head_hash).is_none() {
            issues.push(format!("{}: DAG missing entry for {}", note_ref.note_id, note_ref.head_hash));
        }
    }

    Ok(issues)
}

/// Should this directory entry be traversed during note enumeration?
/// Skips hidden directories (.notology, .git) and _att folders,
/// but always includes the root vault directory itself.
fn should_enter_dir(entry: &walkdir::DirEntry, vault_path: &Path) -> bool {
    // Always enter the root directory (it may have a name starting with '.')
    if entry.path() == vault_path {
        return true;
    }
    let name = entry.file_name().to_string_lossy();
    !name.starts_with('.') && !name.ends_with("_att")
}

/// Enumerate all .md files in vault (excluding hidden dirs and _att folders).
fn enumerate_notes(vault_path: &Path) -> Vec<PathBuf> {
    let vp = vault_path.to_path_buf();
    WalkDir::new(vault_path)
        .into_iter()
        .filter_entry(move |e| should_enter_dir(e, &vp))
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_file())
        .filter(|e| {
            e.path().extension()
                .and_then(|ext| ext.to_str())
                == Some("md")
        })
        .map(|e| e.path().to_path_buf())
        .collect()
}

/// Check if vault has any .md files.
fn has_any_md_file(vault_path: &Path) -> bool {
    let vp = vault_path.to_path_buf();
    WalkDir::new(vault_path)
        .into_iter()
        .filter_entry(move |e| should_enter_dir(e, &vp))
        .filter_map(Result::ok)
        .any(|e| {
            e.file_type().is_file()
                && e.path().extension().and_then(|ext| ext.to_str()) == Some("md")
        })
}

/// Adaptive batch size for progress updates.
fn progress_batch_size(total: usize) -> usize {
    match total {
        0..=100 => 1,
        101..=1000 => 10,
        1001..=10000 => 50,
        _ => 100,
    }
}

/// Create backup of .notology/sync/ → .notology/sync-v1-backup/.
fn create_backup(vault_path: &Path) -> Result<(), String> {
    let src = vault_path.join(".notology").join("sync");
    let dst = vault_path.join(".notology").join("sync-v1-backup");

    if !src.is_dir() {
        return Ok(()); // Nothing to backup
    }
    if dst.exists() {
        return Ok(()); // Backup already exists (resume scenario)
    }

    copy_dir_recursive(&src, &dst)
        .map_err(|e| format!("create_backup: failed to copy sync dir: {}", e))
}

/// Set migration version marker.
fn set_migration_version(vault_path: &Path, version: u32) -> Result<(), String> {
    let path = vault_path.join(".notology").join("migration-version");
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("set_migration_version: create dir failed: {}", e))?;
    }
    atomic_write_file(&path, version.to_string().as_bytes())
}

/// Save migration state to disk.
fn save_state(vault_path: &Path, state: &MigrationState) -> Result<(), String> {
    let path = vault_path.join(".notology").join("migration-state.json");
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("save_state: create dir failed: {}", e))?;
    }
    let bytes = serde_json::to_vec_pretty(state)
        .map_err(|e| format!("save_state: serialize failed: {}", e))?;
    atomic_write_file(&path, &bytes)
}

/// Load migration state from disk.
fn load_state(vault_path: &Path) -> Result<Option<MigrationState>, String> {
    let path = vault_path.join(".notology").join("migration-state.json");
    if !path.is_file() {
        return Ok(None);
    }
    let content = fs::read_to_string(&path)
        .map_err(|e| format!("load_state: read failed: {}", e))?;
    let state: MigrationState = serde_json::from_str(&content)
        .map_err(|e| format!("load_state: parse failed: {}", e))?;
    Ok(Some(state))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn create_vault_with_notes(notes: &[(&str, &str)]) -> TempDir {
        let temp = TempDir::new().unwrap();
        for (rel_path, content) in notes {
            let full = temp.path().join(rel_path);
            if let Some(parent) = full.parent() {
                fs::create_dir_all(parent).unwrap();
            }
            fs::write(&full, content).unwrap();
        }
        temp
    }

    fn noop_progress(_completed: usize, _total: usize) {}

    #[test]
    fn test_needs_migration_new_vault() {
        let temp = TempDir::new().unwrap();
        assert!(!needs_migration(temp.path()));
    }

    #[test]
    fn test_needs_migration_legacy_vault() {
        let temp = create_vault_with_notes(&[
            ("note.md", "---\ntitle: Test\n---\n\nBody"),
        ]);
        assert!(needs_migration(temp.path()));
    }

    #[test]
    fn test_needs_migration_already_migrated() {
        let temp = create_vault_with_notes(&[
            ("note.md", "---\ntitle: Test\n---\n\nBody"),
        ]);
        fs::create_dir_all(temp.path().join(".notology")).unwrap();
        fs::write(temp.path().join(".notology").join("migration-version"), "2").unwrap();
        assert!(!needs_migration(temp.path()));
    }

    #[test]
    fn test_needs_migration_declined() {
        let temp = create_vault_with_notes(&[
            ("note.md", "---\ntitle: Test\n---\n\nBody"),
        ]);
        fs::create_dir_all(temp.path().join(".notology")).unwrap();
        fs::write(temp.path().join(".notology").join("migration-declined"), "declined").unwrap();
        assert!(!needs_migration(temp.path()));
    }

    #[test]
    fn test_migration_empty_vault() {
        let temp = TempDir::new().unwrap();
        let result = run_migration(temp.path(), "TEST-DEV", noop_progress).unwrap();
        assert_eq!(result.status, MigrationStatus::Completed);
        assert_eq!(result.total_notes, 0);
        assert_eq!(result.migrated_notes, 0);
        assert_eq!(get_migration_version(temp.path()), 2);
    }

    #[test]
    fn test_migration_single_note_no_id() {
        let temp = create_vault_with_notes(&[
            ("note.md", "---\ntitle: \"Test Note\"\n---\n\nBody content"),
        ]);
        let result = run_migration(temp.path(), "TEST-DEV", noop_progress).unwrap();
        assert_eq!(result.status, MigrationStatus::Completed);
        assert_eq!(result.migrated_notes, 1);
        assert!(result.failed_notes.is_empty());

        // Note now has id
        let content = fs::read_to_string(temp.path().join("note.md")).unwrap();
        assert!(content.contains("id: \""));

        // Library artifacts exist
        let lib = Library::new(temp.path()).unwrap();
        let id = note_id::read_id_from_file(&temp.path().join("note.md")).unwrap().unwrap();
        assert!(lib.get_head(&id).unwrap().is_some());
    }

    #[test]
    fn test_migration_single_note_with_id() {
        let temp = create_vault_with_notes(&[
            ("note.md", "---\nid: \"20260419100000\"\ntitle: \"Has ID\"\n---\n\nBody"),
        ]);
        let result = run_migration(temp.path(), "TEST-DEV", noop_progress).unwrap();
        assert_eq!(result.status, MigrationStatus::Completed);
        assert_eq!(result.migrated_notes, 1);

        // ID preserved
        let content = fs::read_to_string(temp.path().join("note.md")).unwrap();
        assert!(content.contains("id: \"20260419100000\""));

        let lib = Library::new(temp.path()).unwrap();
        assert!(lib.get_head("20260419100000").unwrap().is_some());
    }

    #[test]
    fn test_migration_multiple_notes() {
        let temp = create_vault_with_notes(&[
            ("a.md", "---\ntitle: A\n---\n\nA content"),
            ("b.md", "---\ntitle: B\n---\n\nB content"),
            ("sub/c.md", "---\ntitle: C\n---\n\nC content"),
            ("sub/deep/d.md", "---\ntitle: D\n---\n\nD content"),
            ("e.md", "---\ntitle: E\n---\n\nE content"),
        ]);
        let result = run_migration(temp.path(), "TEST-DEV", noop_progress).unwrap();
        assert_eq!(result.status, MigrationStatus::Completed);
        assert_eq!(result.migrated_notes, 5);
        assert!(result.failed_notes.is_empty());

        let lib = Library::new(temp.path()).unwrap();
        let refs = lib.refs().list().unwrap();
        assert_eq!(refs.len(), 5);
    }

    #[test]
    fn test_migration_idempotent_resume() {
        let temp = create_vault_with_notes(&[
            ("a.md", "---\ntitle: A\n---\n\nContent A"),
            ("b.md", "---\ntitle: B\n---\n\nContent B"),
        ]);

        // First migration
        let r1 = run_migration(temp.path(), "TEST-DEV", noop_progress).unwrap();
        assert_eq!(r1.migrated_notes, 2);

        // Remove migration version marker to simulate incomplete state
        fs::remove_file(temp.path().join(".notology").join("migration-version")).unwrap();

        // Second migration: should skip already-migrated notes
        let r2 = run_migration(temp.path(), "TEST-DEV", noop_progress).unwrap();
        assert_eq!(r2.status, MigrationStatus::Completed);
        // Notes already have ids+refs, so they're skipped
        assert_eq!(r2.migrated_notes, 2); // counted as migrated (via idempotent skip)

        // Still only 1 version per note (no duplicate commits)
        let lib = Library::new(temp.path()).unwrap();
        let id_a = note_id::read_id_from_file(&temp.path().join("a.md")).unwrap().unwrap();
        let history = lib.get_history(&id_a).unwrap();
        assert_eq!(history.len(), 1);
    }

    #[test]
    fn test_migration_with_base_snapshots() {
        let temp = create_vault_with_notes(&[
            ("note.md", "---\nid: \"20260419100000\"\ntitle: \"Current\"\n---\n\nCurrent content"),
        ]);
        // Create base snapshot
        let base_dir = temp.path().join(".notology").join("sync").join("base");
        fs::create_dir_all(&base_dir).unwrap();
        fs::write(base_dir.join("note.md"), "---\nid: \"20260419100000\"\ntitle: \"Base\"\n---\n\nBase content").unwrap();

        let result = run_migration(temp.path(), "TEST-DEV", noop_progress).unwrap();
        assert_eq!(result.status, MigrationStatus::Completed);

        let lib = Library::new(temp.path()).unwrap();
        let history = lib.get_history("20260419100000").unwrap();
        assert_eq!(history.len(), 2); // base + current
        assert!(history[0].parents.is_empty()); // base has no parent
        assert_eq!(history[1].parents.len(), 1); // current has base as parent
    }

    #[test]
    fn test_migration_preserves_sync_manifest() {
        let temp = create_vault_with_notes(&[
            ("note.md", "---\ntitle: Test\n---\n\nBody"),
        ]);
        let sync_dir = temp.path().join(".notology").join("sync");
        fs::create_dir_all(&sync_dir).unwrap();
        fs::write(sync_dir.join("manifest.json"), r#"{"entries":{}}"#).unwrap();

        run_migration(temp.path(), "TEST-DEV", noop_progress).unwrap();

        // Backup exists
        let backup = temp.path().join(".notology").join("sync-v1-backup");
        assert!(backup.is_dir());
        assert!(backup.join("manifest.json").is_file());

        // Original untouched
        assert!(sync_dir.join("manifest.json").is_file());
    }

    #[test]
    fn test_migration_backup_created() {
        let temp = create_vault_with_notes(&[
            ("note.md", "---\ntitle: Test\n---\n\nBody"),
        ]);
        let sync_dir = temp.path().join(".notology").join("sync");
        fs::create_dir_all(sync_dir.join("base")).unwrap();
        fs::write(sync_dir.join("manifest.json"), "{}").unwrap();
        fs::write(sync_dir.join("base").join("test.md"), "base").unwrap();

        run_migration(temp.path(), "TEST-DEV", noop_progress).unwrap();

        let backup = temp.path().join(".notology").join("sync-v1-backup");
        assert!(backup.join("manifest.json").is_file());
        assert!(backup.join("base").join("test.md").is_file());
    }

    #[test]
    fn test_migration_state_persisted() {
        let temp = create_vault_with_notes(&[
            ("a.md", "---\ntitle: A\n---\n\nA"),
            ("b.md", "---\ntitle: B\n---\n\nB"),
        ]);

        run_migration(temp.path(), "TEST-DEV", noop_progress).unwrap();

        let state = get_migration_state(temp.path()).unwrap().unwrap();
        assert_eq!(state.status, MigrationStatus::Completed);
        assert!(state.completed_at.is_some());
    }

    #[test]
    fn test_verify_migration_clean() {
        let temp = create_vault_with_notes(&[
            ("note.md", "---\ntitle: Test\n---\n\nBody"),
        ]);
        run_migration(temp.path(), "TEST-DEV", noop_progress).unwrap();

        let issues = verify_migration(temp.path()).unwrap();
        assert!(issues.is_empty());
    }

    #[test]
    fn test_verify_migration_with_corruption() {
        let temp = create_vault_with_notes(&[
            ("note.md", "---\ntitle: Test\n---\n\nBody"),
        ]);
        run_migration(temp.path(), "TEST-DEV", noop_progress).unwrap();

        // Delete a CAS object
        let lib = Library::new(temp.path()).unwrap();
        let id = note_id::read_id_from_file(&temp.path().join("note.md")).unwrap().unwrap();
        let head = lib.get_ref(&id).unwrap().unwrap().head_hash;
        lib.cas().delete_object(&head).unwrap();

        let issues = verify_migration(temp.path()).unwrap();
        assert!(!issues.is_empty());
    }

    #[test]
    fn test_decline_migration() {
        let temp = create_vault_with_notes(&[
            ("note.md", "---\ntitle: Test\n---\n\nBody"),
        ]);
        assert!(needs_migration(temp.path()));

        decline_migration(temp.path()).unwrap();
        assert!(!needs_migration(temp.path()));
    }

    #[test]
    fn test_migration_with_subfolders() {
        let temp = create_vault_with_notes(&[
            ("root.md", "---\ntitle: Root\n---\n\nRoot"),
            ("work/project.md", "---\ntitle: Project\n---\n\nProject"),
            ("work/deep/nested.md", "---\ntitle: Nested\n---\n\nNested"),
        ]);
        let result = run_migration(temp.path(), "TEST-DEV", noop_progress).unwrap();
        assert_eq!(result.migrated_notes, 3);

        let lib = Library::new(temp.path()).unwrap();
        let refs = lib.refs().list().unwrap();
        // Verify relative paths contain subfolder
        let paths: Vec<String> = refs.iter().map(|r| r.relative_path.clone()).collect();
        assert!(paths.iter().any(|p| p.contains("work")));
    }

    #[test]
    fn test_migration_ignores_attachments() {
        let temp = create_vault_with_notes(&[
            ("note.md", "---\ntitle: Note\n---\n\nBody"),
            ("note_att/image.md", "not a real note"),
        ]);
        // Also create hidden dir
        let hidden = temp.path().join(".git");
        fs::create_dir_all(&hidden).unwrap();
        fs::write(hidden.join("config.md"), "git config").unwrap();

        let result = run_migration(temp.path(), "TEST-DEV", noop_progress).unwrap();
        assert_eq!(result.migrated_notes, 1); // Only note.md, not att or git
    }

    #[test]
    fn test_migration_skips_already_migrated() {
        let temp = create_vault_with_notes(&[
            ("old.md", "---\nid: \"20260419100000\"\ntitle: Old\n---\n\nOld"),
            ("new.md", "---\ntitle: New\n---\n\nNew"),
        ]);

        // Pre-migrate old.md manually
        let lib = Library::new_with_device_id(temp.path(), "DEV".into()).unwrap();
        let old_content = fs::read(temp.path().join("old.md")).unwrap();
        lib.commit_version("20260419100000", &old_content, "old.md", vec![]).unwrap();

        // Now run migration — old.md should be skipped
        let result = run_migration(temp.path(), "DEV", noop_progress).unwrap();
        assert_eq!(result.migrated_notes, 2); // Both counted
        assert!(result.failed_notes.is_empty());

        // old.md still has exactly 1 version (not duplicated)
        let history = lib.get_history("20260419100000").unwrap();
        assert_eq!(history.len(), 1);
    }
}
