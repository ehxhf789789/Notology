use chrono::{DateTime, Utc};
use rusqlite::{Connection, params};
use serde::{Serialize, Deserialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use super::webdav::WebDavClient;
use super::state::{SyncState, SyncConfig, SyncStatus};
use super::conflict::{ConflictResolver, MergeResult};

// ================================================================
// Constants
// ================================================================

const MAX_RETRY: u32 = 3;
const RETRY_DELAYS_MS: [u64; 3] = [1000, 5000, 15000];
const UPLOAD_TIMEOUT_SECS: u64 = 60;

// ================================================================
// Base snapshot manifest
// ================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BaseEntry {
    pub path: String,
    pub synced_at: DateTime<Utc>,
    pub etag: Option<String>,
    pub is_binary: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SyncManifest {
    pub entries: std::collections::HashMap<String, BaseEntry>,
}

impl SyncManifest {
    fn manifest_path(vault_path: &str) -> PathBuf {
        Path::new(vault_path).join(".notology").join("sync").join("manifest.json")
    }

    fn base_dir(vault_path: &str) -> PathBuf {
        Path::new(vault_path).join(".notology").join("sync").join("base")
    }

    pub fn load(vault_path: &str) -> Self {
        let path = Self::manifest_path(vault_path);
        if let Ok(content) = std::fs::read_to_string(&path) {
            serde_json::from_str(&content).unwrap_or_default()
        } else {
            Self::default()
        }
    }

    pub fn save(&self, vault_path: &str) -> Result<(), String> {
        let path = Self::manifest_path(vault_path);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create sync dir: {}", e))?;
        }
        let content = serde_json::to_string_pretty(self)
            .map_err(|e| format!("Failed to serialize manifest: {}", e))?;
        crate::core::file_io::atomic_write_file(&path, content.as_bytes())
    }

    pub fn save_base(&mut self, vault_path: &str, relative_path: &str, content: &[u8], etag: Option<String>, is_binary: bool) -> Result<(), String> {
        let base_file = Self::base_dir(vault_path).join(relative_path);
        if let Some(parent) = base_file.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create base dir: {}", e))?;
        }
        crate::core::file_io::atomic_write_file(&base_file, content)?;

        self.entries.insert(relative_path.to_string(), BaseEntry {
            path: relative_path.to_string(),
            synced_at: Utc::now(),
            etag,
            is_binary,
        });
        self.save(vault_path)
    }

    pub fn read_base(vault_path: &str, relative_path: &str) -> Option<Vec<u8>> {
        std::fs::read(Self::base_dir(vault_path).join(relative_path)).ok()
    }

    pub fn get_entry(&self, relative_path: &str) -> Option<&BaseEntry> {
        self.entries.get(relative_path)
    }

    pub fn remove_entry(&mut self, vault_path: &str, relative_path: &str) -> Result<(), String> {
        self.entries.remove(relative_path);
        let base_file = Self::base_dir(vault_path).join(relative_path);
        let _ = std::fs::remove_file(&base_file);
        self.save(vault_path)
    }
}

// ================================================================
// Download manifest (checkpoint for initial download)
// ================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DownloadManifest {
    pub status: String, // "in_progress" | "completed"
    pub total: usize,
    pub completed: usize,
    pub completed_files: Vec<String>,
    pub remote_path: String,
    pub local_path: String,
}

impl DownloadManifest {
    fn path(vault_path: &str) -> PathBuf {
        Path::new(vault_path).join(".notology").join("sync").join("download-manifest.json")
    }

    pub fn load(local_path: &str) -> Option<Self> {
        let path = Self::path(local_path);
        let content = std::fs::read_to_string(&path).ok()?;
        serde_json::from_str(&content).ok()
    }

