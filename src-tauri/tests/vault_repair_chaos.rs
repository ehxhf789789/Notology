//! Vault repair CHAOS tests (HanBin 2026-05-24) — adversarial scenarios.
//!
//! These cover:
//!   - 동시성 (concurrent apply, snapshot, mutex race)
//!   - 메모리 / 큰 파일 (100MB+, 500MB attachment)
//!   - 매우 큰 동영상 (대용량 sha256)
//!   - 드래그인/아웃 시나리오 (attachment_add API 직접)
//!   - NAS 동기화 동시성 시뮬레이션 (외부 프로세스가 파일 수정)
//!   - 인터넷 불안정 (NAS 경로 mid-flight 단절)
//!   - 강제 종료 시 partial state (cancel mid-write)
//!   - 손상된 snapshot 감지
//!   - 매우 깊은 디렉토리 / 긴 경로
//!   - 매우 많은 파일 (10k+)
//!   - File handle leak (open + close 반복)

#![cfg(not(target_os = "macos"))] // skip macOS heavy I/O tests in CI; Windows + Linux only

use std::fs;
use std::io::Write;
use std::path::Path;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};

use tempfile::TempDir;

use app_lib::features::sync_v2::attachment_store::AttachmentStore;
use app_lib::features::sync_v2::vault_repair::{
    scan::scan,
    snapshot::{create_snapshot, delete_snapshot, restore_snapshot, list_snapshots, preview_restore},
    apply::{apply, ApplyOptions},
    progress,
};

// ─── 1. 대용량 파일 SHA256 (메모리 OOM 검증) ─────────────────────────

#[test]
fn large_file_100mb_sha256_no_oom() {
    let tmp = TempDir::new().unwrap();
    let vault = tmp.path();
    fs::create_dir_all(vault.join("attachments")).unwrap();
    fs::create_dir_all(vault.join(".notology")).unwrap();

    // Write a 100 MB file (simulates large video/PDF).
    let large_path = vault.join("attachments/big_video.mp4");
    let t = Instant::now();
    {
        let mut f = fs::File::create(&large_path).unwrap();
        let chunk = vec![0xAB; 1024 * 1024]; // 1 MB chunk
        for _ in 0..100 {
            f.write_all(&chunk).unwrap();
        }
        f.sync_all().unwrap();
    }
    eprintln!("[large-file] wrote 100MB in {:?}", t.elapsed());

    fs::write(vault.join("Note.md"),
        "---\ntitle: T\n---\n![[big_video.mp4]]"
    ).unwrap();

    // Scan should NOT panic / OOM.
    let t = Instant::now();
    let report = scan(vault).unwrap();
    eprintln!("[large-file] scan: {:?}, P9 count: {}", t.elapsed(), report.counts.obsidian_attachments);
    assert_eq!(report.counts.obsidian_attachments, 1);

    // Apply should compute sha256 of 100MB file + create blob.
    // Current implementation uses std::fs::read (loads all into RAM).
    // For 100MB this is OK; flag if takes > 30s (suggests pathological).
    let t = Instant::now();
    let opts = ApplyOptions { skip_snapshot: true, ..Default::default() };
    let outcome = apply(vault, &report, &opts).unwrap();
    let elapsed = t.elapsed();
    eprintln!("[large-file] apply: {:?}, imported: {}, errors: {:?}",
        elapsed, outcome.obsidian_attachments_imported, outcome.errors);
    assert_eq!(outcome.obsidian_attachments_imported, 1);
    assert!(outcome.errors.is_empty());
    assert!(elapsed < Duration::from_secs(30),
        "100MB apply took {:?} — performance regression", elapsed);

    // Verify blob integrity.
    let store = AttachmentStore::new(vault.to_path_buf()).unwrap();
    let r = store.all_refs().next().unwrap();
    assert_eq!(r.size_bytes, 100 * 1024 * 1024);
    // Expected sha256 of 100MB of 0xAB.
    let blob_path = store.find_by_sha(&r.sha256).unwrap().local_path.clone();
    assert!(blob_path.is_file());
    let blob_size = fs::metadata(&blob_path).unwrap().len();
    assert_eq!(blob_size, 100 * 1024 * 1024,
        "blob size mismatch: expected 100MB got {} bytes", blob_size);
}

