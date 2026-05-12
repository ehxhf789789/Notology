//! Change notification via per-device state files (D8).
//!
//! Each device writes only its own file at:
//!   `.notology/sync_state/{device_id}.json`
//!
//! Stateless. No caching. Polling and orchestration are 4.6 territory.

use std::collections::{HashMap, HashSet};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::core::sync_provider::{SyncProvider, DeviceStateInfo};

/// Current schema version. Bump on incompatible DeviceState changes.
pub const SCHEMA_VERSION: u32 = 1;

/// One device's sync state. Each device writes ONLY its own file.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DeviceState {
    pub device_id: String,
    pub last_push: DateTime<Utc>,
    /// note_id → head_hash. Optional for backwards-compat with pre-schema-v1 files
    /// (e.g., legacy e2e test artifacts on existing NAS vaults). Missing → empty.
    #[serde(default)]
    pub ref_hashes: HashMap<String, String>,
    #[serde(default)]
    pub schema_version: u32,
}

/// Merged view of all devices' states.
#[derive(Debug, Clone, Default)]
pub struct GlobalSyncState {
    pub devices: HashMap<String, DeviceState>,
    pub file_info: HashMap<String, DeviceStateInfo>,
}

impl GlobalSyncState {
    /// For a given note, what hash does each device claim?
    pub fn devices_with_ref(&self, note_id: &str) -> HashMap<String, String> {
        self.devices.iter()
            .filter_map(|(dev, s)| s.ref_hashes.get(note_id).map(|h| (dev.clone(), h.clone())))
            .collect()
    }

    /// All note_ids any device has pushed.
    pub fn all_note_ids(&self) -> HashSet<String> {
        self.devices.values().flat_map(|s| s.ref_hashes.keys().cloned()).collect()
    }
}

/// A note that differs between local and at least one remote device.
#[derive(Debug, Clone, PartialEq)]
pub struct ChangedNote {
    pub note_id: String,
    pub local_hash: Option<String>,
    pub remote_hashes: HashMap<String, String>, // device_id → hash
}

impl ChangedNote {
    /// True if no remote device matches local hash.
    pub fn fully_diverged(&self) -> bool {
        match &self.local_hash {
            None => !self.remote_hashes.is_empty(),
            Some(local) => self.remote_hashes.values().all(|h| h != local),
        }
    }
}

/// Per-device change notification via state files on NAS.
pub struct ChangeNotifier {
    device_id: String,
}

impl ChangeNotifier {
    pub fn new(device_id: impl Into<String>) -> Self {
        Self { device_id: device_id.into() }
    }

    pub fn device_id(&self) -> &str { &self.device_id }

    /// Update OUR device file after a push. Replaces entire state (not merge).
    pub async fn notify_push(
        &self,
        provider: &dyn SyncProvider,
        ref_hashes: HashMap<String, String>,
    ) -> Result<(), String> {
        let state = DeviceState {
            device_id: self.device_id.clone(),
            last_push: Utc::now(),
            ref_hashes,
            schema_version: SCHEMA_VERSION,
        };
        let bytes = serde_json::to_vec_pretty(&state)
            .map_err(|e| format!("Serialize device state: {}", e))?;
        provider.put_device_state(&self.device_id, &bytes).await
            .map_err(|e| format!("Put device state: {}", e))
    }

    /// Read all device states from NAS. Stateless: re-reads each call.
    pub async fn read_global_state(
        &self,
        provider: &dyn SyncProvider,
    ) -> Result<GlobalSyncState, String> {
        let infos = provider.list_device_states().await
            .map_err(|e| format!("List device states: {}", e))?;

        let mut devices = HashMap::new();
        let mut file_info = HashMap::new();

        for info in infos {
            file_info.insert(info.device_id.clone(), info.clone());
            let bytes = match provider.get_device_state(&info.device_id).await {
                Ok(Some(b)) => b,
                Ok(None) => continue,
                Err(e) => {
                    log::warn!("[notifier] get_device_state {} failed: {:?}", info.device_id, e);
                    continue;
                }
            };
            match serde_json::from_slice::<DeviceState>(&bytes) {
                Ok(state) => {
                    if state.schema_version != SCHEMA_VERSION {
                        log::warn!("[notifier] {} has schema_version {}, expected {}",
                            info.device_id, state.schema_version, SCHEMA_VERSION);
                    }
                    devices.insert(info.device_id.clone(), state);
                }
                Err(e) => {
                    log::warn!("[notifier] Parse {} state failed: {}", info.device_id, e);
                }
            }
        }

        Ok(GlobalSyncState { devices, file_info })
    }

