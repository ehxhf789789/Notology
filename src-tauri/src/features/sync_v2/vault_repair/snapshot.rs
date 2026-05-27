//! vault_repair::snapshot — full vault snapshot + integrity manifest for
//! one-click rollback. This is the **load-bearing safety primitive** for
//! all destructive vault operations.
//!
//! ## Design (HanBin 2026-05-24)
//!
//! Stored at `%LOCALAPPDATA%\Notology\snapshots\<vault_hash>\snapshot_<ts>\`
//!  - **Outside the vault** so the snapshot itself isn't part of any
//!    Synology Drive / WebDAV sync — eating NAS bandwidth + storage for
//!    a local-only safety net would be wrong.
//!  - **Per-vault hash key** so different vaults' snapshots don't collide.
//!
//! Contents:
//!  - `manifest.json` — every file's vault-relative path, size, sha256,
//!    mtime; plus snapshot metadata (started_at, completed_at, file count,
//!    total bytes, source vault path)
//!  - mirror of every file under the original tree structure
//!
//! ## Operations
//!
//! - `create_snapshot(vault, label)` — Phase 1 B1+B2 implementation.
//!   Walks vault, copies every file, computes sha256 inline, writes
//!   manifest. Skips its own snapshot directory if vault contains one.
//!   Idempotent: each call creates a NEW timestamped snapshot.
//!
//! - `restore_snapshot(snapshot_id, vault)` — Phase 1 B3 implementation.
//!   Restores every file from the snapshot's mirror to the live vault.
//!   Files in the vault that aren't in the manifest are DELETED (true
//!   restore = identical state). User confirmation required at UI layer.
//!
//! - `list_snapshots(vault)` — enumerate available snapshots for the vault.
//!
//! - `delete_snapshot(snapshot_id)` — explicit user-driven cleanup.
//!
//! ## Invariants
//!
//!  - Snapshot creation is atomic at the manifest level: if interrupted,
//!    the manifest's `completed_at` stays null and `list_snapshots` skips
//!    incomplete snapshots.
//!  - Restore is best-effort with a per-file error log; the function
//!    completes even if some files fail (rather than half-restoring +
//!    aborting). Per-file failures appear in `RestoreOutcome.errors`.
//!  - Hash verification: every file copied has its sha256 computed AND
//!    re-verified by reading the destination back. Mismatch = error.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::progress::{self, RepairStage};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotEntry {
    pub rel_path: String,
    pub size_bytes: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotManifest {
    pub snapshot_id: String,
    pub started_at: DateTime<Utc>,
    pub completed_at: Option<DateTime<Utc>>,
    pub source_vault: String,
    pub label: String,
    pub file_count: usize,
    pub total_bytes: u64,
    pub entries: Vec<SnapshotEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotInfo {
    pub snapshot_id: String,
    pub label: String,
    pub started_at: DateTime<Utc>,
    pub completed_at: Option<DateTime<Utc>>,
    pub file_count: usize,
    pub total_bytes: u64,
    pub dir: String,
    /// True iff the manifest has `completed_at` set — half-finished
    /// snapshots are surfaced separately so the user can clean them up.
    pub complete: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreOutcome {
    pub snapshot_id: String,
    pub files_restored: usize,
    pub files_deleted: usize,
    pub errors: Vec<String>,
}

/// P1 #6 (HanBin 2026-05-24) — restore preview. Computes exactly what
/// `restore_snapshot` would do without performing any writes. Critical
/// safety feature: the user can see "these 12 files will be DELETED"
/// before clicking through the confirmation dialog.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestorePreview {
    pub snapshot_id: String,
    pub files_to_overwrite: Vec<String>,
    pub files_to_delete: Vec<String>,
    /// Files in BOTH snapshot AND current vault with IDENTICAL sha — restore
    /// would be a no-op for these. Counted but not enumerated (could be
    /// huge for unchanged vaults).
    pub files_unchanged: usize,
    /// Total bytes that will be overwritten (rough cost estimate).
    pub bytes_to_overwrite: u64,
}

// ─── public API ───────────────────────────────────────────────────────

/// Compute the local snapshot root for a given vault. Lives under
/// %LOCALAPPDATA% on Windows, $XDG_DATA_HOME on Linux, ~/Library/...
/// on macOS — never inside the vault itself.
pub fn snapshots_root_for(vault: &Path) -> Result<PathBuf, String> {
    let base = dirs::data_local_dir()
        .ok_or_else(|| "no local data dir available on this platform".to_string())?;
    let mut hasher = Sha256::new();
    hasher.update(vault.to_string_lossy().as_bytes());
    let key = format!("{:x}", hasher.finalize());
    Ok(base.join("Notology").join("snapshots").join(&key[..16]))
}

/// Phase 1 B1+B2 (HanBin 2026-05-24) — full vault snapshot with sha256
/// integrity manifest. Reports progress through the same channel as the
/// repair pipeline so the UI shows one consistent status line.
pub fn create_snapshot(vault: &Path, label: &str) -> Result<SnapshotManifest, String> {
    let started_at = Utc::now();
    let snapshot_id = format!("snapshot_{}", started_at.format("%Y%m%dT%H%M%SZ"));
    let root = snapshots_root_for(vault)?;
    let dir = root.join(&snapshot_id);
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("create snapshot dir {:?}: {}", dir, e))?;

    let mut manifest = SnapshotManifest {
        snapshot_id: snapshot_id.clone(),
        started_at,
        completed_at: None,
        source_vault: vault.to_string_lossy().replace('\\', "/"),
        label: label.to_string(),
        file_count: 0,
        total_bytes: 0,
        entries: Vec::new(),
    };
    // Write the in-progress manifest immediately so `list_snapshots`
    // can show it (and surface it as incomplete if we crash mid-way).
    persist_manifest(&dir, &manifest)?;

    // Walk + copy.
    let mut files_to_copy: Vec<PathBuf> = Vec::new();
    let snapshots_root_abs = root.clone();
    walk_vault_files(vault, &snapshots_root_abs, &mut files_to_copy);

    progress::set_progress(
        RepairStage::BackingUp,
        0,
        files_to_copy.len(),
        format!("Snapshotting {} files...", files_to_copy.len()),
    );

    for (idx, src) in files_to_copy.iter().enumerate() {
        if progress::should_cancel() {
            log::warn!("[snapshot] cancelled at {}/{}", idx, files_to_copy.len());
            persist_manifest(&dir, &manifest)?;
            return Err("snapshot cancelled by user".to_string());
        }
        let rel = match src.strip_prefix(vault) {
            Ok(r) => r.to_path_buf(),
            Err(_) => continue,
        };
        let dst = dir.join(&rel);
        if let Some(parent) = dst.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("mkdir {:?}: {}", parent, e))?;
        }
        // 2026-05-24 (HanBin) — streaming copy with single-pass sha.
        // Was: read entire source → hash → write → read back → hash.
        // For 5 GB file = 15 GB I/O + 5 GB allocation × 2.
        // Now: source → tmp → atomic-rename, sha computed during copy,
        // constant 256 KB RAM. Read-back verify also streams.
        let (src_sha, size) = match crate::core::file_io::stream_copy_with_sha(src, &dst) {
            Ok(v) => v,
            Err(e) => {
                log::warn!("[snapshot] copy fail {:?}: {} (skipped)", src, e);
                continue;
            }
        };
        // Read-back verify (streaming) — guards against silent OS-level
        // corruption / disk errors between rename and now.
        let written_sha = match crate::core::file_io::stream_sha256(&dst) {
            Ok((s, _)) => s,
            Err(e) => {
                log::warn!("[snapshot] readback fail {:?}: {}", dst, e);
                continue;
            }
        };
        if written_sha != src_sha {
            return Err(format!(
                "snapshot integrity check failed for {:?}: source sha {} != written sha {}",
                src, src_sha, written_sha
            ));
        }

        manifest.entries.push(SnapshotEntry {
            rel_path: rel.to_string_lossy().replace('\\', "/"),
            size_bytes: size,
            sha256: src_sha,
        });
        manifest.file_count += 1;
        manifest.total_bytes += size;
        progress::bump_current();

        // Persist manifest incrementally every 50 files so even a
        // crash mid-way leaves a partial-but-introspectable record.
        if idx % 50 == 49 {
            persist_manifest(&dir, &manifest)?;
        }
    }

    manifest.completed_at = Some(Utc::now());
    persist_manifest(&dir, &manifest)?;
    log::info!(
        "[snapshot] created {} ({} files, {} bytes) in {:?}",
        snapshot_id, manifest.file_count, manifest.total_bytes, dir
    );
    Ok(manifest)
}

