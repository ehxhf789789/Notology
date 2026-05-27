// Connection feature module — registers settings tab + editor banner slot.
//
// 5.0.6d (2026-05-17, HanBin) — tab renamed from "연결된 기기" to "보관소
// 상태". HanBin: "연결된 기기를 현재 보관소 상태를 보여주는 이름으로
// 변경" — the panel actually surfaces per-vault sync status (who has
// touched this vault, when, recent activity) rather than a generic device
// roster, so the name now matches the content. lucide Activity icon
// replaces the 🔗 emoji prefix for consistency with the redesigned tab
// nav (5.0.6c).
import { Activity } from 'lucide-react';
import { SettingsRegistry } from '../settings/SettingsRegistry';
import { SlotRegistry } from '../../core/infrastructure/slotRegistry';
import { useSettingsStore } from '../../core/stores/settingsStore';
import { t } from '../../core/utils/i18n';
import { ConnectedDevicesPanel } from './components/ConnectedDevicesPanel';
import { UnregisteredNotesBanner } from './components/UnregisteredNotesBanner';

SettingsRegistry.register({
  id: 'connected-devices',
  label: () => t('vaultStatus', useSettingsStore.getState().language),
  Icon: Activity,
  order: 46,
  component: ConnectedDevicesPanel,
});

// Banner above the editor — surfaces NAS notes that aren't yet in the sync model.
SlotRegistry.register('editor-banner', UnregisteredNotesBanner);
