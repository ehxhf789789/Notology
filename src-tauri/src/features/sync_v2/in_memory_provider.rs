//! In-memory SyncProvider for testing. All data stored in HashMaps.
//! Supports test controls: simulated failures, latency, network partition.

use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use async_trait::async_trait;
use chrono::Utc;

use crate::core::sync_provider::*;

/// In-memory implementation of SyncProvider for unit and integration tests.
pub struct InMemorySyncProvider {
    objects: Mutex<HashMap<String, Vec<u8>>>,
    refs: Mutex<HashMap<String, (Vec<u8>, RefVersion)>>,
    dags: Mutex<HashMap<String, Vec<u8>>>,
    md_files: Mutex<HashMap<String, Vec<u8>>>,
    #[allow(clippy::type_complexity)]
    device_states: Mutex<HashMap<String, (Vec<u8>, chrono::DateTime<chrono::Utc>)>>,
    branches: Mutex<HashMap<String, HashMap<String, Vec<u8>>>>, // note_id -> { branch_name -> content }

    // Test controls
    fail_next: Mutex<Option<SyncProviderError>>,
    delay_ms: AtomicU64,
    network_partition: AtomicBool,
    version_counter: AtomicU64,
}

impl Default for InMemorySyncProvider {
    fn default() -> Self { Self::new() }
}

impl InMemorySyncProvider {
    /// Create empty provider.
    pub fn new() -> Self {
        Self {
            objects: Mutex::new(HashMap::new()),
            refs: Mutex::new(HashMap::new()),
            dags: Mutex::new(HashMap::new()),
            md_files: Mutex::new(HashMap::new()),
            device_states: Mutex::new(HashMap::new()),
            branches: Mutex::new(HashMap::new()),
            fail_next: Mutex::new(None),
            delay_ms: AtomicU64::new(0),
            network_partition: AtomicBool::new(false),
            version_counter: AtomicU64::new(1),
        }
    }

    /// Make the next operation fail with the given error.
    pub fn fail_next(&self, error: SyncProviderError) {
        *self.fail_next.lock().unwrap() = Some(error);
    }

    /// Add latency to all operations (milliseconds).
    pub fn set_delay(&self, ms: u64) {
        self.delay_ms.store(ms, Ordering::SeqCst);
    }

    /// Simulate network disconnect — all operations fail.
    pub fn partition_network(&self) {
        self.network_partition.store(true, Ordering::SeqCst);
    }

    /// Resume normal operation after partition.
    pub fn heal_network(&self) {
        self.network_partition.store(false, Ordering::SeqCst);
    }

    /// How many objects are stored.
    pub fn object_count(&self) -> usize {
        self.objects.lock().unwrap().len()
    }

    fn next_version(&self) -> RefVersion {
        let n = self.version_counter.fetch_add(1, Ordering::SeqCst);
        RefVersion(format!("v{}", n))
    }

    async fn check_failure(&self) -> Result<(), SyncProviderError> {
        if self.network_partition.load(Ordering::SeqCst) {
            return Err(SyncProviderError::NetworkError("network partitioned".into()));
        }
        if let Some(e) = self.fail_next.lock().unwrap().take() {
            return Err(e);
        }
        let delay = self.delay_ms.load(Ordering::SeqCst);
        if delay > 0 {
            tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
        }
        Ok(())
    }
}

#[async_trait]
impl SyncProvider for InMemorySyncProvider {
    async fn put_object(&self, hash: &str, data: &[u8]) -> Result<(), SyncProviderError> {
        self.check_failure().await?;
        self.objects.lock().unwrap().insert(hash.to_string(), data.to_vec());
        Ok(())
    }

    async fn get_object(&self, hash: &str) -> Result<Option<Vec<u8>>, SyncProviderError> {
        self.check_failure().await?;
        Ok(self.objects.lock().unwrap().get(hash).cloned())
    }

    async fn has_object(&self, hash: &str) -> Result<bool, SyncProviderError> {
        self.check_failure().await?;
        Ok(self.objects.lock().unwrap().contains_key(hash))
    }

    async fn list_objects(&self) -> Result<Vec<String>, SyncProviderError> {
        self.check_failure().await?;
        Ok(self.objects.lock().unwrap().keys().cloned().collect())
    }

