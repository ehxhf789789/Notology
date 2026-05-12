//! Vault discovery: scan NAS root for directories containing `.notology/`.
//! Hybrid model: instant display from local cache + background refresh.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::core::sync_provider::SyncProvider;

/// Normalize a remote path for dedup: strip trailing slashes, collapse `//`.
/// Returns canonical form, e.g. "/Colony/Test" (no trailing slash, no double slash).
fn normalize_path(p: &str) -> String {
    let mut collapsed = String::with_capacity(p.len());
    for c in p.chars() {
        if c == '/' && collapsed.ends_with('/') {
            continue;
        }
        collapsed.push(c);
    }
    let trimmed = collapsed.trim_end_matches('/');
    if trimmed.is_empty() { "/".to_string() } else { trimmed.to_string() }
}

/// A discovered vault on the NAS.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredVault {
    /// Display name (directory name).
    pub name: String,
    /// Remote path on NAS (e.g., "/Colony/MyVault").
    pub remote_path: String,
    /// Last modified time from PROPFIND.
    pub modified_at: DateTime<Utc>,
    /// Whether `.notology/` was confirmed present.
    pub verified: bool,
}

/// Cache file for vault discovery results.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultDiscoveryCache {
    pub vaults: Vec<DiscoveredVault>,
    pub scanned_at: DateTime<Utc>,
    pub nas_url: String,
    pub scan_root: String,
}

const CACHE_FILE: &str = "vault-discovery-cache.json";

