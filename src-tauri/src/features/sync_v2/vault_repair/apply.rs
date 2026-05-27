//! vault_repair::apply — execute the fixes from a `RepairReport`.
//!
//! Each pattern (P1–P7) is handled by an independent fixer. Failures on
//! individual items are recorded in `outcome.errors` but do NOT abort the
//! rest. Apply is single-threaded; a higher-level mutex (set in the
//! Tauri command layer) guards against concurrent repair runs.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;

use crate::features::sync_v2::attachment_store::AttachmentStore;
use crate::core::note_id::read_id_from_content;

use super::backup::{BackupHandle, BackupKind};
use super::progress::{self, RepairStage};
use super::scan::{FindingKind, RepairFinding, RepairReport};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyOptions {
    /// If true, only auto-fixable findings are applied. Default true.
    pub auto_only: bool,
    /// Skip pattern P7 (orphan blob sweep). Default false.
    pub skip_orphan_sweep: bool,
    /// Phase 1 B1 (2026-05-24): bypass the mandatory pre-apply snapshot.
    /// Default false. Setting true makes the apply skip the safety net —
    /// only use in tests or when the caller has just taken its own
    /// snapshot via `vault_snapshot_create`.
    #[serde(default)]
    pub skip_snapshot: bool,
    /// Phase 2 B4 (2026-05-24): dry-run mode. When true, every fixer
    /// records what it WOULD do (in outcome counts) but performs no
    /// disk writes. Lets the user preview the change set before
    /// committing. Default false.
    #[serde(default)]
    pub dry_run: bool,
}

