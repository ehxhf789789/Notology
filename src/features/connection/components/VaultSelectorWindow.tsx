/**
 * VaultSelectorWindow — standalone window for vault selection.
 * Rendered when URL has ?vault-selector=true or window label is "vault-selector".
 * When a vault is selected, emits a Tauri event and closes itself.
 */
import { useCallback, useEffect, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { emit, listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { ConnectionVaultSelector } from './ConnectionVaultSelector';
import { getGlobalStore } from '../../../core/stores/persistenceUtils';
import logoWhite from '../../../assets/logo-white.png';
import logoBlack from '../../../assets/logo-black.png';
import '../../../styles/tokens.css';
import '../../../styles/index.css';

// Import connection side-effects (registers Settings tab)
import '../index';

export function VaultSelectorWindow() {
  // Instant theme: check URL param first (set by Rust), then system preference
  const [theme, setTheme] = useState<string>(() => {
    // Rust passes theme info via background_color, but we need data-theme for CSS.
    // Use URL search param if available, otherwise system preference.
    const urlTheme = new URLSearchParams(window.location.search).get('theme');
    const initial = urlTheme || (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
    document.documentElement.setAttribute('data-theme', initial);
    return initial;
  });

  // Load saved theme from global store, then show window
  useEffect(() => {
    const showWindow = () => {
      // Show window after theme is applied (hidden by Rust to prevent dark flash)
      getCurrentWindow().show().catch(() => {});
    };

    // 1. Read last saved theme from global store
    getGlobalStore().then(async (store) => {
      const saved = await store.get<string>('last_theme');
      if (saved) {
        setTheme(saved);
        document.documentElement.setAttribute('data-theme', saved);
      } else {
        const sys = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
        setTheme(sys);
        document.documentElement.setAttribute('data-theme', sys);
      }
      showWindow();
    }).catch(() => {
      const sys = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
      setTheme(sys);
      document.documentElement.setAttribute('data-theme', sys);
      showWindow();
    });

    // 2. Listen for theme changes from main window
    let unlisten: (() => void) | undefined;
    listen<{ theme: string }>('theme-changed', (e) => {
      setTheme(e.payload.theme);
      document.documentElement.setAttribute('data-theme', e.payload.theme);
    }).then(u => { unlisten = u; });

    // 3. Listen for system preference changes
    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e: MediaQueryListEvent) => {
      // Only apply system preference if theme is "system"
      setTheme(prev => {
        if (prev === 'system') {
          const t = e.matches ? 'dark' : 'light';
          document.documentElement.setAttribute('data-theme', t);
        }
        return prev;
      });
    };
    mql.addEventListener('change', handler);

    return () => {
      unlisten?.();
      mql.removeEventListener('change', handler);
    };
  }, []);

  // Apply theme to <html> whenever it changes
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

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
    await emit('vault-selected', { localPath, vaultName });
    await invoke('close_vault_selector');
  }, []);

  const handleClose = useCallback(async () => {
    await getCurrentWindow().close();
  }, []);

  // Resolve effective theme for rendering (system → actual dark/light)
  const effectiveTheme = theme === 'system'
    ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : theme;

  return (
    <div className="vault-selector-window" data-theme={effectiveTheme}>
      <div className="vault-selector-window-header">
        <span className="vault-selector-window-title">Notology</span>
        <button className="vault-selector-window-close" onClick={handleClose}>×</button>
      </div>
      <div className="vault-selector-window-body">
        <div className="vault-selector-window-logo">
          <img src={effectiveTheme === 'dark' ? logoWhite : logoBlack} alt="Notology" className="vault-selector-logo-img" />
          <div className="vault-selector-logo-text">
            <h1>Notology</h1>
            <span className="vault-selector-version">v3.0.0</span>
          </div>
        </div>
        <ConnectionVaultSelector onVaultSelected={handleVaultSelected} />
      </div>
    </div>
  );
}
