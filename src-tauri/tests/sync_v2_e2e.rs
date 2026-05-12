mod common;
use common::e2e_helpers::*;

use app_lib::core::sync_provider::SyncProvider;
use app_lib::features::sync_v2::migration_manager::MigrationManager;

#[tokio::test]
async fn test_e2e_smoke_setup() {
    let Some(env) = setup_devices(2).await else {
        eprintln!("[E2E] NOTOLOGY_TEST_NAS_URL not set; skipping");
        return;
    };
    assert_eq!(env.devices.len(), 2);
    assert_eq!(env.devices[0].device_id, "dev-a");
    assert_eq!(env.devices[1].device_id, "dev-b");
    eprintln!("[E2E] smoke: 2 devices OK, nas_base={}", env.nas_base);
    env.cleanup().await;
}

// ── S1: Fast-forward sync ───────────────────────────────

#[tokio::test]
async fn test_e2e_s1_fast_forward() {
    let Some(env) = setup_devices(2).await else {
        eprintln!("[E2E] NOTOLOGY_TEST_NAS_URL not set; skipping S1");
        return;
    };

    let note_id = "00000000000001";
    create_note_on(&env, 0, note_id, "content from A").await;

    // Device A pushes
    let r0 = sync(&env, 0).await.expect("device 0 sync failed");
    assert!(r0.refs_pushed.len() >= 1, "device 0 should push at least 1 ref, got {}", r0.refs_pushed.len());
    eprintln!("[E2E] S1: dev-a pushed {} refs, {} objects", r0.refs_pushed.len(), r0.objects_uploaded);

    // Device B pulls
    let r1 = sync(&env, 1).await.expect("device 1 sync failed");
    eprintln!("[E2E] S1: dev-b pulled {} refs", r1.refs_pulled.len());

    assert_file_exists(&env, 1, note_id).await;
    assert_same_head(&env, 0, 1, note_id).await;
    eprintln!("[E2E] S1: fast-forward OK");

    env.cleanup().await;
}

// ── S2: Conflict + resolve + propagation ────────────────

