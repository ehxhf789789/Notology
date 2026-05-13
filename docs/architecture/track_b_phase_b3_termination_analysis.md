# Track B Phase B-3 — Termination Scenarios

**Date:** 2026-05-13
**Context:** Phase B-3 PART 5 stabilization. Single-surface principle means
the wikilink chip is the canonical surface; we need to know what happens to
that surface when Notology dies mid-flight.

This document enumerates every termination point reachable from an
attachment drag-in flow and the resulting on-disk + on-NAS state. Each row
ends with the recovery path on next vault open.

## Drag-in flow (Phase B-3 stabilized)

```
                      sync (push_worker / background_worker)
                              │
1. user drops file ──► 2. wikilink inserted ──► 3. attachment_add
                              │                          │
   (optimistic UI,            │                          ├─► sha256 compute
    synchronous)              │                          ├─► CAS blob write
                              │                          ├─► display hardlink
                              │                          ├─► ref JSON write
                              │                          ├─► dirty queue enqueue
                              │                          └─► EventBus emit
                              │
                              ▼
                       4. push_worker /
                          background_worker ──► chunked upload to NAS
```

Steps 1 & 2 are synchronous (sub-millisecond). Step 3 takes ~30 s for a
600 MB file (sha256). Step 4 takes minutes for chunked uploads. The
termination analysis covers a kill at any boundary between these.

## Scenarios

### A. Kill between step 2 and step 3 — wikilink in note, no backend processing

**Trigger:** User drops a file. Wikilink appears in note. User force-quits
Notology before `attachment_add` even starts (extremely fast — <1 s window).

**State on disk:**
- Note `.md` file: contains `[[file.ext]]` wikilink (saved when editor
  flushes — may or may not have been persisted depending on autosave timer)
- Vault `.attachments/`: nothing new
- Vault `.notology/attachments/refs/`: nothing new
- Vault `.notology/cas/blobs/`: nothing new
- Dirty queue: nothing new

**Recovery on next vault open:**
- The `[[file.ext]]` wikilink resolves to nothing → chip renders gray
  (`unresolved` class).
- User can either re-drag the file (succeeds normally) or delete the
  stale wikilink. No silent data corruption.

**Verdict:** ✅ Safe. UI clearly shows the broken reference (gray chip)
so the user knows to retry.

### B. Kill mid-`attachment_add` — sha256 in progress

**Trigger:** Same as A, but kill during the long sha256 read+hash. Most
likely scenario for large files (600 MB MP4 takes ~30 s on NVMe).

**State on disk:**
- Note: wikilink present (optimistic insert is synchronous, ran before
  `attachment_add` started)
- `.attachments/`: nothing new (hardlink is created AFTER CAS write, which
  is AFTER sha computation)
- `.notology/cas/blobs/`: nothing new (CAS write is atomic — partial files
  use a `.tmp` extension that's renamed only on full flush, see
  `atomic_write_file`)
- `.notology/attachments/refs/`: nothing new (ref is written LAST)
- Dirty queue: nothing new

**Recovery on next vault open:**
- Identical to scenario A — gray chip, user re-drags.
- No orphan blob, no orphan ref. `atomic_write_file` guarantees no
  half-written files.

**Verdict:** ✅ Safe. No cleanup needed.

### C. Kill after CAS blob written, before ref JSON written

**Trigger:** `attachment_add` got past the CAS write but hadn't reached the
ref persist + index write. Window: a few hundred milliseconds for small
files, slightly longer for large.

**State on disk:**
- CAS blob: present (`.notology/cas/blobs/{ab}/{cd}/{sha}`)
- `.attachments/<display>`: may or may not be present (hardlink created
  between blob write and ref write)
- Ref JSON: not yet written
- Dirty queue: nothing new

**Recovery on next vault open:**
- Orphan CAS blob (and possibly orphan hardlink) — wastes disk space but
  causes no functional issue.
- Wikilink in note resolves to nothing → gray chip.
- On user retry the same file, `add_attachment` recomputes sha, hits the
  orphan blob via `find_by_sha`, treats it as dedup → reuses the blob,
  writes a fresh ref. The orphan becomes adopted automatically.

**Verdict:** ✅ Safe. Self-healing on retry. A future cleanup pass
(orphan-blob garbage collection) could reclaim disk space without
user action — currently low priority (each orphan is at most one file
the user already has elsewhere).

### D. Kill after ref written, before EventBus emit + dirty queue enqueue

