//! Phase 2 scenario tests — exercise the wired behavior of the three sub-
//! systems delivered in this phase, end-to-end against InMemorySyncProvider.
//!
//! Mirrors the manual verification scenarios HanBin would otherwise run by
//! hand:
//!   A. Offline detection + auto recovery (offline_monitor + push_worker
//!      guard + transition callback).
//!   B. Foreground reconciliation triggers immediate pull + materializes
//!      missing local files at the tail of sync_once.
//!   C. NAS folder browser walks deep into the tree and detects vault
//!      markers across nesting levels.

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex as StdMutex;
use std::time::Duration;

use chrono::Utc;

use app_lib::core::cas::CasStore;
use app_lib::core::refs::{NoteRef, RefStore};
use app_lib::core::sync_provider::SyncProvider;
use app_lib::core::version_dag::VersionDag;
use app_lib::features::sync_v2::commands::browse_folder_with_provider;
use app_lib::features::sync_v2::dirty_queue::{DirtyOperation, DirtyQueue};
use app_lib::features::sync_v2::in_memory_provider::InMemorySyncProvider;
use app_lib::features::sync_v2::offline_monitor::{
    probe_and_update, run_monitor_with_interval, Transition,
};
use app_lib::features::sync_v2::push_worker::PushWorker;
use app_lib::features::sync_v2::sync_engine::SyncEngine;

// ────────────────────────────────────────────────────────────
// Shared setup helpers
// ────────────────────────────────────────────────────────────

struct Bench {
    vault: PathBuf,
    cas: Arc<CasStore>,
    refs: Arc<RefStore>,
    provider: Arc<InMemorySyncProvider>,
    _dir: tempfile::TempDir,
}

fn bench() -> Bench {
    let dir = tempfile::tempdir().expect("tempdir");
    let vault = dir.path().to_path_buf();
    let cas = Arc::new(CasStore::new(&vault).expect("cas"));
    let refs = Arc::new(RefStore::new(&vault).expect("refs"));
    let provider = Arc::new(InMemorySyncProvider::new());
    Bench { vault, cas, refs, provider, _dir: dir }
}

fn engine(b: &Bench, device_id: &str) -> Arc<SyncEngine> {
    let provider: Arc<dyn SyncProvider> = b.provider.clone();
    Arc::new(SyncEngine::new(
        device_id.to_string(), provider, b.cas.clone(), b.refs.clone(), b.vault.clone(),
    ))
}

/// Stage a full remote note (object + DAG + ref + user-visible .md) on the
/// provider, mimicking what another device would have pushed. The .md PUT
/// is required because `ref_sync.decide` checks `has_md` before pulling and
/// treats refs without an associated .md as orphans (deletes them).
/// Returns the head hash.
async fn stage_remote_note(
    provider: &Arc<InMemorySyncProvider>,
    note_id: &str,
    relative_path: &str,
    content: &[u8],
) -> String {
    use app_lib::core::cas::CasStore;
    let hash = CasStore::hash(content);

    provider.put_object(&hash, content).await.unwrap();
    provider.put_md(relative_path, content).await.unwrap();

    let mut dag = VersionDag::default();
    dag.append(hash.clone(), None, "remote-device".into(), vec![]);
    let dag_bytes = serde_json::to_vec(&dag).unwrap();
    provider.put_dag(note_id, &dag_bytes).await.unwrap();

    let note_ref = NoteRef {
        note_id: note_id.into(),
        head_hash: hash.clone(),
        relative_path: relative_path.into(),
        updated_at: Utc::now(),
        sync_etag: None,
    };
    let ref_bytes = serde_json::to_vec_pretty(&note_ref).unwrap();
    provider.put_ref(note_id, &ref_bytes).await.unwrap();

    hash
}

// ────────────────────────────────────────────────────────────
// Scenario A — Offline detection + auto recovery
// ────────────────────────────────────────────────────────────

