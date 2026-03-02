import { useModalStore } from '../../stores/zustand/modalStore';
import { forceOpenLockedVault } from '../../stores/appActions';
import { useSettingsStore } from '../../stores/zustand/settingsStore';
import { t } from '../../utils/i18n';

function VaultLockModal() {
  const vaultLockModalState = useModalStore(s => s.vaultLockModalState);
  const hideVaultLockModal = useModalStore(s => s.hideVaultLockModal);
  const language = useSettingsStore(s => s.language);

  if (!vaultLockModalState || !vaultLockModalState.visible) return null;

  const { holder, isStale, vaultPath } = vaultLockModalState;
  const vaultName = vaultPath.split(/[/\\]/).filter(Boolean).pop() || vaultPath;

  // Format the heartbeat time
  const formatTime = (isoString: string) => {
    try {
      const date = new Date(isoString);
      return date.toLocaleString('ko-KR', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return isoString;
    }
  };

  return (
    <div className="modal-overlay" onClick={hideVaultLockModal}>
      <div className="modal-content vault-lock-modal" onClick={e => e.stopPropagation()}>
        <div className="vault-lock-modal-header">
          <span className="vault-lock-icon">🔒</span>
          <h2>{t('vaultInUse', language)}</h2>
        </div>

        <div className="vault-lock-modal-body">
          <p className="vault-lock-message">
            <strong>{vaultName}</strong> {t('vaultInUseMsg', language)}
          </p>

          {holder && (
            <div className="vault-lock-info">
              <div className="vault-lock-info-row">
                <span className="vault-lock-info-label">{t('deviceLabel', language)}</span>
                <span className="vault-lock-info-value">{holder.hostname}</span>
              </div>
              <div className="vault-lock-info-row">
                <span className="vault-lock-info-label">{t('lastActivityLabel', language)}</span>
                <span className="vault-lock-info-value">{formatTime(holder.heartbeat)}</span>
              </div>
              <div className="vault-lock-info-row">
                <span className="vault-lock-info-label">{t('lockStartedLabel', language)}</span>
                <span className="vault-lock-info-value">{formatTime(holder.locked_at)}</span>
              </div>
            </div>
          )}

          {isStale ? (
            <p className="vault-lock-stale-warning">
              {t('staleSessionWarning', language)}
            </p>
          ) : (
            <p className="vault-lock-active-warning">
              {t('multiDeviceWarning', language)}
            </p>
          )}
        </div>

        <div className="vault-lock-modal-footer">
          <button className="vault-lock-btn cancel" onClick={hideVaultLockModal}>
            {t('cancel', language)}
          </button>
          <button
            className={`vault-lock-btn force ${isStale ? 'recommended' : 'dangerous'}`}
            onClick={forceOpenLockedVault}
          >
            {isStale ? t('open', language) : t('forceOpen', language)}
          </button>
        </div>
      </div>
    </div>
  );
}

export default VaultLockModal;
