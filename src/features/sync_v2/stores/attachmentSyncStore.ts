/**
 * Round 2 R5 v4 (HanBin 2026-05-23) — global attachment-sync indicator store.
 *
 * The previous implementation kept `syncingFiles` as React useState INSIDE
 * SketchEditor. That meant:
 *   - Closing the hover window unmounted the state → spinner disappeared
 *     even though the backend was still uploading.
 *   - Re-opening the hover window started from an empty set → no spinner
 *     even though pushes might still be in flight.
 *   - The 30 s safety-net `setTimeout` was scoped to the component, so
 *     closing the window before 30 s elapsed left no cleanup hook (not
 *     a leak — `clearTimeout` ran on unmount — but the timer never got
 *     a chance to actually fire and flush stuck spinners).
 *
 * Backend behaviour was always correct (the SQLite WAL dirty-queue +
 * push_worker run regardless of UI state — closing the window NEVER
 * pauses or drops a sync). This store fixes only the FRONTEND mirror,
 * making the indicator survive window-close so the user sees the same
 * status when they reopen.
 *
 * Lifecycle:
 *   - Initialised once per app process by `initAttachmentSyncSubscriptions`
 *     (called from App.tsx and HoverWindowApp.tsx alongside the existing
 *     `initAttachmentStoreSubscriptions`).
 *   - Listens for `sync-v2:report` (success → drain the set) and
 *     `attachment:deleted` (file gone → drop it from the set).
 *   - A 30 s safety-net timer runs at the store level (not per-component)
 *     so stuck entries always get flushed.
 *
 * Consumers:
 *   - SketchEditor uses `useAttachmentSyncStore(s => s.syncingFiles)` to
 *     render per-node spinners. Adding a new file node calls
 *     `attachmentSyncActions.markSyncing(path)`.
 *   - Any other UI that wants to show "X files syncing" can subscribe.
 */
import { create } from 'zustand';
import { listen } from '@tauri-apps/api/event';
import { syncV2Commands, type FailedOpDto } from '../syncV2Commands';

interface AttachmentSyncState {
  /** File paths currently flagged as "uploading". */
  syncingFiles: Set<string>;
  /**
   * Permanently failed sync operations (dropped after 5 retries). Surfaces
   * to the user via a notification banner; the user can retry or dismiss.
   * Populated by polling + sync-v2:report-side-effect.
   */
  failed: FailedOpDto[];
  /** Backing flag — true while initial hydrate from backend is in flight. */
  hydrating: boolean;
}

export const useAttachmentSyncStore = create<AttachmentSyncState>(() => ({
  syncingFiles: new Set(),
  failed: [],
  hydrating: false,
}));

export const attachmentSyncActions = {
  markSyncing(paths: string | string[]): void {
    const list = Array.isArray(paths) ? paths : [paths];
    if (list.length === 0) return;
    useAttachmentSyncStore.setState((s) => {
      const next = new Set(s.syncingFiles);
      list.forEach((p) => p && next.add(p));
      if (next.size === s.syncingFiles.size) return s;
      return { syncingFiles: next };
    });
  },

  markComplete(paths?: string[]): void {
    if (!paths) {
      useAttachmentSyncStore.setState((s) =>
        s.syncingFiles.size === 0 ? s : { syncingFiles: new Set() }
      );
      return;
    }
    useAttachmentSyncStore.setState((s) => {
      if (s.syncingFiles.size === 0) return s;
      const next = new Set(s.syncingFiles);
      let changed = false;
      paths.forEach((p) => {
        if (next.delete(p)) changed = true;
      });
      return changed ? { syncingFiles: next } : s;
    });
  },

  isSyncing(path: string): boolean {
    return useAttachmentSyncStore.getState().syncingFiles.has(path);
  },

  /**
   * Round 2 R5 v5 — query backend, reconcile local syncing/failed sets to
   * reflect actual queue state. Called on app start (hydrate) and every
   * POLL_INTERVAL_MS (live update).
   */
  async pollBackendState(): Promise<void> {
    let pending: Awaited<ReturnType<typeof syncV2Commands.listPending>> = [];
    let failed: FailedOpDto[] = [];
    try {
      pending = await syncV2Commands.listPending();
    } catch (err) {
      console.warn('[attachmentSyncStore] listPending failed:', err);
    }
    try {
      failed = await syncV2Commands.listFailed();
    } catch (err) {
      console.warn('[attachmentSyncStore] listFailed failed:', err);
    }

    // Build the set of paths the backend says are still pending.
    const pendingPaths = new Set<string>();
    for (const op of pending) {
      // For attachment ops the target_path is the .notology/attachments/refs
      // JSON path; for note ops it's the .md vault-relative path. The
      // spinner consumers (SketchEditor) compare against absolute paths in
      // node.file. We add BOTH the raw target_path and its basename so we
      // catch both code paths — a small false-positive is fine (extra
      // spinner shown briefly) vs the false-negative (no spinner) we are
      // protecting against.
      pendingPaths.add(op.targetPath);
      const basename = op.targetPath.split(/[/\\]/).pop();
      if (basename) pendingPaths.add(basename);
    }

    useAttachmentSyncStore.setState((s) => {
      // Drain any local syncingFiles paths that are no longer in backend
      // pending — they either uploaded successfully or were moved to failed.
      const nextSyncing = new Set<string>();
      let syncingChanged = s.syncingFiles.size !== 0;
      s.syncingFiles.forEach((p) => {
        const basename = p.split(/[/\\]/).pop() || '';
        if (pendingPaths.has(p) || pendingPaths.has(basename)) {
          nextSyncing.add(p);
        }
      });
      if (nextSyncing.size === s.syncingFiles.size && !syncingChanged) {
        syncingChanged = false;
      } else {
        syncingChanged = true;
      }

      // Add any backend-pending paths we didn't yet know about (e.g. queue
      // items from a previous session that the user never saw a spinner
      // for). This means re-opening the app DURING a pending upload still
      // shows the spinner.
      pendingPaths.forEach((p) => {
        if (!nextSyncing.has(p)) {
          nextSyncing.add(p);
          syncingChanged = true;
        }
      });

      const failedChanged =
        s.failed.length !== failed.length ||
        s.failed.some((f, i) => f.id !== failed[i]?.id);

      if (!syncingChanged && !failedChanged) return s;
      return {
        syncingFiles: syncingChanged ? nextSyncing : s.syncingFiles,
        failed: failedChanged ? failed : s.failed,
      };
    });
  },

  async dismissFailed(failedId: number): Promise<void> {
    try {
      await syncV2Commands.retryFailed(failedId);
    } catch (err) {
      console.warn('[attachmentSyncStore] retryFailed:', err);
    }
    await attachmentSyncActions.pollBackendState();
  },

  async retryAllFailed(): Promise<void> {
    try {
      await syncV2Commands.retryAllFailed();
    } catch (err) {
      console.warn('[attachmentSyncStore] retryAllFailed:', err);
    }
    await attachmentSyncActions.pollBackendState();
  },

  async clearAllFailed(): Promise<void> {
    try {
      await syncV2Commands.clearFailed();
    } catch (err) {
      console.warn('[attachmentSyncStore] clearFailed:', err);
    }
    await attachmentSyncActions.pollBackendState();
  },
};

