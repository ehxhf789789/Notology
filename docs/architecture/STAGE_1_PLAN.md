# Stage 1 Implementation Plan: CAS + Version DAG + Refs

**Date**: 2026-04-19  
**Depends on**: `docs/architecture/ARCHITECTURE_ANALYSIS.md`  
**Target**: Foundation layer for Git-philosophy sync redesign

---

## Plan Confidence Report

| Section | Confidence | Notes |
|---------|-----------|-------|
| 1. Scope & Goals | **HIGH** | Directly from confirmed design decisions |
| 2. Module Architecture | **HIGH** | Based on direct code reading of integration points |
| 3. Data Structures | **HIGH** | Designed with serde compatibility verified |
| 4. On-Disk Layout | **HIGH** | Follows Git conventions adapted for Notology |
| 5. Frontmatter Changes | **HIGH** | **Critical finding**: `id` field already exists (14-digit timestamp), schema requires it |
| 6. Save Flow Integration | **HIGH** | `note.rs` write_file fully read, integration points identified |
| 7. Atomic Multi-File Writes | **MEDIUM** | Ordered writes recommended; NAS edge cases need runtime testing |
| 8. Migration Plan | **HIGH** | Existing `.notology/sync/base/` structure fully understood |
| 9. Sync Engine Adaptation | **MEDIUM** | Sync engine is complex (1,655 LOC); coexistence may surface edge cases |
| 10. Sub-Stage Breakdown | **HIGH** | Each sub-stage independently testable |
| 11. Testing Strategy | **HIGH** | Based on existing test patterns in codebase |
| 12. Rollback Plan | **HIGH** | Standard backup-and-restore pattern |
| 13. Open Questions | **HIGH** | All questions have recommendations with reasoning |
| 14. Risk Register | **HIGH** | Based on code analysis, not speculation |

**Key finding that changes the plan**: The frontmatter `id` field already exists in `Frontmatter` struct (`src-tauri/src/frontmatter/types.rs:179`) as a 14-digit timestamp ID (`YYYYMMDDHHMMSS`) with schema validation (`schemas.rs:11`). However, `create_note()` in `note.rs:182-184` does NOT generate this field — it's only populated via serde default during deserialization. Many existing notes likely lack the `id` field. This means:
- We should use the existing `id` field rather than introducing a new UUID field
- Migration must handle notes without `id` (generate one)
- The timestamp format is adequate for our purposes (unique per note, human-readable)
- No schema or type changes needed

---

## Section 1: Scope & Goals

### 1.1 Explicit In-Scope

1. **Content-Addressable Storage (CAS)**: `.notology/objects/{hash[0:2]}/{hash[2:]}` — SHA-256 based object store for note content
2. **Per-note Version DAG**: `.notology/history/{note-id}.json` — append-only directed acyclic graph of versions
3. **Reference Tracking**: `.notology/refs/{note-id}.json` — pointer to current HEAD version per note
4. **Note ID Integration**: Ensure every note has an `id` field in frontmatter (using existing 14-digit timestamp format)
5. **Migration**: Convert existing vaults from `.notology/sync/base/` to new CAS+DAG+Refs structure
6. **Save Flow Integration**: Every `write_file` call creates a CAS object + DAG entry + ref update
7. **Library Coordinator**: Unified API that coordinates CAS+DAG+Refs as atomic operations

### 1.2 Explicit Out-of-Scope

- Branch creation logic (Stage 4 — N-way Conflict)
- Multi-device branch detection (Stage 4)
- Version History UI (Stage 2)
- GC / Cleanup tool (separate future design)
- Backend abstraction changes (Stage 3)
- Google Drive (Stage 3)
- Freshness state machine (Stage 4)
- Changes to existing sync engine logic (only additive manifest extension)

### 1.3 Success Criteria

1. Every note save produces a CAS object, DAG entry, and ref update
2. Overhead per save: **<50ms** on SSD, **<200ms** on NAS
3. Existing vaults migrate with zero data loss
4. Sync continues to work — no regression in WebDAV sync behavior
5. All 13 existing Rust integration tests continue to pass
6. Notes without `id` field automatically receive one on first save
7. `.notology/objects/` is portable (can be moved between machines, content is self-describing)

---

## Section 2: Module Architecture

### 2.1 `src-tauri/src/core/cas.rs` — Content-Addressable Storage

**Purpose**: Store and retrieve content by SHA-256 hash. Objects are immutable once written.

**Estimated LOC**: ~180

**Dependencies**: `sha2`, `std::fs`, `crate::core::file_io::atomic_write_file`

**Public API**:

```rust
use std::path::{Path, PathBuf};

/// Content-Addressable Storage engine.
/// Objects stored at: {vault}/.notology/objects/{hash[0:2]}/{hash[2:]}
pub struct CasStore {
    objects_dir: PathBuf,
}

impl CasStore {
    /// Create a new CAS store rooted at the given vault path.
    /// Creates .notology/objects/ if it doesn't exist.
    pub fn new(vault_path: &Path) -> Result<Self, String>;

    /// Compute SHA-256 hash of content without storing it.
    pub fn hash(content: &[u8]) -> String;

    /// Store content and return its hash.
    /// If the object already exists (same hash), this is a no-op (deduplication).
    /// Uses atomic write (temp file → fsync → rename).
    pub fn write_object(&self, content: &[u8]) -> Result<String, String>;

    /// Read content by hash. Returns None if object doesn't exist.
    pub fn read_object(&self, hash: &str) -> Result<Option<Vec<u8>>, String>;

    /// Check if an object exists.
    pub fn has_object(&self, hash: &str) -> bool;

    /// Delete an object by hash. Used only by future GC.
    /// Returns Ok(false) if object didn't exist.
    pub fn delete_object(&self, hash: &str) -> Result<bool, String>;

    /// List all object hashes. Used for integrity checks and GC.
    pub fn list_objects(&self) -> Result<Vec<String>, String>;

    /// Get the file path for a given hash (for direct access if needed).
    pub fn object_path(&self, hash: &str) -> PathBuf;
}
```

**Internal details**:
- Hash format: 64-character lowercase hex string (SHA-256)
- Directory sharding: first 2 chars as subdirectory (256 buckets, like Git)
- Atomic write: uses existing `atomic_write_file` from `file_io.rs`
- Deduplication: check `has_object()` before write; if exists, skip
- Thread safety: objects are immutable once written; no locks needed for reads; write uses atomic rename

### 2.2 `src-tauri/src/core/version_dag.rs` — Version DAG

**Purpose**: Maintain a per-note directed acyclic graph of versions. Each version points to its parent(s) and references a CAS object hash.

**Estimated LOC**: ~250

**Dependencies**: `serde`, `serde_json`, `chrono`, `crate::core::file_io`

**Public API**:

```rust
use chrono::{DateTime, Utc};
use serde::{Serialize, Deserialize};
use std::path::{Path, PathBuf};

/// A single version entry in the DAG.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VersionEntry {
    /// SHA-256 hash of the note content at this version
    pub content_hash: String,
    /// Parent version hash(es). Empty for the initial version.
    /// Multiple parents indicate a merge (future Stage 4).
    pub parents: Vec<String>,
    /// When this version was created
    pub timestamp: DateTime<Utc>,
    /// Device that created this version (hostname or device ID)
    pub device_id: String,
    /// SHA-256 hashes of attachments at this version (for tracking, not versioning)
    pub attachment_hashes: Vec<String>,
}

/// Per-note version DAG.
/// Stored at: {vault}/.notology/history/{note-id}.json
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct VersionDag {
    /// Ordered list of versions. Index 0 is oldest.
    /// Using a Vec for simplicity; the DAG structure is encoded via `parents`.
    pub versions: Vec<VersionEntry>,
}

impl VersionDag {
    /// Load DAG for a note. Returns empty DAG if file doesn't exist.
    pub fn load(vault_path: &Path, note_id: &str) -> Result<Self, String>;

    /// Save DAG to disk (atomic write).
    pub fn save(&self, vault_path: &Path, note_id: &str) -> Result<(), String>;

    /// Append a new version. Returns the content_hash for reference.
    /// `parent_hash` is the current HEAD's content_hash (or None for first version).
    pub fn append(
        &mut self,
        content_hash: String,
        parent_hash: Option<String>,
        device_id: String,
        attachment_hashes: Vec<String>,
    ) -> &VersionEntry;

    /// Get the latest version entry (tip of the linear chain).
    /// In Stage 1, there's always exactly one tip (no branches).
    pub fn latest(&self) -> Option<&VersionEntry>;

    /// Get a version by its content_hash.
    pub fn get(&self, content_hash: &str) -> Option<&VersionEntry>;

    /// Get full history as a slice (oldest first).
    pub fn history(&self) -> &[VersionEntry];

    /// Number of versions.
    pub fn len(&self) -> usize;

    /// Check if DAG is empty.
    pub fn is_empty(&self) -> bool;

    /// File path for this DAG.
    pub fn dag_path(vault_path: &Path, note_id: &str) -> PathBuf;
}
```

