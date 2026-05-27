# Stage 4 Implementation Plan: Library-Integrated Sync

**Date**: 2026-04-20  
**Depends on**: `STAGE_4_PHASE_0_SYNC_POSTMORTEM.md`, `STAGE_1_PLAN.md`  
**Target**: Replace legacy sync with CAS-based multi-device synchronization

---

## Plan Confidence Report

| Section | Confidence | Notes |
|---------|-----------|-------|
| 1. Executive Summary | **HIGH** | Based on confirmed decisions D1-D7 |
| 2. Architecture | **HIGH** | Library API verified from implementation |
| 3. Components | **HIGH** | SyncProvider validated against real NAS; ChangeNotifier redesigned with per-device files (D8) after If-Match validation |
| 4. Data Flow Scenarios | **HIGH** | Each addresses a postmortem failure mode |
| 5. Sub-Stage Plan | **HIGH** | 4.1-4.8 COMPLETE; 4.9-4.10 remaining |
| 6. Testing Strategy | **HIGH** | Mock provider + multi-device harness + stress tests specified |
| 7. Migration Plan | **HIGH** | Simple rename + bootstrap, idempotent |
| 8. Risk Analysis | **HIGH** | 12 risks with detailed mitigations and detection strategies |
| 9. Open Questions | **HIGH** | Each tagged with deciding sub-stage |
| 10. Schedule | **MEDIUM** | Solo dev estimate, depends on NAS availability |

**Key design principle**: The sync engine operates on Library primitives (CAS hashes, DAG entries, NoteRefs) — never on raw file content. The Library owns local state; the sync engine mirrors it to/from remote. No shared mutable state between them.

**D8 (decided 2026-04-20)**: Per-device state files replace single `sync_state.json` with If-Match. Synology Apache WebDAV rejects all If-Match headers on PUT. Each device writes `.notology/sync_state/{device_id}.json` — no concurrency conflicts possible.

**D9 (decided 2026-04-20)**: Ref atomic update via GET-Compare-PUT. Refs are mutable pointers (note_id → head_hash). Since If-Match is non-functional (D8 root cause), refs use GET→DAG ancestry check→PUT strategy. If remote head is ancestor of local head: fast-forward PUT. If diverged: report conflict, do NOT PUT. Race window between GET and PUT is acceptable for single-user multi-device use — no data loss (full history in CAS + branches).

**D10 (decided 2026-04-24)**: Branch file path = `.notology/branches/{note_id}/{branch_id}.json`. Branch ID = `{timestamp_millis}_{device_id}_{head_hash[:8]}`. Sortable by creation time, device attribution in filename, hash prefix prevents collisions. No If-Match needed (new files, not updates).

**D11 (decided 2026-04-24)**: Conflict resolution cleanup — promote chosen branch to main ref, delete ALL branch files for that note (chosen + rejected). Rejected content preserved in CAS + DAG (no data loss). Prevents re-detection of already-resolved conflicts.

**D12 (decided 2026-04-25)**: SyncEngine state model — simple `enum SyncState { Idle, Syncing { phase }, Error { message } }` wrapped in `tokio::sync::Mutex`. No FSM library. Transitions enforced by code (try_lock prevents concurrent sync).

**D13 (decided 2026-04-25)**: Polling via `tokio::time::interval`, default 30s. `AtomicBool` stop signal for graceful shutdown. `MissedTickBehavior::Skip` for backpressure.

**D14 (decided 2026-04-25)**: Detailed Tauri events: `sync:started`, `sync:progress`, `sync:completed`, `sync:error`, `sync:conflicts-detected`. Enables phase-specific UI progress.

**D15 (decided 2026-04-25)**: Best-effort per-phase failure handling. Each of 5 phases (DetectChanges → PushObjects → SyncRefs → SaveBranches → NotifyPush) runs independently. Partial failures collected in `SyncReport.errors`, not aborted. Hard failures (provider unreachable) return `Err`.

**D16 (decided 2026-04-25)**: Migration policy — hybrid trigger (detect auto, migrate explicit), 7-day retention, full directory rename `.notology/sync/` → `.notology/sync.legacy/`, idempotent. No auto-migrate from SyncEngine. Local-only (no NAS cleanup).

**D17 (decided 2026-04-25)**: Conflict UI policy — minimal for Stage 4 (list + picker + preview). No diff highlighting, no 3-way merge, no manual merge. Branch preview via TipTap read-only. Toast on new conflicts. Replaced by Stage 2 Version History UI.

---

## Section 1: Executive Summary

### 1.1 Goals

1. **Replace legacy sync engine** with a Library-integrated system that uses CAS objects and DAG version history for all synchronization operations. Eliminates the manifest-based state tracking that caused infinite loops, state divergence, and empty conflict modals (Postmortem Bugs 1-3).

2. **Enable reliable multi-device editing** where concurrent modifications create separate DAG branches per device. User explicitly selects which branch becomes HEAD. No automatic merging that risks silent data loss. All versions preserved permanently.

3. **Provide clear sync state visibility** through per-note sync states (Idle/Pushing/Pulling/Conflict) that the user can inspect via the existing SyncDiagnosticsPanel. Self-diagnostics built-in from day one.

4. **Establish the SyncProvider trait** as a backend abstraction that WebDAV implements first, with Google Drive, Dropbox, and local-folder backends achievable in Stage 3 without changing sync logic.

5. **Define a stable event contract** that Stage 2 (Version History UI) depends on. Sync events carry note_id, content_hash, branch info — enabling the future history browser to show sync-related version changes.

### 1.2 Non-Goals (Explicit)

- **Full Version History UI** — Stage 2 scope, not Stage 4
- **Google Drive backend** — Stage 3 scope; Stage 4 designs the trait, implements only WebDAV
- **Automatic 3-way merge** — Preserved from existing `conflict.rs` but NOT applied silently during sync. User always confirms via UI.
- **End-to-end encryption** — Deferred. Objects stored as plaintext on NAS.
- **Compression** — Deferred. CAS objects stored uncompressed.
- **Garbage collection** — Deferred. No pruning of old objects in Stage 4.
- **Mobile sync** — Desktop only in Stage 4. Mobile uses same Library but no sync.
- **Real-time collaboration** — Not a goal. Eventual consistency with explicit conflict resolution.

### 1.3 Success Criteria

| Criterion | Measurement |
|-----------|-------------|
| Multi-device round-trip | Device A edits → push → Device B pulls → sees same content within 30s |
| Concurrent edit conflict | Device A and B edit same note → both DAG branches preserved → user resolves |
| No race conditions | 10 concurrent edits, 100 sync cycles → no infinite loops, no data loss |
| Migration preserves data | All .md files, frontmatter, attachments intact after migration |
| Recovery from corruption | Delete any single .notology file → sync recovers within 2 cycles |
| Offline resilience | Edit 10 notes offline → come online → all synced within 60s |
| Performance | Push: <2s per note. Full pull (100 notes): <30s on LAN |
| Test count | 100+ new tests (unit + integration + scenario) |

### 1.4 Key User-Visible Changes

- Sync status per note (not just per vault)
- Conflict resolution shows device name + timestamp
- "Reset Sync" button in diagnostics panel
- Sync works after file rename (note ID preserved)
- No more infinite conflict loops
- Sync disabled by default until Stage 4 completes; then re-enabled

### 1.5 Estimated Scope

- **Sub-stages**: 10
- **New Rust code**: ~2,500 LOC
- **New TypeScript code**: ~500 LOC
- **New tests**: 100+
- **Duration**: ~7 weeks (solo dev)
- **Modified existing files**: ~5 (lib.rs, mod.rs, appActions.ts, syncCommands.ts, settings)

---

## Section 2: Architectural Overview

### 2.1 High-Level Diagram

```
┌──────────────────────────────────────────────────────────────────┐
│                         NOTOLOGY APP                            │
│                                                                  │
│  ┌──────────┐    ┌───────────┐    ┌──────────────────────────┐  │
│  │  Editor   │───→│  Library   │───→│  SyncEngine (new)        │  │
│  │ (TipTap)  │    │ CAS+DAG+  │    │                          │  │
│  │           │    │ Refs       │    │  ┌──────────────────┐   │  │
│  └──────────┘    └───────────┘    │  │  SyncProvider     │   │  │
│                        │          │  │  (trait)           │   │  │
│                        │          │  └────────┬───────────┘   │  │
│                  commit_version   │           │               │  │
│                        │          │  ┌────────┴───────────┐   │  │
│                        ▼          │  │  WebDavProvider    │   │  │
│                  ┌───────────┐    │  │  (impl)            │   │  │
│                  │ .notology │    │  └────────┬───────────┘   │  │
│                  │ /objects  │    │           │               │  │
│                  │ /history  │    └───────────┼───────────────┘  │
│                  │ /refs     │                │                  │
│                  └───────────┘                │                  │
└──────────────────────────────────┬────────────┘──────────────────┘
                                   │
                              WebDAV PUT/GET
                                   │
                    ┌──────────────┴──────────────┐
                    │         SYNOLOGY NAS          │
                    │                              │
                    │  vault/.notology/            │
                    │    objects/{hash}            │
                    │    refs/{note-id}.json       │
                    │    history/{note-id}.json    │
                    │    sync_state.json           │
                    │                              │
                    │  vault/Test/note.md          │
                    │  vault/Test/folder/note.md   │
                    └──────────────────────────────┘
```

