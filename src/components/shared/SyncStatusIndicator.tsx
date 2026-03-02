import { memo } from 'react';
import { useSettingsStore } from '../../stores/zustand/settingsStore';
import { t } from '../../utils/i18n';

export type SyncStatus = 'synced' | 'editing' | 'conflict' | 'editing-elsewhere';

interface SyncStatusIndicatorProps {
  status: SyncStatus;
  deviceName?: string;
}

const STATUS_LABEL_KEYS: Record<SyncStatus, string> = {
  synced: 'statusSynced',
  editing: 'statusEditing',
  conflict: 'statusConflict',
  'editing-elsewhere': 'statusEditingElsewhere',
};

export const SyncStatusIndicator = memo(function SyncStatusIndicator({ status, deviceName }: SyncStatusIndicatorProps) {
  const language = useSettingsStore(s => s.language);
  const label = t(STATUS_LABEL_KEYS[status], language);
  const title = deviceName ? `${label} (${deviceName})` : label;

  return (
    <span
      className={`sync-status-indicator sync-status-${status}`}
      title={title}
    >
      {status === 'conflict' ? '▲' : '●'}
    </span>
  );
});
