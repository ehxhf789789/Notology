//! Three-way text merge for plain markdown content.
//!
//! Suggests a merged document when the user picks "Smart Merge" on a
//! conflict. Output is intended for human review — there is no automatic
//! resolution path: clean merges still surface in the dialog so the user
//! can confirm, and merges with conflicts contain Git-style markers the
//! user edits before saving.
//!
//! The algorithm is line-level LCS plus interleaving:
//!   1. Compute LCS(base, local) and LCS(base, remote).
//!   2. Walk all three line streams. Lines that appear in both LCS pairs
//!      are unchanged → emit verbatim.
//!   3. A region where only `local` differs from base is a clean local-side
//!      change → take local lines.
//!   4. Same on the remote side → take remote lines.
//!   5. A region where BOTH sides differ is a conflict → emit Git-style
//!      `<<<<<<< Local / ======= / >>>>>>> Remote` markers around the two
//!      versions of the region. The body in between is the un-merged text
//!      so the user can directly edit.
//!
//! Limitations (acceptable for v1 of the feature):
//!   - Whole-line granularity: a typo fix on the same line as another edit
//!     looks like a full-line conflict.
//!   - No move detection: a paragraph moved on one side + edited on the
//!     other shows as a deletion + insertion.
//!   - Frontmatter is preserved as ordinary text — the `id` line lives in
//!     the header so as long as both sides keep it, no conflict appears
//!     there. Tests guard the expected behavior.

use serde::Serialize;

/// Result returned to the UI. `merged` is the suggested merged content,
/// `clean` is true iff there were zero conflict regions, `conflict_count`
/// equals the number of `<<<<<<< Local` markers in `merged`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeResult {
    pub merged: String,
    pub clean: bool,
    pub conflict_count: usize,
}

const MARKER_LOCAL: &str = "<<<<<<< Local";
const MARKER_SEP: &str = "=======";
const MARKER_REMOTE: &str = ">>>>>>> Remote";

/// Three-way merge entry point. Lines are split on `\n`; the trailing
/// newline (if any) is preserved on the result.
pub fn three_way_merge(base: &str, local: &str, remote: &str) -> MergeResult {
    let base_lines = split_lines(base);
    let local_lines = split_lines(local);
    let remote_lines = split_lines(remote);

    // LCS index pairs against base for each side. lcs[i] = Some(j) means
    // base line i matches local/remote line j; None means base line i is
    // not in the side's LCS path.
    let lcs_local = lcs_match(&base_lines, &local_lines);
    let lcs_remote = lcs_match(&base_lines, &remote_lines);

    let mut merged: Vec<String> = Vec::new();
    let mut conflict_count = 0usize;

    let n = base_lines.len();
    let mut i = 0; // base cursor
    let mut li = 0; // local cursor
    let mut ri = 0; // remote cursor

    while i < n {
        // Case 1: this base line is shared by BOTH sides → emit any pending
        // changes in the local/remote regions before it (those are pure
        // additions that don't have a base counterpart), then emit the
        // line itself.
        let local_match = lcs_local[i];
        let remote_match = lcs_remote[i];
        if let (Some(lj), Some(rj)) = (local_match, remote_match) {
            // Drain any preceding inserts on local side.
            let local_pre: Vec<String> = local_lines[li..lj].iter().cloned().collect();
            let remote_pre: Vec<String> = remote_lines[ri..rj].iter().cloned().collect();
            emit_region(&mut merged, &mut conflict_count, &[], &local_pre, &remote_pre);

            merged.push(base_lines[i].clone());
            i += 1;
            li = lj + 1;
            ri = rj + 1;
            continue;
        }

        // Case 2: this base line was changed/removed on one or both sides.
        // Find the next shared base line — that bounds the divergent region.
        let mut j = i + 1;
        let (next_lj, next_rj) = loop {
            if j >= n {
                break (local_lines.len(), remote_lines.len());
            }
            if let (Some(lj), Some(rj)) = (lcs_local[j], lcs_remote[j]) {
                break (lj, rj);
            }
            j += 1;
        };

        let base_region: Vec<String> = base_lines[i..j].iter().cloned().collect();
        let local_region: Vec<String> = local_lines[li..next_lj].iter().cloned().collect();
        let remote_region: Vec<String> = remote_lines[ri..next_rj].iter().cloned().collect();

        emit_region(
            &mut merged, &mut conflict_count,
            &base_region, &local_region, &remote_region,
        );

        i = j;
        li = next_lj;
        ri = next_rj;
    }

    // Trailing inserts past the end of base (lines added at EOF on either
    // side without a shared anchor following them).
    let local_tail: Vec<String> = local_lines[li..].iter().cloned().collect();
    let remote_tail: Vec<String> = remote_lines[ri..].iter().cloned().collect();
    emit_region(&mut merged, &mut conflict_count, &[], &local_tail, &remote_tail);

    let merged_str = join_lines(&merged, base, local, remote);
    MergeResult {
        merged: merged_str,
        clean: conflict_count == 0,
        conflict_count,
    }
}

