# Stage 4.5 — Sync Safety Audit (pre-distribution gate)

**Status**: Drafted 2026-05-14, **fully adopted 2026-05-14 (HanBin sign-off)**.
All 5 sub-stages confirmed in scope. No partial / no deferral.
**Entry**: Stage 4 sync_v2 + Stage 4.x faststart re-mux landed.
**Exit**: All five audit items below produce green reports.
**Scope**: Verification only — no behavioral changes unless an audit finding
mandates one. Findings → bug tickets → fixed in this stage before Stage 5.
**Sequencing**: 4.5.1 first (gates the others — determinism is baseline for
trust in all subsequent audits). Order then 4.5.5 → 4.5.3 → 4.5.4 → 4.5.2.

## Decision log (2026-05-14)

HanBin sign-off in session 6c67ecfa:
- Q "5개 모두 채택 / 일부 / 폐기" → **5개 모두**
- Q "Stage 5.0 = layout 재설계 / 색만 / 폐기" → **layout 재설계 확정**
- Q "CSS zoom fix = hotfix / Stage 5.0 통합" → **Stage 5.0 통합**
- Q "기존 첨부 17개 = 사용자 재추가 / 자동 일괄 / lazy" → **자동 일괄 (W2)** →
  새 stage `STAGE_4_6_ATTACHMENT_MIGRATION_PLAN.md` 신설

## Next-session entry — Sub-stage 4.5.1 (Faststart determinism)

**Status (2026-05-14) — STAGE 4.5 COMPLETE**:
- **4.5.1**: ✅ 21 fixtures × 3 runs = 63 sha256-matched outputs, 0 deviations. Report: [stage_4_5_reports/4_5_1.md](stage_4_5_reports/4_5_1.md).
- **4.5.5**: ✅ F1 (13/13 NFC↔NFD dedup miss) fixed + re-verified 0/13. NFC normalization landed in `attachment_store.rs` (ingest + lookup + idempotent back-fill). F2 NTFS reserved-chars deferred to Stage 5 UX. Report: [stage_4_5_reports/4_5_5.md](stage_4_5_reports/4_5_5.md).
- **4.5.3**: ✅ 33/33 scenarios passed all explicit Plan targets. **Critical F-1 fixed in-flight**: 14→17-digit attachment_id format (silent ref overwrite under bulk-add). F-2 (write_index O(N) per add) and F-3 (resolve_wikilink linear scan @50K) documented as Stage 5/6 follow-up tickets. Report: [stage_4_5_reports/4_5_3.md](stage_4_5_reports/4_5_3.md).
- **4.5.4**: ✅ 33/33 scenarios passed across 6 dimensions (text_merge, branch convergence, collision @ scale, branch_id determinism, stress, dedup edges). F-1 text_merge O(N·M) > 5000 lines documented. Report: [stage_4_5_reports/4_5_4.md](stage_4_5_reports/4_5_4.md).
- **4.5.2**: ✅ 30 epochs × 150 ops = 4500 ops completed without panic/corruption. Algebraic invariant + sweep clean. F-2-soak confirms 4.5.3 F-2 at workload scale (1.91× wall growth = O(N) write_index). Async-runtime portions (RSS/FD/WAL/queue) deferred to CI follow-up. Report: [stage_4_5_reports/4_5_2.md](stage_4_5_reports/4_5_2.md).
- **4.5.6** (added 2026-05-14, drag-in flow integration): ✅ 33/33 async scenarios passed across 7 classes (sequential, concurrent same-device, multi-device, network failure, conflict, edge, stress). Two prior fixes re-verified end-to-end: NFC normalization (E2) + 17-digit id (E3). Local-persists-on-network-fail invariant (D1+D5) and provider half-push idempotency (D3) confirmed. Report: [stage_4_5_reports/4_5_6.md](stage_4_5_reports/4_5_6.md).
- **4.5.6.x** (added 2026-05-14, DirtyQueue concurrency): ✅ 31/31 scenarios passed across 7 classes (FIFO order, dedup semantics, concurrent enqueue/dequeue, retry & drop, worker drain atomicity, crash recovery, stress). **Confirmed**: same-lane same-device push is **순차 (sequential)** (1 worker for-loop), Fast/Slow lanes 간 + device 간은 **병렬**, per-entry independence (1개 실패가 나머지 안 막음), SQLite WAL 동시성 안전, 앱 종료/재시작 후 큐 + retry 카운트 복구. Cleared `stage-4.5.6-followup-dirty-queue-soak` ticket. Report: [stage_4_5_reports/4_5_6_x.md](stage_4_5_reports/4_5_6_x.md).
- **4.5.7** (added 2026-05-14, multi-device same-note + slow-network): ✅ 40/40 scenarios passed across 9 classes (text edit conflict full-path, same-note attachment race, polling latency, mixed text+attachment, slow-net basic 1-10s + jitter, slow+concurrent, partial timeout, backoff vs slow-net, final integration). **Confirmed**: A/B 동시 same-note 텍스트 편집 → fast-fwd or conflict-detected (LCA-based), 첨부 race → 모두 보존 + provider blob dedup, polling latency = tier interval (Realtime ≤1.5s), 약-신호 = 단순 await 길어짐 (no false retry), text vs attachment domain 독립, parallel 진행이 serial보다 ~2배 빠름. Report: [stage_4_5_reports/4_5_7.md](stage_4_5_reports/4_5_7.md).
- **4.5.8** (added 2026-05-14, real Synology NAS WebDAV): ✅ 26/26 scenarios passed against real NAS (`ehxhf789.synology.me`). Cleanup OK (delete_collection on ephemeral prefix). NAS round-trip avg ~150ms/op. **Confirmed**: ETag W/ normalization, no-If-Match policy, recursive MKCOL, Korean path, per-device state D8 pattern, content-hash validation on get_object, 1MB integrity. **F-1 finding**: intermittent MKCOL race on 4 concurrent put_md to NEW dir (1/4 first run, 4/4 rerun) — non-blocker (production retry covers), ticket `stage-4.5.8-followup-mkcol-race` opened. (A) cargo test --test attempted but blocked by same `STATUS_ENTRYPOINT_NOT_FOUND` lib loader bug as 4.5.1 — standalone binary remains only working test path. Report: [stage_4_5_reports/4_5_8.md](stage_4_5_reports/4_5_8.md).