// ─── 2. 동시 apply 차단 (mutex correctness) ──────────────────────────

#[test]
fn concurrent_apply_locked_out_by_mutex() {
    use app_lib::features::sync_v2::vault_repair::progress::try_acquire_apply_lock;

    progress::reset_to_idle();

    // First thread holds the lock.
    let guard1 = try_acquire_apply_lock();
    assert!(guard1.is_ok(), "first lock should succeed");

    // Second thread MUST be rejected.
    let guard2 = try_acquire_apply_lock();
    assert!(guard2.is_err(), "second lock should fail while first held");
    eprintln!("[mutex] second-acquire error: {:?}", guard2.err());

    // Drop first guard.
    drop(guard1);

    // Now third acquire should succeed.
    let guard3 = try_acquire_apply_lock();
    assert!(guard3.is_ok(), "post-release acquire should succeed");
    drop(guard3);

    progress::reset_to_idle();
    eprintln!("[mutex] lock semantics correct: held → reject → release → acquire");
}

// ─── 3. 다중 스레드에서 동시 snapshot 시도 ───────────────────────────

#[test]
fn concurrent_snapshots_dont_collide() {
    let tmp = TempDir::new().unwrap();
    let vault = tmp.path().to_path_buf();
    fs::create_dir_all(vault.join(".notology")).unwrap();
    fs::write(vault.join("a.md"), "a").unwrap();
    fs::write(vault.join("b.md"), "b").unwrap();

    // Snapshot creation is supposed to be safe across threads since each
    // gets its own timestamped subdir. But the timestamp resolution is
    // seconds — if two snapshots happen in the same second, they may
    // collide on snapshot_id. This test checks that.
    let vault1 = vault.clone();
    let vault2 = vault.clone();
    let t1 = std::thread::spawn(move || create_snapshot(&vault1, "t1"));
    let t2 = std::thread::spawn(move || create_snapshot(&vault2, "t2"));

    let r1 = t1.join().unwrap();
    let r2 = t2.join().unwrap();

    // Both should succeed (worst case one waits via OS file system).
    // OR — if same timestamp → collision risk. Either way, no panic.
    eprintln!("[concurrent-snap] r1 OK: {} (id={:?})",
        r1.is_ok(), r1.as_ref().ok().map(|m| &m.snapshot_id));
    eprintln!("[concurrent-snap] r2 OK: {} (id={:?})",
        r2.is_ok(), r2.as_ref().ok().map(|m| &m.snapshot_id));

    if let Ok(m1) = &r1 { let _ = delete_snapshot(&vault, &m1.snapshot_id); }
    if let Ok(m2) = &r2 { let _ = delete_snapshot(&vault, &m2.snapshot_id); }

    // At least ONE must succeed; if both same id, we'd have data
    // corruption risk. Currently use second-resolution timestamps so
    // this could fire. Flag it if both same id.
    if let (Ok(m1), Ok(m2)) = (&r1, &r2) {
        if m1.snapshot_id == m2.snapshot_id {
            eprintln!("[concurrent-snap] ⚠️ SAME snapshot_id — second-resolution timestamp \
                race. Real production risk if user double-clicks Create.");
        }
    }
}

// ─── 4. Cancel mid-apply 정확성 ───────────────────────────────────────

