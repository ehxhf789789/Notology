//! Reference tracking for Notology version history.
//!
//! Each note has a ref file at `{vault}/.notology/refs/{note-id}.json`
//! that points to the current HEAD version hash and stores sync metadata.

use chrono::{DateTime, Utc};
use serde::{Serialize, Deserialize};
use std::fs;
use std::path::{Path, PathBuf};

use crate::core::file_io::atomic_write_file;

/// A reference pointing to a note's current version.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoteRef {
    /// The note's frontmatter ID (14-digit timestamp)
    pub note_id: String,
    /// SHA-256 hash of the current content (HEAD)
    pub head_hash: String,
    /// File path relative to vault root (e.g., "subfolder/note.md")
    pub relative_path: String,
    /// Last time this ref was updated
    pub updated_at: DateTime<Utc>,
    /// ETag from last successful WebDAV sync (bridges old and new identity)
    pub sync_etag: Option<String>,
}

/// Reference store for all notes in a vault.
/// Each ref stored at: `{vault}/.notology/refs/{note-id}.json`
pub struct RefStore {
    refs_dir: PathBuf,
}

impl RefStore {
    /// Create a new ref store rooted at the vault path.
    /// Creates `.notology/refs/` if it doesn't exist.
    pub fn new(vault_path: &Path) -> Result<Self, String> {
        if !vault_path.is_dir() {
            return Err(format!("RefStore::new: vault path is not a directory: {:?}", vault_path));
        }
        let refs_dir = vault_path.join(".notology").join("refs");
        fs::create_dir_all(&refs_dir)
            .map_err(|e| format!("RefStore::new: failed to create refs directory {:?}: {}", refs_dir, e))?;
        Ok(Self { refs_dir })
    }

    /// Get a ref by note ID. Returns `None` if not found.
    pub fn get(&self, note_id: &str) -> Result<Option<NoteRef>, String> {
        let path = self.ref_path(note_id);
        if !path.is_file() {
            return Ok(None);
        }
        let content = fs::read_to_string(&path)
            .map_err(|e| format!("RefStore::get: failed to read ref file {:?}: {}", path, e))?;
        let note_ref: NoteRef = serde_json::from_str(&content)
            .map_err(|e| format!("RefStore::get: failed to parse ref {:?}: {}", path, e))?;
        Ok(Some(note_ref))
    }

    /// Update or create a ref. Atomic write.
    pub fn set(&self, note_ref: &NoteRef) -> Result<(), String> {
        let path = self.ref_path(&note_ref.note_id);
        let bytes = serde_json::to_vec_pretty(note_ref)
            .map_err(|e| format!("RefStore::set: failed to serialize ref: {}", e))?;
        atomic_write_file(&path, &bytes)
    }

    /// Delete a ref. Returns `Ok(false)` if it didn't exist.
    pub fn delete(&self, note_id: &str) -> Result<bool, String> {
        let path = self.ref_path(note_id);
        if !path.is_file() {
            return Ok(false);
        }
        fs::remove_file(&path)
            .map_err(|e| format!("RefStore::delete: failed to remove {:?}: {}", path, e))?;
        Ok(true)
    }

