//! Schedule — Dedicated calendar events stored in `.notology/schedules.json`.
//! These are independent of note frontmatter and sync via NAS like any vault file.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScheduleEvent {
    pub id: String,
    pub title: String,
    pub date: String,                 // YYYY-MM-DD
    #[serde(skip_serializing_if = "Option::is_none")]
    pub time: Option<String>,         // HH:mm
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_time: Option<String>,     // HH:mm
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repeat: Option<String>,       // daily | weekly | monthly | yearly
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reminder: Option<u32>,        // minutes before event
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub linked_note: Option<String>,  // vault-relative path
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memo: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct ScheduleStore {
    events: Vec<ScheduleEvent>,
}

fn schedules_path(vault_path: &str) -> PathBuf {
    PathBuf::from(vault_path).join(".notology").join("schedules.json")
}

fn read_store(vault_path: &str) -> Result<ScheduleStore, String> {
    let path = schedules_path(vault_path);
    if !path.exists() {
        return Ok(ScheduleStore::default());
    }
    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read schedules: {}", e))?;
    serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse schedules: {}", e))
}

fn write_store(vault_path: &str, store: &ScheduleStore) -> Result<(), String> {
    let path = schedules_path(vault_path);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create .notology dir: {}", e))?;
    }
    let json = serde_json::to_string_pretty(store)
        .map_err(|e| format!("Failed to serialize schedules: {}", e))?;
    std::fs::write(&path, json)
        .map_err(|e| format!("Failed to write schedules: {}", e))
}

/// List schedule events within a date range (inclusive).
#[tauri::command]
pub fn schedule_list(
    vault_path: String,
    start_date: String,
    end_date: String,
) -> Result<Vec<ScheduleEvent>, String> {
    let store = read_store(&vault_path)?;
    let filtered: Vec<ScheduleEvent> = store.events.into_iter().filter(|e| {
        e.date >= start_date && e.date <= end_date
    }).collect();
    Ok(filtered)
}

/// Create a new schedule event.
#[tauri::command]
pub fn schedule_create(
    vault_path: String,
    event: ScheduleEvent,
) -> Result<ScheduleEvent, String> {
    let mut store = read_store(&vault_path)?;
    store.events.push(event.clone());
    write_store(&vault_path, &store)?;
    Ok(event)
}

/// Update an existing schedule event by ID.
#[tauri::command]
pub fn schedule_update(
    vault_path: String,
    event: ScheduleEvent,
) -> Result<ScheduleEvent, String> {
    let mut store = read_store(&vault_path)?;
    if let Some(existing) = store.events.iter_mut().find(|e| e.id == event.id) {
        *existing = event.clone();
    } else {
        return Err(format!("Event not found: {}", event.id));
    }
    write_store(&vault_path, &store)?;
    Ok(event)
}

/// Delete a schedule event by ID.
#[tauri::command]
pub fn schedule_delete(
    vault_path: String,
    event_id: String,
) -> Result<(), String> {
    let mut store = read_store(&vault_path)?;
    let before = store.events.len();
    store.events.retain(|e| e.id != event_id);
    if store.events.len() == before {
        return Err(format!("Event not found: {}", event_id));
    }
    write_store(&vault_path, &store)?;
    Ok(())
}

/// Get a single schedule event by ID.
#[tauri::command]
pub fn schedule_get(
    vault_path: String,
    event_id: String,
) -> Result<ScheduleEvent, String> {
    let store = read_store(&vault_path)?;
    store.events.into_iter()
        .find(|e| e.id == event_id)
        .ok_or_else(|| format!("Event not found: {}", event_id))
}
