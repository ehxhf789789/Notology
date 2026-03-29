use serde::{Serialize, Deserialize};

/// Result of a 3-way merge attempt.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum MergeResult {
    /// Auto-merge succeeded — no overlapping changes.
    Merged { content: String },
    /// Same block changed differently — user must choose.
    Conflict {
        local_version: String,
        remote_version: String,
        conflict_blocks: Vec<ConflictBlock>,
    },
}

/// A single conflicting block with both versions.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConflictBlock {
    pub block_index: usize,
    pub base: String,
    pub local: String,
    pub remote: String,
}

/// User's choice for conflict resolution.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ConflictChoice {
    KeepLocal,
    KeepRemote,
    KeepBoth,
    /// Custom merged content provided by user
    Custom { content: String },
}

// ================================================================
// 3-way merge: block-level (paragraphs separated by blank lines)
// ================================================================

pub struct ConflictResolver;

impl ConflictResolver {
    /// Attempt 3-way merge.
    /// - `base`: last synced version (common ancestor)
    /// - `local`: current local version
    /// - `remote`: current remote (NAS) version
    pub fn resolve(base: &str, local: &str, remote: &str) -> MergeResult {
        // Split into blocks (paragraphs separated by blank lines)
        let base_blocks = split_blocks(base);
        let local_blocks = split_blocks(local);
        let remote_blocks = split_blocks(remote);

        // Diff each side against base
        let local_ops = diff_blocks(&base_blocks, &local_blocks);
        let remote_ops = diff_blocks(&base_blocks, &remote_blocks);

        // Try to merge: apply non-conflicting changes
        let mut merged_blocks: Vec<String> = base_blocks.clone();
        let mut conflicts: Vec<ConflictBlock> = Vec::new();
        let mut has_conflict = false;

        // Build change maps: block_index → new content
        let local_changes = build_change_map(&local_ops);
        let remote_changes = build_change_map(&remote_ops);

        // Collect all affected indices
        let mut all_indices: Vec<usize> = local_changes.keys()
            .chain(remote_changes.keys())
            .copied()
            .collect();
        all_indices.sort();
        all_indices.dedup();

        for &idx in &all_indices {
            let local_change = local_changes.get(&idx);
            let remote_change = remote_changes.get(&idx);

            match (local_change, remote_change) {
                // Only one side changed — apply it
                (Some(change), None) => {
                    apply_change(&mut merged_blocks, idx, change);
                }
                (None, Some(change)) => {
                    apply_change(&mut merged_blocks, idx, change);
                }
                // Both sides changed the same block
                (Some(local_c), Some(remote_c)) => {
                    // If both made the same change, no conflict
                    if local_c == remote_c {
                        apply_change(&mut merged_blocks, idx, local_c);
                    } else {
                        // Real conflict
                        has_conflict = true;
                        conflicts.push(ConflictBlock {
                            block_index: idx,
                            base: if idx < base_blocks.len() {
                                base_blocks[idx].clone()
                            } else {
                                String::new()
                            },
                            local: match local_c {
                                BlockChange::Modified(s) | BlockChange::Inserted(s) => s.clone(),
                                BlockChange::Deleted => String::new(),
                            },
                            remote: match remote_c {
                                BlockChange::Modified(s) | BlockChange::Inserted(s) => s.clone(),
                                BlockChange::Deleted => String::new(),
                            },
                        });
                    }
                }
                (None, None) => {} // unreachable given all_indices construction
            }
        }

        if has_conflict {
            MergeResult::Conflict {
                local_version: local.to_string(),
                remote_version: remote.to_string(),
                conflict_blocks: conflicts,
            }
        } else {
            // Reconstruct content from merged blocks
            let content = join_blocks(&merged_blocks);
            MergeResult::Merged { content }
        }
    }
}

// ================================================================
// Block operations
// ================================================================

/// Split content into blocks (paragraphs). A blank line separates blocks.
fn split_blocks(content: &str) -> Vec<String> {
    let mut blocks = Vec::new();
    let mut current = String::new();

    for line in content.lines() {
        if line.trim().is_empty() {
            if !current.is_empty() {
                blocks.push(current.clone());
                current.clear();
            }
        } else {
            if !current.is_empty() {
                current.push('\n');
            }
            current.push_str(line);
        }
    }
    if !current.is_empty() {
        blocks.push(current);
    }

    blocks
}

/// Rejoin blocks with blank-line separators.
fn join_blocks(blocks: &[String]) -> String {
    blocks.iter()
        .filter(|b| !b.is_empty())
        .cloned()
        .collect::<Vec<_>>()
        .join("\n\n")
}

/// Change type for a block.
#[derive(Debug, Clone, PartialEq)]
enum BlockChange {
    Modified(String),
    Deleted,
    Inserted(String),
}

