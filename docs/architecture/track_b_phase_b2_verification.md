# Track B Phase B-2 — Manual Verification Guide

**Target audience:** HanBin (verifier)
**Phase:** B-2 (Backend: store / sync / migration / lanes / chunked / commands)
**Date:** 2026-05-12 (revised after §4.4 → option C + §4.4-CL)
**Authority:** [track_b_attachment_design.md](./track_b_attachment_design.md) §3, §4, §7, §8

This guide covers manual checks for the Phase B-2 backend. UI flows (Migration modal, conflict resolution dialog, drag-out) are deferred to B-3 and verified separately.

**HanBin's decisions (already confirmed 2026-05-12):**
- §4.3 = **A** — NAS holds only CAS + refs. `.attachments/` is rebuilt locally per device.
- §4.4 = **C** — no size cap. The chunked layer transparently handles files larger than the single-PUT limit.
- §4.4-CL — 16 MB chunks, hybrid NAS layout, manifest-as-commit-token, resume per chunk.

---

## 0. Pre-flight

```powershell
Set-ExecutionPolicy Bypass -Scope Process -Force
. .\notology_test_env.ps1
```

Test vault location for these scenarios — use a throwaway path so the legacy migration cannot damage the production vault:

```
C:\Users\ehxhf\AppData\Local\Notology\test_b2\
```

NAS: `https://ehxhf789.synology.me:18527/Colony/test_b2/` (create empty on Synology before starting S1).

---

## Trigger summary (2026-05-12 hotfix — must-know)

Phase B-2's backend modules are no-ops unless something *triggers* them. Two
trigger points were missing in the initial B-2 cut and were patched in:

| Trigger | Wiring |
|---|---|
| **Vault open → migration auto-run** | `sync_engine::start_3tier` spawns `run_attachment_migration_if_needed` after the workers come up. CPU-heavy sha256 scan runs on `tokio::task::spawn_blocking`. |
| **Migration → push** | Same background task iterates `AttachmentStore::all_refs()` post-migration and enqueues every ref where `sync_etag.is_none()` to the dirty queue. Idempotent (dedup by target_key). |
| **Drag-drop → push** | `useDragDrop.ts` now calls `syncV2Commands.attachmentAdd` (Phase B-2 command) instead of the legacy `noteCommands.importAttachment`. Falls back to legacy if sync engine is not active. |
| **attachment_add → lane** | Backend chooses Fast/Slow lane via `lane_for_size(size_bytes)` at enqueue time — no frontend coordination needed. |

If you ever see a vault with `*_att/` folders that aren't getting migrated,
or attachments that aren't pushing, look at `[attachment_migration]` and
`[attachment_add]` log lines first.

## A. Migration scenarios (critical — zero data loss)

### Setup (before each M-scenario, recreate)

```powershell
$vault = "C:\Users\ehxhf\AppData\Local\Notology\test_b2"
Remove-Item -Recurse -Force $vault -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $vault | Out-Null

# Three notes, two with attachments — including a collision and a dedup case.
Set-Content "$vault\Note1.md" "# Note1`n`n[[Report.pdf]]`n[[image.png]]"
New-Item -ItemType Directory "$vault\Note1_att" | Out-Null
Set-Content -AsByteStream "$vault\Note1_att\Report.pdf" ([byte[]](@(37,80,68,70) + (1..100)))
Set-Content -AsByteStream "$vault\Note1_att\image.png" ([byte[]](@(137,80,78,71) + (1..50)))
Set-Content "$vault\Note1_att\comments.json" "[]"   # system file — must be preserved

Set-Content "$vault\Note2.md" "# Note2`n`n[[Report.pdf]]"
New-Item -ItemType Directory "$vault\Note2_att" | Out-Null
# Different content, SAME name — should hit collision suffix
Set-Content -AsByteStream "$vault\Note2_att\Report.pdf" ([byte[]](@(37,80,68,70) + (200..300)))

