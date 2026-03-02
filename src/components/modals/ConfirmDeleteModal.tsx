import { useEffect } from 'react';
import { useModalStore } from '../../stores/zustand/modalStore';
import { useSettingsStore } from '../../stores/zustand/settingsStore';
import { t, tf } from '../../utils/i18n';

function ConfirmDeleteModal() {
  const confirmDeleteState = useModalStore(s => s.confirmDeleteState);
  const hideConfirmDelete = useModalStore(s => s.hideConfirmDelete);
  const language = useSettingsStore(s => s.language);

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') hideConfirmDelete();
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [hideConfirmDelete]);

  if (!confirmDeleteState || !confirmDeleteState.visible) return null;

  const { itemName, itemType, onConfirm, count } = confirmDeleteState;
  const isFolder = itemType === 'folder';
  const isFile = itemType === 'file';
  const isBatch = count && count > 1;

  const handleConfirm = () => {
    onConfirm();
    hideConfirmDelete();
  };

  const handleCancel = () => {
    hideConfirmDelete();
  };

  // Determine header text
  const getHeaderText = () => {
    if (isBatch) return t('batchDelete', language);
    if (isFile) return t('deleteFile', language);
    if (isFolder) return t('deleteFolder', language);
    return t('deleteNote', language);
  };

  // Determine message text
  const getMessage = () => {
    if (isBatch) {
      return <>{tf('confirmBatchDelete', language, { count: count! })}</>;
    }
    if (isFile) {
      return <><strong>"{itemName}"</strong> {t('confirmDeleteFile', language)}</>;
    }
    if (isFolder) {
      return <><strong>"{itemName}"</strong> {t('confirmDeleteFolder', language)}</>;
    }
    return <><strong>"{itemName}"</strong> {t('confirmDeleteNote', language)}</>;
  };

  // Determine warning text
  const getWarning = () => {
    if (isBatch || isFile) return t('warnWikilinks', language);
    if (isFolder) return t('warnSubitems', language);
    return t('warnAttachments', language);
  };

  return (
    <div className="modal-overlay">
      <div className="confirm-delete-modal">
        <div className="confirm-delete-header">
          {getHeaderText()}
        </div>
        <div className="confirm-delete-body">
          <p className="confirm-delete-message">
            {getMessage()}
          </p>
          <p className="confirm-delete-warning">
            {getWarning()}
          </p>
        </div>
        <div className="confirm-delete-actions">
          <button className="confirm-delete-btn confirm-delete-cancel" onClick={handleCancel}>
            {t('cancel', language)}
          </button>
          <button className="confirm-delete-btn confirm-delete-confirm" onClick={handleConfirm}>
            {t('delete', language)}
          </button>
        </div>
      </div>
    </div>
  );
}

export default ConfirmDeleteModal;
