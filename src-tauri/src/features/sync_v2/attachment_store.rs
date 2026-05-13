//! Attachment store — CAS blob + ref JSON + index management.
//!
//! Layout (per design doc §3.1):
//! ```text
//! vault/.attachments/<display>                                  user-visible
//! vault/.notology/cas/blobs/<sha[0..2]>/<sha[2..4]>/<sha>        binary store
//! vault/.notology/attachments/refs/<attachment_id>.json          metadata
//! vault/.notology/attachments/index.json                          name → ids map
//! ```
//!
//! Concurrency model: a single store instance is wrapped in a `Mutex` at the
//! engine layer. Methods take `&mut self` so the borrow checker enforces it.
//! On-disk writes go through `atomic_write_file` so a crash leaves either
//! the old or new content, never a partial file.

#![allow(dead_code)]

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::core::file_io::atomic_write_file;
use crate::features::sync_v2::attachment_types::{
    AttachmentBlob, AttachmentRef, AttachmentTier, ResolvedAttachment,
};

const SCHEMA_VERSION: u32 = 1;
const INDEX_FILE: &str = "index.json";

#[derive(Debug, Clone, Copy)]
pub enum LinkMethod {
    Hardlink,
    Copy,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct IndexFile {
    schema_version: u32,
    name_to_ids: HashMap<String, Vec<String>>,
    id_to_ref_path: HashMap<String, String>,
}

#[derive(Debug, Clone)]
pub struct AddOutcome {
    pub attachment_ref: AttachmentRef,
    pub was_deduped: bool,
    pub link_method: LinkMethod,
}

pub struct AttachmentStore {
    vault_root: PathBuf,
    refs_by_id: HashMap<String, AttachmentRef>,
    name_to_ids: HashMap<String, Vec<String>>,
    blobs_by_sha: HashMap<String, AttachmentBlob>,
    last_id_ms: i64,
}

impl AttachmentStore {
    pub fn new(vault_root: PathBuf) -> Result<Self, String> {
        let mut s = Self {
            vault_root,
            refs_by_id: HashMap::new(),
            name_to_ids: HashMap::new(),
            blobs_by_sha: HashMap::new(),
            last_id_ms: 0,
        };
        s.ensure_directories()?;
        s.load_from_disk()?;
        Ok(s)
    }

    fn ensure_directories(&self) -> Result<(), String> {
        for sub in [".attachments", ".notology/cas/blobs", ".notology/attachments/refs"] {
            let p = self.vault_root.join(sub);
            std::fs::create_dir_all(&p).map_err(|e| format!("mkdir {}: {}", sub, e))?;
        }
        Ok(())
    }

    fn refs_dir(&self) -> PathBuf {
        self.vault_root.join(".notology/attachments/refs")
    }

    fn index_path(&self) -> PathBuf {
        self.vault_root.join(".notology/attachments").join(INDEX_FILE)
    }

    fn cas_path(&self, sha: &str) -> PathBuf {
        self.vault_root
            .join(".notology/cas/blobs")
            .join(&sha[0..2])
            .join(&sha[2..4])
            .join(sha)
    }

    fn display_dir(&self) -> PathBuf {
        self.vault_root.join(".attachments")
    }

    /// Reload the in-memory indices from `.notology/attachments/refs/`.
    /// **Idempotent** — clears the existing in-memory state first, so calling
    /// this repeatedly does not accumulate duplicate entries in `name_to_ids`.
    /// Track B 2026-05-12 hotfix: long-lived stores held by push_worker /
    /// background_worker must be able to pick up refs added by concurrent
    /// `attachment_add` calls between worker batches.
    pub fn load_from_disk(&mut self) -> Result<(), String> {
        self.refs_by_id.clear();
        self.name_to_ids.clear();
        self.blobs_by_sha.clear();

        let dir = self.refs_dir();
        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => return Ok(()),
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) != Some("json") {
                continue;
            }
            let bytes = match std::fs::read(&path) {
                Ok(b) => b,
                Err(e) => {
                    log::warn!("[attachment_store] skipping unreadable ref {:?}: {}", path, e);
                    continue;
                }
            };
            let r: AttachmentRef = match serde_json::from_slice(&bytes) {
                Ok(v) => v,
                Err(e) => {
                    // Don't abort the whole reload because of one corrupt ref —
                    // a partial state must not strand the rest of the store.
                    log::warn!("[attachment_store] skipping corrupt ref {:?}: {}", path, e);
                    continue;
                }
            };

            self.name_to_ids
                .entry(r.original_name.clone())
                .or_default()
                .push(r.attachment_id.clone());

            let blob_local = self.cas_path(&r.sha256);
            self.blobs_by_sha
                .entry(r.sha256.clone())
                .or_insert_with(|| AttachmentBlob {
                    sha256: r.sha256.clone(),
                    local_path: blob_local,
                    remote_path: r.remote_path.clone(),
                    size_bytes: r.size_bytes,
                });

