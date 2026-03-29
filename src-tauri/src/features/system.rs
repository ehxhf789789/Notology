use std::fs;
use std::path::{Path, PathBuf};
use tauri::Manager;

use crate::core::types::{UrlMetadata, NasPlatformInfo};

#[tauri::command]
pub fn fetch_url_metadata(url: String) -> Result<UrlMetadata, String> {
    use scraper::{Html, Selector};

    let response = reqwest::blocking::get(&url)
        .map_err(|e| format!("Failed to fetch URL: {}", e))?;

    let html_content = response.text()
        .map_err(|e| format!("Failed to read response: {}", e))?;

    let document = Html::parse_document(&html_content);

    let get_meta = |property: &str| -> Option<String> {
        let selector = Selector::parse(&format!("meta[property='{}']", property)).ok()?;
        document.select(&selector).next()?.value().attr("content").map(String::from)
    };

    let get_meta_name = |name: &str| -> Option<String> {
        let selector = Selector::parse(&format!("meta[name='{}']", name)).ok()?;
        document.select(&selector).next()?.value().attr("content").map(String::from)
    };

    let title = get_meta("og:title")
        .or_else(|| {
            let selector = Selector::parse("title").ok()?;
            document.select(&selector).next()?.text().collect::<String>().trim().to_string().into()
        })
        .unwrap_or_else(|| url.clone());

    let description = get_meta("og:description")
        .or_else(|| get_meta_name("description"))
        .unwrap_or_default();

    let image = get_meta("og:image")
        .or_else(|| get_meta("twitter:image"))
        .unwrap_or_default();

    let favicon = {
        let base_url = url::Url::parse(&url).map_err(|e| format!("Invalid URL: {}", e))?;
        let icon_selector = Selector::parse("link[rel*='icon']").ok();

        if let Some(selector) = icon_selector {
            if let Some(link) = document.select(&selector).next() {
                if let Some(href) = link.value().attr("href") {
                    base_url.join(href).ok().map(|u| u.to_string())
                } else {
                    None
                }
            } else {
                None
            }
        } else {
            None
        }
        .unwrap_or_else(|| format!("{}://{}{}favicon.ico",
            base_url.scheme(),
            base_url.host_str().unwrap_or(""),
            if base_url.port().is_some() { format!(":{}", base_url.port().unwrap()) } else { String::new() }
        ))
    };

    Ok(UrlMetadata {
        title,
        description,
        image,
        favicon,
    })
}

#[tauri::command]
pub fn open_url_in_browser(url: String) -> Result<(), String> {
    opener::open(url).map_err(|e| format!("Failed to open URL: {}", e))
}

#[tauri::command]
pub fn detect_nas_platform(vault_path: String) -> Result<NasPlatformInfo, String> {
    let vault = Path::new(&vault_path);

    let mut current = Some(vault as &Path);
    let mut synology_marker_found = false;
    let mut synology_root: Option<PathBuf> = None;

    while let Some(dir) = current {
        let marker = dir.join(".SynologyDrive");
        if marker.is_dir() {
            synology_marker_found = true;
            synology_root = Some(dir.to_path_buf());
            break;
        }
        current = dir.parent();
    }

    let synology_client_running = is_synology_client_running();

    let path_str = vault_path.to_lowercase();
    let path_suggests_synology = path_str.contains("synologydrive")
        || path_str.contains("synology drive")
        || path_str.contains("cloudstation");

    let is_nas_synced = synology_marker_found || (synology_client_running && path_suggests_synology);

    Ok(NasPlatformInfo {
        is_nas_synced,
        platform: if synology_marker_found { "synology".to_string() } else { String::new() },
        synology_root: synology_root.map(|p| p.to_string_lossy().to_string()).unwrap_or_default(),
        synology_client_running,
    })
}

fn is_synology_client_running() -> bool {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;

        if let Ok(output) = std::process::Command::new("tasklist")
            .args(["/FI", "IMAGENAME eq SynologyDrive.exe", "/NH"])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
        {
            let stdout = String::from_utf8_lossy(&output.stdout);
            return stdout.contains("SynologyDrive.exe");
        }
        false
    }
    #[cfg(target_os = "macos")]
    {
        if let Ok(output) = std::process::Command::new("pgrep")
            .args(["-x", "Synology Drive Client"])
            .output()
        {
            return output.status.success();
        }
        false
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        false
    }
}

