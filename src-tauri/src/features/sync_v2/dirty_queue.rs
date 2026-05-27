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

/// Sync lane — splits the queue so a large background upload (e.g. a 1 GB video)
/// doesn't block fast operations (note saves, small attachments) behind it.
/// Track B 2026-05-12: HanBin confirmed the two-tier model.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Lane {
    /// Default — notes, refs, small files (<100 MB). Handled by PushWorker.
    Fast,
    /// Large attachments (≥100 MB). Handled by BackgroundWorker with
    /// concurrency=1 and lower priority. Never blocks Fast lane.
    Slow,
}

impl Lane {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Fast => "fast",
            Self::Slow => "slow",
        }
    }
    pub fn parse(s: &str) -> Self {
        match s {
            "slow" => Self::Slow,
            _ => Self::Fast,
        }
    }
}

/// A pending entry in the queue.
#[derive(Clone, Debug)]
pub struct DirtyEntry {
    pub id: i64,
    pub op: DirtyOperation,
    pub timestamp: DateTime<Utc>,
    pub retry_count: u32,
    pub last_error: Option<String>,
    pub lane: Lane,
}

/// A permanently failed entry — dropped from the active queue after 5
/// retries. Kept in a separate table so the frontend can show "X uploads
/// failed; click to retry" UI and the user has a chance to fix
/// network/permission issues before the data is forgotten.
#[derive(Clone, Debug)]
pub struct FailedEntry {
    pub id: i64,
    pub op: DirtyOperation,
    pub queued_at: DateTime<Utc>,
    pub failed_at: DateTime<Utc>,
    pub last_error: String,
    pub lane: Lane,
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

        // Track B 2026-05-12: add `lane` column if not present. Idempotent
        // via PRAGMA inspection — ALTER TABLE ADD COLUMN errors on duplicate
        // so we check first. Default 'fast' preserves behavior for pre-Track-B
        // DBs in the field.
        let has_lane: bool = conn
            .prepare("SELECT 1 FROM pragma_table_info('pending_changes_v2') WHERE name='lane'")
            .and_then(|mut s| s.exists([]))
            .unwrap_or(false);
        if !has_lane {
            conn.execute_batch(
                "ALTER TABLE pending_changes_v2 ADD COLUMN lane TEXT NOT NULL DEFAULT 'fast';
                 CREATE INDEX IF NOT EXISTS idx_lane ON pending_changes_v2(lane);",
            )
            .map_err(|e| format!("add lane column: {}", e))?;
        }

