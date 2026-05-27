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
// v17 (2026-05-16, HanBin) — per-file custom template storage so a single
// vault-config write can't wipe all templates at once.
import {
  loadAllCustomTemplates,
  saveCustomTemplate,
  deleteCustomTemplateFile,
  migrateLegacyTemplates,
} from '../templatesFileStore';
// v20 (2026-05-16, HanBin) — cross-window template sync. Any mutation here
// broadcasts a Tauri event so hover windows (separate React entrypoints
// with their own templateStore) can reload and stay in sync.
import { notifyTemplatesChanged } from '../../../core/utils/windowSync';

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

  // Load from vault-config.yaml + per-file custom template dir (v17)
  loadTemplates: (vaultPath: string, vaultConfig: {
    customTemplates?: NoteTemplate[];
    enabledTemplateIds?: string[];
    defaultTemplateType?: 'A' | 'B';
    folderTemplates?: FolderNoteTemplate[];
    customShortcuts?: ShortcutBinding[];
  }) => Promise<void>;
  resetToDefaults: () => void;
}

// Internal helper to persist folder templates to vault-config.yaml
async function persistFolderTemplates(templates: FolderNoteTemplate[], vaultPath: string | null) {
  if (!vaultPath) return;
  await updateFolderTemplates(vaultPath, templates);
}

// Internal helper to persist note templates
// v17 (2026-05-16, HanBin) — persist customs as PER-FILE YAML under
// `.notology/templates/custom/<id>.yaml`. Each save = one file write,
// each delete = one file remove. No more single-point-of-failure on
// vault-config.yaml's customTemplates array.
const DEFAULT_TEMPLATE_IDS = new Set(DEFAULT_NOTE_TEMPLATES.map(t => t.id));

async function persistOneCustomTemplate(template: NoteTemplate, vaultPath: string | null) {
  if (!vaultPath) return;
  if (DEFAULT_TEMPLATE_IDS.has(template.id)) return; // never write defaults to disk
  await saveCustomTemplate(vaultPath, template);
  // v17 also clears the legacy vault-config.customTemplates array so a
  // future migration step doesn't re-introduce stale entries.
  await updateCustomTemplates(vaultPath, []).catch(err =>
    console.warn('[templateStore] failed to clear legacy customTemplates:', err),
  );
  // v20 — broadcast so other windows reload templates.
  notifyTemplatesChanged(vaultPath).catch(err =>
    console.warn('[templateStore] broadcast failed:', err),
  );
}

