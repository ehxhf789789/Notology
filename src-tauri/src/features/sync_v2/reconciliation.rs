//! ReconciliationScanner: 3-way consistency check (Local + Remote + Library refs).
//! Q21=C: auto 1x at startup + manual trigger from Settings.
//! Q22=A: NAS-authoritative auto-resolve.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use chrono::Utc;
use serde::Serialize;

use crate::core::cas::CasStore;
use crate::core::library::Library;
use crate::core::note_id;
use crate::core::refs::RefStore;

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ReconciliationReport {
    pub local_only_count: usize,       // L✓ R✗ D✗ — external .md (Track I territory)
    pub nas_only_count: usize,         // L✗ R✓ D✗ — orphan on NAS
    pub local_missing_count: usize,    // L✗ R✓ D✓ — local vanished
    pub nas_missing_count: usize,      // L✓ R✗ D✓ — push missed
    pub orphan_refs_count: usize,      // L✗ R✗ D✓ — stale ref
    pub untracked_local_count: usize,  // L✓ R✓ D✗ — Library gap
    pub hash_mismatch_count: usize,    // L✓ R✓ D✓ hash differs
    pub trash_expired_count: usize,    // 30d+ trash items
    pub all_consistent: bool,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AutoResolveResult {
    pub nas_missing_pushed: usize,
    pub orphan_refs_cleaned: usize,
    pub untracked_committed: usize,
    pub trash_cleaned: usize,
    pub errors: Vec<String>,
}

/// Scan local vault for consistency issues.
/// Lightweight: only checks local filesystem + Library refs. No NAS I/O.
/// Full NAS scan is done by Tier 3 reconciliation (sync_once).
pub fn scan_local(vault_path: &Path, library: &Library) -> Result<ReconciliationReport, String> {
    let mut report = ReconciliationReport::default();

    // 1. Scan all .md files in vault
    let local_files = scan_local_md_files(vault_path)?;

    // 2. Get all Library refs
    let refs = library.refs().list().unwrap_or_default();
    let ref_map: HashMap<String, _> = refs.into_iter()
        .map(|r| (r.note_id.clone(), r))
        .collect();
    let ref_ids: HashSet<&str> = ref_map.keys().map(|s| s.as_str()).collect();

    // 3. Classify each local .md
    let mut local_ids: HashSet<String> = HashSet::new();
    for (rel_path, note_id_opt) in &local_files {
        match note_id_opt {
            Some(nid) => {
                local_ids.insert(nid.clone());
                if !ref_map.contains_key(nid) {
                    // L✓ D✗ — local file exists but no ref → untracked
                    report.untracked_local_count += 1;
                }
            }
            None => {
                // .md without frontmatter id → untracked (Track I/L territory)
                report.local_only_count += 1;
            }
        }
    }

    // 4. Check refs without local files
    for (nid, note_ref) in &ref_map {
        if !local_ids.contains(nid.as_str()) {
            let local_path = vault_path.join(&note_ref.relative_path);
            if !local_path.exists() {
                // D✓ but L✗ — ref exists but local file gone
                // Could be: trash move, manual delete, or NAS-only
                report.orphan_refs_count += 1;
            }
        }
    }

    // 5. Check for NAS push gaps (refs that haven't been pushed)
    // This is a lightweight heuristic: if ref exists but we can't verify NAS presence without I/O
    // → delegate to Tier 3 sync_once which does full remote comparison
    // For now, just count refs with no sync_etag as "potentially missing on NAS"
    for (_, note_ref) in &ref_map {
        if note_ref.sync_etag.is_none() && local_ids.contains(&note_ref.note_id) {
            report.nas_missing_count += 1;
        }
    }

    // 6. Trash cleanup check
    report.trash_expired_count = count_expired_trash(vault_path, 30);

    report.all_consistent = report.local_only_count == 0
        && report.nas_only_count == 0
        && report.local_missing_count == 0
        && report.nas_missing_count == 0
        && report.orphan_refs_count == 0
        && report.untracked_local_count == 0
        && report.hash_mismatch_count == 0
        && report.trash_expired_count == 0;

    Ok(report)
}

/// Result of `materialize_missing_files`. Caller can log/report counts.
#[derive(Debug, Clone, Default)]
pub struct MaterializeResult {
    pub written: usize,
    pub skipped_cas_missing: usize,
    pub errors: Vec<String>,
}

/// Walk all refs and write the user-visible `.md` to disk for any ref whose
/// file is currently **absent** on the local filesystem.
///
/// Used at the tail of `engine.sync_once()` — guarantees the editor sees
/// every pulled note even if `execute_pull`'s atomic_write failed mid-cycle.
///
/// **Safety: never overwrites an existing file.**
/// If the disk file exists at all, we leave it alone — even when its bytes
/// disagree with the CAS object. This was previously the cause of a
/// catastrophic loop where stale duplicate refs (from earlier broken-
/// frontmatter recovery attempts) repeatedly clobbered the user's actual
/// content every Tier 3 cycle. Disagreement means one of:
///   - the user has unsaved edits in flight (engine commit pending),
///   - duplicate refs exist for the same path with different head_hashes
///     (data-shape bug, not something for materialize to silently "fix"),
///   - external NAS-side edit not yet pulled.
/// In every case the right answer is to NOT touch disk; the engine's
/// normal pull/commit flow reconciles correctly.
///
/// Takes `cas` + `ref_store` directly (instead of `Library`) so the sync
/// engine — which holds the two stores via Arc — can call it without a
/// Library handle.
pub fn materialize_missing_files(
    vault_path: &Path,
    cas: &CasStore,
    ref_store: &RefStore,
) -> Result<MaterializeResult, String> {
    let mut result = MaterializeResult::default();

    let refs = ref_store.list().map_err(|e| format!("list refs: {}", e))?;

    for note_ref in refs {
        let normalized = note_ref.relative_path.replace('\\', "/");
        let abs_path = vault_path.join(&normalized);

        // Skip if the disk file already exists. We do NOT compare bytes —
        // see the safety note in the doc comment.
        if abs_path.exists() {
            continue;
        }

        // Disk is missing → look up CAS so we can recreate it.
        let cas_bytes = match cas.read_object(&note_ref.head_hash) {
            Ok(Some(b)) => b,
            Ok(None) => {
                // Object not yet pulled → leave to engine; not an error.
                result.skipped_cas_missing += 1;
                continue;
            }
            Err(e) => {
                result.errors.push(format!("{}: cas read: {}", note_ref.note_id, e));
                continue;
            }
        };

        if let Some(parent) = abs_path.parent() {
            if let Err(e) = std::fs::create_dir_all(parent) {
                result.errors.push(format!("{}: mkdir {:?}: {}", note_ref.note_id, parent, e));
                continue;
            }
        }
        if let Err(e) = crate::core::file_io::atomic_write_file(&abs_path, &cas_bytes) {
            result.errors.push(format!("{}: write {:?}: {}", note_ref.note_id, abs_path, e));
            continue;
        }
        result.written += 1;
    }

    if result.written > 0 || !result.errors.is_empty() {
        log::info!(
            "[reconciliation] materialize_missing_files: written={} skipped_cas_missing={} errors={}",
            result.written, result.skipped_cas_missing, result.errors.len()
        );
    }
    Ok(result)
}

/// Report from `cleanup_stale_duplicate_refs` for the UI to surface.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StaleRefCleanupReport {
    /// Groups where 2+ refs claim the same relative_path.
    pub duplicate_groups: usize,
    /// Refs deleted (the older/staler members of each group).
    pub deleted_count: usize,
    /// note_ids preserved as the surviving owner of each path.
    pub kept_ids: Vec<String>,
    pub errors: Vec<String>,
}

