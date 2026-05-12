//! Sync V2 configuration: per-vault settings for NAS sync.
//!
//! Stored at `{app_config_dir}/sync_v2/{vault_hash}.json`.
//! vault_hash = SHA256(vault_path) first 16 hex chars.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncV2Config {
    pub enabled: bool,
    pub remote_base: String,
    // Legacy fields: kept for deserialization of old configs, skipped on new saves
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
}

impl Default for SyncV2Config {
    fn default() -> Self {
        Self {
            enabled: false,
            remote_base: String::new(),
            url: None,
            username: None,
            password: None,
        }
    }
}

impl SyncV2Config {
    /// Check if this vault config has enough info for sync.
    /// Credentials come from global WebDavConfig, so only remote_base needed here.
    pub fn is_complete(&self) -> bool {
        !self.remote_base.is_empty()
    }

    /// Check if legacy credentials are present (pre-migration config).
    pub fn has_legacy_credentials(&self) -> bool {
        self.url.as_ref().map(|s| !s.is_empty()).unwrap_or(false)
    }
}

/// vault_path → SHA256 hex (first 16 chars) for filename safety.
pub fn vault_hash(vault_path: &Path) -> String {
    let canonical = vault_path.to_string_lossy();
    let mut hasher = Sha256::new();
    hasher.update(canonical.as_bytes());
    let hex = format!("{:x}", hasher.finalize());
    hex[..16].to_string()
}

/// Config file path: `{app_config_dir}/sync_v2/{vault_hash}.json`.
pub fn config_path(app_config_dir: &Path, vault_path: &Path) -> PathBuf {
    app_config_dir
        .join("sync_v2")
        .join(format!("{}.json", vault_hash(vault_path)))
}

pub fn load_config(app_config_dir: &Path, vault_path: &Path) -> Result<SyncV2Config, String> {
    let path = config_path(app_config_dir, vault_path);
    if !path.exists() {
        return Ok(SyncV2Config::default());
    }
    let bytes = std::fs::read(&path).map_err(|e| format!("read config: {}", e))?;
    serde_json::from_slice(&bytes).map_err(|e| format!("parse config: {}", e))
}

pub fn save_config(
    app_config_dir: &Path,
    vault_path: &Path,
    config: &SyncV2Config,
) -> Result<(), String> {
    let path = config_path(app_config_dir, vault_path);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir: {}", e))?;
    }
    let bytes = serde_json::to_vec_pretty(config).map_err(|e| format!("serialize: {}", e))?;
    std::fs::write(&path, bytes).map_err(|e| format!("write config: {}", e))?;
    Ok(())
}

pub fn delete_config(app_config_dir: &Path, vault_path: &Path) -> Result<(), String> {
    let path = config_path(app_config_dir, vault_path);
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| format!("delete config: {}", e))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_vault_hash_deterministic() {
        let h1 = vault_hash(Path::new("C:\\test\\vault"));
        let h2 = vault_hash(Path::new("C:\\test\\vault"));
        assert_eq!(h1, h2);
        assert_eq!(h1.len(), 16);
    }

    #[test]
    fn test_load_missing_returns_default() {
        let tmp = tempfile::tempdir().unwrap();
        let cfg = load_config(tmp.path(), Path::new("C:\\nonexistent")).unwrap();
        assert!(!cfg.enabled);
        assert!(cfg.remote_base.is_empty());
    }

    #[test]
    fn test_save_load_roundtrip() {
        let tmp = tempfile::tempdir().unwrap();
        let vault = Path::new("C:\\test\\myvault");
        let cfg = SyncV2Config {
            enabled: true,
            remote_base: "/Colony/Test".into(),
            url: Some("https://nas.example.com".into()),
            username: Some("user".into()),
            password: Some("pass".into()),
        };
        save_config(tmp.path(), vault, &cfg).unwrap();
        let loaded = load_config(tmp.path(), vault).unwrap();
        assert!(loaded.enabled);
        assert_eq!(loaded.remote_base, "/Colony/Test");
    }
}