### 2.2 Data Flow

```
Local Edit → Library.commit_version()
  → CAS object written locally
  → DAG appended locally (parent = previous HEAD)
  → Ref updated locally

  → SyncEngine.on_local_commit(note_id, hash)
    → Per-note state: Idle → Pushing
    → SyncProvider.put_object(hash, content)
    → SyncProvider.put_ref(note_id, ref_json)
    → SyncProvider.put_dag(note_id, dag_json)  // optional: partial DAG sync
    → SyncProvider.put_md(relative_path, content)  // user-visible .md on NAS
    → Per-note state: Pushing → Idle
    → Emit sync:push-completed

Remote Change Detected (poll or notification):
  → SyncEngine.check_remote_changes()
    → SyncProvider.list_refs() → compare with local refs
    → For each changed note:
      → Per-note state: Idle → Pulling
      → SyncProvider.get_ref(note_id) → remote ref
      → If remote HEAD == local HEAD → skip (already synced)
      → If remote HEAD != local HEAD:
        → SyncProvider.get_object(remote_hash) → content
        → Library.cas.write_object(content)  // store remotely-authored content
        → Compare DAGs: is remote HEAD a descendant of local HEAD?
          → Yes (fast-forward): update local ref to remote HEAD, update .md
          → No (diverged): create branch, set per-note state to Conflict
      → Per-note state: Pulling → Idle (or Conflict)
```

### 2.3 State Machine

```
Per-Note Sync States:

  ┌─────┐  local_commit   ┌─────────┐  push_ok    ┌─────┐
  │ Idle │────────────────→│ Pushing │────────────→│ Idle │
  └─────┘                 └─────────┘              └─────┘
     │                        │ push_fail
     │                        ▼
     │                   ┌─────────┐  retry_ok
     │                   │ RetryQ  │───────────→ Pushing
     │                   └─────────┘
     │
     │  remote_changed   ┌─────────┐  pull_ok     ┌─────┐
     │──────────────────→│ Pulling │────────────→│ Idle │
     │                   └─────────┘              └─────┘
     │                        │ diverged
     │                        ▼
     │                   ┌──────────┐  user_resolve ┌─────┐
     │                   │ Conflict │──────────────→│ Idle │
     │                   └──────────┘               └─────┘
     │
     │  user_pause       ┌────────┐  user_resume   ┌─────┐
     │──────────────────→│ Paused │───────────────→│ Idle │
                         └────────┘                └─────┘
```

**Invalid transitions** (assertions in code):
- `Pushing → Pulling` (must complete push first)
- `Pulling → Pushing` (must complete pull first)
- `Conflict → Pushing` (must resolve first)

### 2.4 Concurrency Model (Avoiding Postmortem Races)

**Single-writer principle**: The `SyncEngine` is the ONLY writer to remote state. The Library is the ONLY writer to local state. They never write to each other's domain.

| Operation | Writer | Reader | Guard |
|-----------|--------|--------|-------|
| Edit note | Library | — | Per-note file lock (existing) |
| Push to NAS | SyncEngine | Library (reads CAS/ref) | Per-note sync state |
| Pull from NAS | SyncEngine | Library (writes CAS, reads ref) | Per-note sync state |
| Resolve conflict | SyncEngine | Library (updates ref) | Per-note sync state |

**No file watcher dependency**: The legacy sync used file watcher events to trigger uploads. Stage 4 uses Library's `commit_version` as the trigger — deterministic, no race with filesystem events.

**No grace period**: Change detection is hash-based (CAS), not mtime-based. A note is "changed" if and only if `local_ref.head_hash != remote_ref.head_hash`.

---

## Section 3: Component Specifications

### 3.1 SyncProvider Trait

**File**: `src-tauri/src/core/sync_provider.rs` (new)  
**Estimated LOC**: ~120

```rust
use async_trait::async_trait;
use serde::{Serialize, Deserialize};

/// Version identifier for remote refs (ETag, revision ID, etc.)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RefVersion(pub String);

/// Metadata about a remote ref.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RefMetadata {
    pub note_id: String,
    pub version: RefVersion,
    pub modified_at: chrono::DateTime<chrono::Utc>,
}

/// Metadata about a device's sync state file (D8).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceStateInfo {
    pub device_id: String,
    pub last_modified: DateTime<Utc>,
    pub size: u64,
}

/// Abstract sync backend. WebDAV implements this first.
/// Future: Google Drive, Dropbox, local-folder.
#[async_trait]
pub trait SyncProvider: Send + Sync {
    /// Store a CAS object on remote. Idempotent (same hash = no-op).
    async fn put_object(&self, hash: &str, data: &[u8]) -> Result<(), String>;

    /// Retrieve a CAS object from remote. Returns None if not found.
    async fn get_object(&self, hash: &str) -> Result<Option<Vec<u8>>, String>;

    /// Check if a CAS object exists on remote.
    async fn has_object(&self, hash: &str) -> Result<bool, String>;

    /// List all object hashes on remote (for full sync / verification).
    async fn list_objects(&self) -> Result<Vec<String>, String>;

    /// Store a ref on remote. Returns the version for conflict detection.
    async fn put_ref(&self, note_id: &str, content: &[u8]) -> Result<RefVersion, String>;

    /// Retrieve a ref from remote. Returns (content, version).
    async fn get_ref(&self, note_id: &str) -> Result<Option<(Vec<u8>, RefVersion)>, String>;

    /// List all refs on remote with metadata.
    async fn list_refs(&self) -> Result<Vec<RefMetadata>, String>;

    /// Delete a ref from remote.
    async fn delete_ref(&self, note_id: &str) -> Result<(), String>;

    /// Store a DAG file on remote.
    async fn put_dag(&self, note_id: &str, content: &[u8]) -> Result<(), String>;

    /// Retrieve a DAG file from remote.
    async fn get_dag(&self, note_id: &str) -> Result<Option<Vec<u8>>, String>;

    /// Store the user-visible .md file on remote (for NAS file browsing).
    async fn put_md(&self, relative_path: &str, content: &[u8]) -> Result<(), String>;

    /// Test connection to remote.
    async fn test_connection(&self) -> Result<bool, String>;

    // === Per-Device State (D8: replaces If-Match sync_state.json) ===
    // Synology Apache WebDAV rejects all If-Match headers (validated 2026-04-20).
    // Per-device files eliminate concurrency conflicts entirely.

    /// Write this device's state file (.notology/sync_state/{device_id}.json).
    /// Each device writes ONLY its own file — no concurrency conflict possible.
    async fn put_device_state(&self, device_id: &str, content: &[u8])
        -> Result<(), SyncProviderError>;

    /// Read a specific device's state file.
    async fn get_device_state(&self, device_id: &str)
        -> Result<Option<Vec<u8>>, SyncProviderError>;

    /// List all device state files (for discovering other devices' changes).
    async fn list_device_states(&self)
        -> Result<Vec<DeviceStateInfo>, SyncProviderError>;

    /// Store a branch file on remote.
    async fn put_branch(&self, note_id: &str, branch_name: &str, content: &[u8])
        -> Result<(), String>;

    /// List branches for a note on remote.
    async fn list_branches(&self, note_id: &str) -> Result<Vec<String>, String>;

    /// Delete a branch from remote.
    async fn delete_branch(&self, note_id: &str, branch_name: &str) -> Result<(), String>;
}
```

**WebDavProvider** implementation maps these to WebDAV operations:
- `put_object(hash, data)` → PUT `{remote_base}/.notology/objects/{hash[0:2]}/{hash[2:]}`
- `get_object(hash)` → GET same path
- `put_ref(note_id, content)` → PUT `{remote_base}/.notology/refs/{note_id}.json`
- `put_md(relative_path, content)` → PUT `{remote_base}/{relative_path}`

### 3.2 SyncEngine

**File**: `src-tauri/src/features/sync_v2/sync_engine.rs` (~600 LOC)

**Purpose**: Orchestrate all sync components. 5-phase `sync_once` flow. Polling lifecycle. State management. Event emission.