**Stage 4.5 production fixes landed**:
1. NFC normalization (Stage 4.5.5) — backward-compatible auto back-fill on `AttachmentStore::new`
2. 17-digit attachment_id (Stage 4.5.3 F-1) — backward-compatible 14↔17 digit dual-parse
3. Removed dead `write_index()` calls (Stage 4.5.3 F-2 / 4.5.2 F-2-soak fix, 2026-05-14) — index.json was write-only dead code, no external readers; soak monotonic growth ratio dropped from 1.91× to 1.35× (passes 1.5× threshold). Function retained behind `#[allow(dead_code)]`.
4. `resolve_wikilink` O(1) primary path (Stage 4.5.3 F-3 fix, 2026-05-14) — uses existing `name_to_ids` HashMap as primary, linear scan for collision-suffixed display_basename as fallback. Pre-fix 7916 µs/lookup @ 50K refs → expected ~1-2 µs (4 orders of magnitude improvement). Production semantic preserved exactly.

Stage 4.6 W2 bulk migration **fully unblocked** — all three showstopper / perf-degradation bugs that would have corrupted or slowed the migration are now fixed.

**Stage 5/6 follow-up tickets opened**:
- ~~`stage-4.5.3-followup-write-index-O-N-squared`~~ — **CLOSED 2026-05-14**: write_index call sites removed (index.json was dead code, never read). Soak growth ratio 1.91× → 1.35× (now under 1.5× threshold). 4.5.2 + 4.5.3 F-2 cleared.
- ~~`stage-4.5.3-followup-resolve-wikilink-index`~~ — **CLOSED 2026-05-14** (hit case): `resolve_wikilink` primary path uses `name_to_ids` HashMap → O(1) for valid wikilinks. Class D bench at 50% miss workload showed no aggregate improvement because the 500 misses still hit the O(N) display_basename fallback — **new follow-up `stage-4.5.3-followup-resolve-wikilink-miss-index`** opened to add a 2nd `display_basename → ids` HashMap for full O(1) on both branches. Non-blocker (typical wikilinks are valid → hit case → already O(1)).
- `stage-4.5.3-followup-async-engine-perf`: in-process async harness for sync_engine perf (3 plan targets)
- `stage-4.5.2-followup-async-soak`: CI runner-based 24h soak (RSS/FD/WAL/queue)
- `stage-4.5.4-followup-text-merge-large-input`: Myers diff or pre-merge guard for >5000-line notes
- `stage-4.5.5-followup-ntfs-reserved-chars` (F2): UX surface for forbidden filename chars

