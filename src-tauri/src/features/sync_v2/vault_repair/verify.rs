//! vault_repair::verify — post-apply consistency check. Runs after every
//! repair pass to confirm the new state matches the contracts the apply
//! step claimed to satisfy. If any invariant fails, `rollback` should be
//! invoked.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::features::sync_v2::attachment_store::AttachmentStore;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerificationFailure {
    pub kind: String,
    pub detail: String,
}

pub fn verify(vault_root: &Path) -> Result<Vec<VerificationFailure>, String> {
    let mut failures = Vec::new();
    let store = AttachmentStore::new(vault_root.to_path_buf())?;

    // ── I1: every AttachmentRef has linked_notes.len() == 1
    for r in store.all_refs() {
        if r.linked_notes.len() != 1 {
            failures.push(VerificationFailure {
                kind: "B-model invariant violated".to_string(),
                detail: format!(
                    "ref {} has {} linked notes (expected 1)",
                    r.attachment_id,
                    r.linked_notes.len()
                ),
            });
        }
    }

    // ── I2: every ref's CAS blob exists and sha matches
    for r in store.all_refs() {
        let blob = store.cas_path(&r.sha256);
        if !blob.is_file() {
            failures.push(VerificationFailure {
                kind: "missing blob".to_string(),
                detail: format!("ref {} sha {}", r.attachment_id, r.sha256),
            });
            continue;
        }
        let bytes = match std::fs::read(&blob) {
            Ok(b) => b,
            Err(e) => {
                failures.push(VerificationFailure {
                    kind: "blob read failed".to_string(),
                    detail: format!("{:?}: {}", blob, e),
                });
                continue;
            }
        };
        let actual = sha256_hex(&bytes);
        if actual != r.sha256 {
            failures.push(VerificationFailure {
                kind: "sha mismatch".to_string(),
                detail: format!(
                    "ref {} expected {} got {}",
                    r.attachment_id, r.sha256, actual
                ),
            });
        }
    }

    // ── I3: no `<note>_att/` legacy folders remain (P1 succeeded)
    if any_att_folder(vault_root) {
        failures.push(VerificationFailure {
            kind: "leftover _att/ folder".to_string(),
            detail: "P1 migration did not clean up all legacy folders".to_string(),
        });
    }

    Ok(failures)
}

fn any_att_folder(dir: &Path) -> bool {
    if let Some(n) = dir.file_name().and_then(|s| s.to_str()) {
        if n.starts_with('.') {
            return false;
        }
        if n.ends_with("_att") {
            return true;
        }
    }
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return false,
    };
    for entry in entries.flatten() {
        let p = entry.path();
        if p.is_dir() && any_att_folder(&p) {
            return true;
        }
    }
    false
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(bytes);
    format!("{:x}", h.finalize())
}
