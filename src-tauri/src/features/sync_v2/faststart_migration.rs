//! Stage 4.6 — Faststart bulk migration for pre-existing video CAS blobs.
//!
//! Per `docs/architecture/STAGE_4_6_ATTACHMENT_MIGRATION_PLAN.md`:
//!
//! Stage 4.x integrated `mp4_faststart::apply_faststart` into
//! `attachment_add` for *new* attachments. Pre-existing mp4/mov/m4v files
//! that went through CAS storage before that integration remain in
//! moov-at-end format and trigger the seek bug — the browser must
//! download the entire file before any seek operation succeeds. This
//! module re-muxes them in place and updates the AttachmentRef sha.
//!
//! Algorithm:
//!   1. Walk all refs whose `tier == Video` (or extension matches mp4/mov/m4v).
//!   2. Probe each ref's CAS blob via `is_faststart()`. Skip if already faststart.
//!   3. `apply_faststart(blob, tmp)` — re-mux to a temp path.
//!   4. Compute sha256 of the re-muxed bytes (will differ from old — moov moved).
//!   5. Move tmp → CAS path of new sha.
//!   6. `AttachmentStore::swap_ref_sha(id, new_sha, new_size)` updates the
//!      ref in place + persists ref JSON + resets sync_etag (forces re-push).
//!   7. Old blob left in CAS — caller is expected to run `sweep_orphans()`
//!      after verifying the migration.
//!
//! Pre-requisites (verified in Stage 4.5):
//!   - 4.5.1 faststart determinism (63/63 sha256-matched outputs across 21
//!     fixtures × 3 runs) — guarantees that re-muxing doesn't introduce
//!     fingerprint variance across devices/runs.
//!   - 4.5.3 F-1 fix (17-digit attachment_id) — prevents silent ref
//!     overwrite when many swap_ref_sha calls happen in the same second.
//!   - 4.5.5 NFC normalization — preserves Korean filename identity
//!     across the migration boundary.
//!
//! Out of scope:
//!   - Wikilink rewrite — unnecessary because wikilinks reference
//!     `original_name`, not CAS sha. The ref indirection means the
//!     resolver picks up the new sha automatically.
//!   - NAS sync — `swap_ref_sha` resets `sync_etag = None`, which the
//!     existing push_worker / background_worker drains on the next
//!     polling tick. This module does not touch the sync engine.

#![allow(dead_code)]

use std::path::PathBuf;
use std::time::Instant;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::core::file_io::atomic_write_file;
use crate::core::mp4_faststart::{apply_faststart, is_faststart};
use crate::features::sync_v2::attachment_store::{sha256_hex, AttachmentStore};
use crate::features::sync_v2::attachment_types::{AttachmentRef, AttachmentTier};

const VIDEO_EXTS: &[&str] = &["mp4", "mov", "m4v"];

/// Read-only scan result. Used by the frontend prompt to show "X videos
/// will be converted" without committing to the run.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct FaststartReport {
    pub candidates: usize,
    pub total_videos: usize,
    pub estimated_disk_required: u64,
}

