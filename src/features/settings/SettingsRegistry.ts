import type { ComponentType } from 'react';

export interface SettingsTabPlugin {
  id: string;
  label: string;
  icon?: string;
  component: ComponentType;
  order?: number; // Lower = earlier. Default tabs are 0-40.
}

const plugins: SettingsTabPlugin[] = [];
const listeners: (() => void)[] = [];
// Stable snapshot for useSyncExternalStore
let snapshot: SettingsTabPlugin[] = [];

export const SettingsRegistry = {
  register(plugin: SettingsTabPlugin) {
    if (plugins.some(p => p.id === plugin.id)) return;
    plugins.push(plugin);
    plugins.sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
    snapshot = [...plugins];
    listeners.forEach(fn => fn());
  },

  unregister(id: string) {
    const idx = plugins.findIndex(p => p.id === id);
    if (idx !== -1) {
      plugins.splice(idx, 1);
      snapshot = [...plugins];
      listeners.forEach(fn => fn());
    }
  },

  getPlugins(): SettingsTabPlugin[] {
    return snapshot;
  },

  subscribe(fn: () => void): () => void {
    listeners.push(fn);
    return () => {
      const idx = listeners.indexOf(fn);
      if (idx !== -1) listeners.splice(idx, 1);
    };
  },
};