#[tokio::test]
async fn test_e2e_s2_conflict_resolve_propagation() {
    let Some(env) = setup_devices(2).await else {
        eprintln!("[E2E] NOTOLOGY_TEST_NAS_URL not set; skipping S2");
        return;
    };

    let note_id = "00000000000001";

    // Both devices start with same note
    create_note_on(&env, 0, note_id, "initial content").await;
    sync(&env, 0).await.expect("initial push");
    sync(&env, 1).await.expect("initial pull");
    assert_same_head(&env, 0, 1, note_id).await;
    let h = env.devices[0].ref_store.get(note_id).unwrap().unwrap();
    eprintln!("[E2E-DIAG] step=initial_sync, dev-a head={}, dev-b head={}",
        h.head_hash, env.devices[1].ref_store.get(note_id).unwrap().unwrap().head_hash);

    // Concurrent edits
    edit_note_on(&env, 0, note_id, "A branch content").await;
    let ha = env.devices[0].ref_store.get(note_id).unwrap().unwrap();
    eprintln!("[E2E-DIAG] step=after_edit_a, dev-a head={}", ha.head_hash);
    edit_note_on(&env, 1, note_id, "B branch content").await;
    let hb = env.devices[1].ref_store.get(note_id).unwrap().unwrap();
    eprintln!("[E2E-DIAG] step=after_edit_b, dev-b head={}", hb.head_hash);

    // Device A pushes its edit
    let r0 = sync(&env, 0).await.expect("A push");
    let ha2 = env.devices[0].ref_store.get(note_id).unwrap().unwrap();
    eprintln!("[E2E-DIAG] step=after_a_sync, dev-a head={}, report refs_pushed={:?} refs_pulled={:?} conflicts={}",
        ha2.head_hash, r0.refs_pushed, r0.refs_pulled, r0.conflicts_detected);

    // Device B syncs — should detect conflict
    let r1 = sync(&env, 1).await.expect("B sync");
    let hb2 = env.devices[1].ref_store.get(note_id).unwrap().unwrap();
    eprintln!("[E2E-DIAG] step=after_b_sync, dev-b head={}, report refs_pushed={:?} refs_pulled={:?} conflicts={}",
        hb2.head_hash, r1.refs_pushed, r1.refs_pulled, r1.conflicts_detected);
    assert!(r1.conflicts_detected >= 1, "expected conflict, got conflicts_detected={}", r1.conflicts_detected);

    // List conflicts on dev-b
    let conflicts = env.devices[1].engine.list_conflicts().await.expect("list_conflicts");
    eprintln!("[E2E-DIAG] step=b_list_conflicts, count={}", conflicts.len());
    for c in &conflicts {
        eprintln!("[E2E-DIAG]   note={}, branches={}", c.note_id, c.branches.len());
        for b in &c.branches {
            eprintln!("[E2E-DIAG]     branch_id={}, head={}, device={}", b.branch_id, b.head_hash, b.source_device);
        }
    }

    let note_conflict = conflicts.iter()
        .find(|c| c.note_id == note_id)
        .expect("conflict for note not found");
    let b_branch = note_conflict.branches.iter()
        .find(|b| b.source_device.contains("dev-b"))
        .expect("B branch not found in conflict branches");
    let b_branch_id = b_branch.branch_id.clone();
    eprintln!("[E2E-DIAG] step=resolve_target, branch_id={}, head={}", b_branch_id, b_branch.head_hash);

    // Device B resolves — keep B branch
    env.devices[1].engine.resolve_conflict(note_id, &b_branch_id).await
        .expect("resolve_conflict failed");
    let hb3 = env.devices[1].ref_store.get(note_id).unwrap().unwrap();
    eprintln!("[E2E-DIAG] step=after_resolve, dev-b head={}", hb3.head_hash);
    let post_resolve_conflicts = env.devices[1].engine.list_conflicts().await.unwrap();
    eprintln!("[E2E-DIAG] step=after_resolve, dev-b conflicts_remaining={}", post_resolve_conflicts.len());

    // Diagnostic: check dev-a local DAG state before sync
    {
        use app_lib::core::version_dag::VersionDag;
        let dag_a = VersionDag::load(&env.devices[0].vault_path, note_id).unwrap_or_default();
        eprintln!("[E2E-DIAG] step=pre_a_sync, dev-a local DAG entries={}", dag_a.versions.len());
        for v in &dag_a.versions {
            eprintln!("[E2E-DIAG]   hash={}..., parents={:?}", &v.content_hash[..16], v.parents);
        }
        // Check if dev-a has B's head object in CAS
        let b_head = env.devices[1].ref_store.get(note_id).unwrap().unwrap().head_hash.clone();
        let a_has_b_obj = env.devices[0].cas_store.read_object(&b_head).ok().flatten().is_some();
        eprintln!("[E2E-DIAG] step=pre_a_sync, dev-a has B's head obj ({})={}", &b_head[..16], a_has_b_obj);
        let a_head = env.devices[0].ref_store.get(note_id).unwrap().unwrap().head_hash.clone();
        eprintln!("[E2E-DIAG] step=pre_a_sync, dev-a local ref head={}", &a_head[..16]);
    }

    // Dev-a post-resolve sync
    let r_a = sync(&env, 0).await.expect("A post-resolve sync");
    let ha3 = env.devices[0].ref_store.get(note_id).unwrap().unwrap();
    let a_conflicts = env.devices[0].engine.list_conflicts().await.unwrap();
    eprintln!("[E2E-DIAG] step=a_post_resolve_sync, dev-a head={}, conflicts_detected={}, list_conflicts count={}, report refs_pushed={:?} refs_pulled={:?} unchanged={} errors={:?}",
        ha3.head_hash, r_a.conflicts_detected, a_conflicts.len(), r_a.refs_pushed, r_a.refs_pulled, r_a.unchanged_refs,
        r_a.errors.iter().map(|e| format!("{}: {}", e.phase as u8, &e.message)).collect::<Vec<_>>());

    if r_a.conflicts_detected > 0 || !a_conflicts.is_empty() {
        for c in &a_conflicts {
            eprintln!("[E2E-DIAG]   dev-a conflict note={}, branches={}", c.note_id, c.branches.len());
            for b in &c.branches {
                eprintln!("[E2E-DIAG]     branch_id={}, head={}, device={}", b.branch_id, b.head_hash, b.source_device);
            }
        }
        // Dev-a resolves conflict — choose branch matching B's resolved head
        let b_resolved_ref = env.devices[1].ref_store.get(note_id).expect("ref").expect("ref exists");
        if let Some(a_note_conflict) = a_conflicts.iter().find(|c| c.note_id == note_id) {
            let target_branch = a_note_conflict.branches.iter()
                .find(|b| b.head_hash == b_resolved_ref.head_hash)
                .expect("matching branch for B's resolved head on dev-a");
            eprintln!("[E2E-DIAG] step=a_resolve, branch_id={}", target_branch.branch_id);
            env.devices[0].engine.resolve_conflict(note_id, &target_branch.branch_id).await
                .expect("dev-a resolve_conflict");
        }
    }

    // Dev-b post-resolve sync
    let r_b2 = sync(&env, 1).await.expect("B post-resolve sync");
    let hb4 = env.devices[1].ref_store.get(note_id).unwrap().unwrap();
    eprintln!("[E2E-DIAG] step=b_post_resolve_sync, dev-b head={}, refs_pushed={:?} refs_pulled={:?}",
        hb4.head_hash, r_b2.refs_pushed, r_b2.refs_pulled);

    // Final sync round
    sync(&env, 0).await.expect("A final sync");
    sync(&env, 1).await.expect("B final sync");
    let ha_final = env.devices[0].ref_store.get(note_id).unwrap().unwrap();
    let hb_final = env.devices[1].ref_store.get(note_id).unwrap().unwrap();
    eprintln!("[E2E-DIAG] step=final, dev-a head={}, dev-b head={}", ha_final.head_hash, hb_final.head_hash);

    assert_same_head(&env, 0, 1, note_id).await;
    eprintln!("[E2E] S2: heads converged after resolve");

    // Branches should be cleaned up (D11)
    assert_branch_count(&env, 0, note_id, 0).await;
    assert_branch_count(&env, 1, note_id, 0).await;
    eprintln!("[E2E] S2: branch cleanup OK");

    env.cleanup().await;
}

