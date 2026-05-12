//! NAS integration tests for Ref Sync (Sub-Stage 4.3).
//!
//! Requires NOTOLOGY_TEST_NAS_* env vars.
//! Run: cargo test --test sync_v2_ref_sync_integration -- --nocapture

use std::sync::Arc;
use std::path::PathBuf;
use chrono::Utc;

use app_lib::core::cas::CasStore;
use app_lib::core::refs::{NoteRef, RefStore};
use app_lib::core::sync_provider::SyncProvider;
use app_lib::core::version_dag::VersionDag;
use app_lib::features::sync_v2::ref_sync::RefSync;
use app_lib::features::sync_v2::webdav_provider::WebDavProvider;
use app_lib::core::webdav::WebDavClient;

struct TestEnv {
    cas: Arc<CasStore>,
    ref_store: Arc<RefStore>,
    provider: Arc<WebDavProvider>,
    vault_path: PathBuf,
    _dir: tempfile::TempDir,
}

fn setup() -> Option<TestEnv> {
    let url = std::env::var("NOTOLOGY_TEST_NAS_URL").ok()?;
    let user = std::env::var("NOTOLOGY_TEST_NAS_USER").ok()?;
    let pass = std::env::var("NOTOLOGY_TEST_NAS_PASS").ok()?;
    let base = std::env::var("NOTOLOGY_TEST_NAS_BASE").ok()?;

    let nanos = Utc::now().timestamp_nanos_opt().unwrap_or(0);
    let tid = format!("{:?}", std::thread::current().id()).replace("ThreadId(", "").replace(")", "");
    let test_base = format!("{}/ref_test_{}_{}", base.trim_end_matches('/'), nanos, tid);

    let client = WebDavClient::new(&url, &user, &pass).ok()?;
    let provider = Arc::new(WebDavProvider::new(client, test_base));

    let dir = tempfile::tempdir().ok()?;
    let vault_path = dir.path().to_path_buf();
    let cas = Arc::new(CasStore::new(&vault_path).ok()?);
    let ref_store = Arc::new(RefStore::new(&vault_path).ok()?);

    Some(TestEnv { cas, ref_store, provider, vault_path, _dir: dir })
}

/// Commit a note locally: CAS object + DAG entry + ref.
fn commit_local(e: &TestEnv, note_id: &str, content: &[u8], parent: Option<&str>) -> NoteRef {
    let hash = e.cas.write_object(content).unwrap();
    let mut dag = VersionDag::load(&e.vault_path, note_id).unwrap_or_default();
    dag.append(hash.clone(), parent.map(|s| s.to_string()), "test-local".into(), vec![]);
    dag.save(&e.vault_path, note_id).unwrap();
    let r = NoteRef {
        note_id: note_id.into(),
        head_hash: hash,
        relative_path: format!("{}.md", note_id),
        updated_at: Utc::now(),
        sync_etag: None,
    };
    e.ref_store.set(&r).unwrap();
    r
}

/// Push a note directly to NAS (simulate another device).
async fn commit_remote(e: &TestEnv, note_id: &str, content: &[u8], parent: Option<&str>) -> NoteRef {
    let hash = CasStore::hash(content);
    e.provider.put_object(&hash, content).await.unwrap();
    let mut dag: VersionDag = match e.provider.get_dag(note_id).await.unwrap() {
        Some(b) => serde_json::from_slice(&b).unwrap_or_default(),
        None => VersionDag::default(),
    };
    dag.append(hash.clone(), parent.map(|s| s.to_string()), "test-remote".into(), vec![]);
    let dag_bytes = serde_json::to_vec_pretty(&dag).unwrap();
    e.provider.put_dag(note_id, &dag_bytes).await.unwrap();
    let r = NoteRef {
        note_id: note_id.into(),
        head_hash: hash,
        relative_path: format!("{}.md", note_id),
        updated_at: Utc::now(),
        sync_etag: None,
    };
    let ref_bytes = serde_json::to_vec_pretty(&r).unwrap();
    e.provider.put_ref(note_id, &ref_bytes).await.unwrap();
    r
}

fn make_sync(e: &TestEnv) -> RefSync {
    RefSync::new(&e.vault_path, e.cas.clone(), e.ref_store.clone(), e.provider.clone())
}

#[tokio::test]
async fn test_real_nas_ref_sync_local_only() {
    let e = match setup() {
        Some(e) => e,
        None => { eprintln!("Skipping NAS test"); return; }
    };
    let r = commit_local(&e, "20260420000001", b"local content", None);
    println!("[NAS] Local note: head={}", &r.head_hash[..8]);

    let result = make_sync(&e).sync_all().await.unwrap();
    println!("[NAS] Pushes: {}, Pulls: {}, Conflicts: {}", result.fast_forwarded_pushes.len(), result.fast_forwarded_pulls.len(), result.conflicts.len());
    assert_eq!(result.fast_forwarded_pushes.len(), 1);
    assert!(result.failed.is_empty(), "Failures: {:?}", result.failed);

    let remote = e.provider.get_ref("20260420000001").await.unwrap();
    assert!(remote.is_some(), "Ref should be on NAS");
    println!("[NAS] Local-only push OK");
}

