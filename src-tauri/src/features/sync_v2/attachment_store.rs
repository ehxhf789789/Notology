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
use unicode_normalization::UnicodeNormalization;

use crate::core::file_io::atomic_write_file;
use crate::features::sync_v2::attachment_types::{
    AttachmentBlob, AttachmentRef, AttachmentTier, ResolvedAttachment,
};

/// Stage 4.5.5 normalization helper. Every `original_name` and wikilink
/// query passes through this before equality comparison so macOS-typed NFD
/// names and Windows-typed NFC names converge. NFC is the chosen canonical
/// form (W3C charmod-norm recommendation, Windows default).
#[inline]
fn nfc(s: &str) -> String {
    s.nfc().collect()
}

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

/// Stage 4.5.5 back-fill report.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct NfcMigrationOutcome {
    pub total: usize,
    pub normalized: usize,
}

pub struct AttachmentStore {
    vault_root: PathBuf,
    refs_by_id: HashMap<String, AttachmentRef>,
    name_to_ids: HashMap<String, Vec<String>>,
    blobs_by_sha: HashMap<String, AttachmentBlob>,
    last_id_ms: i64,
}

impl AttachmentStore {
    /// Vault root path. Exposed for sibling modules (e.g.
    /// `attachment_reconcile`) that need to walk note bodies.
    pub fn vault_root(&self) -> &std::path::Path {
        &self.vault_root
    }

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
        // Stage 4.5.5 back-fill: any pre-existing ref written before NFC
        // normalization landed gets upgraded in place. Idempotent — re-runs
        // on already-normalized stores find nothing to change and return
        // `normalized = 0` so it's safe to keep in the constructor.
        let outcome = s.migrate_normalize_original_names()?;
        if outcome.normalized > 0 {
            log::info!(
                "attachment_store NFC back-fill: {} of {} refs normalized",
                outcome.normalized,
                outcome.total
            );
        }
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

