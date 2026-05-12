//! Tier 1 Push Worker: processes DirtyQueue entries with debounce.
//! Runs as a background tokio task. Panic-safe via tokio::spawn isolation.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::core::cas::CasStore;
use crate::core::refs::RefStore;
use crate::core::sync_provider::SyncProvider;
use crate::core::version_dag::VersionDag;
use crate::features::sync_v2::attachment_store::AttachmentStore;
use crate::features::sync_v2::attachment_sync::AttachmentSync;
use crate::features::sync_v2::dirty_queue::{DirtyEntry, DirtyOperation, DirtyQueue, Lane};

const DEBOUNCE_MS: u64 = 1500;
const POLL_IDLE_MS: u64 = 500;

pub struct PushWorker {
    queue: Arc<DirtyQueue>,
    cas: Arc<CasStore>,
    ref_store: Arc<RefStore>,
    provider: Arc<dyn SyncProvider>,
    vault_path: PathBuf,
    stop_signal: Arc<AtomicBool>,
    /// Reachability flag set by offline_monitor. When `false`, the worker
    /// idles instead of attempting PUTs that would fail and pollute the log.
    /// Always-`true` if the engine never wires an offline monitor.
    online: Arc<AtomicBool>,
    /// User-facing pause flag. `false` = paused; queue is preserved but no
    /// PUTs are attempted. Resume triggers an immediate flush via the
    /// engine's `trigger_reconciliation_now`.
    sync_enabled: Arc<AtomicBool>,
    /// Track B Phase B-2: lazy-initialized attachment store + sync. None until
    /// the first AttachmentUpsert/Delete arrives — avoids paying load_from_disk
    /// cost on vaults that never use attachments.
    attachment_store: Mutex<Option<Arc<Mutex<AttachmentStore>>>>,
}

impl PushWorker {
    pub fn new(
        queue: Arc<DirtyQueue>,
        cas: Arc<CasStore>,
        ref_store: Arc<RefStore>,
        provider: Arc<dyn SyncProvider>,
        vault_path: PathBuf,
        stop_signal: Arc<AtomicBool>,
        online: Arc<AtomicBool>,
        sync_enabled: Arc<AtomicBool>,
    ) -> Self {
        Self {
            queue,
            cas,
            ref_store,
            provider,
            vault_path,
            stop_signal,
            online,
            sync_enabled,
            attachment_store: Mutex::new(None),
        }
    }