    pub fn save(&self, local_path: &str) -> Result<(), String> {
        let path = Self::path(local_path);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("create dir: {}", e))?;
        }
        let content = serde_json::to_string_pretty(self)
            .map_err(|e| format!("serialize: {}", e))?;
        crate::core::file_io::atomic_write_file(&path, content.as_bytes())
    }

    pub fn delete(local_path: &str) {
        let _ = std::fs::remove_file(Self::path(local_path));
    }

    pub fn cleanup_tmp_files(local_path: &str) {
        if let Ok(entries) = glob_tmp_files(Path::new(local_path)) {
            for path in entries {
                let _ = std::fs::remove_file(path);
            }
        }
    }
}

fn glob_tmp_files(dir: &Path) -> Result<Vec<PathBuf>, String> {
    let mut results = Vec::new();
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                results.extend(glob_tmp_files(&path)?);
            } else if path.file_name().map(|n| n.to_string_lossy().ends_with(".notology-tmp")).unwrap_or(false) {
                results.push(path);
            }
        }
    }
    Ok(results)
}

// ================================================================
// Pending change types (offline queue)
// ================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum PendingChange {
    Upload {
        local_path: String,
        remote_path: String,
        relative_path: String,
        timestamp: DateTime<Utc>,
        base_etag: Option<String>,
    },
    Delete {
        remote_path: String,
        relative_path: String,
        timestamp: DateTime<Utc>,
        base_etag: Option<String>,
    },
    Mkdir {
        remote_path: String,
        timestamp: DateTime<Utc>,
    },
}

// ================================================================
// Sync queue (SQLite WAL, transactional)
// ================================================================

pub struct SyncQueue {
    db: Mutex<Connection>,
}

