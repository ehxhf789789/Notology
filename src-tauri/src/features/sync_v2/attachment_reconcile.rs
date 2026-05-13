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

/// Extract the note_id (filename stem, lowercased) from a `.md` file path.
fn note_id_for(path: &Path) -> Option<String> {
    path.file_stem()
        .and_then(|s| s.to_str())
        .map(|s| s.to_lowercase())
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
    //    linked_notes set). We use lowercase comparison throughout because
    //    Windows + macOS filesystems are case-insensitive, and the wikilink
    //    text and the ref's `original_name` may differ in case.
    type RefByName = HashMap<String, (String, String, HashSet<String>)>;
    let mut refs_by_name: RefByName = HashMap::new();
    for r in store.all_refs() {
        report.refs_inspected += 1;
        let key = r.original_name.to_lowercase();
        let linked: HashSet<String> =
            r.linked_notes.iter().map(|s| s.to_lowercase()).collect();
        refs_by_name.insert(
            key,
            (r.attachment_id.clone(), r.original_name.clone(), linked),
        );
    }

    // 2. Walk note bodies. For each wikilink chip that looks like an
    //    attachment, record (note_id, fileName).
    let notes = walk_notes(vault);
    report.notes_scanned = notes.len();
    let re = wikilink_regex();

    // chips_by_note: note_id → set of attachment fileNames (lowercased)
    let mut chips_by_note: HashMap<String, HashSet<String>> = HashMap::new();
    // note_paths: note_id → absolute note path (for the dummy_chips report).
    let mut note_paths: HashMap<String, std::path::PathBuf> = HashMap::new();

    for (path, content) in &notes {
        let nid = match note_id_for(path) {
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

    #[test]
    fn reconcile_finds_dummy_chip() {
        let (tmp, store) = mk_vault();
        // Note references an attachment that has no ref.
        write_note(tmp.path(), "noteA.md", "Body text [[ghost.pdf]] more text.");
        let report = reconcile(&store).unwrap();
        assert_eq!(report.dummy_chips.len(), 1);
        assert_eq!(report.dummy_chips[0].note_id, "notea");
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
        // Ref claims to be linked to noteA, but noteA's body doesn't have the chip.
        let src = tmp.path().join("source.pdf");
        std::fs::write(&src, b"pdf data").unwrap();
        let out = store.add_attachment(&src, "doc.pdf", "notea").unwrap();
        write_note(tmp.path(), "noteA.md", "No attachments here.");
        let report = reconcile(&store).unwrap();
        assert_eq!(report.stale_ref_links.len(), 1);
        assert_eq!(report.stale_ref_links[0].attachment_id, out.attachment_ref.attachment_id);
        assert_eq!(report.stale_ref_links[0].note_id, "notea");
    }

    #[test]
    fn reconcile_finds_missing_ref_link() {
        let (tmp, mut store) = mk_vault();
        let src = tmp.path().join("source.pdf");
        std::fs::write(&src, b"pdf data").unwrap();
        store.add_attachment(&src, "doc.pdf", "notea").unwrap();
        // Note B also references the attachment but ref doesn't know.
        write_note(tmp.path(), "noteA.md", "Has [[doc.pdf]]");
        write_note(tmp.path(), "noteB.md", "Also [[doc.pdf]]");
        let report = reconcile(&store).unwrap();
        assert_eq!(report.missing_ref_links.len(), 1);
        assert_eq!(report.missing_ref_links[0].note_id, "noteb");
    }

    #[test]
    fn reconcile_apply_strips_dummy_chip() {
        let (tmp, mut store) = mk_vault();
        let note = write_note(
            tmp.path(),
            "noteA.md",
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
        let out = store.add_attachment(&src, "doc.pdf", "notea").unwrap();
        // Note A doesn't actually contain the chip → stale.
        write_note(tmp.path(), "noteA.md", "Nothing here.");
        let report = reconcile(&store).unwrap();
        let outcome = reconcile_apply(&mut store, &report).unwrap();
        assert_eq!(outcome.stale_links_fixed, 1);
        assert_eq!(outcome.refs_hard_deleted, 1);
        // Ref gone.
        assert!(store.get_by_id(&out.attachment_ref.attachment_id).is_none());
    }

    #[test]
    fn reconcile_apply_adds_missing_link() {
        let (tmp, mut store) = mk_vault();
        let src = tmp.path().join("source.pdf");
        std::fs::write(&src, b"data").unwrap();
        let out = store.add_attachment(&src, "doc.pdf", "notea").unwrap();
        write_note(tmp.path(), "noteA.md", "[[doc.pdf]]");
        write_note(tmp.path(), "noteB.md", "[[doc.pdf]]");
        let report = reconcile(&store).unwrap();
        let outcome = reconcile_apply(&mut store, &report).unwrap();
        assert_eq!(outcome.missing_links_added, 1);
        let r = store.get_by_id(&out.attachment_ref.attachment_id).unwrap();
        assert!(r.linked_notes.contains(&"noteb".to_string()));
    }
}
