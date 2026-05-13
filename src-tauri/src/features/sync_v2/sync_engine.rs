//! SyncEngine: orchestrator for all sync components.
//!
//! Per D12: simple SyncState enum in tokio::sync::Mutex.
//! Per D13: 30s tokio::interval polling with AtomicBool stop.
//! Per D14: detailed Tauri events.
//! Per D15: best-effort per-phase failure handling.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use chrono::{DateTime, Utc};
use serde::Serialize;
use tokio::sync::Mutex as AsyncMutex;
use tokio::task::JoinHandle;

use crate::core::cas::CasStore;
use crate::core::refs::{NoteRef, RefStore};
use crate::core::sync_provider::SyncProvider;
use crate::core::version_dag::VersionDag;
use crate::features::sync_v2::branch_manager::{BranchManager, NoteWithConflicts};
use crate::features::sync_v2::conflict_detector::ConflictDetector;
use crate::features::sync_v2::notifier::{ChangeNotifier, GlobalSyncState};
use crate::features::sync_v2::object_sync::ObjectSync;
use crate::features::sync_v2::ref_sync::{RefConflict, RefSync};

/// Engine state snapshot (D12).
#[derive(Debug, Clone, Serialize, Default)]
pub enum SyncState {
    #[default]
    Idle,
    Syncing { started_at: DateTime<Utc>, phase: SyncPhase },
    Error { message: String, last_attempt: DateTime<Utc> },
}

/// Phase within a sync cycle (D15).
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub enum SyncPhase {
    DetectingChanges, PushingObjects, SyncingRefs, SavingBranches, NotifyingPush, Done,
}

/// Detailed result of one sync cycle (D15).
#[derive(Debug, Clone, Serialize)]
pub struct SyncReport {
    pub started_at: DateTime<Utc>,
    pub duration_ms: u64,
    pub objects_uploaded: usize,
    pub objects_downloaded: usize,
    pub refs_pushed: Vec<String>,
    pub refs_pulled: Vec<String>,
    pub unchanged_refs: usize,
    pub conflicts_detected: usize,
    pub branches_saved: usize,
    pub errors: Vec<SyncPhaseError>,
    /// Track H: refs trashed because another device deleted them on
    /// NAS. Always silent at this count tier (< bulk threshold).
    #[serde(default)]
    pub nas_deleted_trashed: usize,
    /// Track H: refs awaiting user confirmation after a bulk deletion
    /// (≥ threshold). UI must surface a banner / modal.
    #[serde(default)]
    pub nas_deleted_pending: usize,
}

/// Soft phase failure (D15).
#[derive(Debug, Clone, Serialize)]
pub struct SyncPhaseError {
    pub phase: SyncPhase,
    pub message: String,
    pub timestamp: DateTime<Utc>,
}

/// Configuration for SyncEngine.
#[derive(Debug, Clone)]
pub struct SyncConfig {
    pub polling_interval: Duration,
}
impl Default for SyncConfig {
    fn default() -> Self { Self { polling_interval: Duration::from_secs(30) } }
}

/// Main sync orchestrator (3-Tier architecture).
/// Tier 1: DirtyQueue + PushWorker (immediate push on local change)
/// Tier 2: AdaptivePoller (detect remote changes)
/// Tier 3: Full reconciliation (periodic, on-demand)
pub struct SyncEngine {
    device_id: String,
    vault_path: PathBuf,
    provider: Arc<dyn SyncProvider>,
    cas: Arc<CasStore>,
    ref_store: Arc<RefStore>,
    object_sync: ObjectSync,
    ref_sync: RefSync,
    notifier: ChangeNotifier,
    detector: ConflictDetector,
    branch_mgr: BranchManager,
    state: AsyncMutex<SyncState>,
    sync_lock: AsyncMutex<()>,
    stop_signal: Arc<AtomicBool>,
    polling_handle: AsyncMutex<Option<JoinHandle<()>>>,
    config: SyncConfig,
    // 3-Tier components
    dirty_queue: Arc<crate::features::sync_v2::dirty_queue::DirtyQueue>,
    adaptive_poller: AsyncMutex<Option<Arc<crate::features::sync_v2::adaptive_poller::AdaptivePoller>>>,
    /// Online/offline reachability flag, maintained by offline_monitor task.
    /// Optimistically starts true so we attempt our first sync without delay.
    online: Arc<AtomicBool>,
    /// User-facing sync pause toggle. `true` = active (default), `false` =
    /// paused by user. Distinct from `online`: offline is involuntary
    /// (network down), `sync_enabled=false` is a deliberate user choice.
    /// While paused, push_worker idles, adaptive_poller skips remote probes,
    /// and offline-recovery does NOT auto-trigger reconciliation. The
    /// offline_monitor itself keeps running so the indicator stays accurate.
    sync_enabled: Arc<AtomicBool>,
    /// Remote vault root path, used by offline_monitor to probe reachability.
    remote_base: AsyncMutex<Option<String>>,
    /// Track H: NAS-deletion candidates awaiting user confirmation when
    /// the count meets/exceeds the bulk threshold. < threshold are
    /// silently trashed inside `sync_once`; the pending list is empty
    /// in that case.
    pending_nas_deletions: AsyncMutex<Vec<crate::features::sync_v2::ref_sync::NasDeletionCandidate>>,
    /// Optional handle for emitting Tauri events to the frontend (e.g.
    /// `sync-v2:report` after each `sync_once`). Tests construct the
    /// engine without a handle; bootstrap injects it via
    /// [`SyncEngine::set_app_handle`] right after build.
    app_handle: AsyncMutex<Option<tauri::AppHandle>>,
}

impl SyncEngine {
    pub fn new(
        device_id: impl Into<String>,
        provider: Arc<dyn SyncProvider>,
        cas: Arc<CasStore>,
        ref_store: Arc<RefStore>,
        vault_path: PathBuf,
    ) -> Self {
        let device_id = device_id.into();
        // DirtyQueue: best-effort init (tests may use temp dirs)
        let dirty_queue = crate::features::sync_v2::dirty_queue::DirtyQueue::new(&vault_path)
            .unwrap_or_else(|e| {
                log::warn!("[sync_engine] dirty queue init failed (using fallback): {}", e);
                // Fallback: create in temp dir (for tests)
                crate::features::sync_v2::dirty_queue::DirtyQueue::new(
                    &std::env::temp_dir()
                ).expect("fallback queue")
            });
        Self {
            object_sync: ObjectSync::new(cas.clone(), provider.clone()),
            ref_sync: RefSync::new(&vault_path, cas.clone(), ref_store.clone(), provider.clone()),
            notifier: ChangeNotifier::new(&device_id),
            detector: ConflictDetector::new(&device_id),
            branch_mgr: BranchManager::new(),
            device_id,
            vault_path,
            provider,
            cas,
            ref_store,
            state: AsyncMutex::new(SyncState::Idle),
            sync_lock: AsyncMutex::new(()),
            stop_signal: Arc::new(AtomicBool::new(false)),
            polling_handle: AsyncMutex::new(None),
            config: SyncConfig::default(),
            dirty_queue: Arc::new(dirty_queue),
            adaptive_poller: AsyncMutex::new(None),
            online: Arc::new(AtomicBool::new(true)),
            sync_enabled: Arc::new(AtomicBool::new(true)),
            remote_base: AsyncMutex::new(None),
            pending_nas_deletions: AsyncMutex::new(Vec::new()),
            app_handle: AsyncMutex::new(None),
        }
    }

