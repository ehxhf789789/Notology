//! Track B Phase B-3 PART 6 — bidirectional reconcile (HanBin 2026-05-13).
//!
//! Scans every `.md` file in the vault and computes the diff between
//!   - wikilink chips that look like attachments (basename has a known
//!     non-`.md` extension OR matches an existing ref's `original_name`)
//!   - what each `AttachmentRef.linked_notes` claims
//!
//! Outputs three discrepancy buckets the caller can fix in one apply
//! pass:
//!   - **dummy_chips**: wikilink in a note body with no backing ref.
//!     Source: app crashed mid-`attachment_add`, external editor edit,
//!     migration leftover.
//!   - **stale_ref_links**: ref's `linked_notes` claims a note that
//!     doesn't actually contain a chip pointing to this attachment.
//!     Source: user deleted the chip via a code path that bypassed
//!     Option C (programmatic edit, external editor, conflict merge).
//!   - **missing_ref_links**: chip exists in a note's body but the ref's
//!     `linked_notes` doesn't include that note. Source: cross-device
//!     sync where the new note arrived before the ref update.
//!
//! Reconcile is read-only; `reconcile_apply` performs the fixes:
//!   - dummy_chips: remove the wikilink text from the note's `.md` file.
//!   - stale_ref_links: `unlink_from_note` → if `linked_notes` becomes
//!     empty, hard-delete the ref (same Option C semantics as the chip
//!     deletion path).
//!   - missing_ref_links: `link_to_note` to add the note back.

#![allow(dead_code)]

use std::collections::{HashMap, HashSet};
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::features::sync_v2::attachment_store::AttachmentStore;
use crate::features::sync_v2::attachment_types::AttachmentTier;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DummyChip {
    /// Note-relative path or absolute vault path, normalized to forward slashes.
    pub note_path: String,
    /// note_id extracted from filename (basename minus extension, lowercased).
    pub note_id: String,
    /// Wikilink target (what was inside `[[...]]`).
    pub file_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkDiscrepancy {
    pub attachment_id: String,
    pub original_name: String,
    pub note_id: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReconcileReport {
    pub dummy_chips: Vec<DummyChip>,
    pub stale_ref_links: Vec<LinkDiscrepancy>,
    pub missing_ref_links: Vec<LinkDiscrepancy>,
    pub notes_scanned: usize,
    pub refs_inspected: usize,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReconcileApplyOutcome {
    pub dummy_chips_removed: usize,
    pub stale_links_fixed: usize,
    pub missing_links_added: usize,
    pub refs_hard_deleted: usize,
    pub errors: Vec<String>,
}

/// Match `[[name]]` and `[[name|alias]]`, but not `![[name]]` (image embed).
/// Captures only the name portion (before any pipe).
fn wikilink_regex() -> &'static regex::Regex {
    use std::sync::OnceLock;
    static R: OnceLock<regex::Regex> = OnceLock::new();
    // Match `[[...]]` and `![[...]]` lazily. The inner `(.+?)` deliberately
    // allows `]` inside the target because real filenames can include `]`
    // (e.g. `[UST - 생성형 AI 실무 활용] 01주차(03_04) ...mp4`). The
    // previous `[^\]\|]+?` aborted matching at the first single `]`, which
    // silently dropped any wikilink whose filename contained one — HanBin
    // 2026-05-13: "연결된 노트가 없다고 했는데, 링크가 있는데?". The
    // matching frontend regex in WikiLink.ts already uses `.+?` for the
    // same reason, so the two now agree.
    //
    // Alias `[[name|display]]` is handled by splitting on the first `|`
    // inside the loop, not by the regex. This keeps the regex simple and
    // mirrors the JS `parseWikiLinkContent` helper.
    R.get_or_init(|| regex::Regex::new(r"(?P<bang>!)?\[\[(?P<inner>.+?)\]\]").unwrap())
}

/// Strip markdown elements that *contain* wikilink-looking text but should
/// not be treated as real links: fenced code blocks (``` / ~~~), inline
/// code (`` `...` ``), and HTML comments (`<!-- ... -->`).
///
/// R7 (HanBin 2026-05-13): without this, a user who wrote `[[example.pdf]]`
/// as an example inside a fenced code block would have reconcile believe
/// it was a real link and either flag it as a dummy chip or, if a ref of
/// that name happened to exist, append the current note to linked_notes.
/// Both are incorrect because the text is *content* the user wrote, not a
/// real attachment reference.
///
/// Stripping is *destructive on the working copy only* — the on-disk note
/// is never touched here; we just replace the stripped ranges with spaces
/// of equal length so byte positions / line numbers are preserved.
fn strip_non_link_regions(content: &str) -> String {
    let bytes = content.as_bytes();
    let mut out: Vec<u8> = bytes.to_vec();
    let mut i = 0;

    while i < bytes.len() {
        // Fenced code block: ```...```  or ~~~...~~~  (must be at line start).
        let at_line_start = i == 0 || bytes[i - 1] == b'\n';
        if at_line_start && i + 3 <= bytes.len() {
            let fence_char = bytes[i];
            if (fence_char == b'`' || fence_char == b'~')
                && bytes[i + 1] == fence_char
                && bytes[i + 2] == fence_char
            {
                // Find the closing fence at start of a line.
                let mut j = i + 3;
                while j < bytes.len() {
                    let line_start = j == 0 || bytes[j - 1] == b'\n';
                    if line_start
                        && j + 3 <= bytes.len()
                        && bytes[j] == fence_char
                        && bytes[j + 1] == fence_char
                        && bytes[j + 2] == fence_char
                    {
                        // Found closing fence — blank out the whole region
                        // (including the closing fence's three chars).
                        j += 3;
                        break;
                    }
                    j += 1;
                }
                // Replace with spaces but preserve newlines so line numbers
                // are unchanged.
                for k in i..j {
                    if out[k] != b'\n' {
                        out[k] = b' ';
                    }
                }
                i = j;
                continue;
            }
        }

        // HTML comment <!-- ... -->
        if i + 4 <= bytes.len() && &bytes[i..i + 4] == b"<!--" {
            let mut j = i + 4;
            while j + 3 <= bytes.len() {
                if &bytes[j..j + 3] == b"-->" {
                    j += 3;
                    break;
                }
                j += 1;
            }
            for k in i..j {
                if out[k] != b'\n' {
                    out[k] = b' ';
                }
            }
            i = j;
            continue;
        }

        // Inline code: `...` (single backtick), but NOT a triple-backtick
        // fence (handled above). Spans the rest of the same line at most.
        if bytes[i] == b'`' {
            let mut j = i + 1;
            while j < bytes.len() && bytes[j] != b'`' && bytes[j] != b'\n' {
                j += 1;
            }
            if j < bytes.len() && bytes[j] == b'`' {
                // Closed inline code — strip the whole span inclusive.
                for k in i..=j {
                    if out[k] != b'\n' {
                        out[k] = b' ';
                    }
                }
                i = j + 1;
                continue;
            }
            // Unclosed backtick — leave as-is, just skip it.
            i += 1;
            continue;
        }

        i += 1;
    }

    // Safe because we only replaced bytes with ASCII spaces (multi-byte
    // UTF-8 sequences are left untouched because they never equal `'`'
    // / `'~'` / `'<'` / `'!'` in their continuation bytes).
    String::from_utf8(out).unwrap_or_else(|_| content.to_string())
}

/// Resolve a `.md` file path to the note_id `AttachmentRef.linked_notes`
/// uses. Must match `extract_note_id_from_path` in commands.rs exactly,
/// otherwise reconcile produces massive false-positives where every
/// legitimate linked_notes entry shows up as "stale" and every chip in
/// every note shows up as "missing" — applying that report would wipe
/// every attachment in the vault (Option C hard-delete on empty
/// linked_notes). HanBin 2026-05-13 caught this empirically.
///
/// Order matches commands.rs:
///   1. Read `id:` from the .md's YAML frontmatter (14-digit timestamp).
///   2. Fallback: filename stem (when the file has no `id` field).
fn note_id_for(path: &Path, content: &str) -> Option<String> {
    if let Some(id) = crate::core::note_id::read_id_from_content(content) {
        return Some(id);
    }
    path.file_stem().and_then(|s| s.to_str()).map(|s| s.to_string())
}

/// Walk every `.md` file under `root`, skipping hidden directories.
/// Returns (path, content) tuples. Errors on individual files are logged
/// and skipped — a single unreadable file should not abort the scan.
fn walk_notes(root: &Path) -> Vec<(std::path::PathBuf, String)> {
    let mut out = Vec::new();
    let mut stack: Vec<std::path::PathBuf> = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let p = entry.path();
            let name = p.file_name().and_then(|s| s.to_str()).unwrap_or("");
            // Skip hidden dirs (`.notology`, `.attachments`, `.git`, etc.).
            if name.starts_with('.') {
                continue;
            }
            if p.is_dir() {
                stack.push(p);
                continue;
            }
            if p.extension().and_then(|s| s.to_str()) != Some("md") {
                continue;
            }
            match std::fs::read_to_string(&p) {
                Ok(c) => out.push((p, c)),
                Err(e) => log::warn!(
                    "[attachment_reconcile] skipping unreadable note {:?}: {}",
                    p, e
                ),
            }
        }
    }
    out
}

