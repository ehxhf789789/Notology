// Allow unused code for future features
#![allow(dead_code)]

pub mod core;
pub mod features;
pub mod search;
pub mod vault_lock;
mod frontmatter;
mod memo;

#[cfg(test)]
mod lib_test;

#[cfg(test)]
mod search_latency_test;

#[cfg(test)]
mod attachment_edge_cases_test;

#[cfg(test)]
mod wikilink_rename_test;

#[cfg(test)]
mod massive_rename_test;

#[cfg(test)]
mod massive_search_test;

#[cfg(test)]
mod wikilink_update_massive_test;

#[cfg(test)]
mod html_span_wikilink_test;

#[cfg(test)]
mod canvas_functionality_test;

#[cfg(test)]
mod attachment_cleanup_test;

#[cfg(test)]
mod memo_bottleneck_test;

#[cfg(test)]
mod canvas_memo_test;

#[cfg(test)]
mod indent_integration_test;

#[cfg(test)]
mod attachment_wikilink_sync_test;

#[cfg(test)]
mod synology_safety_test;

use std::sync::{Arc, Mutex};
use std::sync::atomic::AtomicBool;

use search::SearchIndex;
use search::watcher::VaultWatcher;
use memo::MemoIndex;

/// State for cancellable bulk tag operations
pub struct BulkOperationState {
    pub cancel_requested: AtomicBool,
}

pub(crate) struct SearchState {
    index: Option<Arc<SearchIndex>>,
    _watcher: Option<VaultWatcher>,
    memo_index: Option<Arc<MemoIndex>>,
    init_in_progress: bool,
}

// Re-export frontmatter module for features that need it
use frontmatter::FrontmatterParser;

// Frontmatter commands (kept here as they use the private frontmatter module)
#[tauri::command]
fn parse_frontmatter(content: String) -> Result<serde_json::Value, String> {
    let (frontmatter, body) = FrontmatterParser::parse(&content)?;
    Ok(serde_json::json!({
        "frontmatter": frontmatter,
        "body": body
    }))
}

#[tauri::command]
fn validate_frontmatter(frontmatter_json: String) -> Result<Vec<frontmatter::types::ValidationError>, String> {
    let fm: frontmatter::types::Frontmatter = serde_json::from_str(&frontmatter_json)
        .map_err(|e| format!("Invalid frontmatter JSON: {}", e))?;
    FrontmatterParser::validate(&fm)
}

#[tauri::command]
fn frontmatter_to_yaml(frontmatter_json: String) -> Result<String, String> {
    let fm: frontmatter::types::Frontmatter = serde_json::from_str(&frontmatter_json)
        .map_err(|e| format!("Invalid frontmatter JSON: {}", e))?;
    FrontmatterParser::to_yaml(&fm)
}

#[tauri::command]
fn yaml_to_frontmatter(yaml_str: String) -> Result<frontmatter::types::Frontmatter, String> {
    FrontmatterParser::parse_yaml(&yaml_str)
}