// ── S3: Migration → first sync ──────────────────────────

#[tokio::test]
async fn test_e2e_s3_migration_then_first_sync() {
    let Some(env) = setup_devices_with_legacy_a(2).await else {
        eprintln!("[E2E] NOTOLOGY_TEST_NAS_URL not set; skipping S3");
        return;
    };

    let vault_a = &env.devices[0].vault_path;
    let legacy_note_id = "20260101000001";

    // Verify legacy state exists
    assert!(vault_a.join(".notology/sync").is_dir(), "legacy dir should exist before migration");
    eprintln!("[E2E] S3: legacy dir exists");

    // Migrate
    let mgr = MigrationManager::new(vault_a);
    let status = mgr.migrate().await.expect("migration failed");
    eprintln!("[E2E] S3: migration status = {:?}", status);

    // Verify migration results
    assert!(vault_a.join(".notology/sync.legacy").is_dir(), "archive should exist after migration");
    assert!(!vault_a.join(".notology/sync").is_dir(), "legacy dir should be gone after migration");
    assert!(
        matches!(status, app_lib::features::sync_v2::migration_manager::MigrationStatus::Migrated { .. }),
        "expected Migrated status, got {:?}", status,
    );
    eprintln!("[E2E] S3: migration verified");

    // First sync: device A pushes
    sync(&env, 0).await.expect("A first sync");
    eprintln!("[E2E] S3: dev-a first sync OK");

    // Device B pulls
    sync(&env, 1).await.expect("B pull");
    eprintln!("[E2E] S3: dev-b pull OK");

    // Verify legacy note propagated
    assert_file_exists(&env, 1, legacy_note_id).await;
    assert_same_head(&env, 0, 1, legacy_note_id).await;
    eprintln!("[E2E] S3: legacy note propagated OK");

    env.cleanup().await;
}

// ── S4: Polling auto-sync ───────────────────────────────
// Uses InMemoryProvider — start_paused=true is incompatible with real NAS I/O
// (paused tokio time blocks HTTP timeouts).