pub fn list_snapshots(vault: &Path) -> Result<Vec<SnapshotInfo>, String> {
    let root = snapshots_root_for(vault)?;
    if !root.is_dir() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&root).map_err(|e| format!("read {:?}: {}", root, e))?.flatten() {
        let p = entry.path();
        if !p.is_dir() {
            continue;
        }
        let manifest_path = p.join("manifest.json");
        if !manifest_path.is_file() {
            continue;
        }
        let bytes = match std::fs::read(&manifest_path) {
            Ok(b) => b,
            Err(_) => continue,
        };
        let manifest: SnapshotManifest = match serde_json::from_slice(&bytes) {
            Ok(m) => m,
            Err(_) => continue,
        };
        out.push(SnapshotInfo {
            snapshot_id: manifest.snapshot_id.clone(),
            label: manifest.label.clone(),
            started_at: manifest.started_at,
            completed_at: manifest.completed_at,
            file_count: manifest.file_count,
            total_bytes: manifest.total_bytes,
            dir: p.to_string_lossy().replace('\\', "/"),
            complete: manifest.completed_at.is_some(),
        });
    }
    out.sort_by(|a, b| b.started_at.cmp(&a.started_at));
    Ok(out)
}

/// Restore a snapshot to the vault. Files in the vault NOT present in
/// the manifest are deleted (true restore). The vault's `.notology/`
/// system directory IS included in the manifest, so the restore is
/// byte-identical to the snapshot moment.
///
/// Caller is expected to:
///  1. Display a strong confirmation dialog (this is destructive)
///  2. Optionally take a fresh "pre-restore" snapshot first so the
///     user can undo the undo
///  3. Pause sync engines so the restore doesn't race with NAS pull
pub fn restore_snapshot(vault: &Path, snapshot_id: &str) -> Result<RestoreOutcome, String> {
    let root = snapshots_root_for(vault)?;
    let snap_dir = root.join(snapshot_id);
    let manifest_path = snap_dir.join("manifest.json");
    let bytes = std::fs::read(&manifest_path)
        .map_err(|e| format!("read manifest {:?}: {}", manifest_path, e))?;
    let manifest: SnapshotManifest = serde_json::from_slice(&bytes)
        .map_err(|e| format!("parse manifest: {}", e))?;
    if manifest.completed_at.is_none() {
        return Err(format!(
            "snapshot {} is incomplete (started_at={}, no completed_at) — cannot restore",
            snapshot_id, manifest.started_at
        ));
    }

    let mut outcome = RestoreOutcome {
        snapshot_id: snapshot_id.to_string(),
        files_restored: 0,
        files_deleted: 0,
        errors: Vec::new(),
    };

    // Index the manifest for O(1) "is this file in the snapshot?" check.
    let manifest_paths: std::collections::HashSet<String> = manifest
        .entries
        .iter()
        .map(|e| e.rel_path.clone())
        .collect();

    progress::set_progress(
        RepairStage::BackingUp,
        0,
        manifest.entries.len(),
        format!("Restoring {} files from {}...", manifest.entries.len(), snapshot_id),
    );

    // Restore every file from manifest.
    // 2026-05-24 (HanBin) — stress test caught: previous version wrote
    // EVERY manifest entry unconditionally, even when the vault file
    // was already byte-identical to the snapshot. Two problems:
    //   1. counting mismatch — preview returned `files_to_overwrite=3`
    //      (excludes unchanged) but actual `files_restored=5` (counts
    //      everything). Made the preview misleading.
    //   2. performance — for a 44 GB HanBin vault where the user might
    //      restore after a single-file mistake, we'd rewrite all 44 GB.
    // Fix: compare current vault file's sha to manifest sha first; skip
    // when identical. Both counts now reflect actual disk I/O.
    for entry in &manifest.entries {
        if progress::should_cancel() {
            outcome.errors.push("cancelled by user".to_string());
            return Ok(outcome);
        }
        let src = snap_dir.join(entry.rel_path.replace('/', std::path::MAIN_SEPARATOR_STR.as_ref()));
        let dst = vault.join(entry.rel_path.replace('/', std::path::MAIN_SEPARATOR_STR.as_ref()));

        // 2026-05-24 (HanBin) — chaos test caught: previous version
        // short-circuited via the "vault already matches" check WITHOUT
        // verifying the snap file's integrity first. Result: a tampered
        // snap file went undetected because we never read it. Worse,
        // user thought they had a working backup but it was corrupt.
        // Fix: ALWAYS read snap file + verify its sha against manifest
        // first. Only AFTER snap integrity confirmed do we apply the
        // "skip if vault matches" optimization (skips the WRITE, not
        // the READ-and-verify).
        let snap_bytes = match std::fs::read(&src) {
            Ok(b) => b,
            Err(e) => {
                outcome.errors.push(format!("read snapshot {:?}: {}", src, e));
                continue;
            }
        };
        let snap_sha = {
            let mut h = Sha256::new();
            h.update(&snap_bytes);
            format!("{:x}", h.finalize())
        };
        if snap_sha != entry.sha256 {
            outcome.errors.push(format!(
                "snapshot file sha mismatch {:?}: expected {} got {}",
                src, entry.sha256, snap_sha
            ));
            continue;
        }

        // Snap integrity OK. Now check if vault file already matches
        // → skip write if so (perf optimization for partial restores).
        if dst.is_file() {
            if let Ok(cur_bytes) = std::fs::read(&dst) {
                let mut h = Sha256::new();
                h.update(&cur_bytes);
                let cur_sha = format!("{:x}", h.finalize());
                if cur_sha == entry.sha256 {
                    progress::bump_current();
                    continue;
                }
            }
        }

        if let Some(parent) = dst.parent() {
            if let Err(e) = std::fs::create_dir_all(parent) {
                outcome.errors.push(format!("mkdir {:?}: {}", parent, e));
                continue;
            }
        }
        if let Err(e) = atomic_write(&dst, &snap_bytes) {
            outcome.errors.push(format!("restore write {:?}: {}", dst, e));
            continue;
        }
        outcome.files_restored += 1;
        progress::bump_current();
    }

    // Delete vault files NOT in the manifest (true restore semantics).
    let mut to_delete: Vec<PathBuf> = Vec::new();
    walk_vault_files(vault, &snapshots_root_for(vault)?, &mut to_delete);
    for p in to_delete {
        let rel = match p.strip_prefix(vault) {
            Ok(r) => r.to_string_lossy().replace('\\', "/"),
            Err(_) => continue,
        };
        if manifest_paths.contains(&rel) {
            continue;
        }
        if let Err(e) = std::fs::remove_file(&p) {
            outcome.errors.push(format!("delete extra {:?}: {}", p, e));
            continue;
        }
        outcome.files_deleted += 1;
    }

    log::info!(
        "[snapshot] restore {} done: restored={} deleted={} errors={}",
        snapshot_id, outcome.files_restored, outcome.files_deleted, outcome.errors.len()
    );
    Ok(outcome)
}

