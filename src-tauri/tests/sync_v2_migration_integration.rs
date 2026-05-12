//! Integration tests for MigrationManager (local filesystem only).

use std::fs;
use app_lib::features::sync_v2::migration_manager::{MigrationManager, MigrationStatus};

fn setup_legacy() -> (tempfile::TempDir, MigrationManager) {
    let d = tempfile::tempdir().unwrap();
    let legacy = d.path().join(".notology/sync");
    fs::create_dir_all(&legacy).unwrap();
    fs::write(legacy.join("manifest.json"), r#"{"version":1}"#).unwrap();
    fs::write(legacy.join("queue.json"), "[]").unwrap();
    fs::create_dir_all(legacy.join("cache")).unwrap();
    fs::write(legacy.join("cache/item.json"), "{}").unwrap();
    let mgr = MigrationManager::new(d.path());
    (d, mgr)
}

#[tokio::test]
async fn test_full_workflow() {
    let (_d, mgr) = setup_legacy();
    println!("[MIG] Status: {:?}", mgr.status());
    assert_eq!(mgr.status(), MigrationStatus::LegacyDetected);

    let s = mgr.migrate().await.unwrap();
    println!("[MIG] After migrate: {:?}", s);
    assert!(matches!(s, MigrationStatus::Migrated { .. }));
    assert!(!mgr.has_legacy());
    assert!(mgr.has_archive());
    assert!(_d.path().join(".notology/sync.legacy/manifest.json").exists());
    assert!(_d.path().join(".notology/sync.legacy/cache/item.json").exists());
    assert!(_d.path().join(".notology/branches").is_dir());
    assert!(_d.path().join(".notology/sync_state").is_dir());
    assert!(!mgr.cleanup_if_due().await.unwrap());
    println!("[MIG] Full workflow OK");
}

#[tokio::test]
async fn test_cleanup_after_retention() {
    let (_d, _mgr) = setup_legacy();
    let mgr = MigrationManager::new(_d.path()).with_retention(-1);
    mgr.migrate().await.unwrap();
    println!("[MIG] Migrated with immediate retention");
    assert!(mgr.cleanup_if_due().await.unwrap());
    assert_eq!(mgr.status(), MigrationStatus::Cleaned);
    println!("[MIG] Cleanup OK");
}

#[tokio::test]
async fn test_fresh_vault() {
    let d = tempfile::tempdir().unwrap();
    let mgr = MigrationManager::new(d.path());
    assert_eq!(mgr.status(), MigrationStatus::NoLegacy);
    let s = mgr.migrate().await.unwrap();
    assert_eq!(s, MigrationStatus::NoLegacy);
    assert!(d.path().join(".notology/branches").is_dir());
    println!("[MIG] Fresh vault OK");
}

#[tokio::test]
async fn test_reinstantiation() {
    let (_d, mgr) = setup_legacy();
    mgr.migrate().await.unwrap();
    let mgr2 = MigrationManager::new(_d.path());
    assert!(matches!(mgr2.status(), MigrationStatus::Migrated { .. }));
    let s = mgr2.migrate().await.unwrap();
    assert!(matches!(s, MigrationStatus::Migrated { .. }));
    println!("[MIG] Reinstantiation OK");
}
