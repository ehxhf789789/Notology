#![allow(dead_code)]

use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, RwLock};
use std::thread;
use std::time::SystemTime;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoTask {
    pub summary: String,
    pub due_date: Option<String>,
    pub due_time: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexedMemo {
    pub id: String,
    pub note_path: String,
    pub note_title: String,
    pub content: String,
    pub anchor_text: String,
    pub created: String,
    pub created_time: String,
    pub resolved: bool,
    pub task: Option<MemoTask>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoQueryFilter {
    pub start_date: Option<String>,
    pub end_date: Option<String>,
    pub tasks_only: bool,
    pub completed: Option<bool>,
    pub note_path: Option<String>,
}

#[derive(Debug, Clone)]
struct CacheEntry {
    memos: Vec<IndexedMemo>,
    modified_time: SystemTime,
}

pub struct MemoIndex {
    cache: Arc<RwLock<HashMap<String, CacheEntry>>>,
    title_cache: Arc<RwLock<HashMap<String, String>>>,
    vault_path: String,
    initialized: Arc<AtomicBool>,
    initializing: Arc<AtomicBool>,
}

impl MemoIndex {
    pub fn new(vault_path: &str) -> Self {
        Self {
            cache: Arc::new(RwLock::new(HashMap::new())),
            title_cache: Arc::new(RwLock::new(HashMap::new())),
            vault_path: vault_path.to_string(),
            initialized: Arc::new(AtomicBool::new(false)),
            initializing: Arc::new(AtomicBool::new(false)),
        }
    }

    fn get_comments_path(note_path: &str) -> Option<PathBuf> {
        let path = Path::new(note_path);
        let stem = path.file_stem()?.to_string_lossy();
        let parent = path.parent()?;
        Some(parent.join(format!("{}_att", stem)).join("comments.json"))
    }

    fn is_cache_valid(&self, note_path: &str, comments_path: &Path) -> bool {
        let cache = match self.cache.read() {
            Ok(c) => c,
            Err(_) => return false,
        };

        if let Some(entry) = cache.get(note_path) {
            if let Ok(metadata) = fs::metadata(comments_path) {
                if let Ok(modified) = metadata.modified() {
                    return entry.modified_time >= modified;
                }
            }
        }
        false
    }

    /// Index a single note's memos with caching
    pub fn index_note_memos(&self, note_path: &str) -> Result<(), String> {
        let comments_path = match Self::get_comments_path(note_path) {
            Some(p) => p,
            None => return Err("Invalid note path".to_string()),
        };

        if !comments_path.exists() {
            if let Ok(mut cache) = self.cache.write() {
                cache.remove(note_path);
            }
            return Ok(());
        }

        if self.is_cache_valid(note_path, &comments_path) {
            return Ok(());
        }

        let comments_json = fs::read_to_string(&comments_path).map_err(|e| e.to_string())?;
        let comments: Vec<serde_json::Value> =
            serde_json::from_str(&comments_json).map_err(|e| e.to_string())?;

        let modified_time = fs::metadata(&comments_path)
            .and_then(|m| m.modified())
            .unwrap_or_else(|_| SystemTime::now());

        let note_title = self.get_note_title(note_path);

        let indexed_memos: Vec<IndexedMemo> = comments
            .into_iter()
            .map(|comment| IndexedMemo {
                id: comment["id"].as_str().unwrap_or("").to_string(),
                note_path: note_path.to_string(),
                note_title: note_title.clone(),
                content: comment["content"].as_str().unwrap_or("").to_string(),
                anchor_text: comment["anchorText"].as_str().unwrap_or("").to_string(),
                created: comment["created"].as_str().unwrap_or("").to_string(),
                created_time: comment["createdTime"]
                    .as_str()
                    .unwrap_or_else(|| comment["created"].as_str().unwrap_or(""))
                    .to_string(),
                resolved: comment["resolved"].as_bool().unwrap_or(false),
                task: comment.get("task").map(|task_obj| MemoTask {
                    summary: task_obj["summary"].as_str().unwrap_or("").to_string(),
                    due_date: task_obj.get("dueDate").and_then(|v| v.as_str()).map(String::from),
                    due_time: task_obj.get("dueTime").and_then(|v| v.as_str()).map(String::from),
                }),
            })
            .collect();

        if let Ok(mut cache) = self.cache.write() {
            cache.insert(
                note_path.to_string(),
                CacheEntry {
                    memos: indexed_memos,
                    modified_time,
                },
            );
        }

        Ok(())
    }

    fn get_note_title(&self, note_path: &str) -> String {
        {
            if let Ok(cache) = self.title_cache.read() {
                if let Some(title) = cache.get(note_path) {
                    return title.clone();
                }
            }
        }

        let title = Self::extract_note_title(note_path).unwrap_or_else(|| {
            Path::new(note_path)
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default()
        });

        if let Ok(mut cache) = self.title_cache.write() {
            cache.insert(note_path.to_string(), title.clone());
        }

        title
    }

    #[allow(dead_code)]
    pub fn set_note_title(&self, note_path: &str, title: &str) {
        if let Ok(mut cache) = self.title_cache.write() {
            cache.insert(note_path.to_string(), title.to_string());
        }
    }

    pub fn remove_note_memos(&self, note_path: &str) -> Result<(), String> {
        if let Ok(mut cache) = self.cache.write() {
            cache.remove(note_path);
        }
        if let Ok(mut title_cache) = self.title_cache.write() {
            title_cache.remove(note_path);
        }
        Ok(())
    }

    /// Full reindex - starts background initialization
    pub fn full_reindex(&self) -> Result<(), String> {
        {
            if let Ok(mut cache) = self.cache.write() {
                cache.clear();
            }
        }
        {
            if let Ok(mut title_cache) = self.title_cache.write() {
                title_cache.clear();
            }
        }

        self.initialized.store(false, Ordering::SeqCst);

        // Start background initialization
        self.start_background_init();

        Ok(())
    }

    /// Start background initialization in a separate thread
    fn start_background_init(&self) {
        // Check if already initializing
        if self.initializing.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err() {
            return;
        }

        let cache = Arc::clone(&self.cache);
        let title_cache = Arc::clone(&self.title_cache);
        let initialized = Arc::clone(&self.initialized);
        let initializing = Arc::clone(&self.initializing);
        let vault_path = self.vault_path.clone();

        thread::spawn(move || {
            let _ = Self::scan_vault_parallel(&vault_path, &cache, &title_cache);
            initialized.store(true, Ordering::SeqCst);
            initializing.store(false, Ordering::SeqCst);
            log::info!("MemoIndex background initialization complete");
        });
    }

    /// Parallel vault scan using rayon
    fn scan_vault_parallel(
        vault_path: &str,
        cache: &Arc<RwLock<HashMap<String, CacheEntry>>>,
        title_cache: &Arc<RwLock<HashMap<String, String>>>,
    ) -> Result<(), String> {
        let vault = Path::new(vault_path);

        // Collect all comment files first (single-threaded directory walk)
        let comment_files: Vec<(PathBuf, PathBuf)> = Self::collect_comment_files(vault);

        // Process files in parallel
        let results: Vec<(String, CacheEntry)> = comment_files
            .par_iter()
            .filter_map(|(note_path, comments_path)| {
                Self::load_comments_file(note_path, comments_path, title_cache)
            })
            .collect();

        // Batch update cache
        if let Ok(mut cache_guard) = cache.write() {
            for (note_path, entry) in results {
                cache_guard.insert(note_path, entry);
            }
        }

        Ok(())
    }

    /// Collect all _att/comments.json files
    fn collect_comment_files(dir: &Path) -> Vec<(PathBuf, PathBuf)> {
        let mut results = Vec::new();
        Self::collect_comment_files_recursive(dir, &mut results);
        results
    }

    fn collect_comment_files_recursive(dir: &Path, results: &mut Vec<(PathBuf, PathBuf)>) {
        let entries = match fs::read_dir(dir) {
            Ok(e) => e,
            Err(_) => return,
        };

        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();

            if name.starts_with('.') {
                continue;
            }

            if path.is_dir() {
                if name.ends_with("_att") {
                    let comments_path = path.join("comments.json");
                    if comments_path.exists() {
                        if let Some(parent) = path.parent() {
                            let note_name = &name[..name.len() - 4];
                            let note_path = parent.join(format!("{}.md", note_name));
                            if note_path.exists() {
                                results.push((note_path, comments_path));
                            }
                        }
                    }
                } else {
                    Self::collect_comment_files_recursive(&path, results);
                }
            }
        }
    }

    /// Load a single comments file (called in parallel)
    fn load_comments_file(
        note_path: &PathBuf,
        comments_path: &PathBuf,
        title_cache: &Arc<RwLock<HashMap<String, String>>>,
    ) -> Option<(String, CacheEntry)> {
        let comments_json = fs::read_to_string(comments_path).ok()?;
        let comments: Vec<serde_json::Value> = serde_json::from_str(&comments_json).ok()?;

        let modified_time = fs::metadata(comments_path)
            .and_then(|m| m.modified())
            .unwrap_or_else(|_| SystemTime::now());

        let note_path_str = note_path.to_string_lossy().to_string();

        // Get title from cache or extract
        let note_title = {
            let cached = title_cache.read().ok().and_then(|c| c.get(&note_path_str).cloned());
            cached.unwrap_or_else(|| {
                let title = Self::extract_note_title(&note_path_str).unwrap_or_else(|| {
                    note_path
                        .file_stem()
                        .map(|s| s.to_string_lossy().to_string())
                        .unwrap_or_default()
                });
                if let Ok(mut cache) = title_cache.write() {
                    cache.insert(note_path_str.clone(), title.clone());
                }
                title
            })
        };

        let indexed_memos: Vec<IndexedMemo> = comments
            .into_iter()
            .map(|comment| IndexedMemo {
                id: comment["id"].as_str().unwrap_or("").to_string(),
                note_path: note_path_str.clone(),
                note_title: note_title.clone(),
                content: comment["content"].as_str().unwrap_or("").to_string(),
                anchor_text: comment["anchorText"].as_str().unwrap_or("").to_string(),
                created: comment["created"].as_str().unwrap_or("").to_string(),
                created_time: comment["createdTime"]
                    .as_str()
                    .unwrap_or_else(|| comment["created"].as_str().unwrap_or(""))
                    .to_string(),
                resolved: comment["resolved"].as_bool().unwrap_or(false),
                task: comment.get("task").map(|task_obj| MemoTask {
                    summary: task_obj["summary"].as_str().unwrap_or("").to_string(),
                    due_date: task_obj.get("dueDate").and_then(|v| v.as_str()).map(String::from),
                    due_time: task_obj.get("dueTime").and_then(|v| v.as_str()).map(String::from),
                }),
            })
            .collect();

        Some((
            note_path_str,
            CacheEntry {
                memos: indexed_memos,
                modified_time,
            },
        ))
    }

    /// Ensure initialized - waits briefly if background init in progress
    fn ensure_initialized(&self) -> Result<(), String> {
        // Already initialized
        if self.initialized.load(Ordering::SeqCst) {
            return Ok(());
        }

        // If not initializing, start it
        if !self.initializing.load(Ordering::SeqCst) {
            self.start_background_init();
        }

        // Wait for initialization (with timeout)
        let start = std::time::Instant::now();
        let timeout = std::time::Duration::from_secs(10);

        while !self.initialized.load(Ordering::SeqCst) {
            if start.elapsed() > timeout {
                log::warn!("MemoIndex initialization timeout, proceeding with partial data");
                break;
            }
            thread::sleep(std::time::Duration::from_millis(50));
        }

        Ok(())
    }

    /// Query memos with filters (optimized)
    pub fn query_memos(&self, filter: &MemoQueryFilter) -> Result<Vec<IndexedMemo>, String> {
        self.ensure_initialized()?;

        // If querying specific note, ensure it's indexed
        if let Some(ref note_path) = filter.note_path {
            let _ = self.index_note_memos(note_path);
        }

        let cache = self.cache.read().map_err(|e| e.to_string())?;

        // Pre-allocate with estimated capacity
        let estimated_size = if filter.note_path.is_some() {
            100
        } else {
            cache.values().map(|e| e.memos.len()).sum::<usize>()
        };
        let mut results = Vec::with_capacity(estimated_size);

        // Use iterators for better performance
        for entry in cache.values() {
            for memo in &entry.memos {
                if !Self::matches_filter(memo, filter) {
                    continue;
                }
                results.push(memo.clone());
            }
        }

        // Sort by date
        results.sort_unstable_by(|a, b| {
            let date_a = a.task.as_ref()
                .and_then(|t| t.due_date.as_ref())
                .unwrap_or(&a.created);
            let date_b = b.task.as_ref()
                .and_then(|t| t.due_date.as_ref())
                .unwrap_or(&b.created);
            date_a.cmp(date_b)
        });

        Ok(results)
    }

    /// Check if memo matches filter (inlined for performance)
    #[inline]
    fn matches_filter(memo: &IndexedMemo, filter: &MemoQueryFilter) -> bool {
        // Filter by note path
        if let Some(ref note_path) = filter.note_path {
            if &memo.note_path != note_path {
                return false;
            }
        }

        // Filter by tasks_only
        if filter.tasks_only && memo.task.is_none() {
            return false;
        }

        // Filter by completed status
        if let Some(completed) = filter.completed {
            if filter.tasks_only && memo.task.is_none() {
                return false;
            }
            if memo.resolved != completed {
                return false;
            }
        }

        // Filter by date range
        let date_to_check = memo.task.as_ref()
            .and_then(|t| t.due_date.as_ref())
            .unwrap_or(&memo.created);

        if let Some(ref start) = filter.start_date {
            if date_to_check < start {
                return false;
            }
        }

        if let Some(ref end) = filter.end_date {
            if date_to_check > end {
                return false;
            }
        }

        true
    }

    fn extract_note_title(note_path: &str) -> Option<String> {
        let content = fs::read_to_string(note_path).ok()?;
        if !content.starts_with("---") {
            return None;
        }

        let end_idx = content[3..].find("\n---")?;
        let frontmatter = &content[3..end_idx + 3];

        for line in frontmatter.lines() {
            if line.trim_start().starts_with("title:") {
                let title = line.split(':').nth(1)?.trim();
                return Some(title.trim_matches('"').trim_matches('\'').to_string());
            }
        }

        None
    }

    #[allow(dead_code)]
    pub fn invalidate_cache(&self, note_path: &str) {
        if let Ok(mut cache) = self.cache.write() {
            cache.remove(note_path);
        }
    }

    #[allow(dead_code)]
    pub fn get_cache_stats(&self) -> (usize, usize) {
        let memo_count = self.cache.read().map(|c| c.len()).unwrap_or(0);
        let title_count = self.title_cache.read().map(|c| c.len()).unwrap_or(0);
        (memo_count, title_count)
    }

    /// Check if initialization is complete
    #[allow(dead_code)]
    pub fn is_initialized(&self) -> bool {
        self.initialized.load(Ordering::SeqCst)
    }
}
