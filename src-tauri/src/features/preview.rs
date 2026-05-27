use std::fs;
use std::path::PathBuf;
use tauri::Manager;

/// Detect LibreOffice installation on Windows.
fn detect_libreoffice_path() -> Option<PathBuf> {
    let candidates = [
        r"C:\Program Files\LibreOffice\program\soffice.exe",
        r"C:\Program Files (x86)\LibreOffice\program\soffice.exe",
        r"C:\Program Files\LibreOffice 24.8\program\soffice.exe",
        r"C:\Program Files\LibreOffice 24.2\program\soffice.exe",
        r"C:\Program Files\LibreOffice 7.6\program\soffice.exe",
        r"C:\Program Files\LibreOffice 7.5\program\soffice.exe",
    ];

    for candidate in &candidates {
        let p = PathBuf::from(candidate);
        if p.exists() {
            return Some(p);
        }
    }

    if let Ok(output) = std::process::Command::new("where")
        .arg("soffice.exe")
        .output()
    {
        if output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            if let Some(line) = stdout.lines().next() {
                let p = PathBuf::from(line.trim());
                if p.exists() {
                    return Some(p);
                }
            }
        }
    }

    None
}

fn get_preview_cache_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let local_data = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    let cache_dir = local_data.join("preview-cache");
    fs::create_dir_all(&cache_dir).map_err(|e| format!("Failed to create preview cache dir: {}", e))?;
    Ok(cache_dir)
}

fn preview_cache_key(file_path: &str, mtime: u64) -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut hasher = DefaultHasher::new();
    file_path.hash(&mut hasher);
    let path_hash = hasher.finish();
    format!("{}_{}", path_hash, mtime)
}

const DOCUMENT_EXTENSIONS: &[&str] = &[
    "doc", "docx", "ppt", "pptx", "xls", "xlsx", "hwp", "hwpx",
];

fn is_document_extension(ext: &str) -> bool {
    DOCUMENT_EXTENSIONS.contains(&ext.to_lowercase().as_str())
}

#[tauri::command]
pub fn check_preview_engine() -> Result<serde_json::Value, String> {
    let lo_path = detect_libreoffice_path();
    Ok(serde_json::json!({
        "available": lo_path.is_some(),
        "engine": "libreoffice",
        "path": lo_path.map(|p| p.to_string_lossy().to_string()),
    }))
}

