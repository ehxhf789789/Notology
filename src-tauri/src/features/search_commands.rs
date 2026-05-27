use std::sync::{Arc, Mutex};

use tauri::Emitter;

use crate::SearchState;
use crate::search::{SearchIndex, NoteFilter, NoteMetadata, RelationshipData, GraphData, SearchResult as IndexSearchResult};
#[cfg(desktop)]
use crate::search::watcher::VaultWatcher;
use crate::memo::MemoIndex;
use crate::core::types::VaultIntegrityResult;

#[tauri::command]
pub async fn init_search_index(
    vault_path: String,
    state: tauri::State<'_, Mutex<SearchState>>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    {
        let mut search_state = state.lock().map_err(|e| e.to_string())?;

        if search_state.index.is_some() {
            if search_state.vault_path.as_deref() == Some(&vault_path) {
                log::info!("[init_search_index] Already initialized for same vault, re-emitting event");
                drop(search_state);
                let _ = app.emit("search-index-ready", ());
                return Ok(());
            } else {
                log::info!("[init_search_index] Vault changed from {:?} to {}, reinitializing", search_state.vault_path, vault_path);
                search_state.index = None;
                #[cfg(desktop)]
                { search_state._watcher = None; }
                search_state.memo_index = None;
                search_state.vault_path = None;
            }
        }

        if search_state.init_in_progress {
            log::info!("[init_search_index] Init already in progress, returning Ok");
            return Ok(());
        }

        search_state.init_in_progress = true;
    }

    log::info!("[init_search_index] Starting initialization for: {}", vault_path);
    let init_start = std::time::Instant::now();

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

    {
        let mut search_state = state.lock().map_err(|e| e.to_string())?;
        search_state.index = Some(Arc::clone(&index));
        search_state.vault_path = Some(vault_path.clone());
    }

    let _ = app.emit("search-index-ready", ());
    log::info!("[init_search_index] Emitted search-index-ready event");

    #[cfg(desktop)]
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

    {
        let mut search_state = state.lock().map_err(|e| e.to_string())?;
        #[cfg(desktop)]
        { search_state._watcher = watcher; }
        search_state.memo_index = Some(memo_index);
        search_state.vault_path = Some(vault_path.clone());
        search_state.init_in_progress = false;
    }

    log::info!("[init_search_index] Full initialization completed in {:.1}s",
        init_start.elapsed().as_secs_f64());
    Ok(())
}

#[tauri::command]
pub async fn reset_search_state(
    state: tauri::State<'_, Mutex<SearchState>>,
) -> Result<(), String> {
    let mut search_state = state.lock().map_err(|e| e.to_string())?;
    log::info!("[reset_search_state] Clearing search state");
    search_state.index = None;
    #[cfg(desktop)]
    { search_state._watcher = None; }
    search_state.memo_index = None;
    search_state.init_in_progress = false;
    Ok(())
}

