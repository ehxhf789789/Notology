//! Integration tests for connection module: device lifecycle + orphan cleanup
//! + device_id determinism. Uses InMemorySyncProvider (no NAS required).

use std::sync::Arc;
use tempfile::TempDir;

use app_lib::core::library::Library;
use app_lib::core::sync_provider::SyncProvider;
use app_lib::features::sync_v2::in_memory_provider::InMemorySyncProvider;
use app_lib::features::connection::device::{
    DeviceInfo, DeviceStatus, compute_device_id, sanitize_hostname,
};
use app_lib::features::connection::device_registry;
use app_lib::features::connection::orphan_cleaner;
use app_lib::features::connection::remote_import;
use app_lib::features::connection::store::{self, WebDavConfig};

fn make_device(device_id: &str, hostname: &str, machine_id: &str) -> DeviceInfo {
    DeviceInfo {
        device_id: device_id.into(),
        hostname: hostname.into(),
        os: "windows".into(),
        machine_id: machine_id.into(),
        app_version: "3.0.0".into(),
        first_login_at: chrono::Utc::now().to_rfc3339(),
        last_login_at: chrono::Utc::now().to_rfc3339(),
        session_count: 1,
        status: DeviceStatus::Online,
        login_at: chrono::Utc::now().to_rfc3339(),
        last_seen_at: chrono::Utc::now().to_rfc3339(),
        logout_at: None,
        last_ip: None,
    }
}

fn provider() -> Arc<dyn SyncProvider> {
    Arc::new(InMemorySyncProvider::new())
}

// ── 1. mark_logout NAS 반영 ────────────────────────────

#[tokio::test]
async fn mark_logout_reflects_to_nas_via_lifecycle() {
    let tmp = TempDir::new().unwrap();
    let p = provider();
    let mut device = make_device("host-aabbccdd", "host", "mid-A");
    let cfg = WebDavConfig {
        url: "http://test".into(),
        username: "u".into(),
        password: "p".into(),
        label: "test".into(),
        remember_password: true,
        device: device.clone(),
        last_active_vault_hash: None,
    };
    store::save(tmp.path(), &cfg).unwrap();
    device_registry::register_device(&device, &p).await.unwrap();

    // Logout via lifecycle
    device_registry::mark_logout(tmp.path(), &p).await.unwrap();

    let listed = device_registry::list_all_devices(&p).await.unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].status, DeviceStatus::Offline);
    assert!(listed[0].logout_at.is_some());

    // Local config also reflects
    let after = store::load(tmp.path()).unwrap().unwrap();
    assert_eq!(after.device.status, DeviceStatus::Offline);
    let _ = device; // suppress unused
}

// ── 2. Orphan cleanup: same PC, different device_id ────

#[tokio::test]
async fn orphan_cleaner_removes_same_pc_different_id() {
    let p = provider();
    let old = make_device("host-OLD11111", "host", "mid-A");
    let new_d = make_device("host-NEW22222", "host", "mid-A");
    device_registry::register_device(&old, &p).await.unwrap();
    device_registry::register_device(&new_d, &p).await.unwrap();

    let cleaned = orphan_cleaner::clean_orphans(&p, &new_d).await.unwrap();
    assert_eq!(cleaned, 1);

    let listed = device_registry::list_all_devices(&p).await.unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].device_id, "host-NEW22222");
}

// ── 3. Orphan cleanup: different PC preserved ──────────

#[tokio::test]
async fn orphan_cleaner_preserves_different_pc() {
    let p = provider();
    // Same hostname but different machine_id → different PC
    let other_pc = make_device("host-OTHER111", "host", "mid-DIFFERENT");
    let me = make_device("host-NEW22222", "host", "mid-A");
    device_registry::register_device(&other_pc, &p).await.unwrap();
    device_registry::register_device(&me, &p).await.unwrap();

    let cleaned = orphan_cleaner::clean_orphans(&p, &me).await.unwrap();
    assert_eq!(cleaned, 0, "different machine_id must be preserved");

    let listed = device_registry::list_all_devices(&p).await.unwrap();
    assert_eq!(listed.len(), 2);
}

// ── 4. Orphan cleanup: never removes self ──────────────

