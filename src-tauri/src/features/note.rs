use std::fs;
use std::path::Path;
use std::sync::Mutex;

use crate::core::file_io::{atomic_write_file, get_file_lock, find_vault_root, backup_before_save, resolve_collision, copy_dir_recursive};
use crate::core::types::{FileNode, FileContent};
use crate::core::note_id;
use crate::SearchState;
use crate::LibraryState;

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

        // Track B 2026-05-12: ALL dot-prefixed paths stay hidden including
        // `.attachments/`. HanBin's "single-surface principle" — the only
        // user-facing surface for attachments is the wikilink chip in note
        // bodies. Exposing the folder directly would create two
        // contradictory ways to manage the same attachment (drag from chip
        // vs. drag from folder) and confuse the source-of-truth (chip is
        // canonical, hardlink in `.attachments/` is an implementation detail).
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
    library_state: tauri::State<'_, LibraryState>,
    sync_v2_state: tauri::State<'_, crate::features::sync_v2::commands::SyncEngineState>,
) -> Result<(), String> {
    let trimmed_body = body.trim_start();
    let is_sketch = trimmed_body.starts_with('{') && trimmed_body.contains("\"nodes\":");

    // SKETCH protection: if existing file is sketch but new body is NOT sketch, block the save
    if !is_sketch {
        if let Ok(existing) = std::fs::read_to_string(&path) {
            let has_sketch_fm = existing.contains("sketch: true") || existing.contains("sketch:true")
                || existing.contains("canvas: true") || existing.contains("canvas:true");
            let existing_body = existing.split("---").nth(2).unwrap_or("").trim_start();
            let existing_is_sketch = existing_body.starts_with('{') && existing_body.contains("\"nodes\":");
            if has_sketch_fm || existing_is_sketch {
                log::warn!("[write_file] BLOCKED: TipTap trying to overwrite SKETCH file with markdown: {}", path);
                return Err("SKETCH_PROTECTED".to_string());
            }
        }
    }

    log::info!("[write_file] path={} fm_len={:?} is_sketch={} body_len={}", path, frontmatter.as_ref().map(|s| s.len()), is_sketch, body.len());

    let mut content = match &frontmatter {
        Some(fm) if is_sketch && (fm.trim().is_empty() || (!fm.contains("canvas") && !fm.contains("sketch"))) => {
            // Sketch body with missing/empty/wrong frontmatter → force SKETCH frontmatter
            let title = Path::new(&path).file_stem()
                .map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
            log::warn!("[write_file] Restoring SKETCH frontmatter for: {}", path);
            format!("---\ntype: SKETCH\nsketch: true\ntitle: \"{}\"\ncssclasses:\n  - sketch-type\ntags: []\n---\n\n{}", title, body)
        }
        Some(fm) => format!("---\n{}\n---\n\n{}", fm, body),
        None if is_sketch => {
            // Sketch body with no frontmatter → force SKETCH frontmatter
            let title = Path::new(&path).file_stem()
                .map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
            log::warn!("[write_file] Adding SKETCH frontmatter for: {}", path);
            format!("---\ntype: SKETCH\nsketch: true\ntitle: \"{}\"\ncssclasses:\n  - sketch-type\ntags: []\n---\n\n{}", title, body)
        }
        None => body,
    };

    // Resolve note ID: ensure content has an `id` field in frontmatter
    let note_id_for_library = match note_id::read_id_from_content(&content) {
        Some(existing) => Some(existing),
        None => {
            let new_id = note_id::generate_id();
            content = note_id::insert_id_into_content(&content, &new_id);
            Some(new_id)
        }
    };

    let lock = get_file_lock(&path);
    let _guard = lock.lock().map_err(|e| format!("File lock poisoned: {}", e))?;

    if let Some(vault_root) = find_vault_root(Path::new(&path)) {
        if let Err(e) = backup_before_save(Path::new(&path), &vault_root) {
            log::warn!("Backup before save failed (non-fatal): {}", e);
        }
    }

    // PRIMARY SAVE: write .md file first (source of truth)
    atomic_write_file(Path::new(&path), content.as_bytes())?;

    // BEST-EFFORT: Library commit (failures logged, not propagated)
    if let Some(ref id) = note_id_for_library {
        if let Ok(guard) = library_state.lock() {
            if let Some(ref library) = *guard {
                if let Some(vault_root) = find_vault_root(Path::new(&path)) {
                    if let Ok(relative) = Path::new(&path).strip_prefix(&vault_root) {
                        if let Some(rel_str) = relative.to_str() {
                            match library.commit_version(
                                id,
                                content.as_bytes(),
                                rel_str,
                                vec![],
                            ) {
                                Ok(Some(hash)) => {
                                    log::info!("[write_file] committed: {} -> {}", id, &hash[..16]);
                                    // Tier 1: enqueue for immediate push
                                    if let Some(engine) = sync_v2_state.get() {
                                        engine.enqueue_dirty(
                                            crate::features::sync_v2::dirty_queue::DirtyOperation::NoteUpsert {
                                                note_id: id.clone(),
                                                relative_path: rel_str.to_string(),
                                            }
                                        );
                                    }
                                }
                                Ok(None) => log::debug!("[write_file] unchanged (skip): {}", id),
                                Err(e) => log::error!("[write_file] commit FAILED: {} - {}", id, e),
                            }
                        }
                    }
                }
            }
        }
    }

    Ok(())
}