**Serialization**: JSON (human-readable, debuggable, `serde_json` already in deps). MessagePack would save ~30% space but DAG files are small (each version entry is ~200 bytes; 1000 versions = 200KB JSON — acceptable).

**Append-only guarantee**: `append()` only adds; never modifies existing entries. This makes corruption recovery straightforward — truncate to last valid entry.

### 2.3 `src-tauri/src/core/refs.rs` — Reference Tracking

**Purpose**: Map each note ID to its current HEAD version hash plus sync metadata.

**Estimated LOC**: ~150

**Dependencies**: `serde`, `serde_json`, `chrono`, `crate::core::file_io`

**Public API**:

```rust
use chrono::{DateTime, Utc};
use serde::{Serialize, Deserialize};
use std::path::{Path, PathBuf};

/// A reference pointing to a note's current version.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoteRef {
    /// The note's frontmatter ID
    pub note_id: String,
    /// SHA-256 hash of the current content (HEAD)
    pub head_hash: String,
    /// File path relative to vault root (for reverse lookup)
    pub relative_path: String,
    /// Last time this ref was updated
    pub updated_at: DateTime<Utc>,
    /// ETag from last successful sync (for WebDAV compatibility)
    pub sync_etag: Option<String>,
}

/// Reference store for all notes in a vault.
/// Each ref stored at: {vault}/.notology/refs/{note-id}.json
pub struct RefStore {
    refs_dir: PathBuf,
}

impl RefStore {
    /// Create a new ref store rooted at the vault path.
    pub fn new(vault_path: &Path) -> Result<Self, String>;

    /// Get a ref by note ID. Returns None if not found.
    pub fn get(&self, note_id: &str) -> Result<Option<NoteRef>, String>;

    /// Update or create a ref. Atomic write.
    pub fn set(&self, note_ref: &NoteRef) -> Result<(), String>;

    /// Delete a ref. Returns Ok(false) if it didn't exist.
    pub fn delete(&self, note_id: &str) -> Result<bool, String>;

    /// List all refs. Used for enumeration, integrity checks.
    pub fn list(&self) -> Result<Vec<NoteRef>, String>;

    /// Find a ref by relative path (reverse lookup).
    /// Scans all ref files — O(n) but called rarely.
    pub fn find_by_path(&self, relative_path: &str) -> Result<Option<NoteRef>, String>;

    /// File path for a given note ID's ref.
    pub fn ref_path(&self, note_id: &str) -> PathBuf;
}
```

### 2.4 `src-tauri/src/core/note_id.rs` — Note Identity

**Purpose**: Generate, resolve, and manage note IDs. Reuses the existing 14-digit timestamp format.

**Estimated LOC**: ~120

**Dependencies**: `chrono`, `serde_yaml`, `crate::core::file_io`

**Public API**:

```rust
use std::path::Path;

/// Generate a new note ID (14-digit timestamp: YYYYMMDDHHMMSS).
/// Matches existing `generate_note_id()` in frontmatter/types.rs.
/// If collision detected (same second), appends milliseconds.
pub fn generate_id() -> String;

/// Extract note ID from a file's frontmatter.
/// Returns None if file has no frontmatter or no `id` field.
pub fn read_id_from_file(file_path: &Path) -> Result<Option<String>, String>;

/// Add or update the `id` field in a note's frontmatter.
/// Preserves all existing frontmatter fields.
/// Returns the ID that was set.
pub fn ensure_id_in_file(file_path: &Path) -> Result<String, String>;

/// Validate that a string is a valid note ID (14+ digits).
pub fn is_valid_id(id: &str) -> bool;
```

**Key behaviors**:
- `read_id_from_file()` parses frontmatter YAML, extracts `id` field
- `ensure_id_in_file()`:
  1. Read file content
  2. Parse frontmatter
  3. If `id` exists and is valid, return it
  4. If `id` missing, generate new one, insert into frontmatter, atomic write
  5. Preserves all existing frontmatter fields and body content
- Collision avoidance: if two notes are created in the same second, append milliseconds (`YYYYMMDDHHMMSSMMM`)

### 2.5 `src-tauri/src/core/library.rs` — Library Coordinator

**Purpose**: The single entry point for version operations. Coordinates CAS + DAG + Refs atomically. Implements ordered writes (CAS → DAG → Ref) for crash safety.

**Actual LOC**: ~358 production + ~217 tests = 575 total

**Dependencies**: `crate::core::{cas, version_dag, refs, file_io}`, `hostname`, `chrono`

**Public API** (15 methods, grouped logically):

```rust
use std::path::{Path, PathBuf};
use serde::{Serialize, Deserialize};

/// Report from repair_note() detailing what corrective actions were taken.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RepairReport {
    pub note_id: String,
    pub actions_taken: Vec<String>,
    pub final_head_hash: Option<String>,
}

/// The Library coordinates CAS, Version DAG, and Refs as atomic units.
/// Layout: {vault}/.notology/{objects,history,refs,device-id}/
pub struct Library {
    vault_path: PathBuf,
    cas: CasStore,
    refs: RefStore,
    device_id: String,
}

impl Library {
    // ─── Construction ───────────────────────────────────────────

    /// Initialize Library for a vault. Creates directory structure if needed.
    /// device_id is auto-generated ({hostname}-{8charhex}, persisted to
    /// .notology/device-id).
    pub fn new(vault_path: &Path) -> Result<Self, String>;

    /// Like new() but with explicit device_id (for testing determinism).
    pub fn new_with_device_id(vault_path: &Path, device_id: String) -> Result<Self, String>;

    /// Check whether Library directory structure exists at this vault.
    /// Returns true if .notology/objects/, history/, refs/ all exist.
    pub fn is_initialized(vault_path: &Path) -> bool;

    // ─── Commit ─────────────────────────────────────────────────

    /// Commit a new version of a note.
    ///
    /// Steps (ordered writes for crash safety):
    /// 1. Compute SHA-256 hash of content
    /// 2. If hash == current HEAD hash → skip, return Ok(None)
    /// 3. Write CAS object (immutable, idempotent)
    /// 4. Append to DAG (parent = previous HEAD)
    /// 5. Update ref to new hash (commit point)
    ///
    /// Preserves sync_etag from previous ref across commits.
    /// Returns Some(hash) on new commit, None if content unchanged.
    pub fn commit_version(
        &self,
        note_id: &str,
        content: &[u8],
        relative_path: &str,
        attachment_hashes: Vec<String>,
    ) -> Result<Option<String>, String>;

    // ─── Read ───────────────────────────────────────────────────

    /// Get current HEAD hash for a note.
    ///
    /// Performs limited automatic recovery:
    /// - Case 1: ref exists but CAS object missing → fallback to DAG's
    ///   latest entry with valid object, update ref silently
    /// - Case 3: ref missing but DAG exists → create ref from DAG's
    ///   latest entry (with empty relative_path placeholder)
    ///
    /// Returns Ok(None) if note has no ref AND no DAG entries.
    /// Other corruption cases require explicit repair_note() call.
    pub fn get_head(&self, note_id: &str) -> Result<Option<String>, String>;

    /// Read content of a specific version by hash.
    /// Returns Ok(None) if object doesn't exist.
    pub fn read_version(&self, content_hash: &str) -> Result<Option<Vec<u8>>, String>;

    /// Get full history for a note (DAG entries, oldest first).
    /// Includes abandoned entries not reachable from current ref,
    /// for diagnostic visibility.
    pub fn get_history(&self, note_id: &str) -> Result<Vec<VersionEntry>, String>;

    /// Get the NoteRef (with sync metadata).
    pub fn get_ref(&self, note_id: &str) -> Result<Option<NoteRef>, String>;

    // ─── Sync Bridge ────────────────────────────────────────────

    /// Update the sync_etag field on a ref. Called after WebDAV upload/download.
    /// Returns Err if no ref exists for note_id.
    pub fn update_sync_etag(&self, note_id: &str, etag: Option<String>) -> Result<(), String>;

    // ─── Repair ─────────────────────────────────────────────────

    /// Explicit repair operation. Handles all corruption cases via 4-step
    /// strategy:
    /// 1. If ref valid (points to existing CAS object) → no-op
    /// 2. Scan DAG newest-first for any valid CAS object → restore ref
    /// 3. If md_path provided and file exists → resurrect via commit_version
    /// 4. Cannot repair → return final_head_hash: None
    ///
    /// Preserves relative_path and sync_etag from existing ref when possible.
    pub fn repair_note(
        &self,
        note_id: &str,
        md_path: Option<&Path>,
    ) -> Result<RepairReport, String>;

    // ─── Internal Access ────────────────────────────────────────

    /// Access the CAS store.
    pub fn cas(&self) -> &CasStore;
    /// Access the RefStore.
    pub fn refs(&self) -> &RefStore;
    /// Get this device's identifier.
    pub fn device_id(&self) -> &str;
}
```

