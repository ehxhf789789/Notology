//! Detect and register NAS .md files that are not in the current sync model.
//!
//! When a vault was created/used with an earlier sync mechanism (where notes
//! were stored as plain .md files at the vault root), the new sync model only
//! pulls notes registered via `.notology/refs/`. This module scans the NAS
//! recursively, finds unregistered .md files, and registers them in the
//! sync model so the engine can pull them like any other note.
//!
//! Adapted from older sync engine's `full_initial_download` semantics, but
//! built on top of the current `Library::commit_version` API which handles
//! CAS write + DAG append + Ref update atomically.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::core::library::Library;
use crate::core::sync_provider::SyncProvider;

/// Signature for the optional progress callback wired up by the Tauri
/// command. `(current, total)` lets the banner show `47 / 178` style status
/// during a long import. Fires once per note after `register_one` returns
/// (success or error).
pub type ImportProgressFn = dyn Fn(usize, usize);

/// Folder-name prefixes to skip during scan: test artifacts and system folders.
/// Match is **prefix** based — `obj_test_` matches both `obj_test_177...` etc.
const SKIP_PREFIXES: &[&str] = &[
    "obj_test_",
    "ref_test_",
    "notif_test_",
    "branch_test_",
    "engine_",
    "e2e_",
    "_sync_v2_test",
];

/// Folder names to skip exactly (full match).
const SKIP_EXACT: &[&str] = &[
    ".notology",
    "@eaDir",
    "#recycle",
    "#snapshot",
];

/// Safety cap to avoid runaway recursion on a misconfigured NAS layout.
const MAX_DIRS_SCANNED: usize = 500;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    pub scanned_dirs: usize,
    pub found_md_files: usize,
    pub already_registered: usize,
    pub newly_registered: usize,
    /// NAS .md files where we wrote the generated `id` back to remote
    /// (so the next scan recognizes them as already-registered).
    pub id_written_back: usize,
    pub skipped_artifacts: usize,
    pub errors: Vec<String>,
}

impl Default for ImportReport {
    fn default() -> Self {
        Self {
            scanned_dirs: 0,
            found_md_files: 0,
            already_registered: 0,
            newly_registered: 0,
            id_written_back: 0,
            skipped_artifacts: 0,
            errors: Vec::new(),
        }
    }
}

/// Single fetched .md ready for import.
///
/// `relative_path` — used for the ref's `relative_path` field and disk materialization.
/// `fetch_path`    — the exact key/path that successfully returned bytes from the
///                   provider. Used for write-back so we hit the same key whether
///                   the provider strips remote_base internally (WebDav) or stores
///                   verbatim absolute keys (InMemory tests).
pub struct FetchedNote {
    pub relative_path: String,
    pub fetch_path: String,
    pub bytes: Vec<u8>,
}

/// Pending NAS write-back of an id-injected note.
/// Returned from the (sync) library phase so the (async) write-back phase can
/// PUT to remote without holding the library lock across awaits.
pub struct PendingWriteBack {
    pub fetch_path: String,
    pub bytes: Vec<u8>,
}

/// PHASE 1: scan NAS recursively + download every unregistered .md to memory.
/// Async — does NOT touch the local Library at all (no sync-context lock issues).
///
/// Path handling: `list_children` returns absolute paths (NAS-rooted); we fetch
/// each via `get_md` using the path **relative to remote_base**. `WebDavProvider`
/// re-applies `remote_base` internally, so the round-trip is consistent.
pub async fn scan_remote(
    provider: &Arc<dyn SyncProvider>,
    remote_base: &str,
) -> Result<(Vec<FetchedNote>, ImportReport), String> {
    let base = normalize_path(remote_base);
    let mut report = ImportReport::default();
    let md_paths = scan_recursive(provider, &base, &mut report).await;
    report.found_md_files = md_paths.len();

    let mut fetched: Vec<FetchedNote> = Vec::with_capacity(md_paths.len());
    for nas_path in md_paths {
        let relative = compute_relative_path(&nas_path, &base);
        // Fetch: try relative first (WebDavProvider semantics).
        // Fallback to absolute path if relative misses (InMemory test semantics).
        // Track which path actually returned bytes so write-back hits the same key.
        let result: Option<(Vec<u8>, String)> = match provider.get_md(&relative).await {
            Ok(Some(b)) => Some((b, relative.clone())),
            Ok(None) => provider.get_md(&nas_path).await.ok().flatten()
                .map(|b| (b, nas_path.clone())),
            Err(_) => provider.get_md(&nas_path).await.ok().flatten()
                .map(|b| (b, nas_path.clone())),
        };
        match result {
            Some((bytes, fetch_path)) => fetched.push(FetchedNote {
                relative_path: relative,
                fetch_path,
                bytes,
            }),
            None => report.errors.push(format!("{}: vanished mid-scan", nas_path)),
        }
    }
    Ok((fetched, report))
}

