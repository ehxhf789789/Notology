//! Manage conflict branches on remote (save, list, retrieve, resolve).
//! Per D10 (path), D11 (cleanup on resolve).

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use crate::core::sync_provider::SyncProvider;
use crate::features::sync_v2::conflict_detector::ConflictInfo;

pub const SCHEMA_VERSION: u32 = 1;

/// A persisted branch representing one divergent version.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Branch {
    pub branch_id: String,
    pub note_id: String,
    pub head_hash: String,
    pub source_device: String,
    pub created_at: DateTime<Utc>,
    pub schema_version: u32,
}

/// A note with unresolved branches.
#[derive(Debug, Clone, Serialize)]
pub struct NoteWithConflicts {
    pub note_id: String,
    pub branches: Vec<Branch>,
    pub earliest_detected: DateTime<Utc>,
}

/// Manages branch files on remote.
#[derive(Default)]
pub struct BranchManager;

impl BranchManager {
    pub fn new() -> Self { Self }

    /// Save a single branch.
    pub async fn save_branch(&self, provider: &dyn SyncProvider, branch: &Branch) -> Result<(), String> {
        let bytes = serde_json::to_vec_pretty(branch).map_err(|e| format!("Serialize branch: {}", e))?;
        provider.put_branch(&branch.note_id, &branch.branch_id, &bytes).await
            .map_err(|e| format!("Put branch: {}", e))
    }

    /// Save both sides of a conflict.
    pub async fn save_conflict(
        &self, provider: &dyn SyncProvider, info: &ConflictInfo,
    ) -> Result<Vec<Branch>, String> {
        let local = Branch {
            branch_id: info.local_side.branch_id.clone(),
            note_id: info.note_id.clone(),
            head_hash: info.local_side.head_hash.clone(),
            source_device: info.local_side.source_device.clone(),
            created_at: info.detected_at,
            schema_version: SCHEMA_VERSION,
        };
        let remote = Branch {
            branch_id: info.remote_side.branch_id.clone(),
            note_id: info.note_id.clone(),
            head_hash: info.remote_side.head_hash.clone(),
            source_device: info.remote_side.source_device.clone(),
            created_at: info.detected_at,
            schema_version: SCHEMA_VERSION,
        };
        self.save_branch(provider, &local).await?;
        self.save_branch(provider, &remote).await?;
        Ok(vec![local, remote])
    }

    /// List branches for one note (sorted by creation time).
    pub async fn list_branches_for_note(&self, provider: &dyn SyncProvider, note_id: &str) -> Result<Vec<Branch>, String> {
        let ids = provider.list_branches(note_id).await.map_err(|e| format!("list_branches: {}", e))?;
        let mut branches = Vec::new();
        for id in ids {
            match provider.get_branch(note_id, &id).await {
                Ok(Some(bytes)) => match serde_json::from_slice::<Branch>(&bytes) {
                    Ok(b) => branches.push(b),
                    Err(e) => log::warn!("[branch_mgr] parse {}/{}: {}", note_id, id, e),
                },
                Ok(None) => {},
                Err(e) => log::warn!("[branch_mgr] get {}/{}: {:?}", note_id, id, e),
            }
        }
        branches.sort_by_key(|b| b.created_at);
        Ok(branches)
    }

    /// Find all notes with unresolved branches.
    pub async fn list_all_conflicts(&self, provider: &dyn SyncProvider) -> Result<Vec<NoteWithConflicts>, String> {
        let note_ids = provider.list_notes_with_branches().await.map_err(|e| format!("list_notes: {}", e))?;
        let mut result = Vec::new();
        for note_id in note_ids {
            let branches = self.list_branches_for_note(provider, &note_id).await?;
            if branches.is_empty() { continue; }
            let earliest = branches.iter().map(|b| b.created_at).min().unwrap_or_else(Utc::now);
            result.push(NoteWithConflicts { note_id, branches, earliest_detected: earliest });
        }
        Ok(result)
    }

    /// Get a specific branch.
    pub async fn get_branch(&self, provider: &dyn SyncProvider, note_id: &str, branch_id: &str) -> Result<Option<Branch>, String> {
        match provider.get_branch(note_id, branch_id).await {
            Ok(Some(bytes)) => serde_json::from_slice(&bytes).map(Some).map_err(|e| format!("parse: {}", e)),
            Ok(None) => Ok(None),
            Err(e) => Err(format!("get_branch: {}", e)),
        }
    }

