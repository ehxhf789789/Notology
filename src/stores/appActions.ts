/**
 * Cross-store action functions.
 * These are standalone functions that coordinate multiple Zustand stores.
 * They replace the action methods that were previously in AppProvider Context.
 */
import { open } from '@tauri-apps/plugin-dialog';
import { join } from '@tauri-apps/api/path';
import { fileCommands, noteCommands, searchCommands, vaultCommands, utilCommands } from '../services/tauriCommands';
import { fileTreeActions, useFileTreeStore } from './zustand/fileTreeStore';
import { hoverActions, useHoverStore } from './zustand/hoverStore';
import { closeHoverWindow } from '../utils/multiWindow';
import { refreshActions, useRefreshStore } from './zustand/refreshStore';
import { modalActions } from './zustand/modalStore';
import { settingsActions, useSettingsStore } from './zustand/settingsStore';
import { templateActions, useTemplateStore } from './zustand/templateStore';
import { uiActions } from './zustand/uiStore';
import { vaultConfigActions, useVaultConfigStore } from './zustand/vaultConfigStore';
import type { RecentVault } from './zustand/vaultConfigStore';
import type { LockAcquireResult } from '../types';
import type { FacetedTagSelection } from '../components/TagInputSection';
import { computeLevel } from '../utils/frontmatter';
import { findTemplateForLevel, applyTemplateVariables, applyNoteTemplateVariables } from '../utils/templates';
import { loadVaultConfig, clearVaultConfigCache } from '../utils/vaultConfigUtils';
import { noteTypeCacheActions } from './zustand/noteTypeCacheStore';
import { getGlobalStore } from './persistenceUtils';

// ============================================================================
// Vault lifecycle
// ============================================================================

async function loadVaultSettings(targetVaultPath: string) {
  await settingsActions.loadSettings(targetVaultPath);
  const vaultConfig = await loadVaultConfig(targetVaultPath);
  templateActions.loadTemplates(targetVaultPath, vaultConfig);
  vaultConfigActions.setContainerConfigs(vaultConfig.containerConfigs || {});
  vaultConfigActions.setFolderStatuses(vaultConfig.folderStatuses || {});
  vaultConfigActions.setContainerOrder(vaultConfig.containerOrder || []);
}

/**
 * Initialize search index.
 *
 * Call initIndex with await IMMEDIATELY after readDirectory succeeds,
 * while Tauri IPC is known to be working. Later IPC calls may fail with
 * ERR_CONNECTION_REFUSED in dev mode.
 *
 * Rust's setup() hook also auto-starts indexing by reading vault_path from
 * the store. If it completes before this call, initIndex returns instantly.
 */
async function initSearchIndex(vaultPath: string): Promise<void> {
  const start = Date.now();

  // Direct await with timeout — most reliable because IPC works at this point
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      console.log(`[initSearchIndex] Attempt ${attempt}...`);
      await Promise.race([
        searchCommands.initIndex(vaultPath),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('IPC_TIMEOUT')), 30_000)
        ),
      ]);
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      console.log(`[initSearchIndex] Ready in ${elapsed}s (attempt ${attempt})`);
      return;
    } catch (e: any) {
      console.warn(`[initSearchIndex] Attempt ${attempt} failed:`, e?.message || e);
      if (attempt < 3) await new Promise(r => setTimeout(r, 2_000));
    }
  }

  // Last resort: event listener (Rust setup() auto-init may still be running)
  console.log('[initSearchIndex] Falling back to event listener...');
  const { listen } = await import('@tauri-apps/api/event');

  return new Promise<void>((resolve, reject) => {
    let done = false;
    const finish = () => { done = true; clearInterval(iid); clearTimeout(tid); ul?.(); };
    let ul: (() => void) | null = null;

    listen<void>('search-index-ready', () => {
      if (done) return;
      console.log(`[initSearchIndex] Event received after ${((Date.now() - start) / 1000).toFixed(1)}s`);
      finish(); resolve();
    }).then(fn => { ul = fn; });

    const iid = setInterval(() => {
      if (!done) searchCommands.initIndex(vaultPath).catch(() => {});
    }, 5_000);

    const tid = setTimeout(() => {
      if (!done) { finish(); reject(new Error('Search index initialization timed out')); }
    }, 120_000);
  });
}

