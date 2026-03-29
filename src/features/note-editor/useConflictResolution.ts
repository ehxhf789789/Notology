import { useState, useCallback, useMemo, useRef } from 'react';
import type { Editor } from '@tiptap/core';
import { fileCommands, searchCommands, memoCommands } from '../../core/services/tauriCommands';
import { hoverActions, HOVER_ANIMATION } from '../hover-windows/stores/hoverStore';
import { refreshActions } from '../../core/stores/refreshStore';
import { contentCacheActions } from '../content-cache/stores/contentCacheStore';
import { fileLookupActions } from '../../core/stores/fileLookupStore';
import type { NoteFrontmatter } from '../../core/types';
import { serializeFrontmatter, getCurrentTimestamp } from '../../core/utils/frontmatter';
import { markAsSelfSaved } from '../../core/utils/selfSaveTracker';
import { notifyFileSaved, notifySearchIndexUpdated } from '../../core/utils/windowSync';

// Conditional logging - only in development
const DEV = import.meta.env.DEV;
const log = DEV ? console.log.bind(console) : () => {};

export interface ConflictState {
  myContent: string;
  myFrontmatter: NoteFrontmatter;
  externalMtime: number;
}

export interface ConflictCopyInfo {
  originalPath: string;
  originalName: string;
}

export interface UseConflictResolutionParams {
  winId: string;
  winFilePath: string;
  vaultPath: string | null;
  frontmatterRef: React.MutableRefObject<NoteFrontmatter | null>;
  bodyRef: React.MutableRefObject<string>;
  editor: Editor | null;
  body: string;
  refreshHoverWindowsForFile: (filePath: string) => void;
  refreshFileTree: () => void;
}

