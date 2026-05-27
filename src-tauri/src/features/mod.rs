pub mod note;
pub mod wikilink;
pub mod attachment;
pub mod tags;
pub mod preview;
pub mod note_lock;
pub mod cache;
pub mod comments;
pub mod system;
pub mod search_commands;
pub mod schedule;
pub mod share;
pub mod sync_v2;
pub mod connection;
pub mod window_lifecycle;
// Track B Phase B-1 POC (attachment_drag) removed 2026-05-14 — the production
// drag-out path lives in `attachmentDragOut.ts` via tauri-plugin-drag.
