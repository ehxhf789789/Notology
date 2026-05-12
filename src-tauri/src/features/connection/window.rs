//! Vault selector window management (extracted from v1 sync).
//! Opens a separate Tauri window for vault selection.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::Manager;

/// Tracks the entry context of the vault-selector window so the
/// `CloseRequested` handler in lib.rs can decide what closing means:
///
/// - `return_to = None` → selector was the startup entry (no usable
///   vault). User closing it must terminate the app.
/// - `return_to = Some(vault)` → user invoked "보관소 변경" from main.
///   Closing it cancels the switch and restores main on that vault.
/// - `closing_programmatically = true` → we (Rust) are about to call
///   `selector.close()` as part of a vault-selected transition. The
///   close event handler must treat this as a no-op so it doesn't
///   trigger app exit before main has shown.
pub struct SelectorContext {
    pub return_to: Mutex<Option<String>>,
    pub closing_programmatically: AtomicBool,
}

impl SelectorContext {
    pub fn new() -> Self {
        Self {
            return_to: Mutex::new(None),
            closing_programmatically: AtomicBool::new(false),
        }
    }

    pub fn set_return_to(&self, v: Option<String>) {
        *self.return_to.lock().unwrap_or_else(|e| e.into_inner()) = v;
    }

    pub fn get_return_to(&self) -> Option<String> {
        self.return_to.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// Atomically mark the next close as programmatic and return the
    /// previous value. Used by close-handler to distinguish self-close
    /// from user-close.
    pub fn take_programmatic_flag(&self) -> bool {
        self.closing_programmatically.swap(false, Ordering::SeqCst)
    }

    pub fn mark_programmatic(&self) {
        self.closing_programmatically.store(true, Ordering::SeqCst);
    }
}

/// Read user's saved theme from settings.json (returns "light" or "dark").
fn read_saved_theme(app: &tauri::AppHandle) -> String {
    if let Ok(config_dir) = app.path().app_config_dir() {
        let p = config_dir.join("settings.json");
        if let Ok(content) = std::fs::read_to_string(&p) {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
                if let Some(t) = json.get("last_theme").and_then(|v| v.as_str()) {
                    if t == "light" || t == "dark" {
                        return t.to_string();
                    }
                }
                if let Some(t) = json.get("theme").and_then(|v| v.as_str()) {
                    if t == "light" || t == "dark" {
                        return t.to_string();
                    }
                }
            }
        }
    }
    "dark".to_string() // fallback
}

/// Open vault selector window (separate window, theme-aware background).
///
/// Records the entry context so the close handler knows whether the
/// user's close means "cancel the switch" or "exit the app". If a sync
/// engine is currently running, we assume the user came from a working
/// vault session — closing the selector returns them there. Otherwise
/// this is a startup-time entry and close means exit.
#[tauri::command]
pub async fn open_vault_selector(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::webview::{WebviewWindowBuilder, Color};
    use tauri::WebviewUrl;

    // Record return_to before showing the window so the close handler
    // never sees a stale value if the user clicks X fast.
    let return_to: Option<String> = if let Some(engine_state) =
        app.try_state::<crate::features::sync_v2::commands::SyncEngineState>()
    {
        if let Some(engine) = engine_state.get() {
            engine.active_remote_base().await
        } else {
            None
        }
    } else {
        None
    };
    log::info!("[open_vault_selector] return_to = {:?}", return_to);

    if let Some(ctx) = app.try_state::<SelectorContext>() {
        ctx.set_return_to(return_to.clone());
        // Clear stale programmatic-close flag from a previous lifecycle.
        let _ = ctx.take_programmatic_flag();
    }

    // Migration shim: keep dispatcher mode in sync until Stage B fully
    // routes SwitchVaultRequested through dispatch().
    if let Some(dispatcher) = app
        .try_state::<crate::features::window_lifecycle::WindowDispatcherState>()
    {
        let d = (*dispatcher.inner()).clone();
        let rt = return_to.clone();
        tauri::async_runtime::spawn(async move {
            d.set_mode(crate::features::window_lifecycle::WindowMode::SelectorOnly {
                return_to: rt,
            })
            .await;
        });
    }

    // Close existing vault-selector window if any
    if let Some(existing) = app.get_webview_window("vault-selector") {
        // Mark programmatic so the leftover close doesn't trigger app exit.
        if let Some(ctx) = app.try_state::<SelectorContext>() {
            ctx.mark_programmatic();
        }
        let _ = existing.close();
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    }

    let theme = read_saved_theme(&app);
    let bg = if theme == "light" {
        Color(245, 245, 245, 255) // matches CSS --bg-1 in light mode
    } else {
        Color(30, 30, 30, 255)
    };

    let url = format!("/?vault-selector=true&theme={}", theme);

    WebviewWindowBuilder::new(&app, "vault-selector", WebviewUrl::App(url.into()))
        .title("Notology — 보관소 선택")
        .inner_size(520.0, 700.0)
        .center()
        .decorations(false)
        .resizable(false)
        .focused(true)
        .visible(true)
        .background_color(bg)
        .build()
        .map_err(|e| e.to_string())?;

    Ok(())
}

/// Close the vault selector window.
#[tauri::command]
pub async fn close_vault_selector(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("vault-selector") {
        window.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}