            if let Some(ts_ms) = parse_id_to_ms(&r.attachment_id) {
                self.last_id_ms = self.last_id_ms.max(ts_ms);
            }
            self.refs_by_id.insert(r.attachment_id.clone(), r);
        }
        Ok(())
    }

    /// Import a new file. Returns the resulting ref and whether the blob was deduped.
    pub fn add_attachment(
        &mut self,
        source_path: &Path,
        original_name: &str,
        note_id: &str,
    ) -> Result<AddOutcome, String> {
        let bytes =
            std::fs::read(source_path).map_err(|e| format!("read source {:?}: {}", source_path, e))?;
        let sha = sha256_hex(&bytes);
        let size_bytes = bytes.len() as u64;

        let ext = Path::new(original_name)
            .extension()
            .and_then(|e| e.to_str())
            .map(|s| s.to_lowercase())
            .unwrap_or_default();
        let tier = AttachmentTier::from_extension(&ext);
        let mime_type = AttachmentTier::mime_for_extension(&ext).to_string();

        // Track B Phase B-3 PART 6 — dedup matrix (HanBin 2026-05-13):
        //
        //   | sha   | original_name | note_id | action                       |
        //   |-------|---------------|---------|------------------------------|
        //   | match | match         | match   | no-op, return existing       |
        //   | match | match         | ≠       | append note_id to ref's      |
        //   |       |               |         | linked_notes, return same    |
        //   |       |               |         | ref (cross-note dedup)       |
        //   | match | ≠             | (any)   | fresh ref, share CAS blob    |
        //   |       |               |         | (renamed copy)               |
        //   | ≠     | (any)         | (any)   | fresh ref + fresh CAS blob   |
        //
        // Rationale: the wikilink resolver looks up refs by `original_name`,
        // so renamed copies MUST get separate refs or the chip stays orphan.
        // But a popular file referenced from N notes should not produce N
        // refs — they all share the same logical attachment, so we collapse
        // them via `linked_notes`. Hard-delete unlinks one note at a time,
        // so cross-note dedup is correctness-preserving.
        let cross_note_match_id: Option<String> = {
            let mut hit: Option<&AttachmentRef> = None;
            for r in self.refs_by_id.values() {
                if r.sha256 != sha || r.original_name != original_name {
                    continue;
                }
                if r.linked_notes.iter().any(|n| n == note_id) {
                    // Same sha + same name + already linked → no-op return.
                    return Ok(AddOutcome {
                        attachment_ref: r.clone(),
                        was_deduped: true,
                        link_method: LinkMethod::Hardlink,
                    });
                }
                hit = Some(r);
            }
            hit.map(|r| r.attachment_id.clone())
        };

        if let Some(id) = cross_note_match_id {
            // Same sha + same name in another note. Append this note to the
            // existing ref's linked_notes instead of creating a duplicate.
            self.link_to_note(&id, note_id)?;
            let updated = self
                .refs_by_id
                .get(&id)
                .cloned()
                .ok_or_else(|| format!("attachment {} vanished mid-link", id))?;
            return Ok(AddOutcome {
                attachment_ref: updated,
                was_deduped: true,
                link_method: LinkMethod::Hardlink,
            });
        }

        // Dedup: same sha already present?
        let was_deduped = self.blobs_by_sha.contains_key(&sha);

        if !was_deduped {
            // Write CAS blob
            let blob_path = self.cas_path(&sha);
            if let Some(parent) = blob_path.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("mkdir blob parent: {}", e))?;
            }
            if !blob_path.is_file() {
                atomic_write_file(&blob_path, &bytes)?;
            }
            self.blobs_by_sha.insert(
                sha.clone(),
                AttachmentBlob {
                    sha256: sha.clone(),
                    local_path: blob_path.clone(),
                    remote_path: None,
                    size_bytes,
                },
            );
        }

        // For dedup case: try to find an existing ref for this sha+name+note already.
        // We do not return that ref — Track B contract says each import gets a fresh
        // attachment_id. But we still want to merge linked_notes if there's an exact
        // (sha, original_name) match in this note already.
        // ↑ Defer this to caller (Phase B-3 import flow). Here we always create a new ref.

        let attachment_id = self.next_monotonic_id();

        // Display name: collision suffix when the same original_name maps to a
        // different sha (or is already used).
        let display_name = self.allocate_display_name(original_name, &sha);

        // Hardlink display → CAS blob (or copy fallback)
        let display_path = self.display_dir().join(&display_name);
        let link_method = link_or_copy(&self.cas_path(&sha), &display_path)?;

        let ref_obj = AttachmentRef {
            attachment_id: attachment_id.clone(),
            original_name: original_name.to_string(),
            mime_type,
            size_bytes,
            sha256: sha.clone(),
            tier,
            created_at: Utc::now(),
            linked_notes: vec![note_id.to_string()],
            display_path: format!(".attachments/{}", display_name),
            sync_etag: None,
            remote_path: None,
        };

        self.persist_ref(&ref_obj)?;
        self.name_to_ids
            .entry(ref_obj.original_name.clone())
            .or_default()
            .push(attachment_id.clone());
        self.refs_by_id.insert(attachment_id.clone(), ref_obj.clone());
        self.write_index()?;

        Ok(AddOutcome {
            attachment_ref: ref_obj,
            was_deduped,
            link_method,
        })
    }

    /// Import a legacy `{Note}_att/file` into the new layout.
    /// Differs from `add_attachment` only in that the caller may supply the exact
    /// `attachment_id` (used by migration replay) and the source is not copied
    /// twice — it is hashed, CAS-written, hardlinked, and the original left for
    /// the migration cleanup step to remove.
    pub fn import_legacy_file(
        &mut self,
        source_path: &Path,
        original_name: &str,
        note_id: &str,
    ) -> Result<AddOutcome, String> {
        self.add_attachment(source_path, original_name, note_id)
    }

    pub fn delete_attachment(&mut self, attachment_id: &str) -> Result<(), String> {
        let r = self
            .refs_by_id
            .remove(attachment_id)
            .ok_or_else(|| format!("attachment_id {} not found", attachment_id))?;

        // Remove ref JSON
        let ref_path = self.refs_dir().join(format!("{}.json", attachment_id));
        let _ = std::fs::remove_file(&ref_path);

        // Remove display path
        let display_path = self.vault_root.join(&r.display_path);
        let _ = std::fs::remove_file(&display_path);

        // Remove name index entry
        if let Some(ids) = self.name_to_ids.get_mut(&r.original_name) {
            ids.retain(|id| id != attachment_id);
            if ids.is_empty() {
                self.name_to_ids.remove(&r.original_name);
            }
        }

        // If no other ref shares this sha, drop blob
        let still_referenced = self.refs_by_id.values().any(|other| other.sha256 == r.sha256);
        if !still_referenced {
            let blob_path = self.cas_path(&r.sha256);
            let _ = std::fs::remove_file(&blob_path);
            self.blobs_by_sha.remove(&r.sha256);
        }

        self.write_index()?;
        Ok(())
    }

    pub fn link_to_note(&mut self, attachment_id: &str, note_id: &str) -> Result<(), String> {
        let r = self
            .refs_by_id
            .get_mut(attachment_id)
            .ok_or_else(|| format!("attachment_id {} not found", attachment_id))?;
        if !r.linked_notes.iter().any(|n| n == note_id) {
            r.linked_notes.push(note_id.to_string());
            let snapshot = r.clone();
            self.persist_ref(&snapshot)?;
        }
        Ok(())
    }

    pub fn unlink_from_note(&mut self, attachment_id: &str, note_id: &str) -> Result<(), String> {
        let r = self
            .refs_by_id
            .get_mut(attachment_id)
            .ok_or_else(|| format!("attachment_id {} not found", attachment_id))?;
        let before = r.linked_notes.len();
        r.linked_notes.retain(|n| n != note_id);
        if r.linked_notes.len() == before {
            return Ok(());
        }
        let snapshot = r.clone();
        self.persist_ref(&snapshot)?;
        Ok(())
    }

    pub fn get_by_id(&self, attachment_id: &str) -> Option<&AttachmentRef> {
        self.refs_by_id.get(attachment_id)
    }

    pub fn list_for_note(&self, note_id: &str) -> Vec<&AttachmentRef> {
        self.refs_by_id
            .values()
            .filter(|r| r.linked_notes.iter().any(|n| n == note_id))
            .collect()
    }

    /// Resolve a wikilink target like `Report.pdf` in the context of a note.
    /// Strategy: pick the first ref whose `original_name` (or `display_path` tail)
    /// matches AND whose `linked_notes` contains the note_id. Falls back to any
    /// ref with that name if no link is recorded yet (e.g. during migration).
    pub fn resolve_wikilink(
        &self,
        name: &str,
        note_id: &str,
    ) -> Option<ResolvedAttachment> {
        let mut candidates: Vec<&AttachmentRef> = self
            .refs_by_id
            .values()
            .filter(|r| {
                r.original_name == name
                    || display_basename(&r.display_path) == name
            })
            .collect();

        if candidates.is_empty() {
            return None;
        }

        // Prefer refs linked to this note
        candidates.sort_by_key(|r| if r.linked_notes.iter().any(|n| n == note_id) { 0 } else { 1 });

        let r = candidates.first()?;
        Some(ResolvedAttachment {
            attachment_id: r.attachment_id.clone(),
            display_path: r.display_path.clone(),
            local_blob_path: self.cas_path(&r.sha256),
            tier: r.tier,
            size_bytes: r.size_bytes,
            mime_type: r.mime_type.clone(),
        })
    }

    pub fn find_by_sha(&self, sha256: &str) -> Option<&AttachmentBlob> {
        self.blobs_by_sha.get(sha256)
    }

    pub fn all_refs(&self) -> impl Iterator<Item = &AttachmentRef> {
        self.refs_by_id.values()
    }

    /// PART 6 hardening (HanBin 2026-05-13 "원천 방지"): sweep orphan
    /// CAS blobs and orphan display hardlinks that accumulated from
    /// failed deletes (NTFS file locks, antivirus, etc.) or aborted
    /// `attachment_add` calls (blob written, ref persist failed).
    ///
    /// "Orphan" here means a file under `.notology/cas/blobs/` or
    /// `.attachments/` whose sha (for blobs) or display path (for
    /// display files) does not correspond to ANY entry in `refs_by_id`.
    ///
    /// Returns `(blobs_removed, display_files_removed)`. Non-fatal on
    /// individual file errors — they are logged and skipped so a
    /// single locked file does not abort the sweep.
    pub fn sweep_orphans(&self) -> (usize, usize) {
        let valid_shas: std::collections::HashSet<&str> =
            self.refs_by_id.values().map(|r| r.sha256.as_str()).collect();
        let valid_displays: std::collections::HashSet<String> = self
            .refs_by_id
            .values()
            .filter_map(|r| {
                // `display_path` is vault-relative `.attachments/<name>`.
                // Extract just the basename for the comparison set.
                r.display_path
                    .rsplit('/')
                    .next()
                    .map(|s| s.to_string())
            })
            .collect();

        let mut blobs_removed = 0usize;
        let mut displays_removed = 0usize;

        // Walk `.notology/cas/blobs/{xx}/{yy}/{sha}` — the two-level shard.
        let blob_root = self.vault_root.join(".notology/cas/blobs");
        if blob_root.is_dir() {
            if let Ok(level1) = std::fs::read_dir(&blob_root) {
                for l1 in level1.flatten() {
                    let l1_path = l1.path();
                    if !l1_path.is_dir() {
                        continue;
                    }
                    if let Ok(level2) = std::fs::read_dir(&l1_path) {
                        for l2 in level2.flatten() {
                            let l2_path = l2.path();
                            if !l2_path.is_dir() {
                                continue;
                            }
                            if let Ok(files) = std::fs::read_dir(&l2_path) {
                                for f in files.flatten() {
                                    let fp = f.path();
                                    if !fp.is_file() {
                                        continue;
                                    }
                                    let sha = fp
                                        .file_name()
                                        .and_then(|s| s.to_str())
                                        .unwrap_or("");
                                    if sha.is_empty() {
                                        continue;
                                    }
                                    if !valid_shas.contains(sha) {
                                        match std::fs::remove_file(&fp) {
                                            Ok(()) => {
                                                blobs_removed += 1;
                                                log::info!(
                                                    "[attachment_store::sweep_orphans] removed orphan blob {}",
                                                    sha
                                                );
                                            }
                                            Err(e) => log::warn!(
                                                "[attachment_store::sweep_orphans] could not remove blob {}: {} (likely file lock; will retry next sweep)",
                                                sha, e
                                            ),
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        // Walk `.attachments/` — flat directory, one file per display path.
        let display_root = self.display_dir();
        if display_root.is_dir() {
            if let Ok(entries) = std::fs::read_dir(&display_root) {
                for entry in entries.flatten() {
                    let p = entry.path();
                    if !p.is_file() {
                        continue;
                    }
                    let name = p.file_name().and_then(|s| s.to_str()).unwrap_or("");
                    if name.is_empty() {
                        continue;
                    }
                    if !valid_displays.contains(name) {
                        match std::fs::remove_file(&p) {
                            Ok(()) => {
                                displays_removed += 1;
                                log::info!(
                                    "[attachment_store::sweep_orphans] removed orphan display {}",
                                    name
                                );
                            }
                            Err(e) => log::warn!(
                                "[attachment_store::sweep_orphans] could not remove display {}: {} (likely file lock; will retry next sweep)",
                                name, e
                            ),
                        }
                    }
                }
            }
        }

        if blobs_removed + displays_removed > 0 {
            log::info!(
                "[attachment_store::sweep_orphans] swept {} blobs + {} displays",
                blobs_removed, displays_removed
            );
        }
        (blobs_removed, displays_removed)
    }

    /// Update sync metadata after a successful push. Called by `attachment_sync`.
    pub fn record_sync_etag(
        &mut self,
        attachment_id: &str,
        etag: String,
        remote_path: String,
    ) -> Result<(), String> {
        let r = self
            .refs_by_id
            .get_mut(attachment_id)
            .ok_or_else(|| format!("attachment_id {} not found", attachment_id))?;
        r.sync_etag = Some(etag);
        r.remote_path = Some(remote_path);
        let snapshot = r.clone();
        self.persist_ref(&snapshot)?;
        Ok(())
    }

    // === Internals ===

    fn persist_ref(&self, r: &AttachmentRef) -> Result<(), String> {
        let path = self.refs_dir().join(format!("{}.json", r.attachment_id));
        let json = serde_json::to_vec_pretty(r).map_err(|e| format!("serialize ref: {}", e))?;
        atomic_write_file(&path, &json)
    }

    fn write_index(&self) -> Result<(), String> {
        let mut id_to_ref_path = HashMap::new();
        for id in self.refs_by_id.keys() {
            id_to_ref_path.insert(id.clone(), format!("refs/{}.json", id));
        }
        let idx = IndexFile {
            schema_version: SCHEMA_VERSION,
            name_to_ids: self.name_to_ids.clone(),
            id_to_ref_path,
        };
        let bytes =
            serde_json::to_vec_pretty(&idx).map_err(|e| format!("serialize index: {}", e))?;
        atomic_write_file(&self.index_path(), &bytes)
    }

    fn next_monotonic_id(&mut self) -> String {
        let now = Utc::now().timestamp_millis();
        let chosen = if now > self.last_id_ms {
            now
        } else {
            self.last_id_ms + 1
        };
        self.last_id_ms = chosen;
        format_id_from_ms(chosen)
    }

    /// Choose a display filename. If `original_name` is unused, return it as-is.
    /// If it is used by a ref with the same sha, return it (hardlink already there).
    /// Otherwise, append `_1`, `_2`, ... before the extension.
    fn allocate_display_name(&self, original_name: &str, sha: &str) -> String {
        let display_path = self.display_dir().join(original_name);
        if !display_path.exists() {
            return original_name.to_string();
        }
        // If the existing display points at the same sha (e.g. user re-imports
        // the same file), reuse the name.
        if let Some(existing_ids) = self.name_to_ids.get(original_name) {
            for id in existing_ids {
                if let Some(existing) = self.refs_by_id.get(id) {
                    if existing.sha256 == sha {
                        return original_name.to_string();
                    }
                }
            }
        }
        let (stem, ext) = split_stem_ext(original_name);
        for n in 1.. {
            let candidate = if ext.is_empty() {
                format!("{}_{}", stem, n)
            } else {
                format!("{}_{}.{}", stem, n, ext)
            };
            if !self.display_dir().join(&candidate).exists() {
                return candidate;
            }
        }
        unreachable!()
    }
}

// === Free helpers ===

pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    h.finalize().iter().map(|b| format!("{:02x}", b)).collect()
}

/// Hardlink `src → dst`, falling back to copy on filesystems that don't support it
/// (cross-volume, FAT32, or unsupported). On copy fallback, logs a warning.
pub fn link_or_copy(src: &Path, dst: &Path) -> Result<LinkMethod, String> {
    if dst.exists() {
        // Caller asked to link onto an existing path. We treat this as success
        // (idempotent) — the most common case is the same blob already being
        // hardlinked from a previous import.
        return Ok(LinkMethod::Hardlink);
    }
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir display parent: {}", e))?;
    }
    match std::fs::hard_link(src, dst) {
        Ok(()) => Ok(LinkMethod::Hardlink),
        Err(e) => {
            log::warn!(
                "[attachment_store] hard_link failed ({}); falling back to copy: {:?} → {:?}",
                e, src, dst
            );
            std::fs::copy(src, dst).map_err(|e| format!("copy fallback: {}", e))?;
            Ok(LinkMethod::Copy)
        }
    }
}

fn split_stem_ext(name: &str) -> (String, String) {
    let p = Path::new(name);
    let stem = p
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(name)
        .to_string();
    let ext = p
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();
    (stem, ext)
}

fn display_basename(display_path: &str) -> String {
    Path::new(display_path)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(display_path)
        .to_string()
}

fn format_id_from_ms(ms: i64) -> String {
    // YYYYMMDDhhmmss (14 digits) — the trailing ms are folded by saturation at the
    // last_id_ms guard, so two imports in the same second still yield distinct ids.
    let dt = chrono::DateTime::<Utc>::from_timestamp_millis(ms).unwrap_or_else(Utc::now);
    dt.format("%Y%m%d%H%M%S").to_string()
}

fn parse_id_to_ms(id: &str) -> Option<i64> {
    let dt = chrono::NaiveDateTime::parse_from_str(id, "%Y%m%d%H%M%S").ok()?;
    Some(dt.and_utc().timestamp_millis())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn mk_store() -> (TempDir, AttachmentStore) {
        let tmp = TempDir::new().unwrap();
        let store = AttachmentStore::new(tmp.path().to_path_buf()).unwrap();
        (tmp, store)
    }

    fn write_source(dir: &Path, name: &str, content: &[u8]) -> PathBuf {
        let p = dir.join(name);
        std::fs::write(&p, content).unwrap();
        p
    }

    #[test]
    fn new_store_creates_directories() {
        let (tmp, _store) = mk_store();
        assert!(tmp.path().join(".attachments").is_dir());
        assert!(tmp.path().join(".notology/cas/blobs").is_dir());
        assert!(tmp.path().join(".notology/attachments/refs").is_dir());
    }

    #[test]
    fn add_attachment_creates_blob_and_ref() {
        let (tmp, mut store) = mk_store();
        let src = write_source(tmp.path(), "Report.pdf", b"fake pdf data");
        let out = store
            .add_attachment(&src, "Report.pdf", "20260512111111")
            .unwrap();
        assert!(!out.was_deduped);
        assert_eq!(out.attachment_ref.original_name, "Report.pdf");
        assert!(out.attachment_ref.sha256.len() == 64);
        // CAS blob exists
        assert!(store
            .cas_path(&out.attachment_ref.sha256)
            .is_file());
        // Display hardlink exists
        assert!(tmp.path().join(".attachments/Report.pdf").exists());
        // Ref JSON exists
        assert!(tmp
            .path()
            .join(".notology/attachments/refs")
            .join(format!("{}.json", out.attachment_ref.attachment_id))
            .is_file());
    }

    #[test]
    fn add_duplicate_sha_dedups() {
        let (tmp, mut store) = mk_store();
        let src = write_source(tmp.path(), "a.pdf", b"identical bytes");
        let out1 = store.add_attachment(&src, "a.pdf", "n1").unwrap();
        let src2 = write_source(tmp.path(), "b.pdf", b"identical bytes");
        let out2 = store.add_attachment(&src2, "b.pdf", "n2").unwrap();
        assert!(!out1.was_deduped);
        assert!(out2.was_deduped);
        assert_eq!(out1.attachment_ref.sha256, out2.attachment_ref.sha256);
        // Two distinct refs
        assert_ne!(
            out1.attachment_ref.attachment_id,
            out2.attachment_ref.attachment_id
        );
        // One CAS blob
        let cas_path = store.cas_path(&out1.attachment_ref.sha256);
        assert!(cas_path.is_file());
    }

    /// PART 6 stabilization (HanBin 2026-05-13): cross-note dedup.
    /// Same content + same name dropped to a SECOND note must reuse the
    /// existing ref and just append the new note_id to `linked_notes`,
    /// instead of producing a duplicate ref.
    #[test]
    fn add_same_content_same_name_different_note_appends_linked_note() {
        let (tmp, mut store) = mk_store();
        let src = write_source(tmp.path(), "logo.png", b"\x89PNG fake");
        let out1 = store.add_attachment(&src, "logo.png", "noteA").unwrap();
        assert!(!out1.was_deduped);
        let out2 = store.add_attachment(&src, "logo.png", "noteB").unwrap();
        assert!(out2.was_deduped);
        // Same ref id, different linked_notes.
        assert_eq!(out1.attachment_ref.attachment_id, out2.attachment_ref.attachment_id);
        let r = store.get_by_id(&out1.attachment_ref.attachment_id).unwrap();
        assert!(r.linked_notes.contains(&"noteA".to_string()));
        assert!(r.linked_notes.contains(&"noteB".to_string()));
        assert_eq!(r.linked_notes.len(), 2);
        // One CAS blob, one display hardlink — no duplication anywhere.
        let cas_path = store.cas_path(&r.sha256);
        assert!(cas_path.is_file());
        assert!(tmp.path().join(".attachments/logo.png").exists());
        assert!(!tmp.path().join(".attachments/logo_1.png").exists());
    }

    /// PART 6 stabilization (HanBin 2026-05-13): renamed-copy regression.
    /// Same content with a DIFFERENT name dropped to the same note must
    /// produce a fresh ref so the optimistic wikilink chip (which carries
    /// the new name) resolves. Previously smart-dedup matched on
    /// (sha, note_id) only and returned the old-name ref → chip orphan ✕.
    #[test]
    fn add_same_content_different_name_same_note_creates_fresh_ref() {
        let (tmp, mut store) = mk_store();
        let src1 = write_source(tmp.path(), "Video 24.m4a", b"identical bytes");
        let out1 = store.add_attachment(&src1, "Video 24.m4a", "noteA").unwrap();
        let src2 = write_source(tmp.path(), "Video 24_copy.m4a", b"identical bytes");
        let out2 = store
            .add_attachment(&src2, "Video 24_copy.m4a", "noteA")
            .unwrap();
        // Two distinct refs — wikilink lookup by name MUST find each.
        assert_ne!(
            out1.attachment_ref.attachment_id,
            out2.attachment_ref.attachment_id
        );
        assert_eq!(out1.attachment_ref.original_name, "Video 24.m4a");
        assert_eq!(out2.attachment_ref.original_name, "Video 24_copy.m4a");
        // CAS blob is shared (one physical file).
        assert_eq!(out1.attachment_ref.sha256, out2.attachment_ref.sha256);
        assert!(out2.was_deduped); // blob dedup, not ref dedup
        // Both display hardlinks exist with distinct paths.
        assert!(tmp.path().join(".attachments/Video 24.m4a").exists());
        assert!(tmp.path().join(".attachments/Video 24_copy.m4a").exists());
    }

    /// PART 6 hardening (HanBin 2026-05-13): orphan-blob + orphan-display
    /// sweep. Files left behind by a Windows-locked delete must get
    /// reclaimed by the next vault-open / periodic sweep.
    #[test]
    fn sweep_orphans_removes_unreferenced_blob_and_display() {
        let (tmp, mut store) = mk_store();
        // Plant an unreferenced CAS blob.
        let orphan_sha = "deadbeef".repeat(8);
        let blob_path = store.cas_path(&orphan_sha);
        std::fs::create_dir_all(blob_path.parent().unwrap()).unwrap();
        std::fs::write(&blob_path, b"junk").unwrap();
        // Plant an unreferenced display file.
        std::fs::create_dir_all(store.display_dir()).unwrap();
        let stray_display = store.display_dir().join("stray.bin");
        std::fs::write(&stray_display, b"junk").unwrap();
        // Plant a legitimate attachment so we can assert it survives.
        let src = write_source(tmp.path(), "keep.pdf", b"keep me");
        let out = store.add_attachment(&src, "keep.pdf", "n1").unwrap();
        let kept_blob = store.cas_path(&out.attachment_ref.sha256);

        let (blobs, displays) = store.sweep_orphans();
        assert_eq!(blobs, 1);
        assert_eq!(displays, 1);
        // Orphans gone.
        assert!(!blob_path.exists());
        assert!(!stray_display.exists());
        // Legitimate ones survived.
        assert!(kept_blob.is_file());
        assert!(tmp.path().join(".attachments/keep.pdf").exists());
    }

    /// Re-drop of the EXACT same (sha, name, note) tuple is a no-op:
    /// returns the existing ref without touching `linked_notes`.
    #[test]
    fn add_identical_redrop_returns_existing_ref_unchanged() {
        let (tmp, mut store) = mk_store();
        let src = write_source(tmp.path(), "doc.pdf", b"data");
        let out1 = store.add_attachment(&src, "doc.pdf", "noteA").unwrap();
        let out2 = store.add_attachment(&src, "doc.pdf", "noteA").unwrap();
        assert_eq!(out1.attachment_ref.attachment_id, out2.attachment_ref.attachment_id);
        assert!(out2.was_deduped);
        let r = store.get_by_id(&out1.attachment_ref.attachment_id).unwrap();
        assert_eq!(r.linked_notes, vec!["noteA".to_string()]); // not duplicated
    }

    #[test]
    fn add_name_collision_auto_suffix() {
        let (tmp, mut store) = mk_store();
        let src1 = write_source(tmp.path(), "Report.pdf", b"version A");
        let src2 = tmp.path().join("subdir/Report.pdf");
        std::fs::create_dir_all(src2.parent().unwrap()).unwrap();
        std::fs::write(&src2, b"version B").unwrap();
        let out1 = store.add_attachment(&src1, "Report.pdf", "n1").unwrap();
        let out2 = store.add_attachment(&src2, "Report.pdf", "n2").unwrap();
        assert_eq!(out1.attachment_ref.display_path, ".attachments/Report.pdf");
        assert_eq!(
            out2.attachment_ref.display_path,
            ".attachments/Report_1.pdf"
        );
        assert!(tmp.path().join(".attachments/Report.pdf").exists());
        assert!(tmp.path().join(".attachments/Report_1.pdf").exists());
    }

    #[test]
    fn delete_attachment_keeps_blob_if_linked() {
        let (tmp, mut store) = mk_store();
        let src1 = write_source(tmp.path(), "a.pdf", b"same");
        let src2 = write_source(tmp.path(), "b.pdf", b"same");
        let out1 = store.add_attachment(&src1, "a.pdf", "n1").unwrap();
        let out2 = store.add_attachment(&src2, "b.pdf", "n2").unwrap();
        let blob_path = store.cas_path(&out1.attachment_ref.sha256);
        assert!(blob_path.is_file());

        store
            .delete_attachment(&out1.attachment_ref.attachment_id)
            .unwrap();
        // Blob still there (out2 references it)
        assert!(blob_path.is_file());

        store
            .delete_attachment(&out2.attachment_ref.attachment_id)
            .unwrap();
        // Now orphan — blob removed
        assert!(!blob_path.is_file());
    }

    #[test]
    fn delete_attachment_removes_orphan_blob() {
        let (tmp, mut store) = mk_store();
        let src = write_source(tmp.path(), "x.pdf", b"unique");
        let out = store.add_attachment(&src, "x.pdf", "n1").unwrap();
        let blob_path = store.cas_path(&out.attachment_ref.sha256);
        store
            .delete_attachment(&out.attachment_ref.attachment_id)
            .unwrap();
        assert!(!blob_path.is_file());
        assert!(!tmp.path().join(".attachments/x.pdf").exists());
    }

    #[test]
    fn link_to_note_is_idempotent() {
        let (tmp, mut store) = mk_store();
        let src = write_source(tmp.path(), "y.pdf", b"q");
        let out = store.add_attachment(&src, "y.pdf", "n1").unwrap();
        store
            .link_to_note(&out.attachment_ref.attachment_id, "n2")
            .unwrap();
        store
            .link_to_note(&out.attachment_ref.attachment_id, "n2")
            .unwrap();
        let r = store.get_by_id(&out.attachment_ref.attachment_id).unwrap();
        assert_eq!(r.linked_notes.len(), 2);
        store
            .unlink_from_note(&out.attachment_ref.attachment_id, "n2")
            .unwrap();
        let r = store.get_by_id(&out.attachment_ref.attachment_id).unwrap();
        assert_eq!(r.linked_notes.len(), 1);
    }

    #[test]
    fn resolve_wikilink_prefers_note_linked() {
        let (tmp, mut store) = mk_store();
        let src1 = write_source(tmp.path(), "shared.pdf", b"v1");
        let src2 = tmp.path().join("d/shared.pdf");
        std::fs::create_dir_all(src2.parent().unwrap()).unwrap();
        std::fs::write(&src2, b"v2").unwrap();
        let _o1 = store.add_attachment(&src1, "shared.pdf", "noteA").unwrap();
        let o2 = store.add_attachment(&src2, "shared.pdf", "noteB").unwrap();
        // Resolved as shared.pdf in noteB → should give the one suffixed (or original
        // depending on order). Either way the resolved ref must be linked to noteB.
        let resolved = store
            .resolve_wikilink(&display_basename(&o2.attachment_ref.display_path), "noteB")
            .unwrap();
        assert_eq!(resolved.attachment_id, o2.attachment_ref.attachment_id);
    }

    #[test]
    fn load_from_disk_rehydrates_state() {
        let (tmp, mut store) = mk_store();
        let src = write_source(tmp.path(), "p.pdf", b"hello");
        let out = store.add_attachment(&src, "p.pdf", "n1").unwrap();
        let saved_id = out.attachment_ref.attachment_id.clone();
        drop(store);

        let store2 = AttachmentStore::new(tmp.path().to_path_buf()).unwrap();
        let r = store2.get_by_id(&saved_id).unwrap();
        assert_eq!(r.original_name, "p.pdf");
        assert_eq!(r.linked_notes, vec!["n1".to_string()]);
    }

    #[test]
    fn reload_picks_up_refs_written_by_another_instance() {
        // Track B 2026-05-12 hotfix regression test. The background_worker holds
        // a long-lived AttachmentStore; the attachment_add command opens a fresh
        // short-lived store, writes a new ref, and drops it. Before the fix the
        // worker's cached store missed the new ref → "attachment_id not found"
        // after retries → entry dropped. After the fix, calling load_from_disk
        // again must surface the new ref.
        let tmp = TempDir::new().unwrap();

        // Worker-side long-lived store.
        let mut worker_store = AttachmentStore::new(tmp.path().to_path_buf()).unwrap();
        assert_eq!(worker_store.all_refs().count(), 0);

        // Command-side fresh store writes ref to disk.
        let src = write_source(tmp.path(), "late.pdf", b"late arrival");
        let added_id = {
            let mut cmd_store = AttachmentStore::new(tmp.path().to_path_buf()).unwrap();
            cmd_store
                .add_attachment(&src, "late.pdf", "n1")
                .unwrap()
                .attachment_ref
                .attachment_id
        };

        // Worker store still has zero entries in memory.
        assert!(worker_store.get_by_id(&added_id).is_none());

        // Reload should now surface the new ref.
        worker_store.load_from_disk().unwrap();
        assert!(
            worker_store.get_by_id(&added_id).is_some(),
            "reload must pick up refs written by another store instance"
        );
        assert_eq!(worker_store.all_refs().count(), 1);
    }

    #[test]
    fn reload_is_idempotent_without_duplicating_name_index() {
        let (tmp, mut store) = mk_store();
        let src = write_source(tmp.path(), "x.pdf", b"x");
        let out = store.add_attachment(&src, "x.pdf", "n1").unwrap();
        let id = out.attachment_ref.attachment_id.clone();

        // Call load_from_disk repeatedly — entries must not accumulate.
        store.load_from_disk().unwrap();
        store.load_from_disk().unwrap();
        store.load_from_disk().unwrap();
        assert_eq!(store.all_refs().count(), 1);
        assert_eq!(
            store.name_to_ids.get("x.pdf").map(|v| v.len()).unwrap_or(0),
            1,
            "name_to_ids must not accumulate duplicates across reloads"
        );
        // Sanity: ref still resolvable
        assert!(store.get_by_id(&id).is_some());
    }
}