impl SyncQueue {
    pub fn open(vault_path: &str) -> Result<Self, String> {
        let db_path = Path::new(vault_path).join(".notology").join("sync_queue.db");
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("create dir: {}", e))?;
        }

        let conn = Connection::open(&db_path).map_err(|e| format!("open db: {}", e))?;
        conn.execute_batch("PRAGMA journal_mode=WAL;").map_err(|e| format!("WAL: {}", e))?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS pending_changes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                change_type TEXT NOT NULL,
                local_path TEXT,
                remote_path TEXT NOT NULL,
                relative_path TEXT NOT NULL DEFAULT '',
                base_etag TEXT,
                timestamp TEXT NOT NULL,
                retry_count INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE TABLE IF NOT EXISTS sync_state (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );"
        ).map_err(|e| format!("init schema: {}", e))?;

        Ok(Self { db: Mutex::new(conn) })
    }

    pub fn enqueue(&self, change: &PendingChange) -> Result<(), String> {
        let db = self.db.lock().map_err(|e| format!("lock: {}", e))?;
        db.execute_batch("BEGIN IMMEDIATE").map_err(|e| format!("begin: {}", e))?;

        let result = (|| -> Result<(), String> {
            match change {
                PendingChange::Upload { local_path, remote_path, relative_path, timestamp, base_etag } => {
                    db.execute("DELETE FROM pending_changes WHERE remote_path = ?1 AND change_type IN ('upload','delete')", params![remote_path])
                        .map_err(|e| format!("db: {}", e))?;
                    db.execute(
                        "INSERT INTO pending_changes (change_type, local_path, remote_path, relative_path, base_etag, timestamp) VALUES ('upload', ?1, ?2, ?3, ?4, ?5)",
                        params![local_path, remote_path, relative_path, base_etag, timestamp.to_rfc3339()],
                    ).map_err(|e| format!("db: {}", e))?;
                }
                PendingChange::Delete { remote_path, relative_path, timestamp, base_etag } => {
                    db.execute("DELETE FROM pending_changes WHERE remote_path = ?1", params![remote_path])
                        .map_err(|e| format!("db: {}", e))?;
                    db.execute(
                        "INSERT INTO pending_changes (change_type, remote_path, relative_path, base_etag, timestamp) VALUES ('delete', ?1, ?2, ?3, ?4)",
                        params![remote_path, relative_path, base_etag, timestamp.to_rfc3339()],
                    ).map_err(|e| format!("db: {}", e))?;
                }
                PendingChange::Mkdir { remote_path, timestamp } => {
                    db.execute(
                        "INSERT OR IGNORE INTO pending_changes (change_type, remote_path, timestamp) VALUES ('mkdir', ?1, ?2)",
                        params![remote_path, timestamp.to_rfc3339()],
                    ).map_err(|e| format!("db: {}", e))?;
                }
            }
            Ok(())
        })();

        match result {
            Ok(()) => { db.execute_batch("COMMIT").map_err(|e| format!("commit: {}", e))?; Ok(()) }
            Err(e) => { let _ = db.execute_batch("ROLLBACK"); Err(e) }
        }
    }

    pub fn get_pending(&self) -> Result<Vec<(i64, PendingChange)>, String> {
        let db = self.db.lock().map_err(|e| format!("lock: {}", e))?;
        let mut stmt = db.prepare(
            "SELECT id, change_type, local_path, remote_path, relative_path, base_etag, timestamp FROM pending_changes ORDER BY id"
        ).map_err(|e| format!("db: {}", e))?;

        let rows = stmt.query_map([], |row| {
            let id: i64 = row.get(0)?;
            let change_type: String = row.get(1)?;
            let local_path: Option<String> = row.get(2)?;
            let remote_path: String = row.get(3)?;
            let relative_path: String = row.get::<_, Option<String>>(4)?.unwrap_or_default();
            let base_etag: Option<String> = row.get(5)?;
            let ts: String = row.get(6)?;
            let timestamp = DateTime::parse_from_rfc3339(&ts)
                .map(|dt| dt.with_timezone(&Utc)).unwrap_or_else(|_| Utc::now());

            let change = match change_type.as_str() {
                "upload" => PendingChange::Upload { local_path: local_path.unwrap_or_default(), remote_path, relative_path, timestamp, base_etag },
                "delete" => PendingChange::Delete { remote_path, relative_path, timestamp, base_etag },
                "mkdir" => PendingChange::Mkdir { remote_path, timestamp },
                _ => PendingChange::Upload { local_path: local_path.unwrap_or_default(), remote_path, relative_path, timestamp, base_etag },
            };
            Ok((id, change))
        }).map_err(|e| format!("db: {}", e))?;

        rows.collect::<Result<Vec<_>, _>>().map_err(|e| format!("row: {}", e))
    }

    pub fn dequeue(&self, id: i64) -> Result<(), String> {
        let db = self.db.lock().map_err(|e| format!("lock: {}", e))?;
        db.execute("DELETE FROM pending_changes WHERE id = ?1", params![id]).map_err(|e| format!("db: {}", e))?;
        Ok(())
    }

    pub fn increment_retry(&self, id: i64) -> Result<u32, String> {
        let db = self.db.lock().map_err(|e| format!("lock: {}", e))?;
        db.execute("UPDATE pending_changes SET retry_count = retry_count + 1 WHERE id = ?1", params![id])
            .map_err(|e| format!("db: {}", e))?;
        let count: u32 = db.query_row("SELECT retry_count FROM pending_changes WHERE id = ?1", params![id], |r| r.get(0))
            .map_err(|e| format!("db: {}", e))?;
        Ok(count)
    }

    pub fn count(&self) -> Result<usize, String> {
        let db = self.db.lock().map_err(|e| format!("lock: {}", e))?;
        let c: i64 = db.query_row("SELECT COUNT(*) FROM pending_changes", [], |r| r.get(0))
            .map_err(|e| format!("db: {}", e))?;
        Ok(c as usize)
    }

    pub fn set_state(&self, key: &str, value: &str) -> Result<(), String> {
        let db = self.db.lock().map_err(|e| format!("lock: {}", e))?;
        db.execute("INSERT OR REPLACE INTO sync_state (key, value) VALUES (?1, ?2)", params![key, value])
            .map_err(|e| format!("db: {}", e))?;
        Ok(())
    }

    pub fn get_state(&self, key: &str) -> Result<Option<String>, String> {
        let db = self.db.lock().map_err(|e| format!("lock: {}", e))?;
        match db.query_row("SELECT value FROM sync_state WHERE key = ?1", params![key], |r| r.get(0)) {
            Ok(v) => Ok(Some(v)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(format!("db: {}", e)),
        }
    }
}

