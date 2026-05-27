//! Integration tests for the 2026-05-24 remote_import safety net + progress.
//!
//! Lib tests can't link Tauri DLLs on this dev machine, so the safety-net
//! regression coverage lives here as an integration test instead. These
//! exercise `import_into_library` (public) through the same paths the
//! Tauri command uses.

use std::sync::{Arc, Mutex};

use tempfile::TempDir;

use app_lib::core::library::Library;
use app_lib::core::sync_provider::SyncProvider;
use app_lib::features::connection::remote_import::{
    import_into_library, scan_remote,
};
use app_lib::features::sync_v2::in_memory_provider::InMemorySyncProvider;

fn make_vault() -> (TempDir, Library) {
    let tmp = TempDir::new().unwrap();
    std::fs::create_dir_all(tmp.path().join(".notology/refs")).unwrap();
    std::fs::create_dir_all(tmp.path().join(".notology/objects")).unwrap();
    let library = Library::new(tmp.path()).unwrap();
    (tmp, library)
}

/// Crash-then-retry: Phase 2 committed a ref, Phase 3 write-back never
/// reached NAS, then we retry. Safety net must reuse the prior id instead
/// of creating a duplicate ref pointing at the same relative_path.
#[tokio::test]
async fn safety_net_reuses_id_on_retry_when_writeback_was_lost() {
    let (_tmp, library) = make_vault();
    let provider = Arc::new(InMemorySyncProvider::new());
    let provider_dyn: Arc<dyn SyncProvider> = provider.clone();

    // NAS has one .md with NO frontmatter id.
    provider.put_md("/Colony/V/note.md", b"hello world\n").await.unwrap();

    // First import: commit happens. We intentionally DROP `pending` to
    // simulate Phase-3 write-back being lost (network drop or kill).
    let (fetched, mut report) = scan_remote(&provider_dyn, "/Colony/V").await.unwrap();
    assert_eq!(fetched.len(), 1);
    let _ = import_into_library(fetched, &library, false, &mut report, None);

    let first_refs = library.refs().list().unwrap();
    assert_eq!(first_refs.len(), 1, "first run committed one ref");
    let first_id = first_refs[0].note_id.clone();
    let first_hash = first_refs[0].head_hash.clone();

    // Confirm NAS still has the no-id bytes (test premise).
    let nas_bytes = provider.get_md("/Colony/V/note.md").await.unwrap().unwrap();
    assert_eq!(nas_bytes, b"hello world\n",
        "test premise: NAS write-back never happened");

    // Second import (retry). Safety net should kick in.
    let (fetched2, mut report2) = scan_remote(&provider_dyn, "/Colony/V").await.unwrap();
    let pending2 = import_into_library(fetched2, &library, false, &mut report2, None);

    let after_refs = library.refs().list().unwrap();
    assert_eq!(after_refs.len(), 1,
        "safety net must prevent a second ref; got {:?}", after_refs);
    assert_eq!(after_refs[0].note_id, first_id, "same id was reused");
    assert_eq!(after_refs[0].head_hash, first_hash, "content hash unchanged");

    // Write-back is re-emitted so the retry actually patches NAS.
    assert_eq!(pending2.len(), 1, "retry should re-emit the write-back");
    assert!(pending2[0].fetch_path.ends_with("/Colony/V/note.md"));
}

/// Safety net must NOT override an explicit frontmatter id — the existing
/// id-present path is what already-synced notes flow through.
#[tokio::test]
async fn safety_net_does_not_override_existing_id_in_frontmatter() {
    let (_tmp, library) = make_vault();
    let provider = Arc::new(InMemorySyncProvider::new());
    let provider_dyn: Arc<dyn SyncProvider> = provider.clone();

    let nas_content = "---\nid: \"20260524100000\"\n---\nhi\n";
    provider.put_md("/Colony/V/note.md", nas_content.as_bytes()).await.unwrap();

    let (fetched, mut report) = scan_remote(&provider_dyn, "/Colony/V").await.unwrap();
    let pending = import_into_library(fetched, &library, false, &mut report, None);

    let refs = library.refs().list().unwrap();
    assert_eq!(refs.len(), 1);
    assert_eq!(refs[0].note_id, "20260524100000",
        "frontmatter id wins — safety net only fires when id is absent");
    assert_eq!(pending.len(), 0, "id was present → no write-back needed");
}