#[tauri::command]
pub async fn convert_to_preview_pdf(app: tauri::AppHandle, file_path: String) -> Result<String, String> {
    let source = PathBuf::from(&file_path);
    if !source.exists() {
        return Err(format!("File not found: {}", file_path));
    }

    let ext = source.extension()
        .and_then(|e| e.to_str())
        .unwrap_or("");
    if !is_document_extension(ext) {
        return Err(format!("Unsupported document type: .{}", ext));
    }

    let mtime = source.metadata()
        .and_then(|m| m.modified())
        .map(|t| t.duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs())
        .unwrap_or(0);

    let cache_dir = get_preview_cache_dir(&app)?;
    let cache_key = preview_cache_key(&file_path, mtime);
    let cached_pdf = cache_dir.join(format!("{}.pdf", cache_key));

    if cached_pdf.exists() {
        return Ok(cached_pdf.to_string_lossy().to_string());
    }

    let lo_path = detect_libreoffice_path()
        .ok_or_else(|| "LibreOffice not found. Install LibreOffice to preview documents.".to_string())?;

    let path_prefix = {
        use std::collections::hash_map::DefaultHasher;
        use std::hash::{Hash, Hasher};
        let mut hasher = DefaultHasher::new();
        file_path.hash(&mut hasher);
        format!("{}_", hasher.finish())
    };
    if let Ok(entries) = fs::read_dir(&cache_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            if name_str.starts_with(&path_prefix) && name_str.ends_with(".pdf") {
                let _ = fs::remove_file(entry.path());
            }
        }
    }

    let temp_dir = cache_dir.join("_converting");
    fs::create_dir_all(&temp_dir).map_err(|e| format!("Failed to create temp dir: {}", e))?;

    let lo_path_clone = lo_path.clone();
    let source_clone = source.clone();
    let temp_dir_clone = temp_dir.clone();

    let result = tokio::task::spawn_blocking(move || {
        let output = std::process::Command::new(&lo_path_clone)
            .arg("--headless")
            .arg("--norestore")
            .arg("--convert-to")
            .arg("pdf")
            .arg("--outdir")
            .arg(&temp_dir_clone)
            .arg(&source_clone)
            .output()
            .map_err(|e| format!("Failed to run LibreOffice: {}", e))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("LibreOffice conversion failed: {}", stderr));
        }

        Ok(())
    }).await.map_err(|e| format!("Conversion task panicked: {}", e))?;

    result?;

    let source_stem = source.file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("output");
    let converted_pdf = temp_dir.join(format!("{}.pdf", source_stem));

    if !converted_pdf.exists() {
        let found = fs::read_dir(&temp_dir)
            .map_err(|e| format!("Failed to read temp dir: {}", e))?
            .flatten()
            .find(|e| e.path().extension().and_then(|x| x.to_str()) == Some("pdf"));

        if let Some(found_entry) = found {
            fs::rename(found_entry.path(), &cached_pdf)
                .map_err(|e| format!("Failed to move converted PDF to cache: {}", e))?;
        } else {
            return Err("Conversion completed but no PDF file was produced.".to_string());
        }
    } else {
        fs::rename(&converted_pdf, &cached_pdf)
            .map_err(|e| format!("Failed to move converted PDF to cache: {}", e))?;
    }

    let _ = fs::remove_dir_all(&temp_dir);

    Ok(cached_pdf.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn cleanup_preview_cache(app: tauri::AppHandle, max_age_days: Option<u64>) -> Result<u32, String> {
    let cache_dir = get_preview_cache_dir(&app)?;
    let max_age_secs = max_age_days.unwrap_or(30) * 86400;
    let now = std::time::SystemTime::now();
    let mut removed = 0u32;

    if let Ok(entries) = fs::read_dir(&cache_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("pdf") {
                if let Ok(meta) = path.metadata() {
                    if let Ok(modified) = meta.modified() {
                        if let Ok(age) = now.duration_since(modified) {
                            if age.as_secs() > max_age_secs {
                                let _ = fs::remove_file(&path);
                                removed += 1;
                            }
                        }
                    }
                }
            }
        }
    }

    Ok(removed)
}

#[cfg(desktop)]
#[tauri::command]
pub async fn render_hwp_to_svg(path: String) -> Result<String, String> {
    use hwpers::HwpReader;
    use hwpers::render::{HwpRenderer, RenderOptions};

    tokio::task::spawn_blocking(move || -> Result<String, String> {
        let document = HwpReader::from_file(&path)
            .map_err(|e| format!("Failed to read HWP file: {}", e))?;

        let options = RenderOptions::default();
        let renderer = HwpRenderer::new(&document, options);

        let result = renderer.render();

        let mut combined_svg = String::new();
        combined_svg.push_str(r#"<div class="hwp-pages">"#);

        for page_idx in 0..result.pages.len() {
            if let Some(svg) = result.to_svg(page_idx) {
                combined_svg.push_str(&format!(r#"<div class="hwp-page" data-page="{}">{}</div>"#, page_idx + 1, svg));
            }
        }

        combined_svg.push_str("</div>");

        if result.pages.is_empty() {
            return Err("No pages found in HWP document".to_string());
        }

        Ok(combined_svg)
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?
}

#[cfg(not(desktop))]
#[tauri::command]
pub async fn render_hwp_to_svg(_path: String) -> Result<String, String> {
    Err("HWP rendering is not available on mobile".into())
}
