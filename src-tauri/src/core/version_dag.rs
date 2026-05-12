//! Per-note Version DAG for Notology version history.
//!
//! Each note has a directed acyclic graph of versions stored at
//! `{vault}/.notology/history/{note-id}.json`. Versions are append-only:
//! entries are never modified or removed once added.
//!
//! Each entry references a CAS object hash (opaque string at this layer)
//! and records its parent version(s), timestamp, and device identity.

use chrono::{DateTime, Utc};
use serde::{Serialize, Deserialize};
use std::fs;
use std::path::{Path, PathBuf};

use crate::core::file_io::atomic_write_file;

/// A single version entry in the DAG.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VersionEntry {
    /// SHA-256 hash of the full note content (frontmatter + body)
    pub content_hash: String,
    /// Parent version content_hash(es).
    /// - Empty Vec: initial version (root of DAG)
    /// - Single element: normal linear version
    /// - Multiple elements: merge commit (Stage 4)
    pub parents: Vec<String>,
    /// UTC timestamp when this version was created
    pub timestamp: DateTime<Utc>,
    /// Device identifier
    pub device_id: String,
    /// SHA-256 hashes of files in {note}_att/ at this version
    pub attachment_hashes: Vec<String>,
}

/// Per-note version DAG.
/// Stored at: `{vault}/.notology/history/{note-id}.json`
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct VersionDag {
    /// Ordered list of versions. Index 0 is oldest.
    /// The DAG structure is encoded via `parents`, but storage is a Vec.
    pub versions: Vec<VersionEntry>,
}

impl VersionDag {
    /// Load DAG for a note. Returns empty (default) DAG if file doesn't exist.
    /// Returns Err only on file read or JSON parse errors.
    pub fn load(vault_path: &Path, note_id: &str) -> Result<Self, String> {
        let path = Self::dag_path(vault_path, note_id);
        if !path.is_file() {
            return Ok(Self::default());
        }
        let content = fs::read_to_string(&path)
            .map_err(|e| format!("VersionDag::load: failed to read file {:?}: {}", path, e))?;
        serde_json::from_str(&content)
            .map_err(|e| format!("VersionDag::load: failed to parse JSON from {:?}: {}", path, e))
    }

