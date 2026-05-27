# Fix F Implementation Diagnostic

## 1.1 MergeResult handling sites

### Site A: engine.rs:1069 in `try_upload_with_merge` (flush_queue upload path)

Context: When uploading a local file, If-Match conditional PUT fails (ETag mismatch), engine downloads remote, does 3-way merge.

Merged handling: **Auto-applies correctly** — writes merged content to local file, uploads to NAS, updates manifest. Returns `UploadResult::Success`.

Conflict handling: Returns `UploadResult::Conflict` — file added to `conflict_files` vec, `SyncStatus::Conflict` set.

### Site B: engine.rs:1319 in `bidirectional_sync` Phase 1 (simultaneous create detection)

Context: File exists locally AND on remote but NOT in manifest (both devices created it independently).

Merged handling: **Auto-applies correctly** — uploads merged version, writes locally, updates manifest.

Conflict handling: Adds to `conflict_files` vec.

### Site C: mod.rs:354 in `sync_get_conflict_detail` (Tauri command for modal)

Context: Frontend requests conflict detail for display in modal.

Returns `MergeResult` directly to frontend. No auto-apply — just returns the merge result for display.

### Site D: **MISSING** — No merge site for "tracked file changed on remote while also modified locally"

This is the gap. When a file IS in manifest and remote ETag changed, `bidirectional_sync` Phase 1:
- Lines 1254-1262: Detects `needs_download = true`
- Lines 1269-1293: Checks grace period, skips if recently modified
- Lines 1298-1346: Only handles `in_manifest.is_none()` (simultaneous create)
- Lines 1348-1372: For `in_manifest.is_some()`, **directly downloads and overwrites local file** without checking if local was also modified

## 1.2 Sync-cycle merge flow

**The infinite conflict loop for Ggggggjjjjj.md:**

1. **Beacon received**: Other device (labCore-4200) modified file, wrote beacon
2. **Targeted sync** (`targeted_sync`, line 1164-1170): Downloads remote content, **overwrites local file** — no conflict check at all
3. **File watcher** detects local file changed → queues upload via `sync_on_file_saved`
4. **Flush queue** (`try_upload_with_merge`, line 1069): Tries to upload → ETag mismatch (remote was just downloaded with new ETag) → 3-way merge → `MergeResult::Merged` → auto-applies + uploads
5. **Next beacon check**: Other device's beacon still has this file → goto step 2

The loop: download(remote) → watcher queues upload → upload detects mismatch → merge → beacon triggers download again.

**Current behavior when Merged is returned**: In the upload path (Site A), merged content IS auto-applied. But the targeted_sync path (step 2) keeps overwriting with remote content, undoing the merge.

**Expected behavior**: `targeted_sync` and `bidirectional_sync` Phase 1 download path should perform 3-way merge BEFORE overwriting local file when the local file was also modified.

**Gap**: Two functions lack merge logic:
1. `targeted_sync` (line 1164-1170) — direct overwrite, no merge
2. `bidirectional_sync` Phase 1 download for tracked files (line 1362) — direct overwrite, no merge

## 1.3 Beacon/targeted sync

`targeted_sync` is called when beacons report specific changed files. It:
1. Checks grace period (skips recent edits)
2. Checks ETag against manifest
3. Downloads and overwrites local file **without any conflict detection**

The beacon from labCore-4200 lists `Ggggggjjjjj.md`. Every beacon check triggers `targeted_sync` for this file, which overwrites local with remote, which triggers watcher → upload queue → merge → upload → new beacon → repeat.

## 1.4 Frontend toast infrastructure

- **Library**: No toast library on desktop. Mobile has custom `Toast.tsx` component.
- **Existing sync:auto-merged listener**: None. The previous Fix F only added UI to the ConflictResolverPanel (a "병합 결과 적용" button for manual action).
- No event emission from backend for auto-merge.

## 1.5 app_handle in SyncEngine

- **Available**: Yes, via `self.state.app_handle` (Mutex<Option<AppHandle>>)
- `SyncState::set_app_handle()` at state.rs:144
- `SyncState::emit_download_progress()` at state.rs:149-155 demonstrates the pattern
- SyncEngine accesses it via `self.state` field

## Root Cause Analysis

The infinite conflict loop has **two causes**:

1. **`targeted_sync` has no merge logic**: When beacon reports a changed file, `targeted_sync` downloads and overwrites the local file unconditionally. If the local file was also modified, the local changes are lost, then the file watcher queues an upload of the "remote" content back, creating a loop.

2. **`bidirectional_sync` Phase 1 download path has no merge logic for tracked files**: When a tracked file (in manifest) has changed on remote AND locally, the download path just overwrites. Only the simultaneous-create path (line 1298, `in_manifest.is_none()`) calls `ConflictResolver::resolve()`.

The previous Fix F added a "병합 결과 적용" button to the conflict modal but didn't address the backend loop at all.

## Proposed Fix

### Fix 1: Add merge logic to `targeted_sync` (engine.rs ~line 1164)

Before `atomic_write_file`, check if local file also changed since last sync:

```rust
// In targeted_sync, before writing:
if local_path.exists() && in_manifest.is_some() {
    let local_content = std::fs::read(&local_path).unwrap_or_default();
    if local_content != content && !Self::is_binary(relative) {
        // Local also modified — need 3-way merge
        let base = SyncManifest::read_base(&self.vault_path, relative);
        let base_str = base.as_ref().and_then(|b| std::str::from_utf8(b).ok()).unwrap_or("");
        let local_str = std::str::from_utf8(&local_content).unwrap_or("");
        let remote_str = std::str::from_utf8(&content).unwrap_or("");
        
        match ConflictResolver::resolve(base_str, local_str, remote_str) {
            MergeResult::Merged { content: merged } => {
                // Auto-apply merged content
                atomic_write_file(&local_path, merged.as_bytes())?;
                // Upload merged to NAS
                let new_etag = Self::put_and_get_etag(&client, &remote_path, merged.as_bytes()).await.ok();
                manifest.save_base(&self.vault_path, relative, merged.as_bytes(), new_etag, false)?;
                log::info!("[sync-targeted] Auto-merged {}", relative);
                updated.push(relative.clone());
                continue;
            }
            MergeResult::Conflict { .. } => {
                conflict_files.push(relative.clone());
                continue;
            }
        }
    }
}
// Existing download path (no local changes)
atomic_write_file(&local_path, &content)?;
```

### Fix 2: Add merge logic to `bidirectional_sync` Phase 1 download path (engine.rs ~line 1362)

Same pattern: before overwriting, check if local also changed.

### Fix 3: Emit `sync:auto-merged` event after auto-merge

In both merge sites, after successful auto-apply:
```rust
if let Some(handle) = self.state.app_handle.lock().unwrap().as_ref() {
    let _ = handle.emit("sync:auto-merged", serde_json::json!({
        "file": relative,
    }));
}
```

### Fix 4: Frontend toast (simple console.log for now, toast later)

In `src/features/sync/index.ts`, add listener for `sync:auto-merged`.

## Open Questions

1. **Should we add a `conflict_files` return to `targeted_sync`?** Currently it returns `SyncResult` with only `updated` + `grace_skipped`. Need to track conflicts detected during targeted sync.

2. **Should auto-merged files update the beacon?** After auto-merge, should we write a beacon so the other device knows to sync? Currently beacons are only written during `flush_queue`.

3. **For the bidirectional_sync download path (Fix 2), how do we detect "local also changed"?** Compare local file content against `manifest.read_base()`. If they differ, local was modified since last sync.
