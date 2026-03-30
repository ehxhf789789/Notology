import { invoke } from '@tauri-apps/api/core';

export interface SyncStatus {
  type: 'Disconnected' | 'Idle' | 'Syncing' | 'Offline' | 'Conflict' | 'Error';
  progress?: number;
  current_file?: string;
  files?: string[];
  message?: string;
}

export interface SyncConfigPublic {
  url: string;
  username: string;
  remote_base: string;
  enabled: boolean;
}

export type ConflictChoice =
  | 'KeepLocal'
  | 'KeepRemote'
  | 'KeepBoth'
  | { Custom: { content: string } };

export const syncCommands = {
  connect: (url: string, username: string, password: string, vaultPath: string, remoteBase?: string) =>
    invoke<boolean>('sync_connect', { url, username, password, vaultPath, remoteBase: remoteBase ?? null }),

  disconnect: (vaultPath: string) =>
    invoke<void>('sync_disconnect', { vaultPath }),

  getStatus: () =>
    invoke<SyncStatus>('sync_get_status'),

  getConfig: () =>
    invoke<SyncConfigPublic | null>('sync_get_config'),

  syncNow: () =>
    invoke<void>('sync_now'),

  resolveConflict: (filePath: string, choice: ConflictChoice) =>
    invoke<void>('sync_resolve_conflict', { filePath, choice }),

  init: (vaultPath: string) =>
    invoke<void>('sync_init', { vaultPath }),

  onFileSaved: (filePath: string) =>
    invoke<void>('sync_on_file_saved', { filePath }),

  onFileDeleted: (filePath: string) =>
    invoke<void>('sync_on_file_deleted', { filePath }),

  getRemoteFile: (filePath: string) =>
    invoke<string>('sync_get_remote_file', { filePath }),

  startMonitor: () =>
    invoke<void>('sync_start_monitor'),

  flushOnExit: () =>
    invoke<void>('sync_flush_on_exit'),

  onForeground: () =>
    invoke<void>('sync_on_foreground'),

  openVaultSelector: () =>
    invoke<void>('sync_open_vault_selector'),

  closeVaultSelector: () =>
    invoke<void>('sync_close_vault_selector'),

  browseFolder: (url: string, username: string, password: string, path: string) =>
    invoke<RemoteFolderEntry[]>('sync_browse_folder', { url, username, password, path }),

  checkVault: (url: string, username: string, password: string, path: string) =>
    invoke<boolean>('sync_check_vault', { url, username, password, path }),
};

export interface RemoteFolderEntry {
  name: string;
  path: string;
  modified_at: string;
}

// ============================================================
// NAS Connection History
// ============================================================

export interface NasConnections {
  connections: NasConnection[];
  last_active: { connection_id: string; remote_path: string } | null;
}

export interface NasConnection {
  id: string;
  url: string;
  username: string;
  password: string;
  display_name: string;
  vaults: NasVaultEntry[];
}

export interface NasVaultEntry {
  remote_path: string;
  local_cache_path: string;
  name: string;
  last_synced: string | null;
  auto_sync: boolean;
}

export const nasCommands = {
  loadConnections: () =>
    invoke<NasConnections>('sync_load_connections'),

  registerConnection: (url: string, username: string, password: string, displayName: string) =>
    invoke<string>('sync_register_connection', { url, username, password, displayName }),

  removeConnection: (connectionId: string) =>
    invoke<void>('sync_remove_connection', { connectionId }),

  createVault: (url: string, username: string, password: string, connectionId: string, parentPath: string, vaultName: string) =>
    invoke<NasVaultEntry>('sync_create_vault', { url, username, password, connectionId, parentPath, vaultName }),

  openVault: (url: string, username: string, password: string, connectionId: string, remotePath: string) =>
    invoke<NasVaultEntry>('sync_open_vault', { url, username, password, connectionId, remotePath }),

  initialDownload: (url: string, username: string, password: string, remotePath: string, localPath: string) =>
    invoke<number>('sync_initial_download', { url, username, password, remotePath, localPath }),

  setLastActive: (connectionId: string, remotePath: string) =>
    invoke<void>('sync_set_last_active', { connectionId, remotePath }),

  removeVault: (connectionId: string, remotePath: string, deleteLocal: boolean) =>
    invoke<void>('sync_remove_vault', { connectionId, remotePath, deleteLocal }),

  updateVaultName: (connectionId: string, remotePath: string, newName: string) =>
    invoke<void>('sync_update_vault_name', { connectionId, remotePath, newName }),

  renameVault: (url: string, username: string, password: string, connectionId: string, remotePath: string, newName: string) =>
    invoke<string>('sync_rename_vault', { url, username, password, connectionId, remotePath, newName }),

  checkPortChange: (url: string, username: string) =>
    invoke<PortChangeInfo | null>('sync_check_port_change', { url, username }),

  migratePort: (oldConnectionId: string, newUrl: string, newUsername: string, newPassword: string) =>
    invoke<string>('sync_migrate_port', { oldConnectionId, newUrl, newUsername, newPassword }),
};

export interface PortChangeInfo {
  old_connection_id: string;
  old_url: string;
  vault_count: number;
  vault_names: string[];
}