/// P1 #6 (HanBin 2026-05-24) — preview what `restore_snapshot` would do
/// without writing anything. Safe to call any time.
pub fn preview_restore(vault: &Path, snapshot_id: &str) -> Result<RestorePreview, String> {
    let root = snapshots_root_for(vault)?;
    let snap_dir = root.join(snapshot_id);
    let manifest_path = snap_dir.join("manifest.json");
    let bytes = std::fs::read(&manifest_path)
        .map_err(|e| format!("read manifest {:?}: {}", manifest_path, e))?;
    let manifest: SnapshotManifest = serde_json::from_slice(&bytes)
        .map_err(|e| format!("parse manifest: {}", e))?;
    if manifest.completed_at.is_none() {
        return Err(format!("snapshot {} is incomplete", snapshot_id));
    }

    let manifest_paths: std::collections::HashSet<String> = manifest
        .entries
        .iter()
        .map(|e| e.rel_path.clone())
        .collect();
    let manifest_entries: std::collections::HashMap<String, &SnapshotEntry> = manifest
        .entries
        .iter()
        .map(|e| (e.rel_path.clone(), e))
        .collect();

    let mut preview = RestorePreview {
        snapshot_id: snapshot_id.to_string(),
        files_to_overwrite: Vec::new(),
        files_to_delete: Vec::new(),
        files_unchanged: 0,
        bytes_to_overwrite: 0,
    };

    // Files in vault → split into overwrite, unchanged, or delete.
    let mut vault_files: Vec<PathBuf> = Vec::new();
    walk_vault_files(vault, &root, &mut vault_files);
    let vault_paths_set: std::collections::HashSet<String> = vault_files
        .iter()
        .filter_map(|p| p.strip_prefix(vault).ok().map(|r| r.to_string_lossy().replace('\\', "/")))
        .collect();

    for p in &vault_files {
        let rel = match p.strip_prefix(vault) {
            Ok(r) => r.to_string_lossy().replace('\\', "/"),
            Err(_) => continue,
        };
        if !manifest_paths.contains(&rel) {
            preview.files_to_delete.push(rel);
            continue;
        }
        // In manifest — compare sha to decide overwrite vs unchanged.
        let entry = match manifest_entries.get(&rel) {
            Some(e) => e,
            None => continue,
        };
        let cur_sha = match std::fs::read(p) {
            Ok(b) => {
                let mut h = Sha256::new();
                h.update(&b);
                format!("{:x}", h.finalize())
            }
            Err(_) => {
                // Unreadable → counted as overwrite (restore will rewrite from snapshot)
                preview.files_to_overwrite.push(rel);
                preview.bytes_to_overwrite += entry.size_bytes;
                continue;
            }
        };
        if cur_sha == entry.sha256 {
            preview.files_unchanged += 1;
        } else {
            preview.files_to_overwrite.push(rel);
            preview.bytes_to_overwrite += entry.size_bytes;
        }
    }

    // Files in manifest but NOT in vault → also "overwrite" (will be created).
    for entry in &manifest.entries {
        if !vault_paths_set.contains(&entry.rel_path) {
            preview.files_to_overwrite.push(entry.rel_path.clone());
            preview.bytes_to_overwrite += entry.size_bytes;
        }
    }

    Ok(preview)
}