**Key behaviors**:

- **Skip-if-unchanged**: `commit_version()` computes hash BEFORE any I/O. If hash matches current HEAD, returns `Ok(None)` immediately with zero disk writes.
- **device_id**: Format `{hostname}-{8charhex}`. Generated once via `hostname` crate + time-based 8-char hex. Persisted to `.notology/device-id`. If persistence fails, Library init still succeeds (warns via eprintln).
- **Recovery scope**: `get_head()` handles only Case 1 (missing CAS object) and Case 3 (missing ref). All other corruption requires `repair_note()`.
- **Save flow order**: In Sub-Stage 1.5, .md file is written FIRST, then `commit_version` is called best-effort. Library failures never block .md saves.

### 2.6 `src-tauri/src/core/migration.rs` — Migration Logic

**Purpose**: One-time migration from v1 (`.notology/sync/base/` + manifest) to v2 (CAS + DAG + Refs).

**Estimated LOC**: ~300

**Dependencies**: `crate::core::{cas, version_dag, refs, note_id, library, file_io}`, `walkdir`

**Public API**:

```rust
use std::path::Path;
use serde::{Serialize, Deserialize};

/// Migration state persisted between runs.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MigrationState {
    pub version: u32,
    pub status: MigrationStatus,
    pub total_notes: usize,
    pub migrated_notes: usize,
    pub failed_notes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum MigrationStatus {
    NotStarted,
    InProgress,
    Completed,
    Failed { reason: String },
}

/// Check what migration version the vault is at.
/// Returns 0 if no migration marker exists (pre-CAS vault).
/// Returns 2 if CAS migration is complete.
pub fn get_migration_version(vault_path: &Path) -> u32;

/// Check if migration is needed.
pub fn needs_migration(vault_path: &Path) -> bool;

/// Run the migration. Emits progress via callback.
/// Returns the final migration state.
pub fn run_migration(
    vault_path: &Path,
    device_id: &str,
    on_progress: impl Fn(usize, usize), // (completed, total)
) -> Result<MigrationState, String>;

/// Resume an interrupted migration.
pub fn resume_migration(
    vault_path: &Path,
    device_id: &str,
    on_progress: impl Fn(usize, usize),
) -> Result<MigrationState, String>;

/// Verify migration integrity: every ref has a valid object and DAG.
pub fn verify_migration(vault_path: &Path) -> Result<Vec<String>, String>;
```

### 2.7 Module Registration

Add to `src-tauri/src/core/mod.rs`:
```rust
pub mod types;
pub mod file_io;
pub mod cas;
pub mod version_dag;
pub mod refs;
pub mod note_id;
pub mod library;
pub mod migration;
```

---

## Section 3: Data Structures (Detailed)

### 3.1 `VersionEntry` — Single DAG Node

```rust
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
    /// Device identifier (hostname from `hostname` crate, already in Cargo.toml)
    pub device_id: String,
    /// SHA-256 hashes of files in {note}_att/ at this version
    /// Tracks which attachments existed, but doesn't version attachment content
    pub attachment_hashes: Vec<String>,
}
```

**Serialization**: JSON via `serde_json`. Example on disk:
```json
{
  "versions": [
    {
      "content_hash": "a1b2c3d4e5f6...",
      "parents": [],
      "timestamp": "2026-04-19T10:30:00Z",
      "device_id": "DESKTOP-ABC123",
      "attachment_hashes": ["f1e2d3c4..."]
    },
    {
      "content_hash": "b2c3d4e5f6a1...",
      "parents": ["a1b2c3d4e5f6..."],
      "timestamp": "2026-04-19T11:00:00Z",
      "device_id": "DESKTOP-ABC123",
      "attachment_hashes": ["f1e2d3c4..."]
    }
  ]
}
```

**Validation rules**:
- `content_hash`: 64-char lowercase hex
- `parents`: each must be a valid 64-char hex; each must reference an earlier entry in the same DAG (or be from a remote DAG during merge in Stage 4)
- `timestamp`: valid RFC 3339
- `device_id`: non-empty string

**Backward compatibility**: This is a new data format. No backward compat needed — it's created fresh during migration.

### 3.2 `NoteRef` — Current Pointer

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoteRef {
    /// The note's frontmatter ID (14-digit timestamp)
    pub note_id: String,
    /// SHA-256 hash of current content (HEAD version)
    pub head_hash: String,
    /// File path relative to vault root (e.g., "subfolder/note.md")
    pub relative_path: String,
    /// When this ref was last updated
    pub updated_at: DateTime<Utc>,
    /// ETag from last successful WebDAV sync (bridges old and new identity)
    pub sync_etag: Option<String>,
}
```

Example on disk (`.notology/refs/20260419103000.json`):
```json
{
  "note_id": "20260419103000",
  "head_hash": "b2c3d4e5f6a1...",
  "relative_path": "research/quantum-computing.md",
  "updated_at": "2026-04-19T11:00:00Z",
  "sync_etag": "\"abc123-etag\""
}
```

### 3.3 `MigrationState` — Migration Progress

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MigrationState {
    pub version: u32,                    // Target version (2)
    pub status: MigrationStatus,
    pub total_notes: usize,
    pub migrated_notes: usize,
    pub failed_notes: Vec<String>,       // Paths of notes that failed
    pub started_at: DateTime<Utc>,
    pub completed_at: Option<DateTime<Utc>>,
}
```

Stored at `.notology/migration-state.json` during migration. Deleted (or kept as audit trail) after successful completion. The version marker `.notology/migration-version` is a plain text file containing just `2`.

### 3.4 `RepairReport` — Repair Operation Result

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RepairReport {
    /// The note that was repaired.
    pub note_id: String,
    /// Human-readable list of actions taken (for logging/UI).
    pub actions_taken: Vec<String>,
    /// The HEAD hash after repair, or None if note couldn't be resurrected.
    pub final_head_hash: Option<String>,
}
```

Returned by `Library::repair_note()`. The `actions_taken` field contains messages like:
- `"Ref valid, no repair needed"`
- `"Ref points to missing CAS object {hash}"`
- `"Restored ref from DAG entry {hash}"`
- `"Resurrected from .md file as new commit {hash}"`
- `"No recovery path available"`

---

## Section 4: On-Disk Layout (Authoritative)

### Post-Stage-1 Directory Structure

```
vault/
├── notes.md                          # Markdown with frontmatter (including `id:`)
├── subfolder/
│   ├── subfolder.md                  # Folder note
│   └── child-note.md
├── notes_att/                        # Attachments (unchanged)
│   ├── image.png
│   └── comments.json
└── .notology/                        # Hidden metadata
    ├── device-id                     # Plain text: "{hostname}-{8hex}" (NEW)
    ├── migration-version             # Plain text: "2"
    ├── objects/                       # CAS storage (NEW)
    │   ├── a1/
    │   │   └── b2c3d4e5f6...         # Raw content (frontmatter + body)
    │   ├── b2/
    │   │   └── c3d4e5f6a1...
    │   └── ...                       # Up to 256 subdirectories
    ├── history/                       # Version DAGs (NEW)
    │   ├── 20260419103000.json       # DAG for note with id=20260419103000
    │   └── 20260419110000.json
    ├── refs/                          # Current pointers (NEW)
    │   ├── 20260419103000.json       # Ref for note with id=20260419103000
    │   └── 20260419110000.json
    ├── sync/                          # Existing sync data (PRESERVED)
    │   ├── manifest.json             # Extended with note_id mapping
    │   ├── base/                     # Base snapshots (kept for sync engine)
    │   ├── beacon-{device}.json
    │   └── sync.db                   # SQLite queue
    ├── sync-v1-backup/               # Backup of pre-migration sync state
    │   ├── manifest.json
    │   └── base/
    ├── backups/                       # Existing file backups (unchanged)
    ├── vault-config.yaml             # Existing (unchanged)
    ├── tag-ontology.yaml             # Existing (unchanged)
    └── content-cache.json            # Existing (unchanged)
