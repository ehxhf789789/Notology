//! Stage 4 sync engine — Library-integrated sync via SyncProvider trait.
//!
//! Replaces legacy `sync/` module. Currently under development.
//! Not wired into Tauri commands yet (that's sub-stage 4.10).

pub mod webdav_provider;
pub mod in_memory_provider;
pub mod object_sync;
pub mod ref_sync;
pub mod notifier;
pub mod conflict_detector;
pub mod branch_manager;
pub mod sync_engine;
pub mod migration_manager;
pub mod config;
pub mod dirty_queue;
pub mod push_worker;
pub mod adaptive_poller;
pub mod offline_monitor;
pub mod text_merge;
pub mod trash;
pub mod vault_migrator;
pub mod reconciliation;
pub mod bootstrap;
pub mod commands;

// Track B Phase B-1 skeleton — schema only, no logic yet.
pub mod attachment_types;

// Track B Phase B-2 — attachment storage layer (CAS blobs + ref metadata + index).
pub mod attachment_store;

// Track B Phase B-2 — attachment NAS sync (push/pull, dedup, two-tier lane routing).
pub mod attachment_sync;

// Track B Phase B-2 — Slow-lane background worker for large attachments.
pub mod background_worker;

// Track B Phase B-2 — legacy `{Note}_att/` → `.attachments/` + CAS migration.
pub mod attachment_migration;

// Track B Phase B-2 (Q2=C, §4.4-CL) — chunked blob upload layer.
// Files ≥100 MB are split into 16 MB chunks with a commit-last manifest;
// smaller files use a single PUT. Both layouts coexist on NAS.
pub mod chunked_upload;

// Track B Phase B-3 PART 6 (HanBin 2026-05-13) — bidirectional reconcile
// between AttachmentRef.linked_notes and the actual wikilinks present in
// every note's body. Detects + repairs:
//   - dummy chips: wikilink in a note with no backing ref
//   - stale ref links: ref claims a link that the note body does not have
//   - missing ref links: chip in note body that ref doesn't yet record
pub mod attachment_reconcile;
