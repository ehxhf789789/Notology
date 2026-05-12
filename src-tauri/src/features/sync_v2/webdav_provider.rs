//! WebDAV implementation of SyncProvider.
//!
//! Wraps the existing `WebDavClient` (HTTP layer) and adds Stage 4 path
//! construction, hash verification, and structured error handling.

use async_trait::async_trait;
use sha2::{Sha256, Digest};

use crate::core::sync_provider::*;
use crate::core::webdav::WebDavClient;

/// WebDAV-based SyncProvider. Maps trait methods to WebDAV PUT/GET/DELETE
/// operations on a Synology NAS (or any RFC 4918 server).
pub struct WebDavProvider {
    client: WebDavClient,
    remote_base: String,
}

impl WebDavProvider {
    /// Create a new WebDavProvider.
    /// `remote_base`: vault root on NAS, e.g., "/Colony/Test"
    pub fn new(client: WebDavClient, remote_base: String) -> Self {
        Self {
            client,
            remote_base: remote_base.trim_end_matches('/').to_string(),
        }
    }

    // === Path construction (private) ===

    fn object_path(&self, hash: &str) -> String {
        format!("{}/.notology/objects/{}/{}", self.remote_base, &hash[..2], &hash[2..])
    }

    fn ref_path(&self, note_id: &str) -> String {
        format!("{}/.notology/refs/{}.json", self.remote_base, note_id)
    }

    fn dag_path(&self, note_id: &str) -> String {
        format!("{}/.notology/version_dags/{}.json", self.remote_base, note_id)
    }

    fn md_path(&self, relative_path: &str) -> String {
        let normalized = relative_path.replace('\\', "/");
        format!("{}/{}", self.remote_base, normalized.trim_start_matches('/'))
    }

    fn device_state_path(&self, device_id: &str) -> String {
        format!("{}/.notology/sync_state/{}.json", self.remote_base, device_id)
    }

    fn device_states_dir(&self) -> String {
        format!("{}/.notology/sync_state", self.remote_base)
    }

    fn branch_path(&self, note_id: &str, branch_name: &str) -> String {
        format!("{}/.notology/branches/{}/{}.json", self.remote_base, note_id, branch_name)
    }

    fn branches_dir(&self, note_id: &str) -> String {
        format!("{}/.notology/branches/{}", self.remote_base, note_id)
    }

    /// Recursively create all parent directories for a path (top-down MKCOL).
    /// WebDAV MKCOL requires each parent to exist, so we build from shallowest to deepest.
    async fn ensure_parents(&self, path: &str) -> Result<(), SyncProviderError> {
        let parent = match path.trim_end_matches('/').rfind('/') {
            Some(0) => return Ok(()), // root
            Some(i) => &path[..i],
            None => return Ok(()),
        };
        self.ensure_directory(parent).await
    }

    /// Create a directory and all missing ancestors via top-down MKCOL.
    /// Verifies each level via PROPFIND to handle Synology's quirky 405 responses.
    async fn ensure_directory(&self, dir_path: &str) -> Result<(), SyncProviderError> {
        let normalized = dir_path.trim_end_matches('/');
        if normalized.is_empty() { return Ok(()); }

        let segments: Vec<&str> = normalized
            .trim_start_matches('/')
            .split('/')
            .collect();

        let mut current = String::new();
        for segment in &segments {
            current = format!("{}/{}", current, segment);

            // Check if exists first (avoids racy MKCOL on Synology)
            if self.client.list_files(&current).await.is_ok() {
                log::debug!("[ensure_directory] {} exists (PROPFIND ok)", current);
                continue;
            }

            // Try MKCOL
            log::info!("[ensure_directory] MKCOL {}", current);
            match self.client.mkdir(&current).await {
                Ok(_) => {
                    log::info!("[ensure_directory] {} created", current);
                }
                Err(e) => {
                    let msg = e.to_string();
                    if msg.contains("405") || msg.contains("301") || msg.contains("409") {
                        // Verify it actually exists now (Synology may return 405 spuriously)
                        if self.client.list_files(&current).await.is_ok() {
                            log::debug!("[ensure_directory] {} confirmed exists after {} response",
                                current, msg);
                            continue;
                        }
                        log::error!("[ensure_directory] {} mkdir returned {} but PROPFIND says missing!",
                            current, msg);
                        return Err(SyncProviderError::Other(
                            format!("MKCOL {} failed silently: {}", current, msg)
                        ));
                    }
                    log::error!("[ensure_directory] {} mkdir failed: {}", current, msg);
                    return Err(Self::map_error(msg));
                }
            }
        }
        Ok(())
    }

