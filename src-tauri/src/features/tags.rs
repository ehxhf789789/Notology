use std::fs;
use std::path::Path;
use std::sync::Mutex;
use std::sync::atomic::Ordering;

use tauri::Emitter;

use crate::core::file_io::{atomic_write_file, get_file_lock, find_vault_root, backup_before_save};
use crate::core::types::{BulkTagProgress, BulkTagResult};
use crate::{SearchState, BulkOperationState};
use crate::search::NoteFilter;

/// Modify a tag in a frontmatter YAML string.
pub fn modify_tag_in_frontmatter_yaml(
    yaml_str: &str,
    namespace: &str,
    old_name: &str,
    new_name: Option<&str>,
) -> Result<Option<String>, String> {
    let mut value: serde_yaml::Value =
        serde_yaml::from_str(yaml_str).map_err(|e| format!("YAML parse error: {}", e))?;

    let tags = match value.get_mut("tags") {
        Some(t) => t,
        None => return Ok(None),
    };

    let ns_value = match tags.get_mut(namespace) {
        Some(v) => v,
        None => return Ok(None),
    };

    let seq = match ns_value.as_sequence_mut() {
        Some(s) => s,
        None => return Ok(None),
    };

    let mut found = false;

    if let Some(new) = new_name {
        for item in seq.iter_mut() {
            if let Some(s) = item.as_str() {
                if s == old_name {
                    *item = serde_yaml::Value::String(new.to_string());
                    found = true;
                }
            }
        }
    } else {
        seq.retain(|item| {
            if let Some(s) = item.as_str() {
                if s == old_name {
                    found = true;
                    return false;
                }
            }
            true
        });
    }

    if !found {
        return Ok(None);
    }

    if new_name.is_none() && seq.is_empty() {
        if let Some(tags_map) = tags.as_mapping_mut() {
            tags_map.remove(&serde_yaml::Value::String(namespace.to_string()));
        }
    }

    let result = serde_yaml::to_string(&value).map_err(|e| format!("YAML serialize error: {}", e))?;
    Ok(Some(result.trim_end_matches('\n').to_string()))
}

/// Parse "namespace/tagname" into (namespace, tagname)
pub fn parse_namespaced_tag(tag: &str) -> Result<(String, String), String> {
    let parts: Vec<&str> = tag.splitn(2, '/').collect();
    if parts.len() != 2 || parts[0].is_empty() || parts[1].is_empty() {
        return Err(format!("Invalid tag format '{}'. Expected 'namespace/tagname'", tag));
    }
    Ok((parts[0].to_string(), parts[1].to_string()))
}

/// Modify a single note's tag in frontmatter.
pub fn modify_note_tag(
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

    if let Some(vault_root) = find_vault_root(path) {
        let _ = backup_before_save(path, &vault_root);
    }

    let content = fs::read_to_string(path).map_err(|e| e.to_string())?;
    if !content.starts_with("---") {
        return Ok(false);
    }

    let end_idx = match content[3..].find("\n---") {
        Some(idx) => idx,
        None => return Ok(false),
    };

    let fm_yaml = &content[4..3 + end_idx];
    let body = &content[3 + end_idx + 4..];

    match modify_tag_in_frontmatter_yaml(fm_yaml, namespace, old_name, new_name)? {
        Some(new_yaml) => {
            let new_content = format!("---\n{}\n---{}", new_yaml, body);
            atomic_write_file(path, new_content.as_bytes())?;
            Ok(true)
        }
        None => Ok(false),
    }
}

/// Add a tag to a single note's frontmatter.
pub fn add_tag_to_note(
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

    if let Some(vault_root) = find_vault_root(path) {
        let _ = backup_before_save(path, &vault_root);
    }

    let content = fs::read_to_string(path).map_err(|e| e.to_string())?;
    if !content.starts_with("---") {
        return Ok(false);
    }

    let end_idx = match content[3..].find("\n---") {
        Some(idx) => idx,
        None => return Ok(false),
    };

    let fm_yaml = &content[4..3 + end_idx];
    let body = &content[3 + end_idx + 4..];

    let mut value: serde_yaml::Value =
        serde_yaml::from_str(fm_yaml).map_err(|e| format!("YAML parse error: {}", e))?;

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

    let tag_lower = tag_name.to_lowercase();
    let already_exists = seq.iter().any(|item| {
        item.as_str().map(|s| s.to_lowercase() == tag_lower).unwrap_or(false)
    });
    if already_exists {
        return Ok(false);
    }

    seq.push(serde_yaml::Value::String(tag_name.to_string()));

    let new_yaml = serde_yaml::to_string(&value)
        .map_err(|e| format!("YAML serialize error: {}", e))?;
    let new_yaml = new_yaml.trim_end_matches('\n');
    let new_content = format!("---\n{}\n---{}", new_yaml, body);
    atomic_write_file(path, new_content.as_bytes())?;
    Ok(true)
}

#[tauri::command]
pub async fn bulk_delete_tag(
    tag: String,
    state: tauri::State<'_, Mutex<SearchState>>,
    bulk_state: tauri::State<'_, BulkOperationState>,
    app: tauri::AppHandle,
) -> Result<BulkTagResult, String> {
    bulk_state.cancel_requested.store(false, Ordering::SeqCst);

    let (namespace, tag_name) = parse_namespaced_tag(&tag)?;

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
        if bulk_state.cancel_requested.load(Ordering::Relaxed) {
            return Ok(BulkTagResult { affected_count, failed_paths, cancelled: true });
        }

        let _ = app.emit("tag-operation-progress", BulkTagProgress {
            total,
            completed: i,
            current_path: note_path.clone(),
        });

        match modify_note_tag(note_path, &namespace, &tag_name, None) {
            Ok(true) => {
                affected_count += 1;
                let search_state = state.lock().map_err(|e| e.to_string())?;
                if let Some(index) = search_state.index.as_ref() {
                    let _ = index.index_file(Path::new(note_path));
                }
            }
            Ok(false) => {}
            Err(e) => {
                log::warn!("Failed to modify tag in {}: {}", note_path, e);
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

#[tauri::command]
pub async fn bulk_rename_tag(
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

#[tauri::command]
pub async fn cancel_bulk_operation(
    bulk_state: tauri::State<'_, BulkOperationState>,
) -> Result<(), String> {
    bulk_state.cancel_requested.store(true, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
pub async fn bulk_add_tags(
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
                let search_state = state.lock().map_err(|e| e.to_string())?;
                if let Some(index) = search_state.index.as_ref() {
                    let _ = index.index_file(Path::new(note_path));
                }
            }
            Ok(false) => {}
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
