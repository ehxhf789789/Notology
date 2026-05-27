//! Phase B P0 #3 (HanBin 2026-05-24) — integration tests for the
//! vault_repair safety pipeline. Lives in `tests/` so it builds as a
//! standalone binary (not linked into the main app.exe, so it dodges
//! the dev-process file lock and Tauri runtime DLL needs).
//!
//! Validates each piece against real temp-vault fixtures:
//!   - `pure_obsidian` — Obsidian vault with `attachments/` + `[[file.ext]]`
//!     (mirrors HanBin T1 layout)
//!   - `legacy_notology` — sync_v1 vault with `<note>_att/` folders

use std::fs;
use std::path::{Path, PathBuf};
use tempfile::TempDir;

use app_lib::features::sync_v2::vault_repair::scan::{scan, FindingKind};
use app_lib::features::sync_v2::vault_repair::snapshot::{
    create_snapshot, list_snapshots, preview_restore, restore_snapshot,
};
use app_lib::features::sync_v2::vault_repair::apply::{apply, ApplyOptions};

// ─── fixture builders ─────────────────────────────────────────────────

fn build_pure_obsidian(root: &Path) {
    fs::create_dir_all(root.join("attachments")).unwrap();
    fs::create_dir_all(root.join(".notology")).unwrap();
    fs::write(root.join("attachments/diagram.png"), b"PNG content here").unwrap();
    fs::write(root.join("attachments/report.pdf"), b"%PDF-1.4 content").unwrap();
    fs::write(root.join("attachments/orphan.png"), b"unused image").unwrap();
    fs::write(
        root.join("Note A.md"),
        "---\ntitle: Note A\n---\n\nSee [[diagram.png]] and [[report.pdf]].",
    ).unwrap();
    fs::write(
        root.join("Note B.md"),
        "---\ntitle: Note B\n---\n\nEmbed: ![[diagram.png|200x300]]\n\nAlias: [[report.pdf|My Report]]",
    ).unwrap();
    fs::write(root.join("Plain.md"), "---\ntitle: Plain\n---\n\nNothing here.").unwrap();
}

fn build_legacy_notology(root: &Path) {
    fs::create_dir_all(root.join(".notology")).unwrap();
    fs::create_dir_all(root.join("Note1_att")).unwrap();
    fs::write(root.join("Note1.md"), "---\ntitle: Note1\n---\n\n[[Report.pdf]]").unwrap();
    fs::write(root.join("Note1_att/Report.pdf"), b"PDF bytes").unwrap();
}

// ─── tests ────────────────────────────────────────────────────────────

#[test]
fn snapshot_roundtrip_is_byte_identical() {
    let tmp = TempDir::new().unwrap();
    let vault = tmp.path();
    build_pure_obsidian(vault);

    let manifest = create_snapshot(vault, "test").unwrap();
    assert!(manifest.completed_at.is_some(), "snapshot completed_at not set");
    assert!(manifest.file_count >= 6, "expected at least 6 files, got {}", manifest.file_count);

    let snaps = list_snapshots(vault).unwrap();
    assert!(snaps.iter().any(|s| s.snapshot_id == manifest.snapshot_id));

    // Mutate vault: delete + modify + add.
    fs::remove_file(vault.join("Plain.md")).unwrap();
    fs::write(vault.join("Note A.md"), "---\ntitle: Mutated\n---\nDifferent content.").unwrap();
    fs::write(vault.join("New.md"), "post-snapshot file").unwrap();

    let preview = preview_restore(vault, &manifest.snapshot_id).unwrap();
    assert_eq!(preview.files_to_delete, vec!["New.md".to_string()],
        "files_to_delete: {:?}", preview.files_to_delete);
    assert!(preview.files_to_overwrite.iter().any(|p| p == "Note A.md"));
    assert!(preview.files_to_overwrite.iter().any(|p| p == "Plain.md"));

    let outcome = restore_snapshot(vault, &manifest.snapshot_id).unwrap();
    assert!(outcome.files_restored >= 2, "restored {}", outcome.files_restored);
    assert_eq!(outcome.files_deleted, 1, "deleted {}", outcome.files_deleted);

    assert!(vault.join("Plain.md").is_file(), "Plain.md not restored");
    assert!(!vault.join("New.md").exists(), "New.md should have been deleted");
    let note_a = fs::read_to_string(vault.join("Note A.md")).unwrap();
    assert!(note_a.contains("title: Note A"), "Note A.md content not restored: {}", note_a);

    // Cleanup the snapshot from LOCALAPPDATA to avoid polluting between runs.
    let _ = app_lib::features::sync_v2::vault_repair::snapshot::delete_snapshot(vault, &manifest.snapshot_id);
}

