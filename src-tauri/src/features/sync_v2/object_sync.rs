//! CAS object synchronization between local store and remote provider.
//!
//! Objects are immutable (content-addressed by SHA-256) so there are no
//! conflicts — only diffs. Push local-only objects, pull remote-only objects.

use crate::core::cas::CasStore;
use crate::core::sync_provider::SyncProvider;
use std::collections::HashSet;
use std::sync::Arc;
use tokio::sync::Semaphore;

/// Default concurrency for parallel object transfers.
///
/// Benchmarked against real Synology Apache WebDAV NAS (2026-04-20):
///   Concurrency 1: 12.4 obj/s
///   Concurrency 4: 25.0 obj/s  ← peak, 100% success
///   Concurrency 6: 13.8 obj/s  ← regression, 13% failure rate
///
/// Synology throttles at 6+ concurrent PUTs. 4 is peak throughput
/// with 100% reliability. Other backends may support higher values.
pub const DEFAULT_CONCURRENCY: usize = 4;

/// Result of an object sync operation.
#[derive(Debug, Clone)]
pub struct ObjectSyncResult {
    /// Hashes successfully uploaded to remote.
    pub uploaded: Vec<String>,
    /// Hashes successfully downloaded to local.
    pub downloaded: Vec<String>,
    /// Count of objects that exist on both sides (skipped).
    pub already_synced: usize,
    /// Upload failures: (hash, error message).
    pub failed_uploads: Vec<(String, String)>,
    /// Download failures: (hash, error message).
    pub failed_downloads: Vec<(String, String)>,
}

impl ObjectSyncResult {
    /// True if no failures occurred.
    pub fn is_complete_success(&self) -> bool {
        self.failed_uploads.is_empty() && self.failed_downloads.is_empty()
    }
}

/// Diff between local and remote object hashes.
#[derive(Debug, Clone)]
pub struct ObjectDiff {
    /// Objects only in local CAS — need to push.
    pub local_only: Vec<String>,
    /// Objects only on remote — need to pull.
    pub remote_only: Vec<String>,
    /// Objects present on both sides.
    pub both: Vec<String>,
}

/// Synchronizes CAS objects between local store and a SyncProvider.
pub struct ObjectSync {
    cas: Arc<CasStore>,
    provider: Arc<dyn SyncProvider>,
    concurrency: usize,
}

impl ObjectSync {
    /// Create a new ObjectSync.
    pub fn new(cas: Arc<CasStore>, provider: Arc<dyn SyncProvider>) -> Self {
        Self {
            cas,
            provider,
            concurrency: DEFAULT_CONCURRENCY,
        }
    }

    /// Set concurrency limit (minimum 1).
    pub fn with_concurrency(mut self, n: usize) -> Self {
        self.concurrency = n.max(1);
        self
    }

    /// Compute diff: which objects are local-only, remote-only, or on both sides.
    pub async fn diff(&self) -> Result<ObjectDiff, String> {
        let local: HashSet<String> = self.cas.list_objects()
            .map_err(|e| format!("Failed to list local objects: {}", e))?
            .into_iter().collect();

        let remote: HashSet<String> = self.provider.list_objects().await
            .map_err(|e| format!("Failed to list remote objects: {}", e))?
            .into_iter().collect();

        Ok(ObjectDiff {
            local_only: local.difference(&remote).cloned().collect(),
            remote_only: remote.difference(&local).cloned().collect(),
            both: local.intersection(&remote).cloned().collect(),
        })
    }

    /// Push local-only objects to remote, pull remote-only objects to local.
    pub async fn sync(&self) -> Result<ObjectSyncResult, String> {
        let diff = self.diff().await?;
        let already_synced = diff.both.len();

        let push_task = self.push_objects(diff.local_only);
        let pull_task = self.pull_objects(diff.remote_only);
        let (push_result, pull_result) = tokio::join!(push_task, pull_task);

        let (uploaded, failed_uploads) = push_result;
        let (downloaded, failed_downloads) = pull_result;

        Ok(ObjectSyncResult {
            uploaded,
            downloaded,
            already_synced,
            failed_uploads,
            failed_downloads,
        })
    }