Set-Content "$vault\Note3.md" "# Note3`n`n[[data.csv]]"
New-Item -ItemType Directory "$vault\Note3_att" | Out-Null
# Same content as Note1's image — should dedup
Set-Content -AsByteStream "$vault\Note3_att\data.csv" ([byte[]](@(137,80,78,71) + (1..50)))
```

### M1 — Just open the vault. Migration runs automatically.

As of the 2026-05-12 hotfix, vault open → `start_3tier` → background task →
`AttachmentMigration::run()`. No DevTools command needed. Confirm via logs:

```
[attachment_migration] legacy _att/ folders detected, running migration
[attachment_migration] complete: total=4 migrated=4 deduped=1 collisions=1 duration_ms=...
[attachment_migration] enqueued 2 fast-lane + 1 slow-lane attachments for push
[push_worker] attachment <id> pushed (blob_uploaded=true, size=...)
[background_worker] attachment <id> pushed (slow lane, size=... MB)
```

If you want to inspect status without triggering, you can still call:

```js
await window.__TAURI__.core.invoke('attachment_migration_status')
// { needsMigration: false }  — after auto-run, returns false
```

### M2 — Migration report (from logs / manual call)

A manual `attachment_migration_run` returns (approximately):
```json
{
  "total_files": 4,
  "migrated": 4,
  "deduped": 1,         // Note3/data.csv == Note1/image.png (same bytes)
  "collisions": 1,      // Note2/Report.pdf clashed with Note1/Report.pdf
  "duration_ms": <small>,
  "legacy_backup_dir": "<vault>/.legacy/<ts>"
}
```

### M3 — Vault structure

```powershell
Get-ChildItem -Recurse $vault -Force | Select-Object FullName
```

Must show:
- `.attachments/Report.pdf` (Note1's version)
- `.attachments/Report_1.pdf` (Note2's — collision suffix)
- `.attachments/image.png`
- `.attachments/data.csv`
- `.notology/attachments/refs/<id>.json` × 4
- `.notology/cas/blobs/<sh>/<ar>/<sha>` × 3 (dedup → image.png and data.csv share a blob)
- `.notology/attachments/migration_journal.json` with `verification.passed = true`
- `.notology/attachments/index.json`
- `.legacy/<ts>/Note1_att/...` (full backup preserved)
- Note1_att / Note2_att / Note3_att — **removed**
- `Note1.comments.json` preserved beside Note1.md ✓

### M4 — Wikilink rewrite

```powershell
Get-Content "$vault\Note1.md"  # → [[Report.pdf]] (unchanged)
Get-Content "$vault\Note2.md"  # → [[Report_1.pdf]] (rewritten)
Get-Content "$vault\Note3.md"  # → [[data.csv]] (unchanged)
```

### M5 — Integrity check (manual sha)

```powershell
# Original bytes vs migrated CAS blob — must match
$origNote1Pdf = Get-FileHash "$vault\.legacy\<ts>\Note1_att\Report.pdf" -Algorithm SHA256
$casBlobs = Get-ChildItem -Recurse "$vault\.notology\cas\blobs" -File
foreach ($b in $casBlobs) { Get-FileHash $b.FullName -Algorithm SHA256 }
# Each CAS blob hash MUST appear in the ref JSON files.
```

### M6 — Rollback safety

1. Recreate the setup. Run migration once. Confirm completion.
2. Delete `.notology/attachments/refs/<id>.json` for one entry (simulate corruption).
3. Run migration again — `needs_migration` should still report **false** (refs dir exists). Decide: do we want a re-verify mode? For B-2 the answer is no (idempotent).
4. To re-test rollback, manually break things mid-run: kill the process while migration runs (set a breakpoint inside `migrate_all_files`). Expect `.legacy/<ts>/` retains every original; next vault open will re-trigger migration because refs/ is incomplete.

---

## B. Two-tier queue scenarios

### S0 — Pre-condition

Vault from M (post-migration) connected to NAS. Sync engine started. WebDAV reachable. Confirm with `sync_v2_get_state` → `Idle`.

### S1 — Small attachment (Fast lane)

```powershell
# Add a 200 KB PDF
$small = "C:\tmp\small.pdf"
Set-Content -AsByteStream $small ([byte[]](@(37,80,68,70) + (1..(200*1024))))

# Via Tauri command (devtools):
await invoke('attachment_add', { sourcePath: 'C:\\tmp\\small.pdf', noteId: 'Note1' });
```

Verify in DB:
```powershell
$db = "$vault\.notology\sync_v2\queue.db"
sqlite3 $db "SELECT lane, operation_json FROM pending_changes_v2;"
# Expect lane='fast'
```

Within ≤ 5 s (1.5 s debounce + push), NAS should have:
- `.notology/cas/blobs/<sh>/<ar>/<sha>`
- `.notology/attachments/refs/<id>.json`

Check `sync_etag` on local ref is populated.

### S2 — Large attachment (Slow lane + chunked upload)

```powershell
# Create a 120 MB dummy file (exceeds 100 MB chunked threshold)
$big = "C:\tmp\big.mp4"
fsutil file createnew $big (120*1024*1024)

