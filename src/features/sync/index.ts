import { SettingsRegistry } from '../settings/SettingsRegistry';
import { SlotRegistry } from '../../core/infrastructure/slotRegistry';
import { EventBus } from '../../core/infrastructure/eventBus';
import SyncSettingsPanel from './SyncSettingsPanel';
import { SyncStatusIndicator } from './SyncStatusIndicator';
import { syncCommands } from './syncCommands';

// ============================================================
// 1. Settings 탭 등록
// ============================================================
SettingsRegistry.register({
  id: 'sync',
  label: '동기화',
  icon: '☁️',
  component: SyncSettingsPanel,
  order: 50,
});

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
  syncCommands.onFileSaved(path).catch(() => {});
});

// ============================================================
// 4. App lifecycle hooks
// ============================================================

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
