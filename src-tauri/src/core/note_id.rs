//! Note identity management for Notology.
//!
//! Notes are identified by a 14-digit timestamp (`YYYYMMDDHHMMSS`) stored
//! in the frontmatter `id` field. This module provides utilities to generate,
//! read, and ensure note IDs exist in files.

use std::fs;
use std::path::Path;

use crate::core::file_io::atomic_write_file;

/// Generate a new note ID (14-digit timestamp: YYYYMMDDHHMMSS).
///
/// Uses local time to match the existing `generate_note_id()` in
/// `frontmatter/types.rs`. If called multiple times within the same
/// second, identical IDs may be returned — use `generate_unique_id()`
/// for contexts requiring uniqueness (e.g., migration).
pub fn generate_id() -> String {
    chrono::Local::now().format("%Y%m%d%H%M%S").to_string()
}

/// Generate a unique note ID with millisecond suffix to avoid collisions.
/// Format: YYYYMMDDHHMMSSMMM (17 digits).
/// Use this in bulk operations (migration) where many IDs are generated rapidly.
pub fn generate_unique_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static LAST_TS: AtomicU64 = AtomicU64::new(0);

    let now = chrono::Local::now();
    let base = now.format("%Y%m%d%H%M%S").to_string();
    let ms = now.format("%3f").to_string(); // milliseconds
    let candidate = format!("{}{}", base, ms);

    // Ensure monotonically increasing
    let candidate_num: u64 = candidate.parse().unwrap_or(0);
    let prev = LAST_TS.fetch_max(candidate_num, Ordering::SeqCst);
    if candidate_num <= prev {
        let next = prev + 1;
        LAST_TS.store(next, Ordering::SeqCst);
        return format!("{:017}", next);
    }
    candidate
}

/// Validate that a string is a valid note ID.
///
/// Valid formats:
/// - 14 digits: `YYYYMMDDHHMMSS`
/// - 17 digits: `YYYYMMDDHHMMSSMMM` (with millisecond suffix)
pub fn is_valid_id(id: &str) -> bool {
    let len = id.len();
    (len == 14 || len == 17) && id.bytes().all(|b| b.is_ascii_digit())
}

/// Extract note ID from a file's frontmatter.
///
/// Returns `Ok(None)` if the file has no frontmatter or no valid `id` field.
/// Returns `Err` only on file read errors.
pub fn read_id_from_file(file_path: &Path) -> Result<Option<String>, String> {
    let content = fs::read_to_string(file_path)
        .map_err(|e| format!("read_id_from_file: failed to read {:?}: {}", file_path, e))?;
    Ok(read_id_from_content(&content))
}

/// Extract note ID from file content string (without disk I/O).
pub fn read_id_from_content(content: &str) -> Option<String> {
    let fm_yaml = extract_frontmatter(content)?;
    let value: serde_yaml::Value = serde_yaml::from_str(&fm_yaml).ok()?;
    let id = value.get("id")?.as_str()?;
    if is_valid_id(id) {
        Some(id.to_string())
    } else {
        None
    }
}

/// Add the `id` field to a note's frontmatter if missing.
///
/// If a valid `id` already exists, returns it without modifying the file.
/// If missing or invalid, generates a new one, inserts it as the first
/// frontmatter field, and writes the file atomically.
/// Preserves all existing frontmatter fields and body content.
pub fn ensure_id_in_file(file_path: &Path) -> Result<String, String> {
    let content = fs::read_to_string(file_path)
        .map_err(|e| format!("ensure_id_in_file: failed to read {:?}: {}", file_path, e))?;

    // Check if valid id already exists
    if let Some(existing_id) = read_id_from_content(&content) {
        return Ok(existing_id);
    }

    // Generate new id (unique to avoid collisions in bulk operations)
    let new_id = generate_unique_id();
    let new_content = insert_id_into_content(&content, &new_id);
    atomic_write_file(file_path, new_content.as_bytes())?;
    Ok(new_id)
}

