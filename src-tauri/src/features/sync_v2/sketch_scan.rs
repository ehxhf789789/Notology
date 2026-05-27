//! Round 2 R6 (HanBin 2026-05-22) — sketch/canvas note attachment ref scanner.
//!
//! Background — the attachment orphan detector previously inspected only
//! inline `[[wikilinks]]` in `.md` bodies (via `attachment_reconcile`). Sketch
//! ("canvas") notes store their content as a JSON tree of nodes in the body,
//! and a `type: "file"` node holds the referenced attachment in its `file`
//! field. Those references were invisible to the reconcile pass, so any
//! attachment referenced ONLY by a sketch was misclassified as orphan and
//! got hard-deleted on bulk sweep — leaving broken nodes on the canvas.
//!
//! This module exposes a single helper: given a full `.md` body, return the
//! attachment filenames the sketch references. The reconcile module unions
//! the result into its `chips_by_note` map so sketch refs are treated
//! identically to inline wikilinks.
//!
//! Format contract (matches frontend `src/features/sketch/SketchEditor.tsx`):
//!   - frontmatter has `canvas: true`
//!   - body (after frontmatter) is JSON: `{ "nodes": [...], "edges": [...] }`
//!   - file-attachment node:  `{ "type": "file", "file": "name.ext", ... }`
//!   - note-link node:        `{ "type": "link", "url": "Note.md", ... }`
//!     (urls are out of scope here — they're handled by the existing
//!     wikilink/note-id rename infrastructure, not the attachment index.)

#![allow(dead_code)]

use serde_json::Value;

/// 2026-05-24 (HanBin) — companion to `scan_sketch_refs`. Returns the
/// **note-link** URLs referenced by sketch nodes. These come from two
/// patterns the SketchEditor produces:
///
///   • `type: 'link'`  + `url:  "Note.md"`  (the "위키링크 추가" menu —
///     the canonical post-2026-05-24 representation of an internal note
///     reference)
///   • `type: 'file'`  + `file: "*.md"`     (legacy from the broken
///     WikiLinkSearch flow — file-nodes pointing at .md files. The
///     SketchEditor auto-migrates these to type:'link' on next open,
///     but the graph view should already show the correct connection
///     even before that migration runs)
///
/// Caller treats each returned string the same way it treats body
/// inline wikilinks — resolves via `stem_to_id` / `title_to_id`.
///
/// Returns an empty vector for non-sketch notes or JSON parse failures.
pub fn scan_sketch_note_links(md_content: &str) -> Vec<String> {
    if !is_canvas_note(md_content) {
        return Vec::new();
    }
    let body = strip_frontmatter(md_content).trim();
    if body.is_empty() {
        return Vec::new();
    }
    let parsed: Value = match serde_json::from_str(body) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    let nodes = match parsed.get("nodes").and_then(|n| n.as_array()) {
        Some(a) => a,
        None => return Vec::new(),
    };
    let mut out = Vec::new();
    for node in nodes {
        let node_type = node.get("type").and_then(|t| t.as_str()).unwrap_or("");
        // Pattern 1: canonical type:'link' note reference.
        if node_type == "link" {
            if let Some(url) = node.get("url").and_then(|u| u.as_str()) {
                if !url.is_empty() {
                    // url is typically the note name ("dffa" or "dffa.md").
                    // Strip a trailing .md if present so it matches the
                    // resolver's `stem_to_id` keys.
                    let cleaned = url.strip_suffix(".md").unwrap_or(url);
                    let basename = cleaned
                        .rsplit(|c| c == '/' || c == '\\')
                        .next()
                        .unwrap_or(cleaned);
                    out.push(basename.to_string());
                }
            }
            continue;
        }
        // Pattern 2: legacy type:'file' pointing at a .md file. Pre-migration
        // sketches have these; we still want the graph edge to surface.
        if node_type == "file" {
            if let Some(file) = node.get("file").and_then(|f| f.as_str()) {
                let lower = file.to_lowercase();
                if lower.ends_with(".md") {
                    let basename = std::path::Path::new(file)
                        .file_stem()
                        .and_then(|s| s.to_str())
                        .unwrap_or(file);
                    out.push(basename.to_string());
                }
            }
        }
    }
    out
}

/// Return the attachment basenames referenced by sketch nodes in this note
/// body. Returns an empty vector if the note is not a sketch/canvas note,
/// the body fails to parse as JSON, or no file nodes are present.
///
/// Caller is expected to lowercase / NFC-normalize the returned strings to
/// match the rest of the attachment_reconcile pipeline.
pub fn scan_sketch_refs(md_content: &str) -> Vec<String> {
    if !is_canvas_note(md_content) {
        return Vec::new();
    }
    let body = strip_frontmatter(md_content).trim();
    if body.is_empty() {
        return Vec::new();
    }
    let parsed: Value = match serde_json::from_str(body) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    let nodes = match parsed.get("nodes").and_then(|n| n.as_array()) {
        Some(a) => a,
        None => return Vec::new(),
    };
    let mut out = Vec::new();
    for node in nodes {
        let node_type = node.get("type").and_then(|t| t.as_str()).unwrap_or("");
        if node_type != "file" {
            continue;
        }
        if let Some(file) = node.get("file").and_then(|f| f.as_str()) {
            if !file.is_empty() {
                // The `file` field stores the attachment's display path or
                // basename. Reconcile keys by basename (matches
                // `AttachmentRef.original_name`), so we extract that.
                let basename = file
                    .rsplit(|c| c == '/' || c == '\\')
                    .next()
                    .unwrap_or(file);
                out.push(basename.to_string());
            }
        }
    }
    out
}