    fn map_error(e: String) -> SyncProviderError {
        if e.contains("404") || e.contains("not found") || e.contains("Not found") {
            SyncProviderError::NotFound
        } else if e.contains("412") || e.contains("precondition_failed") {
            SyncProviderError::VersionConflict
        } else if e.contains("401") || e.contains("403") || e.contains("인증") {
            SyncProviderError::AuthError(e)
        } else if e.contains("507") || e.contains("공간 부족") {
            SyncProviderError::QuotaExceeded
        } else if e.contains("timeout") || e.contains("Connection") || e.contains("connect") {
            SyncProviderError::NetworkError(e)
        } else {
            SyncProviderError::Other(e)
        }
    }

    fn is_not_found(e: &str) -> bool {
        e.contains("404") || e.contains("not found") || e.contains("Not found")
    }

    /// Normalize ETag for storage: strip outer quotes only, preserve W/ prefix.
    /// Synology returns `W/"8-64fd32f9ffd48"` — we store `W/8-64fd32f9ffd48`.
    /// When sending If-Match, `put_file_conditional` re-wraps in quotes,
    /// producing `"W/8-64fd32f9ffd48"`. However, Synology needs the weak
    /// prefix OUTSIDE quotes: `W/"8-..."`. So we store the raw inner value
    /// (without outer quotes) and handle the If-Match format ourselves.
    fn normalize_etag(raw: &str) -> String {
        // Server may return: W/"8-abc" or "8-abc" or 8-abc
        // We store the inner value only: 8-abc
        // Then reconstruct W/"8-abc" or "8-abc" for If-Match in the provider layer
        raw.trim()
            .trim_start_matches("W/")
            .trim_matches('"')
            .to_string()
    }

    /// Fetch ETag for a path via PROPFIND (fallback when PUT response lacks ETag).
    async fn fetch_etag(&self, path: &str) -> Result<RefVersion, SyncProviderError> {
        match self.client.get_metadata(path).await {
            Ok(meta) => Ok(RefVersion(
                Self::normalize_etag(&meta.etag.unwrap_or_default())
            )),
            Err(e) => Err(Self::map_error(e)),
        }
    }
}

fn compute_sha256(data: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    format!("{:x}", hasher.finalize())
}

#[async_trait]
impl SyncProvider for WebDavProvider {
    async fn put_object(&self, hash: &str, data: &[u8]) -> Result<(), SyncProviderError> {
        let path = self.object_path(hash);
        self.ensure_parents(&path).await?;
        self.client.put_file(&path, data).await
            .map(|_| ())
            .map_err(Self::map_error)
    }

    async fn get_object(&self, hash: &str) -> Result<Option<Vec<u8>>, SyncProviderError> {
        let path = self.object_path(hash);
        match self.client.get_file(&path).await {
            Ok(data) => {
                // Verify hash (R11 mitigation: detect partial/corrupted downloads)
                let actual = compute_sha256(&data);
                if actual != hash {
                    return Err(SyncProviderError::Other(format!(
                        "Hash mismatch for {}: expected {}, got {}", path, hash, actual
                    )));
                }
                Ok(Some(data))
            }
            Err(e) if Self::is_not_found(&e) => Ok(None),
            Err(e) => Err(Self::map_error(e)),
        }
    }

    async fn has_object(&self, hash: &str) -> Result<bool, SyncProviderError> {
        let path = self.object_path(hash);
        match self.client.get_metadata(&path).await {
            Ok(_) => Ok(true),
            Err(e) if Self::is_not_found(&e) => Ok(false),
            Err(e) => Err(Self::map_error(e)),
        }
    }

