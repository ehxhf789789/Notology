//! Migration: v1 nas-connections.json + sync_v2 per-vault configs → unified webdav-config.json.
//! v1 nas-connections.json is preserved (not deleted). sync_v2 configs get .legacy backup.

use std::path::Path;
use serde::Deserialize;

use super::device;
use super::store::{self, WebDavConfig};

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationReport {
    pub migrated: bool,
    pub source: String,
    pub vaults_simplified: usize,
    pub errors: Vec<String>,
}

/// v1 NasConnections format (read-only, for migration).
#[derive(Deserialize)]
struct V1NasConnections {
    connections: Vec<V1NasConnection>,
    last_active: Option<V1LastActive>,
}

#[derive(Deserialize)]
struct V1NasConnection {
    url: String,
    username: String,
    #[serde(default)]
    password: String,
    display_name: String,
}

#[derive(Deserialize)]
struct V1LastActive {
    connection_id: String,
}

/// Check if migration needed and perform if so.
pub fn migrate_if_needed(app_config_dir: &Path) -> Result<MigrationReport, String> {
    // Already migrated?
    if store::config_path(app_config_dir).exists() {
        return Ok(MigrationReport {
            migrated: false,
            source: "already_migrated".into(),
            vaults_simplified: 0,
            errors: vec![],
        });
    }

    // Try v1 nas-connections.json
    // 1. Check app_config_dir (test-friendly, also works if user moved it)
    // 2. Check system default (%APPDATA%/Notology/)
    let v1_path = find_v1_connections_in(app_config_dir)
        .or_else(find_v1_connections_path);
    if let Some(v1_path) = v1_path {
        if let Ok(bytes) = std::fs::read(&v1_path) {
            if let Ok(v1) = serde_json::from_slice::<V1NasConnections>(&bytes) {
                if let Some(conn) = v1.connections.first() {
                    let config = WebDavConfig {
                        url: conn.url.clone(),
                        username: conn.username.clone(),
                        password: conn.password.clone(),
                        label: conn.display_name.clone(),
                        remember_password: true,
                        device: device::collect(),
                        last_active_vault_hash: None,
                    };
                    store::save(app_config_dir, &config)?;

                    // Simplify sync_v2 configs
                    let simplified = simplify_sync_v2_configs(app_config_dir);

                    log::info!("[connection migrator] migrated from v1 nas-connections: url={}", conn.url);
                    return Ok(MigrationReport {
                        migrated: true,
                        source: "v1_nas_connections".into(),
                        vaults_simplified: simplified,
                        errors: vec![],
                    });
                }
            }
        }
    }

    // Try first sync_v2 config with credentials
    let sync_v2_dir = app_config_dir.join("sync_v2");
    if sync_v2_dir.is_dir() {
        if let Ok(entries) = std::fs::read_dir(&sync_v2_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) != Some("json") { continue; }
                if let Ok(bytes) = std::fs::read(&path) {
                    if let Ok(v) = serde_json::from_slice::<serde_json::Value>(&bytes) {
                        if let (Some(url), Some(user), Some(pass)) = (
                            v.get("url").and_then(|v| v.as_str()),
                            v.get("username").and_then(|v| v.as_str()),
                            v.get("password").and_then(|v| v.as_str()),
                        ) {
                            if !url.is_empty() && !user.is_empty() && !pass.is_empty() {
                                let config = WebDavConfig {
                                    url: url.into(),
                                    username: user.into(),
                                    password: pass.into(),
                                    label: format!("{}@{}", user, url),
                                    remember_password: true,
                                    device: device::collect(),
                                    last_active_vault_hash: None,
                                };
                                store::save(app_config_dir, &config)?;
                                let simplified = simplify_sync_v2_configs(app_config_dir);

                                log::info!("[connection migrator] migrated from sync_v2 config: url={}", url);
                                return Ok(MigrationReport {
                                    migrated: true,
                                    source: "sync_v2_config".into(),
                                    vaults_simplified: simplified,
                                    errors: vec![],
                                });
                            }
                        }
                    }
                }
            }
        }
    }

    // Nothing to migrate
    Ok(MigrationReport {
        migrated: false,
        source: "fresh".into(),
        vaults_simplified: 0,
        errors: vec![],
    })
}

/// Remove url/username/password from sync_v2 per-vault configs (they now come from webdav-config).
fn simplify_sync_v2_configs(app_config_dir: &Path) -> usize {
    let sync_v2_dir = app_config_dir.join("sync_v2");
    if !sync_v2_dir.is_dir() { return 0; }

    let mut count = 0;
    if let Ok(entries) = std::fs::read_dir(&sync_v2_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") { continue; }
            if let Ok(bytes) = std::fs::read(&path) {
                if let Ok(mut v) = serde_json::from_slice::<serde_json::Value>(&bytes) {
                    let had_url = v.get("url").and_then(|v| v.as_str()).map(|s| !s.is_empty()).unwrap_or(false);
                    if had_url {
                        // Backup
                        let legacy = path.with_extension("json.legacy");
                        let _ = std::fs::copy(&path, &legacy);

                        // Remove credentials (keep enabled + remoteBase)
                        if let Some(obj) = v.as_object_mut() {
                            obj.remove("url");
                            obj.remove("username");
                            obj.remove("password");
                        }
                        if let Ok(new_bytes) = serde_json::to_vec_pretty(&v) {
                            let _ = std::fs::write(&path, new_bytes);
                            count += 1;
                        }
                    }
                }
            }
        }
    }
    count
}