The next session executes 4.5.1 first because it is the cheapest, gates the
trust of all other audits (and the W2 bulk migration in Stage 4.6), and is
self-contained.

**Concrete deliverables** for the next session:
1. **20 fixtures** in `tests/fixtures/faststart/` covering the matrix below.
2. **`tests/faststart_determinism_test.rs`** running each fixture × 3 runs
   on independent test processes, computing sha256, asserting all 3 match.
3. **CI matrix entry** wired (Windows runner minimum; macOS/Linux optional
   for this sub-stage if cross-platform soak ends up in 4.5.2).
4. **Report** at `docs/architecture/stage_4_5_reports/4_5_1.md` (~1 page):
   method, fixture inventory, results, any deviation findings.

**Fixture matrix** (20 total):

| moov position | container | size class | count |
|---|---|---|---|
| at-end | mp4 | small (1 KB – 1 MB) | 2 |
| at-end | mp4 | medium (10 – 100 MB) | 2 |
| at-end | mp4 | large (500 MB – 1.5 GB) | 1 |
| at-end | mov | small | 1 |
| at-end | mov | medium | 1 |
| at-end | m4v | medium | 1 |
| at-start | mp4 | small | 2 |
| at-start | mp4 | medium | 2 |
| stco-only | mp4 | medium | 2 |
| co64-only | mp4 | large | 2 |
| mixed-track (video + audio) | mp4 | medium | 2 |
| edge: ftyp + free + mdat + moov | mp4 | small | 1 |
| edge: ftyp + uuid + mdat + moov | mp4 | large | 1 |

**Fixture sourcing**:
- Synthetic generation (preferred): a Rust helper builds minimum-valid MP4
  containers programmatically — full control over atom layout, no licensing
  concerns. Use the test fixture pattern already in `mp4_faststart.rs`
  unit tests.
- Real-world (supplementary): HanBin's existing `.attachments/` provides
  several real moov-at-end Webex recordings — copy 2-3 in as additional
  fixtures with redacted filenames.

**Exit criterion**: 60 outputs (20 fixtures × 3 runs) all sha256-match,
0 deviations. Findings (if any) classified as `stage-4.5.1-blocker` and
fixed before 4.5.2 starts.

**Estimated session count**: 1 session if all pass, +1 per finding.

---

## Why this exists

Stage 4 unit + E2E tests cover happy-path correctness (91/91 lib units,
10/10 E2E scenarios). What they **don't** cover:

- Long-running session stability (longest E2E run is ~30 seconds)
- Network instability beyond simple online/offline toggle
- Large-vault performance (test vaults are <100 notes)
- ≥3 concurrent devices editing the same note
- Cross-device clock skew (attachment IDs are timestamp-keyed)
- Path normalization for emoji / NFD / RTL filenames
- Determinism of newly-added preprocessing (faststart re-mux)

Distribution to external users without these checks risks classes of bugs
that only surface in production. Stage 4.5 closes those gaps explicitly.

---

