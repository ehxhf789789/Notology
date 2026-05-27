# Stage 4 Phase 0: Current Sync Failure Analysis (Postmortem)

**Date**: 2026-04-20  
**Status**: Complete  
**Purpose**: Document why the current WebDAV-based sync failed, as foundation for Stage 4 redesign

---

## 1. Original Sync Architecture

### 1.1 WebDAV Model

The sync system uses RFC 4918 WebDAV (PROPFIND/GET/PUT/DELETE/MKCOL/MOVE) to synchronize a local vault with a Synology NAS. Key components:

- **WebDavClient** (`webdav.rs`, 572 lines): HTTP operations with Basic auth, self-signed cert acceptance, TCP keepalive
- **SyncEngine** (`engine.rs`, 1655+ lines): Orchestrates upload, download, merge, beacon, and monitoring
- **SyncManifest** (`engine.rs:56-129`): Records "last known good" state per file — `HashMap<relative_path, BaseEntry{synced_at, etag, is_binary}>`. Base file content stored in `.notology/sync/base/`
- **SyncQueue** (`engine.rs:225-425`): SQLite WAL database for offline pending operations (Upload/Delete/Mkdir)
- **ConflictResolver** (`conflict.rs`, 469 lines): Block-level LCS 3-way merge (base vs local vs remote)
- **Beacons** (`engine.rs:486-594`): Lightweight JSON files on NAS (`.notology/sync/beacon-{device}.json`) for cross-device change notification

### 1.2 Key Data Structures

```rust
// Manifest: what was last synced successfully
pub struct BaseEntry {
    pub path: String,
    pub synced_at: DateTime<Utc>,
    pub etag: Option<String>,
    pub is_binary: bool,
}

// Queue: pending offline operations
pub enum PendingChange {
    Upload { local_path, remote_path, relative_path, timestamp, base_etag },
    Delete { remote_path, relative_path, timestamp, base_etag },
    Mkdir { remote_path, timestamp },
}

// Merge result: auto-merge or user-required conflict
pub enum MergeResult {
    Merged { content: String },
    Conflict { local_version, remote_version, conflict_blocks },
}
```

### 1.3 Sync Flow Overview

Three concurrent entry points, synchronized only by a single `flush_gate` Mutex:

1. **File Save → Debounce → Upload**: File watcher → 1s debounce → `flush_queue` → If-Match PUT → manifest update → beacon write
2. **Monitor Polling (8s cycle)**: `check_beacons()` → `targeted_sync()` or `bidirectional_sync()` → download/upload/merge
3. **Bidirectional Sync (5 phases)**: Full PROPFIND → download changed → upload local-only → delete orphans → register untracked

---

## 2. Failure Modes Encountered

### A. Race Conditions

**A1: Beacon → Download → Watcher → Upload Loop** (CRITICAL)

The most severe failure. When Device B modifies a file:
1. Device B writes beacon with changed file
2. Device A's monitor checks beacons, calls `targeted_sync()`
3. `targeted_sync` downloads remote and **overwrites local** (no merge check)
4. File watcher detects local change, queues upload
5. Upload detects ETag mismatch, runs 3-way merge
6. Merge uploads merged content back
7. Next beacon check: Device B's beacon still lists the file → goto step 2

**Code**: `engine.rs:1164-1170` — `targeted_sync` has no merge logic for tracked files that were also modified locally. Direct `atomic_write_file(&local_path, &content)` with no conflict check.

**Why it couldn't be patched**: We added merge logic to `targeted_sync` in a previous fix attempt, but the fundamental issue is architectural — the beacon system creates a notification loop where each device's writes trigger the other's downloads indefinitely.

**A2: Grace Period + Manifest Registration**

When any file is in grace period (<5s since modification), `should_cache_etag` is set to `false` (engine.rs:1282), which prevents Phase 4b from registering untracked files (the registration code was conditioned on `should_cache_etag`). A single actively-edited file blocks manifest registration for the ENTIRE vault.

**Code**: `engine.rs:1269-1293` (grace period check), `engine.rs:1498-1530` (Phase 4b, conditioned on `should_cache_etag`)

### B. State Synchronization

**B1: Manifest Gets Out of Sync**

The manifest has only ONE way to gain entries: `save_base()`, called only on successful download or upload. Files that exist on both sides with matching content are never registered unless they go through a download/upload cycle. After user deleted `manifest.json`, only 2 of 40 files were re-registered (those that went through conflict resolution path).

**B2: In-Memory vs On-Disk Manifest Divergence**

`SyncManifest` is loaded into memory and modified via `tokio::sync::Mutex<SyncManifest>`. The in-memory state can diverge from disk if `save()` fails (e.g., permissions, disk full). On restart, the disk version is loaded — potentially missing entries that were added in-memory.

**Code**: `engine.rs:86-96` — `save()` serializes to JSON and writes atomically, but errors are propagated without retry.

### C. Network Unreliability

**C1: Half-Written Beacons**

