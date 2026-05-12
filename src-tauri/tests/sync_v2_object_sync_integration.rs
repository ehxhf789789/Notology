//! Integration tests for Object Sync against real Synology NAS.
//!
//! Requires environment variables:
//!   NOTOLOGY_TEST_NAS_URL, NOTOLOGY_TEST_NAS_USER,
//!   NOTOLOGY_TEST_NAS_PASS, NOTOLOGY_TEST_NAS_BASE
//!
//! To run:
//!   . "C:\Users\ehxhf\Desktop\Git\P01_Notology\notology_test_env.ps1"
//!   cd src-tauri
//!   cargo test --test sync_v2_object_sync_integration -- --nocapture
//!
//! Skips gracefully if env vars not set.

use std::sync::Arc;
use app_lib::core::cas::CasStore;
use app_lib::core::sync_provider::SyncProvider;
use app_lib::features::sync_v2::object_sync::ObjectSync;
use app_lib::features::sync_v2::webdav_provider::WebDavProvider;
use app_lib::core::webdav::WebDavClient;

struct TestEnv {
    cas: Arc<CasStore>,
    provider: Arc<WebDavProvider>,
    _temp_dir: tempfile::TempDir,
}

fn setup_test_env() -> Option<TestEnv> {
    let url = std::env::var("NOTOLOGY_TEST_NAS_URL").ok()?;
    let user = std::env::var("NOTOLOGY_TEST_NAS_USER").ok()?;
    let pass = std::env::var("NOTOLOGY_TEST_NAS_PASS").ok()?;
    let base = std::env::var("NOTOLOGY_TEST_NAS_BASE").ok()?;

    // Unique subdirectory per test invocation (tests run in parallel)
    let nanos = chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0);
    let tid = format!("{:?}", std::thread::current().id())
        .replace("ThreadId(", "").replace(")", "");
    let test_base = format!("{}/obj_test_{}_{}", base.trim_end_matches('/'), nanos, tid);

    let client = WebDavClient::new(&url, &user, &pass).ok()?;
    let provider = Arc::new(WebDavProvider::new(client, test_base));

    let temp_dir = tempfile::tempdir().ok()?;
    let cas = Arc::new(CasStore::new(temp_dir.path()).ok()?);

    Some(TestEnv { cas, provider, _temp_dir: temp_dir })
}

#[tokio::test]
async fn test_real_nas_object_sync_push() {
    let env = match setup_test_env() {
        Some(e) => e,
        None => { eprintln!("Skipping NAS test"); return; }
    };

    let mut hashes = Vec::new();
    for i in 0..5 {
        let h = env.cas.write_object(format!("push test {}", i).as_bytes()).unwrap();
        hashes.push(h);
    }
    println!("[NAS] Created 5 local objects");

    let sync = ObjectSync::new(env.cas.clone(), env.provider.clone());
    let result = sync.sync().await.expect("sync failed");

    println!("[NAS] Uploaded: {}, Failed: {}", result.uploaded.len(), result.failed_uploads.len());
    assert!(result.is_complete_success(), "Failures: {:?}", result.failed_uploads);
    assert_eq!(result.uploaded.len(), 5);

    for h in &hashes {
        assert!(env.provider.has_object(h).await.unwrap(), "Missing on NAS: {}", h);
    }
    println!("[NAS] All 5 objects verified on NAS");
}

#[tokio::test]
async fn test_real_nas_object_sync_pull() {
    let env = match setup_test_env() {
        Some(e) => e,
        None => { eprintln!("Skipping NAS test"); return; }
    };

    let mut hashes = Vec::new();
    for i in 0..5 {
        let content = format!("pull test {}", i);
        let hash = CasStore::hash(content.as_bytes());
        env.provider.put_object(&hash, content.as_bytes()).await.unwrap();
        hashes.push(hash);
    }
    println!("[NAS] Put 5 objects directly on NAS");

    let sync = ObjectSync::new(env.cas.clone(), env.provider.clone());
    let result = sync.sync().await.expect("sync failed");

    println!("[NAS] Downloaded: {}, Failed: {}", result.downloaded.len(), result.failed_downloads.len());
    assert!(result.is_complete_success(), "Failures: {:?}", result.failed_downloads);
    assert_eq!(result.downloaded.len(), 5);

    for (i, h) in hashes.iter().enumerate() {
        let content = env.cas.read_object(h).unwrap().expect("missing in local CAS");
        assert_eq!(content, format!("pull test {}", i).as_bytes());
    }
    println!("[NAS] All 5 objects verified in local CAS");
}

