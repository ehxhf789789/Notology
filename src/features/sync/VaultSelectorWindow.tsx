/**
 * VaultSelectorWindow — standalone window for vault selection.
 * Rendered when URL has ?vault-selector=true or window label is "vault-selector".
 * When a vault is selected, emits a Tauri event and closes itself.
 */
import { useCallback, useEffect, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { emit } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { NasVaultSelector } from './NasVaultSelector';
import logoWhite from '../../assets/logo-white.png';
import logoBlack from '../../assets/logo-black.png';
import '../../styles/tokens.css';
import '../../styles/index.css';

// Import sync side-effects (registers Settings tab, EventBus, etc.)
import './index';

export function VaultSelectorWindow() {
  // Dynamic theme from system preference
  const [theme, setTheme] = useState(() => {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  });
  useEffect(() => {
    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e: MediaQueryListEvent) => setTheme(e.matches ? 'dark' : 'light');
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, []);

  // Custom titlebar drag
  useEffect(() => {
    const header = document.querySelector('.vault-selector-window-header');
    if (header) {
      let isDragging = false;
      header.addEventListener('mousedown', async (e) => {
        if ((e.target as HTMLElement).closest('button')) return;
        isDragging = true;
        try { await getCurrentWindow().startDragging(); } catch {}
        isDragging = false;
      });
    }
  }, []);

  const handleVaultSelected = useCallback(async (localPath: string, vaultName: string) => {
    // Emit event to main window
    await emit('vault-selected', { localPath, vaultName });
    // Close this window
    await invoke('sync_close_vault_selector');
  }, []);

  const handleClose = useCallback(async () => {
    await getCurrentWindow().close();
  }, []);

  return (
    <div className="vault-selector-window" data-theme={theme}>
      <div className="vault-selector-window-header">
        <span className="vault-selector-window-title">Notology</span>
        <button className="vault-selector-window-close" onClick={handleClose}>×</button>
      </div>
      <div className="vault-selector-window-body">
        <div className="vault-selector-window-logo">
          <img src={theme === 'dark' ? logoWhite : logoBlack} alt="Notology" className="vault-selector-logo-img" />
          <div className="vault-selector-logo-text">
            <h1>Notology</h1>
            <span className="vault-selector-version">v3.0.0</span>
          </div>
          <p className="vault-selector-subtitle">보관함을 선택하여 시작하세요</p>
        </div>
        <NasVaultSelector onVaultSelected={handleVaultSelected} />
      </div>
    </div>
  );
}
