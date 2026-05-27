// sync_v2 feature module entry point.
// Registers UI into Core slots + Settings tab. Import this file once in App.tsx.

import { RefreshCw } from 'lucide-react';
import { SlotRegistry } from '../../core/infrastructure/slotRegistry';
import { SettingsRegistry } from '../settings/SettingsRegistry';
import { useSettingsStore } from '../../core/stores/settingsStore';
import { t } from '../../core/utils/i18n';
import { SyncV2StatusIndicator } from './components/SyncV2StatusIndicator';
import SyncV2SettingsPanel from './components/SyncV2SettingsPanel';

// Register sync status into sidebar footer slot
SlotRegistry.register('sidebar-footer-status', SyncV2StatusIndicator);

// 5.0.6d (2026-05-17, HanBin) — plugin labels now resolve via i18n + supply a
// lucide Icon so the Settings tab nav stays visually consistent. The old
// '🔄 Sync (v2)' emoji-prefixed string is gone. label is a resolver so it
// updates live when the user switches language.
SettingsRegistry.register({
  id: 'sync-v2',
  label: () => t('sync', useSettingsStore.getState().language),
  Icon: RefreshCw,
  component: SyncV2SettingsPanel,
  order: 45, // After default tabs (0-40), before developer
});

// Re-exports
export { SyncV2StatusIndicator } from './components/SyncV2StatusIndicator';
export { ConflictListModal } from './components/ConflictListModal';
export { BranchPickerModal } from './components/BranchPickerModal';
export { syncV2Commands } from './syncV2Commands';
export { useSyncV2Events } from './hooks/useSyncV2Events';
