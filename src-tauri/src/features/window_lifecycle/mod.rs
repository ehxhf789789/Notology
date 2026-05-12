//! Window lifecycle state machine.
//!
//! Notology runs three kinds of OS windows: a main editor, a vault
//! selector, and zero or more hover (preview) windows. Their lifecycles
//! were previously enforced by ad-hoc code scattered across Rust setup,
//! Tauri command handlers, and React effects — which produced bugs like
//! "main and selector both visible at once" and "closing main while
//! hover windows linger."
//!
//! This module is the single source of truth for window state. The
//! [`transition`] function is pure: given the current [`WindowMode`]
//! and an [`Event`], it returns the next mode plus an ordered list of
//! [`SideEffect`]s. The UI/Tauri layer's only job is to dispatch
//! events into `transition` and faithfully execute the resulting side
//! effects.
//!
//! See `docs/window_lifecycle_cases.md` for the 50-case verification
//! matrix this module is designed to satisfy.

pub mod state;
pub mod dispatcher;
pub mod commands;

pub use state::{transition, Event, SideEffect, WindowMode};
pub use dispatcher::{WindowDispatcher, WindowDispatcherState};
