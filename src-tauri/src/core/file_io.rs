use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use once_cell::sync::Lazy;
use sha2::{Digest, Sha256};

/// Buffer size for streaming I/O. 256 KB balances syscall overhead
/// vs RAM headroom — large enough to amortize per-call cost, small
/// enough that even 1000 concurrent streams stay under 256 MB total.
const STREAM_BUF_SIZE: usize = 256 * 1024;

/// 2026-05-24 (HanBin) — streaming sha256 + size, constant-memory
/// regardless of file size. Replaces the `std::fs::read` + hash pattern
/// that loaded the entire file into RAM (5GB video → 5GB allocation).
///
/// Returns (sha256_hex, total_bytes). Errors on I/O failure with
/// human-readable context.
pub fn stream_sha256(path: &Path) -> Result<(String, u64), String> {
    let mut file = fs::File::open(path)
        .map_err(|e| format!("stream_sha256: open {:?}: {}", path, e))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; STREAM_BUF_SIZE];
    let mut total: u64 = 0;
    loop {
        let n = file.read(&mut buf)
            .map_err(|e| format!("stream_sha256: read {:?}: {}", path, e))?;
        if n == 0 { break; }
        hasher.update(&buf[..n]);
        total += n as u64;
    }
    Ok((format!("{:x}", hasher.finalize()), total))
}

/// 2026-05-24 (HanBin) — streaming copy WITH sha256 + size, single pass,
/// constant-memory. Writes to a temp file then atomic-renames. Used by
/// snapshot + add_attachment for large file safety.
///
/// Returns (sha256_hex_of_source, total_bytes).
pub fn stream_copy_with_sha(src: &Path, dst: &Path) -> Result<(String, u64), String> {
    if let Some(parent) = dst.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("stream_copy: mkdir {:?}: {}", parent, e))?;
        }
    }
    let tmp_name = format!(
        "{}.tmp-stream-{}-{}",
        dst.file_name().unwrap_or_default().to_string_lossy(),
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    );
    let tmp_path = dst.with_file_name(&tmp_name);

    let mut src_file = fs::File::open(src)
        .map_err(|e| format!("stream_copy: open src {:?}: {}", src, e))?;
    let mut dst_file = fs::File::create(&tmp_path)
        .map_err(|e| format!("stream_copy: create tmp {:?}: {}", tmp_path, e))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; STREAM_BUF_SIZE];
    let mut total: u64 = 0;
    loop {
        let n = src_file.read(&mut buf)
            .map_err(|e| format!("stream_copy: read {:?}: {}", src, e))?;
        if n == 0 { break; }
        hasher.update(&buf[..n]);
        dst_file.write_all(&buf[..n])
            .map_err(|e| format!("stream_copy: write tmp {:?}: {}", tmp_path, e))?;
        total += n as u64;
    }
    dst_file.sync_all()
        .map_err(|e| format!("stream_copy: sync {:?}: {}", tmp_path, e))?;
    drop(dst_file);
    drop(src_file);

    rename_with_retry(&tmp_path, dst)
        .map_err(|e| format!("stream_copy: rename {:?} → {:?}: {}", tmp_path, dst, e))?;
    Ok((format!("{:x}", hasher.finalize()), total))
}

/// 2026-05-24 (HanBin) — symlink-safe walker helper. Returns true iff
/// the path is a symlink/junction (Windows) we should NOT follow during
/// vault walks. Used by vault_repair walkers to prevent infinite loops
/// from circular symlinks (e.g. user accidentally created `vault/loop -> vault`).
///
/// Cheap (one syscall via symlink_metadata). Safe to call on every dir
/// entry. Returns false on stat failure (defensive — better to walk
/// than to silently skip unknown).
pub fn is_symlink(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false)
}

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