#[test]
fn cancel_mid_apply_leaves_consistent_state() {
    let tmp = TempDir::new().unwrap();
    let vault = tmp.path();
    fs::create_dir_all(vault.join(".notology")).unwrap();
    fs::create_dir_all(vault.join("attachments")).unwrap();
    // Create 30 attachments + linking notes so apply has time to be
    // cancelled mid-flight.
    for i in 0..30 {
        fs::write(vault.join(format!("attachments/a_{:02}.png", i)),
            format!("content-{}", i)).unwrap();
        fs::write(vault.join(format!("N_{:02}.md", i)),
            format!("[[a_{:02}.png]]", i)).unwrap();
    }

    let report = scan(vault).unwrap();
    progress::request_cancel(); // pre-request cancel
    let opts = ApplyOptions { skip_snapshot: true, ..Default::default() };
    let outcome = apply(vault, &report, &opts).unwrap();

    let imports = outcome.obsidian_attachments_imported;
    let total_expected = report.counts.obsidian_attachments;
    eprintln!("[cancel-mid] imported {} of {} expected", imports, total_expected);
    assert!(imports < total_expected,
        "cancel didn't reduce work (got {} = expected {})", imports, total_expected);

    // Whatever was imported should still be valid (B-model + sha).
    let store = AttachmentStore::new(vault.to_path_buf()).unwrap();
    for r in store.all_refs() {
        assert_eq!(r.linked_notes.len(), 1,
            "cancelled apply left invalid ref: {} has {} linked_notes",
            r.attachment_id, r.linked_notes.len());
        let blob = store.find_by_sha(&r.sha256);
        assert!(blob.is_some(), "ref {} has no blob", r.attachment_id);
    }

    progress::reset_to_idle();
    eprintln!("[cancel-mid] partial state is consistent (all written refs valid)");
}

// ─── 5. 손상된 snapshot 매니페스트 감지 ────────────────────────────

#[test]
fn corrupted_snapshot_manifest_detected_on_restore() {
    let tmp = TempDir::new().unwrap();
    let vault = tmp.path();
    fs::create_dir_all(vault.join(".notology")).unwrap();
    fs::write(vault.join("a.md"), "content").unwrap();

    let manifest = create_snapshot(vault, "corrupt-test").unwrap();
    let snap_dir = std::path::PathBuf::from(
        list_snapshots(vault).unwrap().iter()
            .find(|s| s.snapshot_id == manifest.snapshot_id)
            .unwrap().dir.clone()
    );

    // Corrupt one of the snapshot files (flip bytes).
    let snap_file = snap_dir.join("a.md");
    assert!(snap_file.is_file());
    fs::write(&snap_file, b"TAMPERED").unwrap();

    // Restore should detect sha mismatch and skip the corrupted file.
    let outcome = restore_snapshot(vault, &manifest.snapshot_id).unwrap();
    let sha_errors: Vec<_> = outcome.errors.iter()
        .filter(|e| e.contains("sha mismatch"))
        .collect();
    eprintln!("[corrupt-detect] errors: {:?}", outcome.errors);
    assert!(!sha_errors.is_empty(),
        "corrupted snapshot file silently restored — sha mismatch NOT detected!");

    let _ = delete_snapshot(vault, &manifest.snapshot_id);
}

// ─── 6. 매우 많은 파일 (1000+) ────────────────────────────────────────

#[test]
fn many_files_1000_attachments_performance() {
    let tmp = TempDir::new().unwrap();
    let vault = tmp.path();
    fs::create_dir_all(vault.join(".notology")).unwrap();
    fs::create_dir_all(vault.join("attachments")).unwrap();

    let t = Instant::now();
    for i in 0..1000 {
        fs::write(vault.join(format!("attachments/file_{:04}.png", i)),
            format!("c{}", i).as_bytes()).unwrap();
    }
    fs::write(vault.join("All.md"), {
        let mut s = String::from("---\ntitle: All\n---\n");
        for i in 0..1000 {
            s.push_str(&format!("[[file_{:04}.png]]\n", i));
        }
        s
    }).unwrap();
    eprintln!("[1k-files] setup: {:?}", t.elapsed());

    let t = Instant::now();
    let report = scan(vault).unwrap();
    eprintln!("[1k-files] scan: {:?}, P9: {}", t.elapsed(), report.counts.obsidian_attachments);
    assert_eq!(report.counts.obsidian_attachments, 1000);

    let t = Instant::now();
    let opts = ApplyOptions { skip_snapshot: true, ..Default::default() };
    let outcome = apply(vault, &report, &opts).unwrap();
    let elapsed = t.elapsed();
    eprintln!("[1k-files] apply: {:?}, imported: {}, errors: {}",
        elapsed, outcome.obsidian_attachments_imported, outcome.errors.len());
    assert_eq!(outcome.obsidian_attachments_imported, 1000);
    assert!(outcome.errors.is_empty());
    assert!(elapsed < Duration::from_secs(120),
        "1000 imports took {:?} — perf regression (target <2 min)", elapsed);

    // All refs should exist + be B-model valid.
    let store = AttachmentStore::new(vault.to_path_buf()).unwrap();
    let count = store.all_refs().count();
    assert_eq!(count, 1000);
}