    /// Lazy-init the attachment store and **reload it from disk on every
    /// call**. The reload is critical: between worker batches, the user's
    /// `attachment_add` calls write fresh ref JSONs to disk that the cached
    /// in-memory map would otherwise miss, causing
    /// `push_attachment("...") -> Err("attachment_id ... not found")` and
    /// eventually a drop after max retries. The reload is `clear()` + read,
    /// so it's safe to repeat. Disk read of a few hundred small JSONs is
    /// negligible compared to a single chunk PUT.
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
        // Always reload — cheap, idempotent, prevents the cache-stale bug.
        arc.lock()
            .map_err(|e| format!("attachment_store reload lock: {}", e))?
            .load_from_disk()?;
        Ok(arc)
    }

    /// Resolve an `AttachmentUpsert.relative_path` to its `attachment_id`.
    /// `relative_path` is the ref JSON path (e.g.
    /// `.notology/attachments/refs/20260512123456.json`) — we strip dir + ext.
    fn extract_attachment_id(relative_path: &str) -> Option<String> {
        let p = std::path::Path::new(relative_path);
        p.file_stem().and_then(|s| s.to_str()).map(|s| s.to_string())
    }

    /// Start the push worker loop. Call inside tokio::spawn.
    pub async fn run(self: Arc<Self>) {
        log::info!("[push_worker] started");
        loop {
            if self.stop_signal.load(Ordering::Relaxed) { break; }

            // Skip work entirely while offline: dirty_queue retains the entries
            // and the upcoming online-recovery transition will trigger a flush.
            // This prevents repeated PUT attempts that would all fail and bloat
            // each entry's retry_count for no benefit.
            if !self.online.load(Ordering::Relaxed) {
                tokio::time::sleep(Duration::from_millis(POLL_IDLE_MS)).await;
                continue;
            }

            // Same idle behavior when the user has paused sync. Resume
            // triggers an immediate reconciliation via SyncEngine, so the
            // queue drains promptly without depending on this worker's poll.
            if !self.sync_enabled.load(Ordering::Relaxed) {
                tokio::time::sleep(Duration::from_millis(POLL_IDLE_MS)).await;
                continue;
            }

            let count = self.queue.count_lane(Lane::Fast).unwrap_or(0);
            if count == 0 {
                tokio::time::sleep(Duration::from_millis(POLL_IDLE_MS)).await;
                continue;
            }

            // Debounce: wait for writes to settle
            tokio::time::sleep(Duration::from_millis(DEBOUNCE_MS)).await;
            if self.stop_signal.load(Ordering::Relaxed) { break; }

            // Process batch
            let worker = Arc::clone(&self);
            match tokio::spawn(async move { worker.process_batch().await }).await {
                Ok(Ok(n)) => {
                    if n > 0 {
                        log::info!("[push_worker] processed {} entries", n);
                    }
                }
                Ok(Err(e)) => log::warn!("[push_worker] batch error: {}", e),
                Err(e) => log::error!("[push_worker] batch PANICKED: {:?}", e),
            }
        }
        log::info!("[push_worker] stopped");
    }

    async fn process_batch(&self) -> Result<usize, String> {
        // Track B 2026-05-12: PushWorker handles Fast lane only. Slow lane
        // (large attachments ≥100 MB) is owned by BackgroundWorker so a 1 GB
        // video upload doesn't block fast operations behind it.
        let entries = self.queue.list_pending_lane(Lane::Fast)?;
        let mut success = 0;
        for entry in entries {
            if self.stop_signal.load(Ordering::Relaxed) { break; }
            let entry_id = entry.id;
            match self.process_one(entry).await {
                Ok(()) => {
                    self.queue.dequeue(entry_id)?;
                    success += 1;
                }
                Err(e) => {
                    log::warn!("[push_worker] entry {} failed: {}", entry_id, e);
                    if !self.queue.mark_retry(entry_id, &e)? {
                        log::error!("[push_worker] entry {} dropped after max retries", entry_id);
                    }
                }
            }
        }
        Ok(success)
    }

    async fn process_one(&self, entry: DirtyEntry) -> Result<(), String> {
        match &entry.op {
            DirtyOperation::NoteUpsert { note_id, relative_path } => {
                self.push_single_note(note_id, relative_path).await
            }
            DirtyOperation::NoteDelete { note_id, relative_path } => {
                self.execute_delete(note_id, relative_path).await
            }
            DirtyOperation::NoteMove { note_id, old_path, new_path } => {
                self.execute_move(note_id, old_path, new_path).await
            }
            DirtyOperation::FolderCreate { relative_path } => {
                self.execute_folder_create(&relative_path).await
            }
            DirtyOperation::FolderDelete { relative_path } => {
                self.execute_folder_delete(&relative_path).await
            }
            // Track B Phase B-2 (2026-05-12): replaces the long-standing stubs.
            DirtyOperation::AttachmentUpsert { relative_path } => {
                self.push_attachment_upsert(relative_path).await
            }
            DirtyOperation::AttachmentDelete { relative_path } => {
                self.push_attachment_delete(relative_path).await
            }
            DirtyOperation::YamlChange { relative_path } => {
                log::debug!("[push_worker] yaml change stub: {}", relative_path);
                Ok(())
            }
            DirtyOperation::MetaChange { kind, relative_path } => {
                log::debug!("[push_worker] meta change stub: {:?} {}", kind, relative_path);
                Ok(())
            }
        }
    }

    /// Push a single note: objects → DAG → .md → ref.
    /// Adapted from ref_sync.rs execute_push but for single note.
    async fn push_single_note(&self, note_id: &str, relative_path: &str) -> Result<(), String> {
        let local_ref = self.ref_store.get(note_id)
            .map_err(|e| format!("read ref: {}", e))?
            .ok_or_else(|| format!("ref {} not found", note_id))?;

        // 1. Push head object
        if let Ok(Some(content)) = self.cas.read_object(&local_ref.head_hash) {
            // Skip if already on remote
            if !self.provider.has_object(&local_ref.head_hash).await.unwrap_or(false) {
                self.provider.put_object(&local_ref.head_hash, &content).await
                    .map_err(|e| format!("put_object: {}", e))?;
            }
            // Push .md file
            let normalized_path = relative_path.replace('\\', "/");
            self.provider.put_md(&normalized_path, &content).await
                .map_err(|e| format!("put_md: {}", e))?;
        }

        // 2. Push DAG
        let dag = VersionDag::load(&self.vault_path, note_id)
            .map_err(|e| format!("load DAG: {}", e))?;
        let dag_bytes = serde_json::to_vec_pretty(&dag)
            .map_err(|e| format!("serialize DAG: {}", e))?;
        self.provider.put_dag(note_id, &dag_bytes).await
            .map_err(|e| format!("put_dag: {}", e))?;

        // 3. Push ref (commit point, last). Capture the returned
        //    RefVersion so we can record it as the local sync_etag —
        //    this is the marker that says "this ref has been pushed
        //    to NAS at least once", used by Track H to distinguish
        //    a brand-new local note from a NAS-deletion.
        let ref_bytes = serde_json::to_vec_pretty(&local_ref)
            .map_err(|e| format!("serialize ref: {}", e))?;
        let version = self.provider.put_ref(note_id, &ref_bytes).await
            .map_err(|e| format!("put_ref: {}", e))?;

        // 4. Persist sync_etag locally. Best-effort: if this fails we
        //    log but don't fail the push — the etag is a hint, not
        //    correctness-critical, and re-pushing rewrites it anyway.
        let mut local_ref = local_ref;
        local_ref.sync_etag = Some(version.0);
        if let Err(e) = self.ref_store.set(&local_ref) {
            log::warn!("[push_worker] persist sync_etag failed (non-fatal) for {}: {}", note_id, e);
        }

        log::info!("[push_worker] pushed note {}: {}", note_id, &local_ref.head_hash[..16]);
        Ok(())
    }

    async fn execute_delete(&self, note_id: &str, relative_path: &str) -> Result<(), String> {
        let normalized = relative_path.replace('\\', "/");
        let _ = self.provider.delete_md(&normalized).await;
        let _ = self.provider.delete_ref(note_id).await;
        log::info!("[push_worker] deleted note {}", note_id);
        Ok(())
    }

    async fn execute_move(&self, note_id: &str, old_path: &str, new_path: &str) -> Result<(), String> {
        let old_normalized = old_path.replace('\\', "/");
        let new_normalized = new_path.replace('\\', "/");

        // Read content from new local path
        let local_path = self.vault_path.join(new_path);
        let content = std::fs::read(&local_path)
            .map_err(|e| format!("read moved file: {}", e))?;

        // Push to new location
        self.provider.put_md(&new_normalized, &content).await
            .map_err(|e| format!("put_md new: {}", e))?;

        // Update ref with new path
        if let Some(mut note_ref) = self.ref_store.get(note_id).map_err(|e| format!("get ref: {}", e))? {
            note_ref.relative_path = new_normalized.clone();
            note_ref.updated_at = chrono::Utc::now();
            self.ref_store.set(&note_ref).map_err(|e| format!("set ref: {}", e))?;
            let ref_bytes = serde_json::to_vec_pretty(&note_ref)
                .map_err(|e| format!("serialize ref: {}", e))?;
            let version = self.provider.put_ref(note_id, &ref_bytes).await
                .map_err(|e| format!("put_ref: {}", e))?;
            // Track sync_etag (see execute_push comment).
            note_ref.sync_etag = Some(version.0);
            if let Err(e) = self.ref_store.set(&note_ref) {
                log::warn!("[push_worker] persist sync_etag on move failed (non-fatal) for {}: {}", note_id, e);
            }
        }

        // Delete old location on NAS
        let _ = self.provider.delete_md(&old_normalized).await;

        log::info!("[push_worker] moved note {}: {} → {}", note_id, old_normalized, new_normalized);
        Ok(())
    }

    async fn execute_folder_create(&self, relative_path: &str) -> Result<(), String> {
        let normalized = relative_path.replace('\\', "/");
        // Use put_md path logic to ensure parents, then the folder itself
        // WebDAV MKCOL via ensure_parents handles this
        let full_path = format!("{}/{}",
            self.vault_path.to_string_lossy(), // not used for remote
            normalized);
        // Actually we need provider-level mkdir. Use put_md with empty content as workaround,
        // or better: ensure the folder note push already creates the folder via ensure_parents.
        // Folder creation on NAS happens automatically when push_single_note pushes the folder note
        // (put_md calls ensure_parents). So this is effectively a no-op.
        log::info!("[push_worker] folder create: {} (auto via note push)", normalized);
        Ok(())
    }

    /// Track B Phase B-2 — push an attachment (CAS blob + ref JSON).
    /// `relative_path` is the ref JSON path under the vault, e.g.
    /// `.notology/attachments/refs/20260512123456.json`.
    async fn push_attachment_upsert(&self, relative_path: &str) -> Result<(), String> {
        let id = Self::extract_attachment_id(relative_path)
            .ok_or_else(|| format!("cannot extract attachment_id from {}", relative_path))?;
        let store = self.ensure_attachment_store()?;
        let sync = AttachmentSync::new(self.provider.clone());
        let outcome = sync.push_attachment(&store, &id).await?;
        log::info!(
            "[push_worker] attachment {} pushed (blob_uploaded={}, size={})",
            id, outcome.blob_uploaded, outcome.size_bytes
        );
        Ok(())
    }

    async fn push_attachment_delete(&self, relative_path: &str) -> Result<(), String> {
        let id = Self::extract_attachment_id(relative_path)
            .ok_or_else(|| format!("cannot extract attachment_id from {}", relative_path))?;
        let store = self.ensure_attachment_store()?;
        let sync = AttachmentSync::new(self.provider.clone());
        sync.push_deletion(&store, &id).await?;
        log::info!("[push_worker] attachment {} deleted on NAS", id);
        Ok(())
    }

    async fn execute_folder_delete(&self, relative_path: &str) -> Result<(), String> {
        let normalized = relative_path.replace('\\', "/");
        // Delete the folder on NAS via delete_md (WebDAV DELETE works on directories too)
        match self.provider.delete_md(&normalized).await {
            Ok(()) => log::info!("[push_worker] deleted folder on NAS: {}", normalized),
            Err(e) => {
                // Folder might already be gone or non-empty — log but don't fail
                log::warn!("[push_worker] folder delete on NAS (best-effort): {} - {}", normalized, e);
            }
        }
        Ok(())
    }
}