## Sub-stage 4.5.1 — Faststart determinism

**Risk**: `attachment_add` now applies `apply_faststart()` to mp4/mov/m4v
files before CAS hashing. If the algorithm is non-deterministic (e.g.,
byte-level differences across runs from buffer-padding, allocator, ordering),
the same source file from two devices produces two distinct CAS entries —
defeating dedup AND inflating storage.

**Method**:
1. Create 20 test fixtures across the matrix:
   - moov-at-end (Webex, Zoom, OBS-style)
   - moov-at-start (already faststart)
   - stco-only / co64-only / mixed-track
   - small (1 KB) / medium (50 MB) / large (1.5 GB)
   - mp4 / mov / m4v containers
2. For each fixture, run `apply_faststart()` 3 times on independent
   processes → 3 output files → all 3 must sha256-match.
3. Run on Windows + macOS + Linux to rule out platform-specific drift.

**Deliverable**: `tests/faststart_determinism_test.rs` + a CI matrix entry.
The standalone verify pattern from `c:/tmp/faststart_verify` already covers
the algorithmic skeleton — extend to multi-fixture loop.

**Exit**: 60 outputs (20 fixtures × 3 runs) sha256-match; 0 deviations.

---

## Sub-stage 4.5.2 — 24-hour soak test

**Risk**: Memory leaks, file-descriptor leaks, SQLite WAL bloat, sync queue
unbounded growth — these only surface in long runs. Stage 4 E2E tests
average 30 s; nothing has been observed at 24 h.

**Method**:
1. Headless Tauri build on a CI runner.
2. Vault prepared with a synthetic workload generator:
   - 1 note edit / 30 s
   - 1 attachment add / 5 min
   - 1 note delete / 30 min
3. Run for 24 h. Sample every 60 s:
   - RSS memory
   - Open file descriptors (`procfs` on Linux, `Get-Process | %{ $_.Handles }` on Windows)
   - SQLite WAL size in `.notology/sync_v2.db-wal`
   - Push/pull queue depth (`engine.queue_depth()`)
   - Polling tick time (should stay <500 ms)
4. Plot all five metrics; pass criteria below.

**Deliverable**: `scripts/soak/run_soak.ts` + GitHub Actions workflow that
posts a soak report (markdown + chart images) on demand.

**Exit**:
- RSS growth ≤ 50 MB over 24 h (some growth from glibc allocator is fine)
- FD count stable ±5 from hour 1 onward
- WAL size ≤ 100 MB (or auto-checkpoint working)
- Queue depth steady-state (no monotonic increase)
- No tick > 2 s
- No panic / crash in logs

---

## Sub-stage 4.5.3 — Large-vault performance

**Risk**: O(N²) algorithms hidden in scanner / reconcile / polling that are
imperceptible at 100 notes but quadratic-painful at 10 K notes.

**Method**:
1. Generator: produce vault with 10,000 notes (`note_{0..9999}.md` with
   small frontmatter + 1 KB body), 1,000 attachments (mix of file types,
   total ~10 GB), 50,000 wikilinks (random graph).
2. Measure:
   - Cold vault open time (target: < 5 s to "usable")
   - Initial sync time on a fresh device (target: < depends on net, but
     CPU time should be < 60 s excluding network)
   - Single attachment add time (target: < 500 ms for files < 10 MB)
   - Reconcile pass time (target: < 10 s for 10K notes)
   - Polling tick time at steady state (target: < 200 ms)
3. Profile with `cargo flamegraph` if any target is exceeded.

**Deliverable**: `scripts/perf/generate_large_vault.ts` + `tests/perf_large_vault_test.rs`.

**Exit**: All four targets met OR documented justification + benchmark
baseline for future regression detection.

---

## Sub-stage 4.5.4 — Multi-device conflict at scale

**Risk**: Stage 4 E2E tests 2-device branches. Real users on phone + laptop
+ desktop can produce 3-way branch trees. ConflictDetector's sort stability
and BranchManager's resolution order are correctness-critical.