    async fn list_objects(&self) -> Result<Vec<String>, SyncProviderError> {
        let objects_dir = format!("{}/.notology/objects", self.remote_base);
        let shards = match self.client.list_files(&objects_dir).await {
            Ok(files) => files,
            Err(e) if Self::is_not_found(&e) => return Ok(vec![]),
            Err(e) => return Err(Self::map_error(e)),
        };

        let mut hashes = Vec::new();
        for shard in &shards {
            if !shard.is_collection { continue; }
            let shard_name = shard.path.trim_end_matches('/').rsplit('/').next().unwrap_or("");
            if shard_name.len() != 2 { continue; }

            match self.client.list_files(&shard.path).await {
                Ok(objects) => {
                    for obj in &objects {
                        if obj.is_collection { continue; }
                        let obj_name = obj.path.trim_end_matches('/').rsplit('/').next().unwrap_or("");
                        let full_hash = format!("{}{}", shard_name, obj_name);
                        if full_hash.len() == 64 {
                            hashes.push(full_hash);
                        }
                    }
                }
                Err(e) => log::warn!("[sync_v2] Failed to list shard {}: {}", shard_name, e),
            }
        }
        Ok(hashes)
    }

    async fn put_ref(&self, note_id: &str, content: &[u8]) -> Result<RefVersion, SyncProviderError> {
        let path = self.ref_path(note_id);
        self.ensure_parents(&path).await?;
        let etag = self.client.put_file(&path, content).await
            .map_err(Self::map_error)?;
        let normalized = Self::normalize_etag(&etag.unwrap_or_default());
        if normalized.is_empty() {
            // PUT response lacked ETag — fetch via PROPFIND
            self.fetch_etag(&path).await
        } else {
            Ok(RefVersion(normalized))
        }
    }

    async fn get_ref(&self, note_id: &str) -> Result<Option<(Vec<u8>, RefVersion)>, SyncProviderError> {
        let path = self.ref_path(note_id);
        match self.client.get_file(&path).await {
            Ok(data) => {
                let etag = self.client.get_metadata(&path).await
                    .ok()
                    .and_then(|m| m.etag)
                    .unwrap_or_default();
                Ok(Some((data, RefVersion(Self::normalize_etag(&etag)))))
            }
            Err(e) if Self::is_not_found(&e) => Ok(None),
            Err(e) => Err(Self::map_error(e)),
        }
    }

    async fn list_refs(&self) -> Result<Vec<RefMetadata>, SyncProviderError> {
        let refs_dir = format!("{}/.notology/refs", self.remote_base);
        let files = match self.client.list_files(&refs_dir).await {
            Ok(f) => f,
            Err(e) if Self::is_not_found(&e) => return Ok(vec![]),
            Err(e) => return Err(Self::map_error(e)),
        };

        Ok(files.iter()
            .filter(|f| !f.is_collection && f.path.ends_with(".json"))
            .map(|f| {
                let name = f.path.trim_end_matches('/').rsplit('/').next().unwrap_or("");
                let note_id = name.strip_suffix(".json").unwrap_or(name);
                RefMetadata {
                    note_id: note_id.to_string(),
                    version: RefVersion(f.etag.clone().unwrap_or_default()),
                    modified_at: f.modified_at,
                }
            })
            .collect())
    }

    async fn delete_ref(&self, note_id: &str) -> Result<(), SyncProviderError> {
        let path = self.ref_path(note_id);
        self.client.delete_file(&path).await.map_err(Self::map_error)
    }

    async fn put_dag(&self, note_id: &str, content: &[u8]) -> Result<(), SyncProviderError> {
        let path = self.dag_path(note_id);
        self.ensure_parents(&path).await?;
        self.client.put_file(&path, content).await
            .map(|_| ())
            .map_err(Self::map_error)
    }

    async fn get_dag(&self, note_id: &str) -> Result<Option<Vec<u8>>, SyncProviderError> {
        let path = self.dag_path(note_id);
        match self.client.get_file(&path).await {
            Ok(data) => Ok(Some(data)),
            Err(e) if Self::is_not_found(&e) => Ok(None),
            Err(e) => Err(Self::map_error(e)),
        }
    }

    async fn put_md(&self, relative_path: &str, content: &[u8]) -> Result<(), SyncProviderError> {
        let path = self.md_path(relative_path);
        self.ensure_parents(&path).await?;
        self.client.put_file(&path, content).await
            .map(|_| ())
            .map_err(Self::map_error)
    }

    async fn get_md(&self, relative_path: &str) -> Result<Option<Vec<u8>>, SyncProviderError> {
        let path = self.md_path(relative_path);
        match self.client.get_file(&path).await {
            Ok(data) => Ok(Some(data)),
            Err(e) if Self::is_not_found(&e) => Ok(None),
            Err(e) => Err(Self::map_error(e)),
        }
    }

