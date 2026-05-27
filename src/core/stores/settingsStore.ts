import { create } from 'zustand';
import { emit } from '@tauri-apps/api/event';
import { hoverActions } from '../../features/hover-windows/stores/hoverStore';
import { getVaultStore, getGlobalStore } from './persistenceUtils';
import type { GraphSettings } from '../types';
import { DEFAULT_GRAPH_SETTINGS } from '../types';

export type ThemeSetting = 'dark' | 'light' | 'system';
export type FontSetting = 'default' | 'nanum' | 'noto' | 'malgun' | 'custom';
export type LanguageSetting = 'ko' | 'en';
/**
 * Round 2 R3 — note paper pattern. Applied to the editor body via the
 * `data-paper` attribute on `.tiptap-editor`. Sketch (canvas) notes
 * ignore this entirely.
 * v11 (2026-05-23) — dot/grid removed; only plain and ruled remain.
 */
export type PaperStyle = 'plain' | 'ruled';

export interface CustomFont {
  name: string;
  family: string;
  url?: string;
}

interface SettingsState {
  // State
  theme: ThemeSetting;
  font: FontSetting;
  customFonts: CustomFont[];
  selectedCustomFont: string | null;
  language: LanguageSetting;
  devMode: boolean;
  autoSaveDelay: number;
  toolbarDefaultCollapsed: boolean;
  hoverZoomEnabled: boolean;
  hoverZoomLevel: number;
  hoverDefaultWidth: number;
  hoverDefaultHeight: number;
  graphSettings: GraphSettings;
  fontSize: number;
  lineHeight: string;
  /**
   * Round 2 R3 (HanBin 2026-05-22). Global default paper pattern for note
   * bodies. A note's frontmatter `paper:` overrides this per-note. Sketch
   * (canvas) notes ignore both — the canvas has its own visual model.
   */
  paperStyle: PaperStyle;
  spellCheck: boolean;
  accentColor: number;
  /**
   * Track B Phase B-3 PART 6 (Option C, HanBin 2026-05-13). When true,
   * removing an attachment wikilink chip raises a confirmation modal before
   * the attachment is hard-deleted from CAS / NAS. Off = silent hard delete.
   */
  confirmAttachmentDelete: boolean;

  // Actions
  setTheme: (theme: ThemeSetting, vaultPath: string | null) => void;
  setFont: (font: FontSetting, vaultPath: string | null, customFontName?: string) => void;
  addCustomFont: (font: CustomFont, vaultPath: string | null) => void;
  removeCustomFont: (name: string, vaultPath: string | null) => void;
  setLanguage: (lang: LanguageSetting, vaultPath: string | null) => void;
  setDevMode: (enabled: boolean) => void;
  setAutoSaveDelay: (ms: number, vaultPath: string | null) => void;
  setToolbarDefaultCollapsed: (collapsed: boolean, vaultPath: string | null) => void;
  setHoverZoomEnabled: (enabled: boolean, vaultPath: string | null) => void;
  setHoverZoomLevel: (level: number, vaultPath: string | null) => void;
  setHoverDefaultSize: (width: number, height: number, vaultPath: string | null) => void;
  setGraphSettings: (settings: Partial<GraphSettings>, vaultPath: string | null) => void;
  setFontSize: (size: number, vaultPath: string | null) => void;
  setLineHeight: (lh: string, vaultPath: string | null) => void;
  setPaperStyle: (style: PaperStyle, vaultPath: string | null) => void;
  setSpellCheck: (enabled: boolean, vaultPath: string | null) => void;
  setAccentColor: (index: number, vaultPath: string | null) => void;
  setConfirmAttachmentDelete: (enabled: boolean, vaultPath: string | null) => void;

  // Load from persisted storage
  loadSettings: (vaultPath: string) => Promise<void>;
  loadGlobalSettings: () => Promise<void>;
  resetToDefaults: () => void;
}

