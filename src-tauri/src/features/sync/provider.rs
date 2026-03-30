//! Cloud Provider abstraction — v4.0 Extension Point
//! Currently only WebDAV is implemented. Future providers:
//! Google Drive, Dropbox, OneDrive, etc.

use async_trait::async_trait;

/// Metadata for a remote file
#[derive(Debug, Clone)]
pub struct RemoteFileMeta {
    pub path: String,
    pub is_collection: bool,
    pub modified_at: chrono::DateTime<chrono::Utc>,
    pub etag: Option<String>,
    pub size: Option<u64>,
}

/// Provider types
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub enum ProviderType {
    WebDav,
    // GoogleDrive,  // Future
    // Dropbox,      // Future
    // OneDrive,     // Future
}

/// Abstract cloud provider interface
#[async_trait]
pub trait CloudProvider: Send + Sync {
    /// Test connection
    async fn test_connection(&self) -> Result<bool, String>;

    /// List files in a directory
    async fn list_files(&self, path: &str) -> Result<Vec<RemoteFileMeta>, String>;

    /// Download a file
    async fn get_file(&self, path: &str) -> Result<Vec<u8>, String>;

    /// Upload a file
    async fn put_file(&self, path: &str, content: &[u8]) -> Result<(), String>;

    /// Delete a file
    async fn delete_file(&self, path: &str) -> Result<(), String>;

    /// Create a directory
    async fn mkdir(&self, path: &str) -> Result<(), String>;

    /// Get file metadata
    async fn get_metadata(&self, path: &str) -> Result<RemoteFileMeta, String>;

    /// Move/rename a file
    async fn move_file(&self, from: &str, to: &str) -> Result<(), String>;

    /// Get provider type
    fn provider_type(&self) -> ProviderType;
}