/// Quick check — does this `.md` declare `canvas: true` OR `sketch: true`
/// in YAML frontmatter? Used to gate JSON parsing (almost every `.md` would
/// fail to parse as JSON, and we don't want to incur that cost on plain
/// notes).
///
/// 2026-05-23 (HanBin) — CRITICAL FIX. The original implementation only
/// recognized `canvas:`, but the frontend treats `sketch:` and `canvas:`
/// as equivalent identifiers ([useContentLoader.ts:91-269](src/features/note-editor/useContentLoader.ts):
/// `(fm as any)?.sketch || (fm as any)?.canvas`). Older sketches saved
/// with `sketch: true` in frontmatter were therefore invisible to
/// `scan_sketch_refs` — the reconcile pass simply skipped them, so any
/// attachment referenced ONLY by a `sketch:`-flagged note never got its
/// `linked_notes` populated and showed "첨부파일 없음" in the Attachments
/// tab. Mirror the frontend rule here to close the loop.
fn is_canvas_note(md: &str) -> bool {
    let fm = match extract_frontmatter(md) {
        Some(f) => f,
        None => return false,
    };
    // Cheap line-by-line scan. We don't need full YAML semantics — just
    // the presence of `canvas: true` / `sketch: true` (or no-space form)
    // on its own line. Treat both keys as equivalent because the frontend
    // does too (see useContentLoader.ts).
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

fn extract_frontmatter(md: &str) -> Option<&str> {
    let s = md.strip_prefix("---")?;
    let s = s.strip_prefix('\n').or_else(|| s.strip_prefix("\r\n"))?;
    let end = s.find("\n---")?;
    Some(&s[..end])
}

fn strip_frontmatter(md: &str) -> &str {
    let Some(rest) = md.strip_prefix("---") else { return md };
    let rest = rest.strip_prefix('\n').or_else(|| rest.strip_prefix("\r\n")).unwrap_or(rest);
    let Some(end) = rest.find("\n---") else { return md };
    let after = &rest[end + 4..]; // skip "\n---"
    after.strip_prefix('\n').or_else(|| after.strip_prefix("\r\n")).unwrap_or(after)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_note_returns_empty() {
        let md = "---\ntitle: hello\n---\n\nJust text.";
        assert!(scan_sketch_refs(md).is_empty());
    }

    #[test]
    fn canvas_note_with_file_nodes() {
        let md = r#"---
title: My Canvas
canvas: true
---

{"nodes":[
  {"id":"n1","type":"text","text":"hi","x":0,"y":0},
  {"id":"n2","type":"file","file":"Report.pdf","x":100,"y":100},
  {"id":"n3","type":"file","file":"diagram.png","x":200,"y":200}
],"edges":[]}"#;
        let refs = scan_sketch_refs(md);
        assert_eq!(refs, vec!["Report.pdf", "diagram.png"]);
    }

    #[test]
    fn canvas_note_with_subdir_path() {
        let md = r#"---
canvas: true
---

{"nodes":[{"id":"n1","type":"file","file":".attachments/sub/img.png"}],"edges":[]}"#;
        let refs = scan_sketch_refs(md);
        assert_eq!(refs, vec!["img.png"]);
    }

    #[test]
    fn broken_json_returns_empty() {
        let md = "---\ncanvas: true\n---\n\n{not json";
        assert!(scan_sketch_refs(md).is_empty());
    }

    #[test]
    fn missing_canvas_flag_returns_empty_even_if_json() {
        let md = r#"---
title: x
---

{"nodes":[{"id":"n1","type":"file","file":"x.pdf"}]}"#;
        assert!(scan_sketch_refs(md).is_empty());
    }

    /// 2026-05-23 regression guard. The frontend writes either `canvas:`
    /// or `sketch:` to identify sketch notes (older notes use `sketch:`).
    /// `scan_sketch_refs` must honor both, otherwise `sketch:`-flagged
    /// notes get skipped and their attachments stay disconnected from
    /// `AttachmentRef.linked_notes` (the bug HanBin hit with dddsaa.md
    /// where 3 file nodes were invisible to the Attachments tab filter).
    #[test]
    fn sketch_flag_in_frontmatter_is_honored() {
        let md = r#"---
title: Legacy Sketch
sketch: true
---

{"nodes":[{"id":"n1","type":"file","file":"Report.hwp"}],"edges":[]}"#;
        let refs = scan_sketch_refs(md);
        assert_eq!(refs, vec!["Report.hwp"]);
    }
}