    async fn has_md(&self, relative_path: &str) -> Result<bool, SyncProviderError> {
        let path = self.md_path(relative_path);
        match self.client.get_file(&path).await {
            Ok(_) => Ok(true),
            Err(e) if Self::is_not_found(&e) => Ok(false),
            Err(e) => Err(Self::map_error(e)),
        }
    }

    async fn delete_md(&self, relative_path: &str) -> Result<(), SyncProviderError> {
        let path = self.md_path(relative_path);
        self.client.delete_file(&path).await.map_err(Self::map_error)
    }

    async fn list_md_dir(&self, relative_dir: &str) -> Result<Vec<RemoteChild>, SyncProviderError> {
        let path = self.md_path(relative_dir);
        let files = match self.client.list_files(&path).await {
            Ok(f) => f,
            Err(e) if Self::is_not_found(&e) => return Ok(vec![]),
            Err(e) => return Err(Self::map_error(e)),
        };
        Ok(files.into_iter().map(|f| {
            let name = f.path.trim_end_matches('/').rsplit('/').next()
                .unwrap_or("").to_string();
            RemoteChild {
                name,
                path: f.path,
                is_collection: f.is_collection,
                modified_at: f.modified_at,
                size: f.size,
            }
        }).collect())
    }

    async fn put_device_state(&self, device_id: &str, content: &[u8]) -> Result<(), SyncProviderError> {
        let path = self.device_state_path(device_id);
        self.ensure_parents(&path).await?;
        self.client.put_file(&path, content).await
            .map(|_| ())
            .map_err(Self::map_error)
    }

    async fn get_device_state(&self, device_id: &str) -> Result<Option<Vec<u8>>, SyncProviderError> {
        let path = self.device_state_path(device_id);
        match self.client.get_file(&path).await {
            Ok(data) => Ok(Some(data)),
            Err(e) if Self::is_not_found(&e) => Ok(None),
            Err(e) => Err(Self::map_error(e)),
        }
    }

    async fn list_device_states(&self) -> Result<Vec<DeviceStateInfo>, SyncProviderError> {
        let dir = self.device_states_dir();
        let files = match self.client.list_files(&dir).await {
            Ok(f) => f,
            Err(_) => return Ok(vec![]),  // Directory missing or network error → empty (graceful)
        };
        Ok(files.iter()
            .filter(|f| !f.is_collection && f.path.ends_with(".json"))
            .map(|f| {
                let name = f.path.trim_end_matches('/').rsplit('/').next().unwrap_or("");
                let device_id = name.strip_suffix(".json").unwrap_or(name);
                DeviceStateInfo {
                    device_id: device_id.to_string(),
                    last_modified: f.modified_at,
                    size: f.size,
                }
            })
            .collect())
    }

    async fn put_branch(&self, note_id: &str, branch_name: &str, content: &[u8]) -> Result<(), SyncProviderError> {
        let path = self.branch_path(note_id, branch_name);
        self.ensure_parents(&path).await?;
        self.client.put_file(&path, content).await
            .map(|_| ())
            .map_err(Self::map_error)
    }

    async fn list_branches(&self, note_id: &str) -> Result<Vec<String>, SyncProviderError> {
        let dir = self.branches_dir(note_id);
        let files = match self.client.list_files(&dir).await {
            Ok(f) => f,
            Err(e) if Self::is_not_found(&e) => return Ok(vec![]),
            Err(e) => return Err(Self::map_error(e)),
        };
        Ok(files.iter()
            .filter(|f| !f.is_collection && f.path.ends_with(".json"))
            .map(|f| {
                let name = f.path.trim_end_matches('/').rsplit('/').next().unwrap_or("");
                name.strip_suffix(".json").unwrap_or(name).to_string()
            })
            .collect())
    }

    async fn get_branch(&self, note_id: &str, branch_name: &str) -> Result<Option<Vec<u8>>, SyncProviderError> {
        let path = self.branch_path(note_id, branch_name);
        match self.client.get_file(&path).await {
            Ok(data) => Ok(Some(data)),
            Err(e) if Self::is_not_found(&e) => Ok(None),
            Err(e) => Err(Self::map_error(e)),
        }
    }

