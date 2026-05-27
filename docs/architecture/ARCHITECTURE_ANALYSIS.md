# Notology Architecture Analysis — Sync Redesign Foundation

**Date**: 2026-04-19  
**Version Analyzed**: v3.0.0 (commit `4732400`)  
**Scope**: Full codebase inventory + gap analysis for Git-philosophy sync redesign

---

## Analysis Confidence Report

| Section | Confidence | Notes |
|---------|-----------|-------|
| 1. Codebase Inventory | **HIGH** | All files read directly, versions verified from package.json/Cargo.toml |
| 2. Current Sync Engine | **HIGH** | All 7 sync files read line-by-line (4,072 lines total) |
| 3. Editor & Storage | **HIGH** | editorConfig.ts, note.rs, frontmatter code all read directly |
| 4. Platform-Specific | **MEDIUM** | Mobile UI code read; actual Android build not tested; no iOS artifacts found |
| 5. History Reconstruction | **HIGH** | Git log, branches, tags, docs/ all inspected |
| 6. Gap Analysis | **HIGH** | Based on direct code reading of all sync modules |
| 7. Risk Assessment | **MEDIUM** | Storage overhead estimates are calculated but not benchmarked |
| 8. Open Questions | **HIGH** | Derived from code analysis, not speculation |
| 9. Stage Ordering | **MEDIUM** | Complexity estimates based on LOC analysis, not team velocity data |

**Inference-based claims** (flagged inline with `[INFERENCE]`):
- Mobile build pipeline status (no CI config for mobile found — inferred from Cargo.toml features)
- Storage overhead estimates (calculated from typical note sizes, not measured)
- Migration time estimates (extrapolated from file I/O benchmarks)

---

## Section 1: Codebase Inventory

### 1.0 Memory/Documentation vs Code Discrepancies

| Source | Claim | Reality | Impact |
|--------|-------|---------|--------|
| CLAUDE.md | "React 18" | **React 19.2.0** (package.json) | React 19 features (use, Actions) available but may not be used |
| Memory notes | "HoverEditor.tsx >2000 LOC, known God Component" | **930 lines**, refactored into 10+ hooks | Component is manageable; hook extraction already done |
| CLAUDE.md | "`lib.rs` (~160 lines)" | **406 lines** | CLAUDE.md outdated; lib.rs has grown significantly |
| CLAUDE.md | "`note.rs` (25 commands)" | **648 lines, ~12 commands** | Command count overstated in CLAUDE.md |
| CLAUDE.md | "sync/mod.rs: 27+ Tauri commands" | **1,404 lines, ~20 commands** | Count approximately correct |
| CHANGELOG.md | Latest version "v1.0.4" | **v3.0.0** (tauri.conf.json, Cargo.toml) | CHANGELOG not maintained since v1.0.4 |

### 1.1 Directory Structure

```
P01_Notology/
├── .claude/                     # Claude Code config (settings.json, settings.local.json)
├── .github/                     # CI/CD workflows, issue templates
├── docs/                        # UPDATE_DEPLOYMENT.md, gifs/
├── icon/                        # App icons (6 files)
├── image/                       # README images
├── public/                      # Static assets
├── schemas/                     # JSON Schema definitions
├── src/                         # Frontend (339 files, 62,409 LOC)
│   ├── core/                    #   Platform essentials (59 files)
│   │   ├── app/                 #     App.tsx, HoverWindowApp.tsx, main.tsx
│   │   ├── editor/              #     editorConfig, editorPool, extensions/
│   │   ├── hooks/               #     useDragDrop, useAppKeyboardShortcuts
│   │   ├── infrastructure/      #     eventBus.ts, slotRegistry.ts
│   │   ├── layout/              #     TitleBar, Sidebar, RightPanel, RibbonBar
│   │   ├── services/            #     tauriCommands (file, note, search, etc.)
│   │   ├── stores/              #     fileTreeStore, uiStore, settingsStore, etc.
│   │   ├── types/               #     TypeScript interfaces
│   │   └── utils/               #     i18n, frontmatter, shortcuts, platform
│   ├── features/                #   Independent modules (187 files)
│   │   ├── hover-windows/       #     HoverEditor + all document viewers (50+ files)
│   │   ├── search/              #     Full-text search UI
│   │   ├── sync/                #     Frontend sync integration
│   │   ├── mobile/              #     Mobile UI (37 files)
│   │   ├── tags/                #     Tag system & ontology
│   │   ├── sketch/              #     Canvas editor
│   │   ├── graph/               #     Knowledge graph
│   │   ├── templates/           #     Note templates
│   │   ├── calendar/            #     Calendar view
│   │   ├── comments/            #     Comments/memos
│   │   ├── metadata/            #     YAML editor, frontmatter hook
│   │   ├── settings/            #     App settings UI
│   │   ├── modals/              #     Dialog components
│   │   ├── vault-config/        #     Vault selector, lock modal
│   │   ├── content-cache/       #     Content + note-type caches
│   │   ├── context-menu/        #     Context menus
│   │   ├── folder-tree/         #     Folder tree component
│   │   ├── suggestions/         #     WikiLink/attachment suggestions
│   │   └── shared/              #     LoadingScreen, shared components
│   ├── design-system/           #   Icon definitions (4 files)
│   ├── styles/                  #   CSS (75 files)
│   └── assets/                  #   Static resources (7 files)
├── src-tauri/                   # Rust backend
│   ├── src/                     #   Source (52 files, 19,895 LOC)
│   │   ├── lib.rs               #     Module registration (406 lines)
│   │   ├── core/                #     types.rs (135), file_io.rs (167)
│   │   ├── features/            #     note, sync, wikilink, attachment, tags, etc.
│   │   │   └── sync/            #       7 files (4,072 lines) — see Section 2
│   │   ├── search/              #     Tantivy engine (2,417), watcher (665), parser (126)
│   │   ├── frontmatter/         #     YAML parsing (4 files, 965 lines)
│   │   ├── memo/                #     Comments indexing (520 lines)
│   │   └── vault_lock.rs        #     Multi-device locking (488 lines)
│   ├── Cargo.toml               #   Rust deps (28+ crates)
│   ├── tauri.conf.json          #   Tauri config
│   └── capabilities/            #   Tauri v2 permissions
└── Config files                 # package.json, tsconfig.json, vite.config.ts, etc.
```

**Total**: ~82,304 LOC (62,409 TypeScript/TSX + 19,895 Rust)

### 1.2 Module Map

#### Rust Modules (by LOC, descending)

