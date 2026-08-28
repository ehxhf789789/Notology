/**
 * Cross-store action functions.
 * These are standalone functions that coordinate multiple Zustand stores.
 * They replace the action methods that were previously in AppProvider Context.
 */
import { hoverActions, useHoverStore } from '../../features/hover-windows/stores/hoverStore';
import { open } from '../../web/dialog';
import { join } from '../../web/path';
import { fileCommands, noteCommands, searchCommands, vaultCommands, utilCommands, libraryCommands } from '../services/tauriCommands';
import { EventBus } from '../infrastructure/eventBus';

// Guard: prevent concurrent openVault calls (e.g., rapid clicks, HMR re-mount)
let openVaultInProgress = false;
import { fileTreeActions, useFileTreeStore } from './fileTreeStore';


import { refreshActions, useRefreshStore } from './refreshStore';
import { modalActions } from '../../features/modals/stores/modalStore';
import { settingsActions, useSettingsStore } from './settingsStore';
import { templateActions, useTemplateStore } from '../../features/templates/stores/templateStore';
import { uiActions } from './uiStore';
import { vaultConfigActions, useVaultConfigStore } from '../../features/vault-config/stores/vaultConfigStore';
import type { RecentVault } from '../../features/vault-config/stores/vaultConfigStore';
import type { LockAcquireResult } from '../types';
import type { FacetedTagSelection } from '../../features/shared/TagInputSection';
import { computeLevel } from '../utils/frontmatter';
import { findTemplateForLevel, applyTemplateVariables, applyNoteTemplateVariables } from '../../features/templates/templates';
import { loadVaultConfig, clearVaultConfigCache } from '../utils/vaultConfigUtils';
import { noteTypeCacheActions } from '../../features/content-cache/stores/noteTypeCacheStore';
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
  const { listen } = await import('../../web/event');

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
  // Prevent concurrent invocations (HMR double-mount, rapid clicks)
  if (openVaultInProgress) {
    console.log('[openVault] Already in progress, skipping duplicate call');
    return;
  }
  openVaultInProgress = true;

  try {
    await openVaultInner(newVaultPath);
  } finally {
    openVaultInProgress = false;
  }
}

async function openVaultInner(newVaultPath?: string) {
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
  fileTreeActions.setSelectedContainer(null);
  hoverActions.clearAll();
  vaultConfigActions.clearAll();
  clearVaultConfigCache();
  // 11th hotfix (2026-05-18, HanBin) — wipe noteTypeCache on vault
  // switch so the previous vault's `unmatchedTypes` count doesn't bleed
  // through into the Settings → "미확인 템플릿 정리" badge until the new
  // vault's refresh completes. Without this the badge can show "5개"
  // for the OLD vault while the user is browsing a clean new vault.
  noteTypeCacheActions.reset();
  // Reset stale search state (clears init_in_progress flag if previous init hung)
  searchCommands.resetSearchState().catch(() => {});

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

    // Infrastructure: notify features that vault is ready
    refreshActions.setSearchIndexing(true);
    // App is usable immediately — search/graph will show loading until index ready
    refreshActions.setSearchReady(true);
    EventBus.emit('vault:opened', { path: selected });

    // PART 7 (HanBin 2026-05-14): user-confirmed migration modal.
    // Previously this ran silently — fulfilling Decision 1 of STAGE_1_PLAN.md
    // Appendix C, and the deferred TODO from Sub-Stage 1.6 §10.5. The flow
    // is now: check → if needed AND not declined → migrationActions.prompt()
    // → MigrationModal shows → user decides → store calls runMigration().
    // The library init still happens regardless (works pre- and post-
    // migration), so the editor remains usable while the modal is up.
    libraryCommands.checkMigrationNeeded(selected).then(async (report) => {
      if (report.needs_migration && report.total_notes > 0) {

        if (!wasMigrationDeclined(selected)) {
          console.log(`[openVault] Migration needed: ${report.total_notes} notes — prompting user`);
          migrationActions.prompt(selected, report);
        } else {
          console.log('[openVault] Migration previously declined for this vault — skipping prompt');
        }
      }
      // Initialize library (works whether migration ran or not)
      libraryCommands.initLibrary(selected).catch(e => {
        console.warn('[openVault] Library init failed (non-fatal):', e);
      });
    }).catch(e => {
      console.warn('[openVault] Migration check failed (non-fatal):', e);
      libraryCommands.initLibrary(selected).catch(() => {});
    });

    // Stage 4.6.2 (HanBin 2026-05-14): faststart bulk migration check.
    // Runs after the Stage-4 migration check (independent — Stage-4 fixes
    // ref/blob layout; Stage 4.6 re-muxes existing video blobs to faststart).
    // Both modals can theoretically queue if both apply, but in practice
    // Stage-4 migrated vaults already have refs that 4.6 then probes.
    // 🔴 보관함 이관 검사를 걷어냈다. 데스크톱이 옛 보관함 구조를 새 구조로
    //    올리던 절차인데, web notology의 보관함은 서버가 처음부터 새 구조로 든다.

    // Search index initializes in background — does not block app usage
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
    // Even if readDirectory fails, try to initialize sync so cached vault can sync
    EventBus.emit('vault:opened', { path: selected });
    fileTreeActions.setVaultPath(null);
    vaultConfigActions.removeRecentVault(selected);
    const filteredRecent = useVaultConfigStore.getState().recentVaults;
    await globalStore.set('recent_vaults', filteredRecent);
    await globalStore.delete('vault_path');
  }
}

