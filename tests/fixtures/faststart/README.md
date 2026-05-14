# Faststart determinism fixtures

This directory holds metadata only — the fixture binaries themselves are
generated on demand into a temp dir by the standalone audit binary at
[c:/tmp/faststart_determinism_verify](file:///C:/tmp/faststart_determinism_verify).
Generated fixtures total ~400 MB and are intentionally not checked in.

## Generator

Source: `c:/tmp/faststart_determinism_verify/src/fixtures.rs`.

Each fixture is a minimum-valid container assembled atom-by-atom with no
randomness. mdat payload is fixed bytes (`0xAA`) — content is irrelevant,
only that runs match. Large fixtures are scaled down from the plan's
500 MB – 1.5 GB band to ≤ 80 MB; the algorithm shifts chunk-offset entries
by `moov.size` and copies mdat byte-for-byte, so output determinism is
independent of mdat magnitude. The 4-byte → 8-byte offset boundary is
exercised by the dedicated `co64-only_*` fixtures with entries > 4 GB.

## Matrix (21 fixtures)

| # | name | container | layout | entries |
|---|------|-----------|--------|---------|
|  1 | at-end_mp4_small_1            | mp4 | ftyp+mdat+moov          | stco × 3 |
|  2 | at-end_mp4_small_2            | mp4 | ftyp+mdat+moov          | stco × 3 |
|  3 | at-end_mp4_medium_1           | mp4 | ftyp+mdat+moov          | stco × 3 |
|  4 | at-end_mp4_medium_2           | mp4 | ftyp+mdat+moov          | stco × 3 |
|  5 | at-end_mp4_large_1            | mp4 | ftyp+mdat+moov (80 MB)  | stco × 3 |
|  6 | at-end_mov_small_1            | mov | ftyp+mdat+moov          | stco × 2 |
|  7 | at-end_mov_medium_1           | mov | ftyp+mdat+moov          | stco × 2 |
|  8 | at-end_m4v_medium_1           | m4v | ftyp+mdat+moov          | stco × 2 |
|  9 | at-start_mp4_small_1          | mp4 | ftyp+moov+mdat          | stco × 1 |
| 10 | at-start_mp4_small_2          | mp4 | ftyp+moov+mdat          | stco × 1 |
| 11 | at-start_mp4_medium_1         | mp4 | ftyp+moov+mdat          | stco × 1 |
| 12 | at-start_mp4_medium_2         | mp4 | ftyp+moov+mdat          | stco × 1 |
| 13 | stco-only_mp4_medium_1        | mp4 | ftyp+mdat+moov          | stco × 50 |
| 14 | stco-only_mp4_medium_2        | mp4 | ftyp+mdat+moov          | stco × 500 |
| 15 | co64-only_mp4_large_1         | mp4 | ftyp+mdat+moov          | co64 × 30 (entries > 4 GB) |
| 16 | co64-only_mp4_large_2         | mp4 | ftyp+mdat+moov          | co64 × 200 (entries > 4 GB) |
| 17 | mixed-track_mp4_medium_1      | mp4 | ftyp+mdat+moov(2 traks) | stco + stco |
| 18 | mixed-track_mp4_medium_2      | mp4 | ftyp+mdat+moov(2 traks) | co64 + stco |
| 19 | edge_free_pre_mdat_small_1    | mp4 | ftyp+free+mdat+moov     | stco × 2 |
| 20 | edge_uuid_pre_mdat_large_1    | mp4 | ftyp+uuid+mdat+moov     | co64 × 2 |
| 21 | real_world_redacted           | mp4 | real Webex-style sample | (variable) |

Fixture #21 is copied at runtime from the user's vault if available
(`%LOCALAPPDATA%\com.notology.app\vaults\<id>\한글test\.attachments\*.mp4`)
and silently skipped on a clean host. Filename is redacted before write.

## Why the binary lives in `c:/tmp/`

`cargo test --lib` for the Tauri workspace currently fails on Windows due
to a DLL loader bug (see project_synology_issues / Stage 4 notes — same
class of build issue). The standalone binary inlines `mp4_faststart.rs`
via `#[path]` so the audit can run without touching the broken pathway.
A determinism unit test (`three_run_byte_identity`) exists alongside the
other unit tests in `src-tauri/src/core/mp4_faststart.rs#tests` and will
run automatically once the lib pathway is repaired.

## Running

```pwsh
cd c:/tmp/faststart_determinism_verify
cargo build --release
./target/release/faststart-determinism-verify.exe
```

Exit 0 + "DETERMINISM CONFIRMED" line on success. Exit 1 + per-fixture
sha256 deviation table on any failure (workdir is preserved for inspection).

## Audit history

- **2026-05-14**: 21 fixtures × 3 runs = 63 outputs, 0 deviations, 2.7 s
  (Windows). Report: `docs/architecture/stage_4_5_reports/4_5_1.md`.