// ================================================================
// Sync Engine
// ================================================================

pub struct SyncEngine {
    pub queue: SyncQueue,
    pub state: std::sync::Arc<SyncState>,
    vault_path: String,
}

impl SyncEngine {
    pub fn new(vault_path: &str, state: std::sync::Arc<SyncState>) -> Result<Self, String> {
        let queue = SyncQueue::open(vault_path)?;
        Ok(Self { queue, state, vault_path: vault_path.to_string() })
    }

    fn client(&self) -> Result<WebDavClient, String> {
        let config = self.state.get_config().ok_or("Sync not configured")?;
        WebDavClient::new(&config.url, &config.username, &config.password)
    }

    fn config(&self) -> Result<SyncConfig, String> {
        self.state.get_config().ok_or("Sync not configured".to_string())
    }

    pub fn to_remote_path(&self, local_path: &str) -> Result<String, String> {
        let config = self.config()?;
        let rel = self.to_relative_path(local_path)?;
        Ok(format!("{}/{}", config.remote_base.trim_end_matches('/'), rel))
    }

    fn to_relative_path(&self, local_path: &str) -> Result<String, String> {
        let vault = Path::new(&self.vault_path);
        let local = Path::new(local_path);
        let rel = local.strip_prefix(vault)
            .map_err(|_| format!("{} not inside vault {}", local_path, self.vault_path))?;
        Ok(rel.to_string_lossy().replace('\\', "/"))
    }

    fn is_binary(path: &str) -> bool {
        let ext = Path::new(path).extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        !matches!(ext.as_str(), "md" | "txt" | "json" | "yaml" | "yml" | "css" | "js" | "ts" | "html" | "xml" | "csv" | "toml")
    }

    // ================================================================
    // File events → queue
    // ================================================================

    pub async fn on_file_saved(&self, local_path: &str) -> Result<(), String> {
        let remote_path = self.to_remote_path(local_path)?;
        let relative_path = self.to_relative_path(local_path)?;
        let manifest = SyncManifest::load(&self.vault_path);
        let base_etag = manifest.get_entry(&relative_path).and_then(|e| e.etag.clone());

        self.queue.enqueue(&PendingChange::Upload {
            local_path: local_path.to_string(), remote_path, relative_path,
            timestamp: Utc::now(), base_etag,
        })?;

        // Try immediate flush
        if let Ok(client) = self.client() {
            if client.test_connection().await.unwrap_or(false) {
                let _ = self.flush_queue().await;
                return Ok(());
            }
        }
        self.state.set_status(SyncStatus::Offline);
        Ok(())
    }

    pub async fn on_file_deleted(&self, local_path: &str) -> Result<(), String> {
        let remote_path = self.to_remote_path(local_path)?;
        let relative_path = self.to_relative_path(local_path)?;
        let manifest = SyncManifest::load(&self.vault_path);
        let base_etag = manifest.get_entry(&relative_path).and_then(|e| e.etag.clone());

        self.queue.enqueue(&PendingChange::Delete {
            remote_path, relative_path, timestamp: Utc::now(), base_etag,
        })?;
        Ok(())
    }

    // ================================================================
    // flush_queue — core sync logic with retry + conflict handling
    // ================================================================

