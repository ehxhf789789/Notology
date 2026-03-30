import { createRoot } from 'react-dom/client'
import { getCurrentWindow } from '@tauri-apps/api/window'
import '../../styles/tokens.css'
import '../../index.css'
import 'tippy.js/dist/tippy.css'
// Initialize editor pool early for fast hover window opening
import '../editor/editorPool'
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
  }

  const isVaultSelector = urlParams.get('vault-selector') === 'true'
    || windowLabel === 'vault-selector';

  const root = createRoot(document.getElementById('root')!);

  // Render appropriate app based on window type
  if (isVaultSelector) {
    // Vault selector: separate window with NAS connection + vault selection
    const { VaultSelectorWindow } = await import('../../features/sync/VaultSelectorWindow');
    root.render(<VaultSelectorWindow />);
  } else if (isHoverWindow) {
    // Auto-restored hover windows from previous session have no path param — close them
    if (!urlParams.get('path')) {
      console.warn('[main] Closing stale hover window (no path):', windowLabel);
      getCurrentWindow().destroy().catch(() => getCurrentWindow().close().catch(() => {}));
      return;
    }
    root.render(<HoverWindowApp />);
  } else {
    root.render(<App />);
  }
}

initializeApp();
