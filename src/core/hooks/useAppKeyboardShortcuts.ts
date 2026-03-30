import { useEffect } from 'react';
import {
  hoverActions,
  fileTreeActions,
  refreshActions,
  modalActions,
  uiActions,
  useVaultPath,
  useSelectedContainer,
  useCustomShortcuts,
  useNoteTemplates,
  useContainerConfigs,
  useLanguage,
  useShowSidebar,
  useShowHoverPanel,
} from '../stores/zustand';
import { createNoteWithTemplate } from '../stores/appActions';
import { DEFAULT_SHORTCUTS, getActiveKeys, parseShortcut } from '../utils/shortcuts';
import { t } from '../utils/i18n';

// Template description keys for Ctrl+N detailed popup
const TEMPLATE_DESC_KEYS: Record<string, string> = {
  'NOTE': 'templateDescNote',
  'SKETCH': 'templateDescSketch',
  'MTG': 'templateDescMtg',
  'SEM': 'templateDescSem',
  'EVENT': 'templateDescEvent',
  'OFA': 'templateDescOfa',
  'PAPER': 'templateDescPaper',
  'LIT': 'templateDescLit',
  'DATA': 'templateDescData',
  'THEO': 'templateDescTheo',
  'CONTACT': 'templateDescContact',
  'SETUP': 'templateDescSetup',
};

export function useAppKeyboardShortcuts() {
  const vaultPath = useVaultPath();
  const selectedContainer = useSelectedContainer();
  const customShortcuts = useCustomShortcuts();
  const noteTemplates = useNoteTemplates();
  const containerConfigs = useContainerConfigs();
  const language = useLanguage();
  const showSidebar = useShowSidebar();
  const showHoverPanel = useShowHoverPanel();

  // Stable action references
  const openHoverFile = hoverActions.open;
  const refreshFileTree = fileTreeActions.refreshFileTree;
  const incrementSearchRefresh = refreshActions.incrementSearchRefresh;

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

      // New note (Ctrl+N) - only works when container/folder is selected
      if (checkShortcut('newNote')) {
        e.preventDefault();
        // Only allow note creation when a container or folder is selected
        if (vaultPath && selectedContainer) {
          // Check if inside a Storage container
          const storageTemplateId = getStorageTemplateId();

          // Templates that have their own input modals (skip TitleInputModal)
          const SPECIAL_TEMPLATE_IDS = ['note-contact', 'note-mtg', 'note-paper', 'note-lit', 'note-event'];

          if (storageTemplateId) {
            // Storage container: skip template selector
            const rootPath = getRootContainerPath(selectedContainer);
            const targetPath = rootPath || selectedContainer;

            // Check if this template has its own input modal
            if (SPECIAL_TEMPLATE_IDS.includes(storageTemplateId)) {
              // Special templates: directly call createNoteWithTemplate (it will show its own modal)
              createNoteWithTemplate('', storageTemplateId, targetPath)
                .then(async (notePath) => {
                  await refreshFileTree();
                  incrementSearchRefresh();
                  openHoverFile(notePath);
                })
                .catch(err => console.error('Failed to create note:', err));
            } else {
              // Regular templates: show title input modal first
              const template = noteTemplates.find(t => t.id === storageTemplateId);
              const noteType = template?.frontmatter?.type?.toLowerCase() || template?.prefix?.toLowerCase() || 'note';
              const templateInfo = template ? {
                name: template.name,
                prefix: template.prefix,
                description: t(TEMPLATE_DESC_KEYS[template.prefix.toUpperCase()] || 'templateDescCustom', language),
                noteType,
                customColor: template.customColor,
              } : undefined;

              modalActions.showTitleInputModal(async (result) => {
                if (result.title.trim()) {
                  try {
                    const notePath = await createNoteWithTemplate(result.title.trim(), storageTemplateId, targetPath);
                    await refreshFileTree();
                    incrementSearchRefresh();
                    openHoverFile(notePath);
                  } catch (err) {
                    console.error('Failed to create note:', err);
                  }
                }
              }, t('enterNoteTitlePlaceholder', language), t('newNoteDefault', language), templateInfo);
            }
          } else {
            // Standard container: show template selector
            modalActions.showTemplateSelector(
              { x: Math.round(window.innerWidth / 2 - 150), y: Math.round(window.innerHeight / 2 - 200) },
              (templateId: string) => {
                // Check if this template has its own input modal
                if (SPECIAL_TEMPLATE_IDS.includes(templateId)) {
                  // Special templates: directly call createNoteWithTemplate
                  createNoteWithTemplate('', templateId, selectedContainer)
                    .then(async (notePath) => {
                      await refreshFileTree();
                      incrementSearchRefresh();
                      openHoverFile(notePath);
                    })
                    .catch(err => console.error('Failed to create note:', err));
                } else {
                  // Regular templates: show title input modal
                  const template = noteTemplates.find(t => t.id === templateId);
                  const noteType = template?.frontmatter?.type?.toLowerCase() || template?.prefix?.toLowerCase() || 'note';
                  const templateInfo = template ? {
                    name: template.name,
                    prefix: template.prefix,
                    description: t(TEMPLATE_DESC_KEYS[template.prefix.toUpperCase()] || 'templateDescCustom', language),
                    noteType,
                    customColor: template.customColor,
                  } : undefined;

                  modalActions.showTitleInputModal(async (result) => {
                    if (result.title.trim()) {
                      try {
                        const notePath = await createNoteWithTemplate(result.title.trim(), templateId, selectedContainer);
                        await refreshFileTree();
                        incrementSearchRefresh();
                        openHoverFile(notePath);
                      } catch (err) {
                        console.error('Failed to create note:', err);
                      }
                    }
                  }, t('enterNoteTitlePlaceholder', language), t('newNoteDefault', language), templateInfo);
                }
              }
            );
          }
        }
        return;
      }

      // Search (Ctrl+Shift+F)
      if (checkShortcut('search') || (e.ctrlKey && e.key === 'k' && !e.shiftKey && !e.altKey)) {
        e.preventDefault();
        uiActions.setShowSearch(true);
        return;
      }

      // Calendar (Ctrl+Shift+C) - now opens right panel which contains calendar
      if (checkShortcut('calendar')) {
        e.preventDefault();
        uiActions.setShowHoverPanel(true);
        return;
      }

      // Toggle sidebar (Ctrl+ArrowLeft)
      if (checkShortcut('toggleSidebar')) {
        e.preventDefault();
        uiActions.setShowSidebar(!showSidebar);
        return;
      }

      // Toggle right panel (Ctrl+ArrowRight)
      if (checkShortcut('toggleRightPanel')) {
        e.preventDefault();
        uiActions.setShowHoverPanel(!showHoverPanel);
        return;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [vaultPath, customShortcuts, showSidebar, showHoverPanel, selectedContainer, noteTemplates, containerConfigs, language, openHoverFile, refreshFileTree, incrementSearchRefresh]);
}