    pub(crate) fn cas_path(&self, sha: &str) -> PathBuf {
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
        // Stage 4.5.5: NFC-normalize at the boundary so the rest of the
        // function operates in canonical form. All comparisons against
        // `original_name` further down (and against `name_to_ids` keys,
        // which are populated from the same source) become form-invariant.
        let original_name_owned = nfc(original_name);
        let original_name = original_name_owned.as_str();

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
        // Stage 4.5.3 F-2 fix (HanBin 2026-05-14): index.json is dead code.
        // `load_from_disk` walks `refs/*.json` directly and rebuilds
        // `name_to_ids` + `blobs_by_sha`; nothing reads `index.json`. The
        // O(N) per-call rewrite was an O(N²) seeding bottleneck (4.5.3 F-2,
        // 4.5.2 F-2-soak: 1.91× wall growth at 1500 refs). Removing the
        // call drops add_attachment from ~17 ms to ~5 ms at 1500 refs and
        // eliminates the O(N²) seeding cost entirely.

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

        // Stage 4.5.3 F-2 fix: `write_index()` removed (index.json is dead).
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
        // Stage 4.5.5: NFC-normalize the query so a Windows-typed wikilink
        // matches a macOS-ingested NFD original_name (and vice versa). Refs
        // are stored in NFC form post-Stage 4.5.5; the back-fill migration
        // in `migrate_normalize_original_names` upgrades pre-existing data.
        let name_owned = nfc(name);
        let name = name_owned.as_str();

        // Stage 4.5.3 F-3 fix (HanBin 2026-05-14): O(1) primary path via
        // `name_to_ids` HashMap. The previous implementation linear-scanned
        // every ref on every wikilink resolution — at 50K refs the cost
        // grew to ~8 ms per lookup (4.5.3 Class D scaling), which would
        // dominate render time for note bodies with many wikilink chips.
        // The HashMap was already maintained for `add_attachment` /
        // `delete_attachment` / `migrate_normalize_original_names` — it
        // just wasn't used at the lookup boundary.
        //
        // Two-tier strategy:
        //   1. Primary: `name_to_ids[name]` → O(1) hashmap hit + O(refs-with-name)
        //      candidate filter (typically 1-2 refs per name even at scale).
        //   2. Fallback: linear scan for `display_basename` matches — only
        //      reached when the user wikilinks a collision-suffixed display
        //      name like `[[doc_1.pdf]]` (rare in practice, but the
        //      production semantic is preserved exactly).
        let mut candidates: Vec<&AttachmentRef> = self
            .name_to_ids
            .get(name)
            .map(|ids| {
                ids.iter()
                    .filter_map(|id| self.refs_by_id.get(id))
                    .collect()
            })
            .unwrap_or_default();

        if candidates.is_empty() {
            // Fallback: collision-suffixed display name. Linear scan is
            // unavoidable here without a second display→ids index, and
            // this branch is empirically rare (only fires when the user
            // wikilinks a `_N`-suffixed collision name explicitly).
            candidates = self
                .refs_by_id
                .values()
                .filter(|r| display_basename(&r.display_path) == name)
                .collect();
        }

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

    /// Stage 4.5.5 back-fill: normalize every persisted ref's
    /// `original_name` to NFC. Idempotent — fixtures that are already NFC
    /// are touched zero times. Reason: pre-Stage-4.5.5 macOS-ingested refs
    /// may carry NFD names that no longer match Windows-typed wikilink
    /// queries after the lookup-side NFC fix landed.
    ///
    /// Invariants enforced:
    /// 1. **Zero data loss**: only `original_name` is rewritten; `sha256`,
    ///    `attachment_id`, `linked_notes`, `display_path`, etc. are
    ///    preserved byte-for-byte.
    /// 2. **Checksum verify**: `nfc(nfc(x)) == nfc(x)` is asserted before
    ///    swap. The swap then writes the new ref through `persist_ref`
    ///    (atomic_write_file) so a crash leaves either old or new on disk.
    /// 3. **Idempotent**: re-running yields `normalized = 0` because the
    ///    normalized form is fixed under further NFC application.
    /// 4. **Index rebuilt**: `name_to_ids` is regenerated from the
    ///    post-normalization refs and re-persisted via `write_index`.
    pub fn migrate_normalize_original_names(
        &mut self,
    ) -> Result<NfcMigrationOutcome, String> {
        let total = self.refs_by_id.len();
        let mut normalized = 0usize;

        let ids_to_update: Vec<String> = self
            .refs_by_id
            .iter()
            .filter_map(|(id, r)| {
                let canon = nfc(&r.original_name);
                if canon != r.original_name {
                    Some(id.clone())
                } else {
                    None
                }
            })
            .collect();

        for id in &ids_to_update {
            let r = self
                .refs_by_id
                .get_mut(id)
                .ok_or_else(|| format!("ref {} vanished mid-migration", id))?;
            let canon = nfc(&r.original_name);
            // Invariant 2: idempotency check.
            debug_assert_eq!(canon, nfc(&canon), "NFC must be a fixed point");
            r.original_name = canon;
            let snapshot = r.clone();
            self.persist_ref(&snapshot)?;
            normalized += 1;
        }

        if normalized > 0 {
            // Invariant 4: rebuild the name-keyed in-memory index from
            // scratch so it matches the new on-disk truth. Stage 4.5.3 F-2
            // fix: `write_index()` removed (index.json is dead code; the
            // ref JSONs are the only persisted source of truth and were
            // updated above via `persist_ref`).
            self.name_to_ids.clear();
            for (id, r) in &self.refs_by_id {
                self.name_to_ids
                    .entry(r.original_name.clone())
                    .or_default()
                    .push(id.clone());
            }
        }

        Ok(NfcMigrationOutcome { total, normalized })
    }

    // === Internals ===

    fn persist_ref(&self, r: &AttachmentRef) -> Result<(), String> {
        let path = self.refs_dir().join(format!("{}.json", r.attachment_id));
        let json = serde_json::to_vec_pretty(r).map_err(|e| format!("serialize ref: {}", e))?;
        atomic_write_file(&path, &json)
    }

    /// **Stage 4.5.3 F-2 fix (HanBin 2026-05-14): no longer called.**
    ///
    /// `index.json` was originally intended as a name→id lookup index,
    /// but `load_from_disk` walks `refs/*.json` directly and rebuilds
    /// the in-memory `name_to_ids` map from scratch — `index.json` is
    /// never read anywhere. The per-call rewrite was an O(refs) cost
    /// and the source of the O(N²) seeding bottleneck observed in
    /// 4.5.3 F-2 (1500-ref store, 17 ms/add) and 4.5.2 F-2-soak
    /// (1.91× wall growth over 30 epochs).
    ///
    /// The function is retained behind `#[allow(dead_code)]` so a future
    /// caller (e.g. an external debug tool, or a vault-export utility)
    /// can opt back in without re-deriving the schema. Existing
    /// `index.json` files in the field are left in place as legacy
    /// artifacts; new stores no longer write them.
    #[allow(dead_code)]
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
    // YYYYMMDDhhmmssNNN (17 digits, second + 3-digit ms).
    //
    // Stage 4.5.3 audit (HanBin 2026-05-14): the previous 14-digit
    // second-precision format collided silently when add_attachment was
    // called multiple times within the same second — the `last_id_ms`
    // guard advanced ms-by-ms but the format truncated to seconds, so
    // refs_by_id.insert() overwrote the prior ref. Bulk migration paths
    // (Stage 4.6 W2) and sync batch imports could lose attachments
    // without surfacing an error. Extending to ms precision restores the
    // intended monotonic-distinct-id invariant.
    let dt = chrono::DateTime::<Utc>::from_timestamp_millis(ms).unwrap_or_else(Utc::now);
    dt.format("%Y%m%d%H%M%S%3f").to_string()
}

fn parse_id_to_ms(id: &str) -> Option<i64> {
    // Stage 4.5.3: 17-digit format is current; 14-digit is legacy and
    // still parses for refs that were written before the format extension
    // landed.
    if id.len() == 17 {
        let dt = chrono::NaiveDateTime::parse_from_str(id, "%Y%m%d%H%M%S%3f").ok()?;
        return Some(dt.and_utc().timestamp_millis());
    }
    if id.len() == 14 {
        let dt = chrono::NaiveDateTime::parse_from_str(id, "%Y%m%d%H%M%S").ok()?;
        return Some(dt.and_utc().timestamp_millis());
    }
    None
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

    // === Stage 4.5.5 NFC normalization tests ===

    /// Helper: Korean "한글" in NFD (jamo-decomposed). The NFC form is
    /// `"한글"` (2 codepoints, 6 bytes); NFD is 6 codepoints (12 bytes).
    fn nfd_hangul() -> String {
        "한글".nfd().collect()
    }

    #[test]
    fn add_attachment_stores_original_name_in_nfc() {
        let (tmp, mut store) = mk_store();
        let nfd_name = format!("{}.md", nfd_hangul());
        let src = write_source(tmp.path(), "src_for_nfc.bin", b"hello");
        let out = store.add_attachment(&src, &nfd_name, "noteA").unwrap();
        let stored = &out.attachment_ref.original_name;
        let canon: String = "한글.md".nfc().collect();
        assert_eq!(stored, &canon, "original_name must be NFC-normalized");
        // NFD input MUST resolve to the NFC-stored ref.
        let resolved = store.resolve_wikilink(&nfd_name, "noteA");
        assert!(
            resolved.is_some(),
            "NFD wikilink query must resolve NFC-stored ref"
        );
        // Drop unused vars to satisfy clippy.
        drop(tmp);
    }

    #[test]
    fn resolve_wikilink_matches_across_nfc_nfd() {
        let (tmp, mut store) = mk_store();
        // Ingest in NFC.
        let nfc_name = "한글.md".to_string();
        let src = write_source(tmp.path(), "src_cross.bin", b"x");
        store
            .add_attachment(&src, &nfc_name, "noteA")
            .unwrap();
        // Query in NFD — must still match.
        let nfd_name = format!("{}.md", nfd_hangul());
        assert!(
            store.resolve_wikilink(&nfd_name, "noteA").is_some(),
            "NFC store + NFD query must match"
        );
        // Query in NFC — must still match.
        assert!(
            store.resolve_wikilink(&nfc_name, "noteA").is_some(),
            "NFC store + NFC query must match"
        );
        drop(tmp);
    }

    #[test]
    fn migrate_normalize_back_fills_nfd_legacy_refs() {
        // Simulate a pre-Stage-4.5.5 store that wrote NFD original_names.
        // We bypass add_attachment and write a ref JSON straight to disk
        // with NFD bytes, then reload + migrate.
        let tmp = TempDir::new().unwrap();
        std::fs::create_dir_all(tmp.path().join(".notology/attachments/refs")).unwrap();

        let nfd_name = format!("{}.md", nfd_hangul());
        let canon: String = nfd_name.nfc().collect();
        assert_ne!(nfd_name, canon, "fixture must actually be NFD");

        let r = AttachmentRef {
            attachment_id: "20260514120000".into(),
            original_name: nfd_name.clone(),
            mime_type: "application/octet-stream".into(),
            size_bytes: 0,
            sha256: "deadbeef".into(),
            tier: AttachmentTier::Other,
            created_at: Utc::now(),
            linked_notes: vec!["noteA".into()],
            display_path: format!(".attachments/{}", nfd_name),
            sync_etag: None,
            remote_path: None,
        };
        let ref_path = tmp
            .path()
            .join(".notology/attachments/refs/20260514120000.json");
        std::fs::write(&ref_path, serde_json::to_vec_pretty(&r).unwrap()).unwrap();

        // AttachmentStore::new auto-runs the migration via the constructor.
        let store = AttachmentStore::new(tmp.path().to_path_buf()).unwrap();

        let loaded = store.get_by_id("20260514120000").unwrap();
        assert_eq!(
            loaded.original_name, canon,
            "back-fill must rewrite original_name to NFC"
        );
        // Other fields preserved byte-for-byte.
        assert_eq!(loaded.attachment_id, "20260514120000");
        assert_eq!(loaded.sha256, "deadbeef");
        assert_eq!(loaded.linked_notes, vec!["noteA".to_string()]);
    }

    /// Stage 4.5.3 F-3 fix (HanBin 2026-05-14): `resolve_wikilink` must
    /// hit the `name_to_ids` O(1) primary path on the common case
    /// (original_name match) and only fall back to linear scan for the
    /// rare collision-suffixed display name case. This test pins both
    /// branches:
    ///   - 100 distinct original_names → each resolves correctly via
    ///     primary path (no duplicate refs returned).
    ///   - A second add of same content+different note re-uses the same
    ///     ref via cross-note dedup; resolve still returns it.
    ///   - A collision (different sha, same name) creates `_1`-suffixed
    ///     display path; wikilink to `original_name` (primary path) AND
    ///     wikilink to `display_basename_1` (fallback path) both resolve.
    #[test]
    fn resolve_wikilink_O1_primary_with_fallback() {
        let (tmp, mut store) = mk_store();
        let src_dir = tmp.path().join("rw_src");
        std::fs::create_dir_all(&src_dir).unwrap();

        // Add 100 distinct refs.
        for i in 0..100 {
            let src = src_dir.join(format!("d_{:03}.bin", i));
            std::fs::write(&src, format!("d-{}", i).as_bytes()).unwrap();
            store.add_attachment(&src, &format!("d_{:03}.pdf", i), "noteX").unwrap();
        }
        // Each name resolves to exactly the right ref (primary path).
        for i in 0..100 {
            let name = format!("d_{:03}.pdf", i);
            let res = store.resolve_wikilink(&name, "noteX");
            assert!(res.is_some(), "primary-path resolve failed for {}", name);
        }

        // Collision: same name, different sha → suffixed display path.
        let src1 = src_dir.join("col_1.bin");
        let src2 = src_dir.join("col_2.bin");
        std::fs::write(&src1, b"first").unwrap();
        std::fs::write(&src2, b"second").unwrap();
        let o1 = store.add_attachment(&src1, "collision.pdf", "noteY").unwrap();
        let o2 = store.add_attachment(&src2, "collision.pdf", "noteY").unwrap();
        // o2 should have suffixed display_path (collision)
        assert!(
            o2.attachment_ref.display_path.ends_with("_1.pdf")
                || o2.attachment_ref.display_path != o1.attachment_ref.display_path,
            "collision should produce distinct display paths: {} vs {}",
            o1.attachment_ref.display_path,
            o2.attachment_ref.display_path
        );
        // Primary-path lookup by original_name returns ONE of them
        // (cross-note dedup picks first match in name_to_ids order).
        let primary = store.resolve_wikilink("collision.pdf", "noteY");
        assert!(primary.is_some(), "primary-path lookup of collision name must resolve");

        // Fallback: lookup by collision-suffixed display basename
        // (`collision_1.pdf`) MUST hit the linear scan branch and resolve.
        let display_2 = display_basename(&o2.attachment_ref.display_path).to_string();
        if display_2 != "collision.pdf" {
            // Confirm the fallback path actually works (only meaningful
            // if collision really produced a different display name).
            let fallback = store.resolve_wikilink(&display_2, "noteY");
            assert!(
                fallback.is_some(),
                "fallback resolve for display name {} failed",
                display_2
            );
        }
        drop(tmp);
    }

    /// Stage 4.5.3 F-2 fix (HanBin 2026-05-14): with `write_index()` no
    /// longer called from `add_attachment`/`delete_attachment`/migration,
    /// the only persisted source of truth is the per-ref JSON files in
    /// `.notology/attachments/refs/`. This test pins that:
    ///   1. Adding 50 attachments creates 50 ref JSONs.
    ///   2. `index.json` is NOT created (pre-fix it would have been
    ///      rewritten 50 times).
    ///   3. A fresh store opened on the same vault re-derives identical
    ///      in-memory state from the ref JSONs alone.
    #[test]
    fn add_attachment_does_not_write_index_json() {
        let (tmp, mut store) = mk_store();
        let src_dir = tmp.path().join("idx_src");
        std::fs::create_dir_all(&src_dir).unwrap();
        for i in 0..50 {
            let src = src_dir.join(format!("p_{:02}.bin", i));
            std::fs::write(&src, format!("payload-{}", i).as_bytes()).unwrap();
            store.add_attachment(&src, &format!("p_{:02}.bin", i), &format!("n_{}", i / 5))
                .unwrap();
        }
        let index_path = tmp.path().join(".notology/attachments/index.json");
        assert!(
            !index_path.exists(),
            "index.json must NOT be created (Stage 4.5.3 F-2 fix); found {:?}",
            index_path
        );
        // Reload from disk: same in-memory state.
        let mut store2 = AttachmentStore::new(tmp.path().to_path_buf()).unwrap();
        store2.load_from_disk().unwrap();
        assert_eq!(store2.all_refs().count(), 50);
        // name_to_ids reconstructed from ref JSONs.
        for i in 0..50 {
            let name = format!("p_{:02}.bin", i);
            assert!(
                store2.name_to_ids.contains_key(&name),
                "name_to_ids missing {} after reload",
                name
            );
        }
    }

    /// Stage 4.5.3 audit (HanBin 2026-05-14): verify next_monotonic_id
    /// produces distinct ids when add_attachment is called many times
    /// inside a single second. Pre-fix the format was 14-digit
    /// second-precision and 100 rapid adds collapsed to ~1-2 unique ids,
    /// silently overwriting refs in `refs_by_id` and losing data.
    #[test]
    fn rapid_add_produces_distinct_attachment_ids() {
        let (tmp, mut store) = mk_store();
        let src_dir = tmp.path().join("rapid_src");
        std::fs::create_dir_all(&src_dir).unwrap();
        let mut buf = vec![0u8; 256];
        let mut ids: std::collections::HashSet<String> = std::collections::HashSet::new();
        for i in 0..200 {
            buf[0] = (i & 0xff) as u8;
            buf[1] = ((i >> 8) & 0xff) as u8;
            let name = format!("rapid_{:04}.bin", i);
            let src = src_dir.join(&name);
            std::fs::write(&src, &buf).unwrap();
            let out = store.add_attachment(&src, &name, "n0").unwrap();
            ids.insert(out.attachment_ref.attachment_id);
        }
        assert_eq!(
            ids.len(),
            200,
            "200 rapid adds must produce 200 distinct ids (got {})",
            ids.len()
        );
        assert_eq!(
            store.all_refs().count(),
            200,
            "store must have 200 refs after 200 unique adds"
        );
    }

    #[test]
    fn parse_id_supports_both_14_and_17_digit_formats() {
        // 17-digit: current
        let id17 = format_id_from_ms(1_715_689_200_500);
        assert_eq!(id17.len(), 17, "format must produce 17 digits");
        assert!(parse_id_to_ms(&id17).is_some());
        // 14-digit: legacy
        let legacy = "20260514120000";
        assert_eq!(legacy.len(), 14);
        assert!(
            parse_id_to_ms(legacy).is_some(),
            "legacy 14-digit ids must still parse"
        );
        // Garbage rejected
        assert!(parse_id_to_ms("not-an-id").is_none());
        assert!(parse_id_to_ms("12345").is_none());
    }

    #[test]
    fn migrate_normalize_is_idempotent() {
        // Run the migration twice on a freshly-NFC store — second run must
        // report normalized = 0.
        let (tmp, mut store) = mk_store();
        let src = write_source(tmp.path(), "src_idem.bin", b"x");
        store
            .add_attachment(&src, "한글.md", "noteA")
            .unwrap();

        let first = store.migrate_normalize_original_names().unwrap();
        let second = store.migrate_normalize_original_names().unwrap();
        assert_eq!(
            second.normalized, 0,
            "second migration pass on NFC store must be a no-op"
        );
        assert_eq!(first.total, second.total);
        drop(tmp);
    }
}