/// Detect refs that share a `relative_path` with another ref and prune the
/// stragglers, keeping the most-recently-updated entry per path.
///
/// Why this exists: Phase 1.aa's broken-frontmatter recovery used to mint a
/// fresh `note_id` on every retry, leaving up to N zombie refs all
/// claiming the same disk file. The duplicate refs replicate to NAS via
/// the engine's normal push, so cleanup MUST hit both stores in lockstep
/// or the next pull cycle re-imports the zombies and the cleanup is
/// silently undone.
///
/// **Always destructive on the loser refs**, both locally and on NAS
/// (best-effort — NAS errors are logged but don't abort). Callers should
/// be a manual "fix consistency" action, not a background loop.
///
/// Winner is chosen by `updated_at` desc with a `note_id` desc tiebreak.
/// Path comparison normalizes backslashes to forward slashes so that
/// `Test\foo.md` and `Test/foo.md` are treated as the same path.
pub async fn cleanup_stale_duplicate_refs(
    ref_store: &RefStore,
    provider: Option<&Arc<dyn crate::core::sync_provider::SyncProvider>>,
) -> Result<StaleRefCleanupReport, String> {
    let mut report = StaleRefCleanupReport::default();

    let refs = ref_store.list().map_err(|e| format!("list refs: {}", e))?;
    if refs.is_empty() { return Ok(report); }

    // Group by normalized relative_path.
    let mut by_path: HashMap<String, Vec<crate::core::refs::NoteRef>> = HashMap::new();
    for r in refs {
        let key = r.relative_path.replace('\\', "/");
        by_path.entry(key).or_default().push(r);
    }

    for (path, mut group) in by_path {
        if group.len() < 2 { continue; }
        report.duplicate_groups += 1;

        // Sort: most recent first; tiebreak on note_id descending.
        group.sort_by(|a, b| {
            b.updated_at.cmp(&a.updated_at)
                .then_with(|| b.note_id.cmp(&a.note_id))
        });

        // First entry wins.
        let winner = &group[0];
        report.kept_ids.push(winner.note_id.clone());
        log::info!(
            "[reconciliation] stale-ref cleanup: path={} keep={} drop={}",
            path, winner.note_id,
            group[1..].iter().map(|r| r.note_id.as_str()).collect::<Vec<_>>().join(",")
        );

        for loser in &group[1..] {
            // Local delete first — failure here means the ref is in a
            // state we can't reason about, so abort this loser to avoid
            // leaving NAS-only or local-only orphans.
            match ref_store.delete(&loser.note_id) {
                Ok(_) => report.deleted_count += 1,
                Err(e) => {
                    report.errors.push(format!("local delete {}: {}", loser.note_id, e));
                    continue;
                }
            }

            // NAS delete (best-effort). Without this the next adaptive_poller
            // cycle re-pulls the loser ref and the cleanup is silently undone.
            // Orphan CAS objects are left behind — they're immutable, small,
            // and harmless until a future GC pass.
            if let Some(p) = provider {
                if let Err(e) = p.delete_ref(&loser.note_id).await {
                    log::warn!("[reconciliation] NAS delete_ref {} failed: {}", loser.note_id, e);
                    report.errors.push(format!("NAS delete {}: {}", loser.note_id, e));
                }
            }
        }
    }

    Ok(report)
}