/// Load cached discovery results (instant display).
pub fn load_cache(config_dir: &Path) -> Option<VaultDiscoveryCache> {
    let path = config_dir.join(CACHE_FILE);
    let bytes = std::fs::read(&path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// Save discovery results to cache.
pub fn save_cache(config_dir: &Path, cache: &VaultDiscoveryCache) -> Result<(), String> {
    let path = config_dir.join(CACHE_FILE);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir: {}", e))?;
    }
    let bytes = serde_json::to_vec_pretty(cache).map_err(|e| format!("serialize: {}", e))?;
    std::fs::write(&path, bytes).map_err(|e| format!("write cache: {}", e))?;
    Ok(())
}

/// System/known-non-vault directory names to skip during recursion.
fn is_system_dir(name: &str) -> bool {
    matches!(name,
        "homes" | "photo" | "video" | "music" | "surveillance" |
        "system" | "tmp" | "lib" | "etc" | "web" | "public" |
        "Recycle" | "@eaDir"
    )
}

/// Scan NAS for vault directories with up to `max_depth` recursion.
/// At each level, any directory containing `.notology/` is recognized as a vault
/// (and recursion stops there). Otherwise recurse into the directory if depth < max_depth.
///
/// max_depth=2 covers the typical Synology layout: `/` → `/Colony` → `/Colony/MyVault`.
pub async fn scan(
    provider: &Arc<dyn SyncProvider>,
    scan_root: &str,
) -> Result<Vec<DiscoveredVault>, String> {
    scan_with_depth(provider, scan_root, 2).await
}

async fn scan_with_depth(
    provider: &Arc<dyn SyncProvider>,
    scan_root: &str,
    max_depth: usize,
) -> Result<Vec<DiscoveredVault>, String> {
    let root = normalize_path(scan_root);
    let mut vaults: Vec<DiscoveredVault> = Vec::new();
    // Dedup by normalized path. Tracks both visited dirs (to avoid re-listing)
    // and registered vaults (to avoid duplicate entries).
    let mut visited: HashSet<String> = HashSet::new();
    let mut registered: HashSet<String> = HashSet::new();
    let mut to_scan: Vec<(String, usize)> = vec![(root.clone(), 0)];
    let mut total_dirs_checked = 0;
    const MAX_DIRS: usize = 100; // safety cap

    while let Some((current, depth)) = to_scan.pop() {
        if total_dirs_checked >= MAX_DIRS {
            log::warn!("[vault_discovery] hit MAX_DIRS={} cap, stopping recursion", MAX_DIRS);
            break;
        }

        let current_norm = normalize_path(&current);
        if !visited.insert(current_norm.clone()) {
            // Already listed this directory — skip duplicate work.
            continue;
        }

        let children = match provider.list_children(&current_norm).await {
            Ok(c) => c,
            Err(e) => {
                log::warn!("[vault_discovery] list_children({}) failed: {}", current_norm, e);
                continue;
            }
        };

        let dirs: Vec<_> = children.into_iter()
            .filter(|c| c.is_collection)
            .filter(|c| !c.name.starts_with('.') && !c.name.starts_with('#') && !is_system_dir(&c.name))
            .collect();

        total_dirs_checked += dirs.len();

        for dir in dirs {
            // Always derive subpath from normalized parent + name, then normalize again.
            let subpath = if current_norm == "/" {
                format!("/{}", dir.name)
            } else {
                format!("{}/{}", current_norm, dir.name)
            };
            let subpath_norm = normalize_path(&subpath);

            // Skip if we've already registered this exact path as a vault,
            // or already visited it as a non-vault directory.
            if registered.contains(&subpath_norm) || visited.contains(&subpath_norm) {
                continue;
            }

            // Check if this dir is itself a vault (.notology inside).
            let sub_children = provider.list_children(&subpath_norm).await.unwrap_or_default();
            let has_notology = sub_children.iter()
                .any(|s| s.name == ".notology" && s.is_collection);

            if has_notology {
                // Mark visited too — vault dirs are not recursed further.
                visited.insert(subpath_norm.clone());
                if registered.insert(subpath_norm.clone()) {
                    vaults.push(DiscoveredVault {
                        name: dir.name.clone(),
                        remote_path: subpath_norm,
                        modified_at: dir.modified_at,
                        verified: true,
                    });
                }
            } else if depth < max_depth {
                to_scan.push((subpath_norm, depth + 1));
            }
        }
    }

    log::info!("[vault_discovery] recursive scan '{}' (max_depth={}): {} dirs checked, {} vaults found (deduped)",
        root, max_depth, total_dirs_checked, vaults.len());
    Ok(vaults)
}

/// Hybrid refresh: return cached immediately, then scan in background.
/// Calls `on_updated` callback when fresh results arrive.
pub async fn refresh_with_cache(
    config_dir: &Path,
    provider: &Arc<dyn SyncProvider>,
    nas_url: &str,
    scan_root: &str,
) -> Result<VaultDiscoveryCache, String> {
    // Always do a fresh scan (caller handles caching + emit)
    let vaults = scan(provider, scan_root).await?;
    let cache = VaultDiscoveryCache {
        vaults,
        scanned_at: Utc::now(),
        nas_url: nas_url.to_string(),
        scan_root: scan_root.to_string(),
    };
    save_cache(config_dir, &cache)?;
    Ok(cache)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_strips_trailing_slash() {
        assert_eq!(normalize_path("/Colony/Test/"), "/Colony/Test");
        assert_eq!(normalize_path("/Colony/Test"), "/Colony/Test");
    }

    #[test]
    fn normalize_collapses_double_slash() {
        assert_eq!(normalize_path("/Colony//Test"), "/Colony/Test");
        assert_eq!(normalize_path("//Colony/Test//"), "/Colony/Test");
    }

    #[test]
    fn normalize_preserves_root() {
        assert_eq!(normalize_path("/"), "/");
        assert_eq!(normalize_path("//"), "/");
        assert_eq!(normalize_path(""), "/");
    }

    #[test]
    fn normalize_idempotent() {
        let cases = ["/Colony/Test", "/", "/a/b/c", "/한글/테스트"];
        for c in &cases {
            assert_eq!(normalize_path(c), normalize_path(&normalize_path(c)));
        }
    }

    #[test]
    fn normalize_dedup_by_form() {
        // Different surface forms must collapse to same canonical form.
        let forms = ["/Colony/Test", "/Colony/Test/", "/Colony//Test", "/Colony/Test//"];
        let canonical = normalize_path("/Colony/Test");
        for f in &forms {
            assert_eq!(normalize_path(f), canonical, "form '{}' must canonicalize", f);
        }
    }
}
