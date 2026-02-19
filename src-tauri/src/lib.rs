// Allow unused code for future features
#![allow(dead_code)]

pub mod search;
pub mod vault_lock;
mod frontmatter;
mod memo;

#[cfg(test)]
mod lib_test;

#[cfg(test)]
mod search_latency_test;

#[cfg(test)]
mod attachment_edge_cases_test;

#[cfg(test)]
mod wikilink_rename_test;

#[cfg(test)]
mod massive_rename_test;

#[cfg(test)]
mod massive_search_test;

#[cfg(test)]
mod wikilink_update_massive_test;

#[cfg(test)]
mod html_span_wikilink_test;

#[cfg(test)]
mod canvas_functionality_test;

#[cfg(test)]
mod attachment_cleanup_test;

#[cfg(test)]
mod memo_bottleneck_test;

#[cfg(test)]
mod canvas_memo_test;

#[cfg(test)]
mod indent_integration_test;

#[cfg(test)]
mod attachment_wikilink_sync_test;

#[cfg(test)]
mod synology_safety_test;

use rayon::prelude::*;
use regex::Regex;
use frontmatter::FrontmatterParser;
use serde::{Serialize, Deserialize};
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, Ordering};
use once_cell::sync::Lazy;
use opener;
use tauri::{Manager, Emitter};

use search::{SearchIndex, NoteFilter, NoteMetadata, RelationshipData, GraphData, SearchResult as IndexSearchResult};
use search::watcher::VaultWatcher;

/// State for cancellable bulk tag operations
pub struct BulkOperationState {
    pub cancel_requested: AtomicBool,
}

/// Per-file mutex to prevent concurrent read-modify-write races.
/// Without this, write_file, update_note_frontmatter, and touch_note_modified
/// can interleave reads and writes, causing data loss (TOCTOU race).
static FILE_LOCKS: Lazy<Mutex<HashMap<String, Arc<Mutex<()>>>>> = Lazy::new(|| {
    Mutex::new(HashMap::new())
});

fn get_file_lock(path: &str) -> Arc<Mutex<()>> {
    let mut locks = FILE_LOCKS.lock().unwrap();
    locks.entry(path.to_string())
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone()
}

/// Atomic file write: write to a temp file in the same directory, then rename.
/// This prevents Synology Drive (or any file watcher) from syncing a partially-written file.
/// When File::create is used directly, the file is truncated to 0 bytes first — if Synology
/// picks up the file between truncation and write completion, a corrupt file gets synced.
fn atomic_write_file(path: &Path, content: &[u8]) -> Result<(), String> {
    use std::io::Write;

    let file_name = path.file_name().unwrap_or_default().to_string_lossy();
    let temp_path = path.with_file_name(format!("{}.notology-tmp", file_name));

    let mut file = fs::File::create(&temp_path)
        .map_err(|e| format!("Failed to create temp file {:?}: {}", temp_path, e))?;
    file.write_all(content)
        .map_err(|e| format!("Failed to write temp file {:?}: {}", temp_path, e))?;
    file.sync_all()
        .map_err(|e| format!("Failed to sync temp file {:?}: {}", temp_path, e))?;
    drop(file);

    fs::rename(&temp_path, path)
        .map_err(|e| format!("Failed to rename {:?} -> {:?}: {}", temp_path, path, e))?;

    Ok(())
}
/// Modify a tag in a frontmatter YAML string.
/// If `new_name` is Some, renames old_name → new_name.
/// If `new_name` is None, removes old_name.
/// Returns the modified YAML string if the tag was found, or None if not found.
fn modify_tag_in_frontmatter_yaml(
    yaml_str: &str,
    namespace: &str,
    old_name: &str,
    new_name: Option<&str>,
) -> Result<Option<String>, String> {
    let mut value: serde_yaml::Value =
        serde_yaml::from_str(yaml_str).map_err(|e| format!("YAML parse error: {}", e))?;

    let tags = match value.get_mut("tags") {
        Some(t) => t,
        None => return Ok(None), // No tags section
    };

    let ns_value = match tags.get_mut(namespace) {
        Some(v) => v,
        None => return Ok(None), // Namespace not found
    };

    let seq = match ns_value.as_sequence_mut() {
        Some(s) => s,
        None => return Ok(None), // Not a sequence
    };

    // Find the tag in the sequence
    let mut found = false;

    if let Some(new) = new_name {
        // Rename: replace old_name with new_name
        for item in seq.iter_mut() {
            if let Some(s) = item.as_str() {
                if s == old_name {
                    *item = serde_yaml::Value::String(new.to_string());
                    found = true;
                }
            }
        }
    } else {
        // Delete: remove old_name
        seq.retain(|item| {
            if let Some(s) = item.as_str() {
                if s == old_name {
                    found = true;
                    return false; // Remove
                }
            }
            true
        });
    }

    if !found {
        return Ok(None);
    }

    // If namespace array is now empty after deletion, remove the key
    if new_name.is_none() && seq.is_empty() {
        if let Some(tags_map) = tags.as_mapping_mut() {
            tags_map.remove(&serde_yaml::Value::String(namespace.to_string()));
        }
    }

    let result = serde_yaml::to_string(&value).map_err(|e| format!("YAML serialize error: {}", e))?;
    // serde_yaml adds a trailing newline; trim it for consistency
    Ok(Some(result.trim_end_matches('\n').to_string()))
}

use memo::{MemoIndex, MemoQueryFilter, IndexedMemo};

struct SearchState {
    index: Option<Arc<SearchIndex>>,
    _watcher: Option<VaultWatcher>,
    memo_index: Option<Arc<MemoIndex>>,
    init_in_progress: bool,
}

#[derive(Serialize)]
pub struct FileNode {
    name: String,
    path: String,
    is_dir: bool,
    is_folder_note: bool,
    mtime: Option<u64>, // Modification time in seconds since UNIX epoch
    children: Option<Vec<FileNode>>,
}

#[derive(Serialize)]
pub struct FileContent {
    frontmatter: Option<String>,
    body: String,
}

#[derive(Serialize)]
pub struct AttachmentInfo {
    path: String,
    file_name: String,
    note_path: String,
    note_name: String,
    note_relative_path: String,
    inferred_note_path: String, // Always shows the note path inferred from _att folder
    container: String,
    is_conflict: bool,          // Synology Drive conflict file
    conflict_original: String,  // Original file path (empty if not a conflict)
}

/// File info for attachment suggestions (includes mtime for sorting)
#[derive(Serialize)]
pub struct AttachmentFileInfo {
    file_name: String,
    path: String,      // Relative path within _att folder
    is_image: bool,
    mtime: u64,        // Modification time in seconds since UNIX epoch
}

#[derive(Serialize)]
pub struct BacklinkResult {
    file_path: String,
    file_name: String,
    line_number: u32,
    context: String,
}

// Frontmatter commands
// UNUSED: Not invoked from frontend
#[tauri::command]
fn parse_frontmatter(content: String) -> Result<serde_json::Value, String> {
    let (frontmatter, body) = FrontmatterParser::parse(&content)?;

    Ok(serde_json::json!({
        "frontmatter": frontmatter,
        "body": body
    }))
}

// UNUSED: Not invoked from frontend
#[tauri::command]
fn validate_frontmatter(frontmatter_json: String) -> Result<Vec<frontmatter::types::ValidationError>, String> {
    let fm: frontmatter::types::Frontmatter = serde_json::from_str(&frontmatter_json)
        .map_err(|e| format!("Invalid frontmatter JSON: {}", e))?;

    FrontmatterParser::validate(&fm)
}

// UNUSED: Not invoked from frontend
#[tauri::command]
fn frontmatter_to_yaml(frontmatter_json: String) -> Result<String, String> {
    let fm: frontmatter::types::Frontmatter = serde_json::from_str(&frontmatter_json)
        .map_err(|e| format!("Invalid frontmatter JSON: {}", e))?;

    FrontmatterParser::to_yaml(&fm)
}

// UNUSED: Not invoked from frontend
#[tauri::command]
fn yaml_to_frontmatter(yaml_str: String) -> Result<frontmatter::types::Frontmatter, String> {
    FrontmatterParser::parse_yaml(&yaml_str)
}

// UNUSED: Not invoked from frontend
#[tauri::command]
fn generate_suggestions(
    frontmatter_json: String,
    all_notes_json: String,
) -> Result<Vec<frontmatter::suggestions::Suggestion>, String> {
    let fm: frontmatter::types::Frontmatter = serde_json::from_str(&frontmatter_json)
        .map_err(|e| format!("Invalid frontmatter JSON: {}", e))?;

    let all_notes: Vec<frontmatter::types::Frontmatter> = serde_json::from_str(&all_notes_json)
        .map_err(|e| format!("Invalid all_notes JSON: {}", e))?;

    let suggestions = frontmatter::suggestions::SuggestionEngine::generate_suggestions(&fm, &all_notes);
    Ok(suggestions)
}

#[tauri::command]
fn read_directory(path: String) -> Result<Vec<FileNode>, String> {
    let dir_path = Path::new(&path);
    if !dir_path.is_dir() {
        return Err("Not a valid directory".to_string());
    }
    read_dir_recursive(dir_path, 0)
}