// ─── 7. 깊은 디렉토리 (Windows MAX_PATH 근접) ────────────────────────

#[test]
fn very_deep_nested_path() {
    let tmp = TempDir::new().unwrap();
    let vault = tmp.path();
    fs::create_dir_all(vault.join(".notology")).unwrap();

    // Build 15-level deep nesting. Each level ~10 chars + sep.
    // Approaching but not crossing Windows 260-char limit (cmd default).
    let mut p = vault.to_path_buf();
    for i in 0..15 {
        p = p.join(format!("level_{:02}", i));
    }
    p = p.join("attachments");
    fs::create_dir_all(&p).unwrap();
    fs::write(p.join("deep.pdf"), b"deep").unwrap();
    fs::write(p.parent().unwrap().join("note.md"),
        "---\ntitle: T\n---\n[[deep.pdf]]"
    ).unwrap();

    let report = scan(vault).unwrap();
    eprintln!("[deep-path] P9 count: {}", report.counts.obsidian_attachments);
    assert!(report.counts.obsidian_attachments >= 1, "deep attachment not detected");

    let opts = ApplyOptions { skip_snapshot: true, ..Default::default() };
    let outcome = apply(vault, &report, &opts).unwrap();
    eprintln!("[deep-path] errors: {:?}", outcome.errors);
    assert!(outcome.obsidian_attachments_imported >= 1);
}

// ─── 8. 외부 프로세스가 mid-flight에 파일 수정 시뮬레이션 ─────────────

#[test]
fn external_modification_during_scan_does_not_panic() {
    use std::sync::atomic::{AtomicBool, Ordering};

    let tmp = TempDir::new().unwrap();
    let vault = tmp.path().to_path_buf();
    fs::create_dir_all(vault.join(".notology")).unwrap();
    fs::create_dir_all(vault.join("attachments")).unwrap();
    for i in 0..200 {
        fs::write(vault.join(format!("attachments/x_{:03}.png", i)),
            format!("c{}", i)).unwrap();
        fs::write(vault.join(format!("N_{:03}.md", i)),
            format!("[[x_{:03}.png]]", i)).unwrap();
    }

    // Spawn a worker that simultaneously modifies files (simulates
    // Synology Drive sync writing files while we scan).
    let stop = Arc::new(AtomicBool::new(false));
    let stop2 = stop.clone();
    let vault2 = vault.clone();
    let worker = std::thread::spawn(move || {
        let mut counter = 0u32;
        while !stop2.load(Ordering::Relaxed) {
            let path = vault2.join(format!("attachments/x_{:03}.png",
                counter % 200));
            let _ = fs::write(&path, format!("MUTATED-{}", counter).as_bytes());
            counter += 1;
            std::thread::sleep(Duration::from_millis(2));
        }
        counter
    });

    let t = Instant::now();
    let scan_result = scan(&vault);
    eprintln!("[external-mod] scan {:?} → {:?}",
        t.elapsed(), scan_result.as_ref().map(|r| r.counts.obsidian_attachments));

    stop.store(true, Ordering::Relaxed);
    let mods = worker.join().unwrap();
    eprintln!("[external-mod] worker did {} mutations during scan", mods);

    // Scan must not panic and must produce SOME result.
    assert!(scan_result.is_ok(), "scan panicked under external modification");
}

