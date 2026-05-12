// Bridge between frontend EventBus events and sync_v2 dirty queue.
// Listens for file/folder/attachment events → enqueue to backend.
// Also handles visibility + activity signals for AdaptivePoller.

import { useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

const ACTIVITY_THROTTLE_MS = 60_000; // 1 minute

export function useDirtyQueueBridge() {
  const lastActivity = useRef(0);

  useEffect(() => {
    const unlisteners: UnlistenFn[] = [];

    const setup = async () => {
      // file:deleted → enqueue delete
      unlisteners.push(
        await listen<{ path: string }>('file:deleted', (e) => {
          invoke('sync_v2_enqueue_delete', { path: e.payload.path }).catch(() => {});
        })
      );

      // file:renamed → enqueue move
      unlisteners.push(
        await listen<{ oldPath: string; newPath: string }>('file:renamed', (e) => {
          invoke('sync_v2_enqueue_move', {
            oldPath: e.payload.oldPath,
            newPath: e.payload.newPath,
          }).catch(() => {});
        })
      );

      // attachment:saved → enqueue attachment
      unlisteners.push(
        await listen<{ path: string }>('attachment:saved', (e) => {
          invoke('sync_v2_enqueue_attachment', { path: e.payload.path }).catch(() => {});
        })
      );

      // folder:created → enqueue folder create
      unlisteners.push(
        await listen<{ path: string }>('folder:created', (e) => {
          invoke('sync_v2_enqueue_folder_create', { path: e.payload.path }).catch(() => {});
        })
      );

      // folder:deleted → enqueue folder delete
      unlisteners.push(
        await listen<{ path: string }>('folder:deleted', (e) => {
          invoke('sync_v2_enqueue_folder_delete', { path: e.payload.path }).catch(() => {});
        })
      );
    };

    setup().catch((e) => console.debug('[useDirtyQueueBridge] setup error:', e));

    // Visibility change → signal to AdaptivePoller
    const onVisibility = () => {
      const visible = document.visibilityState === 'visible';
      invoke('sync_v2_signal_visibility', { visible }).catch(() => {});
    };
    document.addEventListener('visibilitychange', onVisibility);

    // User activity → signal (throttled to 1/minute)
    const onActivity = () => {
      const now = Date.now();
      if (now - lastActivity.current > ACTIVITY_THROTTLE_MS) {
        lastActivity.current = now;
        invoke('sync_v2_signal_activity').catch(() => {});
      }
    };
    document.addEventListener('mousemove', onActivity, { passive: true });
    document.addEventListener('keydown', onActivity, { passive: true });

    return () => {
      for (const u of unlisteners) u();
      document.removeEventListener('visibilitychange', onVisibility);
      document.removeEventListener('mousemove', onActivity);
      document.removeEventListener('keydown', onActivity);
    };
  }, []);
}