export function useConflictResolution({
  winId,
  winFilePath,
  vaultPath,
  frontmatterRef,
  bodyRef,
  editor,
  body,
  refreshHoverWindowsForFile,
  refreshFileTree,
}: UseConflictResolutionParams) {
  // Conflict resolution state (Synology sync: external modification while editing)
  const [conflictState, setConflictState] = useState<ConflictState | null>(null);

  // Transient notification for silent external reload (isDirty=false case)
  const [externalReloadNotice, setExternalReloadNotice] = useState(false);

  // Cooldown after conflict resolution to prevent watcher events from re-triggering conflict UI.
  // Set to Date.now() after resolving; content reload checks this to suppress re-trigger.
  const conflictResolvedAtRef = useRef(0);

  // Conflict copy bar dismiss state
  const [conflictCopyBarDismissed, setConflictCopyBarDismissed] = useState(false);

  // Detect conflict copy: file name matches "{original} (내 변경 YYYY-MM-DD).md"
  // OPTIMIZED: Uses O(1) lookup instead of O(n) tree traversal
  const conflictCopyInfo = useMemo((): ConflictCopyInfo | null => {
    if (!winFilePath) return null;
    const fileName = winFilePath.split(/[/\\]/).pop() || '';
    const match = fileName.match(/^(.+) \(내 변경 \d{4}-\d{2}-\d{2}\)\.md$/);
    if (!match) return null;
    const originalName = match[1];
    const dir = winFilePath.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
    const originalPath = `${dir}/${originalName}.md`;
    // O(1) check if original exists using the file lookup index
    const originalExists = fileLookupActions.isNote(originalPath);
    return originalExists ? { originalPath, originalName: `${originalName}.md` } : null;
  }, [winFilePath]);

  // ========== CONFLICT RESOLUTION HANDLERS ==========

  // Accept external changes (discard my edits)
  const handleConflictAcceptExternal = useCallback(() => {
    if (!conflictState || !winFilePath) return;
    conflictResolvedAtRef.current = Date.now();
    contentCacheActions.invalidateContent(winFilePath);
    refreshHoverWindowsForFile(winFilePath);
    setConflictState(null);
  }, [conflictState, winFilePath, refreshHoverWindowsForFile]);

  // Force save my changes (overwrite external)
  const handleConflictKeepMine = useCallback(async () => {
    if (!conflictState || !winFilePath) return;

    // Update mtime ref so save proceeds
    const currentMtime = await fileCommands.getFileMtime(winFilePath);

    const updatedFm: NoteFrontmatter = {
      ...conflictState.myFrontmatter,
      modified: getCurrentTimestamp(),
    };
    const fmString = serializeFrontmatter(updatedFm);

    try {
      await fileCommands.writeFile(winFilePath, fmString, conflictState.myContent);
      markAsSelfSaved(winFilePath);
      contentCacheActions.updateContent(winFilePath, conflictState.myContent, updatedFm);
      notifyFileSaved(winFilePath).catch(() => {});
      searchCommands.indexNote(winFilePath).then(() => {
        refreshActions.batchRefresh({ search: true, calendar: true });
        notifySearchIndexUpdated(winFilePath).catch(() => {});
      }).catch(() => {});
      memoCommands.indexNoteMemos(winFilePath).catch(() => {});
    } catch (e) {
      console.error('HoverEditor: Conflict force save failed:', e);
    }
    conflictResolvedAtRef.current = Date.now();
    setConflictState(null);

    // Return updated values for the caller to set
    return { updatedFm, currentMtime };
  }, [conflictState, winFilePath]);

  // Save mine as copy (keep both)
  const handleConflictSaveBoth = useCallback(async () => {
    if (!conflictState || !winFilePath || !vaultPath) return;

    const timestamp = new Date().toISOString().slice(0, 10);
    const parts = winFilePath.split(/[/\\]/);
    const sep = winFilePath.includes('\\') ? '\\' : '/';
    const dir = parts.slice(0, -1).join(sep);
    const baseName = parts.pop()?.replace(/\.md$/, '') || 'note';
    const copyPath = `${dir}${sep}${baseName} (내 변경 ${timestamp}).md`;

    const fmString = serializeFrontmatter({
      ...conflictState.myFrontmatter,
      modified: getCurrentTimestamp(),
    });

    try {
      await fileCommands.writeFile(copyPath, fmString, conflictState.myContent);
      markAsSelfSaved(copyPath);
      refreshFileTree();
      notifyFileSaved(copyPath).catch(() => {});
      searchCommands.indexNote(copyPath).then(() => {
        refreshActions.batchRefresh({ search: true, calendar: true });
        notifySearchIndexUpdated(copyPath).catch(() => {});
      }).catch(() => {});
      memoCommands.indexNoteMemos(copyPath).catch(() => {});
    } catch (e) {
      console.error('HoverEditor: Save copy failed:', e);
    }

    // Load external version for this window
    contentCacheActions.invalidateContent(winFilePath);
    refreshHoverWindowsForFile(winFilePath);
    conflictResolvedAtRef.current = Date.now();
    setConflictState(null);
  }, [conflictState, winFilePath, vaultPath, refreshHoverWindowsForFile, refreshFileTree]);

  // ========== CONFLICT COPY RESOLUTION HANDLERS ==========

  // Replace original with this conflict copy's content
  const handleConflictCopyReplace = useCallback(async () => {
    if (!conflictCopyInfo || !winFilePath || !frontmatterRef.current || !editor) return;
    const currentBody = (editor.storage as any).markdown?.getMarkdown() || body;
    const updatedFm: NoteFrontmatter = {
      ...frontmatterRef.current,
      modified: getCurrentTimestamp(),
    };
    const fmString = serializeFrontmatter(updatedFm);
    try {
      // Write this copy's content to original path
      await fileCommands.writeFile(conflictCopyInfo.originalPath, fmString, currentBody);
      // Remove copy from search index first (always, even if delete fails)
      await searchCommands.removeFromIndex(winFilePath).catch(() => {});
      // Delete this copy file (delete_file, not delete_note — protect _att)
      await fileCommands.deleteFile(winFilePath).catch(() => {});
      // Refresh any open editors showing the original
      contentCacheActions.invalidateContent(conflictCopyInfo.originalPath);
      refreshHoverWindowsForFile(conflictCopyInfo.originalPath);
      // Re-index original in background, then refresh search
      searchCommands.indexNote(conflictCopyInfo.originalPath).then(() => {
        refreshActions.batchRefresh({ search: true, calendar: true });
        notifySearchIndexUpdated(conflictCopyInfo.originalPath).catch(() => {});
      }).catch(() => {});
      memoCommands.indexNoteMemos(conflictCopyInfo.originalPath).catch(() => {});
      refreshFileTree();
      // Close this copy window
      hoverActions.startClosing(winId);
      setTimeout(() => hoverActions.finishClosing(winId), HOVER_ANIMATION.CLOSE_DURATION);
    } catch (e) {
      console.error('HoverEditor: Conflict copy replace failed:', e);
    }
  }, [conflictCopyInfo, winFilePath, winId, frontmatterRef, editor, body, refreshHoverWindowsForFile, refreshFileTree]);

  // Keep original, delete this conflict copy
  const handleConflictCopyDiscard = useCallback(async () => {
    if (!conflictCopyInfo || !winFilePath) return;
    // Always remove from search index (even if file already deleted by sync)
    await searchCommands.removeFromIndex(winFilePath).catch(() => {});
    // Delete this copy file (delete_file, not delete_note — protect _att)
    await fileCommands.deleteFile(winFilePath).catch(() => {});
    refreshActions.batchRefresh({ search: true, calendar: true });
    refreshFileTree();
    // Close this copy window
    hoverActions.startClosing(winId);
    setTimeout(() => hoverActions.finishClosing(winId), HOVER_ANIMATION.CLOSE_DURATION);
  }, [conflictCopyInfo, winFilePath, winId, refreshFileTree]);

  return {
    // State
    conflictState,
    setConflictState,
    externalReloadNotice,
    setExternalReloadNotice,
    conflictResolvedAtRef,
    conflictCopyBarDismissed,
    setConflictCopyBarDismissed,
    conflictCopyInfo,

    // Handlers
    handleConflictAcceptExternal,
    handleConflictKeepMine,
    handleConflictSaveBoth,
    handleConflictCopyReplace,
    handleConflictCopyDiscard,
  };
}
