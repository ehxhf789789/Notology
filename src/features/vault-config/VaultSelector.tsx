import { FolderOpen, FolderPlus, Trash2, X } from 'lucide-react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { getVersion } from '@tauri-apps/api/app';
import { useState, useEffect } from 'react';
import { useVaultPath } from '../../core/stores/fileTreeStore';
import { useRecentVaults } from './stores/vaultConfigStore';
import { useSettingsStore } from '../../core/stores/settingsStore';
import { openVault, removeVault } from '../../core/stores/appActions';
import { t } from '../../core/utils/i18n';
import logoWhite from '../../assets/logo-white.png';
import logoBlack from '../../assets/logo-black.png';
import { NasVaultSelector } from '../sync/NasVaultSelector';

interface VaultSelectorProps {
  onClose?: () => void;
  showCloseButton?: boolean;
}

function VaultSelector({ onClose, showCloseButton = false }: VaultSelectorProps) {
  const vaultPath = useVaultPath();
  const recentVaults = useRecentVaults();
  const theme = useSettingsStore(s => s.theme);
  const language = useSettingsStore(s => s.language);

  // Determine effective theme (considering system preference)
  const getEffectiveTheme = () => {
    if (theme === 'system') {
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    return theme;
  };
  const effectiveTheme = getEffectiveTheme();

  // Get app version from tauri.conf.json
  const [appVersion, setAppVersion] = useState('');
  useEffect(() => {
    getVersion().then(v => setAppVersion(v)).catch(() => {});
  }, []);
  const logo = effectiveTheme === 'light' ? logoBlack : logoWhite;

  return (
    <div className="vault-selector-overlay">
      <div className="vault-selector-container">
        {showCloseButton && onClose && (
          <button className="vault-selector-close-btn" onClick={onClose} title={t('close', language)}>
            <X size={20} />
          </button>
        )}
        <div className="vault-selector-header">
          <img src={logo} alt="Notology" className="vault-selector-logo" />
          <div className="vault-selector-title-row">
            <h1 className="vault-selector-title">Notology</h1>
            <span className="vault-selector-version">{appVersion ? `v${appVersion}` : ''}</span>
          </div>
          <p className="vault-selector-subtitle">{t('selectVaultToStart', language)}</p>
        </div>

        <div className="vault-selector-body">
          {/* NAS-centric vault selector (includes offline mode) */}
          <NasVaultSelector
            onVaultSelected={(localPath) => {
              openVault(localPath);
            }}
          />
        </div>

        <div className="vault-selector-footer">
          <p className="vault-selector-hint">
            {t('vaultHintText', language)}
          </p>
          {!showCloseButton && (
            <button
              className="vault-selector-exit-btn"
              onClick={() => getCurrentWindow().close()}
            >
              {t('exitApp', language)}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default VaultSelector;
