use serde::{Serialize, Deserialize};

#[derive(Serialize)]
pub struct FileNode {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_folder_note: bool,
    pub mtime: Option<u64>,
    pub children: Option<Vec<FileNode>>,
}

#[derive(Serialize)]
pub struct FileContent {
    pub frontmatter: Option<String>,
    pub body: String,
}

#[derive(Serialize)]
pub struct AttachmentInfo {
    pub path: String,
    pub file_name: String,
    pub note_path: String,
    pub note_name: String,
    pub note_relative_path: String,
    pub inferred_note_path: String,
    pub container: String,
    pub is_conflict: bool,
    pub conflict_original: String,
}


#[derive(Serialize)]
pub struct BacklinkResult {
    pub file_path: String,
    pub file_name: String,
    pub line_number: u32,
    pub context: String,
}

#[derive(Serialize)]
pub struct CommentsWithMtime {
    pub comments: String,
    pub mtime: u64,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarMemo {
    pub id: String,
    pub content: String,
    pub note_path: String,
    pub note_title: String,
    pub date: String,
    pub is_task: bool,
    pub resolved: bool,
    pub anchor_text: String,
    /// 2026-05-26 (HanBin) — `HH:MM` from comment task.dueTime, or `None`
    /// for memo / undated task. Drives Day-view 24-hour timeline placement
    /// (RightPanel CalendarSurface). Frontend treats `null` as "시간 미정"
    /// group at the top of the day.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub due_time: Option<String>,
}

#[derive(Serialize)]
pub struct UrlMetadata {
    pub title: String,
    pub description: String,
    pub image: String,
    pub favicon: String,
}

#[derive(Serialize)]
pub struct NasPlatformInfo {
    pub is_nas_synced: bool,
    pub platform: String,
    pub synology_root: String,
    pub synology_client_running: bool,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct NoteLockInfo {
    pub machine_id: String,
    pub hostname: String,
    pub file_path: String,
    pub locked_at: String,
    pub heartbeat: String,
}

#[derive(Serialize, Clone)]
pub struct BulkTagProgress {
    pub total: usize,
    pub completed: usize,
    pub current_path: String,
}

#[derive(Serialize)]
pub struct BulkTagResult {
    pub affected_count: usize,
    pub failed_paths: Vec<String>,
    pub cancelled: bool,
}

#[derive(Serialize, Clone)]
pub struct VaultIntegrityResult {
    pub orphaned_att_folders: Vec<String>,
    pub total_notes: usize,
    pub total_att_folders: usize,
}

/// File metadata with modification time
#[derive(Serialize)]
pub struct FileMeta {
    pub path: String,
    pub mtime: u64,
}

/// Frontmatter-only result (for metadata queries without body)
#[derive(Serialize)]
pub struct FrontmatterOnly {
    pub path: String,
    pub frontmatter: Option<String>,
    pub mtime: u64,
}

/// Index state for incremental startup
#[allow(dead_code)]
#[derive(Serialize, Deserialize)]
pub struct IndexState {
    pub version: u32,
    pub last_full_index: u64,
    pub file_mtimes: std::collections::HashMap<String, u64>,
}
