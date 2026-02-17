/**
 * Self-save tracker: prevents file watcher from triggering "external change" dialogs
 * when the change was actually made by this app instance.
 *
 * Uses event-count matching instead of timestamps, making it network-speed agnostic.
 * Each save registers expectedEvents: 2 (atomic rename + potential NAS metadata update).
 * Watcher events decrement the counter. External changes have no pending counter.
 */

const DEV = import.meta.env.DEV;
const log = DEV ? console.log.bind(console) : () => {};
const warn = DEV ? console.warn.bind(console) : () => {};

interface PendingSelfSave {
  /** Number of watcher events still expected for this file.
   *  Starts at 2 per save (atomic rename + potential Synology mtime update).
   *  Decremented on each matching watcher event. Removed when it reaches 0. */
  expectedEvents: number;
  /** Timestamp when the save was registered. Used ONLY for fallback cleanup. */
  registeredAt: number;
}

const pendingSelfSaves = new Map<string, PendingSelfSave>();

// Safety net: remove stale entries that were never matched by watcher events.
// This is NOT the matching mechanism — just prevents memory leaks.
const FALLBACK_TIMEOUT_MS = 60_000;

function normalize(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

/**
 * Mark a file as just saved by this app instance.
 * Call this immediately after successfully writing a file.
 * Registers 2 expected watcher events (atomic rename + NAS sync metadata update).
 */
export function markAsSelfSaved(filePath: string): void {
  const normalized = normalize(filePath);
  const existing = pendingSelfSaves.get(normalized);
  if (existing) {
    existing.expectedEvents += 2;
    existing.registeredAt = Date.now();
  } else {
    pendingSelfSaves.set(normalized, {
      expectedEvents: 2,
      registeredAt: Date.now(),
    });
  }

  if (pendingSelfSaves.size > 50) {
    cleanupStalePendingSaves();
  }
}

/**
 * Consume a self-save event for a file. Returns true if this watcher event
 * corresponds to a pending self-save (and should be suppressed).
 * This is destructive — each call decrements the counter.
 */
function consumeSelfSave(filePath: string): boolean {
  const normalized = normalize(filePath);
  const entry = pendingSelfSaves.get(normalized);
  if (!entry) return false;

  entry.expectedEvents -= 1;
  const fileName = normalized.split('/').pop() || normalized;
  log(`[SelfSaveTracker] Consumed self-save event: "${fileName}" (${entry.expectedEvents} remaining)`);

  if (entry.expectedEvents <= 0) {
    pendingSelfSaves.delete(normalized);
  }
  return true;
}

/**
 * Filter a list of paths to only include externally-changed files
 * (i.e., files that were NOT recently self-saved).
 */
export function filterExternalChanges(filePaths: string[]): string[] {
  // Clean up stale entries before matching to prevent over-accumulated counters
  // from rapid saves from suppressing genuine external changes.
  cleanupStalePendingSaves();
  log(`[SelfSaveTracker] Watcher event: ${filePaths.length} files`, filePaths.map(p => p.split(/[/\\]/).pop()));
  const result = filePaths.filter(path => !consumeSelfSave(path));
  if (result.length < filePaths.length) {
    log(`[SelfSaveTracker] Filtered: ${filePaths.length} → ${result.length} (${filePaths.length - result.length} self-saves removed)`);
  }
  return result;
}

/**
 * Remove entries older than FALLBACK_TIMEOUT_MS.
 * Safety net only — not part of the matching logic.
 */
function cleanupStalePendingSaves(): void {
  const now = Date.now();
  for (const [path, entry] of pendingSelfSaves.entries()) {
    if (now - entry.registeredAt >= FALLBACK_TIMEOUT_MS) {
      warn(`[SelfSaveTracker] Removing stale entry: "${path}" (${entry.expectedEvents} unclaimed events)`);
      pendingSelfSaves.delete(path);
    }
  }
}

/**
 * Clear all tracked self-saves (useful for testing or vault switch).
 */
export function clearSelfSaveTracker(): void {
  pendingSelfSaves.clear();
}
