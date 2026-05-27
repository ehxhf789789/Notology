use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::core::file_io::atomic_write_file;
use crate::core::types::{CommentsWithMtime, CalendarMemo};
use crate::SearchState;
use crate::memo::{MemoQueryFilter, IndexedMemo};

#[tauri::command]
pub fn read_comments(note_path: String) -> Result<CommentsWithMtime, String> {
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
pub fn write_comments(note_path: String, comments_json: String) -> Result<u64, String> {
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
    atomic_write_file(&comments_path, comments_json.as_bytes())?;
    let metadata = fs::metadata(&comments_path).map_err(|e| e.to_string())?;
    let mtime = metadata.modified()
        .map_err(|e| e.to_string())?
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    Ok(mtime)
}

#[tauri::command]
pub async fn index_note_memos(
    note_path: String,
    state: tauri::State<'_, Mutex<SearchState>>,
) -> Result<(), String> {
    let search_state = state.lock().map_err(|e| e.to_string())?;
    let memo_index = search_state.memo_index.as_ref().ok_or("Memo index not initialized")?;
    memo_index.index_note_memos(&note_path)
}

#[tauri::command]
pub async fn remove_note_memos(
    note_path: String,
    state: tauri::State<'_, Mutex<SearchState>>,
) -> Result<(), String> {
    let search_state = state.lock().map_err(|e| e.to_string())?;
    let memo_index = search_state.memo_index.as_ref().ok_or("Memo index not initialized")?;
    memo_index.remove_note_memos(&note_path)
}

#[tauri::command]
pub async fn query_memos(
    filter: MemoQueryFilter,
    state: tauri::State<'_, Mutex<SearchState>>,
) -> Result<Vec<IndexedMemo>, String> {
    let search_state = state.lock().map_err(|e| e.to_string())?;
    let memo_index = search_state.memo_index.as_ref().ok_or("Memo index not initialized")?;
    memo_index.query_memos(&filter)
}

#[tauri::command]
pub async fn reindex_memos(
    state: tauri::State<'_, Mutex<SearchState>>,
) -> Result<(), String> {
    let search_state = state.lock().map_err(|e| e.to_string())?;
    let memo_index = search_state.memo_index.as_ref().ok_or("Memo index not initialized")?;
    memo_index.full_reindex()
}

#[tauri::command]
pub fn collect_calendar_memos(
    container_path: String,
) -> Result<Vec<CalendarMemo>, String> {
    let container = Path::new(&container_path);
    let mut memos = Vec::new();

    fn collect_md_files(dir: &Path, files: &mut Vec<PathBuf>) {
        if let Ok(entries) = fs::read_dir(dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    let dir_name = path.file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or("");
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

            let is_task = comment.get("task")
                .map(|v| !v.is_null())
                .unwrap_or(false);

            let date = if is_task {
                comment.get("task")
                    .and_then(|task| task.get("dueDate"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string()
            } else {
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

            if date.is_empty() {
                continue;
            }

            // 2026-05-26 (HanBin) — extract task.dueTime ("HH:MM") for the
            // Day-view 24-hour timeline. Only tasks carry a time; memos
            // are placed in the "시간 미정" group regardless.
            let due_time = if is_task {
                comment.get("task")
                    .and_then(|task| task.get("dueTime"))
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty())
                    .map(|s| s.to_string())
            } else {
                None
            };

            memos.push(CalendarMemo {
                id,
                content,
                note_path: note_path.to_string_lossy().to_string(),
                note_title: note_title.clone(),
                date,
                is_task,
                resolved,
                anchor_text,
                due_time,
            });
        }
    }

    Ok(memos)
}
