import { createRoot } from 'react-dom/client'
import { getCurrentWindow } from '@tauri-apps/api/window'
import '../../styles/tokens.css'
import '../../index.css'
import 'tippy.js/dist/tippy.css'
// 2026-05-25 (HanBin) — bundled Korean fonts. reset.css's `--app-font`
// stack already references "Pretendard" / "Nanum Gothic" / "Noto Sans KR"
// by name, but Notology shipped zero @font-face declarations so Windows
// users without those fonts manually installed got Malgun fallback for
// every option in the Settings font picker. Self-hosting via @fontsource
// (+ the standalone `pretendard` package) makes the picker actually
// work offline (Tauri-compatible).
//
// Why three different packages:
//   - `@fontsource/pretendard` ships LATIN-ONLY (1 subset, no Korean
//     glyphs at U+AC00–D7AF) — its Settings option was a no-op on
//     Windows. The standalone `pretendard` package from the font's
//     designer ships the full Korean glyph set via dynamic subsets,
//     so we use that instead.
//   - `@fontsource/nanum-gothic` ships 92 subsets covering the full
//     Hangul Syllables block — index.css alone works.
//   - `@fontsource/noto-sans-kr` ships 124 subsets — same story.
//
// Browsers fetch only the subsets matching glyphs actually rendered
// (unicode-range), so bundle weight stays reasonable in practice.
import 'pretendard/dist/web/static/pretendard.css'
import '@fontsource/nanum-gothic'
import '@fontsource/noto-sans-kr'
// Initialize editor pool early for fast hover window opening
import '../editor/editorPool'
import { initPlatform, shouldUseMobileApp, isNativeMobile } from '../utils/platform'
import { injectThemeCSS } from '../../styles/theme'
import App from './App.tsx'
import HoverWindowApp from './HoverWindowApp.tsx'
import { flushAllEditorSaves } from '../editor/editorSaveRegistry'

// Detect if we're in a hover window based on URL parameter or window label
async function initializeApp() {
  const urlParams = new URLSearchParams(window.location.search);
  const isHoverFromUrl = urlParams.get('hover') === 'true';
  const windowLabel = getCurrentWindow().label;
  const isHoverFromLabel = windowLabel.startsWith('hover-');
  const isHoverWindow = isHoverFromUrl || isHoverFromLabel;

  // Hover windows: save & close on HMR updates and page refreshes
  // This prevents content loss when the app hot-reloads during development
  if (isHoverWindow) {
    // Vite HMR: save content and close hover window before module update
    if (import.meta.hot) {
      import.meta.hot.on('vite:beforeUpdate', () => {
        flushAllEditorSaves();
        getCurrentWindow().close();
      });
    }
    // Full page refresh: flush saves before unload
    window.addEventListener('beforeunload', () => {
      flushAllEditorSaves();
    });
    // Listen for flush request from main window (before it closes all hovers)
    import('@tauri-apps/api/event').then(({ listen }) => {
      listen('hover:flush-saves', () => {
        flushAllEditorSaves();
      });
    }).catch(() => {});
  }

  // Main window & vault selector: save all hover windows and close them on HMR
  // This prevents content loss when the vault selector or main app hot-reloads.
  // After HMR, initializeApp() will auto-reopen the last vault seamlessly.
  if (!isHoverWindow) {
    if (import.meta.hot) {
      import.meta.hot.on('vite:beforeUpdate', async () => {
        flushAllEditorSaves();
        const { closeAllHoverWindows } = await import('../utils/multiWindow');
        await closeAllHoverWindows();
      });
    }
    window.addEventListener('beforeunload', () => {
      flushAllEditorSaves();
    });
  }

  // Detect native platform (iOS/Android/desktop) before rendering
  await initPlatform();

  // Inject design token CSS variables
  injectThemeCSS();

  const isVaultSelector = urlParams.get('vault-selector') === 'true'
    || windowLabel === 'vault-selector';

  const root = createRoot(document.getElementById('root')!);

  // Render appropriate app based on window type
  if (isVaultSelector) {
    // Vault selector: separate window with NAS connection + vault selection
    const { VaultSelectorWindow } = await import('../../features/connection/components/VaultSelectorWindow');
    root.render(<VaultSelectorWindow />);
  } else if (isHoverWindow) {
    // Auto-restored hover windows from previous session have no path param — close them
    if (!urlParams.get('path')) {
      console.warn('[main] Closing stale hover window (no path):', windowLabel);
      getCurrentWindow().destroy().catch(() => getCurrentWindow().close().catch(() => {}));
      return;
    }
    root.render(<HoverWindowApp />);
  } else if (
    shouldUseMobileApp() ||
    // DEV ONLY: ?mobile=true forces mobile UI on desktop for testing
    (import.meta.env.DEV && urlParams.get('mobile') === 'true')
  ) {
    // Mobile/tablet: render calendar-centric mobile app
    // If vault path passed via URL param (from desktop test window), auto-open it
    const vaultParam = urlParams.get('vault');
    if (vaultParam) {
      const decodedVault = decodeURIComponent(vaultParam);
      const { openVault } = await import('../stores/appActions');
      const { settingsActions } = await import('../stores/settingsStore');
      await settingsActions.loadGlobalSettings();
      await openVault(decodedVault);
    } else {
      // Try auto-open last vault from global store
      const { initializeApp: initApp } = await import('../stores/appActions');
      await initApp();
    }

    const MobileApp = (await import('../../features/mobile/MobileApp')).default;
    const { AppInitializer } = await import('../stores/appStore');
    await import('../../features/sync_v2/index');
    await import('../../features/connection/index');
    root.render(<AppInitializer><MobileApp /></AppInitializer>);
  } else {
    // Desktop: full sidebar + editor + panels
    // sync_v2: register SyncV2StatusIndicator + conflict modals into sidebar-footer-status slot.
    // Side-effect import triggers SlotRegistry.register() at module load.
    await import('../../features/sync_v2/index');
    await import('../../features/connection/index');
    root.render(<App />);
  }
}

initializeApp();
