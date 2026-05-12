// Tauri command wrappers for WebDAV connection management
import { invoke } from '@tauri-apps/api/core';
import type {
  ConnectionTestResult,
  DeviceInfo,
  WebDavStatus,
  DiscoveredVault,
  VaultDiscoveryCache,
  VaultOpenResult,
} from './types';

// ── Auth ────────────────────────────────────

export async function testConnection(
  url: string,
  username: string,
  password: string,
): Promise<ConnectionTestResult> {
  return invoke('webdav_test_connection', { url, username, password });
}

export async function login(
  url: string,
  username: string,
  password: string,
  label: string,
  rememberPassword: boolean,
): Promise<DeviceInfo> {
  return invoke('webdav_login', { url, username, password, label, rememberPassword });
}

export async function logout(removeFromNas: boolean): Promise<void> {
  return invoke('webdav_logout', { removeFromNas });
}

export async function getStatus(): Promise<WebDavStatus> {
  return invoke('webdav_get_status');
}

// ── Devices ─────────────────────────────────

export async function listConnectedDevices(): Promise<DeviceInfo[]> {
  return invoke('list_connected_devices');
}

export async function deleteConnectedDevice(deviceId: string): Promise<void> {
  return invoke('delete_connected_device', { deviceId });
}

// ── Vault Discovery ─────────────────────────

export async function listDiscoveredVaults(): Promise<VaultDiscoveryCache | null> {
  return invoke('sync_v2_list_discovered_vaults');
}

export async function refreshVaultDiscovery(scanRoot: string): Promise<VaultDiscoveryCache> {
  return invoke('sync_v2_refresh_vault_discovery', { scanRoot });
}

export async function openVaultFromPath(remotePath: string): Promise<VaultOpenResult> {
  return invoke('sync_v2_open_vault_from_path', { remotePath });
}

export async function createVault(remotePath: string): Promise<VaultOpenResult> {
  return invoke('sync_v2_create_vault', { remotePath });
}

// ── NAS folder browser ─────────────────────

export interface NasFolderEntry {
  name: string;
  path: string;
  isCollection: boolean;
  isVault: boolean;
}

export interface NasFolderListing {
  path: string;
  children: NasFolderEntry[];
}

/**
 * Browse a NAS directory at `path` and return its immediate children.
 * Each subfolder is probed for a `.notology/` marker so vaults stand out
 * in the picker.
 */
export async function browseNasFolder(path: string): Promise<NasFolderListing> {
  return invoke('sync_v2_browse_nas_folder', { path });
}

// ── Remote import ──────────────────────────

export interface ImportReport {
  scannedDirs: number;
  foundMdFiles: number;
  alreadyRegistered: number;
  newlyRegistered: number;
  /** NAS .md files where we PUT id-injected content back (idempotency). */
  idWrittenBack: number;
  skippedArtifacts: number;
  errors: string[];
}

/**
 * Scan NAS for unregistered .md files and (if dryRun=false) register them
 * in the sync model. Resulting refs propagate to NAS on next sync cycle.
 */
export async function scanUnregisteredNotes(dryRun: boolean): Promise<ImportReport> {
  return invoke('remote_import_scan', { dryRun });
}
