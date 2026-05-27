//! Track B Phase B-1 skeleton — Attachment metadata schema.
//!
//! Compile-only. No business logic. Implementation lives in Phase B-2 (sync) and B-3 (UI).
//!
//! Storage model (confirmed 2026-05-12):
//!   - User-visible:   vault/.attachments/{display_name}
//!   - System refs:    vault/.notology/attachments/refs/{attachment_id}.json
//!   - CAS blobs:      vault/.notology/cas/blobs/{sha[0..2]}/{sha[2..4]}/{sha}
//!   - Link strategy:  hardlink (NTFS / ext4 / APFS), copy fallback on cross-volume / FAT32
//!
//! Reference style: wikilink `[[file.pdf]]` retained in note bodies; this struct holds
//! the out-of-band metadata that the wikilink resolves to via filename → attachment_id map.

#![allow(dead_code)]

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Per-attachment metadata. One JSON file per attachment under
/// `.notology/attachments/refs/{attachment_id}.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AttachmentRef {
    /// 17-digit timestamp (ms-precision UTC), e.g. "20260512123456789".
    /// Pre-Stage-4.5.3 stores wrote 14-digit (second-precision) ids; both
    /// formats parse via `attachment_store::parse_id_to_ms`.
    pub attachment_id: String,

    /// Original filename as shown to the user, e.g. "Report.pdf"
    pub original_name: String,

    /// MIME type derived from extension at import time
    pub mime_type: String,

    /// File size in bytes
    pub size_bytes: u64,

    /// Content-addressed hash of the binary
    pub sha256: String,

    /// Tier classification (drives UI rendering + viewer choice)
    pub tier: AttachmentTier,

    /// UTC timestamp of import
    pub created_at: DateTime<Utc>,

    /// Note IDs that wikilink to this attachment
    pub linked_notes: Vec<String>,

    /// Vault-relative display path, e.g. ".attachments/Report.pdf"
    pub display_path: String,

    /// WebDAV ETag from last successful push (None until first sync)
    pub sync_etag: Option<String>,

    /// Vault-relative remote path on NAS (None until first sync)
    pub remote_path: Option<String>,
}

/// The blob layer — physical binary stored once in CAS, referenced by N AttachmentRefs.
/// Located at `.notology/cas/blobs/{sha[0..2]}/{sha[2..4]}/{sha}`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AttachmentBlob {
    /// SHA-256 hex digest (lowercase, 64 chars)
    pub sha256: String,

    /// Absolute local path in CAS
    pub local_path: PathBuf,

    /// Vault-relative remote location on NAS
    pub remote_path: Option<String>,

    /// File size in bytes
    pub size_bytes: u64,
}

/// File-type tier. Drives:
///   - viewer choice (inline vs. external app)
///   - sync strategy (eager vs. lazy for large media)
///   - drag-out UX
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum AttachmentTier {
    /// png, jpg, jpeg, gif, webp, svg, bmp
    Image,
    /// pdf
    Pdf,
    /// hwpx, docx, pptx, xlsx (LibreOffice preview, external app for editing)
    Document,
    /// csv (inline table preview ≤1MB, external otherwise)
    Csv,
    /// mp4, mov, webm
    Video,
    /// mp3, wav, m4a
    Audio,
    /// Anything else (currently rejected; reserved for future)
    Other,
}

impl AttachmentTier {
    /// Map a lowercased extension (without dot) to a tier.
    /// Returns `Other` for unknown extensions; caller decides whether to accept.
    pub fn from_extension(ext: &str) -> Self {
        match ext {
            "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "bmp" | "ico" => Self::Image,
            "pdf" => Self::Pdf,
            // 2026-05-24 (HanBin) — stress test caught .hwp missing.
            // Legacy Hancom format very common in Korean vaults (HanBin's
            // own vault has 114 .hwp files). Without this, hwp files are
            // classified Other and rejected by P9/P4 detectors → silent
            // migration loss for Korean users. Also added .doc/.ppt/.xls
            // legacy MS Office (Notology document-viewer already handles).
            "hwp" | "hwpx" | "doc" | "docx" | "ppt" | "pptx" | "xls" | "xlsx" => Self::Document,
            "csv" | "tsv" => Self::Csv,
            "mp4" | "mov" | "webm" | "mkv" | "avi" => Self::Video,
            "mp3" | "wav" | "m4a" | "ogg" | "flac" => Self::Audio,
            _ => Self::Other,
        }
    }

