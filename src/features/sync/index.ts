import { SlotRegistry } from '../../core/infrastructure/slotRegistry';
import { EventBus } from '../../core/infrastructure/eventBus';
import { SyncStatusIndicator } from './SyncStatusIndicator';
import { syncCommands } from './syncCommands';

// Settings 탭은 제거 — 보관소 선택창에서 모든 동기화 설정을 관리

// ============================================================
// 2. TitleBar 슬롯에 상태 인디케이터 주입
// ============================================================
SlotRegistry.register('titlebar-status', SyncStatusIndicator);

// ============================================================
// 3. EventBus 구독: Core 이벤트 → Sync 동작
// ============================================================
EventBus.on('file:saved', ({ path }) => {
  syncCommands.onFileSaved(path).catch((e) => {
    console.warn('[sync] onFileSaved failed:', e);
  });
});

EventBus.on('vault:opened', ({ path }) => {
  syncCommands.init(path).then(() => {
    syncCommands.startMonitor().catch(() => {});
  }).catch((e) => {
    console.warn('[sync] init failed:', e);
  });
});

EventBus.on('file:deleted', ({ path }) => {
  syncCommands.onFileDeleted(path).catch(() => {});
});

EventBus.on('file:renamed', ({ oldPath, newPath }) => {
  syncCommands.onFileDeleted(oldPath).catch(() => {});
  syncCommands.onFileSaved(newPath).catch(() => {});
  // Wikilink rename modifies multiple .md files via Rust fs::write (bypasses EventBus).
  // Trigger full sync to catch all changed files.
  setTimeout(() => syncCommands.syncNow().catch(() => {}), 2000);
});

// Folder events
EventBus.on('folder:created', ({ path }) => {
  syncCommands.onFileSaved(path).catch(() => {}); // MKCOL on NAS
});

EventBus.on('folder:deleted', ({ path }) => {
  syncCommands.onFileDeleted(path).catch(() => {});
});

EventBus.on('folder:renamed', ({ oldPath, newPath }) => {
  syncCommands.onFileDeleted(oldPath).catch(() => {});
  syncCommands.onFileSaved(newPath).catch(() => {});
});

// Attachment events
EventBus.on('attachment:saved', ({ path }) => {
  syncCommands.onFileSaved(path).catch(() => {});
});

EventBus.on('attachment:deleted', ({ path }) => {
  syncCommands.onFileDeleted(path).catch(() => {});
});

// Comment events
EventBus.on('comments:saved', ({ commentsPath }) => {
  syncCommands.onFileSaved(commentsPath).catch(() => {});
});

// Config events
EventBus.on('config:saved', ({ path }) => {
  syncCommands.onFileSaved(path).catch(() => {});
});

// ============================================================
// 4. App lifecycle hooks + online recovery
// ============================================================

// Online recovery: auto flush queue when NAS becomes reachable
if (typeof document !== 'undefined') {
  import('@tauri-apps/api/event').then(({ listen }) => {
    listen('sync:online', () => {
      console.log('[sync] Online recovered — triggering sync');
      syncCommands.syncNow().catch(() => {});
    });
  }).catch(() => {});
}

// Foreground resume: pull changes when app regains focus
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      syncCommands.onForeground().catch(() => {});
    }
  });

  // App exit: flush queue (best-effort)
  window.addEventListener('beforeunload', () => {
    syncCommands.flushOnExit().catch(() => {});
  });
}

// ============================================================
// Public API 재수출
// ============================================================
export { SyncStatusIndicator } from './SyncStatusIndicator';
export { ConflictResolverPanel } from './ConflictResolverPanel';
export { syncCommands } from './syncCommands';
