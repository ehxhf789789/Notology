pub mod parser;
pub mod watcher;

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use once_cell::sync::Lazy;
use rayon::prelude::*;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::io::Write;
use tantivy::collector::TopDocs;
use tantivy::query::{BooleanQuery, Occur, QueryParser, TermQuery};
use tantivy::schema::*;
use tantivy::tokenizer::*;
use tantivy::{doc, Index, IndexReader, IndexWriter, ReloadPolicy, TantivyDocument};
use walkdir::WalkDir;

use parser::*;

/// Strip markdown formatting markers from text, preserving content.
/// Removes: bold/italic (**,*,__), highlight (==), strikethrough (~~),
/// headings (#), horizontal rules (---), bullet/list markers, blockquotes (>),
/// inline code backticks, code fences, links, images, wiki links.
/// Preserves: content-internal dashes (e.g., phone numbers 010-5424-3432).
fn strip_markdown_formatting(text: &str) -> String {
    // Line-level patterns
    static RE_HORIZONTAL_RULE: Lazy<Regex> =
        Lazy::new(|| Regex::new(r"^\s*(?:-{3,}|\*{3,}|_{3,})\s*$").unwrap());
    static RE_HEADING: Lazy<Regex> =
        Lazy::new(|| Regex::new(r"^#{1,6}\s+").unwrap());
    static RE_CODE_FENCE: Lazy<Regex> =
        Lazy::new(|| Regex::new(r"^```").unwrap());
    static RE_BLOCKQUOTE: Lazy<Regex> =
        Lazy::new(|| Regex::new(r"^(?:>\s?)+").unwrap());
    static RE_BULLET: Lazy<Regex> =
        Lazy::new(|| Regex::new(r"^(\s*)[-*+]\s+").unwrap());
    static RE_NUMBERED_LIST: Lazy<Regex> =
        Lazy::new(|| Regex::new(r"^(\s*)\d+\.\s+").unwrap());

    // Inline patterns
    static RE_IMAGE: Lazy<Regex> =
        Lazy::new(|| Regex::new(r"!\[([^\]]*)\]\([^)]*\)").unwrap());
    static RE_LINK: Lazy<Regex> =
        Lazy::new(|| Regex::new(r"\[([^\]]*)\]\([^)]*\)").unwrap());
    static RE_WIKI_EMBED: Lazy<Regex> =
        Lazy::new(|| Regex::new(r"!\[\[([^\]]+)\]\]").unwrap());
    static RE_WIKI_LINK: Lazy<Regex> =
        Lazy::new(|| Regex::new(r"\[\[([^\]|]+)(?:\|([^\]]+))?\]\]").unwrap());
    static RE_HIGHLIGHT: Lazy<Regex> =
        Lazy::new(|| Regex::new(r"==([^=]+)==").unwrap());
    static RE_BOLD_ITALIC: Lazy<Regex> =
        Lazy::new(|| Regex::new(r"\*{3}(.+?)\*{3}").unwrap());
    static RE_BOLD: Lazy<Regex> =
        Lazy::new(|| Regex::new(r"\*{2}(.+?)\*{2}").unwrap());
    static RE_ITALIC: Lazy<Regex> =
        Lazy::new(|| Regex::new(r"\*([^*]+)\*").unwrap());
    static RE_BOLD_UNDER: Lazy<Regex> =
        Lazy::new(|| Regex::new(r"__(.+?)__").unwrap());
    static RE_STRIKETHROUGH: Lazy<Regex> =
        Lazy::new(|| Regex::new(r"~~(.+?)~~").unwrap());
    static RE_INLINE_CODE: Lazy<Regex> =
        Lazy::new(|| Regex::new(r"`([^`]+)`").unwrap());

    let mut lines: Vec<String> = Vec::new();
    let mut in_code_block = false;

    for line in text.lines() {
        // Toggle code block state
        if RE_CODE_FENCE.is_match(line) {
            in_code_block = !in_code_block;
            continue; // Skip the fence line itself
        }

        // Inside code block: keep content as-is
        if in_code_block {
            lines.push(line.to_string());
            continue;
        }

        // Skip horizontal rules (---, ***, ___)
        if RE_HORIZONTAL_RULE.is_match(line) {
            continue;
        }

        let mut processed = line.to_string();

        // Remove heading markers (# Text → Text)
        processed = RE_HEADING.replace(&processed, "").to_string();

        // Remove blockquote markers (> Text → Text)
        processed = RE_BLOCKQUOTE.replace_all(&processed, "").to_string();

        // Remove bullet markers at line start (- Text → Text)
        // Preserves indentation structure via capture group $1
        processed = RE_BULLET.replace(&processed, "$1").to_string();

        // Remove numbered list markers (1. Text → Text)
        processed = RE_NUMBERED_LIST.replace(&processed, "$1").to_string();

        // Images: ![alt](url) → alt
        processed = RE_IMAGE.replace_all(&processed, "$1").to_string();

        // Links: [text](url) → text
        processed = RE_LINK.replace_all(&processed, "$1").to_string();

        // Wiki embeds: ![[file]] → file
        processed = RE_WIKI_EMBED.replace_all(&processed, "$1").to_string();

        // Wiki links: [[target|alias]] → alias, [[target]] → target
        processed = RE_WIKI_LINK
            .replace_all(&processed, |caps: &regex::Captures| {
                caps.get(2)
                    .map_or_else(|| caps[1].to_string(), |m| m.as_str().to_string())
            })
            .to_string();

        // Highlight: ==text== → text
        processed = RE_HIGHLIGHT.replace_all(&processed, "$1").to_string();

        // Bold+Italic: ***text*** → text (before bold/italic)
        processed = RE_BOLD_ITALIC.replace_all(&processed, "$1").to_string();

        // Bold: **text** → text
        processed = RE_BOLD.replace_all(&processed, "$1").to_string();

        // Italic: *text* → text (word-boundary aware)
        processed = RE_ITALIC.replace_all(&processed, "$1").to_string();

        // Bold underscores: __text__ → text
        processed = RE_BOLD_UNDER.replace_all(&processed, "$1").to_string();

        // Strikethrough: ~~text~~ → text
        processed = RE_STRIKETHROUGH.replace_all(&processed, "$1").to_string();

        // Inline code: `code` → code
        processed = RE_INLINE_CODE.replace_all(&processed, "$1").to_string();

        if !processed.trim().is_empty() {
            lines.push(processed);
        }
    }

    lines.join("\n")
}

/// Current schema version - increment this when index structure changes
/// v3: Tags now include namespace prefix (e.g., "domain/특허출원")
/// v4: Body text stripped of markdown formatting before indexing
const SCHEMA_VERSION: u32 = 4;

/// Metadata for version tracking and auto-regeneration
#[derive(Serialize, Deserialize, Clone)]
struct IndexMetadata {
    /// Application version that created this index
    app_version: String,
    /// Schema version for compatibility checking
    schema_version: u32,
    /// Original vault path (for verification)
    vault_path: String,
    /// When the index was created
    created_at: String,
}

impl IndexMetadata {
    fn new(vault_path: &str) -> Self {
        Self {
            app_version: env!("CARGO_PKG_VERSION").to_string(),
            schema_version: SCHEMA_VERSION,
            vault_path: vault_path.to_string(),
            created_at: chrono::Utc::now().to_rfc3339(),
        }
    }

    fn is_compatible(&self) -> bool {
        // Check schema version compatibility
        self.schema_version == SCHEMA_VERSION
    }
}

