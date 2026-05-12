// Connection feature module — registers settings tab + editor banner slot
import { SettingsRegistry } from '../settings/SettingsRegistry';
import { SlotRegistry } from '../../core/infrastructure/slotRegistry';
import { ConnectedDevicesPanel } from './components/ConnectedDevicesPanel';
import { UnregisteredNotesBanner } from './components/UnregisteredNotesBanner';

SettingsRegistry.register({
  id: 'connected-devices',
  label: '🔗 연결된 기기',
  order: 46,
  component: ConnectedDevicesPanel,
});

// Banner above the editor — surfaces NAS notes that aren't yet in the sync model.
SlotRegistry.register('editor-banner', UnregisteredNotesBanner);
