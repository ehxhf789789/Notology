import { memo } from 'react';
import { useSettingsStore } from '../../../core/stores/settingsStore';
import { t } from '../../../core/utils/i18n';

interface ConflictBarProps {
  onAcceptExternal: () => void;
  onKeepMine: () => void;
  onSaveBoth: () => void;
}

/**
 * Conflict resolution bar shown when external modifications are detected
 */
export const ConflictBar = memo(function ConflictBar({
  onAcceptExternal,
  onKeepMine,
  onSaveBoth,
}: ConflictBarProps) {
  const language = useSettingsStore(s => s.language);

  return (
    <div className="hover-editor-conflict-bar">
      <span className="conflict-bar-message">{t('conflictDetected', language)}</span>
      <div className="conflict-bar-actions">
        <button className="conflict-btn accept-external" onClick={onAcceptExternal}>
          {t('acceptExternal', language)}
        </button>
        <button className="conflict-btn keep-mine" onClick={onKeepMine}>
          {t('keepMine', language)}
        </button>
        <button className="conflict-btn save-both" onClick={onSaveBoth}>
          {t('keepBoth', language)}
        </button>
      </div>
    </div>
  );
});

interface ConflictCopyBarProps {
  originalName: string;
  onReplaceOriginal: () => void;
  onKeepOriginal: () => void;
  onPreserveBoth: () => void;
}

/**
 * Conflict copy bar shown when a conflict copy file is detected
 */
export const ConflictCopyBar = memo(function ConflictCopyBar({
  originalName,
  onReplaceOriginal,
  onKeepOriginal,
  onPreserveBoth,
}: ConflictCopyBarProps) {
  const language = useSettingsStore(s => s.language);

  return (
    <div className="hover-editor-conflict-copy-bar">
      <span className="conflict-copy-bar-message">{t('conflictCopy', language)} {originalName}</span>
      <div className="conflict-copy-bar-actions">
        <button className="conflict-copy-btn replace-original" onClick={onReplaceOriginal}>
          {t('replaceOriginal', language)}
        </button>
        <button className="conflict-copy-btn keep-original" onClick={onKeepOriginal}>
          {t('keepOriginal', language)}
        </button>
        <button className="conflict-copy-btn keep-both" onClick={onPreserveBoth}>
          {t('preserveBoth', language)}
        </button>
      </div>
    </div>
  );
});

interface SyncBarProps {}

/**
 * Sync in progress bar shown during bulk NAS sync
 */
export const SyncBar = memo(function SyncBar(_props: SyncBarProps) {
  const language = useSettingsStore(s => s.language);

  return (
    <div className="hover-editor-sync-bar">
      <span className="sync-bar-spinner">↻</span>
      {t('syncInProgressHover', language)}
    </div>
  );
});
