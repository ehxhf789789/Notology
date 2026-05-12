//! Trash: soft-delete notes to .notology/trash/ instead of permanent deletion.
//! Retained for 30 days, then auto-cleaned by ReconciliationScanner (Track K).

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

const TRASH_DIR: &str = ".notology/trash";
const RETENTION_DAYS: i64 = 30;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrashEntry {
    pub note_id: String,
    pub original_path: String,  // relative to vault root
    pub deleted_at: DateTime<Utc>,
    pub trash_filename: String,  // filename in trash dir
}

/// Move a note (and its _att folder) to trash.
pub fn move_to_trash(
    vault_path: &Path,
    note_abs_path: &Path,
    note_id: &str,
    relative_path: &str,
) -> Result<TrashEntry, String> {
    let date_str = Utc::now().format("%Y-%m-%d").to_string();
    let trash_dir = vault_path.join(TRASH_DIR).join(&date_str);
    fs::create_dir_all(&trash_dir).map_err(|e| format!("mkdir trash: {}", e))?;

    let stem = note_abs_path.file_stem()
        .unwrap_or_default().to_string_lossy().to_string();
    let trash_filename = format!("{}_{}.md", note_id, stem);
    let trash_dest = trash_dir.join(&trash_filename);

    // Move .md file
    fs::rename(note_abs_path, &trash_dest).or_else(|_| {
        fs::copy(note_abs_path, &trash_dest).map_err(|e| format!("copy: {}", e))?;
        fs::remove_file(note_abs_path).map_err(|e| format!("remove: {}", e))
    })?;

    // Move _att folder if exists
    let parent = note_abs_path.parent().unwrap_or(vault_path);
    let att_dir = parent.join(format!("{}_att", stem));
    if att_dir.exists() && att_dir.is_dir() {
        let trash_att = trash_dir.join(format!("{}_{}_att", note_id, stem));
        fs::rename(&att_dir, &trash_att).or_else(|_| {
            crate::core::file_io::copy_dir_recursive(&att_dir, &trash_att)?;
            fs::remove_dir_all(&att_dir).map_err(|e| e.to_string())
        })?;
    }

    // Write metadata
    let entry = TrashEntry {
        note_id: note_id.to_string(),
        original_path: relative_path.to_string(),
        deleted_at: Utc::now(),
        trash_filename: trash_filename.clone(),
    };
    let meta_path = trash_dir.join(format!("{}.meta.json", trash_filename.trim_end_matches(".md")));
    let meta_bytes = serde_json::to_vec_pretty(&entry)
        .map_err(|e| format!("serialize meta: {}", e))?;
    fs::write(&meta_path, meta_bytes).map_err(|e| format!("write meta: {}", e))?;

    log::info!("[trash] moved to trash: {} ({})", note_id, relative_path);
    Ok(entry)
}

/// List all trash entries.
pub fn list_trash(vault_path: &Path) -> Result<Vec<TrashEntry>, String> {
    let trash_root = vault_path.join(TRASH_DIR);
    if !trash_root.exists() {
        return Ok(Vec::new());
    }

    let mut entries = Vec::new();
    for date_dir in fs::read_dir(&trash_root).map_err(|e| format!("read trash: {}", e))? {
        let date_dir = date_dir.map_err(|e| format!("entry: {}", e))?;
        if !date_dir.path().is_dir() { continue; }
        for file in fs::read_dir(date_dir.path()).map_err(|e| format!("read date: {}", e))? {
            let file = file.map_err(|e| format!("file: {}", e))?;
            let name = file.file_name().to_string_lossy().to_string();
            if name.ends_with(".meta.json") {
                if let Ok(bytes) = fs::read(file.path()) {
                    if let Ok(entry) = serde_json::from_slice::<TrashEntry>(&bytes) {
                        entries.push(entry);
                    }
                }
            }
        }
    }
    entries.sort_by(|a, b| b.deleted_at.cmp(&a.deleted_at));
    Ok(entries)
}

/// Restore a note from trash to its original location.
pub fn restore_from_trash(
    vault_path: &Path,
    note_id: &str,
) -> Result<TrashEntry, String> {
    let trash_root = vault_path.join(TRASH_DIR);

    // Find the entry
    for date_dir in fs::read_dir(&trash_root).map_err(|e| format!("read: {}", e))? {
        let date_dir = date_dir.map_err(|e| e.to_string())?;
        if !date_dir.path().is_dir() { continue; }
        for file in fs::read_dir(date_dir.path()).map_err(|e| e.to_string())? {
            let file = file.map_err(|e| e.to_string())?;
            let name = file.file_name().to_string_lossy().to_string();
            if name.ends_with(".meta.json") {
                if let Ok(bytes) = fs::read(file.path()) {
                    if let Ok(entry) = serde_json::from_slice::<TrashEntry>(&bytes) {
                        if entry.note_id == note_id {
                            // Restore .md
                            let trash_md = date_dir.path().join(&entry.trash_filename);
                            let restore_path = vault_path.join(&entry.original_path);
                            if let Some(parent) = restore_path.parent() {
                                let _ = fs::create_dir_all(parent);
                            }
                            fs::rename(&trash_md, &restore_path)
                                .map_err(|e| format!("restore: {}", e))?;

                            // Restore _att if exists
                            let stem = entry.trash_filename.trim_end_matches(".md");
                            let trash_att = date_dir.path().join(format!("{}_att", stem));
                            if trash_att.exists() {
                                let orig_stem = Path::new(&entry.original_path)
                                    .file_stem().unwrap_or_default().to_string_lossy().to_string();
                                let orig_parent = vault_path.join(&entry.original_path).parent()
                                    .unwrap_or(vault_path).to_path_buf();
                                let restore_att = orig_parent.join(format!("{}_att", orig_stem));
                                let _ = fs::rename(&trash_att, &restore_att);
                            }

                            // Remove meta
                            let _ = fs::remove_file(file.path());

                            log::info!("[trash] restored: {} → {}", note_id, entry.original_path);
                            return Ok(entry);
                        }
                    }
                }
            }
        }
    }

    Err(format!("Trash entry not found for {}", note_id))
}

