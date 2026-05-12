//! Ref synchronization between local and remote.
//!
//! Refs are mutable pointers (note_id → head_hash). RefSync detects
//! three cases per ref:
//!   1. Fast-forward push: local advanced, remote unchanged
//!   2. Fast-forward pull: remote advanced, local unchanged
//!   3. Diverged: both changed → conflict (no auto-merge per D4)
//!
//! Per D9: atomicity via GET-compare-PUT, not If-Match.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use chrono::{DateTime, Utc};
use serde::{Serialize, Deserialize};

use crate::core::cas::CasStore;
use crate::core::refs::{NoteRef, RefStore};
use crate::core::sync_provider::SyncProvider;
use crate::core::version_dag::VersionDag;
use crate::features::sync_v2::object_sync::ObjectSync;

pub use crate::features::sync_v2::object_sync::DEFAULT_CONCURRENCY;

/// Result of a ref sync operation.
#[derive(Debug, Clone)]
pub struct RefSyncResult {
    pub fast_forwarded_pushes: Vec<String>,
    pub fast_forwarded_pulls: Vec<String>,
    pub conflicts: Vec<RefConflict>,
    pub unchanged: usize,
    pub failed: Vec<(String, String)>,
    /// Refs that the detector flagged as NAS-deleted. The engine
    /// caller decides what to do with them based on the policy:
    ///   count < threshold → move to Trash + emit toast event
    ///   count ≥ threshold → stash in pending-confirm state, prompt UI
    pub nas_deletions: Vec<NasDeletionCandidate>,
}

impl RefSyncResult {
    pub fn is_complete_success(&self) -> bool { self.failed.is_empty() }
    pub fn has_conflicts(&self) -> bool { !self.conflicts.is_empty() }
}

/// A diverged ref needing user resolution.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RefConflict {
    pub note_id: String,
    pub local_head: String,
    pub remote_head: String,
    pub common_ancestor: Option<String>,
    pub detected_at: DateTime<Utc>,
}

/// Internal: per-ref sync decision.
#[derive(Debug, Clone)]
enum Action {
    NoOp,
    Push { head: String },
    Pull { head: String },
    Diverged { local_head: String, remote_head: String, ancestor: Option<String> },
    /// Local ref had been pushed before (sync_etag = Some) and is now
    /// missing on NAS → another device deleted it. Move local to Trash
    /// (or, when count ≥ 5, hold pending for user confirm).
    NasDeleted { local_path: String },
}

/// Threshold above which deletions are held pending user confirmation
/// instead of silently moved to Trash. See Track H bulk-confirm flow.
pub const NAS_DELETION_BULK_THRESHOLD: usize = 5;

/// One detected NAS-deletion candidate the UI / engine may act on.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NasDeletionCandidate {
    pub note_id: String,
    pub relative_path: String,
    pub head_hash: String,
    pub detected_at: DateTime<Utc>,
}

/// Synchronizes refs between local RefStore and a SyncProvider.
pub struct RefSync {
    vault_path: PathBuf,
    cas: Arc<CasStore>,
    ref_store: Arc<RefStore>,
    provider: Arc<dyn SyncProvider>,
    object_sync: ObjectSync,
    concurrency: usize,
}

impl RefSync {
    pub fn new(
        vault_path: &Path,
        cas: Arc<CasStore>,
        ref_store: Arc<RefStore>,
        provider: Arc<dyn SyncProvider>,
    ) -> Self {
        let object_sync = ObjectSync::new(cas.clone(), provider.clone())
            .with_concurrency(DEFAULT_CONCURRENCY);
        Self {
            vault_path: vault_path.to_path_buf(),
            cas,
            ref_store,
            provider,
            object_sync,
            concurrency: DEFAULT_CONCURRENCY,
        }
    }

    pub fn with_concurrency(mut self, n: usize) -> Self {
        self.concurrency = n.max(1);
        self
    }