**Trigger:** Backend persisted everything but the JS-side promise hadn't
returned yet.

**State on disk:**
- CAS blob: present
- `.attachments/<display>`: present
- Ref JSON: present (linked_notes = [note_id])
- Dirty queue: not yet enqueued

**Recovery on next vault open:**
- `attachmentStore.hydrate()` reads the ref → wikilink in note resolves
  to it → chip renders normally.
- Migration-style auto-enqueue catches it: the `sync_engine` bootstrap
  (`run_attachment_migration_if_needed`) iterates every ref where
  `sync_etag.is_none()` and enqueues it to the dirty queue. Since this
  fresh ref has no etag, it gets re-enqueued for push.

**Verdict:** ✅ Safe. Recovery handled by the existing post-migration
enqueue loop (introduced in B-2 hotfix).

### E. Kill mid-push — chunked upload in progress

**Trigger:** `background_worker` is uploading a 600 MB chunked attachment.
Some chunks already on NAS, manifest not yet written.

**State:**
- Local: ref present with `sync_etag = None`
- NAS: `cas/blobs/{ab}/{cd}/{sha}_chunks/` contains some chunks; no
  `manifest.json`
- Dirty queue: entry pending (SQLite WAL — survives kill)

**Recovery on next vault open:**
- `background_worker` resumes from the dirty queue.
- `chunked_upload::upload_chunked` detects the missing manifest → treats
  as in-progress.
- `scan_existing_chunks` PROPFINDs the chunks dir, finds the N chunks
  already uploaded, marks them as `resumed`. Only the remaining chunks
  PUT.
- Manifest written last → upload commits atomically.

**Verdict:** ✅ Safe. This is the resume path validated in B-2 Stage 4
verification.

### F. Kill mid-push — single PUT in progress (small file)

**Trigger:** `push_worker` is mid-PUT of a 200 KB ref or single-blob.

**State:**
- Local: ref + blob present, etag empty
- NAS: file may be partially written. Synology PUT is atomic at the HTTP
  level — connection drop → server discards the partial.
- Dirty queue: entry pending

**Recovery on next vault open:**
- Worker re-runs `push_attachment`. `provider.has_md` returns false for
  the blob (partial discarded). Re-uploads. Idempotent end state.

**Verdict:** ✅ Safe.

### G. Kill after wikilink inserted, note never saved, attachment_add ran in background

**Trigger:** User drops a file, sees the wikilink appear, then immediately
kills the app before the editor's autosave fires (~1.5 s debounce).
`attachment_add` may have completed in the background.

**State on disk:**
- Note `.md`: pre-drop content (wikilink was in-memory only)
- Ref JSON: present (depending on `attachment_add` timing — may also be
  absent if both racing)
- CAS blob: present (same)

**Recovery on next vault open:**
- Note shows no wikilink for the attachment.
- Ref exists with `linked_notes = [note_id]` even though the note doesn't
  reference it. This is an **orphan ref**.
- Wikilink resolver doesn't surface orphan refs to the user — they're
  invisible until cleaned up.

**Verdict:** ⚠️ Soft leak. The attachment is preserved on disk and NAS,
syncs to other devices, but no longer reachable via any note. Will
appear in the redesigned Attachments tab (PART 6) so the user can
restore or delete. Until PART 6 ships, the workaround is to keep using
the file (re-drag it into a new wikilink — backend smart-dedup links
the same ref).

### H. Migration kill (separate flow, included for completeness)

Covered in `track_b_phase_b2_verification.md` §M6. `needs_migration()`
returns true while any `*_att/` folder still has files, so a kill
mid-migration auto-resumes on next open.

## Summary

| Scenario | Severity | Cleanup needed? | When |
|----------|:---:|:---:|---|
| A. Pre-add kill | None | No | — |
| B. Mid-sha256 | None | No | — |
| C. Post-CAS, pre-ref | Low | Low priority | Future GC pass |
| D. Post-ref, pre-enqueue | None | Auto | Bootstrap re-enqueue |
| E. Mid-chunked-push | None | No (resume) | — |
| F. Mid-single-PUT | None | No | — |
| G. Wikilink missed save + ref written | Soft leak | User-visible in B-3 Attachments tab | PART 6 |
| H. Mid-migration | None | Auto | needs_migration check |

No scenario causes data loss or NAS corruption. The two scenarios with
visible artifacts (C: orphan blob, G: orphan ref) are self-healing on
retry or surfaceable in the upcoming Attachments tab.