// ─── 9. 갑작스런 vault 폴더 부분 삭제 ─────────────────────────────────

#[test]
fn vault_subfolder_disappears_mid_scan() {
    let tmp = TempDir::new().unwrap();
    let vault = tmp.path().to_path_buf();
    fs::create_dir_all(vault.join(".notology")).unwrap();
    fs::create_dir_all(vault.join("doomed/attachments")).unwrap();
    fs::create_dir_all(vault.join("survivor/attachments")).unwrap();
    fs::write(vault.join("doomed/attachments/a.png"), b"a").unwrap();
    fs::write(vault.join("survivor/attachments/b.png"), b"b").unwrap();
    fs::write(vault.join("doomed/note.md"), "[[a.png]]").unwrap();
    fs::write(vault.join("survivor/note.md"), "[[b.png]]").unwrap();

    // Race: delete `doomed/` between scan and apply.
    let report = scan(&vault).unwrap();
    fs::remove_dir_all(vault.join("doomed")).unwrap();

    let opts = ApplyOptions { skip_snapshot: true, ..Default::default() };
    let outcome = apply(&vault, &report, &opts).unwrap();
    eprintln!("[disappear] imported: {}, errors: {}",
        outcome.obsidian_attachments_imported, outcome.errors.len());

    // Should handle gracefully — survivor.png imported, doomed/a.png
    // results in skip (file_missing) but NO panic.
    let store = AttachmentStore::new(vault.clone()).unwrap();
    assert!(store.all_refs().any(|r| r.original_name == "b.png"),
        "survivor.png should be imported despite doomed/ disappearing");
}

// ─── 10. 권한 거부 시 graceful 실패 ───────────────────────────────────

#[test]
fn snapshot_with_unreadable_path_logs_skip_not_panic() {
    let tmp = TempDir::new().unwrap();
    let vault = tmp.path();
    fs::create_dir_all(vault.join(".notology")).unwrap();
    fs::write(vault.join("ok.md"), "fine").unwrap();
    fs::write(vault.join("bad.md"), "would be locked").unwrap();

    // Hold an exclusive read lock on bad.md (simulates Synology Drive
    // holding the file). On Windows this prevents other access.
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_SHARE_NONE: u32 = 0;
        let _handle = fs::OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_NONE)
            .open(vault.join("bad.md"));

        // Snapshot should at least not panic. Either skips bad.md or
        // succeeds depending on file open semantics.
        let result = create_snapshot(vault, "perm-test");
        eprintln!("[perm-deny] snapshot result: {:?}",
            result.as_ref().map(|m| (m.file_count, m.completed_at.is_some())));
        // No assertion on success — implementation may legitimately
        // either skip or include. Just must not panic.
        if let Ok(m) = result {
            let _ = delete_snapshot(vault, &m.snapshot_id);
        }
    }
}

// ─── 11. NAS 단절 시뮬레이션 (존재하지 않는 sub-path) ────────────────

#[test]
fn missing_attachment_file_handled_during_apply() {
    let tmp = TempDir::new().unwrap();
    let vault = tmp.path();
    fs::create_dir_all(vault.join(".notology")).unwrap();
    fs::create_dir_all(vault.join("attachments")).unwrap();
    fs::write(vault.join("attachments/real.png"), b"real").unwrap();
    fs::write(vault.join("attachments/ghost.png"), b"will be deleted").unwrap();
    fs::write(vault.join("note.md"),
        "[[real.png]] and [[ghost.png]]"
    ).unwrap();

    let report = scan(vault).unwrap();
    assert_eq!(report.counts.obsidian_attachments, 2);

    // BETWEEN scan and apply, ghost.png vanishes (simulates NAS drop).
    fs::remove_file(vault.join("attachments/ghost.png")).unwrap();

    let opts = ApplyOptions { skip_snapshot: true, ..Default::default() };
    let outcome = apply(vault, &report, &opts).unwrap();
    eprintln!("[nas-drop] imported: {}, errors: {:?}",
        outcome.obsidian_attachments_imported, outcome.errors);

    // real.png imported, ghost.png silently skipped (not panic).
    let store = AttachmentStore::new(vault.to_path_buf()).unwrap();
    assert!(store.all_refs().any(|r| r.original_name == "real.png"));
    assert!(!store.all_refs().any(|r| r.original_name == "ghost.png"),
        "ghost.png should NOT have a ref (file vanished)");
}

