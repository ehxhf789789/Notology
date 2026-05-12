# Track B — Attachment System Redesign (Stage 4.10)

**Status:** Phase B-1 (design + POC) — 2026-05-12
**Owner:** HanBin
**Phase plan:** B-1 (1d, this doc) → B-2 (1d, sync integration) → B-3 (1d+, UI / viewers / drag-out)
**Authority above:** [ARCHITECTURE_ANALYSIS.md](./ARCHITECTURE_ANALYSIS.md) (D2 CAS mirror, D8 per-device state, Q8 attachment isolation)

---

## 0. Mandate

Notology was built attachment-first against the Obsidian model (`{Note}_att/` siblings).
Stage 4 sync engine bypasses attachments entirely — `DirtyOperation::AttachmentUpsert/Delete` reach `push_worker.rs:138/142` as no-op stubs. NAS-as-authority cannot be honoured while binaries live only on disk.

Track B re-bases attachments on three primitives Sync V2 already provides:
1. **CAS** — content-addressed blob store
2. **Per-attachment ref metadata** — JSON sibling, mirrors the note ref pattern
3. **WebDAV-driven sync** — eager push, conflict via ref-merge

Outcome: every attachment is a NAS object addressable by `sha256`, dedup-aware across notes, and droppable into external apps via `tauri-plugin-drag`.

---

## 1. Diagnosis (Phase B-1 §PART 0)

### 1.1 Current backend
| File | LOC | Role |
|------|----:|------|
| [`features/attachment.rs`](../../src-tauri/src/features/attachment.rs) | 687 | `read_attachment_folder`, `search_att/search_attachments`, `check_attachment_references`, `delete_multiple_files`, `delete_attachments_with_links` |
| [`features/note.rs:474`](../../src-tauri/src/features/note.rs) | — | `import_attachment(source, note)` — copies file into `{Note}_att/` |
| [`attachment_cleanup_test.rs`](../../src-tauri/src/attachment_cleanup_test.rs) | 922 | 500 scenarios — single/batch/dummy/conflict |
| [`attachment_edge_cases_test.rs`](../../src-tauri/src/attachment_edge_cases_test.rs) | 440 | 15 edge cases — special chars / long names / deep folders |
| [`attachment_wikilink_sync_test.rs`](../../src-tauri/src/attachment_wikilink_sync_test.rs) | 1017 | ~2400 simulations — add / delete / link sync |

### 1.2 Current storage layout (legacy)
```
vault/
  Note.md
  Note_att/
    Report.pdf
    image.png
    comments.json        # special: not a user attachment
```
- Per-note folder, **no dedup** (same file in two notes ⇒ two physical copies).
- Lifecycle bound to parent note (rename / delete cascades — `trash.rs` covers this).