// Detect initial theme from URL param > data-theme attribute > system preference
function detectInitialTheme(): ThemeSetting {
  if (typeof window === 'undefined') return 'dark';
  const urlTheme = new URLSearchParams(window.location.search).get('theme');
  if (urlTheme === 'light' || urlTheme === 'dark' || urlTheme === 'system') return urlTheme;
  const attrTheme = document.documentElement.getAttribute('data-theme');
  if (attrTheme === 'light' || attrTheme === 'dark' || attrTheme === 'system') return attrTheme;
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export const useSettingsStore = create<SettingsState>()((set, get) => ({
  // Initial state — theme detected from current context to prevent dark flash
  theme: detectInitialTheme(),
  font: 'default',
  customFonts: [],
  selectedCustomFont: null,
  language: 'ko',
  devMode: false,
  autoSaveDelay: 1000,
  toolbarDefaultCollapsed: true,
  hoverZoomEnabled: true,
  hoverZoomLevel: 100,
  hoverDefaultWidth: 1000,
  hoverDefaultHeight: 800,
  graphSettings: { ...DEFAULT_GRAPH_SETTINGS },
  fontSize: 15,
  lineHeight: '1.6',
  paperStyle: 'plain',
  spellCheck: false,
  accentColor: 4,
  confirmAttachmentDelete: true,

  // Actions
  setTheme: (newTheme, vaultPath) => {
    set({ theme: newTheme });
    document.documentElement.dataset.theme = newTheme;
    // Broadcast theme change to all hover windows
    emit('theme-changed', { theme: newTheme }).catch(() => {});
    // Save to global store so VaultSelector can read it
    getGlobalStore().then(store => store.set('last_theme', newTheme)).catch(() => {});
    if (!vaultPath) return;
    getVaultStore(vaultPath).then(store => store.set('theme', newTheme));
  },

  setFont: (newFont, vaultPath, customFontName) => {
    set((state) => {
      document.documentElement.dataset.font = newFont;
      const updates: Partial<SettingsState> = { font: newFont };
      if (newFont === 'custom' && customFontName) {
        updates.selectedCustomFont = customFontName;
        const customFont = state.customFonts.find(f => f.name === customFontName);
        if (customFont) {
          document.documentElement.style.setProperty('--custom-font-family', customFont.family);
        }
      }
      return updates;
    });
    if (!vaultPath) return;
    getVaultStore(vaultPath).then(async (store) => {
      await store.set('font', newFont);
      if (newFont === 'custom' && customFontName) {
        await store.set('selected_custom_font', customFontName);
      }
    });
  },

  addCustomFont: (font, vaultPath) => {
    const updated = [...get().customFonts, font];
    set({ customFonts: updated });
    if (!vaultPath) return;
    getVaultStore(vaultPath).then(store => store.set('custom_fonts', updated));
  },

  removeCustomFont: (name, vaultPath) => {
    const { customFonts, selectedCustomFont } = get();
    const updated = customFonts.filter(f => f.name !== name);
    const updates: Partial<SettingsState> = { customFonts: updated };
    if (selectedCustomFont === name) {
      updates.selectedCustomFont = null;
      updates.font = 'default';
      document.documentElement.dataset.font = 'default';
    }
    set(updates);
    if (!vaultPath) return;
    getVaultStore(vaultPath).then(async (store) => {
      await store.set('custom_fonts', updated);
      if (selectedCustomFont === name) {
        await store.set('selected_custom_font', null);
        await store.set('font', 'default');
      }
    });
  },

  setLanguage: (newLang, vaultPath) => {
    set({ language: newLang });
    document.documentElement.lang = newLang;
    if (!vaultPath) return;
    getVaultStore(vaultPath).then(store => store.set('language', newLang));
  },

  setDevMode: (enabled) => {
    set({ devMode: enabled });
    getGlobalStore().then(store => store.set('dev_mode', enabled));
  },

  setAutoSaveDelay: (ms, vaultPath) => {
    set({ autoSaveDelay: ms });
    if (!vaultPath) return;
    getVaultStore(vaultPath).then(store => store.set('auto_save_delay_ms', ms));
  },

  setToolbarDefaultCollapsed: (collapsed, vaultPath) => {
    set({ toolbarDefaultCollapsed: collapsed });
    if (!vaultPath) return;
    getVaultStore(vaultPath).then(store => store.set('toolbar_default_collapsed', collapsed));
  },

  setHoverZoomEnabled: (enabled, vaultPath) => {
    set({ hoverZoomEnabled: enabled });
    if (!vaultPath) return;
    getVaultStore(vaultPath).then(store => store.set('hover_zoom_enabled', enabled));
  },

  setHoverZoomLevel: (level, vaultPath) => {
    const clampedLevel = Math.min(200, Math.max(50, level));
    set({ hoverZoomLevel: clampedLevel });
    if (!vaultPath) return;
    getVaultStore(vaultPath).then(store => store.set('hover_zoom_level', clampedLevel));
  },

  setHoverDefaultSize: (width, height, vaultPath) => {
    const clampedWidth = Math.min(2000, Math.max(400, width));
    const clampedHeight = Math.min(1500, Math.max(300, height));
    set({ hoverDefaultWidth: clampedWidth, hoverDefaultHeight: clampedHeight });
    hoverActions.setDefaultSize(clampedWidth, clampedHeight);
    if (!vaultPath) return;
    getVaultStore(vaultPath).then(async (store) => {
      await store.set('hover_default_width', clampedWidth);
      await store.set('hover_default_height', clampedHeight);
    });
  },

  setGraphSettings: (newSettings, vaultPath) => {
    const current = get().graphSettings;
    const merged = {
      ...current,
      ...newSettings,
      nodeColors: { ...current.nodeColors, ...(newSettings.nodeColors || {}) },
      physics: { ...current.physics, ...(newSettings.physics || {}) },
    };
    set({ graphSettings: merged });
    if (!vaultPath) return;
    getVaultStore(vaultPath).then(store => store.set('graph_settings', merged));
  },

  setFontSize: (size, vaultPath) => {
    const clamped = Math.min(24, Math.max(12, size));
    set({ fontSize: clamped });
    document.documentElement.style.setProperty('--editor-font-size', `${clamped}px`);
    if (!vaultPath) return;
    getVaultStore(vaultPath).then(store => store.set('font_size', clamped));
  },

  setLineHeight: (lh, vaultPath) => {
    set({ lineHeight: lh });
    document.documentElement.style.setProperty('--editor-line-height', lh);
    if (!vaultPath) return;
    getVaultStore(vaultPath).then(store => store.set('line_height', lh));
  },

  setPaperStyle: (style, vaultPath) => {
    set({ paperStyle: style });
    if (!vaultPath) return;
    getVaultStore(vaultPath).then(store => store.set('paper_style', style));
  },

  setSpellCheck: (enabled, vaultPath) => {
    set({ spellCheck: enabled });
    document.querySelectorAll<HTMLElement>('[contenteditable]').forEach(el => {
      el.spellcheck = enabled;
    });
    if (!vaultPath) return;
    getVaultStore(vaultPath).then(store => store.set('spell_check', enabled));
  },

  setAccentColor: (index, vaultPath) => {
    set({ accentColor: index });
    const FOLDER_COLORS = ['#FF6B6B','#FF922B','#FCC419','#51CF66','#339AF0','#7950F2','#F06595','#20C997','#845EF7','#FD7E14'];
    const color = FOLDER_COLORS[index % FOLDER_COLORS.length];
    document.documentElement.style.setProperty('--c-blue', color);
    document.documentElement.style.setProperty('--color-accent', color);
    if (!vaultPath) return;
    getVaultStore(vaultPath).then(store => store.set('accent_color', index));
  },

  setConfirmAttachmentDelete: (enabled, vaultPath) => {
    set({ confirmAttachmentDelete: enabled });
    if (!vaultPath) return;
    getVaultStore(vaultPath).then(store => store.set('confirm_attachment_delete', enabled));
  },

  loadSettings: async (vaultPath) => {
    const vaultStore = await getVaultStore(vaultPath);

    const savedAutoSave = await vaultStore.get<number>('auto_save_delay_ms');
    const savedToolbarCollapsed = await vaultStore.get<boolean>('toolbar_default_collapsed');
    const savedHoverZoomEnabled = await vaultStore.get<boolean>('hover_zoom_enabled');
    const savedHoverZoomLevel = await vaultStore.get<number>('hover_zoom_level');
    const savedHoverDefaultWidth = await vaultStore.get<number>('hover_default_width');
    const savedHoverDefaultHeight = await vaultStore.get<number>('hover_default_height');
    const savedTheme = await vaultStore.get<ThemeSetting>('theme');
    const savedFont = await vaultStore.get<FontSetting>('font');
    const savedCustomFonts = await vaultStore.get<CustomFont[]>('custom_fonts');
    const savedSelectedCustomFont = await vaultStore.get<string>('selected_custom_font');
    const savedLanguage = await vaultStore.get<LanguageSetting>('language');

    const updates: Partial<SettingsState> = {};

    if (savedAutoSave) updates.autoSaveDelay = savedAutoSave;
    if (savedToolbarCollapsed !== null && savedToolbarCollapsed !== undefined) {
      updates.toolbarDefaultCollapsed = savedToolbarCollapsed;
    }
    if (savedHoverZoomEnabled !== null && savedHoverZoomEnabled !== undefined) {
      updates.hoverZoomEnabled = savedHoverZoomEnabled;
    }
    if (savedHoverZoomLevel !== null && savedHoverZoomLevel !== undefined) {
      updates.hoverZoomLevel = savedHoverZoomLevel;
    }
    if (savedHoverDefaultWidth !== null && savedHoverDefaultWidth !== undefined) {
      updates.hoverDefaultWidth = savedHoverDefaultWidth;
    }
    if (savedHoverDefaultHeight !== null && savedHoverDefaultHeight !== undefined) {
      updates.hoverDefaultHeight = savedHoverDefaultHeight;
    }
    // Sync default sizes to hover store
    hoverActions.setDefaultSize(
      savedHoverDefaultWidth ?? 1000,
      savedHoverDefaultHeight ?? 800
    );

    if (savedTheme) {
      updates.theme = savedTheme;
      document.documentElement.dataset.theme = savedTheme;
      // Persist to global store for VaultSelector
      getGlobalStore().then(s => s.set('last_theme', savedTheme)).catch(() => {});
    } else {
      updates.theme = 'dark';
      document.documentElement.dataset.theme = 'dark';
    }
    if (savedFont) {
      updates.font = savedFont;
      document.documentElement.dataset.font = savedFont;
    } else {
      updates.font = 'default';
      document.documentElement.dataset.font = 'default';
    }
    if (savedCustomFonts) {
      updates.customFonts = savedCustomFonts;
    } else {
      updates.customFonts = [];
    }
    if (savedSelectedCustomFont) {
      updates.selectedCustomFont = savedSelectedCustomFont;
      if (savedFont === 'custom' && savedSelectedCustomFont) {
        const customFont = savedCustomFonts?.find(f => f.name === savedSelectedCustomFont);
        if (customFont) {
          document.documentElement.style.setProperty('--custom-font-family', customFont.family);
        }
      }
    } else {
      updates.selectedCustomFont = null;
    }
    if (savedLanguage) {
      updates.language = savedLanguage;
      document.documentElement.lang = savedLanguage;
    } else {
      updates.language = 'ko';
      document.documentElement.lang = 'ko';
    }

    // New Phase 4 settings
    const savedFontSize = await vaultStore.get<number>('font_size');
    const savedLineHeight = await vaultStore.get<string>('line_height');
    const savedSpellCheck = await vaultStore.get<boolean>('spell_check');
    const savedAccentColor = await vaultStore.get<number>('accent_color');
    if (savedFontSize) {
      updates.fontSize = savedFontSize;
      document.documentElement.style.setProperty('--editor-font-size', `${savedFontSize}px`);
    }
    if (savedLineHeight) {
      updates.lineHeight = savedLineHeight;
      document.documentElement.style.setProperty('--editor-line-height', savedLineHeight);
    }
    const savedPaperStyle = await vaultStore.get<PaperStyle>('paper_style');
    if (savedPaperStyle && (savedPaperStyle === 'plain' || savedPaperStyle === 'ruled')) {
      updates.paperStyle = savedPaperStyle;
    }
    if (savedSpellCheck !== null && savedSpellCheck !== undefined) {
      updates.spellCheck = savedSpellCheck;
    }
    if (savedAccentColor !== null && savedAccentColor !== undefined) {
      updates.accentColor = savedAccentColor;
      const FOLDER_COLORS = ['#FF6B6B','#FF922B','#FCC419','#51CF66','#339AF0','#7950F2','#F06595','#20C997','#845EF7','#FD7E14'];
      const color = FOLDER_COLORS[savedAccentColor % FOLDER_COLORS.length];
      document.documentElement.style.setProperty('--c-blue', color);
      document.documentElement.style.setProperty('--color-accent', color);
    }

    const savedConfirmAttachmentDelete = await vaultStore.get<boolean>('confirm_attachment_delete');
    if (savedConfirmAttachmentDelete !== null && savedConfirmAttachmentDelete !== undefined) {
      updates.confirmAttachmentDelete = savedConfirmAttachmentDelete;
    }

    const savedGraphSettings = await vaultStore.get<GraphSettings>('graph_settings');
    if (savedGraphSettings) {
      updates.graphSettings = {
        ...DEFAULT_GRAPH_SETTINGS,
        ...savedGraphSettings,
        nodeColors: { ...DEFAULT_GRAPH_SETTINGS.nodeColors, ...(savedGraphSettings.nodeColors || {}) },
        physics: { ...DEFAULT_GRAPH_SETTINGS.physics, ...(savedGraphSettings.physics || {}) },
      };
    }

    set(updates);
  },

  loadGlobalSettings: async () => {
    const globalStore = await getGlobalStore();
    const savedDevMode = await globalStore.get<boolean>('dev_mode');
    if (savedDevMode !== null && savedDevMode !== undefined) {
      set({ devMode: savedDevMode });
    }
  },

  resetToDefaults: () => {
    set({
      theme: 'dark',
      font: 'default',
      customFonts: [],
      selectedCustomFont: null,
      language: 'ko',
      autoSaveDelay: 1000,
      toolbarDefaultCollapsed: true,
      hoverZoomEnabled: true,
      hoverZoomLevel: 100,
      hoverDefaultWidth: 1000,
      hoverDefaultHeight: 800,
      graphSettings: { ...DEFAULT_GRAPH_SETTINGS },
      fontSize: 15,
      lineHeight: '1.6',
      paperStyle: 'plain',
      spellCheck: false,
      accentColor: 4,
      confirmAttachmentDelete: true,
    });
  },
}));

// Selector hooks
export const useTheme = () => useSettingsStore((s) => s.theme);
export const useFont = () => useSettingsStore((s) => s.font);
export const useLanguage = () => useSettingsStore((s) => s.language);
export const useDevMode = () => useSettingsStore((s) => s.devMode);
export const useAutoSaveDelay = () => useSettingsStore((s) => s.autoSaveDelay);
export const useToolbarDefaultCollapsed = () => useSettingsStore((s) => s.toolbarDefaultCollapsed);
export const useGraphSettings = () => useSettingsStore((s) => s.graphSettings);
export const useFontSize = () => useSettingsStore((s) => s.fontSize);
export const useLineHeight = () => useSettingsStore((s) => s.lineHeight);
export const useSpellCheck = () => useSettingsStore((s) => s.spellCheck);
export const useAccentColor = () => useSettingsStore((s) => s.accentColor);

// Actions (stable references)
export const settingsActions = {
  setTheme: (theme: ThemeSetting, vaultPath: string | null) =>
    useSettingsStore.getState().setTheme(theme, vaultPath),
  setFont: (font: FontSetting, vaultPath: string | null, customFontName?: string) =>
    useSettingsStore.getState().setFont(font, vaultPath, customFontName),
  setLanguage: (lang: LanguageSetting, vaultPath: string | null) =>
    useSettingsStore.getState().setLanguage(lang, vaultPath),
  setDevMode: (enabled: boolean) =>
    useSettingsStore.getState().setDevMode(enabled),
  setAutoSaveDelay: (ms: number, vaultPath: string | null) =>
    useSettingsStore.getState().setAutoSaveDelay(ms, vaultPath),
  setToolbarDefaultCollapsed: (collapsed: boolean, vaultPath: string | null) =>
    useSettingsStore.getState().setToolbarDefaultCollapsed(collapsed, vaultPath),
  setHoverZoomEnabled: (enabled: boolean, vaultPath: string | null) =>
    useSettingsStore.getState().setHoverZoomEnabled(enabled, vaultPath),
  setHoverZoomLevel: (level: number, vaultPath: string | null) =>
    useSettingsStore.getState().setHoverZoomLevel(level, vaultPath),
  setHoverDefaultSize: (width: number, height: number, vaultPath: string | null) =>
    useSettingsStore.getState().setHoverDefaultSize(width, height, vaultPath),
  addCustomFont: (font: CustomFont, vaultPath: string | null) =>
    useSettingsStore.getState().addCustomFont(font, vaultPath),
  removeCustomFont: (name: string, vaultPath: string | null) =>
    useSettingsStore.getState().removeCustomFont(name, vaultPath),
  loadSettings: (vaultPath: string) =>
    useSettingsStore.getState().loadSettings(vaultPath),
  loadGlobalSettings: () =>
    useSettingsStore.getState().loadGlobalSettings(),
  setGraphSettings: (settings: Partial<GraphSettings>, vaultPath: string | null) =>
    useSettingsStore.getState().setGraphSettings(settings, vaultPath),
  resetToDefaults: () =>
    useSettingsStore.getState().resetToDefaults(),
  setFontSize: (size: number, vaultPath: string | null) =>
    useSettingsStore.getState().setFontSize(size, vaultPath),
  setLineHeight: (lh: string, vaultPath: string | null) =>
    useSettingsStore.getState().setLineHeight(lh, vaultPath),
  setSpellCheck: (enabled: boolean, vaultPath: string | null) =>
    useSettingsStore.getState().setSpellCheck(enabled, vaultPath),
  setAccentColor: (index: number, vaultPath: string | null) =>
    useSettingsStore.getState().setAccentColor(index, vaultPath),
  setConfirmAttachmentDelete: (enabled: boolean, vaultPath: string | null) =>
    useSettingsStore.getState().setConfirmAttachmentDelete(enabled, vaultPath),
};