    pub async fn flush_queue(&self) -> Result<(), String> {
        let client = self.client()?;
        let pending = self.queue.get_pending()?;
        let total = pending.len();

        if total == 0 {
            self.state.set_status(SyncStatus::Idle);
            return Ok(());
        }

        let mut manifest = SyncManifest::load(&self.vault_path);
        let mut conflict_files: Vec<String> = Vec::new();

        for (i, (id, change)) in pending.iter().enumerate() {
            let progress = (i as f32) / (total as f32);

            match change {
                PendingChange::Upload { local_path, remote_path, relative_path, base_etag, .. } => {
                    self.state.set_status(SyncStatus::Syncing { progress, current_file: relative_path.clone() });

                    // Retry logic
                    let result = self.try_upload_with_retry(
                        &client, local_path, remote_path, relative_path, base_etag.as_deref(), &mut manifest,
                    ).await;

                    match result {
                        UploadResult::Success => { self.queue.dequeue(*id)?; }
                        UploadResult::Conflict => {
                            conflict_files.push(relative_path.clone());
                            // Don't dequeue — user must resolve
                        }
                        UploadResult::NetworkError => {
                            let retry = self.queue.increment_retry(*id)?;
                            if retry >= MAX_RETRY {
                                self.state.set_status(SyncStatus::Offline);
                                return Ok(());
                            }
                            // Will retry next flush
                        }
                    }
                }
                PendingChange::Delete { remote_path, relative_path, base_etag, .. } => {
                    self.state.set_status(SyncStatus::Syncing { progress, current_file: relative_path.clone() });

                    // Delete conflict protection: check if NAS version was modified since our base
                    let remote_meta = client.get_metadata(remote_path).await.ok();
                    let remote_etag = remote_meta.as_ref().and_then(|m| m.etag.clone());

                    let remote_changed = match (&remote_etag, base_etag) {
                        (Some(current), Some(base)) => current != base,
                        (Some(_), None) => true,
                        (None, _) => false,
                    };

                    if remote_changed {
                        // Someone modified this file on NAS after we deleted locally
                        // Rule: "수정본 우선 보존" — preserve the modified version
                        log::info!("[sync] Delete conflict: {} was modified on NAS, preserving remote version", relative_path);
                        // Download remote version to local (undelete)
                        let local_file = Path::new(&self.vault_path).join(relative_path);
                        if let Ok(content) = client.get_file(remote_path).await {
                            if let Some(parent) = local_file.parent() { let _ = std::fs::create_dir_all(parent); }
                            let _ = crate::core::file_io::atomic_write_file(&local_file, &content);
                            manifest.save_base(&self.vault_path, relative_path, &content, remote_etag, Self::is_binary(relative_path))?;
                        }
                    } else {
                        client.delete_file(remote_path).await?;
                        manifest.remove_entry(&self.vault_path, relative_path)?;
                    }
                    self.queue.dequeue(*id)?;
                }
                PendingChange::Mkdir { remote_path, .. } => {
                    let _ = client.mkdir(remote_path).await;
                    self.queue.dequeue(*id)?;
                }
            }
        }

        manifest.save(&self.vault_path)?;

        if !conflict_files.is_empty() {
            self.state.set_status(SyncStatus::Conflict { files: conflict_files });
        } else {
            self.queue.set_state("last_sync", &Utc::now().to_rfc3339())?;
            self.state.set_status(SyncStatus::Idle);
        }

        Ok(())
    }

