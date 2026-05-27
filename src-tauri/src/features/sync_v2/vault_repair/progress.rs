//! vault_repair::progress — global progress + cancellation state.
//!
//! Single static instance keyed by AtomicBool gates against concurrent
//! apply runs (the user closing the modal and re-triggering from
//! Settings would otherwise launch a second apply on the same vault).
//! A small Mutex-protected snapshot is exposed via `vault_repair_status`
//! so the UI can poll without holding the lock during heavy I/O.
//!
//! 2026-05-24 (HanBin). Layered atop the existing apply/scan modules
//! without changing their public surface — they just need to consult
//! `should_cancel()` at safe checkpoints and call `update_progress()`
//! after each pattern.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

/// Coarse stage labels emitted via Tauri events + included in status.
/// Keep strings stable; the UI maps them to localized text.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RepairStage {
    Idle,
    Scanning,
    BackingUp,
    P1LegacyAtt,
    P2P3Sketch,
    P4Wikilink,
    P6SplitSharedRef,
    P7OrphanSweep,
    P8PurgeBogusMd,
    Verifying,
    Completed,
    Cancelled,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepairProgress {
    pub stage: RepairStage,
    /// Items processed in the CURRENT stage (resets at each stage change).
    pub current: usize,
    /// Total items expected in the current stage.
    pub total: usize,
    /// Free-form line shown under the spinner.
    pub message: String,
    /// True iff `request_cancel()` has been called and apply hasn't
    /// terminated yet. UI uses this to render the Cancel button as
    /// "취소 중..." rather than re-arming it.
    pub cancel_requested: bool,
    /// Wall-clock ms since apply started. 0 when idle.
    pub elapsed_ms: u64,
}

impl Default for RepairProgress {
    fn default() -> Self {
        Self {
            stage: RepairStage::Idle,
            current: 0,
            total: 0,
            message: String::new(),
            cancel_requested: false,
            elapsed_ms: 0,
        }
    }
}

/// Module-level state. The AtomicBool gates double-apply; the Mutex
/// guards the progress snapshot. Held briefly only during update —
/// never during I/O.
static IN_PROGRESS: AtomicBool = AtomicBool::new(false);
static CANCEL_REQUESTED: AtomicBool = AtomicBool::new(false);
static PROGRESS: Mutex<RepairProgress> = Mutex::new(RepairProgress {
    stage: RepairStage::Idle,
    current: 0,
    total: 0,
    message: String::new(),
    cancel_requested: false,
    elapsed_ms: 0,
});
static STARTED_AT_MS: Mutex<Option<std::time::Instant>> = Mutex::new(None);

/// Try to acquire the apply lock. Returns Err if another apply is
/// already running. Callers MUST call `release_apply_lock()` on exit
/// (typically via the RAII guard below).
pub fn try_acquire_apply_lock() -> Result<ApplyLockGuard, String> {
    if IN_PROGRESS.swap(true, Ordering::AcqRel) {
        return Err(
            "Another vault repair is already in progress. Wait for it to complete or cancel via the UI."
                .to_string(),
        );
    }
    CANCEL_REQUESTED.store(false, Ordering::Release);
    if let Ok(mut s) = STARTED_AT_MS.lock() {
        *s = Some(std::time::Instant::now());
    }
    set_progress(RepairStage::Scanning, 0, 0, "Starting...".to_string());
    Ok(ApplyLockGuard)
}

/// RAII guard — releases the in-progress flag on drop, regardless of
/// how the apply path exits (success, error, panic, cancellation).
pub struct ApplyLockGuard;

impl Drop for ApplyLockGuard {
    fn drop(&mut self) {
        IN_PROGRESS.store(false, Ordering::Release);
        if let Ok(mut s) = STARTED_AT_MS.lock() {
            *s = None;
        }
    }
}

pub fn is_in_progress() -> bool {
    IN_PROGRESS.load(Ordering::Acquire)
}

pub fn request_cancel() {
    CANCEL_REQUESTED.store(true, Ordering::Release);
    if let Ok(mut p) = PROGRESS.lock() {
        p.cancel_requested = true;
    }
}

pub fn should_cancel() -> bool {
    CANCEL_REQUESTED.load(Ordering::Acquire)
}

pub fn set_progress(stage: RepairStage, current: usize, total: usize, message: String) {
    if let Ok(mut p) = PROGRESS.lock() {
        p.stage = stage;
        p.current = current;
        p.total = total;
        p.message = message;
        p.cancel_requested = CANCEL_REQUESTED.load(Ordering::Acquire);
        if let Ok(s) = STARTED_AT_MS.lock() {
            if let Some(t) = *s {
                p.elapsed_ms = t.elapsed().as_millis() as u64;
            }
        }
    }
}

pub fn bump_current() {
    if let Ok(mut p) = PROGRESS.lock() {
        p.current = p.current.saturating_add(1);
        if let Ok(s) = STARTED_AT_MS.lock() {
            if let Some(t) = *s {
                p.elapsed_ms = t.elapsed().as_millis() as u64;
            }
        }
    }
}

pub fn snapshot() -> RepairProgress {
    PROGRESS
        .lock()
        .map(|p| p.clone())
        .unwrap_or_default()
}

/// Reset to Idle. Called by the Tauri command layer after apply
/// returns (success or error) so the next poll shows the final stage
/// for ~1 frame then transitions back to Idle.
pub fn reset_to_idle() {
    if let Ok(mut p) = PROGRESS.lock() {
        p.stage = RepairStage::Idle;
        p.current = 0;
        p.total = 0;
        p.message = String::new();
        p.cancel_requested = false;
        p.elapsed_ms = 0;
    }
    CANCEL_REQUESTED.store(false, Ordering::Release);
}