/// `run_monitor` actually fires the transition callback when the provider
/// flips between healthy/failing — the wiring (not just the state machine)
/// reaches the caller.
#[tokio::test]
async fn scenario_a1_monitor_loop_emits_transitions_on_flip() {
    // Hold a concrete Arc so we can call `partition_network` / `heal_network`,
    // and a trait-object Arc that the monitor consumes. Both alias the same
    // allocation — Arc supports unsized coercion via `.clone()` into a Box-
    // shaped trait object.
    let inmemory: Arc<InMemorySyncProvider> = Arc::new(InMemorySyncProvider::new());
    let provider: Arc<dyn SyncProvider> = inmemory.clone();
    let online = Arc::new(AtomicBool::new(true));
    let stop = Arc::new(AtomicBool::new(false));

    let captured: Arc<StdMutex<Vec<Transition>>> = Arc::new(StdMutex::new(Vec::new()));
    let captured_clone = Arc::clone(&captured);

    let monitor_handle = {
        let provider_clone = provider.clone();
        let online_clone = online.clone();
        let stop_clone = stop.clone();
        tokio::spawn(async move {
            run_monitor_with_interval(
                provider_clone,
                "/".into(),
                online_clone,
                stop_clone,
                Duration::from_millis(40),
                move |t| {
                    captured_clone.lock().unwrap().push(t);
                },
            ).await;
        })
    };

    // Healthy phase: a few cycles, no transitions expected.
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(online.load(Ordering::SeqCst));
    {
        let c = captured.lock().unwrap();
        assert!(c.is_empty(), "no transitions while healthy: {:?}", *c);
    }

    // Partition the network → after 2 cycles (~80ms + slop) we should flip.
    inmemory.partition_network();
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(!online.load(Ordering::SeqCst), "should be offline after partition");
    {
        let c = captured.lock().unwrap();
        assert!(c.contains(&Transition::BecameOffline), "captured: {:?}", *c);
    }

    // Heal → next probe should recover.
    inmemory.heal_network();
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(online.load(Ordering::SeqCst), "should be online after heal");
    {
        let c = captured.lock().unwrap();
        assert!(c.contains(&Transition::BecameOnline), "captured: {:?}", *c);
    }

    stop.store(true, Ordering::Relaxed);
    let _ = tokio::time::timeout(Duration::from_secs(2), monitor_handle).await;
}

/// PushWorker idles instead of attempting PUTs while online=false. Once
/// online flips back, a queued operation is processed.
#[tokio::test]
async fn scenario_a2_push_worker_skips_work_while_offline() {
    let b = bench();

    // Local commit so the object exists in CAS (push_worker reads from it).
    let content = b"---\nid: \"20260101000099\"\n---\nbody";
    let hash = b.cas.write_object(content).unwrap();
    b.refs.set(&NoteRef {
        note_id: "20260101000099".into(),
        head_hash: hash,
        relative_path: "note.md".into(),
        updated_at: Utc::now(),
        sync_etag: None,
    }).unwrap();

    let queue = Arc::new(DirtyQueue::new(&b.vault).unwrap());
    queue.enqueue(DirtyOperation::NoteUpsert {
        note_id: "20260101000099".into(),
        relative_path: "note.md".into(),
    }).unwrap();
    assert_eq!(queue.count().unwrap(), 1, "entry queued");

    let online = Arc::new(AtomicBool::new(false));
    let stop = Arc::new(AtomicBool::new(false));
    // Phase 3-A added the user-pause flag; here we leave it active so the
    // test isolates the offline-only behavior it's trying to verify.
    let sync_enabled = Arc::new(AtomicBool::new(true));

    let provider: Arc<dyn SyncProvider> = b.provider.clone();
    let worker = Arc::new(PushWorker::new(
        queue.clone(),
        b.cas.clone(),
        b.refs.clone(),
        provider,
        b.vault.clone(),
        stop.clone(),
        online.clone(),
        sync_enabled.clone(),
    ));

    let worker_clone = Arc::clone(&worker);
    let task = tokio::spawn(async move { worker_clone.run().await });

    // Run worker for a window longer than the 1.5s debounce — yet because
    // online=false it must NOT touch the queue.
    tokio::time::sleep(Duration::from_millis(2500)).await;
    assert_eq!(queue.count().unwrap(), 1, "offline → queue must be untouched");
    assert_eq!(b.provider.object_count(), 0, "no objects pushed");

    // Flip online → next debounce cycle drains the queue.
    online.store(true, Ordering::Relaxed);
    tokio::time::sleep(Duration::from_millis(2500)).await;
    assert_eq!(queue.count().unwrap(), 0, "online → queue drained");
    assert!(b.provider.object_count() > 0, "object pushed to NAS after recovery");

    stop.store(true, Ordering::Relaxed);
    let _ = tokio::time::timeout(Duration::from_secs(2), task).await;
}