    /// Upload with etag check + 3-way merge + retry
    async fn try_upload_with_retry(
        &self,
        client: &WebDavClient,
        local_path: &str,
        remote_path: &str,
        relative_path: &str,
        base_etag: Option<&str>,
        manifest: &mut SyncManifest,
    ) -> UploadResult {
        // Check NAS etag
        let remote_meta = match client.get_metadata(remote_path).await {
            Ok(m) => Some(m),
            Err(_) => None, // File doesn't exist on NAS → new file
        };
        let remote_etag = remote_meta.as_ref().and_then(|m| m.etag.clone());

        let remote_changed = match (&remote_etag, base_etag) {
            (Some(current), Some(base)) => current.as_str() != base,
            (Some(_), None) => true,
            (None, _) => false,
        };

        // Read local file
        let local_content = match std::fs::read(local_path) {
            Ok(c) => c,
            Err(e) => {
                log::warn!("[sync] Failed to read {}: {}", local_path, e);
                return UploadResult::NetworkError;
            }
        };

        if !remote_changed {
            // Fast-forward: NAS unchanged → just upload
            for attempt in 0..MAX_RETRY {
                match client.put_file(remote_path, &local_content).await {
                    Ok(()) => {
                        let new_etag = client.get_metadata(remote_path).await.ok().and_then(|m| m.etag);
                        let _ = manifest.save_base(&self.vault_path, relative_path, &local_content, new_etag, Self::is_binary(relative_path));
                        return UploadResult::Success;
                    }
                    Err(e) => {
                        log::warn!("[sync] Upload attempt {}/{} failed: {}", attempt + 1, MAX_RETRY, e);
                        if attempt + 1 < MAX_RETRY {
                            tokio::time::sleep(std::time::Duration::from_millis(RETRY_DELAYS_MS[attempt as usize])).await;
                        }
                    }
                }
            }
            return UploadResult::NetworkError;
        }

        // NAS changed → need merge
        if Self::is_binary(relative_path) {
            // Binary: can't 3-way merge → keep both, backup old
            log::info!("[sync] Binary conflict: {}, keeping local + backup remote", relative_path);
            // Download remote as .conflict backup
            if let Ok(remote_content) = client.get_file(remote_path).await {
                let backup_path = format!("{}.conflict", local_path);
                let _ = std::fs::write(&backup_path, &remote_content);
            }
            // Upload local version
            match client.put_file(remote_path, &local_content).await {
                Ok(()) => {
                    let new_etag = client.get_metadata(remote_path).await.ok().and_then(|m| m.etag);
                    let _ = manifest.save_base(&self.vault_path, relative_path, &local_content, new_etag, true);
                    return UploadResult::Success;
                }
                Err(_) => return UploadResult::NetworkError,
            }
        }

        // Text file: 3-way merge
        let base_content = SyncManifest::read_base(&self.vault_path, relative_path);
        let remote_bytes = match client.get_file(remote_path).await {
            Ok(b) => b,
            Err(_) => return UploadResult::NetworkError,
        };

        let base_str = base_content.as_ref().and_then(|b| std::str::from_utf8(b).ok()).unwrap_or("");
        let local_str = std::str::from_utf8(&local_content).unwrap_or("");
        let remote_str = std::str::from_utf8(&remote_bytes).unwrap_or("");

        match ConflictResolver::resolve(base_str, local_str, remote_str) {
            MergeResult::Merged { content } => {
                match client.put_file(remote_path, content.as_bytes()).await {
                    Ok(()) => {
                        crate::core::file_io::atomic_write_file(Path::new(local_path), content.as_bytes())
                            .unwrap_or_else(|e| log::warn!("[sync] Failed to write merged local: {}", e));
                        let new_etag = client.get_metadata(remote_path).await.ok().and_then(|m| m.etag);
                        let _ = manifest.save_base(&self.vault_path, relative_path, content.as_bytes(), new_etag, false);
                        UploadResult::Success
                    }
                    Err(_) => UploadResult::NetworkError,
                }
            }
            MergeResult::Conflict { .. } => UploadResult::Conflict,
        }
    }

    // ================================================================
    // pull_changes — NAS → local
    // ================================================================