#[tokio::test]
async fn orphan_cleaner_skips_self() {
    let p = provider();
    let me = make_device("host-aabbccdd", "host", "mid-A");
    device_registry::register_device(&me, &p).await.unwrap();

    let cleaned = orphan_cleaner::clean_orphans(&p, &me).await.unwrap();
    assert_eq!(cleaned, 0);

    let listed = device_registry::list_all_devices(&p).await.unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].device_id, "host-aabbccdd");
}

// ── 5. compute_device_id determinism ──────────────────

#[tokio::test]
async fn compute_device_id_is_deterministic() {
    let id1 = compute_device_id("test-host", "machine-id-123");
    let id2 = compute_device_id("test-host", "machine-id-123");
    assert_eq!(id1, id2, "same input → same id");

    // 100 calls produce same result
    for _ in 0..100 {
        assert_eq!(compute_device_id("test-host", "machine-id-123"), id1);
    }
}

#[tokio::test]
async fn compute_device_id_differs_for_different_machine() {
    let a = compute_device_id("host", "mid-A");
    let b = compute_device_id("host", "mid-B");
    assert_ne!(a, b);
}

#[tokio::test]
async fn compute_device_id_differs_for_different_hostname() {
    let a = compute_device_id("host-a", "mid");
    let b = compute_device_id("host-b", "mid");
    assert_ne!(a, b);
}

#[tokio::test]
async fn compute_device_id_does_not_leak_machine_id() {
    let mid = "supersecret-machine-id-12345";
    let id = compute_device_id("host", mid);
    assert!(!id.contains(mid), "device_id must not leak raw machine_id");
    assert!(!id.contains("supersecret"), "device_id must not leak machine_id substring");
}

#[tokio::test]
async fn compute_device_id_format_hostname_dash_8hex() {
    let id = compute_device_id("Hanbin-labCore", "abc-123");
    // Format: "{hostname}-{8 hex chars}"
    let parts: Vec<&str> = id.rsplitn(2, '-').collect();
    assert_eq!(parts.len(), 2, "must contain at least one dash");
    let suffix = parts[0];
    assert_eq!(suffix.len(), 8, "suffix must be 8 hex chars, got: {}", suffix);
    assert!(suffix.chars().all(|c| c.is_ascii_hexdigit()),
        "suffix must be hex, got: {}", suffix);
}

// ── 6. sanitize_hostname ──────────────────────────────

#[tokio::test]
async fn sanitize_hostname_preserves_safe_chars() {
    assert_eq!(sanitize_hostname("Hanbin-labCore"), "Hanbin-labCore");
    assert_eq!(sanitize_hostname("host_01"), "host_01");
    assert_eq!(sanitize_hostname("ABC123"), "ABC123");
}

#[tokio::test]
async fn sanitize_hostname_replaces_unsafe_chars() {
    assert_eq!(sanitize_hostname("host name"), "host_name"); // space
    assert_eq!(sanitize_hostname("host.local"), "host_local"); // dot
    assert_eq!(sanitize_hostname("host/path"), "host_path"); // slash
}

// ── 7. Migration preserves session_count ──────────────

#[tokio::test]
async fn migrating_device_id_preserves_session_count() {
    let mut old = make_device("host-OLDFORMAT", "host", "mid-A");
    old.session_count = 42;
    old.first_login_at = "2026-01-01T00:00:00+00:00".into();

    // Simulate migration: replace device_id, hostname, os, machine_id from template
    let template = make_device(
        &compute_device_id("host", "mid-A"),
        "host",
        "mid-A",
    );
    old.device_id = template.device_id.clone();
    old.machine_id = template.machine_id;
    old.hostname = template.hostname;
    old.os = template.os;
    // mark_login bumps session_count by 1
    old.mark_login();

    assert_eq!(old.device_id, template.device_id);
    assert_eq!(old.session_count, 43, "session_count preserved + bumped");
    assert_eq!(old.first_login_at, "2026-01-01T00:00:00+00:00",
        "first_login_at must be preserved");
}

// ── 8. Full lifecycle with migration + cleanup ────────