fn read_dir_recursive(path: &Path, depth: u32) -> Result<Vec<FileNode>, String> {
    let mut entries: Vec<FileNode> = Vec::new();

    let read_dir = fs::read_dir(path).map_err(|e| e.to_string())?;

    // Get the parent folder name for folder note detection
    let parent_name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let folder_note_name = format!("{}.md", parent_name);

    for entry in read_dir {
        let entry = entry.map_err(|e| e.to_string())?;
        let entry_path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();

        // Skip hidden files/folders
        if name.starts_with('.') {
            continue;
        }

        let is_dir = entry_path.is_dir();
        let is_folder_note = !is_dir && name == folder_note_name;

        // Get modification time (seconds since UNIX epoch)
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

    // Sort: directories first, then alphabetically
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(entries)
}

fn resolve_collision(target: &Path) -> PathBuf {
    if !target.exists() {
        return target.to_path_buf();
    }
    let stem = target
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    let ext = target
        .extension()
        .map(|e| e.to_string_lossy().to_string());
    let parent = target.parent().unwrap();
    let mut counter = 1;
    loop {
        let new_name = match &ext {
            Some(e) => format!("{}_{}.{}", stem, counter, e),
            None => format!("{}_{}", stem, counter),
        };
        let candidate = parent.join(&new_name);
        if !candidate.exists() {
            return candidate;
        }
        counter += 1;
    }
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(src).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let entry_path = entry.path();
        let dest_path = dst.join(entry.file_name());
        if entry_path.is_dir() {
            copy_dir_recursive(&entry_path, &dest_path)?;
        } else {
            fs::copy(&entry_path, &dest_path).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
fn read_file(path: String) -> Result<FileContent, String> {
    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;

    // Parse frontmatter if present (between --- delimiters)
    if content.starts_with("---") {
        if let Some(end_idx) = content[3..].find("\n---") {
            let frontmatter = content[3..end_idx + 3].trim().to_string();
            let body_start = end_idx + 3 + 4; // skip "\n---"
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
fn read_text_file(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
async fn write_file(
    path: String,
    frontmatter: Option<String>,
    body: String,
    _state: tauri::State<'_, Mutex<SearchState>>,
) -> Result<(), String> {
    let content = match frontmatter {
        Some(fm) => format!("---\n{}\n---\n\n{}", fm, body),
        None => body,
    };

    // Per-file lock: prevent concurrent read-modify-write races with
    // update_note_frontmatter and touch_note_modified
    let lock = get_file_lock(&path);
    let _guard = lock.lock().map_err(|e| format!("File lock poisoned: {}", e))?;

    // Backup before overwriting (best effort — don't fail if backup fails)
    if let Some(vault_root) = find_vault_root(Path::new(&path)) {
        if let Err(e) = backup_before_save(Path::new(&path), &vault_root) {
            log::warn!("Backup before save failed (non-fatal): {}", e);
        }
    }

    // Atomic write: write to temp file then rename to prevent partial file sync
    atomic_write_file(Path::new(&path), content.as_bytes())?;

    Ok(())
}

// UNUSED: Not invoked from frontend
#[tauri::command]
fn create_note(
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

    // Atomic write: write to temp file then rename to prevent partial file sync
    atomic_write_file(&file_path, content.as_bytes())?;

    log::debug!("[create_note] Created and synced: {:?}", file_path);
    Ok(file_path.to_string_lossy().to_string())
}

// UNUSED: Not invoked from frontend
#[tauri::command]
fn create_folder(
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

    // Create the folder note automatically
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

    // Atomic write: write to temp file then rename to prevent partial file sync
    atomic_write_file(&note_path, content.as_bytes())?;

    log::debug!("[create_folder] Created and synced folder note: {:?}", note_path);
    Ok(folder_path.to_string_lossy().to_string())
}

#[tauri::command]
fn ensure_directory(path: String) -> Result<(), String> {
    fs::create_dir_all(&path).map_err(|e| e.to_string())
}

/// List files in a directory with a specific extension
// UNUSED: Not invoked from frontend
#[tauri::command]
fn list_files_in_directory(path: String, extension: String) -> Result<Vec<String>, String> {
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

/// Read attachment folder contents with mtime for sorting
/// Returns files sorted by mtime (most recently modified first)
#[tauri::command]
fn read_attachment_folder(att_folder_path: String, query: String) -> Result<Vec<AttachmentFileInfo>, String> {
    let dir_path = Path::new(&att_folder_path);
    if !dir_path.exists() || !dir_path.is_dir() {
        return Ok(Vec::new());
    }

    let lower_query = query.to_lowercase();
    let mut results: Vec<AttachmentFileInfo> = Vec::new();

    // Image extensions
    const IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"];

    fn collect_files(
        dir: &Path,
        base_path: &Path,
        query: &str,
        image_exts: &[&str],
        results: &mut Vec<AttachmentFileInfo>,
    ) -> Result<(), String> {
        let entries = fs::read_dir(dir).map_err(|e| e.to_string())?;

        for entry in entries {
            let entry = entry.map_err(|e| e.to_string())?;
            let entry_path = entry.path();
            let file_name = entry.file_name().to_string_lossy().to_string();

            // Skip hidden files
            if file_name.starts_with('.') {
                continue;
            }

            if entry_path.is_dir() {
                // Recurse into subdirectories
                collect_files(&entry_path, base_path, query, image_exts, results)?;
            } else if entry_path.is_file() {
                // Get relative path from base _att folder
                let relative_path = entry_path
                    .strip_prefix(base_path)
                    .map(|p| p.to_string_lossy().to_string())
                    .unwrap_or_else(|_| file_name.clone());

                // Filter by query
                if query.is_empty() || relative_path.to_lowercase().contains(query) {
                    // Get modification time
                    let mtime = entry.metadata()
                        .ok()
                        .and_then(|m| m.modified().ok())
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_secs())
                        .unwrap_or(0);

                    // Check if image
                    let ext = entry_path.extension()
                        .map(|e| e.to_string_lossy().to_lowercase())
                        .unwrap_or_default();
                    let is_image = image_exts.contains(&ext.as_str());

                    results.push(AttachmentFileInfo {
                        file_name: relative_path.clone(),
                        path: relative_path,
                        is_image,
                        mtime,
                    });
                }
            }
        }
        Ok(())
    }

    collect_files(dir_path, dir_path, &lower_query, IMAGE_EXTENSIONS, &mut results)?;

    // Sort by mtime descending (most recent first)
    results.sort_by(|a, b| b.mtime.cmp(&a.mtime));

    // Limit to 15 results
    results.truncate(15);

    Ok(results)
}

// UNUSED: Not invoked from frontend
#[tauri::command]
fn search_backlinks(vault_path: String, file_name: String) -> Result<Vec<BacklinkResult>, String> {
    let pattern = format!(r"\[\[{}\]\]", regex::escape(&file_name));
    let re = Regex::new(&pattern).map_err(|e| e.to_string())?;

    let mut results: Vec<BacklinkResult> = Vec::new();
    search_backlinks_recursive(Path::new(&vault_path), &re, &mut results)?;
    Ok(results)
}

fn search_backlinks_recursive(
    path: &Path,
    re: &Regex,
    results: &mut Vec<BacklinkResult>,
) -> Result<(), String> {
    let read_dir = fs::read_dir(path).map_err(|e| e.to_string())?;

    for entry in read_dir {
        let entry = entry.map_err(|e| e.to_string())?;
        let entry_path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();

        if name.starts_with('.') {
            continue;
        }

        if entry_path.is_dir() {
            search_backlinks_recursive(&entry_path, re, results)?;
        } else if name.ends_with(".md") {
            // Read file and search for pattern
            let file = fs::File::open(&entry_path).map_err(|e| e.to_string())?;
            let reader = BufReader::new(file);

            for (line_idx, line) in reader.lines().enumerate() {
                let line = line.map_err(|e| e.to_string())?;
                if re.is_match(&line) {
                    results.push(BacklinkResult {
                        file_path: entry_path.to_string_lossy().to_string(),
                        file_name: name.clone(),
                        line_number: (line_idx + 1) as u32,
                        context: line.trim().to_string(),
                    });
                }
            }
        }
    }

    Ok(())
}

#[tauri::command]
fn move_file(old_path: String, new_path: String) -> Result<(), String> {
    let old = Path::new(&old_path);
    let new = Path::new(&new_path);

    if !old.exists() {
        return Err("Source file does not exist".to_string());
    }
    if new.exists() {
        return Err("Destination already exists".to_string());
    }

    // Ensure parent directory exists
    if let Some(parent) = new.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
    }

    fs::rename(old, new).map_err(|e| {
        // If rename fails (cross-device), try copy + delete
        if let Ok(_) = fs::copy(old, new) {
            let _ = fs::remove_file(old);
            return "".to_string();
        }
        e.to_string()
    })?;

    Ok(())
}

// UNUSED: Not invoked from frontend
#[tauri::command]
fn check_file_exists(path: String) -> bool {
    Path::new(&path).exists()
}

#[tauri::command]
fn delete_file(path: String) -> Result<(), String> {
    let file_path = Path::new(&path);
    if !file_path.exists() {
        return Err("File does not exist".to_string());
    }
    fs::remove_file(file_path).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_folder(path: String) -> Result<(), String> {
    let folder_path = Path::new(&path);
    if !folder_path.exists() {
        return Err("Folder does not exist".to_string());
    }
    if !folder_path.is_dir() {
        return Err("Path is not a directory".to_string());
    }
    fs::remove_dir_all(folder_path).map_err(|e| e.to_string())
}

// UNUSED: Not invoked from frontend
#[tauri::command]
fn import_file(source_path: String, vault_path: String, target_dir: Option<String>) -> Result<String, String> {
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
        PathBuf::from(dir)
    } else {
        PathBuf::from(&vault_path)
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
fn import_attachment(source_path: String, note_path: String) -> Result<String, String> {
    let source = Path::new(&source_path);
    if !source.exists() {
        return Err("Source file does not exist".to_string());
    }

    let note = Path::new(&note_path);

    // Check if note_path is inside an _att folder (attachment file, not a vault note)
    // Attachments should NOT have their own _att folders
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

    // Create {note_name}_att/ folder
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

// UNUSED: Not invoked from frontend
#[tauri::command]
fn move_note(note_path: String, new_dir: String) -> Result<String, String> {
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

    // Move note
    let new_note = new_parent.join(old.file_name().unwrap());
    if new_note.exists() {
        return Err("Destination note already exists".to_string());
    }
    fs::rename(old, &new_note).or_else(|_| {
        fs::copy(old, &new_note).map_err(|e| e.to_string())?;
        fs::remove_file(old).map_err(|e| e.to_string())
    })?;

    // Move attachments folder if exists
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
fn open_in_default_app(path: String) -> Result<(), String> {
    opener::open(Path::new(&path)).map_err(|e| e.to_string())
}

#[tauri::command]
fn reveal_in_explorer(path: String) -> Result<(), String> {
    let target = Path::new(&path);

    // If it's a directory, just open it
    if target.is_dir() {
        return opener::open(target).map_err(|e| e.to_string());
    }

    // For files, use platform-specific commands to select the file in explorer
    #[cfg(target_os = "windows")]
    {
        // Windows: explorer.exe /select,"path"
        // Using raw_arg for proper path handling and DETACHED_PROCESS for faster startup
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
        // macOS: open -R "path" (reveals in Finder)
        std::process::Command::new("open")
            .arg("-R")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    #[cfg(target_os = "linux")]
    {
        // Linux: Try dbus method first, fallback to opening parent directory
        // Most file managers support this via dbus
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
            // Fallback: just open the parent directory
            let dir = target.parent().unwrap_or(target);
            opener::open(dir).map_err(|e| e.to_string())
        }
    }
}

// UNUSED: Not invoked from frontend
#[tauri::command]
fn search_att(vault_path: String, query: String) -> Result<Vec<AttachmentInfo>, String> {
    let mut results: Vec<AttachmentInfo> = Vec::new();
    let q = query.to_lowercase();
    let vault = Path::new(&vault_path);
    search_att_recursive(vault, vault, &q, &mut results)?;
    Ok(results)
}

fn search_att_recursive(
    path: &Path,
    vault_root: &Path,
    query: &str,
    results: &mut Vec<AttachmentInfo>,
) -> Result<(), String> {
    let read_dir = fs::read_dir(path).map_err(|e| e.to_string())?;

    for entry in read_dir {
        let entry = entry.map_err(|e| e.to_string())?;
        let entry_path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();

        if name.starts_with('.') {
            continue;
        }

        if entry_path.is_dir() {
            if name.ends_with("_att") {
                let note_name = name.trim_end_matches("_att");
                let note_path = path.join(format!("{}.md", note_name));

                // Compute relative path and container
                let note_relative = note_path
                    .strip_prefix(vault_root)
                    .unwrap_or(&note_path)
                    .to_string_lossy()
                    .replace('\\', "/");
                let container = note_relative
                    .split('/')
                    .next()
                    .unwrap_or("")
                    .to_string();

                // Pre-compute lowercase versions for efficient matching
                let note_name_lower = note_name.to_lowercase();
                let note_relative_lower = note_relative.to_lowercase();
                let container_lower = container.to_lowercase();

                if let Ok(files) = fs::read_dir(&entry_path) {
                    for file in files {
                        if let Ok(file) = file {
                            let file_name = file.file_name().to_string_lossy().to_string();
                            let file_path = file.path();

                            // Skip comments.json (system file, not user attachment)
                            if file_name == "comments.json" {
                                continue;
                            }

                            if !file_path.is_dir() {
                                // Filter by query: match file name, note name, relative path, or container
                                if query.is_empty()
                                    || file_name.to_lowercase().contains(query)
                                    || note_name_lower.contains(query)
                                    || note_relative_lower.contains(query)
                                    || container_lower.contains(query)
                                {
                                    results.push(AttachmentInfo {
                                        path: file_path.to_string_lossy().to_string(),
                                        file_name: file_name.clone(),
                                        note_path: note_path.to_string_lossy().to_string(),
                                        note_name: note_name.to_string(),
                                        note_relative_path: note_relative.clone(),
                                        inferred_note_path: note_relative.clone(),
                                        container: container.clone(),
                                        is_conflict: false,
                                        conflict_original: String::new(),
                                    });
                                }
                            }
                        }
                    }
                }
            } else {
                search_att_recursive(&entry_path, vault_root, query, results)?;
            }
        }
    }

    Ok(())
}

#[tauri::command]
async fn init_search_index(
    vault_path: String,
    state: tauri::State<'_, Mutex<SearchState>>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    // Atomically check state and claim init
    {
        let mut search_state = state.lock().map_err(|e| e.to_string())?;

        // Already initialized — re-emit event (frontend listener may have missed it) and return
        if search_state.index.is_some() {
            log::info!("[init_search_index] Already initialized, re-emitting event");
            drop(search_state);
            let _ = app.emit("search-index-ready", ());
            return Ok(());
        }

        // Another handler is already initializing — return immediately.
        // Frontend uses Tauri events (not polling) to detect completion,
        // so duplicate calls don't need to wait.
        if search_state.init_in_progress {
            log::info!("[init_search_index] Init already in progress, returning Ok");
            return Ok(());
        }

        search_state.init_in_progress = true;
    }

    log::info!("[init_search_index] Starting initialization for: {}", vault_path);
    let init_start = std::time::Instant::now();

    // Phase 1: Create index and reindex on a blocking thread.
    // spawn_blocking prevents saturating the tokio async runtime.
    let vault_path_clone = vault_path.clone();
    let index_result = tokio::task::spawn_blocking(move || -> Result<Arc<SearchIndex>, String> {
        let idx = SearchIndex::new(&vault_path_clone)?;
        let arc_idx = Arc::new(idx);
        arc_idx.full_reindex()?;
        Ok(arc_idx)
    })
    .await
    .map_err(|e| {
        let mut s = state.lock().unwrap();
        s.init_in_progress = false;
        format!("spawn_blocking join error: {}", e)
    })?;

    let index = match index_result {
        Ok(idx) => idx,
        Err(e) => {
            let mut s = state.lock().map_err(|e| e.to_string())?;
            s.init_in_progress = false;
            log::error!("[init_search_index] Phase 1 failed: {}", e);
            return Err(e);
        }
    };

    log::info!("[init_search_index] Index + reindex done in {:.1}s, storing immediately",
        init_start.elapsed().as_secs_f64());

    // Store index immediately so queryNotes works right away
    {
        let mut search_state = state.lock().map_err(|e| e.to_string())?;
        search_state.index = Some(Arc::clone(&index));
    }

    // Notify frontend via event (bypasses IPC invoke channel which may be unreliable)
    let _ = app.emit("search-index-ready", ());
    log::info!("[init_search_index] Emitted search-index-ready event");

    // Phase 2: VaultWatcher + MemoIndex — non-fatal, index already works
    let watcher = match VaultWatcher::start(&vault_path, Arc::clone(&index), app) {
        Ok(w) => Some(w),
        Err(e) => {
            log::warn!("[init_search_index] VaultWatcher failed (non-fatal): {}", e);
            None
        }
    };

    let vault_path_clone = vault_path.clone();
    let memo_index = tokio::task::spawn_blocking(move || {
        let memo = Arc::new(MemoIndex::new(&vault_path_clone));
        if let Err(e) = memo.full_reindex() {
            log::warn!("[init_search_index] MemoIndex reindex failed (non-fatal): {}", e);
        }
        memo
    })
    .await
    .map_err(|e| format!("MemoIndex spawn_blocking join error: {}", e))?;

    // Store remaining components and clear in_progress flag
    {
        let mut search_state = state.lock().map_err(|e| e.to_string())?;
        search_state._watcher = watcher;
        search_state.memo_index = Some(memo_index);
        search_state.init_in_progress = false;
    }

    log::info!("[init_search_index] Full initialization completed in {:.1}s",
        init_start.elapsed().as_secs_f64());
    Ok(())
}

/// Reset search state — used when frontend reloads or vault changes
#[tauri::command]
async fn reset_search_state(
    state: tauri::State<'_, Mutex<SearchState>>,
) -> Result<(), String> {
    let mut search_state = state.lock().map_err(|e| e.to_string())?;
    log::info!("[reset_search_state] Clearing search state");
    search_state.index = None;
    search_state._watcher = None;
    search_state.memo_index = None;
    search_state.init_in_progress = false;
    Ok(())
}

/// Force clear the search index for a vault (use when permission errors occur)
#[tauri::command]
async fn clear_search_index(
    vault_path: String,
    state: tauri::State<'_, Mutex<SearchState>>,
) -> Result<(), String> {
    log::info!("[clear_search_index] Force clearing index for vault: {}", vault_path);

    // Clear current state first
    {
        let mut search_state = state.lock().map_err(|e| e.to_string())?;
        search_state.index = None;
        search_state._watcher = None;
        search_state.memo_index = None;
    }

    // Small delay to ensure file handles are released
    std::thread::sleep(std::time::Duration::from_millis(100));

    // Get the index directory path and delete it
    let index_dir = SearchIndex::get_index_dir(&vault_path);
    log::info!("[clear_search_index] Deleting index directory: {:?}", index_dir);

    // Aggressive cleanup with retries
    const MAX_ATTEMPTS: u32 = 5;
    const DELAY_MS: u64 = 200;

    for attempt in 1..=MAX_ATTEMPTS {
        if !index_dir.exists() {
            log::info!("[clear_search_index] Index directory already deleted");
            break;
        }

        // Try to delete individual files first
        if let Ok(entries) = std::fs::read_dir(&index_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_file() {
                    let _ = std::fs::remove_file(&path);
                }
            }
        }

        // Then try to remove the directory
        match std::fs::remove_dir_all(&index_dir) {
            Ok(_) => {
                log::info!("[clear_search_index] Successfully deleted index directory");
                break;
            }
            Err(e) => {
                if attempt < MAX_ATTEMPTS {
                    log::warn!(
                        "[clear_search_index] Attempt {}/{} failed: {}. Retrying in {}ms...",
                        attempt, MAX_ATTEMPTS, e, DELAY_MS
                    );
                    std::thread::sleep(std::time::Duration::from_millis(DELAY_MS));
                } else {
                    log::error!("[clear_search_index] Failed after {} attempts: {}", MAX_ATTEMPTS, e);
                    return Err(format!("Failed to clear search index: {}", e));
                }
            }
        }
    }

    Ok(())
}

/// Vault integrity check result
#[derive(Serialize, Clone)]
pub struct VaultIntegrityResult {
    pub orphaned_att_folders: Vec<String>,
    pub total_notes: usize,
    pub total_att_folders: usize,
}

/// Check vault integrity - find orphaned _att folders (attachment folders without corresponding .md files)
/// This helps maintain vault health, especially after multi-device syncs
// UNUSED: Not invoked from frontend
#[tauri::command]
async fn check_vault_integrity(vault_path: String) -> Result<VaultIntegrityResult, String> {
    use std::collections::HashSet;
    use walkdir::WalkDir;

    let vault = std::path::Path::new(&vault_path);
    let mut note_stems: HashSet<String> = HashSet::new();
    let mut att_folders: Vec<(String, String)> = Vec::new(); // (path, stem without _att)

    // Collect all .md files and _att folders
    for entry in WalkDir::new(vault)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy();

        // Skip hidden files/folders
        if name.starts_with('.') {
            continue;
        }

        if path.is_file() && name.ends_with(".md") {
            // Store relative path stem (without .md)
            if let Ok(rel_path) = path.strip_prefix(vault) {
                let stem = rel_path.with_extension("").to_string_lossy().to_string();
                note_stems.insert(stem);
            }
        } else if path.is_dir() && name.ends_with("_att") {
            // Store _att folder path and its expected note stem
            if let Ok(rel_path) = path.strip_prefix(vault) {
                let path_str = rel_path.to_string_lossy().to_string();
                // Remove _att suffix to get expected note stem
                let stem = path_str.trim_end_matches("_att").to_string();
                att_folders.push((path_str, stem));
            }
        }
    }

    // Find orphaned _att folders
    let orphaned: Vec<String> = att_folders
        .iter()
        .filter(|(_, stem)| !note_stems.contains(stem))
        .map(|(path, _)| path.clone())
        .collect();

    Ok(VaultIntegrityResult {
        orphaned_att_folders: orphaned,
        total_notes: note_stems.len(),
        total_att_folders: att_folders.len(),
    })
}

#[tauri::command]
async fn full_text_search(
    query: String,
    limit: Option<usize>,
    state: tauri::State<'_, Mutex<SearchState>>,
) -> Result<Vec<IndexSearchResult>, String> {
    let search_state = state.lock().map_err(|e| e.to_string())?;
    let index = search_state.index.as_ref().ok_or("Search index not initialized")?;
    index.search(&query, limit.unwrap_or(20))
}

#[tauri::command]
async fn query_notes(
    filter: NoteFilter,
    state: tauri::State<'_, Mutex<SearchState>>,
) -> Result<Vec<NoteMetadata>, String> {
    let search_state = state.lock().map_err(|e| e.to_string())?;
    let index = search_state.index.as_ref().ok_or("Search index not initialized")?;
    index.query_notes(&filter)
}

// UNUSED: Not invoked from frontend
#[tauri::command]
async fn get_relationships(
    file_path: String,
    state: tauri::State<'_, Mutex<SearchState>>,
) -> Result<RelationshipData, String> {
    let search_state = state.lock().map_err(|e| e.to_string())?;
    let index = search_state.index.as_ref().ok_or("Search index not initialized")?;
    index.get_relationships(&file_path)
}

#[tauri::command]
async fn get_graph_data(
    container_path: Option<String>,
    include_attachments: Option<bool>,
    state: tauri::State<'_, Mutex<SearchState>>,
) -> Result<GraphData, String> {
    let search_state = state.lock().map_err(|e| e.to_string())?;
    let index = search_state.index.as_ref().ok_or("Search index not initialized")?;
    index.get_graph_data(container_path.as_deref(), include_attachments.unwrap_or(false))
}

#[tauri::command]
async fn reindex_vault(
    state: tauri::State<'_, Mutex<SearchState>>,
) -> Result<(), String> {
    let search_state = state.lock().map_err(|e| e.to_string())?;
    let index = search_state.index.as_ref().ok_or("Search index not initialized")?;
    index.full_reindex()
}

/// Incremental reindex - only update changed files (optimized for large vaults)
// UNUSED: Not invoked from frontend
#[tauri::command]
async fn incremental_reindex(
    state: tauri::State<'_, Mutex<SearchState>>,
) -> Result<usize, String> {
    let search_state = state.lock().map_err(|e| e.to_string())?;
    let index = search_state.index.as_ref().ok_or("Search index not initialized")?;
    index.incremental_reindex()
}

/// Get all unique tags used across all notes in the vault
/// Returns a list of tag IDs (e.g., "domain/특허", "who/홍길동")
#[tauri::command]
async fn get_all_used_tags(
    state: tauri::State<'_, Mutex<SearchState>>,
) -> Result<Vec<String>, String> {
    let search_state = state.lock().map_err(|e| e.to_string())?;
    let index = search_state.index.as_ref().ok_or("Search index not initialized")?;
    index.get_all_tags()
}

#[tauri::command]
async fn get_suggestion_terms(
    limit: Option<usize>,
    state: tauri::State<'_, Mutex<SearchState>>,
) -> Result<Vec<(String, u32)>, String> {
    let search_state = state.lock().map_err(|e| e.to_string())?;
    let index = search_state.index.as_ref().ok_or("Search index not initialized")?;
    index.get_suggestion_terms(limit.unwrap_or(200))
}

/// Get reindex progress (for progress UI)
// UNUSED: Not invoked from frontend
#[tauri::command]
async fn get_reindex_progress(
    state: tauri::State<'_, Mutex<SearchState>>,
) -> Result<(usize, usize, bool), String> {
    let search_state = state.lock().map_err(|e| e.to_string())?;
    let index = search_state.index.as_ref().ok_or("Search index not initialized")?;
    Ok((
        index.progress.completed.load(std::sync::atomic::Ordering::Relaxed),
        index.progress.total.load(std::sync::atomic::Ordering::Relaxed),
        index.progress.is_running.load(std::sync::atomic::Ordering::Relaxed),
    ))
}

#[tauri::command]
async fn search_attachments(
    vault_path: String,
    query: String,
) -> Result<Vec<AttachmentInfo>, String> {
    use walkdir::{WalkDir, DirEntry};
    use search::watcher::{is_synology_conflict_file, get_original_from_conflict};

    let vault = Path::new(&vault_path);
    let query_lower = query.to_lowercase();
    let mut results = Vec::new();

    for entry in WalkDir::new(&vault)
        .into_iter()
        .filter_map(|e: Result<DirEntry, _>| e.ok())
        .filter(|e: &DirEntry| e.file_type().is_file())
    {
        let path: &Path = entry.path();

        // Check if file is in an _att folder (including conflict _att folders)
        let is_attachment = path.components().any(|c| {
            if let std::path::Component::Normal(name) = c {
                let s = name.to_string_lossy();
                s.ends_with("_att") || {
                    // Also match Synology conflict _att folders:
                    // e.g., "Note_att (SynologyDrive Conflict)"
                    let lower = s.to_lowercase();
                    s.contains("_att") && (lower.contains("(synologydrive conflict") || lower.contains("(synology conflict"))
                }
            } else {
                false
            }
        });

        if !is_attachment {
            continue;
        }

        // Get file name
        let file_name = path.file_name()
            .and_then(|n: &std::ffi::OsStr| n.to_str())
            .unwrap_or("")
            .to_string();

        // Skip comments.json (system file, not user attachment)
        if file_name == "comments.json" {
            continue;
        }

        // Check if the file itself is a Synology conflict file
        let file_is_conflict = is_synology_conflict_file(&file_name);
        let file_conflict_original = if file_is_conflict {
            get_original_from_conflict(path)
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default()
        } else {
            String::new()
        };

        // Check if the _att folder is a Synology conflict folder
        // e.g., "Note_att (SynologyDrive Conflict)" instead of "Note_att"
        let att_folder = path.parent().unwrap_or(vault);
        let att_folder_name = att_folder.file_name()
            .and_then(|n: &std::ffi::OsStr| n.to_str())
            .unwrap_or("");
        let folder_is_conflict = is_synology_conflict_file(att_folder_name);

        // Mark as conflict if either the file or its _att folder is a conflict
        let is_conflict = file_is_conflict || folder_is_conflict;
        let conflict_original = if file_is_conflict {
            file_conflict_original
        } else if folder_is_conflict {
            // For folder conflicts, the original would be the same file in the non-conflict _att folder
            get_original_from_conflict(&PathBuf::from(att_folder))
                .map(|orig_folder| orig_folder.join(&file_name).to_string_lossy().to_string())
                .unwrap_or_default()
        } else {
            String::new()
        };

        // Extract the note file name by removing _att suffix
        // For conflict folders like "Note_att (SynologyDrive Conflict)", first strip conflict suffix
        let clean_att_folder_name = if folder_is_conflict {
            // Use regex to strip conflict suffix: "Note_att (SynologyDrive Conflict)" -> "Note_att"
            let re = regex::Regex::new(r" \(Synology(?:Drive)? [Cc]onflict[^)]*\)").unwrap();
            re.replace(att_folder_name, "").to_string()
        } else {
            att_folder_name.to_string()
        };
        let base_name = if clean_att_folder_name.ends_with("_att") {
            &clean_att_folder_name[..clean_att_folder_name.len() - 4] // Remove "_att"
        } else {
            &clean_att_folder_name
        };

        // Ensure note file name ends with .md
        let note_file_name = if base_name.ends_with(".md") {
            base_name.to_string()
        } else {
            format!("{}.md", base_name)
        };

        // Construct the actual note file path
        let note_parent = att_folder.parent().unwrap_or(vault);
        let actual_note_path = note_parent.join(&note_file_name);

        // Check if the note file actually exists
        let note_exists = actual_note_path.exists();

        // Get note name (file name without extension)
        let note_name = note_file_name[..note_file_name.len() - 3].to_string();

        // Check if the attachment is actually linked in the note content
        let is_linked = if note_exists {
            if let Ok(content) = std::fs::read_to_string(&actual_note_path) {
                let content_lower = content.to_lowercase();
                let file_name_lower = file_name.to_lowercase();

                // For .md files, also check without extension (wikilinks might not include .md)
                let file_name_without_md = if file_name_lower.ends_with(".md") {
                    file_name_lower[..file_name_lower.len() - 3].to_string()
                } else {
                    file_name_lower.clone()
                };

                // Check for TipTap HTML format first (most common in this app)
                // <span data-wiki-link="file_name">
                let html_wiki_link = format!("data-wiki-link=\"{}\"", file_name_lower);
                let html_wiki_link_no_ext = format!("data-wiki-link=\"{}\"", file_name_without_md);

                if content_lower.contains(&html_wiki_link) || content_lower.contains(&html_wiki_link_no_ext) {
                    true
                } else {
                    // Fallback: Check for other link formats
                    // Wiki-style: [[file_name]] or ![[file_name]]
                    let wiki_link_pattern = format!("[[{}]]", file_name_lower);
                    let wiki_link_pattern_no_ext = format!("[[{}]]", file_name_without_md);
                    let embed_pattern = format!("![[{}]]", file_name_lower);
                    let embed_pattern_no_ext = format!("![[{}]]", file_name_without_md);

                    // Markdown links: [text](file_name)
                    let md_link_contains = content_lower.contains(&format!("]({})", file_name_lower))
                        || content_lower.contains(&format!("]({})", file_name_lower.replace(" ", "%20")))
                        || content_lower.contains(&format!("]({})", file_name_without_md))
                        || content_lower.contains(&format!("/{}", file_name_lower).as_str());

                    content_lower.contains(&wiki_link_pattern)
                        || content_lower.contains(&wiki_link_pattern_no_ext)
                        || content_lower.contains(&embed_pattern)
                        || content_lower.contains(&embed_pattern_no_ext)
                        || md_link_contains
                }
            } else {
                false
            }
        } else {
            false
        };

        // Get inferred note path (always show, regardless of link existence)
        let inferred_note_path = if note_exists {
            actual_note_path.strip_prefix(vault)
                .ok()
                .and_then(|p: &Path| p.to_str())
                .map(|s| {
                    if s.ends_with(".md") {
                        &s[..s.len() - 3] // Remove .md for display
                    } else {
                        s
                    }
                })
                .unwrap_or("-")
                .replace("\\", "/")
        } else {
            "-".to_string()
        };

        // Get relative path from vault (using the note file, not the folder)
        // Show "-" if note doesn't exist or attachment is not linked
        let note_relative_path = if note_exists && is_linked {
            inferred_note_path.clone()
        } else {
            "-".to_string()
        };

        // Get container (top-level folder)
        let container = note_parent.strip_prefix(vault)
            .ok()
            .and_then(|p: &Path| p.components().next())
            .and_then(|c| {
                if let std::path::Component::Normal(name) = c {
                    name.to_str()
                } else {
                    None
                }
            })
            .unwrap_or("")
            .to_string();

        // Filter by query
        if !query.is_empty() {
            let matches = file_name.to_lowercase().contains(&query_lower)
                || note_name.to_lowercase().contains(&query_lower)
                || note_relative_path.to_lowercase().contains(&query_lower)
                || container.to_lowercase().contains(&query_lower);

            if !matches {
                continue;
            }
        }

        results.push(AttachmentInfo {
            path: path.to_string_lossy().to_string(),
            file_name,
            // Only provide note_path if the note exists AND the attachment is linked
            note_path: if note_exists && is_linked {
                actual_note_path.to_string_lossy().to_string()
            } else {
                String::new()
            },
            note_name,
            note_relative_path,
            inferred_note_path,
            container,
            is_conflict,
            conflict_original,
        });
    }

    Ok(results)
}

/// Check if an attachment file is referenced anywhere in the vault
// UNUSED: Not invoked from frontend
#[tauri::command]
async fn check_attachment_references(
    vault_path: String,
    file_name: String,
) -> Result<Vec<String>, String> {
    use walkdir::WalkDir;

    let vault = Path::new(&vault_path);
    let file_name_lower = file_name.to_lowercase();
    let mut referencing_notes = Vec::new();

    // Walk through all .md files in the vault
    for entry in WalkDir::new(&vault)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
    {
        let path = entry.path();

        // Only check .md files
        if !path.extension().map_or(false, |ext| ext == "md") {
            continue;
        }

        // Read the file content
        if let Ok(content) = std::fs::read_to_string(path) {
            let content_lower = content.to_lowercase();

            // Check for various link formats
            let html_wiki_link = format!("data-wiki-link=\"{}\"", file_name_lower);
            let wiki_link_pattern = format!("[[{}]]", file_name_lower);
            let embed_pattern = format!("![[{}]]", file_name_lower);
            let md_link_contains = content_lower.contains(&format!("]({})", file_name_lower))
                || content_lower.contains(&format!("]({})", file_name_lower.replace(" ", "%20")))
                || content_lower.contains(&format!("/{}", file_name_lower).as_str());

            if content_lower.contains(&html_wiki_link)
                || content_lower.contains(&wiki_link_pattern)
                || content_lower.contains(&embed_pattern)
                || md_link_contains
            {
                referencing_notes.push(path.to_string_lossy().to_string());
            }
        }
    }

    Ok(referencing_notes)
}

/// Delete multiple files at once
#[tauri::command]
async fn delete_multiple_files(paths: Vec<String>) -> Result<usize, String> {
    let mut deleted_count = 0;
    let mut errors = Vec::new();

    for path in paths {
        let path_obj = Path::new(&path);
        if !path_obj.exists() {
            errors.push(format!("{}: File does not exist", path));
            continue;
        }
        match fs::remove_file(path_obj) {
            Ok(_) => deleted_count += 1,
            Err(e) => errors.push(format!("{}: {}", path, e)),
        }
    }

    if !errors.is_empty() && deleted_count == 0 {
        return Err(format!("Failed to delete files:\n{}", errors.join("\n")));
    }

    Ok(deleted_count)
}

/// Delete attachment files and remove their wikilinks from owning notes
/// Returns (deleted_count, links_removed_count, modified_notes)
#[tauri::command]
async fn delete_attachments_with_links(paths: Vec<String>) -> Result<(usize, usize, Vec<String>), String> {
    use regex::Regex;

    let mut deleted_count = 0;
    let mut links_removed_count = 0;
    let mut modified_notes: Vec<String> = Vec::new();
    let mut errors = Vec::new();

    // Regex patterns for wikilinks
    // WikiLinks are stored as HTML spans: <span ... data-wiki-link="filename" ...>filename</span>
    // Also need to match list items containing these spans
    let create_wikilink_regex = |filename: &str| -> Result<Regex, String> {
        let escaped = regex::escape(filename);
        // Match patterns:
        // 1. Full list item line containing only the span: - <span ...>filename</span>
        // 2. Standalone span: <span ... data-wiki-link="filename" ...>filename</span>
        // 3. Legacy [[filename]] format (for backwards compatibility)
        Regex::new(&format!(
            r#"(?m)^[ \t]*[-*][ \t]*<span[^>]*data-wiki-link="{}"[^>]*>[^<]*</span>[ \t]*\n?|<span[^>]*data-wiki-link="{}"[^>]*>[^<]*</span>|\[\[{}\]\]|!\[\[{}\]\]"#,
            escaped, escaped, escaped, escaped
        )).map_err(|e| e.to_string())
    };

    for path in paths {
        let path_obj = Path::new(&path);
        if !path_obj.exists() {
            errors.push(format!("{}: File does not exist", path));
            continue;
        }

        // Extract filename from path
        let file_name = match path_obj.file_name() {
            Some(name) => name.to_string_lossy().to_string(),
            None => {
                errors.push(format!("{}: Invalid file path", path));
                continue;
            }
        };

        // Find owning note from _att folder
        // Pattern: /path/to/Note_att/file.ext → /path/to/Note.md
        let parent_dir = match path_obj.parent() {
            Some(p) => p,
            None => {
                errors.push(format!("{}: Cannot determine parent directory", path));
                continue;
            }
        };

        let parent_name = parent_dir.file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();

        // Check if parent is an _att folder
        // Convention: Note.md → Note_att/ (attachment folder)
        let owning_note_path = if parent_name.ends_with("_att") {
            let note_stem = &parent_name[..parent_name.len() - 4]; // Remove "_att"
            let note_dir = parent_dir.parent().unwrap_or(parent_dir);
            let note_path = note_dir.join(format!("{}.md", note_stem));
            if note_path.exists() {
                Some(note_path)
            } else {
                None
            }
        } else {
            None
        };

        // Remove wikilinks from owning note
        // Try both with and without .md extension, since wikilinks might not include the extension
        let file_name_without_md = if file_name.to_lowercase().ends_with(".md") {
            file_name[..file_name.len() - 3].to_string()
        } else {
            file_name.clone()
        };

        println!("[DEBUG delete_attachments_with_links] file_name: {}, file_name_without_md: {}, parent_name: {}", file_name, file_name_without_md, parent_name);
        println!("[DEBUG delete_attachments_with_links] owning_note_path: {:?}", owning_note_path);

        if let Some(note_path) = owning_note_path {
            println!("[DEBUG delete_attachments_with_links] Reading note: {:?}", note_path);
            if let Ok(content) = fs::read_to_string(&note_path) {
                // Try to match with full filename first, then without .md extension
                let filenames_to_try: Vec<&str> = if file_name != file_name_without_md {
                    vec![&file_name, &file_name_without_md]
                } else {
                    vec![&file_name]
                };

                let mut current_content = content.clone();
                let mut total_matches = 0;

                for fname in filenames_to_try {
                    if let Ok(regex) = create_wikilink_regex(fname) {
                        let matches_found = regex.find_iter(&current_content).count();
                        if matches_found > 0 {
                            println!("[DEBUG delete_attachments_with_links] Found {} matches for '{}'", matches_found, fname);
                            current_content = regex.replace_all(&current_content, "").to_string();
                            total_matches += matches_found;
                        }
                    }
                }

                if total_matches > 0 {
                    // Clean up consecutive empty lines
                    let cleaned_content = current_content
                        .lines()
                        .collect::<Vec<_>>()
                        .join("\n");

                    println!("[DEBUG delete_attachments_with_links] Content len: {} -> {}", content.len(), cleaned_content.len());

                    // Only write if content changed
                    if cleaned_content != content {
                        match fs::write(&note_path, &cleaned_content) {
                            Ok(_) => {
                                println!("[DEBUG delete_attachments_with_links] Successfully wrote updated note");
                                links_removed_count += total_matches;
                                if !modified_notes.contains(&note_path.to_string_lossy().to_string()) {
                                    modified_notes.push(note_path.to_string_lossy().to_string());
                                }
                            }
                            Err(e) => {
                                println!("[DEBUG delete_attachments_with_links] Failed to write note: {}", e);
                            }
                        }
                    } else {
                        println!("[DEBUG delete_attachments_with_links] No changes to write");
                    }
                } else {
                    println!("[DEBUG delete_attachments_with_links] No matches found");
                }
            } else {
                println!("[DEBUG delete_attachments_with_links] Failed to read note file");
            }
        } else {
            println!("[DEBUG delete_attachments_with_links] No owning note found");
        }

        // Delete the attachment file
        match fs::remove_file(path_obj) {
            Ok(_) => deleted_count += 1,
            Err(e) => errors.push(format!("{}: {}", path, e)),
        }
    }

    if !errors.is_empty() && deleted_count == 0 {
        return Err(format!("Failed to delete files:\n{}", errors.join("\n")));
    }

    Ok((deleted_count, links_removed_count, modified_notes))
}

#[tauri::command]
async fn index_note(
    path: String,
    state: tauri::State<'_, Mutex<SearchState>>,
) -> Result<(), String> {
    let search_state = state.lock().map_err(|e| e.to_string())?;
    let index = search_state.index.as_ref().ok_or("Search index not initialized")?;
    let p = std::path::Path::new(&path);
    if p.exists() && p.is_file() {
        index.index_file(p)
    } else {
        Ok(())
    }
}

#[tauri::command]
async fn remove_note_from_index(
    path: String,
    state: tauri::State<'_, Mutex<SearchState>>,
) -> Result<(), String> {
    let search_state = state.lock().map_err(|e| e.to_string())?;
    let index = search_state.index.as_ref().ok_or("Search index not initialized")?;
    index.remove_file(std::path::Path::new(&path))
}

// UNUSED: Not invoked from frontend
#[tauri::command]
fn create_note_with_template(
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

    // Atomic write: write to temp file then rename to prevent partial file sync
    atomic_write_file(&final_path, content.as_bytes())?;

    log::debug!("[create_note_with_template] Created and synced: {:?}", final_path);
    Ok(final_path.to_string_lossy().to_string())
}

/// Retry fs::rename up to 5 times with 200ms delay between attempts.
/// Handles transient locks from Synology Drive, antivirus, etc.
fn rename_with_retry(from: &Path, to: &Path) -> std::io::Result<()> {
    let max_retries = 5;
    for attempt in 1..=max_retries {
        match fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(e) if attempt < max_retries => {
                // os error 5 = Access Denied (Windows), EACCES/EBUSY on Unix
                let code = e.raw_os_error().unwrap_or(0);
                if code == 5 || code == 32 || code == 33 {
                    // 5=ACCESS_DENIED, 32=SHARING_VIOLATION, 33=LOCK_VIOLATION
                    println!("[rename_with_retry] Attempt {}/{} failed (os error {}), retrying in 200ms...", attempt, max_retries, code);
                    std::thread::sleep(std::time::Duration::from_millis(200));
                    continue;
                }
                return Err(e);
            }
            Err(e) => return Err(e),
        }
    }
    unreachable!()
}

// UNUSED: Not invoked from frontend
#[tauri::command]
fn rename_file_with_links(
    file_path: String,
    new_name: String,
    vault_path: String,
) -> Result<String, String> {
    println!("[DEBUG] rename_file_with_links called:");
    println!("  file_path: {}", file_path);
    println!("  new_name: {}", new_name);
    println!("  vault_path: {}", vault_path);

    let old_path = Path::new(&file_path);
    if !old_path.exists() {
        return Err("File does not exist".to_string());
    }

    let parent = old_path.parent().ok_or("Cannot determine parent directory")?;
    let old_stem = old_path.file_stem().unwrap_or_default().to_string_lossy().to_string();
    let old_name_full = old_path.file_name().unwrap_or_default().to_string_lossy().to_string();
    let parent_name = parent.file_name().unwrap_or_default().to_string_lossy().to_string();

    let new_stem = Path::new(&new_name)
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();

    println!("[DEBUG] Extracted names:");
    println!("  old_stem: {}, old_name_full: {}", old_stem, old_name_full);
    println!("  new_stem: {}, new_name: {}", new_stem, new_name);

    // Check if this is a folder note (file stem matches parent folder name)
    let is_folder_note = old_stem.eq_ignore_ascii_case(&parent_name);

    let final_path: PathBuf;

    if is_folder_note {
        // For folder notes, rename both the parent folder and the file
        // Steps: 1) rename file, 2) rename _att, 3) rename parent folder
        // Rollback on failure to prevent inconsistent state
        let grandparent = parent.parent().ok_or("Cannot determine grandparent directory")?;
        let new_folder_path = grandparent.join(&new_stem);

        if new_folder_path.exists() && new_folder_path != parent {
            return Err("A folder with that name already exists".to_string());
        }

        // Step 1: rename file inside folder
        let temp_file_path = parent.join(&new_name);
        rename_with_retry(old_path, &temp_file_path)
            .map_err(|e| format!("Failed to rename file: {}", e))?;

        // Step 2: rename _att folder if exists
        let old_att = parent.join(format!("{}_att", old_stem));
        let att_was_renamed = if old_att.exists() && old_att.is_dir() {
            let new_att = parent.join(format!("{}_att", new_stem));
            if let Err(e) = rename_with_retry(&old_att, &new_att) {
                // Rollback step 1
                let _ = fs::rename(&temp_file_path, old_path);
                return Err(format!("Failed to rename attachment folder: {}", e));
            }
            true
        } else {
            false
        };

        // Step 3: rename parent folder
        if let Err(e) = rename_with_retry(parent, &new_folder_path) {
            // Rollback step 2
            if att_was_renamed {
                let new_att = parent.join(format!("{}_att", new_stem));
                let _ = fs::rename(&new_att, &old_att);
            }
            // Rollback step 1
            let _ = fs::rename(&temp_file_path, old_path);
            return Err(format!("Failed to rename folder: {}", e));
        }

        final_path = new_folder_path.join(&new_name);

        // Update wiki-links for both the old folder name and old file name
        update_wiki_links_recursive(
            Path::new(&vault_path),
            &old_stem,
            &old_name_full,
            &new_stem,
            &new_name,
        );
        // Also update links that might reference the folder name without extension
        if parent_name != old_stem {
            update_wiki_links_recursive(
                Path::new(&vault_path),
                &parent_name,
                &format!("{}.md", parent_name),
                &new_stem,
                &new_name,
            );
        }
    } else if old_path.is_dir() {
        // Folder rename (container)
        // Steps: 1) rename folder, 2) rename folder note, 3) rename _att
        // Rollback on failure
        let new_path = parent.join(&new_name);
        if new_path.exists() && new_path != old_path {
            return Err("A folder with that name already exists".to_string());
        }

        // Check if this folder has a folder note (FolderName/FolderName.md)
        let folder_note_path = old_path.join(format!("{}.md", old_stem));
        let has_folder_note = folder_note_path.exists();

        // Step 1: rename folder
        rename_with_retry(old_path, &new_path)
            .map_err(|e| format!("Failed to rename folder: {}", e))?;

        // If folder had a folder note, rename it and its attachments
        if has_folder_note {
            // Step 2: rename folder note
            let old_note_in_new_folder = new_path.join(format!("{}.md", old_stem));
            let new_note_path = new_path.join(format!("{}.md", new_stem));
            if let Err(e) = rename_with_retry(&old_note_in_new_folder, &new_note_path) {
                // Rollback step 1
                let _ = fs::rename(&new_path, old_path);
                return Err(format!("Failed to rename folder note: {}", e));
            }

            // Step 3: rename _att folder if exists
            let old_att = new_path.join(format!("{}_att", old_stem));
            if old_att.exists() && old_att.is_dir() {
                let new_att = new_path.join(format!("{}_att", new_stem));
                if let Err(e) = rename_with_retry(&old_att, &new_att) {
                    // Rollback step 2
                    let _ = fs::rename(&new_note_path, &old_note_in_new_folder);
                    // Rollback step 1
                    let _ = fs::rename(&new_path, old_path);
                    return Err(format!("Failed to rename attachment folder: {}", e));
                }
            }

            // Update wiki-links for the folder note
            update_wiki_links_recursive(
                Path::new(&vault_path),
                &old_stem,
                &format!("{}.md", old_stem),
                &new_stem,
                &format!("{}.md", new_stem),
            );
        }

        final_path = new_path;
    } else {
        // Regular file rename
        // Steps: 1) rename file, 2) rename _att
        // Rollback on failure
        let new_path = parent.join(&new_name);
        if new_path.exists() && new_path != old_path {
            return Err("A file with that name already exists".to_string());
        }

        // Step 1: rename file
        rename_with_retry(old_path, &new_path).map_err(|e| e.to_string())?;

        // Step 2: rename _att folder if this is a .md file
        let is_md = new_name.ends_with(".md") || old_name_full.ends_with(".md");
        if is_md {
            let old_att = parent.join(format!("{}_att", old_stem));
            if old_att.exists() && old_att.is_dir() {
                let new_att = parent.join(format!("{}_att", new_stem));
                if let Err(e) = rename_with_retry(&old_att, &new_att) {
                    // Rollback step 1
                    let _ = fs::rename(&new_path, old_path);
                    return Err(format!("Failed to rename attachment folder: {}", e));
                }
            }
        }

        final_path = new_path;

        // Update wiki-links across the vault
        update_wiki_links_recursive(
            Path::new(&vault_path),
            &old_stem,
            &old_name_full,
            &new_stem,
            &new_name,
        );
    }

    // Update frontmatter title: field if it exists in the renamed .md file
    // This keeps the frontmatter in sync with the file name
    if final_path.extension().map(|e| e == "md").unwrap_or(false) && final_path.exists() {
        if let Ok(content) = fs::read_to_string(&final_path) {
            if content.starts_with("---\n") || content.starts_with("---\r\n") {
                if let Some(end_idx) = content[4..].find("\n---").map(|i| i + 4) {
                    let fm_section = &content[4..end_idx];
                    // Check if title: field exists in frontmatter
                    if let Some(title_start) = fm_section.find("\ntitle:").or_else(|| {
                        if fm_section.starts_with("title:") { Some(0) } else { None }
                    }) {
                        let new_display_title = new_stem.replace('_', " ");
                        // Find the exact position of the title line
                        let abs_start = if title_start == 0 { 4 } else { 4 + title_start + 1 };
                        let line_end = content[abs_start..].find('\n')
                            .map(|i| abs_start + i)
                            .unwrap_or(end_idx);
                        let new_content = format!(
                            "{}title: \"{}\"{}",
                            &content[..abs_start],
                            new_display_title,
                            &content[line_end..]
                        );
                        let _ = fs::write(&final_path, new_content);
                    }
                }
            }
        }
    }

    Ok(final_path.to_string_lossy().to_string())
}

/// Parallel wiki link update across vault
fn update_wiki_links_recursive(
    dir: &Path,
    old_stem: &str,
    old_full: &str,
    new_stem: &str,
    new_full: &str,
) {
    // Collect all .md files first (single-threaded)
    let md_files = collect_md_files(dir);

    if md_files.is_empty() {
        return;
    }

    // Pre-compute all patterns once
    let patterns = WikiLinkPatterns::new(old_stem, old_full, new_stem, new_full);

    // Process files in parallel
    let updates: Vec<(PathBuf, String)> = md_files
        .par_iter()
        .filter_map(|path| {
            if let Ok(content) = fs::read_to_string(path) {
                if let Some(updated) = patterns.apply(&content) {
                    return Some((path.clone(), updated));
                }
            }
            None
        })
        .collect();

    // Write updates (can be parallelized too, but file I/O often bottlenecks)
    for (path, content) in updates {
        let _ = fs::write(&path, &content);
    }
}

/// Collect all .md files in directory recursively
fn collect_md_files(dir: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    collect_md_files_recursive(dir, &mut files);
    files
}

fn collect_md_files_recursive(dir: &Path, files: &mut Vec<PathBuf>) {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };

    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();

        if name.starts_with('.') || name.ends_with("_att") {
            continue;
        }

        if path.is_dir() {
            collect_md_files_recursive(&path, files);
        } else if name.ends_with(".md") {
            files.push(path);
        }
    }
}

/// Pre-computed wiki link patterns for efficient replacement
struct WikiLinkPatterns {
    // Pattern pairs: (old, new)
    wiki_stem: (String, String),
    wiki_full: Option<(String, String)>,
    wiki_full_no_ext: Option<(String, String)>,
    attr_wiki_stem: (String, String),
    attr_wiki_full: Option<(String, String)>,
    attr_filename_stem: (String, String),
    attr_filename_full: Option<(String, String)>,
    span_text_stem: (String, String),
    span_text_full: Option<(String, String)>,
}

impl WikiLinkPatterns {
    fn new(old_stem: &str, old_full: &str, new_stem: &str, new_full: &str) -> Self {
        let has_full = old_full != old_stem;

        Self {
            wiki_stem: (format!("[[{}]]", old_stem), format!("[[{}]]", new_stem)),
            wiki_full: if has_full {
                Some((format!("[[{}]]", old_full), format!("[[{}]]", new_full)))
            } else {
                None
            },
            wiki_full_no_ext: if old_full.ends_with(".md") && has_full {
                let old_no_ext = old_full.trim_end_matches(".md");
                let new_no_ext = new_full.trim_end_matches(".md");
                if old_no_ext != old_stem {
                    Some((format!("[[{}]]", old_no_ext), format!("[[{}]]", new_no_ext)))
                } else {
                    None
                }
            } else {
                None
            },
            attr_wiki_stem: (
                format!("data-wiki-link=\"{}\"", old_stem),
                format!("data-wiki-link=\"{}\"", new_stem),
            ),
            attr_wiki_full: if has_full {
                Some((
                    format!("data-wiki-link=\"{}\"", old_full),
                    format!("data-wiki-link=\"{}\"", new_full),
                ))
            } else {
                None
            },
            attr_filename_stem: (
                format!("filename=\"{}\"", old_stem),
                format!("filename=\"{}\"", new_stem),
            ),
            attr_filename_full: if has_full {
                Some((
                    format!("filename=\"{}\"", old_full),
                    format!("filename=\"{}\"", new_full),
                ))
            } else {
                None
            },
            span_text_stem: (
                format!(">{}</span>", old_stem),
                format!(">{}</span>", new_stem),
            ),
            span_text_full: if has_full {
                Some((
                    format!(">{}</span>", old_full),
                    format!(">{}</span>", new_full),
                ))
            } else {
                None
            },
        }
    }

    /// Apply all patterns to content, return Some(updated) if changes made
    fn apply(&self, content: &str) -> Option<String> {
        let mut updated = content.to_string();
        let mut has_changes = false;

        // Apply each pattern
        has_changes |= self.replace_pattern(&mut updated, &self.wiki_stem);
        if let Some(ref p) = self.wiki_full {
            has_changes |= self.replace_pattern(&mut updated, p);
        }
        if let Some(ref p) = self.wiki_full_no_ext {
            has_changes |= self.replace_pattern(&mut updated, p);
        }
        has_changes |= self.replace_pattern(&mut updated, &self.attr_wiki_stem);
        if let Some(ref p) = self.attr_wiki_full {
            has_changes |= self.replace_pattern(&mut updated, p);
        }
        has_changes |= self.replace_pattern(&mut updated, &self.attr_filename_stem);
        if let Some(ref p) = self.attr_filename_full {
            has_changes |= self.replace_pattern(&mut updated, p);
        }
        has_changes |= self.replace_pattern(&mut updated, &self.span_text_stem);
        if let Some(ref p) = self.span_text_full {
            has_changes |= self.replace_pattern(&mut updated, p);
        }

        if has_changes {
            Some(updated)
        } else {
            None
        }
    }

    #[inline]
    fn replace_pattern(&self, content: &mut String, pattern: &(String, String)) -> bool {
        if content.contains(&pattern.0) {
            *content = content.replace(&pattern.0, &pattern.1);
            true
        } else {
            false
        }
    }
}

#[tauri::command]
fn delete_note(note_path: String) -> Result<(), String> {
    let path = Path::new(&note_path);
    if !path.exists() {
        return Err("Note does not exist".to_string());
    }

    // Delete associated _att folder first (if it exists)
    // This prevents orphaned attachment folders if note deletion fails
    let stem = path.file_stem().unwrap_or_default().to_string_lossy().to_string();
    let parent = path.parent().unwrap();
    let attachments_dir = parent.join(format!("{}_att", stem));
    if attachments_dir.exists() && attachments_dir.is_dir() {
        fs::remove_dir_all(&attachments_dir).map_err(|e| e.to_string())?;
    }

    // Then delete the note file
    fs::remove_file(path).map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
fn update_note_frontmatter(
    note_path: String,
    new_frontmatter_yaml: String,
) -> Result<(), String> {
    let path = Path::new(&note_path);
    if !path.exists() {
        return Err("Note does not exist".to_string());
    }

    // Per-file lock: prevent concurrent read-modify-write races
    let lock = get_file_lock(&note_path);
    let _guard = lock.lock().map_err(|e| format!("File lock poisoned: {}", e))?;

    // Backup before overwriting (best effort)
    if let Some(vault_root) = find_vault_root(path) {
        if let Err(e) = backup_before_save(path, &vault_root) {
            log::warn!("Backup before frontmatter update failed (non-fatal): {}", e);
        }
    }

    let content = fs::read_to_string(path).map_err(|e| e.to_string())?;

    // Split into frontmatter and body
    let new_content = if content.starts_with("---") {
        // Find the closing ---
        if let Some(end_idx) = content[3..].find("\n---") {
            let body = &content[3 + end_idx + 4..]; // skip past closing ---
            format!("---\n{}\n---{}", new_frontmatter_yaml, body)
        } else {
            // No closing ---, treat entire content as body
            format!("---\n{}\n---\n\n{}", new_frontmatter_yaml, content)
        }
    } else {
        // No existing frontmatter
        format!("---\n{}\n---\n\n{}", new_frontmatter_yaml, content)
    };

    // Atomic write: prevents data loss on force-kill (was fs::write — non-atomic!)
    atomic_write_file(path, new_content.as_bytes())?;
    Ok(())
}

/// Update only the `modified` field in frontmatter without touching the body.
/// Used when comments/memos change — they live in a separate file but should
/// still update the parent note's modification timestamp.
#[tauri::command]
fn touch_note_modified(note_path: String) -> Result<(), String> {
    let path = Path::new(&note_path);
    if !path.exists() {
        return Err("Note does not exist".to_string());
    }

    // Per-file lock: prevent concurrent read-modify-write races
    let lock = get_file_lock(&note_path);
    let _guard = lock.lock().map_err(|e| format!("File lock poisoned: {}", e))?;

    // Backup before overwriting (best effort)
    if let Some(vault_root) = find_vault_root(path) {
        if let Err(e) = backup_before_save(path, &vault_root) {
            log::warn!("Backup before touch_note_modified failed (non-fatal): {}", e);
        }
    }

    let content = fs::read_to_string(path).map_err(|e| e.to_string())?;
    if !content.starts_with("---") {
        return Ok(()); // No frontmatter to update
    }

    let end_idx = match content[3..].find("\n---") {
        Some(idx) => idx,
        None => return Ok(()),
    };

    let fm_section = &content[4..3 + end_idx]; // between --- markers
    let body = &content[3 + end_idx + 4..];
    let now = chrono::Local::now().format("%Y-%m-%dT%H:%M:%S%:z").to_string();

    // Replace existing modified line, or append it
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

#[derive(Serialize, Clone)]
struct BulkTagProgress {
    total: usize,
    completed: usize,
    current_path: String,
}

#[derive(Serialize)]
struct BulkTagResult {
    affected_count: usize,
    failed_paths: Vec<String>,
    cancelled: bool,
}

/// Bulk delete a tag from all notes in the vault.
/// tag format: "namespace/tagname" (e.g., "domain/AI")
#[tauri::command]
async fn bulk_delete_tag(
    tag: String,
    state: tauri::State<'_, Mutex<SearchState>>,
    bulk_state: tauri::State<'_, BulkOperationState>,
    app: tauri::AppHandle,
) -> Result<BulkTagResult, String> {
    bulk_state.cancel_requested.store(false, Ordering::SeqCst);

    // Parse "namespace/tagname"
    let (namespace, tag_name) = parse_namespaced_tag(&tag)?;

    // Get all notes with this tag
    let note_paths = {
        let search_state = state.lock().map_err(|e| e.to_string())?;
        let index = search_state.index.as_ref().ok_or("Search index not initialized")?;
        let filter = NoteFilter {
            tags: Some(vec![tag.clone()]),
            note_type: None,
            created_after: None,
            created_before: None,
            modified_after: None,
            modified_before: None,
            sort_by: None,
            sort_order: None,
        };
        let notes = index.query_notes(&filter)?;
        notes.into_iter().map(|n| n.path).collect::<Vec<_>>()
    };

    let total = note_paths.len();
    let mut affected_count = 0;
    let mut failed_paths = Vec::new();

    for (i, note_path) in note_paths.iter().enumerate() {
        // Check cancellation
        if bulk_state.cancel_requested.load(Ordering::Relaxed) {
            return Ok(BulkTagResult { affected_count, failed_paths, cancelled: true });
        }

        // Emit progress
        let _ = app.emit("tag-operation-progress", BulkTagProgress {
            total,
            completed: i,
            current_path: note_path.clone(),
        });

        match modify_note_tag(note_path, &namespace, &tag_name, None) {
            Ok(true) => {
                affected_count += 1;
                // Re-index
                let search_state = state.lock().map_err(|e| e.to_string())?;
                if let Some(index) = search_state.index.as_ref() {
                    let _ = index.index_file(Path::new(note_path));
                }
            }
            Ok(false) => {} // Tag not found in this note's frontmatter
            Err(e) => {
                log::warn!("Failed to modify tag in {}: {}", note_path, e);
                failed_paths.push(note_path.clone());
            }
        }
    }

    // Final progress
    let _ = app.emit("tag-operation-progress", BulkTagProgress {
        total,
        completed: total,
        current_path: String::new(),
    });

    Ok(BulkTagResult { affected_count, failed_paths, cancelled: false })
}

/// Bulk rename a tag across all notes in the vault.
/// old_tag/new_tag format: "namespace/tagname" (e.g., "domain/AI" → "domain/인공지능")
#[tauri::command]
async fn bulk_rename_tag(
    old_tag: String,
    new_tag: String,
    state: tauri::State<'_, Mutex<SearchState>>,
    bulk_state: tauri::State<'_, BulkOperationState>,
    app: tauri::AppHandle,
) -> Result<BulkTagResult, String> {
    bulk_state.cancel_requested.store(false, Ordering::SeqCst);

    let (old_ns, old_name) = parse_namespaced_tag(&old_tag)?;
    let (new_ns, new_name) = parse_namespaced_tag(&new_tag)?;

    if old_ns != new_ns {
        return Err("Cannot rename tag across different namespaces".to_string());
    }

    // Get all notes with the old tag
    let note_paths = {
        let search_state = state.lock().map_err(|e| e.to_string())?;
        let index = search_state.index.as_ref().ok_or("Search index not initialized")?;
        let filter = NoteFilter {
            tags: Some(vec![old_tag.clone()]),
            note_type: None,
            created_after: None,
            created_before: None,
            modified_after: None,
            modified_before: None,
            sort_by: None,
            sort_order: None,
        };
        let notes = index.query_notes(&filter)?;
        notes.into_iter().map(|n| n.path).collect::<Vec<_>>()
    };

    let total = note_paths.len();
    let mut affected_count = 0;
    let mut failed_paths = Vec::new();

    for (i, note_path) in note_paths.iter().enumerate() {
        if bulk_state.cancel_requested.load(Ordering::Relaxed) {
            return Ok(BulkTagResult { affected_count, failed_paths, cancelled: true });
        }

        let _ = app.emit("tag-operation-progress", BulkTagProgress {
            total,
            completed: i,
            current_path: note_path.clone(),
        });

        match modify_note_tag(note_path, &old_ns, &old_name, Some(&new_name)) {
            Ok(true) => {
                affected_count += 1;
                let search_state = state.lock().map_err(|e| e.to_string())?;
                if let Some(index) = search_state.index.as_ref() {
                    let _ = index.index_file(Path::new(note_path));
                }
            }
            Ok(false) => {}
            Err(e) => {
                log::warn!("Failed to rename tag in {}: {}", note_path, e);
                failed_paths.push(note_path.clone());
            }
        }
    }

    let _ = app.emit("tag-operation-progress", BulkTagProgress {
        total,
        completed: total,
        current_path: String::new(),
    });

    Ok(BulkTagResult { affected_count, failed_paths, cancelled: false })
}

/// Cancel an ongoing bulk tag operation
#[tauri::command]
async fn cancel_bulk_operation(
    bulk_state: tauri::State<'_, BulkOperationState>,
) -> Result<(), String> {
    bulk_state.cancel_requested.store(true, Ordering::SeqCst);
    Ok(())
}

/// Parse "namespace/tagname" into (namespace, tagname)
fn parse_namespaced_tag(tag: &str) -> Result<(String, String), String> {
    let parts: Vec<&str> = tag.splitn(2, '/').collect();
    if parts.len() != 2 || parts[0].is_empty() || parts[1].is_empty() {
        return Err(format!("Invalid tag format '{}'. Expected 'namespace/tagname'", tag));
    }
    Ok((parts[0].to_string(), parts[1].to_string()))
}

/// Modify a single note's tag in frontmatter.
/// Returns Ok(true) if modified, Ok(false) if tag not found.
fn modify_note_tag(
    note_path: &str,
    namespace: &str,
    old_name: &str,
    new_name: Option<&str>,
) -> Result<bool, String> {
    let path = Path::new(note_path);
    if !path.exists() {
        return Err(format!("File does not exist: {}", note_path));
    }

    let lock = get_file_lock(note_path);
    let _guard = lock.lock().map_err(|e| format!("File lock poisoned: {}", e))?;

    // Backup
    if let Some(vault_root) = find_vault_root(path) {
        let _ = backup_before_save(path, &vault_root);
    }

    let content = fs::read_to_string(path).map_err(|e| e.to_string())?;
    if !content.starts_with("---") {
        return Ok(false); // No frontmatter
    }

    let end_idx = match content[3..].find("\n---") {
        Some(idx) => idx,
        None => return Ok(false),
    };

    let fm_yaml = &content[4..3 + end_idx]; // YAML between --- markers
    let body = &content[3 + end_idx + 4..];

    match modify_tag_in_frontmatter_yaml(fm_yaml, namespace, old_name, new_name)? {
        Some(new_yaml) => {
            let new_content = format!("---\n{}\n---{}", new_yaml, body);
            atomic_write_file(path, new_content.as_bytes())?;
            Ok(true)
        }
        None => Ok(false), // Tag not found
    }
}

/// Add a tag to a single note's frontmatter.
/// Creates the tags section and namespace array if they don't exist.
/// Returns Ok(true) if added, Ok(false) if tag already exists.
fn add_tag_to_note(
    note_path: &str,
    namespace: &str,
    tag_name: &str,
) -> Result<bool, String> {
    let path = Path::new(note_path);
    if !path.exists() {
        return Err(format!("File does not exist: {}", note_path));
    }

    let lock = get_file_lock(note_path);
    let _guard = lock.lock().map_err(|e| format!("File lock poisoned: {}", e))?;

    // Backup
    if let Some(vault_root) = find_vault_root(path) {
        let _ = backup_before_save(path, &vault_root);
    }

    let content = fs::read_to_string(path).map_err(|e| e.to_string())?;
    if !content.starts_with("---") {
        return Ok(false); // No frontmatter
    }

    let end_idx = match content[3..].find("\n---") {
        Some(idx) => idx,
        None => return Ok(false),
    };

    let fm_yaml = &content[4..3 + end_idx];
    let body = &content[3 + end_idx + 4..];

    // Parse YAML
    let mut value: serde_yaml::Value =
        serde_yaml::from_str(fm_yaml).map_err(|e| format!("YAML parse error: {}", e))?;

    // Ensure "tags" exists as a mapping
    if value.get("tags").is_none() {
        if let Some(map) = value.as_mapping_mut() {
            map.insert(
                serde_yaml::Value::String("tags".to_string()),
                serde_yaml::Value::Mapping(serde_yaml::Mapping::new()),
            );
        } else {
            return Ok(false);
        }
    }

    let tags = value.get_mut("tags").unwrap();
    if !tags.is_mapping() {
        return Ok(false);
    }

    // Ensure namespace array exists
    let ns_key = serde_yaml::Value::String(namespace.to_string());
    if tags.get(&ns_key).is_none() {
        if let Some(map) = tags.as_mapping_mut() {
            map.insert(ns_key.clone(), serde_yaml::Value::Sequence(Vec::new()));
        }
    }

    let seq = match tags.get_mut(&ns_key).and_then(|v| v.as_sequence_mut()) {
        Some(s) => s,
        None => return Ok(false),
    };

    // Check if tag already exists (case-insensitive)
    let tag_lower = tag_name.to_lowercase();
    let already_exists = seq.iter().any(|item| {
        item.as_str().map(|s| s.to_lowercase() == tag_lower).unwrap_or(false)
    });
    if already_exists {
        return Ok(false);
    }

    // Add tag
    seq.push(serde_yaml::Value::String(tag_name.to_string()));

    let new_yaml = serde_yaml::to_string(&value)
        .map_err(|e| format!("YAML serialize error: {}", e))?;
    let new_yaml = new_yaml.trim_end_matches('\n');
    let new_content = format!("---\n{}\n---{}", new_yaml, body);
    atomic_write_file(path, new_content.as_bytes())?;
    Ok(true)
}

/// Bulk add a tag to multiple notes.
#[tauri::command]
async fn bulk_add_tags(
    paths: Vec<String>,
    tag: String,
    state: tauri::State<'_, Mutex<SearchState>>,
    bulk_state: tauri::State<'_, BulkOperationState>,
    app: tauri::AppHandle,
) -> Result<BulkTagResult, String> {
    bulk_state.cancel_requested.store(false, Ordering::SeqCst);

    let (namespace, tag_name) = parse_namespaced_tag(&tag)?;
    let total = paths.len();
    let mut affected_count = 0;
    let mut failed_paths = Vec::new();

    for (i, note_path) in paths.iter().enumerate() {
        if bulk_state.cancel_requested.load(Ordering::Relaxed) {
            return Ok(BulkTagResult { affected_count, failed_paths, cancelled: true });
        }

        let _ = app.emit("tag-operation-progress", BulkTagProgress {
            total,
            completed: i,
            current_path: note_path.clone(),
        });

        match add_tag_to_note(note_path, &namespace, &tag_name) {
            Ok(true) => {
                affected_count += 1;
                // Re-index
                let search_state = state.lock().map_err(|e| e.to_string())?;
                if let Some(index) = search_state.index.as_ref() {
                    let _ = index.index_file(Path::new(note_path));
                }
            }
            Ok(false) => {} // Already has tag or no frontmatter
            Err(e) => {
                log::warn!("Failed to add tag to {}: {}", note_path, e);
                failed_paths.push(note_path.clone());
            }
        }
    }

    let _ = app.emit("tag-operation-progress", BulkTagProgress {
        total,
        completed: total,
        current_path: String::new(),
    });

    Ok(BulkTagResult { affected_count, failed_paths, cancelled: false })
}

#[cfg(feature = "devtools")]
#[tauri::command]
fn toggle_devtools(webview_window: tauri::WebviewWindow) {
    if webview_window.is_devtools_open() {
        webview_window.close_devtools();
    } else {
        webview_window.open_devtools();
    }
}

#[cfg(not(feature = "devtools"))]
#[tauri::command]
fn toggle_devtools() {
    // DevTools disabled in production build
}

/// Set window icon based on note type
/// Maps note types to template-specific icons for taskbar display
#[tauri::command]
fn set_window_icon(app: tauri::AppHandle, window_label: String, note_type: String) -> Result<(), String> {
    use tauri::Manager;
    use tauri::image::Image;
    use image::GenericImageView;

    // Get the window by label
    let window = app.get_webview_window(&window_label)
        .ok_or_else(|| format!("Window '{}' not found", window_label))?;

    // Map note type to icon file
    // Lucide-style icons for hover windows: note (blue), image (green), pdf (red), code (purple), web (cyan)
    // Main Notology window keeps the original icon.png
    let icon_name = match note_type.to_uppercase().as_str() {
        // Attachment viewers (distinct colored icons)
        "IMAGE" => "image.png",   // Green - image viewer
        "PDF" => "pdf.png",       // Red - PDF viewer
        "CODE" => "code.png",     // Purple - code viewer
        "WEB" => "web.png",       // Cyan - web viewer
        // Note types (all use blue note icon)
        "NOTE" | "MTG" | "EVENT" | "SEM" | "SKETCH" | "OFA" | "PAPER" | "LIT" | "DATA" | "THEO" | "CONTACT" => "note.png",
        // Default for editor windows
        _ => "note.png",
    };

    // Get the icon path from resources
    let icon_path = app.path().resource_dir()
        .map_err(|e| format!("Failed to get resource dir: {}", e))?
        .join("icons")
        .join(icon_name);

    // Load and set the icon
    if icon_path.exists() {
        // Load PNG and convert to RGBA
        let img = image::open(&icon_path)
            .map_err(|e| format!("Failed to load icon image: {}", e))?;
        let (width, height) = img.dimensions();
        let rgba = img.into_rgba8().into_raw();

        // Create Tauri Image from RGBA data
        let icon = Image::new_owned(rgba, width, height);
        window.set_icon(icon)
            .map_err(|e| format!("Failed to set window icon: {}", e))?;
        log::info!("[set_window_icon] Set icon for window '{}' (type: {})", window_label, note_type);
    } else {
        log::warn!("[set_window_icon] Icon not found at {:?}, using default", icon_path);
    }

    Ok(())
}

/// Create a hover window with dark background color to prevent white flash
/// Window starts hidden - frontend calls show() after content is ready
#[tauri::command]
async fn create_hover_window(
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

    // Parse theme directly from URL query param (avoids JS↔Rust serialization issues)
    let is_light = url.contains("theme=light");
    let bg = if is_light {
        Color(245, 245, 245, 255) // #f5f5f5
    } else {
        Color(30, 30, 30, 255)    // #1e1e1e
    };

    WebviewWindowBuilder::new(&app, &label, WebviewUrl::App(url.into()))
        .title(&title)
        .inner_size(width as f64, height as f64)
        .position(x as f64, y as f64)
        .decorations(false)
        .resizable(true)
        .focused(true)
        .visible(false)  // Hidden until frontend show()
        .min_inner_size(400.0, 300.0)
        .background_color(bg)
        .build()
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[derive(Serialize)]
struct CommentsWithMtime {
    comments: String,
    mtime: u64,
}

#[tauri::command]
fn read_comments(note_path: String) -> Result<CommentsWithMtime, String> {
    let note = Path::new(&note_path);
    let stem = note.file_stem()
        .ok_or("Invalid note path")?
        .to_string_lossy();
    let parent = note.parent().ok_or("No parent directory")?;
    let comments_path = parent.join(format!("{}_att", stem)).join("comments.json");
    if comments_path.exists() {
        let comments = fs::read_to_string(&comments_path).map_err(|e| e.to_string())?;
        let metadata = fs::metadata(&comments_path).map_err(|e| e.to_string())?;
        let mtime = metadata.modified()
            .map_err(|e| e.to_string())?
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        Ok(CommentsWithMtime { comments, mtime })
    } else {
        Ok(CommentsWithMtime { comments: "[]".to_string(), mtime: 0 })
    }
}

#[tauri::command]
fn write_comments(note_path: String, comments_json: String) -> Result<u64, String> {
    let note = Path::new(&note_path);
    let stem = note.file_stem()
        .ok_or("Invalid note path")?
        .to_string_lossy();
    let parent = note.parent().ok_or("No parent directory")?;
    let attachments_dir = parent.join(format!("{}_att", stem));
    if !attachments_dir.exists() {
        fs::create_dir_all(&attachments_dir).map_err(|e| e.to_string())?;
    }
    let comments_path = attachments_dir.join("comments.json");
    // Atomic write: write to temp file then rename to prevent partial file sync
    atomic_write_file(&comments_path, comments_json.as_bytes())?;
    // Return new mtime after write
    let metadata = fs::metadata(&comments_path).map_err(|e| e.to_string())?;
    let mtime = metadata.modified()
        .map_err(|e| e.to_string())?
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    Ok(mtime)
}

// Memo indexing commands
#[tauri::command]
async fn index_note_memos(
    note_path: String,
    state: tauri::State<'_, Mutex<SearchState>>,
) -> Result<(), String> {
    let search_state = state.lock().map_err(|e| e.to_string())?;
    let memo_index = search_state.memo_index.as_ref().ok_or("Memo index not initialized")?;
    memo_index.index_note_memos(&note_path)
}

// UNUSED: Not invoked from frontend
#[tauri::command]
async fn remove_note_memos(
    note_path: String,
    state: tauri::State<'_, Mutex<SearchState>>,
) -> Result<(), String> {
    let search_state = state.lock().map_err(|e| e.to_string())?;
    let memo_index = search_state.memo_index.as_ref().ok_or("Memo index not initialized")?;
    memo_index.remove_note_memos(&note_path)
}

// UNUSED: Not invoked from frontend
#[tauri::command]
async fn query_memos(
    filter: MemoQueryFilter,
    state: tauri::State<'_, Mutex<SearchState>>,
) -> Result<Vec<IndexedMemo>, String> {
    let search_state = state.lock().map_err(|e| e.to_string())?;
    let memo_index = search_state.memo_index.as_ref().ok_or("Memo index not initialized")?;
    memo_index.query_memos(&filter)
}

// UNUSED: Not invoked from frontend
#[tauri::command]
async fn reindex_memos(
    state: tauri::State<'_, Mutex<SearchState>>,
) -> Result<(), String> {
    let search_state = state.lock().map_err(|e| e.to_string())?;
    let memo_index = search_state.memo_index.as_ref().ok_or("Memo index not initialized")?;
    memo_index.full_reindex()
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CalendarMemo {
    id: String,
    content: String,
    note_path: String,
    note_title: String,
    date: String, // YYYY-MM-DD format
    is_task: bool,
    resolved: bool,
    anchor_text: String,
}

#[tauri::command]
fn collect_calendar_memos(
    container_path: String,
) -> Result<Vec<CalendarMemo>, String> {
    let container = Path::new(&container_path);
    let mut memos = Vec::new();

    // Recursively collect all .md files
    fn collect_md_files(dir: &Path, files: &mut Vec<PathBuf>) {
        if let Ok(entries) = fs::read_dir(dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    let dir_name = path.file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or("");
                    // Skip hidden directories and attachment folders
                    if !dir_name.starts_with('.') && !dir_name.ends_with("_att") {
                        collect_md_files(&path, files);
                    }
                } else if path.extension().and_then(|e| e.to_str()) == Some("md") {
                    files.push(path);
                }
            }
        }
    }

    let mut md_files = Vec::new();
    collect_md_files(container, &mut md_files);

    // Collect memos from each file
    for note_path in md_files {
        let note_title = note_path
            .file_stem()
            .and_then(|n| n.to_str())
            .unwrap_or("Untitled")
            .to_string();

        let stem = note_path.file_stem()
            .ok_or("Invalid note path")?
            .to_string_lossy();
        let parent = match note_path.parent() {
            Some(p) => p,
            None => continue,
        };
        let comments_path = parent.join(format!("{}_att", stem)).join("comments.json");

        if !comments_path.exists() {
            continue;
        }

        let comments_json = match fs::read_to_string(&comments_path) {
            Ok(content) => content,
            Err(_) => continue,
        };

        let comments: Vec<serde_json::Value> = match serde_json::from_str(&comments_json) {
            Ok(c) => c,
            Err(_) => continue,
        };

        for comment in comments {
            let id = comment.get("id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let content = comment.get("content")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let anchor_text = comment.get("anchorText")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let resolved = comment.get("resolved")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);

            // Check if it's a task
            let is_task = comment.get("task").is_some();

            // Get date: for tasks use dueDate, for regular memos use createdTime
            let date = if is_task {
                comment.get("task")
                    .and_then(|task| task.get("dueDate"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string()
            } else {
                // Extract date from createdTime (YYYY-MM-DD from ISO 8601)
                let created_time = comment.get("createdTime")
                    .and_then(|v| v.as_str())
                    .or_else(|| comment.get("created").and_then(|v| v.as_str()))
                    .unwrap_or("");
                if created_time.len() >= 10 {
                    created_time[..10].to_string()
                } else {
                    String::new()
                }
            };

            // Skip if no valid date
            if date.is_empty() {
                continue;
            }

            memos.push(CalendarMemo {
                id,
                content,
                note_path: note_path.to_string_lossy().to_string(),
                note_title: note_title.clone(),
                date,
                is_task,
                resolved,
                anchor_text,
            });
        }
    }

    Ok(memos)
}

#[derive(Serialize)]
struct UrlMetadata {
    title: String,
    description: String,
    image: String,
    favicon: String,
}

#[tauri::command]
fn fetch_url_metadata(url: String) -> Result<UrlMetadata, String> {
    use scraper::{Html, Selector};

    // Fetch the HTML
    let response = reqwest::blocking::get(&url)
        .map_err(|e| format!("Failed to fetch URL: {}", e))?;

    let html_content = response.text()
        .map_err(|e| format!("Failed to read response: {}", e))?;

    let document = Html::parse_document(&html_content);

    // Helper function to extract meta tag content
    let get_meta = |property: &str| -> Option<String> {
        let selector = Selector::parse(&format!("meta[property='{}']", property)).ok()?;
        document.select(&selector).next()?.value().attr("content").map(String::from)
    };

    let get_meta_name = |name: &str| -> Option<String> {
        let selector = Selector::parse(&format!("meta[name='{}']", name)).ok()?;
        document.select(&selector).next()?.value().attr("content").map(String::from)
    };

    // Extract title (try og:title, then <title> tag)
    let title = get_meta("og:title")
        .or_else(|| {
            let selector = Selector::parse("title").ok()?;
            document.select(&selector).next()?.text().collect::<String>().trim().to_string().into()
        })
        .unwrap_or_else(|| url.clone());

    // Extract description (try og:description, then meta description)
    let description = get_meta("og:description")
        .or_else(|| get_meta_name("description"))
        .unwrap_or_default();

    // Extract image (try og:image, then twitter:image)
    let image = get_meta("og:image")
        .or_else(|| get_meta("twitter:image"))
        .unwrap_or_default();

    // Extract favicon
    let favicon = {
        let base_url = url::Url::parse(&url).map_err(|e| format!("Invalid URL: {}", e))?;
        let icon_selector = Selector::parse("link[rel*='icon']").ok();

        if let Some(selector) = icon_selector {
            if let Some(link) = document.select(&selector).next() {
                if let Some(href) = link.value().attr("href") {
                    // Resolve relative URLs
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
fn open_url_in_browser(url: String) -> Result<(), String> {
    opener::open(url).map_err(|e| format!("Failed to open URL: {}", e))
}

/// File metadata with modification time
#[derive(Serialize)]
pub struct FileMeta {
    path: String,
    mtime: u64, // milliseconds since epoch
}

/// Get modification times for multiple files (batch operation for cache warmup)
/// Returns only files that exist and have valid mtime
#[tauri::command]
fn get_files_mtime(paths: Vec<String>) -> Vec<FileMeta> {
    use std::time::UNIX_EPOCH;

    paths
        .into_iter()
        .filter_map(|path| {
            let p = Path::new(&path);
            if !p.exists() {
                return None;
            }
            let metadata = fs::metadata(p).ok()?;
            let mtime = metadata.modified().ok()?;
            let duration = mtime.duration_since(UNIX_EPOCH).ok()?;
            Some(FileMeta {
                path,
                mtime: duration.as_millis() as u64,
            })
        })
        .collect()
}

/// Get modification time for a single file (milliseconds since epoch).
/// Returns 0 if file doesn't exist or metadata can't be read.
/// Used for optimistic locking: check mtime before save to detect external modifications.
#[tauri::command]
fn get_file_mtime(path: String) -> u64 {
    use std::time::UNIX_EPOCH;

    Path::new(&path)
        .metadata()
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Find the vault root by searching upward for the .notology directory.
fn find_vault_root(file_path: &Path) -> Option<PathBuf> {
    let mut current = file_path.parent()?;
    loop {
        if current.join(".notology").is_dir() {
            return Some(current.to_path_buf());
        }
        match current.parent() {
            Some(parent) => current = parent,
            None => return None,
        }
    }
}

/// Create a backup of a file before overwriting.
/// Stores in .notology/backups/ with timestamp suffix.
/// Keeps latest 5 versions per file, rotates old ones.
fn backup_before_save(file_path: &Path, vault_path: &Path) -> Result<(), String> {
    if !file_path.exists() {
        return Ok(());
    }

    let backup_dir = vault_path.join(".notology").join("backups");
    if !backup_dir.exists() {
        fs::create_dir_all(&backup_dir).map_err(|e| e.to_string())?;
    }

    let file_name = file_path
        .file_name()
        .ok_or("Invalid file path")?
        .to_string_lossy();
    let timestamp = chrono::Local::now().format("%Y-%m-%dT%H-%M-%S");
    let backup_name = format!("{}.{}.bak", file_name, timestamp);
    let backup_path = backup_dir.join(&backup_name);

    fs::copy(file_path, &backup_path).map_err(|e| format!("Backup failed: {}", e))?;

    // Rotate: keep only latest 5 backups for this file
    let prefix = format!("{}.", file_name);
    let mut backups: Vec<PathBuf> = fs::read_dir(&backup_dir)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .map(|s| s.starts_with(&prefix) && s.ends_with(".bak"))
                .unwrap_or(false)
        })
        .collect();

    backups.sort();

    let max_backups = 5;
    if backups.len() > max_backups {
        for old_backup in &backups[..backups.len() - max_backups] {
            let _ = fs::remove_file(old_backup);
        }
    }

    Ok(())
}

/// Clean up old backups in .notology/backups/.
/// Removes backups older than 7 days.
#[tauri::command]
fn cleanup_old_backups(vault_path: String) -> Result<usize, String> {
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

/// Detect if a vault path is on a Synology Drive-synced folder.
/// Checks for .SynologyDrive marker directory in the vault or any parent directory.
/// Returns a JSON object with detection results.
#[tauri::command]
fn detect_nas_platform(vault_path: String) -> Result<NasPlatformInfo, String> {
    let vault = Path::new(&vault_path);

    // Strategy 1: Check for .SynologyDrive folder in vault or any parent
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

    // Strategy 2: Check if Synology Drive Client process is running (Windows)
    let synology_client_running = is_synology_client_running();

    // Strategy 3: Check path patterns typical for Synology Drive
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

#[derive(Serialize)]
struct NasPlatformInfo {
    is_nas_synced: bool,
    platform: String,         // "synology" or ""
    synology_root: String,    // Root of Synology sync folder
    synology_client_running: bool,
}

fn is_synology_client_running() -> bool {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;

        // Check for Synology Drive Client process on Windows
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

// =========================================================================
// Note-level editing lock (file-based, synced via Synology Drive)
// =========================================================================

#[derive(Serialize, Deserialize, Clone)]
pub struct NoteLockInfo {
    pub machine_id: String,
    pub hostname: String,
    pub file_path: String,
    pub locked_at: String,
    pub heartbeat: String,
}

fn note_lock_hash(input: &str) -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut hasher = DefaultHasher::new();
    input.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

#[tauri::command]
fn acquire_note_lock(vault_path: String, note_path: String) -> Result<(), String> {
    let locks_dir = Path::new(&vault_path).join(".notology").join("locks");
    fs::create_dir_all(&locks_dir).map_err(|e| e.to_string())?;

    let hash = note_lock_hash(&note_path);
    let lock_path = locks_dir.join(format!("{}.lock", hash));

    let info = NoteLockInfo {
        machine_id: vault_lock::get_machine_id(),
        hostname: vault_lock::get_hostname(),
        file_path: note_path,
        locked_at: chrono::Utc::now().to_rfc3339(),
        heartbeat: chrono::Utc::now().to_rfc3339(),
    };

    let content = serde_json::to_string_pretty(&info).map_err(|e| e.to_string())?;
    atomic_write_file(&lock_path, content.as_bytes())?;
    Ok(())
}

#[tauri::command]
fn release_note_lock(vault_path: String, note_path: String) -> Result<(), String> {
    let locks_dir = Path::new(&vault_path).join(".notology").join("locks");
    let hash = note_lock_hash(&note_path);
    let lock_path = locks_dir.join(format!("{}.lock", hash));

    if lock_path.exists() {
        if let Ok(content) = fs::read_to_string(&lock_path) {
            if let Ok(info) = serde_json::from_str::<NoteLockInfo>(&content) {
                if info.machine_id == vault_lock::get_machine_id() {
                    let _ = fs::remove_file(&lock_path);
                }
            }
        }
    }
    Ok(())
}

#[tauri::command]
fn update_note_lock_heartbeat(vault_path: String, note_path: String) -> Result<(), String> {
    let locks_dir = Path::new(&vault_path).join(".notology").join("locks");
    let hash = note_lock_hash(&note_path);
    let lock_path = locks_dir.join(format!("{}.lock", hash));

    if lock_path.exists() {
        if let Ok(content) = fs::read_to_string(&lock_path) {
            if let Ok(mut info) = serde_json::from_str::<NoteLockInfo>(&content) {
                if info.machine_id == vault_lock::get_machine_id() {
                    info.heartbeat = chrono::Utc::now().to_rfc3339();
                    let updated = serde_json::to_string_pretty(&info).map_err(|e| e.to_string())?;
                    atomic_write_file(&lock_path, updated.as_bytes())?;
                }
            }
        }
    }
    Ok(())
}

#[tauri::command]
fn check_note_lock(vault_path: String, note_path: String) -> Result<Option<NoteLockInfo>, String> {
    let locks_dir = Path::new(&vault_path).join(".notology").join("locks");
    let hash = note_lock_hash(&note_path);
    let lock_path = locks_dir.join(format!("{}.lock", hash));

    if !lock_path.exists() {
        return Ok(None);
    }

    let content = fs::read_to_string(&lock_path).map_err(|e| e.to_string())?;
    let info: NoteLockInfo = serde_json::from_str(&content).map_err(|e| e.to_string())?;

    // Check stale (120 seconds — generous for Synology sync delay)
    if let Ok(heartbeat) = chrono::DateTime::parse_from_rfc3339(&info.heartbeat) {
        let age = chrono::Utc::now().signed_duration_since(heartbeat);
        if age.num_seconds() > 120 {
            let _ = fs::remove_file(&lock_path);
            return Ok(None);
        }
    }

    // Own lock — not a conflict
    if info.machine_id == vault_lock::get_machine_id() {
        return Ok(None);
    }

    Ok(Some(info))
}

/// Read persistent cache from vault .notology folder
/// Returns empty string if file doesn't exist
#[tauri::command]
fn read_meta_cache(vault_path: String) -> Result<String, String> {
    let cache_path = Path::new(&vault_path).join(".notology").join("content-cache.json");
    if cache_path.exists() {
        fs::read_to_string(&cache_path).map_err(|e| e.to_string())
    } else {
        Ok(String::new())
    }
}

/// Write persistent cache to vault .notology folder
/// Creates .notology folder if it doesn't exist
#[tauri::command]
fn write_meta_cache(vault_path: String, cache_json: String) -> Result<(), String> {
    let notology_dir = Path::new(&vault_path).join(".notology");
    if !notology_dir.exists() {
        fs::create_dir_all(&notology_dir).map_err(|e| e.to_string())?;
    }

    let cache_path = notology_dir.join("content-cache.json");

    // Atomic write: write to temp file then rename to prevent partial file sync
    atomic_write_file(&cache_path, cache_json.as_bytes())?;

    Ok(())
}

/// Frontmatter-only result (for metadata queries without body)
#[derive(Serialize)]
pub struct FrontmatterOnly {
    path: String,
    frontmatter: Option<String>,
    mtime: u64,
}

/// Batch read frontmatter only from multiple files (Obsidian-style metadata-first loading)
/// This is much faster than reading full file content when only metadata is needed
#[tauri::command]
fn read_frontmatters_batch(paths: Vec<String>) -> Vec<FrontmatterOnly> {
    use std::io::{BufRead, BufReader};
    use std::time::UNIX_EPOCH;

    paths
        .into_par_iter()
        .filter_map(|path| {
            let p = Path::new(&path);
            if !p.exists() {
                return None;
            }

            // Get mtime
            let mtime = fs::metadata(p).ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);

            // Read only frontmatter (stop at closing ---)
            let file = fs::File::open(p).ok()?;
            let reader = BufReader::new(file);
            let mut lines = reader.lines();

            // Check first line for ---
            let first_line = lines.next()?.ok()?;
            if first_line.trim() != "---" {
                return Some(FrontmatterOnly {
                    path,
                    frontmatter: None,
                    mtime,
                });
            }

            // Collect frontmatter until closing ---
            let mut fm_lines = Vec::new();
            for line in lines {
                match line {
                    Ok(l) => {
                        if l.trim() == "---" {
                            break;
                        }
                        fm_lines.push(l);
                    }
                    Err(_) => break,
                }
            }

            Some(FrontmatterOnly {
                path,
                frontmatter: Some(fm_lines.join("\n")),
                mtime,
            })
        })
        .collect()
}

/// Index state for incremental startup (Obsidian-style)
// Used by UNUSED commands read_index_state/write_index_state
#[allow(dead_code)]
#[derive(Serialize, Deserialize)]
struct IndexState {
    version: u32,
    last_full_index: u64, // timestamp in ms
    file_mtimes: std::collections::HashMap<String, u64>,
}

/// Read index state from vault .notology folder
// UNUSED: Not invoked from frontend
#[tauri::command]
fn read_index_state(vault_path: String) -> Result<String, String> {
    let state_path = Path::new(&vault_path).join(".notology").join("index-state.json");
    if state_path.exists() {
        fs::read_to_string(&state_path).map_err(|e| e.to_string())
    } else {
        Ok(String::new())
    }
}

/// Write index state to vault .notology folder
// UNUSED: Not invoked from frontend
#[tauri::command]
fn write_index_state(vault_path: String, state_json: String) -> Result<(), String> {
    let notology_dir = Path::new(&vault_path).join(".notology");
    if !notology_dir.exists() {
        fs::create_dir_all(&notology_dir).map_err(|e| e.to_string())?;
    }

    let state_path = notology_dir.join("index-state.json");

    // Atomic write: write to temp file then rename to prevent partial file sync
    atomic_write_file(&state_path, state_json.as_bytes())?;

    Ok(())
}

// GPU compatibility: Read gpu-config.json and set WebView2 browser args before Tauri init.
// This must run BEFORE the WebView2 is created (which happens during .run()).
// On Windows, if disableGpuCompositing is true, we set WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
// to "--disable-gpu-compositing" which moves layer compositing to CPU (minimal perf impact
// for text editor apps) while avoiding GPU driver compatibility issues.
#[cfg(target_os = "windows")]
fn apply_gpu_config() {
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

#[tauri::command]
fn get_gpu_config(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
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
fn set_gpu_config(app: tauri::AppHandle, config: serde_json::Value) -> Result<(), String> {
    let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&config_dir).map_err(|e| e.to_string())?;
    let config_path = config_dir.join("gpu-config.json");
    let content = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    fs::write(&config_path, content).map_err(|e| e.to_string())?;
    Ok(())
}

// ============================================================================
// Document Preview (LibreOffice headless → PDF conversion)
// ============================================================================

/// Detect LibreOffice installation on Windows.
/// Returns the path to soffice.exe if found.
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

    // Try PATH environment variable
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

/// Get the preview cache directory under the app's local data directory.
fn get_preview_cache_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let local_data = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    let cache_dir = local_data.join("preview-cache");
    fs::create_dir_all(&cache_dir).map_err(|e| format!("Failed to create preview cache dir: {}", e))?;
    Ok(cache_dir)
}

/// Generate a stable cache key for a file based on its path and mtime.
fn preview_cache_key(file_path: &str, mtime: u64) -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut hasher = DefaultHasher::new();
    file_path.hash(&mut hasher);
    let path_hash = hasher.finish();
    format!("{}_{}", path_hash, mtime)
}

/// Check if a preview engine (LibreOffice) is available.
#[tauri::command]
fn check_preview_engine() -> Result<serde_json::Value, String> {
    let lo_path = detect_libreoffice_path();
    Ok(serde_json::json!({
        "available": lo_path.is_some(),
        "engine": "libreoffice",
        "path": lo_path.map(|p| p.to_string_lossy().to_string()),
    }))
}

/// Document extensions that can be previewed.
const DOCUMENT_EXTENSIONS: &[&str] = &[
    "doc", "docx", "ppt", "pptx", "xls", "xlsx", "hwp", "hwpx",
];

/// Check if a file extension is a previewable document.
fn is_document_extension(ext: &str) -> bool {
    DOCUMENT_EXTENSIONS.contains(&ext.to_lowercase().as_str())
}

/// Convert a document file to PDF using LibreOffice headless.
/// Returns the path to the cached PDF file.
#[tauri::command]
async fn convert_to_preview_pdf(app: tauri::AppHandle, file_path: String) -> Result<String, String> {
    // Validate file exists
    let source = PathBuf::from(&file_path);
    if !source.exists() {
        return Err(format!("File not found: {}", file_path));
    }

    // Check extension
    let ext = source.extension()
        .and_then(|e| e.to_str())
        .unwrap_or("");
    if !is_document_extension(ext) {
        return Err(format!("Unsupported document type: .{}", ext));
    }

    // Get mtime for cache invalidation
    let mtime = source.metadata()
        .and_then(|m| m.modified())
        .map(|t| t.duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs())
        .unwrap_or(0);

    // Check cache
    let cache_dir = get_preview_cache_dir(&app)?;
    let cache_key = preview_cache_key(&file_path, mtime);
    let cached_pdf = cache_dir.join(format!("{}.pdf", cache_key));

    if cached_pdf.exists() {
        return Ok(cached_pdf.to_string_lossy().to_string());
    }

    // Detect LibreOffice
    let lo_path = detect_libreoffice_path()
        .ok_or_else(|| "LibreOffice not found. Install LibreOffice to preview documents.".to_string())?;

    // Clean old cache entries for this file (different mtime)
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

    // Use a temporary directory for LibreOffice output, then move to cache
    let temp_dir = cache_dir.join("_converting");
    fs::create_dir_all(&temp_dir).map_err(|e| format!("Failed to create temp dir: {}", e))?;

    // Run LibreOffice headless conversion in a blocking thread
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

    // Find the converted PDF in temp dir
    let source_stem = source.file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("output");
    let converted_pdf = temp_dir.join(format!("{}.pdf", source_stem));

    if !converted_pdf.exists() {
        // LibreOffice may produce a slightly different filename; search for any .pdf
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

    // Cleanup temp dir (best effort)
    let _ = fs::remove_dir_all(&temp_dir);

    Ok(cached_pdf.to_string_lossy().to_string())
}

/// Clean up old preview cache files. Returns the number of files removed.
#[tauri::command]
async fn cleanup_preview_cache(app: tauri::AppHandle, max_age_days: Option<u64>) -> Result<u32, String> {
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "windows")]
    apply_gpu_config();

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // Focus the main window when another instance tries to launch
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
                let _ = window.unminimize();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(Mutex::new(SearchState {
            index: None,
            _watcher: None,
            memo_index: None,
            init_in_progress: false,
        }))
        .manage(BulkOperationState {
            cancel_requested: AtomicBool::new(false),
        })
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            parse_frontmatter,
            validate_frontmatter,
            frontmatter_to_yaml,
            yaml_to_frontmatter,
            read_directory,
            read_file,
            write_file,
            create_note,
            create_folder,
            ensure_directory,
            list_files_in_directory,
            read_attachment_folder,
            move_file,
            move_note,
            check_file_exists,
            delete_file,
            delete_folder,
            import_file,
            import_attachment,
            open_in_default_app,
            reveal_in_explorer,
            create_note_with_template,
            rename_file_with_links,
            delete_note,
            update_note_frontmatter,
            touch_note_modified,
            toggle_devtools,
            set_window_icon,
            create_hover_window,
            init_search_index,
            reset_search_state,
            clear_search_index,
            full_text_search,
            query_notes,
            get_relationships,
            get_graph_data,
            reindex_vault,
            get_all_used_tags,
            get_suggestion_terms,
            search_attachments,
            delete_multiple_files,
            delete_attachments_with_links,
            read_comments,
            write_comments,
            read_text_file,
            index_note,
            remove_note_from_index,
            fetch_url_metadata,
            open_url_in_browser,
            index_note_memos,
            collect_calendar_memos,
            // Synology sync safety commands
            get_file_mtime,
            cleanup_old_backups,
            detect_nas_platform,
            // Cache commands for persistent vault cache (Obsidian-style)
            get_files_mtime,
            read_meta_cache,
            write_meta_cache,
            read_frontmatters_batch,
            // Vault lock commands
            vault_lock::check_vault_lock,
            vault_lock::acquire_lock,
            vault_lock::release_lock,
            vault_lock::get_machine_info,
            // Note-level editing lock commands
            acquire_note_lock,
            release_note_lock,
            update_note_lock_heartbeat,
            check_note_lock,
            // GPU compatibility detection
            get_gpu_config,
            set_gpu_config,
            // Bulk tag operations
            bulk_delete_tag,
            bulk_rename_tag,
            bulk_add_tags,
            cancel_bulk_operation,
            // Document preview commands
            check_preview_engine,
            convert_to_preview_pdf,
            cleanup_preview_cache,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