    pub async fn pull_changes(&self) -> Result<Vec<String>, String> {
        let client = self.client()?;
        let config = self.config()?;
        let remote_files = client.list_files(&config.remote_base).await?;
        let mut manifest = SyncManifest::load(&self.vault_path);
        let mut updated = Vec::new();

        for remote in &remote_files {
            if remote.is_collection { continue; }

            let relative = remote.path
                .strip_prefix(&config.remote_base).unwrap_or(&remote.path)
                .trim_start_matches('/');
            let local_path = Path::new(&self.vault_path).join(relative);

            let needs_download = match manifest.get_entry(relative) {
                Some(entry) => match (&remote.etag, &entry.etag) {
                    (Some(r), Some(b)) => r != b,
                    _ => remote.modified_at > entry.synced_at,
                },
                None => true,
            };

            if needs_download {
                self.state.set_status(SyncStatus::Syncing { progress: 0.5, current_file: relative.to_string() });

                if let Some(parent) = local_path.parent() { let _ = std::fs::create_dir_all(parent); }

                // Check for local modifications that aren't synced yet
                let has_pending_upload = self.queue.get_pending()?.iter()
                    .any(|(_, c)| matches!(c, PendingChange::Upload { relative_path: rp, .. } if rp == relative));

                if has_pending_upload {
                    // Don't overwrite local changes — will be handled by flush_queue merge
                    continue;
                }

                match client.get_file(&remote.path).await {
                    Ok(content) => {
                        crate::core::file_io::atomic_write_file(&local_path, &content)?;
                        manifest.save_base(&self.vault_path, relative, &content, remote.etag.clone(), Self::is_binary(relative))?;
                        updated.push(relative.to_string());
                    }
                    Err(e) => log::warn!("[sync] Failed to download {}: {}", remote.path, e),
                }
            }
        }

        self.state.set_status(SyncStatus::Idle);
        Ok(updated)
    }

    /// Full sync: push + pull.
    pub async fn full_sync(&self) -> Result<(), String> {
        self.flush_queue().await?;
        let _updated = self.pull_changes().await?;
        self.push_missing().await?;
        self.queue.set_state("last_full_sync", &Utc::now().to_rfc3339())?;
        self.state.set_status(SyncStatus::Idle);
        Ok(())
    }

    async fn push_missing(&self) -> Result<(), String> {
        let client = self.client()?;
        let config = self.config()?;
        let remote_files = client.list_files(&config.remote_base).await?;
        let remote_paths: std::collections::HashSet<String> = remote_files.iter()
            .map(|f| f.path.strip_prefix(&config.remote_base).unwrap_or(&f.path).trim_start_matches('/').to_string())
            .collect();

        let vault = Path::new(&self.vault_path);
        let local_files = collect_vault_files(vault)?;
        let mut manifest = SyncManifest::load(&self.vault_path);

        for local_path in local_files {
            let relative = local_path.strip_prefix(vault)
                .map_err(|_| "path error".to_string())?
                .to_string_lossy().replace('\\', "/");
            if !remote_paths.contains(&relative) {
                let remote_path = format!("{}/{}", config.remote_base.trim_end_matches('/'), relative);
                Self::ensure_remote_dirs(&client, &remote_path).await?;
                let content = std::fs::read(&local_path).map_err(|e| format!("read: {}", e))?;
                client.put_file(&remote_path, &content).await?;
                let new_etag = client.get_metadata(&remote_path).await.ok().and_then(|m| m.etag);
                manifest.save_base(&self.vault_path, &relative, &content, new_etag, Self::is_binary(&relative))?;
            }
        }
        Ok(())
    }

    async fn ensure_remote_dirs(client: &WebDavClient, remote_path: &str) -> Result<(), String> {
        if let Some(parent) = Path::new(remote_path).parent() {
            let p = parent.to_string_lossy().replace('\\', "/");
            if !p.is_empty() && p != "/" { let _ = client.mkdir(&p).await; }
        }
        Ok(())
    }

    pub async fn check_connectivity(&self) -> bool {
        if let Ok(client) = self.client() {
            client.test_connection().await.unwrap_or(false)
        } else { false }
    }
}

enum UploadResult {
    Success,
    Conflict,
    NetworkError,
}

fn collect_vault_files(dir: &Path) -> Result<Vec<PathBuf>, String> {
    let mut files = Vec::new();
    collect_vault_files_recursive(dir, &mut files)?;
    Ok(files)
}

fn collect_vault_files_recursive(dir: &Path, files: &mut Vec<PathBuf>) -> Result<(), String> {
    let entries = std::fs::read_dir(dir).map_err(|e| format!("read dir: {}", e))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("entry: {}", e))?;
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') { continue; }
        if path.is_dir() { collect_vault_files_recursive(&path, files)?; }
        else { files.push(path); }
    }
    Ok(())
}