    /// Sync all refs bidirectionally.
    pub async fn sync_all(&self) -> Result<RefSyncResult, String> {
        // Enumerate all note_ids from both sides
        let local_refs = self.ref_store.list()
            .map_err(|e| format!("list local refs: {}", e))?;
        let remote_metas = self.provider.list_refs().await
            .map_err(|e| format!("list remote refs: {}", e))?;

        let local_map: HashMap<String, NoteRef> = local_refs.into_iter()
            .map(|r| (r.note_id.clone(), r)).collect();
        let remote_ids: HashSet<String> = remote_metas.iter()
            .map(|m| m.note_id.clone()).collect();

        let all_ids: HashSet<String> = local_map.keys().cloned()
            .chain(remote_ids.iter().cloned()).collect();

        // Decide + execute for each ref
        let mut result = RefSyncResult {
            fast_forwarded_pushes: vec![],
            fast_forwarded_pulls: vec![],
            conflicts: vec![],
            unchanged: 0,
            failed: vec![],
            nas_deletions: vec![],
        };

        for note_id in &all_ids {
            let local = local_map.get(note_id);
            let has_remote = remote_ids.contains(note_id);

            let action = match self.decide(note_id, local, has_remote).await {
                Ok(a) => a,
                Err(e) => {
                    result.failed.push((note_id.clone(), e));
                    continue;
                }
            };

            // NasDeleted is a *report-only* action — sync_all does NOT
            // execute the trash move. The engine layer decides per the
            // bulk-confirm threshold whether to trash silently or stash
            // pending. This keeps ref_sync free of UI/event concerns.
            if let Action::NasDeleted { local_path } = &action {
                if let Some(l) = local {
                    result.nas_deletions.push(NasDeletionCandidate {
                        note_id: note_id.clone(),
                        relative_path: local_path.clone(),
                        head_hash: l.head_hash.clone(),
                        detected_at: Utc::now(),
                    });
                }
                continue;
            }

            match self.execute(note_id, &action).await {
                Ok(()) => match action {
                    Action::NoOp => result.unchanged += 1,
                    Action::Push { .. } => result.fast_forwarded_pushes.push(note_id.clone()),
                    Action::Pull { .. } => result.fast_forwarded_pulls.push(note_id.clone()),
                    Action::Diverged { local_head, remote_head, ancestor } => {
                        result.conflicts.push(RefConflict {
                            note_id: note_id.clone(),
                            local_head,
                            remote_head,
                            common_ancestor: ancestor,
                            detected_at: Utc::now(),
                        });
                    }
                    Action::NasDeleted { .. } => unreachable!("handled above"),
                },
                Err(e) => result.failed.push((note_id.clone(), e)),
            }
        }

        Ok(result)
    }

    /// Decide sync action for one ref.
    async fn decide(&self, note_id: &str, local: Option<&NoteRef>, has_remote: bool) -> Result<Action, String> {
        let remote_ref = if has_remote {
            self.fetch_remote_ref(note_id).await?
        } else {
            None
        };

        match (local, remote_ref) {
            (None, None) => Ok(Action::NoOp),
            (Some(l), None) => {
                // Three sub-cases:
                //
                //   sync_etag = None → never pushed → Push (engine will
                //                      persist a sync_etag after success).
                //
                //   sync_etag = Some + .md absent on NAS → genuine
                //                      NAS-deletion (both ref AND .md
                //                      removed). → MoveToTrash.
                //
                //   sync_etag = Some + .md present on NAS → partial state
                //                      (ref alone deleted — could be NAS
                //                      File Station mishap, manual ref
                //                      cleanup, etc.). The data is still
                //                      on NAS, so trashing local would
                //                      double the damage. Re-push our ref
                //                      to repair the index. Mirrors the
                //                      symmetric check in the (None, Some)
                //                      branch below.
                //
                // Network errors short-circuit to "treat as present" so a
                // flaky connection doesn't trigger mass trashing.
                if l.sync_etag.is_none() {
                    return Ok(Action::Push { head: l.head_hash.clone() });
                }
                let md_exists = self.provider
                    .has_md(&l.relative_path).await.unwrap_or(true);
                if md_exists {
                    log::info!(
                        "[ref_sync] ref {} missing on NAS but .md still present → re-pushing ref",
                        note_id
                    );
                    Ok(Action::Push { head: l.head_hash.clone() })
                } else {
                    Ok(Action::NasDeleted { local_path: l.relative_path.clone() })
                }
            }
            (None, Some(r)) => {
                // Before pulling: verify .md file actually exists on NAS.
                // If .md was deleted externally (NAS File Station, etc.), the ref is orphan → clean up.
                let md_exists = self.provider.has_md(&r.relative_path).await.unwrap_or(true);
                if md_exists {
                    Ok(Action::Pull { head: r.head_hash.clone() })
                } else {
                    log::info!("[ref_sync] remote ref {} exists but .md missing → cleaning orphan ref", note_id);
                    // Delete the orphan remote ref (best-effort)
                    let _ = self.provider.delete_ref(note_id).await;
                    Ok(Action::NoOp)
                }
            }
            (Some(l), Some(r)) => {
                if l.head_hash == r.head_hash {
                    Ok(Action::NoOp)
                } else {
                    self.classify(note_id, &l.head_hash, &r.head_hash).await
                }
            }
        }
    }