| Module | LOC | Purpose | Dependencies |
|--------|-----|---------|-------------|
| `search/mod.rs` | 2,417 | Tantivy full-text search engine | tantivy, serde, regex |
| `features/sync/engine.rs` | 1,655 | Core sync engine: queue, merge, bidirectional sync | rusqlite, chrono, sha2, tokio |
| `features/sync/mod.rs` | 1,404 | Tauri command handlers, debounce, monitor loop | tokio, tauri |
| `features/attachment.rs` | 686 | Attachment management, canvas link detection | regex, walkdir |
| `search/watcher.rs` | 665 | File system watcher with smart debouncing | notify, regex |
| `features/note.rs` | 648 | Note CRUD, SKETCH protection | serde_yaml, chrono |
| `features/sync/webdav.rs` | 572 | RFC 4918 WebDAV client | reqwest, quick-xml |
| `memo/mod.rs` | 520 | Comments/memos indexing | serde_json |
| `vault_lock.rs` | 488 | Multi-device vault locking | chrono, hostname |
| `features/sync/conflict.rs` | 469 | 3-way LCS block merge | serde |
| `features/wikilink.rs` | 420 | WikiLink rename, backlinks | regex, rayon |
| `features/tags.rs` | 405 | Bulk tag operations | serde_yaml, walkdir |
| `features/system.rs` | 402 | GPU detection, NAS detection, URL metadata | reqwest, scraper |
| `features/sync/connections.rs` | 381 | NAS connection history persistence | serde_json, dirs |
| `features/search_commands.rs` | 355 | Search index init/query/reindex | tantivy |
| `features/sync/state.rs` | 329 | SyncConfig/SyncStatus management | serde, chrono |
| `features/preview.rs` | 246 | LibreOffice PDF conversion | tokio::process |
| `frontmatter/types.rs` | 251 | Frontmatter type definitions | serde |
| `frontmatter/schemas.rs` | 205 | JSON Schema for frontmatter | jsonschema |
| `frontmatter/suggestions.rs` | 327 | Frontmatter field suggestions | serde |
| `features/comments.rs` | 208 | Comment CRUD | serde_json |
| `features/sync/realtime.rs` | 182 | WebSocket relay client | tokio-tungstenite, futures-util |
| `frontmatter/mod.rs` | 182 | Frontmatter parsing | serde_yaml |
| `core/file_io.rs` | 167 | Atomic writes, file locks | lazy_static |
| `features/cache.rs` | 141 | Meta cache, batch frontmatter reads | serde_json |
| `core/types.rs` | 135 | Shared structs (FileNode, FileContent) | serde |
| `features/schedule.rs` | 128 | Scheduled tasks | chrono |
| `search/parser.rs` | 126 | Search query parser | — |
| `features/sync/provider.rs` | 55 | CloudProvider trait (skeleton) | async_trait |
| `features/share.rs` | 34 | Share functionality | — |

#### Key React Components (>500 LOC)

| Component | LOC | Purpose |
|-----------|-----|---------|
| `core/utils/i18n.ts` | 2,106 | Korean/English translations |
| `features/search/Search.tsx` | 1,535 | Full-text search UI |
| `features/sketch/useSketchInteraction.ts` | 1,280 | Canvas interaction hooks |
| `features/hover-windows/viewers/docx/docxContentParser.ts` | 1,203 | DOCX XML parser |
| `features/hover-windows/viewers/docx/docxPagination.ts` | 1,146 | DOCX print-layout pagination |
| `features/tags/tagOntologyUtils.ts` | 1,128 | Tag ontology load/save/sync |
| `features/hover-windows/hooks/useHoverEditorHandlers.ts` | 992 | HoverEditor event handlers |
| `features/graph/GraphView.tsx` | 944 | Knowledge graph visualization |
| `features/hover-windows/HoverEditor.tsx` | 930 | Main hover editor (21 responsibilities, 10+ hooks) |
| `features/sketch/SketchEditor.tsx` | 808 | Canvas editor |
| `features/hover-windows/viewers/pptx/pptxShapeParser.ts` | 859 | PPTX shape parsing |

### 1.3 HoverEditor.tsx Breakdown

**Path**: `src/features/hover-windows/HoverEditor.tsx` (930 lines)

Despite earlier characterization as a "God Component", HoverEditor has been refactored into **10+ extracted hooks**, each handling a distinct responsibility:

| Responsibility | Lines | Mechanism |
|---------------|-------|-----------|
| Performance tracking | 49-65 | `mountTimeRef`, dev-only logging |
| Store subscriptions | 67-84 | 14 Zustand selectors |
| Core state | 86-113 | frontmatter, body, isDirty, mtimeOnLoadRef |
| Animation | 114-126 | `useWindowAnimation` hook |
| File resolution | 128-193 | 13 resolver refs for WikiLink plugin |
| Pooled editor lifecycle | 200-344 | editorPool acquire/release, setContent |
| Save logic | 346-421 | Debounced save, mtime tracking, empty-body guard |
| Emergency save | 423-449 | `editorSaveRegistry` for ungraceful shutdown |
| Conflict resolution | 451-497 | `useConflictResolution` hook |
| Comments | 499-595 | `useNoteCommentHandlers` hook |
| Canvas/Sketch | 514-546 | `handleSketchChange`, JSON serialize |
| Content loading | 548-575 | `useContentLoader` hook |
| Note lock | 577-582 | `useNoteLock` hook |
| Drag/resize | 597-612 | `useDragResize` hook |
| Close/minimize | 613-627 | `useCloseMinimize` hook |
| Ctrl+Wheel zoom | 629-636 | `useCtrlWheelZoom` hook |
| Keyboard shortcuts | 638-648 | `useKeyboardShortcuts` hook |
| File drop | 650-665 | `useFileDrop` hook |
| Computed values | 667-704 | fileName, isAttachment, syncStatus |
| Render | 706-930 | JSX with conditional viewers |

### 1.4 Version Verification

| Dependency | CLAUDE.md States | Actual Version | Source |
|-----------|-----------------|----------------|--------|
| React | 18 | **19.2.0** | package.json `"react": "^19.2.0"` |
| Tauri | 2.x | **2.10.2** | Cargo.toml |
| TypeScript | — | **~5.9.3** | package.json devDependencies |
| Vite | — | **7.2.4** | package.json devDependencies |
| Rust Edition | — | **2021** | Cargo.toml |
| Min Rust | — | **1.77.2** | Cargo.toml `rust-version` |
| TipTap | — | **^3.16.0 – ^3.20.0** | package.json (mixed) |
| Zustand | — | **5.0.11** | package.json |
| Tantivy | — | **0.22** | Cargo.toml |
| Reqwest | — | **0.12** | Cargo.toml |
| SQLite (rusqlite) | — | **0.31** (bundled) | Cargo.toml |

**Other notable deps**: `sha2: 0.10` (SHA-256 available), `tokio-tungstenite: 0.24` (WebSocket), `notify: 7` (file watcher, desktop only), `image: 0.25`, `hwpers: 0.3` (HWP rendering, desktop only).

---

## Section 2: Current Sync Engine Analysis

### 2.1 WebDAV Backend

**File**: `src-tauri/src/features/sync/webdav.rs` (572 lines)

#### WebDAV Client Configuration
- `reqwest::Client` with Basic auth, self-signed cert acceptance
- TCP keepalive: 15s, connection timeout: 30s, pool max: 4/host
- Timeout scaling for uploads: 60s base + 60s per 50MB

#### Operations Implemented

| Method | Function | Notes |
|--------|----------|-------|
| PROPFIND (Depth:0) | `test_connection()` | Connectivity check |
| PROPFIND (Depth:1) | `list_files()` | Directory listing with metadata |
| PROPFIND (Depth:0) | `get_metadata()` | Single-file metadata |
| GET | `get_file()` | Download (5min timeout) |
| PUT | `put_file()` | Upload with scaled timeout |
| PUT + If-Match | `put_file_conditional()` | Conditional upload (HTTP 412 on ETag mismatch) |
| PUT + MOVE | `put_file_atomic()` | Atomic: write to temp, then MOVE to final |
| DELETE | `delete_file()` | Idempotent (ignores 404) |
| MOVE | `move_resource()` | Rename with `Overwrite: F` |
| MKCOL | `mkdir()` | Create dir (idempotent, ignores 405) |

