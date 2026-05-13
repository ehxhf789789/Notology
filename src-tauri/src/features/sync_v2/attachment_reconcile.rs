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
    R.get_or_init(|| regex::Regex::new(r"(?P<bang>!)?\[\[(?P<target>[^\]\|]+?)(?:\|[^\]]*)?\]\]").unwrap())
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
        for cap in re.captures_iter(content) {
            if cap.name("bang").is_some() {
                continue; // image embed, not an attachment chip
            }
            let target = cap.name("target").map(|m| m.as_str()).unwrap_or("");
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
            let target = caps.name("target").map(|m| m.as_str()).unwrap_or("");
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

    // 3. Fix missing_ref_links: append note_id to ref's linked_notes.
    for m in &report.missing_ref_links {
        match store.link_to_note(&m.attachment_id, &m.note_id) {
            Ok(()) => outcome.missing_links_added += 1,
            Err(e) => outcome.errors.push(format!(
                "link {} to {}: {}",
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

    for m in &report.missing_ref_links {
        if store.link_to_note(&m.attachment_id, &m.note_id).is_ok() {
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
pub fn reconcile_apply_safe(
    store: &mut AttachmentStore,
    report: &ReconcileReport,
) -> Result<usize, String> {
    let mut added = 0usize;
    for m in &report.missing_ref_links {
        if store.link_to_note(&m.attachment_id, &m.note_id).is_ok() {
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

    #[test]
    fn reconcile_apply_adds_missing_link() {
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
        assert_eq!(outcome.missing_links_added, 1);
        let r = store.get_by_id(&out.attachment_ref.attachment_id).unwrap();
        assert!(r.linked_notes.contains(&"20260513000002".to_string()));
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