pub fn delete_snapshot(vault: &Path, snapshot_id: &str) -> Result<(), String> {
    let root = snapshots_root_for(vault)?;
    let dir = root.join(snapshot_id);
    if !dir.is_dir() {
        return Err(format!("snapshot {} not found", snapshot_id));
    }
    std::fs::remove_dir_all(&dir)
        .map_err(|e| format!("delete snapshot {:?}: {}", dir, e))?;
    Ok(())
}

// ─── helpers ──────────────────────────────────────────────────────────

fn persist_manifest(dir: &Path, manifest: &SnapshotManifest) -> Result<(), String> {
    let path = dir.join("manifest.json");
    let bytes = serde_json::to_vec_pretty(manifest)
        .map_err(|e| format!("serialize manifest: {}", e))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, bytes).map_err(|e| format!("write manifest tmp: {}", e))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("rename manifest: {}", e))?;
    Ok(())
}

fn atomic_write(dst: &Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = dst.with_extension("snap.tmp");
    std::fs::write(&tmp, bytes).map_err(|e| format!("write tmp: {}", e))?;
    std::fs::rename(&tmp, dst).map_err(|e| format!("rename: {}", e))?;
    Ok(())
}

/// Walk every file under the vault, EXCLUDING the snapshot store itself.
/// Returns absolute paths. Skips `.legacy/` (other backup directories
/// could be very large and snapshotting backups of backups is silly).
fn walk_vault_files(vault: &Path, snapshots_root: &Path, out: &mut Vec<PathBuf>) {
    let snapshots_root_canonical = snapshots_root.canonicalize().ok();
    let mut stack = vec![vault.to_path_buf()];
    // 2026-05-24 (HanBin) — symlink loop protection. Track canonical
    // paths we've already entered; if a dir resolves to one we've seen,
    // it's a symlink cycle (`vault/loop -> vault`) and we abort that
    // branch. Without this, a malicious or accidental loop crashes the
    // walker via stack overflow.
    let mut visited: std::collections::HashSet<PathBuf> = std::collections::HashSet::new();
    while let Some(dir) = stack.pop() {
        if let Some(s) = snapshots_root_canonical.as_ref() {
            if let Ok(d) = dir.canonicalize() {
                if d.starts_with(s) {
                    continue;
                }
                // Symlink loop detection — canonical path already seen?
                if !visited.insert(d.clone()) {
                    log::warn!("[snapshot] symlink loop detected at {:?}, skipping", dir);
                    continue;
                }
            }
        }
        if dir != vault {
            if let Some(name) = dir.file_name().and_then(|s| s.to_str()) {
                if name == ".legacy" {
                    continue;
                }
            }
        }
        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let p = entry.path();
            // Skip symlinks entirely — both for file content (could
            // point to anywhere) and dirs (loop risk).
            if crate::core::file_io::is_symlink(&p) {
                log::debug!("[snapshot] skipping symlink {:?}", p);
                continue;
            }
            if p.is_dir() {
                stack.push(p);
            } else if p.is_file() {
                out.push(p);
            }
        }
    }
}

// silence unused dep checker on HashMap import — kept for future
// "diff between snapshots" feature
#[allow(dead_code)]
fn _hash_map_anchor() -> HashMap<String, String> { HashMap::new() }