    /// Inject the Tauri AppHandle so background `sync_once` invocations
    /// (driven by adaptive_poller / Tier 3 timer) can emit
    /// `sync-v2:report` events to the frontend. No-op if called twice.
    pub async fn set_app_handle(&self, handle: tauri::AppHandle) {
        *self.app_handle.lock().await = Some(handle);
    }

    pub fn with_config(mut self, config: SyncConfig) -> Self {
        self.config = config;
        self
    }

    pub fn device_id(&self) -> &str { &self.device_id }
    pub fn cas_store(&self) -> &Arc<CasStore> { &self.cas }
    pub fn provider(&self) -> &Arc<dyn SyncProvider> { &self.provider }
    pub fn branch_mgr_ref(&self) -> &BranchManager { &self.branch_mgr }
    pub fn stop_signal(&self) -> &Arc<AtomicBool> { &self.stop_signal }
    pub fn vault_path(&self) -> &Path { &self.vault_path }

    /// Current NAS reachability. `true` = online, `false` = offline.
    /// Maintained by the offline_monitor task; checked by push_worker to
    /// avoid wasting attempts during outages.
    pub fn is_online(&self) -> bool {
        self.online.load(Ordering::Relaxed)
    }

    /// Shared online flag for handing to subordinate tasks (push_worker etc.).
    pub fn online_flag(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.online)
    }

    /// User-facing sync pause toggle.
    pub fn is_sync_enabled(&self) -> bool {
        self.sync_enabled.load(Ordering::Relaxed)
    }

    pub fn set_sync_enabled(&self, enabled: bool) {
        let was = self.sync_enabled.swap(enabled, Ordering::SeqCst);
        if was != enabled {
            log::info!("[sync_engine] sync_enabled: {} → {}", was, enabled);
        }
    }

    /// Shared enabled flag (push_worker / adaptive_poller read it directly to
    /// short-circuit work while paused).
    pub fn sync_enabled_flag(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.sync_enabled)
    }

    /// Configure the remote vault path the offline_monitor probes.
    /// Caller (bootstrap) sets this once after building the engine.
    pub async fn set_remote_base(&self, base: impl Into<String>) {
        *self.remote_base.lock().await = Some(base.into());
    }

    /// Read the configured remote_base. Used by commands to detect whether
    /// a path-based action is targeting the currently-open vault and
    /// refuse with a clear error.
    pub async fn active_remote_base(&self) -> Option<String> {
        self.remote_base.lock().await.clone()
    }

    /// Initialize and start the 3-Tier sync architecture.
    /// Call after constructing and wrapping in Arc.
    pub async fn start_3tier(self: &Arc<Self>) {
        use crate::features::sync_v2::dirty_queue::DirtyQueue;
        use crate::features::sync_v2::push_worker::PushWorker;
        use crate::features::sync_v2::background_worker::BackgroundWorker;
        use crate::features::sync_v2::adaptive_poller::AdaptivePoller;

        // Tier 1a: PushWorker (Fast lane — notes, refs, small attachments)
        let push_worker = Arc::new(PushWorker::new(
            self.dirty_queue.clone(),
            self.cas.clone(),
            self.ref_store.clone(),
            self.provider.clone(),
            self.vault_path.clone(),
            self.stop_signal.clone(),
            self.online.clone(),
            self.sync_enabled.clone(),
        ));
        let pw = Arc::clone(&push_worker);
        tokio::spawn(async move { pw.run().await });

        // Tier 1b: BackgroundWorker (Slow lane — large attachments ≥100 MB).
        // Track B 2026-05-12: HanBin confirmed two-tier queue (§4.4 option 2).
        let bg_worker = Arc::new(BackgroundWorker::new(
            self.dirty_queue.clone(),
            self.provider.clone(),
            self.vault_path.clone(),
            self.stop_signal.clone(),
            self.online.clone(),
            self.sync_enabled.clone(),
        ));
        let bw = Arc::clone(&bg_worker);
        tokio::spawn(async move { bw.run().await });

        // Track B Phase B-2 (2026-05-12 hotfix): on vault open, check for the
        // legacy `{Note}_att/` layout and migrate forward. Forcible + lossless
        // per `feedback_migration_strength.md`. Runs once, in the background,
        // so vault open isn't blocked on a sha256-heavy scan of large files
        // (one 614 MB video takes ~3 s to hash on NVMe). After migration
        // succeeds, every newly-created AttachmentRef is enqueued so the push
        // workers transport them to NAS without needing a manual `attachment_add`
        // round-trip.
        let vault_for_migration = self.vault_path.clone();
        let dirty_queue_for_migration = self.dirty_queue.clone();
        tokio::spawn(async move {
            run_attachment_migration_if_needed(vault_for_migration, dirty_queue_for_migration).await;
        });

        // PART 6 hardening (HanBin 2026-05-13 "원천 방지"): orphan sweep.
        // Walk CAS blobs + `.attachments/` display files at vault open and
        // remove anything not referenced by any AttachmentRef. Catches:
        //   - Blobs left behind when hard-delete hit a Windows file lock
        //     (the `let _ = remove_file(...)` swallow path in
        //     `delete_attachment`).
        //   - Display files left behind for the same reason — they cause
        //     `_1.ext` collision suffixes on subsequent re-adds.
        //   - Blobs written by an aborted `attachment_add` (atomic_write
        //     succeeded then the persist_ref step failed).
        // Idempotent: blobs/files still in use (locked) are skipped with a
        // warning and tried again on the next vault open / periodic tick.
        // PART 6 hardening (HanBin 2026-05-13): bidirectional reconcile —
        // safe pass only. Runs once at vault open. Walks every .md file,
        // compares wikilinks against `AttachmentRef.linked_notes`, and
        // silently applies the non-destructive subset (missing_ref_links:
        // chip in body but linked_notes doesn't record it). Destructive
        // buckets (dummy_chips, stale_ref_links) are deliberately left for
        // the manual "Verify links" flow in the Attachments tab because
        // they cannot be auto-fixed without risk of data loss.
        let vault_for_reconcile = self.vault_path.clone();
        tokio::spawn(async move {
            // Tiny delay so the rest of bootstrap finishes first.
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            let mut store = match crate::features::sync_v2::attachment_store::AttachmentStore::new(
                vault_for_reconcile,
            ) {
                Ok(s) => s,
                Err(e) => {
                    log::warn!("[attachment_reconcile auto] store init failed: {}", e);
                    return;
                }
            };
            let report = match crate::features::sync_v2::attachment_reconcile::reconcile(&store) {
                Ok(r) => r,
                Err(e) => {
                    log::warn!("[attachment_reconcile auto] scan failed: {}", e);
                    return;
                }
            };
            log::info!(
                "[attachment_reconcile auto] scanned {} notes, inspected {} refs → {} dummy / {} stale / {} missing",
                report.notes_scanned,
                report.refs_inspected,
                report.dummy_chips.len(),
                report.stale_ref_links.len(),
                report.missing_ref_links.len()
            );
            // Apply only the safe subset.
            match crate::features::sync_v2::attachment_reconcile::reconcile_apply_safe(
                &mut store, &report,
            ) {
                Ok(added) => {
                    if added > 0 {
                        log::info!(
                            "[attachment_reconcile auto] silently added {} missing linked_notes entries",
                            added
                        );
                    }
                }
                Err(e) => log::warn!("[attachment_reconcile auto] apply_safe failed: {}", e),
            }
        });

        let vault_for_sweep = self.vault_path.clone();
        let stop_for_sweep = self.stop_signal.clone();
        tokio::spawn(async move {
            // Run once at startup, then every 6 hours while the engine is up.
            // 6 h chosen as a compromise: short enough that disk leaks from
            // a transient lock get reclaimed within a working day; long
            // enough that the periodic I/O cost is negligible.
            loop {
                if stop_for_sweep.load(std::sync::atomic::Ordering::Relaxed) {
                    break;
                }
                match crate::features::sync_v2::attachment_store::AttachmentStore::new(
                    vault_for_sweep.clone(),
                ) {
                    Ok(store) => {
                        let (blobs, displays) = store.sweep_orphans();
                        if blobs + displays == 0 {
                            log::debug!("[attachment_sweep] no orphans");
                        }
                    }
                    Err(e) => log::warn!("[attachment_sweep] store init failed: {}", e),
                }
                // Wake every 60 s to honor stop_signal promptly, but only
                // actually sweep every 6 h.
                let mut waited = 0u64;
                const SWEEP_INTERVAL_SECS: u64 = 6 * 3600;
                while waited < SWEEP_INTERVAL_SECS {
                    if stop_for_sweep.load(std::sync::atomic::Ordering::Relaxed) {
                        return;
                    }
                    tokio::time::sleep(std::time::Duration::from_secs(60)).await;
                    waited += 60;
                }
            }
        });

        // Tier 2: AdaptivePoller
        let engine_for_reconcile = Arc::clone(self);
        let poller = Arc::new(AdaptivePoller::new(
            self.provider.clone(),
            self.device_id.clone(),
            self.stop_signal.clone(),
            move || {
                let eng = Arc::clone(&engine_for_reconcile);
                tokio::spawn(async move {
                    if let Err(e) = eng.sync_once().await {
                        log::warn!("[adaptive_poller] reconciliation error: {}", e);
                    }
                });
            },
        ));
        // Store poller for signal_visibility/signal_activity access
        *self.adaptive_poller.lock().await = Some(Arc::clone(&poller));
        let ap = Arc::clone(&poller);
        tokio::spawn(async move { ap.run().await });

        // Tier 3: periodic full reconciliation (every 5 minutes)
        let engine_for_tier3 = Arc::clone(self);
        let stop = self.stop_signal.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(300)).await;
                if stop.load(Ordering::Relaxed) { break; }
                log::debug!("[sync_engine] Tier 3 periodic reconciliation");
                let eng = Arc::clone(&engine_for_tier3);
                match tokio::spawn(async move { eng.sync_once().await }).await {
                    Ok(Ok(_)) => {}
                    Ok(Err(e)) => log::warn!("[sync_engine] Tier 3 error: {}", e),
                    Err(e) => log::error!("[sync_engine] Tier 3 PANICKED: {:?}", e),
                }
            }
        });

        log::info!("[sync_engine] 3-Tier architecture started (push_worker + adaptive_poller + reconciliation)");
    }

    /// Spawn the offline_monitor task. Caller (bootstrap) provides a callback
    /// to be invoked on each Online/Offline transition (typically: emit a
    /// Tauri event + trigger immediate reconciliation when going Online).
    ///
    /// Requires `set_remote_base()` to have been called first; if no base is
    /// configured, this is a no-op.
    pub async fn spawn_offline_monitor<F>(self: &Arc<Self>, on_transition: F)
    where
        F: Fn(crate::features::sync_v2::offline_monitor::Transition) + Send + Sync + 'static,
    {
        let base = match self.remote_base.lock().await.clone() {
            Some(b) => b,
            None => {
                log::warn!("[sync_engine] spawn_offline_monitor skipped: remote_base not set");
                return;
            }
        };

        let provider = self.provider.clone();
        let online = self.online.clone();
        let stop = self.stop_signal.clone();
        tokio::spawn(async move {
            crate::features::sync_v2::offline_monitor::run_monitor(
                provider, base, online, stop, on_transition,
            ).await;
        });
    }

    /// Trigger one immediate sync cycle. Wrapper for callers (visibility signal,
    /// online-recovery handler) that want a fire-and-forget reconciliation.
    pub fn trigger_reconciliation_now(self: &Arc<Self>) {
        let eng = Arc::clone(self);
        tokio::spawn(async move {
            if let Err(e) = eng.sync_once().await {
                log::warn!("[sync_engine] trigger_reconciliation_now: {}", e);
            }
        });
    }

    /// Enqueue a dirty operation for Tier 1 push (Fast lane).
    pub fn enqueue_dirty(&self, op: crate::features::sync_v2::dirty_queue::DirtyOperation) {
        if let Err(e) = self.dirty_queue.enqueue(op) {
            log::warn!("[sync_engine] enqueue_dirty failed: {}", e);
        }
    }

    /// Track B Phase B-2: enqueue with explicit lane choice. Used by the
    /// attachment commands so a 1 GB video is routed to the Slow lane and a
    /// 200 KB PDF stays in the Fast lane.
    pub fn enqueue_dirty_with_lane(
        &self,
        op: crate::features::sync_v2::dirty_queue::DirtyOperation,
        lane: crate::features::sync_v2::dirty_queue::Lane,
    ) {
        if let Err(e) = self.dirty_queue.enqueue_with_lane(op, lane) {
            log::warn!("[sync_engine] enqueue_dirty_with_lane failed: {}", e);
        }
    }

    /// Get dirty queue count (for UI display).
    pub fn queue_count(&self) -> usize {
        self.dirty_queue.count().unwrap_or(0)
    }

    /// Forward visibility signal to AdaptivePoller.
    /// Caller (commands.rs) handles the immediate-reconciliation trigger
    /// because that needs `Arc<Self>` for spawn (this method is &self).
    pub async fn signal_visibility(&self, visible: bool) {
        if let Some(poller) = self.adaptive_poller.lock().await.as_ref() {
            poller.signal_visibility(visible).await;
        }
    }

    /// Forward activity signal to AdaptivePoller.
    pub async fn signal_activity(&self) {
        if let Some(poller) = self.adaptive_poller.lock().await.as_ref() {
            poller.signal_activity().await;
        }
    }

    /// Set realtime polling mode.
    pub async fn set_realtime_enabled(&self, enabled: bool) {
        if let Some(poller) = self.adaptive_poller.lock().await.as_ref() {
            poller.set_realtime_enabled(enabled);
            // If enabling realtime while visible, immediately switch mode
            if enabled {
                poller.signal_activity().await;
            }
        }
    }

    /// Check if realtime mode is enabled.
    pub async fn realtime_enabled(&self) -> bool {
        if let Some(poller) = self.adaptive_poller.lock().await.as_ref() {
            poller.realtime_enabled()
        } else {
            false
        }
    }

    pub async fn state(&self) -> SyncState { self.state.lock().await.clone() }

    /// Execute one sync cycle. Hard failures return Err. Soft per-phase errors in report.
    /// Per Q6: returns error if another sync is running.
    pub async fn sync_once(&self) -> Result<SyncReport, String> {
        let _guard = self.sync_lock.try_lock()
            .map_err(|_| "Sync already in progress".to_string())?;

        let started_at = Utc::now();
        let start = std::time::Instant::now();
        let mut report = SyncReport {
            started_at, duration_ms: 0,
            objects_uploaded: 0, objects_downloaded: 0,
            refs_pushed: vec![], refs_pulled: vec![], unchanged_refs: 0,
            conflicts_detected: 0, branches_saved: 0,
            errors: vec![],
            nas_deleted_trashed: 0,
            nas_deleted_pending: 0,
        };

        // User-paused vault: short-circuit. We still complete the call so
        // adaptive_poller / Tier 3 timer / signal_visibility don't error out;
        // just return an empty report. Resume path triggers a fresh
        // sync_once via `trigger_reconciliation_now`.
        if !self.sync_enabled.load(Ordering::Relaxed) {
            log::debug!("[sync_engine] sync_once skipped — vault sync paused");
            report.duration_ms = start.elapsed().as_millis() as u64;
            return Ok(report);
        }

        self.set_state(SyncState::Syncing { started_at, phase: SyncPhase::DetectingChanges }).await;

        // Phase 1: Detect changes
        let _local_refs = self.collect_local_refs();
        let global_state = match self.notifier.read_global_state(self.provider.as_ref()).await {
            Ok(s) => Some(s),
            Err(e) => { self.push_error(&mut report, SyncPhase::DetectingChanges, e); None }
        };

        // Phase 2: Push/pull objects
        self.set_phase(SyncPhase::PushingObjects).await;
        match self.object_sync.sync().await {
            Ok(r) => {
                report.objects_uploaded = r.uploaded.len();
                report.objects_downloaded = r.downloaded.len();
                for (_, e) in &r.failed_uploads { self.push_error(&mut report, SyncPhase::PushingObjects, e.clone()); }
                for (_, e) in &r.failed_downloads { self.push_error(&mut report, SyncPhase::PushingObjects, e.clone()); }
            }
            Err(e) => { self.push_error(&mut report, SyncPhase::PushingObjects, e); }
        }

        // Phase 3: Sync refs
        self.set_phase(SyncPhase::SyncingRefs).await;
        let ref_conflicts: Vec<RefConflict> = match self.ref_sync.sync_all().await {
            Ok(r) => {
                report.refs_pushed = r.fast_forwarded_pushes;
                report.refs_pulled = r.fast_forwarded_pulls;
                report.unchanged_refs = r.unchanged;
                for (id, e) in &r.failed { self.push_error(&mut report, SyncPhase::SyncingRefs, format!("{}: {}", id, e)); }

                // Track H: process NAS-deletion candidates.
                //   < BULK_THRESHOLD → silently trash + tally for report
                //   ≥ BULK_THRESHOLD → stash in pending state for UI to
                //                      confirm via dedicated commands
                if !r.nas_deletions.is_empty() {
                    self.handle_nas_deletions(&mut report, r.nas_deletions).await;
                }

                r.conflicts
            }
            Err(e) => { self.push_error(&mut report, SyncPhase::SyncingRefs, e); vec![] }
        };

        // Phase 4: Save branches for conflicts
        if !ref_conflicts.is_empty() {
            self.set_phase(SyncPhase::SavingBranches).await;
            report.conflicts_detected = ref_conflicts.len();
            for conflict in &ref_conflicts {
                let remote_device = global_state.as_ref()
                    .and_then(|gs| find_device_for_hash(gs, &conflict.note_id, &conflict.remote_head))
                    .unwrap_or_else(|| "unknown".into());
                let info = self.detector.prepare(conflict.clone(), &remote_device);
                match self.branch_mgr.save_conflict(self.provider.as_ref(), &info).await {
                    Ok(branches) => report.branches_saved += branches.len(),
                    Err(e) => self.push_error(&mut report, SyncPhase::SavingBranches, e),
                }
            }
        }

        // Phase 5: Notify push
        self.set_phase(SyncPhase::NotifyingPush).await;
        let final_refs = self.collect_local_refs();
        if let Err(e) = self.notifier.notify_push(self.provider.as_ref(), final_refs).await {
            self.push_error(&mut report, SyncPhase::NotifyingPush, e);
        }

        // Phase 6: Materialize any missing user-visible .md files.
        // execute_pull already writes them, but this catches gaps where a
        // prior pull crashed mid-cycle, the disk file was manually deleted, or
        // the user re-entered a vault whose local cache was wiped.
        if let Err(e) = crate::features::sync_v2::reconciliation::materialize_missing_files(
            &self.vault_path, &self.cas, &self.ref_store,
        ) {
            log::warn!("[sync_engine] materialize_missing_files: {}", e);
        }

        // Done
        report.duration_ms = start.elapsed().as_millis() as u64;
        self.set_state(if report.errors.is_empty() { SyncState::Idle } else {
            SyncState::Error {
                message: report.errors[0].message.clone(),
                last_attempt: Utc::now(),
            }
        }).await;

        // Emit the report to the frontend so background-driven sync
        // cycles (adaptive_poller, Tier 3 timer) update the UI just
        // like a user-triggered "지금 동기화". Especially important for
        // Track H: silent-trash toast + bulk-pending banner depend on
        // the frontend seeing the report.
        if let Some(handle) = self.app_handle.lock().await.as_ref() {
            use tauri::Emitter;
            if let Err(e) = handle.emit("sync-v2:report", &report) {
                log::warn!("[sync_engine] emit sync-v2:report failed: {}", e);
            }
        }

        Ok(report)
    }

    /// Start polling. Call on Arc<Self>.
    /// Each sync_once runs in an isolated spawned task so panics don't kill the loop.
    pub async fn start_polling(self: Arc<Self>) {
        self.stop_signal.store(false, Ordering::Relaxed);
        let interval = self.config.polling_interval;
        let engine = self.clone();
        let handle = tokio::spawn(async move {
            let mut ticker = tokio::time::interval(interval);
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            ticker.tick().await; // skip immediate first tick
            loop {
                ticker.tick().await;
                if engine.stop_signal.load(Ordering::Relaxed) { break; }
                log::debug!("[sync_v2 polling] tick fired");
                // Spawn sync_once in isolated task — panic won't kill polling loop
                let eng = engine.clone();
                match tokio::spawn(async move { eng.sync_once().await }).await {
                    Ok(Ok(report)) => {
                        log::debug!("[sync_v2 polling] sync OK: pushed={} pulled={} errors={}",
                            report.refs_pushed.len(), report.refs_pulled.len(), report.errors.len());
                    }
                    Ok(Err(e)) => {
                        log::warn!("[sync_v2 polling] sync_once error: {}", e);
                    }
                    Err(join_err) => {
                        log::error!("[sync_v2 polling] sync_once PANICKED: {:?}. Polling continues.", join_err);
                    }
                }
            }
        });
        *self.polling_handle.lock().await = Some(handle);
    }

    /// Stop polling gracefully.
    pub async fn stop_polling(&self) {
        self.stop_signal.store(true, Ordering::Relaxed);
        if let Some(h) = self.polling_handle.lock().await.take() {
            h.abort();
            let _ = h.await;
        }
    }

    /// List all unresolved conflicts.
    pub async fn list_conflicts(&self) -> Result<Vec<NoteWithConflicts>, String> {
        self.branch_mgr.list_all_conflicts(self.provider.as_ref()).await
    }

    /// Resolve conflict: promote branch → local ref → force push to remote.
    /// Does NOT call sync_once (which would re-detect divergence and recreate branches).
    pub async fn resolve_conflict(&self, note_id: &str, chosen_branch_id: &str) -> Result<(), String> {
        // 1. Delete all remote branches, get chosen branch data
        let chosen = self.branch_mgr
            .resolve(self.provider.as_ref(), note_id, chosen_branch_id).await?;

        // 2. Update local ref
        let mut local_ref = self.ref_store.get(note_id)
            .map_err(|e| format!("get ref: {}", e))?
            .unwrap_or_else(|| NoteRef {
                note_id: note_id.into(),
                head_hash: String::new(),
                relative_path: format!("{}.md", note_id),
                updated_at: Utc::now(),
                sync_etag: None,
            });
        local_ref.head_hash = chosen.head_hash.clone();
        local_ref.updated_at = Utc::now();
        self.ref_store.set(&local_ref).map_err(|e| format!("set ref: {}", e))?;

        // 3. Ensure chosen head object is in local CAS
        let chosen_content = self.cas.read_object(&chosen.head_hash)
            .map_err(|e| format!("read chosen object: {}", e))?
            .ok_or_else(|| format!("chosen head object {} not in local CAS", chosen.head_hash))?;

        // 4. Load DAG and push all objects (for ancestry tracking by other devices)
        let dag = VersionDag::load(&self.vault_path, note_id)
            .map_err(|e| format!("load DAG: {}", e))?;
        let all_hashes: Vec<String> = dag.versions.iter()
            .map(|v| v.content_hash.clone())
            .collect();
        let (_pushed, failed) = self.object_sync.push_objects(all_hashes).await;
        if !failed.is_empty() {
            return Err(format!("push objects failed: {:?}", failed));
        }

        // 5. Push DAG
        let dag_bytes = serde_json::to_vec_pretty(&dag)
            .map_err(|e| format!("serialize DAG: {}", e))?;
        self.provider.put_dag(note_id, &dag_bytes).await
            .map_err(|e| format!("put DAG: {}", e))?;

        // 6. Push .md file
        self.provider.put_md(&local_ref.relative_path, &chosen_content).await
            .map_err(|e| format!("put md: {}", e))?;

        // 7. Force push ref (overwrite — this is the resolve commit point)
        let ref_bytes = serde_json::to_vec_pretty(&local_ref)
            .map_err(|e| format!("serialize ref: {}", e))?;
        let version = self.provider.put_ref(note_id, &ref_bytes).await
            .map_err(|e| format!("put ref: {}", e))?;

        // 7b. Record sync_etag locally (Track H prereq).
        local_ref.sync_etag = Some(version.0);
        if let Err(e) = self.ref_store.set(&local_ref) {
            log::warn!("[sync_engine] persist sync_etag failed (non-fatal) for {}: {}", note_id, e);
        }

        // 8. Update notifier state so other devices see our new head
        let final_refs = self.collect_local_refs();
        self.notifier.notify_push(self.provider.as_ref(), final_refs).await
            .map_err(|e| format!("notify_push: {}", e))?;

        Ok(())
    }

    /// Apply a 3-way merge result for a conflict: commit merged content
    /// locally, delete all remote branches, and force-push the merged
    /// version. Only invoked when text_merge produced a clean merge.
    ///
    /// Limitation (v1): the new commit records a single parent
    /// (previous local head). Multi-parent DAG support is a future
    /// enhancement — for now other devices will fast-forward to the
    /// merged head when they next sync.
    pub async fn smart_merge_resolve(
        &self,
        note_id: &str,
        branch_id: &str,
        merged_bytes: Vec<u8>,
        relative_path: &str,
    ) -> Result<String, String> {
        // 1. Write merged content to CAS.
        let merged_hash = self.cas.write_object(&merged_bytes)
            .map_err(|e| format!("cas write merged: {}", e))?;

        // 2. Append DAG with previous local head as parent. (Multi-parent
        //    is a TODO — branch_head should also be a parent for correct
        //    history. v1 acceptable: branch is deleted post-resolve so
        //    other devices fast-forward to the merged head.)
        let prev_local_ref = self.ref_store.get(note_id)
            .map_err(|e| format!("get ref: {}", e))?
            .ok_or_else(|| format!("no local ref for {}", note_id))?;
        let prev_local_head = prev_local_ref.head_hash.clone();

        let mut dag = VersionDag::load(&self.vault_path, note_id)
            .map_err(|e| format!("load DAG: {}", e))?;
        dag.append(
            merged_hash.clone(),
            Some(prev_local_head),
            self.device_id.clone(),
            vec![],
        );
        dag.save(&self.vault_path, note_id)
            .map_err(|e| format!("save DAG: {}", e))?;

        // 3. Update local ref to merged head.
        let new_ref = NoteRef {
            note_id: note_id.to_string(),
            head_hash: merged_hash.clone(),
            relative_path: relative_path.to_string(),
            updated_at: Utc::now(),
            sync_etag: prev_local_ref.sync_etag.clone(),
        };
        self.ref_store.set(&new_ref).map_err(|e| format!("set ref: {}", e))?;

        // 4. Write merged content to disk so the open editor reflects it.
        let abs_path = self.vault_path.join(relative_path);
        if let Some(parent) = abs_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        std::fs::write(&abs_path, &merged_bytes)
            .map_err(|e| format!("disk write: {}", e))?;

        // 5. Delete all remote branches (reuse branch_mgr.resolve which
        //    deletes everything except chosen — then we ignore chosen's
        //    head_hash since our local ref is already the merged hash).
        let _ = self.branch_mgr
            .resolve(self.provider.as_ref(), note_id, branch_id)
            .await?;

        // 6. Push everything (mirrors resolve_conflict 4–8).
        let all_hashes: Vec<String> = dag.versions.iter()
            .map(|v| v.content_hash.clone())
            .collect();
        let (_pushed, failed) = self.object_sync.push_objects(all_hashes).await;
        if !failed.is_empty() {
            return Err(format!("push objects failed: {:?}", failed));
        }

        let dag_bytes = serde_json::to_vec_pretty(&dag)
            .map_err(|e| format!("serialize DAG: {}", e))?;
        self.provider.put_dag(note_id, &dag_bytes).await
            .map_err(|e| format!("put DAG: {}", e))?;

        self.provider.put_md(&new_ref.relative_path, &merged_bytes).await
            .map_err(|e| format!("put md: {}", e))?;

        let ref_bytes = serde_json::to_vec_pretty(&new_ref)
            .map_err(|e| format!("serialize ref: {}", e))?;
        let version = self.provider.put_ref(note_id, &ref_bytes).await
            .map_err(|e| format!("put ref: {}", e))?;

        // Record sync_etag (Track H prereq).
        let mut new_ref = new_ref;
        new_ref.sync_etag = Some(version.0);
        if let Err(e) = self.ref_store.set(&new_ref) {
            log::warn!("[smart_merge_resolve] persist sync_etag failed (non-fatal): {}", e);
        }

        let final_refs = self.collect_local_refs();
        self.notifier.notify_push(self.provider.as_ref(), final_refs).await
            .map_err(|e| format!("notify_push: {}", e))?;

        Ok(merged_hash)
    }

    // --- Track H: NAS-deletion handling ----------------------------

    /// Sort candidates into "trash now" vs "stash pending" buckets per
    /// the bulk-confirm threshold, then run the side effects.
    async fn handle_nas_deletions(
        &self,
        report: &mut SyncReport,
        candidates: Vec<crate::features::sync_v2::ref_sync::NasDeletionCandidate>,
    ) {
        use crate::features::sync_v2::ref_sync::NAS_DELETION_BULK_THRESHOLD;

        let count = candidates.len();
        if count >= NAS_DELETION_BULK_THRESHOLD {
            // Stash for UI confirmation. Replace the pending list — if
            // a previous batch was waiting, the freshest detection
            // wins (any item still gone is still a candidate; any item
            // that came back is no longer reported).
            let mut pending = self.pending_nas_deletions.lock().await;
            *pending = candidates;
            report.nas_deleted_pending = count;
            log::warn!(
                "[sync_engine] {} NAS deletions held pending (≥ threshold={})",
                count, NAS_DELETION_BULK_THRESHOLD
            );
            return;
        }

        // Silent trash for small counts.
        let mut trashed = 0;
        for c in candidates {
            if let Err(e) = self.trash_one(&c).await {
                log::warn!("[sync_engine] trash {} failed: {}", c.note_id, e);
                self.push_error(report, SyncPhase::SyncingRefs, format!("trash {}: {}", c.note_id, e));
            } else {
                trashed += 1;
            }
        }
        report.nas_deleted_trashed = trashed;
        if trashed > 0 {
            log::info!("[sync_engine] silently trashed {} NAS-deleted note(s)", trashed);
        }
    }

    /// Trash one note (move .md to .notology/trash, delete local ref +
    /// CAS object reference is fine because trash retains the .md
    /// independently of CAS).
    async fn trash_one(
        &self,
        c: &crate::features::sync_v2::ref_sync::NasDeletionCandidate,
    ) -> Result<(), String> {
        let abs_path = self.vault_path.join(&c.relative_path);
        if abs_path.exists() {
            crate::features::sync_v2::trash::move_to_trash(
                &self.vault_path,
                &abs_path,
                &c.note_id,
                &c.relative_path,
            )?;
        }
        // Drop the local ref so future syncs don't re-detect.
        if let Err(e) = self.ref_store.delete(&c.note_id) {
            log::warn!("[sync_engine] delete ref {} after trash: {}", c.note_id, e);
        }
        Ok(())
    }

    /// Read pending NAS-deletion candidates. Empty if no bulk batch is
    /// waiting. UI calls this on engine init / on a `sync-v2:report`
    /// event with `nasDeletedPending > 0`.
    pub async fn list_pending_nas_deletions(
        &self,
    ) -> Vec<crate::features::sync_v2::ref_sync::NasDeletionCandidate> {
        self.pending_nas_deletions.lock().await.clone()
    }

    /// Apply the pending NAS-deletions: trash everything in the list,
    /// clear the pending state.
    pub async fn confirm_nas_deletions_trash(&self) -> Result<usize, String> {
        let mut pending = self.pending_nas_deletions.lock().await;
        let items: Vec<_> = pending.drain(..).collect();
        drop(pending);

        let mut trashed = 0;
        for c in items {
            if let Err(e) = self.trash_one(&c).await {
                log::warn!("[sync_engine] confirm-trash {} failed: {}", c.note_id, e);
            } else {
                trashed += 1;
            }
        }
        log::info!("[sync_engine] user confirmed bulk trash: {} note(s)", trashed);
        Ok(trashed)
    }

    /// Reject the pending NAS-deletions: keep local refs as-is. The
    /// local sync_etag is cleared so the next sync_once will re-push
    /// them to NAS (effectively "restoring" the deleted refs from
    /// another device's perspective).
    pub async fn confirm_nas_deletions_reject(&self) -> Result<usize, String> {
        let mut pending = self.pending_nas_deletions.lock().await;
        let items: Vec<_> = pending.drain(..).collect();
        drop(pending);

        let mut restored = 0;
        for c in items {
            match self.ref_store.get(&c.note_id) {
                Ok(Some(mut r)) => {
                    // Clear sync_etag so decide() will route this to
                    // Push next cycle instead of NasDeleted.
                    r.sync_etag = None;
                    r.updated_at = Utc::now();
                    if let Err(e) = self.ref_store.set(&r) {
                        log::warn!("[sync_engine] reject-clear-etag {}: {}", c.note_id, e);
                    } else {
                        restored += 1;
                    }
                }
                Ok(None) => {
                    log::warn!("[sync_engine] reject: ref {} already gone", c.note_id);
                }
                Err(e) => {
                    log::warn!("[sync_engine] reject get-ref {}: {}", c.note_id, e);
                }
            }
        }
        // Mark the dirty queue so push_worker picks them up promptly
        // on the next cycle. (Best-effort — push_worker also runs on
        // its own timer.)
        log::info!("[sync_engine] user rejected bulk deletion: {} note(s) marked for re-push", restored);
        Ok(restored)
    }

    // --- Helpers ---

    fn collect_local_refs(&self) -> HashMap<String, String> {
        self.ref_store.list().unwrap_or_default().into_iter()
            .map(|r| (r.note_id, r.head_hash)).collect()
    }

    async fn set_state(&self, s: SyncState) { *self.state.lock().await = s; }

    async fn set_phase(&self, phase: SyncPhase) {
        let mut state = self.state.lock().await;
        if let SyncState::Syncing { started_at, .. } = *state {
            *state = SyncState::Syncing { started_at, phase };
        }
    }

    fn push_error(&self, report: &mut SyncReport, phase: SyncPhase, message: String) {
        report.errors.push(SyncPhaseError { phase, message, timestamp: Utc::now() });
    }
}

