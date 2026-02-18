import { create } from 'zustand';
import { emit } from '@tauri-apps/api/event';
import { hoverActions } from './hoverStore';
import { getVaultStore, getGlobalStore } from '../persistenceUtils';
import type { GraphSettings } from '../../types';
import { DEFAULT_GRAPH_SETTINGS } from '../../types';

export type ThemeSetting = 'dark' | 'light' | 'system';
export type FontSetting = 'default' | 'nanum' | 'noto' | 'malgun' | 'custom';
export type LanguageSetting = 'ko' | 'en';

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

  // Load from persisted storage
  loadSettings: (vaultPath: string) => Promise<void>;
  loadGlobalSettings: () => Promise<void>;
  resetToDefaults: () => void;
}

export const useSettingsStore = create<SettingsState>()((set, get) => ({
  // Initial state
  theme: 'dark',
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

  // Actions
  setTheme: (newTheme, vaultPath) => {
    set({ theme: newTheme });
    document.documentElement.dataset.theme = newTheme;
    // Broadcast theme change to all hover windows
    emit('theme-changed', { theme: newTheme }).catch(() => {});
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
};