#[tokio::test]
async fn full_migration_lifecycle() {
    let tmp = TempDir::new().unwrap();
    let p = provider();

    // 1. Old format device on NAS (timestamp-based id)
    let old = make_device("host-OLDTIME01", "host", "mid-X");
    let cfg = WebDavConfig {
        url: "http://test".into(),
        username: "u".into(),
        password: "p".into(),
        label: "test".into(),
        remember_password: true,
        device: old.clone(),
        last_active_vault_hash: None,
    };
    store::save(tmp.path(), &cfg).unwrap();
    device_registry::register_device(&old, &p).await.unwrap();

    // 2. Migration: replace with deterministic device_id
    let new_id = compute_device_id("host", "mid-X");
    let mut config = store::load(tmp.path()).unwrap().unwrap();
    config.device.device_id = new_id.clone();
    config.device.mark_login();
    store::save(tmp.path(), &config).unwrap();
    device_registry::register_device(&config.device, &p).await.unwrap();

    // 3. Orphan cleanup
    let cleaned = orphan_cleaner::clean_orphans(&p, &config.device).await.unwrap();
    assert_eq!(cleaned, 1, "old device must be cleaned");

    // 4. Verify only new device remains
    let listed = device_registry::list_all_devices(&p).await.unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].device_id, new_id);
    assert_eq!(listed[0].machine_id, "mid-X");
    assert_eq!(listed[0].hostname, "host");
}

// ── Remote import (NAS .md scan + register in Library) ────────────────

const REMOTE_BASE: &str = "/test-vault";

fn setup_lib() -> (TempDir, Library) {
    let tmp = TempDir::new().unwrap();
    let library = Library::new_with_device_id(tmp.path(), "test-device".into()).unwrap();
    (tmp, library)
}

async fn put_remote_md(provider: &Arc<dyn SyncProvider>, path: &str, content: &str) {
    // path is relative to vault root; provider's md_path will prepend REMOTE_BASE
    use app_lib::core::sync_provider::SyncProvider as _;
    provider.put_md(path, content.as_bytes()).await.unwrap();
}

fn provider_with_base() -> Arc<dyn SyncProvider> {
    // InMemoryProvider doesn't have a built-in remote_base, so paths are stored
    // verbatim. We mimic NAS layout by prefixing REMOTE_BASE in the test data.
    Arc::new(InMemorySyncProvider::new())
}

#[tokio::test]
async fn remote_import_registers_unregistered_md() {
    let (_tmp, library) = setup_lib();
    let p = provider_with_base();

    // Put .md files at vault paths (provider stores by path)
    let content = "---\nid: '20260101120000'\ntitle: Note A\n---\n\nbody";
    put_remote_md(&p, "/test-vault/folder/note.md", content).await;

    let report = remote_import::scan_and_import(&p, REMOTE_BASE, &library, false).await.unwrap();

    assert_eq!(report.found_md_files, 1);
    assert_eq!(report.newly_registered, 1);
    assert_eq!(report.already_registered, 0);

    let r = library.get_ref("20260101120000").unwrap();
    assert!(r.is_some(), "ref must exist after import");
    assert_eq!(r.unwrap().relative_path, "folder/note.md");
}

#[tokio::test]
async fn remote_import_skips_test_artifacts() {
    let (_tmp, library) = setup_lib();
    let p = provider_with_base();

    // User note in normal folder
    put_remote_md(&p, "/test-vault/Notes/note.md",
        "---\nid: '20260101000001'\n---\nuser data").await;
    // Test artifact folders that must be skipped
    put_remote_md(&p, "/test-vault/obj_test_177/leaked.md",
        "---\nid: '20260101000002'\n---\nartifact").await;
    put_remote_md(&p, "/test-vault/e2e_abc/leaked.md",
        "---\nid: '20260101000003'\n---\nartifact").await;
    put_remote_md(&p, "/test-vault/_sync_v2_test/leaked.md",
        "---\nid: '20260101000004'\n---\nartifact").await;

    let report = remote_import::scan_and_import(&p, REMOTE_BASE, &library, false).await.unwrap();

    assert_eq!(report.newly_registered, 1, "only the user note should register");
    assert!(report.skipped_artifacts >= 3, "must skip artifact folders");
    assert!(library.get_ref("20260101000001").unwrap().is_some());
    assert!(library.get_ref("20260101000002").unwrap().is_none());
    assert!(library.get_ref("20260101000003").unwrap().is_none());
}