#### Debounce Pattern
- **Not 300ms** — the debounce is **1 second** in `mod.rs` (line ~480)
- After a file save event, a 1s `tokio::time::sleep` fires; if no newer event during that 1s, the queue flushes
- Grace period: **5s desktop / 15s mobile** — files modified less than N seconds ago are skipped

#### Chunked Upload
- **None** — files are uploaded whole. Timeout scales linearly with size.

#### Adaptive Timeout
- Upload: `60s + (file_size / 50MB) * 60s`
- Download: fixed 5 minutes
- Connection: 30s

### 2.2 Conflict Model

**3-Document Model (BASE / LOCAL / REMOTE)**:

| Document | Storage | Source |
|----------|---------|--------|
| BASE | `.notology/sync/base/{relative_path}` | Last successfully synced version |
| LOCAL | Actual file in vault directory | Current local state |
| REMOTE | On NAS (WebDAV server) | Current remote state |
| MANIFEST | `.notology/sync/manifest.json` | Metadata: path, synced_at, etag, is_binary per file |

**SHA-256 Integration**: The `sha2` crate is in Cargo.toml but **not used in the sync engine**. All identity/change detection uses WebDAV ETags (server-provided, opaque strings).

**Conflict Detection (engine.rs:914-956)** — ETag-based with mtime verification:

```
remote_etag != base_etag?
  ├── YES → check mtime
  │   ├── |remote_mtime - synced_at| < 2s → NAS restart, NOT a conflict
  │   └── |remote_mtime - synced_at| >= 2s → REAL change detected
  └── NO → no remote change
```

This **dual check** (ETag + mtime) exists specifically to handle NAS restarts where ETags regenerate but content hasn't changed. The 2-second tolerance handles clock granularity.

**No separate frontend mtime-based detection** — the previous mtime-based conflict detection has been replaced by the ETag-based approach in the Rust backend. The frontend only handles conflict *resolution* UI.

**Conflict Resolution Flow**:
1. `ConflictResolver::resolve(base, local, remote)` in `conflict.rs` attempts 3-way merge
2. If non-overlapping changes → auto-merge succeeds, returns `MergeResult::Merged`
3. If overlapping blocks → returns `MergeResult::Conflict` with `ConflictBlock[]`
4. Frontend presents conflict UI via `useConflictResolution` hook
5. User choices: KeepLocal, KeepRemote, BlockMerge (per-block), Custom (free edit)
6. `ConflictResolver::apply_block_choices()` applies resolution

### 2.3 Known Issues Status

| Issue | Status | Evidence |
|-------|--------|----------|
| `selfSaveTracker` 2-event vs 3-event mismatch | **RESOLVED** | Current implementation uses a simple 3-second suppression window (`SUPPRESS_WINDOW_MS = 3_000`) — no event counting |
| `base_etag=None` unconditional conflict | **RESOLVED** | engine.rs:928 handles `(Some(_), None)` case — means remote exists but no base, treated as new file, not unconditional conflict |
| NAS/PC clock skew re-download | **MITIGATED** | 2-second mtime tolerance (engine.rs:935) + grace period (5s/15s) prevents most false positives |
| Frontmatter data loss via `saveFile()` + spread from null | **RESOLVED** | SKETCH protection in note.rs:116-127 blocks saves that would overwrite canvas data; empty-body guard in HoverEditor prevents saving empty content |
| Triple-layer frontmatter write protection in Rust | **CONFIRMED**: (1) SKETCH detection blocks TipTap overwrite (note.rs:116-127), (2) Missing FM auto-restoration for SKETCH files (note.rs:131-147), (3) Atomic write via temp file + rename (file_io.rs:20-42) |

### 2.4 Sync Settings UI

**Current state**: Sync configuration exists in `vaultConfigStore.ts` with `isNasSynced` and `lastSyncResult` fields. The `SyncStatus` enum in `state.rs` defines 8 states (Disconnected, Idle, Syncing, PendingRetry, WaitingForEdits, Offline, Conflict, Error). The UI reflects sync status in the titlebar via slot registry. Settings UI for entering WebDAV credentials exists in `features/settings/Settings.tsx`. **No Google Drive UI exists.**

### 2.5 Deep Dive: `conflict.rs` (469 lines)

**Merge Behavior**: The 3-way merge is **not silent** — it returns `MergeResult::Conflict` when blocks overlap, requiring user arbitration. Only non-overlapping changes are auto-merged.

**Frontmatter Handling**: Frontmatter is extracted before block splitting (`split_frontmatter()` at line 246). If only one side changed FM, that side wins. If both changed FM differently, it triggers a full conflict (even if body blocks are clean).

**Compatibility with "Last Device Wins with Full History"**: The current 3-way merge is **incompatible** with the target architecture. In the new model:
- There is no auto-merge — all concurrent modifications create separate branches
- The user explicitly selects the winning branch or manually merges
- The LCS block diff could be **reused** as a diff visualization tool in the Branch Resolution UI, but the auto-merge logic must be disabled

**What survives**: `split_frontmatter()`, `split_blocks()`, `diff_blocks()`, `lcs_table()` — these utility functions (~200 lines) are valuable for the diff visualization UI. The `ConflictResolver::resolve()` auto-merge flow (~170 lines) and `apply_block_choices()` (~70 lines) need replacement.

### 2.6 Deep Dive: `realtime.rs` (182 lines)

**Protocol**: WebSocket (RFC 6455) over `tokio-tungstenite`. JSON text frames.

**Message Format**:
- Outbound: `{"type": "changed", "files": ["path1.md", "path2.md"]}`
- Inbound: Same format, with added `"device"` field from relay server

**Architecture**: Client-side only. Expects a relay server (Docker container on NAS, not included in this repo). No server implementation found.

**Authentication**: Query-string parameters: `vault`, `device`, `secret`. The secret is passed at `RealtimeClient::start()` — source of the secret not determined from this file alone. `[INFERENCE]` Likely user-configured in sync settings.

**Connection Management**: Auto-reconnect with exponential backoff (1s → 2s → 4s → ... → 30s max). Ping/Pong handling. Graceful fallback — if relay unreachable, beacon polling continues.

**Integration with Sync Flow**: `inbound_rx` is consumed by the monitor loop in `mod.rs`. When a `RemoteChangeNotification` arrives, `notify.notify_one()` wakes the monitor loop immediately for a targeted sync.

**Stage 5 Compatibility**: The realtime client is **directly compatible** with Heartbeat + Adaptive Polling. The existing `notify_change()` / `inbound_rx` pattern is exactly what the heartbeat system needs. The relay protocol would need extending for heartbeat metadata (device status, battery, etc.) but the transport layer is ready.

### 2.7 Deep Dive: `provider.rs` (55 lines)

