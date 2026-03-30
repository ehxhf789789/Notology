/**
 * Cloud Provider abstraction — v4.0 Extension Point
 * Currently only WebDAV is implemented.
 */

export type ProviderType = 'webdav' | 'google-drive' | 'dropbox' | 'onedrive';

export interface CloudProviderConfig {
  type: ProviderType;
  displayName: string;
  // WebDAV-specific
  url?: string;
  username?: string;
  password?: string;
  // OAuth-specific (future)
  accessToken?: string;
  refreshToken?: string;
}

export const SUPPORTED_PROVIDERS: { type: ProviderType; label: string; enabled: boolean }[] = [
  { type: 'webdav', label: 'WebDAV', enabled: true },
  { type: 'google-drive', label: 'Google Drive', enabled: false },
  { type: 'dropbox', label: 'Dropbox', enabled: false },
  { type: 'onedrive', label: 'OneDrive', enabled: false },
];
