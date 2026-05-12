//! Phase 3 scenario tests — automate the manual workflows from each part:
//!   D1..D3: Part 3-A user pause toggle.
//!   (B/C tests will be added when those parts land.)

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use chrono::Utc;

use app_lib::core::cas::CasStore;
use app_lib::core::refs::{NoteRef, RefStore};
use app_lib::core::sync_provider::SyncProvider;
use app_lib::features::sync_v2::dirty_queue::{DirtyOperation, DirtyQueue};
use app_lib::features::sync_v2::in_memory_provider::InMemorySyncProvider;
use app_lib::features::sync_v2::push_worker::PushWorker;
use app_lib::features::sync_v2::sync_engine::SyncEngine;

struct Bench {
    vault: PathBuf,
    cas: Arc<CasStore>,
    refs: Arc<RefStore>,
    provider: Arc<InMemorySyncProvider>,
    _dir: tempfile::TempDir,
}

fn bench() -> Bench {
    let dir = tempfile::tempdir().expect("tempdir");
    let vault = dir.path().to_path_buf();
    let cas = Arc::new(CasStore::new(&vault).expect("cas"));
    let refs = Arc::new(RefStore::new(&vault).expect("refs"));
    let provider = Arc::new(InMemorySyncProvider::new());
    Bench { vault, cas, refs, provider, _dir: dir }
}

fn engine(b: &Bench, device_id: &str) -> Arc<SyncEngine> {
    let provider: Arc<dyn SyncProvider> = b.provider.clone();
    Arc::new(SyncEngine::new(
        device_id.to_string(), provider, b.cas.clone(), b.refs.clone(), b.vault.clone(),
    ))
}

// ────────────────────────────────────────────────────────────
// Part 3-A — User pause toggle
// ────────────────────────────────────────────────────────────

/// `sync_once` short-circuits while paused: returns an empty report instead
/// of attempting any push/pull work. This is the central guard that covers
/// adaptive_poller's trigger AND the periodic Tier 3 timer AND
/// `signal_visibility`'s immediate trigger — one check, all paths.
#[tokio::test]
async fn scenario_d1_sync_once_short_circuits_when_paused() {
    let b = bench();
    let eng = engine(&b, "dev-local");

    // Stage a remote note that an enabled engine would pull on next sync.
    use app_lib::features::sync_v2::commands::browse_folder_with_provider as _;
    let content = b"---\nid: \"20260301000001\"\n---\nfrom another device";
    let hash = CasStore::hash(content);
    b.provider.put_object(&hash, content).await.unwrap();
    b.provider.put_md("incoming.md", content).await.unwrap();
    let mut dag = app_lib::core::version_dag::VersionDag::default();
    dag.append(hash.clone(), None, "remote".into(), vec![]);
    b.provider.put_dag("20260301000001", &serde_json::to_vec(&dag).unwrap()).await.unwrap();
    let nr = NoteRef {
        note_id: "20260301000001".into(),
        head_hash: hash,
        relative_path: "incoming.md".into(),
        updated_at: Utc::now(),
        sync_etag: None,
    };
    b.provider.put_ref("20260301000001", &serde_json::to_vec_pretty(&nr).unwrap()).await.unwrap();

    // Pause → sync_once must NOT pull the remote ref.
    eng.set_sync_enabled(false);
    let report = eng.sync_once().await.expect("sync_once");
    assert_eq!(report.refs_pulled.len(), 0, "paused engine must not pull");
    assert!(b.refs.get("20260301000001").unwrap().is_none(), "no local ref while paused");
    assert!(!b.vault.join("incoming.md").exists(), "no .md materialized");

    // Resume → next sync_once pulls.
    eng.set_sync_enabled(true);
    let report = eng.sync_once().await.expect("sync_once");
    assert_eq!(report.refs_pulled.len(), 1, "resume → pull happens");
    assert!(b.refs.get("20260301000001").unwrap().is_some());
    assert!(b.vault.join("incoming.md").exists());
}