#[derive(Serialize, Deserialize, Clone)]
pub struct SearchResult {
    pub path: String,
    pub title: String,
    pub snippet: String,
    pub score: f32,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct NoteFilter {
    pub note_type: Option<String>,
    pub tags: Option<Vec<String>>,
    pub created_after: Option<String>,
    pub created_before: Option<String>,
    pub modified_after: Option<String>,
    pub modified_before: Option<String>,
    pub sort_by: Option<String>,
    pub sort_order: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct NoteMetadata {
    pub path: String,
    pub title: String,
    pub note_type: String,
    pub tags: Vec<String>,
    pub created: String,
    pub modified: String,
    pub has_body: bool,
    pub comment_count: usize,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct RelationshipData {
    pub outgoing_links: Vec<LinkInfo>,
    pub incoming_links: Vec<LinkInfo>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct LinkInfo {
    pub path: String,
    pub title: String,
    pub context: String,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GraphNode {
    pub id: String,
    pub label: String,
    pub node_type: String,
    pub note_type: String,
    pub path: String,
    pub is_folder_note: bool,
    pub tag_namespace: String,
    pub memo_count: usize,
    pub task_count: usize,
    pub has_unresolved_tasks: bool,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GraphEdge {
    pub source: String,
    pub target: String,
    pub edge_type: String,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct GraphData {
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
}

/// CJK-aware tokenizer that handles Korean, Japanese, Chinese characters
/// by treating each CJK character as an individual token while using
/// standard word-based tokenization for Latin scripts.
#[derive(Clone)]
struct CjkTokenizer;

impl Tokenizer for CjkTokenizer {
    type TokenStream<'a> = CjkTokenStream;

    fn token_stream<'a>(&'a mut self, text: &'a str) -> Self::TokenStream<'a> {
        let mut tokens = Vec::new();
        let mut offset = 0;

        let chars: Vec<char> = text.chars().collect();
        let mut i = 0;

        while i < chars.len() {
            let ch = chars[i];

            if is_cjk_char(ch) {
                // Each CJK character is a token, also create bigrams
                let byte_start = text[..offset].len();
                let char_len = ch.len_utf8();
                tokens.push(TokenData {
                    text: ch.to_string().to_lowercase(),
                    offset_from: byte_start,
                    offset_to: byte_start + char_len,
                });
                // Bigram: current + next CJK char
                if i + 1 < chars.len() && is_cjk_char(chars[i + 1]) {
                    let next_len = chars[i + 1].len_utf8();
                    let bigram = format!("{}{}", ch, chars[i + 1]).to_lowercase();
                    tokens.push(TokenData {
                        text: bigram,
                        offset_from: byte_start,
                        offset_to: byte_start + char_len + next_len,
                    });
                }
                offset += char_len;
                i += 1;
            } else if ch.is_alphanumeric() {
                // Collect Latin word
                let word_start = offset;
                let mut word = String::new();
                while i < chars.len() && chars[i].is_alphanumeric() {
                    word.push(chars[i]);
                    offset += chars[i].len_utf8();
                    i += 1;
                }
                tokens.push(TokenData {
                    text: word.to_lowercase(),
                    offset_from: word_start,
                    offset_to: offset,
                });
            } else {
                offset += ch.len_utf8();
                i += 1;
            }
        }

        CjkTokenStream {
            tokens,
            index: 0,
            token: Token::default(),
        }
    }
}

fn is_cjk_char(c: char) -> bool {
    let cp = c as u32;
    // CJK Unified Ideographs
    (0x4E00..=0x9FFF).contains(&cp)
    // Hangul Syllables
    || (0xAC00..=0xD7AF).contains(&cp)
    // Hangul Jamo
    || (0x1100..=0x11FF).contains(&cp)
    // Hangul Compatibility Jamo
    || (0x3130..=0x318F).contains(&cp)
    // Katakana
    || (0x30A0..=0x30FF).contains(&cp)
    // Hiragana
    || (0x3040..=0x309F).contains(&cp)
    // CJK Extension A
    || (0x3400..=0x4DBF).contains(&cp)
    // CJK Extension B
    || (0x20000..=0x2A6DF).contains(&cp)
}

/// Strip common Korean particles (조사) from the end of a word to extract the stem.
/// Returns the stem if stripping was successful and the result is 2+ chars, otherwise the original.
fn strip_korean_particles(word: &str) -> &str {
    // Ordered longest-first so we match the longest particle
    const PARTICLES: &[&str] = &[
        "에서는", "으로는", "에서도", "으로도", "까지는", "부터는", "에게는",
        "에서", "으로", "까지", "부터", "에게", "한테", "처럼", "만큼",
        "이나", "라는", "에는", "와는", "과는",
        "은", "는", "이", "가", "을", "를", "에", "의", "로", "와", "과",
        "도", "만", "야", "요", "며", "고", "서", "라",
    ];
    let chars: Vec<char> = word.chars().collect();
    for p in PARTICLES {
        if word.ends_with(p) {
            let p_len = p.chars().count();
            if chars.len() > p_len {
                let stem_len = chars.len() - p_len;
                if stem_len >= 2 {
                    let byte_end: usize = chars[..stem_len].iter().map(|c| c.len_utf8()).sum();
                    return &word[..byte_end];
                }
            }
        }
    }
    word
}

/// Check if a word extracted from document body is a valid suggestion term.
fn is_valid_suggestion_word(word: &str) -> bool {
    let chars: Vec<char> = word.chars().collect();
    if chars.is_empty() {
        return false;
    }

    let has_cjk = chars.iter().any(|c| is_cjk_char(*c));

    if has_cjk {
        // Korean/CJK: require 2+ characters, only CJK chars
        chars.len() >= 2 && chars.iter().all(|c| is_cjk_char(*c))
    } else {
        // Latin: require 3+ characters, alphabetic
        if chars.len() < 3 {
            return false;
        }
        // Filter pure numbers
        if chars.iter().all(|c| c.is_ascii_digit()) {
            return false;
        }
        // Must be mostly alphabetic
        if !chars.iter().all(|c| c.is_alphanumeric()) {
            return false;
        }
        let lower = word.to_lowercase();
        const STOPWORDS: &[&str] = &[
            "the", "and", "for", "are", "but", "not", "you", "all", "can", "had",
            "her", "was", "one", "our", "out", "has", "have", "from", "this", "that",
            "with", "they", "been", "said", "each", "which", "their", "will", "other",
            "about", "many", "then", "them", "these", "some", "would", "make", "like",
            "into", "could", "time", "very", "when", "come", "than", "look", "only",
            "also", "back", "after", "use", "two", "how", "first", "well", "way",
            "even", "new", "want", "because", "any", "give", "most", "find",
            "here", "thing", "just", "where", "what", "know", "take", "who",
            "http", "https", "www", "com", "org", "net", "html", "css",
        ];
        !STOPWORDS.contains(&lower.as_str())
    }
}

/// Extract a snippet from text around the query terms
fn extract_snippet(text: &str, query: &str, max_len: usize) -> String {
    if text.is_empty() {
        return String::new();
    }

    // Split query into terms
    let query_terms: Vec<&str> = query
        .split_whitespace()
        .filter(|t| !t.is_empty())
        .collect();

    if query_terms.is_empty() {
        // No query terms, return first max_len chars
        return text.chars().take(max_len).collect();
    }

    // Find first occurrence of any query term (case-insensitive)
    let text_lower = text.to_lowercase();
    let mut best_pos = None;

    for term in &query_terms {
        if let Some(pos) = text_lower.find(&term.to_lowercase()) {
            if best_pos.is_none() || pos < best_pos.unwrap() {
                best_pos = Some(pos);
            }
        }
    }

    match best_pos {
        Some(match_pos) => {
            // Extract context around the match
            let start = if match_pos > max_len / 3 {
                match_pos - max_len / 3
            } else {
                0
            };

            let snippet: String = text.chars().skip(start).take(max_len).collect();

            // Trim to avoid cutting words
            let trimmed = snippet.trim();
            if start > 0 {
                format!("...{}", trimmed)
            } else {
                trimmed.to_string()
            }
        }
        None => {
            // No match found, return first max_len chars
            text.chars().take(max_len).collect()
        }
    }
}

struct TokenData {
    text: String,
    offset_from: usize,
    offset_to: usize,
}

struct CjkTokenStream {
    tokens: Vec<TokenData>,
    index: usize,
    token: Token,
}

impl TokenStream for CjkTokenStream {
    fn advance(&mut self) -> bool {
        if self.index < self.tokens.len() {
            let data = &self.tokens[self.index];
            self.token = Token {
                offset_from: data.offset_from,
                offset_to: data.offset_to,
                position: self.index,
                text: data.text.clone(),
                position_length: 1,
            };
            self.index += 1;
            true
        } else {
            false
        }
    }

    fn token(&self) -> &Token {
        &self.token
    }

    fn token_mut(&mut self) -> &mut Token {
        &mut self.token
    }
}

/// Cached file entry for incremental indexing (reserved for future use)
#[derive(Clone)]
#[allow(dead_code)]
struct IndexedFileEntry {
    path: PathBuf,
    modified_time: std::time::SystemTime,
}

/// Progress tracking for large operations
pub struct IndexProgress {
    pub total: AtomicUsize,
    pub completed: AtomicUsize,
    pub is_running: AtomicBool,
}

impl Default for IndexProgress {
    fn default() -> Self {
        Self {
            total: AtomicUsize::new(0),
            completed: AtomicUsize::new(0),
            is_running: AtomicBool::new(false),
        }
    }
}

/// Pre-parsed document data for batch indexing
struct ParsedDocument {
    path: String,
    title: String,
    body: String,
    tags: Vec<String>,
    note_type: String,
    created: String,
    modified: String,
    wiki_links: Vec<String>,
    frontmatter_raw: String,
}

pub struct SearchIndex {
    index: Index,
    reader: IndexReader,
    writer: Arc<Mutex<IndexWriter>>,
    _schema: Schema,
    vault_path: PathBuf,
    // Field handles
    f_path: Field,
    f_title: Field,
    f_body: Field,
    f_tags: Field,
    f_note_type: Field,
    f_created: Field,
    f_modified: Field,
    f_wiki_links: Field,
    f_frontmatter_raw: Field,
    // File modification cache for incremental indexing
    file_cache: Arc<RwLock<std::collections::HashMap<String, std::time::SystemTime>>>,
    // Progress tracking
    pub progress: Arc<IndexProgress>,
    // Track if reader needs reload (set after writes, cleared after reload)
    // This avoids unnecessary reader.reload() calls on every query
    needs_reload: AtomicBool,
}

impl SearchIndex {
    /// Conditionally reload reader only if index has been modified since last reload
    /// Returns Ok(true) if reload happened, Ok(false) if skipped
    fn reload_if_needed(&self) -> Result<bool, String> {
        if self.needs_reload.swap(false, Ordering::AcqRel) {
            self.reader.reload().map_err(|e| e.to_string())?;
            Ok(true)
        } else {
            Ok(false)
        }
    }

    /// Force reload the reader (for cases where we always need fresh data)
    fn force_reload(&self) -> Result<(), String> {
        self.needs_reload.store(false, Ordering::Release);
        self.reader.reload().map_err(|e| e.to_string())
    }

    /// Clean up any stale lock files that may have been synced from another device
    /// This is critical for NAS/cloud sync scenarios where lock files persist incorrectly
    fn cleanup_stale_locks(index_dir: &Path) {
        // Remove Tantivy writer lock file
        let lock_file = index_dir.join(".tantivy-writer.lock");
        if lock_file.exists() {
            log::warn!("Removing stale Tantivy lock file (likely from cloud sync): {:?}", lock_file);
            if let Err(e) = fs::remove_file(&lock_file) {
                log::error!("Failed to remove lock file: {}", e);
            }
        }

        // Also check for any .lock files that might exist
        if let Ok(entries) = fs::read_dir(index_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if let Some(ext) = path.extension() {
                    if ext == "lock" {
                        log::warn!("Removing stale lock file: {:?}", path);
                        let _ = fs::remove_file(&path);
                    }
                }
            }
        }
    }

    /// Get the local index directory path (outside of synced folders)
    /// This prevents NAS/cloud sync (Synology Drive) from locking index files
    /// Made public for use by clear_search_index command
    pub fn get_index_dir(vault_path: &str) -> PathBuf {
        // Create a unique hash of the vault path to identify the index
        use std::collections::hash_map::DefaultHasher;
        use std::hash::{Hash, Hasher};

        let mut hasher = DefaultHasher::new();
        vault_path.to_lowercase().hash(&mut hasher);
        let vault_hash = hasher.finish();

        // Use local app data directory (not synced)
        #[cfg(target_os = "windows")]
        {
            if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
                return PathBuf::from(local_app_data)
                    .join("Notology")
                    .join("indices")
                    .join(format!("{:016x}", vault_hash));
            }
        }

        #[cfg(target_os = "macos")]
        {
            if let Ok(home) = std::env::var("HOME") {
                return PathBuf::from(home)
                    .join("Library")
                    .join("Application Support")
                    .join("Notology")
                    .join("indices")
                    .join(format!("{:016x}", vault_hash));
            }
        }

        #[cfg(target_os = "linux")]
        {
            if let Ok(home) = std::env::var("HOME") {
                return PathBuf::from(home)
                    .join(".local")
                    .join("share")
                    .join("notology")
                    .join("indices")
                    .join(format!("{:016x}", vault_hash));
            }
        }

        // Fallback: use a temp directory (still outside sync)
        std::env::temp_dir()
            .join("notology")
            .join("indices")
            .join(format!("{:016x}", vault_hash))
    }

    /// Read index metadata from disk
    fn read_metadata(index_dir: &Path) -> Option<IndexMetadata> {
        let metadata_path = index_dir.join("notology_meta.json");
        if let Ok(content) = fs::read_to_string(&metadata_path) {
            serde_json::from_str(&content).ok()
        } else {
            None
        }
    }

    /// Write index metadata to disk
    fn write_metadata(index_dir: &Path, metadata: &IndexMetadata) -> Result<(), String> {
        let metadata_path = index_dir.join("notology_meta.json");
        let content = serde_json::to_string_pretty(metadata)
            .map_err(|e| format!("Failed to serialize metadata: {}", e))?;
        let mut file = fs::File::create(&metadata_path)
            .map_err(|e| format!("Failed to create metadata file: {}", e))?;
        file.write_all(content.as_bytes())
            .map_err(|e| format!("Failed to write metadata: {}", e))?;
        file.sync_all()
            .map_err(|e| format!("Failed to sync metadata: {}", e))?;
        Ok(())
    }

    /// Check if index needs regeneration (version mismatch, corruption, etc.)
    fn needs_regeneration(index_dir: &Path, vault_path: &str) -> bool {
        // If directory doesn't exist, no need to regenerate (will be created fresh)
        if !index_dir.exists() {
            return false;
        }

        // Check if meta.json exists but segment files are missing (corrupted index).
        // Tantivy panics (poisoning global LazyLock) if meta.json references non-existent segments.
        let tantivy_meta = index_dir.join("meta.json");
        if tantivy_meta.exists() {
            let has_segment_files = fs::read_dir(index_dir)
                .map(|entries| {
                    entries.flatten().any(|e| {
                        let name = e.file_name();
                        let name = name.to_string_lossy();
                        // Tantivy segment files have UUIDs and extensions like .store, .fast, .idx, etc.
                        name.contains('.') && !name.starts_with('.') && name != "meta.json"
                            && !name.starts_with("notology_") && !name.ends_with(".lock")
                    })
                })
                .unwrap_or(false);

            if !has_segment_files {
                log::warn!("[SearchIndex] meta.json exists but no segment files found (corrupted). Regenerating...");
                return true;
            }
        }

        // Check metadata
        match Self::read_metadata(index_dir) {
            Some(metadata) => {
                if !metadata.is_compatible() {
                    log::warn!(
                        "[SearchIndex] Schema version mismatch: index={}, current={}. Regenerating...",
                        metadata.schema_version, SCHEMA_VERSION
                    );
                    return true;
                }
                // Verify vault path matches (case-insensitive on Windows)
                let stored_path = metadata.vault_path.to_lowercase();
                let current_path = vault_path.to_lowercase();
                if stored_path != current_path {
                    log::warn!(
                        "[SearchIndex] Vault path mismatch: stored={}, current={}. Regenerating...",
                        metadata.vault_path, vault_path
                    );
                    return true;
                }
                false
            }
            None => {
                // No metadata = old or corrupted index, regenerate
                log::warn!("[SearchIndex] No metadata found (old/corrupted index). Regenerating...");
                true
            }
        }
    }

    /// Force delete index directory for regeneration
    fn force_delete_index(index_dir: &Path) {
        log::info!("[SearchIndex] Force deleting index for regeneration: {:?}", index_dir);

        const MAX_ATTEMPTS: u32 = 5;
        const DELAY_MS: u64 = 200;

        for attempt in 1..=MAX_ATTEMPTS {
            // Try to remove individual files first
            if let Ok(entries) = fs::read_dir(index_dir) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.is_file() {
                        let _ = fs::remove_file(&path);
                    }
                }
            }

            // Then try to remove the directory
            match fs::remove_dir_all(index_dir) {
                Ok(_) => {
                    log::info!("[SearchIndex] Successfully deleted index directory");
                    return;
                }
                Err(e) => {
                    if attempt < MAX_ATTEMPTS {
                        log::warn!(
                            "[SearchIndex] Delete attempt {}/{} failed: {}. Retrying...",
                            attempt, MAX_ATTEMPTS, e
                        );
                        std::thread::sleep(std::time::Duration::from_millis(DELAY_MS));
                    } else {
                        log::error!("[SearchIndex] Failed to delete index after {} attempts: {}", MAX_ATTEMPTS, e);
                    }
                }
            }
        }
    }

    pub fn new(vault_path: &str) -> Result<Self, String> {
        let vault = PathBuf::from(vault_path);

        // Use local directory for index (outside synced folder to avoid NAS/cloud sync conflicts)
        let index_dir = Self::get_index_dir(vault_path);
        log::info!(
            "[SearchIndex] Using local index directory (outside sync): {:?} for vault: {}",
            index_dir, vault_path
        );

        // Check if index needs regeneration due to version mismatch or corruption
        if Self::needs_regeneration(&index_dir, vault_path) {
            Self::force_delete_index(&index_dir);
            // If deletion failed (directory still exists), force-remove remaining files
            // to prevent opening a corrupted/incompatible index
            if index_dir.exists() {
                log::warn!("[SearchIndex] Index directory still exists after force_delete, cleaning up remaining files...");
                if let Ok(entries) = fs::read_dir(&index_dir) {
                    for entry in entries.flatten() {
                        let _ = fs::remove_file(entry.path());
                    }
                }
            }
        }

        if !index_dir.exists() {
            fs::create_dir_all(&index_dir).map_err(|e| e.to_string())?;
        }

        // CRITICAL: Clean up stale lock files before opening index
        // This handles the case where lock files were synced from another device
        Self::cleanup_stale_locks(&index_dir);

        // Build schema
        let mut schema_builder = Schema::builder();

        // Text options with positions for phrase queries and highlighting
        let text_options_stored = TextOptions::default()
            .set_indexing_options(
                TextFieldIndexing::default()
                    .set_tokenizer("cjk")
                    .set_index_option(IndexRecordOption::WithFreqsAndPositions)
            )
            .set_stored();

        let string_options = TextOptions::default()
            .set_indexing_options(TextFieldIndexing::default().set_tokenizer("raw"))
            .set_stored();

        let f_path = schema_builder.add_text_field("path", STRING | STORED);
        let f_title = schema_builder.add_text_field("title", text_options_stored.clone());
        let f_body = schema_builder.add_text_field("body", text_options_stored.clone());
        let f_tags = schema_builder.add_text_field("tags", string_options.clone());
        let f_note_type = schema_builder.add_text_field("note_type", string_options.clone());
        let f_created = schema_builder.add_text_field("created", string_options.clone());
        let f_modified = schema_builder.add_text_field("modified", string_options.clone());
        let f_wiki_links = schema_builder.add_text_field("wiki_links", string_options);
        let f_frontmatter_raw = schema_builder.add_text_field("frontmatter_raw", STORED);

        let schema = schema_builder.build();

        // Helper function to check if an error indicates corruption that requires index recreation
        fn is_corruption_error(err_str: &str) -> bool {
            let lower = err_str.to_lowercase();
            lower.contains("incompatible")
                || lower.contains("mismatch")
                || lower.contains("corrupt")
                || lower.contains("invalid")
                || lower.contains("damaged")
                || lower.contains("lock")
                || lower.contains("permission")
                || lower.contains("access denied")
                || lower.contains("being used")
                || lower.contains("footer")
                || lower.contains("magic")
                || lower.contains("ioerror")
                || lower.contains("assertion")
                || lower.contains("panic")
        }

        // Helper function to recreate index from scratch with aggressive cleanup for NAS/cloud sync
        fn recreate_index(index_dir: &Path, schema: &Schema) -> Result<Index, String> {
            log::warn!("Recreating index from scratch due to corruption...");

            // Aggressive cleanup with retries for NAS/cloud sync scenarios (Synology Drive)
            const MAX_CLEANUP_ATTEMPTS: u32 = 5;
            const CLEANUP_DELAY_MS: u64 = 200;

            for attempt in 1..=MAX_CLEANUP_ATTEMPTS {
                // First try to remove individual files (more granular than remove_dir_all)
                if index_dir.exists() {
                    if let Ok(entries) = fs::read_dir(index_dir) {
                        for entry in entries.flatten() {
                            let path = entry.path();
                            if path.is_file() {
                                if let Err(e) = fs::remove_file(&path) {
                                    log::warn!("Attempt {}: Failed to remove {:?}: {}", attempt, path, e);
                                }
                            }
                        }
                    }

                    // Then try to remove the directory itself
                    if let Err(e) = fs::remove_dir_all(index_dir) {
                        if attempt < MAX_CLEANUP_ATTEMPTS {
                            log::warn!(
                                "Attempt {}/{}: Failed to remove index dir (NAS sync may be locking files): {}. Retrying in {}ms...",
                                attempt, MAX_CLEANUP_ATTEMPTS, e, CLEANUP_DELAY_MS
                            );
                            std::thread::sleep(std::time::Duration::from_millis(CLEANUP_DELAY_MS));
                            continue;
                        } else {
                            log::error!("Failed to remove corrupted index after {} attempts: {}", MAX_CLEANUP_ATTEMPTS, e);
                            // Continue anyway - Tantivy might be able to overwrite
                        }
                    }
                }
                break;
            }

            // Small delay to let filesystem settle (important for NAS)
            std::thread::sleep(std::time::Duration::from_millis(100));

            fs::create_dir_all(index_dir).map_err(|e| e.to_string())?;
            Index::create_in_dir(index_dir, schema.clone()).map_err(|e| e.to_string())
        }

        // Open or create index with full recovery: handles corruption at any stage
        // (index open, reader creation, writer creation)
        let max_recovery_attempts = 3;
        let mut recovery_attempt = 0;

        let (index, reader, writer) = loop {
            recovery_attempt += 1;

            // Step 1: Open or create index
            let index_result: Result<Index, String> = if index_dir.join("meta.json").exists() {
                match Index::open_in_dir(&index_dir) {
                    Ok(idx) => Ok(idx),
                    Err(e) => {
                        let err_str = e.to_string();
                        if is_corruption_error(&err_str) {
                            log::warn!("Index open failed due to corruption ({}), recreating...", e);
                            recreate_index(&index_dir, &schema)
                        } else {
                            Err(format!("Failed to open index: {}", e))
                        }
                    }
                }
            } else {
                Index::create_in_dir(&index_dir, schema.clone()).map_err(|e| e.to_string())
            };

            let index = match index_result {
                Ok(idx) => idx,
                Err(e) => {
                    if recovery_attempt >= max_recovery_attempts {
                        return Err(format!("Failed to initialize index after {} attempts: {}", max_recovery_attempts, e));
                    }
                    log::warn!("Index creation failed (attempt {}/{}): {}", recovery_attempt, max_recovery_attempts, e);
                    std::thread::sleep(std::time::Duration::from_millis(100));
                    continue;
                }
            };

            // Register CJK tokenizer
            let tokenizer_manager = index.tokenizers();
            tokenizer_manager.register("cjk", CjkTokenizer);

            // Step 2: Create reader (this can fail if segment files are corrupted)
            let reader_result = index
                .reader_builder()
                .reload_policy(ReloadPolicy::Manual)
                .try_into();

            let reader: IndexReader = match reader_result {
                Ok(r) => r,
                Err(e) => {
                    let err_str = e.to_string();
                    if is_corruption_error(&err_str) && recovery_attempt < max_recovery_attempts {
                        log::warn!("Reader creation failed due to corruption ({}), recreating index...", e);
                        if let Err(recreate_err) = recreate_index(&index_dir, &schema) {
                            log::error!("Failed to recreate index: {}", recreate_err);
                        }
                        continue;
                    }
                    return Err(format!("Failed to create index reader: {}", e));
                }
            };

            // Step 3: Create writer
            let lock_file = index_dir.join(".tantivy-writer.lock");
            if lock_file.exists() {
                log::warn!("Removing stale writer lock file");
                let _ = fs::remove_file(&lock_file);
            }

            let writer_result = index.writer(50_000_000);
            let writer = match writer_result {
                Ok(w) => w,
                Err(e) => {
                    let err_str = e.to_string();
                    if is_corruption_error(&err_str) && recovery_attempt < max_recovery_attempts {
                        log::warn!("Writer creation failed due to corruption ({}), recreating index...", e);
                        if let Err(recreate_err) = recreate_index(&index_dir, &schema) {
                            log::error!("Failed to recreate index: {}", recreate_err);
                        }
                        continue;
                    }
                    // Try removing lock and retrying once more
                    if err_str.to_lowercase().contains("lock") {
                        let _ = fs::remove_file(&lock_file);
                        if let Ok(w) = index.writer(50_000_000) {
                            break (index, reader, w);
                        }
                    }
                    return Err(format!("Failed to create index writer: {}", e));
                }
            };

            // All components created successfully
            break (index, reader, writer);
        };

        // Write metadata for version tracking (enables auto-regeneration on version change)
        let metadata = IndexMetadata::new(vault_path);
        if let Err(e) = Self::write_metadata(&index_dir, &metadata) {
            log::warn!("[SearchIndex] Failed to write metadata (non-fatal): {}", e);
        } else {
            log::info!(
                "[SearchIndex] Index initialized successfully (schema_version={}, app_version={})",
                metadata.schema_version, metadata.app_version
            );
        }

        Ok(SearchIndex {
            index,
            reader,
            writer: Arc::new(Mutex::new(writer)),
            _schema: schema,
            vault_path: vault,
            f_path,
            f_title,
            f_body,
            f_tags,
            f_note_type,
            f_created,
            f_modified,
            f_wiki_links,
            f_frontmatter_raw,
            file_cache: Arc::new(RwLock::new(std::collections::HashMap::new())),
            progress: Arc::new(IndexProgress::default()),
            needs_reload: AtomicBool::new(false),
        })
    }

    /// Index a single markdown file with retry logic for NAS/cloud sync environments
    pub fn index_file(&self, path: &Path) -> Result<(), String> {
        const MAX_RETRIES: u32 = 3;
        const RETRY_DELAY_MS: u64 = 100;

        for attempt in 1..=MAX_RETRIES {
            match self.index_file_internal(path) {
                Ok(()) => return Ok(()),
                Err(e) => {
                    let is_permission_error = e.to_lowercase().contains("permission")
                        || e.to_lowercase().contains("access")
                        || e.to_lowercase().contains("denied")
                        || e.to_lowercase().contains("ioerror");

                    if is_permission_error && attempt < MAX_RETRIES {
                        log::warn!(
                            "[index_file] Attempt {}/{} failed for {:?}: {}. Retrying in {}ms...",
                            attempt, MAX_RETRIES, path, e, RETRY_DELAY_MS
                        );
                        std::thread::sleep(std::time::Duration::from_millis(RETRY_DELAY_MS));
                    } else {
                        log::error!("[index_file] Failed after {} attempts for {:?}: {}", attempt, path, e);
                        return Err(e);
                    }
                }
            }
        }
        Err("Index failed after max retries".to_string())
    }

    /// Internal index function (called by index_file with retry)
    fn index_file_internal(&self, path: &Path) -> Result<(), String> {
        log::debug!("[index_file] Starting indexing: {:?}", path);
        let content = fs::read_to_string(path).map_err(|e| e.to_string())?;
        let file_name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();

        let (fm_raw, body) = split_frontmatter_body(&content);
        let frontmatter = fm_raw
            .as_ref()
            .map(|raw| parse_frontmatter(raw))
            .unwrap_or_default();

        let title = extract_title(&frontmatter, &file_name);
        let tags = extract_tags(&frontmatter);
        let note_type = extract_note_type(&frontmatter);
        let created = extract_date_field(&frontmatter, "created");
        let modified = extract_date_field(&frontmatter, "modified");
        let wiki_links = extract_wiki_links(&content);

        let path_str = path.to_string_lossy().to_string();

        // Extract searchable text from body (handles SKETCH canvas nodes)
        let raw_body = if note_type.to_uppercase() == "SKETCH" {
            Self::extract_canvas_text(&body)
        } else {
            body.clone()
        };
        let searchable_body = strip_markdown_formatting(&raw_body);

        // Remove existing document for this path (try both original and lowercase variants on Windows)
        let mut writer = self.writer.lock().map_err(|e| e.to_string())?;
        let path_term = tantivy::Term::from_field_text(self.f_path, &path_str);
        writer.delete_term(path_term);

        // Also delete lowercase variant on Windows to clean up old duplicates
        if cfg!(windows) {
            let path_lower = path_str.to_lowercase();
            if path_lower != path_str {
                let path_term_lower = tantivy::Term::from_field_text(self.f_path, &path_lower);
                writer.delete_term(path_term_lower);
            }
        }

        // Build document
        let mut doc = TantivyDocument::new();
        doc.add_text(self.f_path, &path_str);
        doc.add_text(self.f_title, &title);
        doc.add_text(self.f_body, &searchable_body);
        doc.add_text(self.f_note_type, &note_type);
        doc.add_text(self.f_created, &created);
        doc.add_text(self.f_modified, &modified);
        doc.add_text(self.f_frontmatter_raw, fm_raw.as_deref().unwrap_or(""));

        for tag in &tags {
            doc.add_text(self.f_tags, tag);
        }
        for link in &wiki_links {
            doc.add_text(self.f_wiki_links, link);
        }

        writer.add_document(doc).map_err(|e| e.to_string())?;
        writer.commit().map_err(|e| e.to_string())?;
        log::info!("[index_file] Committed to index: {:?}", path);

        // Drop the writer lock before reloading to prevent blocking
        drop(writer);

        // Force reload to ensure changes are immediately visible
        // Note: commit() already does fsync internally, so no additional sleep needed
        self.force_reload()?;

        // Verify the document count after reload
        let searcher = self.reader.searcher();
        let doc_count = searcher.num_docs();
        log::info!("[index_file] Reader reloaded for: {:?}, total docs: {}", path, doc_count);

        Ok(())
    }

    /// Remove a file from the index
    pub fn remove_file(&self, path: &Path) -> Result<(), String> {
        log::debug!("[remove_file] Removing from index: {:?}", path);
        let path_str = path.to_string_lossy().to_string();
        let mut writer = self.writer.lock().map_err(|e| e.to_string())?;
        let path_term = tantivy::Term::from_field_text(self.f_path, &path_str);
        writer.delete_term(path_term);

        // Handle forward/backslash mismatch (JS may use "/" while watcher uses "\")
        let path_backslash = path_str.replace('/', "\\");
        if path_backslash != path_str {
            let term = tantivy::Term::from_field_text(self.f_path, &path_backslash);
            writer.delete_term(term);
        }
        let path_forward = path_str.replace('\\', "/");
        if path_forward != path_str {
            let term = tantivy::Term::from_field_text(self.f_path, &path_forward);
            writer.delete_term(term);
        }

        // Also delete lowercase variant on Windows to clean up old duplicates
        if cfg!(windows) {
            let path_lower = path_str.to_lowercase();
            if path_lower != path_str {
                let path_term_lower = tantivy::Term::from_field_text(self.f_path, &path_lower);
                writer.delete_term(path_term_lower);
            }
        }

        writer.commit().map_err(|e| e.to_string())?;

        // Force reload to ensure removal is immediately visible
        self.force_reload()?;
        log::debug!("[remove_file] Removed and reader reloaded: {:?}", path);

        Ok(())
    }

    /// Reindex all markdown files in the vault (parallel batch operation)
    /// Optimized for 10,000-100,000 notes
    pub fn full_reindex(&self) -> Result<(), String> {
        // Mark progress as running
        self.progress.is_running.store(true, Ordering::SeqCst);
        self.progress.completed.store(0, Ordering::SeqCst);

        // Phase 1: Parallel file collection using walkdir (much faster than recursive read_dir)
        let paths = self.collect_md_files_parallel();
        let total_files = paths.len();
        self.progress.total.store(total_files, Ordering::SeqCst);

        log::info!("Starting parallel reindex of {} files", total_files);

        // Phase 2: Parallel file parsing (CPU-bound, benefits greatly from parallelization)
        let progress = Arc::clone(&self.progress);
        let parsed_docs: Vec<ParsedDocument> = paths
            .par_iter()
            .filter_map(|path| {
                let result = Self::parse_file_for_index(path);
                progress.completed.fetch_add(1, Ordering::Relaxed);
                result.ok()
            })
            .collect();

        log::info!("Parsed {} documents in parallel", parsed_docs.len());

        // Phase 3: Sequential write to index (Tantivy writer is not thread-safe)
        let mut writer = self.writer.lock().map_err(|e| e.to_string())?;
        writer.delete_all_documents().map_err(|e| e.to_string())?;

        // Build and add documents (this is fast since parsing is already done)
        for doc_data in &parsed_docs {
            let mut doc = TantivyDocument::new();
            doc.add_text(self.f_path, &doc_data.path);
            doc.add_text(self.f_title, &doc_data.title);
            doc.add_text(self.f_body, &doc_data.body);
            doc.add_text(self.f_note_type, &doc_data.note_type);
            doc.add_text(self.f_created, &doc_data.created);
            doc.add_text(self.f_modified, &doc_data.modified);
            doc.add_text(self.f_frontmatter_raw, &doc_data.frontmatter_raw);

            for tag in &doc_data.tags {
                doc.add_text(self.f_tags, tag);
            }
            for link in &doc_data.wiki_links {
                doc.add_text(self.f_wiki_links, link);
            }

            if let Err(e) = writer.add_document(doc) {
                log::warn!("Failed to add document {}: {}", doc_data.path, e);
            }
        }

        // Single commit for all changes
        writer.commit().map_err(|e| e.to_string())?;

        // Update file cache for incremental indexing
        let mut cache = self.file_cache.write().map_err(|e| e.to_string())?;
        cache.clear();
        for path in &paths {
            if let Ok(metadata) = fs::metadata(path) {
                if let Ok(modified) = metadata.modified() {
                    cache.insert(path.to_string_lossy().to_string(), modified);
                }
            }
        }

        // Force reload reader after full reindex
        self.force_reload()?;

        self.progress.is_running.store(false, Ordering::SeqCst);
        log::info!("Full reindex completed: {} files indexed", parsed_docs.len());

        Ok(())
    }

    /// Incremental reindex - only update changed files (for large vaults)
    pub fn incremental_reindex(&self) -> Result<usize, String> {
        self.progress.is_running.store(true, Ordering::SeqCst);

        // Collect all current files
        let paths = self.collect_md_files_parallel();
        let cache = self.file_cache.read().map_err(|e| e.to_string())?;

        // Find files that need updating
        let files_to_update: Vec<PathBuf> = paths
            .par_iter()
            .filter(|path| {
                let path_str = path.to_string_lossy().to_string();
                if let Ok(metadata) = fs::metadata(path) {
                    if let Ok(modified) = metadata.modified() {
                        // Check if file is new or modified
                        if let Some(cached_time) = cache.get(&path_str) {
                            return modified > *cached_time;
                        }
                        return true; // New file
                    }
                }
                false
            })
            .cloned()
            .collect();

        drop(cache);

        let update_count = files_to_update.len();
        if update_count == 0 {
            self.progress.is_running.store(false, Ordering::SeqCst);
            return Ok(0);
        }

        self.progress.total.store(update_count, Ordering::SeqCst);
        self.progress.completed.store(0, Ordering::SeqCst);

        log::info!("Incremental reindex: {} files changed", update_count);

        // Parse changed files in parallel
        let progress = Arc::clone(&self.progress);
        let parsed_docs: Vec<ParsedDocument> = files_to_update
            .par_iter()
            .filter_map(|path| {
                let result = Self::parse_file_for_index(path);
                progress.completed.fetch_add(1, Ordering::Relaxed);
                result.ok()
            })
            .collect();

        // Update index
        let mut writer = self.writer.lock().map_err(|e| e.to_string())?;

        for doc_data in &parsed_docs {
            // Delete old version
            let path_term = tantivy::Term::from_field_text(self.f_path, &doc_data.path);
            writer.delete_term(path_term);

            // Add new version
            let mut doc = TantivyDocument::new();
            doc.add_text(self.f_path, &doc_data.path);
            doc.add_text(self.f_title, &doc_data.title);
            doc.add_text(self.f_body, &doc_data.body);
            doc.add_text(self.f_note_type, &doc_data.note_type);
            doc.add_text(self.f_created, &doc_data.created);
            doc.add_text(self.f_modified, &doc_data.modified);
            doc.add_text(self.f_frontmatter_raw, &doc_data.frontmatter_raw);

            for tag in &doc_data.tags {
                doc.add_text(self.f_tags, tag);
            }
            for link in &doc_data.wiki_links {
                doc.add_text(self.f_wiki_links, link);
            }

            let _ = writer.add_document(doc);
        }

        writer.commit().map_err(|e| e.to_string())?;

        // Update cache
        let mut cache = self.file_cache.write().map_err(|e| e.to_string())?;
        for path in &files_to_update {
            if let Ok(metadata) = fs::metadata(path) {
                if let Ok(modified) = metadata.modified() {
                    cache.insert(path.to_string_lossy().to_string(), modified);
                }
            }
        }

        // Force reload after incremental reindex
        self.force_reload()?;
        self.progress.is_running.store(false, Ordering::SeqCst);

        Ok(update_count)
    }

    /// File collection using walkdir with filter_entry + dedup (avoids par_bridge duplicates)
    fn collect_md_files_parallel(&self) -> Vec<PathBuf> {
        let mut seen = std::collections::HashSet::new();
        WalkDir::new(&self.vault_path)
            .into_iter()
            .filter_entry(|entry| {
                let name = entry.file_name().to_string_lossy();
                !name.starts_with('.') && !name.ends_with("_att")
            })
            .filter_map(|entry| entry.ok())
            .filter(|entry| {
                let path = entry.path();
                let name = entry.file_name().to_string_lossy();
                path.is_file() && name.ends_with(".md")
            })
            .filter_map(|entry| {
                let path = entry.into_path();
                let key = path.to_string_lossy().to_lowercase();
                if seen.insert(key) { Some(path) } else { None }
            })
            .collect()
    }

    /// Parse a file into a ParsedDocument (CPU-bound, good for parallelization)
    fn parse_file_for_index(path: &Path) -> Result<ParsedDocument, String> {
        let content = fs::read_to_string(path).map_err(|e| e.to_string())?;
        let file_name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();

        let (fm_raw, body) = split_frontmatter_body(&content);
        let frontmatter = fm_raw
            .as_ref()
            .map(|raw| parse_frontmatter(raw))
            .unwrap_or_default();

        let title = extract_title(&frontmatter, &file_name);
        let tags = extract_tags(&frontmatter);
        let note_type = extract_note_type(&frontmatter);
        let created = extract_date_field(&frontmatter, "created");
        let modified = extract_date_field(&frontmatter, "modified");
        let wiki_links = extract_wiki_links(&content);

        let path_str = path.to_string_lossy().to_string();

        // Extract searchable text from body
        let raw_body = if note_type.to_uppercase() == "SKETCH" {
            Self::extract_canvas_text(&body)
        } else {
            body
        };
        let searchable_body = strip_markdown_formatting(&raw_body);

        Ok(ParsedDocument {
            path: path_str,
            title,
            body: searchable_body,
            tags,
            note_type,
            created,
            modified,
            wiki_links,
            frontmatter_raw: fm_raw.unwrap_or_default(),
        })
    }

    /// Legacy collect method for compatibility
    #[allow(dead_code)]
    fn collect_md_files(dir: &Path, files: &mut Vec<PathBuf>) {
        let entries = match fs::read_dir(dir) {
            Ok(e) => e,
            Err(_) => return,
        };

        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();

            // Skip hidden files/dirs and attachment folders
            if name.starts_with('.') || name.ends_with("_att") {
                continue;
            }

            if path.is_dir() {
                Self::collect_md_files(&path, files);
            } else if name.ends_with(".md") {
                files.push(path);
            }
        }
    }

    /// Index a single file using a provided writer reference (no commit)
    #[allow(dead_code)]
    fn index_file_batch(&self, writer: &mut IndexWriter, path: &Path) -> Result<(), String> {
        let content = fs::read_to_string(path).map_err(|e| e.to_string())?;
        let file_name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();

        let (fm_raw, body) = split_frontmatter_body(&content);
        let frontmatter = fm_raw
            .as_ref()
            .map(|raw| parse_frontmatter(raw))
            .unwrap_or_default();

        let title = extract_title(&frontmatter, &file_name);
        let tags = extract_tags(&frontmatter);
        let note_type = extract_note_type(&frontmatter);
        let created = extract_date_field(&frontmatter, "created");
        let modified = extract_date_field(&frontmatter, "modified");
        let wiki_links = extract_wiki_links(&content);

        let path_str = path.to_string_lossy().to_string();

        // Extract searchable text from body
        let searchable_body = if note_type.to_uppercase() == "SKETCH" {
            // For SKETCH notes, extract text from canvas nodes
            Self::extract_canvas_text(&body)
        } else {
            body.clone()
        };

        // Build document
        let mut doc = TantivyDocument::new();
        doc.add_text(self.f_path, &path_str);
        doc.add_text(self.f_title, &title);
        doc.add_text(self.f_body, &searchable_body);
        doc.add_text(self.f_note_type, &note_type);
        doc.add_text(self.f_created, &created);
        doc.add_text(self.f_modified, &modified);
        doc.add_text(self.f_frontmatter_raw, fm_raw.as_deref().unwrap_or(""));

        for tag in &tags {
            doc.add_text(self.f_tags, tag);
        }
        for link in &wiki_links {
            doc.add_text(self.f_wiki_links, link);
        }

        writer.add_document(doc).map_err(|e| e.to_string())?;

        Ok(())
    }

    /// Extract text from canvas nodes in SKETCH notes
    fn extract_canvas_text(body: &str) -> String {
        use serde_json::Value;

        // Try to parse as JSON
        if let Ok(json) = serde_json::from_str::<Value>(body) {
            if let Some(nodes) = json.get("nodes").and_then(|v| v.as_array()) {
                let mut texts = Vec::new();
                for node in nodes {
                    if let Some(text) = node.get("text").and_then(|v| v.as_str()) {
                        if !text.trim().is_empty() {
                            texts.push(text.trim().to_string());
                        }
                    }
                }
                return texts.join(" ");
            }
        }

        // If not valid JSON or no nodes, return original body
        body.to_string()
    }

    /// Full-text search across title and body
    pub fn search(&self, query_str: &str, limit: usize) -> Result<Vec<SearchResult>, String> {
        // Conditionally reload reader only if index was modified since last reload
        self.reload_if_needed()?;
        let searcher = self.reader.searcher();
        let query_parser =
            QueryParser::for_index(&self.index, vec![self.f_title, self.f_body]);

        let query = match query_parser.parse_query(query_str) {
            Ok(q) => q,
            Err(_) => return Ok(vec![]), // Invalid query (e.g. "**") → return empty results
        };

        let top_docs = searcher
            .search(&query, &TopDocs::with_limit(limit))
            .map_err(|e| e.to_string())?;

        let mut results = Vec::new();
        for (score, doc_address) in top_docs {
            let doc: TantivyDocument = searcher.doc(doc_address).map_err(|e| e.to_string())?;

            let path = doc
                .get_first(self.f_path)
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let title = doc
                .get_first(self.f_title)
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();

            // Generate snippet from body - extract context around query match
            let body_text = doc
                .get_first(self.f_body)
                .and_then(|v| v.as_str())
                .unwrap_or("");

            let snippet = extract_snippet(body_text, query_str, 150);

            results.push(SearchResult {
                path,
                title,
                snippet,
                score,
            });
        }

        Ok(results)
    }

    /// Query notes by filter criteria (optimized for large vaults with 100k+ notes)
    pub fn query_notes(&self, filter: &NoteFilter) -> Result<Vec<NoteMetadata>, String> {
        // Conditionally reload reader only if index was modified since last reload
        let reloaded = self.reload_if_needed()?;
        let searcher = self.reader.searcher();
        let doc_count = searcher.num_docs();
        if reloaded {
            log::info!("[query_notes] Reader reloaded, total docs in index: {}", doc_count);
        }

        // Build a boolean query from filter
        let mut subqueries: Vec<(Occur, Box<dyn tantivy::query::Query>)> = Vec::new();

        if let Some(ref note_type) = filter.note_type {
            let term = tantivy::Term::from_field_text(self.f_note_type, note_type);
            subqueries.push((Occur::Must, Box::new(TermQuery::new(term, IndexRecordOption::Basic))));
        }

        if let Some(ref tags) = filter.tags {
            for tag in tags {
                let term = tantivy::Term::from_field_text(self.f_tags, tag);
                subqueries.push((Occur::Must, Box::new(TermQuery::new(term, IndexRecordOption::Basic))));
            }
        }

        // If no filters, match all
        let query: Box<dyn tantivy::query::Query> = if subqueries.is_empty() {
            Box::new(tantivy::query::AllQuery)
        } else {
            Box::new(BooleanQuery::new(subqueries))
        };

        // Increase limit for large vaults (100k max)
        let top_docs = searcher
            .search(&query, &TopDocs::with_limit(100_000))
            .map_err(|e| e.to_string())?;

        let doc_count = top_docs.len();

        // For small result sets, use sequential processing
        // For large result sets (>1000), use parallel processing
        let raw_results: Vec<(String, NoteMetadata)> = if doc_count > 1000 {
            // Parallel document extraction
            top_docs
                .par_iter()
                .filter_map(|(_score, doc_address)| {
                    let doc: TantivyDocument = searcher.doc(*doc_address).ok()?;
                    self.extract_note_metadata(&doc, filter)
                })
                .collect()
        } else {
            // Sequential for small result sets (avoid overhead)
            top_docs
                .iter()
                .filter_map(|(_score, doc_address)| {
                    let doc: TantivyDocument = searcher.doc(*doc_address).ok()?;
                    self.extract_note_metadata(&doc, filter)
                })
                .collect()
        };

        // Deduplicate (keep latest modified version for each path)
        let mut path_to_metadata: std::collections::HashMap<String, NoteMetadata> =
            std::collections::HashMap::with_capacity(raw_results.len());

        for (dedup_key, metadata) in raw_results {
            if let Some(existing) = path_to_metadata.get(&dedup_key) {
                if metadata.modified > existing.modified {
                    path_to_metadata.insert(dedup_key, metadata);
                }
            } else {
                path_to_metadata.insert(dedup_key, metadata);
            }
        }

        let mut results: Vec<NoteMetadata> = path_to_metadata.into_values().collect();

        // Parallel sort for large result sets
        let sort_order = filter.sort_order.as_deref().unwrap_or("desc");
        let ascending = sort_order == "asc";

        // Helper: secondary sort by modified when primary values are equal
        // This ensures meaningful ordering even when all primary values are identical
        // (e.g., all notes have same type or all have 0 memos)
        if results.len() > 1000 {
            // Use parallel sort for large result sets
            match filter.sort_by.as_deref() {
                Some("title") => {
                    results.par_sort_by(|a, b| {
                        let cmp = a.title.cmp(&b.title);
                        let cmp = if ascending { cmp } else { cmp.reverse() };
                        if cmp == std::cmp::Ordering::Equal {
                            b.modified.cmp(&a.modified) // newest first as tiebreaker
                        } else { cmp }
                    });
                }
                Some("created") => {
                    results.par_sort_by(|a, b| {
                        let cmp = a.created.cmp(&b.created);
                        if ascending { cmp } else { cmp.reverse() }
                    });
                }
                Some("type") => {
                    results.par_sort_by(|a, b| {
                        let cmp = a.note_type.cmp(&b.note_type);
                        let cmp = if ascending { cmp } else { cmp.reverse() };
                        if cmp == std::cmp::Ordering::Equal {
                            b.modified.cmp(&a.modified)
                        } else { cmp }
                    });
                }
                Some("memo") => {
                    results.par_sort_by(|a, b| {
                        let cmp = a.comment_count.cmp(&b.comment_count);
                        let cmp = if ascending { cmp } else { cmp.reverse() };
                        if cmp == std::cmp::Ordering::Equal {
                            b.modified.cmp(&a.modified)
                        } else { cmp }
                    });
                }
                _ => {
                    results.par_sort_by(|a, b| {
                        let cmp = a.modified.cmp(&b.modified);
                        if ascending { cmp } else { cmp.reverse() }
                    });
                }
            }
        } else {
            // Sequential sort for small result sets
            match filter.sort_by.as_deref() {
                Some("title") => {
                    results.sort_by(|a, b| {
                        let cmp = a.title.cmp(&b.title);
                        let cmp = if ascending { cmp } else { cmp.reverse() };
                        if cmp == std::cmp::Ordering::Equal {
                            b.modified.cmp(&a.modified)
                        } else { cmp }
                    });
                }
                Some("created") => {
                    results.sort_by(|a, b| {
                        let cmp = a.created.cmp(&b.created);
                        if ascending { cmp } else { cmp.reverse() }
                    });
                }
                Some("type") => {
                    results.sort_by(|a, b| {
                        let cmp = a.note_type.cmp(&b.note_type);
                        let cmp = if ascending { cmp } else { cmp.reverse() };
                        if cmp == std::cmp::Ordering::Equal {
                            b.modified.cmp(&a.modified)
                        } else { cmp }
                    });
                }
                Some("memo") => {
                    results.sort_by(|a, b| {
                        let cmp = a.comment_count.cmp(&b.comment_count);
                        let cmp = if ascending { cmp } else { cmp.reverse() };
                        if cmp == std::cmp::Ordering::Equal {
                            b.modified.cmp(&a.modified)
                        } else { cmp }
                    });
                }
                _ => {
                    results.sort_by(|a, b| {
                        let cmp = a.modified.cmp(&b.modified);
                        if ascending { cmp } else { cmp.reverse() }
                    });
                }
            }
        }

        log::info!("[query_notes] Returning {} results (from {} total docs)", results.len(), doc_count);
        Ok(results)
    }

    /// Extract NoteMetadata from a Tantivy document with filter application
    fn extract_note_metadata(&self, doc: &TantivyDocument, filter: &NoteFilter) -> Option<(String, NoteMetadata)> {
        let path = doc.get_first(self.f_path).and_then(|v| v.as_str()).unwrap_or("").to_string();
        let title = doc.get_first(self.f_title).and_then(|v| v.as_str()).unwrap_or("").to_string();
        let note_type = doc.get_first(self.f_note_type).and_then(|v| v.as_str()).unwrap_or("NOTE").to_string();
        let created = doc.get_first(self.f_created).and_then(|v| v.as_str()).unwrap_or("").to_string();
        let modified = doc.get_first(self.f_modified).and_then(|v| v.as_str()).unwrap_or("").to_string();

        // Apply date filters
        if let Some(ref after) = filter.created_after {
            if created < *after {
                return None;
            }
        }
        if let Some(ref before) = filter.created_before {
            if created > *before {
                return None;
            }
        }
        if let Some(ref after) = filter.modified_after {
            if modified < *after {
                return None;
            }
        }
        if let Some(ref before) = filter.modified_before {
            if modified > *before {
                return None;
            }
        }

        // Collect all tags
        let tags: Vec<String> = doc
            .get_all(self.f_tags)
            .filter_map(|v| v.as_str().map(|s| s.to_string()))
            .collect();

        // Check if body exists and is not empty
        let body = doc.get_first(self.f_body).and_then(|v| v.as_str()).unwrap_or("");
        let has_body = !body.trim().is_empty();

        // Count comments from note_att/comments.json
        let comment_count = Self::count_comments(&path);

        let metadata = NoteMetadata {
            path: path.clone(),
            title,
            note_type,
            tags,
            created,
            modified,
            has_body,
            comment_count,
        };

        // Use lowercase path as key on Windows for case-insensitive deduplication
        let dedup_key = if cfg!(windows) {
            path.to_lowercase()
        } else {
            path
        };

        Some((dedup_key, metadata))
    }

    /// Get comment count for a specific note (call separately for performance)
    #[allow(dead_code)]
    pub fn get_comment_count(&self, note_path: &str) -> usize {
        Self::count_comments(note_path)
    }

    /// Get relationships (incoming/outgoing links) for a file
    pub fn get_relationships(&self, file_path: &str) -> Result<RelationshipData, String> {
        let searcher = self.reader.searcher();

        // Get outgoing links for this file
        let path_term = tantivy::Term::from_field_text(self.f_path, file_path);
        let path_query = TermQuery::new(path_term, IndexRecordOption::Basic);

        let top_docs = searcher
            .search(&path_query, &TopDocs::with_limit(1))
            .map_err(|e| e.to_string())?;

        let mut outgoing_links = Vec::new();
        let mut file_name = String::new();

        if let Some((_score, doc_address)) = top_docs.first() {
            let doc: TantivyDocument = searcher.doc(*doc_address).map_err(|e| e.to_string())?;

            // Get the file name for incoming link search
            let path = doc.get_first(self.f_path).and_then(|v| v.as_str()).unwrap_or("");
            file_name = Path::new(path)
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default();

            // Collect outgoing wiki links
            let links: Vec<String> = doc
                .get_all(self.f_wiki_links)
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect();

            // Resolve each outgoing link
            for link_name in &links {
                if let Some(link_info) = self.resolve_link(&searcher, link_name)? {
                    outgoing_links.push(link_info);
                }
            }
        }

        // Get incoming links (files that link to this file)
        let incoming_links = if !file_name.is_empty() {
            self.find_incoming_links(&searcher, &file_name, file_path)?
        } else {
            Vec::new()
        };

        Ok(RelationshipData {
            outgoing_links,
            incoming_links,
        })
    }

    fn resolve_link(
        &self,
        searcher: &tantivy::Searcher,
        link_name: &str,
    ) -> Result<Option<LinkInfo>, String> {
        // Search for a file whose title matches the link name
        let query_parser = QueryParser::for_index(&self.index, vec![self.f_title]);
        let query = query_parser
            .parse_query(&format!("\"{}\"", link_name))
            .map_err(|e| e.to_string())?;

        let top_docs = searcher
            .search(&query, &TopDocs::with_limit(5))
            .map_err(|e| e.to_string())?;

        for (_score, doc_address) in top_docs {
            let doc: TantivyDocument = searcher.doc(doc_address).map_err(|e| e.to_string())?;
            let path = doc.get_first(self.f_path).and_then(|v| v.as_str()).unwrap_or("").to_string();
            let title = doc.get_first(self.f_title).and_then(|v| v.as_str()).unwrap_or("").to_string();

            // Check if the title or file stem matches the link name
            let stem = Path::new(&path)
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default();

            if stem == link_name || title == link_name {
                return Ok(Some(LinkInfo {
                    path,
                    title,
                    context: String::new(),
                }));
            }
        }

        Ok(None)
    }

    fn find_incoming_links(
        &self,
        searcher: &tantivy::Searcher,
        file_name: &str,
        exclude_path: &str,
    ) -> Result<Vec<LinkInfo>, String> {
        // Search for documents that have this file name in their wiki_links field
        let term = tantivy::Term::from_field_text(self.f_wiki_links, file_name);
        let query = TermQuery::new(term, IndexRecordOption::Basic);

        let top_docs = searcher
            .search(&query, &TopDocs::with_limit(100))
            .map_err(|e| e.to_string())?;

        let mut results = Vec::new();
        for (_score, doc_address) in top_docs {
            let doc: TantivyDocument = searcher.doc(doc_address).map_err(|e| e.to_string())?;
            let path = doc.get_first(self.f_path).and_then(|v| v.as_str()).unwrap_or("").to_string();

            // Skip self-reference
            if path == exclude_path {
                continue;
            }

            let title = doc.get_first(self.f_title).and_then(|v| v.as_str()).unwrap_or("").to_string();

            results.push(LinkInfo {
                path,
                title,
                context: format!("[[{}]]", file_name),
            });
        }

        Ok(results)
    }

    /// Get graph data for visualization (all nodes + edges in a single Tantivy scan)
    /// If container_path is provided, only include notes under that folder.
    /// Count unresolved memos and tasks in a note's comments.json
    fn count_memos_and_tasks(note_path: &str) -> (usize, usize) {
        let base = if note_path.ends_with(".md") {
            &note_path[..note_path.len() - 3]
        } else {
            note_path
        };
        let comments_file = Path::new(&format!("{}_att", base)).join("comments.json");

        let content = match fs::read_to_string(&comments_file) {
            Ok(c) => c,
            Err(_) => return (0, 0),
        };

        let comments: serde_json::Value = match serde_json::from_str(&content) {
            Ok(v) => v,
            Err(_) => return (0, 0),
        };

        let arr = match comments.as_array() {
            Some(a) => a,
            None => return (0, 0),
        };

        let mut memos = 0usize;
        let mut tasks = 0usize;
        for c in arr {
            let resolved = c.get("resolved").and_then(|v| v.as_bool()).unwrap_or(false);
            if resolved { continue; }
            // Comments with dueDate or task-related fields are tasks
            if c.get("dueDate").is_some() || c.get("due_date").is_some() {
                tasks += 1;
            } else {
                memos += 1;
            }
        }
        (memos, tasks)
    }

    pub fn get_graph_data(&self, container_path: Option<&str>, include_attachments: bool) -> Result<GraphData, String> {
        self.reload_if_needed()?;
        let searcher = self.reader.searcher();

        let top_docs = searcher
            .search(&tantivy::query::AllQuery, &TopDocs::with_limit(100_000))
            .map_err(|e| e.to_string())?;

        let mut nodes: Vec<GraphNode> = Vec::new();
        let mut edges: Vec<GraphEdge> = Vec::new();
        let mut tag_set: std::collections::HashSet<String> = std::collections::HashSet::new();
        let mut stem_to_id: std::collections::HashMap<String, String> = std::collections::HashMap::new();
        let mut title_to_id: std::collections::HashMap<String, String> = std::collections::HashMap::new();
        // Track note paths for folder hierarchy
        let mut note_paths: Vec<String> = Vec::new();

        struct DocInfo {
            path: String,
            wiki_links: Vec<String>,
        }
        let mut doc_infos: Vec<DocInfo> = Vec::new();

        for (_score, doc_address) in &top_docs {
            let doc: TantivyDocument = searcher.doc(*doc_address).map_err(|e| e.to_string())?;

            let path = doc.get_first(self.f_path)
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();

            if path.is_empty() { continue; }

            // Filter by container_path
            if let Some(container) = container_path {
                let path_n = path.replace('\\', "/");
                let container_n = container.replace('\\', "/");
                if !path_n.starts_with(&container_n) { continue; }
            }

            let title = doc.get_first(self.f_title).and_then(|v| v.as_str()).unwrap_or("").to_string();
            let note_type = doc.get_first(self.f_note_type).and_then(|v| v.as_str()).unwrap_or("").to_string();
            let tags: Vec<String> = doc.get_all(self.f_tags).filter_map(|v| v.as_str().map(|s| s.to_string())).collect();
            let wiki_links: Vec<String> = doc.get_all(self.f_wiki_links).filter_map(|v| v.as_str().map(|s| s.to_string())).collect();

            let p = Path::new(&path);
            let stem = p.file_stem().map(|s| s.to_string_lossy().to_lowercase()).unwrap_or_default();
            if !stem.is_empty() { stem_to_id.insert(stem.clone(), path.clone()); }
            if !title.is_empty() { title_to_id.insert(title.to_lowercase(), path.clone()); }

            // Detect folder note: filename matches parent folder name
            let is_folder_note = p.parent()
                .and_then(|parent| parent.file_name())
                .map(|folder_name| {
                    let folder = folder_name.to_string_lossy().to_lowercase();
                    folder == stem
                })
                .unwrap_or(false);

            // Always derive label from file stem (consistent with frontend display)
            // This ensures renames are immediately reflected without frontmatter title sync
            let label = p.file_stem()
                .map(|s| s.to_string_lossy().replace('_', " "))
                .unwrap_or_else(|| title.clone());

            // Count memos and tasks from comments.json
            let (memo_count, task_count) = Self::count_memos_and_tasks(&path);

            nodes.push(GraphNode {
                id: path.clone(),
                label,
                node_type: "note".to_string(),
                note_type: note_type.clone(),
                path: path.clone(),
                is_folder_note,
                tag_namespace: String::new(),
                memo_count,
                task_count,
                has_unresolved_tasks: task_count > 0,
            });
            note_paths.push(path.clone());

            for tag in &tags {
                tag_set.insert(tag.clone());
                edges.push(GraphEdge {
                    source: path.clone(),
                    target: format!("tag:{}", tag),
                    edge_type: "tag".to_string(),
                });
            }

            doc_infos.push(DocInfo { path, wiki_links });
        }

        // Add tag nodes with namespace detection
        for tag in &tag_set {
            let label = tag.split('/').last().unwrap_or(tag).to_string();
            // Extract namespace: "domain/AI" -> "domain"
            let namespace = if tag.contains('/') {
                tag.split('/').next().unwrap_or("").to_string()
            } else {
                String::new()
            };
            nodes.push(GraphNode {
                id: format!("tag:{}", tag),
                label,
                node_type: "tag".to_string(),
                note_type: String::new(),
                path: String::new(),
                is_folder_note: false,
                tag_namespace: namespace,
                memo_count: 0,
                task_count: 0,
                has_unresolved_tasks: false,
            });
        }

        // Resolve wiki_links into edges
        for info in &doc_infos {
            for link_name in &info.wiki_links {
                let link_lower = link_name.to_lowercase();
                let target_id = stem_to_id.get(&link_lower)
                    .or_else(|| title_to_id.get(&link_lower))
                    .cloned();
                if let Some(target) = target_id {
                    if target != info.path {
                        edges.push(GraphEdge {
                            source: info.path.clone(),
                            target,
                            edge_type: "wiki_link".to_string(),
                        });
                    }
                }
            }
        }

        // Build folder hierarchy edges: folder note -> child notes in same folder
        // Also link sub-folder notes to their parent folder note (grandparent)
        let node_id_set: std::collections::HashSet<String> = note_paths.iter().cloned().collect();
        for note_path in &note_paths {
            let p = Path::new(note_path);
            let stem = p.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
            if let Some(parent_dir) = p.parent() {
                let folder_name = parent_dir.file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_default();
                if folder_name.is_empty() { continue; }

                let is_self_folder_note = folder_name == stem;

                if is_self_folder_note {
                    // This note IS a folder note — link it to the grandparent's folder note
                    if let Some(grandparent_dir) = parent_dir.parent() {
                        let gp_folder_name = grandparent_dir.file_name()
                            .map(|n| n.to_string_lossy().to_string())
                            .unwrap_or_default();
                        if !gp_folder_name.is_empty() {
                            let gp_note_path = grandparent_dir.join(format!("{}.md", gp_folder_name));
                            let gp_note_str = gp_note_path.to_string_lossy().to_string();
                            if node_id_set.contains(&gp_note_str) {
                                edges.push(GraphEdge {
                                    source: gp_note_str,
                                    target: note_path.clone(),
                                    edge_type: "contains".to_string(),
                                });
                            }
                        }
                    }
                } else {
                    // Regular note — link to its parent folder's folder note
                    let folder_note_path = parent_dir.join(format!("{}.md", folder_name));
                    let folder_note_str = folder_note_path.to_string_lossy().to_string();
                    if node_id_set.contains(&folder_note_str) {
                        edges.push(GraphEdge {
                            source: folder_note_str,
                            target: note_path.clone(),
                            edge_type: "contains".to_string(),
                        });
                    }
                }
            }
        }

        // Scan attachments if requested
        if include_attachments {
            for note_path in &note_paths {
                let p = Path::new(note_path);
                let note_stem = p.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
                if note_stem.is_empty() { continue; }
                if let Some(parent) = p.parent() {
                    let att_folder = parent.join(format!("{}_att", note_stem));
                    if att_folder.is_dir() {
                        if let Ok(entries) = fs::read_dir(&att_folder) {
                            for entry in entries.filter_map(|e| e.ok()) {
                                let entry_path = entry.path();
                                if !entry_path.is_file() { continue; }
                                let file_name = entry_path.file_name()
                                    .map(|n| n.to_string_lossy().to_string())
                                    .unwrap_or_default();
                                // Skip comments.json
                                if file_name == "comments.json" { continue; }
                                let att_path_str = entry_path.to_string_lossy().to_string();
                                nodes.push(GraphNode {
                                    id: att_path_str.clone(),
                                    label: file_name,
                                    node_type: "attachment".to_string(),
                                    note_type: String::new(),
                                    path: att_path_str.clone(),
                                    is_folder_note: false,
                                    tag_namespace: String::new(),
                                    memo_count: 0,
                                    task_count: 0,
                                    has_unresolved_tasks: false,
                                });
                                edges.push(GraphEdge {
                                    source: note_path.clone(),
                                    target: att_path_str,
                                    edge_type: "attachment".to_string(),
                                });
                            }
                        }
                    }
                }
            }
        }

        Ok(GraphData { nodes, edges })
    }

    /// Check if a file name exists in the index (for wiki-link resolution)
    #[allow(dead_code)]
    pub fn file_exists(&self, file_name: &str) -> bool {
        let searcher = self.reader.searcher();
        // Search by path ending with the file name
        let query_parser = QueryParser::for_index(&self.index, vec![self.f_title]);
        if let Ok(query) = query_parser.parse_query(&format!("\"{}\"", file_name)) {
            if let Ok(results) = searcher.search(&query, &TopDocs::with_limit(1)) {
                return !results.is_empty();
            }
        }
        false
    }

    /// Count comments for a given note path
    #[allow(dead_code)]
    fn count_comments(note_path: &str) -> usize {
        // Comments are stored in note_path_att/comments.json
        // Remove .md extension if present
        let base_path = if note_path.ends_with(".md") {
            &note_path[..note_path.len() - 3]
        } else {
            note_path
        };
        let comments_path = format!("{}_att", base_path);
        let comments_file = Path::new(&comments_path).join("comments.json");

        log::debug!("Checking comments at: {:?} (from note: {})", comments_file, note_path);

        if let Ok(content) = fs::read_to_string(&comments_file) {
            if let Ok(comments) = serde_json::from_str::<serde_json::Value>(&content) {
                if let Some(arr) = comments.as_array() {
                    // Count only unresolved comments (resolved: false or missing)
                    let count = arr.iter()
                        .filter(|comment| {
                            comment.get("resolved")
                                .and_then(|v| v.as_bool())
                                .unwrap_or(false) == false
                        })
                        .count();
                    log::debug!("Found {} unresolved comments (total: {}) in {:?}", count, arr.len(), comments_file);
                    return count;
                }
            }
        }

        0
    }

    /// Get all unique tags used across all notes in the index
    /// Returns deduplicated list of tag IDs (e.g., "domain/특허", "who/홍길동")
    pub fn get_all_tags(&self) -> Result<Vec<String>, String> {
        use std::collections::HashSet;

        self.reload_if_needed()?;
        let searcher = self.reader.searcher();

        // Query all documents
        let query = tantivy::query::AllQuery;
        let top_docs = searcher
            .search(&query, &TopDocs::with_limit(100_000))
            .map_err(|e| e.to_string())?;

        let mut unique_tags: HashSet<String> = HashSet::new();

        for (_score, doc_address) in top_docs {
            if let Ok(doc) = searcher.doc::<TantivyDocument>(doc_address) {
                // Collect all tags from this document
                for tag_value in doc.get_all(self.f_tags) {
                    if let Some(tag) = tag_value.as_str() {
                        unique_tags.insert(tag.to_string());
                    }
                }
            }
        }

        let mut tags: Vec<String> = unique_tags.into_iter().collect();
        tags.sort();

        log::info!("[get_all_tags] Found {} unique tags in vault", tags.len());
        Ok(tags)
    }

    /// Extract high-frequency meaningful words from document bodies.
    /// Reads stored body text, splits by whitespace, strips Korean particles,
    /// and returns the most frequent valid words.
    pub fn get_suggestion_terms(&self, limit: usize) -> Result<Vec<(String, u32)>, String> {
        use std::collections::HashMap;

        self.reload_if_needed()?;
        let searcher = self.reader.searcher();

        let query = tantivy::query::AllQuery;
        let top_docs = searcher
            .search(&query, &TopDocs::with_limit(100_000))
            .map_err(|e| e.to_string())?;

        let mut word_freqs: HashMap<String, u32> = HashMap::new();

        for (_score, doc_address) in top_docs {
            if let Ok(doc) = searcher.doc::<TantivyDocument>(doc_address) {
                let body = doc.get_first(self.f_body).and_then(|v| v.as_str()).unwrap_or("");
                // Track unique words per document (count docs containing the word, not total occurrences)
                let mut doc_words: std::collections::HashSet<String> = std::collections::HashSet::new();

                for raw_word in body.split(|c: char| c.is_whitespace() || c == ',' || c == '.' || c == '!' || c == '?' || c == ';' || c == ':' || c == '(' || c == ')' || c == '[' || c == ']' || c == '"' || c == '\'' || c == '/' || c == '\\' || c == '|' || c == '<' || c == '>' || c == '{' || c == '}' || c == '#' || c == '*' || c == '=' || c == '+' || c == '~' || c == '`') {
                    let trimmed = raw_word.trim();
                    if trimmed.is_empty() { continue; }

                    // For CJK text: strip Korean particles to get stem
                    let has_cjk = trimmed.chars().any(|c| is_cjk_char(c));
                    let word = if has_cjk {
                        strip_korean_particles(trimmed)
                    } else {
                        trimmed
                    };

                    if is_valid_suggestion_word(word) {
                        let normalized = if has_cjk { word.to_string() } else { word.to_lowercase() };
                        doc_words.insert(normalized);
                    }
                }

                for w in doc_words {
                    *word_freqs.entry(w).or_insert(0) += 1;
                }
            }
        }

        // Filter: require appearing in at least 2 documents
        let mut sorted: Vec<(String, u32)> = word_freqs
            .into_iter()
            .filter(|(_, freq)| *freq >= 2)
            .collect();
        sorted.sort_by(|a, b| b.1.cmp(&a.1));
        sorted.truncate(limit);

        log::info!("[get_suggestion_terms] Extracted {} words (limit: {})", sorted.len(), limit);
        Ok(sorted)
    }
}