    /// Detect notes where any OTHER device has a different hash than local.
    /// Excludes our own device file.
    pub async fn check_remote_changes(
        &self,
        provider: &dyn SyncProvider,
        local_refs: &HashMap<String, String>,
    ) -> Result<Vec<ChangedNote>, String> {
        let global = self.read_global_state(provider).await?;

        let mut all_ids = global.all_note_ids();
        for id in local_refs.keys() {
            all_ids.insert(id.clone());
        }

        let mut changed = Vec::new();
        for note_id in all_ids {
            let local_hash = local_refs.get(&note_id).cloned();
            let remote_hashes: HashMap<String, String> = global.devices.iter()
                .filter(|(dev, _)| *dev != &self.device_id)
                .filter_map(|(dev, s)| s.ref_hashes.get(&note_id).map(|h| (dev.clone(), h.clone())))
                .collect();

            let is_changed = match (&local_hash, remote_hashes.is_empty()) {
                (_, true) => false,
                (None, false) => true,
                (Some(local), false) => remote_hashes.values().any(|h| h != local),
            };

            if is_changed {
                changed.push(ChangedNote { note_id, local_hash, remote_hashes });
            }
        }

        Ok(changed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use crate::features::sync_v2::in_memory_provider::InMemorySyncProvider;

    fn provider() -> Arc<InMemorySyncProvider> { Arc::new(InMemorySyncProvider::new()) }

    #[tokio::test]
    async fn test_notify_push_writes_state() {
        let p = provider();
        let n = ChangeNotifier::new("DEV-A");
        let refs: HashMap<String, String> = [("n1".into(), "h1".into())].into();
        n.notify_push(p.as_ref(), refs.clone()).await.unwrap();
        let bytes = p.get_device_state("DEV-A").await.unwrap().unwrap();
        let s: DeviceState = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(s.ref_hashes, refs);
        assert_eq!(s.schema_version, SCHEMA_VERSION);
    }

    #[tokio::test]
    async fn test_read_global_state_empty() {
        let p = provider();
        let n = ChangeNotifier::new("DEV-A");
        let g = n.read_global_state(p.as_ref()).await.unwrap();
        assert!(g.devices.is_empty());
    }

    #[tokio::test]
    async fn test_read_global_state_multi_device() {
        let p = provider();
        ChangeNotifier::new("A").notify_push(p.as_ref(), [("n1".into(), "h1".into())].into()).await.unwrap();
        ChangeNotifier::new("B").notify_push(p.as_ref(), [("n2".into(), "h2".into())].into()).await.unwrap();
        let g = ChangeNotifier::new("A").read_global_state(p.as_ref()).await.unwrap();
        assert_eq!(g.devices.len(), 2);
    }

    #[tokio::test]
    async fn test_check_no_changes_only_local() {
        let p = provider();
        let n = ChangeNotifier::new("A");
        let refs: HashMap<String, String> = [("n1".into(), "h1".into())].into();
        n.notify_push(p.as_ref(), refs.clone()).await.unwrap();
        let changes = n.check_remote_changes(p.as_ref(), &refs).await.unwrap();
        assert!(changes.is_empty());
    }

    #[tokio::test]
    async fn test_check_diverged_remote() {
        let p = provider();
        ChangeNotifier::new("B").notify_push(p.as_ref(), [("n1".into(), "h_remote".into())].into()).await.unwrap();
        let local: HashMap<String, String> = [("n1".into(), "h_local".into())].into();
        let changes = ChangeNotifier::new("A").check_remote_changes(p.as_ref(), &local).await.unwrap();
        assert_eq!(changes.len(), 1);
        assert!(changes[0].fully_diverged());
    }

    #[tokio::test]
    async fn test_check_remote_only_note() {
        let p = provider();
        ChangeNotifier::new("B").notify_push(p.as_ref(), [("new".into(), "h".into())].into()).await.unwrap();
        let changes = ChangeNotifier::new("A").check_remote_changes(p.as_ref(), &HashMap::new()).await.unwrap();
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].local_hash, None);
    }

    #[tokio::test]
    async fn test_excludes_self() {
        let p = provider();
        let n = ChangeNotifier::new("A");
        n.notify_push(p.as_ref(), [("n1".into(), "h".into())].into()).await.unwrap();
        let changes = n.check_remote_changes(p.as_ref(), &[("n1".into(), "h".into())].into()).await.unwrap();
        assert!(changes.is_empty());
    }

    #[tokio::test]
    async fn test_global_devices_with_ref() {
        let p = provider();
        ChangeNotifier::new("A").notify_push(p.as_ref(), [("n1".into(), "hA".into())].into()).await.unwrap();
        ChangeNotifier::new("B").notify_push(p.as_ref(), [("n1".into(), "hB".into())].into()).await.unwrap();
        let g = ChangeNotifier::new("A").read_global_state(p.as_ref()).await.unwrap();
        let owners = g.devices_with_ref("n1");
        assert_eq!(owners.len(), 2);
    }

    #[tokio::test]
    async fn test_notify_push_replaces() {
        let p = provider();
        let n = ChangeNotifier::new("A");
        n.notify_push(p.as_ref(), [("n1".into(), "h1".into()), ("n2".into(), "h2".into())].into()).await.unwrap();
        n.notify_push(p.as_ref(), [("n1".into(), "h1_new".into())].into()).await.unwrap();
        let bytes = p.get_device_state("A").await.unwrap().unwrap();
        let s: DeviceState = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(s.ref_hashes.len(), 1); // n2 gone
    }

    #[tokio::test]
    async fn test_fully_diverged_helper() {
        let c = ChangedNote { note_id: "n".into(), local_hash: Some("x".into()), remote_hashes: [("d".into(), "y".into())].into() };
        assert!(c.fully_diverged());
        let c2 = ChangedNote { note_id: "n".into(), local_hash: Some("x".into()), remote_hashes: [("d".into(), "x".into())].into() };
        assert!(!c2.fully_diverged());
    }
}