impl ApplyOptions {
    pub fn default_safe() -> Self {
        Self {
            auto_only: true,
            skip_orphan_sweep: false,
            skip_snapshot: false,
            dry_run: false,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyOutcome {
    pub legacy_att_migrated: usize,
    pub sketch_external_imported: usize,
    pub sketch_unresolved_imported: usize,
    pub wikilink_resolved: usize,
    pub shared_refs_split: usize,
    pub orphan_blobs_swept: usize,
    /// P9 (2026-05-24) — Obsidian shared-attachments files imported as
    /// Notology AttachmentRefs. Linked to whichever note(s) wikilink
    /// them in body; orphans (no wikilink) become standalone refs.
    #[serde(default)]
    pub obsidian_attachments_imported: usize,
    pub errors: Vec<String>,
    pub backup_dir: String,
    /// Phase 1 B3 (2026-05-24): id of the pre-apply snapshot. UI uses
    /// this for the "Restore" affordance if verify fails or the user
    /// wants to undo. None when `skip_snapshot=true`.
    #[serde(default)]
    pub snapshot_id: Option<String>,
    /// Phase 2 B4 (2026-05-24): true iff this run was a dry-run (no
    /// disk writes). UI surfaces "DRY RUN — no changes applied" badge.
    #[serde(default)]
    pub was_dry_run: bool,
}

pub fn apply(
    vault_root: &Path,
    report: &RepairReport,
    options: &ApplyOptions,
) -> Result<ApplyOutcome, String> {
    let t0 = std::time::Instant::now();
    log::info!(
        "[vault_repair::apply] START vault={:?} findings={} (P1={} P2={} P3={} P4={} P6={} P7={})",
        vault_root,
        report.findings.len(),
        report.counts.legacy_att_folder,
        report.counts.sketch_external_path,
        report.counts.sketch_unresolved_ref,
        report.counts.wikilink_resolvable,
        report.counts.shared_ref,
        report.counts.orphan_blob,
    );

    // Phase 2 B4 — dry-run EARLY return. Must precede the snapshot +
    // BackupHandle steps because both write to disk (snapshot → LOCALAPPDATA,
    // BackupHandle → vault/.legacy/repair_<ts>/). A true dry-run touches
    // ZERO disk and runs in <1s even on huge vaults. The user who wants a
    // safety net before a dry-run can take a snapshot manually via the
    // Snapshot Manager — but most users dry-run multiple times before
    // committing, so making every dry-run pay the snapshot cost (10+ min
    // on the 44 GB HanBin vault) would be wrong.
    if options.dry_run {
        let mut outcome = ApplyOutcome::default();
        // 2026-05-24 (HanBin) — chaos test caught: dry-run was counting
        // findings array which may be capped (MAX_FINDINGS_PER_KIND).
        // counts.* IS the true total because the counter increments
        // before push_finding even when the cap rejects the push.
        // Use counts.* directly — same semantic, capped-array-safe.
        outcome.was_dry_run = true;
        outcome.legacy_att_migrated = report.counts.legacy_att_folder;
        outcome.sketch_external_imported = report.counts.sketch_external_path;
        outcome.sketch_unresolved_imported = report.counts.sketch_unresolved_ref;
        outcome.wikilink_resolved = report.counts.wikilink_resolvable;
        outcome.orphan_blobs_swept = report.counts.orphan_blob;
        outcome.obsidian_attachments_imported = report.counts.obsidian_attachments;
        outcome.shared_refs_split = report.findings.iter()
            .filter(|f| f.kind == FindingKind::SharedRef && f.auto_fixable)
            .map(|f| {
                f.detail.as_deref()
                    .and_then(|d| d.rsplit_once('(').map(|(_, rest)| rest))
                    .and_then(|s| s.split_whitespace().next())
                    .and_then(|s| s.parse::<usize>().ok())
                    .map(|n| n.saturating_sub(1))
                    .unwrap_or(1)
            })
            .sum();
        progress::set_progress(
            RepairStage::Completed, 0, 0,
            "Dry run complete. Vault unchanged (no snapshot taken).".to_string(),
        );
        log::info!(
            "[vault_repair::apply] DRY RUN complete in {:?} (no disk writes) — \
             projected: p1={} p2={} p3={} p4={} p6={} p7={} p9={}",
            t0.elapsed(),
            outcome.legacy_att_migrated,
            outcome.sketch_external_imported,
            outcome.sketch_unresolved_imported,
            outcome.wikilink_resolved,
            outcome.shared_refs_split,
            outcome.orphan_blobs_swept,
            outcome.obsidian_attachments_imported,
        );
        return Ok(outcome);
    }

    // Phase 1 B1+B2+B3 (HanBin 2026-05-24) — MANDATORY full snapshot
    // before any destructive operation. This is the load-bearing
    // safety primitive: if anything goes wrong during apply, the user
    // can 1-click restore to the pre-apply state via the Snapshot
    // Manager UI. Skip only when explicitly opted out (for tests or
    // when the caller already took a snapshot).
    let snapshot_id = if options.skip_snapshot {
        log::warn!("[vault_repair::apply] skip_snapshot=true — proceeding WITHOUT safety snapshot");
        None
    } else {
        progress::set_progress(
            RepairStage::BackingUp, 0, 0,
            "Creating full vault snapshot (safety net)...".to_string(),
        );
        match super::snapshot::create_snapshot(vault_root, "pre-repair") {
            Ok(m) => {
                log::info!(
                    "[vault_repair::apply] safety snapshot created: {} ({} files, {} bytes)",
                    m.snapshot_id, m.file_count, m.total_bytes
                );
                Some(m.snapshot_id)
            }
            Err(e) => {
                log::error!("[vault_repair::apply] snapshot FAILED: {}", e);
                return Err(format!(
                    "Pre-apply snapshot failed: {}. Refusing to proceed — no safety net available. \
                     If you really want to bypass this, pass skip_snapshot=true.",
                    e
                ));
            }
        }
    };

    progress::set_progress(
        RepairStage::BackingUp, 0, 0,
        "Creating change-tracking backup...".to_string(),
    );
    let mut handle = BackupHandle::create(vault_root)?;
    let mut outcome = ApplyOutcome {
        backup_dir: handle.dir.to_string_lossy().replace('\\', "/"),
        snapshot_id: snapshot_id.clone(),
        was_dry_run: options.dry_run,
        ..Default::default()
    };

    // (Dry-run early return moved BEFORE snapshot — see top of fn.)

    let mut store = AttachmentStore::new(vault_root.to_path_buf())?;

    // Cancel-check helper used at every safe checkpoint. Returns true
    // when the caller should bail out cleanly (apply is half-done but
    // the backup is intact so the user can rollback if needed).
    macro_rules! check_cancel {
        () => {
            if progress::should_cancel() {
                log::warn!("[vault_repair::apply] CANCELLED by user request");
                outcome.errors.push("cancelled by user".to_string());
                progress::set_progress(
                    RepairStage::Cancelled, 0, 0,
                    "Cancelled by user. Partial changes remain; rollback available via the backup folder.".to_string(),
                );
                outcome_to_manifest(&mut handle.manifest.applied_counts, &outcome);
                let _ = handle.persist_manifest();
                return Ok(outcome);
            }
        };
    }

    // ── P1: legacy <note>_att/ migration delegates to the existing pipeline.
    // The migrator already backs up to .legacy/<ts>/ on its own; we record
    // the count for the manifest summary.
    let p1_findings: Vec<&RepairFinding> = report
        .findings
        .iter()
        .filter(|f| f.kind == FindingKind::LegacyAttFolder)
        .collect();
    if !p1_findings.is_empty() {
        check_cancel!();
        let t = std::time::Instant::now();
        log::info!("[vault_repair::apply] P1 start: {} folders", p1_findings.len());
        progress::set_progress(
            RepairStage::P1LegacyAtt, 0, p1_findings.len(),
            format!("Migrating {} legacy _att/ folders...", p1_findings.len()),
        );
        match crate::features::sync_v2::attachment_migration::AttachmentMigration::new(
            vault_root.to_path_buf(),
        )
        .run()
        {
            Ok(r) => outcome.legacy_att_migrated = r.migrated,
            Err(e) => outcome.errors.push(format!("P1 attachment_migration: {}", e)),
        }
        log::info!("[vault_repair::apply] P1 done in {:?}", t.elapsed());
        // Re-open store after migration to pick up new refs.
        store = AttachmentStore::new(vault_root.to_path_buf())?;
    }

    // ── P2 + P3: sketch nodes
    {
        check_cancel!();
        let t = std::time::Instant::now();
        let n = report.findings.iter().filter(|f|
            f.kind == FindingKind::SketchExternalPath || f.kind == FindingKind::SketchUnresolvedRef
        ).count();
        log::info!("[vault_repair::apply] P2+P3 start: {} sketch findings", n);
        progress::set_progress(
            RepairStage::P2P3Sketch, 0, n,
            format!("Importing {} sketch attachments...", n),
        );
        apply_sketch_fixes(vault_root, report, &mut store, &mut handle, &mut outcome)?;
        log::info!("[vault_repair::apply] P2+P3 done in {:?}", t.elapsed());
    }

    // ── P4: wikilinks with single-candidate file in vault.
    {
        check_cancel!();
        let t = std::time::Instant::now();
        let n = report.findings.iter().filter(|f|
            f.kind == FindingKind::WikilinkResolvable && f.auto_fixable
        ).count();
        log::info!("[vault_repair::apply] P4 start: {} wikilink findings", n);
        progress::set_progress(
            RepairStage::P4Wikilink, 0, n,
            format!("Resolving {} wikilinks...", n),
        );
        apply_wikilink_fixes(vault_root, report, &mut store, &mut handle, &mut outcome)?;
        log::info!("[vault_repair::apply] P4 done in {:?}", t.elapsed());
    }

    // ── P6: split shared refs (linked_notes.len() ≥ 2).
    {
        check_cancel!();
        let t = std::time::Instant::now();
        let n = report.findings.iter().filter(|f| f.kind == FindingKind::SharedRef).count();
        log::info!("[vault_repair::apply] P6 start: {} shared refs", n);
        progress::set_progress(
            RepairStage::P6SplitSharedRef, 0, n,
            format!("Splitting {} shared refs...", n),
        );
        apply_shared_ref_splits(report, &mut store, &mut handle, &mut outcome)?;
        log::info!("[vault_repair::apply] P6 done in {:?}", t.elapsed());
    }

    // ── P9 (HanBin 2026-05-24): Obsidian shared-attachments folder
    //     ingestion. For each file in a known Obsidian attachments
    //     folder (attachments/, _attachments/, etc.), find which
    //     notes wikilink it in their bodies, and create one
    //     AttachmentRef per (file, note) pair (B-model: per-note
    //     ref + shared CAS blob). Files with no wikilinks become
    //     standalone refs linked to a synthetic vault-root note
    //     (or skipped — current impl skips for safety).
    {
        check_cancel!();
        let t = std::time::Instant::now();
        let n = report.findings.iter().filter(|f|
            f.kind == FindingKind::ObsidianAttachmentsFolder && f.auto_fixable
        ).count();
        log::info!("[vault_repair::apply] P9 start: {} Obsidian attachments", n);
        progress::set_progress(
            RepairStage::P2P3Sketch, 0, n,
            format!("Importing {} Obsidian attachments...", n),
        );
        apply_obsidian_attachments(vault_root, report, &mut store, &mut handle, &mut outcome)?;
        log::info!("[vault_repair::apply] P9 done in {:?}", t.elapsed());
    }

    // ── P8 (HanBin 2026-05-24): purge bogus .md AttachmentRefs that
    // were created when the old WikiLinkSearch flow stored note refs
    // as `type:'file'` sketch nodes (the source-of-bug for `ddddd.md`
    // appearing as a teal attachment). 2026-05-24 refinement: per
    // HanBin's rule, drag-in .md IS a legitimate attachment, so we
    // must NOT blanket-purge all .md refs. Only purge refs that:
    //   • have `.md` extension AND
    //   • have an existing matching .md file inside the vault (i.e.
    //     "this ref shadows an actual note — it can't be an external
    //     attachment").
    // External drag-in .md (no matching vault note) survives. The
    // sketch on-load migration in SketchEditor handles the partner
    // problem of converting old file-nodes to link-nodes.
    {
        check_cancel!();
        progress::set_progress(
            RepairStage::P8PurgeBogusMd, 0, 0,
            "Purging shadow .md AttachmentRefs...".to_string(),
        );
        let t = std::time::Instant::now();
        let mut vault_md_basenames: std::collections::HashSet<String> =
            std::collections::HashSet::new();
        collect_vault_md_basenames(vault_root, &mut vault_md_basenames);
        let bogus_ids: Vec<String> = store
            .all_refs()
            .filter(|r| {
                let ext = r.original_name.rsplit('.').next().unwrap_or("").to_lowercase();
                if ext != "md" { return false; }
                // Only purge if there's an actual vault note with this name
                // — shadow case. Standalone .md refs (e.g. dragged in from
                // outside) are legitimate attachments and survive.
                vault_md_basenames.contains(&r.original_name.to_lowercase())
            })
            .map(|r| r.attachment_id.clone())
            .collect();
        let n = bogus_ids.len();
        for id in bogus_ids {
            if let Err(e) = store.delete_attachment(&id) {
                outcome.errors.push(format!("P8 purge shadow .md ref {}: {}", id, e));
            }
        }
        log::info!(
            "[vault_repair::apply] P8 done in {:?} — purged {} shadow .md refs ({} legit .md refs preserved)",
            t.elapsed(), n,
            store.all_refs().filter(|r| r.original_name.to_lowercase().ends_with(".md")).count()
        );
    }

    // ── P7: orphan blob sweep.
    if !options.skip_orphan_sweep {
        check_cancel!();
        let t = std::time::Instant::now();
        let n = report.findings.iter().filter(|f| f.kind == FindingKind::OrphanBlob).count();
        log::info!("[vault_repair::apply] P7 start: {} orphan blobs", n);
        progress::set_progress(
            RepairStage::P7OrphanSweep, 0, n,
            format!("Sweeping {} orphan blobs...", n),
        );
        apply_orphan_sweep(report, &mut store, &mut outcome);
        log::info!("[vault_repair::apply] P7 done in {:?}", t.elapsed());
    }

    progress::set_progress(
        RepairStage::Completed, 0, 0,
        "Repair complete.".to_string(),
    );

    // Persist final counts to manifest for audit.
    outcome_to_manifest(&mut handle.manifest.applied_counts, &outcome);
    let _ = handle.persist_manifest();

    log::info!(
        "[vault_repair::apply] DONE in {:?} — migrated={} ext_imported={} unref_imported={} wiki={} split={} swept={} errors={}",
        t0.elapsed(),
        outcome.legacy_att_migrated,
        outcome.sketch_external_imported,
        outcome.sketch_unresolved_imported,
        outcome.wikilink_resolved,
        outcome.shared_refs_split,
        outcome.orphan_blobs_swept,
        outcome.errors.len(),
    );
    Ok(outcome)
}

// ─── P2 + P3 ──────────────────────────────────────────────────────────

fn apply_sketch_fixes(
    vault_root: &Path,
    report: &RepairReport,
    store: &mut AttachmentStore,
    backup: &mut BackupHandle,
    outcome: &mut ApplyOutcome,
) -> Result<(), String> {
    // Group by note path so we rewrite each sketch JSON once.
    let mut sketch_targets: HashMap<String, Vec<&RepairFinding>> = HashMap::new();
    for f in &report.findings {
        if !f.auto_fixable {
            continue;
        }
        match f.kind {
            FindingKind::SketchExternalPath | FindingKind::SketchUnresolvedRef => {
                sketch_targets
                    .entry(f.target.clone())
                    .or_default()
                    .push(f);
            }
            _ => {}
        }
    }

    for (note_rel, findings) in &sketch_targets {
        if progress::should_cancel() { return Ok(()); }
        progress::bump_current();
        let abs = vault_root.join(note_rel.replace('/', std::path::MAIN_SEPARATOR_STR.as_ref()));
        let content = match std::fs::read_to_string(&abs) {
            Ok(c) => c,
            Err(e) => {
                outcome.errors.push(format!("read sketch {:?}: {}", abs, e));
                continue;
            }
        };
        let note_id = read_id_from_content(&content).unwrap_or_else(|| {
            abs.file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_string()
        });

        // Backup before mutation.
        if let Err(e) = backup.snapshot(&abs, BackupKind::NoteBody) {
            outcome.errors.push(format!("backup sketch {:?}: {}", abs, e));
            continue;
        }

        // Parse frontmatter + JSON body.
        let (fm, body) = split_frontmatter(&content);
        let mut parsed: JsonValue = match serde_json::from_str(body.trim()) {
            Ok(v) => v,
            Err(e) => {
                outcome.errors.push(format!("parse sketch JSON {:?}: {}", abs, e));
                continue;
            }
        };

        // Walk nodes; rewrite `file:` per finding.
        let nodes = parsed
            .get_mut("nodes")
            .and_then(|n| n.as_array_mut());
        let Some(nodes) = nodes else {
            continue;
        };

        let mut local_changed = 0usize;
        let mut local_errors = vec![];
        for node in nodes {
            let nt = node.get("type").and_then(|t| t.as_str()).unwrap_or("");
            if nt != "file" {
                continue;
            }
            let cur_file = node
                .get("file")
                .and_then(|f| f.as_str())
                .map(str::to_string);
            let Some(cur_file) = cur_file else {
                continue;
            };
            let basename = std::path::Path::new(&cur_file)
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or(&cur_file)
                .to_string();
            // 2026-05-24 (HanBin) — Bug 1 fix. Skip note (.md) files
            // and unknown extensions. The user had `ddddd.md` rendering
            // as a teal attachment node in the graph because a sketch
            // file-node pointed at it; importing it via add_attachment
            // pollutes the store. Mirrors the scan-side guard in
            // detect_p2_p3_sketch.
            if !looks_like_attachment_basename(&basename) {
                continue;
            }
            // Resolve / import.
            let abs_src = if std::path::Path::new(&cur_file).is_absolute() {
                PathBuf::from(&cur_file)
            } else {
                vault_root.join(&cur_file)
            };
            if !abs_src.is_file() {
                local_errors.push(format!("file missing: {}", cur_file));
                continue;
            }
            match store.add_attachment(&abs_src, &basename, &note_id) {
                Ok(out) => {
                    let new_rel = format!(".attachments/{}",
                        std::path::Path::new(&out.attachment_ref.display_path)
                            .file_name()
                            .and_then(|s| s.to_str())
                            .unwrap_or(&basename));
                    node.as_object_mut()
                        .unwrap()
                        .insert("file".into(), JsonValue::String(new_rel));
                    local_changed += 1;
                    // Classify against the original finding kind for the count.
                    let was_external = findings
                        .iter()
                        .any(|f| f.kind == FindingKind::SketchExternalPath && f.detail.as_deref() == Some(cur_file.as_str()));
                    if was_external {
                        outcome.sketch_external_imported += 1;
                    } else {
                        outcome.sketch_unresolved_imported += 1;
                    }
                }
                Err(e) => local_errors.push(format!("import {}: {}", cur_file, e)),
            }
        }

        if local_changed > 0 {
            let new_body = serde_json::to_string(&parsed)
                .map_err(|e| format!("re-serialize sketch JSON: {}", e))?;
            let new_content = format!("{}{}", fm, new_body);
            if let Err(e) = atomic_write(&abs, new_content.as_bytes()) {
                outcome.errors.push(format!("write sketch {:?}: {}", abs, e));
            }
        }
        for err in local_errors {
            outcome.errors.push(format!("{}: {}", note_rel, err));
        }
    }

    Ok(())
}

// ─── P4 ───────────────────────────────────────────────────────────────

fn apply_wikilink_fixes(
    vault_root: &Path,
    report: &RepairReport,
    store: &mut AttachmentStore,
    _backup: &mut BackupHandle,
    outcome: &mut ApplyOutcome,
) -> Result<(), String> {
    // 2026-05-24 (HanBin) — perf fix. The original implementation called
    // `find_file_in_vault` PER finding, walking the entire vault each
    // time → O(findings × files) hot path that turned ~50 findings on a
    // 5000-file vault into 250,000 stat syscalls. Now we walk the vault
    // ONCE up-front and look up candidates by basename in O(1).
    let p4_count = report.findings.iter().filter(|f|
        f.kind == FindingKind::WikilinkResolvable && f.auto_fixable
    ).count();
    if p4_count == 0 {
        return Ok(());
    }
    let mut file_index: std::collections::HashMap<String, Vec<PathBuf>> =
        std::collections::HashMap::new();
    let t_idx = std::time::Instant::now();
    index_vault_files_for_apply(vault_root, &mut file_index);
    log::info!(
        "[vault_repair::apply::P4] indexed {} unique basenames in {:?}",
        file_index.len(),
        t_idx.elapsed()
    );

    for f in &report.findings {
        if f.kind != FindingKind::WikilinkResolvable || !f.auto_fixable {
            continue;
        }
        if progress::should_cancel() { return Ok(()); }
        progress::bump_current();
        let chip = f.detail.clone().unwrap_or_default();
        let note_path = vault_root.join(f.target.replace('/', std::path::MAIN_SEPARATOR_STR.as_ref()));
        let content = match std::fs::read_to_string(&note_path) {
            Ok(c) => c,
            Err(e) => {
                outcome.errors.push(format!("P4 read {:?}: {}", note_path, e));
                continue;
            }
        };
        let note_id = read_id_from_content(&content).unwrap_or_else(|| {
            note_path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_string()
        });
        // O(1) lookup against the pre-built index.
        let candidates = file_index.get(&chip.to_lowercase());
        let Some(candidates) = candidates else { continue };
        if candidates.len() != 1 {
            continue;
        }
        let src = &candidates[0];
        match store.add_attachment(src, &chip, &note_id) {
            Ok(_) => outcome.wikilink_resolved += 1,
            Err(e) => outcome.errors.push(format!("P4 import {}: {}", chip, e)),
        }
    }
    Ok(())
}

/// Walk the vault tree (skipping hidden dirs + `_att/`) and collect the
/// lowercase basenames of every `.md` file. Used by P8 to distinguish
/// "shadow" .md AttachmentRefs (where a same-named note exists) from
/// legitimate external-attachment .md refs (no matching note).
fn collect_vault_md_basenames(
    vault_root: &Path,
    out: &mut std::collections::HashSet<String>,
) {
    let mut stack = vec![vault_root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        if dir != vault_root {
            if let Some(n) = dir.file_name().and_then(|s| s.to_str()) {
                if n.starts_with('.') || n.ends_with("_att") {
                    continue;
                }
            }
        }
        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_dir() {
                stack.push(p);
                continue;
            }
            if let Some(basename) = p.file_name().and_then(|s| s.to_str()) {
                if basename.to_lowercase().ends_with(".md") {
                    out.insert(basename.to_lowercase());
                }
            }
        }
    }
}

// ─── P9 — Obsidian attachments ────────────────────────────────────────

/// Phase 3 P9 (2026-05-24, HanBin) — ingest files from Obsidian shared-
/// attachments folders as Notology AttachmentRefs. Per-finding flow:
///   1. Resolve the file's vault-relative path → absolute path.
///   2. Scan all .md bodies for `[[<basename>]]` wikilinks (with or
///      without extension) — these are the notes that reference it.
///   3. For each linking note: `attachment_add(file, note_id)` →
///      creates per-note ref + shared CAS blob (B-model).
///   4. If no notes link it: skip (do NOT create an orphan ref; the
///      user can wikilink it later, at which point a subsequent repair
///      pass will catch it via P4).
fn apply_obsidian_attachments(
    vault_root: &Path,
    report: &RepairReport,
    store: &mut AttachmentStore,
    _backup: &mut BackupHandle,
    outcome: &mut ApplyOutcome,
) -> Result<(), String> {
    let p9_findings: Vec<&RepairFinding> = report.findings.iter()
        .filter(|f| f.kind == FindingKind::ObsidianAttachmentsFolder && f.auto_fixable)
        .collect();
    if p9_findings.is_empty() {
        return Ok(());
    }

    // Pre-scan: for each note, collect the set of wikilink basenames
    // (lowercased) it references. Reuses the same logic as P4's
    // wikilink extraction, run ONCE up-front.
    let mut note_chip_map: std::collections::HashMap<PathBuf, std::collections::HashSet<String>>
        = std::collections::HashMap::new();
    let mut note_id_by_path: std::collections::HashMap<PathBuf, String>
        = std::collections::HashMap::new();
    let mut md_files: Vec<PathBuf> = Vec::new();
    walk_md_for_apply(vault_root, &mut md_files);
    // P1 #4 (HanBin 2026-05-24) — broader regex covering BOTH
    //   `[[file.ext]]`   (wikilink)
    //   `![[file.ext]]`  (Obsidian image/embed syntax)
    // The leading `!` is captured separately but treated identically
    // for the purpose of "this note references this file".
    let wiki_re = regex::Regex::new(r"!?\[\[([^\]\[\n]+)\]\]")
        .map_err(|e| format!("compile wikilink regex: {}", e))?;
    for md in &md_files {
        // Skip Excalidraw and Obsidian Canvas siblings — they're not
        // Notology notes and their `[[...]]` syntax can mean
        // something different (Excalidraw embeds, Canvas references).
        // Cheap filter via filename suffix before reading content.
        let stem_lower = md.file_stem()
            .and_then(|s| s.to_str())
            .map(|s| s.to_lowercase())
            .unwrap_or_default();
        if stem_lower.ends_with(".excalidraw") {
            continue;
        }
        let content = match std::fs::read_to_string(md) {
            Ok(c) => c,
            Err(_) => continue,
        };
        let nid = read_id_from_content(&content)
            .unwrap_or_else(|| md.file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_string());
        if nid.is_empty() { continue; }
        note_id_by_path.insert(md.clone(), nid);
        let mut chips = std::collections::HashSet::new();
        for cap in wiki_re.captures_iter(&content) {
            let inner = cap.get(1).map(|m| m.as_str()).unwrap_or("");
            // Strip alias `[[file|alias]]`, width spec `[[file|175]]`,
            // and Obsidian image size spec `[[file|200x300]]`.
            let target = inner.split('|').next().unwrap_or("").trim();
            if target.is_empty() { continue; }
            // Strip heading anchor `[[Note#Heading]]` and block anchor
            // `[[Note^block-id]]` — both leave just the note/file name.
            let target = target.split('#').next().unwrap_or("").trim();
            let target = target.split('^').next().unwrap_or("").trim();
            if target.is_empty() { continue; }
            chips.insert(target.to_lowercase());
        }
        if !chips.is_empty() {
            note_chip_map.insert(md.clone(), chips);
        }
    }

    for f in p9_findings {
        if progress::should_cancel() { return Ok(()); }
        progress::bump_current();
        let abs = vault_root.join(f.target.replace('/', std::path::MAIN_SEPARATOR_STR.as_ref()));
        if !abs.is_file() { continue; }
        let basename = match abs.file_name().and_then(|s| s.to_str()) {
            Some(b) => b.to_string(),
            None => continue,
        };
        let basename_lower = basename.to_lowercase();
        let basename_no_ext = std::path::Path::new(&basename)
            .file_stem()
            .and_then(|s| s.to_str())
            .map(|s| s.to_lowercase())
            .unwrap_or_default();

        // Find linking notes — match either full filename or stem.
        let mut linking_note_ids: Vec<String> = Vec::new();
        for (md_path, chips) in &note_chip_map {
            if chips.contains(&basename_lower) || chips.contains(&basename_no_ext) {
                if let Some(nid) = note_id_by_path.get(md_path) {
                    linking_note_ids.push(nid.clone());
                }
            }
        }
        if linking_note_ids.is_empty() {
            // Orphan attachment — skip rather than create an unowned ref.
            continue;
        }
        // Create one ref per linking note (B-model).
        for nid in linking_note_ids {
            match store.add_attachment(&abs, &basename, &nid) {
                Ok(_) => outcome.obsidian_attachments_imported += 1,
                Err(e) => outcome.errors.push(format!("P9 import {} for {}: {}", basename, nid, e)),
            }
        }
    }
    Ok(())
}

fn walk_md_for_apply(root: &Path, out: &mut Vec<PathBuf>) {
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        // Skip hidden / `_att` dirs — EXCEPT the root itself, which
        // may legitimately have a name starting with '.' on systems
        // where the vault lives in a tempdir or a hidden folder.
        // (HanBin 2026-05-24 — integration test caught this when
        // TempDir name `.tmpXXX` was rejected as the root.)
        if dir != root {
            if let Some(n) = dir.file_name().and_then(|s| s.to_str()) {
                if n.starts_with('.') || n.ends_with("_att") {
                    continue;
                }
            }
        }
        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_dir() {
                stack.push(p);
            } else if p.extension().and_then(|s| s.to_str()) == Some("md") {
                // Skip Excalidraw embeds — `<name>.excalidraw.md` is
                // an Excalidraw drawing wrapped as md, not a Notology
                // note. Including it would pollute the chip map with
                // Excalidraw-internal references.
                if let Some(stem) = p.file_stem().and_then(|s| s.to_str()) {
                    if stem.to_lowercase().ends_with(".excalidraw") {
                        continue;
                    }
                }
                out.push(p);
            }
        }
    }
}

