//! Library coordinator for the Notology version control layer.
//!
//! Coordinates CAS, Version DAG, and Refs as atomic operations.
//! Implements ordered writes (CAS -> DAG -> Ref) for crash safety.
//!
//! # Spec Deviations from STAGE_1_PLAN.md Section 2.5
//!
//! - Adds `new_with_device_id()`, `repair_note()`, `device_id()` methods
//! - Adds `RepairReport` data type
//! - Save flow order changed: .md write happens BEFORE library commit
//!   in Sub-Stage 1.5 (this module exposes `commit_version` for that flow)
//! - Limited automatic recovery in `get_head()`: only Case 1 (missing
//!   CAS object) and Case 3 (missing ref). Other cases require explicit
//!   `repair_note()`.
//! - `get_history()` returns full DAG including abandoned entries
//! - device_id format: `{hostname}-{8charhex}`, persisted to
//!   `.notology/device-id`

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use serde::{Serialize, Deserialize};

use crate::core::cas::CasStore;
use crate::core::version_dag::{VersionDag, VersionEntry};
use crate::core::refs::{RefStore, NoteRef};

/// Report from `repair_note()` detailing what corrective actions were taken.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RepairReport {
    /// The note that was repaired.
    pub note_id: String,
    /// Human-readable list of actions taken (for logging/UI).
    pub actions_taken: Vec<String>,
    /// The HEAD hash after repair, or None if note couldn't be resurrected.
    pub final_head_hash: Option<String>,
}

/// The Library coordinates CAS, Version DAG, and Refs as atomic units.
///
/// Layout: `{vault}/.notology/{objects,history,refs,device-id}/`
pub struct Library {
    vault_path: PathBuf,
    cas: Arc<CasStore>,
    refs: Arc<RefStore>,
    device_id: String,
}

impl Library {
    /// Initialize Library for a vault. Creates directory structure if needed.
    /// device_id is auto-generated (hostname + UUID, persisted on disk).
    pub fn new(vault_path: &Path) -> Result<Self, String> {
        let device_id = Self::resolve_device_id(vault_path)?;
        Self::new_with_device_id(vault_path, device_id)
    }

    /// Like `new()` but with explicit device_id (for testing).
    pub fn new_with_device_id(vault_path: &Path, device_id: String) -> Result<Self, String> {
        if !vault_path.is_dir() {
            return Err(format!("Library::new: vault path is not a directory: {:?}", vault_path));
        }
        let cas = Arc::new(CasStore::new(vault_path)
            .map_err(|e| format!("Library::new: failed to init CAS: {}", e))?);
        let refs = Arc::new(RefStore::new(vault_path)
            .map_err(|e| format!("Library::new: failed to init RefStore: {}", e))?);

        let history_dir = vault_path.join(".notology").join("history");
        fs::create_dir_all(&history_dir)
            .map_err(|e| format!("Library::new: failed to create history directory: {}", e))?;

        Ok(Self {
            vault_path: vault_path.to_path_buf(),
            cas,
            refs,
            device_id,
        })
    }

    /// Check whether Library directory structure exists at this vault.
    pub fn is_initialized(vault_path: &Path) -> bool {
        vault_path.join(".notology").join("objects").is_dir()
            && vault_path.join(".notology").join("history").is_dir()
            && vault_path.join(".notology").join("refs").is_dir()
    }

    /// Commit a new version of a note.
    ///
    /// Steps (ordered writes for crash safety):
    /// 1. Hash content; skip if unchanged from HEAD
    /// 2. Write CAS object (immutable, idempotent)
    /// 3. Append to DAG (parent = previous HEAD)
    /// 4. Update ref to new hash (commit point)
    ///
    /// Returns `Some(hash)` on new commit, `None` if content unchanged.
    pub fn commit_version(
        &self,
        note_id: &str,
        content: &[u8],
        relative_path: &str,
        attachment_hashes: Vec<String>,
    ) -> Result<Option<String>, String> {
        let new_hash = CasStore::hash(content);

        // Skip-if-unchanged
        let current_ref = self.refs.get(note_id)?;
        if current_ref.as_ref().map(|r| r.head_hash.as_str()) == Some(&new_hash) {
            return Ok(None);
        }

        // Step 2: CAS (immutable, idempotent)
        self.cas.write_object(content)
            .map_err(|e| format!("commit_version: CAS write failed: {}", e))?;

        // Step 3: DAG append
        let mut dag = VersionDag::load(&self.vault_path, note_id)
            .map_err(|e| format!("commit_version: DAG load failed: {}", e))?;
        let parent_hash = dag.latest().map(|v| v.content_hash.clone());
        dag.append(new_hash.clone(), parent_hash, self.device_id.clone(), attachment_hashes);
        dag.save(&self.vault_path, note_id)
            .map_err(|e| format!("commit_version: DAG save failed: {}", e))?;

        // Step 4: Ref update (commit point)
        let prev_etag = current_ref.and_then(|r| r.sync_etag);
        let new_ref = NoteRef {
            note_id: note_id.to_string(),
            head_hash: new_hash.clone(),
            relative_path: relative_path.to_string(),
            updated_at: chrono::Utc::now(),
            sync_etag: prev_etag,
        };
        self.refs.set(&new_ref)
            .map_err(|e| format!("commit_version: ref update failed: {}", e))?;

        Ok(Some(new_hash))
    }

