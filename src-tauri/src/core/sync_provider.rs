//! SyncProvider trait — abstract interface for remote storage backends.
//!
//! The sync engine operates through this trait exclusively. WebDAV implements
//! it first; Google Drive, Dropbox, and local-folder backends can be added
//! in Stage 3 without modifying the sync engine.
//!
//! All methods use `SyncProviderError` for structured error handling.
//! Version-tracked operations (refs, sync_state) use `RefVersion` for
//! optimistic concurrency control (If-Match semantics).

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use serde::{Serialize, Deserialize};

/// Version identifier for remote resources (ETag, revision ID, etc.).
/// Used for conditional updates (optimistic concurrency).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RefVersion(pub String);

/// Metadata about a remote ref.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RefMetadata {
    pub note_id: String,
    pub version: RefVersion,
    pub modified_at: DateTime<Utc>,
}

/// Branch information for conflict resolution.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BranchInfo {
    pub head_hash: String,
    pub device_id: String,
    pub timestamp: DateTime<Utc>,
    pub content_preview: String,
}

/// Metadata about a device's sync state file (D8).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DeviceStateInfo {
    pub device_id: String,
    pub last_modified: DateTime<Utc>,
    pub size: u64,
}

/// Structured errors from sync provider operations.
#[derive(Debug, Clone)]
pub enum SyncProviderError {
    /// Resource does not exist on remote.
    NotFound,
    /// Conditional PUT failed: remote version changed since read.
    VersionConflict,
    /// Network-level failure (timeout, DNS, connection reset).
    NetworkError(String),
    /// Authentication failure (wrong credentials, expired token).
    AuthError(String),
    /// Remote storage quota exceeded.
    QuotaExceeded,
    /// Any other error.
    Other(String),
}

impl std::fmt::Display for SyncProviderError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotFound => write!(f, "not found"),
            Self::VersionConflict => write!(f, "version conflict"),
            Self::NetworkError(e) => write!(f, "network error: {}", e),
            Self::AuthError(e) => write!(f, "auth error: {}", e),
            Self::QuotaExceeded => write!(f, "storage quota exceeded"),
            Self::Other(e) => write!(f, "{}", e),
        }
    }
}

impl std::error::Error for SyncProviderError {}

/// Abstract sync backend trait.
///
/// All methods are async. Implementations must be Send + Sync for
/// use across Tokio tasks.
#[async_trait]
pub trait SyncProvider: Send + Sync {
    // === Object Operations (immutable, idempotent) ===

    /// Store a CAS object on remote. No-op if same hash already exists.
    async fn put_object(&self, hash: &str, data: &[u8]) -> Result<(), SyncProviderError>;

    /// Retrieve a CAS object by hash. Returns None if not found.
    async fn get_object(&self, hash: &str) -> Result<Option<Vec<u8>>, SyncProviderError>;

    /// Check if a CAS object exists on remote (cheaper than get_object).
    async fn has_object(&self, hash: &str) -> Result<bool, SyncProviderError>;

    /// List all object hashes on remote (for verification, full sync).
    async fn list_objects(&self) -> Result<Vec<String>, SyncProviderError>;

    // === Ref Operations (mutable, version-tracked) ===

    /// Store a ref. Returns new RefVersion for future conditional updates.
    async fn put_ref(&self, note_id: &str, content: &[u8]) -> Result<RefVersion, SyncProviderError>;

    /// Retrieve ref content + version. Returns None if not found.
    async fn get_ref(&self, note_id: &str) -> Result<Option<(Vec<u8>, RefVersion)>, SyncProviderError>;

    /// List all refs with metadata.
    async fn list_refs(&self) -> Result<Vec<RefMetadata>, SyncProviderError>;

    /// Delete a ref (note deletion).
    async fn delete_ref(&self, note_id: &str) -> Result<(), SyncProviderError>;

    // === DAG Operations (per-note version history) ===

    /// Store a DAG file on remote.
    async fn put_dag(&self, note_id: &str, content: &[u8]) -> Result<(), SyncProviderError>;

    /// Retrieve a DAG file. Returns None if not found.
    async fn get_dag(&self, note_id: &str) -> Result<Option<Vec<u8>>, SyncProviderError>;

    // === User-Visible .md Files ===

    /// Store .md file at relative vault path (for NAS file browsing).
    async fn put_md(&self, relative_path: &str, content: &[u8]) -> Result<(), SyncProviderError>;

    /// Check if .md file exists on remote.
    async fn has_md(&self, relative_path: &str) -> Result<bool, SyncProviderError>;