await invoke('attachment_add', { sourcePath: 'C:\\tmp\\big.mp4', noteId: 'Note1' });
```

DB check:
```powershell
sqlite3 $db "SELECT lane FROM pending_changes_v2 ORDER BY id DESC LIMIT 1;"
# Expect lane='slow'
```

Verify in logs (`tail -f` on Notology log):
```
[background_worker] attachment <id> pushed (slow lane, size=120 MB)
```

**NAS layout** (large file → chunked, §4.4-CL):
```bash
$base = "https://ehxhf789.synology.me:18527/Colony/test_b2"
# Manifest commit token
curl -u "$user:$pass" "$base/.notology/cas/blobs/<ab>/<cd>/<sha>_chunks/manifest.json"
# Expect: JSON with chunk_count=8 (120 MB / 16 MB = 7.5 → 8 chunks), all chunk sha256s

# Chunks themselves
curl -u "$user:$pass" "$base/.notology/cas/blobs/<ab>/<cd>/<sha>_chunks/chunk_0000"
# Expect: 16 MB binary
curl -u "$user:$pass" "$base/.notology/cas/blobs/<ab>/<cd>/<sha>_chunks/chunk_0007"
# Expect: ~8 MB binary (final chunk)

# Single-file blob should NOT exist for chunked uploads
curl -u "$user:$pass" -o /dev/null -w "%{http_code}" "$base/.notology/cas/blobs/<ab>/<cd>/<sha>"
# Expect: 404
```

### S2a — Chunked resume after kill

1. Start `attachment_add` on a 500 MB file. Wait for ~5 of the 32 chunks to upload (watch logs).
2. Force-kill Notology (Task Manager → End task).
3. Restart Notology. The dirty queue entry is still in place (SQLite WAL).
4. Watch logs — `chunked_upload` should report `resumed_chunks=5` (or however many had completed pre-kill) and only upload the remainder.
5. `manifest.json` only appears AFTER the last chunk lands. Verify by checking NAS in the middle of the upload — chunks present, manifest absent until completion.

### S2b — Chunked download (cross-device)

After S2, on a second device (or by clearing local CAS):

```powershell
Remove-Item "$vault\.notology\cas\blobs" -Recurse -Force
Remove-Item "$vault\.attachments" -Recurse -Force
# Trigger pull (engine restart or explicit syncNow)
```

Verify:
- `download_blob` reassembles all 8 chunks → single local file at `.notology/cas/blobs/<ab>/<cd>/<sha>` (single layout locally)
- Final reassembled sha256 matches the manifest's `total_sha256`
- `.attachments/big.mp4` hardlink recreated
- Local layout is ALWAYS single-file; chunked is NAS-only

### S3 — Fast does not block on Slow

1. Start by enqueueing one big.mp4 (Slow). Watch upload progress (NAS PUT in flight).
2. While Slow upload is in flight, add a small.pdf. The fast push should complete within seconds, independent of the big upload.

Check ordering:
```powershell
sqlite3 $db "SELECT id, lane, timestamp FROM pending_changes_v2 ORDER BY id;"
# Small fast-lane entry should drain before slow-lane entry completes.
```

### S4 — Dedup verification

```powershell
# Add the same file twice to different notes
await invoke('attachment_add', { sourcePath: 'C:\\tmp\\small.pdf', noteId: 'Note1' });
await invoke('attachment_add', { sourcePath: 'C:\\tmp\\small.pdf', noteId: 'Note2' });
```

Expect:
- Two `AttachmentRef.json` files (different attachment_ids)
- **One** CAS blob (single sha256)
- On NAS: only one PUT for the blob (the second push logs `blob_uploaded=false`)

```powershell
# Local CAS
(Get-ChildItem -Recurse "$vault\.notology\cas\blobs" -File).Count
# Should be 1 + previous count, NOT 2 + previous count.
```

### S5 — Deletion + orphan blob cleanup

```powershell
await invoke('attachment_delete', { attachmentId: '<id1>' });  // first ref pointing to small.pdf
# Blob should still exist on NAS + local (other ref points to it)

