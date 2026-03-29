import { create } from 'zustand';
import type { FolderNoteTemplate, NoteTemplate } from '../../../core/types';
import type { ShortcutBinding } from '../../../core/utils/shortcuts';
import { DEFAULT_TEMPLATES, DEFAULT_NOTE_TEMPLATES } from '../templates';
import {
  updateCustomTemplates,
  updateEnabledTemplateIds,
  updateDefaultTemplateType,
  updateFolderTemplates,
  updateCustomShortcuts,
} from '../../../core/utils/vaultConfigUtils';

interface TemplateState {
  // State
  templates: FolderNoteTemplate[];
  defaultTemplateType: 'A' | 'B';
  noteTemplates: NoteTemplate[];
  enabledTemplateIds: string[];
  customShortcuts: ShortcutBinding[];

  // Actions - Folder note templates
  setDefaultTemplateType: (type: 'A' | 'B', vaultPath: string | null) => void;
  addTemplate: (template: FolderNoteTemplate, vaultPath: string | null) => void;
  removeTemplate: (id: string, vaultPath: string | null) => void;
  updateTemplate: (template: FolderNoteTemplate, vaultPath: string | null) => void;

  // Actions - Note templates
  addNoteTemplate: (template: NoteTemplate, vaultPath: string | null) => void;
  updateNoteTemplate: (template: NoteTemplate, vaultPath: string | null) => void;
  removeNoteTemplate: (id: string, vaultPath: string | null) => void;
  setEnabledTemplates: (ids: string[], vaultPath: string | null) => void;
  toggleTemplateEnabled: (id: string, vaultPath: string | null) => void;

  // Actions - Shortcuts
  setCustomShortcuts: (shortcuts: ShortcutBinding[], vaultPath: string | null) => void;

  // Load from vault-config.yaml
  loadTemplates: (vaultPath: string, vaultConfig: {
    customTemplates?: NoteTemplate[];
    enabledTemplateIds?: string[];
    defaultTemplateType?: 'A' | 'B';
    folderTemplates?: FolderNoteTemplate[];
    customShortcuts?: ShortcutBinding[];
  }) => void;
  resetToDefaults: () => void;
}

// Internal helper to persist folder templates to vault-config.yaml
async function persistFolderTemplates(templates: FolderNoteTemplate[], vaultPath: string | null) {
  if (!vaultPath) return;
  await updateFolderTemplates(vaultPath, templates);
}

// Internal helper to persist note templates
async function persistNoteTemplates(templates: NoteTemplate[], vaultPath: string | null) {
  if (!vaultPath) return;
  const customOnly = templates.filter(t => !t.id.startsWith('note-') || t.id.startsWith('note-custom-'));
  await updateCustomTemplates(vaultPath, customOnly);
}

// Inject template custom colors as CSS variables on :root
// This allows wiki link colors and other UI to automatically match template colors
function injectTemplateColorVars(noteTemplates: NoteTemplate[]) {
  const root = typeof document !== 'undefined' ? document.documentElement : null;
  if (!root) return;

  for (const tmpl of noteTemplates) {
    if (tmpl.customColor) {
      const noteType = (tmpl.frontmatter.type || tmpl.prefix).toLowerCase();
      root.style.setProperty(`--${noteType}-color`, tmpl.customColor);
    }
  }
}