```

### File Naming Conventions

| Directory | Naming | Example |
|-----------|--------|---------|
| `objects/` | `{hash[0:2]}/{hash[2:]}` | `a1/b2c3d4e5f6789...` (no extension) |
| `history/` | `{note-id}.json` | `20260419103000.json` |
| `refs/` | `{note-id}.json` | `20260419103000.json` |

### Atomic Write Protocol

All writes to `.notology/` use the same pattern as `file_io.rs`:
1. Write to `{filename}.notology-tmp` in same directory
2. `file.sync_all()` — flush to disk
3. `fs::rename(tmp, final)` — atomic on POSIX; near-atomic on NTFS

### Concurrency Safeguards

- **CAS objects**: Immutable after creation. Multiple writers producing the same hash are idempotent — the content is identical by definition. No locks needed.
- **DAG files**: Per-note file lock via `get_file_lock(dag_path)` (reuse existing `FILE_LOCKS` from `file_io.rs`).
- **Ref files**: Same per-file lock pattern.
- **Library coordinator**: Acquires lock for the note's DAG+Ref pair, performs all three writes, then releases.

### Corruption Recovery

| File Type | Detection | Recovery |
|-----------|-----------|----------|
| CAS object | Hash verification: re-hash content, compare with filename | Delete corrupted object; re-create from current .md file on next save |
| DAG file | JSON parse failure | Load last valid JSON; if total failure, recreate from current ref + CAS object |
| Ref file | JSON parse failure | Rebuild from DAG (latest entry is HEAD) |
| Migration marker | Missing or invalid | Re-run migration (idempotent) |

---

## Section 5: Frontmatter Changes

### 5.1 Existing `id` Field — Status

**Critical finding**: The `id` field already exists in the Notology schema:

- **Rust struct** (`frontmatter/types.rs:179`): `pub id: String` with `#[serde(default = "generate_note_id")]`
- **JSON Schema** (`frontmatter/schemas.rs:11`): `"id": { "type": "string", "pattern": "^[0-9]{14}$" }`
- **TypeScript type** (`core/types/frontmatter.ts:40`): `id: string` in `BaseFrontmatter`
- **Generator** (`frontmatter/types.rs:170`): `generate_note_id()` → `YYYYMMDDHHMMSS` format

**However**, `create_note()` in `note.rs:182-184` does NOT include `id` in the generated frontmatter:
```rust
let content = format!(
    "---\ncreated: \"{}\"\nmodified: \"{}\"\ntitle: \"{}\"\ntype: \"{}\"\ntags: []\n---\n\n",
    datetime, datetime, title, ntype
);
```

This means many existing notes likely **lack the `id` field**. The serde default only applies when frontmatter is deserialized via the `Frontmatter` struct, not when raw YAML strings are passed around.

### 5.2 Plan: No New Field Needed

We will use the existing `id` field as the note identity for CAS/DAG/Refs. No schema changes, no new field name, no TypeScript type changes.

**Field specification**:
- **Name**: `id` (existing)
- **Format**: 14-digit timestamp `YYYYMMDDHHMMSS` (existing schema pattern)
- **Collision handling**: If collision within same second, append 3 more digits for milliseconds (`YYYYMMDDHHMMSSMMM`)
- **Position in frontmatter**: After `---\n`, before other fields. When adding to existing notes, insert as first field.

### 5.3 Behavior for Notes Without `id`

1. **On migration**: All notes receive an `id` if they don't have one (bulk operation)
2. **On save (post-migration)**: If `write_file()` detects missing `id`, generate and insert before proceeding to CAS/DAG/Ref operations
3. **User manually removes `id`**: Re-generate on next save. The `id` is non-optional.
4. **User edits `id` to a different value**: Accept the new value; this effectively creates a new identity. The old DAG/Ref become orphaned (future GC handles this). A warning log entry is created.

### 5.4 `id` Insertion Logic

When adding `id` to an existing note's frontmatter:
```
Input:  ---\ncreated: "..."\ntitle: "..."\n---
Output: ---\nid: "20260419103000"\ncreated: "..."\ntitle: "..."\n---
```

Implementation: read frontmatter string, parse as YAML, check for `id` key, if missing generate and serialize back. Use `serde_yaml` to preserve field order as much as possible.

### 5.5 `create_note()` and `create_folder()` Changes

Both `create_note()` (note.rs:165) and `create_folder()` (note.rs:193) must be updated to include `id` in generated frontmatter:

```rust
// Before (note.rs:182-184):
let content = format!(
    "---\ncreated: \"{}\"\nmodified: \"{}\"\ntitle: \"{}\"\ntype: \"{}\"\ntags: []\n---\n\n",
    datetime, datetime, title, ntype
);

// After:
let note_id = crate::core::note_id::generate_id();
let content = format!(
    "---\nid: \"{}\"\ncreated: \"{}\"\nmodified: \"{}\"\ntitle: \"{}\"\ntype: \"{}\"\ntags: []\n---\n\n",
    note_id, datetime, datetime, title, ntype
);
```

Same pattern for `create_folder()` (note.rs:214-218) and `create_note_with_template()` (note.rs:435-454 — the template frontmatter may or may not include `id`; ensure it does).

---

## Section 6: Save Flow Integration

### Current Flow (note.rs:106-161)

```
Frontend calls write_file(path, frontmatter, body)
  → SKETCH protection check (lines 115-127)
  → Content assembly: "---\n{fm}\n---\n\n{body}" (lines 131-148)
  → Acquire per-file mutex lock (line 150-151)
  → Backup existing file (lines 153-157)
  → atomic_write_file(path, content) (line 159)
  → Return Ok(())
```

### New Flow (after Stage 1 integration)

**Critical design decision**: The .md file is written FIRST, then Library commit is called as best-effort enrichment. Library failures must NEVER cause .md write to fail. The .md file is the source of truth.

```
Frontend calls write_file(path, frontmatter, body)
  → SKETCH protection check (unchanged)
  → Content assembly (unchanged)
  → Acquire per-file mutex lock (unchanged)
  → Backup existing file (unchanged)

  → [NEW] Resolve note ID:
      id = note_id::read_id_from_content(&content)
      if id is None:
          id = note_id::generate_id()
          content = insert_id_into_frontmatter(content, id)

  → atomic_write_file(path, content)     ← .md FIRST, primary save
  → Return Ok(())                        ← primary save complete

  → [NEW, best-effort] Library commit:
      vault_root = find_vault_root(path)
      if vault_root.is_some() && Library::is_initialized(vault_root):
          relative_path = path.strip_prefix(vault_root)
          library = get_or_init_library(vault_root)
          if let Err(e) = library.commit_version(id, content.as_bytes(), relative_path, vec![]) {
              log::warn!("Library commit failed (non-fatal): {}", e);
              // Do NOT propagate — .md file already saved
          }
```

### Why .md First?

1. **Source of truth**: Notology's "library" philosophy — markdown files are the user's data. Everything else is metadata enrichment.
2. **No data loss on library failure**: If CAS/DAG/Ref writes fail (disk full, permissions, corruption), the user's note is still saved.
3. **Self-healing**: On next save, `commit_version` will reconcile via skip-if-unchanged. `repair_note()` can fully reconstruct library state from .md files if needed.
4. **Graceful degradation**: Pre-migration vaults work exactly as before.

### Step-by-Step Analysis

**Step 1: Resolve note ID** (~0.1ms)
- Parse frontmatter for `id` field. If missing, generate one and modify `content` string.
- **Failure mode**: Frontmatter parse error → skip ID insertion, proceed with save (no data loss)
- **No lock needed**: We're already holding the per-file mutex

**Step 2: Write .md file** (unchanged, ~1ms SSD)
- `atomic_write_file(path, content)` — existing behavior, always succeeds or returns error
- This is the primary save. Return `Ok(())` to the caller after this step.

**Step 3: Library commit (best-effort)** (~1-10ms SSD, ~10-50ms NAS)
- `commit_version()` internally:
  1. `CasStore::hash(content)` → 0.01ms for typical 5KB note
  2. Compare with current HEAD → 0.1ms (read ref file)
  3. If unchanged → skip (return None) → 0ms additional
  4. `CasStore::write_object(content)` → 0.5ms SSD (write + fsync + rename)
  5. `VersionDag::load() + append() + save()` → 0.5ms SSD
  6. `RefStore::set()` → 0.5ms SSD
- **Failure mode**: Any step fails → log warning. The .md file is already saved. CAS/DAG/Ref can be reconstructed via `repair_note()` later.
- **Performance**: Target <10ms additional overhead on SSD.

### Lock Acquisition Order

Only one lock is needed per save: the existing per-file mutex from `get_file_lock(path)`. The library operations happen while holding this lock. Since each note's CAS/DAG/Ref files are per-note, there's no cross-note lock contention.

**Deadlock prevention**: No nested locks. The per-file lock is the only lock acquired. CAS writes are lockless (immutable objects). DAG and Ref files are only accessed from within the per-file lock scope.

