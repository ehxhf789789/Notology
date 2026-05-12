//! Integration tests against real Synology NAS.
//!
//! Requires environment variables:
//!   NOTOLOGY_TEST_NAS_URL=https://nas.example.com:port
//!   NOTOLOGY_TEST_NAS_USER=username
//!   NOTOLOGY_TEST_NAS_PASS=password
//!   NOTOLOGY_TEST_NAS_BASE=/Colony/Test2
//!
//! Load via: . "C:\Users\ehxhf\Desktop\notology_test_env.ps1"
//! Run:  cargo test --test sync_v2_webdav_integration -- --nocapture
//!
//! Skipped automatically if env vars not set.

use app_lib::core::sync_provider::*;
use app_lib::features::sync_v2::webdav_provider::WebDavProvider;
use app_lib::core::webdav::WebDavClient;
use sha2::{Sha256, Digest};

fn make_test_provider() -> Option<WebDavProvider> {
    let url = std::env::var("NOTOLOGY_TEST_NAS_URL").ok()?;
    let user = std::env::var("NOTOLOGY_TEST_NAS_USER").ok()?;
    let pass = std::env::var("NOTOLOGY_TEST_NAS_PASS").ok()?;
    let base = std::env::var("NOTOLOGY_TEST_NAS_BASE").ok()?;

    let client = WebDavClient::new(&url, &user, &pass).ok()?;
    Some(WebDavProvider::new(client, base))
}

fn hash_bytes(data: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(data);
    format!("{:x}", h.finalize())
}

#[tokio::test]
async fn test_real_nas_connection() {
    let provider = match make_test_provider() {
        Some(p) => p,
        None => {
            eprintln!("Skipping: NOTOLOGY_TEST_NAS_* env vars not set");
            return;
        }
    };

    let connected = provider.test_connection().await.unwrap();
    assert!(connected, "NAS connection failed");
    println!("[NAS] Connection OK");
}

#[tokio::test]
async fn test_real_nas_object_round_trip() {
    let provider = match make_test_provider() {
        Some(p) => p,
        None => { eprintln!("Skipping NAS test"); return; }
    };

    let test_data = b"hello stage 4 sync v2";
    let hash = hash_bytes(test_data);
    println!("[NAS] Testing object round-trip with hash: {}", hash);

    // Put
    provider.put_object(&hash, test_data).await.unwrap();
    println!("[NAS] put_object OK");

    // Has
    assert!(provider.has_object(&hash).await.unwrap());
    println!("[NAS] has_object OK");

    // Get (includes hash verification)
    let retrieved = provider.get_object(&hash).await.unwrap();
    assert_eq!(retrieved.as_deref(), Some(test_data.as_slice()));
    println!("[NAS] get_object OK (hash verified)");
}

#[tokio::test]
async fn test_real_nas_ref_round_trip() {
    let provider = match make_test_provider() {
        Some(p) => p,
        None => { eprintln!("Skipping NAS test"); return; }
    };

    let note_id = "99990000000001"; // test-only ID
    let ref_content = br#"{"note_id":"99990000000001","head_hash":"abc123"}"#;

    let version = provider.put_ref(note_id, ref_content).await.unwrap();
    println!("[NAS] put_ref OK, version: {:?}", version);

    let (content, ver) = provider.get_ref(note_id).await.unwrap().unwrap();
    assert_eq!(content, ref_content);
    println!("[NAS] get_ref OK, content matches, version: {:?}", ver);

    // Cleanup
    provider.delete_ref(note_id).await.unwrap();
    assert!(provider.get_ref(note_id).await.unwrap().is_none());
    println!("[NAS] delete_ref OK");
}

#[tokio::test]
async fn test_real_nas_per_device_state() {
    let provider = match make_test_provider() {
        Some(p) => p,
        None => { eprintln!("Skipping NAS test"); return; }
    };

    // Device A writes its state
    let state_a = br#"{"device_id":"DEV-A","last_push":"2026-04-20T00:00:00Z"}"#;
    provider.put_device_state("DEV-A", state_a).await.unwrap();
    println!("[NAS] put_device_state DEV-A OK");

    // Device B writes its state
    let state_b = br#"{"device_id":"DEV-B","last_push":"2026-04-20T00:00:00Z"}"#;
    provider.put_device_state("DEV-B", state_b).await.unwrap();
    println!("[NAS] put_device_state DEV-B OK");

    // Read back
    let got_a = provider.get_device_state("DEV-A").await.unwrap();
    assert_eq!(got_a.as_deref(), Some(state_a.as_slice()));
    println!("[NAS] get_device_state DEV-A OK");

    let got_b = provider.get_device_state("DEV-B").await.unwrap();
    assert_eq!(got_b.as_deref(), Some(state_b.as_slice()));
    println!("[NAS] get_device_state DEV-B OK");

    // List shows both
    let list = provider.list_device_states().await.unwrap();
    println!("[NAS] list_device_states: {} entries", list.len());
    let ids: Vec<&str> = list.iter().map(|d| d.device_id.as_str()).collect();
    assert!(ids.contains(&"DEV-A"), "DEV-A missing from list: {:?}", ids);
    assert!(ids.contains(&"DEV-B"), "DEV-B missing from list: {:?}", ids);
    println!("[NAS] list_device_states OK");

    // Overwrite (no conflict)
    let updated = br#"{"device_id":"DEV-A","last_push":"2026-04-20T01:00:00Z"}"#;
    provider.put_device_state("DEV-A", updated).await.unwrap();
    let got = provider.get_device_state("DEV-A").await.unwrap();
    assert_eq!(got.as_deref(), Some(updated.as_slice()));
    println!("[NAS] overwrite DEV-A OK (no conflict)");
}

#[tokio::test]
async fn test_real_nas_branch_lifecycle() {
    let provider = match make_test_provider() {
        Some(p) => p,
        None => { eprintln!("Skipping NAS test"); return; }
    };

    let note_id = "99990000000002";
    let branch_name = "DEV-TEST-12345678";

    // Create
    provider.put_branch(note_id, branch_name, b"branch-content").await.unwrap();
    println!("[NAS] put_branch OK");

    // List
    let branches = provider.list_branches(note_id).await.unwrap();
    assert!(branches.contains(&branch_name.to_string()));
    println!("[NAS] list_branches OK: {:?}", branches);

    // Get
    let content = provider.get_branch(note_id, branch_name).await.unwrap();
    assert_eq!(content, Some(b"branch-content".to_vec()));
    println!("[NAS] get_branch OK");

    // Delete
    provider.delete_branch(note_id, branch_name).await.unwrap();
    println!("[NAS] delete_branch OK");
}

#[tokio::test]
async fn test_real_nas_md_file() {
    let provider = match make_test_provider() {
        Some(p) => p,
        None => { eprintln!("Skipping NAS test"); return; }
    };

    let md_content = b"---\nid: \"99990000000003\"\ntitle: \"Test Note\"\n---\n\nHello from sync v2!";
    provider.put_md("_sync_v2_test/test_note.md", md_content).await.unwrap();
    println!("[NAS] put_md OK");

    // Cleanup
    provider.delete_md("_sync_v2_test/test_note.md").await.unwrap();
    println!("[NAS] delete_md OK");
}