/// Q22=A: Auto-resolve local issues.
pub fn auto_resolve_local(
    vault_path: &Path,
    library: &Library,
) -> Result<AutoResolveResult, String> {
    let mut result = AutoResolveResult::default();

    // 1. Commit untracked local .md files (D✗ → create ref)
    let local_files = scan_local_md_files(vault_path)?;
    for (rel_path, note_id_opt) in &local_files {
        if let Some(nid) = note_id_opt {
            if library.refs().get(nid).ok().flatten().is_none() {
                let full_path = vault_path.join(rel_path);
                if let Ok(content) = std::fs::read(&full_path) {
                    let normalized = rel_path.replace('\\', "/");
                    match library.commit_version(nid, &content, &normalized, vec![]) {
                        Ok(Some(_)) => {
                            result.untracked_committed += 1;
                            log::info!("[reconciliation] committed untracked: {}", nid);
                        }
                        Ok(None) => {}
                        Err(e) => result.errors.push(format!("commit {}: {}", nid, e)),
                    }
                }
            }
        }
    }

    // 2. Clean orphan refs (L✗ D✓ — ref without local file)
    let refs = library.refs().list().unwrap_or_default();
    for note_ref in &refs {
        let local_path = vault_path.join(&note_ref.relative_path);
        if !local_path.exists() {
            // Check trash first
            let in_trash = vault_path.join(".notology/trash")
                .exists(); // simplified check
            if !in_trash {
                match library.refs().delete(&note_ref.note_id) {
                    Ok(true) => {
                        result.orphan_refs_cleaned += 1;
                        log::info!("[reconciliation] cleaned orphan ref: {}", note_ref.note_id);
                    }
                    _ => {}
                }
            }
        }
    }

    // 3. Clean expired trash (30d+)
    result.trash_cleaned = purge_expired_trash(vault_path, 30);

    Ok(result)
}

