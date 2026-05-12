// Subscribe to Tauri sync_v2 events and update store.

import { useEffect } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { syncV2Actions } from '../stores/syncV2Store';
import { showToast } from '../../shared/Toast';

/**
 * Mount once at app root. Listens for backend sync events and
 * keeps the Zustand store in sync.
 */
export function useSyncV2Events() {
  useEffect(() => {
    const unlisteners: UnlistenFn[] = [];

    const setup = async () => {
      // D14: sync lifecycle events
      unlisteners.push(await listen('sync_v2:started', () => {
        syncV2Actions.refreshState();
      }));

      unlisteners.push(await listen('sync_v2:completed', () => {
        syncV2Actions.refreshState();
        syncV2Actions.refreshConflicts();
      }));

      unlisteners.push(await listen<string>('sync_v2:error', (e) => {
        syncV2Actions.refreshState();
        showToast({ type: 'error', title: 'Sync error', description: e.payload });
      }));

      unlisteners.push(await listen('sync_v2:conflict_detected', () => {
        syncV2Actions.refreshConflicts();
        showToast({ type: 'warning', title: 'Conflict detected', description: 'Review in sync panel' });
      }));

      // NAS reachability transitions emitted by offline_monitor.
      unlisteners.push(await listen<boolean>('sync-v2:online-changed', (e) => {
        syncV2Actions.setOnline(e.payload);
      }));

      // User toggle. Backend emits this after `sync_v2_set_enabled` so
      // every window mirrors the new state without polling.
      unlisteners.push(await listen<boolean>('sync-v2:enabled-changed', (e) => {
        syncV2Actions.setSyncEnabled(e.payload);
      }));

      // Track H + general status: every sync_once emits this with the
      // full report. Mirror it into the store so the UI sees background
      // sync results (silent-trash toast, bulk-pending banner) the same
      // way it sees the user-triggered "지금 동기화" results.
      unlisteners.push(await listen<any>('sync-v2:report', (e) => {
        const report = e.payload;
        if (!report) return;
        syncV2Actions.applyReport(report);
      }));

      // Initial fetch
      syncV2Actions.refreshState();
      syncV2Actions.refreshOnline();
      syncV2Actions.refreshSyncEnabled();
      syncV2Actions.refreshConflicts();
    };

    setup().catch(() => {});

    return () => {
      for (const u of unlisteners) u();
    };
  }, []);
}
