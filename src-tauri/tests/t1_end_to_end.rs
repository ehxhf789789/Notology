//! T1 클론 end-to-end 검증 (HanBin 2026-05-24).
//!
//! T1 = `c:\tmp\notology_test_vaults\HanBin_T1_skeleton` — 386 .md 파일 +
//! 786 총 파일 + 32 MB. Obsidian-flavored vault (no .notology, no _att/,
//! shared `attachments/` folder, [[file.ext]] wikilinks).
//!
//! 이 테스트는 사용자 시나리오 그대로:
//!   1. T1을 fresh temp 위치로 복사 (원본 무영향)
//!   2. baseline integrity manifest 작성 (모든 파일 sha256)
//!   3. scan → 결과 검증
//!   4. dry-run → vault 무변경 검증
//!   5. real apply (with mandatory snapshot)
//!   6. B-model invariant 검증
//!   7. AttachmentRef → CAS blob → display path 무결성 검증
//!   8. .md 파일 전부 byte-identical (apply는 .md를 건드리면 안 됨)
//!   9. snapshot preview 검증
//!  10. 사후 cleanup
//!
//! T1이 없으면 skip (CI 환경 등).

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

use sha2::{Digest, Sha256};
use tempfile::TempDir;

use app_lib::features::sync_v2::attachment_store::AttachmentStore;
use app_lib::features::sync_v2::vault_repair::scan::scan;
use app_lib::features::sync_v2::vault_repair::snapshot::{
    delete_snapshot, preview_restore,
};
use app_lib::features::sync_v2::vault_repair::apply::{apply, ApplyOptions};

const T1_PATH: &str = r"C:\tmp\notology_test_vaults\HanBin_T1_skeleton";

