import { useAttachmentStore } from '../../attachments/stores/attachmentStore';
import { navigateIfFolderNote } from '../../../core/stores/appActions';
import { useRef, useCallback, useMemo } from 'react';
import { useFileTreeStore, useVaultPath, fileTreeActions } from '../../../core/stores/fileTreeStore';
import { useHoverStore, hoverActions } from '../stores/hoverStore';
import { useSettingsStore, settingsActions } from '../../../core/stores/settingsStore';
import { useTemplateStore } from '../../templates/stores/templateStore';
import { useIsNasSynced, useIsBulkSyncing } from '../../vault-config/stores/vaultConfigStore';
import { modalActions } from '../../modals/stores/modalStore';
import { noteTypeCacheActions } from '../../content-cache/stores/noteTypeCacheStore';
import { useSearchRefreshTrigger } from '../../../core/stores/refreshStore';
import { fileLookupActions } from '../../../core/stores/fileLookupStore';
import { createNote, createNoteWithTemplate, createFolder, deleteNote, deleteFolder } from '../../../core/stores/appActions';
import { utilCommands } from '../../../core/services/tauriCommands';
// Conditional logging - only in development
const DEV = import.meta.env.DEV;
const log = DEV ? console.log.bind(console) : () => {};

/**
 * Hook that manages store subscriptions and stable action references for HoverEditorWindow.
 * Encapsulates Zustand store selectors and provides stable callback refs.
 */
export function useHoverEditorStores() {
  // Use Zustand stores directly for optimized subscriptions (no re-render on unrelated state changes)
  const fileTree = useFileTreeStore((state) => state.fileTree);
  const closeHoverFile = useHoverStore((state) => state.closeHoverFile);
  const focusHoverFile = useHoverStore((state) => state.focusHoverFile);
  const minimizeHoverFile = useHoverStore((state) => state.minimizeHoverFile);
  const updateHoverWindow = useHoverStore((state) => state.updateHoverWindow);
  const refreshHoverWindowsForFile = useHoverStore((state) => state.refreshHoverWindowsForFile);
  const searchRefreshTrigger = useSearchRefreshTrigger();

  // Use individual Zustand stores for optimized subscriptions
  const vaultPath = useVaultPath();
  const toolbarDefaultCollapsed = useSettingsStore((s) => s.toolbarDefaultCollapsed);
  const hoverZoomEnabled = useSettingsStore((s) => s.hoverZoomEnabled);
  const hoverZoomLevel = useSettingsStore((s) => s.hoverZoomLevel);
  const noteTemplates = useTemplateStore((s) => s.noteTemplates);
  const isBulkSyncing = useIsBulkSyncing();
  const isNasSynced = useIsNasSynced();
  const language = useSettingsStore((s) => s.language);

  // OPTIMIZATION: Store action references in a ref - these are stable and don't need to trigger re-renders
  const appStoreActionsRef = useRef({
    showContextMenu: modalActions.showContextMenu,
    refreshFileTree: fileTreeActions.refreshFileTree,
    createNote,
    createNoteWithTemplate,
    createFolder,
    showTemplateSelector: modalActions.showTemplateSelector,
    setHoverZoomLevel: (level: number) => settingsActions.setHoverZoomLevel(level, useFileTreeStore.getState().vaultPath),
    deleteNote,
    deleteFolder,
    showConfirmDelete: modalActions.showConfirmDelete,
  });

  // Use hoverActions.open directly (stable reference, no Context overhead)
  const openHoverFile = hoverActions.open;

  return {
    fileTree,
    closeHoverFile,
    focusHoverFile,
    minimizeHoverFile,
    updateHoverWindow,
    refreshHoverWindowsForFile,
    searchRefreshTrigger,
    vaultPath,
    toolbarDefaultCollapsed,
    hoverZoomEnabled,
    hoverZoomLevel,
    noteTemplates,
    isBulkSyncing,
    isNasSynced,
    language,
    appStoreActionsRef,
    openHoverFile,
  };
}

/**
 * Hook that provides file resolution callbacks for wikilinks.
 * Uses O(1) lookup via fileLookupStore instead of O(n) tree traversal.
 */