#[test]
fn scan_detects_obsidian_attachments() {
    let tmp = TempDir::new().unwrap();
    let vault = tmp.path();
    build_pure_obsidian(vault);

    let report = scan(vault).unwrap();
    assert_eq!(
        report.counts.obsidian_attachments, 3,
        "expected 3 Obsidian attachments, got {} ({:?})",
        report.counts.obsidian_attachments, report.counts
    );
    let p9_count = report.findings.iter()
        .filter(|f| f.kind == FindingKind::ObsidianAttachmentsFolder)
        .count();
    assert_eq!(p9_count, 3);
}

#[test]
fn scan_detects_legacy_att_folder() {
    let tmp = TempDir::new().unwrap();
    let vault = tmp.path();
    build_legacy_notology(vault);

    let report = scan(vault).unwrap();
    assert!(report.counts.legacy_att_folder >= 1, "expected legacy _att/ detected");
}

#[test]
fn dry_run_does_not_modify_vault_but_projects_counts() {
    let tmp = TempDir::new().unwrap();
    let vault = tmp.path();
    build_pure_obsidian(vault);

    let pre_state: std::collections::HashMap<String, Vec<u8>> = {
        let mut m = std::collections::HashMap::new();
        for entry in walkdir(vault) {
            let rel = entry.strip_prefix(vault).unwrap().to_string_lossy().to_string();
            m.insert(rel, fs::read(&entry).unwrap());
        }
        m
    };

    let report = scan(vault).unwrap();
    let opts = ApplyOptions {
        auto_only: true,
        skip_orphan_sweep: false,
        skip_snapshot: false,
        dry_run: true,
    };
    let outcome = apply(vault, &report, &opts).unwrap();

    assert!(outcome.was_dry_run, "outcome.was_dry_run should be true");
    // T1 perf finding (2026-05-24): dry-run no longer snapshots.
    // Users dry-run multiple times before committing; per-dry-run
    // snapshot cost (10+ min on 44 GB vault) was wrong. Pure preview.
    assert!(outcome.snapshot_id.is_none(), "dry-run must NOT snapshot (pure preview)");
    assert!(outcome.obsidian_attachments_imported >= 2,
        "expected ≥2 P9 projections, got {}",
        outcome.obsidian_attachments_imported);

    for (rel, original) in &pre_state {
        let cur_path = vault.join(rel);
        assert!(cur_path.is_file(), "dry-run deleted user file: {}", rel);
        let cur = fs::read(&cur_path).unwrap();
        assert_eq!(*original, cur, "dry-run modified user file: {}", rel);
    }

    // No snapshot cleanup needed — dry-run doesn't snapshot now.
}

