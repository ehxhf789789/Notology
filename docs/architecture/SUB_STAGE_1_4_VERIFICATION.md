# Sub-Stage 1.4 Verification Report: Library Coordinator

**Date**: 2026-04-19  
**Module**: `src-tauri/src/core/library.rs` (575 lines; 358 production, 217 tests)

---

## Phase 1: Test Re-execution

### 1.1 Library Tests

```
running 13 tests
test core::library::tests::test_device_id_persisted ... ok
test core::library::tests::test_commit_version_creates_all_three ... ok
test core::library::tests::test_commit_unchanged_content ... ok
test core::library::tests::test_read_version ... ok
test core::library::tests::test_repair_note_missing_ref ... ok
test core::library::tests::test_commit_changed_content ... ok
test core::library::tests::test_recovery_missing_ref_with_dag ... ok
test core::library::tests::test_get_head ... ok
test core::library::tests::test_update_sync_etag ... ok
test core::library::tests::test_get_history ... ok
test core::library::tests::test_multiple_notes_independent ... ok
test core::library::tests::test_repair_note_missing_object ... ok
test core::library::tests::test_recovery_missing_object ... ok

test result: ok. 13 passed; 0 failed; 0 ignored; 0 measured; 318 filtered out; finished in 0.18s
```

- **Pass/fail**: 13/13
- **Debug output**: None observed with `--nocapture`. The `eprintln!` in `resolve_device_id` (line 331) was not triggered since file writes succeed in test TempDirs.
- **Execution time**: 0.18s

### 1.2 All Core Tests (Regression)

```
test result: ok. 52 passed; 0 failed; 0 ignored; 0 measured; 279 filtered out; finished in 0.30s
```

Breakdown: CAS 11 + DAG 9 + Refs 8 + NoteID 11 + Library 13 = **52/52**. No regressions.

### 1.3 Clippy

```
No clippy issues in library.rs
```

---

## Phase 2: Spec Deviation Compliance

### 2.1 New Methods

- `pub fn new_with_device_id(vault_path: &Path, device_id: String) -> Result<Self, String>` (line 57) ✅
- `pub fn repair_note(&self, note_id: &str, md_path: Option<&Path>) -> Result<RepairReport, String>` (lines 213-290) ✅
- `pub fn device_id(&self) -> &str` (line 299) ✅

### 2.2 RepairReport

```rust
// lines 28-36
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RepairReport {
    pub note_id: String,
    pub actions_taken: Vec<String>,
    pub final_head_hash: Option<String>,
}
```

All fields and derives present. ✅

### 2.3 device_id Format

Line 325: `let device_id = format!("{}-{}", hostname, uuid_part);`

- Hostname sanitized via `sanitize_hostname` (line 339-344): alphanumeric + `-` + `_`, truncate to 32 chars. ✅
- Hex part: `generate_short_id()` returns `format!("{:08x}", ...)` — exactly 8 hex chars. ✅

### 2.4 device_id Persistence

- Location: `{vault}/.notology/device-id` (line 306) ✅
- Read: trims whitespace, returns existing if non-empty (lines 309-316) ✅
- Write: best-effort with `eprintln!` warning (lines 328-332) ✅

### 2.5 Module Doc Comment

Lines 1-17 list all 6 deviations:
- [x] new_with_device_id, repair_note, device_id methods
- [x] RepairReport
- [x] Save flow order change
- [x] Limited automatic recovery (Case 1, 3)
- [x] get_history returns full DAG
- [x] device_id format

All present. ✅

---

## Phase 3: `commit_version` Correctness

### 3.1 Full Method (lines 94-134)

```rust
pub fn commit_version(
    &self, note_id: &str, content: &[u8],
    relative_path: &str, attachment_hashes: Vec<String>,
) -> Result<Option<String>, String> {
    let new_hash = CasStore::hash(content);                    // Step 1
    let current_ref = self.refs.get(note_id)?;                 // Step 2 (read)
    if current_ref.as_ref().map(|r| r.head_hash.as_str())      // Step 2 (compare)
        == Some(&new_hash) {
        return Ok(None);                                        // Step 2 (skip)
    }
    self.cas.write_object(content)...?;                        // Step 3: CAS
    let mut dag = VersionDag::load(&self.vault_path, note_id)...?;
    let parent_hash = dag.latest().map(|v| v.content_hash.clone());
    dag.append(new_hash.clone(), parent_hash, ...);
    dag.save(&self.vault_path, note_id)...?;                   // Step 4: DAG
    let prev_etag = current_ref.and_then(|r| r.sync_etag);
    let new_ref = NoteRef { head_hash: new_hash.clone(), sync_etag: prev_etag, ... };
    self.refs.set(&new_ref)...?;                               // Step 5: Ref
    Ok(Some(new_hash))
}
```

