//! vault_repair::backup — snapshot files before mutation so any
//! verification failure can roll back to the original state.
//!
//! Layout: `.legacy/repair_<ISO_timestamp>/` containing
//!   • `manifest.json` — list of every backed-up file with original path
//!     and sha256, plus per-pattern action summary
//!   • Mirror of the affected files at their original vault-relative paths
//!
//! Created lazily on first write so dry-run scans don't leave traces.

use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// One file copied into the backup directory.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupEntry {
    pub rel_path: String,
    pub sha256: String,
    pub size_bytes: u64,
    pub kind: BackupKind,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum BackupKind {
    /// .md file body (may be sketch JSON or regular markdown)
    NoteBody,
    /// AttachmentRef JSON
    RefJson,
    /// Legacy attachment in `<note>_att/`
    LegacyAttachment,
    /// CAS blob (rare — only when sweep is risky)
    CasBlob,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RepairManifest {
    pub started_at: Option<DateTime<Utc>>,
    pub completed_at: Option<DateTime<Utc>>,
    pub vault_root: String,
    pub entries: Vec<BackupEntry>,
    /// Counts of operations applied per pattern, for audit trail.
    #[serde(default)]
    pub applied_counts: serde_json::Value,
    /// True iff verify() passed AFTER all apply steps.
    #[serde(default)]
    pub verified: bool,
}

pub struct BackupHandle {
    pub dir: PathBuf,
    pub vault_root: PathBuf,
    pub manifest: RepairManifest,
}

impl BackupHandle {
    pub fn create(vault_root: &Path) -> Result<Self, String> {
        let ts = Utc::now().format("%Y%m%dT%H%M%SZ").to_string();
        let dir = vault_root.join(".legacy").join(format!("repair_{}", ts));
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("create backup dir {:?}: {}", dir, e))?;
        let manifest = RepairManifest {
            started_at: Some(Utc::now()),
            vault_root: vault_root.to_string_lossy().replace('\\', "/"),
            ..Default::default()
        };
        let handle = Self {
            dir,
            vault_root: vault_root.to_path_buf(),
            manifest,
        };
        handle.persist_manifest()?;
        Ok(handle)
    }

    /// Copy a vault file into the backup tree (preserving its relative path)
    /// and record it in the manifest.
    pub fn snapshot(&mut self, abs_path: &Path, kind: BackupKind) -> Result<(), String> {
        let rel = abs_path
            .strip_prefix(&self.vault_root)
            .map_err(|_| format!("snapshot path {:?} not under vault root", abs_path))?
            .to_path_buf();
        let dst = self.dir.join(&rel);
        if let Some(parent) = dst.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("mkdir backup parent: {}", e))?;
        }
        let bytes = std::fs::read(abs_path)
            .map_err(|e| format!("read for backup {:?}: {}", abs_path, e))?;
        let sha = sha256_hex(&bytes);
        let size = bytes.len() as u64;
        std::fs::write(&dst, &bytes)
            .map_err(|e| format!("write backup {:?}: {}", dst, e))?;
        self.manifest.entries.push(BackupEntry {
            rel_path: rel.to_string_lossy().replace('\\', "/"),
            sha256: sha,
            size_bytes: size,
            kind,
        });
        Ok(())
    }

    pub fn persist_manifest(&self) -> Result<(), String> {
        let path = self.dir.join("manifest.json");
        let json = serde_json::to_vec_pretty(&self.manifest)
            .map_err(|e| format!("serialise manifest: {}", e))?;
        std::fs::write(&path, json).map_err(|e| format!("write manifest: {}", e))?;
        Ok(())
    }

    pub fn mark_verified(&mut self) -> Result<(), String> {
        self.manifest.verified = true;
        self.manifest.completed_at = Some(Utc::now());
        self.persist_manifest()
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(bytes);
    format!("{:x}", h.finalize())
}
