/**
 * Stage 4.6.2 (HanBin 2026-05-14) — Faststart bulk migration UI state.
 *
 * Mirror of `migration/stores/migrationStore.ts` but for the faststart
 * conversion flow. Backend `src-tauri/src/features/sync_v2/faststart_migration.rs`
 * emits `faststart_migration:progress` events with `{ done, total }`.
 *
 * Lifecycle:
 *   1. `openVault` calls `faststartMigrationCommands.check()` → if
 *      `candidates > 0 && !declined`, store enters `prompt` phase.
 *   2. User clicks "지금 변환" → `runConversion()` → `running` phase,
 *      progress events update `done` / `total`.
 *   3. Backend resolves → `done` phase with `converted` / `skipped` /
 *      `failed` counts.
 *   4. User clicks Close OR another vault opens → store resets to `idle`.
 *
 * "지금 변환 / 나중에 / 다시 묻지 않기" — last option persists per-vault
 * decline in localStorage so the prompt doesn't re-appear.
 */

import { create } from 'zustand';
import {
  faststartMigrationCommands,
  type FaststartReport,
  type FaststartState,
} from '../../../core/services/tauriCommands';

export type FaststartPhase = 'idle' | 'prompt' | 'running' | 'done' | 'error';

interface FaststartStoreState {
  phase: FaststartPhase;
  vaultPath: string | null;
  preReport: FaststartReport | null;
  /** Live progress while phase === 'running'. */
  done: number;
  total: number;
  finalState: FaststartState | null;
  errorMessage: string | null;

  prompt: (vaultPath: string, report: FaststartReport) => void;
  runConversion: () => Promise<void>;
  skip: (rememberDecline?: boolean) => void;
  reportProgress: (done: number, total: number) => void;
  reset: () => void;
}

const DECLINE_KEY_PREFIX = 'notology.faststart_migration.declined:';

function vaultDeclineKey(vaultPath: string): string {
  return `${DECLINE_KEY_PREFIX}${vaultPath.replace(/\\/g, '/').toLowerCase()}`;
}

export function wasFaststartMigrationDeclined(vaultPath: string): boolean {
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
    // localStorage unavailable — silent.
  }
}

export const useFaststartMigrationStore = create<FaststartStoreState>(
  (set, get) => ({
    phase: 'idle',
    vaultPath: null,
    preReport: null,
    done: 0,
    total: 0,
    finalState: null,
    errorMessage: null,

    prompt(vaultPath, report) {
      set({
        phase: 'prompt',
        vaultPath,
        preReport: report,
        done: 0,
        total: report.candidates ?? 0,
        finalState: null,
        errorMessage: null,
      });
    },

    async runConversion() {
      const { vaultPath } = get();
      if (!vaultPath) return;
      set({ phase: 'running', done: 0, errorMessage: null });
      try {
        const result = await faststartMigrationCommands.run(vaultPath);
        set({
          phase: 'done',
          finalState: result,
          done: result.converted,
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
        void faststartMigrationCommands.decline(vaultPath).catch(() => {});
      }
      set({ phase: 'idle', vaultPath: null, preReport: null });
    },

    reportProgress(done, total) {
      if (get().phase !== 'running') return;
      set({ done, total: total || get().total });
    },

    reset() {
      set({
        phase: 'idle',
        vaultPath: null,
        preReport: null,
        done: 0,
        total: 0,
        finalState: null,
        errorMessage: null,
      });
    },
  })
);

export const faststartMigrationActions = {
  prompt: (vault: string, report: FaststartReport) =>
    useFaststartMigrationStore.getState().prompt(vault, report),
  runConversion: () => useFaststartMigrationStore.getState().runConversion(),
  skip: (remember?: boolean) =>
    useFaststartMigrationStore.getState().skip(remember),
  reportProgress: (d: number, t: number) =>
    useFaststartMigrationStore.getState().reportProgress(d, t),
  reset: () => useFaststartMigrationStore.getState().reset(),
};
