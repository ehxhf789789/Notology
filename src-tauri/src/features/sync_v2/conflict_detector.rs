//! Transform ref_sync's RefConflict into UI-ready ConflictInfo.
//! Pure/sync — no I/O. BranchManager handles persistence.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use crate::features::sync_v2::ref_sync::RefConflict;

/// One side of a conflict.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ConflictSide {
    /// Per D10: `{timestamp_millis}_{device_id}_{head_hash[:8]}`
    pub branch_id: String,
    pub head_hash: String,
    pub source_device: String,
}

/// Enriched conflict ready for BranchManager to persist.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConflictInfo {
    pub note_id: String,
    pub local_side: ConflictSide,
    pub remote_side: ConflictSide,
    pub common_ancestor: Option<String>,
    pub detected_at: DateTime<Utc>,
}

/// Pure transform: assigns branch IDs to conflict sides.
pub struct ConflictDetector {
    device_id: String,
}

impl ConflictDetector {
    pub fn new(device_id: impl Into<String>) -> Self {
        Self { device_id: device_id.into() }
    }

    /// Generate ConflictInfo from a RefConflict.
    /// `remote_device`: device_id that pushed the remote_head.
    pub fn prepare(&self, conflict: RefConflict, remote_device: &str) -> ConflictInfo {
        let ts = conflict.detected_at.timestamp_millis();
        ConflictInfo {
            note_id: conflict.note_id,
            local_side: ConflictSide {
                branch_id: format!("{}_{}_{}",
                    ts, sanitize(&self.device_id), short_hash(&conflict.local_head)),
                head_hash: conflict.local_head,
                source_device: self.device_id.clone(),
            },
            remote_side: ConflictSide {
                branch_id: format!("{}_{}_{}",
                    ts, sanitize(remote_device), short_hash(&conflict.remote_head)),
                head_hash: conflict.remote_head,
                source_device: remote_device.to_string(),
            },
            common_ancestor: conflict.common_ancestor,
            detected_at: conflict.detected_at,
        }
    }

    /// Bulk prepare.
    pub fn prepare_all(&self, conflicts: Vec<RefConflict>, remote_device: &str) -> Vec<ConflictInfo> {
        conflicts.into_iter().map(|c| self.prepare(c, remote_device)).collect()
    }
}

fn short_hash(hash: &str) -> String { hash.chars().take(8).collect() }

fn sanitize(id: &str) -> String {
    id.chars().map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mk(note: &str, local: &str, remote: &str) -> RefConflict {
        RefConflict {
            note_id: note.into(), local_head: local.into(), remote_head: remote.into(),
            common_ancestor: None, detected_at: Utc::now(),
        }
    }

    #[test]
    fn test_prepare_both_sides() {
        let d = ConflictDetector::new("DEV-A");
        let info = d.prepare(mk("n1", "local_hash_abc", "remote_hash_xyz"), "DEV-B");
        assert_eq!(info.local_side.source_device, "DEV-A");
        assert_eq!(info.remote_side.source_device, "DEV-B");
        assert_eq!(info.local_side.head_hash, "local_hash_abc");
    }

    #[test]
    fn test_branch_id_format() {
        let d = ConflictDetector::new("labCore-2500");
        let info = d.prepare(mk("n", "aaaaaaaabbbb", "ccccccccdddd"), "labCore-4200");
        assert!(info.local_side.branch_id.contains("labCore-2500"));
        assert!(info.local_side.branch_id.ends_with("_aaaaaaaa"));
        assert!(info.remote_side.branch_id.contains("labCore-4200"));
        assert!(info.remote_side.branch_id.ends_with("_cccccccc"));
    }

    #[test]
    fn test_sanitize_bad_chars() {
        let d = ConflictDetector::new("dev/with:bad*chars");
        let info = d.prepare(mk("n", "h1_longlong", "h2_longlong"), "B");
        assert!(!info.local_side.branch_id.contains('/'));
        assert!(!info.local_side.branch_id.contains(':'));
    }

    #[test]
    fn test_preserves_ancestor() {
        let d = ConflictDetector::new("A");
        let mut c = mk("n", "l_hash_xx", "r_hash_yy");
        c.common_ancestor = Some("base_hash".into());
        assert_eq!(d.prepare(c, "B").common_ancestor, Some("base_hash".into()));
    }

    #[test]
    fn test_prepare_all() {
        let d = ConflictDetector::new("A");
        let infos = d.prepare_all(vec![mk("n1","l1_hh","r1_hh"), mk("n2","l2_hh","r2_hh")], "B");
        assert_eq!(infos.len(), 2);
    }

    #[test]
    fn test_deterministic() {
        let d = ConflictDetector::new("A");
        let c = mk("n", "local_hh", "remote_hh");
        let c2 = c.clone();
        assert_eq!(d.prepare(c, "B").local_side.branch_id, d.prepare(c2, "B").local_side.branch_id);
    }
}
