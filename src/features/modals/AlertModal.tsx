import { useEffect, useRef } from 'react';
import { useModalStore } from './stores/modalStore';
import { useSettingsStore } from '../../core/stores/settingsStore';
import { t } from '../../core/utils/i18n';

function AlertModal() {
  const alertModalState = useModalStore(s => s.alertModalState);
  const hideAlertModal = useModalStore(s => s.hideAlertModal);
  const language = useSettingsStore(s => s.language);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (alertModalState?.visible && buttonRef.current) {
      buttonRef.current.focus();
    }
  }, [alertModalState?.visible]);

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') hideAlertModal();
    };
    if (alertModalState?.visible) {
      document.addEventListener('keydown', handleEscape);
      return () => document.removeEventListener('keydown', handleEscape);
    }
  }, [alertModalState?.visible, hideAlertModal]);

  if (!alertModalState?.visible) return null;

  const { title, message } = alertModalState;

  return (
    <div className="modal-overlay" onClick={hideAlertModal}>
      <div className="modal-shell alert-modal" onClick={(e) => e.stopPropagation()}>
        <div className="alert-modal-header">{title}</div>
        <div className="alert-modal-body">
          <p className="alert-modal-message">{message}</p>
        </div>
        <div className="alert-modal-actions">
          <button
            ref={buttonRef}
            className="alert-modal-btn"
            onClick={hideAlertModal}
          >
            {t('confirm', language)}
          </button>
        </div>
      </div>
    </div>
  );
}

export default AlertModal;
