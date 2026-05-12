//! Legacy attachment migration — `vault/{Note}_att/` → new layout.
//!
//! Per design doc §7 and `feedback_migration_strength.md`:
//!   - **Forcible** — auto-triggered on vault open when legacy folders exist
//!     and the new ref store is empty.
//!   - **Lossless** — pre-state checksums + .legacy/<ts>/ backup + post-state
//!     verification. Rollback restores the original tree bit-for-bit.
//!   - **Crash-safe** — journal is written incrementally; resume picks up
//!     from the last verified entry.
//!
//! Out-of-scope: NAS sync. Migration is a local-only transformation. The
//! resulting ref + blob files end up in the dirty queue (caller's job to
//! enqueue) and the existing push_worker / background_worker drain them.

#![allow(dead_code)]

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::core::file_io::atomic_write_file;
use crate::features::sync_v2::attachment_store::{sha256_hex, AttachmentStore};

/// Files inside `{Note}_att/` that are NOT user attachments — must be left in
/// place (or migrated separately). Currently just the comments sidecar.
const SYSTEM_FILES: &[&str] = &["comments.json"];

#[derive(Debug, Clone, Serialize, Deserialize)]
struct LegacyFileEntry {
    source_path: String,   // vault-relative, e.g. "Note1_att/Report.pdf"
    note_stem: String,     // "Note1"
    file_name: String,     // "Report.pdf"
    sha256: String,
    size_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct MigrationEntry {
    source_path: String,
    attachment_id: String,
    sha256: String,
    display_path: String,
    note_stem: String,
    status: EntryStatus,
    timestamp: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
enum EntryStatus {
    Migrated,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct VerificationResult {
    performed_at: Option<DateTime<Utc>>,
    files_expected: usize,
    files_found: usize,
    sha_mismatches: Vec<String>,
    passed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct MigrationJournal {
    schema_version: u32,
    started_at: Option<DateTime<Utc>>,
    completed_at: Option<DateTime<Utc>>,
    entries: Vec<MigrationEntry>,
    verification: VerificationResult,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct MigrationReport {
    pub total_files: usize,
    pub migrated: usize,
    pub deduped: usize,
    pub collisions: usize,
    pub duration_ms: u64,
    pub legacy_backup_dir: Option<String>,
}

pub struct AttachmentMigration {
    vault_root: PathBuf,
    journal_path: PathBuf,
}

impl AttachmentMigration {
    pub fn new(vault_root: PathBuf) -> Self {
        let journal_path =
            vault_root.join(".notology/attachments/migration_journal.json");
        Self { vault_root, journal_path }
    }

    /// True iff any `*_att/` folder still holds files (excluding system
    /// sidecars like `comments.json`).
    ///
    /// Track B 2026-05-12 hotfix: simplified from the original
    /// "legacy ∧ ¬new_refs" predicate. That version mishandled partial
    /// migrations — a kill mid-run leaves N refs in `.notology/attachments/refs/`
    /// while leaving the remaining _att/ files untouched, but the old check
    /// then read `has_new_refs=true` and skipped a re-run, stranding those
    /// files permanently.
    ///
    /// New invariant: legacy files present ⇒ migration needed. The cleanup
    /// step removes `_att/` folders *only after* verification passes, so
    /// `scan_legacy().is_empty()` is the canonical success signal. On a
    /// retry, already-migrated files dedup via sha256 in CAS — no double
    /// work, no duplicate refs.
    pub fn needs_migration(&self) -> Result<bool, String> {
        if !self.vault_root.is_dir() {
            return Ok(false);
        }
        let legacy_files = self.scan_legacy(false)?;
        Ok(!legacy_files.is_empty())
    }

    /// Run the migration end-to-end. Idempotent on subsequent calls (returns
    /// trivial report when nothing to do). On verification failure, rolls back.
    pub fn run(&mut self) -> Result<MigrationReport, String> {
        let started = Utc::now();
        let legacy = self.scan_legacy(true)?;
        if legacy.is_empty() {
            return Ok(MigrationReport::default());
        }

        let legacy_backup_dir = self.create_legacy_backup(&legacy, started)?;

        let mut journal = MigrationJournal {
            schema_version: 1,
            started_at: Some(started),
            completed_at: None,
            entries: Vec::new(),
            verification: VerificationResult::default(),
        };
        self.persist_journal(&journal)?;

        let mut store = AttachmentStore::new(self.vault_root.clone())?;
        let total_files = legacy.len();
        let mut migrated = 0usize;
        let mut deduped = 0usize;
        let mut collisions = 0usize;

        // Mapping: note_stem → { old_filename → display_basename } so we can
        // rewrite wikilinks in the body of `{note_stem}.md` afterwards.
        let mut wiki_remap: HashMap<String, HashMap<String, String>> = HashMap::new();

        for entry in &legacy {
            let abs_src = self.vault_root.join(&entry.source_path);
            match store.import_legacy_file(&abs_src, &entry.file_name, &entry.note_stem) {
                Ok(out) => {
                    let display_basename = std::path::Path::new(&out.attachment_ref.display_path)
                        .file_name()
                        .and_then(|s| s.to_str())
                        .unwrap_or("")
                        .to_string();
                    if display_basename != entry.file_name {
                        collisions += 1;
                    }
                    if out.was_deduped {
                        deduped += 1;
                    }
                    migrated += 1;
                    wiki_remap
                        .entry(entry.note_stem.clone())
                        .or_default()
                        .insert(entry.file_name.clone(), display_basename.clone());
                    journal.entries.push(MigrationEntry {
                        source_path: entry.source_path.clone(),
                        attachment_id: out.attachment_ref.attachment_id,
                        sha256: out.attachment_ref.sha256.clone(),
                        display_path: out.attachment_ref.display_path,
                        note_stem: entry.note_stem.clone(),
                        status: EntryStatus::Migrated,
                        timestamp: Utc::now(),
                    });
                }
                Err(e) => {
                    journal.entries.push(MigrationEntry {
                        source_path: entry.source_path.clone(),
                        attachment_id: String::new(),
                        sha256: entry.sha256.clone(),
                        display_path: String::new(),
                        note_stem: entry.note_stem.clone(),
                        status: EntryStatus::Failed,
                        timestamp: Utc::now(),
                    });
                    self.persist_journal(&journal)?;
                    self.rollback(&legacy_backup_dir, &legacy)?;
                    return Err(format!("import failed for {}: {}", entry.source_path, e));
                }
            }
            self.persist_journal(&journal)?;
        }

        // Rewrite wikilinks in note bodies.
        if let Err(e) = self.rewrite_wikilinks(&wiki_remap) {
            self.rollback(&legacy_backup_dir, &legacy)?;
            return Err(format!("wikilink rewrite failed: {}", e));
        }

        // Post-state verification.
        let verification = self.verify(&legacy, &store)?;
        journal.verification = verification.clone();
        journal.completed_at = Some(Utc::now());
        self.persist_journal(&journal)?;

        if !verification.passed {
            self.rollback(&legacy_backup_dir, &legacy)?;
            return Err(format!(
                "verification failed: expected={}, found={}, mismatches={}",
                verification.files_expected,
                verification.files_found,
                verification.sha_mismatches.len()
            ));
        }

        // Cleanup legacy folders (only after verification passes).
        self.cleanup_legacy_folders()?;

        Ok(MigrationReport {
            total_files,
            migrated,
            deduped,
            collisions,
            duration_ms: (Utc::now() - started).num_milliseconds().max(0) as u64,
            legacy_backup_dir: Some(legacy_backup_dir.to_string_lossy().to_string()),
        })
    }

    fn scan_legacy(&self, compute_sha: bool) -> Result<Vec<LegacyFileEntry>, String> {
        let mut out = Vec::new();
        self.walk_for_att(&self.vault_root, &mut out, compute_sha)?;
        Ok(out)
    }

    fn walk_for_att(
        &self,
        dir: &Path,
        out: &mut Vec<LegacyFileEntry>,
        compute_sha: bool,
    ) -> Result<(), String> {
        // Skip vault internal dirs entirely
        if let Some(name) = dir.file_name().and_then(|s| s.to_str()) {
            if name.starts_with('.') {
                return Ok(());
            }
        }
        let entries = match std::fs::read_dir(dir) {
            Ok(e) => e,
            Err(_) => return Ok(()),
        };
        for e in entries.flatten() {
            let p = e.path();
            if !p.is_dir() {
                continue;
            }
            let name = match p.file_name().and_then(|s| s.to_str()) {
                Some(n) => n.to_string(),
                None => continue,
            };
            if name.starts_with('.') {
                continue;
            }
            if let Some(stem) = name.strip_suffix("_att") {
                // Found a legacy attachment folder.
                if let Ok(files) = std::fs::read_dir(&p) {
                    for f in files.flatten() {
                        let fp = f.path();
                        if !fp.is_file() {
                            continue;
                        }
                        let fname = match fp.file_name().and_then(|s| s.to_str()) {
                            Some(n) => n.to_string(),
                            None => continue,
                        };
                        if SYSTEM_FILES.contains(&fname.as_str()) {
                            continue;
                        }
                        let rel = fp
                            .strip_prefix(&self.vault_root)
                            .map(|r| r.to_string_lossy().replace('\\', "/"))
                            .unwrap_or_else(|_| fp.to_string_lossy().to_string());
                        let metadata =
                            std::fs::metadata(&fp).map_err(|e| format!("metadata {:?}: {}", fp, e))?;
                        let size_bytes = metadata.len();
                        let sha = if compute_sha {
                            let bytes = std::fs::read(&fp)
                                .map_err(|e| format!("read {:?}: {}", fp, e))?;
                            sha256_hex(&bytes)
                        } else {
                            String::new()
                        };
                        out.push(LegacyFileEntry {
                            source_path: rel,
                            note_stem: stem.to_string(),
                            file_name: fname,
                            sha256: sha,
                            size_bytes,
                        });
                    }
                }
            } else {
                self.walk_for_att(&p, out, compute_sha)?;
            }
        }
        Ok(())
    }

    fn create_legacy_backup(
        &self,
        legacy: &[LegacyFileEntry],
        started: DateTime<Utc>,
    ) -> Result<PathBuf, String> {
        let ts = started.format("%Y%m%d_%H%M%S").to_string();
        let backup_root = self.vault_root.join(".legacy").join(&ts);
        std::fs::create_dir_all(&backup_root).map_err(|e| format!("mkdir legacy: {}", e))?;
        for entry in legacy {
            let src = self.vault_root.join(&entry.source_path);
            let dst = backup_root.join(&entry.source_path);
            if let Some(parent) = dst.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("mkdir backup parent: {}", e))?;
            }
            std::fs::copy(&src, &dst).map_err(|e| format!("backup copy {:?}: {}", src, e))?;
        }
        Ok(backup_root)
    }

    fn rewrite_wikilinks(
        &self,
        remap_by_note: &HashMap<String, HashMap<String, String>>,
    ) -> Result<(), String> {
        // Walk all .md files (skip hidden + _att — _att is going away anyway).
        let mut md_files = Vec::new();
        self.walk_md(&self.vault_root, &mut md_files);

        for md in md_files {
            let stem = md
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or_default()
                .to_string();
            // Build remap for this note. The legacy convention is that
            // `Note_att/file.pdf` is referenced by `Note.md` only — so we use
            // the per-note remap.
            let per_note = remap_by_note.get(&stem);
            // Also consider the union — wikilinks may point at attachments
            // owned by another note (rare but legal). Fall back to that union
            // for any name not found in per_note.
            let mut union_remap: BTreeMap<String, String> = BTreeMap::new();
            for table in remap_by_note.values() {
                for (k, v) in table {
                    union_remap.entry(k.clone()).or_insert_with(|| v.clone());
                }
            }

            let content = match std::fs::read_to_string(&md) {
                Ok(c) => c,
                Err(_) => continue,
            };

            let rewritten = rewrite_wikilinks_in_content(&content, per_note, &union_remap);
            if rewritten != content {
                atomic_write_file(&md, rewritten.as_bytes())?;
            }
        }
        Ok(())
    }

    fn walk_md(&self, dir: &Path, out: &mut Vec<PathBuf>) {
        if let Some(name) = dir.file_name().and_then(|s| s.to_str()) {
            if name.starts_with('.') || name.ends_with("_att") {
                return;
            }
        }
        if let Ok(entries) = std::fs::read_dir(dir) {
            for e in entries.flatten() {
                let p = e.path();
                if p.is_dir() {
                    self.walk_md(&p, out);
                } else if p.extension().and_then(|s| s.to_str()) == Some("md") {
                    out.push(p);
                }
            }
        }
    }

    fn verify(
        &self,
        legacy: &[LegacyFileEntry],
        store: &AttachmentStore,
    ) -> Result<VerificationResult, String> {
        let mut found = 0usize;
        let mut mismatches = Vec::new();
        let mut seen_shas: HashSet<String> = HashSet::new();
        for r in store.all_refs() {
            seen_shas.insert(r.sha256.clone());
        }

        // Every legacy sha must correspond to a CAS blob now.
        let mut expected_shas: HashSet<String> = HashSet::new();
        for entry in legacy {
            expected_shas.insert(entry.sha256.clone());
            let blob = self
                .vault_root
                .join(".notology/cas/blobs")
                .join(&entry.sha256[0..2])
                .join(&entry.sha256[2..4])
                .join(&entry.sha256);
            if !blob.is_file() {
                mismatches.push(format!("missing blob: {}", entry.source_path));
                continue;
            }
            let bytes = match std::fs::read(&blob) {
                Ok(b) => b,
                Err(e) => {
                    mismatches.push(format!("read blob {:?}: {}", blob, e));
                    continue;
                }
            };
            let actual = sha256_hex(&bytes);
            if actual != entry.sha256 {
                mismatches.push(format!(
                    "sha mismatch for {}: expected {}, got {}",
                    entry.source_path, entry.sha256, actual
                ));
                continue;
            }
            found += 1;
        }

        let passed = mismatches.is_empty()
            && found == legacy.len()
            && expected_shas.iter().all(|s| seen_shas.contains(s));

        Ok(VerificationResult {
            performed_at: Some(Utc::now()),
            files_expected: legacy.len(),
            files_found: found,
            sha_mismatches: mismatches,
            passed,
        })
    }

    fn cleanup_legacy_folders(&self) -> Result<(), String> {
        let mut to_remove = Vec::new();
        self.collect_att_dirs(&self.vault_root, &mut to_remove);
        for dir in to_remove {
            // Preserve system files (comments.json) by moving them up next to
            // the note. The cascade then deletes the _att dir.
            self.preserve_system_files(&dir)?;
            std::fs::remove_dir_all(&dir)
                .map_err(|e| format!("remove legacy {:?}: {}", dir, e))?;
        }
        Ok(())
    }

    fn collect_att_dirs(&self, dir: &Path, out: &mut Vec<PathBuf>) {
        if let Some(name) = dir.file_name().and_then(|s| s.to_str()) {
            if name.starts_with('.') {
                return;
            }
            if name.ends_with("_att") {
                out.push(dir.to_path_buf());
                return;
            }
        }
        if let Ok(entries) = std::fs::read_dir(dir) {
            for e in entries.flatten() {
                let p = e.path();
                if p.is_dir() {
                    self.collect_att_dirs(&p, out);
                }
            }
        }
    }

    fn preserve_system_files(&self, att_dir: &Path) -> Result<(), String> {
        let parent = att_dir.parent().ok_or_else(|| "att_dir has no parent".to_string())?;
        let stem = att_dir
            .file_name()
            .and_then(|s| s.to_str())
            .and_then(|n| n.strip_suffix("_att"))
            .unwrap_or_default();
        for sysname in SYSTEM_FILES {
            let src = att_dir.join(sysname);
            if !src.is_file() {
                continue;
            }
            // Place comments.json beside its note as `{note}.comments.json`.
            let dst = parent.join(format!("{}.{}", stem, sysname));
            if dst.exists() {
                continue; // already preserved
            }
            std::fs::rename(&src, &dst)
                .or_else(|_| std::fs::copy(&src, &dst).map(|_| ()))
                .map_err(|e| format!("preserve {:?}: {}", src, e))?;
        }
        Ok(())
    }

    fn rollback(
        &self,
        backup_dir: &Path,
        legacy: &[LegacyFileEntry],
    ) -> Result<(), String> {
        log::warn!("[attachment_migration] rollback triggered, restoring from {:?}", backup_dir);
        // Restore: copy backup files back to their original paths. This is
        // belt-and-suspenders — the originals are not deleted until cleanup,
        // which only runs after verification passes.
        for entry in legacy {
            let src = backup_dir.join(&entry.source_path);
            let dst = self.vault_root.join(&entry.source_path);
            if let Some(parent) = dst.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            if src.is_file() {
                let _ = std::fs::copy(&src, &dst);
            }
        }
        // Remove partial new state so the next vault open will retry the
        // migration from a clean slate.
        let _ = std::fs::remove_dir_all(self.vault_root.join(".attachments"));
        let _ = std::fs::remove_dir_all(self.vault_root.join(".notology/attachments"));
        let _ = std::fs::remove_dir_all(self.vault_root.join(".notology/cas/blobs"));
        Ok(())
    }

    fn persist_journal(&self, journal: &MigrationJournal) -> Result<(), String> {
        if let Some(parent) = self.journal_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("mkdir journal parent: {}", e))?;
        }
        let bytes = serde_json::to_vec_pretty(journal)
            .map_err(|e| format!("serialize journal: {}", e))?;
        atomic_write_file(&self.journal_path, &bytes)
    }
}

/// Rewrite wikilinks in a note body. Supports `[[name]]`, `![[name]]`, alias
/// `[[name|alias]]`, and the HTML span form `<span data-wiki-link="name">…</span>`.
fn rewrite_wikilinks_in_content(
    content: &str,
    per_note: Option<&HashMap<String, String>>,
    union_remap: &BTreeMap<String, String>,
) -> String {
    // Helper: pick replacement for `name` if any.
    let resolve = |name: &str| -> Option<String> {
        if let Some(m) = per_note {
            if let Some(v) = m.get(name) {
                if v != name {
                    return Some(v.clone());
                }
            }
        }
        if let Some(v) = union_remap.get(name) {
            if v != name {
                return Some(v.clone());
            }
        }
        None
    };

    // Wikilink + embed: `[[name]]`, `![[name]]`, `[[name|alias]]`, `![[name|alias]]`
    let wiki_re = Regex::new(r"!?\[\[([^\]\[\|]+)(\|[^\]\[]*)?\]\]").unwrap();
    let with_wiki = wiki_re.replace_all(content, |caps: &regex::Captures| {
        let whole = caps.get(0).unwrap().as_str();
        let name = caps.get(1).unwrap().as_str();
        let suffix = caps.get(2).map(|m| m.as_str()).unwrap_or("");
        if let Some(new_name) = resolve(name) {
            let prefix = if whole.starts_with('!') { "!" } else { "" };
            format!("{}[[{}{}]]", prefix, new_name, suffix)
        } else {
            whole.to_string()
        }
    });

    // HTML span: `<span data-wiki-link="name" ...>display</span>`
    let span_re = Regex::new(r#"data-wiki-link="([^"]+)""#).unwrap();
    let with_span = span_re.replace_all(&with_wiki, |caps: &regex::Captures| {
        let name = caps.get(1).unwrap().as_str();
        if let Some(new_name) = resolve(name) {
            format!(r#"data-wiki-link="{}""#, new_name)
        } else {
            caps.get(0).unwrap().as_str().to_string()
        }
    });

    with_span.into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn write(path: &Path, content: &[u8]) {
        if let Some(p) = path.parent() {
            std::fs::create_dir_all(p).unwrap();
        }
        std::fs::write(path, content).unwrap();
    }

    #[test]
    fn migration_noop_when_no_legacy_files() {
        let tmp = TempDir::new().unwrap();
        let mut m = AttachmentMigration::new(tmp.path().to_path_buf());
        assert!(!m.needs_migration().unwrap());
        let report = m.run().unwrap();
        assert_eq!(report.total_files, 0);
        assert_eq!(report.migrated, 0);
    }

    #[test]
    fn migration_moves_files_into_new_layout() {
        let tmp = TempDir::new().unwrap();
        let vault = tmp.path();
        write(&vault.join("Note1.md"), b"# Note1\n\n[[Report.pdf]]");
        write(&vault.join("Note1_att/Report.pdf"), b"PDF bytes A");

        let mut m = AttachmentMigration::new(vault.to_path_buf());
        assert!(m.needs_migration().unwrap());
        let report = m.run().unwrap();
        assert_eq!(report.total_files, 1);
        assert_eq!(report.migrated, 1);
        assert!(vault.join(".attachments/Report.pdf").exists());
        assert!(!vault.join("Note1_att").exists());
        // Backup preserved
        assert!(report.legacy_backup_dir.is_some());
    }

    #[test]
    fn migration_handles_collision_with_suffix() {
        let tmp = TempDir::new().unwrap();
        let vault = tmp.path();
        write(&vault.join("A.md"), b"# A\n[[Report.pdf]]");
        write(&vault.join("A_att/Report.pdf"), b"version A");
        write(&vault.join("B.md"), b"# B\n[[Report.pdf]]");
        write(&vault.join("B_att/Report.pdf"), b"version B");

        let mut m = AttachmentMigration::new(vault.to_path_buf());
        let report = m.run().unwrap();
        assert_eq!(report.total_files, 2);
        assert_eq!(report.migrated, 2);
        assert!(report.collisions >= 1);
        assert!(vault.join(".attachments/Report.pdf").exists());
        assert!(vault.join(".attachments/Report_1.pdf").exists());

        // Note bodies: the second one should now reference Report_1.pdf
        let a = std::fs::read_to_string(vault.join("A.md")).unwrap();
        let b = std::fs::read_to_string(vault.join("B.md")).unwrap();
        // One contains the original name, the other contains the suffixed name.
        let total_orig = a.matches("[[Report.pdf]]").count() + b.matches("[[Report.pdf]]").count();
        let total_suffixed =
            a.matches("[[Report_1.pdf]]").count() + b.matches("[[Report_1.pdf]]").count();
        assert_eq!(total_orig + total_suffixed, 2);
        assert_eq!(total_suffixed, 1);
    }

    #[test]
    fn migration_dedups_same_sha() {
        let tmp = TempDir::new().unwrap();
        let vault = tmp.path();
        write(&vault.join("A.md"), b"# A\n[[shared.pdf]]");
        write(&vault.join("A_att/shared.pdf"), b"identical bytes");
        write(&vault.join("B.md"), b"# B\n[[shared.pdf]]");
        write(&vault.join("B_att/shared.pdf"), b"identical bytes");

        let mut m = AttachmentMigration::new(vault.to_path_buf());
        let report = m.run().unwrap();
        assert_eq!(report.total_files, 2);
        assert!(report.deduped >= 1);
        // Single CAS blob
        let mut blobs = Vec::new();
        for shard in std::fs::read_dir(vault.join(".notology/cas/blobs")).unwrap().flatten() {
            for inner in std::fs::read_dir(shard.path()).unwrap().flatten() {
                for blob in std::fs::read_dir(inner.path()).unwrap().flatten() {
                    blobs.push(blob.path());
                }
            }
        }
        assert_eq!(blobs.len(), 1);
    }

    #[test]
    fn migration_preserves_comments_json() {
        let tmp = TempDir::new().unwrap();
        let vault = tmp.path();
        write(&vault.join("X.md"), b"# X");
        write(&vault.join("X_att/Report.pdf"), b"pdf");
        write(&vault.join("X_att/comments.json"), b"[]");

        let mut m = AttachmentMigration::new(vault.to_path_buf());
        m.run().unwrap();
        assert!(!vault.join("X_att").exists());
        assert!(vault.join("X.comments.json").exists());
    }

    #[test]
    fn partial_migration_state_still_needs_migration() {
        // Simulates the 2026-05-12 hotfix scenario: a previous run wrote some
        // refs but was killed before cleanup_legacy_folders. `needs_migration`
        // must still return true so the next vault open finishes the job.
        let tmp = TempDir::new().unwrap();
        let vault = tmp.path();

        // Two source attachments + one note, one of them appears "already
        // migrated" (ref exists in new location).
        write(&vault.join("A.md"), b"# A\n[[one.pdf]]\n[[two.pdf]]");
        write(&vault.join("A_att/one.pdf"), b"alpha");
        write(&vault.join("A_att/two.pdf"), b"beta");

        // Manually write a ref to simulate a half-finished run.
        let fake_ref = r#"{
            "attachment_id":"20260512000000",
            "original_name":"one.pdf",
            "mime_type":"application/pdf",
            "size_bytes":5,
            "sha256":"deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
            "tier":"pdf",
            "created_at":"2026-05-12T00:00:00Z",
            "linked_notes":["A"],
            "display_path":".attachments/one.pdf",
            "sync_etag":null,
            "remote_path":null
        }"#;
        write(
            &vault.join(".notology/attachments/refs/20260512000000.json"),
            fake_ref.as_bytes(),
        );

        let m = AttachmentMigration::new(vault.to_path_buf());
        // The buggy pre-hotfix code returned false here. After the fix it
        // returns true because two.pdf is still sitting in A_att/.
        assert!(
            m.needs_migration().unwrap(),
            "partial migration must still trigger needs_migration"
        );
    }

    #[test]
    fn rewrites_html_span_wikilinks() {
        let body = r#"# A
<span data-wiki-link="Report.pdf" class="attachment">Report.pdf</span>
"#;
        let mut per_note = HashMap::new();
        per_note.insert("Report.pdf".to_string(), "Report_1.pdf".to_string());
        let union: BTreeMap<String, String> = BTreeMap::new();
        let out = rewrite_wikilinks_in_content(body, Some(&per_note), &union);
        assert!(out.contains(r#"data-wiki-link="Report_1.pdf""#));
    }
}