fn index_vault_files_for_apply(
    vault_root: &Path,
    out: &mut std::collections::HashMap<String, Vec<PathBuf>>,
) {
    let mut stack = vec![vault_root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        // Root-tolerant hidden check (see walk_md_for_apply comment).
        if dir != vault_root {
            if let Some(n) = dir.file_name().and_then(|s| s.to_str()) {
                if n.starts_with('.') {
                    continue;
                }
            }
        }
        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_dir() {
                stack.push(p);
                continue;
            }
            if let Some(basename) = p.file_name().and_then(|s| s.to_str()) {
                if basename.ends_with(".md") {
                    continue;
                }
                out.entry(basename.to_lowercase()).or_default().push(p);
            }
        }
    }
}

// ─── P6 ───────────────────────────────────────────────────────────────

fn apply_shared_ref_splits(
    report: &RepairReport,
    store: &mut AttachmentStore,
    _backup: &mut BackupHandle,
    outcome: &mut ApplyOutcome,
) -> Result<(), String> {
    for f in &report.findings {
        if f.kind != FindingKind::SharedRef || !f.auto_fixable {
            continue;
        }
        if progress::should_cancel() { return Ok(()); }
        progress::bump_current();
        let att_id = &f.target;
        // Snapshot current linked_notes.
        let linked: Vec<String> = match store.get_by_id(att_id) {
            Some(r) => r.linked_notes.clone(),
            None => continue,
        };
        if linked.len() < 2 {
            continue;
        }
        // Q2 = (a): original ID keeps the FIRST (oldest) note; remaining
        // notes get fresh clones reusing the same blob.
        let (keeper, rest) = linked.split_first().unwrap();
        // First, unlink the rest from the original. (B-model: original
        // ends up with linked_notes = [keeper].)
        for note_id in rest {
            if let Err(e) = store.unlink_from_note(att_id, note_id) {
                outcome.errors.push(format!("P6 unlink {} from {}: {}", att_id, note_id, e));
            }
        }
        // Then clone for each of the rest.
        for note_id in rest {
            match store.clone_ref_for_note(att_id, note_id) {
                Ok(_) => outcome.shared_refs_split += 1,
                Err(e) => outcome.errors.push(format!("P6 clone {} for {}: {}", att_id, note_id, e)),
            }
        }
        // Sanity check.
        if let Some(r) = store.get_by_id(att_id) {
            if r.linked_notes != vec![keeper.clone()] {
                outcome.errors.push(format!(
                    "P6 invariant: ref {} ended with {:?}, expected [{}]",
                    att_id, r.linked_notes, keeper
                ));
            }
        }
    }
    Ok(())
}

