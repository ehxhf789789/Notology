/**
 * PART 7 (HanBin 2026-05-14) — listener for backend `migration:progress`
 * events. Mounts once at app startup; updates the migrationStore so the
 * MigrationModal sees live { completed, total } numbers during the run.
 */

import { useEffect } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { migrationActions } from '../stores/migrationStore';

interface MigrationProgressPayload {
  completed: number;
  total: number;
}

export function useMigrationProgress(): void {
  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    let cancelled = false;
    void (async () => {
      try {
        const fn = await listen<MigrationProgressPayload>('migration:progress', (event) => {
          const { completed, total } = event.payload;
          migrationActions.reportProgress(completed, total);
        });
        if (cancelled) {
          fn();
        } else {
          unlisten = fn;
        }
      } catch (e) {
        console.warn('[migration] failed to subscribe to migration:progress:', e);
      }
    })();
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, []);
}