#[tokio::test]
async fn test_real_nas_ref_sync_remote_only() {
    let e = match setup() {
        Some(e) => e,
        None => { eprintln!("Skipping NAS test"); return; }
    };
    let r = commit_remote(&e, "20260420000002", b"remote content", None).await;
    println!("[NAS] Remote note: head={}", &r.head_hash[..8]);

    let result = make_sync(&e).sync_all().await.unwrap();
    println!("[NAS] Pushes: {}, Pulls: {}, Failed: {:?}", result.fast_forwarded_pushes.len(), result.fast_forwarded_pulls.len(), result.failed);
    assert_eq!(result.fast_forwarded_pulls.len(), 1);
    assert!(result.failed.is_empty(), "Failures: {:?}", result.failed);

    let local = e.ref_store.get("20260420000002").unwrap();
    assert!(local.is_some(), "Local should have ref after pull");
    assert!(e.cas.has_object(&r.head_hash), "Local CAS should have head object");
    println!("[NAS] Remote-only pull OK");
}

#[tokio::test]
async fn test_real_nas_ref_sync_fast_forward_push() {
    let e = match setup() {
        Some(e) => e,
        None => { eprintln!("Skipping NAS test"); return; }
    };
    // Push v1
    let r1 = commit_local(&e, "20260420000003", b"v1", None);
    make_sync(&e).sync_all().await.unwrap();
    println!("[NAS] v1 pushed: {}", &r1.head_hash[..8]);

    // Advance locally to v2
    let r2 = commit_local(&e, "20260420000003", b"v2", Some(&r1.head_hash));
    let result = make_sync(&e).sync_all().await.unwrap();
    println!("[NAS] FF push: pushes={}, conflicts={}", result.fast_forwarded_pushes.len(), result.conflicts.len());
    assert_eq!(result.fast_forwarded_pushes.len(), 1);
    assert!(result.conflicts.is_empty());

    // Verify NAS has v2
    let (remote_bytes, _) = e.provider.get_ref("20260420000003").await.unwrap().unwrap();
    let remote_ref: NoteRef = serde_json::from_slice(&remote_bytes).unwrap();
    assert_eq!(remote_ref.head_hash, r2.head_hash);
    println!("[NAS] Fast-forward push OK");
}

#[tokio::test]
async fn test_real_nas_ref_sync_conflict_detection() {
    let e = match setup() {
        Some(e) => e,
        None => { eprintln!("Skipping NAS test"); return; }
    };
    // Shared base
    let base = commit_local(&e, "20260420000004", b"base", None);
    make_sync(&e).sync_all().await.unwrap();
    println!("[NAS] Base synced: {}", &base.head_hash[..8]);

    // Local advances
    let local_v2 = commit_local(&e, "20260420000004", b"local v2", Some(&base.head_hash));
    // Remote advances (different content)
    let remote_v2 = commit_remote(&e, "20260420000004", b"remote v2", Some(&base.head_hash)).await;
    println!("[NAS] Diverged: local={}, remote={}", &local_v2.head_hash[..8], &remote_v2.head_hash[..8]);

    let result = make_sync(&e).sync_all().await.unwrap();
    println!("[NAS] Conflicts: {}, Pushes: {}, Pulls: {}", result.conflicts.len(), result.fast_forwarded_pushes.len(), result.fast_forwarded_pulls.len());

    assert_eq!(result.conflicts.len(), 1);
    assert_eq!(result.fast_forwarded_pushes.len(), 0);
    assert_eq!(result.fast_forwarded_pulls.len(), 0);

    // Neither side modified
    let local_after = e.ref_store.get("20260420000004").unwrap().unwrap();
    assert_eq!(local_after.head_hash, local_v2.head_hash, "Local unchanged");
    let (remote_bytes, _) = e.provider.get_ref("20260420000004").await.unwrap().unwrap();
    let remote_after: NoteRef = serde_json::from_slice(&remote_bytes).unwrap();
    assert_eq!(remote_after.head_hash, remote_v2.head_hash, "Remote unchanged");
    println!("[NAS] Conflict detection OK, both sides preserved");
}

#[tokio::test]
async fn test_real_nas_ref_sync_mixed_batch() {
    let e = match setup() {
        Some(e) => e,
        None => { eprintln!("Skipping NAS test"); return; }
    };
    // A: local only
    commit_local(&e, "20260420000010", b"A local", None);
    // B: remote only
    commit_remote(&e, "20260420000011", b"B remote", None).await;
    // C: same both sides (sync first, then check no-op)
    commit_local(&e, "20260420000012", b"C same", None);
    make_sync(&e).sync_all().await.unwrap(); // pushes A+C, pulls B
    println!("[NAS] Initial sync done");

    // Second sync: everything should be in-sync
    let result = make_sync(&e).sync_all().await.unwrap();
    println!("[NAS] Mixed: pushes={}, pulls={}, unchanged={}, conflicts={}, failed={:?}",
        result.fast_forwarded_pushes.len(), result.fast_forwarded_pulls.len(),
        result.unchanged, result.conflicts.len(), result.failed);
    // All 3 notes should now be unchanged
    assert_eq!(result.unchanged, 3);
    assert!(result.fast_forwarded_pushes.is_empty());
    assert!(result.fast_forwarded_pulls.is_empty());
    assert!(result.conflicts.is_empty());
    println!("[NAS] Mixed batch OK — all converged");
}