await invoke('attachment_delete', { attachmentId: '<id2>' });  // last ref
# Blob now orphan → both local CAS and NAS blob removed
```

NAS check:
```bash
curl -u "$user:$pass" https://ehxhf789.synology.me:18527/Colony/test_b2/.notology/cas/blobs/<sh>/<ar>/<sha>
# Expect 404
```

### S6 — Cross-device pull (manual)

1. From Device A: `attachment_add` (M-1) → wait for push completion.
2. On Device B (or a second test vault pointing at the same NAS path): manually trigger reconciliation. Frontend has `syncV2Commands.syncNow()` and there is also `attachment_sync.pull_all` (not wired as a top-level command yet — internal). For now, restart the engine — bootstrap will pull on init.
3. Expect on Device B:
   - `.notology/attachments/refs/<id>.json` matches A's
   - `.notology/cas/blobs/<sha>` present
   - `.attachments/<display>` hardlinked

---

## C. Conflict scenarios (B-2 detects; B-3 resolves UI)

### C1 — Attachment ref conflict

Set up two devices each holding a ref with the same `attachment_id` but different `sha256`. (Manual; requires writing both ref JSON files directly to local + NAS, simulating a race.)

The `ConflictDetector::prepare_attachment` should produce:
```json
{
  "attachmentId": "<id>",
  "localSide": { "branchId": "att_<ts>_<dev>_<sha8>", "sha256": "...", ... },
  "remoteSide": { "branchId": "...", "sha256": "...", ... },
  "resolutionOptions": ["use_local", "use_remote", "keep_both"]
}
```

(Phase B-2 leaves the UI surface to B-3; this stage verifies the data shape is correct.)

### C2 — Synology suffix detection

```powershell
# Drop a Synology-style conflict file in .attachments/
Set-Content "$vault\.attachments\Report (SynologyDrive Conflict 2026-05-12-12-00-00).pdf" "conflicted"
```

Run `detect_synology_conflict("Report (SynologyDrive Conflict 2026-05-12-12-00-00).pdf")` (via a quick unit test invocation) → returns `Some("Report.pdf")`.

Phase B-3 will wire this into a UI prompt; B-2 just exposes the helper.

---

## D. Auto-regression checklist (re-confirm before sign-off)

```powershell
cd src-tauri
cargo build --lib                           # ✓ Finished, 40 warns (all pre-existing)
cargo test --lib --no-run                   # ✓ test profile compiled
cd ..
npx tsc --noEmit -p .                       # ✓ EXIT 0 (no output)
```

`cargo test --lib` runtime: the Windows DLL `STATUS_ENTRYPOINT_NOT_FOUND` issue is pre-existing (reproduced on `attachment_cleanup` in Phase B-1). Track B-2's new unit tests compile cleanly. If HanBin wants test execution: run inside a CI/Linux box or `cargo build` the test binary then launch via `cargo nextest` with WebView2 DLLs adjacent.

---

## E. Sign-off rubric

| Gate | Status | Notes |
|------|:------:|-------|
| Migration zero data loss | ☐ | M1–M5 all pass; .legacy/ retained |
| Wikilinks rewritten on collision | ☐ | M4 |
| Comments.json preserved beside note | ☐ | M3 |
| Fast lane < 100 MB → push_worker | ☐ | S1 |
| Slow lane ≥ 100 MB → background_worker | ☐ | S2 |
| Chunked NAS layout for ≥ 100 MB | ☐ | S2 (manifest + chunk_NNNN visible) |
| Resume after kill (chunk-granular) | ☐ | S2a |
| Chunked download reassembles correctly | ☐ | S2b |
| Small drains while large in flight | ☐ | S3 |
| Dedup at CAS layer | ☐ | S4 |
| Orphan blob cleanup | ☐ | S5 |
| Cross-device pull | ☐ | S6 (optional Phase B-2) |
| Attachment conflict shape | ☐ | C1 |
| Synology suffix detection | ☐ | C2 |
| `cargo build --lib` clean | ☐ | D |
| `cargo test --lib --no-run` compiles | ☐ | D |
| `tsc --noEmit` EXIT 0 | ☐ | D |

Tick all → Phase B-2 ✓ → proceed to Phase B-3 (UI, drag-out plugin, viewers).
