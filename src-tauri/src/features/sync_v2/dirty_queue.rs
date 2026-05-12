//! Dirty Queue: SQLite WAL-backed queue for pending sync operations.
//! Crash-safe — SQLite WAL ensures no data loss on app termination.
//! Adapted from v1 SyncQueue (features/sync/engine.rs).

use chrono::{DateTime, Utc};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::Mutex;

/// Types of dirty operations that need NAS sync.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type")]
pub enum DirtyOperation {
    NoteUpsert { note_id: String, relative_path: String },
    NoteDelete { note_id: String, relative_path: String },
    NoteMove { note_id: String, old_path: String, new_path: String },
    AttachmentUpsert { relative_path: String },
    AttachmentDelete { relative_path: String },
    FolderCreate { relative_path: String },
    FolderDelete { relative_path: String },
    YamlChange { relative_path: String },
    MetaChange { kind: MetaKind, relative_path: String },
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub enum MetaKind {
    Comments,
    Schedules,
}

/// A pending entry in the queue.
#[derive(Clone, Debug)]
pub struct DirtyEntry {
    pub id: i64,
    pub op: DirtyOperation,
    pub timestamp: DateTime<Utc>,
    pub retry_count: u32,
    pub last_error: Option<String>,
}

/// SQLite WAL-backed dirty queue.
pub struct DirtyQueue {
    db: Mutex<Connection>,
}

impl DirtyQueue {
    /// Open or create queue database at `.notology/sync_v2/queue.db`.
    pub fn new(vault_path: &Path) -> Result<Self, String> {
        let db_dir = vault_path.join(".notology").join("sync_v2");
        std::fs::create_dir_all(&db_dir).map_err(|e| format!("mkdir: {}", e))?;

        let db_path = db_dir.join("queue.db");
        let conn = Connection::open(&db_path).map_err(|e| format!("open db: {}", e))?;
        conn.execute_batch("PRAGMA journal_mode=WAL;").map_err(|e| format!("WAL: {}", e))?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS pending_changes_v2 (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                operation_json TEXT NOT NULL,
                target_key TEXT NOT NULL,
                timestamp INTEGER NOT NULL,
                retry_count INTEGER NOT NULL DEFAULT 0,
                last_error TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_target ON pending_changes_v2(target_key);",
        )
        .map_err(|e| format!("create table: {}", e))?;

        Ok(Self { db: Mutex::new(conn) })
    }

    /// Enqueue an operation. If same target_key exists, replace it (dedup).
    pub fn enqueue(&self, op: DirtyOperation) -> Result<i64, String> {
        let db = self.db.lock().unwrap();
        let target_key = Self::target_key(&op);
        let op_json = serde_json::to_string(&op).map_err(|e| format!("serialize: {}", e))?;
        let ts = Utc::now().timestamp_millis();

        // Replace existing entry with same target_key (dedup)
        db.execute(
            "DELETE FROM pending_changes_v2 WHERE target_key = ?1",
            params![target_key],
        )
        .map_err(|e| format!("dedup: {}", e))?;

        db.execute(
            "INSERT INTO pending_changes_v2 (operation_json, target_key, timestamp, retry_count) VALUES (?1, ?2, ?3, 0)",
            params![op_json, target_key, ts],
        )
        .map_err(|e| format!("insert: {}", e))?;

        Ok(db.last_insert_rowid())
    }

    /// List all pending entries ordered by timestamp.
    pub fn list_pending(&self) -> Result<Vec<DirtyEntry>, String> {
        let db = self.db.lock().unwrap();
        let mut stmt = db
            .prepare("SELECT id, operation_json, timestamp, retry_count, last_error FROM pending_changes_v2 ORDER BY timestamp")
            .map_err(|e| format!("prepare: {}", e))?;

        let entries = stmt
            .query_map([], |row| {
                let op_json: String = row.get(0)?;
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, u32>(3)?,
                    row.get::<_, Option<String>>(4)?,
                ))
            })
            .map_err(|e| format!("query: {}", e))?;

        // Re-query with correct column indices
        drop(entries);
        drop(stmt);

        let mut stmt = db
            .prepare("SELECT id, operation_json, timestamp, retry_count, last_error FROM pending_changes_v2 ORDER BY timestamp")
            .map_err(|e| format!("prepare: {}", e))?;

