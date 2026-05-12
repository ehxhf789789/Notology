//! Share module — OS native sharing for mobile platforms.

use std::path::Path;

/// Share a file via OS native share sheet.
#[tauri::command]
pub async fn share_file(
    path: String,
    mime_type: String,
    title: String,
) -> Result<(), String> {
    let _ = (&mime_type, &title);
    let file_path = Path::new(&path);
    if !file_path.exists() {
        return Err(format!("File not found: {}", path));
    }
    tauri_plugin_opener::open_path(file_path, None::<&str>)
        .map_err(|e| format!("Failed to share file: {}", e))
}

/// Share text content via OS native share sheet.
#[tauri::command]
pub async fn share_text(
    text: String,
    title: String,
) -> Result<(), String> {
    let _ = &title;
    if text.starts_with("http://") || text.starts_with("https://") {
        tauri_plugin_opener::open_url(&text, None::<&str>)
            .map_err(|e| format!("Failed to open URL: {}", e))
    } else {
        Err("Text sharing requires clipboard fallback".to_string())
    }
}