// ─── P7 ───────────────────────────────────────────────────────────────

fn apply_orphan_sweep(
    report: &RepairReport,
    store: &mut AttachmentStore,
    outcome: &mut ApplyOutcome,
) {
    // We could re-derive orphans from the live store, but the report
    // already has them — and it's cheaper. Sweep blobs that the scan
    // marked as orphan AND that the live store still considers orphan.
    use std::collections::HashSet;
    let referenced: HashSet<String> = store.all_refs().map(|r| r.sha256.clone()).collect();
    for f in &report.findings {
        if f.kind != FindingKind::OrphanBlob {
            continue;
        }
        let sha = match &f.detail {
            Some(s) => s.clone(),
            None => continue,
        };
        if referenced.contains(&sha) {
            continue; // not orphan anymore
        }
        let blob_path = store.cas_path(&sha);
        if let Err(e) = std::fs::remove_file(&blob_path) {
            // File-locked / already gone is fine; log only on persistent failure.
            log::warn!("[vault_repair P7] remove orphan blob {:?}: {}", blob_path, e);
            continue;
        }
        outcome.orphan_blobs_swept += 1;
    }
}

// ─── helpers ──────────────────────────────────────────────────────────

fn split_frontmatter(content: &str) -> (String, String) {
    // Returns (frontmatter-including-fences-and-trailing-newline, body).
    if !content.starts_with("---") {
        return ("".to_string(), content.to_string());
    }
    let rest = &content[3..];
    let nl = if rest.starts_with("\r\n") { 2 } else { 1 };
    let after_open = &rest[nl..];
    let Some(end) = after_open.find("\n---") else {
        return ("".to_string(), content.to_string());
    };
    let fm_end_in_content = 3 + nl + end + 4; // up to and including "\n---"
    // Skip newline after closing ---
    let after_close_offset = if content[fm_end_in_content..].starts_with("\r\n") {
        fm_end_in_content + 2
    } else if content[fm_end_in_content..].starts_with('\n') {
        fm_end_in_content + 1
    } else {
        fm_end_in_content
    };
    (
        content[..after_close_offset].to_string(),
        content[after_close_offset..].to_string(),
    )
}