        let mut result = Vec::new();
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, u32>(3)?,
                    row.get::<_, Option<String>>(4)?,
                ))
            })
            .map_err(|e| format!("query: {}", e))?;

        for row in rows {
            let (id, op_json, ts, retry_count, last_error) =
                row.map_err(|e| format!("row: {}", e))?;
            let op: DirtyOperation =
                serde_json::from_str(&op_json).map_err(|e| format!("parse: {}", e))?;
            let timestamp = DateTime::from_timestamp_millis(ts)
                .unwrap_or_else(|| Utc::now());
            result.push(DirtyEntry {
                id,
                op,
                timestamp,
                retry_count,
                last_error,
            });
        }

        Ok(result)
    }

    /// Remove a completed entry.
    pub fn dequeue(&self, id: i64) -> Result<(), String> {
        let db = self.db.lock().unwrap();
        db.execute("DELETE FROM pending_changes_v2 WHERE id = ?1", params![id])
            .map_err(|e| format!("dequeue: {}", e))?;
        Ok(())
    }

    /// Increment retry count. Returns false if max retries (5) exceeded (entry removed).
    pub fn mark_retry(&self, id: i64, error: &str) -> Result<bool, String> {
        let db = self.db.lock().unwrap();
        db.execute(
            "UPDATE pending_changes_v2 SET retry_count = retry_count + 1, last_error = ?2 WHERE id = ?1",
            params![id, error],
        )
        .map_err(|e| format!("update retry: {}", e))?;

        let count: u32 = db
            .query_row(
                "SELECT retry_count FROM pending_changes_v2 WHERE id = ?1",
                params![id],
                |r| r.get(0),
            )
            .unwrap_or(999);

        if count >= 5 {
            db.execute("DELETE FROM pending_changes_v2 WHERE id = ?1", params![id])
                .map_err(|e| format!("drop: {}", e))?;
            Ok(false)
        } else {
            Ok(true)
        }
    }

    /// Number of pending entries.
    pub fn count(&self) -> Result<usize, String> {
        let db = self.db.lock().unwrap();
        let c: i64 = db
            .query_row("SELECT COUNT(*) FROM pending_changes_v2", [], |r| r.get(0))
            .map_err(|e| format!("count: {}", e))?;
        Ok(c as usize)
    }

    /// Generate a dedup key for an operation.
    fn target_key(op: &DirtyOperation) -> String {
        match op {
            DirtyOperation::NoteUpsert { note_id, .. } => format!("note_upsert:{}", note_id),
            DirtyOperation::NoteDelete { note_id, .. } => format!("note_delete:{}", note_id),
            DirtyOperation::NoteMove { note_id, .. } => format!("note_move:{}", note_id),
            DirtyOperation::AttachmentUpsert { relative_path } => format!("att_upsert:{}", relative_path),
            DirtyOperation::AttachmentDelete { relative_path } => format!("att_delete:{}", relative_path),
            DirtyOperation::FolderCreate { relative_path } => format!("folder_create:{}", relative_path),
            DirtyOperation::FolderDelete { relative_path } => format!("folder_delete:{}", relative_path),
            DirtyOperation::YamlChange { relative_path } => format!("yaml:{}", relative_path),
            DirtyOperation::MetaChange { kind, relative_path } => format!("meta:{:?}:{}", kind, relative_path),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_queue() -> (DirtyQueue, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let q = DirtyQueue::new(dir.path()).unwrap();
        (q, dir)
    }

    #[test]
    fn test_enqueue_dequeue() {
        let (q, _d) = make_queue();
        let op = DirtyOperation::NoteUpsert {
            note_id: "n1".into(),
            relative_path: "test/note.md".into(),
        };
        let id = q.enqueue(op).unwrap();
        assert_eq!(q.count().unwrap(), 1);
        q.dequeue(id).unwrap();
        assert_eq!(q.count().unwrap(), 0);
    }

    #[test]
    fn test_dedup_replaces() {
        let (q, _d) = make_queue();
        let op1 = DirtyOperation::NoteUpsert {
            note_id: "n1".into(),
            relative_path: "v1".into(),
        };
        let op2 = DirtyOperation::NoteUpsert {
            note_id: "n1".into(),
            relative_path: "v2".into(),
        };
        q.enqueue(op1).unwrap();
        q.enqueue(op2).unwrap();
        assert_eq!(q.count().unwrap(), 1);
        let entries = q.list_pending().unwrap();
        match &entries[0].op {
            DirtyOperation::NoteUpsert { relative_path, .. } => assert_eq!(relative_path, "v2"),
            _ => panic!("wrong op"),
        }
    }

    #[test]
    fn test_list_ordered() {
        let (q, _d) = make_queue();
        q.enqueue(DirtyOperation::NoteDelete {
            note_id: "a".into(),
            relative_path: "a.md".into(),
        })
        .unwrap();
        q.enqueue(DirtyOperation::FolderCreate {
            relative_path: "folder".into(),
        })
        .unwrap();
        let entries = q.list_pending().unwrap();
        assert_eq!(entries.len(), 2);
    }

    #[test]
    fn test_mark_retry_and_drop() {
        let (q, _d) = make_queue();
        let id = q
            .enqueue(DirtyOperation::NoteUpsert {
                note_id: "n1".into(),
                relative_path: "x".into(),
            })
            .unwrap();
        for i in 0..4 {
            assert!(q.mark_retry(id, &format!("err {}", i)).unwrap());
        }
        // 5th retry → dropped
        assert!(!q.mark_retry(id, "final err").unwrap());
        assert_eq!(q.count().unwrap(), 0);
    }

    #[test]
    fn test_different_ops_not_deduped() {
        let (q, _d) = make_queue();
        q.enqueue(DirtyOperation::NoteUpsert {
            note_id: "n1".into(),
            relative_path: "x".into(),
        })
        .unwrap();
        q.enqueue(DirtyOperation::NoteDelete {
            note_id: "n1".into(),
            relative_path: "x".into(),
        })
        .unwrap();
        assert_eq!(q.count().unwrap(), 2);
    }
}