    /// Classify whether local/remote heads are fast-forward or diverged.
    async fn classify(&self, note_id: &str, local_head: &str, remote_head: &str) -> Result<Action, String> {
        // Load local DAG
        let local_dag = VersionDag::load(&self.vault_path, note_id)
            .map_err(|e| format!("load local DAG: {}", e))?;

        // Load remote DAG
        let remote_dag = self.fetch_remote_dag(note_id).await?;

        // Merge both DAGs' entries for complete ancestry picture
        let merged = merge_dag_entries(&local_dag, &remote_dag);

        let remote_is_ancestor_of_local = is_ancestor(&merged, remote_head, local_head);
        let local_is_ancestor_of_remote = is_ancestor(&merged, local_head, remote_head);

        Ok(match (remote_is_ancestor_of_local, local_is_ancestor_of_remote) {
            (true, false) => Action::Push { head: local_head.to_string() },
            (false, true) => Action::Pull { head: remote_head.to_string() },
            (true, true) => Action::NoOp, // same hash but caught earlier
            (false, false) => Action::Diverged {
                local_head: local_head.to_string(),
                remote_head: remote_head.to_string(),
                ancestor: find_common_ancestor(&merged, local_head, remote_head),
            },
        })
    }

    /// Execute a sync action.
    async fn execute(&self, note_id: &str, action: &Action) -> Result<(), String> {
        match action {
            Action::NoOp | Action::Diverged { .. } | Action::NasDeleted { .. } => Ok(()),
            Action::Push { head } => self.execute_push(note_id, head).await,
            Action::Pull { head } => self.execute_pull(note_id, head).await,
        }
    }

    /// Push: objects → DAG → .md → ref (ref is commit point).
    async fn execute_push(&self, note_id: &str, _head: &str) -> Result<(), String> {
        let local_ref = self.ref_store.get(note_id)
            .map_err(|e| format!("read local ref: {}", e))?
            .ok_or_else(|| format!("local ref {} gone", note_id))?;

        // 1. Push head object
        if let Ok(Some(content)) = self.cas.read_object(&local_ref.head_hash) {
            let _ = self.object_sync.push_objects(vec![local_ref.head_hash.clone()]).await;
            // Also push the .md file
            let _ = self.provider.put_md(&local_ref.relative_path, &content).await;
        }

        // 2. Push DAG
        let dag = VersionDag::load(&self.vault_path, note_id)
            .map_err(|e| format!("load DAG for push: {}", e))?;
        let dag_bytes = serde_json::to_vec_pretty(&dag)
            .map_err(|e| format!("serialize DAG: {}", e))?;
        self.provider.put_dag(note_id, &dag_bytes).await
            .map_err(|e| format!("put DAG: {}", e))?;

        // 3. D9 re-check: remote hasn't moved since our decide()
        if let Some(remote_ref) = self.fetch_remote_ref(note_id).await? {
            let merged_dag = {
                let remote_dag = self.fetch_remote_dag(note_id).await
                    .unwrap_or_default();
                merge_dag_entries(&dag, &remote_dag)
            };
            if !is_ancestor(&merged_dag, &remote_ref.head_hash, &local_ref.head_hash) {
                return Err("Remote ref changed during push — retry next cycle".into());
            }
        }

        // 4. PUT ref (commit point, last). Capture version → sync_etag.
        let ref_bytes = serde_json::to_vec_pretty(&local_ref)
            .map_err(|e| format!("serialize ref: {}", e))?;
        let version = self.provider.put_ref(note_id, &ref_bytes).await
            .map_err(|e| format!("put ref: {}", e))?;

        // 5. Record sync_etag locally (Track H prereq).
        let mut local_ref = local_ref.clone();
        local_ref.sync_etag = Some(version.0);
        if let Err(e) = self.ref_store.set(&local_ref) {
            log::warn!("[ref_sync] persist sync_etag failed (non-fatal) for {}: {}", note_id, e);
        }

        log::info!("[ref_sync] Pushed ref {}: {}", note_id, local_ref.head_hash);
        Ok(())
    }