    /// Read .md file at relative vault path.
    async fn get_md(&self, relative_path: &str) -> Result<Option<Vec<u8>>, SyncProviderError>;

    /// Delete .md file (note rename or deletion).
    async fn delete_md(&self, relative_path: &str) -> Result<(), SyncProviderError>;

    /// List children of a vault-relative directory (e.g., ".notology/devices").
    /// Like put_md/get_md, the path is relative to the vault root (remote_base).
    async fn list_md_dir(&self, relative_dir: &str) -> Result<Vec<RemoteChild>, SyncProviderError>;

    // === Per-Device State (D8: replaces If-Match sync_state.json) ===
    // Synology Apache WebDAV rejects all If-Match headers on PUT.
    // Per-device files eliminate concurrency conflicts entirely.

    /// Write this device's state file (.notology/sync_state/{device_id}.json).
    /// Each device writes ONLY its own file — no concurrency conflict possible.
    async fn put_device_state(&self, device_id: &str, content: &[u8]) -> Result<(), SyncProviderError>;

    /// Read a specific device's state file.
    async fn get_device_state(&self, device_id: &str) -> Result<Option<Vec<u8>>, SyncProviderError>;

    /// List all device state files with metadata.
    async fn list_device_states(&self) -> Result<Vec<DeviceStateInfo>, SyncProviderError>;

    // === Branches (multi-device conflict visibility) ===

    /// Store a branch file.
    async fn put_branch(&self, note_id: &str, branch_name: &str, content: &[u8]) -> Result<(), SyncProviderError>;

    /// List all branch names for a note.
    async fn list_branches(&self, note_id: &str) -> Result<Vec<String>, SyncProviderError>;

    /// Get a specific branch's content.
    async fn get_branch(&self, note_id: &str, branch_name: &str) -> Result<Option<Vec<u8>>, SyncProviderError>;

    /// Delete a branch file.
    async fn delete_branch(&self, note_id: &str, branch_name: &str) -> Result<(), SyncProviderError>;

    /// List all note_ids that have at least one branch file.
    async fn list_notes_with_branches(&self) -> Result<Vec<String>, SyncProviderError>;

    // === Directory Listing ===

    /// List immediate children of a remote directory (PROPFIND depth=1).
    /// Returns (name, is_collection) pairs. Used for vault discovery.
    async fn list_children(&self, remote_dir: &str) -> Result<Vec<RemoteChild>, SyncProviderError>;

    // === Vault-level operations ===

    /// Rename/move a remote collection (and its contents) atomically.
    /// Path is absolute (e.g. "/Colony/OldName" → "/Colony/NewName").
    /// Used by vault rename — providers map this to WebDAV `MOVE` with
    /// Depth: infinity. `Overwrite: F` so accidental clobber returns an
    /// error instead of silently nuking the destination.
    async fn move_collection(&self, from_abs: &str, to_abs: &str) -> Result<(), SyncProviderError>;

    /// Recursively delete a remote collection.
    /// Path is absolute (e.g. "/Colony/OldVault"). Used by vault delete
    /// when the user opts in to wiping the NAS copy.
    async fn delete_collection(&self, abs_path: &str) -> Result<(), SyncProviderError>;

    // === Connection ===

    /// Test connection to remote. Used for diagnostics.
    async fn test_connection(&self) -> Result<bool, SyncProviderError>;
}

/// An entry returned by `list_children`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteChild {
    pub name: String,
    pub path: String,
    pub is_collection: bool,
    pub modified_at: DateTime<Utc>,
    pub size: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_ref_version_serialization() {
        let v = RefVersion("etag-123".to_string());
        let json = serde_json::to_string(&v).unwrap();
        let parsed: RefVersion = serde_json::from_str(&json).unwrap();
        assert_eq!(v, parsed);
    }

    #[test]
    fn test_branch_info_serialization() {
        let b = BranchInfo {
            head_hash: "abc123".into(),
            device_id: "DEV-1".into(),
            timestamp: Utc::now(),
            content_preview: "Hello world".into(),
        };
        let json = serde_json::to_string(&b).unwrap();
        let parsed: BranchInfo = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.head_hash, "abc123");
    }

    #[test]
    fn test_sync_provider_error_display() {
        assert_eq!(SyncProviderError::NotFound.to_string(), "not found");
        assert_eq!(SyncProviderError::VersionConflict.to_string(), "version conflict");
        assert!(SyncProviderError::NetworkError("timeout".into()).to_string().contains("timeout"));
    }
}