// === Helpers ===

fn scan_local_md_files(vault_path: &Path) -> Result<Vec<(String, Option<String>)>, String> {
    let mut files = Vec::new();
    walk_md(vault_path, vault_path, &mut files)?;
    Ok(files)
}

fn walk_md(base: &Path, current: &Path, out: &mut Vec<(String, Option<String>)>) -> Result<(), String> {
    let entries = std::fs::read_dir(current).map_err(|e| format!("readdir: {}", e))?;
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name();
        let name_str = name.to_string_lossy();

        if name_str.starts_with('.') || name_str.ends_with("_att") {
            continue;
        }

        if path.is_dir() {
            walk_md(base, &path, out)?;
        } else if path.extension().and_then(|s| s.to_str()) == Some("md") {
            let rel = path.strip_prefix(base)
                .map_err(|e| e.to_string())?
                .to_string_lossy()
                .replace('\\', "/");
            let nid = note_id::read_id_from_file(&path).ok().flatten();
            out.push((rel, nid));
        }
    }
    Ok(())
}

fn count_expired_trash(vault_path: &Path, days: i64) -> usize {
    let trash_dir = vault_path.join(".notology/trash");
    if !trash_dir.exists() { return 0; }

    let cutoff = Utc::now() - chrono::Duration::days(days);
    let mut count = 0;

    if let Ok(entries) = std::fs::read_dir(&trash_dir) {
        for entry in entries.flatten() {
            if !entry.path().is_dir() { continue; }
            if let Ok(files) = std::fs::read_dir(entry.path()) {
                for file in files.flatten() {
                    let name = file.file_name().to_string_lossy().to_string();
                    if name.ends_with(".meta.json") {
                        if let Ok(bytes) = std::fs::read(file.path()) {
                            if let Ok(meta) = serde_json::from_slice::<crate::features::sync_v2::trash::TrashEntry>(&bytes) {
                                if meta.deleted_at < cutoff {
                                    count += 1;
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    count
}

fn purge_expired_trash(vault_path: &Path, days: i64) -> usize {
    let trash_dir = vault_path.join(".notology/trash");
    if !trash_dir.exists() { return 0; }

    let cutoff = Utc::now() - chrono::Duration::days(days);
    let mut cleaned = 0;

    if let Ok(date_dirs) = std::fs::read_dir(&trash_dir) {
        for date_dir in date_dirs.flatten() {
            if !date_dir.path().is_dir() { continue; }
            let mut all_expired = true;
            if let Ok(files) = std::fs::read_dir(date_dir.path()) {
                for file in files.flatten() {
                    let name = file.file_name().to_string_lossy().to_string();
                    if name.ends_with(".meta.json") {
                        if let Ok(bytes) = std::fs::read(file.path()) {
                            if let Ok(meta) = serde_json::from_slice::<crate::features::sync_v2::trash::TrashEntry>(&bytes) {
                                if meta.deleted_at < cutoff {
                                    // Delete the .md + .meta.json + _att
                                    let md_path = date_dir.path().join(&meta.trash_filename);
                                    let _ = std::fs::remove_file(&md_path);
                                    let _ = std::fs::remove_file(file.path());
                                    let stem = meta.trash_filename.trim_end_matches(".md");
                                    let att = date_dir.path().join(format!("{}_att", stem));
                                    if att.exists() { let _ = std::fs::remove_dir_all(&att); }
                                    cleaned += 1;
                                } else {
                                    all_expired = false;
                                }
                            }
                        }
                    }
                }
            }
            // Remove empty date directory
            if all_expired {
                let _ = std::fs::remove_dir(date_dir.path());
            }
        }
    }
    cleaned
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_scan_empty_vault() {
        let tmp = tempfile::tempdir().unwrap();
        let lib = Library::new(tmp.path()).unwrap();
        let report = scan_local(tmp.path(), &lib).unwrap();
        assert!(report.all_consistent);
    }

    #[test]
    fn test_scan_untracked() {
        let tmp = tempfile::tempdir().unwrap();
        let vault = tmp.path();
        std::fs::write(vault.join("test.md"), "---\nid: \"20260101000001\"\n---\nHello").unwrap();
        let lib = Library::new(vault).unwrap();
        let report = scan_local(vault, &lib).unwrap();
        assert_eq!(report.untracked_local_count, 1);
        assert!(!report.all_consistent);
    }

    #[test]
    fn test_auto_resolve_commits_untracked() {
        let tmp = tempfile::tempdir().unwrap();
        let vault = tmp.path();
        std::fs::write(vault.join("test.md"), "---\nid: \"20260101000001\"\n---\nHello").unwrap();
        let lib = Library::new(vault).unwrap();

        let result = auto_resolve_local(vault, &lib).unwrap();
        assert_eq!(result.untracked_committed, 1);

        // Now scan should be clean
        let report = scan_local(vault, &lib).unwrap();
        assert_eq!(report.untracked_local_count, 0);
    }

    #[test]
    fn test_scan_orphan_ref() {
        let tmp = tempfile::tempdir().unwrap();
        let vault = tmp.path();
        let lib = Library::new(vault).unwrap();
        // Create a ref for a non-existent file
        let _ = lib.refs().set(&crate::core::refs::NoteRef {
            note_id: "orphan001".into(),
            head_hash: "deadbeef".into(),
            relative_path: "gone/note.md".into(),
            updated_at: Utc::now(),
            sync_etag: None,
        });
        let report = scan_local(vault, &lib).unwrap();
        assert_eq!(report.orphan_refs_count, 1);
    }

    #[test]
    fn materialize_writes_missing_files_from_cas() {
        // Setup: ref exists + CAS has the object, but the .md file is absent.
        // Simulates a mid-pull crash where ref/CAS landed but disk write failed.
        let tmp = tempfile::tempdir().unwrap();
        let vault = tmp.path();
        let lib = Library::new(vault).unwrap();

        let content = b"---\nid: \"20260101000001\"\n---\nHello";
        let hash = lib.cas().write_object(content).unwrap();
        lib.refs().set(&crate::core::refs::NoteRef {
            note_id: "20260101000001".into(),
            head_hash: hash,
            relative_path: "folder/note.md".into(),
            updated_at: Utc::now(),
            sync_etag: None,
        }).unwrap();

        // .md file does NOT exist yet
        assert!(!vault.join("folder/note.md").exists());

        let result = materialize_missing_files(vault, lib.cas(), lib.refs()).unwrap();
        assert_eq!(result.written, 1);
        assert!(vault.join("folder/note.md").exists());
        assert_eq!(std::fs::read(vault.join("folder/note.md")).unwrap(), content);
    }

    #[test]
    fn materialize_skips_when_cas_object_missing() {
        // Ref exists but no CAS object — engine hasn't pulled it yet.
        // We must NOT error out; we just skip and let the next pull fetch it.
        let tmp = tempfile::tempdir().unwrap();
        let vault = tmp.path();
        let lib = Library::new(vault).unwrap();

        lib.refs().set(&crate::core::refs::NoteRef {
            note_id: "pending".into(),
            head_hash: "0000000000000000000000000000000000000000000000000000000000000000".into(),
            relative_path: "pending.md".into(),
            updated_at: Utc::now(),
            sync_etag: None,
        }).unwrap();

        let result = materialize_missing_files(vault, lib.cas(), lib.refs()).unwrap();
        assert_eq!(result.written, 0);
        assert_eq!(result.skipped_cas_missing, 1);
        assert!(result.errors.is_empty());
        assert!(!vault.join("pending.md").exists());
    }

    #[test]
    fn materialize_idempotent_when_disk_already_matches() {
        let tmp = tempfile::tempdir().unwrap();
        let vault = tmp.path();
        let lib = Library::new(vault).unwrap();

        let content = b"---\nid: \"20260101000002\"\n---\nbody";
        let hash = lib.cas().write_object(content).unwrap();
        std::fs::write(vault.join("a.md"), content).unwrap();
        lib.refs().set(&crate::core::refs::NoteRef {
            note_id: "20260101000002".into(),
            head_hash: hash,
            relative_path: "a.md".into(),
            updated_at: Utc::now(),
            sync_etag: None,
        }).unwrap();

        // First call: byte-identical → no write.
        let r1 = materialize_missing_files(vault, lib.cas(), lib.refs()).unwrap();
        assert_eq!(r1.written, 0);
        assert!(r1.errors.is_empty());

        // Second call (idempotent).
        let r2 = materialize_missing_files(vault, lib.cas(), lib.refs()).unwrap();
        assert_eq!(r2.written, 0);
    }

    #[test]
    fn materialize_handles_backslash_paths_in_refs() {
        // Legacy refs may have stored paths with Windows-native backslashes.
        // The materialize step normalizes them so the file lands at the right
        // forward-slash location and works on macOS/Linux too.
        let tmp = tempfile::tempdir().unwrap();
        let vault = tmp.path();
        let lib = Library::new(vault).unwrap();

        let content = b"---\nid: \"20260101000003\"\n---\nbody";
        let hash = lib.cas().write_object(content).unwrap();
        lib.refs().set(&crate::core::refs::NoteRef {
            note_id: "20260101000003".into(),
            head_hash: hash,
            relative_path: "sub\\nested.md".into(),
            updated_at: Utc::now(),
            sync_etag: None,
        }).unwrap();

        let result = materialize_missing_files(vault, lib.cas(), lib.refs()).unwrap();
        assert_eq!(result.written, 1);
        assert!(vault.join("sub/nested.md").exists());
    }

    #[test]
    fn materialize_never_overwrites_existing_disk_file_even_when_bytes_differ() {
        // Critical safety invariant: the disk file is sacred. If it exists
        // with different bytes (user is editing, or stale duplicate ref
        // points at the same path with a different hash), DO NOT clobber.
        // Pre-fix this loop wrote the user's edits over with old CAS bytes
        // every Tier 3 cycle.
        let tmp = tempfile::tempdir().unwrap();
        let vault = tmp.path();
        let lib = Library::new(vault).unwrap();

        let cas_content = b"---\nid: \"20260101000004\"\n---\nfrom CAS";
        let disk_content = b"---\nid: \"20260101000004\"\n---\nuser is editing this NOW";
        let hash = lib.cas().write_object(cas_content).unwrap();
        std::fs::write(vault.join("editing.md"), disk_content).unwrap();
        lib.refs().set(&crate::core::refs::NoteRef {
            note_id: "20260101000004".into(),
            head_hash: hash,
            relative_path: "editing.md".into(),
            updated_at: Utc::now(),
            sync_etag: None,
        }).unwrap();

        let r = materialize_missing_files(vault, lib.cas(), lib.refs()).unwrap();
        assert_eq!(r.written, 0, "must NOT overwrite when disk file exists");
        assert_eq!(
            std::fs::read(vault.join("editing.md")).unwrap(),
            disk_content,
            "user content preserved"
        );
    }

    // ── Stale duplicate ref cleanup ───────────────────────

    fn make_ref(note_id: &str, rel: &str, hash: &str, ts_offset_secs: i64)
        -> crate::core::refs::NoteRef
    {
        crate::core::refs::NoteRef {
            note_id: note_id.into(),
            head_hash: hash.into(),
            relative_path: rel.into(),
            updated_at: Utc::now() + chrono::Duration::seconds(ts_offset_secs),
            sync_etag: None,
        }
    }

    #[tokio::test]
    async fn cleanup_keeps_most_recent_when_paths_collide() {
        // Three refs all claim "Test/note.md" — leftover from broken-FM
        // recovery that minted a fresh id on each retry. Newest wins.
        let tmp = tempfile::tempdir().unwrap();
        let lib = Library::new(tmp.path()).unwrap();
        lib.refs().set(&make_ref("20260101000001", "Test/note.md", "h1", -300)).unwrap();
        lib.refs().set(&make_ref("20260101000002", "Test/note.md", "h2", -100)).unwrap();
        lib.refs().set(&make_ref("20260101000003", "Test/note.md", "h3", 0)).unwrap();

        let r = cleanup_stale_duplicate_refs(lib.refs(), None).await.unwrap();
        assert_eq!(r.duplicate_groups, 1);
        assert_eq!(r.deleted_count, 2);
        assert_eq!(r.kept_ids, vec!["20260101000003".to_string()]);
        assert!(r.errors.is_empty());
        assert!(lib.refs().get("20260101000003").unwrap().is_some());
        assert!(lib.refs().get("20260101000001").unwrap().is_none());
        assert!(lib.refs().get("20260101000002").unwrap().is_none());
    }

    #[tokio::test]
    async fn cleanup_normalizes_backslash_so_split_paths_merge() {
        // One ref uses `Test/foo.md`, another uses `Test\foo.md`. They
        // refer to the same disk file — must collapse to one.
        let tmp = tempfile::tempdir().unwrap();
        let lib = Library::new(tmp.path()).unwrap();
        lib.refs().set(&make_ref("20260101000010", "Test/foo.md",  "h1", -100)).unwrap();
        lib.refs().set(&make_ref("20260101000011", "Test\\foo.md", "h2", 0)).unwrap();

        let r = cleanup_stale_duplicate_refs(lib.refs(), None).await.unwrap();
        assert_eq!(r.duplicate_groups, 1);
        assert_eq!(r.deleted_count, 1);
        assert_eq!(r.kept_ids, vec!["20260101000011".to_string()]);
    }

    #[tokio::test]
    async fn cleanup_leaves_distinct_paths_alone() {
        let tmp = tempfile::tempdir().unwrap();
        let lib = Library::new(tmp.path()).unwrap();
        lib.refs().set(&make_ref("20260101000020", "a.md", "h1", 0)).unwrap();
        lib.refs().set(&make_ref("20260101000021", "b.md", "h2", 0)).unwrap();
        lib.refs().set(&make_ref("20260101000022", "c.md", "h3", 0)).unwrap();

        let r = cleanup_stale_duplicate_refs(lib.refs(), None).await.unwrap();
        assert_eq!(r.duplicate_groups, 0);
        assert_eq!(r.deleted_count, 0);
        // All three still exist.
        assert!(lib.refs().get("20260101000020").unwrap().is_some());
        assert!(lib.refs().get("20260101000021").unwrap().is_some());
        assert!(lib.refs().get("20260101000022").unwrap().is_some());
    }

    #[tokio::test]
    async fn cleanup_idempotent_on_second_run() {
        let tmp = tempfile::tempdir().unwrap();
        let lib = Library::new(tmp.path()).unwrap();
        lib.refs().set(&make_ref("20260101000030", "x.md", "h1", -100)).unwrap();
        lib.refs().set(&make_ref("20260101000031", "x.md", "h2", 0)).unwrap();

        let r1 = cleanup_stale_duplicate_refs(lib.refs(), None).await.unwrap();
        assert_eq!(r1.deleted_count, 1);

        let r2 = cleanup_stale_duplicate_refs(lib.refs(), None).await.unwrap();
        assert_eq!(r2.duplicate_groups, 0);
        assert_eq!(r2.deleted_count, 0);
    }
}
