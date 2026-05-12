// sync_v2 feature module entry point.
// Registers UI into Core slots + Settings tab. Import this file once in App.tsx.

import { SlotRegistry } from '../../core/infrastructure/slotRegistry';
import { SettingsRegistry } from '../settings/SettingsRegistry';
import { SyncV2StatusIndicator } from './components/SyncV2StatusIndicator';
import SyncV2SettingsPanel from './components/SyncV2SettingsPanel';

// Register sync status into sidebar footer slot
SlotRegistry.register('sidebar-footer-status', SyncV2StatusIndicator);

// Register settings tab
SettingsRegistry.register({
  id: 'sync-v2',
  label: '🔄 Sync (v2)',
  component: SyncV2SettingsPanel,
  order: 45, // After default tabs (0-40), before developer
});

// Re-exports
export { SyncV2StatusIndicator } from './components/SyncV2StatusIndicator';
export { ConflictListModal } from './components/ConflictListModal';
export { BranchPickerModal } from './components/BranchPickerModal';
export { syncV2Commands } from './syncV2Commands';
export { useSyncV2Events } from './hooks/useSyncV2Events';
