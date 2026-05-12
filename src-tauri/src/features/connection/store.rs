//! WebDAV connection config store.
//! Single global file: {app_config_dir}/webdav-config.json
//! Contains NAS credentials + device info. Shared by all vaults.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use super::device::DeviceInfo;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebDavConfig {
    pub url: String,
    pub username: String,
    pub password: String,
    pub label: String,
    pub remember_password: bool,
    pub device: DeviceInfo,
    pub last_active_vault_hash: Option<String>,
}

impl Default for WebDavConfig {
    fn default() -> Self {
        Self {
            url: String::new(),
            username: String::new(),
            password: String::new(),
            label: String::new(),
            remember_password: true,
            device: super::device::collect(),
            last_active_vault_hash: None,
        }
    }
}

impl WebDavConfig {
    pub fn is_configured(&self) -> bool {
        !self.url.is_empty() && !self.username.is_empty() && !self.password.is_empty()
    }
}

pub fn config_path(app_config_dir: &Path) -> PathBuf {
    app_config_dir.join("webdav-config.json")
}

pub fn load(app_config_dir: &Path) -> Result<Option<WebDavConfig>, String> {
    let path = config_path(app_config_dir);
    if !path.exists() {
        return Ok(None);
    }
    let bytes = std::fs::read(&path).map_err(|e| format!("read webdav-config: {}", e))?;
    match serde_json::from_slice::<WebDavConfig>(&bytes) {
        Ok(config) => Ok(Some(config)),
        Err(e) => {
            // Backup corrupted file
            let backup = path.with_extension("json.corrupted");
            let _ = std::fs::rename(&path, &backup);
            log::warn!("[connection] corrupted webdav-config.json backed up: {}", e);
            Ok(None)
        }
    }
}

pub fn save(app_config_dir: &Path, config: &WebDavConfig) -> Result<(), String> {
    let path = config_path(app_config_dir);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir: {}", e))?;
    }
    let bytes = serde_json::to_vec_pretty(config).map_err(|e| format!("serialize: {}", e))?;
    std::fs::write(&path, bytes).map_err(|e| format!("write: {}", e))?;
    Ok(())
}

pub fn delete(app_config_dir: &Path) -> Result<(), String> {
    let path = config_path(app_config_dir);
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| format!("delete: {}", e))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_load_missing() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(load(tmp.path()).unwrap().is_none());
    }

    #[test]
    fn test_save_load_roundtrip() {
        let tmp = tempfile::tempdir().unwrap();
        let config = WebDavConfig {
            url: "https://nas.example.com:5006".into(),
            username: "user".into(),
            password: "pass".into(),
            label: "My NAS".into(),
            ..Default::default()
        };
        save(tmp.path(), &config).unwrap();
        let loaded = load(tmp.path()).unwrap().unwrap();
        assert_eq!(loaded.url, "https://nas.example.com:5006");
        assert_eq!(loaded.username, "user");
    }

    #[test]
    fn test_corrupted_backup() {
        let tmp = tempfile::tempdir().unwrap();
        let path = config_path(tmp.path());
        std::fs::write(&path, "not json").unwrap();
        assert!(load(tmp.path()).unwrap().is_none());
        assert!(path.with_extension("json.corrupted").exists());
    }
}