### Library Initialization Lifecycle

The `Library` instance is created per-vault, not per-save. It should be stored in Tauri's managed state or as a lazy global:

```rust
// In lib.rs or a new state module
use once_cell::sync::Lazy;
use std::sync::Mutex;

static LIBRARY: Lazy<Mutex<Option<Library>>> = Lazy::new(|| Mutex::new(None));

fn get_library(vault_path: &Path) -> Option<Library> {
    // Initialize lazily on first access if migration is complete
}
```

### Graceful Degradation

If the library is not initialized (pre-migration vault, or migration failed), all save operations work exactly as they do today. The library integration is purely additive — never blocks a save.

---

## Section 7: Atomic Multi-File Writes

### 7.1 Problem Statement

A single `commit_version()` creates/updates 3 files:
1. CAS object: `.notology/objects/{aa}/{bb...}` (immutable, idempotent)
2. DAG file: `.notology/history/{note-id}.json` (append)
3. Ref file: `.notology/refs/{note-id}.json` (overwrite)

Plus the .md file itself (4th write, already atomic).

If crash occurs between writes, the vault must remain consistent.

### 7.2 Solution Analysis

| Option | Pros | Cons | Verdict |
|--------|------|------|---------|
| **A) Write-Ahead Log** | Full ACID, clean recovery | Adds complexity (WAL file, recovery logic), extra I/O | Overkill for append-only operations |
| **B) Ordered writes** | Simple, exploits immutability of CAS | Ref can point to nonexistent DAG entry during crash window | **RECOMMENDED** |
| **C) SQLite for DAG/Ref** | Transactional, proven | Adds SQLite dependency for metadata (already used for sync queue), harder to debug/inspect | Viable alternative |
| **D) Two-phase commit** | Clean staging | Complex, extra I/O, temp directory management | Over-engineered |

### 7.3 Recommendation: Ordered Writes with Idempotent Recovery

**Write order**:
1. **CAS object first** — immutable, idempotent. If crash here, orphaned object (harmless, future GC).
2. **DAG append second** — append-only. If crash here, DAG has entry but ref is stale. Recovery: scan DAG for latest entry, update ref.
3. **Ref update last** — signals completion. If ref points to a hash, the object and DAG entry must exist.
4. **.md file** — already written by existing `atomic_write_file()`.

**Invariant**: If the ref file exists and points to hash H, then:
- `objects/{H[0:2]}/{H[2:]}` exists and is valid
- `history/{note-id}.json` contains an entry with `content_hash == H`

**Why this works**:
- CAS is idempotent: writing the same object twice is harmless
- DAG is append-only: a partial append is detectable (invalid JSON) and recoverable (truncate to last valid entry)
- Ref is the "commit point": only updated after object and DAG are safely on disk

### 7.4 Recovery Procedure

Recovery is split into two tiers: automatic (in `get_head()`) and explicit (via `repair_note()`).

**Automatic recovery (in `get_head()`, lazy per-note)**:

| Case | Condition | Recovery | Side effect |
|------|-----------|----------|-------------|
| Case 1 | Ref exists, CAS object missing | Scan DAG newest-first for valid object → update ref | Ref silently updated |
| Case 3 | Ref missing, DAG exists | Create ref from DAG's latest entry | Ref created with empty `relative_path` |

Cases NOT handled by `get_head()` (require explicit `repair_note()`):
- Case 2: DAG missing ref's hash (DAG corruption)
- Case 4: Both ref and DAG missing but .md file exists
- Case 5: All metadata missing (requires .md resurrection)

**Explicit recovery (via `repair_note(note_id, md_path)`)**:

4-step strategy, executed in order:
1. **Validate ref**: If ref points to valid CAS object → no-op, return success
2. **DAG fallback**: Scan DAG entries newest-first. First entry with valid CAS object → restore ref from it. Preserves existing `relative_path` and `sync_etag` from old ref.
3. **MD resurrection**: If `md_path` provided and file exists → read content, call `commit_version()` to create fresh CAS+DAG+Ref from the .md file
4. **Total failure**: Return `RepairReport` with `final_head_hash: None`

Returns `RepairReport` with `actions_taken` describing each step taken.

**Design rationale**: Automatic recovery is conservative (only 2 cases) to avoid masking real corruption. Over-recovery can hide bugs. Users encountering persistent issues run `repair_note()` explicitly.

### 7.5 NAS Compatibility

NAS filesystems (SMB/CIFS, NFS, WebDAV) have weaker atomicity:
- `rename()` may not be atomic across network mounts
- `fsync()` may not flush to NAS disk immediately

**Mitigations**:
- The `.notology/` directory is typically on the local filesystem even when the vault is on NAS (Synology Drive syncs the whole folder, but operations happen locally first)
- If `.notology/` is on a network mount directly, the ordered-write approach still works because:
  - CAS objects are immutable: even if rename isn't atomic, the content is correct once complete
  - DAG append: if partially written, JSON parse fails, recovery kicks in
  - Ref update: last write; if it fails, recovery rebuilds it
- The existing sync engine already handles NAS quirks (rename retry, etc.)

---

## Section 8: Migration Plan

### 8.1 Pre-Migration Checks

```rust
pub fn pre_migration_check(vault_path: &Path) -> Result<PreMigrationReport, String> {
    // 1. Check current migration version
    let version = get_migration_version(vault_path);
    if version >= 2 { return Ok(AlreadyMigrated); }

    // 2. Count .md files (excluding _att/ and .notology/)
    let note_count = count_notes(vault_path);

    // 3. Estimate space needed:
    //    ~200 bytes per ref, ~300 bytes per DAG entry, ~5KB per CAS object
    //    Plus base snapshots if they exist
    let estimated_space = note_count * 6_000; // ~6KB per note

    // 4. Check available disk space
    let available = fs2::available_space(vault_path)?;
    if available < estimated_space * 2 { // 2x safety margin
        return Err("Insufficient disk space for migration");
    }

    // 5. Check for existing .notology/sync/base/ (provides historical data)
    let has_base_snapshots = vault_path.join(".notology/sync/base").is_dir();

    Ok(PreMigrationReport { note_count, estimated_space, has_base_snapshots })
}
```

### 8.2 Migration Steps (Detailed Sequence)

```
Phase 1: Preparation
  1. Write migration-state.json: { status: InProgress, total: N, migrated: 0 }
  2. Create directory structure: objects/, history/, refs/
  3. Backup: copy .notology/sync/ → .notology/sync-v1-backup/

Phase 2: Per-Note Migration (for each .md file)
  4. Read note content from disk
  5. Extract or generate frontmatter `id`:
     a. Parse frontmatter YAML
     b. If `id` exists and is valid → use it
     c. If `id` missing → generate new one, rewrite frontmatter (atomic)
  6. Hash current content → current_hash
  7. Write CAS object: objects/{current_hash[0:2]}/{current_hash[2:]}
  8. Check for base snapshot: .notology/sync/base/{relative_path}
     a. If base exists → hash it → base_hash → write CAS object
     b. Create DAG: [base_entry → current_entry] (two versions)
     c. If no base → create DAG: [current_entry] (one version)
  9. Create ref: { note_id, head_hash: current_hash, relative_path, ... }
  10. Look up sync manifest for ETag → store in ref.sync_etag
  11. Update migration-state.json: migrated_notes += 1
  12. Emit progress callback: on_progress(migrated, total)

Phase 3: Finalization
  13. Write migration-version file: "2"
  14. Update migration-state.json: { status: Completed }
  15. Verification pass (optional but recommended):
      For each ref: verify object exists, verify DAG contains head_hash
```

### 8.3 Failure Handling

**Crash during Phase 2 (per-note)**:
- On next launch: read `migration-state.json`
- If status == InProgress: resume from `migrated_notes` count
- Already-migrated notes are skipped (check if ref exists for that note_id)
- CAS writes are idempotent; DAG writes are checked for duplicates

**Verification failure**:
- Log which notes failed verification
- Do not write `migration-version`
- Retry migration on next launch
- If repeated failure: fall back to non-library mode (app works without CAS)

**Disk full**:
- Detect `write_object` failure → set `MigrationStatus::Failed`
- On next launch: retry after user frees space
- No data loss: original .md files and sync state are untouched

### 8.4 Migration UX

**Tauri command** (new):
```rust
#[tauri::command]
pub async fn check_migration_needed(vault_path: String) -> Result<bool, String>;

#[tauri::command]
pub async fn run_vault_migration(
    vault_path: String,
    app_handle: tauri::AppHandle,
) -> Result<MigrationState, String>;
```

**Frontend integration**: Call `check_migration_needed()` after vault selection. If true, show migration UI before opening the vault.

