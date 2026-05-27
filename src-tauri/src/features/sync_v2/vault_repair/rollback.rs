//! vault_repair::rollback — restore the vault to its pre-apply state using
//! the BackupHandle manifest. Reverse-iterates the entries so directories
//! get re-created before files written into them. Best-effort: logs each
//! failure but continues, since partial restore is better than none.

use std::path::Path;

use super::backup::RepairManifest;

#[derive(Debug, Clone, Default)]
pub struct RollbackOutcome {
    pub restored: usize,
    pub failed: Vec<String>,
}

pub fn rollback(
    vault_root: &Path,
    backup_dir: &Path,
    manifest: &RepairManifest,
) -> RollbackOutcome {
    let mut outcome = RollbackOutcome::default();
    for entry in manifest.entries.iter().rev() {
        let src = backup_dir.join(&entry.rel_path);
        let dst = vault_root.join(&entry.rel_path);
        if let Some(parent) = dst.parent() {
            if let Err(e) = std::fs::create_dir_all(parent) {
                outcome.failed.push(format!("mkdir {:?}: {}", parent, e));
                continue;
            }
        }
        match std::fs::copy(&src, &dst) {
            Ok(_) => outcome.restored += 1,
            Err(e) => outcome.failed.push(format!("copy {:?} → {:?}: {}", src, dst, e)),
        }
    }
    outcome
}