/// Atomic file write: write to a uniquely-named temp file, fsync, then rename.
///
/// Resilient to:
/// - Concurrent writes to the same target (unique temp names per call)
/// - Transient Windows file locks (antivirus, search indexer) via retry
/// - Interrupted operations (temp file cleaned up on final failure)
pub fn atomic_write_file(path: &Path, content: &[u8]) -> Result<(), String> {
    use std::io::Write;
    use std::time::{SystemTime, UNIX_EPOCH};

    const MAX_ATTEMPTS: u32 = 5;
    const RETRY_DELAY_MS: u64 = 50;

    // Ensure parent directory exists
    if let Some(parent) = path.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("atomic_write_file: create parent dir {:?}: {}", parent, e))?;
        }
    }

    // Unique temp name: avoids collision between concurrent calls
    let file_name = path.file_name().unwrap_or_default().to_string_lossy();
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let temp_name = format!("{}.tmp-{}-{}", file_name, std::process::id(), nanos);
    let temp_path = path.with_file_name(&temp_name);

    // Write content to temp file
    let mut file = fs::File::create(&temp_path)
        .map_err(|e| format!("atomic_write_file: create temp {:?}: {}", temp_path, e))?;
    file.write_all(content)
        .map_err(|e| format!("atomic_write_file: write temp {:?}: {}", temp_path, e))?;
    file.sync_all()
        .map_err(|e| format!("atomic_write_file: sync temp {:?}: {}", temp_path, e))?;
    drop(file);

    // Rename temp to target (with retry for Windows transient locks)
    for attempt in 1..=MAX_ATTEMPTS {
        match fs::rename(&temp_path, path) {
            Ok(_) => return Ok(()),
            Err(e) if attempt < MAX_ATTEMPTS => {
                // If temp is gone but target exists, another writer completed first
                if !temp_path.exists() && path.is_file() {
                    return Ok(());
                }
                std::thread::sleep(std::time::Duration::from_millis(RETRY_DELAY_MS));
                log::debug!(
                    "atomic_write_file: rename attempt {}/{} for {:?}: {}",
                    attempt, MAX_ATTEMPTS, path, e
                );
            }
            Err(e) => {
                // Final failure: clean up temp file
                let _ = fs::remove_file(&temp_path);
                return Err(format!(
                    "atomic_write_file: rename failed after {} attempts {:?} -> {:?}: {}",
                    MAX_ATTEMPTS, temp_path, path, e
                ));
            }
        }
    }
    unreachable!()
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

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn test_atomic_write_basic() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("test.txt");
        atomic_write_file(&path, b"hello").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"hello");
    }

    #[test]
    fn test_atomic_write_replaces_existing() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("test.txt");
        atomic_write_file(&path, b"foo").unwrap();
        atomic_write_file(&path, b"bar").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"bar");
    }

    #[test]
    fn test_atomic_write_creates_parent_dir() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("nested").join("deep").join("file.txt");
        atomic_write_file(&path, b"content").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"content");
    }

    #[test]
    fn test_atomic_write_concurrent() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("shared.txt");

        std::thread::scope(|s| {
            let handles: Vec<_> = (0..10)
                .map(|i| {
                    let p = path.clone();
                    s.spawn(move || {
                        let content = format!("thread-{}", i);
                        atomic_write_file(&p, content.as_bytes()).unwrap();
                    })
                })
                .collect();

            for h in handles {
                h.join().unwrap();
            }
        });

        // File exists and contains one of the writes (last-writer-wins)
        let content = fs::read_to_string(&path).unwrap();
        assert!(content.starts_with("thread-"));

        // No temp files left behind
        let tmp_files: Vec<_> = fs::read_dir(tmp.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| {
                e.file_name().to_string_lossy().contains(".tmp-")
            })
            .collect();
        assert!(tmp_files.is_empty(), "Temp files left behind: {:?}", tmp_files);
    }

    #[test]
    fn test_atomic_write_no_temp_left_on_success() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("clean.txt");
        atomic_write_file(&path, b"data").unwrap();

        let entries: Vec<_> = fs::read_dir(tmp.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .collect();
        // Should only have the target file, no temp files
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].file_name().to_string_lossy().as_ref(), "clean.txt");
    }
}

/// Retry fs::rename up to 5 times with 200ms delay between attempts.
/// Handles transient Windows file locks (ACCESS_DENIED=5, SHARING_VIOLATION=32, LOCK_VIOLATION=33).
pub fn rename_with_retry(from: &Path, to: &Path) -> std::io::Result<()> {
    let max_retries = 5;
    for attempt in 1..=max_retries {
        match fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(e) if attempt < max_retries => {
                let code = e.raw_os_error().unwrap_or(0);
                if code == 5 || code == 32 || code == 33 {
                    log::debug!("[rename_with_retry] Attempt {}/{} failed (os error {}), retrying in 200ms...", attempt, max_retries, code);
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