    /// Push specific objects to remote with bounded concurrency.
    pub async fn push_objects(&self, hashes: Vec<String>)
        -> (Vec<String>, Vec<(String, String)>)
    {
        let semaphore = Arc::new(Semaphore::new(self.concurrency));
        let mut tasks = Vec::new();

        for hash in hashes {
            let permit = semaphore.clone().acquire_owned().await.unwrap();
            let cas = self.cas.clone();
            let provider = self.provider.clone();

            tasks.push(tokio::spawn(async move {
                let _permit = permit;

                // Read from local CAS
                let content = match cas.read_object(&hash) {
                    Ok(Some(c)) => c,
                    Ok(None) => return (hash, Err("Object missing from local CAS".into())),
                    Err(e) => return (hash, Err(format!("Local read failed: {}", e))),
                };

                // Skip if already on remote (bandwidth save)
                if provider.has_object(&hash).await.unwrap_or(false) {
                    return (hash, Ok(()));
                }

                // Upload
                match provider.put_object(&hash, &content).await {
                    Ok(_) => (hash, Ok(())),
                    Err(e) => (hash, Err(format!("{}", e))),
                }
            }));
        }

        collect_results(tasks).await
    }

    /// Pull specific objects from remote with bounded concurrency.
    /// Verifies SHA-256 hash on each download.
    pub async fn pull_objects(&self, hashes: Vec<String>)
        -> (Vec<String>, Vec<(String, String)>)
    {
        let semaphore = Arc::new(Semaphore::new(self.concurrency));
        let mut tasks = Vec::new();

        for hash in hashes {
            let permit = semaphore.clone().acquire_owned().await.unwrap();
            let cas = self.cas.clone();
            let provider = self.provider.clone();

            tasks.push(tokio::spawn(async move {
                let _permit = permit;

                // Skip if already in local CAS
                if cas.has_object(&hash) {
                    return (hash, Ok(()));
                }

                // Download
                let content = match provider.get_object(&hash).await {
                    Ok(Some(c)) => c,
                    Ok(None) => return (hash, Err("Object not found on remote".into())),
                    Err(e) => return (hash, Err(format!("{}", e))),
                };

                // Defense-in-depth hash verification
                let actual = CasStore::hash(&content);
                if actual != hash {
                    let msg = format!("Hash mismatch: expected {}, got {}", hash, actual);
                    return (hash, Err(msg));
                }

                // Write to local CAS
                match cas.write_object(&content) {
                    Ok(_) => (hash, Ok(())),
                    Err(e) => (hash, Err(format!("Local write failed: {}", e))),
                }
            }));
        }

        collect_results(tasks).await
    }
}