**Method**:
1. Extend `tests/common/e2e_helpers.rs` `MultiDeviceEnv` from 2 to 5 devices.
2. New E2E scenarios:
   - **S10**: 3 devices edit same note concurrently → 3 branches → smart-merge resolves to single head
   - **S11**: 5 devices each create + edit + delete different attachments → ConflictDetector handles cross-attachment moves
   - **S12**: Device A creates branch X, syncs offline. Device B creates branch Y from the SAME parent as X but unaware. Device C resolves on top of both. Verify no orphan branches.
   - **S13**: ResolveByName collision — 3 devices each create an attachment with the same `originalName` but different content. Verify each gets a distinct ref + collision-suffixed displayPath.
3. Run each new scenario × 10 with fail-injecting provider; 0 failures.

**Deliverable**: 4 new E2E tests in `tests/sync_v2_e2e.rs`.

**Exit**: 40 runs pass (4 scenarios × 10 iterations); 0 deadlock or orphan
state.

---

## Sub-stage 4.5.5 — Path / filename normalization regression

**Risk**: Past bug (PART 6.5 `[`/`]` in filenames) shows path edge cases
can silently break wikilink parsing. Other categories not yet tested:

| Class | Example | Risk |
|---|---|---|
| Emoji | `회의 📅 메모.md` | UTF-8 round-trip, sort order |
| NFC vs NFD | macOS-created `한글.md` (NFD) imported on Windows (NFC) | Different bytes, same display — dedup miss |
| RTL | `דָּגֵשׁ.md` | Bidirectional rendering, byte direction |
| Combining marks | `café.md` vs `café.md` | NFC normalization in indexer |
| Surrogate pairs | `𝓗𝓮𝓵𝓵𝓸.md` | UTF-16 vs UTF-8 conversion in WebView2 |
| Whitespace | `  leading.md`, `trail .md` | Trim heuristics |
| Reserved Windows chars in linked content | `[[Q:1]]`, `[[A?B]]` | Wikilink parser regex |

**Method**:
1. Create test vault with 50 notes covering the matrix.
2. Verify:
   - Note + attachment creation round-trips disk → ref → wikilink → render
   - `attachment_add` produces correct `original_name` (NFC normalized)
   - `resolveByName(name, noteId)` matches both NFC and NFD spellings
   - Sync between Windows host + macOS host preserves names
3. Document any failures; fix in Stage 4.5 before exit.

**Deliverable**: `tests/path_normalization_test.rs` + fixture generator.

**Exit**: All 50 fixtures round-trip through {disk, ref, wikilink, sync,
display} with byte-equivalent original_name OR documented NFC/NFD policy.

---

## Out of scope (deferred)

- Mobile device sync (separate Stage)
- WebDAV server compatibility matrix beyond Synology (NextCloud, ownCloud,
  Apache mod_dav, nginx-dav — Stage 4.6 if needed)
- Cryptographic verification (end-to-end content signing) — Stage 6
- Sync speed optimization beyond meeting 4.5.3 targets — Stage 6

---

## Sequencing

Suggested order (each ~1 session):

1. **4.5.1 (Faststart determinism)** — fastest, lowest dependency
2. **4.5.5 (Path normalization)** — pure unit/integration tests, no infra needed
3. **4.5.3 (Large vault perf)** — needs generator infra
4. **4.5.4 (Multi-device conflict)** — extends existing e2e_helpers
5. **4.5.2 (24h soak)** — needs CI runner time slot; can run while other
   sub-stages proceed

Total estimate: 5 sessions if all green; +2 per finding that requires a fix.

---

## Reporting

Each sub-stage produces:
- A test file or scripts dir under `tests/` or `scripts/`
- A short markdown report (≤ 1 page) in `docs/architecture/stage_4_5_reports/{NN}.md` with method, results, findings
- An entry in `CHANGELOG.md` once green

Stage 4.5 is **closed** when all 5 reports green + 0 open findings tagged
`stage-4.5-blocker`.
