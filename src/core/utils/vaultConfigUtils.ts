import { fileCommands } from '../services/tauriCommands';
import { join } from '@tauri-apps/api/path';
import { load, type Store } from '@tauri-apps/plugin-store';
import yaml from 'js-yaml';
import type { ContainerConfig, FolderStatusConfig, FolderNoteTemplate, NoteTemplate } from '../types';
import type { ShortcutBinding } from './shortcuts';

/**
 * Vault configuration stored in .notology/vault-config.yaml
 * This makes folder configurations portable across devices
 */
export interface VaultConfig {
  containerConfigs: Record<string, ContainerConfig>;
  folderStatuses: Record<string, FolderStatusConfig>;
  containerOrder?: string[]; // Custom container order (array of container names)
  customTemplates?: NoteTemplate[];
  enabledTemplateIds?: string[];
  defaultTemplateType?: 'A' | 'B';
  folderTemplates?: FolderNoteTemplate[];
  customShortcuts?: ShortcutBinding[];
  _meta?: {
    version: string;
    lastModified: string;
  };
}

let cachedVaultConfig: VaultConfig | null = null;
let cachedVaultPath: string | null = null;
let migratedConfigThisSession = false;

// Self-save tracking: prevent self-triggering feedback loop
let lastSelfSaveTime = 0;

/**
 * Check if vault-config.yaml was just saved by this app instance (within 2 seconds).
 * Used by the file watcher to skip reloading our own saves.
 */
export function wasSelfSave(): boolean {
  return Date.now() - lastSelfSaveTime < 2000;
}

// Debounce support for saveVaultConfig
let pendingSaveTimer: ReturnType<typeof setTimeout> | null = null;
let pendingSaveConfig: VaultConfig | null = null;
let pendingSaveVaultPath: string | null = null;
let pendingSaveResolvers: Array<{ resolve: () => void; reject: (e: unknown) => void }> = [];

/**
 * Convert an absolute path to a relative path (relative to vault root).
 * Uses forward slashes for cross-platform portability.
 */
function toRelativePath(absPath: string, vaultPath: string): string {
  const normalizedAbs = absPath.replace(/\\/g, '/');
  const normalizedVault = vaultPath.replace(/\\/g, '/');
  if (normalizedAbs.toLowerCase().startsWith(normalizedVault.toLowerCase())) {
    const rel = normalizedAbs.slice(normalizedVault.length);
    // Remove leading slash
    return rel.startsWith('/') ? rel.slice(1) : rel;
  }
  // Already relative or different root — return as-is with forward slashes
  return normalizedAbs;
}

/**
 * Convert a relative path to an absolute path (prepend vault root).
 * Adapts to OS path separator.
 */
function toAbsolutePath(relPath: string, vaultPath: string): string {
  const normalizedRel = relPath.replace(/\\/g, '/');
  // Detect if it's already absolute (has drive letter or starts with /)
  if (/^[A-Za-z]:/.test(normalizedRel) || normalizedRel.startsWith('/')) {
    // Already absolute — convert to relative first for portability
    return toAbsoluteFromRelative(toRelativePath(relPath, vaultPath), vaultPath);
  }
  return toAbsoluteFromRelative(normalizedRel, vaultPath);
}