fn find_v1_connections_in(dir: &Path) -> Option<std::path::PathBuf> {
    let path = dir.join("nas-connections.json");
    if path.exists() { Some(path) } else { None }
}

fn find_v1_connections_path() -> Option<std::path::PathBuf> {
    #[cfg(target_os = "windows")]
    {
        if let Ok(appdata) = std::env::var("APPDATA") {
            let path = std::path::PathBuf::from(appdata).join("Notology").join("nas-connections.json");
            if path.exists() { return Some(path); }
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        if let Some(config) = dirs::config_dir() {
            let path = config.join("notology").join("nas-connections.json");
            if path.exists() { return Some(path); }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_skip_if_exists() {
        let tmp = tempfile::tempdir().unwrap();
        store::save(tmp.path(), &WebDavConfig::default()).unwrap();
        let report = migrate_test_only(tmp.path()).unwrap();
        assert!(!report.migrated);
        assert_eq!(report.source, "already_migrated");
    }

    #[test]
    fn test_fresh_no_sources() {
        let tmp = tempfile::tempdir().unwrap();
        let report = migrate_test_only(tmp.path()).unwrap();
        assert!(!report.migrated);
        assert_eq!(report.source, "fresh");
    }

    /// Test-only: migrate without checking system v1 path
    fn migrate_test_only(app_config_dir: &Path) -> Result<MigrationReport, String> {
        if store::config_path(app_config_dir).exists() {
            return Ok(MigrationReport { migrated: false, source: "already_migrated".into(), vaults_simplified: 0, errors: vec![] });
        }
        // Only check local app_config_dir, NOT system APPDATA
        let v1_path = find_v1_connections_in(app_config_dir);
        if let Some(v1_path) = v1_path {
            if let Ok(bytes) = std::fs::read(&v1_path) {
                if let Ok(v1) = serde_json::from_slice::<V1NasConnections>(&bytes) {
                    if let Some(conn) = v1.connections.first() {
                        let config = WebDavConfig {
                            url: conn.url.clone(), username: conn.username.clone(),
                            password: conn.password.clone(), label: conn.display_name.clone(),
                            remember_password: true, device: device::collect(), last_active_vault_hash: None,
                        };
                        store::save(app_config_dir, &config)?;
                        let simplified = simplify_sync_v2_configs(app_config_dir);
                        return Ok(MigrationReport { migrated: true, source: "v1_nas_connections".into(), vaults_simplified: simplified, errors: vec![] });
                    }
                }
            }
        }
        // Try sync_v2 configs
        let sync_v2_dir = app_config_dir.join("sync_v2");
        if sync_v2_dir.is_dir() {
            if let Ok(entries) = std::fs::read_dir(&sync_v2_dir) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.extension().and_then(|e| e.to_str()) != Some("json") { continue; }
                    if let Ok(bytes) = std::fs::read(&path) {
                        if let Ok(v) = serde_json::from_slice::<serde_json::Value>(&bytes) {
                            if let (Some(url), Some(user), Some(pass)) = (
                                v.get("url").and_then(|v| v.as_str()),
                                v.get("username").and_then(|v| v.as_str()),
                                v.get("password").and_then(|v| v.as_str()),
                            ) {
                                if !url.is_empty() && !user.is_empty() && !pass.is_empty() {
                                    let config = WebDavConfig {
                                        url: url.into(), username: user.into(), password: pass.into(),
                                        label: format!("{}@{}", user, url), remember_password: true,
                                        device: device::collect(), last_active_vault_hash: None,
                                    };
                                    store::save(app_config_dir, &config)?;
                                    let simplified = simplify_sync_v2_configs(app_config_dir);
                                    return Ok(MigrationReport { migrated: true, source: "sync_v2_config".into(), vaults_simplified: simplified, errors: vec![] });
                                }
                            }
                        }
                    }
                }
            }
        }
        Ok(MigrationReport { migrated: false, source: "fresh".into(), vaults_simplified: 0, errors: vec![] })
    }

    #[test]
    fn test_migrate_from_sync_v2() {
        let tmp = tempfile::tempdir().unwrap();
        let sync_v2_dir = tmp.path().join("sync_v2");
        std::fs::create_dir_all(&sync_v2_dir).unwrap();
        std::fs::write(
            sync_v2_dir.join("abc123.json"),
            r#"{"enabled":true,"url":"https://nas.test","username":"user","password":"pass","remoteBase":"/vault"}"#,
        ).unwrap();

        let report = migrate_test_only(tmp.path()).unwrap();
        assert!(report.migrated);
        assert_eq!(report.source, "sync_v2_config");
        assert_eq!(report.vaults_simplified, 1);

        // Verify webdav-config created
        let config = store::load(tmp.path()).unwrap().unwrap();
        assert_eq!(config.url, "https://nas.test");

        // Verify sync_v2 config simplified
        let simplified: serde_json::Value = serde_json::from_slice(
            &std::fs::read(sync_v2_dir.join("abc123.json")).unwrap()
        ).unwrap();
        assert!(simplified.get("url").is_none());
        assert!(simplified.get("remoteBase").is_some());

        // Verify legacy backup
        assert!(sync_v2_dir.join("abc123.json.legacy").exists());
    }
}
