/**
 * VaultSelectorWindow — standalone window for vault selection.
 * Rendered when URL has ?vault-selector=true or window label is "vault-selector".
 * When a vault is selected, emits a Tauri event and closes itself.
 */
import { useCallback, useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { emit, listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { ConnectionVaultSelector } from './ConnectionVaultSelector';
import { getGlobalStore } from '../../../core/stores/persistenceUtils';
import { t } from '../../../core/utils/i18n';
import { useLanguage } from '../../../core/stores/settingsStore';
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

  const language = useLanguage();

  // Resolve effective theme for rendering (system → actual dark/light)
  const effectiveTheme = theme === 'system'
    ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : theme;

  return (
    <div className="vault-selector-window" data-theme={effectiveTheme}>
      {/* 5.0.6ab (2026-05-17, HanBin) — final layout per HanBin's Obsidian
          reference. Three zones:
          • Titlebar → small Notology wordmark on the LEFT (was empty per
            HanBin "윈도우 바에서도 당연히 텍스트가 있어야 하는데 왜
            비어 있냐"). The chrome now carries the app identity at all
            times even when the user scrolls past the hero.
          • Hero (centered) → 48px logo + Notology wordmark (24px) +
            version pill, then the page title underneath. Mirrors the
            Obsidian "Quick start" hero block — vertically stacked,
            horizontally centred, generous breathing space.
          • Body → connection chip (right-aligned) + vault list. */}
      <div className="vault-selector-window-header">
        <span className="vault-selector-window-titlebar-brand">
          <img
            src={effectiveTheme === 'dark' ? logoWhite : logoBlack}
            alt=""
            className="vault-selector-window-titlebar-brand__logo"
          />
          <span className="vault-selector-window-titlebar-brand__name">Notology</span>
          {/* 5.0.6ac (2026-05-17, HanBin) — page label after the brand.
              HanBin: "윈도우 바에 보관소 선택창 (한글/영문 고려)".
              i18n drives the language; dot separator keeps the visual
              hierarchy (brand emphasized, page label muted secondary). */}
          <span className="vault-selector-window-titlebar-brand__sep" aria-hidden="true">·</span>
          <span className="vault-selector-window-titlebar-brand__page">
            {t('vsWindowTitle', language)}
          </span>
        </span>
        <span className="vault-selector-window-titlebar-spacer" />
        <button
          className="vault-selector-window-close"
          onClick={handleClose}
          aria-label={t('close', language)}
          title={t('close', language)}
        >
          <X size={16} strokeWidth={2} />
        </button>
      </div>
      <div className="vault-selector-window-hero">
        <img
          src={effectiveTheme === 'dark' ? logoWhite : logoBlack}
          alt=""
          className="vault-selector-window-hero__logo"
        />
        <div className="vault-selector-window-hero__brand">
          <span className="vault-selector-window-hero__name">Notology</span>
          <span className="vault-selector-window-hero__version">v3.0.0</span>
        </div>
        <h1 className="vault-selector-window-hero__title">{t('vsWindowTitle', language)}</h1>
      </div>
      <div className="vault-selector-window-body">
        <ConnectionVaultSelector onVaultSelected={handleVaultSelected} />
      </div>
    </div>
  );
}