/// PushWorker honours `sync_enabled` independently of `online`. Even when
/// the network is up, a paused vault must NOT push queued operations.
#[tokio::test]
async fn scenario_d2_push_worker_idles_while_paused() {
    let b = bench();

    // Local commit so the object exists in CAS for the worker to read.
    let content = b"---\nid: \"20260301000002\"\n---\nlocal";
    let hash = b.cas.write_object(content).unwrap();
    b.refs.set(&NoteRef {
        note_id: "20260301000002".into(),
        head_hash: hash,
        relative_path: "note.md".into(),
        updated_at: Utc::now(),
        sync_etag: None,
    }).unwrap();

    let queue = Arc::new(DirtyQueue::new(&b.vault).unwrap());
    queue.enqueue(DirtyOperation::NoteUpsert {
        note_id: "20260301000002".into(),
        relative_path: "note.md".into(),
    }).unwrap();
    assert_eq!(queue.count().unwrap(), 1);

    let online = Arc::new(AtomicBool::new(true));   // network OK
    let sync_enabled = Arc::new(AtomicBool::new(false)); // user paused
    let stop = Arc::new(AtomicBool::new(false));

    let provider: Arc<dyn SyncProvider> = b.provider.clone();
    let worker = Arc::new(PushWorker::new(
        queue.clone(), b.cas.clone(), b.refs.clone(), provider,
        b.vault.clone(), stop.clone(), online.clone(), sync_enabled.clone(),
    ));
    let task = {
        let w = Arc::clone(&worker);
        tokio::spawn(async move { w.run().await })
    };

    // Past the 1.5 s debounce — work must still be untouched while paused.
    tokio::time::sleep(Duration::from_millis(2500)).await;
    assert_eq!(queue.count().unwrap(), 1, "paused → queue untouched");
    assert_eq!(b.provider.object_count(), 0, "no PUTs while paused");

    // Resume → next debounce drains the queue.
    sync_enabled.store(true, Ordering::Relaxed);
    tokio::time::sleep(Duration::from_millis(2500)).await;
    assert_eq!(queue.count().unwrap(), 0, "resume → queue drains");
    assert!(b.provider.object_count() > 0, "object pushed after resume");

    stop.store(true, Ordering::Relaxed);
    let _ = tokio::time::timeout(Duration::from_secs(2), task).await;
}

/// Pausing should not flag the vault as offline. The `online` flag is the
/// network reachability state and stays independent — the indicator UI uses
/// this separation to render "일시 정지" vs "오프라인" with different
/// tooltips.
#[tokio::test]
async fn scenario_d3_pause_is_orthogonal_to_online() {
    let b = bench();
    let eng = engine(&b, "dev-local");

    // Default: online + enabled.
    assert!(eng.is_online());
    assert!(eng.is_sync_enabled());

    // Pause does NOT flip online.
    eng.set_sync_enabled(false);
    assert!(!eng.is_sync_enabled());
    assert!(eng.is_online(), "pause must not affect online flag");

    // Resume restores enabled, online unchanged.
    eng.set_sync_enabled(true);
    assert!(eng.is_sync_enabled());
    assert!(eng.is_online());
}

// ────────────────────────────────────────────────────────────
// Part 3-B — vault rename / delete
// ────────────────────────────────────────────────────────────

use app_lib::features::connection::vault_actions;

/// Full rename workflow against an InMemory provider that contains the
/// vault's NAS contents. The local directory + per-vault config follow.
#[tokio::test]
async fn scenario_d4_rename_full_flow() {
    let tmp = tempfile::tempdir().unwrap();
    let cfg_dir = tmp.path().join("config");
    std::fs::create_dir_all(&cfg_dir).unwrap();
    let local_root = tmp.path().join("vaults").join("hashA");
    let old_local = local_root.join("OldVault");
    std::fs::create_dir_all(&old_local).unwrap();
    std::fs::write(old_local.join("readme.md"), b"# old").unwrap();

    let provider = Arc::new(InMemorySyncProvider::new());
    let provider_dyn: Arc<dyn SyncProvider> = provider.clone();
    provider.put_md("/Colony/OldVault/readme.md", b"# old").await.unwrap();
    provider.put_md("/Colony/OldVault/.notology/objects/aa/bb", b"obj").await.unwrap();

    app_lib::features::sync_v2::config::save_config(&cfg_dir, &old_local,
        &app_lib::features::sync_v2::config::SyncV2Config {
            enabled: true,
            remote_base: "/Colony/OldVault".into(),
            ..Default::default()
        }).unwrap();

    let outcome = vault_actions::rename_vault(
        &provider_dyn, "/Colony", "OldVault", "RenamedVault",
        &old_local, &cfg_dir,
    ).await.unwrap();

    // NAS folder + nested CAS objects all moved
    assert!(provider.get_md("/Colony/OldVault/readme.md").await.unwrap().is_none());
    assert!(provider.get_md("/Colony/RenamedVault/readme.md").await.unwrap().is_some());
    assert!(provider.get_md("/Colony/RenamedVault/.notology/objects/aa/bb").await.unwrap().is_some());

    // Local rename
    assert!(!old_local.exists());
    assert!(outcome.new_local_path.exists());
    assert!(outcome.new_local_path.join("readme.md").exists());

    // Config migrated with updated remote_base
    let cfg = app_lib::features::sync_v2::config::load_config(&cfg_dir, &outcome.new_local_path).unwrap();
    assert_eq!(cfg.remote_base, "/Colony/RenamedVault");
    assert!(cfg.enabled);
}

