import { load, type Store } from '@tauri-apps/plugin-store';

// Global store for app-wide settings (vault_path, recent_vaults, dev_mode)
let globalStoreInstance: Store | null = null;

export async function getGlobalStore(): Promise<Store> {
  if (!globalStoreInstance) {
    globalStoreInstance = await load('settings.json', { autoSave: true, defaults: {} });
  }
  return globalStoreInstance;
}

// Hash function for vault path to create safe filename
function hashVaultPath(vaultPath: string): string {
  const encoded = btoa(unescape(encodeURIComponent(vaultPath)));
  return encoded.replace(/[/+=]/g, '_').slice(0, 64);
}

// Vault-specific store cache
const vaultStoreCache = new Map<string, Store>();

export async function getVaultStore(vaultPath: string): Promise<Store> {
  const hash = hashVaultPath(vaultPath);
  if (vaultStoreCache.has(hash)) {
    return vaultStoreCache.get(hash)!;
  }
  const store = await load(`vault_${hash}.json`, { autoSave: true, defaults: {} });
  vaultStoreCache.set(hash, store);
  return store;
}
