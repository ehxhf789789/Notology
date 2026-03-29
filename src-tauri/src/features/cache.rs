use rayon::prelude::*;
use std::fs;
use std::path::Path;

use crate::core::file_io::atomic_write_file;
use crate::core::types::{FileMeta, FrontmatterOnly};

#[tauri::command]
pub fn get_files_mtime(paths: Vec<String>) -> Vec<FileMeta> {
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

#[tauri::command]
pub fn get_file_mtime(path: String) -> u64 {
    use std::time::UNIX_EPOCH;

    Path::new(&path)
        .metadata()
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[tauri::command]
pub fn read_meta_cache(vault_path: String) -> Result<String, String> {
    let cache_path = Path::new(&vault_path).join(".notology").join("content-cache.json");
    if cache_path.exists() {
        fs::read_to_string(&cache_path).map_err(|e| e.to_string())
    } else {
        Ok(String::new())
    }
}

#[tauri::command]
pub fn write_meta_cache(vault_path: String, cache_json: String) -> Result<(), String> {
    let notology_dir = Path::new(&vault_path).join(".notology");
    if !notology_dir.exists() {
        fs::create_dir_all(&notology_dir).map_err(|e| e.to_string())?;
    }

    let cache_path = notology_dir.join("content-cache.json");
    atomic_write_file(&cache_path, cache_json.as_bytes())?;

    Ok(())
}

#[tauri::command]
pub fn read_frontmatters_batch(paths: Vec<String>) -> Vec<FrontmatterOnly> {
    use std::io::BufRead;
    use std::time::UNIX_EPOCH;

    paths
        .into_par_iter()
        .filter_map(|path| {
            let p = Path::new(&path);
            if !p.exists() {
                return None;
            }

            let mtime = fs::metadata(p).ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);

            let file = fs::File::open(p).ok()?;
            let reader = std::io::BufReader::new(file);
            let mut lines = reader.lines();

            let first_line = lines.next()?.ok()?;
            if first_line.trim() != "---" {
                return Some(FrontmatterOnly {
                    path,
                    frontmatter: None,
                    mtime,
                });
            }

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

#[tauri::command]
pub fn read_index_state(vault_path: String) -> Result<String, String> {
    let state_path = Path::new(&vault_path).join(".notology").join("index-state.json");
    if state_path.exists() {
        fs::read_to_string(&state_path).map_err(|e| e.to_string())
    } else {
        Ok(String::new())
    }
}

#[tauri::command]
pub fn write_index_state(vault_path: String, state_json: String) -> Result<(), String> {
    let notology_dir = Path::new(&vault_path).join(".notology");
    if !notology_dir.exists() {
        fs::create_dir_all(&notology_dir).map_err(|e| e.to_string())?;
    }

    let state_path = notology_dir.join("index-state.json");
    atomic_write_file(&state_path, state_json.as_bytes())?;

    Ok(())
}