    /// Get current HEAD hash for a note.
    ///
    /// Performs limited automatic recovery:
    /// - Case 1: ref exists but CAS object missing -> fallback to DAG latest valid
    /// - Case 3: ref missing but DAG exists -> create ref from DAG latest
    pub fn get_head(&self, note_id: &str) -> Result<Option<String>, String> {
        let ref_opt = self.refs.get(note_id)?;

        match ref_opt {
            Some(note_ref) => {
                if self.cas.has_object(&note_ref.head_hash) {
                    return Ok(Some(note_ref.head_hash));
                }
                // Case 1: ref -> missing object. Scan DAG for valid entry.
                let dag = VersionDag::load(&self.vault_path, note_id)?;
                for entry in dag.versions.iter().rev() {
                    if self.cas.has_object(&entry.content_hash) {
                        let updated = NoteRef {
                            head_hash: entry.content_hash.clone(),
                            updated_at: chrono::Utc::now(),
                            ..note_ref
                        };
                        self.refs.set(&updated)?;
                        return Ok(Some(entry.content_hash.clone()));
                    }
                }
                Ok(None)
            }
            None => {
                // Case 3: no ref. Check DAG.
                let dag = VersionDag::load(&self.vault_path, note_id)?;
                if let Some(latest) = dag.latest() {
                    let new_ref = NoteRef {
                        note_id: note_id.to_string(),
                        head_hash: latest.content_hash.clone(),
                        relative_path: String::new(),
                        updated_at: chrono::Utc::now(),
                        sync_etag: None,
                    };
                    self.refs.set(&new_ref)?;
                    Ok(Some(latest.content_hash.clone()))
                } else {
                    Ok(None)
                }
            }
        }
    }

    /// Read content of a specific version by hash.
    pub fn read_version(&self, content_hash: &str) -> Result<Option<Vec<u8>>, String> {
        self.cas.read_object(content_hash)
    }

    /// Get full history for a note (oldest first, includes abandoned entries).
    pub fn get_history(&self, note_id: &str) -> Result<Vec<VersionEntry>, String> {
        let dag = VersionDag::load(&self.vault_path, note_id)?;
        Ok(dag.versions)
    }

    /// Get the NoteRef (with sync metadata).
    pub fn get_ref(&self, note_id: &str) -> Result<Option<NoteRef>, String> {
        self.refs.get(note_id)
    }

    /// Update the sync_etag field on a ref.
    pub fn update_sync_etag(&self, note_id: &str, etag: Option<String>) -> Result<(), String> {
        let mut note_ref = self.refs.get(note_id)?
            .ok_or_else(|| format!("update_sync_etag: no ref for note_id {}", note_id))?;
        note_ref.sync_etag = etag;
        note_ref.updated_at = chrono::Utc::now();
        self.refs.set(&note_ref)
    }