**Full Trait Signature**:
```rust
#[async_trait]
pub trait CloudProvider: Send + Sync {
    async fn test_connection(&self) -> Result<bool, String>;
    async fn list_files(&self, path: &str) -> Result<Vec<RemoteFileMeta>, String>;
    async fn get_file(&self, path: &str) -> Result<Vec<u8>, String>;
    async fn put_file(&self, path: &str, content: &[u8]) -> Result<(), String>;
    async fn delete_file(&self, path: &str) -> Result<(), String>;
    async fn mkdir(&self, path: &str) -> Result<(), String>;
    async fn get_metadata(&self, path: &str) -> Result<RemoteFileMeta, String>;
    async fn move_file(&self, from: &str, to: &str) -> Result<(), String>;
    fn provider_type(&self) -> ProviderType;
}
```

**Implementation Status**: Trait is defined but **not implemented** by the WebDAV client. `webdav.rs` defines a standalone `WebDavClient` struct with matching methods, but it does not `impl CloudProvider for WebDavClient`. The engine calls `WebDavClient` directly.

**WebDAV-Specific Assumptions Baked Into the Trait**:
1. `list_files(path: &str)` — assumes hierarchical path-based storage (Google Drive uses file IDs, not paths)
2. `mkdir(path: &str)` — Google Drive doesn't have directories in the traditional sense (folders are metadata)
3. `move_file(from, to)` — Google Drive uses `PATCH` to update parent folder, not path-based move
4. `RemoteFileMeta.etag` — WebDAV ETags are not equivalent to Google Drive revision IDs
5. Missing: `put_file` doesn't return an ETag/version identifier (needed for optimistic concurrency)
6. Missing: No `watch` / `subscribe` method for server-push change notifications (Google Drive has push notifications)
7. Missing: No batch operations (Google Drive batch API is critical for performance)

**Assessment**: The trait needs **significant extension** before Google Drive can be added. The current shape is WebDAV-centric. A redesigned trait would need:
- Path abstraction (path-based for WebDAV, ID-based for cloud providers)
- Version/ETag return from `put_file`
- `watch()` / `changes()` for server-push
- Batch get/put operations
- Quota/usage query

---

## Section 3: Editor & Storage Integration

### 3.1 TipTap Configuration

**File**: `src/core/editor/editorConfig.ts` (212 lines)

**23 extensions enabled** (including sub-extensions):

| Extension | Source | Purpose |
|-----------|--------|---------|
| StarterKit | @tiptap/starter-kit | Base (bold, italic disabled for custom versions) |
| CodeBlockWithHighlight | custom | Syntax highlighting (17 languages), collapse support |
| ParagraphWithIndent | custom | Indent levels, HTML serialization |
| HeadingWithAlign | custom | h1-h6 with text-align |
| ItalicCJK | custom | CJK-aware italic parsing |
| Highlight | @tiptap/extension-highlight | Text highlighting |
| Subscript/Superscript | @tiptap | Sub/superscript |
| TaskList + TaskItem | @tiptap | Checkboxes (nested: true) |
| Table + Row + Cell + Header | @tiptap + custom | Tables with cell background colors |
| TextAlign | @tiptap | Paragraph/heading alignment |
| Callout | custom | Admonition blocks |
| CommentMarks | custom | Comment anchor marks |
| WikiLink | custom | `[[note]]` links with resolution (500 LOC) |
| WikiLinkSuggestion | custom | Autocomplete for wikilinks |
| MathInline + MathBlock + MathTrigger + MathCursorPlugin | custom | LaTeX math (724 LOC total) |
| LinkCard | custom | Rich link previews |
| Markdown | tiptap-markdown | Markdown serialization (html: true) |
| Placeholder | @tiptap | Empty editor placeholder |

**Cursor-Aware Decoration**: Not found as a named feature. Math extensions include `MathCursorPlugin` (134 lines) which provides cursor-aware behavior within math nodes.

### 3.2 File I/O Patterns

**Save Flow**:
1. TipTap editor content → `editor.storage.markdown.getMarkdown()` → markdown string
2. Frontmatter → `serializeFrontmatter(fm)` → YAML string
3. Combined: `---\n{yaml}\n---\n\n{body}`
4. Tauri IPC → `write_file` command in `note.rs`
5. Rust: acquire per-file mutex lock → atomic write (`.notology-tmp` → `sync_all()` → rename)

**Frontmatter**: YAML format, parsed with `serde_yaml` (Rust) and `yaml` npm package (frontend).

**Standard fields**: `created`, `modified`, `title`, `type` (NOTE/SKETCH/CONTAINER), `tags`, `cssclasses`, `canvas`, `sketch`.

**Large note handling**: No explicit chunking or streaming. Files read/written whole. Potential issue for very large notes (>10MB) but unlikely in practice for markdown.

### 3.3 Vault Structure (On-Disk)

```
vault/
├── note.md                     # Markdown with YAML frontmatter
├── folder/
│   ├── folder.md               # Folder note (index)
│   └── child.md
├── note_att/                   # Attachments for note.md (suffix "_att")
│   ├── image.png
│   ├── doc.pdf
│   └── comments.json           # Comments/memos data
├── .notology/                  # Hidden metadata
│   ├── vault-config.yaml       # Container configs, folder statuses
│   ├── tag-ontology.yaml       # Tag definitions & hierarchy
│   ├── content-cache.json      # Persistent content cache
│   └── sync/                   # Sync metadata
│       ├── manifest.json       # File→ETag mapping
│       ├── base/               # Baseline snapshots for 3-way merge
│       │   └── {relative_path} # Copy of last synced version
│       ├── beacon-{device}.json # Device change notifications
│       └── sync.db             # SQLite WAL queue for pending changes
└── .gitignore
```

---

## Section 4: Platform-Specific Considerations

### 4.1 Desktop

**File Watcher**: `src-tauri/src/search/watcher.rs` (665 lines) using `notify` crate v7.

| Parameter | Value | Purpose |
|-----------|-------|---------|
| Poll interval | 300ms | Optimized for NAS/cloud sync |
| Base debounce | 250ms | Stability check |
| Extended debounce | 500ms | Rapid consecutive changes |
| Burst debounce | 2s | Bulk sync detection (>10 files) |

**Smart features**: Synology conflict file detection (regex for `_{Device}_{Timestamp}_{ConflictType}`), `.notology-tmp` skip, hidden dir skip, `_att` folder skip for search indexing.

**FS Access**: Standard `std::fs` operations. Atomic writes via temp+rename. Per-file mutex locks to prevent concurrent read-modify-write.

### 4.2 Mobile

**UI Layer**: `src/features/mobile/` (37 files) — full separate UI with:
- Calendar-first 5-tab layout (Calendar | Notes | Search | Graph | Settings)
- Route stack navigation
- Bottom sheet, action sheet, FAB, swipeable rows
- Mobile-specific metadata editor
- Mobile sync banner

**Platform Detection**: `src/core/utils/platform.ts` (85 lines) — breakpoints: phone ≤599dp, tablet 600-1279dp, desktop ≥1280dp.

**Build Pipeline**: `[INFERENCE]` Android build requires JDK 17 + SDK 34 + 4 Rust targets (aarch64/armv7/x86/x86_64). No mobile CI/CD configuration found in `.github/workflows/`. The `Cargo.toml` feature flag `desktop` gates `notify`, `opener`, `hwpers`, `single-instance`, `updater` — mobile builds would exclude these.

