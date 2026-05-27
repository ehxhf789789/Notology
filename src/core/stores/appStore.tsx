/**
 * AppProvider - Thin shell for initialization and event listeners.
 *
 * All state is managed in individual Zustand stores:
 * - fileTreeStore: vaultPath, fileTree, selectedContainer
 * - hoverStore: hover windows
 * - refreshStore: search/calendar/ontology refresh triggers, searchReady
 * - modalStore: all modal states
 * - settingsStore: theme, font, language, dev settings
 * - templateStore: note/folder templates, shortcuts
 * - uiStore: showSearch, showCalendar, showSidebar, showHoverPanel, animation states
 * - vaultConfigStore: containerConfigs, folderStatuses, recentVaults, NAS state
 *
 * Complex cross-store actions are in appActions.ts
 */
import { useEffect, type ReactNode } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { vaultCommands } from '../services/tauriCommands';
import { hoverActions } from '../../features/hover-windows/stores/hoverStore';
import { useFileTreeStore, fileTreeActions } from './fileTreeStore';
import { useRefreshStore, refreshActions } from './refreshStore';
import { modalActions } from '../../features/modals/stores/modalStore';
import { templateActions } from '../../features/templates/stores/templateStore';
import { vaultConfigActions } from '../../features/vault-config/stores/vaultConfigStore';
import { loadVaultConfig, clearVaultConfigCache, wasSelfSave } from '../utils/vaultConfigUtils';
import { filterExternalChanges, isSyncActive } from '../utils/selfSaveTracker';
import { initializeApp } from './appActions';
import { initContentCacheSync, cleanupContentCacheSync } from '../../features/content-cache/stores/contentCacheStore';

// Re-export types for backward compatibility
export type { TitleInputResult } from '../../features/modals/stores/modalStore';
export type { ThemeSetting, FontSetting, LanguageSetting, CustomFont } from './settingsStore';
export type { RecentVault } from '../../features/vault-config/stores/vaultConfigStore';

export function AppInitializer({ children }: { children: ReactNode }) {
  // Subscribe to values needed for event listener setup
  const vaultPath = useFileTreeStore((s) => s.vaultPath);
  const searchReady = useRefreshStore((s) => s.searchReady);

  // Initialize app on mount
  useEffect(() => {
    initializeApp();
    // Initialize cross-window cache sync for multi-window mode
    initContentCacheSync();
    return () => {
      cleanupContentCacheSync();
    };
  }, []);

  // Listen for Synology Drive sync events from Rust file watcher
  useEffect(() => {
    if (!vaultPath || !searchReady) return;
    const unlisteners: UnlistenFn[] = [];

    const setup = async () => {
      // File changed externally (Synology sync or other editor)
      unlisteners.push(await listen<{ paths: string[] }>('vault-files-changed', (e) => {
        fileTreeActions.refreshFileTree();
        // Filter out:
        // 1. .notology internal files (sync metadata, base snapshots)
        // 2. Files changed during active sync (bidirectional_sync writes files)
        // 3. Files that were just saved by this app (self-save tracker)
        const userFiles = e.payload.paths.filter(p => !p.includes('.notology'));
        if (!isSyncActive()) {
          const externallyChanged = filterExternalChanges(userFiles);
          if (externallyChanged.length > 0) {
            hoverActions.refreshForFiles(externallyChanged);
          }
        }
        refreshActions.incrementSearchRefresh();
        // If vault-config.yaml changed externally, reload configs
        if (e.payload.paths.some(p => p.endsWith('vault-config.yaml')) && !wasSelfSave()) {
          clearVaultConfigCache();
          if (vaultPath) {
            loadVaultConfig(vaultPath).then(config => {
              templateActions.loadTemplates(vaultPath, config);
              vaultConfigActions.setContainerConfigs(config.containerConfigs || {});
              vaultConfigActions.setFolderStatuses(config.folderStatuses || {});
              vaultConfigActions.setContainerOrder(config.containerOrder || []);
              console.log('[Sync] vault-config.yaml reloaded from external change');
            }).catch(() => {});
          }
        }
      }));

      // File deleted externally
      unlisteners.push(await listen<{ paths: string[] }>('vault-file-deleted', () => {
        fileTreeActions.refreshFileTree();
        refreshActions.incrementSearchRefresh();
      }));

      // Synology Drive conflict file detected
      unlisteners.push(await listen<{ conflict_path: string; original_path: string }>(
        'synology-conflict-detected', (e) => {
          const name = e.payload.original_path.split(/[/\\]/).pop() || '';
          const conflictName = e.payload.conflict_path.split(/[/\\]/).pop() || '';
          modalActions.showAlertModal(
            '\uB3D9\uAE30\uD654 \uCDA9\uB3CC \uAC10\uC9C0',
            `\uD30C\uC77C "${name}"\uC5D0 \uB3D9\uAE30\uD654 \uCDA9\uB3CC\uC774 \uBC1C\uC0DD\uD588\uC2B5\uB2C8\uB2E4.\n\nSynology Drive\uAC00 \uCDA9\uB3CC \uBC84\uC804\uC744 \uBCC4\uB3C4 \uD30C\uC77C\uB85C \uBCF4\uAD00\uD588\uC2B5\uB2C8\uB2E4:\n\u2192 ${conflictName}\n\n\uC6D0\uBCF8\uACFC \uCDA9\uB3CC \uD30C\uC77C\uC744 \uBE44\uAD50\uD558\uC5EC \uC218\uB3D9\uC73C\uB85C \uBCD1\uD569\uD574 \uC8FC\uC138\uC694.`
          );
        }
      ));

      // Bulk sync detection
      unlisteners.push(await listen<{ syncing: boolean; file_count: number }>(
        'synology-bulk-sync', (e) => {
          vaultConfigActions.setIsBulkSyncing(e.payload.syncing);
          if (e.payload.syncing) {
            console.log(`[Sync] Bulk sync detected: ${e.payload.file_count} files changing`);
          } else {
            console.log('[Sync] Bulk sync completed, vault stabilized');
          }
        }
      ));

      // Detect NAS platform
      vaultCommands.detectNasPlatform(vaultPath).then((info) => {
        vaultConfigActions.setIsNasSynced(info.is_nas_synced);
        vaultConfigActions.setNasPlatform(info.platform);
        if (info.is_nas_synced) {
          console.log(`[NAS] Synology Drive detected. Root: ${info.synology_root}`);
        }
      }).catch(() => {});

      // Clean up old backups
      vaultCommands.cleanupOldBackups(vaultPath).catch(() => {});
    };

    setup();
    return () => { unlisteners.forEach(fn => fn()); };
  }, [vaultPath, searchReady]);

  return <>{children}</>;
}