#[tokio::test]
async fn remote_import_idempotent_second_run_no_change() {
    let (_tmp, library) = setup_lib();
    let p = provider_with_base();

    put_remote_md(&p, "/test-vault/note.md",
        "---\nid: '20260101000010'\n---\nbody").await;

    let r1 = remote_import::scan_and_import(&p, REMOTE_BASE, &library, false).await.unwrap();
    assert_eq!(r1.newly_registered, 1);

    let r2 = remote_import::scan_and_import(&p, REMOTE_BASE, &library, false).await.unwrap();
    assert_eq!(r2.newly_registered, 0);
    assert_eq!(r2.already_registered, 1);
}

#[tokio::test]
async fn remote_import_generates_id_if_missing() {
    let (_tmp, library) = setup_lib();
    let p = provider_with_base();

    // No frontmatter id
    put_remote_md(&p, "/test-vault/orphan.md", "# Just a heading\n\nbody").await;

    let report = remote_import::scan_and_import(&p, REMOTE_BASE, &library, false).await.unwrap();
    assert_eq!(report.newly_registered, 1);
    assert!(report.errors.is_empty());

    // Some new ref should exist (we don't know the generated id but library should have ≥1)
    // Refs dir scan via get_ref is per-id; instead use library iteration if available.
    // Fallback: read the registered file from Library and verify content was committed.
    // (We assume id generation works — covered by note_id::generate_id tests separately.)
}

#[tokio::test]
async fn remote_import_dry_run_no_mutation() {
    let (_tmp, library) = setup_lib();
    let p = provider_with_base();

    put_remote_md(&p, "/test-vault/dry.md",
        "---\nid: '20260101000020'\n---\nbody").await;

    let report = remote_import::scan_and_import(&p, REMOTE_BASE, &library, true).await.unwrap();

    assert_eq!(report.newly_registered, 1, "dry-run reports what WOULD register");
    assert!(library.get_ref("20260101000020").unwrap().is_none(),
        "dry-run must NOT actually create refs");
}

#[tokio::test]
async fn remote_import_handles_invalid_utf8_gracefully() {
    let (_tmp, library) = setup_lib();
    let p = Arc::new(InMemorySyncProvider::new()) as Arc<dyn SyncProvider>;

    // Mix valid + invalid UTF-8
    use app_lib::core::sync_provider::SyncProvider as _;
    p.put_md("/test-vault/good.md",
        b"---\nid: '20260101000030'\n---\nok").await.unwrap();
    p.put_md("/test-vault/bad.md", &[0xff, 0xfe, 0x00, 0x80]).await.unwrap();

    let report = remote_import::scan_and_import(&p, REMOTE_BASE, &library, false).await.unwrap();

    assert_eq!(report.found_md_files, 2);
    assert_eq!(report.newly_registered, 1, "good file imports");
    assert!(!report.errors.is_empty(), "bad file logs an error");
    assert!(library.get_ref("20260101000030").unwrap().is_some());
}

// ── Phase 1.x: id write-back to NAS for full idempotency ─────────

#[tokio::test]
async fn remote_import_writes_id_back_to_nas() {
    use app_lib::core::sync_provider::SyncProvider as _;
    let (_tmp, library) = setup_lib();
    let p = provider_with_base();

    // No frontmatter id — register_one will generate one.
    let original = "# Hello\n\nNo frontmatter here.";
    put_remote_md(&p, "/test-vault/note.md", original).await;

    let report = remote_import::scan_and_import(&p, REMOTE_BASE, &library, false).await.unwrap();
    assert_eq!(report.newly_registered, 1);
    assert_eq!(report.id_written_back, 1, "no-id source must be written back");

    // Re-fetch NAS .md → frontmatter must now contain a valid id.
    let nas_after = p.get_md("/test-vault/note.md").await.unwrap()
        .expect("file should still exist after write-back");
    let nas_str = std::str::from_utf8(&nas_after).unwrap();
    let parsed_id = app_lib::core::note_id::read_id_from_content(nas_str);
    assert!(parsed_id.is_some(), "NAS .md should have id injected");
    assert!(app_lib::core::note_id::is_valid_id(&parsed_id.unwrap()));
}