    /// Pull: objects → DAG → ref (update local).
    async fn execute_pull(&self, note_id: &str, _head: &str) -> Result<(), String> {
        let remote_ref = self.fetch_remote_ref(note_id).await?
            .ok_or_else(|| format!("remote ref {} gone", note_id))?;

        // 1. Pull head object
        let _ = self.object_sync.pull_objects(vec![remote_ref.head_hash.clone()]).await;

        // 2. Pull + merge DAG
        let remote_dag = self.fetch_remote_dag(note_id).await?;
        let mut local_dag = VersionDag::load(&self.vault_path, note_id)
            .unwrap_or_default();
        // Merge: add remote entries not in local
        for entry in &remote_dag.versions {
            if local_dag.get(&entry.content_hash).is_none() {
                local_dag.versions.push(entry.clone());
            }
        }
        local_dag.save(&self.vault_path, note_id)
            .map_err(|e| format!("save merged DAG: {}", e))?;

        // 3. Write .md from pulled content
        if let Ok(Some(content)) = self.cas.read_object(&remote_ref.head_hash) {
            let md_path = self.vault_path.join(&remote_ref.relative_path);
            if let Some(parent) = md_path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            let _ = crate::core::file_io::atomic_write_file(&md_path, &content);
        }

        // 4. Update local ref
        self.ref_store.set(&remote_ref)
            .map_err(|e| format!("set local ref: {}", e))?;

        log::info!("[ref_sync] Pulled ref {}: {}", note_id, remote_ref.head_hash);
        Ok(())
    }

    // === Helpers ===

    async fn fetch_remote_ref(&self, note_id: &str) -> Result<Option<NoteRef>, String> {
        match self.provider.get_ref(note_id).await {
            Ok(Some((bytes, ver))) => {
                let mut r: NoteRef = serde_json::from_slice(&bytes)
                    .map_err(|e| format!("parse remote ref: {}", e))?;
                // Stamp the version we read into sync_etag so a
                // subsequent pull-write captures the "we saw this on
                // NAS" marker (Track H prereq).
                r.sync_etag = Some(ver.0);
                Ok(Some(r))
            }
            Ok(None) => Ok(None),
            Err(e) => Err(format!("get remote ref: {}", e)),
        }
    }

    async fn fetch_remote_dag(&self, note_id: &str) -> Result<VersionDag, String> {
        match self.provider.get_dag(note_id).await {
            Ok(Some(bytes)) => serde_json::from_slice(&bytes)
                .map_err(|e| format!("parse remote DAG: {}", e)),
            Ok(None) => Ok(VersionDag::default()),
            Err(e) => Err(format!("get remote DAG: {}", e)),
        }
    }
}

// === DAG ancestry helpers (not in Library API, implemented here) ===

/// Build a hash→parents map from both DAGs for unified ancestry checks.
fn merge_dag_entries(a: &VersionDag, b: &VersionDag) -> HashMap<String, Vec<String>> {
    let mut map = HashMap::new();
    for entry in a.versions.iter().chain(b.versions.iter()) {
        map.entry(entry.content_hash.clone())
            .or_insert_with(|| entry.parents.clone());
    }
    map
}

/// Check if `ancestor` is an ancestor of `descendant` in the DAG.
/// BFS from descendant backwards through parents.
fn is_ancestor(dag: &HashMap<String, Vec<String>>, ancestor: &str, descendant: &str) -> bool {
    if ancestor == descendant { return true; }
    let mut visited = HashSet::new();
    let mut queue = vec![descendant.to_string()];
    while let Some(current) = queue.pop() {
        if current == ancestor { return true; }
        if !visited.insert(current.clone()) { continue; }
        if let Some(parents) = dag.get(&current) {
            queue.extend(parents.iter().cloned());
        }
    }
    false
}

