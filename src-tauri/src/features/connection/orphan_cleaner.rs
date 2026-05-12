//! Orphan device.json cleanup.
//! When a device's `device_id` changes (e.g., migrating from timestamp-based to
//! deterministic IDs), old entries on the NAS become orphans. This module removes
//! them, but ONLY if hostname + os + machine_id ALL match the current device.
//! Partial matches are preserved (might be a different PC with same hostname).

use std::sync::Arc;

use crate::core::sync_provider::SyncProvider;
use super::device::DeviceInfo;

const DEVICES_DIR: &str = ".notology/devices";

/// Clean orphan device.json files on NAS.
/// Returns count of files removed. Best-effort; individual failures logged but ignored.
///
/// Matching: hostname + os + machine_id ALL match current → orphan.
/// Self device (same device_id) is always preserved.
pub async fn clean_orphans(
    provider: &Arc<dyn SyncProvider>,
    current: &DeviceInfo,
) -> Result<usize, String> {
    let children = match provider.list_md_dir(DEVICES_DIR).await {
        Ok(c) => c,
        Err(e) => {
            log::trace!("[orphan_cleaner] list_md_dir failed (likely no devices/ yet): {}", e);
            return Ok(0);
        }
    };

    let mut cleaned = 0;
    for child in children {
        if child.is_collection || !child.name.ends_with(".json") {
            continue;
        }
        // Skip self
        if child.name == format!("{}.json", current.device_id) {
            continue;
        }

        let rel_path = format!("{}/{}", DEVICES_DIR, child.name);
        let bytes = match provider.get_md(&rel_path).await {
            Ok(Some(b)) => b,
            Ok(None) => continue,
            Err(e) => {
                log::debug!("[orphan_cleaner] read {} failed: {}", child.name, e);
                continue;
            }
        };

        let other: DeviceInfo = match serde_json::from_slice(&bytes) {
            Ok(d) => d,
            Err(e) => {
                log::debug!("[orphan_cleaner] parse {} failed: {}", child.name, e);
                continue;
            }
        };

        // 3-way match: hostname + os + machine_id
        let same_pc = other.hostname == current.hostname
            && other.os == current.os
            && other.machine_id == current.machine_id;

        if same_pc && other.device_id != current.device_id {
            log::info!(
                "[orphan_cleaner] removing orphan: {} (was {}, current is {})",
                child.name, other.device_id, current.device_id
            );
            match provider.delete_md(&rel_path).await {
                Ok(_) => cleaned += 1,
                Err(e) => log::warn!("[orphan_cleaner] delete {} failed: {}", child.name, e),
            }
        }
    }

    if cleaned > 0 {
        log::info!("[orphan_cleaner] cleaned {} orphan device(s)", cleaned);
    }
    Ok(cleaned)
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::device::DeviceStatus;
    use super::super::device_registry;
    use crate::features::sync_v2::in_memory_provider::InMemorySyncProvider;

    fn make_device(device_id: &str, hostname: &str, machine_id: &str) -> DeviceInfo {
        DeviceInfo {
            device_id: device_id.into(),
            hostname: hostname.into(),
            os: "windows".into(),
            machine_id: machine_id.into(),
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

    #[tokio::test]
    async fn removes_same_pc_different_id() {
        let p = provider();
        let old = make_device("host-OLD11111", "host", "mid-A");
        let new_d = make_device("host-NEW22222", "host", "mid-A");
        device_registry::register_device(&old, &p).await.unwrap();
        device_registry::register_device(&new_d, &p).await.unwrap();

        let cleaned = clean_orphans(&p, &new_d).await.unwrap();
        assert_eq!(cleaned, 1);

        let listed = device_registry::list_all_devices(&p).await.unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].device_id, "host-NEW22222");
    }

    #[tokio::test]
    async fn preserves_different_machine_id() {
        let p = provider();
        let other = make_device("host-OTHER111", "host", "mid-DIFFERENT");
        let me = make_device("host-NEW22222", "host", "mid-A");
        device_registry::register_device(&other, &p).await.unwrap();
        device_registry::register_device(&me, &p).await.unwrap();

        let cleaned = clean_orphans(&p, &me).await.unwrap();
        assert_eq!(cleaned, 0, "different machine_id must be preserved");

        let listed = device_registry::list_all_devices(&p).await.unwrap();
        assert_eq!(listed.len(), 2);
    }

    #[tokio::test]
    async fn preserves_different_hostname() {
        let p = provider();
        let other = make_device("other-AAAA1111", "other", "mid-A");
        let me = make_device("host-NEW22222", "host", "mid-A");
        device_registry::register_device(&other, &p).await.unwrap();
        device_registry::register_device(&me, &p).await.unwrap();

        let cleaned = clean_orphans(&p, &me).await.unwrap();
        assert_eq!(cleaned, 0, "different hostname must be preserved");
    }

    #[tokio::test]
    async fn preserves_different_os() {
        let p = provider();
        let mut other = make_device("host-OTHER111", "host", "mid-A");
        other.os = "linux".into();
        let me = make_device("host-NEW22222", "host", "mid-A");
        device_registry::register_device(&other, &p).await.unwrap();
        device_registry::register_device(&me, &p).await.unwrap();

        let cleaned = clean_orphans(&p, &me).await.unwrap();
        assert_eq!(cleaned, 0, "different os must be preserved");
    }

    #[tokio::test]
    async fn never_removes_self() {
        let p = provider();
        let me = make_device("host-NEW22222", "host", "mid-A");
        device_registry::register_device(&me, &p).await.unwrap();

        let cleaned = clean_orphans(&p, &me).await.unwrap();
        assert_eq!(cleaned, 0);

        let listed = device_registry::list_all_devices(&p).await.unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].device_id, "host-NEW22222");
    }

    #[tokio::test]
    async fn empty_devices_dir_returns_zero() {
        let p = provider();
        let me = make_device("host-NEW22222", "host", "mid-A");
        let cleaned = clean_orphans(&p, &me).await.unwrap();
        assert_eq!(cleaned, 0);
    }

    #[tokio::test]
    async fn removes_multiple_orphans() {
        let p = provider();
        let old1 = make_device("host-OLD11111", "host", "mid-A");
        let old2 = make_device("host-OLD22222", "host", "mid-A");
        let old3 = make_device("host-OLD33333", "host", "mid-A");
        let new_d = make_device("host-NEW44444", "host", "mid-A");
        device_registry::register_device(&old1, &p).await.unwrap();
        device_registry::register_device(&old2, &p).await.unwrap();
        device_registry::register_device(&old3, &p).await.unwrap();
        device_registry::register_device(&new_d, &p).await.unwrap();

        let cleaned = clean_orphans(&p, &new_d).await.unwrap();
        assert_eq!(cleaned, 3);

        let listed = device_registry::list_all_devices(&p).await.unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].device_id, "host-NEW44444");
    }
}
