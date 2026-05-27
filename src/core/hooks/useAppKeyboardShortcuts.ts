import { useEffect } from 'react';
import {
  modalActions,
  uiActions,
  useVaultPath,
  useSelectedContainer,
  useCustomShortcuts,
  useContainerConfigs,
  useShowHoverPanel,
  useUIStore,
} from '../stores/zustand';
import { createNoteFromTemplateInteractive } from '../stores/appActions';
import { DEFAULT_SHORTCUTS, getActiveKeys, parseShortcut } from '../utils/shortcuts';

// v18 (2026-05-16, HanBin) — wizard/title/special-modal branching extracted
// into `createNoteFromTemplateInteractive` so all three entry points share
// one flow. TEMPLATE_DESC_KEYS and related i18n now live inside that action.

export function useAppKeyboardShortcuts() {
  const vaultPath = useVaultPath();
  const selectedContainer = useSelectedContainer();
  const customShortcuts = useCustomShortcuts();
  const containerConfigs = useContainerConfigs();
  const showHoverPanel = useShowHoverPanel();

  useEffect(() => {
    const getShortcutKeys = (id: string) => {
      const custom = customShortcuts.find(s => s.id === id);
      const def = DEFAULT_SHORTCUTS.find(s => s.id === id);
      if (custom) return getActiveKeys(custom);
      if (def) return getActiveKeys(def);
      return '';
    };

    // Find the root container path for a given container path
    const getRootContainerPath = (containerPath: string | null): string | null => {
      if (!containerPath || !vaultPath) return null;
      const normalizedPath = containerPath.replace(/\\/g, '/');
      const normalizedVault = vaultPath.replace(/\\/g, '/');
      const relativePath = normalizedPath.startsWith(normalizedVault)
        ? normalizedPath.slice(normalizedVault.length + 1)
        : normalizedPath;
      const firstSegment = relativePath.split('/')[0];
      if (!firstSegment) return null;
      return `${normalizedVault}/${firstSegment}`.replace(/\//g, '\\');
    };

    // Check if selected container is inside a Storage container and get its assigned template
    const getStorageTemplateId = (): string | null => {
      const rootPath = getRootContainerPath(selectedContainer);
      if (!rootPath) return null;

      const normalizedRoot = rootPath.replace(/\\/g, '/').toLowerCase();

      let config = containerConfigs[rootPath];

      if (!config) {
        for (const [key, value] of Object.entries(containerConfigs)) {
          const normalizedKey = key.replace(/\\/g, '/').toLowerCase();
          if (normalizedKey === normalizedRoot) {
            config = value;
            break;
          }
        }
      }

      if (config?.type === 'storage' && config.assignedTemplateId) {
        return config.assignedTemplateId;
      }
      return null;
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't trigger shortcuts when typing in input fields
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
        return;
      }

      const checkShortcut = (id: string): boolean => {
        const keys = getShortcutKeys(id);
        if (!keys) return false;
        const parsed = parseShortcut(keys);
        const ctrlMatch = parsed.ctrl === (e.ctrlKey || e.metaKey);
        const shiftMatch = parsed.shift === e.shiftKey;
        const altMatch = parsed.alt === e.altKey;
        const keyMatch = parsed.key.toLowerCase() === e.key.toLowerCase() ||
                        (parsed.key === 'ArrowLeft' && e.key === 'ArrowLeft') ||
                        (parsed.key === 'ArrowRight' && e.key === 'ArrowRight');
        return ctrlMatch && shiftMatch && altMatch && keyMatch;
      };

      // New note (Ctrl+N) - only works when container/folder is selected.
      // v18 (2026-05-16, HanBin) — wizard / special-modal / title-modal
      // branching was duplicated across this hook, ContainerView, and
      // RibbonBar (3 call sites, only this one had the wizard branch →
      // user-input vars never prompted from the other two). Now all three
      // route through `createNoteFromTemplateInteractive` in appActions.
      if (checkShortcut('newNote')) {
        e.preventDefault();
        if (vaultPath && selectedContainer) {
          const storageTemplateId = getStorageTemplateId();
          if (storageTemplateId) {
            const rootPath = getRootContainerPath(selectedContainer);
            const targetPath = rootPath || selectedContainer;
            createNoteFromTemplateInteractive(storageTemplateId, targetPath);
          } else {
            // Standard container: pick a template (centered dialog), then
            // hand off to the shared interactive flow.
            modalActions.showTemplateSelector(
              { x: 0, y: 0 },
              (templateId: string) => {
                createNoteFromTemplateInteractive(templateId, selectedContainer);
              },
              'centered',
            );
          }
        }
        return;
      }

      // Command palette (Ctrl+K) — Stage 5.0.4a
      if (checkShortcut('commandPalette')) {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('open-command-palette'));
        return;
      }

      // Search (Ctrl+Shift+F). Ctrl+K alias removed in 5.0.4a — it now opens the
      // command palette above instead.
      if (checkShortcut('search')) {
        e.preventDefault();
        uiActions.setShowSearch(true);
        return;
      }

      // Settings (Ctrl+,) — Stage 5.0.4a. Reuses existing 'open-settings'
      // event consumed by Sidebar.tsx so the modal opens regardless of where
      // the shortcut fires.
      if (checkShortcut('settings')) {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('open-settings'));
        return;
      }

      // New folder (Ctrl+Shift+N) — Stage 5.0.4a. Reuses Sidebar's new-container
      // flow via custom event so any focused surface can open the dialog.
      if (checkShortcut('newFolder')) {
        e.preventDefault();
        if (vaultPath) {
          window.dispatchEvent(new CustomEvent('open-new-folder'));
        }
        return;
      }

      // Toggle sidebar (Ctrl+ArrowLeft) — Stage 5.0.3b-simplify (2026-05-15):
      // semantic now = collapse toggle (expanded ↔ icon-only). The legacy
      // hidden mode was removed because two collapse axes (hide vs icon-only)
      // created duplicate UI surface that confused users (one button each).
      if (checkShortcut('toggleSidebar')) {
        e.preventDefault();
        const collapsed = useUIStore.getState().sidebarCollapsed;
        uiActions.setSidebarCollapsed(!collapsed);
        return;
      }

      // Toggle right panel (Ctrl+ArrowRight)
      if (checkShortcut('toggleRightPanel')) {
        e.preventDefault();
        uiActions.setShowHoverPanel(!showHoverPanel);
        return;
      }

      // DEV ONLY: Open mobile test window. Stage 5.0.4a moves these from
      // Ctrl+Shift+M/T → Ctrl+Alt+Shift+M/T so they no longer collide with the
      // removed-but-still-recognizable user keys.
      if (
        import.meta.env.DEV &&
        e.ctrlKey && e.altKey && e.shiftKey &&
        (e.key === 'M' || e.key === 'T' || e.key === 'm' || e.key === 't')
      ) {
        e.preventDefault();
        const device = e.key.toUpperCase() === 'T' ? 'tablet' : 'phone';
        import('@tauri-apps/api/core').then(({ invoke }) => {
          invoke('open_mobile_test_window', {
            vaultPath: vaultPath || null,
            device,
          }).catch(console.error);
        });
        return;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [vaultPath, customShortcuts, showHoverPanel, selectedContainer, containerConfigs]);
}
