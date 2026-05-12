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
