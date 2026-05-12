//! Track B Phase B-1 POC — External drag-out capability probe.
//!
//! Goal: when the user starts dragging an attachment chip from the editor,
//! produce a local file path that the frontend can attach to a DataTransfer
//! object (`text/uri-list` + `application/octet-stream`) so the OS can drop
//! the file onto another app (Desktop, KakaoTalk, Outlook, …).
//!
//! This is a POC. It is *not* wired into production drag handlers. The real
//! integration happens in Phase B-3 once we know which transport actually
//! works on WebView2 + Windows.
//!
//! Approach tested here = "Approach B" (per Phase B-1 spec):
//!   frontend dragstart  ─►  `attachment_prepare_drag` (this command)
//!   returns local path  ─►  setData('text/uri-list', file://<path>)
//!
//! If Approach B fails to produce a real file drop in target apps on Windows
//! (likely on WebView2), Phase B-3 escalates to Approach C — `tauri-plugin-drag`.

#![allow(dead_code)]

use std::path::{Path, PathBuf};

/// Result returned to the frontend dragstart handler.
#[derive(Debug, Clone, serde::Serialize)]
pub struct DragPayload {
    /// Absolute OS path (with native separators) to the file the user is dragging.
    /// Frontend converts to `file://...` URL before calling `dataTransfer.setData`.
    pub absolute_path: String,

    /// Just the file's display name (e.g. "Report.pdf"). Used by some target apps
    /// to suggest a filename when the drop creates a copy.
    pub file_name: String,

    /// MIME type for setData fallback (`application/octet-stream` for unknown).
    pub mime_type: String,

    /// File size in bytes — frontend can show a tooltip / abort huge drags.
    pub size_bytes: u64,

    /// Diagnostic: whether this path is on the same drive as %LOCALAPPDATA% (Windows).
    /// Cross-volume hardlinks fail; useful to know for Phase B-2 fallback decisions.
    pub same_volume_as_local: bool,
}

/// POC command. Validates the input path, gathers metadata, and returns a payload
/// the frontend can attach to a DataTransfer.
///
/// In production (Phase B-3) this will be replaced or wrapped by a resolver that
/// takes an `attachment_id` instead of a raw path, and exports from CAS if needed.
#[tauri::command]
pub fn attachment_drag_poc_prepare(absolute_path: String) -> Result<DragPayload, String> {
    let path = Path::new(&absolute_path);

    if !path.exists() {
        return Err(format!("file does not exist: {}", absolute_path));
    }
    if !path.is_file() {
        return Err(format!("not a regular file: {}", absolute_path));
    }

    let metadata = std::fs::metadata(path).map_err(|e| e.to_string())?;
    let size_bytes = metadata.len();

    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "invalid file name".to_string())?
        .to_string();

    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_lowercase())
        .unwrap_or_default();

    let mime_type = crate::features::sync_v2::attachment_types::AttachmentTier::mime_for_extension(&ext)
        .to_string();

    let same_volume_as_local = is_same_volume_as_local_appdata(path);

    Ok(DragPayload {
        absolute_path: path
            .canonicalize()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or(absolute_path),
        file_name,
        mime_type,
        size_bytes,
        same_volume_as_local,
    })
}

/// Heuristic: on Windows, two paths can have a hardlink iff they share a drive letter.
/// On Unix, same filesystem ≈ same device id. We approximate by drive-letter check
/// since the POC only needs an informational hint.
fn is_same_volume_as_local_appdata(path: &Path) -> bool {
    let appdata = match std::env::var_os("LOCALAPPDATA") {
        Some(s) => PathBuf::from(s),
        None => return false,
    };

    #[cfg(windows)]
    {
        let path_drive = path.components().next().and_then(|c| match c {
            std::path::Component::Prefix(p) => p.as_os_str().to_str().map(str::to_ascii_uppercase),
            _ => None,
        });
        let appdata_drive = appdata.components().next().and_then(|c| match c {
            std::path::Component::Prefix(p) => p.as_os_str().to_str().map(str::to_ascii_uppercase),
            _ => None,
        });
        return path_drive == appdata_drive && path_drive.is_some();
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let dev_a = std::fs::metadata(path).map(|m| m.dev()).ok();
        let dev_b = std::fs::metadata(&appdata).map(|m| m.dev()).ok();
        return dev_a.is_some() && dev_a == dev_b;
    }

    #[allow(unreachable_code)]
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn rejects_nonexistent_path() {
        let result = attachment_drag_poc_prepare("Z:/definitely/does/not/exist.pdf".to_string());
        assert!(result.is_err());
    }

    #[test]
    fn returns_metadata_for_real_file() {
        let mut tmp = std::env::temp_dir();
        tmp.push("notology_drag_poc_test.pdf");
        {
            let mut f = std::fs::File::create(&tmp).unwrap();
            f.write_all(b"%PDF-1.4 fake").unwrap();
        }
        let payload =
            attachment_drag_poc_prepare(tmp.to_string_lossy().to_string()).unwrap();
        assert_eq!(payload.file_name, "notology_drag_poc_test.pdf");
        assert_eq!(payload.mime_type, "application/pdf");
        assert_eq!(payload.size_bytes, 13);
        let _ = std::fs::remove_file(&tmp);
    }
}
