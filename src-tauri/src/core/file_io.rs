use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use once_cell::sync::Lazy;

/// Per-file mutex to prevent concurrent read-modify-write races.
pub static FILE_LOCKS: Lazy<Mutex<HashMap<String, Arc<Mutex<()>>>>> = Lazy::new(|| {
    Mutex::new(HashMap::new())
});

pub fn get_file_lock(path: &str) -> Arc<Mutex<()>> {
    let mut locks = FILE_LOCKS.lock().unwrap();
    locks.entry(path.to_string())
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone()
}

/// Atomic file write: write to a temp file in the same directory, then rename.
pub fn atomic_write_file(path: &Path, content: &[u8]) -> Result<(), String> {
    use std::io::Write;

    let file_name = path.file_name().unwrap_or_default().to_string_lossy();
    // Debug: log all .md file writes through this path
    if file_name.ends_with(".md") {
        let preview = std::str::from_utf8(&content[..std::cmp::min(50, content.len())]).unwrap_or("[binary]");
        log::info!("[atomic_write] path={:?} len={} preview={:?}", path, content.len(), preview);
    }
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

pub fn resolve_collision(target: &Path) -> PathBuf {
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

pub fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), String> {
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

/// Find the vault root by searching upward for the .notology directory.
pub fn find_vault_root(file_path: &Path) -> Option<PathBuf> {
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
pub fn backup_before_save(file_path: &Path, vault_path: &Path) -> Result<(), String> {
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

/// Retry fs::rename up to 5 times with 200ms delay between attempts.
pub fn rename_with_retry(from: &Path, to: &Path) -> std::io::Result<()> {
    let max_retries = 5;
    for attempt in 1..=max_retries {
        match fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(e) if attempt < max_retries => {
                let code = e.raw_os_error().unwrap_or(0);
                if code == 5 || code == 32 || code == 33 {
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