    async fn delete_branch(&self, note_id: &str, branch_name: &str) -> Result<(), SyncProviderError> {
        let path = self.branch_path(note_id, branch_name);
        self.client.delete_file(&path).await.map_err(Self::map_error)
    }

    async fn list_notes_with_branches(&self) -> Result<Vec<String>, SyncProviderError> {
        let dir = format!("{}/.notology/branches", self.remote_base);
        let entries = match self.client.list_files(&dir).await {
            Ok(e) => e,
            Err(e) if Self::is_not_found(&e) => return Ok(vec![]),
            Err(e) => return Err(Self::map_error(e)),
        };
        Ok(entries.iter()
            .filter(|e| e.is_collection)
            .filter_map(|e| {
                let name = e.path.trim_end_matches('/').rsplit('/').next()?;
                if name == "branches" || name.is_empty() { return None; }
                Some(name.to_string())
            })
            .collect())
    }

    async fn list_children(&self, remote_dir: &str) -> Result<Vec<RemoteChild>, SyncProviderError> {
        let files = match self.client.list_files(remote_dir).await {
            Ok(f) => f,
            Err(e) if Self::is_not_found(&e) => return Ok(vec![]),
            Err(e) => return Err(Self::map_error(e)),
        };
        Ok(files.into_iter().map(|f| {
            let name = f.path.trim_end_matches('/').rsplit('/').next()
                .unwrap_or("").to_string();
            RemoteChild {
                name,
                path: f.path,
                is_collection: f.is_collection,
                modified_at: f.modified_at,
                size: f.size,
            }
        }).collect())
    }

    async fn test_connection(&self) -> Result<bool, SyncProviderError> {
        self.client.test_connection().await.map_err(Self::map_error)
    }

    async fn move_collection(&self, from_abs: &str, to_abs: &str) -> Result<(), SyncProviderError> {
        // The underlying client `move_resource` works for both files and
        // directories — Synology returns 201/204 either way. We pass the
        // absolute paths verbatim (no remote_base prefix here, since vault
        // rename operates ABOVE the vault root).
        self.client.move_resource(from_abs, to_abs).await.map_err(Self::map_error)
    }

    async fn delete_collection(&self, abs_path: &str) -> Result<(), SyncProviderError> {
        // WebDAV DELETE on a collection cascades to all descendants per
        // RFC 4918 §9.6.1. Synology supports this with one request.
        self.client.delete_file(abs_path).await.map_err(Self::map_error)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_object_path_sharded() {
        let client = WebDavClient::new("http://nas:5005/webdav", "u", "p").unwrap();
        let p = WebDavProvider::new(client, "/Colony/Test".into());
        assert_eq!(
            p.object_path("a1b2c3d4e5f6789012345678901234567890123456789012345678901234"),
            "/Colony/Test/.notology/objects/a1/b2c3d4e5f6789012345678901234567890123456789012345678901234"
        );
    }

    #[test]
    fn test_ref_path_construction() {
        let client = WebDavClient::new("http://nas:5005/webdav", "u", "p").unwrap();
        let p = WebDavProvider::new(client, "/Colony/Test".into());
        assert_eq!(p.ref_path("20260419103000"), "/Colony/Test/.notology/refs/20260419103000.json");
    }

    #[test]
    fn test_md_path_no_double_slash() {
        let client = WebDavClient::new("http://nas:5005/webdav", "u", "p").unwrap();
        let p = WebDavProvider::new(client, "/Colony/Test/".into()); // trailing slash
        assert_eq!(p.md_path("Test/note.md"), "/Colony/Test/Test/note.md");
        assert_eq!(p.md_path("/Test/note.md"), "/Colony/Test/Test/note.md");
    }

    #[test]
    fn test_dag_path() {
        let client = WebDavClient::new("http://nas:5005/webdav", "u", "p").unwrap();
        let p = WebDavProvider::new(client, "/Colony/Test".into());
        assert_eq!(p.dag_path("20260419103000"), "/Colony/Test/.notology/version_dags/20260419103000.json");
    }

    #[test]
    fn test_branch_path() {
        let client = WebDavClient::new("http://nas:5005/webdav", "u", "p").unwrap();
        let p = WebDavProvider::new(client, "/Colony/Test".into());
        assert_eq!(
            p.branch_path("20260419103000", "DEV-A-1234"),
            "/Colony/Test/.notology/branches/20260419103000/DEV-A-1234.json"
        );
    }
}
