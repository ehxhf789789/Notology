//! Tauri commands exposing the WindowDispatcher to the frontend.
//!
//! Only a narrow surface is exposed — event sources that the frontend
//! legitimately needs to trigger. Most lifecycle events (main close,
//! selector close, vault-selected) are fired by Tauri internals or Rust
//! listeners; we don't re-export those.

use super::{Event, WindowDispatcherState, WindowMode};

/// Subset of [`Event`] that the frontend may dispatch. Adding new
/// variants here is an intentional API decision — most events should
/// stay backend-internal.
#[derive(Debug, serde::Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum FrontendEventDto {
    /// User clicked "보관소 변경" (or equivalent). Triggers main hide
    /// + selector show + return_to capture, all serialized through
    /// the state machine.
    SwitchVaultRequested,
}

impl From<FrontendEventDto> for Event {
    fn from(dto: FrontendEventDto) -> Event {
        match dto {
            FrontendEventDto::SwitchVaultRequested => Event::SwitchVaultRequested,
        }
    }
}

#[tauri::command]
pub async fn dispatch_window_event(
    event: FrontendEventDto,
    dispatcher: tauri::State<'_, WindowDispatcherState>,
) -> Result<(), String> {
    let d = (*dispatcher.inner()).clone();
    d.dispatch(event.into()).await
}

/// Read-only snapshot of the current [`WindowMode`]. Frontend uses
/// this for diagnostic / debug overlays.
#[tauri::command]
pub async fn get_window_mode(
    dispatcher: tauri::State<'_, WindowDispatcherState>,
) -> Result<WindowModeDto, String> {
    let mode = dispatcher.current_mode().await;
    Ok(WindowModeDto::from(mode))
}

/// Serializable mirror of [`WindowMode`]. Keeps the public Tauri API
/// stable even if the internal enum gains variants.
#[derive(Debug, serde::Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum WindowModeDto {
    Splash,
    SelectorOnly { return_to: Option<String> },
    MainOnly { vault: String, hovers: Vec<String> },
    Exiting,
}

impl From<WindowMode> for WindowModeDto {
    fn from(m: WindowMode) -> Self {
        match m {
            WindowMode::Splash => WindowModeDto::Splash,
            WindowMode::SelectorOnly { return_to } => WindowModeDto::SelectorOnly { return_to },
            WindowMode::MainOnly { vault, hovers } => WindowModeDto::MainOnly { vault, hovers },
            WindowMode::Exiting => WindowModeDto::Exiting,
        }
    }
}