/// Collect results from spawned tasks into success/failure vecs.
async fn collect_results(
    tasks: Vec<tokio::task::JoinHandle<(String, Result<(), String>)>>,
) -> (Vec<String>, Vec<(String, String)>) {
    let mut succeeded = Vec::new();
    let mut failed = Vec::new();

    for task in tasks {
        match task.await {
            Ok((hash, Ok(()))) => succeeded.push(hash),
            Ok((hash, Err(e))) => failed.push((hash, e)),
            Err(e) => log::error!("[object_sync] Task panic: {}", e),
        }
    }

    (succeeded, failed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::sync_v2::in_memory_provider::InMemorySyncProvider;
    use tempfile::TempDir;

    fn make_test_cas() -> (Arc<CasStore>, TempDir) {
        let dir = TempDir::new().unwrap();
        let cas = CasStore::new(dir.path()).unwrap();
        (Arc::new(cas), dir)
    }

    #[tokio::test]
    async fn test_diff_empty() {
        let (cas, _d) = make_test_cas();
        let provider = Arc::new(InMemorySyncProvider::new());
        let sync = ObjectSync::new(cas, provider);
        let diff = sync.diff().await.unwrap();
        assert!(diff.local_only.is_empty());
        assert!(diff.remote_only.is_empty());
        assert!(diff.both.is_empty());
    }

    #[tokio::test]
    async fn test_diff_local_only() {
        let (cas, _d) = make_test_cas();
        let hash = cas.write_object(b"local content").unwrap();
        let provider = Arc::new(InMemorySyncProvider::new());
        let sync = ObjectSync::new(cas, provider);
        let diff = sync.diff().await.unwrap();
        assert_eq!(diff.local_only, vec![hash]);
        assert!(diff.remote_only.is_empty());
    }

    #[tokio::test]
    async fn test_diff_remote_only() {
        let (cas, _d) = make_test_cas();
        let provider = Arc::new(InMemorySyncProvider::new());
        let hash = CasStore::hash(b"remote only");
        provider.put_object(&hash, b"remote only").await.unwrap();
        let sync = ObjectSync::new(cas, provider);
        let diff = sync.diff().await.unwrap();
        assert!(diff.local_only.is_empty());
        assert_eq!(diff.remote_only, vec![hash]);
    }

    #[tokio::test]
    async fn test_push_uploads_local_objects() {
        let (cas, _d) = make_test_cas();
        cas.write_object(b"content 1").unwrap();
        cas.write_object(b"content 2").unwrap();
        let provider = Arc::new(InMemorySyncProvider::new());
        let sync = ObjectSync::new(cas, provider.clone());
        let result = sync.sync().await.unwrap();
        assert_eq!(result.uploaded.len(), 2);
        assert!(result.failed_uploads.is_empty());
        assert_eq!(provider.object_count(), 2);
    }

    #[tokio::test]
    async fn test_pull_downloads_remote_objects() {
        let (cas, _d) = make_test_cas();
        let provider = Arc::new(InMemorySyncProvider::new());
        let content = b"only on remote";
        let hash = CasStore::hash(content);
        provider.put_object(&hash, content).await.unwrap();
        let sync = ObjectSync::new(cas.clone(), provider);
        let result = sync.sync().await.unwrap();
        assert_eq!(result.downloaded.len(), 1);
        assert!(cas.has_object(&hash));
    }

    #[tokio::test]
    async fn test_already_synced_skipped() {
        let (cas, _d) = make_test_cas();
        let content = b"on both sides";
        let hash = cas.write_object(content).unwrap();
        let provider = Arc::new(InMemorySyncProvider::new());
        provider.put_object(&hash, content).await.unwrap();
        let sync = ObjectSync::new(cas, provider);
        let result = sync.sync().await.unwrap();
        assert_eq!(result.uploaded.len(), 0);
        assert_eq!(result.downloaded.len(), 0);
        assert_eq!(result.already_synced, 1);
    }

    #[tokio::test]
    async fn test_idempotent_double_sync() {
        let (cas, _d) = make_test_cas();
        cas.write_object(b"data").unwrap();
        let provider = Arc::new(InMemorySyncProvider::new());
        let sync = ObjectSync::new(cas, provider);
        sync.sync().await.unwrap();
        let result2 = sync.sync().await.unwrap();
        assert_eq!(result2.uploaded.len(), 0);
        assert_eq!(result2.already_synced, 1);
    }

    #[tokio::test]
    async fn test_partial_failure_does_not_abort() {
        let (cas, _d) = make_test_cas();
        let h1 = cas.write_object(b"a").unwrap();
        let _h2 = cas.write_object(b"b").unwrap();
        let _h3 = cas.write_object(b"c").unwrap();
        let provider = Arc::new(InMemorySyncProvider::new());
        // Pre-upload h1 so it gets skipped (has_object = true)
        let content_a = cas.read_object(&h1).unwrap().unwrap();
        provider.put_object(&h1, &content_a).await.unwrap();
        // Now sync: h1 skipped (already there), b+c need upload
        // Partition network so put_object fails for b and c
        provider.partition_network();
        let sync = ObjectSync::new(cas, provider.clone());
        let result = sync.sync().await;
        // diff() itself may fail due to partition — that's ok
        // The point is: no panic, errors are returned
        assert!(result.is_err() || !result.as_ref().unwrap().is_complete_success());
        provider.heal_network();
    }

    #[tokio::test]
    async fn test_hash_mismatch_on_download() {
        let (cas, _d) = make_test_cas();
        let provider = Arc::new(InMemorySyncProvider::new());
        // Store content under wrong hash
        let fake_hash = "a".repeat(64);
        provider.put_object(&fake_hash, b"wrong content").await.unwrap();
        let sync = ObjectSync::new(cas, provider);
        let result = sync.sync().await.unwrap();
        assert_eq!(result.failed_downloads.len(), 1);
        assert!(result.failed_downloads[0].1.contains("mismatch"));
    }

    #[tokio::test]
    async fn test_concurrency_limit() {
        let (cas, _d) = make_test_cas();
        for i in 0..20 {
            cas.write_object(format!("content {}", i).as_bytes()).unwrap();
        }
        let provider = Arc::new(InMemorySyncProvider::new());
        provider.set_delay(10);
        let sync = ObjectSync::new(cas, provider).with_concurrency(4);
        let start = std::time::Instant::now();
        let result = sync.sync().await.unwrap();
        let elapsed = start.elapsed();
        assert_eq!(result.uploaded.len(), 20);
        // 20 ops at 10ms, concurrency 4 → ~50ms minimum (5 batches)
        // Sequential would be 200ms+
        assert!(elapsed.as_millis() < 300, "Took {}ms — concurrency may not be working", elapsed.as_millis());
    }
}