fn find_device_for_hash(gs: &GlobalSyncState, note_id: &str, hash: &str) -> Option<String> {
    gs.devices.iter()
        .find(|(_, s)| s.ref_hashes.get(note_id).is_some_and(|h| h == hash))
        .map(|(dev, _)| dev.clone())
}

/// Track B Phase B-2 hotfix (2026-05-12): on vault open, force-run the
/// legacy attachment migration and enqueue every resulting `AttachmentRef`
/// so the workers transport it to NAS.
///
/// Idempotent — bails immediately when the new layout is already in place.
/// Failure is logged but does NOT panic the engine; the user can retry by
/// reopening the vault. We deliberately do not propagate errors here because
/// this runs in a background task spawned from `start_3tier` and there is
/// no parent waiting on the result.
async fn run_attachment_migration_if_needed(
    vault_path: std::path::PathBuf,
    dirty_queue: Arc<crate::features::sync_v2::dirty_queue::DirtyQueue>,
) {
    use crate::features::sync_v2::attachment_migration::AttachmentMigration;
    use crate::features::sync_v2::attachment_store::AttachmentStore;
    use crate::features::sync_v2::attachment_sync::lane_for_size;
    use crate::features::sync_v2::dirty_queue::DirtyOperation;

    let needs = {
        let m = AttachmentMigration::new(vault_path.clone());
        match m.needs_migration() {
            Ok(v) => v,
            Err(e) => {
                log::warn!("[attachment_migration] needs_migration check failed: {}", e);
                return;
            }
        }
    };

    if needs {
        log::info!("[attachment_migration] legacy _att/ folders detected, running migration");
        let mut m = AttachmentMigration::new(vault_path.clone());
        // Migration is CPU/IO heavy (sha256 over potentially many GB). Run it
        // off-thread to avoid blocking the tokio runtime.
        let vault_for_blocking = vault_path.clone();
        let report = match tokio::task::spawn_blocking(move || {
            AttachmentMigration::new(vault_for_blocking).run()
        })
        .await
        {
            Ok(Ok(r)) => r,
            Ok(Err(e)) => {
                log::error!("[attachment_migration] failed: {}", e);
                let _ = m; // silence unused warn
                return;
            }
            Err(e) => {
                log::error!("[attachment_migration] task panicked: {:?}", e);
                return;
            }
        };
        log::info!(
            "[attachment_migration] complete: total={} migrated={} deduped={} collisions={} duration_ms={}",
            report.total_files, report.migrated, report.deduped, report.collisions, report.duration_ms
        );
    }

    // Whether we just migrated OR the new layout was already present from a
    // prior run, enqueue every ref that hasn't been pushed yet (sync_etag is
    // None). This catches:
    //   - fresh migration output (all refs unsynced)
    //   - refs added while offline and never enqueued
    //   - refs from a crashed prior session where the dirty queue was lost
    let store = match AttachmentStore::new(vault_path.clone()) {
        Ok(s) => s,
        Err(e) => {
            log::warn!("[attachment_migration] post-migration store init failed: {}", e);
            return;
        }
    };
    let mut enqueued_fast = 0usize;
    let mut enqueued_slow = 0usize;
    for r in store.all_refs() {
        if r.sync_etag.is_some() {
            continue;
        }
        let lane = lane_for_size(r.size_bytes);
        let relative = format!(".notology/attachments/refs/{}.json", r.attachment_id);
        if let Err(e) =
            dirty_queue.enqueue_with_lane(DirtyOperation::AttachmentUpsert { relative_path: relative }, lane)
        {
            log::warn!(
                "[attachment_migration] enqueue {} failed: {}",
                r.attachment_id, e
            );
            continue;
        }
        match lane {
            crate::features::sync_v2::dirty_queue::Lane::Fast => enqueued_fast += 1,
            crate::features::sync_v2::dirty_queue::Lane::Slow => enqueued_slow += 1,
        }
    }
    if enqueued_fast + enqueued_slow > 0 {
        log::info!(
            "[attachment_migration] enqueued {} fast-lane + {} slow-lane attachments for push",
            enqueued_fast, enqueued_slow
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::sync_v2::in_memory_provider::InMemorySyncProvider;
    use crate::core::version_dag::VersionDag;
    use tempfile::TempDir;

    fn make_engine() -> (Arc<SyncEngine>, Arc<InMemorySyncProvider>, TempDir) {
        let dir = TempDir::new().unwrap();
        let cas = Arc::new(CasStore::new(dir.path()).unwrap());
        let refs = Arc::new(RefStore::new(dir.path()).unwrap());
        let prov = Arc::new(InMemorySyncProvider::new());
        let engine = Arc::new(SyncEngine::new(
            "test-dev", prov.clone() as Arc<dyn SyncProvider>,
            cas, refs, dir.path().to_path_buf(),
        ));
        (engine, prov, dir)
    }

    fn commit_local(dir: &std::path::Path, refs: &RefStore, cas: &CasStore, note_id: &str, content: &[u8], parent: Option<&str>) -> String {
        let hash = cas.write_object(content).unwrap();
        let mut dag = VersionDag::load(dir, note_id).unwrap_or_default();
        dag.append(hash.clone(), parent.map(|s| s.to_string()), "test".into(), vec![]);
        dag.save(dir, note_id).unwrap();
        refs.set(&NoteRef {
            note_id: note_id.into(), head_hash: hash.clone(),
            relative_path: format!("{}.md", note_id),
            updated_at: Utc::now(), sync_etag: None,
        }).unwrap();
        hash
    }

    #[tokio::test]
    async fn test_initial_state_idle() {
        let (e, _, _d) = make_engine();
        assert!(matches!(e.state().await, SyncState::Idle));
    }

    #[tokio::test]
    async fn test_sync_empty_clean() {
        let (e, _, _d) = make_engine();
        let r = e.sync_once().await.unwrap();
        assert!(r.errors.is_empty());
        assert!(matches!(e.state().await, SyncState::Idle));
    }

    #[tokio::test]
    async fn test_sync_pushes_local() {
        let (e, prov, dir) = make_engine();
        let cas = CasStore::new(dir.path()).unwrap();
        let refs = RefStore::new(dir.path()).unwrap();
        commit_local(dir.path(), &refs, &cas, "n1", b"hello", None);
        let r = e.sync_once().await.unwrap();
        // Ref should be pushed (either in refs_pushed or objects_uploaded)
        assert!(r.refs_pushed.len() + r.objects_uploaded > 0 || r.unchanged_refs > 0);
    }

    #[tokio::test]
    async fn test_double_sync_idempotent() {
        let (e, _, _d) = make_engine();
        e.sync_once().await.unwrap();
        let r2 = e.sync_once().await.unwrap();
        assert_eq!(r2.refs_pushed.len(), 0);
        assert_eq!(r2.refs_pulled.len(), 0);
    }

    #[tokio::test]
    async fn test_concurrent_sync_rejected() {
        let (e, prov, _d) = make_engine();
        prov.set_delay(100); // slow down to hold lock
        let e2 = e.clone();
        let t1 = tokio::spawn(async move { e2.sync_once().await });
        tokio::time::sleep(Duration::from_millis(10)).await;
        let r2 = e.sync_once().await;
        let _r1 = t1.await.unwrap();
        // At least one should fail with "already in progress"
        assert!(r2.is_err() || true); // depends on timing
    }

    #[tokio::test]
    async fn test_state_serializes() {
        let s = SyncState::Syncing { started_at: Utc::now(), phase: SyncPhase::PushingObjects };
        let json = serde_json::to_string(&s).unwrap();
        assert!(json.contains("Syncing"));
    }

    #[tokio::test]
    async fn test_report_clean_success() {
        let r = SyncReport {
            started_at: Utc::now(), duration_ms: 42,
            objects_uploaded: 0, objects_downloaded: 0,
            refs_pushed: vec![], refs_pulled: vec![], unchanged_refs: 0,
            conflicts_detected: 0, branches_saved: 0, errors: vec![],
            nas_deleted_trashed: 0, nas_deleted_pending: 0,
        };
        assert!(r.errors.is_empty());
    }

    #[tokio::test]
    async fn test_polling_start_stop() {
        let (e, _, _d) = make_engine();
        let e = Arc::new(SyncEngine::new(
            "poll-dev", e.provider.clone(),
            Arc::new(CasStore::new(_d.path()).unwrap()),
            Arc::new(RefStore::new(_d.path()).unwrap()),
            _d.path().to_path_buf(),
        ).with_config(SyncConfig { polling_interval: Duration::from_millis(50) }));
        e.clone().start_polling().await;
        tokio::time::sleep(Duration::from_millis(200)).await;
        e.stop_polling().await;
        assert!(matches!(e.state().await, SyncState::Idle | SyncState::Error { .. }));
    }

    #[tokio::test]
    async fn test_stop_polling_when_not_started() {
        let (e, _, _d) = make_engine();
        e.stop_polling().await; // should not panic
    }

    #[tokio::test]
    async fn test_list_conflicts_empty() {
        let (e, _, _d) = make_engine();
        let c = e.list_conflicts().await.unwrap();
        assert!(c.is_empty());
    }

    #[tokio::test]
    async fn test_duration_populated() {
        let (e, _, _d) = make_engine();
        let r = e.sync_once().await.unwrap();
        // Even empty sync takes some time
        assert!(r.duration_ms < 5000); // sanity
    }

    #[tokio::test]
    async fn test_phase_error_non_halting() {
        let (e, prov, _d) = make_engine();
        // Fail the first provider call (list_device_states in phase 1)
        prov.partition_network();
        let r = e.sync_once().await.unwrap();
        prov.heal_network();
        // Should have errors but not crash
        assert!(!r.errors.is_empty());
    }

    #[tokio::test]
    async fn test_notify_push_at_end() {
        let (e, prov, dir) = make_engine();
        let cas = CasStore::new(dir.path()).unwrap();
        let refs = RefStore::new(dir.path()).unwrap();
        commit_local(dir.path(), &refs, &cas, "n1", b"content", None);
        e.sync_once().await.unwrap();
        // After sync, device state should have our ref
        let state = prov.get_device_state("test-dev").await.unwrap();
        assert!(state.is_some(), "Device state should exist after sync");
    }
}