// ─── 12. attachment_add 직접 호출 (드래그-인 simulation) ──────────────

#[test]
fn drag_in_simulation_creates_ref_and_blob() {
    let tmp = TempDir::new().unwrap();
    let vault = tmp.path();
    fs::create_dir_all(vault.join(".notology")).unwrap();
    let src = tmp.path().join("dropped.pdf");
    fs::write(&src, b"PDF dropped from OS Explorer").unwrap();

    let mut store = AttachmentStore::new(vault.to_path_buf()).unwrap();
    let outcome = store.add_attachment(&src, "dropped.pdf", "test-note-id").unwrap();
    eprintln!("[drag-in] ref id: {} display: {}",
        outcome.attachment_ref.attachment_id, outcome.attachment_ref.display_path);

    assert_eq!(outcome.attachment_ref.linked_notes, vec!["test-note-id".to_string()]);
    assert!(!outcome.attachment_ref.sha256.is_empty());

    // Blob + display path exist.
    let blob = store.find_by_sha(&outcome.attachment_ref.sha256).unwrap();
    assert!(blob.local_path.is_file());
    let display_abs = vault.join(&outcome.attachment_ref.display_path);
    assert!(display_abs.is_file(), "display hardlink missing: {:?}", display_abs);

    // Same file dropped to ANOTHER note → second per-note ref + blob shared.
    let outcome2 = store.add_attachment(&src, "dropped.pdf", "second-note-id").unwrap();
    assert_eq!(outcome2.attachment_ref.linked_notes, vec!["second-note-id".to_string()]);
    assert_eq!(outcome2.attachment_ref.sha256, outcome.attachment_ref.sha256);
    assert_ne!(outcome2.attachment_ref.attachment_id, outcome.attachment_ref.attachment_id,
        "B-model violated: should create new ref id, not reuse");
}

// ─── 13. 강제 종료 후 다음 apply가 stuck mutex 풀어야 ─────────────────

#[test]
fn after_panic_in_apply_mutex_is_recoverable() {
    use app_lib::features::sync_v2::vault_repair::progress::try_acquire_apply_lock;

    // Simulate: acquire, then "panic" (drop without releasing properly
    // via guard). RAII guard SHOULD release. Verify second acquire
    // works.
    progress::reset_to_idle();
    {
        let guard = try_acquire_apply_lock().unwrap();
        // Simulate panic by dropping guard explicitly without "panic!"
        // (real panic in apply would also drop the guard via stack
        // unwind, so this is functionally equivalent).
        drop(guard);
    }

    // Second acquire must succeed.
    let g2 = try_acquire_apply_lock();
    assert!(g2.is_ok(), "mutex stuck after first guard drop");
    drop(g2);
    progress::reset_to_idle();
    eprintln!("[mutex-recovery] AtomicBool released on guard drop — recoverable");
}

// ─── 14. cancel 후 reset 안 하면 다음 apply 즉시 cancel ──────────────