/// Progress callback fires once per note in input order.
#[tokio::test]
async fn progress_callback_invoked_per_note_in_order() {
    let (_tmp, library) = make_vault();
    let provider = Arc::new(InMemorySyncProvider::new());
    let provider_dyn: Arc<dyn SyncProvider> = provider.clone();
    for i in 0..5 {
        provider.put_md(&format!("/V/n{}.md", i),
            format!("note {}\n", i).as_bytes()).await.unwrap();
    }

    let (fetched, mut report) = scan_remote(&provider_dyn, "/V").await.unwrap();
    assert_eq!(fetched.len(), 5);

    let calls: Arc<Mutex<Vec<(usize, usize)>>> = Arc::new(Mutex::new(Vec::new()));
    let calls_clone = calls.clone();
    let cb = move |c: usize, t: usize| { calls_clone.lock().unwrap().push((c, t)); };
    let _ = import_into_library(fetched, &library, false, &mut report, Some(&cb));
    drop(cb);

    let observed = Arc::try_unwrap(calls).unwrap().into_inner().unwrap();
    assert_eq!(observed, vec![(1, 5), (2, 5), (3, 5), (4, 5), (5, 5)],
        "expected monotonic ticks reaching total");
}

/// Mid-import "kill" simulation: process the first batch, lose all pending
/// write-backs, then retry the WHOLE set. Library should converge to
/// exactly the right ref count with zero duplicates.
#[tokio::test]
async fn mid_import_kill_recovers_without_duplicates() {
    let (_tmp, library) = make_vault();
    let provider = Arc::new(InMemorySyncProvider::new());
    let provider_dyn: Arc<dyn SyncProvider> = provider.clone();

    // 10 NAS notes, all id-less (the failure-mode that triggers safety net).
    for i in 0..10 {
        provider.put_md(&format!("/V/note{:02}.md", i),
            format!("body {}\n", i).as_bytes()).await.unwrap();
    }

    // First "import" runs but write-back never replays (kill before Phase 3).
    let (fetched1, mut r1) = scan_remote(&provider_dyn, "/V").await.unwrap();
    let _ = import_into_library(fetched1, &library, false, &mut r1, None);
    let after_first = library.refs().list().unwrap().len();
    assert_eq!(after_first, 10, "first run committed 10 refs");

    // Retry — NAS still has no ids on any note.
    let (fetched2, mut r2) = scan_remote(&provider_dyn, "/V").await.unwrap();
    let pending2 = import_into_library(fetched2, &library, false, &mut r2, None);
    let after_retry = library.refs().list().unwrap().len();

    assert_eq!(after_retry, 10,
        "retry must not duplicate any ref; got {} refs", after_retry);
    assert_eq!(r2.newly_registered, 0, "all 10 must hash-match existing refs");
    assert_eq!(r2.already_registered, 10);
    assert_eq!(pending2.len(), 10,
        "all 10 still need write-back (NAS hasn't been patched yet)");
}

/// Without the safety net (which we can't disable from outside), confirm
/// that the WITH-safety-net behaviour also handles the all-ids-present
/// case as a no-op — i.e., a normal already-in-sync vault stays stable.
#[tokio::test]
async fn already_synced_vault_is_a_no_op() {
    let (_tmp, library) = make_vault();
    let provider = Arc::new(InMemorySyncProvider::new());
    let provider_dyn: Arc<dyn SyncProvider> = provider.clone();

    // 3 notes that already have ids in their frontmatter.
    for i in 0..3 {
        let body = format!(
            "---\nid: \"2026052410000{}\"\n---\nbody {}\n",
            i, i
        );
        provider.put_md(&format!("/V/n{}.md", i), body.as_bytes()).await.unwrap();
    }

    // First import.
    let (f1, mut r1) = scan_remote(&provider_dyn, "/V").await.unwrap();
    let p1 = import_into_library(f1, &library, false, &mut r1, None);
    assert_eq!(r1.newly_registered, 3);
    assert_eq!(p1.len(), 0, "no write-backs needed");

    // Second import — should be a complete no-op.
    let (f2, mut r2) = scan_remote(&provider_dyn, "/V").await.unwrap();
    let p2 = import_into_library(f2, &library, false, &mut r2, None);
    assert_eq!(r2.newly_registered, 0);
    assert_eq!(r2.already_registered, 3);
    assert_eq!(p2.len(), 0);
    assert_eq!(library.refs().list().unwrap().len(), 3);
}
