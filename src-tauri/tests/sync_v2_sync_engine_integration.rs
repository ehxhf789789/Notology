//! NAS integration tests for SyncEngine (Sub-Stage 4.6).
//! Requires NOTOLOGY_TEST_NAS_* env vars.

use std::sync::Arc;
use std::path::PathBuf;
use chrono::Utc;
use app_lib::core::cas::CasStore;
use app_lib::core::refs::{NoteRef, RefStore};
use app_lib::core::sync_provider::SyncProvider;
use app_lib::core::version_dag::VersionDag;
use app_lib::features::sync_v2::sync_engine::{SyncEngine, SyncState};
use app_lib::features::sync_v2::webdav_provider::WebDavProvider;
use app_lib::core::webdav::WebDavClient;

struct TestEnv {
    engine: Arc<SyncEngine>,
    cas: Arc<CasStore>,
    refs: Arc<RefStore>,
    vault: PathBuf,
    _dir: tempfile::TempDir,
}

fn setup(suffix: &str) -> Option<TestEnv> {
    let url = std::env::var("NOTOLOGY_TEST_NAS_URL").ok()?;
    let user = std::env::var("NOTOLOGY_TEST_NAS_USER").ok()?;
    let pass = std::env::var("NOTOLOGY_TEST_NAS_PASS").ok()?;
    let base = std::env::var("NOTOLOGY_TEST_NAS_BASE").ok()?;
    let nanos = Utc::now().timestamp_nanos_opt().unwrap_or(0);
    let tid = format!("{:?}", std::thread::current().id()).replace("ThreadId(", "").replace(")", "");
    let test_base = format!("{}/engine_{}_{}_{}",
        base.trim_end_matches('/'), suffix, nanos, tid);
    let client = WebDavClient::new(&url, &user, &pass).ok()?;
    let provider: Arc<dyn SyncProvider> = Arc::new(WebDavProvider::new(client, test_base));
    let dir = tempfile::tempdir().ok()?;
    let vault = dir.path().to_path_buf();
    let cas = Arc::new(CasStore::new(&vault).ok()?);
    let refs = Arc::new(RefStore::new(&vault).ok()?);
    let engine = Arc::new(SyncEngine::new(
        format!("DEV-{}", suffix), provider, cas.clone(), refs.clone(), vault.clone(),
    ));
    Some(TestEnv { engine, cas, refs, vault, _dir: dir })
}

fn commit(e: &TestEnv, note_id: &str, content: &[u8], parent: Option<&str>) -> String {
    let hash = e.cas.write_object(content).unwrap();
    let mut dag = VersionDag::load(&e.vault, note_id).unwrap_or_default();
    dag.append(hash.clone(), parent.map(|s| s.to_string()), "test".into(), vec![]);
    dag.save(&e.vault, note_id).unwrap();
    e.refs.set(&NoteRef {
        note_id: note_id.into(), head_hash: hash.clone(),
        relative_path: format!("{}.md", note_id),
        updated_at: Utc::now(), sync_etag: None,
    }).unwrap();
    hash
}

#[tokio::test]
async fn test_real_nas_engine_empty_sync() {
    let e = match setup("empty") { Some(e) => e, None => { eprintln!("Skipping NAS test"); return; } };
    let r = e.engine.sync_once().await.unwrap();
    println!("[NAS] Empty sync: {}ms, errors={}", r.duration_ms, r.errors.len());
    assert!(r.errors.is_empty());
    assert!(matches!(e.engine.state().await, SyncState::Idle));
    println!("[NAS] Empty sync OK");
}

#[tokio::test]
async fn test_real_nas_engine_push_local() {
    let e = match setup("push") { Some(e) => e, None => { eprintln!("Skipping NAS test"); return; } };
    commit(&e, "20260426000001", b"local content", None);
    let r = e.engine.sync_once().await.unwrap();
    println!("[NAS] Push: refs_pushed={}, objects_up={}, errors={:?}",
        r.refs_pushed.len(), r.objects_uploaded, r.errors);
    // Should have pushed something
    assert!(r.refs_pushed.len() > 0 || r.objects_uploaded > 0);
    println!("[NAS] Push OK");
}

#[tokio::test]
async fn test_real_nas_engine_idempotent() {
    let e = match setup("idem") { Some(e) => e, None => { eprintln!("Skipping NAS test"); return; } };
    commit(&e, "20260426000002", b"idem content", None);
    e.engine.sync_once().await.unwrap();
    let r2 = e.engine.sync_once().await.unwrap();
    println!("[NAS] Second sync: pushed={}, pulled={}, unchanged={}, errors={}",
        r2.refs_pushed.len(), r2.refs_pulled.len(), r2.unchanged_refs, r2.errors.len());
    assert_eq!(r2.refs_pushed.len(), 0);
    assert_eq!(r2.refs_pulled.len(), 0);
    println!("[NAS] Idempotent OK");
}

#[tokio::test]
async fn test_real_nas_engine_list_conflicts_empty() {
    let e = match setup("lc") { Some(e) => e, None => { eprintln!("Skipping NAS test"); return; } };
    let c = e.engine.list_conflicts().await.unwrap();
    assert!(c.is_empty());
    println!("[NAS] list_conflicts empty OK");
}

#[tokio::test]
async fn test_real_nas_engine_report_duration() {
    let e = match setup("dur") { Some(e) => e, None => { eprintln!("Skipping NAS test"); return; } };
    let r = e.engine.sync_once().await.unwrap();
    println!("[NAS] Duration: {}ms", r.duration_ms);
    assert!(r.duration_ms < 30000); // sanity: under 30s
    println!("[NAS] Duration OK");
}