Beacon write uses `put_file_atomic` (temp → MOVE), which is safe. But if the app crashes between beacon write and stale cleanup, old beacons persist and trigger false downloads on next launch.

**C2: PROPFIND Response Size**

`list_remote_recursive` (engine.rs:1583-1619) has no exclusion for `#recycle`, `node_modules`, or other large directories. On Synology NAS with recycle bin containing thousands of old files, this caused multi-second PROPFIND responses and unnecessary processing.

### D. Multi-Device Coordination

**D1: No Ownership Model**

No concept of which device "owns" a file version. Both devices can modify simultaneously with no coordination beyond ETag checks. The only synchronization is "whoever uploads last wins" (with 3-way merge for text files, direct overwrite for binary).

**D2: Beacon Semantics Ambiguous**

Beacons say "I changed these files" but don't say "I changed them TO this version." When a beacon is processed, the receiving device doesn't know if the beacon is stale (already processed) or fresh.

### E. Recovery

**E1: No Recovery From Broken Manifest**

When `manifest.json` is corrupted or deleted, there is no automatic recovery path. The sync engine enters an infinite detection loop (sees "new" remote files every cycle, downloads some, skips others due to grace period, never registers them).

**E2: No "Reset Sync" Command**

Users have no way to force a full re-sync or rebuild the manifest from scratch without manually deleting files.

---

## 3. Specific Bugs (With Evidence)

### Bug 1: Infinite "11 Files Changing" Loop

**Symptom**: `[Sync] Bulk sync detected: 11 files changing` every few seconds, indefinitely.

**Root cause** (from `SYNC_DIAGNOSTIC_REPORT.md` Finding 2): Manifest had 2 entries for 40-file vault. 38 files detected as "new from remote" every cycle. Grace period prevented registration. Phase 4b registration conditioned on `should_cache_etag` which was always `false`.

**Fix attempts**:
1. Added Phase 4b manifest registration pass — worked only when no files in grace period
2. Removed `should_cache_etag` condition from Phase 4b — partially worked but still missed files skipped by other conditions

**Why partial**: The grace period check has cascading effects — setting `should_cache_etag = false` affects Phase 4b, ETag caching, and next-cycle behavior.

### Bug 2: Empty Conflict Modal

**Symptom**: Conflict modal shows empty "내 버전" and "NAS 버전" boxes.

**Root cause** (from `SYNC_DIAGNOSTIC_REPORT.md` Finding 1): `ConflictResolver::resolve()` returns `MergeResult::Merged` (auto-merge succeeds with empty base), but frontend only renders `Conflict` variant fields. `local_version` and `remote_version` are `undefined` for `Merged`.

**Root deeper cause** (from `FIX_F_DIAGNOSTIC.md`): The base content was empty because manifest was mostly empty. With empty base, the merge algorithm treats both versions as entirely new non-overlapping additions → auto-merge succeeds → wrong result for user.

### Bug 3: Conflict Loop for `Ggggggjjjjj.md`

**Symptom**: File alternates between upload/conflict/download every 2 seconds.

**Root cause** (from `FIX_F_DIAGNOSTIC.md`): `targeted_sync` downloads remote version without merge check → file watcher detects change → queues upload → upload fails ETag → merge → upload → new beacon → download again.

**Fix attempts**:
1. Added merge logic to `targeted_sync` — correct approach but the loop continued because the beacon from the other device was still present
2. Added loop detector (10 conflicts in 5min → auto-pause) — mitigated but didn't solve root cause

### Bug 4: Modal Rendered Inside Sidebar

**Symptom**: Conflict modal appears clipped to sidebar area, not centered on screen.

**Root cause** (from `SYNC_DIAGNOSTIC_REPORT.md` Finding 4): `SyncConflictBanner.tsx` rendered modal inline (not via `createPortal`), inside sidebar DOM with `overflow: hidden`.

**Fix**: Used `createPortal(overlay, document.body)` — this one was successfully fixed.

### Bug 5: `vault:opened` Double Fire

**Symptom**: `[sync] vault:opened received` appears twice in console.

**Root cause** (from `SYNC_DIAGNOSTIC_REPORT.md` Finding 5): `initializeApp()` calls `openVault()` (emits `vault:opened`), then emits `vault-selected` event, which App.tsx listener catches and calls `openVault()` again.

**Fix**: Removed `vault-selected` emit from auto-reopen path, replaced with direct window show — successfully fixed.

---

## 4. Lessons Learned

### 4.1 Patterns to NOT Carry Into Stage 4

1. **File-path-based identity**: The entire sync system uses relative file paths as the identity key. Renames break the link between manifest, queue, and CAS. Stage 4 must use Library's note ID (frontmatter `id` field).

2. **ETag-only change detection**: ETags are server-provided, opaque, and reset on NAS restart. Stage 4 should use content-based hashing (SHA-256 from Library CAS) for change detection.