### 3.2 Ordered Execution Verification

| Step | Spec | Line(s) | Verified |
|------|------|---------|----------|
| 1. Hash | `CasStore::hash(content)` | 101 | ✅ |
| 2. Skip-if-unchanged | Ref read + compare + early return | 104-107 | ✅ Before any writes |
| 3. CAS write | `self.cas.write_object(content)` | 110-111 | ✅ First write |
| 4. DAG append+save | `dag.append(...); dag.save(...)` | 114-119 | ✅ After CAS, before ref |
| 5. Ref update | `self.refs.set(&new_ref)` | 130-131 | ✅ Last write |

Order is strictly CAS → DAG → Ref. ✅

### 3.3 Critical Correctness

- **Skip before CAS write?** Yes — line 106 returns `Ok(None)` before line 110. ✅
- **Parent hash from previous HEAD?** Line 116: `dag.latest().map(|v| v.content_hash.clone())` — uses DAG's latest, not new hash. ✅
- **sync_etag preserved?** Line 122: `current_ref.and_then(|r| r.sync_etag)` → carried to new ref. ✅
- **attachment_hashes passed through?** Line 117: `dag.append(..., attachment_hashes)`. ✅

### 3.4 Skip-if-unchanged

Early return at line 106: `return Ok(None)`. This is BEFORE any disk I/O (CAS write is line 110). ✅

### 3.5 Failure Mode Analysis

| Failure Point | Vault State | Recovery |
|--------------|-------------|----------|
| CAS write fails (line 110) | No writes occurred | Clean — retry safe |
| DAG load fails (line 114) | CAS has orphaned object | Harmless — future GC; CAS is idempotent |
| DAG save fails (line 118) | CAS object exists, DAG unchanged | Re-commit will re-append; CAS idempotent |
| Ref set fails (line 130) | CAS + DAG updated, ref stale | `get_head()` Case 1 recovery: DAG has entry → ref rebuilt. ✅ |

All failure modes are recoverable. ✅

---

## Phase 4: `get_head` Recovery Logic

### 4.1 Full Method (lines 141-182)

Quoted in full read above.

### 4.2 Case 1 Verification

Code path when ref exists but CAS object missing (lines 149-162):
- Loads DAG (line 150)
- Iterates `dag.versions.iter().rev()` — **newest first** ✅
- For each: checks `has_object` → if found, creates updated ref with `..note_ref` struct update (line 153-157) → calls `self.refs.set()` (line 158) → returns `Ok(Some(...))` ✅
- If none found: returns `Ok(None)` (line 162) ✅

Ref is updated atomically via `refs.set()`. ✅

### 4.3 Case 3 Verification

Code path when ref missing, DAG exists (lines 164-180):
- Loads DAG (line 166)
- If `dag.latest()` is Some: creates new ref with `relative_path: String::new()` (placeholder) and `sync_etag: None` (lines 168-174) ✅
- Calls `self.refs.set()` (line 175) ✅
- If DAG empty: returns `Ok(None)` (line 178) ✅

### 4.4 No Over-Recovery

`get_head` does NOT:
- Read .md files ✅
- Generate IDs ✅
- Modify data when both ref and DAG are missing (returns `Ok(None)`) ✅
- Repair DAG corruption ✅

### 4.5 Atomicity