/// Extract the YAML frontmatter string from between `---` markers.
fn extract_frontmatter(content: &str) -> Option<String> {
    let trimmed = content.strip_prefix("---\r\n")
        .or_else(|| content.strip_prefix("---\n"))?;
    let end = trimmed.find("\n---\n")
        .or_else(|| trimmed.find("\n---\r\n"))
        .or_else(|| {
            // Handle case where --- is at EOF with no trailing newline
            if trimmed.ends_with("\n---") {
                Some(trimmed.len() - 3)
            } else {
                None
            }
        })?;
    Some(trimmed[..end].to_string())
}

/// Insert an `id` field into content, preserving existing formatting.
///
/// If the file starts with an opening fence `---` but is missing the closing
/// fence (broken frontmatter from prior corruption), we DON'T blindly prepend
/// another id line — that path accumulates duplicates forever. Instead we
/// repair the header: strip duplicate `id:` lines, preserve other keys, and
/// add a proper closing fence.
pub fn insert_id_into_content(content: &str, new_id: &str) -> String {
    let id_line = format!("id: \"{}\"\n", new_id);

    let line_sep_opt = if content.starts_with("---\r\n") {
        Some("\r\n")
    } else if content.starts_with("---\n") {
        Some("\n")
    } else {
        None
    };

    if let Some(line_sep) = line_sep_opt {
        // Has opening fence — verify a closing fence exists.
        let header_len = line_sep.len() + 3;
        let after_open = &content[header_len..];
        let close_pat = format!("{}---", line_sep);
        if !after_open.contains(&close_pat) {
            return repair_broken_frontmatter_and_set_id(content, new_id, line_sep);
        }
        // Well-formed: prepend id at top of frontmatter.
        return format!("---{}{}{}", line_sep, id_line.replace('\n', line_sep), after_open);
    }

    // No frontmatter — wrap body.
    format!("---\n{}---\n\n{}", id_line, content)
}

/// Repair a content with broken frontmatter (open fence, no close fence) and
/// re-inject the id cleanly.
///
/// Real-world trigger: in a long-running vault, some external write path can
/// drop the closing `---` fence. Our parser then can't read the existing id,
/// so each subsequent import generates a new id and prepends another `id:`
/// line — accumulating duplicates forever and bloating the file.
///
/// Repair strategy:
///  - Strip all leading `id:` lines from the broken header (they're our prior
///    accidental duplicates).
///  - Preserve any other YAML keys we encounter.
///  - Stop at the first blank line OR first non-key line (= body start).
///  - Re-emit a clean `---\n id: NEW \n <other keys> \n---\n\n<body>`.
fn repair_broken_frontmatter_and_set_id(content: &str, new_id: &str, line_sep: &str) -> String {
    let header_len = line_sep.len() + 3; // "---" + sep
    let after_open = &content[header_len..];

    let mut other_keys: Vec<&str> = Vec::new();
    let mut body_start = 0usize;
    let mut header_ended = false;

    // Walk lines until we hit a blank or non-YAML-looking line.
    for line in after_open.split_inclusive('\n') {
        if header_ended { break; }
        let trimmed = line.trim_end_matches(|c: char| c == '\n' || c == '\r');
        if trimmed.is_empty() {
            body_start += line.len();
            header_ended = true;
            continue;
        }
        // Heuristic: a YAML key has `key: value` shape with a colon.
        let key_part = trimmed.trim_start();
        let looks_like_key = key_part.contains(':');
        if !looks_like_key {
            // Not YAML — body starts here (don't advance past this line).
            header_ended = true;
            continue;
        }
        if key_part.starts_with("id:") || key_part.starts_with("id ") {
            // Drop duplicate id line.
            body_start += line.len();
            continue;
        }
        other_keys.push(trimmed);
        body_start += line.len();
    }

    let body = &after_open[body_start..];

    let mut out = String::with_capacity(content.len() + 64);
    out.push_str("---");
    out.push_str(line_sep);
    out.push_str(&format!("id: \"{}\"", new_id));
    out.push_str(line_sep);
    for k in other_keys {
        out.push_str(k);
        out.push_str(line_sep);
    }
    out.push_str("---");
    out.push_str(line_sep);
    out.push_str(line_sep);
    out.push_str(body);
    out
}