/// `delete_remote=false` path: local + config gone, NAS preserved so other
/// devices can still access the vault. This is the safe default the dialog
/// keeps unchecked.
#[tokio::test]
async fn scenario_d5_delete_local_only_preserves_nas() {
    let tmp = tempfile::tempdir().unwrap();
    let cfg_dir = tmp.path().join("config");
    std::fs::create_dir_all(&cfg_dir).unwrap();
    let local = tmp.path().join("vaults").join("hashB").join("MyVault");
    std::fs::create_dir_all(&local).unwrap();
    std::fs::write(local.join("note.md"), b"local").unwrap();

    let provider = Arc::new(InMemorySyncProvider::new());
    let provider_dyn: Arc<dyn SyncProvider> = provider.clone();
    provider.put_md("/Colony/MyVault/note.md", b"nas").await.unwrap();

    app_lib::features::sync_v2::config::save_config(&cfg_dir, &local,
        &app_lib::features::sync_v2::config::SyncV2Config {
            enabled: true,
            remote_base: "/Colony/MyVault".into(),
            ..Default::default()
        }).unwrap();

    let outcome = vault_actions::delete_vault_full(
        &provider_dyn, "/Colony/MyVault", &local, &cfg_dir, false,
    ).await.unwrap();

    assert!(outcome.local_removed);
    assert!(!outcome.remote_removed);
    assert!(outcome.config_removed);
    assert!(!local.exists());
    assert!(provider.get_md("/Colony/MyVault/note.md").await.unwrap().is_some(),
        "NAS file preserved when delete_remote=false");
}

/// `delete_remote=true` path: NAS folder + descendants gone, sibling vaults
/// untouched. This guards against the recursive delete accidentally
/// reaching too far.
#[tokio::test]
async fn scenario_d6_delete_remote_recursive_preserves_siblings() {
    let tmp = tempfile::tempdir().unwrap();
    let cfg_dir = tmp.path().join("config");
    std::fs::create_dir_all(&cfg_dir).unwrap();
    let local = tmp.path().join("vaults").join("hashC").join("Doomed");
    std::fs::create_dir_all(&local).unwrap();

    let provider = Arc::new(InMemorySyncProvider::new());
    let provider_dyn: Arc<dyn SyncProvider> = provider.clone();
    provider.put_md("/Colony/Doomed/a.md", b"x").await.unwrap();
    provider.put_md("/Colony/Doomed/sub/b.md", b"y").await.unwrap();
    provider.put_md("/Colony/Sibling/keep.md", b"z").await.unwrap();
    // Edge: another vault whose name is a *prefix* of "Doomed" must NOT
    // be caught by the prefix-based delete. (Names like "Doom" exist in
    // the wild.)
    provider.put_md("/Colony/Doom/safe.md", b"safe").await.unwrap();

    let outcome = vault_actions::delete_vault_full(
        &provider_dyn, "/Colony/Doomed", &local, &cfg_dir, true,
    ).await.unwrap();

    assert!(outcome.remote_removed);
    assert!(provider.get_md("/Colony/Doomed/a.md").await.unwrap().is_none());
    assert!(provider.get_md("/Colony/Doomed/sub/b.md").await.unwrap().is_none());
    assert!(provider.get_md("/Colony/Sibling/keep.md").await.unwrap().is_some(),
        "sibling vault preserved");
    assert!(provider.get_md("/Colony/Doom/safe.md").await.unwrap().is_some(),
        "prefix-name vault preserved (not a substring match)");
}

// ────────────────────────────────────────────────────────────
// Part 3-C — text 3-way merge (smart merge)
// ────────────────────────────────────────────────────────────

use app_lib::core::library::Library;
use app_lib::features::sync_v2::text_merge;

