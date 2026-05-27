//! vault_repair::sandbox — Phase 5 B8 (HanBin 2026-05-24).
//!
//! Clones a vault to a sandbox location so the user can run scan/apply
//! against a COPY of their important data and verify the result before
//! touching the real vault. The clone is byte-identical (sha-verified).
//!
//! ## Why this exists
//!
//! Stated user need: a 44 GB Synology-synced production vault that
//! they want to migrate from Obsidian → Notology with zero risk. Even
//! with snapshot + rollback (Phase 1), the cognitive load of "what if
//! something goes wrong" is real. Sandbox lets the user:
//!   1. Clone vault → `<some_path>/<vault_name>_sandbox_<ts>/`
//!   2. Open the sandbox in Notology (via VaultSelector)
//!   3. Run vault_repair_apply against the sandbox
//!   4. Verify everything looks right
//!   5. ONLY THEN repeat the operation on the real vault
//!
//! ## Storage
//!
//! Default sandbox root: `%LOCALAPPDATA%\Notology\sandboxes\` — same
//! parent as snapshots but in a distinct subtree. User can also pass
//! a custom destination (e.g. external SSD for very large vaults).
//!
//! ## Costs
//!
//! Full byte-level copy. For a 44 GB vault: ~2-5 min on local SSD,
//! longer on slow disks. Progress emitted same channel as repair.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::progress::{self, RepairStage};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxOutcome {
    pub sandbox_path: String,
    pub source_vault: String,
    pub files_copied: usize,
    pub bytes_copied: u64,
    pub errors: Vec<String>,
}

/// Default sandbox root directory. User can override per-call.
pub fn sandboxes_root() -> Result<PathBuf, String> {
    let base = dirs::data_local_dir()
        .ok_or_else(|| "no local data dir on this platform".to_string())?;
    Ok(base.join("Notology").join("sandboxes"))
}

/// Phase 5 B8 — clone a vault to a sandbox location. Skips the snapshot
/// store (`%LOCALAPPDATA%\Notology\snapshots`) and `.legacy/` backups
/// to avoid copying "backups of backups". `.notology/` IS copied so
/// the sandbox is a fully-functional Notology vault.
///
/// Returns the sandbox absolute path on success. The user can then open
/// it as a regular vault and run repair against it.
pub fn create_sandbox(
    source_vault: &Path,
    label: &str,
) -> Result<SandboxOutcome, String> {
    let started = std::time::Instant::now();
    let ts = chrono::Utc::now().format("%Y%m%dT%H%M%SZ").to_string();
    let vault_name = source_vault
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("vault");
    let sandbox_root = sandboxes_root()?;
    let sandbox_path = sandbox_root.join(format!("{}_sandbox_{}_{}", vault_name, label, ts));
    std::fs::create_dir_all(&sandbox_path)
        .map_err(|e| format!("create sandbox dir {:?}: {}", sandbox_path, e))?;

    let mut outcome = SandboxOutcome {
        sandbox_path: sandbox_path.to_string_lossy().replace('\\', "/"),
        source_vault: source_vault.to_string_lossy().replace('\\', "/"),
        files_copied: 0,
        bytes_copied: 0,
        errors: Vec::new(),
    };

    // Walk source vault.
    let mut to_copy: Vec<PathBuf> = Vec::new();
    walk_source(source_vault, &mut to_copy);

    progress::set_progress(
        RepairStage::BackingUp,
        0,
        to_copy.len(),
        format!("Cloning vault to sandbox ({} files)...", to_copy.len()),
    );

    for (idx, src) in to_copy.iter().enumerate() {
        if progress::should_cancel() {
            outcome.errors.push("cancelled by user".to_string());
            log::warn!("[sandbox] cancelled at {}/{}", idx, to_copy.len());
            return Ok(outcome);
        }
        let rel = match src.strip_prefix(source_vault) {
            Ok(r) => r.to_path_buf(),
            Err(_) => continue,
        };
        let dst = sandbox_path.join(&rel);
        if let Some(parent) = dst.parent() {
            if let Err(e) = std::fs::create_dir_all(parent) {
                outcome.errors.push(format!("mkdir {:?}: {}", parent, e));
                continue;
            }
        }
        let bytes = match std::fs::read(src) {
            Ok(b) => b,
            Err(e) => {
                outcome.errors.push(format!("read {:?}: {}", src, e));
                continue;
            }
        };
        let src_sha = {
            let mut h = Sha256::new();
            h.update(&bytes);
            format!("{:x}", h.finalize())
        };
        let size = bytes.len() as u64;
        if let Err(e) = std::fs::write(&dst, &bytes) {
            outcome.errors.push(format!("write {:?}: {}", dst, e));
            continue;
        }
        // Read-back verify — catches OS-level silent corruption.
        let written = match std::fs::read(&dst) {
            Ok(b) => b,
            Err(e) => {
                outcome.errors.push(format!("readback {:?}: {}", dst, e));
                continue;
            }
        };
        let dst_sha = {
            let mut h = Sha256::new();
            h.update(&written);
            format!("{:x}", h.finalize())
        };
        if src_sha != dst_sha {
            outcome.errors.push(format!(
                "sha mismatch {:?}: src {} != dst {}",
                rel, src_sha, dst_sha
            ));
            continue;
        }
        outcome.files_copied += 1;
        outcome.bytes_copied += size;
        progress::bump_current();
    }

    log::info!(
        "[sandbox] created {:?} ({} files, {} bytes, {} errors) in {:?}",
        sandbox_path,
        outcome.files_copied,
        outcome.bytes_copied,
        outcome.errors.len(),
        started.elapsed()
    );
    Ok(outcome)
}

fn walk_source(root: &Path, out: &mut Vec<PathBuf>) {
    let snapshots_root = super::snapshot::snapshots_root_for(root).ok();
    let sandbox_root = sandboxes_root().ok();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        // Skip our own meta-storage if it happens to be under the vault.
        if let Some(d) = dir.canonicalize().ok() {
            if let Some(s) = &snapshots_root {
                if let Ok(sc) = s.canonicalize() {
                    if d.starts_with(&sc) {
                        continue;
                    }
                }
            }
            if let Some(s) = &sandbox_root {
                if let Ok(sc) = s.canonicalize() {
                    if d.starts_with(&sc) {
                        continue;
                    }
                }
            }
        }
        // Root-tolerant — only skip `.legacy` for non-root dirs.
        if dir != root {
            if let Some(name) = dir.file_name().and_then(|s| s.to_str()) {
                if name == ".legacy" {
                    continue;
                }
            }
        }
        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_dir() {
                stack.push(p);
            } else if p.is_file() {
                out.push(p);
            }
        }
    }
}