export async function openVault(newVaultPath?: string) {
  const currentVaultPath = useFileTreeStore.getState().vaultPath;

  let defaultPath: string | undefined;
  if (!newVaultPath && currentVaultPath) {
    const parts = currentVaultPath.split(/[/\\]/).filter(Boolean);
    if (parts.length > 1) {
      parts.pop();
      defaultPath = parts.join('\\');
    }
  }

  const selected = newVaultPath || await open({
    directory: true,
    multiple: false,
    defaultPath
  });
  if (!selected) return;

  // Clean up stale vault.lock files
  try {
    const lockPath = await join(selected, '.notology', 'vault.lock');
    if (await fileCommands.checkFileExists(lockPath)) {
      await fileCommands.deleteFile(lockPath);
      console.log('[openVault] Cleaned up stale vault.lock file');
    }
  } catch { /* ignore */ }

  fileTreeActions.setVaultPath(selected);
  refreshActions.setSearchReady(false);
  fileTreeActions.setSelectedContainer(null);
  hoverActions.clearAll();
  vaultConfigActions.clearAll();
  clearVaultConfigCache();

  const globalStore = await getGlobalStore();
  await globalStore.set('vault_path', selected);

  const vaultName = selected.split(/[/\\]/).filter(Boolean).pop() || selected;
  const newVault: RecentVault = { path: selected, name: vaultName, lastOpened: new Date().toISOString() };
  vaultConfigActions.addRecentVault(newVault);
  const updatedRecent = useVaultConfigStore.getState().recentVaults;
  await globalStore.set('recent_vaults', updatedRecent);

  try {
    const tree = await fileCommands.readDirectory(selected);
    fileTreeActions.setFileTree(tree);
    await loadVaultSettings(selected);

    // Show the app immediately — search indexes in the background
    refreshActions.setSearchReady(true);
    refreshActions.setSearchIndexing(true);

    initSearchIndex(selected).then(() => {
      console.log('[openVault] Search index ready');
      refreshActions.setSearchIndexing(false);
      refreshActions.incrementSearchRefresh();
    }).catch(searchErr => {
      console.error('[openVault] Background search init failed:', searchErr);
      refreshActions.setSearchIndexing(false);
    });
  } catch (e) {
    console.error('Failed to read directory:', e);
    fileTreeActions.setVaultPath(null);
    vaultConfigActions.removeRecentVault(selected);
    const filteredRecent = useVaultConfigStore.getState().recentVaults;
    await globalStore.set('recent_vaults', filteredRecent);
    await globalStore.delete('vault_path');
  }
}

export async function closeVault() {
  fileTreeActions.clearAll();
  hoverActions.clearAll();
  vaultConfigActions.clearAll();
  refreshActions.setSearchReady(false);
  const globalStore = await getGlobalStore();
  await globalStore.delete('vault_path');
}

export async function removeVault(vaultPathToRemove: string) {
  vaultConfigActions.removeRecentVault(vaultPathToRemove);
  const globalStore = await getGlobalStore();
  const updated = useVaultConfigStore.getState().recentVaults;
  await globalStore.set('recent_vaults', updated);
}

// ============================================================================
// Container / navigation
// ============================================================================

export function selectContainer(path: string | null) {
  fileTreeActions.setSelectedContainer(path);
  uiActions.setShowSearch(false);
  uiActions.setShowCalendar(false);
}

// ============================================================================
// File operations
// ============================================================================

export async function createNote(title: string, parentPath?: string): Promise<string> {
  const vaultPath = useFileTreeStore.getState().vaultPath;
  const targetDir = parentPath || vaultPath;
  if (!targetDir) throw new Error('No vault open');
  const result = await noteCommands.createNote(targetDir, title);
  await fileTreeActions.refreshFileTree();
  await searchCommands.indexNote(result).catch(() => {});
  refreshActions.incrementSearchRefresh();
  return result;
}

export async function createFolder(name: string, parentPath?: string): Promise<string> {
  const vaultPath = useFileTreeStore.getState().vaultPath;
  const targetDir = parentPath || vaultPath;
  if (!targetDir) throw new Error('No vault open');

  const { templates, defaultTemplateType } = useTemplateStore.getState();
  const language = useSettingsStore.getState().language;
  const level = vaultPath ? computeLevel(targetDir, vaultPath) : 0;
  const template = findTemplateForLevel(templates, level, defaultTemplateType);
  const { frontmatter, body } = applyTemplateVariables(template, { title: name }, language);

  const result = await noteCommands.createFolder(targetDir, name, frontmatter, body);
  await fileTreeActions.refreshFileTree();
  const folderNotePath = `${result}\\${name}.md`;
  try {
    await searchCommands.indexNote(folderNotePath);
  } catch (e) {
    console.error('[createFolder] Index failed:', e);
  }
  refreshActions.incrementSearchRefresh();
  if (template.frontmatter.type) {
    noteTypeCacheActions.patchNoteType(name, template.frontmatter.type as string);
  }
  return result;
}

