use std::fs;
use std::path::Path;
use std::sync::Mutex;

use crate::core::file_io::{atomic_write_file, get_file_lock, find_vault_root, backup_before_save, resolve_collision, copy_dir_recursive};
use crate::core::types::{FileNode, FileContent};
use crate::SearchState;

pub fn read_dir_recursive(path: &Path, depth: u32) -> Result<Vec<FileNode>, String> {
    let mut entries: Vec<FileNode> = Vec::new();

    let read_dir = fs::read_dir(path).map_err(|e| e.to_string())?;

    let parent_name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let folder_note_name = format!("{}.md", parent_name);

    for entry in read_dir {
        let entry = entry.map_err(|e| e.to_string())?;
        let entry_path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();

        if name.starts_with('.') {
            continue;
        }

        let is_dir = entry_path.is_dir();
        let is_folder_note = !is_dir && name == folder_note_name;

        let mtime = entry.metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs());

        let children = if is_dir && depth < 5 {
            Some(read_dir_recursive(&entry_path, depth + 1).unwrap_or_default())
        } else if is_dir {
            Some(Vec::new())
        } else {
            None
        };

        entries.push(FileNode {
            name,
            path: entry_path.to_string_lossy().to_string(),
            is_dir,
            is_folder_note,
            mtime,
            children,
        });
    }

    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(entries)
}

#[tauri::command]
pub fn read_directory(path: String) -> Result<Vec<FileNode>, String> {
    let dir_path = Path::new(&path);
    if !dir_path.is_dir() {
        return Err("Not a valid directory".to_string());
    }
    read_dir_recursive(dir_path, 0)
}

#[tauri::command]
pub fn read_file(path: String) -> Result<FileContent, String> {
    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;

    if content.starts_with("---") {
        if let Some(end_idx) = content[3..].find("\n---") {
            let frontmatter = content[3..end_idx + 3].trim().to_string();
            let body_start = end_idx + 3 + 4;
            let body = if body_start < content.len() {
                content[body_start..].trim_start_matches('\n').to_string()
            } else {
                String::new()
            };
            return Ok(FileContent {
                frontmatter: Some(frontmatter),
                body,
            });
        }
    }

    Ok(FileContent {
        frontmatter: None,
        body: content,
    })
}