        // Round 2 R5 v5 (HanBin 2026-05-23) — permanently-failed entries
        // table. Entries dropped after 5 retries are moved here instead of
        // being silently deleted, so the user has a chance to fix the
        // underlying problem (network, auth, file gone) and re-enqueue.
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS failed_changes_v2 (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                operation_json TEXT NOT NULL,
                target_key TEXT NOT NULL,
                queued_at INTEGER NOT NULL,
                failed_at INTEGER NOT NULL,
                last_error TEXT NOT NULL,
                lane TEXT NOT NULL DEFAULT 'fast'
            );
            CREATE INDEX IF NOT EXISTS idx_failed_target ON failed_changes_v2(target_key);",
        )
        .map_err(|e| format!("create failed table: {}", e))?;

        Ok(Self { db: Mutex::new(conn) })
    }

    /// Record a permanently-failed entry. Called from push_worker when an
    /// operation has exhausted its retry budget. The original queue entry
    /// is dropped by `mark_retry` itself; this just preserves the metadata
    /// for the failure-list UI.
    pub fn record_failed(
        &self,
        op: &DirtyOperation,
        queued_at_ms: i64,
        last_error: &str,
        lane: Lane,
    ) -> Result<i64, String> {
        let db = self.db.lock().unwrap();
        let target_key = Self::target_key(op);
        let op_json = serde_json::to_string(op).map_err(|e| format!("serialize failed: {}", e))?;
        let failed_at = Utc::now().timestamp_millis();
        db.execute(
            "INSERT INTO failed_changes_v2 (operation_json, target_key, queued_at, failed_at, last_error, lane) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![op_json, target_key, queued_at_ms, failed_at, last_error, lane.as_str()],
        )
        .map_err(|e| format!("insert failed: {}", e))?;
        Ok(db.last_insert_rowid())
    }

    /// List all permanently-failed entries. Frontend uses this to render
    /// the failure-list / "retry all" UI.
    pub fn list_failed(&self) -> Result<Vec<FailedEntry>, String> {
        let db = self.db.lock().unwrap();
        let mut stmt = db
            .prepare(
                "SELECT id, operation_json, queued_at, failed_at, last_error, lane FROM failed_changes_v2 ORDER BY failed_at",
            )
            .map_err(|e| format!("prepare failed: {}", e))?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                ))
            })
            .map_err(|e| format!("query failed: {}", e))?;
        let mut out = Vec::new();
        for r in rows.flatten() {
            let (id, op_json, queued_at_ms, failed_at_ms, last_error, lane_str) = r;
            let op: DirtyOperation = match serde_json::from_str(&op_json) {
                Ok(o) => o,
                Err(_) => continue,
            };
            out.push(FailedEntry {
                id,
                op,
                queued_at: DateTime::<Utc>::from_timestamp_millis(queued_at_ms).unwrap_or_else(Utc::now),
                failed_at: DateTime::<Utc>::from_timestamp_millis(failed_at_ms).unwrap_or_else(Utc::now),
                last_error,
                lane: Lane::parse(&lane_str),
            });
        }
        Ok(out)
    }

    /// Remove a failed entry (typically after the user re-enqueues it
    /// via `sync_v2_retry_failed`).
    pub fn dequeue_failed(&self, id: i64) -> Result<(), String> {
        let db = self.db.lock().unwrap();
        db.execute("DELETE FROM failed_changes_v2 WHERE id = ?1", params![id])
            .map_err(|e| format!("delete failed: {}", e))?;
        Ok(())
    }

    /// Clear all failed entries (user dismisses the failure list entirely).
    pub fn clear_failed(&self) -> Result<usize, String> {
        let db = self.db.lock().unwrap();
        let n = db
            .execute("DELETE FROM failed_changes_v2", [])
            .map_err(|e| format!("clear failed: {}", e))?;
        Ok(n)
    }

    /// Number of permanently-failed entries.
    pub fn count_failed(&self) -> Result<usize, String> {
        let db = self.db.lock().unwrap();
        let c: i64 = db
            .query_row("SELECT COUNT(*) FROM failed_changes_v2", [], |r| r.get(0))
            .map_err(|e| format!("count failed: {}", e))?;
        Ok(c as usize)
    }

    /// Enqueue an operation in the Fast lane. Dedup by target_key.
    pub fn enqueue(&self, op: DirtyOperation) -> Result<i64, String> {
        self.enqueue_with_lane(op, Lane::Fast)
    }

    /// Enqueue with explicit lane. Caller must choose Slow only for large
    /// attachments to avoid them blocking the Fast lane.
    pub fn enqueue_with_lane(&self, op: DirtyOperation, lane: Lane) -> Result<i64, String> {
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
            "INSERT INTO pending_changes_v2 (operation_json, target_key, timestamp, retry_count, lane) VALUES (?1, ?2, ?3, 0, ?4)",
            params![op_json, target_key, ts, lane.as_str()],
        )
        .map_err(|e| format!("insert: {}", e))?;

        Ok(db.last_insert_rowid())
    }

    /// List all pending entries ordered by timestamp (both lanes).
    pub fn list_pending(&self) -> Result<Vec<DirtyEntry>, String> {
        self.list_pending_inner(None)
    }

    /// List pending entries in a specific lane.
    pub fn list_pending_lane(&self, lane: Lane) -> Result<Vec<DirtyEntry>, String> {
        self.list_pending_inner(Some(lane))
    }

    fn list_pending_inner(&self, lane_filter: Option<Lane>) -> Result<Vec<DirtyEntry>, String> {
        let db = self.db.lock().unwrap();
        let (sql, lane_str) = match lane_filter {
            Some(l) => (
                "SELECT id, operation_json, timestamp, retry_count, last_error, lane FROM pending_changes_v2 WHERE lane = ?1 ORDER BY timestamp",
                Some(l.as_str()),
            ),
            None => (
                "SELECT id, operation_json, timestamp, retry_count, last_error, lane FROM pending_changes_v2 ORDER BY timestamp",
                None,
            ),
        };

        let mut stmt = db.prepare(sql).map_err(|e| format!("prepare: {}", e))?;

        let map_row = |row: &rusqlite::Row| -> rusqlite::Result<(i64, String, i64, u32, Option<String>, String)> {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, u32>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, String>(5)?,
            ))
        };

        let rows: Vec<_> = if let Some(s) = lane_str {
            stmt.query_map(params![s], map_row)
                .map_err(|e| format!("query: {}", e))?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(|e| format!("row: {}", e))?
        } else {
            stmt.query_map([], map_row)
                .map_err(|e| format!("query: {}", e))?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(|e| format!("row: {}", e))?
        };

        let mut result = Vec::with_capacity(rows.len());
        for (id, op_json, ts, retry_count, last_error, lane_s) in rows {
            let op: DirtyOperation =
                serde_json::from_str(&op_json).map_err(|e| format!("parse: {}", e))?;
            let timestamp = DateTime::from_timestamp_millis(ts).unwrap_or_else(Utc::now);
            result.push(DirtyEntry {
                id,
                op,
                timestamp,
                retry_count,
                last_error,
                lane: Lane::parse(&lane_s),
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

    /// Number of pending entries (both lanes).
    pub fn count(&self) -> Result<usize, String> {
        let db = self.db.lock().unwrap();
        let c: i64 = db
            .query_row("SELECT COUNT(*) FROM pending_changes_v2", [], |r| r.get(0))
            .map_err(|e| format!("count: {}", e))?;
        Ok(c as usize)
    }

    /// Number of pending entries in a specific lane.
    pub fn count_lane(&self, lane: Lane) -> Result<usize, String> {
        let db = self.db.lock().unwrap();
        let c: i64 = db
            .query_row(
                "SELECT COUNT(*) FROM pending_changes_v2 WHERE lane = ?1",
                params![lane.as_str()],
                |r| r.get(0),
            )
            .map_err(|e| format!("count_lane: {}", e))?;
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