/// Final state after `run()`. Frontend reads `converted` + `failed.len()`
/// for the success summary.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct FaststartState {
    pub converted: usize,
    pub skipped_already_faststart: usize,
    pub failed: Vec<String>,
    pub backup_dir: Option<PathBuf>,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct FaststartJournalEntry {
    attachment_id: String,
    old_sha: String,
    new_sha: String,
    timestamp: DateTime<Utc>,
    status: EntryStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
enum EntryStatus {
    Converted,
    SkippedAlreadyFaststart,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct FaststartJournal {
    schema_version: u32,
    started_at: Option<DateTime<Utc>>,
    completed_at: Option<DateTime<Utc>>,
    entries: Vec<FaststartJournalEntry>,
}

pub struct FaststartMigration {
    vault_root: PathBuf,
    journal_path: PathBuf,
    decline_marker: PathBuf,
}

impl FaststartMigration {
    pub fn new(vault_root: PathBuf) -> Self {
        let journal_path = vault_root.join(".notology/attachments/faststart_journal.json");
        let decline_marker = vault_root.join(".notology/attachments/faststart_declined");
        Self {
            vault_root,
            journal_path,
            decline_marker,
        }
    }

    pub fn declined(&self) -> bool {
        self.decline_marker.is_file()
    }

    pub fn decline(&self) -> Result<(), String> {
        if let Some(parent) = self.decline_marker.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("mkdir decline: {e}"))?;
        }
        atomic_write_file(&self.decline_marker, b"declined")
    }

    /// Read-only scan: how many video refs need faststart conversion?
    /// Returns zero counts when the user previously declined.
    pub fn check_needed(&self) -> Result<FaststartReport, String> {
        if self.declined() {
            return Ok(FaststartReport::default());
        }
        if !self.vault_root.is_dir() {
            return Ok(FaststartReport::default());
        }
        let store = AttachmentStore::new(self.vault_root.clone())?;
        let mut report = FaststartReport::default();
        for r in store.all_refs() {
            if !is_video_ref(r) {
                continue;
            }
            report.total_videos += 1;
            let blob_path = store.cas_path(&r.sha256);
            if !blob_path.is_file() {
                continue;
            }
            match is_faststart(&blob_path) {
                Ok(true) => {} // already faststart — skip
                Ok(false) => {
                    report.candidates += 1;
                    report.estimated_disk_required += r.size_bytes;
                }
                Err(_) => { /* unparseable — skip silently */ }
            }
        }
        Ok(report)
    }

    /// Execute migration. `on_progress(done, total)` fires after each
    /// candidate is processed (success, skip, or failure). The caller
    /// is expected to bridge this to a Tauri event for UI live updates.
    pub fn run<F: FnMut(usize, usize)>(
        &mut self,
        mut on_progress: F,
    ) -> Result<FaststartState, String> {
        let t0 = Instant::now();
        let mut state = FaststartState::default();
        let mut store = AttachmentStore::new(self.vault_root.clone())?;

        let mut journal = FaststartJournal {
            schema_version: 1,
            started_at: Some(Utc::now()),
            ..Default::default()
        };

        // Backup ref JSONs (lightweight — blobs not copied; the original
        // moov-at-end blobs remain in CAS until sweep_orphans runs, so
        // ref-level rollback restores the pointers).
        let backup_root = self.vault_root.join(".notology/attachments.pre-faststart-migration");
        let backup_refs = backup_root.join("refs");
        std::fs::create_dir_all(&backup_refs).map_err(|e| format!("backup mkdir: {e}"))?;
        let refs_src = self.vault_root.join(".notology/attachments/refs");
        if refs_src.is_dir() {
            for entry in std::fs::read_dir(&refs_src).map_err(|e| format!("read refs: {e}"))? {
                let entry = entry.map_err(|e| format!("entry: {e}"))?;
                let dest = backup_refs.join(entry.file_name());
                std::fs::copy(entry.path(), dest).map_err(|e| format!("backup copy: {e}"))?;
            }
        }
        state.backup_dir = Some(backup_root);

        // Snapshot candidate ids upfront — `swap_ref_sha` mutates the
        // store, so we can't iterate `all_refs` while mutating.
        let candidate_ids: Vec<(String, String)> = store
            .all_refs()
            .filter(|r| is_video_ref(r))
            .map(|r| (r.attachment_id.clone(), r.sha256.clone()))
            .collect();
        let total = candidate_ids.len();
        on_progress(0, total);

        let tmp_dir = self.vault_root.join(".notology/attachments/faststart_tmp");
        std::fs::create_dir_all(&tmp_dir).map_err(|e| format!("tmp mkdir: {e}"))?;

        for (idx, (id, old_sha)) in candidate_ids.iter().enumerate() {
            match self.process_one(&mut store, id, old_sha, &tmp_dir) {
                Ok(EntryStatus::Converted) => {
                    state.converted += 1;
                    journal.entries.push(FaststartJournalEntry {
                        attachment_id: id.clone(),
                        old_sha: old_sha.clone(),
                        new_sha: store
                            .get_by_id(id)
                            .map(|r| r.sha256.clone())
                            .unwrap_or_default(),
                        timestamp: Utc::now(),
                        status: EntryStatus::Converted,
                    });
                }
                Ok(EntryStatus::SkippedAlreadyFaststart) => {
                    state.skipped_already_faststart += 1;
                    journal.entries.push(FaststartJournalEntry {
                        attachment_id: id.clone(),
                        old_sha: old_sha.clone(),
                        new_sha: old_sha.clone(),
                        timestamp: Utc::now(),
                        status: EntryStatus::SkippedAlreadyFaststart,
                    });
                }
                Ok(EntryStatus::Failed) | Err(_) => {
                    state.failed.push(id.clone());
                    journal.entries.push(FaststartJournalEntry {
                        attachment_id: id.clone(),
                        old_sha: old_sha.clone(),
                        new_sha: String::new(),
                        timestamp: Utc::now(),
                        status: EntryStatus::Failed,
                    });
                }
            }
            on_progress(idx + 1, total);
        }

        // Best-effort tmp dir cleanup
        let _ = std::fs::remove_dir_all(&tmp_dir);

        journal.completed_at = Some(Utc::now());
        let journal_bytes = serde_json::to_vec_pretty(&journal)
            .map_err(|e| format!("journal serialize: {e}"))?;
        atomic_write_file(&self.journal_path, &journal_bytes)?;

        state.duration_ms = t0.elapsed().as_millis() as u64;
        Ok(state)
    }

    /// Process a single ref: probe → re-mux → swap. Returns the
    /// resulting status. Internal errors map to `Failed` (entry-level
    /// failure shouldn't abort the entire migration).
    fn process_one(
        &self,
        store: &mut AttachmentStore,
        attachment_id: &str,
        old_sha: &str,
        tmp_dir: &std::path::Path,
    ) -> Result<EntryStatus, String> {
        let blob_path = store.cas_path(old_sha);
        if !blob_path.is_file() {
            return Ok(EntryStatus::Failed);
        }

        let already = match is_faststart(&blob_path) {
            Ok(b) => b,
            Err(_) => return Ok(EntryStatus::Failed),
        };
        if already {
            return Ok(EntryStatus::SkippedAlreadyFaststart);
        }

        let tmp_path = tmp_dir.join(format!("{}.tmp", attachment_id));
        if let Err(_e) = apply_faststart(&blob_path, &tmp_path) {
            let _ = std::fs::remove_file(&tmp_path);
            return Ok(EntryStatus::Failed);
        }

        let new_bytes = match std::fs::read(&tmp_path) {
            Ok(b) => b,
            Err(_) => {
                let _ = std::fs::remove_file(&tmp_path);
                return Ok(EntryStatus::Failed);
            }
        };
        let new_sha = sha256_hex(&new_bytes);
        let new_size = new_bytes.len() as u64;

        // Move tmp → CAS path of new sha
        let new_blob_path = store.cas_path(&new_sha);
        if let Some(parent) = new_blob_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("new blob mkdir: {e}"))?;
        }
        // Use rename first (fast same-volume), copy fallback if rename fails.
        if std::fs::rename(&tmp_path, &new_blob_path).is_err() {
            if std::fs::copy(&tmp_path, &new_blob_path).is_err() {
                let _ = std::fs::remove_file(&tmp_path);
                return Ok(EntryStatus::Failed);
            }
            let _ = std::fs::remove_file(&tmp_path);
        }

        // Swap ref sha in store
        if store
            .swap_ref_sha(attachment_id, new_sha, Some(new_size))
            .is_err()
        {
            return Ok(EntryStatus::Failed);
        }
        Ok(EntryStatus::Converted)
    }
}