/// `probe_and_update` does NOT flip on a single transient failure. This is
/// the unit-test equivalent of the manual scenario where a one-off network
/// blip should be ignored, but covered here at scenario level too so the
/// FAILURE_THRESHOLD invariant is locked against future regression.
#[tokio::test]
async fn scenario_a3_transient_blip_does_not_flip_status() {
    let p = Arc::new(InMemorySyncProvider::new());
    let provider: Arc<dyn SyncProvider> = p.clone();
    let online = Arc::new(AtomicBool::new(true));
    let mut fails = 0u32;
    let mut succs = 0u32;

    // Healthy probe.
    let t = probe_and_update(&provider, "/", &online, &mut fails, &mut succs).await;
    assert_eq!(t, Transition::None);

    // Single forced failure (consumed on next op).
    p.fail_next(app_lib::core::sync_provider::SyncProviderError::NetworkError("blip".into()));
    let t = probe_and_update(&provider, "/", &online, &mut fails, &mut succs).await;
    assert_eq!(t, Transition::None, "single failure must not flip");
    assert!(online.load(Ordering::SeqCst));

    // Healthy again — counter resets, still online, no transition.
    let t = probe_and_update(&provider, "/", &online, &mut fails, &mut succs).await;
    assert_eq!(t, Transition::None);
    assert_eq!(fails, 0);
}

// ────────────────────────────────────────────────────────────
// Scenario B — Foreground reconciliation pulls remote changes
//                + Phase 6 materialize covers post-pull gaps
// ────────────────────────────────────────────────────────────

/// `engine.sync_once()` pulls a remote ref staged by another device and
/// materializes the .md to disk. This is the path
/// `signal_visibility(true) → trigger_reconciliation_now → sync_once`
/// exercises in production.
#[tokio::test]
async fn scenario_b1_sync_once_pulls_remote_and_materializes() {
    let b = bench();
    let eng = engine(&b, "dev-local");

    // Another device's contribution staged on the shared NAS.
    let content = b"---\nid: \"20260202000001\"\n---\nfrom remote";
    stage_remote_note(&b.provider, "20260202000001", "incoming.md", content).await;

    // Local has nothing yet.
    assert!(b.refs.get("20260202000001").unwrap().is_none());
    assert!(!b.vault.join("incoming.md").exists());

    let report = eng.sync_once().await.expect("sync_once");
    assert!(report.errors.is_empty(), "errors: {:?}", report.errors);
    assert_eq!(report.refs_pulled.len(), 1, "remote ref pulled");

    // Local ref + disk file both populated.
    assert!(b.refs.get("20260202000001").unwrap().is_some());
    assert!(b.vault.join("incoming.md").exists());
    assert_eq!(std::fs::read(b.vault.join("incoming.md")).unwrap(), content);
}

/// The Phase 6 materialize tail at the end of `sync_once` heals a state where
/// the local ref already exists but the on-disk .md is missing — e.g. a
/// crash between `cas.write_object` and the .md write, or a user wiping
/// their local cache before re-entering the vault.
#[tokio::test]
async fn scenario_b2_phase6_materializes_locally_dropped_files() {
    let b = bench();
    let eng = engine(&b, "dev-local");

    // Local ref + CAS object exist; user deleted the .md after a crash.
    let content = b"---\nid: \"20260202000002\"\n---\nbody to recover";
    let hash = b.cas.write_object(content).unwrap();
    b.refs.set(&NoteRef {
        note_id: "20260202000002".into(),
        head_hash: hash,
        relative_path: "recover.md".into(),
        updated_at: Utc::now(),
        sync_etag: None,
    }).unwrap();
    assert!(!b.vault.join("recover.md").exists(), "precondition: .md missing");

    eng.sync_once().await.expect("sync_once");

    assert!(b.vault.join("recover.md").exists(), "Phase 6 must materialize");
    assert_eq!(std::fs::read(b.vault.join("recover.md")).unwrap(), content);
}