function toAbsoluteFromRelative(relPath: string, vaultPath: string): string {
  // Use OS-native separator (detect from vaultPath)
  const sep = vaultPath.includes('\\') ? '\\' : '/';
  const normalizedVault = vaultPath.replace(/[/\\]+$/, '');
  const normalizedRel = relPath.replace(/\//g, sep);
  return `${normalizedVault}${sep}${normalizedRel}`;
}

/**
 * Convert Record keys from relative paths (stored in YAML) to absolute paths (used in memory)
 */
function convertKeysToAbsolute<T>(record: Record<string, T>, vaultPath: string): Record<string, T> {
  const result: Record<string, T> = {};
  for (const [key, value] of Object.entries(record)) {
    result[toAbsolutePath(key, vaultPath)] = value;
  }
  return result;
}

/**
 * Convert Record keys from absolute paths (used in memory) to relative paths (stored in YAML)
 */
function convertKeysToRelative<T>(record: Record<string, T>, vaultPath: string): Record<string, T> {
  const result: Record<string, T> = {};
  for (const [key, value] of Object.entries(record)) {
    result[toRelativePath(key, vaultPath)] = value;
  }
  return result;
}

// Hash function for vault path (must match appStore)
function hashVaultPath(vaultPath: string): string {
  const encoded = btoa(unescape(encodeURIComponent(vaultPath)));
  return encoded.replace(/[/+=]/g, '_').slice(0, 64);
}

// Get vault-specific Tauri store (for migration)
async function getVaultStore(vaultPath: string): Promise<Store> {
  const hash = hashVaultPath(vaultPath);
  return await load(`vault_${hash}.json`, { autoSave: true, defaults: {} });
}

/**
 * Load vault config from .notology/vault-config.yaml
 * Automatically migrates from Tauri Store on first load
 */
export async function loadVaultConfig(vaultPath: string): Promise<VaultConfig> {
  if (cachedVaultConfig) {
    return cachedVaultConfig;
  }

  try {
    const configPath = await join(vaultPath, '.notology', 'vault-config.yaml');

    // Ensure .notology directory exists
    const metaPath = await join(vaultPath, '.notology');
    try {
      await fileCommands.ensureDirectory(metaPath);
    } catch {
      // Directory might already exist
    }

    let config: VaultConfig;

    try {
      const yamlContent = await fileCommands.readTextFile(configPath);
      config = yaml.load(yamlContent) as VaultConfig;
      if (!config.containerConfigs) config.containerConfigs = {};
      if (!config.folderStatuses) config.folderStatuses = {};
    } catch {
      // File doesn't exist, create empty config
      config = {
        containerConfigs: {},
        folderStatuses: {},
      };
    }

    // Convert relative path keys (stored in YAML) → absolute path keys (used in memory)
    config.containerConfigs = convertKeysToAbsolute(config.containerConfigs, vaultPath);
    config.folderStatuses = convertKeysToAbsolute(config.folderStatuses, vaultPath);

    // Auto-migrate from Tauri Store (only once per session)
    if (!migratedConfigThisSession) {
      migratedConfigThisSession = true;
      const migrated = await migrateConfigFromTauriStore(vaultPath, config);
      if (migrated) {
        console.log('[loadVaultConfig] Migrated container configs from Tauri Store');
      }
    }

    cachedVaultConfig = config;
    cachedVaultPath = vaultPath;
    return config;
  } catch (error) {
    console.error('[loadVaultConfig] Failed to load vault config:', error);
    return {
      containerConfigs: {},
      folderStatuses: {},
    };
  }
}

/**
 * Migrate container configs and folder statuses from Tauri Store to vault
 */
async function migrateConfigFromTauriStore(
  vaultPath: string,
  config: VaultConfig
): Promise<boolean> {
  try {
    const vaultStore = await getVaultStore(vaultPath);
    let anyMigrated = false;

    // Migrate container configs
    const storedContainerConfigs = await vaultStore.get<Record<string, ContainerConfig>>('container_configs');
    if (storedContainerConfigs) {
      for (const [path, containerConfig] of Object.entries(storedContainerConfigs)) {
        if (!config.containerConfigs[path]) {
          config.containerConfigs[path] = containerConfig;
          anyMigrated = true;
        }
      }
    }

    // Migrate folder statuses
    const storedFolderStatuses = await vaultStore.get<Record<string, FolderStatusConfig>>('folder_statuses');
    if (storedFolderStatuses) {
      for (const [path, statusConfig] of Object.entries(storedFolderStatuses)) {
        if (!config.folderStatuses[path]) {
          config.folderStatuses[path] = statusConfig;
          anyMigrated = true;
        }
      }
    }

    // Migrate custom templates (only custom ones, not built-in)
    const storedNoteTemplates = await vaultStore.get<NoteTemplate[]>('note_templates');
    if (storedNoteTemplates && storedNoteTemplates.length > 0) {
      const customTemplates = storedNoteTemplates.filter(t => !t.id.startsWith('note-') || t.id.startsWith('note-custom-'));
      if (customTemplates.length > 0) {
        if (!config.customTemplates) config.customTemplates = [];
        const existingIds = new Set(config.customTemplates.map(t => t.id));
        const newTemplates = customTemplates.filter(t => !existingIds.has(t.id));
        if (newTemplates.length > 0) {
          config.customTemplates.push(...newTemplates);
          anyMigrated = true;
        }
      }
    }

    // Migrate enabled template IDs
    const storedEnabledIds = await vaultStore.get<string[]>('enabled_template_ids');
    if (storedEnabledIds && !config.enabledTemplateIds) {
      config.enabledTemplateIds = storedEnabledIds;
      anyMigrated = true;
    }

    // Migrate default template type
    const storedDefaultType = await vaultStore.get<'A' | 'B'>('default_template_type');
    if (storedDefaultType && !config.defaultTemplateType) {
      config.defaultTemplateType = storedDefaultType;
      anyMigrated = true;
    }

    // Migrate folder templates (custom only)
    const storedFolderTemplates = await vaultStore.get<FolderNoteTemplate[]>('templates');
    if (storedFolderTemplates && storedFolderTemplates.length > 0 && !config.folderTemplates) {
      config.folderTemplates = storedFolderTemplates.filter(t => t.type === 'B');
      anyMigrated = true;
    }

    // Migrate custom shortcuts
    const storedShortcuts = await vaultStore.get<ShortcutBinding[]>('custom_shortcuts');
    if (storedShortcuts && storedShortcuts.length > 0 && !config.customShortcuts) {
      config.customShortcuts = storedShortcuts;
      anyMigrated = true;
    }

    // Only save if we actually migrated new data
    if (anyMigrated) {
      console.log('[migrateConfigFromTauriStore] Migrated data from Tauri Store');
      await saveVaultConfig(vaultPath, config);
      return true;
    }

    return false;
  } catch (error) {
    console.error('[migrateConfigFromTauriStore] Migration failed:', error);
    return false;
  }
}

/**
 * Save vault config to .notology/vault-config.yaml
 * Uses optimistic locking: reads the disk version before saving and merges
 * if another device (via Synology sync) modified it since our last read.
 * Debounced: rapid successive calls are batched into one write (500ms).
 */
export async function saveVaultConfig(vaultPath: string, config: VaultConfig): Promise<void> {
  // Store the latest config to save
  pendingSaveConfig = config;
  pendingSaveVaultPath = vaultPath;

  return new Promise<void>((resolve, reject) => {
    pendingSaveResolvers.push({ resolve, reject });

    // Clear previous timer and set a new one
    if (pendingSaveTimer) clearTimeout(pendingSaveTimer);
    pendingSaveTimer = setTimeout(() => {
      const cfg = pendingSaveConfig!;
      const vp = pendingSaveVaultPath!;
      const resolvers = [...pendingSaveResolvers];
      pendingSaveConfig = null;
      pendingSaveVaultPath = null;
      pendingSaveResolvers = [];
      pendingSaveTimer = null;

      flushSaveVaultConfig(vp, cfg)
        .then(() => resolvers.forEach(r => r.resolve()))
        .catch(e => resolvers.forEach(r => r.reject(e)));
    }, 500);
  });
}

/**
 * Immediately flush a pending save (called by debounce timer)
 */
async function flushSaveVaultConfig(vaultPath: string, config: VaultConfig): Promise<void> {
  try {
    const configPath = await join(vaultPath, '.notology', 'vault-config.yaml');

    // Optimistic locking: check if disk version differs from our cached version
    try {
      const diskYaml = await fileCommands.readTextFile(configPath);
      const diskConfig = yaml.load(diskYaml) as VaultConfig | null;
      if (diskConfig?._meta?.version && cachedVaultConfig?._meta?.version &&
          diskConfig._meta.version !== cachedVaultConfig._meta.version) {
        // Another device modified the config — merge key-value maps
        // Disk config has relative keys, convert to absolute for comparison
        const diskContainerAbs = convertKeysToAbsolute(diskConfig.containerConfigs || {}, vaultPath);
        const diskStatusAbs = convertKeysToAbsolute(diskConfig.folderStatuses || {}, vaultPath);
        console.log('[saveVaultConfig] Disk version differs, merging configs');
        // Merge containerConfigs (our changes win for same keys)
        for (const [key, val] of Object.entries(diskContainerAbs)) {
          if (!(key in config.containerConfigs)) {
            config.containerConfigs[key] = val;
          }
        }
        // Merge folderStatuses (our changes win for same keys)
        for (const [key, val] of Object.entries(diskStatusAbs)) {
          if (!(key in config.folderStatuses)) {
            config.folderStatuses[key] = val;
          }
        }
        // Merge customTemplates by id
        if (diskConfig.customTemplates && diskConfig.customTemplates.length > 0) {
          if (!config.customTemplates) config.customTemplates = [];
          const existingIds = new Set(config.customTemplates.map(t => t.id));
          for (const t of diskConfig.customTemplates) {
            if (!existingIds.has(t.id)) {
              config.customTemplates.push(t);
            }
          }
        }
        // Merge folderTemplates by id
        if (diskConfig.folderTemplates && diskConfig.folderTemplates.length > 0) {
          if (!config.folderTemplates) config.folderTemplates = [];
          const existingIds = new Set(config.folderTemplates.map(t => t.id));
          for (const t of diskConfig.folderTemplates) {
            if (!existingIds.has(t.id)) {
              config.folderTemplates.push(t);
            }
          }
        }
        // Merge customShortcuts by id
        if (diskConfig.customShortcuts && diskConfig.customShortcuts.length > 0) {
          if (!config.customShortcuts) config.customShortcuts = [];
          const existingIds = new Set(config.customShortcuts.map(s => s.id));
          for (const s of diskConfig.customShortcuts) {
            if (!existingIds.has(s.id)) {
              config.customShortcuts.push(s);
            }
          }
        }
      }
    } catch {
      // File doesn't exist or can't be read — proceed with our config
    }

    // Update metadata
    config._meta = {
      version: `${Date.now()}-${Math.random().toString(36).substring(2, 8)}`,
      lastModified: new Date().toISOString(),
    };

    // Convert absolute path keys → relative for portable storage
    const configToWrite: VaultConfig = {
      ...config,
      containerConfigs: convertKeysToRelative(config.containerConfigs, vaultPath),
      folderStatuses: convertKeysToRelative(config.folderStatuses, vaultPath),
    };

    const yamlContent = yaml.dump(configToWrite, { lineWidth: -1, noRefs: true });

    // Mark self-save BEFORE writing to prevent feedback loop
    lastSelfSaveTime = Date.now();

    await fileCommands.writeFile(configPath, null, yamlContent);

    // Cache with absolute keys (in-memory format)
    cachedVaultConfig = config;
    cachedVaultPath = vaultPath;
  } catch (error) {
    console.error('[saveVaultConfig] Failed to save vault config:', error);
    throw error;
  }
}

/**
 * Update container config for a specific path
 */
export async function updateContainerConfig(
  vaultPath: string,
  containerPath: string,
  containerConfig: ContainerConfig
): Promise<void> {
  const config = await loadVaultConfig(vaultPath);
  config.containerConfigs[containerPath] = containerConfig;
  await saveVaultConfig(vaultPath, config);
}

/**
 * Update folder status for a specific path
 */
export async function updateFolderStatus(
  vaultPath: string,
  folderPath: string,
  statusConfig: FolderStatusConfig
): Promise<void> {
  const config = await loadVaultConfig(vaultPath);
  config.folderStatuses[folderPath] = statusConfig;
  await saveVaultConfig(vaultPath, config);
}

/**
 * Update custom templates (portable across devices)
 */
export async function updateCustomTemplates(
  vaultPath: string,
  templates: NoteTemplate[]
): Promise<void> {
  const config = await loadVaultConfig(vaultPath);
  config.customTemplates = templates;
  await saveVaultConfig(vaultPath, config);
}

/**
 * Get custom templates from vault config
 */
export async function getCustomTemplates(vaultPath: string): Promise<NoteTemplate[]> {
  const config = await loadVaultConfig(vaultPath);
  return config.customTemplates || [];
}

/**
 * Update enabled template IDs
 */
export async function updateEnabledTemplateIds(
  vaultPath: string,
  ids: string[]
): Promise<void> {
  const config = await loadVaultConfig(vaultPath);
  config.enabledTemplateIds = ids;
  await saveVaultConfig(vaultPath, config);
}

/**
 * Update default template type
 */
export async function updateDefaultTemplateType(
  vaultPath: string,
  type: 'A' | 'B'
): Promise<void> {
  const config = await loadVaultConfig(vaultPath);
  config.defaultTemplateType = type;
  await saveVaultConfig(vaultPath, config);
}

/**
 * Update folder templates (custom only)
 */
export async function updateFolderTemplates(
  vaultPath: string,
  templates: FolderNoteTemplate[]
): Promise<void> {
  const config = await loadVaultConfig(vaultPath);
  config.folderTemplates = templates.filter(t => t.type === 'B');
  await saveVaultConfig(vaultPath, config);
}

/**
 * Update custom shortcuts
 */
export async function updateCustomShortcuts(
  vaultPath: string,
  shortcuts: ShortcutBinding[]
): Promise<void> {
  const config = await loadVaultConfig(vaultPath);
  config.customShortcuts = shortcuts;
  await saveVaultConfig(vaultPath, config);
}

/**
 * Update container order (array of container names for custom sorting)
 */
export async function updateContainerOrder(
  vaultPath: string,
  order: string[]
): Promise<void> {
  const config = await loadVaultConfig(vaultPath);
  config.containerOrder = order;
  await saveVaultConfig(vaultPath, config);
}

/**
 * Clear cached vault config (call when vault changes)
 */
export function clearVaultConfigCache(): void {
  cachedVaultConfig = null;
  cachedVaultPath = null;
}