/// Replace the value of the `id` field in frontmatter, or insert one if absent.
///
/// Used when conflict-copy detection forces a fresh id on a file that ALREADY
/// has an id (it shares the id with a sibling). Plain `insert_id_into_content`
/// would prepend a duplicate id line; this scans the frontmatter block and
/// rewrites the existing id line in place, preserving line endings + other keys.
pub fn replace_or_insert_id(content: &str, new_id: &str) -> String {
    // No frontmatter at all → fall back to insert path.
    let has_lf = content.starts_with("---\n");
    let has_crlf = content.starts_with("---\r\n");
    if !has_lf && !has_crlf {
        return insert_id_into_content(content, new_id);
    }

    let line_sep = if has_crlf { "\r\n" } else { "\n" };
    let header_len = if has_crlf { 5 } else { 4 }; // "---\r\n" or "---\n"

    // Locate the closing fence "---" in frontmatter.
    let after_open = &content[header_len..];
    let close_pat = format!("{}---", line_sep);
    let fm_body_len = match after_open.find(&close_pat) {
        Some(idx) => idx,
        // Malformed: open fence without close. Repair instead of blindly
        // prepending another id line (which would accumulate forever).
        None => return repair_broken_frontmatter_and_set_id(content, new_id, line_sep),
    };
    let fm_body = &after_open[..fm_body_len];
    let rest = &after_open[fm_body_len..]; // starts with "\n---" or "\r\n---"

    // Walk frontmatter lines and replace `id:` line; if absent, prepend new id.
    let id_line = format!("id: \"{}\"", new_id);
    let mut out_fm = String::with_capacity(fm_body.len() + 32);
    let mut replaced = false;
    let lines: Vec<&str> = fm_body.split(line_sep).collect();
    for (i, line) in lines.iter().enumerate() {
        let trimmed = line.trim_start();
        let is_id = trimmed.starts_with("id:") || trimmed.starts_with("id ");
        if is_id && !replaced {
            // Preserve leading whitespace (rare but possible for nested keys —
            // top-level id is more common).
            let indent_len = line.len() - trimmed.len();
            out_fm.push_str(&line[..indent_len]);
            out_fm.push_str(&id_line);
            replaced = true;
        } else {
            out_fm.push_str(line);
        }
        if i + 1 < lines.len() {
            out_fm.push_str(line_sep);
        }
    }

    if !replaced {
        // Frontmatter exists but has no id key → prepend.
        let prepended = format!("{}{}{}", id_line, line_sep, out_fm);
        return format!("---{}{}{}", line_sep, prepended, rest);
    }

    format!("---{}{}{}", line_sep, out_fm, rest)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;
    use std::io::Write;

    fn write_test_file(dir: &Path, name: &str, content: &str) -> std::path::PathBuf {
        let path = dir.join(name);
        let mut f = fs::File::create(&path).unwrap();
        f.write_all(content.as_bytes()).unwrap();
        path
    }

    #[test]
    fn test_generate_id_format() {
        let id = generate_id();
        assert_eq!(id.len(), 14);
        assert!(id.bytes().all(|b| b.is_ascii_digit()));
    }

    #[test]
    fn test_generate_id_uniqueness() {
        let ids: Vec<String> = (0..100).map(|_| generate_id()).collect();
        // At least some should differ (unless all generated in same second)
        // We just verify they're all valid
        for id in &ids {
            assert!(is_valid_id(id));
        }
    }

    #[test]
    fn test_is_valid_id() {
        assert!(is_valid_id("20260419103000"));        // 14 digits
        assert!(is_valid_id("20260419103000123"));      // 17 digits (ms)
        assert!(!is_valid_id("1234567890123"));         // 13 digits
        assert!(!is_valid_id("abcdefghijklmn"));        // not digits
        assert!(!is_valid_id(""));                      // empty
        assert!(!is_valid_id("123456789012345"));       // 15 digits
    }

    #[test]
    fn test_read_id_from_file_with_id() {
        let tmp = TempDir::new().unwrap();
        let path = write_test_file(tmp.path(), "note.md",
            "---\nid: \"20260419103000\"\ntitle: \"Test\"\n---\n\nBody");
        let id = read_id_from_file(&path).unwrap();
        assert_eq!(id, Some("20260419103000".to_string()));
    }

    #[test]
    fn test_read_id_from_file_missing() {
        let tmp = TempDir::new().unwrap();
        let path = write_test_file(tmp.path(), "note.md",
            "---\ntitle: \"Test\"\n---\n\nBody");
        assert_eq!(read_id_from_file(&path).unwrap(), None);
    }

    #[test]
    fn test_read_id_from_file_no_frontmatter() {
        let tmp = TempDir::new().unwrap();
        let path = write_test_file(tmp.path(), "note.md", "Just a body, no frontmatter.");
        assert_eq!(read_id_from_file(&path).unwrap(), None);
    }

    #[test]
    fn test_read_id_from_file_invalid_id() {
        let tmp = TempDir::new().unwrap();
        let path = write_test_file(tmp.path(), "note.md",
            "---\nid: \"not-valid\"\ntitle: \"Test\"\n---\n\nBody");
        assert_eq!(read_id_from_file(&path).unwrap(), None);
    }

    #[test]
    fn test_ensure_id_adds_to_existing_frontmatter() {
        let tmp = TempDir::new().unwrap();
        let path = write_test_file(tmp.path(), "note.md",
            "---\ncreated: \"2026-01-01\"\ntitle: \"Test\"\n---\n\nBody content.");
        let id = ensure_id_in_file(&path).unwrap();
        assert!(is_valid_id(&id));

        // Verify file now has id and body preserved
        let content = fs::read_to_string(&path).unwrap();
        assert!(content.contains(&format!("id: \"{}\"", id)));
        assert!(content.contains("Body content."));
        assert!(content.contains("created: \"2026-01-01\""));
        assert!(content.contains("title: \"Test\""));
    }

    #[test]
    fn test_ensure_id_preserves_existing_id() {
        let tmp = TempDir::new().unwrap();
        let original = "---\nid: \"20260419103000\"\ntitle: \"Test\"\n---\n\nBody";
        let path = write_test_file(tmp.path(), "note.md", original);
        let id = ensure_id_in_file(&path).unwrap();
        assert_eq!(id, "20260419103000");

        // File content should be unchanged
        let content = fs::read_to_string(&path).unwrap();
        assert_eq!(content, original);
    }

    #[test]
    fn test_ensure_id_no_frontmatter() {
        let tmp = TempDir::new().unwrap();
        let path = write_test_file(tmp.path(), "note.md", "Just body text.");
        let id = ensure_id_in_file(&path).unwrap();
        assert!(is_valid_id(&id));

        let content = fs::read_to_string(&path).unwrap();
        assert!(content.starts_with("---\n"));
        assert!(content.contains(&format!("id: \"{}\"", id)));
        assert!(content.contains("Just body text."));
    }

    #[test]
    fn test_ensure_id_idempotent() {
        let tmp = TempDir::new().unwrap();
        let path = write_test_file(tmp.path(), "note.md",
            "---\ntitle: \"Test\"\n---\n\nBody");
        let id1 = ensure_id_in_file(&path).unwrap();
        let content_after_first = fs::read_to_string(&path).unwrap();

        let id2 = ensure_id_in_file(&path).unwrap();
        let content_after_second = fs::read_to_string(&path).unwrap();

        assert_eq!(id1, id2);
        assert_eq!(content_after_first, content_after_second);
    }

    // ── replace_or_insert_id ─────────────────────────

    #[test]
    fn replace_id_swaps_existing_value_lf() {
        let original = "---\nid: \"20260101000001\"\ntitle: A\n---\n\nbody";
        let result = replace_or_insert_id(original, "20260505123456789");
        assert!(result.contains("id: \"20260505123456789\""), "new id present");
        assert!(!result.contains("20260101000001"), "old id removed");
        assert!(result.contains("title: A"), "siblings preserved");
        assert!(result.ends_with("\n\nbody"), "body preserved");
        // Single id line, no duplicate
        assert_eq!(result.matches("id:").count(), 1);
    }

    #[test]
    fn replace_id_preserves_crlf() {
        let original = "---\r\nid: \"20260101000001\"\r\ntitle: A\r\n---\r\n\r\nbody";
        let result = replace_or_insert_id(original, "20260505123456789");
        assert!(result.contains("id: \"20260505123456789\""));
        assert!(!result.contains("20260101000001"));
        assert!(result.contains("\r\ntitle: A\r\n"), "CRLF preserved");
        assert!(result.ends_with("\r\n\r\nbody"));
    }

    #[test]
    fn replace_id_inserts_when_frontmatter_has_no_id() {
        let original = "---\ntitle: A\ncreated: 2026-01-01\n---\n\nbody";
        let result = replace_or_insert_id(original, "20260505123456789");
        assert!(result.contains("id: \"20260505123456789\""));
        assert!(result.contains("title: A"));
        assert!(result.contains("created: 2026-01-01"));
        assert_eq!(result.matches("id:").count(), 1);
    }

    #[test]
    fn replace_id_no_frontmatter_falls_back_to_insert() {
        let original = "# Hello\n\nbody only";
        let result = replace_or_insert_id(original, "20260505123456789");
        assert!(result.starts_with("---\n"));
        assert!(result.contains("id: \"20260505123456789\""));
        assert!(result.contains("# Hello"));
        assert!(result.contains("body only"));
    }

    // ── broken frontmatter repair ─────────────────────

    #[test]
    fn insert_id_repairs_broken_frontmatter_missing_close() {
        // Real-world ghffltnpt.md case: opening fence + 7 stale id lines,
        // no closing fence. Should NOT prepend another id line — repair instead.
        let broken = "---\nid: \"20260505110338772\"\nid: \"20260505110324852\"\nid: \"20260505072355199\"\n\n# 내용\n\n$5$5$\n";
        let result = insert_id_into_content(broken, "20260505999999999");

        // Exactly ONE id line afterwards.
        assert_eq!(result.matches("id:").count(), 1, "duplicate id lines must be collapsed");
        assert!(result.contains("id: \"20260505999999999\""));
        // Closing fence present.
        let close_count = result.matches("\n---\n").count();
        assert!(close_count >= 1, "must have a closing fence after repair");
        // Body preserved.
        assert!(result.contains("# 내용"));
        assert!(result.contains("$5$5$"));
        // Old ids are gone.
        assert!(!result.contains("20260505110338772"));
        assert!(!result.contains("20260505110324852"));
    }

    #[test]
    fn insert_id_repairs_broken_fm_preserves_non_id_keys() {
        let broken = "---\nid: \"20260101000001\"\ntitle: My Note\nid: \"20260101000002\"\ncreated: 2026-01-01\n\nbody text\n";
        let result = insert_id_into_content(broken, "20260505999999999");

        assert_eq!(result.matches("id:").count(), 1);
        assert!(result.contains("title: My Note"), "non-id keys preserved");
        assert!(result.contains("created: 2026-01-01"));
        assert!(result.contains("body text"));
        // Must close.
        assert!(result.matches("\n---").count() >= 1);
    }

    #[test]
    fn insert_id_well_formed_unchanged_behavior() {
        // Sanity: well-formed frontmatter still gets a fresh id prepended (legacy behavior).
        let well_formed = "---\ntitle: A\n---\n\nbody";
        let result = insert_id_into_content(well_formed, "20260505999999999");
        assert!(result.starts_with("---\n"));
        assert!(result.contains("id: \"20260505999999999\""));
        assert!(result.contains("title: A"));
        assert!(result.contains("body"));
    }

    #[test]
    fn replace_or_insert_id_repairs_broken_via_fallback() {
        // replace_or_insert_id sees no close fence → falls back to repair path.
        let broken = "---\nid: \"20260101000001\"\nid: \"20260101000002\"\n\n# body\n";
        let result = replace_or_insert_id(broken, "20260505999999999");
        assert_eq!(result.matches("id:").count(), 1);
        assert!(result.contains("id: \"20260505999999999\""));
        assert!(result.contains("# body"));
    }
}