#[tokio::test]
async fn test_real_nas_object_sync_bidirectional() {
    let env = match setup_test_env() {
        Some(e) => e,
        None => { eprintln!("Skipping NAS test"); return; }
    };

    // 3 local-only
    for i in 0..3 {
        env.cas.write_object(format!("local {}", i).as_bytes()).unwrap();
    }
    // 3 remote-only
    for i in 0..3 {
        let content = format!("remote {}", i);
        let hash = CasStore::hash(content.as_bytes());
        env.provider.put_object(&hash, content.as_bytes()).await.unwrap();
    }
    println!("[NAS] Setup: 3 local + 3 remote");

    let sync = ObjectSync::new(env.cas.clone(), env.provider.clone());
    let result = sync.sync().await.expect("sync failed");

    println!("[NAS] Uploaded: {}, Downloaded: {}", result.uploaded.len(), result.downloaded.len());
    assert_eq!(result.uploaded.len(), 3);
    assert_eq!(result.downloaded.len(), 3);
    assert!(result.is_complete_success());

    assert_eq!(env.cas.list_objects().unwrap().len(), 6);
    assert_eq!(env.provider.list_objects().await.unwrap().len(), 6);
    println!("[NAS] Convergence: both sides have 6 objects");
}

#[tokio::test]
async fn test_real_nas_object_sync_idempotent() {
    let env = match setup_test_env() {
        Some(e) => e,
        None => { eprintln!("Skipping NAS test"); return; }
    };

    for i in 0..3 {
        env.cas.write_object(format!("idem {}", i).as_bytes()).unwrap();
    }

    let sync = ObjectSync::new(env.cas.clone(), env.provider.clone());

    let r1 = sync.sync().await.unwrap();
    assert_eq!(r1.uploaded.len(), 3);
    println!("[NAS] First sync: uploaded 3");

    let r2 = sync.sync().await.unwrap();
    assert_eq!(r2.uploaded.len(), 0);
    assert_eq!(r2.downloaded.len(), 0);
    assert_eq!(r2.already_synced, 3);
    println!("[NAS] Second sync: 0 uploads, 3 already-synced (idempotent)");
}

#[tokio::test]
async fn test_real_nas_object_sync_concurrency_benchmark() {
    // Just check env vars are set — each benchmark level creates its own env
    if setup_test_env().is_none() {
        eprintln!("Skipping NAS test");
        return;
    }

    const COUNT: usize = 30;
    let levels = [1, 4, 6, 10];

    println!("\n[BENCH] === Object Sync Concurrency Benchmark ===");
    println!("[BENCH] {} objects per run", COUNT);
    println!("[BENCH] {:<12} {:<15} {:<15}", "Concurrency", "Time", "Throughput");

    for &c in &levels {
        // Fresh env per level
        let bench = match setup_test_env() {
            Some(e) => e,
            None => return,
        };

        for i in 0..COUNT {
            bench.cas.write_object(format!("bench c{} i{}", c, i).as_bytes()).unwrap();
        }

        let sync = ObjectSync::new(bench.cas.clone(), bench.provider.clone())
            .with_concurrency(c);

        let start = std::time::Instant::now();
        let result = sync.sync().await.unwrap();
        let elapsed = start.elapsed();

        let throughput = COUNT as f64 / elapsed.as_secs_f64();
        println!("[BENCH] {:<12} {:<15?} {:.1} obj/s", c, elapsed, throughput);

        let success_count = result.uploaded.len();
        let success_rate = success_count as f64 / COUNT as f64;
        println!("[BENCH] Concurrency={}: {}/{} succeeded ({:.0}%)",
            c, success_count, COUNT, success_rate * 100.0);

        if success_rate < 0.8 {
            println!("[BENCH] WARNING: Concurrency {} has high failure rate — NAS throttling likely", c);
            if !result.failed_uploads.is_empty() {
                println!("[BENCH] Sample failures: {:?}",
                    &result.failed_uploads[..result.failed_uploads.len().min(3)]);
            }
        }
    }

    println!("[BENCH] Pick concurrency where throughput plateaus.");
}