#[tauri::command]
pub fn read_text_file(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn write_file(
    path: String,
    frontmatter: Option<String>,
    body: String,
    _state: tauri::State<'_, Mutex<SearchState>>,
) -> Result<(), String> {
    let trimmed_body = body.trim_start();
    let is_canvas = trimmed_body.starts_with('{') && trimmed_body.contains("\"nodes\":");

    // SKETCH protection: if existing file is canvas but new body is NOT canvas, block the save
    if !is_canvas {
        if let Ok(existing) = std::fs::read_to_string(&path) {
            let has_canvas_fm = existing.contains("canvas: true") || existing.contains("canvas:true");
            let existing_body = existing.split("---").nth(2).unwrap_or("").trim_start();
            let existing_is_canvas = existing_body.starts_with('{') && existing_body.contains("\"nodes\":");
            if has_canvas_fm || existing_is_canvas {
                log::warn!("[write_file] BLOCKED: TipTap trying to overwrite SKETCH file with markdown: {}", path);
                return Err("SKETCH_PROTECTED".to_string());
            }
        }
    }

    log::info!("[write_file] path={} fm_len={:?} is_canvas={} body_len={}", path, frontmatter.as_ref().map(|s| s.len()), is_canvas, body.len());

    let content = match &frontmatter {
        Some(fm) if is_canvas && (fm.trim().is_empty() || !fm.contains("canvas")) => {
            // Canvas body with missing/empty/wrong frontmatter → force SKETCH frontmatter
            let title = Path::new(&path).file_stem()
                .map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
            log::warn!("[write_file] Restoring SKETCH frontmatter for: {}", path);
            format!("---\ntype: SKETCH\ncanvas: true\ntitle: \"{}\"\ncssclasses:\n  - sketch-type\ntags: []\n---\n\n{}", title, body)
        }
        Some(fm) => format!("---\n{}\n---\n\n{}", fm, body),
        None if is_canvas => {
            // Canvas body with no frontmatter → force SKETCH frontmatter
            let title = Path::new(&path).file_stem()
                .map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
            log::warn!("[write_file] Adding SKETCH frontmatter for: {}", path);
            format!("---\ntype: SKETCH\ncanvas: true\ntitle: \"{}\"\ncssclasses:\n  - sketch-type\ntags: []\n---\n\n{}", title, body)
        }
        None => body,
    };

    let lock = get_file_lock(&path);
    let _guard = lock.lock().map_err(|e| format!("File lock poisoned: {}", e))?;

    if let Some(vault_root) = find_vault_root(Path::new(&path)) {
        if let Err(e) = backup_before_save(Path::new(&path), &vault_root) {
            log::warn!("Backup before save failed (non-fatal): {}", e);
        }
    }

    atomic_write_file(Path::new(&path), content.as_bytes())?;

    Ok(())
}

#[tauri::command]
pub fn create_note(
    dir_path: String,
    title: String,
    note_type: Option<String>,
    _state: tauri::State<'_, Mutex<SearchState>>,
) -> Result<String, String> {
    let file_name = format!("{}.md", title);
    let file_path = Path::new(&dir_path).join(&file_name);

    if file_path.exists() {
        return Err("File already exists".to_string());
    }

    let now = chrono::Local::now();
    let datetime = now.format("%Y-%m-%dT%H:%M:%S%:z").to_string();
    let ntype = note_type.unwrap_or_else(|| "NOTE".to_string());

    let content = format!(
        "---\ncreated: \"{}\"\nmodified: \"{}\"\ntitle: \"{}\"\ntype: \"{}\"\ntags: []\n---\n\n",
        datetime, datetime, title, ntype
    );

    atomic_write_file(&file_path, content.as_bytes())?;

    log::debug!("[create_note] Created and synced: {:?}", file_path);
    Ok(file_path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn create_folder(
    parent_path: String,
    name: String,
    template_frontmatter: Option<String>,
    template_body: Option<String>,
    _state: tauri::State<'_, Mutex<SearchState>>,
) -> Result<String, String> {
    let folder_path = Path::new(&parent_path).join(&name);

    if folder_path.exists() {
        return Err("Folder already exists".to_string());
    }

    fs::create_dir(&folder_path).map_err(|e| e.to_string())?;

    let note_name = format!("{}.md", name);
    let note_path = folder_path.join(&note_name);
    let now = chrono::Local::now();
    let datetime = now.format("%Y-%m-%dT%H:%M:%S%:z").to_string();

    let frontmatter = template_frontmatter.unwrap_or_else(|| {
        format!(
            "created: \"{}\"\nmodified: \"{}\"\ntitle: \"{}\"\ntype: \"FOLDER\"\ncssclasses: []\ntags: []",
            datetime, datetime, name
        )
    });

    let body = template_body.unwrap_or_default();
    let content = format!("---\n{}\n---\n\n{}", frontmatter, body);

    atomic_write_file(&note_path, content.as_bytes())?;

    log::debug!("[create_folder] Created and synced folder note: {:?}", note_path);
    Ok(folder_path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn ensure_directory(path: String) -> Result<(), String> {
    fs::create_dir_all(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_files_in_directory(path: String, extension: String) -> Result<Vec<String>, String> {
    let dir_path = Path::new(&path);
    if !dir_path.exists() {
        return Ok(Vec::new());
    }
    if !dir_path.is_dir() {
        return Err("Not a valid directory".to_string());
    }

    let mut files: Vec<String> = Vec::new();
    let ext_with_dot = format!(".{}", extension);

    for entry in fs::read_dir(dir_path).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let file_name = entry.file_name().to_string_lossy().to_string();

        if entry.path().is_file() && file_name.ends_with(&ext_with_dot) {
            files.push(file_name);
        }
    }

    files.sort();
    Ok(files)
}

#[tauri::command]
pub fn move_file(old_path: String, new_path: String) -> Result<(), String> {
    let old = Path::new(&old_path);
    let new = Path::new(&new_path);

    if !old.exists() {
        return Err("Source file does not exist".to_string());
    }
    if new.exists() {
        return Err("Destination already exists".to_string());
    }

    if let Some(parent) = new.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
    }

    fs::rename(old, new).map_err(|e| {
        if let Ok(_) = fs::copy(old, new) {
            let _ = fs::remove_file(old);
            return "".to_string();
        }
        e.to_string()
    })?;

    Ok(())
}

#[tauri::command]
pub fn check_file_exists(path: String) -> bool {
    Path::new(&path).exists()
}

#[tauri::command]
pub fn delete_file(path: String) -> Result<(), String> {
    let file_path = Path::new(&path);
    if !file_path.exists() {
        return Err("File does not exist".to_string());
    }
    fs::remove_file(file_path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_folder(path: String) -> Result<(), String> {
    let folder_path = Path::new(&path);
    if !folder_path.exists() {
        return Err("Folder does not exist".to_string());
    }
    if !folder_path.is_dir() {
        return Err("Path is not a directory".to_string());
    }
    fs::remove_dir_all(folder_path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn import_file(source_path: String, vault_path: String, target_dir: Option<String>) -> Result<String, String> {
    let source = Path::new(&source_path);
    if !source.exists() {
        return Err("Source file does not exist".to_string());
    }

    let file_name = source
        .file_name()
        .ok_or("Invalid source file name")?
        .to_string_lossy()
        .to_string();

    let target_parent = if let Some(dir) = target_dir {
        std::path::PathBuf::from(dir)
    } else {
        std::path::PathBuf::from(&vault_path)
    };

    if !target_parent.exists() {
        fs::create_dir_all(&target_parent).map_err(|e| e.to_string())?;
    }

    let target = target_parent.join(&file_name);
    let final_target = resolve_collision(&target);

    fs::copy(source, &final_target).map_err(|e| e.to_string())?;

    Ok(final_target.to_string_lossy().to_string())
}

#[tauri::command]
pub fn import_attachment(source_path: String, note_path: String) -> Result<String, String> {
    let source = Path::new(&source_path);
    if !source.exists() {
        return Err("Source file does not exist".to_string());
    }

    let note = Path::new(&note_path);

    let is_in_att_folder = note.components().any(|c| {
        if let std::path::Component::Normal(name) = c {
            name.to_string_lossy().ends_with("_att")
        } else {
            false
        }
    });

    if is_in_att_folder {
        return Err("Cannot import attachments to files inside _att folders".to_string());
    }

    let note_stem = note
        .file_stem()
        .ok_or("Invalid note path")?
        .to_string_lossy()
        .to_string();
    let note_dir = note.parent().ok_or("Invalid note path")?;

    let attachments_dir = note_dir.join(format!("{}_att", note_stem));
    if !attachments_dir.exists() {
        fs::create_dir(&attachments_dir).map_err(|e| e.to_string())?;
    }

    let file_name = source
        .file_name()
        .ok_or("Invalid source file name")?
        .to_string_lossy()
        .to_string();
    let target = attachments_dir.join(&file_name);
    let final_target = resolve_collision(&target);

    fs::copy(source, &final_target).map_err(|e| e.to_string())?;

    Ok(final_target.to_string_lossy().to_string())
}

#[tauri::command]
pub fn move_note(note_path: String, new_dir: String) -> Result<String, String> {
    let old = Path::new(&note_path);
    if !old.exists() {
        return Err("Note does not exist".to_string());
    }

    let stem = old
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    let old_dir = old.parent().ok_or("Invalid note path")?;
    let attachments_name = format!("{}_att", stem);
    let old_att = old_dir.join(&attachments_name);

    let new_parent = Path::new(&new_dir);
    if !new_parent.exists() {
        fs::create_dir_all(new_parent).map_err(|e| e.to_string())?;
    }

    let new_note = new_parent.join(old.file_name().unwrap());
    if new_note.exists() {
        return Err("Destination note already exists".to_string());
    }
    fs::rename(old, &new_note).or_else(|_| {
        fs::copy(old, &new_note).map_err(|e| e.to_string())?;
        fs::remove_file(old).map_err(|e| e.to_string())
    })?;

    if old_att.exists() && old_att.is_dir() {
        let new_att = new_parent.join(&attachments_name);
        fs::rename(&old_att, &new_att).or_else(|_| {
            copy_dir_recursive(&old_att, &new_att)?;
            fs::remove_dir_all(&old_att).map_err(|e| e.to_string())
        })?;
    }

    Ok(new_note.to_string_lossy().to_string())
}

#[tauri::command]
pub fn create_note_with_template(
    dir_path: String,
    file_name: String,
    frontmatter_yaml: String,
    body: String,
) -> Result<String, String> {
    let dir = Path::new(&dir_path);
    if !dir.exists() {
        return Err("Directory does not exist".to_string());
    }

    let target = dir.join(format!("{}.md", file_name));
    let final_path = resolve_collision(&target);

    let content = format!("---\n{}\n---\n\n{}", frontmatter_yaml, body);

    atomic_write_file(&final_path, content.as_bytes())?;

    log::debug!("[create_note_with_template] Created and synced: {:?}", final_path);
    Ok(final_path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn delete_note(note_path: String) -> Result<(), String> {
    let path = Path::new(&note_path);
    if !path.exists() {
        return Err("Note does not exist".to_string());
    }

    let stem = path.file_stem().unwrap_or_default().to_string_lossy().to_string();
    let parent = path.parent().unwrap();
    let attachments_dir = parent.join(format!("{}_att", stem));
    if attachments_dir.exists() && attachments_dir.is_dir() {
        fs::remove_dir_all(&attachments_dir).map_err(|e| e.to_string())?;
    }

    fs::remove_file(path).map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub fn update_note_frontmatter(
    note_path: String,
    new_frontmatter_yaml: String,
) -> Result<(), String> {
    let path = Path::new(&note_path);
    if !path.exists() {
        return Err("Note does not exist".to_string());
    }

    let lock = get_file_lock(&note_path);
    let _guard = lock.lock().map_err(|e| format!("File lock poisoned: {}", e))?;

    if let Some(vault_root) = find_vault_root(path) {
        if let Err(e) = backup_before_save(path, &vault_root) {
            log::warn!("Backup before frontmatter update failed (non-fatal): {}", e);
        }
    }

    let content = fs::read_to_string(path).map_err(|e| e.to_string())?;

    let new_content = if content.starts_with("---") {
        if let Some(end_idx) = content[3..].find("\n---") {
            let body = &content[3 + end_idx + 4..];
            format!("---\n{}\n---{}", new_frontmatter_yaml, body)
        } else {
            format!("---\n{}\n---\n\n{}", new_frontmatter_yaml, content)
        }
    } else {
        format!("---\n{}\n---\n\n{}", new_frontmatter_yaml, content)
    };

    atomic_write_file(path, new_content.as_bytes())?;
    Ok(())
}

#[tauri::command]
pub fn touch_note_modified(note_path: String) -> Result<(), String> {
    let path = Path::new(&note_path);
    if !path.exists() {
        return Err("Note does not exist".to_string());
    }

    let lock = get_file_lock(&note_path);
    let _guard = lock.lock().map_err(|e| format!("File lock poisoned: {}", e))?;

    if let Some(vault_root) = find_vault_root(path) {
        if let Err(e) = backup_before_save(path, &vault_root) {
            log::warn!("Backup before touch_note_modified failed (non-fatal): {}", e);
        }
    }

    let content = fs::read_to_string(path).map_err(|e| e.to_string())?;
    if !content.starts_with("---") {
        return Ok(());
    }

    let end_idx = match content[3..].find("\n---") {
        Some(idx) => idx,
        None => return Ok(()),
    };

    let fm_section = &content[4..3 + end_idx];
    let body = &content[3 + end_idx + 4..];
    let now = chrono::Local::now().format("%Y-%m-%dT%H:%M:%S%:z").to_string();

    let updated_fm = if let Some(mod_start) = fm_section.find("\nmodified:") {
        let line_end = fm_section[mod_start + 1..]
            .find('\n')
            .map(|i| mod_start + 1 + i)
            .unwrap_or(fm_section.len());
        format!(
            "{}modified: \"{}\"{}",
            &fm_section[..mod_start + 1],
            now,
            &fm_section[line_end..]
        )
    } else if fm_section.starts_with("modified:") {
        let line_end = fm_section.find('\n').unwrap_or(fm_section.len());
        format!("modified: \"{}\"{}", now, &fm_section[line_end..])
    } else {
        format!("{}\nmodified: \"{}\"", fm_section, now)
    };

    let new_content = format!("---\n{}\n---{}", updated_fm, body);
    atomic_write_file(path, new_content.as_bytes())?;
    Ok(())
}

#[tauri::command]
pub fn open_in_default_app(path: String) -> Result<(), String> {
    opener::open(Path::new(&path)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn reveal_in_explorer(path: String) -> Result<(), String> {
    let target = Path::new(&path);

    if target.is_dir() {
        return opener::open(target).map_err(|e| e.to_string());
    }

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x00000008;
        std::process::Command::new("explorer")
            .raw_arg(format!("/select,\"{}\"", path))
            .creation_flags(DETACHED_PROCESS)
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-R")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    #[cfg(target_os = "linux")]
    {
        let dbus_result = std::process::Command::new("dbus-send")
            .args(&[
                "--session",
                "--dest=org.freedesktop.FileManager1",
                "--type=method_call",
                "/org/freedesktop/FileManager1",
                "org.freedesktop.FileManager1.ShowItems",
                &format!("array:string:file://{}", path),
                "string:",
            ])
            .spawn();

        if dbus_result.is_ok() {
            Ok(())
        } else {
            let dir = target.parent().unwrap_or(target);
            opener::open(dir).map_err(|e| e.to_string())
        }
    }
}

/// Read a file as binary bytes (for JavaScript document viewers).
#[tauri::command]
pub async fn read_binary_file(path: String) -> Result<Vec<u8>, String> {
    tokio::fs::read(&path).await
        .map_err(|e| format!("Failed to read file: {}", e))
}