export async function deleteFile(path: string) {
  await searchCommands.removeFromIndex(path).catch(() => {});
  await fileCommands.deleteFile(path);
  // Close hover windows in both overlay mode and multi-window mode
  hoverActions.closeByFilePath(path);
  closeHoverWindow(path).catch(() => {});
  await fileTreeActions.refreshFileTree();
  refreshActions.incrementSearchRefresh();
  refreshActions.refreshCalendar(); // Sync memos/todos
}

export async function deleteFolder(path: string) {
  await fileCommands.deleteFolder(path);
  const { selectedContainer } = useFileTreeStore.getState();
  if (selectedContainer === path) fileTreeActions.setSelectedContainer(null);
  await fileTreeActions.refreshFileTree();
  await searchCommands.reindexVault().catch(() => {});
  refreshActions.incrementSearchRefresh();
  refreshActions.refreshCalendar(); // Sync memos/todos
}

export async function moveFile(oldPath: string, newPath: string) {
  await searchCommands.removeFromIndex(oldPath).catch(() => {});
  await fileCommands.moveFile(oldPath, newPath);
  hoverActions.updateFilePath(oldPath, newPath);
  await fileTreeActions.refreshFileTree();
  await searchCommands.indexNote(newPath).catch(() => {});
  refreshActions.incrementSearchRefresh();
  refreshActions.refreshCalendar(); // Sync memos/todos
}

export async function moveNote(notePath: string, newDir: string): Promise<string> {
  await searchCommands.removeFromIndex(notePath).catch(() => {});
  const newPath = await noteCommands.moveNote(notePath, newDir);
  hoverActions.updateFilePath(notePath, newPath);
  await fileTreeActions.refreshFileTree();
  await searchCommands.indexNote(newPath).catch(() => {});
  refreshActions.incrementSearchRefresh();
  refreshActions.refreshCalendar(); // Sync memos/todos
  return newPath;
}

export async function importFile(sourcePath: string, targetDir?: string): Promise<string> {
  const vaultPath = useFileTreeStore.getState().vaultPath;
  const result = await noteCommands.importFile(sourcePath, vaultPath || '', targetDir || null);
  await fileTreeActions.refreshFileTree();
  return result;
}

export async function deleteNote(notePath: string) {
  await searchCommands.removeFromIndex(notePath).catch(() => {});
  await noteCommands.deleteNote(notePath);
  // Close hover windows in both overlay mode and multi-window mode
  hoverActions.closeByFilePath(notePath);
  closeHoverWindow(notePath).catch(() => {});
  await fileTreeActions.refreshFileTree();
  refreshActions.incrementSearchRefresh();
  refreshActions.refreshCalendar(); // Sync memos/todos
}