### 1.3 Reference styles already supported
- Wikilink: `[[file.pdf]]` (primary; TipTap's WikiLink node serializes to this)
- Embed: `![[image.png]]` (image-only inline render via `Decoration.widget`)
- HTML span: `<span data-wiki-link="file.pdf">` (TipTap output form)
- Markdown: `](file.pdf)` (parse-only)

### 1.4 Sync V2 attachment coverage
- `DirtyOperation::AttachmentUpsert { relative_path }` / `AttachmentDelete` — enum defined
- `sync_v2_enqueue_attachment` Tauri command exists ([`commands.rs:489`](../../src-tauri/src/features/sync_v2/commands.rs))
- `push_worker.rs:137-144` — **stubbed** (`log::debug` + `Ok(())`)
- `ref_sync.rs`, `object_sync.rs` — `.md` + DAG only, no binary path
- `trash.rs` — cascade for `{stem}_att` folder works ✓
- `vault_migrator.rs:176` / `reconciliation.rs:359` — already skip `_att` folders (assumes they're not in DAG)

### 1.5 Frontend coverage matrix
| Capability | Status | Locus |
|-----------|:------:|-------|
| Drag-drop in (external → app) | ✅ | `useDragDrop.ts`, `import_attachment` |
| Paste import | ⚠️ partial | TipTap default image paste |
| Insert via `//` suggestion | ✅ | `AttachmentSuggestion.ts` |
| Inline image render `![[]]` | ✅ | `WikiLink.ts` `Decoration.widget` |
| Chip render `[[]]` | ✅ | WikiLink node + `att-{category}` class |
| PDF viewer | ✅ | `HoverPdfViewer.tsx` (iframe) |
| Image viewer | ✅ | inline `<img>` + hover-window |
| Document viewer | ✅ | LibreOffice → PDF cache |
| **CSV viewer** | ❌ | **new in B-3** |
| **Video / Audio viewer** | ❌ | **new in B-3** |
| NAS sync | ❌ | **new in B-2** (push_worker stubs) |
| Conflict policy | ⚠️ partial | Synology suffix detection only |
| Trash | ✅ | `sync_v2/trash.rs` cascade |
| Cleanup | ✅ | `delete_attachments_with_links` (regex covers wikilink + HTML span) |
| **Drag-out (app → external)** | ❌ | **new in B-3** (see §5) |

---

## 2. Schema (Phase B-1 §PART 1)

### 2.1 `AttachmentRef`
One JSON file per attachment, stored at `vault/.notology/attachments/refs/{attachment_id}.json`.

Skeleton lives at [`src-tauri/src/features/sync_v2/attachment_types.rs`](../../src-tauri/src/features/sync_v2/attachment_types.rs) — compile-only; logic deferred to B-2.

```rust
pub struct AttachmentRef {
    pub attachment_id: String,        // 14-digit ms-precision UTC timestamp
    pub original_name: String,        // "Report.pdf"
    pub mime_type: String,            // "application/pdf"
    pub size_bytes: u64,
    pub sha256: String,
    pub tier: AttachmentTier,
    pub created_at: DateTime<Utc>,
    pub linked_notes: Vec<String>,    // note_ids that wikilink this attachment
    pub display_path: String,         // ".attachments/Report.pdf"
    pub sync_etag: Option<String>,
    pub remote_path: Option<String>,
}
```

### 2.2 `AttachmentBlob`
Physical binary in CAS — one per unique `sha256`, referenced by N AttachmentRefs.

```rust
pub struct AttachmentBlob {
    pub sha256: String,
    pub local_path: PathBuf,          // .notology/cas/blobs/ab/cd/<sha>
    pub remote_path: Option<String>,
    pub size_bytes: u64,
}
```

### 2.3 `AttachmentTier`
```rust
pub enum AttachmentTier { Image, Pdf, Document, Csv, Video, Audio, Other }
```
- `from_extension(ext)` — total function, returns `Other` for unknown
- `supports_inline_preview()` — true for Image / Pdf / Csv / Video / Audio
- `supports_external_viewer_only()` — true for Document
- `mime_for_extension(ext)` — string table

### 2.4 Reference resolver
Wikilink resolution: `[[file.pdf]]` → search `linked_notes` index for current `note_id` → return `AttachmentRef` whose `original_name` matches. Phase B-2 implements; struct is `ResolvedAttachment` (see [attachment_types.rs](../../src-tauri/src/features/sync_v2/attachment_types.rs)).

Multiple files with the same `original_name` in the same note → resolver disambiguates by `attachment_id` carried alongside the wikilink (TipTap node attribute extension in B-3).

---

## 3. Storage Layout (decision §1.2 confirmed 2026-05-12)

### 3.1 Final structure
```
vault/
  Note.md
  AnotherNote.md
  .attachments/                                      ← user-visible (Obsidian-style)
    Report.pdf            ┐
    Image.png             │ each is a hardlink to a CAS blob
    Report_1.pdf          │ (name collision auto-numbered)
    ...                   ┘
  .notology/
    attachments/
      refs/
        20260512123456.json      # per-attachment metadata
        20260512123457.json
        ...
      index.json                 # filename → attachment_id map (B-2)
    cas/
      blobs/
        ab/cd/abcd1234...        # SHA-256 sharded 2/2 prefix
        ef/01/ef012345...
    refs/                        # existing — note refs (Stage 1)
    objects/                     # existing — note DAG (Stage 1)
    branches/                    # existing — version history
```

### 3.2 Link strategy: hardlink + copy fallback
| Filesystem | Method | Notes |
|-----------|--------|-------|
| NTFS (same volume) | `std::fs::hard_link` | default on Windows |
| ext4 / APFS / Btrfs | `std::fs::hard_link` | default on Linux / macOS |
| FAT32 / cross-volume / network mount | `std::fs::copy` | fallback; emits `log::warn` |

Implementation contract (B-2):
```rust
fn link_or_copy(blob: &Path, display: &Path) -> std::io::Result<LinkMethod> {
    match std::fs::hard_link(blob, display) {
        Ok(()) => Ok(LinkMethod::Hardlink),
        Err(e) if can_fallback(&e) => {
            std::fs::copy(blob, display)?;
            Ok(LinkMethod::Copy)
        }
        Err(e) => Err(e),
    }
}
```
- Stored on `AttachmentRef` (optional `link_method` extension if observable bugs arise).
- Edits to `vault/.attachments/X` are not detected — files are treated as immutable. The CAS hash is the identity.

### 3.3 Name-collision policy
Two AttachmentRefs with the same `original_name` (different `sha256`) ⇒ second one gets `Report_1.pdf`, third `Report_2.pdf`. Both `AttachmentRef.display_path` reflect the suffix; the unsuffixed `original_name` is preserved.

### 3.4 Dedup
- Same `sha256` ⇒ one blob, N refs. `linked_notes` of each ref tracks its own note set.
- Different `sha256` with same `original_name` ⇒ separate refs, suffixed display names.

---

## 4. Sync Strategy (Phase B-2 input)

### 4.1 Eager (Option A confirmed)
- New attachment created → `sync_v2_enqueue_attachment` (already exists) → push_worker uploads blob and ref.
- Other device's reconciliation pulls both.
- All devices end with identical CAS state.

### 4.2 Operation flow (B-2 implements)

**Push (push_worker → WebDAV):**
1. Read `AttachmentRef` from `.notology/attachments/refs/{id}.json`
2. If `provider.has_object(&sha256)` false → `PUT vault/.notology/cas/blobs/{sha}` with binary
3. `PUT vault/.notology/attachments/refs/{id}.json` with ref JSON (If-Match etag — D2 semantics)
4. Update `sync_etag` on local ref
5. (Optional, B-2 decision) `PUT vault/.attachments/{display_name}` — see §4.3

**Pull (reconciliation):**
1. Discover new ref files via PROPFIND on `.notology/attachments/refs/`
2. Read each ref → ensure CAS blob present (download if missing)
3. Recreate hardlink `vault/.attachments/{display_name}` → CAS blob
4. Update local `index.json`

### 4.3 `.attachments/` mirror — open question for B-2
Two strategies:
- **A** (recommended): NAS holds only `.notology/cas/blobs/` + `.notology/attachments/refs/`. `.attachments/{display}` is rebuilt locally as a hardlink each pull. Simpler; no duplicate upload.
- **B**: NAS mirrors `.attachments/{display}` for human inspection via Synology File Station. Costs ×2 storage. **Defer to B-2 decision.**

### 4.4 Large-file strategy (B-2) — revised 2026-05-12 to option C

HanBin reversed the earlier "warn + soft cap" plan. Final decision = **no size cap**: the chunked layer (§4.4-CL) makes single-PUT limits invisible. A 5 GB video and a 200 KB PDF go through the same `attachment_add` command; the size dictates lane choice (Fast/Slow) and transport (single PUT vs chunked) automatically.

### 4.4-CL Chunked upload layer

Implemented in [`chunked_upload.rs`](../../src-tauri/src/features/sync_v2/chunked_upload.rs). Confirmed parameters (2026-05-12):

| Parameter | Value | Why |
|-----------|-------|-----|
| Chunk size | 16 MB | Comfortably under any Synology Apache PUT cap; coarse enough for low per-chunk overhead |
| Threshold | 100 MB | Files ≥ this use chunked transport. Identical to the Slow-lane queue threshold so the two activate together. |
| Local CAS layout | Single file (always) | Hardlinking to `.attachments/{display}` requires a contiguous file. The chunked layout is **NAS-only**. |
| NAS layout (small) | `.notology/cas/blobs/{ab}/{cd}/{sha}` | Backward-compatible single PUT |
| NAS layout (large) | `.notology/cas/blobs/{ab}/{cd}/{sha}_chunks/{manifest.json, chunk_NNNN}` | Folder + commit token |
| Commit semantics | Manifest written **last** | Without manifest, the upload is considered absent → resumable + atomic |
| Resume granularity | Per chunk via PROPFIND size match | Cheap; per-chunk hash verified only on download |
| Hash verification | Per chunk + reassembled-total on download | Defense in depth; catches single corrupted chunk |

### 4.5 CSV merge
- Phase B-2 decision: **no** automatic merge. CSVs sync as opaque binaries.
- Reason: text-merge of structured CSV (column shifts, quoting) creates worse breakage than Last-Device-Wins. Branch preserved at `.notology/branches/` for manual recovery.

---

## 5. ★ External Drag-Out (Phase B-3 input — re-reviewed 2026-05-12)

### 5.1 POC result (Phase B-1 §PART 2)
- Approach A (HTML5 `setData('text/uri-list', 'file://...')`) — **fails on WebView2 + Windows**. Reproduced:
  - Bare attachment-chip drag onto Desktop → text-only drag preview, no file drop. (HanBin screenshot 2026-05-12)
  - Same chip onto KakaoTalk and KakaoWork chat input → no drop accepted.
  - Result: WebView2 emits only `text/plain` style payload; OS does not negotiate a file-promise transfer.
- Approach B (Tauri command + same `setData`) — same outcome expected; root cause is WebView2's DataTransfer surface, not the path.

### 5.2 Confirmed strategy: tauri-plugin-drag (Approach C)
Library: [`crabnebula-dev/drag-rs`](https://github.com/crabnebula-dev/drag-rs) (Apache-2.0 / MIT, last release 2026-05-01, Tauri v2 compatible).

Native API used per platform:
- **Windows** — `IDataObject` + `DoDragDrop` (Ole32). Produces real file promise. Drops as actual file in Explorer / KakaoTalk / KakaoWork / Outlook.
- **macOS** — `NSPasteboard` file promise
- **Linux** — GTK `target_list`

**Required additions (Phase B-3):**
1. `src-tauri/Cargo.toml`: `tauri-plugin-drag = "2"` (verify exact crate name at install)
2. `package.json`: `@crabnebula/tauri-plugin-drag`
3. `src-tauri/src/lib.rs`: `.plugin(tauri_plugin_drag::init())` in builder
4. `src-tauri/capabilities/default.json`: drag plugin permission entry
5. WebView2 quirk: may need `webview.controller().SetAllowExternalDrop(false)` to suppress the default drop handler that swallows outgoing drags. Validate during B-3 integration; expose as Rust call if plugin doesn't already do this.

### 5.3 UX surface
Drag handle = the existing attachment chip (`<span class="wiki-link-inline attachment">`). Hookup:
```ts
chip.addEventListener('dragstart', async (e) => {
  e.preventDefault();        // suppress TipTap's text drag
  const ref = await resolveAttachment(fileName);
  await startDrag({ item: [ref.absolute_local_path], icon: tierIcon(ref.tier) });
});
```

### 5.4 Fallback options (only if `tauri-plugin-drag` regresses)
1. **"Show in folder"** context menu — opens File Explorer at the CAS-linked display file; user drags from there. Robust, but two-step.
2. **"Copy as file"** — Windows-only, writes `CF_HDROP` to clipboard via Rust; user pastes into target. Discoverability: poor.
3. **Custom Rust plugin** — re-implement IDataObject ourselves. Avoid unless plugin is unmaintained.

Decision tree captured in `track_b_attachment_design_decisions.md` (B-3 will create if needed).

### 5.5 POC artifacts (do not promote to production)
- [`src-tauri/src/features/attachment_drag.rs`](../../src-tauri/src/features/attachment_drag.rs) — `attachment_drag_poc_prepare` Tauri command (path validation + metadata)
- [`src/features/sync_v2/test/AttachmentDragPoc.tsx`](../../src/features/sync_v2/test/AttachmentDragPoc.tsx) — floating dev panel with picker + draggable chip + log
- Both will be deleted at the start of Phase B-3 once the plugin integration replaces them.

---

## 6. File-type tier matrix (Phase B-3 input)

| Tier | Extensions | Inline preview | External viewer | Drag-out (B-3) | Notes |
|------|-----------|---------------|----------------|:--------------:|-------|
| Image | png, jpg, jpeg, gif, webp, svg, bmp | inline `<img>` | hover-window | ✓ | HEIC deferred |
| Pdf | pdf | optional embed | `HoverPdfViewer` (iframe) | ✓ | largest user demand |
| Document | hwpx, docx, pptx, xlsx | none (chip only) | LibreOffice → PDF cache | ✓ | preserve current viewer cache |
| Csv | csv | papaparse table ≤1MB | chip only ≥1MB | ✓ | merge = LWW |
| Video | mp4, mov, webm | `<video>` (lazy) | external app | ✓ | thumbnail deferred to B-3+ |
| Audio | mp3, wav, m4a | `<audio>` (always) | — | ✓ | inline play |
| Other | (anything else) | reject at import | — | ✓ | future opt-in |

Excluded altogether: zip / tar.gz (archives), txt (imports as note).

---

## 7. Migration (Phase B-2 + B-3 prep)

### 7.1 Trigger
On vault open, if `vault/.notology/attachments/refs/` is absent **and** at least one `*_att/` directory exists ⇒ run migration. Modal blocks vault until completion. Per `feedback_migration_strength.md`: forcible + zero data loss + checksum verify + rollback.

### 7.2 Algorithm
```text
1.  Acquire vault lock (existing vault_lock.rs)
2.  Snapshot pre-state:
      for each */{*_att}/file in vault:
          record { source_path, size, sha256 }
3.  Create vault/.legacy/<timestamp>/  (rsync-equivalent copy of all _att folders)
4.  For each (note, _att, file):
       a. compute sha256
       b. attachment_id = next_timestamp_ms() (monotonic)
       c. write CAS blob at .notology/cas/blobs/<sha[0..2]>/<sha[2..4]>/<sha>
       d. resolve display_name: if `.attachments/<original>` exists with different sha
          → suffix `_1`, `_2`, ... until unique
       e. hardlink (or copy fallback) .attachments/<display> → CAS blob
       f. write .notology/attachments/refs/<attachment_id>.json
       g. update note body: rewrite `[[old_filename]]` → `[[display]]` if name changed
       h. record (source, display, sha) in migration journal
5.  Post-state verification:
       - count(.notology/attachments/refs/*.json) == count(source files)
       - for each ref: blob exists, size matches, sha matches
       - hash all original sources again — abort if any mismatch (race)
6.  If verified:
       - DELETE original _att folders (only after .legacy/ backup confirmed by step 3)
       - emit `vault:attachment-migration-complete` event
7.  If verification fails:
       - DELETE partially-written .attachments/ and .notology/attachments/
       - RESTORE from .legacy/<timestamp>/
       - show modal with diff log, refuse vault open
```

### 7.3 Safety invariants
- `.legacy/<timestamp>/` is **never deleted** by migration. User chooses to clear via a Settings action after a successful sync round-trip.
- Migration journal written incrementally to `.notology/attachments/migration_journal.json` — survives crash; resume picks up at last verified entry.
- Wikilink rewrites use the same regex engine as `delete_attachments_with_links` (proven on the existing 2400-case test corpus).

### 7.4 Rollback UX
If verification fails or user cancels (rare — modal disables cancel after step 4):
- Vault returns to pre-state bit-identical (verified via journal).
- Error report saved to `vault/.notology/migration_errors.log`.
- User can retry or open vault read-only (separate flag).

### 7.5 Out-of-scope for B-1
The migration algorithm above is the contract for B-2 implementation. B-1 commits only:
- Schema struct ([`attachment_types.rs`](../../src-tauri/src/features/sync_v2/attachment_types.rs))
- Drag-out POC ([`attachment_drag.rs`](../../src-tauri/src/features/attachment_drag.rs))
- This design document

---

## 8. Conflict Policy (Phase B-2 input)

| Scenario | Probability | Policy |
|---------|:-----------:|--------|
| Same `attachment_id`, different `sha256` | ~0 (id = ms timestamp + device entropy) | Last Device Wins; both blobs preserved at `.notology/branches/<branch_id>/attachments/` |
| Concurrent attachment add to same note from two devices | possible | distinct `attachment_id`s; merge = union of `linked_notes` |
| Same `sha256`, different `attachment_id` | common (HanBin saves the same PDF on two devices) | dedup at CAS level — both refs reference one blob |
| Synology conflict suffix on `.attachments/*` | possible during simultaneous edits | existing `conflict_detector.rs` extended in B-2 — keep both, prompt resolution |
| Stale link (note references deleted attachment) | possible | resolver returns `Unresolved` — chip rendered as unresolved (existing UI) |

---

## 9. Phase plan & sizing

| Phase | Day | Scope |
|-------|:---:|-------|
| **B-1** | 1d (now) | Diagnosis · schema skeleton · drag-out POC + technical re-review · this doc |
| **B-2** | 1.5d | `attachment_sync.rs` (push_worker stubs filled) · CAS write path · migration impl · ref store + index · reconciliation pull |
| **B-3** | 2d | `tauri-plugin-drag` integration (was 1d; +1d for plugin install / WebView2 quirk validation / fallback paths) · CSV viewer · Video/Audio viewer · drag-out wiring · UI tier rendering |

B-3 sized up by 1 day because drag-out moved from "HTML5 standard" to "native plugin integration"; KakaoWork failure proves the plugin is mandatory, not optional.

---

## 10. Acceptance gate (Phase B-1)

- [x] PART 0 diagnosis paste'd to HanBin
- [x] PART 1 schema confirmed:
  - [x] Hardlink + copy fallback (Approach 3)
  - [x] wikilink retained, internal `attachment_id` map added
  - [x] `.attachments/` user-visible name
  - [x] flat layout + collision suffix
- [x] PART 2 drag-out re-reviewed:
  - [x] HTML5 setData fails on WebView2 (POC + HanBin verification with native chip)
  - [x] KakaoWork failure documented
  - [x] tauri-plugin-drag designated mandatory for B-3
- [x] PART 3 NAS layout fixed (§3.1)
- [x] PART 4 migration algorithm specified (§7) with rollback
- [x] PART 5 deliverables:
  - [x] this doc
  - [x] `attachment_types.rs` skeleton (compiles)
  - [x] `attachment_drag.rs` POC (compiles)
  - [x] `AttachmentDragPoc.tsx` dev-only component (tsc passes)

## 11. Auto-regression

| Check | Result |
|-------|:------:|
| `cargo build --lib` | ✓ (40 pre-existing warns) |
| `cargo test --lib --no-run` | ✓ (69 pre-existing warns; binary builds) |
| `cargo test --lib` runtime | ✗ pre-existing `STATUS_ENTRYPOINT_NOT_FOUND` on Windows Tauri lib tests (unrelated to Track B; `attachment_cleanup` shows same error) |
| `npx tsc --noEmit -p .` | ✓ EXIT 0 |

## 12. Phase B-2 / B-3 inputs (cheat sheet)

**For B-2:**
- Fill `push_worker.rs:138/142` using §4.2 flow
- Implement migration §7
- Decide §4.3 (NAS `.attachments/` mirror Y/N)
- Decide §4.4 (large-file threshold)
- Extend `conflict_detector.rs` per §8

**For B-3:**
- Install `tauri-plugin-drag` + `@crabnebula/tauri-plugin-drag` + capability
- Verify WebView2 `SetAllowExternalDrop` requirement
- Wire `dragstart` on attachment chips per §5.3
- Implement CSV viewer (papaparse, 1 MB cutoff)
- Implement Video / Audio inline players per §6
- Delete POC files: `attachment_drag.rs`, `AttachmentDragPoc.tsx`

## 13. Single-Surface Principle (Phase B-3 — confirmed 2026-05-12)

HanBin clarification: the **only** user-facing surface for attachments is the
wikilink chip embedded in a note body. The `.attachments/` folder is an
implementation detail — it must not appear in:

- file tree (`read_directory` continues to hide `.attachments/`, `.notology/`, `.legacy/`)
- the Attachments tab (currently fed by `_att/` folder walking — must switch to `AttachmentRef` index)
- search results (treat as opaque storage)

Consequences:
1. **Wikilink chip is the canonical reference.** Adding, removing, renaming,
   sharing, opening, or dragging an attachment all happen through the chip.
   The file in `.attachments/` is reconstructible from the ref + CAS blob, so
   there is no scenario where the user needs to "find the original file" by
   browsing the folder.
2. **Drag-in → auto-chip.** When the user drops a file onto the editor, a
   chip is inserted at the cursor immediately (placeholder while sha is
   computed; finalized on `attachment_add` response). Already wired in B-2
   via `useDragDrop.ts` → `attachmentAdd`; B-3 polishes the placeholder UX.
3. **Drag-out from chip(s) → external app.** Single chip → single file drag.
   Multiple selected chips → multi-file drag. Implemented via
   `tauri-plugin-drag`'s `startDrag({ item: [paths] })` accepting an array.
4. **Attachments tab redesign.** Powered by `AttachmentRef` index, not folder
   scan. Columns: original_name, linked notes (count + first), tier, size,
   sync status. Search over `original_name` + linked note titles. Click a row
   → open viewer; right-click → "go to note" + "delete + cleanup wikilinks".
5. **Frontend attachment resolver.** Phase B-2's `WikiLink.resolveLink`
   currently consults only the file tree, so `[[Report.pdf]]` shows
   unresolved (gray) after migration. B-3 wires a `zustand/attachmentStore`
   that mirrors the backend index, hydrated on vault open via
   `attachment_list_all` (new command) and updated on `attachment:saved`
   events. `resolveLink` consults this store first, falls back to file tree.
6. **Multi-select on chips.** Click + Shift-click extends a selection across
   chips in the same note (and across notes within a hover window stack).
   Selection state lives in the WikiLink decoration layer; ProseMirror
   plugin tracks `selectedChips: Set<{noteId, chipIndex}>`. Drag from any
   selected chip drags the whole set.

### B-3 task expansion (was 2 days → now ~3.5 days)

| # | Task | Day |
|---|------|----:|
| 1 | `tauri-plugin-drag` install + permission + builder | 0.25 |
| 2 | `attachmentStore` (zustand) + `attachment_list_all` command + hydration on vault open | 0.5 |
| 3 | `resolveLink` rewired to attachmentStore first (fixes gray chips post-migration) | 0.25 |
| 4 | Single chip drag-out (export-from-CAS → `startDrag`) | 0.5 |
| 5 | Multi-chip selection + group drag-out | 0.5 |
| 6 | Attachments tab redesign on AttachmentRef index | 0.5 |
| 7 | Migration progress modal (consume `attachment:migration-progress` event) | 0.25 |
| 8 | Conflict resolution dialog (UseLocal/UseRemote/KeepBoth) | 0.25 |
| 9 | CSV viewer (papaparse <1 MB cutoff) | 0.25 |
| 10 | Video/Audio inline players (HTML5 native) | 0.25 |
| 11 | Delete POC files + final regression | 0.0 |
| **total** | | **~3.5d** |