export async function closeVault() {
  EventBus.emit('vault:closed', {});
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
  // 관찰 ①-g: 어느 서가를 여는가 — 탐색 패턴이 관심사의 재료다
  if (path) import('../../features/dobbin/observe').then(m => m.observe('open_folder', path)).catch(() => {});
  uiActions.setShowSearch(false);
  uiActions.setShowCalendar(false);
  // 🔴 홈이 열린 채 폴더를 누르면 화면이 안 바뀐다 — 중앙 분기에서 홈이
  //    컨테이너보다 앞이기 때문이다 (UIUX_PLAN P0). 검색이 이미 같은 이유로
  //    여기서 닫히고 있었다. **한 자리에서 함께 닫는다.**
  uiActions.setShowDobbinHome(false);
}

// 🔴 폴더노트는 hover 창으로 열지 않는다 (사용자 지시, 2026-08-25:
//    "폴더 노트는 hover 창으로 열리면 안된다"). 파일명 == 부모 폴더명이면
//    그 노트 자체가 폴더다 — Search.tsx 가 2026-08-11 에 받은 규칙
//    (CONTAINER → selectContainer) 을 위키링크 클릭에도 편다.
//    참이면 이동까지 끝냈다는 뜻이므로 호출부는 열기를 멈춘다.
export function navigateIfFolderNote(path: string): boolean {
  const norm = path.replace(/\\/g, '/');
  if (!/\.md$/i.test(norm)) return false;
  const parts = norm.split('/');
  if (parts.length < 2) return false;
  const stem = parts[parts.length - 1].replace(/\.md$/i, '');
  if (stem !== parts[parts.length - 2]) return false;
  selectContainer(parts.slice(0, -1).join('/'));
  return true;
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

export async function createNoteWithTemplate(
  title: string,
  templateId: string,
  parentPath?: string,
  /**
   * Stage 5.0.5a-β (2026-05-16, HanBin) — pre-collected variable values
   * from NoteCreationWizard. When provided, the legacy per-template input
   * modals are bypassed and the note is created with the supplied vars +
   * auto-fill system variables. Used for templates whose body declares
   * user-input `{{vars}}` (autoFill=false in TEMPLATE_VAR_CATALOG).
   */
  customVariables?: Record<string, string>,
  /**
   * Hotfix (2026-05-17, HanBin) — wizard's per-creation tag selection.
   * Threaded through to `applyNoteTemplateVariables` as `userTags` so
   * domain/who/org/ctx picks merge into the new note's frontmatter.
   * Previously the wizard collected these but they were dropped at the
   * call site.
   */
  userTags?: FacetedTagSelection,
): Promise<string> {
  const vaultPath = useFileTreeStore.getState().vaultPath;
  const targetDir = parentPath || vaultPath;
  if (!targetDir) throw new Error('No vault open');

  const { noteTemplates } = useTemplateStore.getState();
  const template = noteTemplates.find(t => t.id === templateId);
  if (!template) throw new Error('Template not found');

  const language = useSettingsStore.getState().language;
  const createNoteHelper = async (vars: Record<string, string> & { title: string }, callTimeUserTags?: FacetedTagSelection) => {
    const { fileName, frontmatter, body } = applyNoteTemplateVariables(template, vars, callTimeUserTags, language);
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

  // β-stage shortcut: wizard already gathered values. Skip TitleInputModal
  // and use whatever customVariables provides. Title comes through the first
  // arg directly (wizard already trimmed it).
  if (customVariables) {
    return createNoteHelper({ title, ...customVariables }, userTags);
  }

  // 11th hotfix (2026-05-18, HanBin) — special-modals retire.
  // Five dedicated modals (Contact/Meeting/Paper/Literature/Event) used to
  // sit here as templateId-specific branches. They were dead weight: each
  // had the same TagInputSection chip wizard and the same form fields that
  // TitleInputModal + userInputTokens now collect generically. Unified path:
  //
  //   1. Gather tokens this template wants the user to fill from
  //      `template.userInputTokens` AND a body scan (templates can declare
  //      tokens that aren't in their body — see note-mtg/event/paper/lit/etc.).
  //   2. If we have ANY user-input tokens OR title is empty → open
  //      TitleInputModal. It already handles synthetic specs for non-catalog
  //      tokens and pre-fills title from `initialInputValue`.
  //   3. Otherwise → straight create with the supplied title.
  //
  // Result: 5 modal files + 5 store actions + 5 mount points become dead.
  let userInputTokens: string[] = template.userInputTokens ? [...template.userInputTokens] : [];
  try {
    const { scanUserInputVars } = await import('../../features/templates/templateVarScan');
    const bodyTokens = scanUserInputVars(template.body).map(s => s.token);
    for (const tok of bodyTokens) {
      if (!userInputTokens.includes(tok)) userInputTokens.push(tok);
    }
  } catch (err) {
    console.warn('[createNoteWithTemplate] var-scan import failed:', err);
  }

  const needsTitle = !title || title.trim() === '';
  const needsTokens = userInputTokens.length > 0;

  if (needsTitle || needsTokens) {
    const { t: tFn } = await import('../utils/i18n');
    const templateInfo = {
      name: template.name,
      prefix: template.prefix,
      description: tFn(TEMPLATE_DESC_KEYS_INTERACTIVE[template.prefix.toUpperCase()] || 'templateDescCustom', language),
      noteType: template.frontmatter.type?.toLowerCase() || template.prefix.toLowerCase() || 'note',
      customColor: template.customColor,
      icon: template.icon,
    };
    return new Promise((resolve, reject) => {
      modalActions.showTitleInputModal(
        (result) => {
          if (!result.title.trim()) {
            reject(new Error('title required'));
            return;
          }
          const vars = result.varValues
            ? { title: result.title.trim(), ...result.varValues }
            : { title: result.title.trim() };
          createNoteHelper(vars, result.tags).then(resolve).catch(reject);
        },
        tFn('enterNoteTitlePlaceholder', language),
        tFn('newNoteDefault', language),
        templateInfo,
        userInputTokens,
        // Pre-fill the title input with whatever the caller provided. For
        // inline-name flows (ContainerView, HoverEditor) this becomes the
        // seed value; for empty-title invocations it stays empty.
        title && title.trim() ? title.trim() : undefined,
        // Pre-seed the wizard tag chips from template's tagCategories so
        // the user can see + adjust BEFORE creating, same as the
        // createNoteFromTemplateInteractive flow.
        {
          domain: [...(template.tagCategories?.domain ?? [])],
          who:    [...(template.tagCategories?.who    ?? [])],
          org:    [...(template.tagCategories?.org    ?? [])],
          ctx:    [...(template.tagCategories?.ctx    ?? [])],
        },
      );
    });
  }

  return createNoteHelper({ title });
}

/**
 * Stage 5.0.5a v18 (2026-05-16, HanBin) — interactive create-from-template
 * flow. Single entry point for all "user picked a template, now create a
 * note" call sites (Ctrl+N, ContainerView "+ 새 노트", RibbonBar storage
 * buttons).
 *
 * 11th hotfix (2026-05-18, HanBin) — special-modals retire collapsed this
 * into a single path: TitleInputModal collects title + any user-input
 * tokens (from body scan ∪ template.userInputTokens) + tag chips, then
 * createNoteWithTemplate is called with customVariables so it skips its
 * own internal modal-opening path. The old SPECIAL_TEMPLATE_IDS branch
 * (Contact/MTG/Paper/Lit/Event → dedicated modal) is gone — those
 * templates now declare their fields via `userInputTokens` and route
 * through the same unified wizard as every other template.
 *
 * After creation the file tree refreshes, search re-indexes, and the new
 * note opens in a hover window — same finalisation across all branches.
 */
const TEMPLATE_DESC_KEYS_INTERACTIVE: Record<string, string> = {
  'NOTE': 'templateDescNote',
  'SKETCH': 'templateDescSketch',
  'MTG': 'templateDescMtg',
  'SEM': 'templateDescSem',
  'EVENT': 'templateDescEvent',
  'OFA': 'templateDescOfa',
  'PAPER': 'templateDescPaper',
  'LIT': 'templateDescLit',
  'DATA': 'templateDescData',
  'THEO': 'templateDescTheo',
  'CONTACT': 'templateDescContact',
  'SETUP': 'templateDescSetup',
};

export async function createNoteFromTemplateInteractive(
  templateId: string,
  targetContainer: string | null,
): Promise<void> {
  const { noteTemplates } = useTemplateStore.getState();
  const template = noteTemplates.find(t => t.id === templateId);
  if (!template) {
    console.error('[createNoteFromTemplateInteractive] template not found:', templateId);
    return;
  }

  const language = useSettingsStore.getState().language;
  const { t: tFn } = await import('../utils/i18n');

  const finalize = async (notePath: string) => {
    await fileTreeActions.refreshFileTree();
    refreshActions.incrementSearchRefresh();
    hoverActions.open(notePath);
  };

  // All templates → unified TitleInputModal collects title + user-input
  // tokens + tag chips. 11th hotfix (2026-05-18) removed the special-modals
  // bypass for note-contact/mtg/paper/lit/event; they now declare their
  // fields via `template.userInputTokens` and flow through this same path.
  let userInputTokens: string[] = template.userInputTokens ? [...template.userInputTokens] : [];
  try {
    const { scanUserInputVars } = await import('../../features/templates/templateVarScan');
    const bodyTokens = scanUserInputVars(template.body).map(s => s.token);
    for (const tok of bodyTokens) {
      if (!userInputTokens.includes(tok)) userInputTokens.push(tok);
    }
  } catch (err) {
    console.warn('[createNoteFromTemplateInteractive] var-scan import failed:', err);
  }

  const noteType = template.frontmatter.type?.toLowerCase() || template.prefix.toLowerCase() || 'note';
  const templateInfo = {
    name: template.name,
    prefix: template.prefix,
    description: tFn(TEMPLATE_DESC_KEYS_INTERACTIVE[template.prefix.toUpperCase()] || 'templateDescCustom', language),
    noteType,
    customColor: template.customColor,
    // v18 — icon flows through so the modal header can render the right
    // lucide component (was missing → blank icon span for custom types).
    icon: template.icon,
  };

  modalActions.showTitleInputModal(
    async (result) => {
      if (!result.title.trim()) return;
      try {
        // v18 — pass the inline-collected variable values as customVariables
        // so createNoteWithTemplate substitutes them into both body and
        // frontmatter. Empty object when the template declared no vars.
        const customVariables = result.varValues && Object.keys(result.varValues).length > 0
          ? result.varValues
          : undefined;
        // Hotfix (2026-05-17, HanBin) — wizard's `tags` selection was
        // silently dropped here: only title + customVariables flowed
        // through. Now passing `result.tags` as the 5th arg so the
        // user's per-creation tag picks reach `applyNoteTemplateVariables`
        // and merge into the new note's frontmatter.
        const notePath = await createNoteWithTemplate(
          result.title.trim(),
          templateId,
          targetContainer || undefined,
          customVariables,
          result.tags,
        );
        await finalize(notePath);
      } catch (err) {
        console.error('[createNoteFromTemplateInteractive] title-modal create failed:', err);
      }
    },
    tFn('enterNoteTitlePlaceholder', language),
    tFn('newNoteDefault', language),
    templateInfo,
    userInputTokens,
    // initialInputValue — empty for fresh new-note (Ctrl+N is intentionally a
    // blank title; only migration pre-fills the existing filename).
    undefined,
    // 10th hotfix (2026-05-17, HanBin) — pre-seed wizard tag chips from
    // template's tagCategories so the user sees the defaults BEFORE
    // creating. Empty arrays per category if the template didn't define
    // any → wizard tag section opens empty, same as before.
    {
      domain: [...(template.tagCategories?.domain ?? [])],
      who:    [...(template.tagCategories?.who    ?? [])],
      org:    [...(template.tagCategories?.org    ?? [])],
      ctx:    [...(template.tagCategories?.ctx    ?? [])],
    },
  );
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
  const { vaultLockModalState } = await import('../../features/modals/stores/modalStore').then(m => ({ vaultLockModalState: m.useModalStore.getState().vaultLockModalState }));
  if (!vaultLockModalState) return;
  const { vaultPath: lockedVaultPath } = vaultLockModalState;
  modalActions.hideVaultLockModal();

  const result = await acquireVaultLock(lockedVaultPath, true);
  if (result.status === 'Success' || result.status === 'AlreadyHeld') {
    fileTreeActions.setVaultPath(lockedVaultPath);
    fileTreeActions.setSelectedContainer(null);
    hoverActions.clearAll();
    vaultConfigActions.clearAll();
    // 11th hotfix — same reset as openVault path; force-open-locked is a
    // vault switch from the user's POV.
    noteTypeCacheActions.reset();

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

      refreshActions.setSearchIndexing(true);
      refreshActions.setSearchReady(true);

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

let initializeAppCalled = false;

export async function initializeApp() {
  // Guard against double-invocation (HMR re-mount)
  if (initializeAppCalled) {
    console.log('[initializeApp] Already called, skipping duplicate');
    return;
  }
  initializeAppCalled = true;

  await settingsActions.loadGlobalSettings();

  // Try to auto-reopen last vault if it exists locally.
  // This works on both fresh start and HMR recovery.
  // Sync will connect in the background via EventBus subscription on vault:opened.
  try {
    const globalStore = await getGlobalStore();
    const savedPath = await globalStore.get<string>('vault_path');
    if (savedPath) {
      // Verify the folder still exists before opening
      const exists = await fileCommands.checkFileExists(savedPath).catch(() => false);
      if (exists) {
        console.log('[initializeApp] Auto-reopening last vault:', savedPath);
        await openVault(savedPath);
        // Show main window directly (don't emit vault-selected — that would
        // trigger App.tsx listener to call openVault() again, causing duplicate
        // sync monitors). See SYNC_DIAGNOSTIC_REPORT.md Finding 5.
        try {
          const { getCurrentWindow } = await import('../../web/window');
          const mainWin = getCurrentWindow();
          await mainWin.show();
          await mainWin.setFocus();
        } catch {}
        return;
      } else {
        console.log('[initializeApp] Saved vault path no longer exists, clearing:', savedPath);
        await globalStore.delete('vault_path');
      }
    }
  } catch (e) {
    console.warn('[initializeApp] Failed to auto-reopen vault:', e);
  }

  // No saved vault — show main window with inline vault selector
  console.log('[initializeApp] No vault to auto-reopen, showing inline vault selector');
  try {
    const { getCurrentWindow } = await import('../../web/window');
    const mainWin = getCurrentWindow();
    await mainWin.show();
    await mainWin.setFocus();
  } catch (e) {
    console.warn('[initializeApp] Failed to show main window:', e);
  }
}
