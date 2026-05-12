//! Device registration: push DeviceInfo JSON to NAS .notology/devices/.
//! Uses put_md/get_md pattern (provider handles path normalization).

use std::sync::Arc;
use crate::core::sync_provider::SyncProvider;
use super::device::DeviceInfo;

const DEVICES_DIR: &str = ".notology/devices";

/// Register device on NAS (vault-specific).
pub async fn register_device(
    device: &DeviceInfo,
    provider: &Arc<dyn SyncProvider>,
) -> Result<(), String> {
    let path = format!("{}/{}.json", DEVICES_DIR, device.device_id);
    let content = serde_json::to_vec_pretty(device)
        .map_err(|e| format!("serialize device: {}", e))?;
    // Use put_md which handles ensure_parents + path normalization
    provider.put_md(&path, &content).await
        .map_err(|e| format!("register device: {}", e))?;
    log::debug!("[device_registry] registered: {} (status={:?})", device.device_id, device.status);
    Ok(())
}

/// Heartbeat: update last_seen_at + push to NAS.
pub async fn heartbeat(
    config_dir: &std::path::Path,
    provider: &Arc<dyn SyncProvider>,
) -> Result<(), String> {
    let mut config = super::store::load(config_dir)?
        .ok_or("no webdav config")?;
    config.device.mark_heartbeat();
    super::store::save(config_dir, &config)?;
    register_device(&config.device, provider).await
}

/// Mark device as offline + push to NAS (app shutdown).
pub async fn mark_logout(
    config_dir: &std::path::Path,
    provider: &Arc<dyn SyncProvider>,
) -> Result<(), String> {
    let mut config = super::store::load(config_dir)?
        .ok_or("no webdav config")?;
    config.device.mark_logout();
    super::store::save(config_dir, &config)?;
    register_device(&config.device, provider).await
}

/// List all registered devices for this vault.
/// Uses list_children on .notology/devices/ + get_md for each JSON file.
pub async fn list_all_devices(
    provider: &Arc<dyn SyncProvider>,
) -> Result<Vec<DeviceInfo>, String> {
    let children = provider.list_md_dir(DEVICES_DIR).await
        .unwrap_or_default(); // dir missing → empty

    let mut devices = Vec::new();
    for child in &children {
        if child.is_collection || !child.name.ends_with(".json") {
            continue;
        }
        let rel_path = format!("{}/{}", DEVICES_DIR, child.name);
        match provider.get_md(&rel_path).await {
            Ok(Some(bytes)) => {
                match serde_json::from_slice::<DeviceInfo>(&bytes) {
                    Ok(d) => devices.push(d),
                    Err(e) => log::warn!("[device_registry] parse {}: {}", child.name, e),
                }
            }
            Ok(None) => {}
            Err(e) => log::warn!("[device_registry] read {}: {}", child.name, e),
        }
    }

    devices.sort_by(|a, b| b.last_seen_at.cmp(&a.last_seen_at));
    log::debug!("[device_registry] listed {} devices", devices.len());
    Ok(devices)
}