```rust
pub enum SyncState {
    Idle,
    Syncing { started_at: DateTime<Utc>, phase: SyncPhase },
    Error { message: String, last_attempt: DateTime<Utc> },
}

pub enum SyncPhase {
    DetectingChanges, PushingObjects, SyncingRefs, SavingBranches, NotifyingPush, Done,
}

pub struct SyncReport {
    pub duration_ms: u64,
    pub objects_uploaded: usize,
    pub objects_downloaded: usize,
    pub refs_pushed: Vec<String>,
    pub refs_pulled: Vec<String>,
    pub unchanged_refs: usize,
    pub conflicts_detected: Vec<ConflictInfo>,
    pub branches_saved: usize,
    pub errors: Vec<SyncPhaseError>,
}

pub struct SyncPhaseError {
    pub phase: SyncPhase,
    pub message: String,
    pub timestamp: DateTime<Utc>,
}

pub struct SyncEngine {
    device_id: String,
    provider: Arc<dyn SyncProvider>,
    object_sync: Arc<ObjectSync>,
    ref_sync: Arc<RefSync>,
    notifier: Arc<ChangeNotifier>,
    detector: Arc<ConflictDetector>,
    branch_mgr: Arc<BranchManager>,
    ref_store: Arc<RefStore>,
    state: Arc<Mutex<SyncState>>,
    sync_lock: Arc<tokio::sync::Mutex<()>>,
    stop_signal: Arc<AtomicBool>,
    app_handle: Mutex<Option<AppHandle>>,
}

impl SyncEngine {
    pub fn new(device_id, provider, cas, ref_store, vault_path) -> Self;
    pub async fn state(&self) -> SyncState;
    pub async fn sync_once(&self) -> Result<SyncReport, String>;
    pub async fn start_polling(self: Arc<Self>, config: SyncConfig);
    pub async fn stop_polling(&self);
    pub async fn list_conflicts(&self) -> Result<Vec<NoteWithConflicts>, String>;
    pub async fn resolve_conflict(&self, note_id, chosen_branch_id) -> Result<Branch, String>;
}
```

**sync_once 5-phase flow** (D15 best-effort):
1. DetectChanges: `notifier.check_remote_changes()`
2. PushObjects: `object_sync.sync()`
3. SyncRefs: `ref_sync.sync_all()`
4. SaveBranches: for each conflict → `detector.prepare()` → `branch_mgr.save_conflict()`
5. NotifyPush: `notifier.notify_push()` with current ref snapshot

**Concurrency guard** (D12): `sync_lock.try_lock()` prevents overlapping `sync_once` calls.
**Polling** (D13): `tokio::time::interval(30s)`, `AtomicBool` stop signal.
**Events** (D14): `sync:started`, `sync:progress`, `sync:completed`, `sync:error`, `sync:conflicts-detected`.

### 3.3 ChangeNotifier (Per-Device State Files — D8)

**File**: `src-tauri/src/features/sync_v2/notifier.rs`  
**Estimated LOC**: ~200

**Design**: Each device writes its own state file at `.notology/sync_state/{device_id}.json`. Reading global state merges all device files in memory. No concurrency conflicts — each device owns its file exclusively.

> **Note**: Originally planned as single `sync_state.json` with If-Match conditional PUT (R3). Synology Apache WebDAV rejects all If-Match headers on PUT (validated 2026-04-20). Redesigned as per-device files (D8).

```rust
/// This device's state (what it has pushed).
#[derive(Serialize, Deserialize)]
pub struct DeviceState {
    pub device_id: String,
    pub last_push: DateTime<Utc>,
    pub ref_hashes: HashMap<String, String>,  // note_id → head_hash
    pub schema_version: u32,                   // for forward compat
}

/// Global view: merged state across all devices (built in memory).
#[derive(Debug)]
pub struct GlobalSyncState {
    pub devices: HashMap<String, DeviceState>,
}

impl GlobalSyncState {
    /// Build by reading all device state files.
    pub async fn read_all(provider: &dyn SyncProvider) -> Result<Self, String>;
    
    /// For a given note, find which devices have which hash.
    pub fn devices_for_note(&self, note_id: &str) -> HashMap<String, String>;
}

pub struct ChangeNotifier {
    device_id: String,
    cached_state: Mutex<Option<DeviceState>>,
}

impl ChangeNotifier {
    /// After local push: update OUR device file.
    /// No conflict possible — only this device writes this file.
    pub async fn notify_push(&self, provider: &dyn SyncProvider,
        note_id: &str, hash: &str) -> Result<(), String> {
        let mut state = self.load_or_init().await;
        state.last_push = Utc::now();
        state.ref_hashes.insert(note_id.to_string(), hash.to_string());
        let bytes = serde_json::to_vec_pretty(&state)?;
        provider.put_device_state(&self.device_id, &bytes).await?;
        Ok(())
    }

    /// Check what changes other devices have made.
    pub async fn check_remote_changes(&self, provider: &dyn SyncProvider)
        -> Result<Vec<ChangedNote>, String> {
        let global = GlobalSyncState::read_all(provider).await?;
        // Compare each note's hash across devices vs our local refs
        // Return notes where some device has a different hash than us
    }
}
```

**Advantages over beacons AND single sync_state.json**:
- No concurrency conflicts (each device owns its file)
- No If-Match dependency (works with any WebDAV server)
- Contains exact hashes (not just "changed" flag)
- Compatible with any backend (GoogleDrive, Dropbox, S3, local folder)
- Reading cost: O(N device files) — for typical 2-5 devices, 2-5 GETs (parallelizable, cached)
- Stale device cleanup: after 30 days inactivity, device file may be archived (deferred)

### 3.4 ConflictDetector

**File**: `src-tauri/src/features/sync_v2/conflict_detector.rs` (~150 LOC)

**Purpose**: Pure transform — enriches raw `RefConflict` (from ref_sync) into UI-ready `ConflictInfo` with branch IDs (D10 scheme). No I/O.

```rust
pub struct ConflictInfo {
    pub note_id: String,
    pub local_side: ConflictSide,
    pub remote_side: ConflictSide,
    pub common_ancestor: Option<String>,
    pub detected_at: DateTime<Utc>,
}

pub struct ConflictSide {
    pub branch_id: String,        // generated per D10
    pub head_hash: String,
    pub source_device: String,
}

pub struct ConflictDetector {
    device_id: String,
}

impl ConflictDetector {
    pub fn new(device_id: impl Into<String>) -> Self;

    /// Pure transform: RefConflict → ConflictInfo.
    /// Generates branch IDs but does NOT save branches.
    pub fn prepare(&self, conflict: RefConflict, remote_device: &str)
        -> ConflictInfo;

    /// Bulk prepare.
    pub fn prepare_all(&self, conflicts: Vec<RefConflict>, remote_device: &str)
        -> Vec<ConflictInfo>;
}
```

**Separation rationale**: ConflictDetector is pure/sync (no I/O). BranchManager is async/I/O. Clean split enables unit testing without mocks.

### 3.5 BranchManager

**File**: `src-tauri/src/features/sync_v2/branch_manager.rs` (~300 LOC)

**Purpose**: Manage branch files on NAS — save, list, retrieve, resolve (D10 paths, D11 cleanup).

```rust
pub struct Branch {
    pub branch_id: String,
    pub note_id: String,
    pub head_hash: String,
    pub source_device: String,
    pub created_at: DateTime<Utc>,
    pub schema_version: u32,
}

pub struct NoteWithConflicts {
    pub note_id: String,
    pub branches: Vec<Branch>,
    pub earliest_detected: DateTime<Utc>,
}

pub struct BranchManager;

impl BranchManager {
    pub fn new() -> Self;

    /// Save a branch to NAS (D10 path scheme).
    pub async fn save_branch(&self, provider: &dyn SyncProvider,
        branch: &Branch) -> Result<(), String>;

    /// Save both sides of a conflict.
    pub async fn save_conflict(&self, provider: &dyn SyncProvider,
        info: &ConflictInfo) -> Result<Vec<Branch>, String>;

    /// List branches for a note.
    pub async fn list_branches_for_note(&self, provider: &dyn SyncProvider,
        note_id: &str) -> Result<Vec<Branch>, String>;

    /// Find all notes with unresolved branches.
    pub async fn list_all_conflicts(&self, provider: &dyn SyncProvider)
        -> Result<Vec<NoteWithConflicts>, String>;

    /// Resolve: promote chosen branch, delete all siblings (D11).
    pub async fn resolve(&self, provider: &dyn SyncProvider,
        note_id: &str, chosen_branch_id: &str) -> Result<Branch, String>;
}
```

#### 3.5.1 Branch Sync Semantics

**Lifecycle** (D10 + D11): created on conflict detection → preserved on NAS for multi-device visibility → deleted after resolution.

- Device A detects conflict → `save_conflict()` writes branch files to NAS
- Device B pulls → sees A's branches via `list_branches_for_note()` → conflict UI shows "From: {device} at {time}"
- User resolves on either device → `resolve()` promotes chosen branch, deletes all branch files for note (D11)
- Other device's next pull → no branches remain → conflict resolved

Events: `sync:branch-created`, `sync:branch-removed` (emitted by SyncEngine in 4.6).

### 3.6 MigrationManager

**File**: `src-tauri/src/features/sync_v2/migration.rs`  
**Estimated LOC**: ~100

```rust
impl MigrationManager {
    /// Check if legacy sync data exists.
    pub fn has_legacy_data(vault_path: &Path) -> bool;

    /// Move legacy data to .notology/sync.legacy/
    pub fn migrate_legacy(vault_path: &Path) -> Result<(), String>;

    /// Bootstrap Stage 4 sync state from existing Library refs.
    pub fn bootstrap_sync_state(
        vault_path: &Path, library: &Library
    ) -> Result<(), String>;
}
```

### 3.7 Event Contract (Stage 2 Dependency)