export const useTemplateStore = create<TemplateState>()((set, get) => ({
  // Initial state
  templates: DEFAULT_TEMPLATES,
  defaultTemplateType: 'A',
  noteTemplates: DEFAULT_NOTE_TEMPLATES,
  enabledTemplateIds: DEFAULT_NOTE_TEMPLATES.map(t => t.id),
  customShortcuts: [],

  // Actions - Folder note templates
  setDefaultTemplateType: (type, vaultPath) => {
    set({ defaultTemplateType: type });
    if (!vaultPath) return;
    updateDefaultTemplateType(vaultPath, type);
  },

  addTemplate: (template, vaultPath) => {
    const updated = [...get().templates, template];
    set({ templates: updated });
    persistFolderTemplates(updated, vaultPath);
  },

  removeTemplate: (id, vaultPath) => {
    const updated = get().templates.filter(t => t.id !== id);
    set({ templates: updated });
    persistFolderTemplates(updated, vaultPath);
  },

  updateTemplate: (template, vaultPath) => {
    const updated = get().templates.map(t => t.id === template.id ? template : t);
    set({ templates: updated });
    persistFolderTemplates(updated, vaultPath);
  },

  // Actions - Note templates
  addNoteTemplate: (template, vaultPath) => {
    const updated = [...get().noteTemplates, template];
    set({ noteTemplates: updated });
    persistNoteTemplates(updated, vaultPath);
  },

  updateNoteTemplate: (template, vaultPath) => {
    const updated = get().noteTemplates.map(t => t.id === template.id ? template : t);
    set({ noteTemplates: updated });
    persistNoteTemplates(updated, vaultPath);
    injectTemplateColorVars(updated);
  },

  removeNoteTemplate: (id, vaultPath) => {
    const updated = get().noteTemplates.filter(t => t.id !== id);
    set({ noteTemplates: updated });
    persistNoteTemplates(updated, vaultPath);
  },

  setEnabledTemplates: (ids, vaultPath) => {
    set({ enabledTemplateIds: ids });
    if (!vaultPath) return;
    updateEnabledTemplateIds(vaultPath, ids);
  },

  toggleTemplateEnabled: (id, vaultPath) => {
    const { enabledTemplateIds } = get();
    const newIds = enabledTemplateIds.includes(id)
      ? enabledTemplateIds.filter(i => i !== id)
      : [...enabledTemplateIds, id];
    set({ enabledTemplateIds: newIds });
    if (!vaultPath) return;
    updateEnabledTemplateIds(vaultPath, newIds);
  },

  // Actions - Shortcuts
  setCustomShortcuts: (shortcuts, vaultPath) => {
    set({ customShortcuts: shortcuts });
    if (!vaultPath) return;
    updateCustomShortcuts(vaultPath, shortcuts);
  },

  // Load from vault-config.yaml (all template data now in portable config)
  loadTemplates: (_vaultPath, vaultConfig) => {
    const updates: Partial<TemplateState> = {};

    // Folder templates
    if (vaultConfig.folderTemplates && vaultConfig.folderTemplates.length > 0) {
      const customTemplates = vaultConfig.folderTemplates.filter(t => t.type === 'B');
      updates.templates = [...DEFAULT_TEMPLATES, ...customTemplates];
    } else {
      updates.templates = DEFAULT_TEMPLATES;
    }
    if (vaultConfig.defaultTemplateType) updates.defaultTemplateType = vaultConfig.defaultTemplateType;

    // Note templates (custom ones from vault config)
    const savedCustomNoteTemplates = vaultConfig.customTemplates || [];
    if (savedCustomNoteTemplates.length > 0) {
      updates.noteTemplates = [...DEFAULT_NOTE_TEMPLATES, ...savedCustomNoteTemplates];
    } else {
      updates.noteTemplates = DEFAULT_NOTE_TEMPLATES;
    }
    if (vaultConfig.enabledTemplateIds) {
      updates.enabledTemplateIds = vaultConfig.enabledTemplateIds;
    } else {
      updates.enabledTemplateIds = DEFAULT_NOTE_TEMPLATES.map(t => t.id);
    }

    // Shortcuts
    if (vaultConfig.customShortcuts) {
      updates.customShortcuts = vaultConfig.customShortcuts;
    } else {
      updates.customShortcuts = [];
    }

    set(updates);

    // Inject custom colors as CSS variables
    if (updates.noteTemplates) {
      injectTemplateColorVars(updates.noteTemplates);
    }
  },

  resetToDefaults: () => {
    set({
      templates: DEFAULT_TEMPLATES,
      defaultTemplateType: 'A',
      noteTemplates: DEFAULT_NOTE_TEMPLATES,
      enabledTemplateIds: DEFAULT_NOTE_TEMPLATES.map(t => t.id),
      customShortcuts: [],
    });
  },
}));

// Selector hooks
export const useNoteTemplates = () => useTemplateStore((s) => s.noteTemplates);
export const useEnabledTemplateIds = () => useTemplateStore((s) => s.enabledTemplateIds);
export const useFolderTemplates = () => useTemplateStore((s) => s.templates);
export const useDefaultTemplateType = () => useTemplateStore((s) => s.defaultTemplateType);
export const useCustomShortcuts = () => useTemplateStore((s) => s.customShortcuts);

// Actions (stable references)
export const templateActions = {
  setDefaultTemplateType: (type: 'A' | 'B', vaultPath: string | null) =>
    useTemplateStore.getState().setDefaultTemplateType(type, vaultPath),
  addTemplate: (template: FolderNoteTemplate, vaultPath: string | null) =>
    useTemplateStore.getState().addTemplate(template, vaultPath),
  removeTemplate: (id: string, vaultPath: string | null) =>
    useTemplateStore.getState().removeTemplate(id, vaultPath),
  updateTemplate: (template: FolderNoteTemplate, vaultPath: string | null) =>
    useTemplateStore.getState().updateTemplate(template, vaultPath),
  addNoteTemplate: (template: NoteTemplate, vaultPath: string | null) =>
    useTemplateStore.getState().addNoteTemplate(template, vaultPath),
  updateNoteTemplate: (template: NoteTemplate, vaultPath: string | null) =>
    useTemplateStore.getState().updateNoteTemplate(template, vaultPath),
  removeNoteTemplate: (id: string, vaultPath: string | null) =>
    useTemplateStore.getState().removeNoteTemplate(id, vaultPath),
  setEnabledTemplates: (ids: string[], vaultPath: string | null) =>
    useTemplateStore.getState().setEnabledTemplates(ids, vaultPath),
  toggleTemplateEnabled: (id: string, vaultPath: string | null) =>
    useTemplateStore.getState().toggleTemplateEnabled(id, vaultPath),
  setCustomShortcuts: (shortcuts: ShortcutBinding[], vaultPath: string | null) =>
    useTemplateStore.getState().setCustomShortcuts(shortcuts, vaultPath),
  loadTemplates: (vaultPath: string, vaultConfig: {
    customTemplates?: NoteTemplate[];
    enabledTemplateIds?: string[];
    defaultTemplateType?: 'A' | 'B';
    folderTemplates?: FolderNoteTemplate[];
    customShortcuts?: ShortcutBinding[];
  }) =>
    useTemplateStore.getState().loadTemplates(vaultPath, vaultConfig),
  resetToDefaults: () =>
    useTemplateStore.getState().resetToDefaults(),
};