/// PHASE 2: register each fetched .md in the Library.
/// Sync — caller holds the Library lock for the whole call.
///
/// Returns a list of `PendingWriteBack` items for notes whose `id` was newly
/// generated (so the NAS .md must be updated with id-injected content for
/// next-run idempotency). The async caller drains the list via `write_back_ids`.
///
/// 2026-05-24 (HanBin): added `path_to_id` safety net + optional
/// `progress_cb`. The map is built once per import so the per-note safety
/// net stays O(1) instead of paying O(refs) per file.
pub fn import_into_library(
    fetched: Vec<FetchedNote>,
    library: &Library,
    dry_run: bool,
    report: &mut ImportReport,
    progress_cb: Option<&ImportProgressFn>,
) -> Vec<PendingWriteBack> {
    let total = fetched.len();

    // Safety net for the partial-failure edge case: if a previous import
    // committed a ref for relative_path X but the Phase-3 write-back never
    // hit NAS, the file on NAS still has no frontmatter id. Without this
    // map, the next retry would mint a fresh id and create a duplicate ref
    // pointing at the same path (ref churn). With it, we reuse the id we
    // already minted and replay the write-back instead.
    //
    // Built once per import (snapshot of library state). Phase 2 holds the
    // library lock for its duration, so no concurrent commit can stale this.
    // Paths normalized to forward slashes — older Windows commits stored
    // backslashes and we compare against scanner-produced forward slashes.
    let path_to_id: HashMap<String, String> = library.refs().list()
        .unwrap_or_default()
        .into_iter()
        .map(|r| (r.relative_path.replace('\\', "/"), r.note_id))
        .collect();

    let mut pending: Vec<PendingWriteBack> = Vec::new();
    for (idx, note) in fetched.into_iter().enumerate() {
        match register_one(&note, library, dry_run, &path_to_id) {
            Ok(outcome) => {
                if outcome.newly_registered {
                    report.newly_registered += 1;
                } else {
                    report.already_registered += 1;
                }
                if !dry_run {
                    if let Some(bytes) = outcome.write_back_bytes {
                        pending.push(PendingWriteBack {
                            fetch_path: note.fetch_path,
                            bytes,
                        });
                    }
                }
            }
            Err(e) => {
                log::warn!("[remote_import] register {} failed: {}", note.relative_path, e);
                report.errors.push(format!("{}: {}", note.relative_path, e));
            }
        }
        if let Some(cb) = progress_cb {
            cb(idx + 1, total);
        }
    }
    log::info!(
        "[remote_import] dry_run={} scanned={} md={} new={} already={} pending_writeback={} artifacts_skipped={} errors={}",
        dry_run,
        report.scanned_dirs,
        report.found_md_files,
        report.newly_registered,
        report.already_registered,
        pending.len(),
        report.skipped_artifacts,
        report.errors.len(),
    );
    pending
}

/// PHASE 3: write id-injected content back to NAS for notes whose id we generated.
/// Without this, the next scan would generate yet another id and create a duplicate
/// ref — breaking idempotency for files that arrived without frontmatter ids.
///
/// PUT failures are logged but do not abort: the local library is already
/// authoritative; the next import attempt will retry.
pub async fn write_back_ids(
    provider: &Arc<dyn SyncProvider>,
    pending: Vec<PendingWriteBack>,
    report: &mut ImportReport,
) {
    for wb in pending {
        match provider.put_md(&wb.fetch_path, &wb.bytes).await {
            Ok(_) => {
                report.id_written_back += 1;
                log::debug!("[remote_import] put_md ok: {}", wb.fetch_path);
            }
            Err(e) => {
                log::warn!("[remote_import] put_md failed for {}: {}", wb.fetch_path, e);
                report.errors.push(format!("write-back {}: {}", wb.fetch_path, e));
            }
        }
    }
}

