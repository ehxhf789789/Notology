//! vault_repair — comprehensive legacy/inconsistency detector and repair pipeline.
//!
//! 2026-05-24 (HanBin). Sister system to `attachment_migration` (v1→v2 _att/ folder
//! migration) and `attachment_reconcile` (chip ↔ ref drift fixer). vault_repair
//! unifies both plus 5 additional patterns the user hit in their vault that
//! previous tooling didn't catch:
//!
//! ## Patterns detected
//!
//! | ID | Pattern                                              | Auto-fix | Severity |
//! |----|------------------------------------------------------|----------|----------|
//! | P1 | `<note>_att/` folder still present (sync_v1)         | yes      | high     |
//! | P2 | sketch node `file:` is external OS path (not vault)  | yes      | high     |
//! | P3 | sketch node `file:` inside vault but no AttachmentRef | yes     | medium   |
//! | P4 | `[[wikilink]]` chip with no ref + file exists in vault | yes (1 candidate) / report (ambiguous) | medium |
//! | P5 | `[[wikilink]]` chip with no ref + no file in vault   | report   | low      |
//! | P6 | AttachmentRef.linked_notes.len() ≥ 2 (B-model violation) | yes  | medium   |
//! | P7 | orphan CAS blob (no ref points to it)                | yes      | low      |
//!
//! ## Safety
//!
//! Every apply step writes to `.legacy/repair_<ISO_timestamp>/` first. Any
//! verification failure rolls back via the manifest. Cargo invariants:
//!  - Pre-apply: `scan()` is pure (read-only, no side effects).
//!  - Per-pattern: each fixer is independent — failures don't abort the rest.
//!  - Post-apply: `verify()` re-checks sha256 of every new blob + ref count.
//!  - Rollback: restores backup files in reverse manifest order.
//!
//! ## Trigger model (HanBin 2026-05-24 decision)
//!
//!  - "First open" of a legacy vault → auto-scan + dialog (dismissible).
//!  - Established vaults → manual trigger only, via Settings → Dev Mode tab.
//!  - "Legacy" = any P1/P6 detected, OR no `.notology/repair_history.json`
//!     present AND any P2/P3/P5 detected. P4/P7 alone don't auto-trigger.

#![allow(dead_code)] // Modules are wired piece by piece across Batch 2.X commits.

pub mod scan;
pub mod backup;
pub mod apply;
pub mod verify;
pub mod rollback;
pub mod progress;
pub mod snapshot;
pub mod sandbox;

pub use scan::{scan, RepairReport, PatternCount, RepairFinding, FindingKind};
pub use apply::{apply, ApplyOptions, ApplyOutcome};
pub use backup::{BackupHandle, RepairManifest};
pub use verify::{verify, VerificationFailure};
pub use progress::{
    is_in_progress, request_cancel, snapshot as progress_snapshot,
    reset_to_idle, RepairProgress, RepairStage,
};