fn find_file_in_vault(
    dir: &Path,
    needle_lower: &str,
    found: &mut Option<PathBuf>,
    count: &mut usize,
) {
    // Recursion enters from `vault_root` at the top — we don't gate
    // the root itself on `.`-prefix (it may legitimately start with
    // a dot in tempdir / hidden-folder setups). Nested hidden dirs
    // ARE skipped via the inner check below before each recurse.
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let p = entry.path();
        if p.is_dir() {
            find_file_in_vault(&p, needle_lower, found, count);
            if *count > 1 {
                return;
            }
        } else if let Some(n) = p.file_name().and_then(|s| s.to_str()) {
            if n.to_lowercase() == needle_lower {
                *count += 1;
                if *count == 1 {
                    *found = Some(p);
                }
                if *count > 1 {
                    return;
                }
            }
        }
    }
}

fn outcome_to_manifest(target: &mut JsonValue, outcome: &ApplyOutcome) {
    let v = serde_json::json!({
        "legacy_att_migrated": outcome.legacy_att_migrated,
        "sketch_external_imported": outcome.sketch_external_imported,
        "sketch_unresolved_imported": outcome.sketch_unresolved_imported,
        "wikilink_resolved": outcome.wikilink_resolved,
        "shared_refs_split": outcome.shared_refs_split,
        "orphan_blobs_swept": outcome.orphan_blobs_swept,
        "errors": outcome.errors.len(),
    });
    *target = v;
}

