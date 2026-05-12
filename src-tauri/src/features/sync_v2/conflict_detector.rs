//! Transform ref_sync's RefConflict into UI-ready ConflictInfo.
//! Pure/sync — no I/O. BranchManager handles persistence.
//!
//! Track B Phase B-2 (2026-05-12): extended with attachment-conflict detection.
//! Same flavor as note conflicts (two heads, common ancestor) but on
//! `AttachmentRef.sha256` instead of note head hash. Resolution surface in B-3.

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

// ── Track B Phase B-2: attachment conflicts ────────────────────────────────

/// Raw observation: same attachment_id, different sha256 on local vs. remote.
/// Built by the pull loop when it spots a divergent ref.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AttachmentRefConflict {
    pub attachment_id: String,
    pub local_sha: String,
    pub remote_sha: String,
    pub local_etag: Option<String>,
    pub remote_etag: Option<String>,
    pub detected_at: DateTime<Utc>,
}

/// UI-facing attachment conflict — mirrors `ConflictInfo` for notes.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AttachmentConflictInfo {
    pub attachment_id: String,
    pub local_side: AttachmentSide,
    pub remote_side: AttachmentSide,
    pub detected_at: DateTime<Utc>,
    pub resolution_options: Vec<AttachmentResolution>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AttachmentSide {
    pub branch_id: String,
    pub sha256: String,
    pub source_device: String,
    pub etag: Option<String>,
}

/// How the user (or automation) wants the conflict resolved.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AttachmentResolution {
    UseLocal,
    UseRemote,
    /// Keep both — remote becomes a new attachment_id (next monotonic ms),
    /// local keeps the original. Preserves both blobs in CAS.
    KeepBoth,
}

impl ConflictDetector {
    /// Build a UI-ready attachment conflict from a raw observation.
    pub fn prepare_attachment(
        &self,
        conflict: AttachmentRefConflict,
        remote_device: &str,
    ) -> AttachmentConflictInfo {
        let ts = conflict.detected_at.timestamp_millis();
        AttachmentConflictInfo {
            attachment_id: conflict.attachment_id,
            local_side: AttachmentSide {
                branch_id: format!(
                    "att_{}_{}_{}",
                    ts,
                    sanitize(&self.device_id),
                    short_hash(&conflict.local_sha)
                ),
                sha256: conflict.local_sha,
                source_device: self.device_id.clone(),
                etag: conflict.local_etag,
            },
            remote_side: AttachmentSide {
                branch_id: format!(
                    "att_{}_{}_{}",
                    ts,
                    sanitize(remote_device),
                    short_hash(&conflict.remote_sha)
                ),
                sha256: conflict.remote_sha,
                source_device: remote_device.to_string(),
                etag: conflict.remote_etag,
            },
            detected_at: conflict.detected_at,
            resolution_options: vec![
                AttachmentResolution::UseLocal,
                AttachmentResolution::UseRemote,
                AttachmentResolution::KeepBoth,
            ],
        }
    }
}

/// Inspect a filename for the Synology Drive conflict suffix. Returns the
/// original filename if so (the suffix is stripped). Otherwise None.
///
/// Patterns covered (case-insensitive):
///   - "Report (SynologyDrive Conflict 2026-05-12-12-00-00).pdf"
///   - "Report (Synology Conflict 2026-05-12-12-00-00).pdf"
///   - "Report (Conflict 2026-05-12-12-00-00).pdf" (defensive)
pub fn detect_synology_conflict(filename: &str) -> Option<String> {
    let re = regex::Regex::new(
        r"(?i)^(?P<base>.+?)\s*\(\s*(?:Synology(?:Drive)?\s+)?Conflict[^)]*\)(?P<ext>\.[^.]+)?$",
    )
    .ok()?;
    let caps = re.captures(filename)?;
    let base = caps.name("base")?.as_str().trim_end().to_string();
    let ext = caps.name("ext").map(|m| m.as_str().to_string()).unwrap_or_default();
    Some(format!("{}{}", base, ext))
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

    // ── Track B Phase B-2 attachment conflict tests ──────────────────────

    fn mk_att(
        id: &str,
        local_sha: &str,
        remote_sha: &str,
    ) -> AttachmentRefConflict {
        AttachmentRefConflict {
            attachment_id: id.into(),
            local_sha: local_sha.into(),
            remote_sha: remote_sha.into(),
            local_etag: None,
            remote_etag: None,
            detected_at: Utc::now(),
        }
    }

    #[test]
    fn detects_attachment_conflict_with_resolution_options() {
        let d = ConflictDetector::new("DEV-A");
        let info = d.prepare_attachment(
            mk_att("20260512123456", "abc12345abcdef", "xyz98765xyzwww"),
            "DEV-B",
        );
        assert_eq!(info.attachment_id, "20260512123456");
        assert_eq!(info.local_side.source_device, "DEV-A");
        assert_eq!(info.remote_side.source_device, "DEV-B");
        assert!(info.local_side.branch_id.starts_with("att_"));
        assert!(info.local_side.branch_id.ends_with("_abc12345"));
        assert!(info.remote_side.branch_id.ends_with("_xyz98765"));
        assert_eq!(info.resolution_options.len(), 3);
        assert!(info.resolution_options.contains(&AttachmentResolution::KeepBoth));
    }

    #[test]
    fn detects_synology_conflict_filename() {
        assert_eq!(
            detect_synology_conflict("Report (SynologyDrive Conflict 2026-05-12-12-00-00).pdf"),
            Some("Report.pdf".to_string())
        );
        assert_eq!(
            detect_synology_conflict("data (Synology Conflict 2026-01-01-00-00-00).csv"),
            Some("data.csv".to_string())
        );
        assert_eq!(detect_synology_conflict("Report.pdf"), None);
        assert_eq!(detect_synology_conflict("Normal (1).pdf"), None);
    }

    #[test]
    fn resolution_options_correct() {
        let d = ConflictDetector::new("X");
        let info = d.prepare_attachment(mk_att("id", "shaA", "shaB"), "Y");
        assert_eq!(
            info.resolution_options,
            vec![
                AttachmentResolution::UseLocal,
                AttachmentResolution::UseRemote,
                AttachmentResolution::KeepBoth,
            ]
        );
    }
}