    /// Per D11: promote chosen branch, delete all siblings. Returns chosen Branch.
    pub async fn resolve(&self, provider: &dyn SyncProvider, note_id: &str, chosen_branch_id: &str) -> Result<Branch, String> {
        let chosen = self.get_branch(provider, note_id, chosen_branch_id).await?
            .ok_or_else(|| format!("Branch {}/{} not found", note_id, chosen_branch_id))?;
        let all_ids = provider.list_branches(note_id).await.map_err(|e| format!("list: {}", e))?;
        for id in &all_ids {
            if let Err(e) = provider.delete_branch(note_id, id).await {
                log::warn!("[branch_mgr] delete {}/{}: {:?}", note_id, id, e);
            }
        }
        Ok(chosen)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use crate::features::sync_v2::in_memory_provider::InMemorySyncProvider;
    use crate::features::sync_v2::conflict_detector::ConflictDetector;
    use crate::features::sync_v2::ref_sync::RefConflict;

    fn prov() -> Arc<InMemorySyncProvider> { Arc::new(InMemorySyncProvider::new()) }
    fn mk_branch(note: &str, id: &str, hash: &str, dev: &str) -> Branch {
        Branch { branch_id: id.into(), note_id: note.into(), head_hash: hash.into(),
            source_device: dev.into(), created_at: Utc::now(), schema_version: SCHEMA_VERSION }
    }

    #[tokio::test]
    async fn test_save_and_get() {
        let p = prov(); let m = BranchManager::new();
        let b = mk_branch("n1", "br_a", "ha", "DEV-A");
        m.save_branch(p.as_ref(), &b).await.unwrap();
        assert_eq!(m.get_branch(p.as_ref(), "n1", "br_a").await.unwrap(), Some(b));
    }

    #[tokio::test]
    async fn test_get_missing() {
        let p = prov();
        assert!(BranchManager::new().get_branch(p.as_ref(), "x", "y").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn test_list_empty() {
        let p = prov();
        assert!(BranchManager::new().list_branches_for_note(p.as_ref(), "n").await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn test_list_sorted() {
        let p = prov(); let m = BranchManager::new();
        let mut b1 = mk_branch("n1", "br1", "h1", "A");
        let mut b2 = mk_branch("n1", "br2", "h2", "B");
        b1.created_at = Utc::now() - chrono::Duration::seconds(10);
        m.save_branch(p.as_ref(), &b1).await.unwrap();
        m.save_branch(p.as_ref(), &b2).await.unwrap();
        let list = m.list_branches_for_note(p.as_ref(), "n1").await.unwrap();
        assert_eq!(list[0].branch_id, "br1");
        assert_eq!(list[1].branch_id, "br2");
    }

    #[tokio::test]
    async fn test_save_conflict_two() {
        let p = prov(); let d = ConflictDetector::new("A"); let m = BranchManager::new();
        let c = RefConflict { note_id: "n1".into(), local_head: "lh_12345678".into(),
            remote_head: "rh_abcdefgh".into(), common_ancestor: None, detected_at: Utc::now() };
        let info = d.prepare(c, "B");
        let saved = m.save_conflict(p.as_ref(), &info).await.unwrap();
        assert_eq!(saved.len(), 2);
        assert_eq!(m.list_branches_for_note(p.as_ref(), "n1").await.unwrap().len(), 2);
    }

    #[tokio::test]
    async fn test_list_all_empty() {
        let p = prov();
        assert!(BranchManager::new().list_all_conflicts(p.as_ref()).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn test_list_all_multiple() {
        let p = prov(); let m = BranchManager::new();
        m.save_branch(p.as_ref(), &mk_branch("n1", "a", "ha", "A")).await.unwrap();
        m.save_branch(p.as_ref(), &mk_branch("n1", "b", "hb", "B")).await.unwrap();
        m.save_branch(p.as_ref(), &mk_branch("n2", "c", "hc", "A")).await.unwrap();
        m.save_branch(p.as_ref(), &mk_branch("n2", "d", "hd", "B")).await.unwrap();
        let all = m.list_all_conflicts(p.as_ref()).await.unwrap();
        assert_eq!(all.len(), 2);
    }

    #[tokio::test]
    async fn test_resolve_deletes_all() {
        let p = prov(); let m = BranchManager::new();
        m.save_branch(p.as_ref(), &mk_branch("n1", "a", "ha", "A")).await.unwrap();
        m.save_branch(p.as_ref(), &mk_branch("n1", "b", "hb", "B")).await.unwrap();
        m.save_branch(p.as_ref(), &mk_branch("n1", "c", "hc", "C")).await.unwrap();
        let chosen = m.resolve(p.as_ref(), "n1", "b").await.unwrap();
        assert_eq!(chosen.head_hash, "hb");
        assert!(m.list_branches_for_note(p.as_ref(), "n1").await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn test_resolve_nonexistent_errors() {
        let p = prov(); let m = BranchManager::new();
        m.save_branch(p.as_ref(), &mk_branch("n1", "a", "ha", "A")).await.unwrap();
        assert!(m.resolve(p.as_ref(), "n1", "nope").await.is_err());
        assert_eq!(m.list_branches_for_note(p.as_ref(), "n1").await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn test_idempotent_save() {
        let p = prov(); let d = ConflictDetector::new("A"); let m = BranchManager::new();
        let c = RefConflict { note_id: "n".into(), local_head: "lh_12345678".into(),
            remote_head: "rh_abcdefgh".into(), common_ancestor: None, detected_at: Utc::now() };
        let info = d.prepare(c, "B");
        m.save_conflict(p.as_ref(), &info).await.unwrap();
        m.save_conflict(p.as_ref(), &info).await.unwrap();
        assert_eq!(m.list_branches_for_note(p.as_ref(), "n").await.unwrap().len(), 2);
    }

    #[tokio::test]
    async fn test_resolve_isolates_notes() {
        let p = prov(); let m = BranchManager::new();
        m.save_branch(p.as_ref(), &mk_branch("x", "xa", "hxa", "A")).await.unwrap();
        m.save_branch(p.as_ref(), &mk_branch("x", "xb", "hxb", "B")).await.unwrap();
        m.save_branch(p.as_ref(), &mk_branch("y", "ya", "hya", "A")).await.unwrap();
        m.save_branch(p.as_ref(), &mk_branch("y", "yb", "hyb", "B")).await.unwrap();
        m.resolve(p.as_ref(), "x", "xa").await.unwrap();
        assert!(m.list_branches_for_note(p.as_ref(), "x").await.unwrap().is_empty());
        assert_eq!(m.list_branches_for_note(p.as_ref(), "y").await.unwrap().len(), 2);
    }
}