3. **Direct file overwrite in download path**: The pattern of `atomic_write_file(local_path, remote_content)` without checking local modifications is the root of all conflict loops. Stage 4 must always merge-before-write.

4. **Manifest as sole source of truth for sync state**: A single JSON file that must be manually maintained is fragile. Library's per-note refs + DAG provide a more robust state model.

5. **Grace period as sync gate**: Using file mtime to defer sync operations creates cascading state invalidation. Stage 4 should use Library's version hash comparison instead.

6. **Concurrent entry points without clear state machine**: Three entry points (file save, monitor polling, beacon) all modify the same state through a single Mutex. Stage 4 needs a proper state machine with well-defined transitions.

### 4.2 Library Primitives That Replace Problematic Patterns

| Current Pattern | Problem | Library Replacement |
|----------------|---------|-------------------|
| File path identity | Renames break sync | Note ID (frontmatter `id`) |
| ETag comparison | NAS restart resets ETags | SHA-256 content hash |
| Manifest base snapshot | Single point of failure | CAS objects (immutable, deduplicated) |
| 3-way merge with fragile base | Empty base = wrong merge | DAG parent tracking (always has correct ancestor) |
| Grace period (mtime-based) | Cascading cache invalidation | Version hash comparison (deterministic) |
| File watcher → queue → upload | Race condition window | Library commit → sync diff → upload |

### 4.3 Cost of Patching

Over multiple sessions, approximately 8-10 fix attempts were made:
- Total code changes: ~500 lines of sync engine modifications
- New infrastructure: loop_detector.rs, Toast.tsx, SyncDiagnosticsPanel.tsx, FIX_F_DIAGNOSTIC.md, SYNC_DIAGNOSTIC_REPORT.md
- User frustration: multiple days of broken sync, data near-loss, manual PowerShell diagnostics
- Conclusion: the architecture cannot be patched — it must be replaced

---

## 5. Constraints for Stage 4 Design

### Must Support
- Multi-device editing (2+ devices, concurrent edits)
- Eventual consistency (offline-first, sync when online)
- Conflict preservation ("Last Device Wins with Full History" per Notology principle)
- All backends: WebDAV (Synology NAS), Google Drive (future)

### Must NOT Have
- Race conditions between file watcher / sync / merge
- Mutable state that can become inconsistent (manifest.json pattern)
- Direct file overwrite without merge check
- Infinite loops under any combination of concurrent edits
- Grace period as sync gate

### Must Have
- Clear recovery mechanism (one-command reset to known-good state)
- Deterministic state (same inputs → same sync decisions)
- Per-note sync state (not per-vault boolean)
- Self-diagnostics (already built: SyncDiagnosticsPanel)

### Must Integrate
- Library CAS (content-addressable objects)
- Library DAG (per-note version history)
- Library Refs (current HEAD per note)
- Library Note ID (stable identity across renames)

---

## 6. Open Questions for Stage 4 Design

1. **Push-based or pull-based?** Current: hybrid (push uploads immediately, pull on timer). Should sync be event-driven (push changes immediately) or clock-driven (poll periodically)?

2. **How to map CAS objects to NAS paths?** Current: 1:1 mapping (note.md ↔ NAS/note.md). Should CAS objects be synced as-is (`.notology/objects/` on NAS) or should only .md files be synced (with Library state derived)?

3. **Sync .notology/ directory?** Current: .notology/sync/ is synced (beacons, manifest). Should Library's .notology/objects/, history/, refs/ be synced too? This would give other devices immediate access to version history.

4. **Device coordination model?** Options:
   - A) No coordination (current): each device uploads/downloads independently
   - B) Token-based: a "sync token" file on NAS records which device last synced
   - C) DAG-based: each device maintains its own branch, merge happens on pull

5. **Conflict UI**: Same block-level merge UI but rebuilt? Or completely new UI based on Library's branch model (compare DAG branches from different devices)?

6. **How to handle the existing `.notology/sync/` data during migration?** Current sync state (manifest, base snapshots, queue) has partial correctness. Can it be converted to Library state, or should it be discarded?

7. **WebDAV vs native Synology API?** Synology has a proprietary File Station API that may be more reliable than WebDAV. Worth investigating for Stage 4?

---

## Summary

The current sync system has fundamental architectural flaws centered on:
1. **Race conditions** between three concurrent entry points (file save, monitor, beacon)
2. **Fragile state** (manifest JSON that gets out of sync with reality)
3. **Missing merge logic** in download paths (overwrites without conflict check)
4. **Identity model** based on file paths (breaks on rename, no version tracking)

These cannot be fixed by patching. Stage 4 will replace the sync engine with a Library-integrated system using content-addressed objects, per-note version DAGs, and a proper state machine for sync operations.

**Current status**: Sync is disabled via `is_sync_enabled()` flag (default `false`). Re-enable with `NOTOLOGY_SYNC_ENABLED=1` environment variable for testing only. Library (CAS + DAG + Refs) continues to work for local version control.