    async fn put_ref(&self, note_id: &str, content: &[u8]) -> Result<RefVersion, SyncProviderError> {
        self.check_failure().await?;
        let version = self.next_version();
        self.refs.lock().unwrap().insert(note_id.to_string(), (content.to_vec(), version.clone()));
        Ok(version)
    }

    async fn get_ref(&self, note_id: &str) -> Result<Option<(Vec<u8>, RefVersion)>, SyncProviderError> {
        self.check_failure().await?;
        Ok(self.refs.lock().unwrap().get(note_id).cloned())
    }

    async fn list_refs(&self) -> Result<Vec<RefMetadata>, SyncProviderError> {
        self.check_failure().await?;
        Ok(self.refs.lock().unwrap().iter().map(|(id, (_, ver))| {
            RefMetadata {
                note_id: id.clone(),
                version: ver.clone(),
                modified_at: Utc::now(),
            }
        }).collect())
    }

    async fn delete_ref(&self, note_id: &str) -> Result<(), SyncProviderError> {
        self.check_failure().await?;
        self.refs.lock().unwrap().remove(note_id);
        Ok(())
    }

    async fn put_dag(&self, note_id: &str, content: &[u8]) -> Result<(), SyncProviderError> {
        self.check_failure().await?;
        self.dags.lock().unwrap().insert(note_id.to_string(), content.to_vec());
        Ok(())
    }

    async fn get_dag(&self, note_id: &str) -> Result<Option<Vec<u8>>, SyncProviderError> {
        self.check_failure().await?;
        Ok(self.dags.lock().unwrap().get(note_id).cloned())
    }

    async fn put_md(&self, relative_path: &str, content: &[u8]) -> Result<(), SyncProviderError> {
        self.check_failure().await?;
        self.md_files.lock().unwrap().insert(relative_path.to_string(), content.to_vec());
        Ok(())
    }

    async fn get_md(&self, relative_path: &str) -> Result<Option<Vec<u8>>, SyncProviderError> {
        self.check_failure().await?;
        Ok(self.md_files.lock().unwrap().get(relative_path).cloned())
    }

    async fn has_md(&self, relative_path: &str) -> Result<bool, SyncProviderError> {
        self.check_failure().await?;
        Ok(self.md_files.lock().unwrap().contains_key(relative_path))
    }

    async fn delete_md(&self, relative_path: &str) -> Result<(), SyncProviderError> {
        self.check_failure().await?;
        self.md_files.lock().unwrap().remove(relative_path);
        Ok(())
    }

    async fn list_md_dir(&self, relative_dir: &str) -> Result<Vec<RemoteChild>, SyncProviderError> {
        self.check_failure().await?;
        let dir = relative_dir.trim_end_matches('/');
        let md = self.md_files.lock().unwrap();
        let mut seen = std::collections::HashSet::new();
        let mut result = vec![];
        for key in md.keys() {
            if let Some(rest) = key.strip_prefix(dir).and_then(|r| r.strip_prefix('/')) {
                let name = rest.split('/').next().unwrap_or("");
                if !name.is_empty() && seen.insert(name.to_string()) {
                    result.push(RemoteChild {
                        name: name.to_string(),
                        path: format!("{}/{}", dir, name),
                        is_collection: rest.contains('/'),
                        modified_at: chrono::Utc::now(),
                        size: 0,
                    });
                }
            }
        }
        Ok(result)
    }

    async fn put_device_state(&self, device_id: &str, content: &[u8]) -> Result<(), SyncProviderError> {
        self.check_failure().await?;
        self.device_states.lock().unwrap().insert(
            device_id.to_string(),
            (content.to_vec(), chrono::Utc::now()),
        );
        Ok(())
    }

    async fn get_device_state(&self, device_id: &str) -> Result<Option<Vec<u8>>, SyncProviderError> {
        self.check_failure().await?;
        Ok(self.device_states.lock().unwrap()
            .get(device_id)
            .map(|(content, _)| content.clone()))
    }

    async fn list_device_states(&self) -> Result<Vec<DeviceStateInfo>, SyncProviderError> {
        self.check_failure().await?;
        Ok(self.device_states.lock().unwrap()
            .iter()
            .map(|(id, (content, modified))| DeviceStateInfo {
                device_id: id.clone(),
                last_modified: *modified,
                size: content.len() as u64,
            })
            .collect())
    }