/// LCA + CAS read + line-level merge end-to-end. Sets up a real Library
/// with three commits (base, local, remote) on independent branches and
/// verifies `three_way_merge` plus the LCA lookup recover a clean result.
#[tokio::test]
async fn scenario_d7_smart_merge_clean_path() {
    let tmp = tempfile::tempdir().unwrap();
    let library = Library::new_with_device_id(tmp.path(), "dev-merge".into()).unwrap();

    let note_id = "20260301000099";
    let base = b"line1\nline2\nline3\n";
    let local = b"LINE1\nline2\nline3\n";
    let remote = b"line1\nline2\nLINE3\n";

    // Commit base.
    let base_hash = library.commit_version(note_id, base, "n.md", vec![]).unwrap().unwrap();
    // Two divergent branches, both rooted at base.
    let local_hash = app_lib::core::cas::CasStore::hash(local);
    library.cas().write_object(local).unwrap();
    let mut dag = app_lib::core::version_dag::VersionDag::load(library.vault_path(), note_id).unwrap();
    dag.append(local_hash.clone(), Some(base_hash.clone()), "dev-A".into(), vec![]);
    let remote_hash = app_lib::core::cas::CasStore::hash(remote);
    library.cas().write_object(remote).unwrap();
    dag.append(remote_hash.clone(), Some(base_hash.clone()), "dev-B".into(), vec![]);
    dag.save(library.vault_path(), note_id).unwrap();

    // LCA must surface base.
    let dag2 = app_lib::core::version_dag::VersionDag::load(library.vault_path(), note_id).unwrap();
    let lca = dag2.find_lca(&local_hash, &remote_hash).expect("LCA exists");
    assert_eq!(lca, base_hash);

    // Run merge directly (the Tauri command is just a thin wrapper).
    let result = text_merge::three_way_merge(
        std::str::from_utf8(base).unwrap(),
        std::str::from_utf8(local).unwrap(),
        std::str::from_utf8(remote).unwrap(),
    );
    assert!(result.clean, "disjoint edits → clean: {:?}", result.merged);
    assert_eq!(result.merged, "LINE1\nline2\nLINE3\n");
}

/// When both sides edit the same region, the merge result includes
/// markers and the user is expected to resolve manually before commit.
#[tokio::test]
async fn scenario_d8_smart_merge_with_conflicts() {
    let tmp = tempfile::tempdir().unwrap();
    let library = Library::new_with_device_id(tmp.path(), "dev-conflict".into()).unwrap();

    let note_id = "20260301000100";
    let base = b"alpha\nbeta\ngamma\n";
    let local = b"alpha\nLOCAL\ngamma\n";
    let remote = b"alpha\nREMOTE\ngamma\n";

    let base_hash = library.commit_version(note_id, base, "c.md", vec![]).unwrap().unwrap();
    let local_hash = app_lib::core::cas::CasStore::hash(local);
    library.cas().write_object(local).unwrap();
    let remote_hash = app_lib::core::cas::CasStore::hash(remote);
    library.cas().write_object(remote).unwrap();
    let mut dag = app_lib::core::version_dag::VersionDag::load(library.vault_path(), note_id).unwrap();
    dag.append(local_hash.clone(), Some(base_hash.clone()), "dev-A".into(), vec![]);
    dag.append(remote_hash.clone(), Some(base_hash.clone()), "dev-B".into(), vec![]);
    dag.save(library.vault_path(), note_id).unwrap();

    let dag2 = app_lib::core::version_dag::VersionDag::load(library.vault_path(), note_id).unwrap();
    let lca = dag2.find_lca(&local_hash, &remote_hash).unwrap();
    assert_eq!(lca, base_hash);

    let result = text_merge::three_way_merge(
        std::str::from_utf8(base).unwrap(),
        std::str::from_utf8(local).unwrap(),
        std::str::from_utf8(remote).unwrap(),
    );
    assert!(!result.clean);
    assert_eq!(result.conflict_count, 1);
    assert!(result.merged.contains("LOCAL"));
    assert!(result.merged.contains("REMOTE"));
}

/// Refuses to suggest a merge when histories share no ancestor (e.g. two
/// vaults that were independently rebuilt). The UI surfaces the error and
/// the user falls back to manual resolution.
#[tokio::test]
async fn scenario_d9_smart_merge_no_lca_returns_none() {
    let tmp = tempfile::tempdir().unwrap();
    let library = Library::new_with_device_id(tmp.path(), "dev-x".into()).unwrap();

    let note_id = "20260301000101";
    // Two independent histories, no shared root.
    let a_hash = library.commit_version(note_id, b"a", "x.md", vec![]).unwrap().unwrap();
    // Forge a second history by manually inserting a parentless entry —
    // commit_version always parents off the previous head, so we bypass it.
    let mut dag = app_lib::core::version_dag::VersionDag::load(library.vault_path(), note_id).unwrap();
    let b_hash = app_lib::core::cas::CasStore::hash(b"b");
    library.cas().write_object(b"b").unwrap();
    dag.append(b_hash.clone(), None, "dev-Y".into(), vec![]); // root of independent line
    dag.save(library.vault_path(), note_id).unwrap();

    let dag2 = app_lib::core::version_dag::VersionDag::load(library.vault_path(), note_id).unwrap();
    assert!(dag2.find_lca(&a_hash, &b_hash).is_none());
}
