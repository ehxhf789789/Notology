//! NAS connection history persistence.
//! Stored globally at %APPDATA%/Notology/nas-connections.json (not per-vault).

use serde::{Serialize, Deserialize};
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NasConnections {
    pub connections: Vec<NasConnection>,
    pub last_active: Option<LastActiveVault>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NasConnection {
    pub id: String,
    pub url: String,
    pub username: String,
    #[serde(default)]
    pub password: String,
    pub display_name: String,
    pub vaults: Vec<NasVaultEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NasVaultEntry {
    pub remote_path: String,
    pub local_cache_path: String,
    pub name: String,
    pub last_synced: Option<String>,
    pub auto_sync: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LastActiveVault {
    pub connection_id: String,
    pub remote_path: String,
}

impl Default for NasConnections {
    fn default() -> Self {
        Self {
            connections: Vec::new(),
            last_active: None,
        }
    }
}

/// Generate a stable connection ID from url + username.
pub fn make_connection_id(url: &str, username: &str) -> String {
    let mut hasher = DefaultHasher::new();
    format!("{}|{}", url, username).hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

/// Get the global config directory for Notology (%APPDATA%/Notology or platform equivalent).
fn global_config_dir() -> Result<PathBuf, String> {
    // Use APPDATA on Windows, ~/.config on Linux/Mac
    #[cfg(target_os = "windows")]
    {
        let appdata = std::env::var("APPDATA")
            .map_err(|_| "APPDATA not set".to_string())?;
        Ok(PathBuf::from(appdata).join("Notology"))
    }
    #[cfg(not(target_os = "windows"))]
    {
        let home = std::env::var("HOME")
            .map_err(|_| "HOME not set".to_string())?;
        Ok(PathBuf::from(home).join(".config").join("notology"))
    }
}

fn connections_path() -> Result<PathBuf, String> {
    Ok(global_config_dir()?.join("nas-connections.json"))
}

/// Get the local vault cache base directory.
pub fn local_vaults_dir() -> Result<PathBuf, String> {
    #[cfg(target_os = "windows")]
    {
        let local = std::env::var("LOCALAPPDATA")
            .map_err(|_| "LOCALAPPDATA not set".to_string())?;
        Ok(PathBuf::from(local).join("Notology").join("vaults"))
    }
    #[cfg(not(target_os = "windows"))]
    {
        let home = std::env::var("HOME")
            .map_err(|_| "HOME not set".to_string())?;
        Ok(PathBuf::from(home).join(".local").join("share").join("notology").join("vaults"))
    }
}

/// Compute local cache path for a vault.
pub fn vault_local_path(connection_id: &str, vault_name: &str) -> Result<PathBuf, String> {
    Ok(local_vaults_dir()?.join(connection_id).join(vault_name))
}

// ================================================================
// CRUD operations
// ================================================================

pub fn load_connections() -> Result<NasConnections, String> {
    let path = connections_path()?;
    if !path.exists() {
        return Ok(NasConnections::default());
    }
    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read nas-connections.json: {}", e))?;
    serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse nas-connections.json: {}", e))
}

pub fn save_connections(data: &NasConnections) -> Result<(), String> {
    let path = connections_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create config dir: {}", e))?;
    }
    let content = serde_json::to_string_pretty(data)
        .map_err(|e| format!("Failed to serialize: {}", e))?;
    crate::core::file_io::atomic_write_file(&path, content.as_bytes())
}

/// Add or update a connection. Returns the connection ID.
pub fn upsert_connection(url: &str, username: &str, password: &str, display_name: &str) -> Result<String, String> {
    let mut data = load_connections()?;
    let id = make_connection_id(url, username);

    if let Some(conn) = data.connections.iter_mut().find(|c| c.id == id) {
        conn.display_name = display_name.to_string();
        conn.password = password.to_string();
    } else {
        data.connections.push(NasConnection {
            id: id.clone(),
            url: url.to_string(),
            username: username.to_string(),
            password: password.to_string(),
            display_name: display_name.to_string(),
            vaults: Vec::new(),
        });
    }

    save_connections(&data)?;
    Ok(id)
}

/// Check if a port-changed connection exists (same host+username, different port).
/// Returns the old connection if found.
pub fn find_port_changed_connection(url: &str, username: &str) -> Result<Option<NasConnection>, String> {
    let data = load_connections()?;

    let new_host = extract_host_without_port(url);
    if new_host.is_empty() { return Ok(None); }

    let new_id = make_connection_id(url, username);

    for conn in &data.connections {
        if conn.id == new_id { continue; } // Same connection
        if conn.username != username { continue; }

        let old_host = extract_host_without_port(&conn.url);
        if old_host == new_host && !conn.vaults.is_empty() {
            return Ok(Some(conn.clone()));
        }
    }

    Ok(None)
}

/// Migrate an old connection's vaults to a new connection (port change).
/// Moves vault entries + updates local_cache_path references without re-downloading.
pub fn migrate_port_change(old_connection_id: &str, new_url: &str, new_username: &str, new_password: &str) -> Result<String, String> {
    let mut data = load_connections()?;
    let new_id = make_connection_id(new_url, new_username);

    // Find old connection and take its vaults
    let old_vaults: Vec<NasVaultEntry> = data.connections.iter()
        .find(|c| c.id == old_connection_id)
        .map(|c| c.vaults.clone())
        .unwrap_or_default();

    if old_vaults.is_empty() {
        return Err("Old connection has no vaults to migrate".to_string());
    }

    // Migrate local_cache_path: rename old connection dir to new
    let old_dir = local_vaults_dir()?.join(old_connection_id);
    let new_dir = local_vaults_dir()?.join(&new_id);

    if old_dir.exists() && !new_dir.exists() {
        std::fs::rename(&old_dir, &new_dir)
            .map_err(|e| format!("Failed to rename vault cache dir: {}", e))?;
    }

    // Update vault entries with new paths
    let migrated_vaults: Vec<NasVaultEntry> = old_vaults.into_iter().map(|mut v| {
        let new_path = vault_local_path(&new_id, &v.name)
            .unwrap_or_else(|_| std::path::PathBuf::from(&v.local_cache_path));
        v.local_cache_path = new_path.to_string_lossy().to_string();
        v
    }).collect();

    // Remove old connection
    data.connections.retain(|c| c.id != old_connection_id);

    // Create/update new connection with migrated vaults
    if let Some(conn) = data.connections.iter_mut().find(|c| c.id == new_id) {
        conn.vaults = migrated_vaults;
        conn.password = new_password.to_string();
    } else {
        data.connections.push(NasConnection {
            id: new_id.clone(),
            url: new_url.to_string(),
            username: new_username.to_string(),
            password: new_password.to_string(),
            display_name: new_url.to_string(),
            vaults: migrated_vaults,
        });
    }

    // Update last_active
    if let Some(ref mut la) = data.last_active {
        if la.connection_id == old_connection_id {
            la.connection_id = new_id.clone();
        }
    }

    save_connections(&data)?;
    Ok(new_id)
}

/// Extract hostname without port from a URL.
fn extract_host_without_port(url: &str) -> String {
    if let Ok(parsed) = url::Url::parse(url) {
        format!("{}://{}", parsed.scheme(), parsed.host_str().unwrap_or(""))
    } else {
        String::new()
    }
}

/// Add a vault to a connection.
pub fn add_vault_to_connection(
    connection_id: &str,
    remote_path: &str,
    vault_name: &str,
) -> Result<String, String> {
    let mut data = load_connections()?;
    let conn = data.connections.iter_mut()
        .find(|c| c.id == connection_id)
        .ok_or_else(|| format!("Connection {} not found", connection_id))?;

    // Check if already registered
    if conn.vaults.iter().any(|v| v.remote_path == remote_path) {
        // Update name if different
        if let Some(v) = conn.vaults.iter_mut().find(|v| v.remote_path == remote_path) {
            v.name = vault_name.to_string();
        }
        let local = vault_local_path(connection_id, vault_name)?;
        save_connections(&data)?;
        return Ok(local.to_string_lossy().to_string());
    }

    let local = vault_local_path(connection_id, vault_name)?;

    conn.vaults.push(NasVaultEntry {
        remote_path: remote_path.to_string(),
        local_cache_path: local.to_string_lossy().to_string(),
        name: vault_name.to_string(),
        last_synced: None,
        auto_sync: true,
    });

    // Set as last active
    data.last_active = Some(LastActiveVault {
        connection_id: connection_id.to_string(),
        remote_path: remote_path.to_string(),
    });

    save_connections(&data)?;
    Ok(local.to_string_lossy().to_string())
}

/// Remove a vault from a connection.
pub fn remove_vault_from_connection(connection_id: &str, remote_path: &str) -> Result<(), String> {
    let mut data = load_connections()?;
    if let Some(conn) = data.connections.iter_mut().find(|c| c.id == connection_id) {
        conn.vaults.retain(|v| v.remote_path != remote_path);
    }
    // Clear last_active if it was this vault
    if let Some(ref la) = data.last_active {
        if la.connection_id == connection_id && la.remote_path == remote_path {
            data.last_active = None;
        }
    }
    save_connections(&data)
}

/// Remove an entire connection.
pub fn remove_connection(connection_id: &str) -> Result<(), String> {
    let mut data = load_connections()?;
    data.connections.retain(|c| c.id != connection_id);
    if let Some(ref la) = data.last_active {
        if la.connection_id == connection_id {
            data.last_active = None;
        }
    }
    save_connections(&data)
}

/// Set last active vault.
pub fn set_last_active(connection_id: &str, remote_path: &str) -> Result<(), String> {
    let mut data = load_connections()?;
    data.last_active = Some(LastActiveVault {
        connection_id: connection_id.to_string(),
        remote_path: remote_path.to_string(),
    });
    save_connections(&data)
}

/// Update last_synced for a vault.
pub fn update_vault_sync_time(connection_id: &str, remote_path: &str) -> Result<(), String> {
    let mut data = load_connections()?;
    if let Some(conn) = data.connections.iter_mut().find(|c| c.id == connection_id) {
        if let Some(vault) = conn.vaults.iter_mut().find(|v| v.remote_path == remote_path) {
            vault.last_synced = Some(chrono::Utc::now().to_rfc3339());
        }
    }
    save_connections(&data)
}