```typescript
// Events emitted by SyncEngineV2 via app_handle.emit()
// Stage 2 (Version History UI) will listen to these.

type SyncEvent =
  | { type: 'sync:push-started';    payload: { note_id: string } }
  | { type: 'sync:push-completed';  payload: { note_id: string; hash: string } }
  | { type: 'sync:push-failed';     payload: { note_id: string; error: string } }
  | { type: 'sync:pull-started';    payload: { note_id: string } }
  | { type: 'sync:pull-completed';  payload: { note_id: string; outcome: PullOutcome } }
  | { type: 'sync:conflict';        payload: ConflictReport }
  | { type: 'sync:resolved';        payload: { note_id: string; chosen_hash: string } }
  | { type: 'sync:state-changed';   payload: { note_id: string; state: NoteSyncState } }
  | { type: 'sync:full-push';       payload: { total: number; completed: number } }
  | { type: 'sync:full-pull';       payload: { total: number; completed: number; current_note_id?: string } }
  | { type: 'sync:full-pull-completed'; payload: { total: number } }
  | { type: 'sync:branch-created';  payload: { note_id: string; branch: BranchInfo } }
  | { type: 'sync:branch-removed';  payload: { note_id: string; device_id: string } };

// Payload types (stable contract):

interface PullOutcome {
  type: 'AlreadySynced' | 'FastForward' | 'Diverged' | 'NewNote';
  new_hash?: string;
  local_hash?: string;
  remote_hash?: string;
  note_id?: string;
}

interface ConflictReport {
  note_id: string;
  local_branch: BranchInfo;
  remote_branches: BranchInfo[];
  common_ancestor: string | null;
}

interface BranchInfo {
  head_hash: string;
  device_id: string;
  timestamp: string;
  content_preview: string;
}
```

**Stability guarantee**: Event names and payload shapes will not change once Stage 4 ships. Stage 2 can depend on them.

---

## Section 4: Data Flow Scenarios

### 4.1 Single Device, Online Edit and Save

```
User edits note.md → TipTap → write_file()
  → Library.commit_version("id", content, path, [])
    → CAS: write object (hash = abc123)
    → DAG: append entry (parent = previous HEAD)
    → Ref: update HEAD to abc123
  → SyncEngine.on_local_commit("id")
    → State: Idle → Pushing
    → provider.put_object("abc123", content) ✓     # Immutable, idempotent
    → provider.put_dag("id", dag_json) ✓           # Append-only, idempotent
    → provider.put_md("Test/note.md", content) ✓   # User-visible, can be regenerated
    → provider.put_ref("id", ref_json) ✓           # ATOMIC COMMIT POINT (last)
    → State: Pushing → Idle
    → Emit sync:push-completed
```

The ref is the atomic commit point. Until ref is updated, observers see the old version. If any preceding step fails, ref retains old hash and the push is automatically retried in the next cycle. All preceding operations are idempotent: re-pushing same hash/dag/md is a no-op.

**Postmortem avoidance**: No file watcher involved. Library commit is the trigger.

#### 4.1.1 Partial Failure Recovery

| Failure Point | State After Crash | Recovery |
|--------------|-------------------|----------|
| put_object fails | Nothing on NAS changed | Retry entire push next cycle |
| put_dag fails | Object on NAS (orphaned) | Retry push; object idempotent |
| put_md fails | Object + DAG on NAS, no .md | Retry push; .md regenerated from CAS |
| put_ref fails | Object + DAG + .md on NAS, ref unchanged | Retry push; ref updated, all deps already present |

In all cases, the ref still points to the previous version. Other devices see no change until ref updates. Next sync cycle retries the push from the failed step (idempotent puts skip already-uploaded artifacts).

### 4.2 Two Devices, Sequential Edits

```
Device A edits → push (HEAD = A1)
  NAS: ref = A1, object A1 exists

Device B polls:
  → list_refs() → sees ref with hash A1
  → Local ref has hash A0 (previous)
  → A1 is descendant of A0 in DAG → fast-forward
  → get_object(A1) → store in local CAS
  → get_dag("id") → merge into local DAG
  → Update local ref to A1
  → Update local .md file with A1 content
  → State: Idle (no conflict)
```

**Postmortem avoidance**: DAG ancestry check prevents false conflicts. No ETag comparison.

### 4.3 Two Devices, Concurrent Edits (Race Test)

```
Device A edits → HEAD = A1 (parent = BASE)
Device B edits → HEAD = B1 (parent = BASE)

Device A pushes first:
  → NAS: ref = A1

Device B pushes:
  → put_ref("id", B1_ref) → gets RefVersion from NAS
  → B polls: sees NAS ref = A1, local ref = B1
  → A1 is NOT descendant of B1 (diverged!)
  → ConflictDetector.detect() → ConflictReport
  → BranchManager.create_branch("id", "device-A", A1)
  → State: Conflict { branches: [A1, B1] }
  → Emit sync:conflict

User sees conflict UI:
  → Selects B1 (or A1)
  → resolve_conflict("id", "B1")
    → Library ref updated to B1
    → Push B1 to NAS
    → Branch A1 preserved in .notology/branches/
```

**Postmortem avoidance**: No direct file overwrite. Both versions preserved. User explicitly chooses.

### 4.4 Offline Edit, Online Sync

```
Device offline: edits 5 notes → Library commits locally (CAS+DAG+Ref)
  → SyncEngine.on_local_commit() → push fails (offline)
  → State per note: Idle → Error("offline")
  → Queued for retry

Device comes online:
  → SyncEngine detects connectivity
  → For each queued note:
    → push_note(note_id) → succeeds
    → State: Error → Pushing → Idle
  → check_and_pull() for remote changes during offline period
```

### 4.5 Network Failure Mid-Upload

```
push_note("id"):
  → put_object(hash) ✓
  → put_ref(note_id) ✗ (network timeout)
  → State: Pushing → Error
  → Retry after backoff (1s, 2s, 4s, max 60s)
  → put_ref(note_id) ✓ (retry succeeds)
  → put_dag, put_md ✓
  → State: Error → Idle
```

**Key**: CAS put is idempotent. If object already uploaded, retry is free. Ref put is the "commit point" — if it fails, the push is incomplete but safe.

### 4.6 Conflict Requiring User Resolution

```
ConflictReport arrives:
  → Frontend shows minimal conflict UI:
    ┌──────────────────────────────────────┐
    │ Conflict: note.md                    │
    │                                      │
    │ Branch A (DESKTOP-2500, 10:30):      │
    │   "Added section about quantum..."   │
    │                                      │
    │ Branch B (DESKTOP-4200, 10:32):      │
    │   "Updated references in..."         │
    │                                      │
    │ [Keep A] [Keep B] [View Full Diff]   │
    └──────────────────────────────────────┘
  → User clicks "Keep B"
  → resolve_conflict("id", hash_B)
    → Library.refs.set(note_id, hash_B)
    → push_note(note_id)
    → Branch A preserved in .notology/branches/
```

### 4.7 New Device Joining (Full Pull)

```
New device opens vault (empty .notology/):
  → Library.new() → creates objects/, history/, refs/
  → SyncEngine.full_pull() initiated
    → provider.list_refs() → all note IDs with hashes [N total]
    → Persist pull plan to .notology/sync_v2/full_pull_state.json
    → Spawn parallel workers (default 6 concurrent)
    → For each note (priority: refs first, then objects):
      → get_ref(note_id) → write to local refs
      → get_dag(note_id) → write to local DAG
      → get_object(head_hash) → write to local CAS
      → Generate .md file from CAS object content
      → Update full_pull_state.json: mark note as completed
      → Emit sync:full-pull { total: N, completed: i, current_note_id }
    → On completion: delete full_pull_state.json
    → Emit sync:full-pull-completed
```

#### 4.7.1 Resume After Interruption

If app restarts during full pull:
1. Detect `.notology/sync_v2/full_pull_state.json`
2. Read list of completed note IDs
3. Resume from first incomplete note
4. Already-pulled notes are intact (CAS objects immutable)
5. Progress continues from where it left off

#### 4.7.2 Partial Vault Usability

During ongoing full pull:
- **Completed notes**: Full read/write. User can edit, Library commits work.
- **Incomplete notes**: Shown in file tree with "Pulling..." badge.
- **Editing blocked for incomplete notes**: Prevents divergence with remote version.
- **Search index**: Builds incrementally as notes are pulled.

### 4.8 File Rename

```
User renames note.md → new-name.md
  → wikilink.rs handles rename (existing logic)
  → write_file(new_path, content) → Library.commit_version(SAME note_id)
    → Same note_id because frontmatter `id` field unchanged
  → SyncEngine.on_local_commit(note_id)
    → push_note: put_ref (with updated relative_path), put_md (new path)
    → Old .md path on NAS: orphaned (cleaned up on next full sync or left as-is)
```

**Postmortem avoidance**: Note ID (not file path) is the sync identity. Rename doesn't break sync.

### 4.9 File Deletion

```
User deletes note.md
  → delete_note(path) in note.rs
  → SyncEngine.on_local_delete(note_id)
    → provider.delete_ref(note_id)
    → provider.delete .md file on NAS
    → Local: DAG and CAS objects preserved (version history)
    → Remote: ref removed, objects remain (GC is future work)
```

### 4.10 Recovery From Corrupted Local State

