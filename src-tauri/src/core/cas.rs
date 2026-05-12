//! Content-Addressable Storage (CAS) for Notology version history.
//!
//! Objects are stored by their SHA-256 hash in a sharded directory layout:
//! `{vault}/.notology/objects/{hash[0:2]}/{hash[2:]}`.
//!
//! Objects are immutable once written. Writing the same content twice is
//! a no-op (deduplication by hash). No locking is required for reads or
//! writes because identical content always produces identical files.

use sha2::{Sha256, Digest};
use std::fs;
use std::path::{Path, PathBuf};

use crate::core::file_io::atomic_write_file;

/// Validate that a string is a well-formed SHA-256 hex hash.
fn is_valid_hash(hash: &str) -> bool {
    hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

/// Content-Addressable Storage engine.
///
/// Objects are stored at `{vault}/.notology/objects/{hash[0:2]}/{hash[2:]}`.
/// Each object file contains the raw bytes that hash to its filename.
pub struct CasStore {
    objects_dir: PathBuf,
}

impl CasStore {
    /// Create a new CAS store rooted at the given vault path.
    /// Creates `.notology/objects/` if it doesn't exist.
    pub fn new(vault_path: &Path) -> Result<Self, String> {
        if !vault_path.is_dir() {
            return Err(format!("CasStore::new: vault path is not a directory: {:?}", vault_path));
        }
        let objects_dir = vault_path.join(".notology").join("objects");
        fs::create_dir_all(&objects_dir)
            .map_err(|e| format!("CasStore::new: failed to create objects directory {:?}: {}", objects_dir, e))?;
        Ok(Self { objects_dir })
    }

    /// Compute SHA-256 hash of content without storing it.
    /// Returns a 64-character lowercase hex string.
    pub fn hash(content: &[u8]) -> String {
        let mut hasher = Sha256::new();
        hasher.update(content);
        let result = hasher.finalize();
        // Format each byte as two lowercase hex chars
        result.iter().map(|b| format!("{:02x}", b)).collect()
    }

    /// Store content and return its SHA-256 hash.
    ///
    /// If the object already exists (same hash), this is a no-op (deduplication).
    /// Uses atomic write (temp file -> fsync -> rename).
    pub fn write_object(&self, content: &[u8]) -> Result<String, String> {
        let hash = Self::hash(content);
        let path = self.object_path(&hash);

        // Deduplication: skip write if object already exists
        if path.is_file() {
            return Ok(hash);
        }

        // Create shard directory if needed
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("write_object: failed to create shard directory {:?}: {}", parent, e))?;
        }

        // If the write fails but the object now exists (another thread or
        // process completed first), that's fine — CAS deduplication.
        if let Err(e) = atomic_write_file(&path, content) {
            if path.is_file() {
                return Ok(hash); // Another thread wrote it
            }
            return Err(e);
        }
        Ok(hash)
    }

    /// Read content by hash. Returns `None` if object doesn't exist.
    pub fn read_object(&self, hash: &str) -> Result<Option<Vec<u8>>, String> {
        if !is_valid_hash(hash) {
            return Err(format!("read_object: invalid hash format: {}", hash));
        }
        let path = self.object_path(hash);
        if !path.is_file() {
            return Ok(None);
        }
        let content = fs::read(&path)
            .map_err(|e| format!("read_object: failed to read {:?}: {}", path, e))?;
        Ok(Some(content))
    }

    /// Check if an object exists. Returns `false` for invalid hashes.
    pub fn has_object(&self, hash: &str) -> bool {
        if !is_valid_hash(hash) {
            return false;
        }
        self.object_path(hash).is_file()
    }

    /// Delete an object by hash. Returns `Ok(false)` if it didn't exist.
    pub fn delete_object(&self, hash: &str) -> Result<bool, String> {
        if !is_valid_hash(hash) {
            return Err(format!("delete_object: invalid hash format: {}", hash));
        }
        let path = self.object_path(hash);
        if !path.is_file() {
            return Ok(false);
        }
        fs::remove_file(&path)
            .map_err(|e| format!("delete_object: failed to remove {:?}: {}", path, e))?;
        Ok(true)
    }

    /// List all object hashes in the store.
    pub fn list_objects(&self) -> Result<Vec<String>, String> {
        let mut hashes = Vec::new();

        let entries = match fs::read_dir(&self.objects_dir) {
            Ok(entries) => entries,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(hashes),
            Err(e) => return Err(format!("list_objects: failed to read objects dir: {}", e)),
        };

        for shard_entry in entries {
            let shard_entry = shard_entry
                .map_err(|e| format!("list_objects: failed to read shard entry: {}", e))?;
            let shard_name = shard_entry.file_name().to_string_lossy().to_string();

            // Shard must be a 2-char lowercase hex directory
            if shard_name.len() != 2
                || !shard_name.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
                || !shard_entry.path().is_dir()
            {
                continue;
            }

            let shard_dir = shard_entry.path();
            let object_entries = fs::read_dir(&shard_dir)
                .map_err(|e| format!("list_objects: failed to read shard {:?}: {}", shard_dir, e))?;

            for obj_entry in object_entries {
                let obj_entry = obj_entry
                    .map_err(|e| format!("list_objects: failed to read object entry: {}", e))?;
                let obj_name = obj_entry.file_name().to_string_lossy().to_string();

                // Object name must be 62-char lowercase hex and a regular file
                let full_hash = format!("{}{}", shard_name, obj_name);
                if is_valid_hash(&full_hash) && obj_entry.path().is_file() {
                    hashes.push(full_hash);
                }
            }
        }

        Ok(hashes)
    }

    /// Get the file path for a given hash.
    pub fn object_path(&self, hash: &str) -> PathBuf {
        self.objects_dir.join(&hash[..2]).join(&hash[2..])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn make_test_store() -> (TempDir, CasStore) {
        let temp = TempDir::new().expect("create temp dir");
        let store = CasStore::new(temp.path()).expect("create store");
        (temp, store)
    }

    #[test]
    fn test_hash_determinism() {
        let content = b"hello world";
        let first = CasStore::hash(content);
        for _ in 0..10 {
            assert_eq!(CasStore::hash(content), first);
        }
    }

    #[test]
    fn test_write_and_read() {
        let (_tmp, store) = make_test_store();
        let content = b"hello world";
        let hash = store.write_object(content).unwrap();
        let read_back = store.read_object(&hash).unwrap();
        assert_eq!(read_back, Some(content.to_vec()));
    }

    #[test]
    fn test_deduplication() {
        let (_tmp, store) = make_test_store();
        let content = b"duplicate me";
        let h1 = store.write_object(content).unwrap();
        let h2 = store.write_object(content).unwrap();
        assert_eq!(h1, h2);
        // Only one object on disk
        assert_eq!(store.list_objects().unwrap().len(), 1);
    }

    #[test]
    fn test_read_nonexistent() {
        let (_tmp, store) = make_test_store();
        // Valid hash that was never written
        let hash = CasStore::hash(b"never stored");
        assert_eq!(store.read_object(&hash).unwrap(), None);
    }

    #[test]
    fn test_has_object() {
        let (_tmp, store) = make_test_store();
        let content = b"check existence";
        let hash = store.write_object(content).unwrap();
        assert!(store.has_object(&hash));
        store.delete_object(&hash).unwrap();
        assert!(!store.has_object(&hash));
    }

    #[test]
    fn test_delete_object() {
        let (_tmp, store) = make_test_store();
        let hash = store.write_object(b"to be deleted").unwrap();
        assert_eq!(store.delete_object(&hash).unwrap(), true);
        assert!(!store.has_object(&hash));
        // Delete nonexistent returns false
        assert_eq!(store.delete_object(&hash).unwrap(), false);
    }

    #[test]
    fn test_list_objects() {
        let (_tmp, store) = make_test_store();
        let h1 = store.write_object(b"one").unwrap();
        let h2 = store.write_object(b"two").unwrap();
        let h3 = store.write_object(b"three").unwrap();
        let mut listed = store.list_objects().unwrap();
        listed.sort();
        let mut expected = vec![h1, h2, h3];
        expected.sort();
        assert_eq!(listed, expected);
    }

    #[test]
    fn test_invalid_hash_path() {
        let (_tmp, store) = make_test_store();
        // Too short
        assert!(store.read_object("ab").is_err());
        // Uppercase
        assert!(store.read_object("A1B2C3D4E5F6A1B2C3D4E5F6A1B2C3D4E5F6A1B2C3D4E5F6A1B2C3D4E5F6A1B2").is_err());
        // Not hex
        assert!(store.read_object("zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz").is_err());
        // has_object returns false for invalid
        assert!(!store.has_object("not-a-hash"));
        // delete_object returns Err for invalid
        assert!(store.delete_object("not-a-hash").is_err());
    }

    #[test]
    fn test_empty_content() {
        let (_tmp, store) = make_test_store();
        let hash = CasStore::hash(&[]);
        assert_eq!(hash, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
        let written = store.write_object(&[]).unwrap();
        assert_eq!(written, hash);
        assert_eq!(store.read_object(&hash).unwrap(), Some(vec![]));
    }

    #[test]
    fn test_large_content() {
        let (_tmp, store) = make_test_store();
        let content: Vec<u8> = (0..1_000_000).map(|i| (i % 256) as u8).collect();
        let h1 = CasStore::hash(&content);
        let h2 = store.write_object(&content).unwrap();
        assert_eq!(h1, h2);
        let read_back = store.read_object(&h2).unwrap().unwrap();
        assert_eq!(read_back, content);
    }

    #[test]
    fn test_concurrent_same_hash() {
        let (_tmp, store) = make_test_store();
        let content = b"concurrent content";
        let expected_hash = CasStore::hash(content);

        std::thread::scope(|s| {
            let handles: Vec<_> = (0..4)
                .map(|_| {
                    s.spawn(|| store.write_object(content).unwrap())
                })
                .collect();

            for handle in handles {
                let hash = handle.join().unwrap();
                assert_eq!(hash, expected_hash);
            }
        });

        assert_eq!(store.list_objects().unwrap().len(), 1);
    }
}