    async fn put_branch(&self, note_id: &str, branch_name: &str, content: &[u8]) -> Result<(), SyncProviderError> {
        self.check_failure().await?;
        self.branches.lock().unwrap()
            .entry(note_id.to_string())
            .or_default()
            .insert(branch_name.to_string(), content.to_vec());
        Ok(())
    }

    async fn list_branches(&self, note_id: &str) -> Result<Vec<String>, SyncProviderError> {
        self.check_failure().await?;
        Ok(self.branches.lock().unwrap()
            .get(note_id)
            .map(|m| m.keys().cloned().collect())
            .unwrap_or_default())
    }

    async fn get_branch(&self, note_id: &str, branch_name: &str) -> Result<Option<Vec<u8>>, SyncProviderError> {
        self.check_failure().await?;
        Ok(self.branches.lock().unwrap()
            .get(note_id)
            .and_then(|m| m.get(branch_name))
            .cloned())
    }

    async fn delete_branch(&self, note_id: &str, branch_name: &str) -> Result<(), SyncProviderError> {
        self.check_failure().await?;
        if let Some(m) = self.branches.lock().unwrap().get_mut(note_id) {
            m.remove(branch_name);
        }
        Ok(())
    }

    async fn list_notes_with_branches(&self) -> Result<Vec<String>, SyncProviderError> {
        self.check_failure().await?;
        let branches = self.branches.lock().unwrap();
        Ok(branches.keys()
            .filter(|k| !branches.get(*k).map_or(true, |m| m.is_empty()))
            .cloned().collect())
    }

    async fn list_children(&self, remote_dir: &str) -> Result<Vec<RemoteChild>, SyncProviderError> {
        self.check_failure().await?;
        let dir = remote_dir.trim_end_matches('/');
        let md = self.md_files.lock().unwrap();
        let mut seen = std::collections::HashSet::new();
        let mut result = vec![];
        for key in md.keys() {
            if let Some(rest) = key.strip_prefix(dir).and_then(|r| r.strip_prefix('/')) {
                let name = rest.split('/').next().unwrap_or("");
                if !name.is_empty() && seen.insert(name.to_string()) {
                    let is_dir = rest.contains('/');
                    result.push(RemoteChild {
                        name: name.to_string(),
                        path: format!("{}/{}", dir, name),
                        is_collection: is_dir,
                        modified_at: chrono::Utc::now(),
                        size: 0,
                    });
                }
            }
        }
        Ok(result)
    }

    async fn test_connection(&self) -> Result<bool, SyncProviderError> {
        self.check_failure().await?;
        Ok(true)
    }

    async fn move_collection(&self, from_abs: &str, to_abs: &str) -> Result<(), SyncProviderError> {
        self.check_failure().await?;
        // Rename every key whose path starts with `from_abs/` (or equals
        // `from_abs`) to live under `to_abs` instead. The .md HashMap is
        // the only one keyed by user-visible paths — the rest (objects,
        // refs, dags, branches, device_states) live under `.notology/...`
        // which we treat as part of the collection too.
        let from = from_abs.trim_end_matches('/');
        let to = to_abs.trim_end_matches('/');
        if from.is_empty() || to.is_empty() || from == to {
            return Ok(());
        }
        let rewrite = |k: &str| -> Option<String> {
            if k == from {
                Some(to.to_string())
            } else if let Some(rest) = k.strip_prefix(from) {
                if rest.starts_with('/') {
                    Some(format!("{}{}", to, rest))
                } else {
                    None
                }
            } else {
                None
            }
        };
        // md_files
        {
            let mut md = self.md_files.lock().unwrap();
            let renames: Vec<(String, String)> = md.keys()
                .filter_map(|k| rewrite(k).map(|nk| (k.clone(), nk)))
                .collect();
            for (old, new) in renames {
                if let Some(v) = md.remove(&old) {
                    md.insert(new, v);
                }
            }
        }
        Ok(())
    }