/// Convenience wrapper: scan + import + write-back in one call.
/// Used by tests + simple flows where the caller can hold the Library across
/// the await (e.g., InMemory tests).
pub async fn scan_and_import(
    provider: &Arc<dyn SyncProvider>,
    remote_base: &str,
    library: &Library,
    dry_run: bool,
) -> Result<ImportReport, String> {
    let (fetched, mut report) = scan_remote(provider, remote_base).await?;
    let pending = import_into_library(fetched, library, dry_run, &mut report, None);
    write_back_ids(provider, pending, &mut report).await;
    Ok(report)
}

/// Recursive folder scan returning every `.md` file path on NAS.
/// Synology rejects PROPFIND `Depth: infinity`, so walk folder-by-folder.
async fn scan_recursive(
    provider: &Arc<dyn SyncProvider>,
    base: &str,
    report: &mut ImportReport,
) -> Vec<String> {
    let mut to_scan: Vec<String> = vec![base.to_string()];
    let mut md_files: Vec<String> = Vec::new();
    let mut visited: HashSet<String> = HashSet::new();

    while let Some(current) = to_scan.pop() {
        if report.scanned_dirs >= MAX_DIRS_SCANNED {
            log::warn!("[remote_import] hit MAX_DIRS_SCANNED={}, stopping", MAX_DIRS_SCANNED);
            report.errors.push(format!("Reached safety cap ({} directories)", MAX_DIRS_SCANNED));
            break;
        }
        let normalized = normalize_path(&current);
        if !visited.insert(normalized.clone()) {
            continue;
        }
        report.scanned_dirs += 1;

        let children = match provider.list_children(&normalized).await {
            Ok(c) => c,
            Err(e) => {
                log::trace!("[remote_import] list_children({}) failed: {}", normalized, e);
                continue;
            }
        };

        for child in children {
            if is_skip_name(&child.name) {
                if child.is_collection {
                    report.skipped_artifacts += 1;
                }
                continue;
            }
            if child.is_collection {
                let subpath = if normalized == "/" {
                    format!("/{}", child.name)
                } else {
                    format!("{}/{}", normalized, child.name)
                };
                to_scan.push(subpath);
            } else if child.name.ends_with(".md") {
                md_files.push(child.path);
            }
        }
    }
    md_files
}

/// Returns true if a directory/file name should be skipped during scan.
fn is_skip_name(name: &str) -> bool {
    if SKIP_EXACT.iter().any(|exact| *exact == name) {
        return true;
    }
    if SKIP_PREFIXES.iter().any(|prefix| name.starts_with(prefix)) {
        return true;
    }
    false
}

fn normalize_path(p: &str) -> String {
    let trimmed = p.trim_end_matches('/');
    if trimmed.is_empty() { "/".to_string() } else { trimmed.to_string() }
}

/// Compute path relative to vault root (strip `remote_base` prefix).
fn compute_relative_path(nas_path: &str, remote_base: &str) -> String {
    let base = normalize_path(remote_base);
    let path = normalize_path(nas_path);
    path.strip_prefix(&base)
        .unwrap_or(&path)
        .trim_start_matches('/')
        .to_string()
}

/// Outcome of registering a single fetched .md.
struct RegisterOutcome {
    /// `true` if this call newly created/updated the library ref; `false` if
    /// the ref already pointed at the same content hash.
    newly_registered: bool,
    /// `Some(bytes)` when the id had to be generated (so NAS .md needs
    /// write-back of id-injected content). `None` when the source already
    /// had a valid id.
    write_back_bytes: Option<Vec<u8>>,
}