export function useFileResolution(
  winFilePath: string,
  effectiveAttStem: string | null,
  openHoverFile: (path: string) => void,
) {
  // OPTIMIZED: O(1) hash lookup instead of O(n) tree traversal
  const resolveLink = useCallback((fileName: string): boolean => {
    // Track B Phase B-3 (2026-05-12): consult the AttachmentRef index FIRST.
    // Post-migration, attachments live under `.attachments/` (hidden in the
    // file tree per single-surface principle), so the legacy lookups below
    // never find them. Done via getState() — no React subscription here
    // (this callback is invoked from a ProseMirror plugin), and the editor's
    // mount component handles re-decoration on hydrate changes.
    const attRef = useAttachmentStore.getState().resolveByName(fileName);
    if (attRef) return true;

    // Legacy fallback chain (covers pre-migration and notes still warming up):
    if (effectiveAttStem) {
      if (fileLookupActions.isInAttFolder(fileName, effectiveAttStem)) return true;
      const attPath = fileLookupActions.resolveAttachmentPath(fileName, winFilePath);
      if (attPath) return true;
    }

    // Then try to resolve as note globally (O(1) lookup)
    const notePath = fileLookupActions.resolveNotePath(fileName);
    if (notePath) return true;

    // Also check if it's a direct attachment by name
    const directAttPath = fileLookupActions.resolveAttachmentPath(fileName);
    return directAttPath !== null;
  }, [effectiveAttStem, winFilePath]);

  // Use global noteTypeCache store (shared across all windows, no per-window query)
  const getNoteType = useCallback((fileName: string): string | null => {
    return noteTypeCacheActions.getNoteType(fileName);
  }, []);

  // OPTIMIZED: O(1) check if file is an attachment in current note's _att folder
  const isAttachment = useCallback((fileName: string): boolean => {
    // Track B Phase B-3: AttachmentRef index is canonical for new-schema vaults.
    // Also honor the cross-context pending map for chips whose drop is still
    // in flight (especially after this hover window was reopened).
    const store = useAttachmentStore.getState();
    if (store.resolveByName(fileName)) return true;
    if (store.isPending(fileName)) return true;
    if (!effectiveAttStem) return false;
    return fileLookupActions.isInAttFolder(fileName, effectiveAttStem);
  }, [effectiveAttStem]);

  // OPTIMIZED: O(1) resolve fileName to full path
  const resolveFilePathImpl = useCallback((fileName: string): string | null => {
    // Track B Phase B-3: prefer the new AttachmentRef index. We return the
    // absolute vault path to `.attachments/<display>` — the file there is a
    // hardlink to the CAS blob, so any viewer that does `convertFileSrc`
    // gets the same bytes the user expects.
    const attRef = useAttachmentStore.getState().resolveByName(fileName);
    // 🔴 **서버가 주는 `local_path` 가 곧 완전한 경로다** (`library:01_Tasks/…`).
    //    예전엔 `vaultPath + displayPath` 로 이어 붙였는데,
    //      ① `displayPath` 는 이 DTO 에 없다 (undefined)
    //      ② `vaultPath` 가 없으면 **통째로 건너뛰어** null 을 돌려줬다
    //    그래서 첨부 링크를 눌러도 **아무 일도 안 났다** — 창도 안 뜨고
    //    요청도 안 나갔다 (실측). 사용자가 본 *"렌더링이 연결되지 않음"* 이다.
    if (attRef?.local_path) {
      return attRef.local_path;
    }
    if (attRef) {
      const vaultPath = useFileTreeStore.getState().vaultPath;
      const disp = (attRef as { displayPath?: string }).displayPath;
      if (vaultPath && disp) {
        const sep = vaultPath.includes('\\') ? '\\' : '/';
        return vaultPath + sep + disp.replace(/\//g, sep);
      }
    }

    // Legacy fallback chain.
    if (effectiveAttStem) {
      const attPath = fileLookupActions.resolveInAttFolder(fileName, effectiveAttStem);
      if (attPath) return attPath;
    }

    // If not found in _att folder, search globally (for notes)
    const notePath = fileLookupActions.resolveNotePath(fileName);
    if (notePath) return notePath;

    // Also try as general attachment
    const globalAttPath = fileLookupActions.resolveAttachmentPath(fileName);
    return globalAttPath;
  }, [effectiveAttStem]);

  const handleLinkClick = useCallback((fileName: string) => {
    const path = resolveFilePathImpl(fileName);

    if (path) {
      // 🔴 폴더노트 링크는 컨테이너로 이동한다 — hover 금지 (appActions 참조)
      if (navigateIfFolderNote(path)) return;
      const isPreviewable = /\.(md|pdf|png|jpg|jpeg|gif|webp|svg|bmp|ico|json|py|js|ts|jsx|tsx|css|html|xml|yaml|yml|toml|rs|go|java|c|cpp|h|hpp|cs|rb|php|sh|bash|sql|lua|r|swift|kt|scala|csv|doc|docx|ppt|pptx|xls|xlsx|hwp|hwpx)$/i.test(path);
      if (isPreviewable) {
        openHoverFile(path);
      } else {
        utilCommands.openInDefaultApp(path);
      }
    }
  }, [resolveFilePathImpl, openHoverFile]);

  const handleContextMenu = useCallback((
    fileName: string,
    position: { x: number; y: number },
    showContextMenu: typeof modalActions.showContextMenu,
    deleteCallback?: () => void,
  ) => {
    // Coordinates from WikiLink are viewport-relative (clientX/clientY)
    // ContextMenu uses position:fixed, so we pass them as-is (not adjusted)
    showContextMenu(fileName, position, winFilePath, undefined, undefined, undefined, deleteCallback);
  }, [winFilePath]);

  return {
    resolveLink,
    getNoteType,
    isAttachment,
    resolveFilePathImpl,
    handleLinkClick,
    handleContextMenu,
  };
}
