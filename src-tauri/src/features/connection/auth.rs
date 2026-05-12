//! WebDAV authentication: test connection, first login, re-login, logout.

use std::path::Path;
use std::sync::Arc;

use serde::Serialize;

use crate::core::sync_provider::SyncProvider;
use super::device;
use super::device::DeviceInfo;
use super::store::WebDavConfig;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ConnectionTestResult {
    Success,
    InvalidCredentials,
    NetworkError(String),
    ServerError(String),
}

/// Test WebDAV connection (PROPFIND root depth=0).
pub async fn test_connection(
    url: &str,
    username: &str,
    password: &str,
) -> Result<ConnectionTestResult, String> {
    let client = crate::core::webdav::WebDavClient::new(url, username, password)
        .map_err(|e| format!("WebDAV client init: {}", e))?;

    match client.test_connection().await {
        Ok(true) => Ok(ConnectionTestResult::Success),
        Ok(false) => Ok(ConnectionTestResult::ServerError("Connection test returned false".into())),
        Err(e) => {
            let msg = e.to_string();
            if msg.contains("401") || msg.contains("403") || msg.contains("auth") {
                Ok(ConnectionTestResult::InvalidCredentials)
            } else if msg.contains("timeout") || msg.contains("connect") || msg.contains("dns") {
                Ok(ConnectionTestResult::NetworkError(msg))
            } else {
                Ok(ConnectionTestResult::ServerError(msg))
            }
        }
    }
}

/// First-time login: test connection → create WebDavConfig → save.
pub async fn first_login(
    config_dir: &Path,
    url: String,
    username: String,
    password: String,
    label: String,
    remember_password: bool,
) -> Result<DeviceInfo, String> {
    // 1. Test connection
    match test_connection(&url, &username, &password).await? {
        ConnectionTestResult::Success => {}
        ConnectionTestResult::InvalidCredentials =>
            return Err("Invalid credentials (401/403)".into()),
        ConnectionTestResult::NetworkError(e) =>
            return Err(format!("Network error: {}", e)),
        ConnectionTestResult::ServerError(e) =>
            return Err(format!("Server error: {}", e)),
    }

    // 2. Collect device info
    let mut dev = device::collect();
    dev.mark_login();

    // 3. Build config
    let config = WebDavConfig {
        url,
        username,
        password: if remember_password { password } else { String::new() },
        label,
        remember_password,
        device: dev.clone(),
        last_active_vault_hash: None,
    };

    // 4. Save
    super::store::save(config_dir, &config)?;
    log::info!("[auth] first_login: device_id={}", dev.device_id);

    Ok(dev)
}

/// Re-login: load existing config → test → update session.
pub async fn re_login(config_dir: &Path) -> Result<DeviceInfo, String> {
    let mut config = super::store::load(config_dir)?
        .ok_or("No WebDAV config found")?;

    // Test connection validity
    match test_connection(&config.url, &config.username, &config.password).await? {
        ConnectionTestResult::Success => {}
        other => return Err(format!("Re-login failed: {:?}", other)),
    }

    config.device.mark_login();
    super::store::save(config_dir, &config)?;
    log::info!("[auth] re_login: device_id={}", config.device.device_id);

    Ok(config.device)
}

/// Logout: mark offline on NAS → optionally delete device → delete config.
pub async fn logout(
    config_dir: &Path,
    remove_from_nas: bool,
    provider: Option<&Arc<dyn SyncProvider>>,
) -> Result<(), String> {
    let mut config = match super::store::load(config_dir)? {
        Some(c) => c,
        None => return Ok(()), // already logged out
    };

    // Mark offline
    config.device.mark_logout();

    // Push offline status to NAS
    if let Some(p) = provider {
        let _ = super::device_registry::register_device(&config.device, p).await;

        if remove_from_nas {
            let _ = super::device_registry::delete_device(&config.device.device_id, p).await;
        }
    }

    // Delete local config
    super::store::delete(config_dir)?;

    // Clear vault discovery cache
    let cache_path = config_dir.join("vault-discovery-cache.json");
    let _ = std::fs::remove_file(&cache_path);

    log::info!("[auth] logout: device_id={}, remove_from_nas={}", config.device.device_id, remove_from_nas);
    Ok(())
}