| Duration | UI |
|----------|-----|
| <3s | Progress bar in existing loading screen |
| 3-15s | Dedicated modal: "Upgrading vault..." + progress bar (N/total notes) |
| >15s | Same modal + "This may take a moment for large vaults" |
| All | "Do not close the application" warning |

Progress events emitted via `app_handle.emit("migration:progress", { completed, total })`.

### 8.5 Time Estimates

| Vault Size | Operations | SSD | NAS/HDD |
|-----------|-----------|-----|---------|
| 100 notes | ~300 file writes | <1s | ~3s |
| 1,000 notes | ~3,000 file writes | ~3s | ~15s |
| 10,000 notes | ~30,000 file writes | ~20s | ~90s |

Each note requires: 1 read (.md) + 1 read (base, if exists) + 2-3 writes (CAS + DAG + ref) + 1 write (frontmatter update if `id` missing).

---

## Section 9: Sync Engine Adaptation

### 9.1 Identity Translation

The sync engine continues to operate on file paths. The CAS layer runs in parallel, enriching the sync metadata.

**Extended manifest entry** (backward compatible):

```rust
// engine.rs — extend BaseEntry
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BaseEntry {
    pub path: String,
    pub synced_at: DateTime<Utc>,
    pub etag: Option<String>,
    pub is_binary: bool,
    // NEW FIELDS (optional for backward compat)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_hash: Option<String>,
}
```

### 9.2 What Changes

1. **After successful upload** (engine.rs, where `save_base` is called):
   - Additionally: `library.update_sync_etag(note_id, new_etag)`
   - The ref's `sync_etag` stays in sync with the manifest's ETag

2. **After successful download**:
   - Additionally: `library.commit_version(note_id, downloaded_content, relative_path, vec![])`
   - Creates a CAS object and DAG entry for the downloaded version

3. **Conflict detection enhancement** (future-ready, not enforced in Stage 1):
   - Currently: `remote_etag != base_etag`
   - Future Stage 4: `remote_content_hash != ref.head_hash` (content-based, not metadata-based)

4. **Manifest population**:
   - When saving a manifest entry, also populate `note_id` and `content_hash` from the library

### 9.3 What Doesn't Change

- WebDAV transport layer (`webdav.rs`)
- Sync queue (SQLite WAL in `sync.db`)
- Beacon system (`engine.rs:476-591`)
- Realtime WebSocket client (`realtime.rs`)
- Monitor loop (`mod.rs:576-838`)
- Conflict resolution logic (`conflict.rs`)
- Grace period, debounce, adaptive polling
- All Tauri sync commands in `mod.rs`

### 9.4 Coexistence Strategy

Stage 1 adds the library layer alongside the existing sync engine. They coexist:
- **Save path**: Library writes CAS/DAG/Ref → then existing `atomic_write_file` writes .md → then sync engine picks up the file change event
- **Sync path**: Sync engine downloads file → writes .md → file watcher triggers → (optionally) library records the downloaded version
- **Identity bridge**: The ref's `sync_etag` field connects the two systems. The manifest's `note_id` and `content_hash` fields provide the reverse mapping.

The sync engine remains the authoritative system for remote synchronization. The library is a local history layer that the sync engine enriches but does not depend on.

---

## Section 10: Sub-Stage Breakdown

### Sub-Stage 1.1: CAS Foundation

**Duration**: ~3-4 days  
**Deliverables**:
- `src-tauri/src/core/cas.rs` — full implementation
- Unit tests: hash determinism, write/read/exists/delete, deduplication, invalid hash handling

**Tests required**:
```rust
#[test] fn test_hash_determinism()           // Same content → same hash
#[test] fn test_write_and_read()             // Write → read → compare
#[test] fn test_deduplication()              // Write same content twice → one object
#[test] fn test_read_nonexistent()           // Returns None
#[test] fn test_has_object()                 // Exists check
#[test] fn test_delete_object()              // Delete → verify gone
#[test] fn test_list_objects()               // Write 3, list all
#[test] fn test_invalid_hash_path()          // Bad hash string → error
#[test] fn test_empty_content()              // Empty content is valid
#[test] fn test_large_content()              // 1MB content works
#[test] fn test_concurrent_same_hash()       // Two threads write same → no error
```

**Unblocks**: Sub-Stage 1.2

### Sub-Stage 1.2: Version DAG

**Duration**: ~3-4 days  
**Deliverables**:
- `src-tauri/src/core/version_dag.rs` — full implementation
- Unit tests: append, load/save round-trip, history traversal

**Tests required**:
```rust
#[test] fn test_empty_dag()                  // New DAG is empty
#[test] fn test_append_single()              // Append one version
#[test] fn test_append_chain()               // Append 3 versions, verify parents
#[test] fn test_latest()                     // Returns most recent
#[test] fn test_get_by_hash()                // Find version by hash
#[test] fn test_save_and_load()              // Serialize → deserialize round-trip
#[test] fn test_history_order()              // Oldest first
#[test] fn test_corrupted_json_recovery()    // Invalid JSON → error (handled by caller)
#[test] fn test_many_versions()              // 1000 versions, load time <100ms
```

**Unblocks**: Sub-Stage 1.3

### Sub-Stage 1.3: Refs + Note ID

**Duration**: ~3-4 days  
**Deliverables**:
- `src-tauri/src/core/refs.rs` — full implementation
- `src-tauri/src/core/note_id.rs` — full implementation
- Unit tests for both modules
- Integration test: CAS + DAG + Refs round-trip

**Tests required**:
```rust
// note_id tests
#[test] fn test_generate_id_format()         // 14 digits
#[test] fn test_generate_id_uniqueness()     // 100 IDs in rapid succession, all unique
#[test] fn test_read_id_from_file()          // File with id → returns it
#[test] fn test_read_id_missing()            // File without id → returns None
#[test] fn test_ensure_id_adds_to_existing() // Note without id → gets one, content preserved
#[test] fn test_ensure_id_preserves_existing()// Note with id → unchanged
#[test] fn test_is_valid_id()                // Valid/invalid patterns

// refs tests
#[test] fn test_set_and_get()                // Write ref → read ref
#[test] fn test_get_nonexistent()            // Returns None
#[test] fn test_delete()                     // Delete → verify gone
#[test] fn test_list()                       // Write 3, list all
#[test] fn test_find_by_path()               // Reverse lookup works
#[test] fn test_overwrite()                  // Update existing ref

// Integration
#[test] fn test_cas_dag_ref_roundtrip()      // Write content → CAS → DAG → Ref → read back
```

**Unblocks**: Sub-Stage 1.4

### Sub-Stage 1.4: Library Coordinator

**Duration**: ~4-5 days  
**Deliverables**:
- `src-tauri/src/core/library.rs` — full implementation
- Integration tests: commit_version atomicity, skip-if-unchanged
- Recovery procedure implementation and tests

**Tests required**:
```rust
#[test] fn test_commit_version_creates_all_three()  // Object + DAG + Ref
#[test] fn test_commit_unchanged_content()           // Returns None, no new writes
#[test] fn test_commit_changed_content()             // New version appended
#[test] fn test_get_head()                           // Returns current hash
#[test] fn test_read_version()                       // Read content by hash
#[test] fn test_get_history()                        // Returns all versions
#[test] fn test_update_sync_etag()                   // ETag stored in ref
#[test] fn test_recovery_missing_ref()               // DAG exists, ref missing → rebuild
#[test] fn test_recovery_missing_object()            // Ref exists, object missing → detected
#[test] fn test_multiple_notes_independent()         // Two notes don't interfere
```

**Unblocks**: Sub-Stage 1.5

### Sub-Stage 1.5: Save Flow Integration

**Duration**: ~4-5 days  
**Deliverables**:
- Modified `note.rs`: `write_file`, `create_note`, `create_folder`, `create_note_with_template` include `id` and call library
- Library instance management (lazy global or Tauri state)
- All 13 existing integration tests pass
- New integration tests for the combined flow

**Tests required**:
```rust
#[test] fn test_write_file_creates_version()         // Save → verify CAS/DAG/Ref
#[test] fn test_write_file_without_library()         // Pre-migration vault → works as before
#[test] fn test_create_note_has_id()                 // New note has id in frontmatter
#[test] fn test_create_folder_has_id()               // Folder note has id
#[test] fn test_save_sketch_creates_version()        // SKETCH saves also versioned
#[test] fn test_frontmatter_only_update_versioned()  // update_note_frontmatter creates version
#[test] fn test_library_failure_doesnt_block_save()  // Library error → .md still saved
```

Plus verify all existing tests pass: `wikilink_rename_test`, `attachment_cleanup_test`, `canvas_functionality_test`, etc.