/// Register a fetched .md in the local sync model.
///
/// - Library mutations (commit_version + disk materialize) happen here.
/// - NAS write-back is deferred: returned via `write_back_bytes` for the async
///   caller to PUT after the library lock is released.
fn register_one(
    note: &FetchedNote,
    library: &Library,
    dry_run: bool,
    path_to_id: &HashMap<String, String>,
) -> Result<RegisterOutcome, String> {
    let content_str = std::str::from_utf8(&note.bytes)
        .map_err(|e| format!("not valid UTF-8: {}", e))?;

    let existing_id = crate::core::note_id::read_id_from_content(content_str);
    let id_was_present = existing_id.as_ref()
        .map(|id| crate::core::note_id::is_valid_id(id))
        .unwrap_or(false);
    let initial_id = if id_was_present {
        existing_id.clone().unwrap()
    } else {
        // SAFETY NET (2026-05-24): before minting a fresh id, see if some
        // existing ref already covers this relative_path. Without this, a
        // crash between Phase 2 (commit) and Phase 3 (NAS write-back) lets
        // the next retry mint a *different* id for the same NAS file —
        // creating a duplicate ref pointing at the same path. Reusing the
        // earlier id makes the retry idempotent: write-back replays, hash
        // matches existing ref, no churn.
        let norm_path = note.relative_path.replace('\\', "/");
        if let Some(prior_id) = path_to_id.get(&norm_path) {
            log::info!(
                "[remote_import] reusing existing id {} for path {} (safety net: NAS file has no frontmatter id, prior ref present)",
                prior_id, norm_path
            );
            prior_id.clone()
        } else {
            // Bulk import: ms+atomic counter to avoid collisions within same second.
            // generate_id() (1s resolution) silently overwrote refs in early runs.
            crate::core::note_id::generate_unique_id()
        }
    };

    // Conflict-copy collision detection: legacy sync_v1 produced sibling files
    // like `note (내 변경 2026-03-30).md` that share frontmatter id with their
    // primary. Without this branch, both files would compete to own the same
    // ref (each overwriting the other on every import) — non-idempotent drift.
    // When we detect another file already owns this id at a different path,
    // we mint a fresh unique id for THIS file and rewrite its frontmatter.
    //
    // Path normalization: refs written by older Windows code stored the path
    // with backslashes (e.g. `ghgh\안녕.md`). The scanner produces forward
    // slashes. Compare normalized — otherwise we falsely flag the same file
    // as a collision against itself and churn its id every run.
    let mut note_id = initial_id;
    let mut id_was_rewritten = false;
    if let Ok(Some(existing_ref)) = library.get_ref(&note_id) {
        let existing_norm = existing_ref.relative_path.replace('\\', "/");
        let new_norm = note.relative_path.replace('\\', "/");
        if existing_norm != new_norm {
            let new_id = crate::core::note_id::generate_unique_id();
            log::warn!(
                "[remote_import] id collision: id={} existing_path={} new_path={} → reassigning id={}",
                note_id, existing_ref.relative_path, note.relative_path, new_id
            );
            note_id = new_id;
            id_was_rewritten = true;
        }
    }

    // Compute final content once (with id injected/replaced if needed)
    let final_content = if id_was_rewritten {
        // file already had an id (or we generated one earlier) — replace it
        crate::core::note_id::replace_or_insert_id(content_str, &note_id)
    } else if id_was_present {
        content_str.to_string()
    } else {
        crate::core::note_id::insert_id_into_content(content_str, &note_id)
    };
    let final_bytes = final_content.into_bytes();
    let final_hash = crate::core::cas::CasStore::hash(&final_bytes);

    let already_registered = library.get_ref(&note_id)
        .ok()
        .flatten()
        .map(|r| r.head_hash == final_hash)
        .unwrap_or(false);

    if dry_run {
        // dry-run reports what *would* change in the library. Disk-only gaps
        // (ref present but file missing) are silently fixed during real import.
        return Ok(RegisterOutcome {
            newly_registered: !already_registered,
            write_back_bytes: None,
        });
    }

    // Library mutation: skip commit if already at this hash
    if !already_registered {
        library.commit_version(&note_id, &final_bytes, &note.relative_path, vec![])
            .map_err(|e| format!("commit_version: {}", e))?;
    }

    // Materialize the .md at vault_path/relative_path so the sidebar (which walks
    // local FS) can see it. CAS/refs already hold the source of truth — disk
    // copy is just a checkout. Idempotent: skip if existing bytes already match.
    // Critical for re-runs where ref exists but disk file was never written.
    let abs_path = library.vault_path().join(&note.relative_path);
    let needs_write = match std::fs::read(&abs_path) {
        Ok(existing) => existing != final_bytes,
        Err(_) => true,
    };
    if needs_write {
        if let Some(parent) = abs_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("create_dir_all {:?}: {}", parent, e))?;
        }
        std::fs::write(&abs_path, &final_bytes)
            .map_err(|e| format!("write {:?}: {}", abs_path, e))?;
    }

    log::debug!("[remote_import] registered: {} -> {}", note.relative_path, note_id);

    // Schedule NAS write-back when:
    //  (a) source had no id and we generated one (else next scan would mint a
    //      different id and create a duplicate ref), or
    //  (b) we rewrote a colliding id to break a conflict-copy tie (else next
    //      scan would re-detect collision and assign yet another fresh id —
    //      ref churn forever).
    let needs_writeback = !id_was_present || id_was_rewritten;
    let write_back_bytes = if needs_writeback { Some(final_bytes) } else { None };

    Ok(RegisterOutcome {
        newly_registered: !already_registered,
        write_back_bytes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skip_name_matches_test_artifacts() {
        assert!(is_skip_name("obj_test_177"));
        assert!(is_skip_name("ref_test_abc"));
        assert!(is_skip_name("notif_test_xyz"));
        assert!(is_skip_name("branch_test_42"));
        assert!(is_skip_name("engine_push_177"));
        assert!(is_skip_name("e2e_aaa"));
        assert!(is_skip_name("_sync_v2_test"));
    }

    #[test]
    fn skip_name_matches_system_folders() {
        assert!(is_skip_name(".notology"));
        assert!(is_skip_name("@eaDir"));
        assert!(is_skip_name("#recycle"));
        assert!(is_skip_name("#snapshot"));
    }

    #[test]
    fn skip_name_preserves_user_folders() {
        // User folders must NOT be skipped.
        assert!(!is_skip_name("Test"));
        assert!(!is_skip_name("ghgh"));
        assert!(!is_skip_name("내부회의"));
        assert!(!is_skip_name("dd"));
        assert!(!is_skip_name("My Notes"));
        assert!(!is_skip_name("project-2026"));
    }

    #[test]
    fn skip_name_does_not_match_substrings() {
        // "engine" prefix matches engine_*, but standalone "engine" should NOT match
        // (no underscore). Our prefixes include trailing _, so safe.
        assert!(!is_skip_name("engineering"));
        // ".notology" exact match — anything starting with "." but not exact is fine
        assert!(!is_skip_name(".gitignore"));
    }

    #[test]
    fn normalize_path_collapses_form() {
        assert_eq!(normalize_path("/Colony/Test"), "/Colony/Test");
        assert_eq!(normalize_path("/Colony/Test/"), "/Colony/Test");
        assert_eq!(normalize_path("/"), "/");
        assert_eq!(normalize_path(""), "/");
    }

    #[test]
    fn compute_relative_path_strips_base() {
        assert_eq!(
            compute_relative_path("/Colony/Test/folder/note.md", "/Colony/Test"),
            "folder/note.md"
        );
        assert_eq!(
            compute_relative_path("/Colony/Test/folder/note.md", "/Colony/Test/"),
            "folder/note.md"
        );
        assert_eq!(
            compute_relative_path("/Colony/Test/note.md", "/Colony/Test"),
            "note.md"
        );
    }

    #[test]
    fn compute_relative_path_handles_korean() {
        assert_eq!(
            compute_relative_path("/Colony/한글/내부회의.md", "/Colony/한글"),
            "내부회의.md"
        );
    }

    #[test]
    fn import_report_default_zero() {
        let r = ImportReport::default();
        assert_eq!(r.scanned_dirs, 0);
        assert_eq!(r.found_md_files, 0);
        assert_eq!(r.newly_registered, 0);
        assert_eq!(r.id_written_back, 0);
        assert!(r.errors.is_empty());
    }

}
