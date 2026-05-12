//! NAS integration tests for BranchManager (Sub-Stage 4.5).
//! Requires NOTOLOGY_TEST_NAS_* env vars.

use std::sync::Arc;
use chrono::Utc;
use app_lib::core::sync_provider::SyncProvider;
use app_lib::features::sync_v2::branch_manager::{Branch, BranchManager, SCHEMA_VERSION};
use app_lib::features::sync_v2::conflict_detector::ConflictDetector;
use app_lib::features::sync_v2::ref_sync::RefConflict;
use app_lib::features::sync_v2::webdav_provider::WebDavProvider;
use app_lib::core::webdav::WebDavClient;

fn setup() -> Option<Arc<WebDavProvider>> {
    let url = std::env::var("NOTOLOGY_TEST_NAS_URL").ok()?;
    let user = std::env::var("NOTOLOGY_TEST_NAS_USER").ok()?;
    let pass = std::env::var("NOTOLOGY_TEST_NAS_PASS").ok()?;
    let base = std::env::var("NOTOLOGY_TEST_NAS_BASE").ok()?;
    let nanos = Utc::now().timestamp_nanos_opt().unwrap_or(0);
    let tid = format!("{:?}", std::thread::current().id()).replace("ThreadId(", "").replace(")", "");
    let test_base = format!("{}/branch_test_{}_{}", base.trim_end_matches('/'), nanos, tid);
    let client = WebDavClient::new(&url, &user, &pass).ok()?;
    Some(Arc::new(WebDavProvider::new(client, test_base)))
}

fn mk_conflict(note: &str) -> RefConflict {
    RefConflict {
        note_id: note.into(),
        local_head: format!("local_{}_abcdefgh", note),
        remote_head: format!("remote_{}_12345678", note),
        common_ancestor: Some(format!("base_{}", note)),
        detected_at: Utc::now(),
    }
}

#[tokio::test]
async fn test_real_nas_save_conflict() {
    let p = match setup() { Some(p) => p, None => { eprintln!("Skipping NAS test"); return; } };
    let d = ConflictDetector::new("DEV-A");
    let m = BranchManager::new();
    let info = d.prepare(mk_conflict("note1"), "DEV-B");
    let saved = m.save_conflict(p.as_ref(), &info).await.unwrap();
    println!("[NAS] Saved {} branches", saved.len());
    assert_eq!(saved.len(), 2);
    let list = m.list_branches_for_note(p.as_ref(), "note1").await.unwrap();
    assert_eq!(list.len(), 2);
    println!("[NAS] Save conflict OK");
}

#[tokio::test]
async fn test_real_nas_list_all_conflicts() {
    let p = match setup() { Some(p) => p, None => { eprintln!("Skipping NAS test"); return; } };
    let d = ConflictDetector::new("DEV-A");
    let m = BranchManager::new();
    for i in 0..3 {
        let info = d.prepare(mk_conflict(&format!("note_{}", i)), "DEV-B");
        m.save_conflict(p.as_ref(), &info).await.unwrap();
    }
    println!("[NAS] Created 3 conflicts");
    let all = m.list_all_conflicts(p.as_ref()).await.unwrap();
    println!("[NAS] list_all found {} notes", all.len());
    assert_eq!(all.len(), 3);
    println!("[NAS] list_all_conflicts OK");
}

#[tokio::test]
async fn test_real_nas_resolve() {
    let p = match setup() { Some(p) => p, None => { eprintln!("Skipping NAS test"); return; } };
    let d = ConflictDetector::new("DEV-A");
    let m = BranchManager::new();
    let info = d.prepare(mk_conflict("resolve_note"), "DEV-B");
    let saved = m.save_conflict(p.as_ref(), &info).await.unwrap();
    let chosen_id = saved[0].branch_id.clone();
    let chosen = m.resolve(p.as_ref(), "resolve_note", &chosen_id).await.unwrap();
    assert_eq!(chosen.branch_id, chosen_id);
    let remaining = m.list_branches_for_note(p.as_ref(), "resolve_note").await.unwrap();
    assert!(remaining.is_empty());
    println!("[NAS] Resolve OK, branches cleaned");
}

#[tokio::test]
async fn test_real_nas_cross_device_read() {
    let p = match setup() { Some(p) => p, None => { eprintln!("Skipping NAS test"); return; } };
    let d = ConflictDetector::new("DEV-A");
    BranchManager::new().save_conflict(p.as_ref(), &d.prepare(mk_conflict("cross"), "DEV-B")).await.unwrap();
    println!("[NAS] DEV-A saved");
    let list = BranchManager::new().list_branches_for_note(p.as_ref(), "cross").await.unwrap();
    assert_eq!(list.len(), 2);
    assert!(list.iter().all(|b| b.schema_version == SCHEMA_VERSION));
    println!("[NAS] Cross-device read OK");
}

#[tokio::test]
async fn test_real_nas_empty_list() {
    let p = match setup() { Some(p) => p, None => { eprintln!("Skipping NAS test"); return; } };
    let all = BranchManager::new().list_all_conflicts(p.as_ref()).await.unwrap();
    assert!(all.is_empty());
    println!("[NAS] Empty list OK");
}

#[tokio::test]
async fn test_real_nas_resolve_isolates() {
    let p = match setup() { Some(p) => p, None => { eprintln!("Skipping NAS test"); return; } };
    let d = ConflictDetector::new("DEV-A");
    let m = BranchManager::new();
    let ix = d.prepare(mk_conflict("x"), "DEV-B");
    let iy = d.prepare(mk_conflict("y"), "DEV-B");
    let xr = m.save_conflict(p.as_ref(), &ix).await.unwrap();
    m.save_conflict(p.as_ref(), &iy).await.unwrap();
    m.resolve(p.as_ref(), "x", &xr[0].branch_id).await.unwrap();
    assert!(m.list_branches_for_note(p.as_ref(), "x").await.unwrap().is_empty());
    assert_eq!(m.list_branches_for_note(p.as_ref(), "y").await.unwrap().len(), 2);
    println!("[NAS] Resolve isolation OK");
}
