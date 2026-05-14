/**
 * Stage 4.6.2 (HanBin 2026-05-14) — listener for backend
 * `faststart_migration:progress` events. Mounts once at app startup;
 * updates the faststartMigrationStore so the FaststartMigrationModal
 * sees live { done, total } numbers during the run.
 */

import { useEffect } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { faststartMigrationActions } from '../stores/faststartMigrationStore';

interface FaststartProgressPayload {
  done: number;
  total: number;
}

export function useFaststartMigrationProgress(): void {
  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    let cancelled = false;
    void (async () => {
      try {
        const fn = await listen<FaststartProgressPayload>(
          'faststart_migration:progress',
          (event) => {
            const { done, total } = event.payload;
            faststartMigrationActions.reportProgress(done, total);
          }
        );
        if (cancelled) {
          fn();
        } else {
          unlisten = fn;
        }
      } catch (e) {
        console.warn(
          '[faststart_migration] failed to subscribe to progress events:',
          e
        );
      }
    })();
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, []);
}