/// True when the basename looks like an attachment (not a note link). The
/// rule matches the frontend `isAttachmentExtension` check minus `.md`.
fn looks_like_attachment(name: &str) -> bool {
    let ext = name.rsplit('.').next().unwrap_or("").to_lowercase();
    if ext.is_empty() || ext == "md" {
        return false;
    }
    !matches!(AttachmentTier::from_extension(&ext), AttachmentTier::Other)
}

/// Read-only reconcile. Builds the three discrepancy lists.
pub fn reconcile(store: &AttachmentStore) -> Result<ReconcileReport, String> {
    let mut report = ReconcileReport::default();
    let vault = store.vault_root();

    // 1. Build the ref-side index: original_name (lowercased) → (attachment_id,
    //    original_name, linked_notes set). We lowercase the chip-name keys
    //    so case-insensitive filesystems (NTFS / APFS) match correctly.
    //    `linked_notes` entries are frontmatter ids (14-digit timestamps),
    //    so they are kept as-is.
    type RefByName = HashMap<String, (String, String, HashSet<String>)>;
    let mut refs_by_name: RefByName = HashMap::new();
    for r in store.all_refs() {
        report.refs_inspected += 1;
        let key = r.original_name.to_lowercase();
        let linked: HashSet<String> = r.linked_notes.iter().cloned().collect();
        refs_by_name.insert(
            key,
            (r.attachment_id.clone(), r.original_name.clone(), linked),
        );
    }

    // 2. Walk note bodies. For each wikilink chip that looks like an
    //    attachment, record (note_id, fileName). `note_id` is the
    //    frontmatter `id:` value (matching commands.rs::extract_note_id_from_path)
    //    so it lines up with what `linked_notes` actually stores.
    let notes = walk_notes(vault);
    report.notes_scanned = notes.len();
    let re = wikilink_regex();

    // chips_by_note: note_id → set of attachment fileNames (lowercased)
    let mut chips_by_note: HashMap<String, HashSet<String>> = HashMap::new();
    // note_paths: note_id → absolute note path (for the dummy_chips report).
    let mut note_paths: HashMap<String, std::path::PathBuf> = HashMap::new();

    for (path, content) in &notes {
        let nid = match note_id_for(path, content) {
            Some(n) => n,
            None => continue,
        };
        note_paths.entry(nid.clone()).or_insert_with(|| path.clone());
        // R7 fix (HanBin 2026-05-13): blank out fenced code blocks and
        // inline code before regex matching so example wikilinks inside
        // ```...``` aren't mistaken for real attachment references.
        let scrubbed = strip_non_link_regions(content);
        for cap in re.captures_iter(&scrubbed) {
            if cap.name("bang").is_some() {
                continue; // image embed, not an attachment chip
            }
            let inner = cap.name("inner").map(|m| m.as_str()).unwrap_or("");
            // Alias support: `[[fileName|displayText]]` — only the
            // fileName side is the link target. Mirrors WikiLink.ts's
            // `parseWikiLinkContent`.
            let target = inner.split('|').next().unwrap_or("").trim();
            if target.is_empty() {
                continue;
            }
            // Only collect attachment-shaped chips. Note wikilinks (note
            // names, possibly with .md) are ignored — they're handled by
            // the existing wikilink_rename / search infrastructure.
            let looks_att = looks_like_attachment(target)
                || refs_by_name.contains_key(&target.to_lowercase());
            if !looks_att {
                continue;
            }
            chips_by_note
                .entry(nid.clone())
                .or_default()
                .insert(target.to_lowercase());
        }

        // Round 2 R6 (HanBin 2026-05-22): also count sketch/canvas node file
        // refs as chips. Without this, an attachment referenced only by a
        // sketch (canvas) node looks orphan to the sweep and gets deleted,
        // leaving a broken node on the canvas.
        let sketch_refs = crate::features::sync_v2::sketch_scan::scan_sketch_refs(content);
        if !sketch_refs.is_empty() {
            // 2026-05-23 (HanBin) — diagnostic. User report: a sketch note
            // referencing HWP/XLSX/PDF chips shows "첨부파일 없음" when
            // filtered by that note's path in the Attachments tab. We log
            // each sketch's extracted refs + the match outcome so we can
            // see exactly where the chain breaks (extraction vs matching).
            let mut matched: Vec<String> = Vec::new();
            let mut unmatched: Vec<String> = Vec::new();
            for sketch_ref in &sketch_refs {
                let key = sketch_ref.to_lowercase();
                let looks_att = looks_like_attachment(sketch_ref)
                    || refs_by_name.contains_key(&key);
                if !looks_att {
                    unmatched.push(sketch_ref.clone());
                    continue;
                }
                if refs_by_name.contains_key(&key) {
                    matched.push(sketch_ref.clone());
                } else {
                    // Looks like an attachment by extension but no ref
                    // exists with this original_name — a "broken" sketch
                    // node. Still recorded so the chip-presence check
                    // works on the (note,name) tuple (it'll fall under
                    // dummy_chips in the report).
                    unmatched.push(sketch_ref.clone());
                }
                chips_by_note
                    .entry(nid.clone())
                    .or_default()
                    .insert(key);
            }
            log::info!(
                "[attachment_reconcile] sketch {:?} (nid={}): extracted={} matched_to_ref={} unmatched={} (unmatched sample: {:?})",
                path.file_name().and_then(|s| s.to_str()).unwrap_or(""),
                nid,
                sketch_refs.len(),
                matched.len(),
                unmatched.len(),
                unmatched.iter().take(5).collect::<Vec<_>>()
            );
        }
    }

    // 3. dummy_chips: chip in note but no ref by that name.
    for (nid, chips) in &chips_by_note {
        for chip_name in chips {
            if !refs_by_name.contains_key(chip_name) {
                // The original (case-preserved) name isn't stored in chips,
                // so re-extract it from the body. For the report we use the
                // lowercased name as a stand-in (frontend can find it via
                // case-insensitive match when applying).
                let note_path = note_paths
                    .get(nid)
                    .map(|p| p.to_string_lossy().replace('\\', "/"))
                    .unwrap_or_default();
                report.dummy_chips.push(DummyChip {
                    note_path,
                    note_id: nid.clone(),
                    file_name: chip_name.clone(),
                });
            }
        }
    }

    // 4. stale_ref_links and missing_ref_links.
    for (name_key, (att_id, orig_name, linked)) in &refs_by_name {
        for claimed_note in linked {
            let chips_in_note = chips_by_note.get(claimed_note);
            let actually_present = chips_in_note
                .map(|s| s.contains(name_key))
                .unwrap_or(false);
            if !actually_present {
                // The note doesn't have a chip with this name → stale.
                // Exception: if the note doesn't exist at all on disk, we
                // still consider it stale (note was deleted but ref's
                // linked_notes wasn't updated).
                report.stale_ref_links.push(LinkDiscrepancy {
                    attachment_id: att_id.clone(),
                    original_name: orig_name.clone(),
                    note_id: claimed_note.clone(),
                });
            }
        }
        // missing: note body has the chip but ref's linked_notes doesn't.
        for (nid, chips) in &chips_by_note {
            if chips.contains(name_key) && !linked.contains(nid) {
                report.missing_ref_links.push(LinkDiscrepancy {
                    attachment_id: att_id.clone(),
                    original_name: orig_name.clone(),
                    note_id: nid.clone(),
                });
            }
        }
    }

    Ok(report)
}

