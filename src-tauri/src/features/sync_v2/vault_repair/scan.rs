//! vault_repair::scan — read-only inspection of a vault for 7 known
//! inconsistency patterns. Produces a `RepairReport` with per-pattern
//! finding lists. Never mutates the vault (no I/O writes, no ref changes,
//! no body rewrites). Safe to call repeatedly.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::features::sync_v2::attachment_store::AttachmentStore;
use crate::features::sync_v2::attachment_reconcile;
use crate::features::sync_v2::sketch_scan;
use crate::core::note_id::read_id_from_content;

/// One inconsistency entry. Multiple findings of the same kind can refer
/// to different files/notes — they aggregate into `RepairReport`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepairFinding {
    pub kind: FindingKind,
    /// Path that's the focus of the finding. For P1 = the `_att/` folder.
    /// For P2/P3/P4/P5 = the .md file containing the bad reference.
    /// For P6 = the AttachmentRef's id (logical, not a path). For P7 =
    /// the orphan blob path. Always vault-relative (forward slashes).
    pub target: String,
    /// Optional secondary detail (filename, sha, etc.). Free-form to
    /// avoid coupling the report shape to the fixer.
    #[serde(default)]
    pub detail: Option<String>,
    /// Whether the auto-fix can resolve this finding without human input.
    /// `false` means the report surfaces it but apply() will skip.
    pub auto_fixable: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum FindingKind {
    /// P1 — `<note>_att/` folder still on disk (sync_v1 leftover).
    LegacyAttFolder,
    /// P2 — sketch node `file:` is an OS-external absolute path.
    SketchExternalPath,
    /// P3 — sketch node `file:` inside vault but no AttachmentRef.
    SketchUnresolvedRef,
    /// P4 — wikilink chip without ref, single candidate file exists.
    WikilinkResolvable,
    /// P5 — wikilink chip without ref, no file in vault.
    WikilinkBroken,
    /// P6 — AttachmentRef.linked_notes.len() ≥ 2 (B-model violation).
    SharedRef,
    /// P7 — CAS blob with no ref pointing at it.
    OrphanBlob,
    /// P9 (2026-05-24) — Obsidian shared-attachments folder (`attachments/`,
    /// `_attachments/`, etc.) contains files referenced by `[[file.ext]]`
    /// wikilinks. Detected by: vault has top-level folder matching common
    /// Obsidian conventions AND no `.notology/` (never been a Notology
    /// vault before).
    ObsidianAttachmentsFolder,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatternCount {
    pub legacy_att_folder: usize,
    pub sketch_external_path: usize,
    pub sketch_unresolved_ref: usize,
    pub wikilink_resolvable: usize,
    pub wikilink_broken: usize,
    pub shared_ref: usize,
    pub orphan_blob: usize,
    /// P9 (2026-05-24) — Obsidian shared-attachments folder files
    /// that need ingestion as Notology AttachmentRefs.
    #[serde(default)]
    pub obsidian_attachments: usize,
}

impl PatternCount {
    pub fn total(&self) -> usize {
        self.legacy_att_folder
            + self.sketch_external_path
            + self.sketch_unresolved_ref
            + self.wikilink_resolvable
            + self.wikilink_broken
            + self.shared_ref
            + self.orphan_blob
            + self.obsidian_attachments
    }

    pub fn auto_fixable_total(&self) -> usize {
        // P5 (broken) reports only — never auto-fixed.
        self.total() - self.wikilink_broken
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepairReport {
    pub counts: PatternCount,
    /// Findings, limited to a sane sample size per pattern (default 200)
    /// so the report stays bounded for huge vaults. The full count is
    /// in `counts` regardless.
    pub findings: Vec<RepairFinding>,
    /// Vault root as scanned (absolute, normalised).
    pub vault_root: String,
    /// True if any auto-fixable pattern was found.
    pub repair_recommended: bool,
}

// 2026-05-24 (HanBin) — chaos test caught this as CRITICAL data-loss
// bug. Original 200-cap was intended to bound the report's JSON size
// for UI transport, but `apply` iterates the SAME findings array
// → cap meant apply silently processed only first 200 of N findings.
// For HanBin's 44 GB vault with 1000s of attachments, this would have
// lost 80%+ of data on first migration.
//
// Fix: effectively unlimited (100k). At ~200 bytes per finding,
// 100k findings = 20 MB JSON. Large but transportable, and the cap
// is now defensive (catastrophic vault), not the UX limit it was
// supposed to be. UI can paginate if it cares about display.
const MAX_FINDINGS_PER_KIND: usize = 100_000;

/// Pure read-only scan. No side effects. Returns aggregated report.
pub fn scan(vault_root: &Path) -> Result<RepairReport, String> {
    let t0 = std::time::Instant::now();
    log::info!("[vault_repair::scan] START vault={:?}", vault_root);
    if !vault_root.is_dir() {
        return Err(format!("vault_root is not a directory: {:?}", vault_root));
    }

    let mut report = RepairReport {
        vault_root: vault_root.to_string_lossy().replace('\\', "/"),
        ..Default::default()
    };

    let store = AttachmentStore::new(vault_root.to_path_buf())?;
    // 2026-05-24 (HanBin) — perf: pre-build lowercase name set ONCE.
    // The old impl called `any_ref_with_name` per chip → `store.all_refs()`
    // linear scan per call. On a 1000-ref / 5000-chip vault this was 5M
    // string ops. HashSet build is O(N) once, then O(1) per lookup.
    let name_set: HashSet<String> = store
        .all_refs()
        .map(|r| r.original_name.to_lowercase())
        .collect();
    log::info!("[vault_repair::scan] pre-built name index: {} refs", name_set.len());

    // ─── Walk .md files once; collect:
    //       • note_id_to_path map  (frontmatter id → rel path)
    //       • notes with sketch-flag for sketch_scan
    //       • all wikilink chip names per note for P4/P5
    let mut note_id_to_path: HashMap<String, String> = HashMap::new();
    let mut note_paths_abs: Vec<PathBuf> = Vec::new();
    walk_md(vault_root, &mut note_paths_abs);

    let mut sketch_notes: Vec<(PathBuf, String)> = Vec::new(); // (path, content)
    let mut note_chip_map: HashMap<PathBuf, HashSet<String>> = HashMap::new();
    let wiki_re = wikilink_re();

    for nf in &note_paths_abs {
        let content = match std::fs::read_to_string(nf) {
            Ok(c) => c,
            Err(_) => continue,
        };
        let nid = read_id_from_content(&content).unwrap_or_else(|| {
            nf.file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_string()
        });
        if !nid.is_empty() {
            if let Ok(rel) = nf.strip_prefix(vault_root) {
                note_id_to_path
                    .insert(nid.to_lowercase(), rel.to_string_lossy().replace('\\', "/"));
            }
        }
        // sketch?
        if is_sketch_note(&content) {
            sketch_notes.push((nf.clone(), content.clone()));
        }
        // wikilink chips (filter to attachment-shaped; skip code blocks)
        let scrubbed = strip_non_link_regions(&content);
        let mut chips: HashSet<String> = HashSet::new();
        for cap in wiki_re.captures_iter(&scrubbed) {
            if cap.name("bang").is_some() {
                continue;
            }
            let inner = cap.name("inner").map(|m| m.as_str()).unwrap_or("");
            let target = inner.split('|').next().unwrap_or("").trim();
            if target.is_empty() {
                continue;
            }
            if looks_like_attachment(target) {
                chips.insert(target.to_string());
            }
        }
        if !chips.is_empty() {
            note_chip_map.insert(nf.clone(), chips);
        }
    }

    // ── P1: legacy <note>_att/ folders
    let t = std::time::Instant::now();
    detect_p1_legacy_att(vault_root, &mut report);
    log::info!("[vault_repair::scan] P1: {} ({:?})", report.counts.legacy_att_folder, t.elapsed());

    // ── P2 + P3: sketch nodes
    let t = std::time::Instant::now();
    for (path, content) in &sketch_notes {
        detect_p2_p3_sketch(vault_root, path, content, &name_set, &mut report);
    }
    log::info!(
        "[vault_repair::scan] P2+P3: ext={} unref={} ({:?})",
        report.counts.sketch_external_path,
        report.counts.sketch_unresolved_ref,
        t.elapsed()
    );

    // ── P4 + P5: wikilink chips without ref
    let t = std::time::Instant::now();
    detect_p4_p5_wikilinks(vault_root, &note_chip_map, &name_set, &mut report);
    log::info!(
        "[vault_repair::scan] P4+P5: resolvable={} broken={} ({:?})",
        report.counts.wikilink_resolvable,
        report.counts.wikilink_broken,
        t.elapsed()
    );

    // ── P6: refs with linked_notes.len() >= 2
    let t = std::time::Instant::now();
    detect_p6_shared_refs(&store, &mut report);
    log::info!("[vault_repair::scan] P6: {} ({:?})", report.counts.shared_ref, t.elapsed());

    // ── P7: orphan blobs
    let t = std::time::Instant::now();
    detect_p7_orphan_blobs(vault_root, &store, &mut report);
    log::info!("[vault_repair::scan] P7: {} ({:?})", report.counts.orphan_blob, t.elapsed());

    // ── P9: Obsidian shared-attachments folder files (2026-05-24, HanBin).
    // Only meaningful for "Obsidian-flavored" vaults — detected as
    // having a known shared-attachments folder AND not already a Notology
    // vault (no `.notology/` dir, no `_att/` folders).
    let t = std::time::Instant::now();
    detect_p9_obsidian_attachments(vault_root, &name_set, &mut report);
    log::info!("[vault_repair::scan] P9: {} ({:?})", report.counts.obsidian_attachments, t.elapsed());

    report.repair_recommended = report.counts.auto_fixable_total() > 0;
    log::info!("[vault_repair::scan] DONE in {:?} total={}", t0.elapsed(), report.counts.total());
    Ok(report)
}

// ─── P1 ───────────────────────────────────────────────────────────────

fn detect_p1_legacy_att(vault_root: &Path, report: &mut RepairReport) {
    let mut stack = vec![vault_root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        // Root-tolerant: don't skip the vault root itself even if its
        // name starts with '.' (e.g. tempdir, hidden user folder).
        // HanBin 2026-05-24 — caught by integration test.
        if dir != vault_root {
            if let Some(name) = dir.file_name().and_then(|s| s.to_str()) {
                if name.starts_with('.') {
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
            if !p.is_dir() {
                continue;
            }
            let n = p.file_name().and_then(|s| s.to_str()).unwrap_or("");
            if n.starts_with('.') {
                continue;
            }
            if n.ends_with("_att") {
                report.counts.legacy_att_folder += 1;
                push_finding(
                    &mut report.findings,
                    FindingKind::LegacyAttFolder,
                    &rel(vault_root, &p),
                    Some(n.to_string()),
                    true,
                );
            } else {
                stack.push(p);
            }
        }
    }
}

// ─── P2 + P3 ──────────────────────────────────────────────────────────

fn detect_p2_p3_sketch(
    vault_root: &Path,
    note_path: &Path,
    content: &str,
    name_set: &HashSet<String>,
    report: &mut RepairReport,
) {
    let refs = sketch_scan::scan_sketch_refs(content);
    if refs.is_empty() {
        return;
    }
    let vault_str = vault_root.to_string_lossy().replace('\\', "/").to_lowercase();
    let note_rel = rel(vault_root, note_path);

    for sketch_ref in refs {
        let is_absolute = std::path::Path::new(&sketch_ref).is_absolute();
        let normalised = sketch_ref.replace('\\', "/").to_lowercase();
        let basename = std::path::Path::new(&sketch_ref)
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or(&sketch_ref)
            .to_string();

        // 2026-05-24 (HanBin) — Bug 1 fix. The user observed
        // `ddddd.md` appearing as an attachment node in the graph
        // because the sketch had a `type: file` node pointing at
        // ddddd.md (likely from drag-in of a .md file onto the
        // canvas — currently no UI prevention). Skip anything that
        // isn't an actual attachment extension; .md files are notes,
        // not attachments, and creating an AttachmentRef for them
        // pollutes the store + graph.
        if !looks_like_attachment(&basename) {
            continue;
        }

        if is_absolute && !normalised.starts_with(&vault_str) {
            report.counts.sketch_external_path += 1;
            push_finding(
                &mut report.findings,
                FindingKind::SketchExternalPath,
                &note_rel,
                Some(sketch_ref.clone()),
                true,
            );
            continue;
        }

        // P3 check: O(1) lookup against pre-built name set.
        if !name_set.contains(&basename.to_lowercase()) {
            report.counts.sketch_unresolved_ref += 1;
            push_finding(
                &mut report.findings,
                FindingKind::SketchUnresolvedRef,
                &note_rel,
                Some(basename),
                true,
            );
        }
    }
}

// ─── P4 + P5 ──────────────────────────────────────────────────────────

fn detect_p4_p5_wikilinks(
    vault_root: &Path,
    note_chip_map: &HashMap<PathBuf, HashSet<String>>,
    name_set: &HashSet<String>,
    report: &mut RepairReport,
) {
    // Build a basename → [abs paths] index of the vault once. Used to
    // distinguish P4 (single candidate, auto-fixable) vs ambiguous.
    let mut file_index: HashMap<String, Vec<PathBuf>> = HashMap::new();
    index_vault_files(vault_root, &mut file_index);

    for (note_path, chips) in note_chip_map {
        let note_rel = rel(vault_root, note_path);
        for chip in chips {
            // O(1) lookup against pre-built name set (was O(N) per chip).
            if name_set.contains(&chip.to_lowercase()) {
                continue; // ref exists, not a finding
            }
            let key = chip.to_lowercase();
            let candidates = file_index.get(&key).cloned().unwrap_or_default();
            if candidates.is_empty() {
                report.counts.wikilink_broken += 1;
                push_finding(
                    &mut report.findings,
                    FindingKind::WikilinkBroken,
                    &note_rel,
                    Some(chip.clone()),
                    false,
                );
            } else if candidates.len() == 1 {
                report.counts.wikilink_resolvable += 1;
                push_finding(
                    &mut report.findings,
                    FindingKind::WikilinkResolvable,
                    &note_rel,
                    Some(chip.clone()),
                    true,
                );
            } else {
                // Ambiguous — surface as a separate "report-only" sub-case
                // of P4 by marking auto_fixable=false. We could carve out a
                // dedicated kind later if the UI needs to distinguish.
                report.counts.wikilink_resolvable += 1;
                push_finding(
                    &mut report.findings,
                    FindingKind::WikilinkResolvable,
                    &note_rel,
                    Some(format!("{} (ambiguous: {} candidates)", chip, candidates.len())),
                    false,
                );
            }
        }
    }
}

// ─── P6 ───────────────────────────────────────────────────────────────

fn detect_p6_shared_refs(store: &AttachmentStore, report: &mut RepairReport) {
    for r in store.all_refs() {
        if r.linked_notes.len() >= 2 {
            report.counts.shared_ref += 1;
            push_finding(
                &mut report.findings,
                FindingKind::SharedRef,
                &r.attachment_id,
                Some(format!(
                    "{} ({} notes)",
                    r.original_name,
                    r.linked_notes.len()
                )),
                true,
            );
        }
    }
}

// ─── P7 ───────────────────────────────────────────────────────────────

fn detect_p7_orphan_blobs(vault_root: &Path, store: &AttachmentStore, report: &mut RepairReport) {
    let blobs_dir = vault_root.join(".notology/cas/blobs");
    if !blobs_dir.is_dir() {
        return;
    }
    let referenced: HashSet<String> = store
        .all_refs()
        .map(|r| r.sha256.clone())
        .collect();

    // Walk blobs dir 2-level deep (sha[0..2] / sha[2..4] / sha).
    let l1 = match std::fs::read_dir(&blobs_dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for l1e in l1.flatten() {
        let l2_dir = l1e.path();
        if !l2_dir.is_dir() {
            continue;
        }
        let l2 = match std::fs::read_dir(&l2_dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for l2e in l2.flatten() {
            let l3_dir = l2e.path();
            if !l3_dir.is_dir() {
                continue;
            }
            let l3 = match std::fs::read_dir(&l3_dir) {
                Ok(e) => e,
                Err(_) => continue,
            };
            for l3e in l3.flatten() {
                let blob_path = l3e.path();
                if !blob_path.is_file() {
                    continue;
                }
                let sha = blob_path
                    .file_name()
                    .and_then(|s| s.to_str())
                    .unwrap_or("")
                    .to_string();
                if sha.is_empty() {
                    continue;
                }
                if !referenced.contains(&sha) {
                    report.counts.orphan_blob += 1;
                    push_finding(
                        &mut report.findings,
                        FindingKind::OrphanBlob,
                        &rel(vault_root, &blob_path),
                        Some(sha),
                        true,
                    );
                }
            }
        }
    }
}

// ─── P9 ───────────────────────────────────────────────────────────────

/// Detect files inside well-known Obsidian shared-attachments folders
/// (anywhere in the vault tree, not just at the root). The migration
/// target is: each such file becomes a Notology AttachmentRef linked
/// to whichever note(s) reference it via `[[file.ext]]` wikilinks.
/// Files NOT referenced by any note's body are reported as
/// auto_fixable=false so the user can review.
///
/// Known Obsidian-flavored attachment folder names:
///   - `attachments`, `_attachments`
///   - `assets`, `_assets`
///   - `files`
///
/// 2026-05-24 (HanBin) — walk EVERY level. The HanBin vault uses
/// per-folder `attachments/` (e.g. `01_Tasks/X/attachments/`); the
/// root-only check missed hundreds of real attachments. T1 end-to-end
/// validation caught this.
fn detect_p9_obsidian_attachments(
    vault_root: &Path,
    name_set: &HashSet<String>,
    report: &mut RepairReport,
) {
    const ATTACHMENT_FOLDER_NAMES: &[&str] = &[
        "attachments", "_attachments", "assets", "_assets", "files",
    ];
    let is_attachment_folder = |name: &str| -> bool {
        let lower = name.to_lowercase();
        ATTACHMENT_FOLDER_NAMES.iter().any(|n| *n == lower)
    };

    // Walk the entire vault, looking for folders matching a known
    // attachment-convention name. For each match, recurse INSIDE it
    // and treat every file as a P9 candidate.
    let mut stack = vec![vault_root.to_path_buf()];
    // 2026-05-24 (HanBin) — symlink loop protection.
    let mut visited: std::collections::HashSet<PathBuf> = std::collections::HashSet::new();
    while let Some(dir) = stack.pop() {
        if dir != vault_root {
            if let Some(name) = dir.file_name().and_then(|s| s.to_str()) {
                if name.starts_with('.') || name.ends_with("_att") {
                    continue;
                }
            }
        }
        if let Ok(canonical) = dir.canonicalize() {
            if !visited.insert(canonical) {
                continue;
            }
        }
        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let p = entry.path();
            // 2026-05-24 — skip symlinks (both dirs and files) to
            // prevent loop attacks + accidental scope escape.
            if crate::core::file_io::is_symlink(&p) {
                continue;
            }
            if !p.is_dir() {
                continue;
            }
            let n = p.file_name().and_then(|s| s.to_str()).unwrap_or("");
            if n.starts_with('.') || n.ends_with("_att") {
                continue;
            }
            if is_attachment_folder(n) {
                drain_attachment_folder(vault_root, &p, name_set, report);
            } else {
                stack.push(p);
            }
        }
    }
}

/// Helper for P9 — walk an attachment folder recursively and emit a
/// finding per real attachment file.
fn drain_attachment_folder(
    vault_root: &Path,
    folder: &Path,
    name_set: &HashSet<String>,
    report: &mut RepairReport,
) {
    let mut stack = vec![folder.to_path_buf()];
    while let Some(d) = stack.pop() {
        let entries = match std::fs::read_dir(&d) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let p = entry.path();
            // 2026-05-24 (HanBin) — symlink skip in P9 ingestion.
            // Following symlinks here would let an attacker inject
            // arbitrary files into the import (a symlink from
            // attachments/secret.pdf → /etc/passwd would be slurped
            // into CAS). Always skip — Notology attachment files
            // should be REAL files inside the vault, not pointers.
            if crate::core::file_io::is_symlink(&p) {
                continue;
            }
            if p.is_dir() {
                stack.push(p);
                continue;
            }
            let basename = match p.file_name().and_then(|s| s.to_str()) {
                Some(b) => b.to_string(),
                None => continue,
            };
            if basename.starts_with('.') {
                continue;
            }
            if name_set.contains(&basename.to_lowercase()) {
                continue;
            }
            if !looks_like_attachment(&basename) {
                continue;
            }
            report.counts.obsidian_attachments += 1;
            push_finding(
                &mut report.findings,
                FindingKind::ObsidianAttachmentsFolder,
                &rel(vault_root, &p),
                Some(basename),
                true,
            );
        }
    }
}

// ─── helpers ──────────────────────────────────────────────────────────

fn push_finding(
    findings: &mut Vec<RepairFinding>,
    kind: FindingKind,
    target: &str,
    detail: Option<String>,
    auto_fixable: bool,
) {
    let same_kind_count = findings.iter().filter(|f| f.kind == kind).count();
    if same_kind_count >= MAX_FINDINGS_PER_KIND {
        return;
    }
    findings.push(RepairFinding {
        kind,
        target: target.to_string(),
        detail,
        auto_fixable,
    });
}

fn rel(vault_root: &Path, p: &Path) -> String {
    p.strip_prefix(vault_root)
        .map(|r| r.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| p.to_string_lossy().to_string())
}

fn walk_md(root: &Path, out: &mut Vec<PathBuf>) {
    let mut stack = vec![root.to_path_buf()];
    // 2026-05-24 (HanBin) — symlink loop protection.
    let mut visited: std::collections::HashSet<PathBuf> = std::collections::HashSet::new();
    while let Some(dir) = stack.pop() {
        if dir != root {
            if let Some(name) = dir.file_name().and_then(|s| s.to_str()) {
                if name.starts_with('.') || name.ends_with("_att") {
                    continue;
                }
            }
        }
        // Symlink loop detection.
        if let Ok(canonical) = dir.canonicalize() {
            if !visited.insert(canonical) {
                continue;
            }
        }
        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let p = entry.path();
            if crate::core::file_io::is_symlink(&p) {
                continue;
            }
            if p.is_dir() {
                stack.push(p);
            } else if p.extension().and_then(|s| s.to_str()) == Some("md") {
                out.push(p);
            }
        }
    }
}

fn index_vault_files(vault_root: &Path, out: &mut HashMap<String, Vec<PathBuf>>) {
    let mut stack = vec![vault_root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        // Root-tolerant hidden check.
        if dir != vault_root {
            if let Some(name) = dir.file_name().and_then(|s| s.to_str()) {
                if name.starts_with('.') {
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

fn is_sketch_note(content: &str) -> bool {
    // Match the keys the frontend treats as sketch identifiers.
    // (useContentLoader.ts: `(fm as any)?.sketch || (fm as any)?.canvas`)
    let fm_end = match content.find("\n---") {
        Some(i) if content.starts_with("---") => i,
        _ => return false,
    };
    let fm = &content[3..fm_end];
    for line in fm.lines() {
        let t = line.trim();
        let rest = if let Some(r) = t.strip_prefix("canvas:") {
            r
        } else if let Some(r) = t.strip_prefix("sketch:") {
            r
        } else {
            continue;
        };
        let v = rest.trim();
        if v == "true" || v == "True" || v == "TRUE" || v == "yes" {
            return true;
        }
    }
    false
}

fn wikilink_re() -> regex::Regex {
    // Same shape as attachment_reconcile::wikilink_regex.
    regex::Regex::new(
        r"(?P<bang>!)?\[\[(?P<inner>[^\]\[]+)\]\]",
    )
    .expect("wikilink regex must compile")
}

fn strip_non_link_regions(content: &str) -> String {
    // Replace fenced code blocks + inline code with spaces so wikilinks
    // inside example text don't count.
    let mut out = String::with_capacity(content.len());
    let mut in_fence = false;
    for line in content.split_inclusive('\n') {
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") {
            in_fence = !in_fence;
            for _ in 0..line.len() {
                out.push(' ');
            }
            continue;
        }
        if in_fence {
            for _ in 0..line.len() {
                out.push(' ');
            }
            continue;
        }
        // inline code: ` ... `
        let bytes = line.as_bytes();
        let mut i = 0;
        let mut in_inline = false;
        while i < bytes.len() {
            if bytes[i] == b'`' {
                in_inline = !in_inline;
                out.push(' ');
                i += 1;
                continue;
            }
            if in_inline {
                out.push(' ');
            } else {
                out.push(bytes[i] as char);
            }
            i += 1;
        }
    }
    out
}

fn looks_like_attachment(name: &str) -> bool {
    // Mirror attachment_reconcile::looks_like_attachment.
    let ext = name.rsplit('.').next().unwrap_or("").to_lowercase();
    if ext.is_empty() || ext == "md" {
        return false;
    }
    !matches!(
        crate::features::sync_v2::attachment_types::AttachmentTier::from_extension(&ext),
        crate::features::sync_v2::attachment_types::AttachmentTier::Other
    )
}

// silence unused import warning until apply layer wires it in
#[allow(dead_code)]
fn _ref_reconcile_silencer(_: &attachment_reconcile::ReconcileReport) {}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn empty_vault_scan_has_zero_findings() {
        let tmp = TempDir::new().unwrap();
        std::fs::create_dir_all(tmp.path().join(".notology")).unwrap();
        let r = scan(tmp.path()).unwrap();
        assert_eq!(r.counts.total(), 0);
        assert!(!r.repair_recommended);
    }

    #[test]
    fn p1_legacy_att_folder_detected() {
        let tmp = TempDir::new().unwrap();
        std::fs::create_dir_all(tmp.path().join("Note1_att")).unwrap();
        std::fs::write(tmp.path().join("Note1_att/x.pdf"), b"x").unwrap();
        std::fs::create_dir_all(tmp.path().join(".notology")).unwrap();
        let r = scan(tmp.path()).unwrap();
        assert_eq!(r.counts.legacy_att_folder, 1);
        assert!(r.repair_recommended);
    }

    #[test]
    fn p6_shared_ref_detected() {
        let tmp = TempDir::new().unwrap();
        let mut store = AttachmentStore::new(tmp.path().to_path_buf()).unwrap();
        let src = tmp.path().join("src.pdf");
        std::fs::write(&src, b"data").unwrap();
        store.add_attachment(&src, "doc.pdf", "noteA").unwrap();
        // Force a shared ref the legacy way (link_to_note).
        let ids: Vec<String> = store.all_refs().map(|r| r.attachment_id.clone()).collect();
        store.link_to_note(&ids[0], "noteB").unwrap();
        drop(store);

        let r = scan(tmp.path()).unwrap();
        assert_eq!(r.counts.shared_ref, 1, "{:?}", r.findings);
        assert!(r.repair_recommended);
    }

    #[test]
    fn p7_orphan_blob_detected() {
        let tmp = TempDir::new().unwrap();
        std::fs::create_dir_all(tmp.path().join(".notology/cas/blobs/aa/bb")).unwrap();
        std::fs::write(tmp.path().join(".notology/cas/blobs/aa/bb/aabbcc"), b"orphan").unwrap();
        let r = scan(tmp.path()).unwrap();
        assert_eq!(r.counts.orphan_blob, 1, "{:?}", r.findings);
    }
}
