/**
 * PART 7 (HanBin 2026-05-14) — Vault migration progress + confirmation state.
 *
 * The backend (`src-tauri/src/core/migration.rs`) already emits
 * `migration:progress` events with `{ completed, total }` payloads. This
 * store consumes those events + drives the MigrationModal's UI state.
 *
 * Lifecycle:
 *   1. `openVault` calls `libraryCommands.checkMigrationNeeded()` → if
 *      `needs_migration && total_notes > 0`, store enters `prompt` phase.
 *   2. User clicks Upgrade → `runMigration()` is invoked, store enters
 *      `running` phase, progress events update `completed`.
 *   3. Backend resolves → `done` phase with summary
 *      (migrated / failed counts).
 *   4. User clicks Close or another vault opens → store resets to `idle`.
 *
 * Skip vs. Don't ask again: both close the modal without running migration.
 * "Don't ask again" persists the vault path in localStorage so the prompt
 * doesn't re-appear on the next open. (Backend `decline_vault_migration`
 * also exists as a per-vault flag but the UX-level skip is per-launch.)
 */

import { create } from 'zustand';
import { libraryCommands, type MigrationState, type PreMigrationReport } from '../../../core/services/tauriCommands';

export type MigrationPhase = 'idle' | 'prompt' | 'running' | 'done' | 'error';

interface MigrationStoreState {
  phase: MigrationPhase;
  vaultPath: string | null;
  /** From the pre-check; tells the user how much work the migration entails. */
  preReport: PreMigrationReport | null;
  /** Live progress while phase === 'running'. */
  completed: number;
  total: number;
  /** Final report from runMigration() — populated in `done`/`error` phases. */
  finalState: MigrationState | null;
  errorMessage: string | null;

  // ── Actions ────────────────────────────────────────────────────────────────
  prompt: (vaultPath: string, report: PreMigrationReport) => void;
  /** User accepted; kicks off the backend migration. */
  runUpgrade: () => Promise<void>;
  /** User clicked Skip — close modal, optionally persist "don't ask again". */
  skip: (rememberDecline?: boolean) => void;
  /** Called by useMigrationProgress on each `migration:progress` event. */
  reportProgress: (completed: number, total: number) => void;
  /** Reset to idle (vault closed / modal dismissed). */
  reset: () => void;
}

const DECLINE_KEY_PREFIX = 'notology.migration.declined:';

function vaultDeclineKey(vaultPath: string): string {
  return `${DECLINE_KEY_PREFIX}${vaultPath.replace(/\\/g, '/').toLowerCase()}`;
}

/** Was migration previously declined for this vault path? */
export function wasMigrationDeclined(vaultPath: string): boolean {
  try {
    return localStorage.getItem(vaultDeclineKey(vaultPath)) === 'true';
  } catch {
    return false;
  }
}

function persistDecline(vaultPath: string) {
  try {
    localStorage.setItem(vaultDeclineKey(vaultPath), 'true');
  } catch {
    // localStorage unavailable (private mode etc.) — silent.
  }
}

export const useMigrationStore = create<MigrationStoreState>((set, get) => ({
  phase: 'idle',
  vaultPath: null,
  preReport: null,
  completed: 0,
  total: 0,
  finalState: null,
  errorMessage: null,

  prompt(vaultPath, report) {
    set({
      phase: 'prompt',
      vaultPath,
      preReport: report,
      completed: 0,
      total: report.total_notes ?? 0,
      finalState: null,
      errorMessage: null,
    });
  },

  async runUpgrade() {
    const { vaultPath } = get();
    if (!vaultPath) return;
    set({ phase: 'running', completed: 0, errorMessage: null });
    try {
      const result = await libraryCommands.runMigration(vaultPath);
      set({
        phase: 'done',
        finalState: result,
        completed: result.migrated_notes ?? get().completed,
        total: result.total_notes ?? get().total,
      });
    } catch (e) {
      set({
        phase: 'error',
        errorMessage: e instanceof Error ? e.message : String(e),
      });
    }
  },

  skip(rememberDecline = false) {
    const { vaultPath } = get();
    if (rememberDecline && vaultPath) {
      persistDecline(vaultPath);
      // Best-effort backend flag — non-fatal if it fails.
      void libraryCommands.declineMigration(vaultPath).catch(() => {});
    }
    set({ phase: 'idle', vaultPath: null, preReport: null });
  },

  reportProgress(completed, total) {
    if (get().phase !== 'running') return;
    set({ completed, total: total || get().total });
  },

  reset() {
    set({
      phase: 'idle',
      vaultPath: null,
      preReport: null,
      completed: 0,
      total: 0,
      finalState: null,
      errorMessage: null,
    });
  },
}));

export const migrationActions = {
  prompt: (vault: string, report: PreMigrationReport) =>
    useMigrationStore.getState().prompt(vault, report),
  runUpgrade: () => useMigrationStore.getState().runUpgrade(),
  skip: (remember?: boolean) => useMigrationStore.getState().skip(remember),
  reportProgress: (c: number, t: number) =>
    useMigrationStore.getState().reportProgress(c, t),
  reset: () => useMigrationStore.getState().reset(),
};