/// Permanently delete one trash entry (the .md, its _att folder, and
/// its meta.json). Used by the Trash panel "영구 삭제" button.
pub fn purge_one(vault_path: &Path, note_id: &str) -> Result<(), String> {
    let trash_root = vault_path.join(TRASH_DIR);
    for date_dir in fs::read_dir(&trash_root).map_err(|e| format!("read: {}", e))? {
        let date_dir = date_dir.map_err(|e| e.to_string())?;
        if !date_dir.path().is_dir() { continue; }
        for file in fs::read_dir(date_dir.path()).map_err(|e| e.to_string())? {
            let file = file.map_err(|e| e.to_string())?;
            let name = file.file_name().to_string_lossy().to_string();
            if !name.ends_with(".meta.json") { continue; }
            let bytes = match fs::read(file.path()) { Ok(b) => b, Err(_) => continue };
            let entry: TrashEntry = match serde_json::from_slice(&bytes) {
                Ok(e) => e, Err(_) => continue,
            };
            if entry.note_id != note_id { continue; }

            let trash_md = date_dir.path().join(&entry.trash_filename);
            let _ = fs::remove_file(&trash_md);
            let stem = entry.trash_filename.trim_end_matches(".md");
            let trash_att = date_dir.path().join(format!("{}_att", stem));
            if trash_att.exists() {
                let _ = fs::remove_dir_all(&trash_att);
            }
            let _ = fs::remove_file(file.path());
            log::info!("[trash] purged: {}", note_id);
            return Ok(());
        }
    }
    Err(format!("Trash entry not found for {}", note_id))
}

/// Remove every trash entry older than `RETENTION_DAYS`. Returns the
/// count of purged entries.
pub fn purge_expired(vault_path: &Path) -> Result<usize, String> {
    let trash_root = vault_path.join(TRASH_DIR);
    if !trash_root.exists() { return Ok(0); }

    let cutoff = Utc::now() - chrono::Duration::days(RETENTION_DAYS);
    let mut purged = 0;
    for date_dir in fs::read_dir(&trash_root).map_err(|e| format!("read: {}", e))? {
        let date_dir = date_dir.map_err(|e| e.to_string())?;
        if !date_dir.path().is_dir() { continue; }
        let mut to_remove: Vec<(std::path::PathBuf, String)> = Vec::new();
        for file in fs::read_dir(date_dir.path()).map_err(|e| e.to_string())? {
            let file = file.map_err(|e| e.to_string())?;
            let name = file.file_name().to_string_lossy().to_string();
            if !name.ends_with(".meta.json") { continue; }
            let bytes = match fs::read(file.path()) { Ok(b) => b, Err(_) => continue };
            let entry: TrashEntry = match serde_json::from_slice(&bytes) {
                Ok(e) => e, Err(_) => continue,
            };
            if entry.deleted_at < cutoff {
                to_remove.push((file.path(), entry.trash_filename.clone()));
            }
        }
        for (meta_path, trash_filename) in to_remove {
            let trash_md = date_dir.path().join(&trash_filename);
            let _ = fs::remove_file(&trash_md);
            let stem = trash_filename.trim_end_matches(".md");
            let trash_att = date_dir.path().join(format!("{}_att", stem));
            if trash_att.exists() {
                let _ = fs::remove_dir_all(&trash_att);
            }
            let _ = fs::remove_file(&meta_path);
            purged += 1;
        }
        // Remove empty date dirs.
        if let Ok(mut iter) = fs::read_dir(date_dir.path()) {
            if iter.next().is_none() {
                let _ = fs::remove_dir(date_dir.path());
            }
        }
    }
    if purged > 0 {
        log::info!("[trash] purged {} expired entries", purged);
    }
    Ok(purged)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_move_and_list() {
        let tmp = tempfile::tempdir().unwrap();
        let vault = tmp.path();
        let note = vault.join("Test/note.md");
        fs::create_dir_all(note.parent().unwrap()).unwrap();
        fs::write(&note, "---\nid: \"123\"\n---\ntest").unwrap();

        let entry = move_to_trash(vault, &note, "123", "Test/note.md").unwrap();
        assert_eq!(entry.note_id, "123");
        assert!(!note.exists());

        let list = list_trash(vault).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].note_id, "123");
    }

    #[test]
    fn test_restore() {
        let tmp = tempfile::tempdir().unwrap();
        let vault = tmp.path();
        let note = vault.join("Test/note.md");
        fs::create_dir_all(note.parent().unwrap()).unwrap();
        fs::write(&note, "---\nid: \"456\"\n---\ncontent").unwrap();

        move_to_trash(vault, &note, "456", "Test/note.md").unwrap();
        assert!(!note.exists());

        let restored = restore_from_trash(vault, "456").unwrap();
        assert_eq!(restored.original_path, "Test/note.md");
        assert!(note.exists());
        assert_eq!(fs::read_to_string(&note).unwrap(), "---\nid: \"456\"\n---\ncontent");
    }
}