/// Phase 4 B6 (HanBin 2026-05-24) — NAS-resilient atomic write.
/// Uses `rename_with_retry` from core::file_io which retries Windows
/// transient lock errors (ACCESS_DENIED=5, SHARING_VIOLATION=32,
/// LOCK_VIOLATION=33) up to 5× with 200ms backoff. Critical for
/// Synology Drive-synced vaults where the sync agent may briefly hold
/// file handles during reconciliation, causing a vanilla rename to
/// fail mid-repair.
fn atomic_write(dst: &Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = dst.with_extension("repair.tmp");
    // Write with retry for the tmp file too (rare but possible if the
    // exact destination name collides with a stale .repair.tmp from a
    // previous crashed run).
    let mut last_err: Option<std::io::Error> = None;
    for attempt in 1..=5 {
        match std::fs::write(&tmp, bytes) {
            Ok(()) => { last_err = None; break; }
            Err(e) => {
                let code = e.raw_os_error().unwrap_or(0);
                if attempt < 5 && (code == 5 || code == 32 || code == 33) {
                    log::debug!("[vault_repair::atomic_write] tmp write retry {}/5 (os {})", attempt, code);
                    std::thread::sleep(std::time::Duration::from_millis(200));
                    last_err = Some(e);
                    continue;
                }
                return Err(format!("write tmp: {}", e));
            }
        }
    }
    if let Some(e) = last_err {
        return Err(format!("write tmp (exhausted retries): {}", e));
    }
    crate::core::file_io::rename_with_retry(&tmp, dst)
        .map_err(|e| format!("rename (with retry): {}", e))?;
    Ok(())
}

/// Same rule as `attachment_reconcile::looks_like_attachment` — accept only
/// known attachment-tier extensions (image / pdf / document / csv / video /
/// audio). Rejects `.md` (notes) and unknown extensions. Used to defensively
/// gate the apply path against sketch nodes whose `file:` points at things
/// the user never intended as attachments.
fn looks_like_attachment_basename(name: &str) -> bool {
    let ext = name.rsplit('.').next().unwrap_or("").to_lowercase();
    if ext.is_empty() || ext == "md" {
        return false;
    }
    !matches!(
        crate::features::sync_v2::attachment_types::AttachmentTier::from_extension(&ext),
        crate::features::sync_v2::attachment_types::AttachmentTier::Other
    )
}