    /// List all refs.
    pub fn list(&self) -> Result<Vec<NoteRef>, String> {
        let mut refs = Vec::new();
        let entries = match fs::read_dir(&self.refs_dir) {
            Ok(entries) => entries,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(refs),
            Err(e) => return Err(format!("RefStore::list: failed to read refs directory: {}", e)),
        };
        for entry in entries {
            let entry = entry
                .map_err(|e| format!("RefStore::list: failed to read entry: {}", e))?;
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") || !path.is_file() {
                continue;
            }
            let content = fs::read_to_string(&path)
                .map_err(|e| format!("RefStore::list: failed to read {:?}: {}", path, e))?;
            let note_ref: NoteRef = serde_json::from_str(&content)
                .map_err(|e| format!("RefStore::list: failed to parse {:?}: {}", path, e))?;
            refs.push(note_ref);
        }
        Ok(refs)
    }

    /// Find a ref by relative path (reverse lookup). O(n) scan.
    pub fn find_by_path(&self, relative_path: &str) -> Result<Option<NoteRef>, String> {
        let all = self.list()?;
        Ok(all.into_iter().find(|r| r.relative_path == relative_path))
    }

    /// File path for a given note ID's ref.
    pub fn ref_path(&self, note_id: &str) -> PathBuf {
        self.refs_dir.join(format!("{}.json", note_id))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn make_ref(note_id: &str, hash: &str, path: &str) -> NoteRef {
        NoteRef {
            note_id: note_id.to_string(),
            head_hash: hash.to_string(),
            relative_path: path.to_string(),
            updated_at: chrono::DateTime::parse_from_rfc3339("2026-04-19T10:00:00Z")
                .unwrap().with_timezone(&Utc),
            sync_etag: None,
        }
    }

    #[test]
    fn test_set_and_get() {
        let tmp = TempDir::new().unwrap();
        let store = RefStore::new(tmp.path()).unwrap();
        let r = make_ref("20260419100000", "abc123", "note.md");
        store.set(&r).unwrap();
        let loaded = store.get("20260419100000").unwrap().unwrap();
        assert_eq!(loaded.note_id, "20260419100000");
        assert_eq!(loaded.head_hash, "abc123");
        assert_eq!(loaded.relative_path, "note.md");
    }

    #[test]
    fn test_get_nonexistent() {
        let tmp = TempDir::new().unwrap();
        let store = RefStore::new(tmp.path()).unwrap();
        assert!(store.get("99999999999999").unwrap().is_none());
    }

    #[test]
    fn test_delete() {
        let tmp = TempDir::new().unwrap();
        let store = RefStore::new(tmp.path()).unwrap();
        let r = make_ref("20260419100000", "abc", "n.md");
        store.set(&r).unwrap();
        assert_eq!(store.delete("20260419100000").unwrap(), true);
        assert!(store.get("20260419100000").unwrap().is_none());
        assert_eq!(store.delete("20260419100000").unwrap(), false);
    }

    #[test]
    fn test_list() {
        let tmp = TempDir::new().unwrap();
        let store = RefStore::new(tmp.path()).unwrap();
        store.set(&make_ref("00000000000001", "h1", "a.md")).unwrap();
        store.set(&make_ref("00000000000002", "h2", "b.md")).unwrap();
        store.set(&make_ref("00000000000003", "h3", "c.md")).unwrap();
        let listed = store.list().unwrap();
        assert_eq!(listed.len(), 3);
    }

    #[test]
    fn test_find_by_path() {
        let tmp = TempDir::new().unwrap();
        let store = RefStore::new(tmp.path()).unwrap();
        store.set(&make_ref("00000000000001", "h1", "alpha.md")).unwrap();
        store.set(&make_ref("00000000000002", "h2", "sub/beta.md")).unwrap();
        store.set(&make_ref("00000000000003", "h3", "gamma.md")).unwrap();
        let found = store.find_by_path("sub/beta.md").unwrap().unwrap();
        assert_eq!(found.note_id, "00000000000002");
        assert!(store.find_by_path("nonexistent.md").unwrap().is_none());
    }

    #[test]
    fn test_overwrite() {
        let tmp = TempDir::new().unwrap();
        let store = RefStore::new(tmp.path()).unwrap();
        store.set(&make_ref("20260419100000", "old_hash", "n.md")).unwrap();
        store.set(&make_ref("20260419100000", "new_hash", "n.md")).unwrap();
        let loaded = store.get("20260419100000").unwrap().unwrap();
        assert_eq!(loaded.head_hash, "new_hash");
    }

    #[test]
    fn test_round_trip_all_fields() {
        let tmp = TempDir::new().unwrap();
        let store = RefStore::new(tmp.path()).unwrap();

        // With sync_etag
        let r = NoteRef {
            note_id: "20260419100000".into(),
            head_hash: "abcdef".into(),
            relative_path: "sub/folder/note.md".into(),
            updated_at: chrono::DateTime::parse_from_rfc3339("2026-04-19T10:30:00Z")
                .unwrap().with_timezone(&Utc),
            sync_etag: Some("\"etag-value-123\"".into()),
        };
        store.set(&r).unwrap();
        let loaded = store.get("20260419100000").unwrap().unwrap();
        assert_eq!(loaded.sync_etag, Some("\"etag-value-123\"".into()));
        assert_eq!(loaded.updated_at, r.updated_at);

        // Without sync_etag
        let r2 = NoteRef {
            sync_etag: None,
            ..r.clone()
        };
        store.set(&r2).unwrap();
        let loaded2 = store.get("20260419100000").unwrap().unwrap();
        assert_eq!(loaded2.sync_etag, None);
    }

    #[test]
    fn test_cas_dag_ref_roundtrip() {
        use crate::core::cas::CasStore;
        use crate::core::version_dag::VersionDag;

        let temp = TempDir::new().unwrap();
        let vault = temp.path();
        let note_id = "20260419103000";
        let device_id = "TEST-DEVICE";

        let cas = CasStore::new(vault).unwrap();
        let refs = RefStore::new(vault).unwrap();

        // Step 1: Write content to CAS
        let content = b"---\nid: \"20260419103000\"\n---\n\nHello world";
        let hash = cas.write_object(content).unwrap();

        // Step 2: Append to DAG
        let mut dag = VersionDag::load(vault, note_id).unwrap();
        assert!(dag.is_empty());
        dag.append(hash.clone(), None, device_id.to_string(), vec![]);
        dag.save(vault, note_id).unwrap();

        // Step 3: Update ref
        let note_ref = NoteRef {
            note_id: note_id.to_string(),
            head_hash: hash.clone(),
            relative_path: "test-note.md".to_string(),
            updated_at: Utc::now(),
            sync_etag: None,
        };
        refs.set(&note_ref).unwrap();

        // Step 4: Verify round-trip
        let loaded_ref = refs.get(note_id).unwrap().unwrap();
        assert_eq!(loaded_ref.head_hash, hash);

        let loaded_dag = VersionDag::load(vault, note_id).unwrap();
        assert_eq!(loaded_dag.len(), 1);
        assert_eq!(loaded_dag.latest().unwrap().content_hash, hash);

        let loaded_content = cas.read_object(&hash).unwrap().unwrap();
        assert_eq!(loaded_content, content.to_vec());

        // Step 5: Append second version
        let content2 = b"---\nid: \"20260419103000\"\n---\n\nUpdated content";
        let hash2 = cas.write_object(content2).unwrap();

        let mut dag = VersionDag::load(vault, note_id).unwrap();
        dag.append(hash2.clone(), Some(hash.clone()), device_id.to_string(), vec![]);
        dag.save(vault, note_id).unwrap();

        refs.set(&NoteRef {
            head_hash: hash2.clone(),
            updated_at: Utc::now(),
            ..loaded_ref
        }).unwrap();

        // Step 6: Verify history
        let final_dag = VersionDag::load(vault, note_id).unwrap();
        assert_eq!(final_dag.len(), 2);
        assert_eq!(final_dag.history()[0].content_hash, hash);
        assert_eq!(final_dag.history()[1].content_hash, hash2);
        assert_eq!(final_dag.history()[1].parents, vec![hash]);

        let final_ref = refs.get(note_id).unwrap().unwrap();
        assert_eq!(final_ref.head_hash, hash2);
    }
}