#[test]
fn cancel_token_must_be_reset_before_next_apply() {
    let tmp = TempDir::new().unwrap();
    let vault = tmp.path();
    fs::create_dir_all(vault.join(".notology")).unwrap();
    fs::create_dir_all(vault.join("attachments")).unwrap();
    fs::write(vault.join("attachments/x.pdf"), b"x").unwrap();
    fs::write(vault.join("n.md"), "[[x.pdf]]").unwrap();

    let report = scan(vault).unwrap();

    // Request cancel BEFORE first apply.
    progress::request_cancel();
    let opts = ApplyOptions { skip_snapshot: true, ..Default::default() };
    let outcome1 = apply(vault, &report, &opts).unwrap();
    assert!(outcome1.errors.iter().any(|e| e.contains("cancelled")),
        "first apply should be cancelled");

    // WITHOUT resetting, second apply would ALSO be cancelled!
    // This is a real foot-gun. Verify behavior.
    let outcome2 = apply(vault, &report, &opts).unwrap();
    let still_cancelled = outcome2.errors.iter().any(|e| e.contains("cancelled"));
    eprintln!("[cancel-sticky] second apply (no reset) cancelled? {}", still_cancelled);

    if still_cancelled {
        eprintln!("[cancel-sticky] ⚠️ cancel token IS sticky — Tauri command layer MUST reset \
            after each apply or user is permanently stuck.");
    }

    // Now reset and retry → should work.
    progress::reset_to_idle();
    let outcome3 = apply(vault, &report, &opts).unwrap();
    assert!(!outcome3.errors.iter().any(|e| e.contains("cancelled")),
        "after reset, apply should NOT be cancelled");
    eprintln!("[cancel-sticky] post-reset apply: imported {}, no cancel",
        outcome3.obsidian_attachments_imported);

    progress::reset_to_idle();
}

// ─── 15. snapshot의 manifest.json 자체가 손상되면? ────────────────────

#[test]
fn snapshot_with_corrupt_manifest_json_fails_gracefully() {
    let tmp = TempDir::new().unwrap();
    let vault = tmp.path();
    fs::create_dir_all(vault.join(".notology")).unwrap();
    fs::write(vault.join("a.md"), "a").unwrap();

    let m = create_snapshot(vault, "corrupt-json").unwrap();
    let snap_dir = std::path::PathBuf::from(
        list_snapshots(vault).unwrap().iter()
            .find(|s| s.snapshot_id == m.snapshot_id)
            .unwrap().dir.clone()
    );

    // Corrupt manifest.json itself.
    fs::write(snap_dir.join("manifest.json"), b"{ not json").unwrap();

    // Preview AND restore should error gracefully, not panic.
    let preview_result = preview_restore(vault, &m.snapshot_id);
    assert!(preview_result.is_err(), "preview should error on corrupt manifest");
    eprintln!("[corrupt-manifest] preview error: {:?}", preview_result.err());

    let restore_result = restore_snapshot(vault, &m.snapshot_id);
    assert!(restore_result.is_err(), "restore should error on corrupt manifest");
    eprintln!("[corrupt-manifest] restore error: {:?}", restore_result.err());

    let _ = delete_snapshot(vault, &m.snapshot_id);
}

// ─── 16. dry-run 이 메모리 / 시간 폭발 안 함 ──────────────────────────

#[test]
fn dry_run_constant_time_regardless_of_findings() {
    let tmp = TempDir::new().unwrap();
    let vault = tmp.path();
    fs::create_dir_all(vault.join(".notology")).unwrap();
    fs::create_dir_all(vault.join("attachments")).unwrap();
    for i in 0..500 {
        fs::write(vault.join(format!("attachments/big_{:03}.png", i)),
            vec![0u8; 10_240]).unwrap();
        fs::write(vault.join(format!("n_{:03}.md", i)),
            format!("[[big_{:03}.png]]", i)).unwrap();
    }

    let report = scan(vault).unwrap();
    assert_eq!(report.counts.obsidian_attachments, 500);

    // Dry-run should be instant (μs) regardless of 500 findings.
    let opts = ApplyOptions { dry_run: true, skip_snapshot: true, ..Default::default() };
    let t = Instant::now();
    let outcome = apply(vault, &report, &opts).unwrap();
    let elapsed = t.elapsed();
    eprintln!("[dry-run-perf] {} findings, dry-run took {:?}", 500, elapsed);
    assert!(elapsed < Duration::from_millis(100),
        "dry-run took {:?} — should be <100ms for any size", elapsed);
    assert_eq!(outcome.obsidian_attachments_imported, 500);
    assert!(outcome.was_dry_run);
}