**Known Issues**:
- `[INFERENCE]` Landscape mode bottom-bar→sidebar transform: mobile UI exists but no explicit landscape handling found in code
- VisualViewport keyboard handling: uses `window.innerWidth/Height`, no `VisualViewport` API usage found
- Long-press: mobile context menu exists (`features/mobile/components/ContextMenu.tsx`)

### 4.3 Tablet

Responsive breakpoints support tablet portrait (600-959dp) and landscape (960-1279dp). Uses same mobile components with larger layout. No tablet-specific components found.

---

## Section 5: History Reconstruction

### 5.1 Session Artifacts

**`.claude/` directory**: Contains only `settings.json` (permissions for bash/sed/unzip) and `settings.local.json` (git status, cargo generate-lockfile permissions). No session history files.

**`.claude/plans/`**: Contains only the current plan file (`snoopy-honking-puppy.md`). No prior plan files.

**CLAUDE.md**: 350+ lines, comprehensive but with stale data (React 18 reference, outdated LOC counts for lib.rs/note.rs). Architecture principles and golden rules are current and accurate.

**No `CLAUDE.*.md` variants found.**

**`docs/` directory**: Contains only `UPDATE_DEPLOYMENT.md` (215 lines — version update, signing, CI/CD procedures) and `gifs/` directory. No `docs/sessions/`, `docs/decisions/`, or `docs/adr/` directories exist.

### 5.2 Git History Analysis

**Tags** (19 releases): v1.0.0 through v3.0.0, plus `v2.0.0-pre-refactor`.

**Branches**: Only `main` (+ one worktree agent branch). No sync-specific feature branches.

**Key Sync-Related Commits** (chronological, newest first):

| Commit | Message | Significance |
|--------|---------|-------------|
| `931b985` | feat: vault selector theme + NAS→WebDAV + CloudProvider skeleton | CloudProvider trait added |
| `f318fb7` | fix: suppress false conflict detection for own saves (5s grace period) | Grace period introduced |
| `11a6cbf` | fix: skip pull for recently modified files (<30s) | Prevents false conflicts |
| `4e55236` | feat: v4.0 — sync fixes + CSS token swap + bug fixes | Major sync stabilization |
| `faa7aab` | fix: sync optimization — 10 bugs from pattern-based audit | Bulk bug fix |
| `bede542` | fix: auto-resolve config file conflicts + skip .notology from sync queue | Config handling |
| `3a310f3` | feat: click conflict indicator to open ConflictResolverPanel modal | Conflict UI |
| `8d0bca6` | fix: critical sync data integrity fixes (16 issues from deep audit) | Data integrity |
| `ddaec51` | fix: v3.0.0 sync completeness — full EventBus coverage + data integrity | EventBus wiring |
| `26298cb` | feat: v3.0.0 — modular architecture + NAS WebDAV sync engine | Initial sync engine |

### 5.3 Documentation

- **README.md** (52K bytes): Comprehensive user-facing documentation with vault concepts, feature descriptions, frontmatter reference, FAQ
- **README.ko.md** (50K bytes): Korean translation
- **CHANGELOG.md** (83 lines): Stale — only covers v1.0.0 through v1.0.4
- **UPDATE_DEPLOYMENT.md**: Build/release procedures

### 5.4 TODO/FIXME/HACK Comments

**None found** in sync-related code paths (`src-tauri/src/features/sync/`, `note.rs`, or frontend sync files). Code is clean of marker comments.

---

## Section 6: Gap Analysis vs Target Architecture

### 6.1 Content-Addressable Storage Layer (`.notology/objects/`)

**Current State**: No CAS exists. Files stored as-is. SHA-256 crate (`sha2: 0.10`) is a dependency but not used in sync.

| Classification | Details |
|---------------|---------|
| **Category** | **NEW** |
| LOC existing that survives | 0 |
| LOC new code required | ~800-1200 |
| LOC to remove | 0 |

**Implementation scope**: SHA-256 hashing of note content, object store with `objects/{hash[0:2]}/{hash[2:]}` layout, deduplication, garbage collection for unreferenced objects.

### 6.2 Version DAG (`.notology/history/{note-id}.dag`)

**Current State**: No version history. Only the manifest tracks the last-synced ETag. Base snapshots (`.notology/sync/base/`) store one version per file.

| Classification | Details |
|---------------|---------|
| **Category** | **NEW** |
| LOC existing that survives | 0 |
| LOC new code required | ~600-900 |
| LOC to remove | 0 |

**Note**: Base snapshots could be used as initial "version 0" during migration.

### 6.3 Reference Tracking (`.notology/refs/{note-id}.ref`)

**Current State**: `SyncManifest` in `manifest.json` maps relative paths to `BaseEntry{path, synced_at, etag, is_binary}`. This is a flat map, not a ref-pointing-to-hash system.

| Classification | Details |
|---------------|---------|
| **Category** | **REPLACE** |
| LOC existing that survives | ~30 (BaseEntry struct shape, adapted) |
| LOC new code required | ~300-500 |
| LOC to remove | ~80 (current manifest read/write in engine.rs:54-129) |

### 6.4 Branch Management (`.notology/branches/`)

**Current State**: No branch concept. Conflicts create `.conflict` sidecar files or `(내 변경 YYYY-MM-DD)` copies. No per-device tracking.

| Classification | Details |
|---------------|---------|
| **Category** | **NEW** |
| LOC existing that survives | 0 |
| LOC new code required | ~500-700 |
| LOC to remove | ~50 (conflict copy creation in engine.rs) |

### 6.5 Conflict Queue (`.notology/conflicts/`)

**Current State**: `SyncStatus::Conflict { files: Vec<String> }` tracks conflict files in memory. `ConflictBlock` structs sent to frontend. No persistent conflict queue on disk.

| Classification | Details |
|---------------|---------|
| **Category** | **EXTEND** |
| LOC existing that survives | ~80 (ConflictBlock, ConflictChoice, KeepSide types from conflict.rs:1-52) |
| LOC new code required | ~300-400 |
| LOC to remove | ~30 (in-memory conflict tracking in state.rs) |

### 6.6 Heartbeat File (`.notology/heartbeat.json`)

**Current State**: Beacon system exists (engine.rs:476-591) — similar concept but different scope. Beacons track changed files, not device liveness.

| Classification | Details |
|---------------|---------|
| **Category** | **EXTEND** |
| LOC existing that survives | ~100 (beacon write/check/cleanup logic, adapted for heartbeat) |
| LOC new code required | ~200-300 |
| LOC to remove | ~20 (beacon-specific file naming) |

### 6.7 Storage Backend Abstraction (Rust Trait)

**Current State**: `CloudProvider` trait exists (provider.rs, 55 lines) but is **not implemented** by WebDavClient. Engine calls WebDavClient directly.

| Classification | Details |
|---------------|---------|
| **Category** | **REFACTOR** |
| LOC existing that survives | ~30 (trait structure concept, RemoteFileMeta) |
| LOC new code required | ~400-600 (redesigned trait + WebDAV adapter + engine refactor to use trait) |
| LOC to remove | ~25 (current trait with WebDAV-specific assumptions) |

**Key refactor**: Engine must be parameterized over `dyn CloudProvider` instead of calling `WebDavClient` directly. Trait needs path abstraction, ETag return from put, watch/changes, batch ops.