let initialized = false;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let safetyTimer: ReturnType<typeof setTimeout> | null = null;

/** Poll cadence — fast enough for live spinner update, slow enough to not flood
 *  the backend. 3 s tested as a comfortable balance. */
const POLL_INTERVAL_MS = 3000;
/** Hard safety: if a spinner is set but the backend has never confirmed it
 *  via either polling or a report event for this long, drain it. Generous so
 *  large attachments on slow networks aren't cut off prematurely. */
const SAFETY_DRAIN_MS = 5 * 60_000;

/**
 * Set up the global sync-v2 listeners + hydrate + periodic poll. Idempotent.
 *
 * v5.1 (HanBin 2026-05-23) — every step wrapped in try/catch so a failure
 * in any single piece (Tauri command not registered, listener registration
 * error, zustand version-skew bug) can't blank-screen the whole hover/main
 * window. The init is best-effort: if anything goes wrong, we log and let
 * the app continue running without sync indicators (better than no UI).
 */
export function initAttachmentSyncSubscriptions(): () => void {
  if (initialized) return () => {};
  initialized = true;

  const cleanups: Array<() => void> = [];

  try {
    useAttachmentSyncStore.setState({ hydrating: true });
    void attachmentSyncActions
      .pollBackendState()
      .catch((err) => console.warn('[attachmentSyncStore] hydrate failed:', err))
      .finally(() => {
        try {
          useAttachmentSyncStore.setState({ hydrating: false });
        } catch {/* ignore */}
      });
  } catch (err) {
    console.warn('[attachmentSyncStore] hydrate scheduling failed:', err);
  }

  try {
    const p = listen('sync-v2:report', () => {
      void attachmentSyncActions.pollBackendState();
    });
    cleanups.push(() => { p.then((fn) => fn()).catch(() => {}); });
  } catch (err) {
    console.warn('[attachmentSyncStore] sync-v2:report listen failed:', err);
  }

  try {
    const p = listen('attachment:deleted', () => {
      void attachmentSyncActions.pollBackendState();
    });
    cleanups.push(() => { p.then((fn) => fn()).catch(() => {}); });
  } catch (err) {
    console.warn('[attachmentSyncStore] attachment:deleted listen failed:', err);
  }

  try {
    pollTimer = setInterval(() => {
      void attachmentSyncActions.pollBackendState();
    }, POLL_INTERVAL_MS);
  } catch (err) {
    console.warn('[attachmentSyncStore] poll interval setup failed:', err);
  }

  try {
    const unsub = useAttachmentSyncStore.subscribe((s) => {
      if (s.syncingFiles.size > 0) {
        if (!safetyTimer) {
          safetyTimer = setTimeout(() => {
            safetyTimer = null;
            attachmentSyncActions.markComplete();
          }, SAFETY_DRAIN_MS);
        }
      } else if (safetyTimer) {
        clearTimeout(safetyTimer);
        safetyTimer = null;
      }
    });
    cleanups.push(unsub);
  } catch (err) {
    console.warn('[attachmentSyncStore] subscribe failed:', err);
  }

  return () => {
    cleanups.forEach((fn) => { try { fn(); } catch {/* ignore */} });
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (safetyTimer) { clearTimeout(safetyTimer); safetyTimer = null; }
    initialized = false;
  };
}