    /// Explicit repair operation for corruption cases.
    ///
    /// `md_path`: optional path to the .md file. If provided and other
    /// recovery fails, hashes the .md content and creates a fresh commit.
    pub fn repair_note(
        &self,
        note_id: &str,
        md_path: Option<&Path>,
    ) -> Result<RepairReport, String> {
        let mut actions = Vec::new();
        let ref_opt = self.refs.get(note_id)?;
        let dag = VersionDag::load(&self.vault_path, note_id)?;

        // Step 1: ref valid?
        if let Some(ref note_ref) = ref_opt {
            if self.cas.has_object(&note_ref.head_hash) {
                actions.push("Ref valid, no repair needed".to_string());
                return Ok(RepairReport {
                    note_id: note_id.to_string(),
                    actions_taken: actions,
                    final_head_hash: Some(note_ref.head_hash.clone()),
                });
            }
            actions.push(format!("Ref points to missing CAS object {}", note_ref.head_hash));
        }

        // Step 2: find valid object in DAG (newest first)
        for entry in dag.versions.iter().rev() {
            if self.cas.has_object(&entry.content_hash) {
                let relative_path = ref_opt.as_ref()
                    .map(|r| r.relative_path.clone())
                    .or_else(|| md_path.and_then(|p| {
                        p.strip_prefix(&self.vault_path).ok()
                            .and_then(|rp| rp.to_str().map(|s| s.to_string()))
                    }))
                    .unwrap_or_default();
                let sync_etag = ref_opt.as_ref().and_then(|r| r.sync_etag.clone());

                let new_ref = NoteRef {
                    note_id: note_id.to_string(),
                    head_hash: entry.content_hash.clone(),
                    relative_path,
                    updated_at: chrono::Utc::now(),
                    sync_etag,
                };
                self.refs.set(&new_ref)?;
                actions.push(format!("Restored ref from DAG entry {}", entry.content_hash));
                return Ok(RepairReport {
                    note_id: note_id.to_string(),
                    actions_taken: actions,
                    final_head_hash: Some(entry.content_hash.clone()),
                });
            }
        }

        // Step 3: resurrect from .md file
        if let Some(md_path) = md_path {
            if md_path.is_file() {
                let content = fs::read(md_path)
                    .map_err(|e| format!("repair_note: failed to read md file: {}", e))?;
                let relative_path = md_path.strip_prefix(&self.vault_path).ok()
                    .and_then(|rp| rp.to_str().map(|s| s.to_string()))
                    .unwrap_or_default();
                let new_hash = self.commit_version(note_id, &content, &relative_path, vec![])?;
                if let Some(hash) = new_hash {
                    actions.push(format!("Resurrected from .md file as new commit {}", hash));
                    return Ok(RepairReport {
                        note_id: note_id.to_string(),
                        actions_taken: actions,
                        final_head_hash: Some(hash),
                    });
                }
            }
        }

        actions.push("No recovery path available".to_string());
        Ok(RepairReport {
            note_id: note_id.to_string(),
            actions_taken: actions,
            final_head_hash: None,
        })
    }

    /// Access the CAS store.
    pub fn cas(&self) -> &CasStore { &self.cas }

    /// Access the RefStore.
    pub fn refs(&self) -> &RefStore { &self.refs }

    /// Get Arc-wrapped CAS store (for SyncEngine).
    pub fn arc_cas(&self) -> Arc<CasStore> { Arc::clone(&self.cas) }

    /// Get Arc-wrapped RefStore (for SyncEngine).
    pub fn arc_refs(&self) -> Arc<RefStore> { Arc::clone(&self.refs) }

    /// Get vault root path.
    pub fn vault_path(&self) -> &Path { &self.vault_path }

    /// Get this device's identifier.
    pub fn device_id(&self) -> &str { &self.device_id }

    // ─── Private helpers ────────────────────────────────────────

    fn resolve_device_id(vault_path: &Path) -> Result<String, String> {
        let notology_dir = vault_path.join(".notology");
        let _ = fs::create_dir_all(&notology_dir);
        let device_id_path = notology_dir.join("device-id");

        // Try to read existing
        if device_id_path.is_file() {
            if let Ok(id) = fs::read_to_string(&device_id_path) {
                let id = id.trim().to_string();
                if !id.is_empty() {
                    return Ok(id);
                }
            }
        }

        // Generate new
        let hostname = hostname::get()
            .ok()
            .and_then(|h| h.into_string().ok())
            .map(|s| sanitize_hostname(&s))
            .unwrap_or_else(|| "unknown-host".to_string());
        let uuid_part = generate_short_id();
        let device_id = format!("{}-{}", hostname, uuid_part);

        // Persist (best-effort)
        if let Err(e) = fs::write(&device_id_path, &device_id) {
            // eprintln is intentional: warn about persistence failure
            // without blocking Library initialization
            eprintln!("Warning: failed to persist device-id to {:?}: {}", device_id_path, e);
        }

        Ok(device_id)
    }
}

/// Sanitize hostname: keep alphanumerics, hyphens, underscores. Truncate to 32 chars.
fn sanitize_hostname(hostname: &str) -> String {
    let sanitized: String = hostname.chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect();
    let truncated: String = sanitized.chars().take(32).collect();
    if truncated.is_empty() { "unknown-host".to_string() } else { truncated }
}