#[tokio::test(start_paused = true)]
async fn test_e2e_s4_polling_auto_sync() {
    let env = setup_devices_inmemory_with_polling(2, std::time::Duration::from_secs(30)).await;
    let interval = std::time::Duration::from_secs(30);

    // Dev-b starts polling
    start_polling(&env, 1).await;

    // Dev-a creates and pushes a note
    create_note_on(&env, 0, "00000000000001", "from A").await;
    sync(&env, 0).await.expect("dev-a sync");
    eprintln!("[E2E] S4: dev-a pushed, awaiting dev-b polling tick");

    // Advance time past one polling interval
    advance_and_yield(interval + std::time::Duration::from_secs(1)).await;

    // Dev-b should have auto-pulled via polling
    assert_file_exists(&env, 1, "00000000000001").await;
    assert_same_head(&env, 0, 1, "00000000000001").await;
    eprintln!("[E2E] S4: polling auto-sync OK");

    env.devices[1].engine.stop_polling().await;
}

// ── S5: Concurrent sync rejected ────────────────────────

#[tokio::test]
async fn test_e2e_s5_concurrent_sync_rejected() {
    let (env, provider) = setup_devices_inmemory_with_delay(1, 100).await;

    // Create some notes so sync has work to do
    create_notes_batch(&env, 0, 5).await;

    let engine = env.devices[0].engine.clone();
    let engine2 = engine.clone();
    let (r1, r2) = tokio::join!(
        engine.sync_once(),
        engine2.sync_once(),
    );

    let oks = [&r1, &r2].iter().filter(|r| r.is_ok()).count();
    let errs = [&r1, &r2].iter().filter(|r| r.is_err()).count();
    assert_eq!(oks, 1, "expected 1 Ok, got {} (r1={:?}, r2={:?})", oks, r1, r2);
    assert_eq!(errs, 1);

    let err_msg = [&r1, &r2].iter()
        .find(|r| r.is_err())
        .unwrap()
        .as_ref()
        .unwrap_err();
    assert!(err_msg.contains("already in progress"),
            "expected 'already in progress', got: {}", err_msg);
    eprintln!("[E2E] S5: concurrent sync rejected OK");

    // Reset delay for clean drop
    provider.set_delay(0);
}

// ── S6: Error rollback (InMemory only) ──────────────────

/// NOTE: S6 uses InMemoryProvider with FailInjectingProvider wrapper.
/// WebDavProvider에 대한 fail injection은 4.9 범위 외.
#[tokio::test]
async fn test_e2e_s6_error_rollback_inmemory() {
    let (env, fail_provider) = setup_devices_inmemory_with_fail_injection_on(2, 0).await;

    create_note_on(&env, 0, "00000000000001", "note 1").await;
    create_note_on(&env, 0, "00000000000002", "note 2").await;

    // Fail on 2nd put_object
    fail_provider.set_fail_at(Some(2));

    // sync_once returns Ok(report) with errors, not Err (best-effort per D15)
    let r = sync(&env, 0).await.expect("sync_once should return Ok even with partial failures");
    assert!(!r.errors.is_empty(), "expected errors in report, got none");
    eprintln!("[E2E] S6: first sync had {} errors as expected", r.errors.len());

    // Remove failure injection
    fail_provider.set_fail_at(None);

    // Retry — should succeed
    let r2 = sync(&env, 0).await.expect("retry sync should succeed");
    eprintln!("[E2E] S6: retry sync: errors={}, refs_pushed={:?}", r2.errors.len(), r2.refs_pushed);

    // Dev-b pulls everything
    sync(&env, 1).await.expect("dev-b sync");

    assert_file_exists(&env, 1, "00000000000001").await;
    assert_file_exists(&env, 1, "00000000000002").await;
    assert_same_head(&env, 0, 1, "00000000000001").await;
    assert_same_head(&env, 0, 1, "00000000000002").await;
    eprintln!("[E2E] S6: error rollback + recovery OK");
}

// ── S7: Stale device ────────────────────────────────────

