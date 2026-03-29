use std::fs;
use std::path::Path;

use crate::core::file_io::atomic_write_file;
use crate::core::types::NoteLockInfo;

fn note_lock_hash(input: &str) -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut hasher = DefaultHasher::new();
    input.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

#[tauri::command]
pub fn acquire_note_lock(vault_path: String, note_path: String) -> Result<(), String> {
    let locks_dir = Path::new(&vault_path).join(".notology").join("locks");
    fs::create_dir_all(&locks_dir).map_err(|e| e.to_string())?;

    let hash = note_lock_hash(&note_path);
    let lock_path = locks_dir.join(format!("{}.lock", hash));

    let info = NoteLockInfo {
        machine_id: crate::vault_lock::get_machine_id(),
        hostname: crate::vault_lock::get_hostname(),
        file_path: note_path,
        locked_at: chrono::Utc::now().to_rfc3339(),
        heartbeat: chrono::Utc::now().to_rfc3339(),
    };

    let content = serde_json::to_string_pretty(&info).map_err(|e| e.to_string())?;
    atomic_write_file(&lock_path, content.as_bytes())?;
    Ok(())
}

#[tauri::command]
pub fn release_note_lock(vault_path: String, note_path: String) -> Result<(), String> {
    let locks_dir = Path::new(&vault_path).join(".notology").join("locks");
    let hash = note_lock_hash(&note_path);
    let lock_path = locks_dir.join(format!("{}.lock", hash));

    if lock_path.exists() {
        if let Ok(content) = fs::read_to_string(&lock_path) {
            if let Ok(info) = serde_json::from_str::<NoteLockInfo>(&content) {
                if info.machine_id == crate::vault_lock::get_machine_id() {
                    let _ = fs::remove_file(&lock_path);
                }
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub fn update_note_lock_heartbeat(vault_path: String, note_path: String) -> Result<(), String> {
    let locks_dir = Path::new(&vault_path).join(".notology").join("locks");
    let hash = note_lock_hash(&note_path);
    let lock_path = locks_dir.join(format!("{}.lock", hash));

    if lock_path.exists() {
        if let Ok(content) = fs::read_to_string(&lock_path) {
            if let Ok(mut info) = serde_json::from_str::<NoteLockInfo>(&content) {
                if info.machine_id == crate::vault_lock::get_machine_id() {
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
pub fn check_note_lock(vault_path: String, note_path: String) -> Result<Option<NoteLockInfo>, String> {
    let locks_dir = Path::new(&vault_path).join(".notology").join("locks");
    let hash = note_lock_hash(&note_path);
    let lock_path = locks_dir.join(format!("{}.lock", hash));

    if !lock_path.exists() {
        return Ok(None);
    }

    let content = fs::read_to_string(&lock_path).map_err(|e| e.to_string())?;
    let info: NoteLockInfo = serde_json::from_str(&content).map_err(|e| e.to_string())?;

    if let Ok(heartbeat) = chrono::DateTime::parse_from_rfc3339(&info.heartbeat) {
        let age = chrono::Utc::now().signed_duration_since(heartbeat);
        if age.num_seconds() > 120 {
            let _ = fs::remove_file(&lock_path);
            return Ok(None);
        }
    }

    if info.machine_id == crate::vault_lock::get_machine_id() {
        return Ok(None);
    }

    Ok(Some(info))
}