/// Emit one divergent region, deciding between clean take-local /
/// take-remote / conflict-markers.
fn emit_region(
    out: &mut Vec<String>,
    conflict_count: &mut usize,
    base: &[String],
    local: &[String],
    remote: &[String],
) {
    let local_changed = local != base;
    let remote_changed = remote != base;

    match (local_changed, remote_changed) {
        (false, false) => {
            // Identical to base. Just keep base.
            out.extend_from_slice(base);
        }
        (true, false) => {
            // Local edit, remote unchanged → take local.
            out.extend_from_slice(local);
        }
        (false, true) => {
            // Remote edit, local unchanged → take remote.
            out.extend_from_slice(remote);
        }
        (true, true) => {
            // Both edited the same region. If both produced the IDENTICAL
            // result (parallel edit to the same value), it's not a conflict.
            if local == remote {
                out.extend_from_slice(local);
            } else {
                *conflict_count += 1;
                out.push(MARKER_LOCAL.to_string());
                out.extend_from_slice(local);
                out.push(MARKER_SEP.to_string());
                out.extend_from_slice(remote);
                out.push(MARKER_REMOTE.to_string());
            }
        }
    }
}

/// Split content on `\n`, preserving empty lines and dropping the trailing
/// empty produced by a final `\n`. The trailing newline is reinstated by
/// `join_lines` based on whether *any* of the inputs ended with one.
fn split_lines(s: &str) -> Vec<String> {
    if s.is_empty() {
        return Vec::new();
    }
    let mut out: Vec<String> = s.split('\n').map(String::from).collect();
    // If the source ended with `\n`, the last element is "" — drop it; we
    // re-add the newline in `join_lines` instead.
    if out.last().map(|s| s.is_empty()).unwrap_or(false) {
        out.pop();
    }
    out
}

fn join_lines(lines: &[String], base: &str, local: &str, remote: &str) -> String {
    let mut s = lines.join("\n");
    // Preserve trailing newline if any input had one. Common case: all
    // markdown files end with `\n`.
    if base.ends_with('\n') || local.ends_with('\n') || remote.ends_with('\n') {
        s.push('\n');
    }
    s
}