/// Generate 8 hex chars from system time for device-id suffix.
/// Not a real UUID; sufficient for per-device-per-vault uniqueness
/// since it's generated only once and persisted.
fn generate_short_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{:08x}", (nanos as u32) ^ ((nanos >> 32) as u32))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn make_library() -> (TempDir, Library) {
        let temp = TempDir::new().unwrap();
        let lib = Library::new_with_device_id(
            temp.path(),
            "TEST-DEVICE-12345678".to_string(),
        ).unwrap();
        (temp, lib)
    }

    #[test]
    fn test_commit_version_creates_all_three() {
        let (_tmp, lib) = make_library();
        let note_id = "20260419100000";
        let content = b"test content";
        let hash = lib.commit_version(note_id, content, "test.md", vec![]).unwrap().unwrap();

        // CAS object exists
        assert!(lib.cas().has_object(&hash));
        // DAG has 1 entry
        let history = lib.get_history(note_id).unwrap();
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].content_hash, hash);
        // Ref points to hash
        let r = lib.get_ref(note_id).unwrap().unwrap();
        assert_eq!(r.head_hash, hash);
    }

    #[test]
    fn test_commit_unchanged_content() {
        let (_tmp, lib) = make_library();
        let note_id = "20260419100000";
        let content = b"same content";
        let hash = lib.commit_version(note_id, content, "t.md", vec![]).unwrap().unwrap();
        let result = lib.commit_version(note_id, content, "t.md", vec![]).unwrap();
        assert_eq!(result, None);
        assert_eq!(lib.get_history(note_id).unwrap().len(), 1);
        assert_eq!(lib.cas().list_objects().unwrap().len(), 1);
        assert_eq!(lib.get_head(note_id).unwrap(), Some(hash));
    }

    #[test]
    fn test_commit_changed_content() {
        let (_tmp, lib) = make_library();
        let note_id = "20260419100000";
        let h1 = lib.commit_version(note_id, b"v1", "t.md", vec![]).unwrap().unwrap();
        let h2 = lib.commit_version(note_id, b"v2", "t.md", vec![]).unwrap().unwrap();
        assert_ne!(h1, h2);
        assert_eq!(lib.get_history(note_id).unwrap().len(), 2);
        assert_eq!(lib.get_head(note_id).unwrap(), Some(h2));
    }

    #[test]
    fn test_get_head() {
        let (_tmp, lib) = make_library();
        let note_id = "20260419100000";
        assert_eq!(lib.get_head(note_id).unwrap(), None);
        let hash = lib.commit_version(note_id, b"content", "t.md", vec![]).unwrap().unwrap();
        assert_eq!(lib.get_head(note_id).unwrap(), Some(hash));
    }

    #[test]
    fn test_read_version() {
        let (_tmp, lib) = make_library();
        let note_id = "20260419100000";
        let content = b"readable content";
        let hash = lib.commit_version(note_id, content, "t.md", vec![]).unwrap().unwrap();
        let read_back = lib.read_version(&hash).unwrap().unwrap();
        assert_eq!(read_back, content.to_vec());
        // Valid-format hash that doesn't exist
        let empty_hash = CasStore::hash(b"nonexistent");
        assert_eq!(lib.read_version(&empty_hash).unwrap(), None);
    }

    #[test]
    fn test_get_history() {
        let (_tmp, lib) = make_library();
        let note_id = "20260419100000";
        let h1 = lib.commit_version(note_id, b"v1", "t.md", vec![]).unwrap().unwrap();
        let h2 = lib.commit_version(note_id, b"v2", "t.md", vec![]).unwrap().unwrap();
        let h3 = lib.commit_version(note_id, b"v3", "t.md", vec![]).unwrap().unwrap();
        let history = lib.get_history(note_id).unwrap();
        assert_eq!(history.len(), 3);
        assert!(history[0].parents.is_empty());
        assert_eq!(history[1].parents, vec![h1]);
        assert_eq!(history[2].parents, vec![h2]);
        assert_eq!(history[2].content_hash, h3);
    }

    #[test]
    fn test_update_sync_etag() {
        let (_tmp, lib) = make_library();
        let note_id = "20260419100000";
        lib.commit_version(note_id, b"content", "t.md", vec![]).unwrap();

        lib.update_sync_etag(note_id, Some("etag123".into())).unwrap();
        assert_eq!(lib.get_ref(note_id).unwrap().unwrap().sync_etag, Some("etag123".into()));

        lib.update_sync_etag(note_id, None).unwrap();
        assert_eq!(lib.get_ref(note_id).unwrap().unwrap().sync_etag, None);

        // Unknown note → Err
        assert!(lib.update_sync_etag("99999999999999", Some("x".into())).is_err());
    }

    #[test]
    fn test_recovery_missing_ref_with_dag() {
        let (tmp, lib) = make_library();
        let note_id = "20260419100000";
        let content = b"dag content";
        let hash = CasStore::hash(content);

        // Manually create CAS object + DAG without ref
        lib.cas().write_object(content).unwrap();
        let mut dag = VersionDag::default();
        dag.append(hash.clone(), None, "D".into(), vec![]);
        dag.save(tmp.path(), note_id).unwrap();

        // get_head should recover
        let head = lib.get_head(note_id).unwrap();
        assert_eq!(head, Some(hash.clone()));
        // Ref now exists
        let r = lib.refs().get(note_id).unwrap().unwrap();
        assert_eq!(r.head_hash, hash);
    }

    #[test]
    fn test_recovery_missing_object() {
        let (_tmp, lib) = make_library();
        let note_id = "20260419100000";
        let h1 = lib.commit_version(note_id, b"v1", "t.md", vec![]).unwrap().unwrap();
        let h2 = lib.commit_version(note_id, b"v2", "t.md", vec![]).unwrap().unwrap();

        // Delete latest CAS object
        lib.cas().delete_object(&h2).unwrap();

        // get_head should fall back to h1
        let head = lib.get_head(note_id).unwrap();
        assert_eq!(head, Some(h1.clone()));
        let r = lib.refs().get(note_id).unwrap().unwrap();
        assert_eq!(r.head_hash, h1);
    }

    #[test]
    fn test_multiple_notes_independent() {
        let (_tmp, lib) = make_library();
        let ha = lib.commit_version("00000000000001", b"note A", "a.md", vec![]).unwrap().unwrap();
        let hb = lib.commit_version("00000000000002", b"note B", "b.md", vec![]).unwrap().unwrap();
        assert_eq!(lib.get_head("00000000000001").unwrap(), Some(ha.clone()));
        assert_eq!(lib.get_head("00000000000002").unwrap(), Some(hb.clone()));

        // Modify A doesn't affect B
        lib.commit_version("00000000000001", b"note A v2", "a.md", vec![]).unwrap();
        assert_eq!(lib.get_head("00000000000002").unwrap(), Some(hb));
    }

    #[test]
    fn test_repair_note_missing_ref() {
        let (tmp, lib) = make_library();
        let note_id = "20260419100000";
        let content = b"repair content";
        let hash = CasStore::hash(content);

        lib.cas().write_object(content).unwrap();
        let mut dag = VersionDag::default();
        dag.append(hash.clone(), None, "D".into(), vec![]);
        dag.save(tmp.path(), note_id).unwrap();

        let report = lib.repair_note(note_id, None).unwrap();
        assert!(report.actions_taken.iter().any(|a| a.contains("Restored ref from DAG")));
        assert_eq!(report.final_head_hash, Some(hash));
        assert!(lib.refs().get(note_id).unwrap().is_some());
    }

    #[test]
    fn test_repair_note_missing_object() {
        let (tmp, lib) = make_library();
        let note_id = "20260419100000";

        // Commit then delete all CAS objects
        let h1 = lib.commit_version(note_id, b"v1", "test.md", vec![]).unwrap().unwrap();
        lib.cas().delete_object(&h1).unwrap();

        // Provide .md file for resurrection
        let md_path = tmp.path().join("test.md");
        fs::write(&md_path, b"resurrected content").unwrap();

        let report = lib.repair_note(note_id, Some(&md_path)).unwrap();
        assert!(report.final_head_hash.is_some());
        assert!(report.actions_taken.iter().any(|a| a.contains("Resurrected from .md")));
    }

    #[test]
    fn test_device_id_persisted() {
        let tmp = TempDir::new().unwrap();
        let id1 = {
            let lib = Library::new(tmp.path()).unwrap();
            lib.device_id().to_string()
        };
        // New library at same vault should read persisted device-id
        let id2 = {
            let lib = Library::new(tmp.path()).unwrap();
            lib.device_id().to_string()
        };
        assert_eq!(id1, id2);
        assert!(!id1.is_empty());
        // File exists
        let device_id_path = tmp.path().join(".notology").join("device-id");
        assert!(device_id_path.is_file());
        let persisted = fs::read_to_string(&device_id_path).unwrap();
        assert_eq!(persisted.trim(), id1);
    }
}