    /// Whether this tier can be previewed inline (without spawning an external viewer)
    /// or via the existing hover-window viewers.
    pub fn supports_inline_preview(&self) -> bool {
        matches!(self, Self::Image | Self::Pdf | Self::Csv | Self::Video | Self::Audio)
    }

    /// Whether this tier requires an external application to open
    /// (no first-party inline editor — only the document preview viewer for view-only).
    pub fn supports_external_viewer_only(&self) -> bool {
        matches!(self, Self::Document)
    }

    /// MIME type for use in WebDAV PUT Content-Type and HTML drag-out data.
    pub fn mime_for_extension(ext: &str) -> &'static str {
        match ext {
            "png" => "image/png",
            "jpg" | "jpeg" => "image/jpeg",
            "gif" => "image/gif",
            "webp" => "image/webp",
            "svg" => "image/svg+xml",
            "bmp" => "image/bmp",
            "ico" => "image/x-icon",
            "pdf" => "application/pdf",
            "hwp" => "application/x-hwp",
            "hwpx" => "application/vnd.hancom.hwpx",
            "doc" => "application/msword",
            "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "ppt" => "application/vnd.ms-powerpoint",
            "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            "xls" => "application/vnd.ms-excel",
            "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "csv" | "tsv" => "text/csv",
            "mp4" => "video/mp4",
            "mov" => "video/quicktime",
            "webm" => "video/webm",
            "mkv" => "video/x-matroska",
            "avi" => "video/x-msvideo",
            "mp3" => "audio/mpeg",
            "wav" => "audio/wav",
            "m4a" => "audio/mp4",
            "ogg" => "audio/ogg",
            "flac" => "audio/flac",
            _ => "application/octet-stream",
        }
    }
}

/// Result of resolving a wikilink target (e.g. `[[Report.pdf]]`) against the attachment index.
/// Phase B-2 will implement the resolver; this struct fixes its shape.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResolvedAttachment {
    pub attachment_id: String,
    pub display_path: String,
    pub local_blob_path: PathBuf,
    pub tier: AttachmentTier,
    pub size_bytes: u64,
    pub mime_type: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tier_classification_covers_all_supported_extensions() {
        assert_eq!(AttachmentTier::from_extension("png"), AttachmentTier::Image);
        assert_eq!(AttachmentTier::from_extension("pdf"), AttachmentTier::Pdf);
        assert_eq!(AttachmentTier::from_extension("hwpx"), AttachmentTier::Document);
        assert_eq!(AttachmentTier::from_extension("csv"), AttachmentTier::Csv);
        assert_eq!(AttachmentTier::from_extension("mp4"), AttachmentTier::Video);
        assert_eq!(AttachmentTier::from_extension("mp3"), AttachmentTier::Audio);
        assert_eq!(AttachmentTier::from_extension("zip"), AttachmentTier::Other);
    }

    #[test]
    fn mime_table_matches_tier() {
        assert_eq!(AttachmentTier::mime_for_extension("pdf"), "application/pdf");
        assert_eq!(AttachmentTier::mime_for_extension("png"), "image/png");
        assert_eq!(AttachmentTier::mime_for_extension("unknown"), "application/octet-stream");
    }

    #[test]
    fn ref_round_trips_through_json() {
        let r = AttachmentRef {
            attachment_id: "20260512123456".into(),
            original_name: "Report.pdf".into(),
            mime_type: "application/pdf".into(),
            size_bytes: 1234,
            sha256: "abcd".repeat(16),
            tier: AttachmentTier::Pdf,
            created_at: Utc::now(),
            linked_notes: vec!["20260512111111".into()],
            display_path: ".attachments/Report.pdf".into(),
            sync_etag: None,
            remote_path: None,
        };
        let s = serde_json::to_string(&r).unwrap();
        let back: AttachmentRef = serde_json::from_str(&s).unwrap();
        assert_eq!(back.attachment_id, r.attachment_id);
        assert_eq!(back.tier, AttachmentTier::Pdf);
    }
}