### 6.8 Google Drive Backend

**Current State**: `ProviderType::GoogleDrive` is commented out in provider.rs. No implementation.

| Classification | Details |
|---------------|---------|
| **Category** | **NEW** |
| LOC existing that survives | 0 |
| LOC new code required | ~1500-2500 |
| LOC to remove | 0 |

**Scope**: OAuth2 flow (PKCE for desktop, system browser redirect), Drive API v3 integration, rate limiting (100 req/100s/user), quota handling, folder-as-metadata abstraction, resumable uploads for large files.

### 6.9 Freshness State Machine

**Current State**: `SyncStatus` enum in state.rs has 8 states, but they are **per-engine**, not **per-note**. No per-note freshness tracking.

| Classification | Details |
|---------------|---------|
| **Category** | **EXTEND** |
| LOC existing that survives | ~50 (SyncStatus enum shape, status emission pattern) |
| LOC new code required | ~600-800 |
| LOC to remove | ~100 (per-engine status logic replaced by per-note) |

**Target states per note**: Fresh, LocalAhead, Checking, Downloading, Uploading, Conflict, Offline.

### 6.10 Version History Browser UI

**Current State**: No version history UI. No version data to display.

| Classification | Details |
|---------------|---------|
| **Category** | **NEW** |
| LOC existing that survives | 0 |
| LOC new code required | ~1200-1800 (React components + Tauri commands) |
| LOC to remove | 0 |

**Scope**: Version list panel, content diff view (reusing `diff_blocks`/`lcs_table` from conflict.rs), restore functionality, version metadata display.

### 6.11 Branch Resolution UI

**Current State**: Conflict resolution UI exists (`useConflictResolution` hook, conflict bars in HoverEditor). Supports KeepLocal/KeepRemote/BlockMerge/Custom.

| Classification | Details |
|---------------|---------|
| **Category** | **REFACTOR** |
| LOC existing that survives | ~200 (conflict resolution hook patterns, UI layout patterns) |
| LOC new code required | ~800-1200 |
| LOC to remove | ~150 (current conflict copy pattern, auto-merge UI) |

**Key change**: Shift from "merge these two versions" to "here are N branches from N devices — pick one as main or manually merge."

### 6.12 Ontology Layer

**Current State**: Tag ontology exists (`tag-ontology.yaml`, `tagOntologyUtils.ts` 1,128 lines, TagPanel, FacetedTagEditor). No entity extraction, embeddings, or AI-driven features.

| Classification | Details |
|---------------|---------|
| **Category** | **NEW** (for entity extraction / embeddings / graph building) |
| LOC existing that survives | ~1,128 (tag ontology system — user-assigned tags, already synced via frontmatter) |
| LOC new code required | ~3000-5000 (entity extraction, embedding generation, graph DB) |
| LOC to remove | 0 |

### Summary Table

| Component | Category | Survives | New | Remove |
|-----------|----------|----------|-----|--------|
| 6.1 CAS | NEW | 0 | 800-1200 | 0 |
| 6.2 Version DAG | NEW | 0 | 600-900 | 0 |
| 6.3 Refs | REPLACE | 30 | 300-500 | 80 |
| 6.4 Branches | NEW | 0 | 500-700 | 50 |
| 6.5 Conflict Queue | EXTEND | 80 | 300-400 | 30 |
| 6.6 Heartbeat | EXTEND | 100 | 200-300 | 20 |
| 6.7 Backend Abstraction | REFACTOR | 30 | 400-600 | 25 |
| 6.8 Google Drive | NEW | 0 | 1500-2500 | 0 |
| 6.9 Freshness State | EXTEND | 50 | 600-800 | 100 |
| 6.10 Version History UI | NEW | 0 | 1200-1800 | 0 |
| 6.11 Branch Resolution UI | REFACTOR | 200 | 800-1200 | 150 |
| 6.12 Ontology | NEW | 1128 | 3000-5000 | 0 |
| **TOTAL** | — | **~1,618** | **~10,200-15,900** | **~455** |

**Existing sync code**: ~4,072 LOC Rust + ~1,000 LOC frontend sync. Of this, ~1,618 LOC survives. **~3,454 LOC of existing sync code will be deprecated or significantly reworked.**

---

## Section 7: Risk Assessment

### 7.1 Breaking Changes

| Change | Impact | Mitigation |
|--------|--------|-----------|
| `.notology/sync/` → `.notology/objects/` + `refs/` + `history/` | Existing sync state lost | Migration script (see 7.6) |
| ETag-based → SHA-256-based identity | All ETags invalidated; full re-sync needed | First sync after migration performs full reconciliation |
| Per-engine → per-note sync status | Frontend components consuming `SyncStatus` break | Phased migration with compatibility shim |
| Conflict model change (auto-merge → branch) | Users accustomed to auto-merge get more prompts | Clear UX messaging; non-conflicting notes unaffected |
| CloudProvider trait change | WebDAV client must be refactored | WebDAV remains functional; trait wraps existing code |

### 7.2 Performance Concerns

| Concern | Analysis |
|---------|----------|
| CAS hash computation on save | SHA-256 of a 10KB note: ~0.01ms. Negligible. |
| Version DAG growth | Each save adds ~200 bytes to DAG. 10,000 saves = 2MB. Manageable. |
| Object store disk I/O | One additional write per save (object file). SSD: negligible. HDD/NAS: ~1ms. |
| Startup with large vault | Must load all refs (~1KB each). 10,000 notes = 10MB. Adds ~50-100ms. |
| Per-note freshness tracking | HashMap<NoteId, FreshnessState> in memory. 10K entries: ~1MB. Fine. |

### 7.3 Storage Overhead Estimation

**Assumptions**: Average note size 5KB, average 10 versions per note.

| Vault Size | Current | New (CAS + DAG + Refs) | Overhead |
|-----------|---------|----------------------|----------|
| 100 notes | 500KB notes + 500KB base = 1MB | 500KB notes + 5MB objects + 20KB DAGs + 100KB refs = ~5.5MB | +4.5MB (4.5x) |
| 1,000 notes | 5MB + 5MB = 10MB | 5MB + 50MB objects + 200KB DAGs + 1MB refs = ~56MB | +46MB (5.6x) |
| 10,000 notes | 50MB + 50MB = 100MB | 50MB + 500MB objects + 2MB DAGs + 10MB refs = ~562MB | +462MB (5.6x) |

**Note**: Object deduplication reduces this. If 30% of versions share identical blocks, effective overhead drops to ~4x. For a 10K-note vault, ~400MB is acceptable on modern storage.

### 7.4 Critical Path Dependencies

```
Stage 1 (CAS + DAG) ──→ Stage 2 (Version History UI)
        │                        │
        └──→ Stage 4 (Freshness) ──→ Stage 5 (Heartbeat)
        │
        └──→ Stage 3 (Backend Abstraction + Google Drive)

Stage 6 (Ontology) ── parallel, no dependencies ──
```

**Stage 1 is the absolute prerequisite.** Nothing else can proceed without CAS and Version DAG.

### 7.5 Irreversibility Points