fn is_video_ref(r: &AttachmentRef) -> bool {
    if matches!(r.tier, AttachmentTier::Video) {
        return true;
    }
    if r.mime_type.starts_with("video/") {
        return true;
    }
    if let Some(ext) = std::path::Path::new(&r.original_name)
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_lowercase())
    {
        return VIDEO_EXTS.iter().any(|&v| v == ext);
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::TempDir;

    /// Build a synthetic non-faststart MP4 (mirror of the
    /// mp4_faststart::tests::make_synthetic_mp4 structure).
    /// Layout: ftyp + mdat(payload) + moov(stco × 1).
    fn write_non_faststart_mp4(path: &std::path::Path) {
        let mut f = std::fs::File::create(path).unwrap();
        // ftyp 24 bytes
        f.write_all(&24u32.to_be_bytes()).unwrap();
        f.write_all(b"ftyp").unwrap();
        f.write_all(b"isom\x00\x00\x00\x00mp42avc1").unwrap();
        // mdat 24 bytes (16-byte payload)
        f.write_all(&24u32.to_be_bytes()).unwrap();
        f.write_all(b"mdat").unwrap();
        f.write_all(&[0xAAu8; 16]).unwrap();
        // moov 60 bytes (trak > mdia > minf > stbl > stco × 1)
        f.write_all(&60u32.to_be_bytes()).unwrap();
        f.write_all(b"moov").unwrap();
        f.write_all(&52u32.to_be_bytes()).unwrap();
        f.write_all(b"trak").unwrap();
        f.write_all(&44u32.to_be_bytes()).unwrap();
        f.write_all(b"mdia").unwrap();
        f.write_all(&36u32.to_be_bytes()).unwrap();
        f.write_all(b"minf").unwrap();
        f.write_all(&28u32.to_be_bytes()).unwrap();
        f.write_all(b"stbl").unwrap();
        f.write_all(&20u32.to_be_bytes()).unwrap();
        f.write_all(b"stco").unwrap();
        f.write_all(&0u32.to_be_bytes()).unwrap(); // version+flags
        f.write_all(&1u32.to_be_bytes()).unwrap(); // entry count
        f.write_all(&56u32.to_be_bytes()).unwrap(); // single offset
        f.sync_all().unwrap();
    }

    fn mk_vault() -> TempDir {
        let tmp = TempDir::new().unwrap();
        let mut store = AttachmentStore::new(tmp.path().to_path_buf()).unwrap();
        // Seed one non-faststart mp4 attachment
        let src = tmp.path().join("video1.mp4");
        write_non_faststart_mp4(&src);
        store.add_attachment(&src, "video1.mp4", "noteA").unwrap();
        // Seed one already-faststart mp4 (use the same fixture but pre-converted)
        let src2 = tmp.path().join("video2.mp4");
        let src2_pre = tmp.path().join("video2_pre.mp4");
        write_non_faststart_mp4(&src2_pre);
        apply_faststart(&src2_pre, &src2).unwrap();
        store.add_attachment(&src2, "video2.mp4", "noteB").unwrap();
        // Seed a non-video file to verify is_video_ref filtering
        let src3 = tmp.path().join("doc.pdf");
        std::fs::write(&src3, b"PDF content").unwrap();
        store.add_attachment(&src3, "doc.pdf", "noteC").unwrap();
        tmp
    }

    #[test]
    fn check_needed_counts_only_non_faststart_videos() {
        let tmp = mk_vault();
        let mig = FaststartMigration::new(tmp.path().to_path_buf());
        let report = mig.check_needed().unwrap();
        // 2 video refs total, 1 already-faststart (skipped), 1 needs conversion
        assert_eq!(report.total_videos, 2);
        assert_eq!(report.candidates, 1);
        assert!(report.estimated_disk_required > 0);
    }

    #[test]
    fn run_converts_non_faststart_and_skips_others() {
        let tmp = mk_vault();
        let mut mig = FaststartMigration::new(tmp.path().to_path_buf());
        let mut progress_calls = 0;
        let state = mig
            .run(|done, total| {
                progress_calls += 1;
                assert!(done <= total);
                assert_eq!(total, 2);
            })
            .unwrap();
        assert_eq!(state.converted, 1, "exactly one ref needed conversion");
        assert_eq!(state.skipped_already_faststart, 1);
        assert!(state.failed.is_empty(), "no failures expected: {:?}", state.failed);
        assert!(state.backup_dir.is_some());
        // Progress callback fires for initial 0/total + each entry
        assert!(progress_calls >= 3);

        // Re-run is a no-op: every video is now faststart
        let report2 = mig.check_needed().unwrap();
        assert_eq!(report2.candidates, 0);
    }

    #[test]
    fn declined_short_circuits_check_needed() {
        let tmp = mk_vault();
        let mig = FaststartMigration::new(tmp.path().to_path_buf());
        mig.decline().unwrap();
        let report = mig.check_needed().unwrap();
        assert_eq!(report.candidates, 0);
        assert_eq!(report.total_videos, 0);
        assert!(mig.declined());
    }

    #[test]
    fn run_writes_journal_with_per_entry_status() {
        let tmp = mk_vault();
        let mut mig = FaststartMigration::new(tmp.path().to_path_buf());
        mig.run(|_, _| {}).unwrap();
        let journal_bytes = std::fs::read(&mig.journal_path).unwrap();
        let journal: FaststartJournal = serde_json::from_slice(&journal_bytes).unwrap();
        assert_eq!(journal.schema_version, 1);
        assert!(journal.started_at.is_some());
        assert!(journal.completed_at.is_some());
        assert_eq!(journal.entries.len(), 2); // 2 video refs
        let converted = journal
            .entries
            .iter()
            .filter(|e| e.status == EntryStatus::Converted)
            .count();
        let skipped = journal
            .entries
            .iter()
            .filter(|e| e.status == EntryStatus::SkippedAlreadyFaststart)
            .count();
        assert_eq!(converted, 1);
        assert_eq!(skipped, 1);
    }
}