/// Find common ancestor of two hashes via BFS from both directions.
fn find_common_ancestor(dag: &HashMap<String, Vec<String>>, a: &str, b: &str) -> Option<String> {
    let ancestors_of_a = collect_ancestors(dag, a);
    // BFS from b, first hit in ancestors_of_a is LCA
    let mut visited = HashSet::new();
    let mut queue = vec![b.to_string()];
    while let Some(current) = queue.pop() {
        if ancestors_of_a.contains(&current) { return Some(current); }
        if !visited.insert(current.clone()) { continue; }
        if let Some(parents) = dag.get(&current) {
            queue.extend(parents.iter().cloned());
        }
    }
    None
}

fn collect_ancestors(dag: &HashMap<String, Vec<String>>, start: &str) -> HashSet<String> {
    let mut ancestors = HashSet::new();
    let mut queue = vec![start.to_string()];
    while let Some(current) = queue.pop() {
        if !ancestors.insert(current.clone()) { continue; }
        if let Some(parents) = dag.get(&current) {
            queue.extend(parents.iter().cloned());
        }
    }
    ancestors
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::sync_v2::in_memory_provider::InMemorySyncProvider;
    use tempfile::TempDir;

    struct TestSetup {
        vault: PathBuf,
        cas: Arc<CasStore>,
        ref_store: Arc<RefStore>,
        provider: Arc<InMemorySyncProvider>,
        _dir: TempDir,
    }

    fn setup() -> TestSetup {
        let dir = TempDir::new().unwrap();
        let vault = dir.path().to_path_buf();
        let cas = Arc::new(CasStore::new(&vault).unwrap());
        let ref_store = Arc::new(RefStore::new(&vault).unwrap());
        let provider = Arc::new(InMemorySyncProvider::new());
        TestSetup { vault, cas, ref_store, provider, _dir: dir }
    }

    /// Create a note with content, commit to CAS + DAG + Ref locally.
    fn commit_local(s: &TestSetup, note_id: &str, content: &[u8], parent: Option<&str>) -> String {
        let hash = s.cas.write_object(content).unwrap();
        let mut dag = VersionDag::load(&s.vault, note_id).unwrap_or_default();
        dag.append(hash.clone(), parent.map(|s| s.to_string()), "test-dev".into(), vec![]);
        dag.save(&s.vault, note_id).unwrap();
        s.ref_store.set(&NoteRef {
            note_id: note_id.into(),
            head_hash: hash.clone(),
            relative_path: format!("{}.md", note_id),
            updated_at: Utc::now(),
            sync_etag: None,
        }).unwrap();
        hash
    }

    /// Simulate a remote commit: put object + DAG + ref on provider.
    async fn commit_remote(s: &TestSetup, note_id: &str, content: &[u8], parent: Option<&str>) -> String {
        let hash = CasStore::hash(content);
        s.provider.put_object(&hash, content).await.unwrap();
        // Build DAG
        let existing_dag: VersionDag = match s.provider.get_dag(note_id).await.unwrap() {
            Some(b) => serde_json::from_slice(&b).unwrap_or_default(),
            None => VersionDag::default(),
        };
        let mut dag = existing_dag;
        dag.append(hash.clone(), parent.map(|s| s.to_string()), "remote-dev".into(), vec![]);
        let dag_bytes = serde_json::to_vec_pretty(&dag).unwrap();
        s.provider.put_dag(note_id, &dag_bytes).await.unwrap();
        // Ref
        let r = NoteRef {
            note_id: note_id.into(),
            head_hash: hash.clone(),
            relative_path: format!("{}.md", note_id),
            updated_at: Utc::now(),
            sync_etag: None,
        };
        let ref_bytes = serde_json::to_vec_pretty(&r).unwrap();
        s.provider.put_ref(note_id, &ref_bytes).await.unwrap();
        // Also put .md file (has_md check in decide requires this)
        s.provider.put_md(&r.relative_path, content).await.unwrap();
        hash
    }

    fn make_sync(s: &TestSetup) -> RefSync {
        RefSync::new(&s.vault, s.cas.clone(), s.ref_store.clone(), s.provider.clone())
    }

    #[tokio::test]
    async fn test_no_refs_anywhere() {
        let s = setup();
        let sync = make_sync(&s);
        let r = sync.sync_all().await.unwrap();
        assert_eq!(r.unchanged, 0);
        assert!(r.fast_forwarded_pushes.is_empty());
        assert!(r.fast_forwarded_pulls.is_empty());
        assert!(r.conflicts.is_empty());
    }

    #[tokio::test]
    async fn test_local_only_pushed() {
        let s = setup();
        let h = commit_local(&s, "note1", b"hello", None);
        let sync = make_sync(&s);
        let r = sync.sync_all().await.unwrap();
        assert_eq!(r.fast_forwarded_pushes, vec!["note1"]);
        // Verify on remote
        let remote = s.provider.get_ref("note1").await.unwrap();
        assert!(remote.is_some());
        // After push, local ref must carry a sync_etag (Track H prereq).
        let local = s.ref_store.get("note1").unwrap().unwrap();
        assert!(local.sync_etag.is_some(),
            "push must persist sync_etag from RefVersion");
    }

    #[tokio::test]
    async fn test_full_nas_deletion_both_ref_and_md_missing() {
        // 1. Local commits a note → pushed → sync_etag stamped + .md on NAS.
        let s = setup();
        let _h = commit_local(&s, "note1", b"hello", None);
        let sync = make_sync(&s);
        let r1 = sync.sync_all().await.unwrap();
        assert_eq!(r1.fast_forwarded_pushes, vec!["note1"]);

        // 2. Another device deletes BOTH the ref AND the .md (full
        //    note removal, the normal lifecycle case).
        s.provider.delete_ref("note1").await.unwrap();
        s.provider.delete_md("note1.md").await.unwrap();

        // 3. Detector classifies as NAS-deletion.
        let r2 = sync.sync_all().await.unwrap();
        assert_eq!(r2.nas_deletions.len(), 1);
        assert_eq!(r2.nas_deletions[0].note_id, "note1");
        assert!(r2.fast_forwarded_pushes.is_empty(),
            "must not re-push a NAS-deleted ref");
    }

    #[tokio::test]
    async fn test_partial_state_ref_alone_missing_md_kept_triggers_repush() {
        // Safety: if only the ref disappears but the .md is still on
        // NAS (NAS File Station mishap, manual ref cleanup during
        // testing, etc.), we must NOT trash local — data is intact on
        // NAS. The detector should classify this as a re-push instead.
        let s = setup();
        let _h = commit_local(&s, "note1", b"hello", None);
        let sync = make_sync(&s);
        let _ = sync.sync_all().await.unwrap();

        // Delete only the ref, leave .md alone.
        s.provider.delete_ref("note1").await.unwrap();
        assert!(
            s.provider.has_md("note1.md").await.unwrap(),
            "precondition: .md still present"
        );

        let r = sync.sync_all().await.unwrap();
        assert!(r.nas_deletions.is_empty(),
            "must NOT classify as deletion when .md still exists on NAS");
        assert_eq!(r.fast_forwarded_pushes, vec!["note1"],
            "must re-push the ref to repair the partial state");

        // After re-push, NAS has the ref back.
        assert!(s.provider.get_ref("note1").await.unwrap().is_some());
    }

    #[tokio::test]
    async fn test_fresh_local_without_etag_still_pushes() {
        // A brand-new local commit (sync_etag = None) must keep getting
        // pushed even though remote has no ref yet. This guards the
        // false-positive case: without the sync_etag check, every new
        // note would be mis-classified as a NAS-deletion.
        let s = setup();
        let _h = commit_local(&s, "note1", b"hello", None);
        let local = s.ref_store.get("note1").unwrap().unwrap();
        assert!(local.sync_etag.is_none(), "precondition: fresh ref has no etag");

        let sync = make_sync(&s);
        let r = sync.sync_all().await.unwrap();
        assert_eq!(r.fast_forwarded_pushes, vec!["note1"]);
        assert!(r.nas_deletions.is_empty());
    }

    #[tokio::test]
    async fn test_remote_only_pulled() {
        let s = setup();
        let h = commit_remote(&s, "note1", b"remote content", None).await;
        let sync = make_sync(&s);
        let r = sync.sync_all().await.unwrap();
        assert_eq!(r.fast_forwarded_pulls, vec!["note1"]);
        // Verify locally
        let local = s.ref_store.get("note1").unwrap().unwrap();
        assert_eq!(local.head_hash, h);
    }

    #[tokio::test]
    async fn test_same_ref_unchanged() {
        let s = setup();
        let h = commit_local(&s, "note1", b"same", None);
        commit_remote(&s, "note1", b"same", None).await; // same content → same hash
        let sync = make_sync(&s);
        let r = sync.sync_all().await.unwrap();
        assert_eq!(r.unchanged, 1);
    }

    #[tokio::test]
    async fn test_fast_forward_push() {
        let s = setup();
        // Base version on both sides
        let base = commit_local(&s, "note1", b"base", None);
        commit_remote(&s, "note1", b"base", None).await;
        // Local advances
        let _v2 = commit_local(&s, "note1", b"v2 local", Some(&base));
        let sync = make_sync(&s);
        let r = sync.sync_all().await.unwrap();
        assert_eq!(r.fast_forwarded_pushes, vec!["note1"]);
    }

    #[tokio::test]
    async fn test_fast_forward_pull() {
        let s = setup();
        let base = commit_local(&s, "note1", b"base", None);
        let base_r = commit_remote(&s, "note1", b"base", None).await;
        // Remote advances
        let v2 = commit_remote(&s, "note1", b"v2 remote", Some(&base_r)).await;
        let sync = make_sync(&s);
        let r = sync.sync_all().await.unwrap();
        assert_eq!(r.fast_forwarded_pulls, vec!["note1"]);
        let local = s.ref_store.get("note1").unwrap().unwrap();
        assert_eq!(local.head_hash, v2);
    }

    #[tokio::test]
    async fn test_divergence_detected() {
        let s = setup();
        let base = commit_local(&s, "note1", b"base", None);
        let base_r = commit_remote(&s, "note1", b"base", None).await;
        // Both advance independently
        commit_local(&s, "note1", b"local branch", Some(&base));
        commit_remote(&s, "note1", b"remote branch", Some(&base_r)).await;
        let sync = make_sync(&s);
        let r = sync.sync_all().await.unwrap();
        assert_eq!(r.conflicts.len(), 1);
        assert_eq!(r.conflicts[0].note_id, "note1");
        assert!(r.conflicts[0].common_ancestor.is_some());
    }

    #[tokio::test]
    async fn test_mixed_batch() {
        let s = setup();
        // note1: local only (push)
        commit_local(&s, "note1", b"local only", None);
        // note2: remote only (pull)
        commit_remote(&s, "note2", b"remote only", None).await;
        // note3: same on both (no-op)
        commit_local(&s, "note3", b"same", None);
        commit_remote(&s, "note3", b"same", None).await;
        let sync = make_sync(&s);
        let r = sync.sync_all().await.unwrap();
        assert_eq!(r.fast_forwarded_pushes.len(), 1);
        assert_eq!(r.fast_forwarded_pulls.len(), 1);
        assert_eq!(r.unchanged, 1);
    }

    #[tokio::test]
    async fn test_ancestry_helpers() {
        let mut dag = HashMap::new();
        dag.insert("C".into(), vec!["B".into()]);
        dag.insert("B".into(), vec!["A".into()]);
        dag.insert("A".into(), vec![]);
        assert!(is_ancestor(&dag, "A", "C"));
        assert!(is_ancestor(&dag, "B", "C"));
        assert!(!is_ancestor(&dag, "C", "A"));
        assert_eq!(find_common_ancestor(&dag, "B", "C"), Some("B".into()));
    }

    #[tokio::test]
    async fn test_objects_pushed_with_ref() {
        let s = setup();
        let h = commit_local(&s, "note1", b"push me", None);
        let sync = make_sync(&s);
        sync.sync_all().await.unwrap();
        // Object must exist on remote
        assert!(s.provider.has_object(&h).await.unwrap());
    }
}