| Point | Severity | Mitigation |
|-------|----------|-----------|
| `.notology/sync/` directory structure change | **HIGH** | Keep old structure alongside new for 2 releases; migration creates backup |
| Removing auto-merge from conflict resolution | **MEDIUM** | Can be re-enabled as an option if users demand it |
| CloudProvider trait redesign | **LOW** | Internal API; WebDAV adapter absorbs changes |
| Per-note sync metadata | **MEDIUM** | Can coexist with per-engine status during transition |

### 7.6 Migration Strategy

#### Data Migration Path

**From**: `.notology/sync/manifest.json` + `.notology/sync/base/{path}` + `sync.db`  
**To**: `.notology/objects/{hash}` + `.notology/refs/{note-id}.ref` + `.notology/history/{note-id}.dag`

**Steps**:
1. For each file in manifest:
   - Hash current local file → create object in `objects/`
   - If base snapshot exists, hash it → create object (becomes version 0)
   - Create DAG with 1-2 entries (base → current)
   - Create ref pointing to current version hash
2. Preserve `sync.db` pending queue — flush before migration or migrate entries
3. Write migration version marker: `.notology/migration-version: 2`
4. Backup old structure to `.notology/sync-v1-backup/`

#### ETag → SHA-256 Transition

After migration, first sync cycle:
1. Download remote file list (PROPFIND)
2. For each remote file: download content, compute SHA-256
3. Compare SHA-256 with local ref hash
4. If match → update ref with remote ETag for future If-Match headers
5. If mismatch → create branch (remote version preserved as alternate branch)
6. ETags stored alongside SHA-256 in refs for the WebDAV backend optimization

#### Migration Timing

**Recommended**: **Forced on update** with user notification.

Rationale:
- Opt-in creates indefinite support burden for two sync systems
- Gradual migration creates complex edge cases (half-migrated vaults)
- Forced migration with clear UX is cleanest

#### Rollback Strategy

If migration fails mid-vault:
1. Migration is transactional: write new structure alongside old
2. Only delete old structure after full success + verification
3. If crash during migration: old structure intact, retry on next launch
4. `.notology/sync-v1-backup/` preserved for 30 days after successful migration

#### Estimated Migration Times

| Vault Size | Time (SSD) | Time (NAS/HDD) |
|-----------|-----------|----------------|
| 100 notes | <1s | ~2s |
| 1,000 notes | ~2s | ~10s |
| 10,000 notes | ~15s | ~60s |

`[INFERENCE]` Based on: SHA-256 of 5KB = 0.01ms, file write = 0.1ms (SSD) / 1ms (HDD), read base file = 0.1ms (SSD) / 1ms (HDD). Dominated by I/O.

#### User-Facing Migration UX

- **<5s**: Progress bar in existing loading screen, no special UI
- **5-30s**: Dedicated "Upgrading vault..." modal with progress bar showing note count
- **>30s**: Same modal with estimated time remaining, "This may take a moment" message
- All cases: "Do not close the app" warning during migration

---

## Section 8: Open Questions

### Q1: Note Identity — Path-Based vs UUID-Based?

**Why it matters**: CAS requires a stable note ID. Currently, notes are identified by file path. Renames break the identity chain.

**Candidates**:
- **A) File path** (current): Simple, compatible with Obsidian. But renames create new history chains.
- **B) UUID in frontmatter**: Stable across renames. Requires frontmatter modification on all existing notes.
- **C) Content hash of first version**: Immutable but opaque. Hard for users to correlate.

**Recommendation**: **B (UUID in frontmatter)**. Add `id: {uuid}` to frontmatter on first sync. Wikilinks already handle renames — the UUID is only for sync/history tracking. Migration adds UUIDs to all existing notes. Obsidian compatibility preserved (Obsidian ignores unknown frontmatter fields).

### Q2: Object Store Scope — Full Content or Deltas?

**Why it matters**: Storing full content per version is simple but uses more space. Deltas save space but add complexity.

**Candidates**:
- **A) Full content per version**: Simple, O(1) restore. ~5x storage overhead.
- **B) Base + deltas**: Complex, requires delta chain replay. ~2x storage overhead.
- **C) Hybrid (pack files like Git)**: Best of both but very complex to implement.

**Recommendation**: **A (full content)** for initial implementation. 5x overhead on markdown files is acceptable (500MB for 10K notes). Optimize to B/C only if users report storage issues. YAGNI.

### Q3: Sync Granularity — File-Level or Block-Level?

**Why it matters**: File-level sync is simpler but transfers entire files. Block-level could reduce bandwidth for large notes.

**Recommendation**: **File-level**. Average note is 5KB. Even at 10,000 notes, full file sync is fast. Block-level adds enormous complexity with minimal gain for text files. Reserve block-level for binary attachments if needed.

### Q4: Version Retention Policy

**Why it matters**: Unlimited versions → unbounded storage growth.

**Candidates**:
- **A) Keep all forever**: Maximum data preservation. Disk usage grows linearly.
- **B) Time-based**: Keep all versions <30 days, daily snapshots <1 year, monthly beyond.
- **C) Count-based**: Keep last 100 versions per note.

**Recommendation**: **B (time-based)** with user-configurable retention. Default: all versions <90 days, weekly snapshots <1 year, monthly beyond. GC runs on app startup.

### Q5: How Should Attachments Be Versioned?

**Why it matters**: Binary attachments (images, PDFs) can be large. Full CAS versioning would multiply storage.

**Recommendation**: **Don't version attachments** in CAS. Track attachment existence in the note's DAG metadata (list of attachment hashes at that version), but store attachment objects only once. If an attachment is modified (rare for binaries), the old object remains until GC. This mirrors Git's handling of binary files.

### Q6: Offline-First or Online-First?

**Why it matters**: Determines whether the app functions fully without network.

**Recommendation**: **Offline-first** (current behavior). Local vault is always the working copy. Sync is opportunistic. The freshness state machine makes the sync state visible, but never blocks editing.

---

## Section 9: Recommended Stage Ordering

### Stage 1: CAS + Version DAG + Ref System

**Prerequisites**: None (foundation)  
**Estimated Complexity**: 6-8 weeks  
**New LOC**: ~2,000-2,600 (CAS 800-1200 + DAG 600-900 + Refs 300-500 + migration ~300)

**Deliverables**:
1. `src-tauri/src/core/cas.rs` — Content-Addressable Storage (SHA-256 hash, object read/write/GC)
2. `src-tauri/src/core/version_dag.rs` — Per-note DAG (append version, traverse history, branch/merge)
3. `src-tauri/src/core/refs.rs` — Ref management (get/set HEAD, list refs)
4. Migration from `.notology/sync/base/` to new structure
5. Integration: every `write_file` creates a CAS object + DAG entry + ref update
6. UUID generation for note identity (frontmatter `id:` field)