/// For each line in `a`, return Some(j) if line a[i] participates in the
/// LCS at b[j], else None. Standard O(N·M) DP table walk; fine for note-
/// sized text (typically <1000 lines).
fn lcs_match(a: &[String], b: &[String]) -> Vec<Option<usize>> {
    let n = a.len();
    let m = b.len();
    if n == 0 || m == 0 {
        return vec![None; n];
    }
    // dp[i][j] = LCS length of a[0..i], b[0..j]
    let mut dp = vec![vec![0usize; m + 1]; n + 1];
    for i in 0..n {
        for j in 0..m {
            if a[i] == b[j] {
                dp[i + 1][j + 1] = dp[i][j] + 1;
            } else {
                dp[i + 1][j + 1] = dp[i + 1][j].max(dp[i][j + 1]);
            }
        }
    }
    // Backtrack to find the matching pairs.
    let mut matches: Vec<Option<usize>> = vec![None; n];
    let mut i = n;
    let mut j = m;
    while i > 0 && j > 0 {
        if a[i - 1] == b[j - 1] {
            matches[i - 1] = Some(j - 1);
            i -= 1;
            j -= 1;
        } else if dp[i - 1][j] >= dp[i][j - 1] {
            i -= 1;
        } else {
            j -= 1;
        }
    }
    matches
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merge_identical_inputs_is_clean() {
        let r = three_way_merge("hello\nworld\n", "hello\nworld\n", "hello\nworld\n");
        assert!(r.clean);
        assert_eq!(r.conflict_count, 0);
        assert_eq!(r.merged, "hello\nworld\n");
    }

    #[test]
    fn merge_disjoint_edits_are_clean() {
        // local edits line 1, remote edits line 3 — no overlap → clean.
        let base = "alpha\nbeta\ngamma\n";
        let local = "ALPHA\nbeta\ngamma\n";
        let remote = "alpha\nbeta\nGAMMA\n";
        let r = three_way_merge(base, local, remote);
        assert!(r.clean, "merged: {:?}", r.merged);
        assert_eq!(r.merged, "ALPHA\nbeta\nGAMMA\n");
    }

    #[test]
    fn merge_same_region_both_sides_yields_markers() {
        let base = "alpha\nbeta\ngamma\n";
        let local = "alpha\nLOCAL\ngamma\n";
        let remote = "alpha\nREMOTE\ngamma\n";
        let r = three_way_merge(base, local, remote);
        assert!(!r.clean);
        assert_eq!(r.conflict_count, 1);
        assert!(r.merged.contains(MARKER_LOCAL));
        assert!(r.merged.contains(MARKER_SEP));
        assert!(r.merged.contains(MARKER_REMOTE));
        assert!(r.merged.contains("LOCAL"));
        assert!(r.merged.contains("REMOTE"));
        // Lines outside the conflict are still present verbatim.
        assert!(r.merged.starts_with("alpha\n"));
        assert!(r.merged.ends_with("gamma\n"));
    }

    #[test]
    fn merge_same_edit_on_both_sides_is_clean() {
        // Both changed the line to the same value (parallel typo fix).
        let base = "alpha\nbeta\ngamma\n";
        let local = "alpha\nFIXED\ngamma\n";
        let remote = "alpha\nFIXED\ngamma\n";
        let r = three_way_merge(base, local, remote);
        assert!(r.clean);
        assert_eq!(r.merged, "alpha\nFIXED\ngamma\n");
    }

    #[test]
    fn merge_preserves_frontmatter_id_when_unchanged() {
        // Both sides keep the id line, edit only body. Header survives.
        let base = "---\nid: \"20260101000001\"\n---\n\nbody.\n";
        let local = "---\nid: \"20260101000001\"\n---\n\nlocal body.\n";
        let remote = "---\nid: \"20260101000001\"\n---\n\nremote body.\n";
        let r = three_way_merge(base, local, remote);
        assert!(r.merged.starts_with("---\nid: \"20260101000001\"\n---\n"));
        // body has a conflict → markers present
        assert!(r.merged.contains("local body."));
        assert!(r.merged.contains("remote body."));
        assert_eq!(r.conflict_count, 1);
    }

    #[test]
    fn merge_handles_unicode_korean_pure_additions() {
        // Both sides only ADD lines, never edit existing ones — line-level
        // LCS handles this cleanly. (Replacement-style edits on adjacent
        // lines end up grouped per the algorithm's coarseness; that's an
        // accepted limitation, see module docstring.)
        let base = "한국어\n끝\n";
        let local = "한국어\n중간\n끝\n";        // insert "중간" mid-doc
        let remote = "한국어\n끝\n파이팅\n";    // append "파이팅"
        let r = three_way_merge(base, local, remote);
        assert!(r.clean, "merged: {:?}", r.merged);
        assert_eq!(r.merged, "한국어\n중간\n끝\n파이팅\n");
    }

    #[test]
    fn merge_adjacent_replacements_yield_one_combined_conflict_region() {
        // Documented limitation: when local replaces line A and remote
        // replaces an adjacent line B (no shared anchor BETWEEN them),
        // the algorithm bundles the pair into one conflict region rather
        // than two clean disjoint takes. The user resolves manually. This
        // test pins that behavior so future refactors don't silently
        // change the user-visible output.
        let base = "alpha\nbeta\ngamma\n";
        let local = "ALPHA\nbeta\ngamma\n";
        let remote = "alpha\nBETA\ngamma\n";
        let r = three_way_merge(base, local, remote);
        assert!(!r.clean);
        assert_eq!(r.conflict_count, 1);
        // Both sides' edits visible in the conflict markers; the shared
        // anchor `gamma` is preserved verbatim outside.
        assert!(r.merged.contains(MARKER_LOCAL));
        assert!(r.merged.contains("ALPHA"));
        assert!(r.merged.contains("BETA"));
        assert!(r.merged.ends_with("gamma\n"));
    }

    #[test]
    fn merge_handles_pure_addition_at_end() {
        let base = "alpha\nbeta\n";
        let local = "alpha\nbeta\nlocal-tail\n";
        let remote = "alpha\nbeta\n";
        let r = three_way_merge(base, local, remote);
        assert!(r.clean);
        assert_eq!(r.merged, "alpha\nbeta\nlocal-tail\n");
    }

    #[test]
    fn merge_handles_addition_on_both_ends_no_conflict() {
        // local adds at start, remote adds at end → independent regions.
        let base = "middle\n";
        let local = "header\nmiddle\n";
        let remote = "middle\nfooter\n";
        let r = three_way_merge(base, local, remote);
        assert!(r.clean);
        assert_eq!(r.merged, "header\nmiddle\nfooter\n");
    }

    #[test]
    fn merge_empty_base_with_both_adding_yields_conflict() {
        // No common ancestor lines → entire content is a conflict region.
        let r = three_way_merge("", "first\n", "second\n");
        assert!(!r.clean);
        assert!(r.merged.contains("first"));
        assert!(r.merged.contains("second"));
        assert!(r.merged.contains(MARKER_LOCAL));
    }

    #[test]
    fn merge_preserves_no_trailing_newline_when_no_input_had_one() {
        let r = three_way_merge("alpha", "ALPHA", "alpha");
        assert_eq!(r.merged, "ALPHA");
    }
}