#[test]
fn t1_clone_end_to_end_validation() {
    let t1 = PathBuf::from(T1_PATH);
    if !t1.is_dir() {
        eprintln!("[T1] SKIP — fixture not found at {:?}", t1);
        eprintln!("[T1] To enable, clone HanBin to {} first.", T1_PATH);
        return;
    }

    eprintln!("\n═══════════════════════════════════════════════════════════════");
    eprintln!("  T1 클론 end-to-end 검증");
    eprintln!("═══════════════════════════════════════════════════════════════\n");

    // ─── Step 1: copy T1 to temp vault ───
    eprintln!("[Step 1/10] T1 → temp vault 복사 시작...");
    let t0 = Instant::now();
    let tmp = TempDir::new().unwrap();
    let vault = tmp.path().to_path_buf();
    copy_dir_recursive(&t1, &vault).expect("copy T1");
    eprintln!("  ✓ {:?} ({} files)", t0.elapsed(), count_files(&vault));

    // ─── Step 2: baseline integrity ───
    eprintln!("\n[Step 2/10] Baseline integrity manifest 생성...");
    let t0 = Instant::now();
    let baseline_files = walkdir_all(&vault);
    let baseline_count = baseline_files.len();
    let baseline_md_count = baseline_files
        .iter()
        .filter(|p| p.extension().and_then(|s| s.to_str()) == Some("md"))
        .count();
    let baseline_shas: HashMap<String, String> = baseline_files
        .iter()
        .map(|p| {
            let rel = p.strip_prefix(&vault).unwrap().to_string_lossy().replace('\\', "/");
            let sha = sha256_of(p);
            (rel, sha)
        })
        .collect();
    eprintln!("  ✓ {:?} — total: {} files, .md: {} files", t0.elapsed(), baseline_count, baseline_md_count);
    assert!(baseline_md_count >= 380, "expected ≥380 .md files in T1 clone, got {}", baseline_md_count);

    // ─── Step 3: scan ───
    eprintln!("\n[Step 3/10] Scan 실행...");
    let t0 = Instant::now();
    let report = scan(&vault).expect("scan");
    eprintln!("  ✓ {:?} — counts:", t0.elapsed());
    eprintln!("      legacy_att_folder        : {}", report.counts.legacy_att_folder);
    eprintln!("      sketch_external_path     : {}", report.counts.sketch_external_path);
    eprintln!("      sketch_unresolved_ref    : {}", report.counts.sketch_unresolved_ref);
    eprintln!("      wikilink_resolvable      : {}", report.counts.wikilink_resolvable);
    eprintln!("      wikilink_broken (report) : {}", report.counts.wikilink_broken);
    eprintln!("      shared_ref               : {}", report.counts.shared_ref);
    eprintln!("      orphan_blob              : {}", report.counts.orphan_blob);
    eprintln!("      obsidian_attachments     : {}", report.counts.obsidian_attachments);
    eprintln!("      TOTAL                    : {} (auto-fixable: {})",
        report.counts.total(), report.counts.auto_fixable_total());

    // T1 expectations
    assert_eq!(report.counts.legacy_att_folder, 0,
        "T1 is pure Obsidian, MUST NOT have any _att/ folders");
    assert_eq!(report.counts.sketch_external_path, 0,
        "T1 has no sketches");
    assert_eq!(report.counts.shared_ref, 0,
        "T1 store is empty, no refs to share");
    // P9 detection — HanBin uses per-folder `attachments/` (not root).
    // T1 has 100s of files inside various `attachments/` subfolders.
    assert!(report.counts.obsidian_attachments >= 100,
        "T1 has 100s of files in per-folder attachments/ — got {}",
        report.counts.obsidian_attachments);
    // T1 is small-only clone (<200KB filter), so 100s of `[[file.ext]]`
    // wikilinks reference files NOT present in T1 (large videos, big
    // PDFs were filtered out). High broken count is EXPECTED for T1
    // — would be near zero on the real 44 GB HanBin vault.
    eprintln!("  ℹ wikilink_broken={} expected to be high for T1 small-only clone (files >200KB excluded)",
        report.counts.wikilink_broken);

    // ─── Step 4: dry-run ───
    eprintln!("\n[Step 4/10] Dry-run 실행 (vault 무변경 확인)...");
    let t0 = Instant::now();
    let dry_outcome = apply(&vault, &report, &ApplyOptions {
        auto_only: true,
        skip_orphan_sweep: false,
        skip_snapshot: false,
        dry_run: true,
    }).expect("dry-run apply");
    eprintln!("  ✓ {:?}", t0.elapsed());
    eprintln!("      was_dry_run              : {}", dry_outcome.was_dry_run);
    eprintln!("      snapshot_id              : {:?}", dry_outcome.snapshot_id);
    eprintln!("      projected p9 imports     : {}", dry_outcome.obsidian_attachments_imported);
    eprintln!("      projected p4 wikilinks   : {}", dry_outcome.wikilink_resolved);

    assert!(dry_outcome.was_dry_run, "outcome.was_dry_run must be true for dry-run");
    // Dry-run no longer snapshots (T1 perf finding: 16s snapshot for
    // 786 files = ~10 min for 44 GB HanBin; users dry-run multiple
    // times before committing so per-dry-run snapshot cost was wrong).
    assert!(dry_outcome.snapshot_id.is_none(),
        "dry-run MUST NOT snapshot — pure preview, zero disk writes");

    // Verify vault is byte-identical post-dry-run
    let post_dryrun_shas: HashMap<String, String> = walkdir_all(&vault)
        .iter()
        .map(|p| {
            let rel = p.strip_prefix(&vault).unwrap().to_string_lossy().replace('\\', "/");
            (rel, sha256_of(p))
        })
        .collect();
    let baseline_subset: HashMap<&String, &String> = baseline_shas.iter()
        .filter(|(k, _)| !k.starts_with(".notology"))
        .collect();
    let post_subset: HashMap<&String, &String> = post_dryrun_shas.iter()
        .filter(|(k, _)| !k.starts_with(".notology"))
        .collect();
    assert_eq!(baseline_subset.len(), post_subset.len(),
        "dry-run changed file count: baseline={}, post={}", baseline_subset.len(), post_subset.len());
    for (rel, original_sha) in &baseline_subset {
        let cur_sha = post_subset.get(*rel)
            .expect(&format!("file vanished after dry-run: {}", rel));
        assert_eq!(original_sha, cur_sha,
            "dry-run MODIFIED user file: {}", rel);
    }
    eprintln!("  ✓ vault byte-identical confirmed ({} user files unchanged)", baseline_subset.len());

    // No dry-run snapshot to clean up (dry-run skips snapshot now).

    // ─── Step 5: real apply ───
    eprintln!("\n[Step 5/10] Real apply 실행 (mandatory snapshot + 변경)...");
    let t0 = Instant::now();
    let real_outcome = apply(&vault, &report, &ApplyOptions {
        auto_only: true,
        skip_orphan_sweep: true, // T1 has no blobs yet; skip to keep test focused
        skip_snapshot: false,
        dry_run: false,
    }).expect("real apply");
    eprintln!("  ✓ {:?}", t0.elapsed());
    eprintln!("      snapshot_id              : {:?}", real_outcome.snapshot_id);
    eprintln!("      legacy_att_migrated      : {}", real_outcome.legacy_att_migrated);
    eprintln!("      sketch_external_imported : {}", real_outcome.sketch_external_imported);
    eprintln!("      sketch_unresolved_imp.   : {}", real_outcome.sketch_unresolved_imported);
    eprintln!("      wikilink_resolved        : {}", real_outcome.wikilink_resolved);
    eprintln!("      shared_refs_split        : {}", real_outcome.shared_refs_split);
    eprintln!("      orphan_blobs_swept       : {}", real_outcome.orphan_blobs_swept);
    eprintln!("      obsidian_attachments_imp.: {}", real_outcome.obsidian_attachments_imported);
    eprintln!("      errors                   : {} ({})",
        real_outcome.errors.len(),
        if real_outcome.errors.is_empty() { "none".to_string() }
        else { format!("first: {}", real_outcome.errors[0]) }
    );

    assert!(real_outcome.snapshot_id.is_some(), "real apply MUST snapshot");
    let snapshot_id = real_outcome.snapshot_id.clone().unwrap();

    // ─── Step 6: B-model invariant ───
    eprintln!("\n[Step 6/10] B-model invariant 검증 (linked_notes.len() == 1)...");
    let store = AttachmentStore::new(vault.clone()).expect("open store");
    let refs: Vec<_> = store.all_refs().cloned().collect();
    let total_refs = refs.len();
    eprintln!("  AttachmentRefs created: {}", total_refs);
    let mut violations = 0;
    for r in &refs {
        if r.linked_notes.len() != 1 {
            violations += 1;
            eprintln!("  ✗ B-model violated: ref {} ({}) has {} linked_notes",
                r.attachment_id, r.original_name, r.linked_notes.len());
        }
    }
    if violations == 0 {
        eprintln!("  ✓ all {} refs satisfy B-model (each owns exactly 1 note)", total_refs);
    }
    assert_eq!(violations, 0, "B-model violations: {}", violations);

    // ─── Step 7: blob + display path integrity ───
    eprintln!("\n[Step 7/10] CAS blob + display path 무결성 검증...");
    let mut missing_blobs = 0;
    let mut missing_displays = 0;
    let mut sha_mismatches = 0;
    for r in &refs {
        // Use public find_by_sha + display_path; cas_path is pub(crate)
        // and inaccessible from integration tests.
        let blob_info = store.find_by_sha(&r.sha256);
        let blob_path = match blob_info {
            Some(b) => b.local_path.clone(),
            None => {
                missing_blobs += 1;
                eprintln!("  ✗ blob missing in index: ref {} sha {}", r.attachment_id, r.sha256);
                continue;
            }
        };
        if !blob_path.is_file() {
            missing_blobs += 1;
            eprintln!("  ✗ blob file missing on disk: ref {} path {:?}", r.attachment_id, blob_path);
            continue;
        }
        let actual_sha = sha256_of(&blob_path);
        if actual_sha != r.sha256 {
            sha_mismatches += 1;
            eprintln!("  ✗ blob sha mismatch: ref {} expected {} got {}",
                r.attachment_id, r.sha256, actual_sha);
        }
        let display_abs = vault.join(&r.display_path);
        if !display_abs.is_file() {
            missing_displays += 1;
            eprintln!("  ✗ display missing: ref {} path {}", r.attachment_id, r.display_path);
        }
    }
    if missing_blobs == 0 && missing_displays == 0 && sha_mismatches == 0 {
        eprintln!("  ✓ all {} refs have valid blob + display + matching sha", total_refs);
    }
    assert_eq!(missing_blobs, 0);
    assert_eq!(missing_displays, 0);
    assert_eq!(sha_mismatches, 0);

    // ─── Step 8: .md files untouched ───
    eprintln!("\n[Step 8/10] .md 파일 무변경 검증 (apply는 .md 본문 안 건드림)...");
    let mut md_modified = 0;
    let mut md_deleted = 0;
    let mut md_checked = 0;
    for (rel, original_sha) in &baseline_shas {
        if !rel.ends_with(".md") {
            continue;
        }
        md_checked += 1;
        let abs = vault.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR.as_ref()));
        if !abs.is_file() {
            md_deleted += 1;
            eprintln!("  ✗ .md DELETED by apply: {}", rel);
            continue;
        }
        let cur_sha = sha256_of(&abs);
        if cur_sha != *original_sha {
            md_modified += 1;
            eprintln!("  ✗ .md MODIFIED by apply: {}", rel);
        }
    }
    if md_modified == 0 && md_deleted == 0 {
        eprintln!("  ✓ all {} .md files byte-identical (apply only adds refs, never touches notes)", md_checked);
    }
    assert_eq!(md_deleted, 0, ".md files deleted: {}", md_deleted);
    assert_eq!(md_modified, 0, ".md files modified: {}", md_modified);

    // ─── Step 9: snapshot preview ───
    eprintln!("\n[Step 9/10] Snapshot restore preview 검증...");
    let preview = preview_restore(&vault, &snapshot_id).expect("preview");
    eprintln!("  files to overwrite : {} ({} bytes)",
        preview.files_to_overwrite.len(), preview.bytes_to_overwrite);
    eprintln!("  files to delete    : {}", preview.files_to_delete.len());
    eprintln!("  files unchanged    : {}", preview.files_unchanged);
    // Snapshot was taken BEFORE apply, so post-apply state should show:
    //   - lots of "files_to_delete" (the new .notology/ structure)
    //   - lots of "unchanged" (the .md files apply didn't touch)
    assert!(preview.files_unchanged >= 380,
        "expected ≥380 unchanged (.md files apply didn't touch) — got {}",
        preview.files_unchanged);
    assert!(preview.files_to_delete.len() > 0,
        "expected snapshot to want to delete new .notology files");
    eprintln!("  ✓ preview semantics confirmed (.md unchanged, new CAS files would be deleted on restore)");

    // ─── Step 10: cleanup ───
    eprintln!("\n[Step 10/10] Cleanup (snapshot 삭제)...");
    if let Err(e) = delete_snapshot(&vault, &snapshot_id) {
        eprintln!("  ⚠ snapshot cleanup failed: {} (manual cleanup may be needed at LOCALAPPDATA)", e);
    } else {
        eprintln!("  ✓ snapshot deleted from LOCALAPPDATA");
    }

    // ─── Final report ───
    eprintln!("\n═══════════════════════════════════════════════════════════════");
    eprintln!("  T1 검증 종합 결과");
    eprintln!("═══════════════════════════════════════════════════════════════");
    eprintln!("  vault 파일                : {} (baseline) → {} (post-apply)",
        baseline_count, count_files(&vault));
    eprintln!("  .md 파일                  : {} (모두 unchanged)", baseline_md_count);
    eprintln!("  AttachmentRefs 생성       : {}", total_refs);
    eprintln!("  B-model 위반              : 0");
    eprintln!("  blob/display 무결성       : 0 missing, 0 sha mismatch");
    eprintln!("  apply 도중 에러           : {}", real_outcome.errors.len());
    eprintln!("  snapshot/restore 흐름     : OK");
    eprintln!("═══════════════════════════════════════════════════════════════\n");
}

// ─── helpers ──────────────────────────────────────────────────────────

fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let p = entry.path();
        let dst_p = dst.join(entry.file_name());
        if p.is_dir() {
            copy_dir_recursive(&p, &dst_p)?;
        } else {
            fs::copy(&p, &dst_p)?;
        }
    }
    Ok(())
}

fn walkdir_all(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(d) = stack.pop() {
        for entry in fs::read_dir(&d).unwrap().flatten() {
            let p = entry.path();
            if p.is_dir() {
                stack.push(p);
            } else if p.is_file() {
                out.push(p);
            }
        }
    }
    out
}

fn count_files(root: &Path) -> usize {
    walkdir_all(root).len()
}

fn sha256_of(p: &Path) -> String {
    let bytes = fs::read(p).unwrap();
    let mut h = Sha256::new();
    h.update(&bytes);
    format!("{:x}", h.finalize())
}
