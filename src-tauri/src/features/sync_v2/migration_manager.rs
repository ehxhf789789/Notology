//! MigrationManager: transition from legacy sync to sync_v2.
//!
//! Per D16: hybrid trigger, 7-day retention, full directory rename,
//! idempotent, local-only (no NAS).

use std::fs;
use std::path::PathBuf;
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};

pub const SCHEMA_VERSION: u32 = 1;
pub const DEFAULT_RETENTION_DAYS: i64 = 7;

const LEGACY_DIR: &str = ".notology/sync";
const ARCHIVE_DIR: &str = ".notology/sync.legacy";
const BRANCHES_DIR: &str = ".notology/branches";
const SYNC_STATE_DIR: &str = ".notology/sync_state";
const MARKER_FILE: &str = ".notology/migration.json";

/// Migration status.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum MigrationStatus {
    NoLegacy,
    LegacyDetected,
    Migrated { migrated_at: DateTime<Utc>, cleanup_due: DateTime<Utc> },
    Cleaned,
    FailedMigration { error: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Marker {
    schema_version: u32,
    migrated_at: DateTime<Utc>,
    retention_days: i64,
}

/// Manages migration from legacy sync to sync_v2.
pub struct MigrationManager {
    vault_path: PathBuf,
    retention_days: i64,
}

impl MigrationManager {
    pub fn new(vault_path: impl Into<PathBuf>) -> Self {
        Self { vault_path: vault_path.into(), retention_days: DEFAULT_RETENTION_DAYS }
    }

    pub fn with_retention(mut self, days: i64) -> Self {
        self.retention_days = days;
        self
    }

    fn legacy_path(&self) -> PathBuf { self.vault_path.join(LEGACY_DIR) }
    fn archive_path(&self) -> PathBuf { self.vault_path.join(ARCHIVE_DIR) }
    fn marker_path(&self) -> PathBuf { self.vault_path.join(MARKER_FILE) }
    fn branches_path(&self) -> PathBuf { self.vault_path.join(BRANCHES_DIR) }
    fn sync_state_path(&self) -> PathBuf { self.vault_path.join(SYNC_STATE_DIR) }

    pub fn has_legacy(&self) -> bool { self.legacy_path().is_dir() }
    pub fn has_archive(&self) -> bool { self.archive_path().is_dir() }

    /// Current migration status.
    pub fn status(&self) -> MigrationStatus {
        let legacy = self.has_legacy();
        let archive = self.has_archive();
        let marker = self.read_marker();

        match (legacy, archive, marker) {
            (false, false, None) => MigrationStatus::NoLegacy,
            (true, false, None) => MigrationStatus::LegacyDetected,
            (true, true, _) => MigrationStatus::LegacyDetected, // edge: both exist
            (false, true, Some(m)) => MigrationStatus::Migrated {
                migrated_at: m.migrated_at,
                cleanup_due: m.migrated_at + Duration::days(m.retention_days),
            },
            (false, false, Some(_)) => MigrationStatus::Cleaned,
            (false, true, None) => MigrationStatus::FailedMigration {
                error: "Archive exists without marker".into(),
            },
            (true, false, Some(_)) => MigrationStatus::FailedMigration {
                error: "Marker exists but legacy not renamed".into(),
            },
        }
    }

    /// Perform migration. Idempotent.
    pub async fn migrate(&self) -> Result<MigrationStatus, String> {
        match self.status() {
            MigrationStatus::NoLegacy | MigrationStatus::Cleaned => {
                self.ensure_sync_v2_structure()?;
                return Ok(self.status());
            }
            MigrationStatus::Migrated { .. } => return Ok(self.status()),
            MigrationStatus::FailedMigration { error } => {
                return Err(format!("Previous failure: {}", error));
            }
            MigrationStatus::LegacyDetected => {}
        }

        let legacy = self.legacy_path();
        let archive = self.archive_path();

        if archive.exists() {
            let ts = Utc::now().timestamp();
            let fallback = self.vault_path.join(format!("{ARCHIVE_DIR}_{ts}"));
            fs::rename(&legacy, &fallback)
                .map_err(|e| format!("Rename to fallback: {}", e))?;
            return Err(format!("Archive collision. Legacy saved at {:?}", fallback));
        }

        fs::rename(&legacy, &archive)
            .map_err(|e| format!("Rename: {}", e))?;

        let marker = Marker {
            schema_version: SCHEMA_VERSION,
            migrated_at: Utc::now(),
            retention_days: self.retention_days,
        };
        self.write_marker(&marker)?;
        self.ensure_sync_v2_structure()?;

        Ok(self.status())
    }

    /// Delete archive if retention passed.
    pub async fn cleanup_if_due(&self) -> Result<bool, String> {
        let marker = match self.read_marker() {
            Some(m) => m,
            None => return Ok(false),
        };
        let due = marker.migrated_at + Duration::days(marker.retention_days);
        if Utc::now() < due { return Ok(false); }
        let archive = self.archive_path();
        if !archive.is_dir() { return Ok(false); }
        fs::remove_dir_all(&archive).map_err(|e| format!("Remove archive: {}", e))?;
        Ok(true)
    }

    /// Create sync_v2 directories. Idempotent.
    pub fn ensure_sync_v2_structure(&self) -> Result<(), String> {
        for p in [self.branches_path(), self.sync_state_path()] {
            if !p.exists() {
                fs::create_dir_all(&p).map_err(|e| format!("Create {}: {}", p.display(), e))?;
            }
        }
        Ok(())
    }

    fn read_marker(&self) -> Option<Marker> {
        let bytes = fs::read(self.marker_path()).ok()?;
        serde_json::from_slice(&bytes).ok()
    }

    fn write_marker(&self, m: &Marker) -> Result<(), String> {
        let path = self.marker_path();
        if let Some(p) = path.parent() { let _ = fs::create_dir_all(p); }
        let bytes = serde_json::to_vec_pretty(m).map_err(|e| format!("Serialize: {}", e))?;
        fs::write(&path, bytes).map_err(|e| format!("Write marker: {}", e))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn make() -> (MigrationManager, TempDir) {
        let d = TempDir::new().unwrap();
        (MigrationManager::new(d.path()), d)
    }

    fn create_legacy(m: &MigrationManager) {
        let p = m.legacy_path();
        fs::create_dir_all(&p).unwrap();
        fs::write(p.join("manifest.json"), "{}").unwrap();
    }

    #[test]
    fn test_fresh_vault() {
        let (m, _d) = make();
        assert_eq!(m.status(), MigrationStatus::NoLegacy);
    }

    #[test]
    fn test_legacy_detected() {
        let (m, _d) = make();
        create_legacy(&m);
        assert_eq!(m.status(), MigrationStatus::LegacyDetected);
    }

    #[tokio::test]
    async fn test_migrate_fresh() {
        let (m, _d) = make();
        let s = m.migrate().await.unwrap();
        assert_eq!(s, MigrationStatus::NoLegacy);
        assert!(m.branches_path().is_dir());
        assert!(m.sync_state_path().is_dir());
    }

    #[tokio::test]
    async fn test_migrate_legacy() {
        let (m, _d) = make();
        create_legacy(&m);
        let s = m.migrate().await.unwrap();
        assert!(matches!(s, MigrationStatus::Migrated { .. }));
        assert!(!m.has_legacy());
        assert!(m.has_archive());
        assert!(m.archive_path().join("manifest.json").exists());
        assert!(m.branches_path().is_dir());
    }

    #[tokio::test]
    async fn test_migrate_idempotent() {
        let (m, _d) = make();
        create_legacy(&m);
        let s1 = m.migrate().await.unwrap();
        let s2 = m.migrate().await.unwrap();
        assert!(matches!(s1, MigrationStatus::Migrated { .. }));
        assert!(matches!(s2, MigrationStatus::Migrated { .. }));
    }

    #[test]
    fn test_ensure_structure_idempotent() {
        let (m, _d) = make();
        m.ensure_sync_v2_structure().unwrap();
        m.ensure_sync_v2_structure().unwrap();
        assert!(m.branches_path().is_dir());
    }

    #[tokio::test]
    async fn test_cleanup_not_due() {
        let (m, _d) = make();
        create_legacy(&m);
        m.migrate().await.unwrap();
        assert!(!m.cleanup_if_due().await.unwrap());
        assert!(m.has_archive());
    }

    #[tokio::test]
    async fn test_cleanup_due() {
        let (m, _d) = make();
        let m = MigrationManager::new(m.vault_path.clone()).with_retention(-1);
        create_legacy(&m);
        m.migrate().await.unwrap();
        assert!(m.cleanup_if_due().await.unwrap());
        assert!(!m.has_archive());
        assert_eq!(m.status(), MigrationStatus::Cleaned);
    }

    #[tokio::test]
    async fn test_cleanup_never_migrated() {
        let (m, _d) = make();
        assert!(!m.cleanup_if_due().await.unwrap());
    }

    #[tokio::test]
    async fn test_archive_collision() {
        let (m, _d) = make();
        create_legacy(&m);
        fs::create_dir_all(m.archive_path()).unwrap();
        let r = m.migrate().await;
        assert!(r.is_err());
        assert!(!m.has_legacy()); // renamed to timestamped fallback
    }

    #[tokio::test]
    async fn test_marker_persists() {
        let (m, d) = make();
        create_legacy(&m);
        m.migrate().await.unwrap();
        let m2 = MigrationManager::new(d.path());
        assert!(matches!(m2.status(), MigrationStatus::Migrated { .. }));
    }
}