/// Delete a device registration from NAS.
pub async fn delete_device(
    device_id: &str,
    provider: &Arc<dyn SyncProvider>,
) -> Result<(), String> {
    let device_path = format!("{}/{}.json", DEVICES_DIR, device_id);
    let _ = provider.delete_md(&device_path).await; // 404 ignore
    log::info!("[device_registry] deleted: {}", device_id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::device::{DeviceInfo, DeviceStatus};
    use crate::features::sync_v2::in_memory_provider::InMemorySyncProvider;
    use tempfile::TempDir;

    fn make_device(id: &str) -> DeviceInfo {
        DeviceInfo {
            device_id: id.into(),
            hostname: format!("host-{}", id),
            os: "windows".into(),
            machine_id: format!("mid-{}", id),
            app_version: "3.0.0".into(),
            first_login_at: chrono::Utc::now().to_rfc3339(),
            last_login_at: chrono::Utc::now().to_rfc3339(),
            session_count: 1,
            status: DeviceStatus::Online,
            login_at: chrono::Utc::now().to_rfc3339(),
            last_seen_at: chrono::Utc::now().to_rfc3339(),
            logout_at: None,
            last_ip: None,
        }
    }

    fn provider() -> Arc<dyn SyncProvider> {
        Arc::new(InMemorySyncProvider::new())
    }

    fn make_webdav_config(device: DeviceInfo) -> super::super::store::WebDavConfig {
        super::super::store::WebDavConfig {
            url: "http://test".into(),
            username: "u".into(),
            password: "p".into(),
            label: "test".into(),
            remember_password: true,
            device,
            last_active_vault_hash: None,
        }
    }

    #[tokio::test]
    async fn register_then_list_returns_device() {
        let p = provider();
        let d = make_device("dev-A");
        register_device(&d, &p).await.unwrap();

        let listed = list_all_devices(&p).await.unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].device_id, "dev-A");
        assert_eq!(listed[0].status, DeviceStatus::Online);
    }

    #[tokio::test]
    async fn list_multiple_devices_sorted_by_last_seen_desc() {
        let p = provider();
        let mut d_old = make_device("dev-old");
        d_old.last_seen_at = "2026-01-01T00:00:00+00:00".into();
        let mut d_new = make_device("dev-new");
        d_new.last_seen_at = "2026-12-31T00:00:00+00:00".into();

        register_device(&d_old, &p).await.unwrap();
        register_device(&d_new, &p).await.unwrap();

        let listed = list_all_devices(&p).await.unwrap();
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0].device_id, "dev-new", "newest first");
        assert_eq!(listed[1].device_id, "dev-old");
    }

    #[tokio::test]
    async fn list_empty_when_no_devices_registered() {
        let p = provider();
        let listed = list_all_devices(&p).await.unwrap();
        assert_eq!(listed.len(), 0);
    }

    #[tokio::test]
    async fn delete_removes_from_list() {
        let p = provider();
        register_device(&make_device("a"), &p).await.unwrap();
        register_device(&make_device("b"), &p).await.unwrap();
        assert_eq!(list_all_devices(&p).await.unwrap().len(), 2);

        delete_device("a", &p).await.unwrap();
        let after = list_all_devices(&p).await.unwrap();
        assert_eq!(after.len(), 1);
        assert_eq!(after[0].device_id, "b");
    }

    #[tokio::test]
    async fn delete_nonexistent_succeeds() {
        let p = provider();
        delete_device("nonexistent", &p).await.unwrap(); // must not error
    }

    #[tokio::test]
    async fn heartbeat_updates_last_seen_in_config_and_nas() {
        let tmp = TempDir::new().unwrap();
        let mut device = make_device("dev-hb");
        device.last_seen_at = "2026-01-01T00:00:00+00:00".into();

        // Save initial config
        super::super::store::save(tmp.path(), &make_webdav_config(device.clone())).unwrap();
        let p = provider();
        register_device(&device, &p).await.unwrap();

        let initial_seen = device.last_seen_at.clone();
        std::thread::sleep(std::time::Duration::from_millis(20));

        // Heartbeat
        heartbeat(tmp.path(), &p).await.unwrap();

        // Local config updated
        let after = super::super::store::load(tmp.path()).unwrap().unwrap();
        assert!(after.device.last_seen_at > initial_seen, "config last_seen_at must advance");
        assert_eq!(after.device.status, DeviceStatus::Online, "heartbeat keeps status Online");

        // NAS device.json reflects new last_seen
        let listed = list_all_devices(&p).await.unwrap();
        assert_eq!(listed.len(), 1);
        assert!(listed[0].last_seen_at > initial_seen);
        assert_eq!(listed[0].status, DeviceStatus::Online);
    }

    #[tokio::test]
    async fn mark_logout_sets_offline_on_nas() {
        let tmp = TempDir::new().unwrap();
        let device = make_device("dev-out");
        super::super::store::save(tmp.path(), &make_webdav_config(device.clone())).unwrap();
        let p = provider();
        register_device(&device, &p).await.unwrap();

        // Sanity: starts Online
        let listed = list_all_devices(&p).await.unwrap();
        assert_eq!(listed[0].status, DeviceStatus::Online);

        mark_logout(tmp.path(), &p).await.unwrap();

        // NAS now shows Offline + logout_at
        let listed = list_all_devices(&p).await.unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].status, DeviceStatus::Offline);
        assert!(listed[0].logout_at.is_some());

        // Local config also Offline
        let after = super::super::store::load(tmp.path()).unwrap().unwrap();
        assert_eq!(after.device.status, DeviceStatus::Offline);
    }

    #[tokio::test]
    async fn full_lifecycle_login_heartbeat_logout() {
        let tmp = TempDir::new().unwrap();
        let mut device = make_device("dev-lifecycle");
        device.status = DeviceStatus::Offline; // start fresh
        device.session_count = 0;

        super::super::store::save(tmp.path(), &make_webdav_config(device.clone())).unwrap();
        let p = provider();

        // 1. Login (mark_login + register)
        let mut config = super::super::store::load(tmp.path()).unwrap().unwrap();
        config.device.mark_login();
        super::super::store::save(tmp.path(), &config).unwrap();
        register_device(&config.device, &p).await.unwrap();

        let listed = list_all_devices(&p).await.unwrap();
        assert_eq!(listed[0].status, DeviceStatus::Online);
        assert_eq!(listed[0].session_count, 1);

        // 2. Heartbeat tick
        std::thread::sleep(std::time::Duration::from_millis(15));
        heartbeat(tmp.path(), &p).await.unwrap();

        let listed = list_all_devices(&p).await.unwrap();
        assert_eq!(listed[0].status, DeviceStatus::Online, "heartbeat keeps Online");

        // 3. Logout
        mark_logout(tmp.path(), &p).await.unwrap();

        let listed = list_all_devices(&p).await.unwrap();
        assert_eq!(listed[0].status, DeviceStatus::Offline);
        assert!(listed[0].logout_at.is_some());
    }
}