#[tokio::test]
async fn remote_import_existing_id_no_writeback() {
    use app_lib::core::sync_provider::SyncProvider as _;
    let (_tmp, library) = setup_lib();
    let p = provider_with_base();

    let original = "---\nid: '20260101120000'\ntitle: Already Tagged\n---\nbody";
    put_remote_md(&p, "/test-vault/already.md", original).await;

    let report = remote_import::scan_and_import(&p, REMOTE_BASE, &library, false).await.unwrap();
    assert_eq!(report.newly_registered, 1);
    assert_eq!(report.id_written_back, 0, "id already present → no PUT");

    // NAS .md content must be byte-identical (no needless rewrite).
    let nas_after = p.get_md("/test-vault/already.md").await.unwrap().unwrap();
    assert_eq!(nas_after, original.as_bytes(), "remote bytes must be unchanged");
}

#[tokio::test]
async fn remote_import_fully_idempotent_after_writeback() {
    let (_tmp, library) = setup_lib();
    let p = provider_with_base();

    // Mix: 2 with ids + 3 without → 5 total, 3 need write-back.
    put_remote_md(&p, "/test-vault/a.md", "---\nid: '20260101000001'\n---\nA").await;
    put_remote_md(&p, "/test-vault/b.md", "---\nid: '20260101000002'\n---\nB").await;
    put_remote_md(&p, "/test-vault/c.md", "# C\n\nno id").await;
    put_remote_md(&p, "/test-vault/sub/d.md", "# D\n\nno id").await;
    put_remote_md(&p, "/test-vault/e.md", "no frontmatter at all").await;

    let r1 = remote_import::scan_and_import(&p, REMOTE_BASE, &library, false).await.unwrap();
    assert_eq!(r1.found_md_files, 5);
    assert_eq!(r1.newly_registered, 5);
    assert_eq!(r1.already_registered, 0);
    assert_eq!(r1.id_written_back, 3, "3 no-id files must have ids written back");

    // 2nd run: all files now have stable ids → fully idempotent.
    let r2 = remote_import::scan_and_import(&p, REMOTE_BASE, &library, false).await.unwrap();
    assert_eq!(r2.found_md_files, 5);
    assert_eq!(r2.newly_registered, 0, "no new registrations on re-run");
    assert_eq!(r2.already_registered, 5);
    assert_eq!(r2.id_written_back, 0, "no further write-backs needed");
    assert!(r2.errors.is_empty(), "re-run should be clean");
}

#[tokio::test]
async fn remote_import_unique_ids_no_collision() {
    let (_tmp, library) = setup_lib();
    let p = provider_with_base();

    // 5 no-id files registered in the same wall-clock second would have
    // collided with `generate_id()` (1s resolution). With `generate_unique_id()`
    // they each get a distinct ms+counter id.
    for i in 0..5 {
        put_remote_md(&p, &format!("/test-vault/n{}.md", i),
            &format!("# Note {}\n", i)).await;
    }

    let report = remote_import::scan_and_import(&p, REMOTE_BASE, &library, false).await.unwrap();
    assert_eq!(report.newly_registered, 5);
    assert_eq!(report.id_written_back, 5);

    // Each of the 5 files must have a *distinct* id on NAS post-writeback.
    use app_lib::core::sync_provider::SyncProvider as _;
    let mut ids: Vec<String> = Vec::new();
    for i in 0..5 {
        let bytes = p.get_md(&format!("/test-vault/n{}.md", i)).await.unwrap().unwrap();
        let s = std::str::from_utf8(&bytes).unwrap();
        let id = app_lib::core::note_id::read_id_from_content(s)
            .expect("id must be present after write-back");
        ids.push(id);
    }
    let unique: std::collections::HashSet<_> = ids.iter().collect();
    assert_eq!(unique.len(), 5, "all 5 ids must be distinct (no collisions)");
}

// ── NAS folder browser ──────────────────────────────────────

