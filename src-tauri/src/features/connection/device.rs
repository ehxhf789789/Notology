//! Device info collection + lifecycle (login/heartbeat/logout).
//! Reuses vault_lock.rs machine_id + hostname.

use chrono::Utc;
use serde::{Deserialize, Serialize};
use sha2::{Sha256, Digest};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum DeviceStatus {
    Online,
    Offline,
}

impl Default for DeviceStatus {
    fn default() -> Self { Self::Offline }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
    pub device_id: String,
    pub hostname: String,
    pub os: String,
    pub machine_id: String,
    pub app_version: String,
    pub first_login_at: String,
    pub last_login_at: String,
    pub session_count: u64,
    #[serde(default)]
    pub status: DeviceStatus,
    #[serde(default)]
    pub login_at: String,
    #[serde(default)]
    pub last_seen_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub logout_at: Option<String>,
    // last_ip removed (Q-M2-3=A, Stage 5)
    #[serde(default, skip_serializing)]
    pub last_ip: Option<String>,
}

/// Sanitize hostname for use in device_id: keep alphanumeric + dash + underscore.
pub fn sanitize_hostname(h: &str) -> String {
    h.chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect()
}

/// Compute deterministic device_id: `{sanitized_hostname}-{sha256(machine_id)[..4 bytes]}`.
/// Same PC = same device_id across all vaults and across app restarts.
/// machine_id itself is NOT exposed (privacy: hashed).
pub fn compute_device_id(hostname: &str, machine_id: &str) -> String {
    let san = sanitize_hostname(hostname);
    let mut hasher = Sha256::new();
    hasher.update(machine_id.as_bytes());
    let hash = hasher.finalize();
    let short_hex = format!("{:02x}{:02x}{:02x}{:02x}", hash[0], hash[1], hash[2], hash[3]);
    format!("{}-{}", san, short_hex)
}

/// Collect device info from current system.
/// device_id is deterministic — same PC produces same id across restarts and vaults.
pub fn collect() -> DeviceInfo {
    let machine_id = crate::vault_lock::get_machine_id();
    let hostname = crate::vault_lock::get_hostname();
    let now = Utc::now().to_rfc3339();
    let device_id = compute_device_id(&hostname, &machine_id);

    DeviceInfo {
        device_id,
        hostname,
        os: std::env::consts::OS.to_string(),
        machine_id,
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        first_login_at: now.clone(),
        last_login_at: now.clone(),
        session_count: 1,
        status: DeviceStatus::Online,
        login_at: now.clone(),
        last_seen_at: now,
        logout_at: None,
        last_ip: None,
    }
}

impl DeviceInfo {
    pub fn mark_login(&mut self) {
        let now = Utc::now().to_rfc3339();
        self.status = DeviceStatus::Online;
        self.login_at = now.clone();
        self.last_seen_at = now.clone();
        self.logout_at = None;
        self.last_login_at = now;
        self.session_count += 1;
        self.app_version = env!("CARGO_PKG_VERSION").to_string();
    }

    pub fn mark_heartbeat(&mut self) {
        self.last_seen_at = Utc::now().to_rfc3339();
    }

    pub fn mark_logout(&mut self) {
        let now = Utc::now().to_rfc3339();
        self.status = DeviceStatus::Offline;
        self.logout_at = Some(now.clone());
        self.last_seen_at = now;
    }
}

// generate_short_hex was non-deterministic (timestamp+pid based) — replaced by
// compute_device_id (sha256 of machine_id). Removed to prevent accidental misuse.

/// Update session info on existing DeviceInfo (legacy compat).
pub fn update_session(info: &mut DeviceInfo) {
    info.mark_login();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh() -> DeviceInfo {
        DeviceInfo {
            device_id: "test-1234".into(),
            hostname: "test".into(),
            os: "windows".into(),
            machine_id: "mid".into(),
            app_version: "0.0.0".into(),
            first_login_at: "2026-01-01T00:00:00+00:00".into(),
            last_login_at: "2026-01-01T00:00:00+00:00".into(),
            session_count: 0,
            status: DeviceStatus::Offline,
            login_at: "".into(),
            last_seen_at: "".into(),
            logout_at: None,
            last_ip: None,
        }
    }

    #[test]
    fn mark_login_sets_online_and_increments_session() {
        let mut d = fresh();
        d.mark_login();
        assert_eq!(d.status, DeviceStatus::Online);
        assert_eq!(d.session_count, 1);
        assert!(!d.login_at.is_empty());
        assert!(!d.last_seen_at.is_empty());
        assert_eq!(d.logout_at, None);
        assert_eq!(d.last_login_at, d.login_at);
    }

    #[test]
    fn mark_login_twice_increments_session_twice() {
        let mut d = fresh();
        d.mark_login();
        d.mark_login();
        assert_eq!(d.session_count, 2);
    }

    #[test]
    fn mark_heartbeat_only_updates_last_seen() {
        let mut d = fresh();
        d.mark_login();
        let login_at = d.login_at.clone();
        let session_count = d.session_count;
        std::thread::sleep(std::time::Duration::from_millis(20));
        d.mark_heartbeat();
        assert_eq!(d.status, DeviceStatus::Online, "heartbeat must NOT change status");
        assert_eq!(d.session_count, session_count, "heartbeat must NOT change session_count");
        assert_eq!(d.login_at, login_at, "heartbeat must NOT change login_at");
        assert!(d.last_seen_at > login_at, "last_seen_at must advance");
    }

    #[test]
    fn mark_logout_sets_offline_with_logout_at() {
        let mut d = fresh();
        d.mark_login();
        d.mark_logout();
        assert_eq!(d.status, DeviceStatus::Offline);
        assert!(d.logout_at.is_some());
        assert_eq!(d.last_seen_at, *d.logout_at.as_ref().unwrap());
    }

    #[test]
    fn mark_login_after_logout_clears_logout_at() {
        let mut d = fresh();
        d.mark_login();
        d.mark_logout();
        assert!(d.logout_at.is_some());
        d.mark_login();
        assert_eq!(d.logout_at, None);
        assert_eq!(d.status, DeviceStatus::Online);
    }

    #[test]
    fn collect_creates_online_device() {
        let d = collect();
        assert_eq!(d.status, DeviceStatus::Online);
        assert_eq!(d.session_count, 1);
        assert!(!d.device_id.is_empty());
        assert!(d.device_id.contains('-'));
    }

    #[test]
    fn serde_status_camel_case_lowercase() {
        // Frontend (TypeScript) expects camelCase: "online" / "offline".
        // This test pins the contract — breaking it is a frontend regression.
        let online = serde_json::to_string(&DeviceStatus::Online).unwrap();
        let offline = serde_json::to_string(&DeviceStatus::Offline).unwrap();
        assert_eq!(online, "\"online\"");
        assert_eq!(offline, "\"offline\"");
    }

    #[test]
    fn serde_round_trip_preserves_all_fields() {
        let mut d = fresh();
        d.mark_login();
        d.mark_heartbeat();
        let json = serde_json::to_string(&d).unwrap();
        let parsed: DeviceInfo = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.device_id, d.device_id);
        assert_eq!(parsed.status, d.status);
        assert_eq!(parsed.login_at, d.login_at);
        assert_eq!(parsed.session_count, d.session_count);
    }
}