#[tokio::test]
async fn test_e2e_s7_stale_device() {
    let Some(env) = setup_devices(2).await else {
        eprintln!("[E2E] NOTOLOGY_TEST_NAS_URL not set; skipping S7");
        return;
    };

    let note_id = "00000000000001";

    // Both devices sync initial note
    create_note_on(&env, 0, note_id, "initial").await;
    sync(&env, 0).await.expect("initial push");
    sync(&env, 1).await.expect("initial pull");
    assert_same_head(&env, 0, 1, note_id).await;
    eprintln!("[E2E] S7: initial sync OK");

    // Delete dev-a's remote device state to simulate stale/reset device.
    // Create a standalone provider to access remote directly.
    {
        use app_lib::features::sync_v2::webdav_provider::WebDavProvider;
        use app_lib::core::webdav::WebDavClient;

        let url = std::env::var("NOTOLOGY_TEST_NAS_URL").unwrap();
        let user = std::env::var("NOTOLOGY_TEST_NAS_USER").unwrap();
        let pass = std::env::var("NOTOLOGY_TEST_NAS_PASS").unwrap();
        let client = WebDavClient::new(&url, &user, &pass).unwrap();
        let prov: Box<dyn SyncProvider> = Box::new(WebDavProvider::new(client, env.nas_base.clone()));
        // Overwrite dev-a state with empty ref_hashes (simulates state loss)
        let empty_state = br#"{"device_id":"dev-a","last_push":"2020-01-01T00:00:00Z","ref_hashes":{},"schema_version":1}"#;
        prov.put_device_state("dev-a", empty_state).await.expect("overwrite state");
        eprintln!("[E2E] S7: dev-a remote state wiped");
    }

    // Dev-b creates a new note while dev-a is "stale"
    create_note_on(&env, 1, "00000000000002", "from B while A was stale").await;
    sync(&env, 1).await.expect("dev-b push new note");
    eprintln!("[E2E] S7: dev-b pushed new note");

    // Dev-a syncs — should recover and pull dev-b's new note
    let r = sync(&env, 0).await.expect("dev-a stale sync");
    eprintln!("[E2E] S7: dev-a stale sync: refs_pulled={:?}, errors={}", r.refs_pulled, r.errors.len());

    assert_file_exists(&env, 0, "00000000000002").await;
    assert_same_head(&env, 0, 1, "00000000000002").await;

    // No conflicts expected (pure fast-forward)
    let conflicts = env.devices[0].engine.list_conflicts().await.unwrap();
    assert_eq!(conflicts.len(), 0, "unexpected conflicts: {:?}", conflicts.iter().map(|c| &c.note_id).collect::<Vec<_>>());
    eprintln!("[E2E] S7: stale device recovery OK");

    env.cleanup().await;
}

// ── S8: Multi-note batch (50) ───────────────────────────

#[tokio::test]
async fn test_e2e_s8_multi_note_batch() {
    let Some(env) = setup_devices(2).await else {
        eprintln!("[E2E] NOTOLOGY_TEST_NAS_URL not set; skipping S8");
        return;
    };

    create_notes_batch(&env, 0, 50).await;
    eprintln!("[E2E] S8: created 50 notes locally");

    let r = sync(&env, 0).await.expect("dev-a batch sync");
    assert_eq!(r.refs_pushed.len(), 50, "expected 50 refs pushed, got {}", r.refs_pushed.len());
    eprintln!("[E2E] S8: dev-a pushed {} refs, {} objects in batch", r.refs_pushed.len(), r.objects_uploaded);

    sync(&env, 1).await.expect("dev-b batch pull");

    for i in 1..=50u32 {
        let id = format!("{:014}", i);
        assert_file_exists(&env, 1, &id).await;
        assert_same_head(&env, 0, 1, &id).await;
    }
    eprintln!("[E2E] S8: all 50 notes converged");

    env.cleanup().await;
}

// ── S9: Resolve propagation (3 devices) ─────────────────