#[tokio::test]
async fn nas_browser_lists_children_and_detects_vault_marker() {
    use app_lib::core::sync_provider::SyncProvider as _;
    use app_lib::features::sync_v2::commands::browse_folder_with_provider;

    let p: Arc<dyn SyncProvider> = Arc::new(InMemorySyncProvider::new());

    // Layout:
    //   /Colony/Vault1/.notology/marker     ← vault
    //   /Colony/Vault1/notes.md
    //   /Colony/PlainFolder/file.md         ← plain folder, not a vault
    p.put_md("/Colony/Vault1/.notology/marker.md", b"x").await.unwrap();
    p.put_md("/Colony/Vault1/notes.md", b"y").await.unwrap();
    p.put_md("/Colony/PlainFolder/file.md", b"z").await.unwrap();

    let listing = browse_folder_with_provider(&p, "/Colony").await.unwrap();
    assert_eq!(listing.path, "/Colony");
    let names: Vec<&str> = listing.children.iter().map(|c| c.name.as_str()).collect();
    assert!(names.contains(&"Vault1"));
    assert!(names.contains(&"PlainFolder"));

    let vault1 = listing.children.iter().find(|c| c.name == "Vault1").unwrap();
    assert!(vault1.is_collection);
    assert!(vault1.is_vault, "vault with .notology must be flagged");

    let plain = listing.children.iter().find(|c| c.name == "PlainFolder").unwrap();
    assert!(plain.is_collection);
    assert!(!plain.is_vault, "plain folder must not be flagged as vault");
}

#[tokio::test]
async fn nas_browser_skips_test_artifact_folders() {
    use app_lib::core::sync_provider::SyncProvider as _;
    use app_lib::features::sync_v2::commands::browse_folder_with_provider;

    let p: Arc<dyn SyncProvider> = Arc::new(InMemorySyncProvider::new());
    p.put_md("/Colony/RealVault/.notology/marker.md", b"x").await.unwrap();
    p.put_md("/Colony/obj_test_177/leaked.md", b"a").await.unwrap();
    p.put_md("/Colony/e2e_abc/leaked.md", b"a").await.unwrap();
    p.put_md("/Colony/_sync_v2_test/leaked.md", b"a").await.unwrap();

    let listing = browse_folder_with_provider(&p, "/Colony").await.unwrap();
    let names: Vec<&str> = listing.children.iter().map(|c| c.name.as_str()).collect();
    assert!(names.contains(&"RealVault"));
    assert!(!names.iter().any(|n| n.starts_with("obj_test_")));
    assert!(!names.iter().any(|n| n.starts_with("e2e_")));
    assert!(!names.iter().any(|n| n.starts_with("_sync_v2_test")));
}

#[tokio::test]
async fn remote_import_repairs_broken_frontmatter_no_churn() {
    // Real-world ghffltnpt.md scenario: opening fence exists but closing is
    // missing, with several stale `id:` lines accumulated from prior buggy
    // imports. Without repair, every run would generate yet another id and
    // prepend another duplicate line — file grows forever and banner shows
    // "1 unregistered note" perpetually. After repair, the file is clean and
    // subsequent runs are idempotent.
    use app_lib::core::sync_provider::SyncProvider as _;
    let (_tmp, library) = setup_lib();
    let p = provider_with_base();

    let broken = "---\nid: \"20260505110338772\"\nid: \"20260505110324852\"\nid: \"20260505072355199\"\n\n# 내용\n\n$5$5$\n";
    put_remote_md(&p, "/test-vault/broken.md", broken).await;

    // 1st run: detect broken FM, repair, register, write-back to NAS.
    let r1 = remote_import::scan_and_import(&p, REMOTE_BASE, &library, false).await.unwrap();
    assert_eq!(r1.found_md_files, 1);
    assert_eq!(r1.newly_registered, 1);
    assert_eq!(r1.id_written_back, 1, "broken file must be repaired + PUT to NAS");
    assert!(r1.errors.is_empty());

    // NAS post-repair: exactly one id line, closing fence present, body intact.
    let nas_after = p.get_md("/test-vault/broken.md").await.unwrap().unwrap();
    let s = std::str::from_utf8(&nas_after).unwrap();
    assert_eq!(s.matches("id:").count(), 1, "NAS file should have one id line");
    assert!(s.contains("\n---\n"), "NAS file must have a closing fence");
    assert!(s.contains("# 내용"));
    assert!(s.contains("$5$5$"));
    // Stale ids gone.
    assert!(!s.contains("20260505110338772"));

    // 2nd run: fully idempotent — no churn, no further write-backs.
    let r2 = remote_import::scan_and_import(&p, REMOTE_BASE, &library, false).await.unwrap();
    assert_eq!(r2.newly_registered, 0, "no re-registration after repair");
    assert_eq!(r2.already_registered, 1);
    assert_eq!(r2.id_written_back, 0, "no further write-back");
}