#[tauri::command]
pub fn create_note(
    dir_path: String,
    title: String,
    note_type: Option<String>,
    _state: tauri::State<'_, Mutex<SearchState>>,
    library_state: tauri::State<'_, LibraryState>,
    sync_v2_state: tauri::State<'_, crate::features::sync_v2::commands::SyncEngineState>,
) -> Result<String, String> {
    let file_name = format!("{}.md", title);
    let file_path = Path::new(&dir_path).join(&file_name);

    if file_path.exists() {
        return Err("File already exists".to_string());
    }

    let now = chrono::Local::now();
    let datetime = now.format("%Y-%m-%dT%H:%M:%S%:z").to_string();
    let ntype = note_type.unwrap_or_else(|| "NOTE".to_string());

    let note_id = note_id::generate_id();
    let content = format!(
        "---\nid: \"{}\"\ncreated: \"{}\"\nmodified: \"{}\"\ntitle: \"{}\"\ntype: \"{}\"\ntags: []\n---\n\n",
        note_id, datetime, datetime, title, ntype
    );

    atomic_write_file(&file_path, content.as_bytes())?;

    // Library commit: register new note in CAS/DAG/RefStore for sync_v2
    log::info!("[create_note] attempting commit for {} at {:?}", note_id, file_path);
    match library_state.lock() {
        Err(e) => log::error!("[create_note] library lock POISONED: {}", e),
        Ok(guard) => match guard.as_ref() {
            None => log::warn!("[create_note] library not initialized (guard=None)"),
            Some(library) => match find_vault_root(&file_path) {
                None => log::error!("[create_note] find_vault_root returned None for {:?}", file_path),
                Some(vault_root) => match file_path.strip_prefix(&vault_root) {
                    Err(e) => log::error!("[create_note] strip_prefix failed: {:?} vs {:?}: {}", file_path, vault_root, e),
                    Ok(relative) => match relative.to_str() {
                        None => log::error!("[create_note] relative path not valid UTF-8: {:?}", relative),
                        Some(rel_str) => {
                            match library.commit_version(&note_id, content.as_bytes(), rel_str, vec![]) {
                                Ok(Some(hash)) => {
                                    log::info!("[create_note] committed: {} -> {}", note_id, &hash[..16]);
                                    if let Some(engine) = sync_v2_state.get() {
                                        engine.enqueue_dirty(
                                            crate::features::sync_v2::dirty_queue::DirtyOperation::NoteUpsert {
                                                note_id: note_id.clone(),
                                                relative_path: rel_str.to_string(),
                                            }
                                        );
                                    }
                                }
                                Ok(None) => log::debug!("[create_note] unchanged (skip): {}", note_id),
                                Err(e) => log::warn!("[create_note] commit failed: {} - {}", note_id, e),
                            }
                        }
                    },
                },
            },
        },
    }

    Ok(file_path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn create_folder(
    parent_path: String,
    name: String,
    template_frontmatter: Option<String>,
    template_body: Option<String>,
    _state: tauri::State<'_, Mutex<SearchState>>,
    library_state: tauri::State<'_, LibraryState>,
    sync_v2_state: tauri::State<'_, crate::features::sync_v2::commands::SyncEngineState>,
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

    let folder_note_id = note_id::generate_id();
    let frontmatter = template_frontmatter.unwrap_or_else(|| {
        format!(
            "id: \"{}\"\ncreated: \"{}\"\nmodified: \"{}\"\ntitle: \"{}\"\ntype: \"FOLDER\"\ncssclasses: []\ntags: []",
            folder_note_id, datetime, datetime, name
        )
    });

    let body = template_body.unwrap_or_default();
    let mut content = format!("---\n{}\n---\n\n{}", frontmatter, body);
    // Ensure id exists even when template_frontmatter was provided
    if note_id::read_id_from_content(&content).is_none() {
        content = note_id::insert_id_into_content(&content, &folder_note_id);
    }

    atomic_write_file(&note_path, content.as_bytes())?;

    // Library commit for folder note (sync_v2)
    let folder_note_id_final = note_id::read_id_from_content(&content).unwrap_or(folder_note_id);
    log::info!("[create_folder] attempting commit for {} at {:?}", folder_note_id_final, note_path);
    match library_state.lock() {
        Err(e) => log::error!("[create_folder] library lock failed: {}", e),
        Ok(guard) => match guard.as_ref() {
            None => log::warn!("[create_folder] library not initialized"),
            Some(library) => match find_vault_root(&note_path) {
                None => log::error!("[create_folder] find_vault_root None"),
                Some(vault_root) => match note_path.strip_prefix(&vault_root) {
                    Err(e) => log::error!("[create_folder] strip_prefix: {}", e),
                    Ok(relative) => match relative.to_str() {
                        None => log::error!("[create_folder] path not UTF-8"),
                        Some(rel_str) => {
                            match library.commit_version(&folder_note_id_final, content.as_bytes(), rel_str, vec![]) {
                                Ok(Some(hash)) => {
                                    log::info!("[create_folder] committed: {} -> {}", folder_note_id_final, &hash[..16]);
                                    if let Some(engine) = sync_v2_state.get() {
                                        engine.enqueue_dirty(
                                            crate::features::sync_v2::dirty_queue::DirtyOperation::NoteUpsert {
                                                note_id: folder_note_id_final.clone(),
                                                relative_path: rel_str.replace('\\', "/"),
                                            }
                                        );
                                    }
                                }
                                Ok(None) => log::debug!("[create_folder] unchanged: {}", folder_note_id_final),
                                Err(e) => log::warn!("[create_folder] commit failed: {} - {}", folder_note_id_final, e),
                            }
                        }
                    },
                },
            },
        },
    }

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
pub fn delete_folder(
    path: String,
    library_state: tauri::State<'_, LibraryState>,
    sync_v2_state: tauri::State<'_, crate::features::sync_v2::commands::SyncEngineState>,
) -> Result<(), String> {
    delete_folder_inner(Path::new(&path), &library_state, &sync_v2_state)
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
pub fn move_note(
    note_path: String,
    new_dir: String,
    library_state: tauri::State<'_, LibraryState>,
    sync_v2_state: tauri::State<'_, crate::features::sync_v2::commands::SyncEngineState>,
) -> Result<String, String> {
    let old = Path::new(&note_path);
    if !old.exists() {
        return Err("Note does not exist".to_string());
    }

    let stem = old
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    let old_parent_dir = old.parent().ok_or("Invalid note path")?;

    // Check if this is a folder note: the note sits inside a directory with the same name
    // e.g., 테스트/폴더/폴더.md → old_parent_dir = 테스트/폴더, stem = 폴더
    let parent_dir_name = old_parent_dir.file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let is_folder_note = parent_dir_name == stem;

    if is_folder_note {
        // === Folder note: move entire directory ===
        return move_folder_cascade(
            old_parent_dir, &stem, &new_dir,
            &library_state, &sync_v2_state,
        );
    }

    // === Regular note: move single file + _att ===

    // Capture old relative path + note_id BEFORE move
    let note_id = crate::core::note_id::read_id_from_file(old).ok().flatten();
    let old_relative = {
        let guard = library_state.lock().unwrap_or_else(|e| e.into_inner());
        guard.as_ref().and_then(|lib| {
            old.strip_prefix(lib.vault_path()).ok()
                .and_then(|r| r.to_str())
                .map(|s| s.replace('\\', "/"))
        })
    };

    let attachments_name = format!("{}_att", stem);
    let old_att = old_parent_dir.join(&attachments_name);

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

    // Sync: enqueue move (old path delete + new path push)
    let new_relative = {
        let guard = library_state.lock().unwrap_or_else(|e| e.into_inner());
        guard.as_ref().and_then(|lib| {
            new_note.strip_prefix(lib.vault_path()).ok()
                .and_then(|r| r.to_str())
                .map(|s| s.replace('\\', "/"))
        })
    };

    if let (Some(nid), Some(old_rel), Some(new_rel)) = (note_id, old_relative, new_relative) {
        // Update local ref path
        if let Ok(guard) = library_state.lock() {
            if let Some(lib) = guard.as_ref() {
                if let Ok(Some(mut note_ref)) = lib.refs().get(&nid) {
                    note_ref.relative_path = new_rel.clone();
                    note_ref.updated_at = chrono::Utc::now();
                    let _ = lib.refs().set(&note_ref);
                    log::info!("[move_note] updated ref path: {} → {}", old_rel, new_rel);
                }
            }
        }
        // Enqueue move for NAS sync
        if let Some(engine) = sync_v2_state.get() {
            engine.enqueue_dirty(
                crate::features::sync_v2::dirty_queue::DirtyOperation::NoteMove {
                    note_id: nid,
                    old_path: old_rel,
                    new_path: new_rel,
                }
            );
        }
    }

    Ok(new_note.to_string_lossy().to_string())
}

/// Move an entire folder (container) with all its contents to a new parent.
/// Updates all inner notes' refs and enqueues sync operations.
fn move_folder_cascade(
    old_folder_dir: &Path,  // e.g., vault/테스트/폴더
    folder_name: &str,      // e.g., "폴더"
    new_parent_dir: &str,   // e.g., vault/Test
    library_state: &LibraryState,
    sync_v2_state: &crate::features::sync_v2::commands::SyncEngineState,
) -> Result<String, String> {
    let new_parent = Path::new(new_parent_dir);
    if !new_parent.exists() {
        fs::create_dir_all(new_parent).map_err(|e| e.to_string())?;
    }

    let new_folder_dir = new_parent.join(folder_name);
    if new_folder_dir.exists() {
        return Err(format!("Folder already exists at {:?}", new_folder_dir));
    }

    // Get vault root for relative path computation
    let vault_root = {
        let guard = library_state.lock().unwrap_or_else(|e| e.into_inner());
        guard.as_ref().map(|lib| lib.vault_path().to_path_buf())
    };

    // Collect all .md files BEFORE moving (for ref updates)
    let mut notes_to_update: Vec<(String, String, String)> = Vec::new(); // (note_id, old_rel, new_rel)
    if let Some(ref vroot) = vault_root {
        fn collect_notes(dir: &Path, vault_root: &Path, old_base: &Path, new_base: &Path, out: &mut Vec<(String, String, String)>) {
            if let Ok(entries) = std::fs::read_dir(dir) {
                for entry in entries.flatten() {
                    let p = entry.path();
                    if p.is_dir() {
                        let name = p.file_name().unwrap_or_default().to_string_lossy();
                        if !name.ends_with("_att") && name != ".notology" {
                            collect_notes(&p, vault_root, old_base, new_base, out);
                        }
                    } else if p.extension().and_then(|e| e.to_str()) == Some("md") {
                        if let Ok(Some(id)) = crate::core::note_id::read_id_from_file(&p) {
                            if let Ok(old_rel) = p.strip_prefix(vault_root) {
                                // Compute new relative path
                                if let Ok(within_folder) = p.strip_prefix(old_base) {
                                    let new_abs = new_base.join(within_folder);
                                    if let Ok(new_rel) = new_abs.strip_prefix(vault_root) {
                                        let old_s = old_rel.to_str().unwrap_or("").replace('\\', "/");
                                        let new_s = new_rel.to_str().unwrap_or("").replace('\\', "/");
                                        out.push((id, old_s, new_s));
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        collect_notes(old_folder_dir, vroot, old_folder_dir, &new_folder_dir, &mut notes_to_update);
    }

    log::info!("[move_note] folder cascade: {:?} → {:?} ({} notes)",
        old_folder_dir, new_folder_dir, notes_to_update.len());

    // Move the entire directory
    fs::rename(old_folder_dir, &new_folder_dir).or_else(|_| {
        copy_dir_recursive(old_folder_dir, &new_folder_dir)?;
        fs::remove_dir_all(old_folder_dir).map_err(|e| e.to_string())
    })?;

    // Update all inner notes' refs + enqueue sync
    if let Ok(guard) = library_state.lock() {
        if let Some(lib) = guard.as_ref() {
            for (note_id, _old_rel, new_rel) in &notes_to_update {
                if let Ok(Some(mut note_ref)) = lib.refs().get(note_id) {
                    note_ref.relative_path = new_rel.clone();
                    note_ref.updated_at = chrono::Utc::now();
                    let _ = lib.refs().set(&note_ref);
                }
            }
        }
    }
    if let Some(engine) = sync_v2_state.get() {
        for (note_id, old_rel, new_rel) in &notes_to_update {
            engine.enqueue_dirty(
                crate::features::sync_v2::dirty_queue::DirtyOperation::NoteMove {
                    note_id: note_id.clone(),
                    old_path: old_rel.clone(),
                    new_path: new_rel.clone(),
                }
            );
        }
        // Enqueue old folder deletion on NAS
        if let Some(ref vroot) = vault_root {
            if let Ok(old_rel) = old_folder_dir.strip_prefix(vroot) {
                if let Some(rel_str) = old_rel.to_str() {
                    engine.enqueue_dirty(
                        crate::features::sync_v2::dirty_queue::DirtyOperation::FolderDelete {
                            relative_path: rel_str.replace('\\', "/"),
                        }
                    );
                }
            }
        }
    }

    // Return the new folder note path
    let new_folder_note = new_folder_dir.join(format!("{}.md", folder_name));
    Ok(new_folder_note.to_string_lossy().to_string())
}

#[tauri::command]
pub fn create_note_with_template(
    dir_path: String,
    file_name: String,
    frontmatter_yaml: String,
    body: String,
    library_state: tauri::State<'_, LibraryState>,
    sync_v2_state: tauri::State<'_, crate::features::sync_v2::commands::SyncEngineState>,
) -> Result<String, String> {
    let dir = Path::new(&dir_path);
    if !dir.exists() {
        return Err("Directory does not exist".to_string());
    }

    let target = dir.join(format!("{}.md", file_name));
    let final_path = resolve_collision(&target);

    let mut content = format!("---\n{}\n---\n\n{}", frontmatter_yaml, body);
    // Ensure id exists (template may or may not include one)
    let note_id = match note_id::read_id_from_content(&content) {
        Some(id) => id,
        None => {
            let new_id = note_id::generate_id();
            content = note_id::insert_id_into_content(&content, &new_id);
            new_id
        }
    };

    atomic_write_file(&final_path, content.as_bytes())?;

    // Library commit for sync_v2
    log::info!("[create_note_with_template] attempting commit for {} at {:?}", note_id, final_path);
    match library_state.lock() {
        Err(e) => log::error!("[create_note_with_template] library lock POISONED: {}", e),
        Ok(guard) => match guard.as_ref() {
            None => log::warn!("[create_note_with_template] library not initialized"),
            Some(library) => match find_vault_root(&final_path) {
                None => log::error!("[create_note_with_template] find_vault_root None for {:?}", final_path),
                Some(vault_root) => match final_path.strip_prefix(&vault_root) {
                    Err(e) => log::error!("[create_note_with_template] strip_prefix failed: {}", e),
                    Ok(relative) => match relative.to_str() {
                        None => log::error!("[create_note_with_template] path not UTF-8"),
                        Some(rel_str) => {
                            match library.commit_version(&note_id, content.as_bytes(), rel_str, vec![]) {
                                Ok(Some(hash)) => {
                                    log::info!("[create_note_with_template] committed: {} -> {}", note_id, &hash[..16]);
                                    if let Some(engine) = sync_v2_state.get() {
                                        engine.enqueue_dirty(
                                            crate::features::sync_v2::dirty_queue::DirtyOperation::NoteUpsert {
                                                note_id: note_id.clone(),
                                                relative_path: rel_str.to_string(),
                                            }
                                        );
                                    }
                                }
                                Ok(None) => log::debug!("[create_note_with_template] unchanged: {}", note_id),
                                Err(e) => log::warn!("[create_note_with_template] commit failed: {} - {}", note_id, e),
                            }
                        }
                    },
                },
            },
        },
    }

    Ok(final_path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn delete_note(
    note_path: String,
    library_state: tauri::State<'_, LibraryState>,
    sync_v2_state: tauri::State<'_, crate::features::sync_v2::commands::SyncEngineState>,
) -> Result<(), String> {
    let path = Path::new(&note_path);
    if !path.exists() {
        return Err("Note does not exist".to_string());
    }

    let stem = path.file_stem().unwrap_or_default().to_string_lossy().to_string();
    let parent = path.parent().unwrap();

    // Check if this is a folder note (parent dir name == stem)
    let parent_dir_name = parent.file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let is_folder_note = parent_dir_name == stem && parent.is_dir();

    if is_folder_note {
        // Folder note: delegate to delete_folder which handles cascading
        log::info!("[delete_note] detected folder note, cascading to delete_folder: {:?}", parent);
        return delete_folder_inner(parent, &library_state, &sync_v2_state);
    }

    // === Regular note deletion → move to trash ===

    let note_id = crate::core::note_id::read_id_from_file(path).ok().flatten();
    let relative_path = {
        let guard = library_state.lock().unwrap_or_else(|e| e.into_inner());
        guard.as_ref().and_then(|lib| {
            path.strip_prefix(lib.vault_path()).ok()
                .and_then(|r| r.to_str())
                .map(|s| s.replace('\\', "/"))
        })
    };

    let vault_root = {
        let guard = library_state.lock().unwrap_or_else(|e| e.into_inner());
        guard.as_ref().map(|lib| lib.vault_path().to_path_buf())
    };

    if let (Some(ref nid), Some(ref rel), Some(ref vroot)) = (&note_id, &relative_path, &vault_root) {
        // Move to trash (preserves file for 30 days)
        match crate::features::sync_v2::trash::move_to_trash(vroot, path, nid, rel) {
            Ok(_) => log::info!("[delete_note] moved to trash: {}", nid),
            Err(e) => {
                log::warn!("[delete_note] trash failed, falling back to permanent delete: {}", e);
                // Fallback: permanent delete
                let attachments_dir = parent.join(format!("{}_att", stem));
                if attachments_dir.exists() && attachments_dir.is_dir() {
                    let _ = fs::remove_dir_all(&attachments_dir);
                }
                let _ = fs::remove_file(path);
            }
        }

        // Delete local ref + enqueue NAS deletion (regardless of trash/permanent)
        if let Ok(guard) = library_state.lock() {
            if let Some(lib) = guard.as_ref() {
                let _ = lib.refs().delete(nid);
                log::info!("[delete_note] deleted ref: {}", nid);
            }
        }
        if let Some(engine) = sync_v2_state.get() {
            engine.enqueue_dirty(
                crate::features::sync_v2::dirty_queue::DirtyOperation::NoteDelete {
                    note_id: nid.clone(),
                    relative_path: rel.clone(),
                }
            );
        }
    } else {
        // No note_id or relative_path — permanent delete only
        let attachments_dir = parent.join(format!("{}_att", stem));
        if attachments_dir.exists() && attachments_dir.is_dir() {
            let _ = fs::remove_dir_all(&attachments_dir);
        }
        fs::remove_file(path).map_err(|e| e.to_string())?;
    }

    Ok(())
}

/// Internal folder deletion with sync_v2 — shared by delete_note (folder note) and delete_folder.
fn delete_folder_inner(
    folder_path: &Path,
    library_state: &LibraryState,
    sync_v2_state: &crate::features::sync_v2::commands::SyncEngineState,
) -> Result<(), String> {
    if !folder_path.exists() {
        return Err("Folder does not exist".to_string());
    }
    if !folder_path.is_dir() {
        return Err("Path is not a directory".to_string());
    }

    let vault_root = {
        let guard = library_state.lock().unwrap_or_else(|e| e.into_inner());
        guard.as_ref().map(|lib| lib.vault_path().to_path_buf())
    };

    // Collect all .md files BEFORE deletion
    let mut notes_to_delete: Vec<(String, String)> = Vec::new();
    if let Some(ref vroot) = vault_root {
        fn collect_md(dir: &Path, vault_root: &Path, out: &mut Vec<(String, String)>) {
            if let Ok(entries) = std::fs::read_dir(dir) {
                for entry in entries.flatten() {
                    let p = entry.path();
                    if p.is_dir() {
                        let name = p.file_name().unwrap_or_default().to_string_lossy();
                        if !name.ends_with("_att") && name != ".notology" {
                            collect_md(&p, vault_root, out);
                        }
                    } else if p.extension().and_then(|e| e.to_str()) == Some("md") {
                        if let Ok(Some(id)) = crate::core::note_id::read_id_from_file(&p) {
                            if let Ok(rel) = p.strip_prefix(vault_root) {
                                if let Some(s) = rel.to_str() {
                                    out.push((id, s.replace('\\', "/")));
                                }
                            }
                        }
                    }
                }
            }
        }
        collect_md(folder_path, vroot, &mut notes_to_delete);
    }

    log::info!("[delete_folder] deleting {:?} with {} notes inside", folder_path, notes_to_delete.len());

    fs::remove_dir_all(folder_path).map_err(|e| e.to_string())?;

    // Delete refs + enqueue NAS deletions
    if let Ok(guard) = library_state.lock() {
        if let Some(lib) = guard.as_ref() {
            for (note_id, _) in &notes_to_delete {
                let _ = lib.refs().delete(note_id);
            }
        }
    }
    if let Some(engine) = sync_v2_state.get() {
        for (note_id, rel_path) in &notes_to_delete {
            engine.enqueue_dirty(
                crate::features::sync_v2::dirty_queue::DirtyOperation::NoteDelete {
                    note_id: note_id.clone(),
                    relative_path: rel_path.clone(),
                }
            );
        }
        if let Some(ref vroot) = vault_root {
            if let Ok(rel) = folder_path.strip_prefix(vroot) {
                if let Some(s) = rel.to_str() {
                    engine.enqueue_dirty(
                        crate::features::sync_v2::dirty_queue::DirtyOperation::FolderDelete {
                            relative_path: s.replace('\\', "/"),
                        }
                    );
                }
            }
        }
    }

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

#[cfg(desktop)]
#[tauri::command]
pub fn open_in_default_app(path: String) -> Result<(), String> {
    opener::open(Path::new(&path)).map_err(|e| e.to_string())
}

#[cfg(not(desktop))]
#[tauri::command]
pub fn open_in_default_app(path: String) -> Result<(), String> {
    tauri_plugin_opener::open_path(Path::new(&path), None::<&str>)
        .map_err(|e| format!("Failed to open file: {}", e))
}

#[cfg(desktop)]
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

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        Err("reveal_in_explorer is not supported on this platform".into())
    }
}

#[cfg(not(desktop))]
#[tauri::command]
pub fn reveal_in_explorer(_path: String) -> Result<(), String> {
    Err("Not available on mobile".into())
}

/// Read a file as binary bytes (for JavaScript document viewers).
#[tauri::command]
pub async fn read_binary_file(path: String) -> Result<Vec<u8>, String> {
    tokio::fs::read(&path).await
        .map_err(|e| format!("Failed to read file: {}", e))
}