    /// Save DAG to disk (atomic write).
    pub fn save(&self, vault_path: &Path, note_id: &str) -> Result<(), String> {
        let path = Self::dag_path(vault_path, note_id);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("VersionDag::save: failed to create history directory {:?}: {}", parent, e))?;
        }
        let bytes = serde_json::to_vec_pretty(self)
            .map_err(|e| format!("VersionDag::save: failed to serialize: {}", e))?;
        atomic_write_file(&path, &bytes)
    }

    /// Append a new version. Returns reference to the appended entry.
    /// `parent_hash` is the current HEAD's content_hash, or None for first version.
    pub fn append(
        &mut self,
        content_hash: String,
        parent_hash: Option<String>,
        device_id: String,
        attachment_hashes: Vec<String>,
    ) -> &VersionEntry {
        let entry = VersionEntry {
            content_hash,
            parents: match parent_hash {
                Some(h) => vec![h],
                None => vec![],
            },
            timestamp: Utc::now(),
            device_id,
            attachment_hashes,
        };
        self.versions.push(entry);
        // Safe: we just pushed
        self.versions.last().unwrap()
    }

    /// Get the latest version entry (last in versions Vec).
    pub fn latest(&self) -> Option<&VersionEntry> {
        self.versions.last()
    }

    /// Get a version by its content_hash. Returns None if not found.
    pub fn get(&self, content_hash: &str) -> Option<&VersionEntry> {
        self.versions.iter().find(|v| v.content_hash == content_hash)
    }

    /// Get full history as a slice (oldest first).
    pub fn history(&self) -> &[VersionEntry] {
        &self.versions
    }

    /// Lowest Common Ancestor of two version hashes in the DAG.
    ///
    /// Walks ancestors of `a` to build a set, then BFS-walks ancestors of
    /// `b` and returns the first one that appears in `a`'s set. The
    /// guarantee "first" is by BFS order — closer ancestors come first.
    /// Returns `None` when:
    ///   - either hash isn't in the DAG (caller should treat as no-LCA),
    ///   - the two histories share no ancestor (genuinely independent
    ///     branches, e.g. a vault that was rebuilt from scratch).
    ///
    /// Uses `parents` as the directed-edge encoding — multiple parents
    /// (merge commits) are walked correctly.
    pub fn find_lca(&self, a: &str, b: &str) -> Option<String> {
        if a == b {
            return Some(a.to_string());
        }
        if self.get(a).is_none() || self.get(b).is_none() {
            return None;
        }
        // Build the full ancestor set of `a` (including `a` itself, since
        // a node is its own ancestor for LCA purposes).
        let ancestors_of_a = self.collect_ancestors(a);
        // BFS from `b`: first hit in `ancestors_of_a` is the LCA.
        use std::collections::{HashSet, VecDeque};
        let mut visited: HashSet<String> = HashSet::new();
        let mut queue: VecDeque<String> = VecDeque::new();
        queue.push_back(b.to_string());
        visited.insert(b.to_string());
        while let Some(node) = queue.pop_front() {
            if ancestors_of_a.contains(&node) {
                return Some(node);
            }
            if let Some(entry) = self.get(&node) {
                for p in &entry.parents {
                    if visited.insert(p.clone()) {
                        queue.push_back(p.clone());
                    }
                }
            }
        }
        None
    }

    /// Collect every ancestor hash reachable from `start` (inclusive).
    fn collect_ancestors(&self, start: &str) -> std::collections::HashSet<String> {
        use std::collections::{HashSet, VecDeque};
        let mut seen: HashSet<String> = HashSet::new();
        let mut queue: VecDeque<String> = VecDeque::new();
        queue.push_back(start.to_string());
        seen.insert(start.to_string());
        while let Some(node) = queue.pop_front() {
            if let Some(entry) = self.get(&node) {
                for p in &entry.parents {
                    if seen.insert(p.clone()) {
                        queue.push_back(p.clone());
                    }
                }
            }
        }
        seen
    }

    /// Number of versions.
    pub fn len(&self) -> usize {
        self.versions.len()
    }

    /// Check if DAG is empty.
    pub fn is_empty(&self) -> bool {
        self.versions.is_empty()
    }

    /// File path for this DAG.
    pub fn dag_path(vault_path: &Path, note_id: &str) -> PathBuf {
        vault_path.join(".notology").join("history").join(format!("{}.json", note_id))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn make_temp_vault() -> TempDir {
        TempDir::new().expect("create temp dir")
    }

    #[test]
    fn test_empty_dag() {
        let dag = VersionDag::default();
        assert!(dag.is_empty());
        assert_eq!(dag.len(), 0);
        assert!(dag.latest().is_none());
    }

    #[test]
    fn test_append_single() {
        let mut dag = VersionDag::default();
        let entry = dag.append(
            "hash_a".to_string(),
            None,
            "DEVICE-1".to_string(),
            vec![],
        );
        assert_eq!(entry.content_hash, "hash_a");
        assert!(entry.parents.is_empty());
        assert_eq!(dag.len(), 1);
        assert_eq!(dag.latest().unwrap().content_hash, "hash_a");
    }

    #[test]
    fn test_append_chain() {
        let mut dag = VersionDag::default();
        dag.append("hash_a".into(), None, "D".into(), vec![]);
        dag.append("hash_b".into(), Some("hash_a".into()), "D".into(), vec![]);
        dag.append("hash_c".into(), Some("hash_b".into()), "D".into(), vec![]);

        assert_eq!(dag.len(), 3);
        assert_eq!(dag.history()[0].content_hash, "hash_a");
        assert!(dag.history()[0].parents.is_empty());
        assert_eq!(dag.history()[1].parents, vec!["hash_a"]);
        assert_eq!(dag.history()[2].parents, vec!["hash_b"]);
        assert_eq!(dag.latest().unwrap().content_hash, "hash_c");
    }

    #[test]
    fn test_latest() {
        let mut dag = VersionDag::default();
        assert!(dag.latest().is_none());
        dag.append("h1".into(), None, "D".into(), vec![]);
        dag.append("h2".into(), Some("h1".into()), "D".into(), vec![]);
        dag.append("h3".into(), Some("h2".into()), "D".into(), vec![]);
        assert_eq!(dag.latest().unwrap().content_hash, "h3");
    }

    #[test]
    fn test_get_by_hash() {
        let mut dag = VersionDag::default();
        dag.append("hash_a".into(), None, "D".into(), vec![]);
        dag.append("hash_b".into(), Some("hash_a".into()), "D".into(), vec![]);
        dag.append("hash_c".into(), Some("hash_b".into()), "D".into(), vec![]);

        assert_eq!(dag.get("hash_a").unwrap().content_hash, "hash_a");
        assert_eq!(dag.get("hash_b").unwrap().parents, vec!["hash_a"]);
        assert!(dag.get("nonexistent").is_none());
    }

    #[test]
    fn lca_self_returns_self() {
        let mut dag = VersionDag::default();
        dag.append("a".into(), None, "D".into(), vec![]);
        assert_eq!(dag.find_lca("a", "a"), Some("a".into()));
    }

    #[test]
    fn lca_linear_chain() {
        // a → b → c.  LCA(b, c) = b; LCA(a, c) = a.
        let mut dag = VersionDag::default();
        dag.append("a".into(), None, "D".into(), vec![]);
        dag.append("b".into(), Some("a".into()), "D".into(), vec![]);
        dag.append("c".into(), Some("b".into()), "D".into(), vec![]);
        assert_eq!(dag.find_lca("b", "c"), Some("b".into()));
        assert_eq!(dag.find_lca("a", "c"), Some("a".into()));
    }

    #[test]
    fn lca_diverged_branches() {
        // base — local
        //      \— remote
        // LCA(local, remote) = base.
        let mut dag = VersionDag::default();
        dag.append("base".into(), None, "D".into(), vec![]);
        dag.append("local".into(), Some("base".into()), "DA".into(), vec![]);
        dag.append("remote".into(), Some("base".into()), "DB".into(), vec![]);
        assert_eq!(dag.find_lca("local", "remote"), Some("base".into()));
        assert_eq!(dag.find_lca("remote", "local"), Some("base".into()));
    }

    #[test]
    fn lca_unrelated_returns_none() {
        // Two independent histories that never share an ancestor.
        let mut dag = VersionDag::default();
        dag.append("a1".into(), None, "DA".into(), vec![]);
        dag.append("a2".into(), Some("a1".into()), "DA".into(), vec![]);
        dag.append("b1".into(), None, "DB".into(), vec![]);
        dag.append("b2".into(), Some("b1".into()), "DB".into(), vec![]);
        assert_eq!(dag.find_lca("a2", "b2"), None);
    }

    #[test]
    fn lca_unknown_hash_returns_none() {
        let mut dag = VersionDag::default();
        dag.append("a".into(), None, "D".into(), vec![]);
        assert_eq!(dag.find_lca("a", "unknown"), None);
        assert_eq!(dag.find_lca("unknown", "a"), None);
    }

    #[test]
    fn test_save_and_load() {
        let tmp = make_temp_vault();
        let note_id = "20260419103000";

        let mut dag = VersionDag::default();
        // Use fixed timestamps for deterministic round-trip
        let ts1 = DateTime::parse_from_rfc3339("2026-04-19T10:30:00Z")
            .unwrap().with_timezone(&Utc);
        let ts2 = DateTime::parse_from_rfc3339("2026-04-19T11:00:00Z")
            .unwrap().with_timezone(&Utc);

        dag.versions.push(VersionEntry {
            content_hash: "hash_a".into(),
            parents: vec![],
            timestamp: ts1,
            device_id: "DESKTOP-1".into(),
            attachment_hashes: vec!["att_1".into()],
        });
        dag.versions.push(VersionEntry {
            content_hash: "hash_b".into(),
            parents: vec!["hash_a".into()],
            timestamp: ts2,
            device_id: "DESKTOP-1".into(),
            attachment_hashes: vec!["att_1".into()],
        });

        dag.save(tmp.path(), note_id).unwrap();

        let loaded = VersionDag::load(tmp.path(), note_id).unwrap();
        assert_eq!(loaded.len(), 2);
        assert_eq!(loaded.versions[0].content_hash, "hash_a");
        assert_eq!(loaded.versions[0].timestamp, ts1);
        assert_eq!(loaded.versions[1].content_hash, "hash_b");
        assert_eq!(loaded.versions[1].parents, vec!["hash_a"]);
        assert_eq!(loaded.versions[1].timestamp, ts2);
        assert_eq!(loaded.versions[1].device_id, "DESKTOP-1");
        assert_eq!(loaded.versions[1].attachment_hashes, vec!["att_1"]);
    }

    #[test]
    fn test_history_order() {
        let mut dag = VersionDag::default();
        dag.append("A".into(), None, "D".into(), vec![]);
        dag.append("B".into(), Some("A".into()), "D".into(), vec![]);
        dag.append("C".into(), Some("B".into()), "D".into(), vec![]);

        let h = dag.history();
        assert_eq!(h[0].content_hash, "A");
        assert_eq!(h[1].content_hash, "B");
        assert_eq!(h[2].content_hash, "C");
    }

    #[test]
    fn test_corrupted_json_recovery() {
        let tmp = make_temp_vault();
        let note_id = "20260419103000";
        let dag_path = VersionDag::dag_path(tmp.path(), note_id);
        fs::create_dir_all(dag_path.parent().unwrap()).unwrap();
        fs::write(&dag_path, b"{ this is not valid json").unwrap();

        let result = VersionDag::load(tmp.path(), note_id);
        assert!(result.is_err());
        let err_msg = result.unwrap_err();
        assert!(
            err_msg.contains("parse") || err_msg.contains("JSON") || err_msg.contains("expected"),
            "error should mention JSON issue, got: {}", err_msg
        );
    }

    #[test]
    fn test_many_versions() {
        let tmp = make_temp_vault();
        let note_id = "20260419120000";

        let mut dag = VersionDag::default();
        let mut parent: Option<String> = None;
        for i in 0..1000 {
            let hash = format!("hash_{:04}", i);
            dag.append(hash.clone(), parent, "DEVICE".into(), vec![]);
            parent = Some(hash);
        }
        assert_eq!(dag.len(), 1000);

        let save_start = std::time::Instant::now();
        dag.save(tmp.path(), note_id).unwrap();
        let save_time = save_start.elapsed();
        assert!(save_time.as_millis() < 500, "save took {}ms", save_time.as_millis());

        let load_start = std::time::Instant::now();
        let loaded = VersionDag::load(tmp.path(), note_id).unwrap();
        let load_time = load_start.elapsed();
        assert!(load_time.as_millis() < 500, "load took {}ms", load_time.as_millis());

        assert_eq!(loaded.len(), 1000);
        assert_eq!(loaded.versions[0].content_hash, "hash_0000");
        assert_eq!(loaded.versions[999].content_hash, "hash_0999");
    }
}
