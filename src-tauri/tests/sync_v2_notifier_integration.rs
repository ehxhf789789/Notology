//! NAS integration tests for ChangeNotifier (Sub-Stage 4.4).
//!
//! Requires NOTOLOGY_TEST_NAS_* env vars.
//! Run: cargo test --test sync_v2_notifier_integration -- --nocapture

use std::sync::Arc;
use std::collections::HashMap;
use chrono::Utc;

use app_lib::core::sync_provider::SyncProvider;
use app_lib::features::sync_v2::notifier::{ChangeNotifier, DeviceState};
use app_lib::features::sync_v2::webdav_provider::WebDavProvider;
use app_lib::core::webdav::WebDavClient;

fn setup() -> Option<Arc<WebDavProvider>> {
    let url = std::env::var("NOTOLOGY_TEST_NAS_URL").ok()?;
    let user = std::env::var("NOTOLOGY_TEST_NAS_USER").ok()?;
    let pass = std::env::var("NOTOLOGY_TEST_NAS_PASS").ok()?;
    let base = std::env::var("NOTOLOGY_TEST_NAS_BASE").ok()?;
    let nanos = Utc::now().timestamp_nanos_opt().unwrap_or(0);
    let tid = format!("{:?}", std::thread::current().id()).replace("ThreadId(", "").replace(")", "");
    let test_base = format!("{}/notif_test_{}_{}", base.trim_end_matches('/'), nanos, tid);
    let client = WebDavClient::new(&url, &user, &pass).ok()?;
    Some(Arc::new(WebDavProvider::new(client, test_base)))
}

#[tokio::test]
async fn test_real_nas_notifier_single_device() {
    let p = match setup() { Some(p) => p, None => { eprintln!("Skipping NAS test"); return; } };
    let n = ChangeNotifier::new("DEV-A");
    let refs: HashMap<String, String> = [("n1".into(), "h1".into()), ("n2".into(), "h2".into())].into();
    n.notify_push(p.as_ref(), refs.clone()).await.unwrap();
    println!("[NAS] DEV-A pushed 2 refs");
    let g = n.read_global_state(p.as_ref()).await.unwrap();
    assert_eq!(g.devices.len(), 1);
    assert_eq!(g.devices.get("DEV-A").unwrap().ref_hashes, refs);
    println!("[NAS] Single device round-trip OK");
}

#[tokio::test]
async fn test_real_nas_notifier_two_devices() {
    let p = match setup() { Some(p) => p, None => { eprintln!("Skipping NAS test"); return; } };
    ChangeNotifier::new("DEV-A").notify_push(p.as_ref(), [("nA".into(), "hA".into())].into()).await.unwrap();
    ChangeNotifier::new("DEV-B").notify_push(p.as_ref(), [("nB".into(), "hB".into())].into()).await.unwrap();
    println!("[NAS] Both devices pushed");
    let g = ChangeNotifier::new("DEV-A").read_global_state(p.as_ref()).await.unwrap();
    assert_eq!(g.devices.len(), 2);
    assert!(g.devices.contains_key("DEV-A"));
    assert!(g.devices.contains_key("DEV-B"));
    println!("[NAS] Two-device cross-visibility OK");
}

#[tokio::test]
async fn test_real_nas_notifier_detects_divergence() {
    let p = match setup() { Some(p) => p, None => { eprintln!("Skipping NAS test"); return; } };
    ChangeNotifier::new("DEV-B").notify_push(p.as_ref(), [("n1".into(), "h_remote".into())].into()).await.unwrap();
    println!("[NAS] DEV-B pushed n1=h_remote");
    let local: HashMap<String, String> = [("n1".into(), "h_local".into())].into();
    let changes = ChangeNotifier::new("DEV-A").check_remote_changes(p.as_ref(), &local).await.unwrap();
    assert_eq!(changes.len(), 1);
    assert!(changes[0].fully_diverged());
    println!("[NAS] Divergence detection OK");
}

#[tokio::test]
async fn test_real_nas_notifier_overwrite() {
    let p = match setup() { Some(p) => p, None => { eprintln!("Skipping NAS test"); return; } };
    let n = ChangeNotifier::new("DEV-OW");
    n.notify_push(p.as_ref(), [("n1".into(), "h1".into()), ("n2".into(), "h2".into()), ("n3".into(), "h3".into())].into()).await.unwrap();
    println!("[NAS] First push: 3 refs");
    n.notify_push(p.as_ref(), [("n1".into(), "h1_new".into())].into()).await.unwrap();
    println!("[NAS] Second push: 1 ref (replaces)");
    let g = n.read_global_state(p.as_ref()).await.unwrap();
    let s = g.devices.get("DEV-OW").unwrap();
    assert_eq!(s.ref_hashes.len(), 1);
    println!("[NAS] Overwrite semantics OK");
}