**Unblocks**: Sub-Stage 1.6

### Sub-Stage 1.6: Migration

**Duration**: ~5-7 days  
**Deliverables**:
- `src-tauri/src/core/migration.rs` — full implementation
- Migration Tauri commands
- Frontend migration UI (modal with progress bar)
- Integration into vault opening flow
- Stress tests with various vault sizes

**Tests required**:
```rust
#[test] fn test_migration_needed_detection()         // Pre-CAS vault → true
#[test] fn test_migration_already_done()             // Post-CAS vault → false
#[test] fn test_migrate_note_with_id()               // Note has id → used
#[test] fn test_migrate_note_without_id()            // Note missing id → generated
#[test] fn test_migrate_with_base_snapshot()          // Base exists → two-version DAG
#[test] fn test_migrate_without_base()               // No base → single-version DAG
#[test] fn test_migrate_etag_carried_over()          // Manifest ETag → ref.sync_etag
#[test] fn test_migration_resume_after_interrupt()   // Kill mid-migration → resume works
#[test] fn test_migration_verification()             // verify_migration catches issues
#[test] fn test_migrate_100_notes()                  // Performance: <2s
#[test] fn test_migrate_1000_notes()                 // Performance: <10s
#[test] fn test_migration_preserves_sync_state()     // sync/manifest.json, sync.db untouched
#[test] fn test_migration_backup_created()           // sync-v1-backup/ exists
```

**Frontend deliverables**:
- Migration check on vault open (in `appActions.ts` or vault-config flow)
- Progress modal component
- Event listener for `migration:progress`

---

## Section 11: Testing Strategy

### 11.1 Unit Tests (Per Module)

Each module in Section 10 has its test list. Total: ~50 unit/integration tests.

All tests use `tempfile::TempDir` for isolated vault directories (already in dev dependencies).

### 11.2 Integration Tests

```rust
// New test file: src-tauri/src/library_integration_test.rs

#[test] fn test_full_lifecycle() {
    // 1. Create vault with 5 notes (no id)
    // 2. Run migration
    // 3. Verify all notes have id, CAS objects, DAGs, refs
    // 4. Save a note 3 times
    // 5. Verify 3 versions in DAG, 3 objects in CAS
    // 6. Read version history
    // 7. Read old version content, verify matches
}

#[test] fn test_sync_coexistence() {
    // 1. Create vault, migrate
    // 2. Simulate sync download (write .md file)
    // 3. Verify library can commit the downloaded version
    // 4. Verify manifest and ref agree on state
}

#[test] fn test_rename_preserves_history() {
    // 1. Create note with 5 versions
    // 2. Rename note (new file path)
    // 3. Verify ref.relative_path updated
    // 4. Verify DAG and CAS objects unchanged
    // 5. Verify history still accessible
}
```

### 11.3 Performance Benchmarks

```rust
#[test] fn bench_commit_version_overhead() {
    // Create vault, migrate 1 note
    // Time 100 consecutive saves
    // Assert: average < 10ms per save (SSD)
}

#[test] fn bench_migration_1000_notes() {
    // Create vault with 1000 notes (various sizes)
    // Time migration
    // Assert: < 10s
}

#[test] fn bench_startup_10k_refs() {
    // Create vault with 10K refs
    // Time RefStore::list()
    // Assert: < 2s
}
```

### 11.4 Manual Test Plan

1. **Clean install**: Install Notology on a machine with no vault → create vault → create note → verify `.notology/objects/`, `history/`, `refs/` created
2. **Migration**: Open an existing v1 vault → verify migration prompt → complete migration → verify all notes have `id` → verify history browsable (Stage 2, but data should be there)
3. **Normal editing**: Edit a note 5 times → verify 5 versions in DAG → verify old versions readable via Tauri command
4. **Large note**: Create a 500KB note → save → verify CAS object is correct size
5. **Concurrent saves**: Open two hover windows for different notes → save both rapidly → verify no cross-contamination
6. **Sync after migration**: Connect NAS → sync → verify new files get CAS/DAG/Ref → verify downloaded files get versions
7. **Power loss simulation**: Kill Notology process mid-save → restart → verify recovery runs → verify no data loss
8. **Vault portability**: Copy vault to another machine → open → verify history intact

---

## Section 12: Rollback Plan

### 12.1 If Stage 1 Has Critical Bugs Post-Release

**Backup**: `.notology/sync-v1-backup/` preserves the pre-migration sync state.

**Rollback procedure**:
1. User downgrades to pre-Stage-1 Notology version
2. Pre-Stage-1 version ignores `.notology/objects/`, `history/`, `refs/` (doesn't know about them)
3. `.notology/sync/manifest.json` and `sync.db` are untouched by Stage 1
4. If manifest was extended with `note_id`/`content_hash` fields: serde `#[serde(default)]` means old versions ignore unknown fields
5. Sync resumes normally from the preserved state

**Forward-fix preferred**: The library layer is purely additive. If it has bugs, it can be disabled (skip library calls in `write_file`) without affecting core functionality.

### 12.2 Detection of Issues

- Save failures logged with `log::error!` — visible in Tauri logs
- Migration failures reported to user via modal
- CAS integrity can be verified via `verify_migration()` command
- Future: telemetry on CAS/DAG write failures (opt-in)

### 12.3 Hotfix Strategy

- Forward-only fixes. The CAS/DAG/Ref structure is designed for recovery.
- For data corruption: provide `repair_vault()` command that rebuilds DAGs and refs from .md files + CAS objects
- Worst case: delete `.notology/objects/`, `history/`, `refs/` and re-run migration (all data is reconstructible from .md files)

---

## Section 13: Open Questions for User Decision

> **Status (post Sub-Stage 1.4)**: All 5 questions resolved and implemented.
> See `library.rs` implementation and Appendix C for chosen answers and rationale.

### Q1: DAG Serialization Format

**Options**:
- **A) JSON** — human-readable, debuggable, `serde_json` already in deps. ~200 bytes per entry.
- **B) MessagePack** — 30% smaller, faster parse. Not human-readable. Needs new dep.

**Recommendation**: **A (JSON)**. The DAG files are small (even 1000 versions = 200KB). Human readability aids debugging. No new dependency.

**Decision**: A (JSON). Implemented in `version_dag.rs` using `serde_json::to_vec_pretty`.

### Q2: Note ID Format — Keep Timestamp or Switch to UUID v7

**Options**:
- **A) Keep 14-digit timestamp** — existing format, already in schema, human-readable
- **B) UUID v7** — globally unique, sortable by time, standard format. Requires schema change.

**Recommendation**: **A (keep timestamp)**. The existing format works, the schema validates it, and no migration of the `id` field itself is needed. UUID v7 would require changing the schema pattern from `^[0-9]{14}$` to a UUID pattern, updating the frontend type, and re-generating all existing IDs. The timestamp format is unique enough for a single-user PKM app (collision within same second is handled by appending milliseconds).

**Decision**: A (keep timestamp). Implemented in `note_id.rs` using `chrono::Local::now()` matching existing `generate_note_id()`.

### Q3: Library Instance Lifecycle

**Options**:
- **A) Tauri managed state** — `app.manage(Mutex<Library>)`. Tied to app lifecycle.
- **B) Lazy global** — `once_cell::Lazy<Mutex<Option<Library>>>`. Independent of Tauri.
- **C) Per-call construction** — Create library on each save. Simple but slower.

