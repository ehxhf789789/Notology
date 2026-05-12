// Connection module TypeScript types (mirrors Rust structs)

export type DeviceStatus = 'Online' | 'Offline';

export interface DeviceInfo {
  deviceId: string;
  hostname: string;
  os: string;
  machineId: string;
  appVersion: string;
  firstLoginAt: string;
  lastLoginAt: string;
  sessionCount: number;
  status: DeviceStatus;
  loginAt: string;
  lastSeenAt: string;
  logoutAt: string | null;
}

export type ConnectionTestResult =
  | 'Success'
  | 'InvalidCredentials'
  | { NetworkError: string }
  | { ServerError: string };

export interface WebDavStatus {
  connected: boolean;
  url: string | null;
  username: string | null;
  label: string | null;
  device: DeviceInfo | null;
}

export interface DiscoveredVault {
  name: string;
  remotePath: string;
  modifiedAt: string;
  verified: boolean;
}

export interface VaultDiscoveryCache {
  vaults: DiscoveredVault[];
  scannedAt: string;
  nasUrl: string;
  scanRoot: string;
}

export interface VaultOpenResult {
  name: string;
  remotePath: string;
  localPath: string;
}