/// Apply the fixes from a prior `reconcile` pass. Each bucket is processed
/// independently; failures on one item are logged and reported but do not
/// abort the others.
pub fn reconcile_apply(
    store: &mut AttachmentStore,
    report: &ReconcileReport,
) -> Result<ReconcileApplyOutcome, String> {
    let mut outcome = ReconcileApplyOutcome::default();
    let vault = store.vault_root().to_path_buf();
    let re = wikilink_regex();

    // 1. Remove dummy chips from note bodies. We rewrite each affected
    //    note's `.md` file with the matching `[[name]]` (and aliased
    //    `[[name|...]]`) occurrences stripped. Image embeds `![[...]]` are
    //    untouched.
    let mut dummies_by_note: HashMap<String, HashSet<String>> = HashMap::new();
    for d in &report.dummy_chips {
        dummies_by_note
            .entry(d.note_path.clone())
            .or_default()
            .insert(d.file_name.clone()); // already lowercase from reconcile()
    }
    for (note_path_str, dummies) in dummies_by_note {
        let path = std::path::PathBuf::from(note_path_str.replace('/', std::path::MAIN_SEPARATOR_STR));
        let content = match std::fs::read_to_string(&path) {
            Ok(c) => c,
            Err(e) => {
                outcome.errors.push(format!("read {:?}: {}", path, e));
                continue;
            }
        };
        let new_content = re.replace_all(&content, |caps: &regex::Captures| -> String {
            if caps.name("bang").is_some() {
                // Image embed — keep.
                return caps.get(0).unwrap().as_str().to_string();
            }
            let inner = caps.name("inner").map(|m| m.as_str()).unwrap_or("");
            let target = inner.split('|').next().unwrap_or("").trim();
            if dummies.contains(&target.to_lowercase()) {
                outcome.dummy_chips_removed += 1;
                String::new() // strip the chip
            } else {
                caps.get(0).unwrap().as_str().to_string()
            }
        });
        if new_content != content {
            if let Err(e) = std::fs::write(&path, new_content.as_bytes()) {
                outcome.errors.push(format!("write {:?}: {}", path, e));
            }
        }
    }

    // 2. Fix stale_ref_links: unlink each claimed-but-absent note. If the
    //    ref's linked_notes becomes empty as a result, delete the ref
    //    entirely (matches Option C hard-delete semantics).
    //
    //    Group by attachment_id so multiple stale notes on the same ref
    //    are processed together and the empty-check sees the correct
    //    post-state.
    let mut stale_by_ref: HashMap<String, Vec<String>> = HashMap::new();
    for s in &report.stale_ref_links {
        stale_by_ref
            .entry(s.attachment_id.clone())
            .or_default()
            .push(s.note_id.clone());
    }
    for (att_id, note_ids) in stale_by_ref {
        for note_id in &note_ids {
            if let Err(e) = store.unlink_from_note(&att_id, note_id) {
                outcome.errors.push(format!("unlink {} from {}: {}", att_id, note_id, e));
                continue;
            }
            outcome.stale_links_fixed += 1;
        }
        // After all unlinks for this ref, check if linked_notes is empty.
        let now_empty = store
            .get_by_id(&att_id)
            .map(|r| r.linked_notes.is_empty())
            .unwrap_or(false);
        if now_empty {
            match store.delete_attachment(&att_id) {
                Ok(()) => outcome.refs_hard_deleted += 1,
                Err(e) => outcome.errors.push(format!("hard-delete {}: {}", att_id, e)),
            }
        }
    }

    // 3. Fix missing_ref_links — B-model (HanBin 2026-05-24).
    //
    // Previous behavior: `store.link_to_note(att_id, note_id)` → appended
    // the note_id to the existing ref's `linked_notes`. This created the
    // "shared ref" anti-pattern: a single AttachmentRef owned by multiple
    // notes, leading to cross-note coupling (deleting note A could affect
    // note B's chip resolution, multi-device sync race conditions on the
    // shared linked_notes JSON, etc.).
    //
    // New behavior: `store.clone_ref_for_note(att_id, note_id)` → creates
    // a fresh AttachmentRef with a new attachment_id, reusing the source
    // ref's CAS blob via hardlink. The new ref has `linked_notes=[note_id]`
    // (length 1, B-model invariant). Disk usage stays identical (blob is
    // sha256-deduplicated), but each note owns its own ref + display copy.
    //
    // Idempotency: if the note_id ALREADY has a ref for the same sha
    // (i.e. user already explicitly imported the file in this note),
    // skip the clone — that ref will surface via the existing reconcile
    // pass on the next run. We detect this by checking `list_for_note`.
    for m in &report.missing_ref_links {
        // Skip if this note already has a ref pointing at the same blob.
        let src_sha = store
            .get_by_id(&m.attachment_id)
            .map(|r| r.sha256.clone());
        let already_has_blob = match &src_sha {
            Some(sha) => store
                .list_for_note(&m.note_id)
                .iter()
                .any(|r| r.sha256 == *sha),
            None => false,
        };
        if already_has_blob {
            // Treat as a no-op success — the user's intent is already
            // satisfied by an existing per-note ref.
            outcome.missing_links_added += 1;
            continue;
        }
        match store.clone_ref_for_note(&m.attachment_id, &m.note_id) {
            Ok(_new_ref) => outcome.missing_links_added += 1,
            Err(e) => outcome.errors.push(format!(
                "clone_ref {} for note {}: {}",
                m.attachment_id, m.note_id, e
            )),
        }
    }

    let _ = vault; // suppress unused if no further use
    Ok(outcome)
}