#[tauri::command]
pub fn cleanup_old_backups(vault_path: String) -> Result<usize, String> {
    let backup_dir = Path::new(&vault_path).join(".notology").join("backups");
    if !backup_dir.exists() {
        return Ok(0);
    }

    let cutoff =
        std::time::SystemTime::now() - std::time::Duration::from_secs(7 * 24 * 60 * 60);
    let mut removed = 0;

    if let Ok(entries) = fs::read_dir(&backup_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if let Ok(metadata) = path.metadata() {
                if let Ok(modified) = metadata.modified() {
                    if modified < cutoff {
                        if fs::remove_file(&path).is_ok() {
                            removed += 1;
                        }
                    }
                }
            }
        }
    }

    Ok(removed)
}

#[tauri::command]
pub fn set_window_icon(app: tauri::AppHandle, window_label: String, note_type: String) -> Result<(), String> {
    use tauri::Manager;
    use tauri::image::Image;
    use image::GenericImageView;

    let window = app.get_webview_window(&window_label)
        .ok_or_else(|| format!("Window '{}' not found", window_label))?;

    let icon_name = match note_type.to_uppercase().as_str() {
        "IMAGE" => "image.png",
        "PDF" => "pdf.png",
        "CODE" => "code.png",
        "WEB" => "web.png",
        "NOTE" | "MTG" | "EVENT" | "SEM" | "SKETCH" | "OFA" | "PAPER" | "LIT" | "DATA" | "THEO" | "CONTACT" => "note.png",
        _ => "note.png",
    };

    let icon_path = app.path().resource_dir()
        .map_err(|e| format!("Failed to get resource dir: {}", e))?
        .join("icons")
        .join(icon_name);

    if icon_path.exists() {
        let img = image::open(&icon_path)
            .map_err(|e| format!("Failed to load icon image: {}", e))?;
        let (width, height) = img.dimensions();
        let rgba = img.into_rgba8().into_raw();

        let icon = Image::new_owned(rgba, width, height);
        window.set_icon(icon)
            .map_err(|e| format!("Failed to set window icon: {}", e))?;
        log::info!("[set_window_icon] Set icon for window '{}' (type: {})", window_label, note_type);
    } else {
        log::warn!("[set_window_icon] Icon not found at {:?}, using default", icon_path);
    }

    Ok(())
}

#[tauri::command]
pub async fn create_hover_window(
    app: tauri::AppHandle,
    label: String,
    url: String,
    title: String,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
) -> Result<(), String> {
    use tauri::webview::{WebviewWindowBuilder, Color};
    use tauri::WebviewUrl;

    let is_light = url.contains("theme=light");
    let bg = if is_light {
        Color(245, 245, 245, 255)
    } else {
        Color(30, 30, 30, 255)
    };

    WebviewWindowBuilder::new(&app, &label, WebviewUrl::App(url.into()))
        .title(&title)
        .inner_size(width as f64, height as f64)
        .position(x as f64, y as f64)
        .decorations(false)
        .resizable(true)
        .focused(true)
        .visible(false)
        .min_inner_size(400.0, 300.0)
        .background_color(bg)
        .build()
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub fn get_gpu_config(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    let config_path = config_dir.join("gpu-config.json");
    if config_path.exists() {
        let content = fs::read_to_string(&config_path).map_err(|e| e.to_string())?;
        serde_json::from_str(&content).map_err(|e| e.to_string())
    } else {
        Ok(serde_json::json!({}))
    }
}

#[tauri::command]
pub fn set_gpu_config(app: tauri::AppHandle, config: serde_json::Value) -> Result<(), String> {
    let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&config_dir).map_err(|e| e.to_string())?;
    let config_path = config_dir.join("gpu-config.json");
    let content = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    fs::write(&config_path, content).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(feature = "devtools")]
#[tauri::command]
pub fn toggle_devtools(webview_window: tauri::WebviewWindow) {
    if webview_window.is_devtools_open() {
        webview_window.close_devtools();
    } else {
        webview_window.open_devtools();
    }
}

#[cfg(not(feature = "devtools"))]
#[tauri::command]
pub fn toggle_devtools() {
    // DevTools disabled in production build
}

/// GPU compatibility: Read gpu-config.json and set WebView2 browser args before Tauri init.
#[cfg(target_os = "windows")]
pub fn apply_gpu_config() {
    if let Ok(appdata) = std::env::var("APPDATA") {
        let config_path = PathBuf::from(&appdata)
            .join("com.notology.app")
            .join("gpu-config.json");
        if let Ok(content) = fs::read_to_string(&config_path) {
            if let Ok(config) = serde_json::from_str::<serde_json::Value>(&content) {
                if config.get("disableGpuCompositing").and_then(|v| v.as_bool()) == Some(true) {
                    std::env::set_var(
                        "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
                        "--disable-gpu-compositing",
                    );
                }
            }
        }
    }
}