**Recommendation**: **A (Tauri managed state)**. It's the idiomatic Tauri pattern, provides proper lifecycle management, and is accessible from all command handlers via `State<'_, ...>`. The library is cheap to hold in memory (only stores paths and device_id; all data is on disk).

**Decision**: Deferred to Sub-Stage 1.5. Library struct supports both patterns via `new()` / `new_with_device_id()`.

### Q4: Recovery Timing

**Options**:
- **A) On startup** — scan all refs/DAGs at app launch. Adds startup time.
- **B) On first access** — lazy recovery per-note. No startup cost.
- **C) Background** — recovery runs in background thread after startup.

**Recommendation**: **B (on first access)**. Startup time is critical for UX. Recovery is rare (only after crashes). Check integrity lazily when a note is first accessed. If a ref/DAG is corrupted, repair it then.

**Decision**: B (on first access). Implemented in `get_head()` — limited automatic recovery (Case 1, 3) runs lazily when a note's HEAD is queried. Full recovery via `repair_note()` is explicit.

### Q5: Should `update_note_frontmatter()` Create Versions?

`update_note_frontmatter()` in `note.rs:477` is called when only frontmatter changes (e.g., tag edits, metadata updates). Should this create a new CAS version?

**Options**:
- **A) Yes** — every frontmatter change is a version. Complete history.
- **B) No** — only body changes create versions. Frontmatter-only changes update the .md but skip CAS.

**Recommendation**: **A (yes)**. Frontmatter changes (tag edits, type changes) are meaningful user actions. The overhead is minimal (one CAS object + DAG entry). And since we hash the full content (frontmatter + body), a frontmatter-only change produces a different hash, naturally creating a new version.

**Decision**: A (yes). `commit_version` hashes full content (frontmatter + body), so frontmatter-only changes naturally produce new versions.

---

## Section 14: Risk Register

| # | Risk | Likelihood | Impact | Mitigation |
|---|------|-----------|--------|-----------|
| R1 | Atomic write failure on NAS filesystem | Low | Medium | Ordered writes + recovery procedure; `.notology/` typically on local disk |
| R2 | Migration of large vault (10K+ notes) takes >60s | Medium | Low | Progress UI, resumable migration, background option |
| R3 | Existing notes with `id` field containing non-standard values | Low | Medium | Validate format; if invalid, treat as missing and generate new one |
| R4 | `id` collision (two notes created in same second) | Low | Low | Millisecond suffix; detected at ref creation (unique note_id per ref) |
| R5 | Performance regression on slow storage (HDD/NAS) | Medium | Medium | Skip-if-unchanged optimization; benchmark; lazy recovery |
| R6 | DAG file grows very large (note saved 10,000+ times) | Low | Low | 10K entries ≈ 2MB JSON — acceptable. Future: compact DAG format |
| R7 | Library initialization race condition (two saves before init completes) | Low | Medium | Per-note file locks prevent concurrent access; init is idempotent |
| R8 | Frontmatter rewrite during migration corrupts notes | Low | High | Backup before migration; use serde_yaml parse/serialize; test with edge cases |
| R9 | Sync engine writes .md without going through library | Medium | Low | Library is enrichment, not gatekeeper. Sync-written files get versioned on next watcher trigger or explicit call |
| R10 | `create_note_with_template()` receives frontmatter with conflicting `id` | Low | Low | If template has `id`, use it; if not, generate. Template IDs are user-provided — respect them |

---

## Appendix A: Existing Code Modifications Summary

| File | Change | Lines Affected |
|------|--------|---------------|
| `src-tauri/src/core/mod.rs` | Add module declarations | +6 lines |
| `src-tauri/src/features/note.rs` | Add `id` to `create_note`, `create_folder`, `create_note_with_template`; call library in `write_file`, `update_note_frontmatter` | ~40 lines changed |
| `src-tauri/src/features/sync/engine.rs` | Extend `BaseEntry` with optional `note_id`, `content_hash`; call library after upload/download | ~20 lines changed |
| `src-tauri/src/lib.rs` | Register new Tauri commands (migration); manage Library state | ~15 lines changed |

**New files**: 7 (`cas.rs`, `version_dag.rs`, `refs.rs`, `note_id.rs`, `library.rs`, `migration.rs`, `library_integration_test.rs`)

**Total new code estimate**: ~1,250 LOC Rust + ~100 LOC TypeScript (migration UI)

## Appendix B: Dependency Changes

| Crate | Current | Change |
|-------|---------|--------|
| `sha2` | 0.10 (already in Cargo.toml) | No change — already available |
| `hostname` | 0.4 (already in Cargo.toml) | No change — used for device_id |
| `uuid` | not present | **NOT needed** — using existing timestamp ID format |
| `fs2` | not present | **Optional** — for disk space check in migration. Can use `std::fs::metadata` instead |

No new dependencies required.

---

## Appendix C: Implementation Deviation Log

This section records deliberate deviations from the original Stage 1 plan,
decided during implementation. Future stages should consult this when
referring to `library.rs` behavior.

### C.1 Deviations Decided 2026-04-19 (Sub-Stage 1.4)

| # | Section | Deviation | Rationale |
|---|---------|-----------|-----------|
| 1 | 2.5 | Added `new_with_device_id()`, `repair_note()`, `device_id()` methods | Testing determinism, explicit repair, public access |
| 2 | 3 (new 3.4) | Added `RepairReport` struct | Structured output for repair operations |
| 3 | 2.5 | device_id format = `{hostname}-{8hex}`, persisted to `.notology/device-id` | Human-readable, no uuid crate dependency |
| 4 | 6 | Save flow order: .md first, library commit second (best-effort) | .md is source of truth; library failures must not cause data loss |
| 5 | 7.4 | Limited automatic recovery in `get_head()` (Case 1, 3 only) | Conservative — avoid masking real corruption |
| 6 | 2.5 | `get_history()` returns full DAG including abandoned entries | Diagnostic visibility for future version history UI |

### C.2 Implementation Outcomes

**After Sub-Stage 1.4 (Library Coordinator)**:
- Production LOC: 358 (library.rs)
- Total file LOC: 575 (with 217 lines of tests)
- All 13 tests passing (10 spec + 3 deviation)
- All 52 core tests passing
- Verification report: `docs/architecture/SUB_STAGE_1_4_VERIFICATION.md`

**After Sub-Stage 1.5 (Save Flow Integration)**:
- Files modified: note.rs (~35 lines), lib.rs (~35 lines), note_id.rs (+2 lines visibility)
- New integration tests: 9 (in `src-tauri/tests/library_integration_test.rs`)
- All 52 core tests + 9 integration tests passing
- Verification report: `docs/architecture/SUB_STAGE_1_5_VERIFICATION.md`

**After Sub-Stage 1.6 (Migration)**:
- New module: migration.rs (832 lines: ~400 production + ~430 tests)
- 19 migration tests
- Additional note_id.rs changes: `generate_unique_id()` added
- Schema fix: `frontmatter/schemas.rs` pattern updated for 17-digit IDs
- **Total Stage 1**: 80 tests across 7 modules
  - CAS: 11, Version DAG: 9, Refs: 8, NoteID: 11, Library: 13, Integration: 9, Migration: 19
- Verification report: `docs/architecture/SUB_STAGE_1_6_VERIFICATION.md`

### C.3 Future Stages — Lessons

**From Sub-Stage 1.4**:
- When adding methods to existing structs, document in module-level `//!` doc comment AND in this Appendix
- Save flow ordering decisions should consider: which artifact is the "source of truth"? Place that write first, others as best-effort.
- Recovery logic should be conservative — over-recovery can mask bugs
- New deviations should be added to a new C.X subsection per sub-stage

**From Sub-Stage 1.6**:
- When implementing bulk operations (migration), collision scenarios (same-second ID generation) must be anticipated. Atomic counters or millisecond precision are cheap insurance.
- Frontend integration scope creep can blow up sub-stage duration — be explicit about what's deferred.
- Test files' physical location (in-module vs separate integration tests) is a trade-off between access to private helpers and true integration coverage. Either is acceptable if testing is thorough.
- Schema validators and runtime checks must be updated together. A schema that rejects valid data is a silent contract break.
- Pre-existing test flakiness (e.g., timing assertions) may surface only when total test count grows. Timing assertions should account for parallel execution.

### C.4 Deviations Decided 2026-04-19 (Sub-Stage 1.6)

| # | Section | Deviation | Rationale | Severity |
|---|---------|-----------|-----------|----------|
| 7 | 5.5, 6 | ID format extended: 17-digit (`YYYYMMDDHHMMSSMMM`) IDs generated by `generate_unique_id()` | Prevent collisions when migrating many notes in the same second | Contract change |
| 8 | (new) | `generate_unique_id()` function added to note_id.rs with atomic counter | Monotonic uniqueness even within same millisecond | Additive |
| 9 | 11 (testing) | `version_dag.rs::test_many_versions` timing assertion relaxed from 100ms to 500ms | Parallel test contention with 71+ tests causes intermittent failures | Acceptable |
| 10 | 8 (migration UI) | Migration auto-runs in `openVault` without user confirmation | Deferred modal UI as separate frontend task; acceptable for developer use only | **VIOLATION of Decision 1** |
| 11 | 10 (test location) | 19 migration tests placed as unit tests in `migration.rs` instead of separate integration file | Unit tests have access to private helpers making testing more direct | Acceptable |

**Schema Impact (Deviation 7)**: `frontmatter/schemas.rs` pattern updated from `"^[0-9]{14}$"` to `"^[0-9]{14}([0-9]{3})?$"` (14 or 17 digits). Both legacy and new IDs accepted by `is_valid_id()` in note_id.rs.

**Follow-up Required**:
- **Pre-distribution (must fix)**: Create MigrationModal for Decision 1 compliance. TODO tracked in `src/core/stores/appActions.ts`.
- **Testing (optional, future)**: Performance test with 10K+ notes; Unicode filename testing; disk-full resilience.