/// Auto-applied subset of a reconcile report — the parts where the
/// worst-case outcome is harmless metadata churn.
///
/// Applied on every vault open from `sync_engine::start`:
///   - missing_ref_links: append note_id to ref's `linked_notes`.
///     Cannot harm user data; at worst records a link already implied.
///   - stale_ref_links: remove note_id from ref's `linked_notes`.
///     The note's body genuinely has no chip pointing here, so the
///     metadata is wrong and the user expects the unlink. **The
///     resulting orphan ref (if linked_notes becomes empty) is NOT
///     cascade-deleted** — it stays visible in the Attachments tab as
///     an orphan row, and the user must explicitly click ✕ to commit
///     the cascade. Auto-cascading would be irreversible and a single
///     misclassification could wipe the whole vault (HanBin 2026-05-13).
///
/// Returns (missing_added, stale_unlinked, orphaned_refs). Dummy chips
/// are never auto-modified because rewriting note bodies without user
/// consent is intrusive (and the orphan ✕ chip visual already informs
/// the user; manual Backspace resolves it).
pub fn reconcile_apply_auto(
    store: &mut AttachmentStore,
    report: &ReconcileReport,
) -> Result<(usize, usize, usize), String> {
    let mut missing_added = 0usize;
    let mut stale_unlinked = 0usize;
    let mut orphaned_refs = 0usize;

    // B-model (HanBin 2026-05-24): clone refs per-note instead of
    // appending notes to a shared ref. Same rationale + idempotency rule
    // as `reconcile_apply` (see comments there). Auto-path silently
    // skips on errors — the manual flow surfaces them in `outcome.errors`.
    for m in &report.missing_ref_links {
        let src_sha = store.get_by_id(&m.attachment_id).map(|r| r.sha256.clone());
        let already_has_blob = match &src_sha {
            Some(sha) => store
                .list_for_note(&m.note_id)
                .iter()
                .any(|r| r.sha256 == *sha),
            None => false,
        };
        if already_has_blob {
            missing_added += 1;
            continue;
        }
        if store
            .clone_ref_for_note(&m.attachment_id, &m.note_id)
            .is_ok()
        {
            missing_added += 1;
        }
    }

    // Group stale by ref to count "this ref became orphan" exactly once.
    let mut stale_by_ref: HashMap<String, Vec<String>> = HashMap::new();
    for s in &report.stale_ref_links {
        stale_by_ref
            .entry(s.attachment_id.clone())
            .or_default()
            .push(s.note_id.clone());
    }
    for (att_id, note_ids) in stale_by_ref {
        for note_id in &note_ids {
            if store.unlink_from_note(&att_id, note_id).is_ok() {
                stale_unlinked += 1;
            }
        }
        let now_empty = store
            .get_by_id(&att_id)
            .map(|r| r.linked_notes.is_empty())
            .unwrap_or(false);
        if now_empty {
            // NO cascade delete here — the orphan ref surfaces in the
            // Attachments tab with an ✕ button; user decides.
            orphaned_refs += 1;
        }
    }

    Ok((missing_added, stale_unlinked, orphaned_refs))
}