    async fn delete_collection(&self, abs_path: &str) -> Result<(), SyncProviderError> {
        self.check_failure().await?;
        let prefix = abs_path.trim_end_matches('/');
        if prefix.is_empty() {
            return Ok(());
        }
        // Drop every md_files entry under the prefix.
        let mut md = self.md_files.lock().unwrap();
        md.retain(|k, _| {
            if k == prefix { return false; }
            if let Some(rest) = k.strip_prefix(prefix) {
                !rest.starts_with('/')
            } else {
                true
            }
        });
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_put_get_object_round_trip() {
        let p = InMemorySyncProvider::new();
        p.put_object("abc123", b"hello").await.unwrap();
        let data = p.get_object("abc123").await.unwrap();
        assert_eq!(data, Some(b"hello".to_vec()));
    }

    #[tokio::test]
    async fn test_has_object() {
        let p = InMemorySyncProvider::new();
        assert!(!p.has_object("x").await.unwrap());
        p.put_object("x", b"data").await.unwrap();
        assert!(p.has_object("x").await.unwrap());
    }

    #[tokio::test]
    async fn test_get_missing_object_returns_none() {
        let p = InMemorySyncProvider::new();
        assert_eq!(p.get_object("nonexistent").await.unwrap(), None);
    }

    #[tokio::test]
    async fn test_put_get_ref_round_trip() {
        let p = InMemorySyncProvider::new();
        let v = p.put_ref("note1", b"ref-content").await.unwrap();
        let (content, version) = p.get_ref("note1").await.unwrap().unwrap();
        assert_eq!(content, b"ref-content");
        assert_eq!(version, v);
    }

    #[tokio::test]
    async fn test_put_get_device_state_round_trip() {
        let p = InMemorySyncProvider::new();
        p.put_device_state("device-A", b"state A").await.unwrap();
        let got = p.get_device_state("device-A").await.unwrap();
        assert_eq!(got.as_deref(), Some(b"state A".as_slice()));
    }

    #[tokio::test]
    async fn test_get_missing_device_state_returns_none() {
        let p = InMemorySyncProvider::new();
        assert!(p.get_device_state("nonexistent").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn test_list_device_states_empty() {
        let p = InMemorySyncProvider::new();
        assert!(p.list_device_states().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn test_list_device_states_multiple() {
        let p = InMemorySyncProvider::new();
        p.put_device_state("dev-A", b"a").await.unwrap();
        p.put_device_state("dev-B", b"b").await.unwrap();
        p.put_device_state("dev-C", b"c").await.unwrap();
        let list = p.list_device_states().await.unwrap();
        assert_eq!(list.len(), 3);
        let ids: Vec<&str> = list.iter().map(|d| d.device_id.as_str()).collect();
        assert!(ids.contains(&"dev-A"));
        assert!(ids.contains(&"dev-B"));
        assert!(ids.contains(&"dev-C"));
    }

    #[tokio::test]
    async fn test_overwrite_device_state() {
        let p = InMemorySyncProvider::new();
        p.put_device_state("dev-A", b"v1").await.unwrap();
        p.put_device_state("dev-A", b"v2").await.unwrap();
        let got = p.get_device_state("dev-A").await.unwrap();
        assert_eq!(got.as_deref(), Some(b"v2".as_slice()));
        assert_eq!(p.list_device_states().await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn test_branch_lifecycle() {
        let p = InMemorySyncProvider::new();
        // Create
        p.put_branch("note1", "dev-A-123", b"branch-data").await.unwrap();
        // List
        let branches = p.list_branches("note1").await.unwrap();
        assert_eq!(branches.len(), 1);
        assert_eq!(branches[0], "dev-A-123");
        // Get
        let data = p.get_branch("note1", "dev-A-123").await.unwrap();
        assert_eq!(data, Some(b"branch-data".to_vec()));
        // Delete
        p.delete_branch("note1", "dev-A-123").await.unwrap();
        assert!(p.list_branches("note1").await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn test_network_partition() {
        let p = InMemorySyncProvider::new();
        p.partition_network();
        let result = p.put_object("x", b"data").await;
        assert!(matches!(result, Err(SyncProviderError::NetworkError(_))));
        p.heal_network();
        p.put_object("x", b"data").await.unwrap();
    }

    #[tokio::test]
    async fn test_fail_next() {
        let p = InMemorySyncProvider::new();
        p.fail_next(SyncProviderError::QuotaExceeded);
        let result = p.put_object("x", b"data").await;
        assert!(matches!(result, Err(SyncProviderError::QuotaExceeded)));
        // Next call succeeds (fail_next is one-shot)
        p.put_object("x", b"data").await.unwrap();
    }
}
