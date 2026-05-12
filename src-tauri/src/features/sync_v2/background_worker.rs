//! Background sync worker — drains the Slow lane (large attachments ≥100 MB).
//!
//! Runs alongside `PushWorker` (which owns the Fast lane). The two workers are
//! independent tokio tasks reading from the same SQLite-backed `DirtyQueue` but
//! filtered by `Lane`. This lets a 1 GB video upload proceed in parallel with
//! small note saves without head-of-line blocking.
//!
//! Design choices for the Slow lane:
//!   - concurrency = 1 (one big PUT at a time; Synology throttles concurrent
//!     large uploads worse than concurrent small ones)
//!   - poll interval = 3 s (vs. 0.5 s for fast) — slow lane churn is rare
//!   - debounce = 0 (large files don't get batched edits; push immediately
//!     once dirty)
//!   - retry budget shared with `DirtyQueue::mark_retry` — 5 attempts max
//!
//! Confirmed by HanBin 2026-05-12 (§4.4 option 2: two-tier queue).

#![allow(dead_code)]

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::core::sync_provider::SyncProvider;
use crate::features::sync_v2::attachment_store::AttachmentStore;
use crate::features::sync_v2::attachment_sync::AttachmentSync;
use crate::features::sync_v2::dirty_queue::{DirtyEntry, DirtyOperation, DirtyQueue, Lane};

const POLL_IDLE_MS: u64 = 3000;

pub struct BackgroundWorker {
    queue: Arc<DirtyQueue>,
    provider: Arc<dyn SyncProvider>,
    vault_path: PathBuf,
    stop_signal: Arc<AtomicBool>,
    online: Arc<AtomicBool>,
    sync_enabled: Arc<AtomicBool>,
    attachment_store: Mutex<Option<Arc<Mutex<AttachmentStore>>>>,
}

impl BackgroundWorker {
    pub fn new(
        queue: Arc<DirtyQueue>,
        provider: Arc<dyn SyncProvider>,
        vault_path: PathBuf,
        stop_signal: Arc<AtomicBool>,
        online: Arc<AtomicBool>,
        sync_enabled: Arc<AtomicBool>,
    ) -> Self {
        Self {
            queue,
            provider,
            vault_path,
            stop_signal,
            online,
            sync_enabled,
            attachment_store: Mutex::new(None),
        }
    }

    pub async fn run(self: Arc<Self>) {
        log::info!("[background_worker] started (Slow lane)");
        loop {
            if self.stop_signal.load(Ordering::Relaxed) {
                break;
            }
            if !self.online.load(Ordering::Relaxed) || !self.sync_enabled.load(Ordering::Relaxed) {
                tokio::time::sleep(Duration::from_millis(POLL_IDLE_MS)).await;
                continue;
            }
            let count = self.queue.count_lane(Lane::Slow).unwrap_or(0);
            if count == 0 {
                tokio::time::sleep(Duration::from_millis(POLL_IDLE_MS)).await;
                continue;
            }

            // No debounce: large files take seconds-to-minutes, the user is
            // already committed to the action. Just push.
            let worker = Arc::clone(&self);
            match tokio::spawn(async move { worker.process_batch().await }).await {
                Ok(Ok(n)) => {
                    if n > 0 {
                        log::info!("[background_worker] processed {} slow-lane entries", n);
                    }
                }
                Ok(Err(e)) => log::warn!("[background_worker] batch error: {}", e),
                Err(e) => log::error!("[background_worker] batch PANICKED: {:?}", e),
            }
        }
        log::info!("[background_worker] stopped");
    }

    async fn process_batch(&self) -> Result<usize, String> {
        let entries = self.queue.list_pending_lane(Lane::Slow)?;
        let mut success = 0;
        for entry in entries {
            if self.stop_signal.load(Ordering::Relaxed) {
                break;
            }
            let entry_id = entry.id;
            match self.process_one(entry).await {
                Ok(()) => {
                    self.queue.dequeue(entry_id)?;
                    success += 1;
                }
                Err(e) => {
                    log::warn!("[background_worker] entry {} failed: {}", entry_id, e);
                    if !self.queue.mark_retry(entry_id, &e)? {
                        log::error!(
                            "[background_worker] entry {} dropped after max retries",
                            entry_id
                        );
                    }
                }
            }
        }
        Ok(success)
    }

    async fn process_one(&self, entry: DirtyEntry) -> Result<(), String> {
        match &entry.op {
            DirtyOperation::AttachmentUpsert { relative_path } => {
                self.push_attachment_upsert(relative_path).await
            }
            DirtyOperation::AttachmentDelete { relative_path } => {
                self.push_attachment_delete(relative_path).await
            }
            other => {
                // Slow lane is reserved for large attachments. Anything else
                // here is a misroute — log and drop so it doesn't keep retrying.
                log::warn!("[background_worker] unexpected slow-lane op: {:?}", other);
                Ok(())
            }
        }
    }

    async fn push_attachment_upsert(&self, relative_path: &str) -> Result<(), String> {
        let id = extract_attachment_id(relative_path)
            .ok_or_else(|| format!("cannot extract attachment_id from {}", relative_path))?;
        let store = self.ensure_attachment_store()?;
        let sync = AttachmentSync::new(self.provider.clone());
        let outcome = sync.push_attachment(&store, &id).await?;
        log::info!(
            "[background_worker] attachment {} pushed (slow lane, size={} MB)",
            id,
            outcome.size_bytes / (1024 * 1024)
        );
        Ok(())
    }

    async fn push_attachment_delete(&self, relative_path: &str) -> Result<(), String> {
        let id = extract_attachment_id(relative_path)
            .ok_or_else(|| format!("cannot extract attachment_id from {}", relative_path))?;
        let store = self.ensure_attachment_store()?;
        let sync = AttachmentSync::new(self.provider.clone());
        sync.push_deletion(&store, &id).await?;
        log::info!("[background_worker] attachment {} deleted on NAS (slow lane)", id);
        Ok(())
    }

    /// See [`PushWorker::ensure_attachment_store`] — same reload-every-call
    /// contract. Without the reload, an `attachment_add` call that completes
    /// between two background-worker batches has its ref invisible to the
    /// worker's cached store and the upload silently retries until dropped.
    fn ensure_attachment_store(&self) -> Result<Arc<Mutex<AttachmentStore>>, String> {
        let mut g = self.attachment_store.lock().unwrap();
        let arc = if let Some(s) = g.as_ref() {
            Arc::clone(s)
        } else {
            let store = AttachmentStore::new(self.vault_path.clone())?;
            let arc = Arc::new(Mutex::new(store));
            *g = Some(Arc::clone(&arc));
            arc
        };
        arc.lock()
            .map_err(|e| format!("attachment_store reload lock: {}", e))?
            .load_from_disk()?;
        Ok(arc)
    }
}

fn extract_attachment_id(relative_path: &str) -> Option<String> {
    std::path::Path::new(relative_path)
        .file_stem()
        .and_then(|s| s.to_str())
        .map(|s| s.to_string())
}
