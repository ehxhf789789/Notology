# Stage 4.6 — Existing-attachment faststart bulk migration (W2)

**Status**: New stage, **confirmed 2026-05-14 (HanBin sign-off)**.
**Entry**: Stage 4.5 all 5 sub-stages green (especially 4.5.1 — faststart
determinism must be proven before bulk-rewriting existing CAS blobs).
**Exit**: Every existing mp4 / mov / m4v in the vault's CAS store is
verified faststart-enabled. AttachmentRefs and wikilinks consistent.

---

## Why this exists

Stage 4.x integrated faststart re-mux into `attachment_add` — but only for
*new* attachments. HanBin's vault contains pre-existing media files that
went through CAS storage *before* this integration; they remain in moov-
at-end format and trigger the seek bug (browser must download the entire
file before any seek operation succeeds).

Empirical confirmation (2026-05-14):
- `드론 기술 개요…mp4` (773 MB) — moov at 99.7% ✗
- new 14 MB mp4 added 2026-05-14 — moov at 0.0% ✓ (already faststart on
  source, `Ok(true)` branch passed through unchanged)

The 17 existing AttachmentRefs in HanBin's `한글test` vault are a known
mix. W2 (bulk migration) ensures all of them become seek-friendly without
any user manual work.

---

## Algorithm

1. **Discover candidates** — walk `.notology/cas/blobs/**` looking for
   files whose AttachmentRef tier is `video` (or extension matches
   `mp4 | mov | m4v`).
2. **Probe** — for each candidate, run `mp4_faststart::is_faststart()`.
   Skip the ones already faststart.
3. **Re-mux to a temp file** — `mp4_faststart::apply_faststart(src, tmp)`.
   On any error, log + skip this file (leave original untouched).
4. **Replace atomically**:
   a. Compute new sha256 of the re-muxed bytes (will differ from the old
      sha — new content, even if mdat is byte-equivalent, because moov is
      now at the front).
   b. Write the re-muxed file to the new CAS location: `blobs/<aa>/<bb>/<new-sha>`.
   c. Update the AttachmentRef's `sha256` + `size_bytes` (same file size
      but explicit refresh) + `synced_to_server: false` so the new blob
      gets pushed.
   d. **Do not delete the old blob** until the new one is confirmed
      written (atomic-ish rename pattern).
5. **Wikilink rewrite is NOT needed** — wikilinks reference filenames
   (`originalName`), not CAS sha. AttachmentRef indirection means the
   wikilink resolver picks up the new sha automatically.
6. **Update sync queue** — enqueue the new blob for push; enqueue the
   old blob for trash (Track H semantics — old sha is now orphan in CAS).
7. **Verification pass** — after all candidates processed, re-walk and
   confirm every video-tier blob now passes `is_faststart()`.
8. **Backup safety net** — before the run, copy `.notology/attachments/`
   to `.notology/attachments.pre-faststart-migration/` so user can
   manually revert if anything goes wrong. Kept for 7 days then GC'd
   (matches Track B-2 backup retention).

---

## UX

- Re-use the **MigrationModal** pattern from Stage 4.x. Same component
  type, different store: `useFaststartMigrationStore`.
- Trigger: automatic on vault open *if* any candidate exists and not yet
  declined for this vault.
- States: `idle` → `prompt` → `running` → `done` / `error`.
- Progress: "Converted X / Y videos" updating live (backend emits
  `faststart_migration:progress` events).
- Prompt copy:
  > **기존 영상 파일 최적화**
  >
  > 7개의 영상 파일이 재생/탐색 호환성 향상을 위해 변환됩니다.
  > 화질이나 길이 변경 없이 메타데이터 위치만 재배치됩니다.
  > 변환 전 데이터는 `.notology/attachments.pre-faststart-migration/`
  > 폴더에 자동 백업됩니다.
  >
  > [지금 변환] [나중에] [다시 묻지 않기]
- `declineMigration` persists per vault in localStorage
  (`notology.faststart_migration.declined:<vault>`).

---

## Backend deliverables

- New module `src-tauri/src/features/sync_v2/faststart_migration.rs`
  (parallel to `attachment_migration.rs`):
  - `check_faststart_migration_needed(vault) -> FaststartReport`
  - `run_faststart_migration(vault) -> FaststartState` (emits progress)
  - `decline_faststart_migration(vault)`
- Tauri commands: 3 (mirror migration trio)
- Library wiring: AttachmentStore exposes a helper to swap an existing
  ref's blob sha (currently it only inserts new refs)

## Frontend deliverables

- `src/features/faststart-migration/` mirroring `src/features/migration/`:
  - `stores/faststartMigrationStore.ts`
  - `hooks/useFaststartMigrationProgress.ts`
  - `components/FaststartMigrationModal.tsx`
- Mount in `App.tsx` next to `<MigrationModal />`
- Trigger in `appActions.ts::openVault` after Stage-4 migration check

---

## Test plan

Pre-requisite: Stage 4.5.1 (determinism) green. Without that, bulk-rewriting
CAS blobs introduces fingerprint variance risk.

Unit:
- `faststart_migration` module — fixture vault with 3 candidates (1
  already-faststart, 1 needs conversion, 1 corrupted) → expect 1
  converted, 1 skipped, 1 error logged.
- Backup folder created and contains pre-migration copy.

Integration (`tests/faststart_migration_integration.rs`):
- Vault with 5 candidates, run migration, assert all videos pass
  `is_faststart()` after.
- Sha256 differs for converted ones, same for unchanged.
- AttachmentRef linked_notes preserved.
- Decline flow: prompted vault that declined stays untouched.

E2E (manual on HanBin's vault):
- Open vault → prompt appears with count
- Click "지금 변환" → progress bar
- Verify backup folder exists
- Verify all video-tier refs now pass inspect
- Re-open vault → no prompt (already migrated)

---

## Risk + mitigation

| Risk | Mitigation |
|---|---|
| Mid-migration crash leaves vault inconsistent | Atomic rename per file; failure on file N doesn't affect file N-1's completion |
| User cancels mid-migration | State per-file; resumable on next open via probe-then-skip-already-done |
| Disk space (need 2x video size temporarily) | Pre-check free space ≥ Σ candidate sizes; abort with friendly message if not |
| Synology push storm (re-uploading all converted blobs) | Use existing `lane_for_size` — large videos go to Slow lane; throttle |
| AttachmentRef inconsistency between devices | Migration is per-device; sync engine handles cross-device dedup via sha. After Device A migrates, Device B will see new refs on next pull and dedup against its own (possibly already migrated) blobs |
| Backup folder takes 2x disk space until GC | Documented; GC runs at 7 days; user can manually delete sooner |

---

## Estimated session count

- 4.6.1 backend module + tests: **1 session**
- 4.6.2 frontend modal + integration: **0.5 session**
- 4.6.3 E2E on HanBin vault + report: **0.5 session**

Total: **2 sessions**. Bumps to 3 if migration on HanBin's vault reveals
an unforeseen blob layout case (e.g., a file that mp4_faststart's parser
flags as malformed — would surface in the 4.5.1 audit ideally, but real
production vaults can have edge cases the synthetic test fixtures miss).

---

## Sequencing in the larger roadmap

```
4.5.1 green (determinism proven)
   ↓
4.5.2 / 4.5.3 / 4.5.4 / 4.5.5 (parallel where possible)
   ↓
all 4.5 green
   ↓
4.6 attachment migration (this stage)
   ↓
4.6 verified on HanBin vault
   ↓
Stage 5.0 redesign + 5.0.5 zoom-overhaul
```
