/**
 * Self-save tracker: prevents file watcher from triggering "external change" dialogs
 * when the change was actually made by this app instance or by sync.
 *
 * Uses time-window suppression: any watcher event for a file within SUPPRESS_WINDOW_MS
 * of a self-save is suppressed. This is more robust than event counting because
 * the number of watcher events per file operation varies by platform and NAS config.
 */

const DEV = import.meta.env.DEV;
const log = DEV ? console.log.bind(console) : () => {};

/** Time window (ms) after a self-save during which watcher events are suppressed.
 *  3 seconds covers: atomic rename, NAS metadata update, Synology Drive sync events. */
const SUPPRESS_WINDOW_MS = 3_000;

/** Maximum age of a tracker entry before cleanup (memory leak prevention). */
const MAX_ENTRY_AGE_MS = 60_000;

/** Map of normalized file path → timestamp of the most recent self-save. */
const selfSaveTimes = new Map<string, number>();

function normalize(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

/**
 * Mark a file as just saved by this app instance.
 * Call this immediately after successfully writing a file.
 */
export function markAsSelfSaved(filePath: string): void {
  const normalized = normalize(filePath);
  selfSaveTimes.set(normalized, Date.now());

  if (selfSaveTimes.size > 100) {
    cleanupStaleEntries();
  }
}

/**
 * Check if a watcher event for this file should be suppressed
 * (i.e., the file was self-saved within the suppression window).
 */
function isSelfSaved(filePath: string): boolean {
  const normalized = normalize(filePath);
  const saveTime = selfSaveTimes.get(normalized);
  if (!saveTime) return false;

  const age = Date.now() - saveTime;
  if (age < SUPPRESS_WINDOW_MS) {
    return true;
  }

  // Outside window — clean up entry
  selfSaveTimes.delete(normalized);
  return false;
}

/**
 * Filter a list of paths to only include externally-changed files
 * (i.e., files that were NOT recently self-saved).
 */
export function filterExternalChanges(filePaths: string[]): string[] {
  log(`[SelfSaveTracker] Watcher event: ${filePaths.length} files`, filePaths.map(p => p.split(/[/\\]/).pop()));
  const result = filePaths.filter(path => !isSelfSaved(path));
  if (result.length < filePaths.length) {
    log(`[SelfSaveTracker] Filtered: ${filePaths.length} → ${result.length} (${filePaths.length - result.length} self-saves removed)`);
  }
  return result;
}

/**
 * Remove entries older than MAX_ENTRY_AGE_MS.
 */
function cleanupStaleEntries(): void {
  const now = Date.now();
  for (const [path, time] of selfSaveTimes.entries()) {
    if (now - time >= MAX_ENTRY_AGE_MS) {
      selfSaveTimes.delete(path);
    }
  }
}

/**
 * Clear all tracked self-saves (useful for testing or vault switch).
 */
export function clearSelfSaveTracker(): void {
  selfSaveTimes.clear();
}

// ============================================================
// Sync-active flag: suppresses file watcher hover refresh during sync
// ============================================================
let _syncActive = false;
export function setSyncActive(active: boolean): void { _syncActive = active; }
export function isSyncActive(): boolean { return _syncActive; }