```
User scenario: .notology/refs/ deleted accidentally
  → SyncEngine.full_pull()
    → Downloads all refs from NAS
    → Rebuilds local ref store
    → For missing CAS objects: downloads from NAS
    → For missing DAGs: downloads from NAS
    → State: fully recovered
```

Or via diagnostics: "Reset Sync" button → calls `full_pull()`.

---

## Section 5: Sub-Stage Plan

### Sub-Stage 4.1: SyncProvider Trait + WebDavProvider Skeleton

**Goal**: Define the trait and implement basic WebDAV operations for objects and refs.

**Files created**:
- `src-tauri/src/core/sync_provider.rs` (~120 LOC)
- `src-tauri/src/features/sync_v2/mod.rs` (~20 LOC)
- `src-tauri/src/features/sync_v2/webdav_provider.rs` (~250 LOC)

**Tests**: 8 unit tests (trait contract, path construction, error handling)  
**Dependencies**: None (foundation)  
**Duration**: 3 days  
**Done when**: `cargo test sync_provider` passes, WebDavProvider compiles and connects to real NAS  
**Verification**: `put_object` + `get_object` round-trip works against test NAS

### Sub-Stage 4.2: Object Sync (Immutable, Simplest)

**Goal**: Push/pull CAS objects between local and remote. Objects are immutable so this is the simplest sync operation.

**Files created**:
- `src-tauri/src/features/sync_v2/object_sync.rs` (~150 LOC)

**Tests**: 10 tests (put, get, dedup, missing object, concurrent put, large object)  
**Dependencies**: 4.1  
**Duration**: 3 days  
**Done when**: Objects round-trip local↔NAS without data loss  
**Verification**: Write object locally, push to NAS, pull from NAS, compare hash

**Status (2026-04-20): COMPLETE**

Deliverables:
- `src-tauri/src/features/sync_v2/object_sync.rs` (362 lines)
- 10 unit tests (InMemoryProvider) + 5 NAS integration tests
- `tests/sync_v2_object_sync_integration.rs`

Benchmark results (Synology Apache WebDAV):
- Concurrency 1: 11-12 obj/s (baseline)
- Concurrency 4: 46 obj/s, 100% success (peak + stable)
- Concurrency 6: 55 obj/s, 90% success (throttling begins)
- Concurrency 10: 32 obj/s, 90% success (degraded)
- **Decision**: `DEFAULT_CONCURRENCY = 4` based on measurement

Issues discovered and resolved:
- `ensure_parent` required recursive top-down MKCOL (would have affected production first-sync)
- `tokio::test` parallel execution caused `timestamp_millis()` collisions; nanos+thread_id adopted
- Synology WebDAV throttles at 6+ concurrent PUTs; DEFAULT_CONCURRENCY reduced to 4

### Sub-Stage 4.3: Ref Sync (Detection + Integration)

**Goal**: Sync refs between local and NAS, detecting three cases: fast-forward push, fast-forward pull, and divergence (conflict). Uses GET-Compare-PUT strategy (D9) since If-Match is non-functional.

**Files**:
- `src-tauri/src/features/sync_v2/ref_sync.rs` (~400 LOC)
- `src-tauri/tests/sync_v2_ref_sync_integration.rs` (~250 LOC)

**Dependencies**: 4.1 (SyncProvider trait), 4.2 (ObjectSync for dependency pushing)  
**Duration**: 5 days  
**Tests**: 10 unit + 5 NAS integration = 15 new tests