/// Block-level diff operation.
#[derive(Debug, Clone)]
struct BlockOp {
    index: usize,
    change: BlockChange,
}

/// Compute block-level diff using LCS (longest common subsequence).
fn diff_blocks(base: &[String], modified: &[String]) -> Vec<BlockOp> {
    let mut ops = Vec::new();

    // Simple LCS-based diff
    let lcs = lcs_table(base, modified);
    let mut i = base.len();
    let mut j = modified.len();
    let mut changes: Vec<(usize, BlockChange)> = Vec::new();

    while i > 0 || j > 0 {
        if i > 0 && j > 0 && base[i - 1] == modified[j - 1] {
            // Same block — no change
            i -= 1;
            j -= 1;
        } else if j > 0 && (i == 0 || lcs[i][j - 1] >= lcs[i - 1][j]) {
            // Insertion in modified
            changes.push((i, BlockChange::Inserted(modified[j - 1].clone())));
            j -= 1;
        } else if i > 0 {
            // Deletion from base
            changes.push((i - 1, BlockChange::Deleted));
            i -= 1;
        }
    }

    changes.reverse();

    // Convert to BlockOps, merging adjacent delete+insert as modify
    let mut idx = 0;
    while idx < changes.len() {
        let (pos, ref change) = changes[idx];

        // Check for modify: delete at pos followed by insert at pos
        if let BlockChange::Deleted = change {
            if idx + 1 < changes.len() {
                if let (p2, BlockChange::Inserted(ref new_content)) = &changes[idx + 1] {
                    if *p2 == pos {
                        ops.push(BlockOp {
                            index: pos,
                            change: BlockChange::Modified(new_content.clone()),
                        });
                        idx += 2;
                        continue;
                    }
                }
            }
        }

        ops.push(BlockOp { index: pos, change: change.clone() });
        idx += 1;
    }

    ops
}

/// Build LCS table for block-level comparison.
fn lcs_table(a: &[String], b: &[String]) -> Vec<Vec<usize>> {
    let m = a.len();
    let n = b.len();
    let mut table = vec![vec![0; n + 1]; m + 1];

    for i in 1..=m {
        for j in 1..=n {
            if a[i - 1] == b[j - 1] {
                table[i][j] = table[i - 1][j - 1] + 1;
            } else {
                table[i][j] = table[i - 1][j].max(table[i][j - 1]);
            }
        }
    }

    table
}

/// Build a map of block_index → change from diff ops.
fn build_change_map(ops: &[BlockOp]) -> std::collections::HashMap<usize, BlockChange> {
    let mut map = std::collections::HashMap::new();
    for op in ops {
        map.insert(op.index, op.change.clone());
    }
    map
}

/// Apply a change to the merged blocks.
fn apply_change(blocks: &mut Vec<String>, index: usize, change: &BlockChange) {
    match change {
        BlockChange::Modified(new_content) => {
            if index < blocks.len() {
                blocks[index] = new_content.clone();
            }
        }
        BlockChange::Deleted => {
            if index < blocks.len() {
                blocks[index] = String::new(); // Mark as empty, filtered on join
            }
        }
        BlockChange::Inserted(content) => {
            if index <= blocks.len() {
                blocks.insert(index, content.clone());
            } else {
                blocks.push(content.clone());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_no_conflict() {
        let base = "Hello\n\nWorld\n\nFoo";
        let local = "Hello\n\nWorld Modified\n\nFoo";
        let remote = "Hello\n\nWorld\n\nFoo\n\nBar";

        match ConflictResolver::resolve(base, local, remote) {
            MergeResult::Merged { content } => {
                assert!(content.contains("World Modified"));
                assert!(content.contains("Bar"));
            }
            MergeResult::Conflict { .. } => panic!("Expected merge, got conflict"),
        }
    }

    #[test]
    fn test_same_change_no_conflict() {
        let base = "A\n\nB\n\nC";
        let local = "A\n\nX\n\nC";
        let remote = "A\n\nX\n\nC";

        match ConflictResolver::resolve(base, local, remote) {
            MergeResult::Merged { content } => {
                assert!(content.contains("X"));
            }
            MergeResult::Conflict { .. } => panic!("Same change should not conflict"),
        }
    }

    #[test]
    fn test_real_conflict() {
        let base = "A\n\nB\n\nC";
        let local = "A\n\nLocal Version\n\nC";
        let remote = "A\n\nRemote Version\n\nC";

        match ConflictResolver::resolve(base, local, remote) {
            MergeResult::Conflict { conflict_blocks, .. } => {
                assert_eq!(conflict_blocks.len(), 1);
                assert_eq!(conflict_blocks[0].local, "Local Version");
                assert_eq!(conflict_blocks[0].remote, "Remote Version");
            }
            MergeResult::Merged { .. } => panic!("Expected conflict"),
        }
    }
}
