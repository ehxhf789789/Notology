use serde::{Serialize, Deserialize};
use std::sync::{Arc, Mutex};

/// Sync connection configuration. Stored in .notology/sync-config.json.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncConfig {
    pub url: String,
    pub username: String,
    /// Encrypted or plain (for now plain — OS keychain integration later)
    pub password: String,
    pub vault_path: String,
    /// Remote base path relative to WebDAV root (e.g. "/vault")
    pub remote_base: String,
    pub enabled: bool,
}

/// Current sync status, emitted to frontend via Tauri events.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum SyncStatus {
    /// Not configured or disabled
    Disconnected,
    /// Configured but no active operation
    Idle,
    /// Currently syncing
    Syncing {
        progress: f32,
        current_file: String,
    },
    /// Network unreachable — changes queued offline
    Offline,
    /// One or more conflicts need user resolution
    Conflict {
        files: Vec<String>,
    },
    /// Unrecoverable error
    Error {
        message: String,
    },
}

/// Thread-safe sync state shared across Tauri commands.
pub struct SyncState {
    pub status: Mutex<SyncStatus>,
    pub config: Mutex<Option<SyncConfig>>,
}

impl SyncState {
    pub fn new() -> Self {
        Self {
            status: Mutex::new(SyncStatus::Disconnected),
            config: Mutex::new(None),
        }
    }

    pub fn get_status(&self) -> SyncStatus {
        self.status.lock().unwrap().clone()
    }

    pub fn set_status(&self, status: SyncStatus) {
        *self.status.lock().unwrap() = status;
    }

    pub fn get_config(&self) -> Option<SyncConfig> {
        self.config.lock().unwrap().clone()
    }

    pub fn set_config(&self, config: SyncConfig) {
        *self.config.lock().unwrap() = Some(config);
    }

    pub fn clear_config(&self) {
        *self.config.lock().unwrap() = None;
        *self.status.lock().unwrap() = SyncStatus::Disconnected;
    }
}

// ================================================================
// Persistence: .notology/sync-config.json
// ================================================================

const CONFIG_FILE: &str = "sync-config.json";

/// Load sync config from vault's .notology/ folder.
pub fn load_config(vault_path: &str) -> Result<Option<SyncConfig>, String> {
    let config_path = std::path::Path::new(vault_path)
        .join(".notology")
        .join(CONFIG_FILE);

    if !config_path.exists() {
        return Ok(None);
    }

    let content = std::fs::read_to_string(&config_path)
        .map_err(|e| format!("Failed to read sync config: {}", e))?;
    let config: SyncConfig = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse sync config: {}", e))?;

    Ok(Some(config))
}

/// Save sync config to vault's .notology/ folder.
pub fn save_config(vault_path: &str, config: &SyncConfig) -> Result<(), String> {
    let notology_dir = std::path::Path::new(vault_path).join(".notology");
    if !notology_dir.exists() {
        std::fs::create_dir_all(&notology_dir)
            .map_err(|e| format!("Failed to create .notology dir: {}", e))?;
    }

    let config_path = notology_dir.join(CONFIG_FILE);
    let content = serde_json::to_string_pretty(config)
        .map_err(|e| format!("Failed to serialize sync config: {}", e))?;

    crate::core::file_io::atomic_write_file(&config_path, content.as_bytes())?;
    Ok(())
}

/// Delete sync config from vault's .notology/ folder.
pub fn delete_config(vault_path: &str) -> Result<(), String> {
    let config_path = std::path::Path::new(vault_path)
        .join(".notology")
        .join(CONFIG_FILE);

    if config_path.exists() {
        std::fs::remove_file(&config_path)
            .map_err(|e| format!("Failed to delete sync config: {}", e))?;
    }

    Ok(())
}