export async function renameFile(filePath: string, newName: string): Promise<string> {
  const vaultPath = useFileTreeStore.getState().vaultPath;
  if (!vaultPath) throw new Error('No vault open');
  const currentContainer = useFileTreeStore.getState().selectedContainer;
  await searchCommands.removeFromIndex(filePath).catch(() => {});
  const newPath = await noteCommands.renameFileWithLinks(filePath, newName, vaultPath);
  hoverActions.updateFilePathAndRefreshAll(filePath, newPath);
  // Update selectedContainer if it references the renamed path
  if (currentContainer) {
    const sep = '\\';
    const normalizedOld = filePath.replace(/\//g, sep);
    const normalizedContainer = currentContainer.replace(/\//g, sep);
    if (normalizedContainer === normalizedOld) {
      fileTreeActions.setSelectedContainer(newPath);
    } else if (normalizedContainer.startsWith(normalizedOld + sep)) {
      fileTreeActions.setSelectedContainer(newPath + currentContainer.slice(filePath.length));
    }
  }
  await fileTreeActions.refreshFileTree();
  await searchCommands.indexNote(newPath).catch(() => {});
  refreshActions.incrementSearchRefresh();
  refreshActions.refreshCalendar(); // Sync memos/todos
  return newPath;
}

export async function updateNoteFrontmatter(notePath: string, frontmatterYaml: string) {
  await noteCommands.updateFrontmatter(notePath, frontmatterYaml);
  await fileTreeActions.refreshFileTree();
}

// ============================================================================
// Note creation with templates
// ============================================================================

export async function createNoteWithTemplate(title: string, templateId: string, parentPath?: string): Promise<string> {
  const vaultPath = useFileTreeStore.getState().vaultPath;
  const targetDir = parentPath || vaultPath;
  if (!targetDir) throw new Error('No vault open');

  const { noteTemplates } = useTemplateStore.getState();
  const template = noteTemplates.find(t => t.id === templateId);
  if (!template) throw new Error('Template not found');

  const language = useSettingsStore.getState().language;
  const createNoteHelper = async (vars: Record<string, string> & { title: string }, userTags?: FacetedTagSelection) => {
    const { fileName, frontmatter, body } = applyNoteTemplateVariables(template, vars, userTags, language);
    const result = await noteCommands.createNoteWithTemplate(targetDir, fileName, frontmatter, body);
    await fileTreeActions.refreshFileTree();
    await searchCommands.indexNote(result).catch((err) => {
      console.error('[createNote] Failed to index note:', err);
    });
    refreshActions.incrementSearchRefresh();
    if (template.frontmatter.type) {
      noteTypeCacheActions.patchNoteType(fileName, template.frontmatter.type as string);
    }
    return result;
  };

  // Contact template
  if (templateId === 'note-contact') {
    return new Promise((resolve, reject) => {
      modalActions.showContactInputModal((formData: any) => {
        const vars = {
          title: formData.name || title,
          name: formData.name || title,
          email: formData.email || '',
          organization: formData.company || '',
          role: formData.position || '',
          phone: formData.phone || '',
          location: formData.location || '',
        };
        createNoteHelper(vars, formData.tags).then(resolve).catch(reject);
      });
    });
  }

  // Meeting template
  if (templateId === 'note-mtg') {
    return new Promise((resolve, reject) => {
      modalActions.showMeetingInputModal((formData: any) => {
        const vars = {
          title: formData.title,
          participants: formData.participants,
          date: formData.date || '',
          time: formData.time || '',
        };
        createNoteHelper(vars, formData.tags).then(resolve).catch(reject);
      });
    });
  }

  // Paper template
  if (templateId === 'note-paper') {
    return new Promise((resolve, reject) => {
      modalActions.showPaperInputModal((formData: any) => {
        const vars = {
          title: formData.title,
          authors: formData.authors,
          year: formData.year,
          venue: formData.venue,
          doi: formData.doi,
          url: formData.url,
        };
        createNoteHelper(vars, formData.tags).then(resolve).catch(reject);
      });
    });
  }

  // Literature template
  if (templateId === 'note-lit') {
    return new Promise((resolve, reject) => {
      modalActions.showLiteratureInputModal((formData: any) => {
        const vars = {
          title: formData.title,
          authors: formData.authors,
          year: formData.year,
          publisher: formData.publisher,
          source: formData.source,
          url: formData.url,
        };
        createNoteHelper(vars, formData.tags).then(resolve).catch(reject);
      });
    });
  }

  // Event template
  if (templateId === 'note-event') {
    return new Promise((resolve, reject) => {
      modalActions.showEventInputModal((formData: any) => {
        const vars = {
          title: formData.title,
          date: formData.date,
          location: formData.location,
          organizer: formData.organizer,
          participants: formData.participants,
        };
        createNoteHelper(vars, formData.tags).then(resolve).catch(reject);
      });
    });
  }

  // For templates with empty title, show title input
  if (!title || title.trim() === '') {
    return new Promise((resolve, reject) => {
      modalActions.showTitleInputModal((result) => {
        createNoteHelper({ title: result.title }, result.tags).then(resolve).catch(reject);
      });
    });
  }

  return createNoteHelper({ title });
}

// ============================================================================
// Vault lock
// ============================================================================

export async function acquireVaultLock(lockVaultPath: string, force = false): Promise<LockAcquireResult> {
  try {
    return await vaultCommands.acquireLock(lockVaultPath, force);
  } catch (e) {
    return { status: 'Error', message: String(e) };
  }
}

export async function releaseVaultLock() {
  const vaultPath = useFileTreeStore.getState().vaultPath;
  if (vaultPath) {
    try {
      await vaultCommands.releaseLock(vaultPath);
    } catch (e) {
      console.error('Failed to release vault lock:', e);
    }
  }
}

export async function forceOpenLockedVault() {
  const { vaultLockModalState } = await import('./zustand/modalStore').then(m => ({ vaultLockModalState: m.useModalStore.getState().vaultLockModalState }));
  if (!vaultLockModalState) return;
  const { vaultPath: lockedVaultPath } = vaultLockModalState;
  modalActions.hideVaultLockModal();

  const result = await acquireVaultLock(lockedVaultPath, true);
  if (result.status === 'Success' || result.status === 'AlreadyHeld') {
    fileTreeActions.setVaultPath(lockedVaultPath);
    refreshActions.setSearchReady(false);
    fileTreeActions.setSelectedContainer(null);
    hoverActions.clearAll();
    vaultConfigActions.clearAll();

    const globalStore = await getGlobalStore();
    await globalStore.set('vault_path', lockedVaultPath);

    const vaultName = lockedVaultPath.split(/[/\\]/).filter(Boolean).pop() || lockedVaultPath;
    const newVault: RecentVault = { path: lockedVaultPath, name: vaultName, lastOpened: new Date().toISOString() };
    vaultConfigActions.addRecentVault(newVault);
    const updatedRecent = useVaultConfigStore.getState().recentVaults;
    await globalStore.set('recent_vaults', updatedRecent);

    try {
      const tree = await fileCommands.readDirectory(lockedVaultPath);
      fileTreeActions.setFileTree(tree);
      await loadVaultSettings(lockedVaultPath);

      // Show the app immediately — search indexes in the background
      refreshActions.setSearchReady(true);
      refreshActions.setSearchIndexing(true);

      initSearchIndex(lockedVaultPath).then(() => {
        console.log('[forceOpenLockedVault] Search index ready');
        refreshActions.setSearchIndexing(false);
        refreshActions.incrementSearchRefresh();
      }).catch(searchErr => {
        console.error('[forceOpenLockedVault] Background search init failed:', searchErr);
        refreshActions.setSearchIndexing(false);
      });
    } catch (e) {
      console.error('Failed to read directory:', e);
    }
  } else if (result.status === 'Error') {
    modalActions.showAlertModal('\uBCF4\uAD00\uC18C \uC5F4\uAE30 \uC2E4\uD328', result.message);
  }
}

// ============================================================================
// Misc
// ============================================================================

export async function toggleDevTools() {
  await utilCommands.toggleDevtools();
}

export function refreshHoverWindowsForFile(filePath: string) {
  hoverActions.refreshForFile(filePath);
}

// ============================================================================
// Initialization (called from AppProvider on mount)
// ============================================================================

export async function initializeApp() {
  await settingsActions.loadGlobalSettings();

  const globalStore = await getGlobalStore();
  const savedPath = await globalStore.get<string>('vault_path');
  const savedRecentVaults = await globalStore.get<RecentVault[]>('recent_vaults');

  // Validate and load recent vaults
  if (savedRecentVaults && savedRecentVaults.length > 0) {
    const validVaults: RecentVault[] = [];
    for (const vault of savedRecentVaults) {
      try {
        await fileCommands.readDirectory(vault.path);
        validVaults.push(vault);
      } catch {
        console.log(`Removing invalid vault: ${vault.path}`);
      }
    }
    vaultConfigActions.setRecentVaults(validVaults);
    if (validVaults.length !== savedRecentVaults.length) {
      await globalStore.set('recent_vaults', validVaults);
    }
  }

  if (savedPath) {
    try {
      const tree = await fileCommands.readDirectory(savedPath);
      fileTreeActions.setVaultPath(savedPath);
      fileTreeActions.setFileTree(tree);
      await loadVaultSettings(savedPath);

      // Show the app immediately — search indexes in the background
      refreshActions.setSearchReady(true);
      refreshActions.setSearchIndexing(true);

      // Background indexing: don't block the UI
      initSearchIndex(savedPath).then(() => {
        refreshActions.setSearchIndexing(false);
        refreshActions.incrementSearchRefresh();
      }).catch(e => {
        console.error('[initializeApp] Background search init failed:', e);
        refreshActions.setSearchIndexing(false);
      });
    } catch (e) {
      console.error('Failed to read saved vault:', e);
      await globalStore.delete('vault_path');
    }
  }
}