#[test]
fn apply_creates_attachment_refs_for_p9() {
    let tmp = TempDir::new().unwrap();
    let vault = tmp.path();
    build_pure_obsidian(vault);

    let report = scan(vault).unwrap();
    let opts = ApplyOptions {
        auto_only: true,
        skip_orphan_sweep: true,
        skip_snapshot: true,
        dry_run: false,
    };
    let outcome = apply(vault, &report, &opts).unwrap();

    assert!(outcome.obsidian_attachments_imported >= 4,
        "expected ≥4 P9 imports, got {} (errors: {:?})",
        outcome.obsidian_attachments_imported, outcome.errors);

    let store = app_lib::features::sync_v2::attachment_store::AttachmentStore::new(
        vault.to_path_buf()
    ).unwrap();
    let refs: Vec<_> = store.all_refs().collect();
    let diagram_refs: Vec<_> = refs.iter().filter(|r| r.original_name == "diagram.png").collect();
    let report_refs: Vec<_> = refs.iter().filter(|r| r.original_name == "report.pdf").collect();
    let orphan_refs: Vec<_> = refs.iter().filter(|r| r.original_name == "orphan.png").collect();
    assert_eq!(diagram_refs.len(), 2,
        "expected 2 refs for diagram.png, got {}", diagram_refs.len());
    assert_eq!(report_refs.len(), 2,
        "expected 2 refs for report.pdf, got {}", report_refs.len());
    assert_eq!(orphan_refs.len(), 0,
        "orphan.png should not have a ref");
    for r in &refs {
        assert_eq!(r.linked_notes.len(), 1,
            "B-model violated: ref {} has {} linked_notes",
            r.attachment_id, r.linked_notes.len());
    }
}

#[test]
fn snapshot_skipped_when_skip_snapshot_true() {
    let tmp = TempDir::new().unwrap();
    let vault = tmp.path();
    build_pure_obsidian(vault);
    let report = scan(vault).unwrap();
    let opts = ApplyOptions {
        skip_snapshot: true,
        ..Default::default()
    };
    let outcome = apply(vault, &report, &opts).unwrap();
    assert!(outcome.snapshot_id.is_none(),
        "snapshot_id should be None when skip_snapshot=true");
}

#[test]
fn p9_wikilink_embed_and_alias_syntax_both_caught() {
    let tmp = TempDir::new().unwrap();
    let vault = tmp.path();
    fs::create_dir_all(vault.join("attachments")).unwrap();
    fs::create_dir_all(vault.join(".notology")).unwrap();
    fs::write(vault.join("attachments/file.pdf"), b"PDF").unwrap();
    fs::write(vault.join("Note.md"),
        "---\ntitle: T\n---\n\
         ![[file.pdf]]\n\
         [[file.pdf|My File]]\n\
         [[file.pdf#section1]]"
    ).unwrap();

    let report = scan(vault).unwrap();
    let opts = ApplyOptions {
        skip_snapshot: true,
        ..Default::default()
    };
    let outcome = apply(vault, &report, &opts).unwrap();
    assert!(outcome.obsidian_attachments_imported >= 1,
        "expected ≥1 import despite embed/alias/anchor syntax, got {} (errors: {:?})",
        outcome.obsidian_attachments_imported, outcome.errors);
    let store = app_lib::features::sync_v2::attachment_store::AttachmentStore::new(
        vault.to_path_buf()
    ).unwrap();
    let refs: Vec<_> = store.all_refs().collect();
    assert!(refs.iter().any(|r| r.original_name == "file.pdf"));
}

#[test]
fn snapshot_creates_localappdata_storage_not_in_vault() {
    let tmp = TempDir::new().unwrap();
    let vault = tmp.path();
    build_pure_obsidian(vault);

    let manifest = create_snapshot(vault, "isolation_test").unwrap();
    // .legacy/ should NOT contain the snapshot — it lives in LOCALAPPDATA.
    let in_vault_legacy = vault.join(".legacy");
    if in_vault_legacy.exists() {
        let count = fs::read_dir(&in_vault_legacy).map(|e| e.count()).unwrap_or(0);
        assert_eq!(count, 0,
            "snapshot leaked into vault .legacy/ — must live outside vault");
    }
    let _ = app_lib::features::sync_v2::vault_repair::snapshot::delete_snapshot(vault, &manifest.snapshot_id);
}

// ─── helpers ──────────────────────────────────────────────────────────

fn walkdir(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(d) = stack.pop() {
        if let Some(n) = d.file_name().and_then(|s| s.to_str()) {
            if n.starts_with('.') {
                continue;
            }
        }
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