**Risk Factors**:
- Atomic multi-file writes (object + DAG + ref must be consistent) — use write-ahead log or ordered writes
- NAS filesystem compatibility (some NAS don't support atomic rename across directories)
- Migration correctness — must handle interrupted migrations

**Testing Strategy**:
- Unit tests for CAS (hash, store, retrieve, GC)
- Unit tests for DAG (append, traverse, branch detection)
- Integration test: save note → verify object exists → verify DAG updated → verify ref points to new hash
- Migration test: create mock v1 vault, run migration, verify all objects/DAGs/refs created correctly
- Stress test: 10K notes migration timing

### Stage 2: Version History UI + Branch Resolution UI

**Prerequisites**: Stage 1  
**Estimated Complexity**: 4-6 weeks  
**New LOC**: ~2,000-3,000 (History UI 1200-1800 + Branch UI 800-1200)

**Deliverables**:
1. `src/features/version-history/` — React components for version browsing
2. Version list panel (date, device, summary)
3. Diff view (reusing `diff_blocks`/`lcs_table` from conflict.rs)
4. Restore functionality (create new version from old)
5. Branch resolution panel (list branches, preview, select/merge)
6. Tauri commands for history queries

**Risk Factors**:
- Diff performance on large notes (LCS is O(n*m) — may need optimization for >1000 blocks)
- UX complexity — users unfamiliar with "branches" concept

**Testing Strategy**:
- Create multi-version note, verify history displays correctly
- Create conflict scenario, verify branch UI shows all branches
- Test restore: restore old version, verify new version created (not destructive)
- Test diff: modify note, verify diff highlights changes correctly
- Usability: test with non-technical user for branch concept comprehension

### Stage 3: Storage Backend Abstraction + Google Drive

**Prerequisites**: Stage 1  
**Estimated Complexity**: 8-12 weeks  
**New LOC**: ~2,000-3,100 (Trait redesign 400-600 + Google Drive 1500-2500)

**Deliverables**:
1. Redesigned `CloudProvider` trait with path abstraction, batch ops, watch support
2. `WebDavProvider` — adapter wrapping existing `WebDavClient`
3. `GoogleDriveProvider` — OAuth2, Drive API v3, resumable uploads
4. Engine refactored to use `dyn CloudProvider`
5. Backend selection UI in vault settings
6. Google Drive OAuth flow (PKCE for desktop, system browser redirect)

**Risk Factors**:
- Google Drive API rate limits (100 req/100s/user) require careful batching
- OAuth token refresh reliability across sleep/wake cycles
- Google Drive folder model differs fundamentally from WebDAV paths
- Google API Console setup / review process for OAuth consent screen

**Testing Strategy**:
- WebDAV adapter: all existing sync tests must pass unchanged
- Google Drive: mock API for unit tests, integration test with real Drive account
- Rate limit simulation: verify graceful degradation
- OAuth: test token refresh, revocation, multi-account scenarios

### Stage 4: Freshness State Machine + N-way Conflict (Last Device Wins)

**Prerequisites**: Stage 1, Stage 3  
**Estimated Complexity**: 4-6 weeks  
**New LOC**: ~1,100-1,200 (Freshness 600-800 + Branch management 500-700, minus removals)

**Deliverables**:
1. Per-note `FreshnessState` enum + state machine transitions
2. UI indicators (file tree badges, editor status bar)
3. N-way branch creation when multiple devices modify concurrently
4. Device registry (device ID, name, last seen, platform)
5. Loading/buffering UI when catching up
6. Remove auto-merge from default flow (preserve as opt-in advanced option)

**Risk Factors**:
- Per-note state tracking memory/performance with large vaults
- State transitions must be atomic (race between local save and remote notification)
- UX: too many "conflict" prompts for multi-device users → need smart batching

**Testing Strategy**:
- Simulate 3-device concurrent edits → verify all 3 branches preserved
- Verify freshness state transitions: save → LocalAhead → upload → Fresh
- Test offline → online transition: verify correct catchup sequence
- Measure memory usage with 10K notes tracked

### Stage 5: Heartbeat + Adaptive Polling + LAN mDNS (Optional)

**Prerequisites**: Stage 4  
**Estimated Complexity**: 2-4 weeks  
**New LOC**: ~400-600

**Deliverables**:
1. Heartbeat file (`.notology/heartbeat.json`) with device status, battery, last active
2. Adaptive polling: faster when other devices active, slower when alone
3. LAN mDNS discovery (optional): instant sync when devices on same network
4. Integration with existing `realtime.rs` WebSocket relay

**Risk Factors**:
- mDNS may be blocked on corporate networks
- Heartbeat file contention if two devices write simultaneously (use device-specific files)

**Testing Strategy**:
- Verify polling rate adapts when heartbeat indicates active devices
- Test mDNS discovery on local network
- Test fallback when relay/mDNS unavailable

### Stage 6: Ontology Layer (Parallel Track)

**Prerequisites**: None (parallel to all stages)  
**Estimated Complexity**: 12-20 weeks  
**New LOC**: ~3,000-5,000

**Deliverables**:
1. Entity extraction from note content
2. Embedding generation (local model or API)
3. Graph database (local SQLite or custom)
4. Semantic search
5. Auto-tagging suggestions
6. Knowledge graph enhancements

**Risk Factors**:
- Embedding model selection (local vs API trade-offs)
- Index rebuild time for large vaults
- Privacy concerns with API-based embeddings

**Testing Strategy**:
- Unit tests for entity extraction accuracy
- Benchmark embedding generation time per note
- Integration test: create notes, verify graph relationships
- Verify ontology is derivative (deletable, rebuilds from content)

### Ordering Rationale

The proposed order (1 → 2/3 parallel → 4 → 5, with 6 independent) optimizes for:
1. **Foundation first**: CAS/DAG are required by everything else
2. **User value early**: Version History UI (Stage 2) delivers visible value immediately after Stage 1
3. **Backend flexibility**: Stage 3 can run in parallel with Stage 2, enabling Google Drive before freshness tracking
4. **Incremental complexity**: Each stage builds on proven foundations
5. **Ontology independence**: Can start anytime, delivers value without sync changes

**Alternative ordering considered**: Doing Stage 4 (Freshness) before Stage 3 (Google Drive). This would be valid if multi-device sync quality is more important than backend flexibility. The recommended order prioritizes Google Drive as a user-requested feature.

---

## Appendix A: Existing Code Reuse Map

| Existing Code | Lines | Reuse in New Architecture |
|--------------|-------|--------------------------|
| `conflict.rs` — `split_frontmatter()`, `split_blocks()`, `diff_blocks()`, `lcs_table()` | ~200 | Diff visualization in Version History UI |
| `conflict.rs` — `ConflictBlock`, `ConflictChoice`, `KeepSide` types | ~50 | Branch Resolution UI data types |
| `engine.rs` — SQLite WAL queue pattern | ~200 | Sync queue remains relevant |
| `engine.rs` — beacon write/check | ~100 | Heartbeat system foundation |
| `engine.rs` — adaptive polling loop | ~200 | Freshness state machine polling |
| `webdav.rs` — full WebDAV client | ~572 | Wrapped in `WebDavProvider` adapter |
| `realtime.rs` — WebSocket relay client | ~182 | Heartbeat transport layer |
| `state.rs` — SyncStatus, SyncConfig | ~100 | Extended for per-note freshness |
| `connections.rs` — NAS connection persistence | ~381 | Extended for multi-backend connection storage |
| `provider.rs` — RemoteFileMeta struct | ~15 | Kept with additions |
| `file_io.rs` — atomic_write_file, file locks | ~167 | Core I/O unchanged |
| `note.rs` — SKETCH protection, FM restoration | ~100 | Core save flow unchanged |
| **Total reusable** | **~2,267** | |