#[tokio::test]
async fn test_e2e_s9_resolve_propagation_three_devices() {
    let Some(env) = setup_devices(3).await else {
        eprintln!("[E2E] NOTOLOGY_TEST_NAS_URL not set; skipping S9");
        return;
    };

    let note_id = "00000000000001";

    // All 3 devices start with same note
    create_note_on(&env, 0, note_id, "initial").await;
    sync(&env, 0).await.expect("initial push");
    sync(&env, 1).await.expect("dev-b initial pull");
    sync(&env, 2).await.expect("dev-c initial pull");
    assert_all_converged(&env, note_id).await;
    eprintln!("[E2E] S9: 3-way initial sync OK");

    // Concurrent edits on dev-a and dev-b
    edit_note_on(&env, 0, note_id, "A branch").await;
    edit_note_on(&env, 1, note_id, "B branch").await;

    // Dev-a pushes
    sync(&env, 0).await.expect("dev-a push");
    eprintln!("[E2E] S9: dev-a pushed A branch");

    // Dev-b syncs — conflict
    let r_b = sync(&env, 1).await.expect("dev-b sync");
    assert!(r_b.conflicts_detected >= 1, "dev-b expected conflict, got {}", r_b.conflicts_detected);
    eprintln!("[E2E] S9: dev-b detected conflict");

    // Dev-c syncs — also sees conflict (remote has A, which differs from its initial state... wait no)
    // Dev-c has "initial" head, remote has A head. A is descendant of initial → fast-forward pull.
    // Dev-c won't see conflict — it just pulls A.
    let r_c = sync(&env, 2).await.expect("dev-c sync");
    eprintln!("[E2E] S9: dev-c sync: refs_pulled={:?}, conflicts={}", r_c.refs_pulled, r_c.conflicts_detected);

    // Dev-a resolves: keep A branch
    // Dev-a needs to see branches — they were created by dev-b's sync
    let conflicts_a = env.devices[0].engine.list_conflicts().await.unwrap();
    if !conflicts_a.is_empty() {
        let a_note = conflicts_a.iter().find(|c| c.note_id == note_id).unwrap();
        let a_branch = a_note.branches.iter()
            .find(|b| b.source_device.contains("dev-a"))
            .expect("A branch");
        env.devices[0].engine.resolve_conflict(note_id, &a_branch.branch_id).await
            .expect("dev-a resolve");
        eprintln!("[E2E] S9: dev-a resolved with A branch");
    } else {
        eprintln!("[E2E] S9: dev-a sees no local conflicts (branches created by dev-b)");
    }

    // Sync all — propagate resolution
    sync(&env, 0).await.expect("dev-a post-resolve sync");
    sync(&env, 1).await.expect("dev-b post-resolve sync 1");
    sync(&env, 2).await.expect("dev-c post-resolve sync 1");

    // Dev-b and dev-c may see divergence → resolve with A branch
    for idx in 1..=2 {
        let conflicts = env.devices[idx].engine.list_conflicts().await.unwrap();
        if let Some(nc) = conflicts.iter().find(|c| c.note_id == note_id) {
            // Find branch matching A's resolved head
            let a_head = env.devices[0].ref_store.get(note_id).unwrap().unwrap().head_hash.clone();
            if let Some(target) = nc.branches.iter().find(|b| b.head_hash == a_head) {
                eprintln!("[E2E] S9: dev-{} resolving with A branch {}", (b'a' + idx as u8) as char, target.branch_id);
                env.devices[idx].engine.resolve_conflict(note_id, &target.branch_id).await
                    .expect("resolve");
            }
        }
    }

    // Final sync rounds
    sync(&env, 0).await.expect("final sync 0");
    sync(&env, 1).await.expect("final sync 1");
    sync(&env, 2).await.expect("final sync 2");
    // One more round to ensure full convergence
    sync(&env, 0).await.expect("final sync 0b");
    sync(&env, 1).await.expect("final sync 1b");
    sync(&env, 2).await.expect("final sync 2b");

    // Assert 3-way convergence
    assert_all_converged(&env, note_id).await;
    eprintln!("[E2E] S9: 3-way convergence achieved");

    // All branches cleaned up
    assert_branch_count(&env, 0, note_id, 0).await;
    assert_branch_count(&env, 1, note_id, 0).await;
    assert_branch_count(&env, 2, note_id, 0).await;
    eprintln!("[E2E] S9: branch cleanup OK");

    // Verify content is "A branch" on all devices
    for idx in 0..3 {
        let head = env.devices[idx].ref_store.get(note_id).unwrap().unwrap();
        let content = env.devices[idx].cas_store.read_object(&head.head_hash).unwrap().unwrap();
        let text = String::from_utf8_lossy(&content);
        assert!(text.contains("A branch"),
            "dev-{} content should contain 'A branch', got: {}",
            (b'a' + idx as u8) as char, text);
    }
    eprintln!("[E2E] S9: all devices have A branch content");

    env.cleanup().await;
}