async function deleteOneCustomTemplate(id: string, vaultPath: string | null) {
  if (!vaultPath) return;
  if (DEFAULT_TEMPLATE_IDS.has(id)) return;
  await deleteCustomTemplateFile(vaultPath, id);
  notifyTemplatesChanged(vaultPath).catch(err =>
    console.warn('[templateStore] broadcast failed:', err),
  );
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

  // Actions - Note templates (v17 — per-file persistence)
  addNoteTemplate: (template, vaultPath) => {
    const updated = [...get().noteTemplates, template];
    const currentEnabled = get().enabledTemplateIds;
    const newEnabled = currentEnabled.includes(template.id)
      ? currentEnabled
      : [...currentEnabled, template.id];
    set({ noteTemplates: updated, enabledTemplateIds: newEnabled });
    // Single template write — won't touch other template files.
    persistOneCustomTemplate(template, vaultPath).catch(err =>
      console.error('[templateStore] addNoteTemplate persist failed:', err),
    );
    if (vaultPath && newEnabled !== currentEnabled) {
      updateEnabledTemplateIds(vaultPath, newEnabled);
    }
  },

  updateNoteTemplate: (template, vaultPath) => {
    const updated = get().noteTemplates.map(t => t.id === template.id ? template : t);
    set({ noteTemplates: updated });
    persistOneCustomTemplate(template, vaultPath).catch(err =>
      console.error('[templateStore] updateNoteTemplate persist failed:', err),
    );
    injectTemplateColorVars(updated);
  },

  removeNoteTemplate: (id, vaultPath) => {
    const updated = get().noteTemplates.filter(t => t.id !== id);
    set({ noteTemplates: updated });
    deleteOneCustomTemplate(id, vaultPath).catch(err =>
      console.error('[templateStore] removeNoteTemplate delete failed:', err),
    );
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

  // Load from vault-config.yaml + per-file custom template store (v17).
  loadTemplates: async (vaultPath, vaultConfig) => {
    const updates: Partial<TemplateState> = {};

    // Folder templates
    if (vaultConfig.folderTemplates && vaultConfig.folderTemplates.length > 0) {
      const customTemplates = vaultConfig.folderTemplates.filter(t => t.type === 'B');
      updates.templates = [...DEFAULT_TEMPLATES, ...customTemplates];
    } else {
      updates.templates = DEFAULT_TEMPLATES;
    }
    if (vaultConfig.defaultTemplateType) updates.defaultTemplateType = vaultConfig.defaultTemplateType;

    // v17 (2026-05-16, HanBin) — custom templates now live as individual
    // YAML files under `.notology/templates/custom/`. Load from there;
    // run a one-shot migration if vault-config still has the legacy
    // `customTemplates` array (writes each to its own file).
    let perFileCustoms: NoteTemplate[] = [];
    try {
      perFileCustoms = await loadAllCustomTemplates(vaultPath);
    } catch (err) {
      console.error('[templateStore] failed to load per-file customs:', err);
    }
    // Migrate legacy array if present and not yet superseded by per-file
    // versions (per-file wins by id).
    if (vaultConfig.customTemplates && vaultConfig.customTemplates.length > 0) {
      const perFileIds = new Set(perFileCustoms.map(t => t.id));
      const toMigrate = vaultConfig.customTemplates.filter(
        t => !DEFAULT_TEMPLATE_IDS.has(t.id) && !perFileIds.has(t.id),
      );
      if (toMigrate.length > 0) {
        try {
          const migrated = await migrateLegacyTemplates(vaultPath, toMigrate, DEFAULT_TEMPLATE_IDS);
          perFileCustoms = [...perFileCustoms, ...migrated];
        } catch (err) {
          console.warn('[templateStore] migration of legacy templates failed:', err);
        }
      }
      // Clear the legacy array so the per-file store is the single
      // source of truth going forward.
      try {
        await updateCustomTemplates(vaultPath, []);
      } catch (err) {
        console.warn('[templateStore] failed to clear legacy customTemplates:', err);
      }
    }
    // Dedupe defensively — drop anything whose id collides with current
    // defaults (cleanup for historical pollution bug).
    const savedCustomNoteTemplates = perFileCustoms.filter(t => !DEFAULT_TEMPLATE_IDS.has(t.id));
    if (savedCustomNoteTemplates.length > 0) {
      updates.noteTemplates = [...DEFAULT_NOTE_TEMPLATES, ...savedCustomNoteTemplates];
    } else {
      updates.noteTemplates = DEFAULT_NOTE_TEMPLATES;
    }
    if (vaultConfig.enabledTemplateIds) {
      // Stage 5.0.5a (2026-05-16) — filter out stale IDs from old 12-template
      // registry that no longer resolve in DEFAULT_NOTE_TEMPLATES.
      const allValidIds = new Set([
        ...DEFAULT_NOTE_TEMPLATES.map(t => t.id),
        ...savedCustomNoteTemplates.map(t => t.id),
      ]);
      const survived = vaultConfig.enabledTemplateIds.filter(id => allValidIds.has(id));
      // v16 fix (2026-05-16, HanBin) — auto-include any custom templates that
      // are NOT yet in enabledTemplateIds. Without this, templates created
      // before the v12 auto-enable fix stay hidden from TemplateSelector.
      const survivedSet = new Set(survived);
      for (const t of savedCustomNoteTemplates) {
        if (!survivedSet.has(t.id)) survived.push(t.id);
      }
      updates.enabledTemplateIds = survived.length > 0
        ? survived
        : DEFAULT_NOTE_TEMPLATES.map(t => t.id);
    } else {
      // No saved enabledTemplateIds — enable all defaults + customs.
      updates.enabledTemplateIds = [
        ...DEFAULT_NOTE_TEMPLATES.map(t => t.id),
        ...savedCustomNoteTemplates.map(t => t.id),
      ];
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