#[tauri::command]
pub async fn clear_search_index(
    vault_path: String,
    state: tauri::State<'_, Mutex<SearchState>>,
) -> Result<(), String> {
    log::info!("[clear_search_index] Force clearing index for vault: {}", vault_path);

    {
        let mut search_state = state.lock().map_err(|e| e.to_string())?;
        search_state.index = None;
        #[cfg(desktop)]
        { search_state._watcher = None; }
        search_state.memo_index = None;
    }

    std::thread::sleep(std::time::Duration::from_millis(100));

    let index_dir = SearchIndex::get_index_dir(&vault_path);
    log::info!("[clear_search_index] Deleting index directory: {:?}", index_dir);

    const MAX_ATTEMPTS: u32 = 5;
    const DELAY_MS: u64 = 200;

    for attempt in 1..=MAX_ATTEMPTS {
        if !index_dir.exists() {
            log::info!("[clear_search_index] Index directory already deleted");
            break;
        }

        if let Ok(entries) = std::fs::read_dir(&index_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_file() {
                    let _ = std::fs::remove_file(&path);
                }
            }
        }

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

#[tauri::command]
pub async fn full_text_search(
    query: String,
    limit: Option<usize>,
    state: tauri::State<'_, Mutex<SearchState>>,
) -> Result<Vec<IndexSearchResult>, String> {
    let search_state = state.lock().map_err(|e| e.to_string())?;
    let index = search_state.index.as_ref().ok_or("Search index not initialized")?;
    index.search(&query, limit.unwrap_or(20))
}

#[tauri::command]
pub async fn query_notes(
    filter: NoteFilter,
    state: tauri::State<'_, Mutex<SearchState>>,
) -> Result<Vec<NoteMetadata>, String> {
    let search_state = state.lock().map_err(|e| e.to_string())?;
    let index = search_state.index.as_ref().ok_or("Search index not initialized")?;
    index.query_notes(&filter)
}

#[tauri::command]
pub async fn get_relationships(
    file_path: String,
    state: tauri::State<'_, Mutex<SearchState>>,
) -> Result<RelationshipData, String> {
    let search_state = state.lock().map_err(|e| e.to_string())?;
    let index = search_state.index.as_ref().ok_or("Search index not initialized")?;
    index.get_relationships(&file_path)
}

#[tauri::command]
pub async fn get_graph_data(
    container_path: Option<String>,
    include_attachments: Option<bool>,
    state: tauri::State<'_, Mutex<SearchState>>,
) -> Result<GraphData, String> {
    let search_state = state.lock().map_err(|e| e.to_string())?;
    let index = search_state.index.as_ref().ok_or("Search index not initialized")?;
    index.get_graph_data(container_path.as_deref(), include_attachments.unwrap_or(false))
}

#[tauri::command]
pub async fn reindex_vault(
    state: tauri::State<'_, Mutex<SearchState>>,
) -> Result<(), String> {
    let search_state = state.lock().map_err(|e| e.to_string())?;
    let index = search_state.index.as_ref().ok_or("Search index not initialized")?;
    index.full_reindex()
}

#[tauri::command]
pub async fn incremental_reindex(
    state: tauri::State<'_, Mutex<SearchState>>,
) -> Result<usize, String> {
    let search_state = state.lock().map_err(|e| e.to_string())?;
    let index = search_state.index.as_ref().ok_or("Search index not initialized")?;
    index.incremental_reindex()
}

#[tauri::command]
pub async fn get_all_used_tags(
    state: tauri::State<'_, Mutex<SearchState>>,
) -> Result<Vec<String>, String> {
    let search_state = state.lock().map_err(|e| e.to_string())?;
    let index = search_state.index.as_ref().ok_or("Search index not initialized")?;
    index.get_all_tags()
}

#[tauri::command]
pub async fn get_suggestion_terms(
    limit: Option<usize>,
    state: tauri::State<'_, Mutex<SearchState>>,
) -> Result<Vec<(String, u32)>, String> {
    let search_state = state.lock().map_err(|e| e.to_string())?;
    let index = search_state.index.as_ref().ok_or("Search index not initialized")?;
    index.get_suggestion_terms(limit.unwrap_or(200))
}

#[tauri::command]
pub async fn get_reindex_progress(
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
pub async fn index_note(
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
pub async fn remove_note_from_index(
    path: String,
    state: tauri::State<'_, Mutex<SearchState>>,
) -> Result<(), String> {
    let search_state = state.lock().map_err(|e| e.to_string())?;
    let index = search_state.index.as_ref().ok_or("Search index not initialized")?;
    index.remove_file(std::path::Path::new(&path))
}

#[tauri::command]
pub async fn check_vault_integrity(vault_path: String) -> Result<VaultIntegrityResult, String> {
    use std::collections::HashSet;
    use walkdir::WalkDir;

    let vault = std::path::Path::new(&vault_path);
    let mut note_stems: HashSet<String> = HashSet::new();
    let mut att_folders: Vec<(String, String)> = Vec::new();

    for entry in WalkDir::new(vault)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy();

        if name.starts_with('.') {
            continue;
        }

        if path.is_file() && name.ends_with(".md") {
            if let Ok(rel_path) = path.strip_prefix(vault) {
                let stem = rel_path.with_extension("").to_string_lossy().to_string();
                note_stems.insert(stem);
            }
        } else if path.is_dir() && name.ends_with("_att") {
            if let Ok(rel_path) = path.strip_prefix(vault) {
                let path_str = rel_path.to_string_lossy().to_string();
                let stem = path_str.trim_end_matches("_att").to_string();
                att_folders.push((path_str, stem));
            }
        }
    }

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