#[tauri::command]
fn generate_suggestions(
    frontmatter_json: String,
    all_notes_json: String,
) -> Result<Vec<frontmatter::suggestions::Suggestion>, String> {
    let fm: frontmatter::types::Frontmatter = serde_json::from_str(&frontmatter_json)
        .map_err(|e| format!("Invalid frontmatter JSON: {}", e))?;
    let all_notes: Vec<frontmatter::types::Frontmatter> = serde_json::from_str(&all_notes_json)
        .map_err(|e| format!("Invalid all_notes JSON: {}", e))?;
    let suggestions = frontmatter::suggestions::SuggestionEngine::generate_suggestions(&fm, &all_notes);
    Ok(suggestions)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "windows")]
    features::system::apply_gpu_config();

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            use tauri::Manager;
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
                let _ = window.unminimize();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(Mutex::new(SearchState {
            index: None,
            _watcher: None,
            memo_index: None,
            init_in_progress: false,
        }))
        .manage(BulkOperationState {
            cancel_requested: AtomicBool::new(false),
        })
        .manage(features::sync::TauriSyncState::new())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // Open VaultSelector window on startup.
            // Main window stays hidden until a vault is selected.
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(300)).await;

                let app_clone = app_handle.clone();
                if let Err(e) = features::sync::sync_open_vault_selector(app_handle).await {
                    log::warn!("[setup] Failed to open vault selector: {}", e);
                    if let Some(main) = tauri::Manager::get_webview_window(&app_clone, "main") {
                        let _ = main.show();
                    }
                }
            });

            // Listen for vault-selected event → show main window
            {
                use tauri::Listener;
                let app_handle2 = app.handle().clone();
                app.handle().listen_any("vault-selected", move |event| {
                    log::info!("[setup] vault-selected event received");
                    if let Some(main) = tauri::Manager::get_webview_window(&app_handle2, "main") {
                        // Set proper title before showing
                        let _ = main.set_title("Notology");
                        let _ = main.show();
                        let _ = main.set_focus();
                    }
                });
            }

            // Ensure main window stays hidden until vault is selected
            if let Some(main) = tauri::Manager::get_webview_window(app, "main") {
                let _ = main.hide();
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Frontmatter commands (local to lib.rs)
            parse_frontmatter,
            validate_frontmatter,
            frontmatter_to_yaml,
            yaml_to_frontmatter,
            // Note / file commands
            features::note::read_directory,
            features::note::read_file,
            features::note::read_text_file,
            features::note::write_file,
            features::note::create_note,
            features::note::create_folder,
            features::note::ensure_directory,
            features::note::list_files_in_directory,
            features::note::move_file,
            features::note::move_note,
            features::note::check_file_exists,
            features::note::delete_file,
            features::note::delete_folder,
            features::note::import_file,
            features::note::import_attachment,
            features::note::create_note_with_template,
            features::note::delete_note,
            features::note::update_note_frontmatter,
            features::note::touch_note_modified,
            features::note::open_in_default_app,
            features::note::reveal_in_explorer,
            features::note::read_binary_file,
            // Wikilink commands
            features::wikilink::rename_file_with_links,
            features::wikilink::search_backlinks,
            // Attachment commands
            features::attachment::read_attachment_folder,
            features::attachment::search_attachments,
            features::attachment::delete_multiple_files,
            features::attachment::delete_attachments_with_links,
            features::attachment::check_attachment_references,
            // Tag commands
            features::tags::bulk_delete_tag,
            features::tags::bulk_rename_tag,
            features::tags::bulk_add_tags,
            features::tags::cancel_bulk_operation,
            // Preview commands
            features::preview::check_preview_engine,
            features::preview::convert_to_preview_pdf,
            features::preview::cleanup_preview_cache,
            features::preview::render_hwp_to_svg,
            // Note lock commands
            features::note_lock::acquire_note_lock,
            features::note_lock::release_note_lock,
            features::note_lock::update_note_lock_heartbeat,
            features::note_lock::check_note_lock,
            // Cache commands
            features::cache::get_files_mtime,
            features::cache::get_file_mtime,
            features::cache::read_meta_cache,
            features::cache::write_meta_cache,
            features::cache::read_frontmatters_batch,
            // Comment commands
            features::comments::read_comments,
            features::comments::write_comments,
            features::comments::index_note_memos,
            features::comments::collect_calendar_memos,
            // System commands
            features::system::fetch_url_metadata,
            features::system::open_url_in_browser,
            features::system::detect_nas_platform,
            features::system::cleanup_old_backups,
            features::system::set_window_icon,
            features::system::create_hover_window,
            features::system::get_gpu_config,
            features::system::set_gpu_config,
            features::system::toggle_devtools,
            // Search commands
            features::search_commands::init_search_index,
            features::search_commands::reset_search_state,
            features::search_commands::clear_search_index,
            features::search_commands::full_text_search,
            features::search_commands::query_notes,
            features::search_commands::get_relationships,
            features::search_commands::get_graph_data,
            features::search_commands::reindex_vault,
            features::search_commands::get_all_used_tags,
            features::search_commands::get_suggestion_terms,
            features::search_commands::index_note,
            features::search_commands::remove_note_from_index,
            // Vault lock commands
            vault_lock::check_vault_lock,
            vault_lock::acquire_lock,
            vault_lock::release_lock,
            vault_lock::get_machine_info,
            // Sync commands (WebDAV)
            features::sync::sync_connect,
            features::sync::sync_disconnect,
            features::sync::sync_get_status,
            features::sync::sync_get_config,
            features::sync::sync_now,
            features::sync::sync_resolve_conflict,
            features::sync::sync_init,
            features::sync::sync_on_file_saved,
            features::sync::sync_start_monitor,
            features::sync::sync_browse_folder,
            features::sync::sync_check_vault,
            features::sync::sync_load_connections,
            features::sync::sync_register_connection,
            features::sync::sync_remove_connection,
            features::sync::sync_create_vault,
            features::sync::sync_open_vault,
            features::sync::sync_initial_download,
            features::sync::sync_set_last_active,
            features::sync::sync_flush_on_exit,
            features::sync::sync_on_foreground,
            features::sync::sync_open_vault_selector,
            features::sync::sync_close_vault_selector,
            features::sync::sync_check_port_change,
            features::sync::sync_migrate_port,
            features::sync::sync_remove_vault,
            features::sync::sync_update_vault_name,
            features::sync::sync_rename_vault,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