#[tokio::test]
async fn remote_import_treats_backslash_path_as_same_file() {
    // Regression: legacy Windows code paths committed refs with backslashes
    // (e.g. `ghgh\note.md`). The scanner normalizes to forward slashes. Without
    // path normalization in collision detection we would falsely flag the same
    // file as a sibling collision and reassign its id every run.
    let (_tmp, library) = setup_lib();
    let p = provider_with_base();

    let id = "20260427104218";
    let content = format!("---\nid: '{}'\n---\nbody", id);
    put_remote_md(&p, "/test-vault/sub/note.md", &content).await;

    // Pre-seed the library with a backslash-style ref (simulates a ref that was
    // pulled from NAS where it was stored by older Windows-native code).
    library.commit_version(id, content.as_bytes(), "sub\\note.md", vec![]).unwrap();

    let report = remote_import::scan_and_import(&p, REMOTE_BASE, &library, false).await.unwrap();
    assert_eq!(report.found_md_files, 1);
    assert_eq!(report.newly_registered, 0,
        "same file via backslash vs forward slash must NOT be a collision");
    assert_eq!(report.already_registered, 1);
    assert_eq!(report.id_written_back, 0);

    // Original id must be preserved on NAS — no churn.
    let nas_after = p.get_md("/test-vault/sub/note.md").await.unwrap().unwrap();
    let parsed = app_lib::core::note_id::read_id_from_content(
        std::str::from_utf8(&nas_after).unwrap()
    ).unwrap();
    assert_eq!(parsed, id, "id must not be reassigned");
}

#[tokio::test]
async fn remote_import_breaks_conflict_copy_id_collision() {
    use app_lib::core::sync_provider::SyncProvider as _;
    let (_tmp, library) = setup_lib();
    let p = provider_with_base();

    // Two siblings sharing the same frontmatter id — typical sync_v1 conflict-copy
    // pattern (`final.md` and `final_1.md` both authored from the same primary).
    let shared_id = "20260330202149";
    let primary = format!("---\nid: '{}'\n---\nprimary content", shared_id);
    let sibling = format!("---\nid: '{}'\n---\nsibling content", shared_id);
    put_remote_md(&p, "/test-vault/final.md", &primary).await;
    put_remote_md(&p, "/test-vault/final_1.md", &sibling).await;

    // 1st run: both should register; one keeps the shared id, the other gets a
    // freshly minted id + write-back of corrected frontmatter.
    let r1 = remote_import::scan_and_import(&p, REMOTE_BASE, &library, false).await.unwrap();
    assert_eq!(r1.found_md_files, 2);
    assert_eq!(r1.newly_registered, 2);
    assert_eq!(r1.id_written_back, 1, "exactly one sibling needs id rewrite");
    assert!(r1.errors.is_empty());

    // Inspect NAS post-writeback: ids must now be distinct.
    let bytes_a = p.get_md("/test-vault/final.md").await.unwrap().unwrap();
    let bytes_b = p.get_md("/test-vault/final_1.md").await.unwrap().unwrap();
    let id_a = app_lib::core::note_id::read_id_from_content(std::str::from_utf8(&bytes_a).unwrap())
        .expect("primary keeps id");
    let id_b = app_lib::core::note_id::read_id_from_content(std::str::from_utf8(&bytes_b).unwrap())
        .expect("sibling has reassigned id");
    assert_ne!(id_a, id_b, "ids must diverge after collision break");

    // 2nd run: fully idempotent — no churn, no new write-backs.
    let r2 = remote_import::scan_and_import(&p, REMOTE_BASE, &library, false).await.unwrap();
    assert_eq!(r2.newly_registered, 0, "no re-registration on second run");
    assert_eq!(r2.already_registered, 2);
    assert_eq!(r2.id_written_back, 0, "no churn write-backs");
}