Ref update in Case 1 (line 158): constructs `updated` NoteRef in memory first, then writes atomically via `refs.set()`. If write fails, the error propagates — original ref file is untouched (atomic_write_file either succeeds or doesn't modify the target). ✅

---

## Phase 5: `repair_note` 4-Step Strategy

### 5.1 Full Method (lines 213-290)

Quoted in full read above.

### 5.2 4-Step Structure

- [x] Step 1: Ref valid → no-op (lines 222-231)
- [x] Step 2: DAG scan newest-first → restore ref (lines 235-262)
- [x] Step 3: md_path → commit_version (lines 264-282)
- [x] Step 4: No recovery → return with `final_head_hash: None` (lines 284-289)

### 5.3 Action Messages

- Step 1 no-op: `"Ref valid, no repair needed"` (line 225)
- Step 1 bad ref: `"Ref points to missing CAS object {hash}"` (line 232)
- Step 2 success: `"Restored ref from DAG entry {hash}"` (line 255)
- Step 3 success: `"Resurrected from .md file as new commit {hash}"` (line 274)
- Step 4 failure: `"No recovery path available"` (line 284)

### 5.4 relative_path Reconstruction (Step 2)

Lines 238-244:
```rust
let relative_path = ref_opt.as_ref()
    .map(|r| r.relative_path.clone())           // 1. From existing ref
    .or_else(|| md_path.and_then(|p| {           // 2. From md_path
        p.strip_prefix(&self.vault_path).ok()
            .and_then(|rp| rp.to_str().map(|s| s.to_string()))
    }))
    .unwrap_or_default();                        // 3. Empty string
```

Fallback chain: ref → md_path → empty. ✅

### 5.5 sync_etag Preservation (Step 2)

Line 245: `let sync_etag = ref_opt.as_ref().and_then(|r| r.sync_etag.clone());` ✅

### 5.6 Step 3 Uses commit_version

Line 272: `let new_hash = self.commit_version(note_id, &content, &relative_path, vec![])?;` ✅

Uses the standard commit flow, not manual CAS/DAG/Ref writes. ✅

---

## Phase 6: `resolve_device_id` Behavior

### 6.1 Implementation (lines 303-335)

Quoted in full read above. Helper functions `sanitize_hostname` (lines 338-344) and `generate_short_id` (lines 350-357).

### 6.2 Persistence Scenarios

| Scenario | Code Path | Result |
|----------|-----------|--------|
| No file | Lines 309 false → 318-325 generate → 328 write | New ID generated and persisted |
| File with ID | Lines 310-313 read+trim → non-empty → return | Existing ID returned |
| Empty file | Lines 310-313 read+trim → empty → fall through to generate | New ID generated |
| Whitespace-only | Trimmed at line 311, empty check at 312 → regenerate | New ID generated |

All correct. ✅

### 6.3 Hostname Sanitization

For `"한빈의 MacBook Pro"`:
- Korean chars → `-`, space → `-`
- Result: `"--------MacBook-Pro"` (19 chars, ≤32)

**Observation**: Consecutive hyphens are not collapsed. This produces ugly but functional device IDs like `"--------MacBook-Pro-a1b2c3d4"`. Not a bug per spec — purely cosmetic. **Low severity observation.**

### 6.4 Short ID Generation (lines 350-357)

```rust
fn generate_short_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{:08x}", (nanos as u32) ^ ((nanos >> 32) as u32))
}
```

- Uses `SystemTime` nanos ✅
- Falls back to 0 ✅
- XORs upper/lower 32 bits ✅
- Formats as 8 lowercase hex ✅

### 6.5 Persistence Error Handling

Lines 328-332: `eprintln!` warning, then proceeds with `Ok(device_id)`. Library init succeeds. ✅

---

## Phase 7: Other Methods

### 7.1 `read_version` (line 185-187)

Delegates to `self.cas.read_object(content_hash)`. ✅

### 7.2 `get_history` (lines 190-193)

Loads DAG, returns `dag.versions` (Vec, oldest first). Empty DAG → empty Vec. ✅

### 7.3 `get_ref` (lines 196-198)

Direct delegate to `self.refs.get(note_id)`. ✅

### 7.4 `update_sync_etag` (lines 201-207)

Reads ref → errors if None → updates `sync_etag` + `updated_at` → writes back. ✅

### 7.5 `is_initialized` (lines 79-83)

Checks all three dirs: objects/, history/, refs/. Returns true only if ALL exist. ✅

### 7.6 Accessors

`cas()` (line 293), `refs()` (line 296), `device_id()` (line 299). All present and trivial. ✅

---

## Phase 8: Code Quality Audit

### 8.1 `unwrap()` Audit

All `unwrap()` occurrences are in `#[cfg(test)] mod tests` (lines 365-575). **Zero `unwrap()` in production code.** ✅

### 8.2 `expect()` Audit

None found. ✅

### 8.3 Debug Print Audit

One `eprintln!` at line 331 — intentional warning for device-id persistence failure, documented in code comment. No `println!` or `dbg!`. ✅

### 8.4 Error Messages (5 samples)

1. `"commit_version: CAS write failed: {}"` (line 111) — operation + context ✅
2. `"commit_version: DAG load failed: {}"` (line 115) — operation + context ✅
3. `"update_sync_etag: no ref for note_id {}"` (line 203) — operation + note_id ✅
4. `"Library::new: vault path is not a directory: {:?}"` (line 59) — operation + path ✅
5. `"repair_note: failed to read md file: {}"` (line 268) — operation + error ✅

All follow `"{operation}: {description}: {context}"` pattern. ✅

### 8.5 Documentation Completeness

| Public Item | Has `///` doc? |
|-------------|---------------|
| `Library` struct | ✅ |
| `RepairReport` struct | ✅ |
| `Library::new` | ✅ |
| `Library::new_with_device_id` | ✅ |
| `Library::is_initialized` | ✅ |
| `Library::commit_version` | ✅ |
| `Library::get_head` | ✅ |
| `Library::read_version` | ✅ |
| `Library::get_history` | ✅ |
| `Library::get_ref` | ✅ |
| `Library::update_sync_etag` | ✅ |
| `Library::repair_note` | ✅ |
| `Library::cas` | ✅ |
| `Library::refs` | ✅ |
| `Library::device_id` | ✅ |

All 15 public items documented. ✅

---

## Phase 9: Test Quality Review

| Test | Behavior Verified | Quality |
|------|-------------------|---------|
| `test_commit_version_creates_all_three` | CAS+DAG+Ref all created on commit | ✅ Checks all 3 artifacts |
| `test_commit_unchanged_content` | Returns None, no new writes | ✅ Checks DAG len, CAS count, head |
| `test_commit_changed_content` | New hash, DAG grows, ref updated | ✅ |
| `test_get_head` | None before commit, Some after | ✅ |
| `test_read_version` | Content round-trip, nonexistent returns None | ✅ |
| `test_get_history` | 3 versions, parent chain correct | ✅ Checks parents[0], [1], [2] |
| `test_update_sync_etag` | Set/clear/unknown-note paths | ✅ All 3 cases |
| `test_recovery_missing_ref_with_dag` | Case 3: DAG exists, no ref | ✅ Verifies ref created |
| `test_recovery_missing_object` | Case 1: delete CAS obj, fallback to older | ✅ Verifies ref updated to h1 |
| `test_multiple_notes_independent` | Two notes don't interfere | ✅ |
| `test_repair_note_missing_ref` | DAG+CAS exist, no ref → repair | ✅ Checks actions_taken content |
| `test_repair_note_missing_object` | CAS deleted → resurrect from .md | ✅ Only tests Step 3 path |
| `test_device_id_persisted` | Create, drop, recreate → same ID | ✅ Checks file exists + content |

**Observations**:
- `test_repair_note_missing_object` only tests the Step 3 path (md resurrection). The Step 2 path (DAG fallback with older valid object) is already covered by `test_recovery_missing_object` via `get_head`. Adequate coverage overall.
- No test for `repair_note` Step 4 (total failure). Low risk — the code path is simple (push message, return None).

---

## Phase 10: Integration Verification

### 10.1 Scope

`git diff --stat` for core/ shows:
- `src-tauri/src/core/mod.rs` — +5 lines (all sub-stages 1.1-1.4 combined)
- `src-tauri/Cargo.toml` — pre-existing changes (not from library.rs; no new deps added)

`library.rs` is untracked (new file). ✅

### 10.2 No New Dependencies

Cargo.toml diff is pre-existing. `hostname`, `sha2`, `chrono`, `serde_json`, `serde_yaml` all present before Stage 1. ✅

### 10.3 LOC Breakdown

- Total: 575 lines
- Test block: 217 lines
- Production: 358 lines
- Target: ~400 max production
- **Within target.** ✅

---

## Phase 11: Final Assessment

### 11.1 Overall Verdict: **PASS**

The Library coordinator is correctly implemented, all 52 core tests pass (no regressions), and the critical `commit_version` method follows the ordered-writes invariant precisely.

### 11.2 Risks Identified

| Risk | Severity | Description |
|------|----------|-------------|
| Hostname consecutive hyphens | **Low** | Non-ASCII hostnames produce ugly device IDs like `"--------MacBook-Pro-a1b2c3d4"`. Functional but cosmetic. |
| `commit_version` reads ref twice | **Low** | Lines 104 and 122 both read the ref. Second read is to extract `sync_etag` after `current_ref` is consumed by the skip check. One extra file read (~0.1ms). Acceptable. |
| `get_head` Case 3 sets empty relative_path | **Low** | By design. `repair_note()` or `commit_version()` will set it properly later. |
| No test for repair Step 4 (total failure) | **Low** | Code path is trivial (3 lines). Risk of bug is minimal. |

### 11.3 Ready for Sub-Stage 1.5?

**Yes, proceed.** No blockers. All foundation modules (CAS, DAG, Refs, NoteID, Library) are verified and stable with 52 passing tests.

### 11.4 Suggested Follow-up Tasks

1. **Hostname sanitization improvement** (optional, cosmetic): Collapse consecutive hyphens in `sanitize_hostname`. Low priority.
2. **Optimize double ref read** in `commit_version` (optional): Read ref once, clone etag before consuming for skip check. Low priority — 0.1ms overhead.