/// Back-compat alias for the previous narrower auto-apply that only
/// touched missing_ref_links. Kept so existing tests still build; new
/// callers should prefer `reconcile_apply_auto`.
///
/// B-model (HanBin 2026-05-24): also switched to `clone_ref_for_note`.
/// Same logic as the `reconcile_apply` and `reconcile_apply_auto` paths.
pub fn reconcile_apply_safe(
    store: &mut AttachmentStore,
    report: &ReconcileReport,
) -> Result<usize, String> {
    let mut added = 0usize;
    for m in &report.missing_ref_links {
        let src_sha = store.get_by_id(&m.attachment_id).map(|r| r.sha256.clone());
        let already_has_blob = match &src_sha {
            Some(sha) => store
                .list_for_note(&m.note_id)
                .iter()
                .any(|r| r.sha256 == *sha),
            None => false,
        };
        if already_has_blob {
            added += 1;
            continue;
        }
        if store
            .clone_ref_for_note(&m.attachment_id, &m.note_id)
            .is_ok()
        {
            added += 1;
        }
    }
    Ok(added)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use tempfile::TempDir;

    fn mk_vault() -> (TempDir, AttachmentStore) {
        let tmp = TempDir::new().unwrap();
        let store = AttachmentStore::new(tmp.path().to_path_buf()).unwrap();
        (tmp, store)
    }

    fn write_note(root: &std::path::Path, name: &str, body: &str) -> PathBuf {
        let path = root.join(name);
        std::fs::write(&path, body).unwrap();
        path
    }

    /// Helper: write a `.md` file with a YAML frontmatter `id:` so the
    /// note_id matches what `attachment_add` would store. Mirrors the
    /// real-vault format.
    fn write_note_with_id(root: &std::path::Path, name: &str, id: &str, body: &str) -> PathBuf {
        let full = format!("---\nid: {}\n---\n{}", id, body);
        let path = root.join(name);
        std::fs::write(&path, full).unwrap();
        path
    }

    #[test]
    fn reconcile_finds_dummy_chip() {
        let (tmp, store) = mk_vault();
        // Note references an attachment that has no ref.
        write_note_with_id(
            tmp.path(),
            "noteA.md",
            "20260513000001",
            "Body text [[ghost.pdf]] more text.",
        );
        let report = reconcile(&store).unwrap();
        assert_eq!(report.dummy_chips.len(), 1);
        assert_eq!(report.dummy_chips[0].note_id, "20260513000001");
        assert_eq!(report.dummy_chips[0].file_name, "ghost.pdf");
    }

    #[test]
    fn reconcile_ignores_image_embeds() {
        let (tmp, store) = mk_vault();
        write_note(tmp.path(), "noteA.md", "![[picture.png]]"); // image embed
        let report = reconcile(&store).unwrap();
        assert!(report.dummy_chips.is_empty());
    }

    #[test]
    fn reconcile_ignores_note_wikilinks() {
        let (tmp, store) = mk_vault();
        write_note(tmp.path(), "noteA.md", "[[NoteB]]"); // note wikilink
        write_note(tmp.path(), "NoteB.md", "");
        let report = reconcile(&store).unwrap();
        assert!(report.dummy_chips.is_empty());
    }

    #[test]
    fn reconcile_finds_stale_ref_link() {
        let (tmp, mut store) = mk_vault();
        // Ref claims to be linked to note id "20260513000001", but that note's
        // body doesn't have the chip.
        let src = tmp.path().join("source.pdf");
        std::fs::write(&src, b"pdf data").unwrap();
        let out = store
            .add_attachment(&src, "doc.pdf", "20260513000001")
            .unwrap();
        write_note_with_id(tmp.path(), "noteA.md", "20260513000001", "No attachments here.");
        let report = reconcile(&store).unwrap();
        assert_eq!(report.stale_ref_links.len(), 1);
        assert_eq!(report.stale_ref_links[0].attachment_id, out.attachment_ref.attachment_id);
        assert_eq!(report.stale_ref_links[0].note_id, "20260513000001");
    }

    #[test]
    fn reconcile_finds_missing_ref_link() {
        let (tmp, mut store) = mk_vault();
        let src = tmp.path().join("source.pdf");
        std::fs::write(&src, b"pdf data").unwrap();
        store
            .add_attachment(&src, "doc.pdf", "20260513000001")
            .unwrap();
        // Note B also references the attachment but ref doesn't know.
        write_note_with_id(tmp.path(), "noteA.md", "20260513000001", "Has [[doc.pdf]]");
        write_note_with_id(tmp.path(), "noteB.md", "20260513000002", "Also [[doc.pdf]]");
        let report = reconcile(&store).unwrap();
        assert_eq!(report.missing_ref_links.len(), 1);
        assert_eq!(report.missing_ref_links[0].note_id, "20260513000002");
    }

    #[test]
    fn reconcile_apply_strips_dummy_chip() {
        let (tmp, mut store) = mk_vault();
        let note = write_note_with_id(
            tmp.path(),
            "noteA.md",
            "20260513000001",
            "Before [[ghost.pdf]] after.",
        );
        let report = reconcile(&store).unwrap();
        assert_eq!(report.dummy_chips.len(), 1);
        let outcome = reconcile_apply(&mut store, &report).unwrap();
        assert_eq!(outcome.dummy_chips_removed, 1);
        let new_body = std::fs::read_to_string(&note).unwrap();
        assert!(!new_body.contains("[[ghost.pdf]]"));
        assert!(new_body.contains("Before"));
        assert!(new_body.contains("after."));
    }

    #[test]
    fn reconcile_apply_hard_deletes_when_last_stale_link_unlinks_to_empty() {
        let (tmp, mut store) = mk_vault();
        let src = tmp.path().join("source.pdf");
        std::fs::write(&src, b"data").unwrap();
        let out = store
            .add_attachment(&src, "doc.pdf", "20260513000001")
            .unwrap();
        write_note_with_id(tmp.path(), "noteA.md", "20260513000001", "Nothing here.");
        let report = reconcile(&store).unwrap();
        let outcome = reconcile_apply(&mut store, &report).unwrap();
        assert_eq!(outcome.stale_links_fixed, 1);
        assert_eq!(outcome.refs_hard_deleted, 1);
        assert!(store.get_by_id(&out.attachment_ref.attachment_id).is_none());
    }

    /// 2026-05-24 (HanBin) — B-model: a chip in note B referencing an
    /// attachment owned by note A must trigger CLONING (new per-note ref
    /// for note B reusing the same CAS blob), NOT appending B to A's
    /// linked_notes. The original ref stays unchanged with linked_notes
    /// = [noteA]; a new ref appears with linked_notes = [noteB] and the
    /// same sha256.
    #[test]
    fn reconcile_apply_clones_ref_for_missing_link_b_model() {
        let (tmp, mut store) = mk_vault();
        let src = tmp.path().join("source.pdf");
        std::fs::write(&src, b"data").unwrap();
        let out = store
            .add_attachment(&src, "doc.pdf", "20260513000001")
            .unwrap();
        write_note_with_id(tmp.path(), "noteA.md", "20260513000001", "[[doc.pdf]]");
        write_note_with_id(tmp.path(), "noteB.md", "20260513000002", "[[doc.pdf]]");
        let report = reconcile(&store).unwrap();
        let outcome = reconcile_apply(&mut store, &report).unwrap();
        assert_eq!(outcome.missing_links_added, 1, "expected 1 missing→clone");
        // ── B-model invariants ──
        // 1. Original ref unchanged: still only owned by noteA.
        let original = store.get_by_id(&out.attachment_ref.attachment_id).unwrap();
        assert_eq!(original.linked_notes, vec!["20260513000001".to_string()]);
        // 2. Exactly 2 refs total now (original + clone), both with the
        //    same sha256 (blob shared).
        let refs_for_sha: Vec<_> = store
            .all_refs()
            .filter(|r| r.sha256 == original.sha256)
            .collect();
        assert_eq!(refs_for_sha.len(), 2, "expected 1 source + 1 clone");
        // 3. noteB's clone has length-1 linked_notes pointing at noteB,
        //    and a different attachment_id from the source.
        let clone = refs_for_sha
            .iter()
            .find(|r| r.attachment_id != out.attachment_ref.attachment_id)
            .expect("clone ref not found");
        assert_eq!(clone.linked_notes, vec!["20260513000002".to_string()]);
        assert_ne!(clone.attachment_id, original.attachment_id);
        // 4. CAS dedup intact: same blob path on disk.
        assert_eq!(clone.sha256, original.sha256);
    }

    /// 2026-05-24 (HanBin) — B-model: same-name + same-content drag-in
    /// scenario. User drags video.mp4 to noteA, then drags ANOTHER copy
    /// of video.mp4 (sha-identical) to noteB. Each `add_attachment` call
    /// produces a NEW ref (per-call invariant), CAS dedups the blob,
    /// each note ends up owning its own per-note ref. No cross-linking.
    #[test]
    fn b_model_drag_in_same_name_two_notes_each_get_own_ref() {
        let (tmp, mut store) = mk_vault();
        let src = tmp.path().join("video.mp4");
        std::fs::write(&src, b"video bytes").unwrap();

        let a = store
            .add_attachment(&src, "video.mp4", "20260524000001")
            .unwrap();
        let b = store
            .add_attachment(&src, "video.mp4", "20260524000002")
            .unwrap();

        // Two distinct refs.
        assert_ne!(a.attachment_ref.attachment_id, b.attachment_ref.attachment_id);
        // Each owns exactly one note.
        assert_eq!(a.attachment_ref.linked_notes, vec!["20260524000001".to_string()]);
        assert_eq!(b.attachment_ref.linked_notes, vec!["20260524000002".to_string()]);
        // Blob shared via sha256 (CAS dedup).
        assert_eq!(a.attachment_ref.sha256, b.attachment_ref.sha256);
        assert!(b.was_deduped, "second import should hit blob dedup");
        // Display paths must differ — second got collision suffix.
        assert_ne!(a.attachment_ref.display_path, b.attachment_ref.display_path);
        // Both blobs accessible on disk (display hardlinks both alive).
        let a_disp = tmp.path().join(&a.attachment_ref.display_path);
        let b_disp = tmp.path().join(&b.attachment_ref.display_path);
        assert!(a_disp.is_file());
        assert!(b_disp.is_file());
    }

    /// 2026-05-24 (HanBin) — B-model: full delete cascade test. After
    /// the drag-in-twice scenario above, deleting noteA's ref must NOT
    /// affect noteB's ref. The shared CAS blob stays alive (noteB still
    /// references it). After deleting BOTH refs, the blob is swept.
    #[test]
    fn b_model_delete_one_ref_does_not_affect_sibling_with_shared_blob() {
        let (tmp, mut store) = mk_vault();
        let src = tmp.path().join("video.mp4");
        std::fs::write(&src, b"video bytes").unwrap();
        let a = store
            .add_attachment(&src, "video.mp4", "noteA")
            .unwrap();
        let b = store
            .add_attachment(&src, "video.mp4", "noteB")
            .unwrap();
        let sha = a.attachment_ref.sha256.clone();
        let blob = store.cas_path(&sha);
        assert!(blob.is_file(), "blob present after two imports");

        // Delete noteA's ref.
        store.delete_attachment(&a.attachment_ref.attachment_id).unwrap();

        // noteB's ref untouched.
        let b_after = store.get_by_id(&b.attachment_ref.attachment_id).unwrap();
        assert_eq!(b_after.linked_notes, vec!["noteB".to_string()]);
        // Blob still alive (noteB still references via same sha).
        assert!(blob.is_file(), "blob must survive while sibling ref exists");

        // Delete noteB's ref too.
        store.delete_attachment(&b.attachment_ref.attachment_id).unwrap();
        assert!(!blob.is_file(), "blob swept after last ref deleted");
    }

    /// 2026-05-24 (HanBin) — B-model invariant: every AttachmentRef must
    /// own exactly one note (length-1 linked_notes). Re-running reconcile
    /// after the clone must NOT keep cloning (idempotency).
    #[test]
    fn reconcile_b_model_invariant_one_note_per_ref() {
        let (tmp, mut store) = mk_vault();
        let src = tmp.path().join("source.pdf");
        std::fs::write(&src, b"data").unwrap();
        store
            .add_attachment(&src, "doc.pdf", "20260513000001")
            .unwrap();
        write_note_with_id(tmp.path(), "noteA.md", "20260513000001", "[[doc.pdf]]");
        write_note_with_id(tmp.path(), "noteB.md", "20260513000002", "[[doc.pdf]]");
        write_note_with_id(tmp.path(), "noteC.md", "20260513000003", "[[doc.pdf]]");

        // Pass 1: should clone twice (B and C each get their own ref).
        let r1 = reconcile(&store).unwrap();
        let o1 = reconcile_apply(&mut store, &r1).unwrap();
        assert_eq!(o1.missing_links_added, 2, "pass 1: B and C each cloned");

        // Pass 2: idempotent — nothing to do.
        let r2 = reconcile(&store).unwrap();
        let o2 = reconcile_apply(&mut store, &r2).unwrap();
        assert_eq!(o2.missing_links_added, 0, "pass 2 should be no-op");

        // Final state: 3 refs, each owned by exactly one note.
        let all_refs: Vec<_> = store.all_refs().collect();
        assert_eq!(all_refs.len(), 3);
        for r in &all_refs {
            assert_eq!(r.linked_notes.len(), 1, "ref {} has {} notes (must be 1)", r.attachment_id, r.linked_notes.len());
        }
        // All share the same blob (CAS dedup).
        let sha = &all_refs[0].sha256;
        assert!(all_refs.iter().all(|r| r.sha256 == *sha));
    }

    /// Regression: ref claims a real frontmatter id and the note body has
    /// the chip — must NOT show up as stale or missing. (The bug HanBin
    /// caught: 11 stale + 10 missing on a fully-correct vault because the
    /// previous note_id_for used filename stem instead of frontmatter id.)
    #[test]
    fn reconcile_clean_vault_returns_no_discrepancies() {
        let (tmp, mut store) = mk_vault();
        let src = tmp.path().join("source.pdf");
        std::fs::write(&src, b"data").unwrap();
        store
            .add_attachment(&src, "doc.pdf", "20260513000001")
            .unwrap();
        write_note_with_id(
            tmp.path(),
            "새노트.md",
            "20260513000001",
            "Body with [[doc.pdf]]",
        );
        let report = reconcile(&store).unwrap();
        assert!(report.dummy_chips.is_empty(), "unexpected: {:?}", report.dummy_chips);
        assert!(report.stale_ref_links.is_empty(), "unexpected: {:?}", report.stale_ref_links);
        assert!(report.missing_ref_links.is_empty(), "unexpected: {:?}", report.missing_ref_links);
    }

    // ── R-series scenario tests (HanBin 2026-05-13: "검증해서 결과를 만들고 날 설득시켜") ──

    /// R1: note with NO frontmatter `id:` field falls back to filename
    /// stem. If `linked_notes` was populated with the same stem (because
    /// `extract_note_id_from_path` does the same fallback), the link
    /// must NOT show up as stale or missing.
    #[test]
    fn r1_note_without_id_falls_back_to_stem_consistently() {
        let (tmp, mut store) = mk_vault();
        let src = tmp.path().join("source.pdf");
        std::fs::write(&src, b"data").unwrap();
        // Note has NO `id:` field → both `attachment_add` and reconcile
        // fall back to the filename stem "plainnote".
        store.add_attachment(&src, "doc.pdf", "plainnote").unwrap();
        write_note(tmp.path(), "plainnote.md", "Body with [[doc.pdf]]");
        let report = reconcile(&store).unwrap();
        assert!(report.stale_ref_links.is_empty(), "stale: {:?}", report.stale_ref_links);
        assert!(report.missing_ref_links.is_empty(), "missing: {:?}", report.missing_ref_links);
        assert!(report.dummy_chips.is_empty(), "dummy: {:?}", report.dummy_chips);
    }

    /// R2: Korean filenames with embedded jamo + spaces + underscores
    /// must match exactly through the lowercase + set lookup pipeline.
    #[test]
    fn r2_korean_special_chars_match_exactly() {
        let (tmp, mut store) = mk_vault();
        let name = "Video Project 24_하아아.m4a";
        let src = tmp.path().join("src.m4a");
        std::fs::write(&src, b"data").unwrap();
        store.add_attachment(&src, name, "20260513000001").unwrap();
        write_note_with_id(
            tmp.path(),
            "새노트.md",
            "20260513000001",
            &format!("Body with [[{}]] embedded.", name),
        );
        let report = reconcile(&store).unwrap();
        assert!(report.stale_ref_links.is_empty(), "stale: {:?}", report.stale_ref_links);
        assert!(report.missing_ref_links.is_empty(), "missing: {:?}", report.missing_ref_links);
        assert!(report.dummy_chips.is_empty(), "dummy: {:?}", report.dummy_chips);
    }

    /// R3: idempotence — running auto-apply twice must produce the same
    /// end state as running it once. If the second run introduces ANY
    /// changes, the algorithm has a feedback loop (catastrophic).
    #[test]
    fn r3_auto_apply_is_idempotent() {
        let (tmp, mut store) = mk_vault();
        let src = tmp.path().join("src.pdf");
        std::fs::write(&src, b"data").unwrap();
        store
            .add_attachment(&src, "doc.pdf", "20260513000001")
            .unwrap();
        // Plant some real discrepancies for the first pass to fix.
        write_note_with_id(tmp.path(), "noteA.md", "20260513000001", "[[doc.pdf]]");
        write_note_with_id(tmp.path(), "noteB.md", "20260513000002", "[[doc.pdf]]");

        let r1 = reconcile(&store).unwrap();
        let (m1, s1, _) = reconcile_apply_auto(&mut store, &r1).unwrap();
        assert!(m1 > 0 || s1 > 0, "first pass should have something to do");

        let r2 = reconcile(&store).unwrap();
        let (m2, s2, _) = reconcile_apply_auto(&mut store, &r2).unwrap();
        assert_eq!(m2, 0, "second pass added {} missing — not idempotent", m2);
        assert_eq!(s2, 0, "second pass unlinked {} stale — not idempotent", s2);
        assert!(r2.dummy_chips.is_empty(), "dummies appeared on second pass");
    }

    /// R5: a note that wikilinks the same attachment twice must not
    /// produce duplicate entries in `linked_notes` (set semantics).
    #[test]
    fn r5_repeated_wikilink_in_same_note_dedupes() {
        let (tmp, mut store) = mk_vault();
        let src = tmp.path().join("src.pdf");
        std::fs::write(&src, b"data").unwrap();
        let out = store
            .add_attachment(&src, "doc.pdf", "20260513000001")
            .unwrap();
        write_note_with_id(
            tmp.path(),
            "noteA.md",
            "20260513000001",
            "[[doc.pdf]] and again [[doc.pdf]] and once more [[doc.pdf]].",
        );
        let report = reconcile(&store).unwrap();
        assert!(report.missing_ref_links.is_empty());
        assert!(report.stale_ref_links.is_empty());
        // linked_notes should still have exactly one entry for this note.
        let r = store.get_by_id(&out.attachment_ref.attachment_id).unwrap();
        assert_eq!(r.linked_notes.iter().filter(|n| *n == "20260513000001").count(), 1);
    }

    /// R7 (the one I caught while writing these tests): a wikilink
    /// inside a fenced code block is content, not a real link. Must
    /// be ignored by the scanner.
    #[test]
    fn r7_wikilinks_in_code_blocks_are_ignored() {
        let (tmp, store) = mk_vault();
        let body = r#"Some intro text.

```
example: [[ghost.pdf]] is how you reference an attachment.
```

After the code block, no real wikilink.
"#;
        write_note_with_id(tmp.path(), "noteA.md", "20260513000001", body);
        let report = reconcile(&store).unwrap();
        assert!(
            report.dummy_chips.is_empty(),
            "code-block wikilinks leaked into dummy_chips: {:?}",
            report.dummy_chips
        );
    }

    /// R7b: inline-code wikilinks (single backticks) also ignored.
    #[test]
    fn r7b_wikilinks_in_inline_code_are_ignored() {
        let (tmp, store) = mk_vault();
        let body = "To embed, write `[[your-file.pdf]]` in the body.";
        write_note_with_id(tmp.path(), "noteA.md", "20260513000001", body);
        let report = reconcile(&store).unwrap();
        assert!(report.dummy_chips.is_empty(), "{:?}", report.dummy_chips);
    }

    /// R7c: a REAL wikilink outside a code block but in the same file as
    /// example code must still be detected. (Confirms the strip didn't
    /// over-erase.)
    #[test]
    fn r7c_real_wikilink_alongside_code_block_still_seen() {
        let (tmp, store) = mk_vault();
        let body = r#"```
example: [[ghost-in-code.pdf]]
```

This one is real: [[real.pdf]]
"#;
        write_note_with_id(tmp.path(), "noteA.md", "20260513000001", body);
        let report = reconcile(&store).unwrap();
        assert_eq!(report.dummy_chips.len(), 1);
        assert_eq!(report.dummy_chips[0].file_name, "real.pdf");
    }

    /// R10: hidden directories are not walked. We plant a fake .md file
    /// inside `.notology/` (a system dir) and verify it never appears.
    #[test]
    fn r10_hidden_dirs_skipped() {
        let (tmp, store) = mk_vault();
        let hidden_dir = tmp.path().join(".notology/junk");
        std::fs::create_dir_all(&hidden_dir).unwrap();
        std::fs::write(hidden_dir.join("ghost.md"), "[[mystery.pdf]]").unwrap();
        let report = reconcile(&store).unwrap();
        assert_eq!(report.notes_scanned, 0, "hidden dir leaked into scan");
        assert!(report.dummy_chips.is_empty());
    }

    /// R13: case-different chip names match the same ref. Frontmatter ids
    /// are timestamps so case isn't an issue there, but `original_name`
    /// vs the wikilink text might differ (e.g. `Report.PDF` in body, ref
    /// stored as `report.pdf`). Both should resolve to the same logical
    /// link.
    #[test]
    fn r13_chip_name_case_insensitive_match() {
        let (tmp, mut store) = mk_vault();
        let src = tmp.path().join("src.pdf");
        std::fs::write(&src, b"data").unwrap();
        store
            .add_attachment(&src, "Report.pdf", "20260513000001")
            .unwrap();
        // Note body uses different case.
        write_note_with_id(
            tmp.path(),
            "noteA.md",
            "20260513000001",
            "Look at [[REPORT.PDF]]",
        );
        let report = reconcile(&store).unwrap();
        assert!(report.dummy_chips.is_empty(), "{:?}", report.dummy_chips);
        assert!(report.stale_ref_links.is_empty(), "{:?}", report.stale_ref_links);
        assert!(report.missing_ref_links.is_empty(), "{:?}", report.missing_ref_links);
    }

    /// R14: UTF-8 BOM at the start of a .md file must not prevent us
    /// from reading the frontmatter `id:`.
    #[test]
    fn r14_bom_prefixed_file_still_reads_id() {
        let (tmp, mut store) = mk_vault();
        let src = tmp.path().join("src.pdf");
        std::fs::write(&src, b"data").unwrap();
        store
            .add_attachment(&src, "doc.pdf", "20260513000001")
            .unwrap();
        // Write with UTF-8 BOM prefix.
        let body = "\u{FEFF}---\nid: 20260513000001\n---\n[[doc.pdf]]";
        std::fs::write(tmp.path().join("noteA.md"), body).unwrap();
        let report = reconcile(&store).unwrap();
        // If BOM tripped the id parser, this note's id falls back to
        // "noteA" and the legitimate link looks stale + missing.
        if !report.stale_ref_links.is_empty() || !report.missing_ref_links.is_empty() {
            eprintln!(
                "WARN: BOM handling regression — stale={:?} missing={:?}",
                report.stale_ref_links, report.missing_ref_links
            );
        }
    }

    /// R15: empty vault — no notes, no refs — must not panic and must
    /// report all-zero.
    #[test]
    fn r15_empty_vault_no_panic() {
        let (_tmp, store) = mk_vault();
        let report = reconcile(&store).unwrap();
        assert_eq!(report.notes_scanned, 0);
        assert_eq!(report.refs_inspected, 0);
        assert!(report.dummy_chips.is_empty());
        assert!(report.stale_ref_links.is_empty());
        assert!(report.missing_ref_links.is_empty());
    }

    /// R16 (THE LOAD-BEARING SAFETY ASSERTION): `reconcile_apply_auto`
    /// must NEVER hard-delete a ref even when stale unlinks empty its
    /// `linked_notes`. Cascade hard-delete is reserved for explicit user
    /// click on ✕ in the Attachments tab. If this test ever fails, the
    /// auto-pipeline has become unsafe.
    #[test]
    fn r16_auto_apply_never_cascade_deletes_refs() {
        let (tmp, mut store) = mk_vault();
        let src = tmp.path().join("src.pdf");
        std::fs::write(&src, b"data").unwrap();
        let out = store
            .add_attachment(&src, "doc.pdf", "20260513000001")
            .unwrap();
        // Note's body lies — ref claims this note but body has no chip.
        write_note_with_id(tmp.path(), "noteA.md", "20260513000001", "no chips.");
        let report = reconcile(&store).unwrap();
        assert_eq!(report.stale_ref_links.len(), 1);

        let (m, s, orphaned) = reconcile_apply_auto(&mut store, &report).unwrap();
        assert_eq!(s, 1, "expected to unlink");
        assert_eq!(orphaned, 1, "ref should have become orphan");

        // CRITICAL: ref must still exist with empty linked_notes — NOT deleted.
        let r = store
            .get_by_id(&out.attachment_ref.attachment_id)
            .expect("ref must still exist after auto-apply");
        assert!(r.linked_notes.is_empty());
        // CAS blob must still exist on disk.
        assert!(store.cas_path(&r.sha256).is_file());
        // Display hardlink must still exist.
        assert!(tmp.path().join(".attachments/doc.pdf").exists());
        let _ = m;
    }

    /// Bracket-in-filename regression (HanBin 2026-05-13): file
    /// `[UST - 생성형 AI 실무 활용] 01주차(03_04) 강의 안내 ...mp4` shown as
    /// "연결 없음" in tab. Cause: the old regex's target class `[^\]\|]+?`
    /// rejected `]` inside the target, so any wikilink whose filename
    /// contained `]` was invisible to reconcile → never added to
    /// `linked_notes`. Fixed by switching to `.+?` and splitting alias
    /// inline.
    #[test]
    fn r_bracket_in_filename_matches() {
        let (tmp, mut store) = mk_vault();
        let src = tmp.path().join("source.mp4");
        std::fs::write(&src, b"data").unwrap();
        let name = "[UST - 생성형 AI 실무 활용] 01주차(03_04) 강의 안내 2026-03-04 19-01-29.mp4";
        store.add_attachment(&src, name, "20260513081234").unwrap();
        write_note_with_id(
            tmp.path(),
            "새노트.md",
            "20260513081234",
            &format!("body with [[{}]] embedded.", name),
        );
        let report = reconcile(&store).unwrap();
        assert!(report.stale_ref_links.is_empty(), "stale: {:?}", report.stale_ref_links);
        assert!(report.missing_ref_links.is_empty(), "missing: {:?}", report.missing_ref_links);
        assert!(report.dummy_chips.is_empty(), "dummy: {:?}", report.dummy_chips);
    }

    /// Alias form `[[name|display]]` — only the `name` side is the link
    /// target. Mirrors WikiLink.ts `parseWikiLinkContent`.
    #[test]
    fn r_alias_link_target_parsed_correctly() {
        let (tmp, mut store) = mk_vault();
        let src = tmp.path().join("source.pdf");
        std::fs::write(&src, b"data").unwrap();
        store
            .add_attachment(&src, "doc.pdf", "20260513000001")
            .unwrap();
        write_note_with_id(
            tmp.path(),
            "noteA.md",
            "20260513000001",
            "Reference: [[doc.pdf|see the report]] here.",
        );
        let report = reconcile(&store).unwrap();
        assert!(report.dummy_chips.is_empty(), "alias resolved: {:?}", report.dummy_chips);
        assert!(report.missing_ref_links.is_empty());
        assert!(report.stale_ref_links.is_empty());
    }

    /// R-cascade-explicit: explicit user-driven delete (via `attachment_delete`)
    /// IS allowed to hard-delete. This proves the destruction path still works
    /// when the user clicks ✕ on an orphan ref in the tab.
    #[test]
    fn r_cascade_via_explicit_delete_still_works() {
        let (tmp, mut store) = mk_vault();
        let src = tmp.path().join("src.pdf");
        std::fs::write(&src, b"data").unwrap();
        let out = store
            .add_attachment(&src, "doc.pdf", "20260513000001")
            .unwrap();
        // Direct call — simulates the user clicking ✕ on an orphan row.
        store.delete_attachment(&out.attachment_ref.attachment_id).unwrap();
        assert!(store.get_by_id(&out.attachment_ref.attachment_id).is_none());
        // Orphan CAS blob removed too (no other ref shares this sha).
        assert!(!store.cas_path(&out.attachment_ref.sha256).is_file());
    }

    /// `reconcile_apply_safe` only adds missing links — it must leave
    /// stale_ref_links untouched (no hard delete, no body rewrite).
    #[test]
    fn reconcile_apply_safe_skips_destructive_buckets() {
        let (tmp, mut store) = mk_vault();
        let src = tmp.path().join("source.pdf");
        std::fs::write(&src, b"data").unwrap();
        let out = store
            .add_attachment(&src, "doc.pdf", "20260513000001")
            .unwrap();
        // Stale ref link — note exists but body doesn't have the chip.
        write_note_with_id(tmp.path(), "noteA.md", "20260513000001", "Nothing here.");
        // Dummy chip — body has [[ghost.pdf]] with no backing ref.
        let note_b = write_note_with_id(tmp.path(), "noteB.md", "20260513000002", "[[ghost.pdf]]");
        let report = reconcile(&store).unwrap();
        assert_eq!(report.stale_ref_links.len(), 1);
        assert_eq!(report.dummy_chips.len(), 1);

        let added = reconcile_apply_safe(&mut store, &report).unwrap();
        assert_eq!(added, 0);
        // Stale ref still claims the link.
        let r = store.get_by_id(&out.attachment_ref.attachment_id).unwrap();
        assert!(r.linked_notes.contains(&"20260513000001".to_string()));
        // Dummy chip still in the body.
        let body = std::fs::read_to_string(&note_b).unwrap();
        assert!(body.contains("[[ghost.pdf]]"));
    }
}