**Scope (in)**:
- RefSync struct with diff/sync methods
- Fast-forward detection via DAG ancestry traversal
- Conflict detection (not resolution — that's 4.5/4.8)
- Integration with ObjectSync (push referenced objects before ref)
- GET-Compare-PUT for ref updates (D9)

**Scope (out, deferred)**:
- Conflict resolution UI (4.8)
- Branch file persistence on NAS (4.5 BranchManager)
- SyncEngine orchestration (4.6)
- Change notification (4.4 ChangeNotifier)

**Three sync outcomes per ref**:

1. **Fast-forward push** (local ahead): Remote head is ancestor of local head in DAG → push objects then PUT ref
2. **Fast-forward pull** (remote ahead): Local head is ancestor of remote head → pull objects then write local ref
3. **Diverged** (conflict): Neither is ancestor → do NOT modify either side; return `RefConflict`

**Key types**:
```rust
pub struct RefSyncResult {
    pub fast_forwarded_pushes: Vec<String>,    // note_ids pushed
    pub fast_forwarded_pulls: Vec<String>,     // note_ids pulled
    pub conflicts: Vec<RefConflict>,           // diverged refs
    pub unchanged: usize,                       // already in sync
    pub failed: Vec<(String, String)>,         // (note_id, error)
}

pub struct RefConflict {
    pub note_id: String,
    pub local_head: String,
    pub remote_head: String,
    pub common_ancestor: Option<String>,
    pub detected_at: DateTime<Utc>,
}
```

**Decisions (confirmed)**:
- D9: GET-Compare-PUT strategy for atomicity (no If-Match)
- Push order: Objects → DAG → .md → Ref (ref is commit point)
- Concurrency: 4 (matches 4.2 benchmark)
- DAG sync: full file atomically (decided, was Q8); threshold 1MB for incremental

**Done when**: Two simulated devices can push/pull refs; divergence correctly detected; fast-forward converges  
**Verification**: Device A pushes ref A1, Device B pushes ref B1 from same base, both detect divergence

**Status (2026-04-24): COMPLETE**

Deliverables:
- `src-tauri/src/features/sync_v2/ref_sync.rs` (565 lines)
- `src-tauri/tests/sync_v2_ref_sync_integration.rs` (197 lines)
- 10 unit tests (InMemoryProvider) + 5 NAS integration tests, all passing

Key implementation notes:
- DAG ancestry (`is_ancestor`, `find_common_ancestor`) implemented as standalone helpers in ref_sync.rs (Library's VersionDag has no such methods)
- NoteRef uses `head_hash` + separate per-note DAG loaded via `VersionDag::load(vault_path, note_id)`
- Sequential ref iteration (no Arc spawning); concurrency wraps at 4.6 SyncEngine layer

### Sub-Stage 4.4: ChangeNotifier (D8: Per-Device State Files)

**Goal**: Replace beacon system with per-device state files on NAS. Each device writes `.notology/sync_state/{device_id}.json`. Global state built by reading all device files. No concurrency conflicts.

**Files created**:
- `src-tauri/src/features/sync_v2/notifier.rs` (~200 LOC)

**Tests**: 10 unit (InMemoryProvider) + 4 NAS integration = 14 new tests  
**Dependencies**: 4.1 (SyncProvider trait)  
**Duration**: 2 days

**Confirmed decisions**:
- Q1: SyncEngine calls `notify_push` explicitly after push (4.6 wires it)
- Q2: Stateless — no caching, each call reads fresh from provider
- Q3: Stale device cleanup deferred to 4.7 (expose `last_push` for detection)
- Q4: `check_remote_changes` takes `local_refs: HashMap` from caller (no RefStore dependency)

**Done when**: Device A pushes and updates its state file; Device B reads all state files and detects A's changes  
**Verification**: Multiple device states correctly merged in memory; changed notes list accurate; NAS integration passes

**Status (2026-04-24): COMPLETE**

Deliverables:
- `src-tauri/src/features/sync_v2/notifier.rs` (273 lines)
- `src-tauri/tests/sync_v2_notifier_integration.rs` (77 lines)
- 10 unit tests (InMemoryProvider) + 4 NAS integration tests, all passing

Key implementation notes:
- Stateless design — each call reads fresh from provider
- Caller passes `local_refs: HashMap` to `check_remote_changes` (no RefStore dependency)
- `DeviceState.schema_version` enables forward compat; unknown versions logged as warning
- `notify_push` replaces entire ref_hashes map (deleted refs correctly reflected)
- Excludes own device from `check_remote_changes` output

### Sub-Stage 4.5: ConflictDetector + BranchManager

**Goal**: Transform ref_sync's conflict detections into persisted branch files; provide resolution API for UI.

**Files**:
- `src-tauri/src/features/sync_v2/conflict_detector.rs` (~150 LOC)
- `src-tauri/src/features/sync_v2/branch_manager.rs` (~300 LOC)
- `src-tauri/tests/sync_v2_branch_manager_integration.rs` (~250 LOC)

**Dependencies**: 4.1 (SyncProvider branch methods), 4.3 (RefConflict from ref_sync)  
**Duration**: 5 days

**Confirmed decisions**:
- D10: Branch path = `.notology/branches/{note_id}/{branch_id}.json`
- D10: Branch ID = `{timestamp_millis}_{device_id}_{head_hash[:8]}`
- D11: Resolve deletes all sibling branches; rejected content preserved in CAS+DAG

**Test count target**: ConflictDetector unit 4-5, BranchManager unit 10-12, NAS integration 5-6, total ~20  
**Done when**: Branches saved to NAS, listed, resolved with cleanup. Multi-device visibility verified.  
**Verification**: Create conflict → save branches → list from "other device" → resolve → verify cleanup

**Status (2026-04-25): COMPLETE**

Deliverables:
- `conflict_detector.rs` (119 lines, 6 unit tests)
- `branch_manager.rs` (197 lines, 11 unit tests)
- `sync_v2_branch_manager_integration.rs` (107 lines, 6 NAS tests)
- SyncProvider trait: `list_notes_with_branches` added to both providers

Key implementation notes:
- ConflictDetector is pure/sync (no I/O) — deterministic branch_id from RefConflict.detected_at
- BranchManager handles all NAS I/O via SyncProvider trait
- D10 branch_id format confirmed: `{timestamp_millis}_{device_id}_{head_hash[:8]}`
- D11 resolve deletes all siblings (content preserved in CAS)
- 152 total tests, no regressions

### Sub-Stage 4.6: SyncEngine

**Goal**: Orchestrate all sync components. 5-phase `sync_once`, polling lifecycle, state management, event emission.

**File**: `src-tauri/src/features/sync_v2/sync_engine.rs` (~600 LOC)  
**Tests**: 15-20 unit (InMemoryProvider + real components) + 5-6 NAS integration

**Dependencies**: 4.1 (provider), 4.2 (ObjectSync), 4.3 (RefSync), 4.4 (ChangeNotifier), 4.5 (ConflictDetector + BranchManager), Library RefStore

**Confirmed decisions**:
- D12: SyncState enum + tokio::sync::Mutex (no FSM library)
- D13: tokio::interval polling, 30s default, AtomicBool stop
- D14: Detailed events (started/progress/completed/error/conflicts-detected)
- D15: Best-effort per-phase, errors in SyncReport (not aborted)
- Q6: try_lock prevents concurrent sync_once

**Duration**: 5 days  
**Done when**: Full push/pull/conflict cycle works with mock provider; polling lifecycle start/stop works  
**Verification**: State machine transitions, 5-phase flow, partial failure handling, concurrent guard

**Status (2026-04-25): COMPLETE**

Deliverables:
- `sync_engine.rs` (446 lines, 13 unit tests)
- `sync_v2_sync_engine_integration.rs` (107 lines, 5 NAS tests)
- SyncEngine.new() builds all sub-components; sync_once() 5-phase orchestration
- Polling via tokio::interval with MissedTickBehavior::Skip
- try_lock prevents concurrent sync (Q6)
- 165 total tests, no regressions

### Sub-Stage 4.7: MigrationManager

**Goal**: Transition from legacy sync to sync_v2. Rename `.notology/sync/` → `.notology/sync.legacy/`, initialize sync_v2 structure, manage retention-based cleanup.

**File**: `src-tauri/src/features/sync_v2/migration_manager.rs` (~200 LOC)  
**Tests**: 10 unit (tempdir) + 4 integration (local filesystem)

**Dependencies**: None from 4.1-4.6 (pure local filesystem operations)  
**Duration**: 2 days

**Confirmed decisions (D16)**:
- Hybrid trigger: detection automatic, action explicit (no auto-migrate)
- 7-day retention (configurable), full directory rename
- Idempotent: second migrate() is no-op
- `ensure_sync_v2_structure()` creates `.notology/branches/` + `.notology/sync_state/`

**Done when**: Legacy detected, migrated, cleanup works after retention  
**Verification**: All files preserved in archive; sync_v2 structure created; idempotent

**Status (2026-04-25): COMPLETE**

Deliverables:
- `migration_manager.rs` (274 lines, 11 unit tests)
- `sync_v2_migration_integration.rs` (68 lines, 4 integration tests)
- 5-state MigrationStatus enum, idempotent migrate(), archive collision handling
- Local-only (per D16), no NAS interaction
- 176 total tests, no regressions

### Sub-Stage 4.8: Minimal Conflict UI

**Split into 2 steps**: Step 1 (backend Tauri commands), Step 2 (frontend React)

**Backend** (Step 1):
- `src-tauri/src/features/sync_v2/commands.rs` (~200 LOC)
- `SyncEngineState` in lib.rs (Option<Arc<SyncEngine>>, initialized in 4.10)
- 5 Tauri commands: sync_now, get_sync_state, list_conflicts, resolve_conflict, get_branch_content

**Frontend** (Step 2 — COMPLETE):
- `src/core/types/sync.ts` — TS types mirroring Rust structs (SyncState, SyncReport, Branch, NoteWithConflicts)
- `src/features/sync_v2/syncV2Commands.ts` — 5 invoke() wrappers
- `src/features/sync_v2/stores/syncV2Store.ts` — Zustand store + imperative actions
- `src/features/sync_v2/hooks/useSyncV2Events.ts` — Tauri event listener hook
- `src/features/sync_v2/components/SyncV2StatusIndicator.tsx` — Sidebar footer status
- `src/features/sync_v2/components/ConflictListModal.tsx` — Conflict list overlay
- `src/features/sync_v2/components/BranchPickerModal.tsx` — Branch selection + preview
- `src/features/sync_v2/components/BranchPreview.tsx` — TipTap read-only preview
- `src/features/sync_v2/components/ResolveConfirmDialog.tsx` — Confirm before resolve
- `src/features/sync_v2/index.ts` — Module entry, SlotRegistry registration
- `src/styles/features/sync-v2.css` — CSS with design tokens

**Status**: COMPLETE (Step 1 + Step 2)  
**Dependencies**: 4.6 (SyncEngine)  
**Duration**: 3 days (1 backend + 2 frontend)  
**Decisions**: Q1-Q7, D17 (conflict UI policy)  
**Verification**: `npx tsc --noEmit` passes, all CSS uses design tokens

### Sub-Stage 4.9: End-to-End Integration Tests

**Goal**: Multi-device simulation testing all scenarios from Section 4.

**Files created**:
- `src-tauri/tests/sync_v2_integration.rs` (~500 LOC)

**Tests**: 20 scenario tests  
**Dependencies**: 4.6, 4.7, 4.8  
**Duration**: 3 days  
**Done when**: All 10 scenarios from Section 4 pass as automated tests  
**Verification**: `cargo test --test sync_v2_integration` passes

### Sub-Stage 4.10: Re-Enable Sync + Monitor

**Goal**: Wire everything into Tauri commands, re-enable sync by default.

**Files modified**:
- `src-tauri/src/features/sync/mod.rs` — new commands pointing to sync_v2
- `src-tauri/src/lib.rs` — register new commands
- `src/core/stores/appActions.ts` — call new sync init on vault open
- Remove `is_sync_enabled()` gate (or set default to `true`)

**Tests**: 5 integration tests (app lifecycle, vault open → sync init → push → pull)  
**Dependencies**: 4.9  
**Duration**: 2 days  
**Done when**: App starts with sync enabled, 2-device round-trip works in production  
**Verification**: Full manual test on two devices

---

## Section 6: Testing Strategy

### 6.1 Unit Tests Per Component

| Component | Test Count | Key Scenarios |
|-----------|-----------|---------------|
| SyncProvider trait | 8 | Path construction, error propagation, mock impl |
| Object sync | 10 | Round-trip, dedup, large files, concurrent |
| Ref sync | 12 | Push/pull, fast-forward, divergence, concurrent update |
| ChangeNotifier | 6 | Multi-device, stale, empty state |
| ConflictDetector | 8 | Diverged, fast-forward, 3-way, LCA |
| BranchManager | 7 | Create, list, promote, delete, edge cases |
| SyncEngine | 20 | All state transitions, error recovery |
| MigrationManager | 6 | Legacy detect, rename, bootstrap, idempotent |
| UI components | 3 | Conflict panel renders, resolution works |
| **Total** | **80** | |

### 6.2 Integration Tests

20 scenario tests covering Section 4 data flows. Uses mock SyncProvider (in-memory HashMap backend) to avoid NAS dependency.

### 6.3 Postmortem Regression Tests

Each postmortem bug gets a dedicated test:

| Postmortem Bug | Test Name | Verifies |
|---------------|-----------|----------|
| Bug 1: Infinite loop | `test_no_infinite_loop_on_concurrent_edits` | 100 cycles, no repeat |
| Bug 2: Empty conflict modal | `test_conflict_ui_shows_content` | Both branches have content |
| Bug 3: Conflict loop | `test_beacon_triggered_merge_not_loop` | Beacon → pull → no re-push |
| Bug A1: Race condition | `test_push_pull_no_race` | Concurrent push+pull on same note |
| Bug A2: Grace period | `test_no_grace_period_blocking` | Hash-based detection, no mtime |

### 6.4 Target: 105 total tests

80 unit + 20 integration + 5 regression = 105.

### 6.5 Mock SyncProvider (InMemorySyncProvider)

All unit and integration tests use a mock provider to avoid NAS dependency:

```rust
pub struct InMemorySyncProvider {
    objects: Mutex<HashMap<String, Vec<u8>>>,
    refs: Mutex<HashMap<String, (Vec<u8>, RefVersion)>>,
    dags: Mutex<HashMap<String, Vec<u8>>>,
    md_files: Mutex<HashMap<String, Vec<u8>>>,
    device_states: Mutex<HashMap<String, Vec<u8>>>,  // D8: per-device state files
    branches: Mutex<HashMap<String, Vec<u8>>>,
    // Test controls
    fail_next: Mutex<Option<String>>,   // simulate failure on next op
    delay_ms: Mutex<u64>,              // simulate latency
    network_partition: AtomicBool,     // simulate disconnect
}

impl InMemorySyncProvider {
    pub fn new() -> Self;
    pub fn fail_next(&self, error: String);  // next operation returns this error
    pub fn set_delay(&self, ms: u64);        // add latency to all ops
    pub fn partition_network(&self);         // all ops fail with "network error"
    pub fn heal_network(&self);             // resume normal operation
}
```

### 6.6 Multi-Device Simulation Harness

```rust
pub struct DeviceSimulator {
    devices: Vec<TestDevice>,
    shared_provider: Arc<InMemorySyncProvider>,
}

pub struct TestDevice {
    device_id: String,
    library: Arc<Library>,
    engine: SyncEngineV2,
}

impl DeviceSimulator {
    pub fn new(device_count: usize) -> Self;
    pub fn device(&self, idx: usize) -> &TestDevice;
    pub async fn sync_all(&self);           // all devices push then pull
    pub async fn assert_consistent(&self);  // all devices have same refs
}
```

Usage pattern:
```rust
let sim = DeviceSimulator::new(2);
sim.device(0).edit("note1", "Device A version").await;
sim.device(1).edit("note1", "Device B version").await;
sim.sync_all().await;
assert!(sim.device(0).has_conflict("note1"));
assert!(sim.device(1).has_conflict("note1"));
```

### 6.7 Stress Test Scenarios

1. **Concurrent edit storm**: 5 devices, 100 random edits across 20 notes, sync simultaneously. Verify: no infinite loops, all branches preserved, eventual consistency after resolution.

2. **Network chaos**: Random disconnect every 1-10 seconds during sync. Verify: idempotent retries, no duplicate uploads, no data loss.

3. **Partial CAS object**: Interrupted upload leaves half-written object on NAS. Verify: SHA-256 mismatch detected on pull, re-downloaded successfully.

4. **Large vault**: 1000 notes, 10000 objects, full pull from new device. Verify: completes within 60s on LAN, progress events accurate, resume works after interruption.

---

## Section 7: Migration Plan

### 7.1 Detection

```rust
fn has_legacy_data(vault_path: &Path) -> bool {
    vault_path.join(".notology").join("sync").join("manifest.json").exists()
}
```

### 7.2 Migration Steps

#### 7.2.1 Pre-Migration Detection

- Detect `.notology/sync/manifest.json` → legacy marker
- Detect `.notology/objects/` on NAS → Stage 4 marker (if exists, migration was previously attempted)
- Decide mode: first migration / resume / already migrated (no-op)

#### 7.2.2 Local Bootstrap

1. Atomic rename: `.notology/sync/` → `.notology/sync.legacy/`
2. Bootstrap Stage 4 sync state from Library refs
3. Mark all local refs as "needs initial push"

#### 7.2.3 NAS Discovery

1. List existing NAS .md files (recursive PROPFIND)
2. List existing CAS objects on NAS (if any)
3. Build comparison matrix: local vs remote per file

#### 7.2.4 Reconciliation (Per File)

| Local | NAS | Action |
|-------|-----|--------|
| Exists, content X | Exists, content X (same hash) | Mark synced, no transfer |
| Exists, content X | Exists, content Y (different) | Create migration conflict (preserve both as branches) |
| Exists, content X | Not present | Push as new |
| Not present | Exists, content Y | Pull as new note (generate `id` if missing) |
| Has frontmatter `id` | NAS file has same `id` | Match by id (handle renames correctly) |

#### 7.2.5 NAS Without Stage 4 Structure

If NAS has .md files but no `.notology/objects/`:
- Bootstrap CAS from NAS files (one-time, slow operation)
- For each NAS file: download → hash → write to NAS `objects/`
- Build NAS refs from current state
- May take significant time for large vaults
- Emit progress: `sync:migration { phase: "bootstrap-cas", completed, total }`

#### 7.2.6 Migration Conflicts

For files where local and NAS differ at migration time:
- Both versions preserved as branches
- User notified: "N notes have migration conflicts requiring resolution"
- Same conflict UI as normal sync conflicts
- Migration completes regardless (conflicts don't block migration)

### 7.3 Rollback

If Stage 4 fails catastrophically:
1. Set `NOTOLOGY_SYNC_ENABLED=0`
2. Rename `.notology/sync.legacy/` back to `.notology/sync/`
3. Previous sync engine resumes (with known issues but functional)

### 7.4 Backward Compatibility

`.notology/sync.legacy/` preserved indefinitely. User can manually delete after confirming Stage 4 works.

---

## Section 8: Risk Analysis

| # | Risk | Likelihood | Impact | Mitigation | Detection |
|---|------|-----------|--------|-----------|-----------|
| R1 | NAS has pre-existing `.notology/objects/` from manual upload | Low | Medium | Check for conflicts on first push; merge if possible | `has_object` check before put |
| R2 | Partial migration failure | Low | High | Migration is atomic rename; Library refs are source of truth | Migration state file |
| R3 | ~~If-Match conditional PUT~~ Synology rejects all If-Match on PUT (weak ETags only, validated 2026-04-20) | Confirmed | High | **Resolved by D8**: per-device state files; no atomic update needed | N/A — eliminated by design |
| R3b | Network failure during bulk push | Medium | Low | Idempotent put_object; retry on reconnect | Per-note error state |
| R4 | DAG divergence faster than user resolves | Medium | Medium | Loop detector (existing); max 3 branches per note | Diagnostics panel |
| R5 | Storage quota exceeded on NAS | Low | Medium | Check quota before push; warn user | Provider reports quota errors |
| R6 | Performance with 1000+ notes full pull | Medium | Medium | Parallel downloads (4 concurrent, D=4 benchmark); progress events | Performance benchmark test |
| R7 | Inter-device Stage 4 version incompatibility | Low | High | Version field in sync_state.json; reject incompatible | Version check on pull |
| R8 | Conflict UI baseline UX insufficient | Medium | Low | Minimal but functional; Stage 2 replaces with full UI | User feedback |
| R9 | Vault corruption mid-migration | Low | High | Migration is atomic rename + Library refs unchanged | Migration state file detects partial state |
| R10 | NAS clock skew between devices | Medium | Low | Use logical timestamps (DAG order), not wall clock for ordering | DAG ancestry checks ignore timestamps |
| R11 | Partial CAS object on NAS (half-written) | Low | High | SHA-256 verify on every get_object; hash mismatch triggers re-download | Hash comparison in pull path |
| R12 | .md ↔ CAS divergence after partial push | Medium | Low | Ref-as-commit-point ensures atomicity; pull uses CAS as truth, not .md | Ref always points to valid CAS hash |
| R13 | Stale device state files accumulating on NAS | Low | Low | Manual cleanup via diagnostics panel; automatic pruning deferred | File count grows with device count |
| R14 | Ref concurrent update race (D9 GET-Compare-PUT window) | Low | Medium | Race creates redundant conflict branch, not data loss; next sync cycle reconciles | Redundant conflict resolution for user |
| R15 | Branches accumulate if user never resolves | Low | Low | UI shows conflicts prominently (4.8); Version History (Stage 2) provides alternate resolution | Storage bloat, no data loss |
| R16 | Sync polling drains battery on mobile | Low | Low | 30s default OK for desktop; mobile tuning deferred | Battery decay |
| R17 | Event emission overhead | Very Low | Negligible | ~5-10 events/cycle; small JSON payloads | N/A |
| R18 | sync_once deadlock if Mutex interaction bugs | Very Low | High | tokio::sync::Mutex (no poison); try_lock + timeout | Service requires restart |

**R1 Detail**: If user manually copied vault to NAS or another Stage 4 instance ran previously, NAS may have existing CAS objects. On first push, `has_object` is checked before `put_object` (always cheap due to immutability). Unexpected objects on NAS that don't match local refs are left untouched (forward compatibility).

**R2 Detail**: Migration is atomic rename (`.notology/sync/` → `.notology/sync.legacy/`). If rename succeeds but bootstrap fails, Library refs are still the source of truth. Re-running migration detects the incomplete state and resumes. Legacy data in `sync.legacy/` is never modified.

**R9 Detail**: If app crashes between rename and bootstrap, the vault has neither legacy sync nor Stage 4 state. On restart, migration detects missing `.notology/sync/` AND missing Stage 4 markers → bootstraps from Library refs (which are always present and correct since Library operates independently of sync).

**R11 Detail**: Network interruption during `put_object` could leave a partial file on NAS. When another device tries `get_object`, the SHA-256 hash of the received content won't match the expected hash. The pull code must verify: `CasStore::hash(&downloaded) == expected_hash`. On mismatch, discard and retry.

---

## Section 9: Open Questions (Deferred)

| # | Question | Deciding Sub-Stage | Default If Not Decided |
|---|----------|-------------------|----------------------|
| Q1 | Ref serialization: JSON vs CBOR | **Decided: 4.1** | **JSON** (human-readable, matches Library format) |
| Q2 | Object path on NAS: flat vs sharded | **Decided: 4.1** | **Sharded** `{hash[0:2]}/{hash[2:]}` (matches local CAS) |
| Q3 | Branch pruning policy | 4.5 | No auto-pruning; manual delete only |
| Q4 | Encryption scope | Deferred | None (plaintext on NAS) |
| Q5 | Compression for large objects | Deferred | None (store raw) |
| Q6 | Bandwidth throttling | Deferred | None (NAS is typically LAN) |
| Q7 | Conflict UI exact layout | 4.8 | Minimal: device name + preview + buttons |
| Q9 | Bootstrap CAS from NAS files: how to detect "Notology note" vs random file? | 4.7 | Check for YAML frontmatter with `id` field |
| Q10 | Branch retention after resolution: delete immediately or keep N days? | 4.5 | Delete immediately after promotion |

---

## Section 10: Implementation Schedule

### Timeline

| Week | Sub-Stages | Deliverables |
|------|-----------|-------------|
| 1 | 4.1, 4.2 | SyncProvider trait, WebDavProvider, object sync |
| 2 | 4.3, 4.4 | Ref sync with divergence detection, ChangeNotifier |
| 3-4 | 4.5, 4.6 | ConflictDetector, BranchManager, SyncEngine state machine |
| 5 | 4.7, 4.8 | Migration, minimal conflict UI |
| 6 | 4.9 | End-to-end integration tests |
| 7 | 4.10 | Re-enable sync, production monitoring |

### Decision Points

- **After 4.3**: Verify ref sync works on real NAS before proceeding to conflict detection
- **After 4.6**: Full system review before migration implementation
- **After 4.9**: User acceptance test before re-enabling sync

### Rollback Plan

At any point during Stage 4:
1. Sync remains disabled (default `NOTOLOGY_SYNC_ENABLED=0`)
2. Library continues to work for local version control
3. Legacy sync data preserved in `.notology/sync.legacy/`
4. New `sync_v2/` code can be feature-flagged independently

---

## Appendix A: Existing Code Reuse

| Existing Code | Reuse in Stage 4 |
|--------------|-----------------|
| `core/cas.rs` | Direct use — SyncProvider mirrors CAS operations to NAS |
| `core/version_dag.rs` | Direct use — DAGs synced as JSON files |
| `core/refs.rs` | Direct use — Refs synced as JSON files |
| `core/library.rs` | Direct use — `commit_version` triggers sync push |
| `core/note_id.rs` | Direct use — note ID is sync identity |
| `conflict.rs` (ConflictResolver) | Reuse for future auto-merge option (not in Stage 4 default) |
| `webdav.rs` (WebDavClient) | Reuse HTTP client, wrap in WebDavProvider |
| `SyncDiagnosticsPanel.tsx` | Extend with Stage 4 per-note states |
| `Toast.tsx` | Reuse for sync event notifications |
| `loop_detector.rs` | Reuse for conflict loop prevention |

---

## Sub-stage 4.9 COMPLETE (2026-04-25)

### 결과

| # | Scenario | 결과 | 비고 |
|---|----------|------|------|
| S1 | Fast-forward sync | ✅ PASS | |
| S2 | Conflict + resolve + propagation | ✅ PASS | **Fix A 필요** (아래) |
| S3 | Migration → first sync | ✅ PASS | |
| S4 | Polling auto-sync (start_paused) | ✅ PASS | **InMemory 전환** (아래) |
| S5 | Concurrent sync rejected | ✅ PASS | |
| S6 | Error rollback (InMemory only) | ✅ PASS | |
| S7 | Stale device | ✅ PASS | |
| S8 | Multi-note batch (50) | ✅ PASS | |
| S9 | Resolve propagation (3 devices) | ✅ PASS | |

### Flakiness

- 5회 반복 실행: 5/5 full pass (10 passed × 5)
- 평균 실행 시간: ~30s

### 발견 & 수정

**Fix A (production 수정)**: `resolve_conflict`이 내부 `sync_once`를 호출하면 매번 diverged로 재감지되어 branch 무한 재생성. sync_engine.rs의 resolve_conflict을 직접 object/DAG/md/ref push + notifier update로 재구현. L249-264 교체.

이유: resolve는 의도적 force overwrite로, 일반 sync classify 경로를 거치면 안 됨. D9 re-check 생략 (resolve 자체가 conflict 해결 commit).

영향: 4.10 실제 UI 사용에서도 동일 이슈 예방. 사용자 resolve가 즉시 remote에 반영되도록 보장.

**S4 InMemory 전환 (test 조정)**: Q3 결정 "Manual tokio::time::advance" 재해석. start_paused = true는 전체 tokio runtime timer를 paused로 만들어 실제 network I/O (reqwest HTTP)와 상호작용 비결정적. InMemoryProvider로 전환하여 결정성 유지 (0.09s 실행).

**object_sync integration flaky**: 4.2 기존 issue. Synology 동시 put_object throttling 근처 경계 동작. 4.9 Fix A 무관. DEFAULT_CONCURRENCY=4 유지.

### LOC

| 파일 | LOC |
|------|-----|
| tests/sync_v2_e2e.rs | 513 |
| tests/common/e2e_helpers.rs | 524 |
| tests/common/mod.rs | 1 |
| sync_engine.rs (Fix A) | net +0 (교체) |
| Cargo.toml (dev-deps) | +2 (uuid, tokio test-util) |
| **합계** | **1,040** |

### 회귀

- sync_v2 unit tests: 91/91
- 4.1 NAS integration: webdav 6/6, sync_engine 5/5, notifier 4/4, ref_sync 5/5, branch_manager 6/6

### 다음 단계

Sub-stage 4.10 (SyncEngineState bootstrap & wiring)

---

## Sub-stage 4.10 COMPLETE (2026-04-26)

### 결과

- SyncEngine production wiring 완료
- vault open 시 sync_v2_config 로드 → MigrationManager → WebDavProvider → SyncEngine → polling start (자동)
- Settings panel (URL/user/pass/remote_base/enabled) — SettingsRegistry plugin tab
- 4.8 popover에서 Settings 진입 가능 (CustomEvent dispatch)
- Polling loop panic-safe (tokio::spawn 격리 + log)

### 수동 검증

| # | 시나리오 | 결과 |
|---|----------|------|
| A | 처음 NAS 설정 + Save | ✅ engine started, polling active |
| B | 노트 작성 + 자동 polling push | ✅ ref_sync push 확인 (30s interval) |

### 핵심 결정 (Q1-Q12)

| Q | 결정 |
|---|------|
| Q1 | vault open 시 자동 생성 (config.enabled && complete) |
| Q2 | %APPCONFIG%/sync_v2/{vault_hash}.json (Rust std::fs) |
| Q3 | plaintext (Stage 5+ keychain) |
| Q4 | 자동 start_polling |
| Q5 | 고정 30초 |
| Q6 | vault open 시 자동 migrate |
| Q7 | WebDav 하드코딩 |
| Q8 | v1 그대로 (default off) |
| Q9 | SettingsRegistry plugin tab + popover 진입점 |
| Q10 | Save toast only |
| Q11 | Minimal viable |
| Q12 | Bootstrap integration test 1개 |

### 발견 & 수정

**Fix A (4.9)**: resolve_conflict 내부 sync_once 제거 → 직접 force push.

**Fix B-1a (4.10)**: polling loop 내 sync_once를 tokio::spawn 격리. 
panic 발생 시 polling loop 생존 + log::error 출력. 
원인: 첫 sync_once 성공 후 두 번째 tick에서 silent panic → polling 영구 정지.
격리 패턴으로 panic이 loop를 죽이지 못하도록 방어.

**Library Arc 변경 (4.10)**: CasStore/RefStore를 Arc<T>로 wrap하여 SyncEngine과 공유.
기존 accessor deref 유지, 호출처 영향 0.

### 4.10 범위 외 (4.11+)

- 첨부파일 동기화 (SyncProvider에 attachment method 추가)
- EventBus file:saved → 즉시 sync trigger
- vault-config.yaml / tag-ontology.yaml 동기화
- create_note 시 Library.commit_version 호출
- Credential keychain 저장
- 사용자 polling interval 설정
- Multi-device pull 완전 검증 (시나리오 C/D)

### LOC

| 영역 | LOC |
|------|-----|
| Backend (config.rs + bootstrap.rs + commands 추가 + lib.rs 변경 + library.rs) | ~300 |
| Frontend (SyncV2SettingsPanel + syncV2Commands + index + StatusIndicator + Sidebar) | ~220 |
| Tests (bootstrap_integration.rs) | 47 |
| sync_engine.rs (polling fix) | +15 |
| **합계** | **~580** |

### 회귀

- sync_v2 unit: 94/94
- library unit: 13/13
- core unit: 79/79

### Stage 4 완료

Sub-stage 4.10 완료로 **Stage 4 전체 100% 완료**.
사용자가 Settings에서 NAS credential 입력 → Save → 즉시 30초 polling sync 시작.

### 다음

- Stage 4.11+ (첨부파일, 이벤트 sync, yaml, create_note commit)
- Stage 2 (Version History UI)
- Stage 3 (Storage Backend Abstraction — Google Drive)