/// Re-running sync_once does not rewrite a file whose disk bytes already
/// match the CAS object — materialize_missing_files is byte-idempotent so
/// it never bumps mtime needlessly.
#[tokio::test]
async fn scenario_b3_phase6_idempotent_when_disk_already_matches() {
    let b = bench();
    let eng = engine(&b, "dev-local");

    let content = b"---\nid: \"20260202000003\"\n---\nstable";
    let hash = b.cas.write_object(content).unwrap();
    std::fs::write(b.vault.join("stable.md"), content).unwrap();
    b.refs.set(&NoteRef {
        note_id: "20260202000003".into(),
        head_hash: hash,
        relative_path: "stable.md".into(),
        updated_at: Utc::now(),
        sync_etag: None,
    }).unwrap();

    let mtime_before = std::fs::metadata(b.vault.join("stable.md"))
        .unwrap().modified().unwrap();

    // tiny gap so any rewrite would yield a distinct mtime
    tokio::time::sleep(Duration::from_millis(50)).await;

    eng.sync_once().await.expect("sync_once");

    let mtime_after = std::fs::metadata(b.vault.join("stable.md"))
        .unwrap().modified().unwrap();
    assert_eq!(mtime_before, mtime_after, "byte-equal disk must not be rewritten");
}

// ────────────────────────────────────────────────────────────
// Scenario C — NAS folder browser navigates deep + flags vaults
//   (basic `nas_browser_*` tests live in connection_lifecycle.rs;
//    these exercise multi-level navigation and edge cases.)
// ────────────────────────────────────────────────────────────

/// Browsing into a nested subfolder still flags vaults that live at the
/// inner level — i.e., the per-child `.notology/` probe runs at every depth,
/// not just from root.
#[tokio::test]
async fn scenario_c1_browser_finds_vaults_at_arbitrary_depth() {
    let p: Arc<InMemorySyncProvider> = Arc::new(InMemorySyncProvider::new());
    let provider: Arc<dyn SyncProvider> = p.clone();
    use app_lib::core::sync_provider::SyncProvider as _;
    p.put_md("/Colony/Projects/Notes2026/.notology/marker.md", b"x").await.unwrap();
    p.put_md("/Colony/Projects/Notes2026/journal.md", b"y").await.unwrap();
    p.put_md("/Colony/Projects/Drafts/wip.md", b"z").await.unwrap();

    // Root /Colony should NOT yet flag Projects as vault — Projects only
    // contains Notes2026 + Drafts, neither of which is `.notology`.
    let root = browse_folder_with_provider(&provider, "/Colony").await.unwrap();
    let projects = root.children.iter().find(|c| c.name == "Projects").unwrap();
    assert!(projects.is_collection);
    assert!(!projects.is_vault, "intermediate dir is not a vault");

    // Drill into Projects: now we see Notes2026 (vault) + Drafts (plain).
    let inside = browse_folder_with_provider(&provider, "/Colony/Projects").await.unwrap();
    let notes = inside.children.iter().find(|c| c.name == "Notes2026").unwrap();
    assert!(notes.is_vault, "Notes2026 has .notology — must flag as vault");
    let drafts = inside.children.iter().find(|c| c.name == "Drafts").unwrap();
    assert!(!drafts.is_vault);
}

/// `is_collection` is preserved for files vs directories so the UI knows
/// what to make navigable.
#[tokio::test]
async fn scenario_c2_browser_distinguishes_files_from_folders() {
    let p: Arc<InMemorySyncProvider> = Arc::new(InMemorySyncProvider::new());
    let provider: Arc<dyn SyncProvider> = p.clone();
    use app_lib::core::sync_provider::SyncProvider as _;
    p.put_md("/Mixed/SubFolder/inner.md", b"x").await.unwrap();
    p.put_md("/Mixed/loose.md", b"y").await.unwrap();

    let listing = browse_folder_with_provider(&provider, "/Mixed").await.unwrap();
    let folder = listing.children.iter().find(|c| c.name == "SubFolder").unwrap();
    let file = listing.children.iter().find(|c| c.name == "loose.md").unwrap();
    assert!(folder.is_collection);
    assert!(!file.is_collection);
    // Sort: folders first.
    let folder_idx = listing.children.iter().position(|c| c.name == "SubFolder").unwrap();
    let file_idx = listing.children.iter().position(|c| c.name == "loose.md").unwrap();
    assert!(folder_idx < file_idx, "folders sort before files");
}
