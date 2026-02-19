import { useState, useEffect, useRef, useCallback, useMemo, memo } from 'react';
import { EditorContent } from '@tiptap/react';
import type { Editor } from '@tiptap/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { fileCommands, searchCommands, utilCommands, noteLockCommands, memoCommands } from '../services/tauriCommands';
import type { NoteLockInfo } from '../services/tauriCommands';
import { editorPool } from '../utils/editorPool';
import { isHoverWindow } from '../utils/multiWindow';
import { Tags, MessageSquare, Minus, X } from 'lucide-react';
import { SyncStatusIndicator, type SyncStatus } from './SyncStatusIndicator';
import { useHoverStore, hoverActions, useIsClosing, useIsMinimizing, HOVER_ANIMATION } from '../stores/zustand/hoverStore';
import { useFileTreeStore, useVaultPath, fileTreeActions } from '../stores/zustand/fileTreeStore';
import { useSettingsStore } from '../stores/zustand/settingsStore';
import { t } from '../utils/i18n';
import { useTemplateStore } from '../stores/zustand/templateStore';
import { useIsNasSynced, useIsBulkSyncing } from '../stores/zustand/vaultConfigStore';
import { modalActions } from '../stores/zustand/modalStore';
import { noteTypeCacheActions } from '../stores/zustand/noteTypeCacheStore';
import { refreshActions, useSearchRefreshTrigger } from '../stores/zustand/refreshStore';
import { contentCacheActions } from '../stores/zustand/contentCacheStore';
import { fileLookupActions } from '../stores/zustand/fileLookupStore';
import { createNote, createNoteWithTemplate, createFolder, deleteNote, deleteFolder } from '../stores/appActions';
import { settingsActions } from '../stores/zustand/settingsStore';
import { useDropTarget } from '../hooks/useDragDrop';
import type { NoteFrontmatter, NoteComment, CanvasData, CanvasSelection } from '../types';
import type { FacetedTags } from '../types/frontmatter';
import { serializeFrontmatter, getCurrentTimestamp } from '../utils/frontmatter';
import { getFlatTags } from '../utils/frontmatterUtils';
import { loadComments, saveComments } from '../utils/comments';
import { markAsSelfSaved } from '../utils/selfSaveTracker';
import { registerEditorSave, unregisterEditorSave } from '../utils/editorSaveRegistry';
import { notifyFileSaved, notifyMemoChanged, notifySearchIndexUpdated } from '../utils/windowSync';
import EditorToolbar from './EditorToolbar';
import EditorContextMenu from './EditorContextMenu';
import CommentPanel from './CommentPanel';
import Search from './Search';
import CanvasEditor from './CanvasEditor';
import TagPanel from './metadata/TagPanel';
import { runAnimation, HOVER_WINDOW_OPEN_DURATION, hoverWindowPropsAreEqual, type HoverEditorWindowProps } from './hover/hoverAnimationUtils';

// Conditional logging - only in development
const DEV = import.meta.env.DEV;
const log = DEV ? console.log.bind(console) : () => {};

export const HoverEditorWindow = memo(function HoverEditorWindow({ window: win }: HoverEditorWindowProps) {
  // ========== PERFORMANCE TIMING ==========
  const mountTimeRef = useRef(performance.now());
  const timingLogRef = useRef<{ step: string; time: number }[]>([]);
  const logTiming = (step: string) => {
    const elapsed = performance.now() - mountTimeRef.current;
    timingLogRef.current.push({ step, time: elapsed });
    log(`[HoverEditor ${win.id.slice(-6)}] ${step}: ${elapsed.toFixed(1)}ms`);
  };

  // Log mount
  useEffect(() => {
    logTiming('Component mounted');
    return () => {
      log(`[HoverEditor ${win.id.slice(-6)}] Unmounted. Full timing:`, timingLogRef.current);
    };
  }, []);

  // Use Zustand stores directly for optimized subscriptions (no re-render on unrelated state changes)
  const fileTree = useFileTreeStore((state) => state.fileTree);
  const closeHoverFile = useHoverStore((state) => state.closeHoverFile);
  const focusHoverFile = useHoverStore((state) => state.focusHoverFile);
  const minimizeHoverFile = useHoverStore((state) => state.minimizeHoverFile);
  const updateHoverWindow = useHoverStore((state) => state.updateHoverWindow);
  const refreshHoverWindowsForFile = useHoverStore((state) => state.refreshHoverWindowsForFile);
  const searchRefreshTrigger = useSearchRefreshTrigger();
  // Note: Snap preview uses direct DOM manipulation - no React state needed

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

  const [frontmatter, setFrontmatter] = useState<NoteFrontmatter | null>(null);
  const [body, setBody] = useState('');
  const [isDirty, setIsDirty] = useState(false);
  // Optimistic locking: track file mtime to detect external modifications (Synology sync)
  const mtimeOnLoadRef = useRef<number>(0);
  const [isDragging, setIsDragging] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  // Animation states - isClosing/isMinimizing from shared store for sync
  const [isOpening, setIsOpening] = useState(true);
  const isClosing = useIsClosing(win.id);
  const isMinimizing = useIsMinimizing(win.id);
  const [isSnapping, setIsSnapping] = useState(false);

  // Conflict resolution state (Synology sync: external modification while editing)
  const [conflictState, setConflictState] = useState<{
    myContent: string;
    myFrontmatter: NoteFrontmatter;
    externalMtime: number;
  } | null>(null);

  // Transient notification for silent external reload (isDirty=false case)
  const [externalReloadNotice, setExternalReloadNotice] = useState(false);

  // Note-level editing lock from another device
  const [remoteLock, setRemoteLock] = useState<NoteLockInfo | null>(null);

  // Cooldown after conflict resolution to prevent watcher events from re-triggering conflict UI.
  // Set to Date.now() after resolving; content reload checks this to suppress re-trigger.
  const conflictResolvedAtRef = useRef(0);

  // Detect conflict copy: file name matches "{original} (내 변경 YYYY-MM-DD).md"
  // OPTIMIZED: Uses O(1) lookup instead of O(n) tree traversal
  const conflictCopyInfo = useMemo(() => {
    if (!win.filePath) return null;
    const fileName = win.filePath.split(/[/\\]/).pop() || '';
    const match = fileName.match(/^(.+) \(내 변경 \d{4}-\d{2}-\d{2}\)\.md$/);
    if (!match) return null;
    const originalName = match[1];
    const dir = win.filePath.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
    const originalPath = `${dir}/${originalName}.md`;
    // O(1) check if original exists using the file lookup index
    const originalExists = fileLookupActions.isNote(originalPath);
    return originalExists ? { originalPath, originalName: `${originalName}.md` } : null;
  }, [win.filePath]);

  // Track previous states to detect restoration
  const prevCachedRef = useRef(win.cached);
  const prevMinimizedRef = useRef(win.minimized);

  // Debug: Log animation state changes
  useEffect(() => {
    log(`[HoverEditor ${win.id.slice(-6)}] Animation states: opening=${isOpening}, closing=${isClosing}, minimizing=${isMinimizing}`);
  }, [isOpening, isClosing, isMinimizing, win.id]);

  // Detect cache OR minimized restoration and re-trigger opening animation
  useEffect(() => {
    const restoredFromCache = prevCachedRef.current === true && win.cached === false;
    const restoredFromMinimized = prevMinimizedRef.current === true && win.minimized === false;

    if (restoredFromCache) {
      log(`[HoverEditor ${win.id.slice(-6)}] Restored from CACHE - triggering opening animation`);
      setIsOpening(true);
    } else if (restoredFromMinimized) {
      log(`[HoverEditor ${win.id.slice(-6)}] Restored from MINIMIZED - triggering opening animation`);
      // Reset opacity before starting new animation
      if (hoverEditorRef.current) {
        hoverEditorRef.current.style.opacity = '0';
      }
      setIsOpening(true);
    }

    prevCachedRef.current = win.cached;
    prevMinimizedRef.current = win.minimized;
  }, [win.cached, win.minimized, win.id]);

  // Run opening animation using Web Animations API
  useEffect(() => {
    if (isOpening && hoverEditorRef.current) {
      const el = hoverEditorRef.current;
      const startTime = performance.now();
      log(`[HoverWindow ${win.id.slice(-6)}] OPEN - Web Animation started`);

      runAnimation(el, 'open', HOVER_WINDOW_OPEN_DURATION).then(() => {
        const elapsed = performance.now() - startTime;
        log(`[HoverWindow ${win.id.slice(-6)}] OPEN - animation completed (${elapsed.toFixed(1)}ms)`);
        setIsOpening(false);
      });
    }
  }, [isOpening, win.id]);

  // Clear snapping animation after it completes
  useEffect(() => {
    if (isSnapping) {
      const timer = setTimeout(() => setIsSnapping(false), 100); // Match CSS 80ms + buffer
      return () => clearTimeout(timer);
    }
  }, [isSnapping]);
  const [editorMenuPos, setEditorMenuPos] = useState<{ x: number; y: number } | null>(null);
  const [comments, setComments] = useState<NoteComment[]>([]);
  const [showComments, setShowComments] = useState(false);
  const [showTags, setShowTags] = useState(false);
  const [activeCommentId, setActiveCommentId] = useState<string | null>(null);
  const [canvasData, setCanvasData] = useState<CanvasData>({ nodes: [], edges: [] });
  const [canvasSelection, setCanvasSelection] = useState<CanvasSelection | null>(null);
  const [preservedSelection, setPreservedSelection] = useState<{ text: string; range: { from: number; to: number } } | null>(null);
  const [pendingTaskMode, setPendingTaskMode] = useState(false);
  const [isContentLoading, setIsContentLoading] = useState(true); // Track content loading for skeleton UI
  const [conflictCopyBarDismissed, setConflictCopyBarDismissed] = useState(false);
  const dragStartRef = useRef({ x: 0, y: 0, posX: 0, posY: 0 });
  const resizeStartRef = useRef({ x: 0, y: 0, w: 0, h: 0 });
  const preSnapSizeRef = useRef<{ width: number; height: number } | null>(null);
  const preMaximizeStateRef = useRef<{ position: { x: number; y: number }; size: { width: number; height: number } } | null>(null);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const commentValidationTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isLoadingRef = useRef(false);
  const prevFilePathRef = useRef<string | null>(null);
  const commentsRef = useRef<NoteComment[]>([]);
  const commentsMtimeRef = useRef<number>(0); // Track comments.json mtime for sync safety
  const contentSetRef = useRef(false); // Track if content was already set by sync path
  const prevCommentsKeyRef = useRef(''); // Track comment changes to avoid redundant editor dispatches
  // Refs for stable saveFile callback (avoids dependency chain: every edit → saveFile recreated → 4+ downstream callbacks recreated)
  const frontmatterRef = useRef<NoteFrontmatter | null>(null);
  frontmatterRef.current = frontmatter;
  const bodyRef = useRef('');
  bodyRef.current = body;

  // Keep commentsRef in sync with comments state
  useEffect(() => {
    commentsRef.current = comments;
  }, [comments]);

  // NOTE: Removed per-window noteTypeCache refresh - it now happens globally once in App.tsx
  // Previously, every hover window was triggering a refresh on fileTree change, causing N*refreshes

  // For conflict copies, use original note's _att folder (they share attachments)
  const effectiveAttStem = useMemo(() => {
    if (!win.filePath) return null;
    if (conflictCopyInfo) {
      return conflictCopyInfo.originalPath.replace(/\.md$/i, '');
    }
    return win.filePath.replace(/\.md$/i, '');
  }, [win.filePath, conflictCopyInfo]);

  // OPTIMIZED: O(1) hash lookup instead of O(n) tree traversal
  // Uses fileLookupStore index built when fileTree changes
  const resolveLink = useCallback((fileName: string): boolean => {
    // First, try to resolve in current note's _att folder (O(1) lookup)
    if (effectiveAttStem) {
      if (fileLookupActions.isInAttFolder(fileName, effectiveAttStem)) return true;
      const attPath = fileLookupActions.resolveAttachmentPath(fileName, win.filePath);
      if (attPath) return true;
    }

    // Then try to resolve as note globally (O(1) lookup)
    const notePath = fileLookupActions.resolveNotePath(fileName);
    if (notePath) return true;

    // Also check if it's a direct attachment by name
    const directAttPath = fileLookupActions.resolveAttachmentPath(fileName);
    return directAttPath !== null;
  }, [effectiveAttStem, win.filePath]);

  // Use global noteTypeCache store (shared across all windows, no per-window query)
  const getNoteType = useCallback((fileName: string): string | null => {
    return noteTypeCacheActions.getNoteType(fileName);
  }, []);

  // OPTIMIZED: O(1) check if file is an attachment in current note's _att folder
  // Uses fileLookupStore index instead of O(n) tree traversal
  // For conflict copies, uses the original note's _att folder (shared attachments)
  const isAttachment = useCallback((fileName: string): boolean => {
    if (!effectiveAttStem) return false;
    return fileLookupActions.isInAttFolder(fileName, effectiveAttStem);
  }, [effectiveAttStem]);

  // OPTIMIZED: O(1) resolve fileName to full path
  // Uses fileLookupStore index instead of O(n) tree traversal
  // For conflict copies, uses the original note's _att folder (shared attachments)
  const resolveFilePathImpl = useCallback((fileName: string): string | null => {
    // First, check if the file is an attachment (exists in current note's _att folder)
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
      const isPreviewable = /\.(md|pdf|png|jpg|jpeg|gif|webp|svg|bmp|ico|json|py|js|ts|jsx|tsx|css|html|xml|yaml|yml|toml|rs|go|java|c|cpp|h|hpp|cs|rb|php|sh|bash|sql|lua|r|swift|kt|scala)$/i.test(path);
      if (isPreviewable) {
        openHoverFile(path);
      } else {
        utilCommands.openInDefaultApp(path);
      }
    }
  }, [resolveFilePathImpl, openHoverFile]);

  const handleContextMenu = useCallback((fileName: string, position: { x: number; y: number }, deleteCallback?: () => void) => {
    // Coordinates from WikiLink are viewport-relative (clientX/clientY)
    // ContextMenu uses position:fixed, so we pass them as-is (not adjusted)
    appStoreActionsRef.current.showContextMenu(fileName, position, win.filePath, undefined, undefined, undefined, deleteCallback);
  }, [win.filePath]);

  const hoverEditorRef = useRef<HTMLDivElement>(null);

  const handleEditorContextMenu = useCallback((pos: { x: number; y: number }) => {
    // EditorContextMenu uses portal to document.body, so pass viewport coordinates directly
    setEditorMenuPos(pos);
  }, []);

  const handleCommentClick = useCallback((commentId: string) => {
    setActiveCommentId(commentId);
    setShowComments(true);
  }, []);

  // Ref for the editor body (for drop target and other uses)
  const editorBodyRef = useRef<HTMLDivElement>(null);

  // Use refs so WikiLink plugin always calls the latest functions
  const resolveLinkRef = useRef(resolveLink);
  resolveLinkRef.current = resolveLink;
  const getNoteTypeRef = useRef(getNoteType);
  getNoteTypeRef.current = getNoteType;
  const isAttachmentRef = useRef(isAttachment);
  isAttachmentRef.current = isAttachment;
  const handleLinkClickRef = useRef(handleLinkClick);
  handleLinkClickRef.current = handleLinkClick;
  const handleContextMenuRef = useRef(handleContextMenu);
  handleContextMenuRef.current = handleContextMenu;
  const handleEditorContextMenuRef = useRef(handleEditorContextMenu);
  handleEditorContextMenuRef.current = handleEditorContextMenu;
  const handleCommentClickRef = useRef(handleCommentClick);
  handleCommentClickRef.current = handleCommentClick;
  const resolveFilePathRef = useRef(resolveFilePathImpl);
  resolveFilePathRef.current = resolveFilePathImpl;

  // Keep fileTree ref for WikiLinkSuggestion (getter-based, no extension recreation)
  const fileTreeRef = useRef(fileTree);
  fileTreeRef.current = fileTree;

  // Keep vaultPath ref for AttachmentSuggestion
  const vaultPathRef = useRef(vaultPath || '');
  vaultPathRef.current = vaultPath || '';

  // ========== POOLED EDITOR ==========
  const [editor, setEditor] = useState<Editor | null>(null);
  const editorRef = useRef<Editor | null>(null);
  const editorAcquiredRef = useRef(false);
  const pendingBodyRef = useRef<string | null>(null); // Store body until editor is ready

  // Acquire editor from pool on mount
  useEffect(() => {
    if (editorAcquiredRef.current) return;
    editorAcquiredRef.current = true;

    const acquireStart = performance.now();
    logTiming('Acquiring editor from pool');

    const doAcquire = () => {
      const pooledEditor = editorPool.acquire({
        onClickLink: (name: string) => handleLinkClickRef.current(name),
        onContextMenu: (name: string, pos: { x: number; y: number }, deleteCallback?: () => void) =>
          handleContextMenuRef.current(name, pos, deleteCallback),
        resolveLink: (name: string) => resolveLinkRef.current(name),
        getNoteType: (name: string) => getNoteTypeRef.current(name),
        isAttachment: (name: string) => isAttachmentRef.current(name),
        onEditorContextMenu: (pos: { x: number; y: number }) => handleEditorContextMenuRef.current(pos),
        onCommentClick: (id: string) => handleCommentClickRef.current(id),
        getFileTree: () => fileTreeRef.current,
        notePath: win.filePath,
        vaultPath: vaultPathRef.current,
        resolveFilePath: (name: string) => resolveFilePathRef.current(name),
      });

      if (pooledEditor) {
        // Set up onUpdate handler
        pooledEditor.on('update', ({ editor: ed }) => {
          if (isLoadingRef.current) return;
          const markdown = (ed.storage as any).markdown.getMarkdown();
          setBody(markdown);
          setIsDirty(true);

          // Debounce comment validation
          if (commentValidationTimeoutRef.current) {
            clearTimeout(commentValidationTimeoutRef.current);
          }
          commentValidationTimeoutRef.current = setTimeout(() => {
            const currentComments = commentsRef.current;
            if (currentComments.length > 0) {
              const doc = ed.state.doc;
              const docSize = doc.content.size;
              const validComments = currentComments.filter(comment => {
                const { from, to } = comment.position;
                if (from < 0 || to > docSize || from >= to) return false;
                try {
                  const textAtPosition = doc.textBetween(from, to, ' ');
                  return textAtPosition === comment.anchorText;
                } catch {
                  return false;
                }
              });
              if (validComments.length < currentComments.length) {
                setComments(validComments);
                saveComments(win.filePath, validComments, commentsMtimeRef.current).then((result) => {
                  commentsMtimeRef.current = result.mtime;
                  if (result.comments !== validComments) setComments(result.comments);
                  refreshActions.batchRefresh({ search: true, calendar: true });
                });
              }
            }
          }, 1000);

          if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
          saveTimeoutRef.current = setTimeout(() => {
            const markdown = (ed.storage as any).markdown.getMarkdown();
            saveFile(markdown);
          }, 300); // Reduced for faster content reflection to main view
        });

        editorRef.current = pooledEditor;
        setEditor(pooledEditor);
        logTiming(`Editor acquired from pool (${(performance.now() - acquireStart).toFixed(1)}ms)`);

        // If body was loaded before editor was ready, set content now
        if (pendingBodyRef.current !== null && !contentSetRef.current) {
          const setContentStart = performance.now();
          isLoadingRef.current = true; // Guard: prevent onUpdate from firing during setContent
          pooledEditor.commands.setContent(pendingBodyRef.current);
          isLoadingRef.current = false;
          contentSetRef.current = true;
          pendingBodyRef.current = null;
          logTiming(`Editor setContent (deferred) (${(performance.now() - setContentStart).toFixed(1)}ms)`);
        }
      }
    };

    // Check if pool is ready
    if (editorPool.isReady()) {
      doAcquire();
    } else {
      editorPool.init().then(doAcquire);
    }

    // Release on unmount — save dirty content first (critical for HMR / refresh)
    return () => {
      if (editorRef.current) {
        // Flush pending auto-save timer
        if (saveTimeoutRef.current) {
          clearTimeout(saveTimeoutRef.current);
          saveTimeoutRef.current = null;
        }
        // Save dirty content before releasing (fire-and-forget)
        const ed = editorRef.current;
        const fm = frontmatterRef.current;
        if (isDirtyRef.current && ed && !ed.isDestroyed && fm && !isLoadingRef.current) {
          const markdown = (ed.storage as any).markdown.getMarkdown();
          const updatedFm = { ...fm, modified: getCurrentTimestamp() };
          const fmString = serializeFrontmatter(updatedFm);
          fileCommands.writeFile(win.filePath, fmString, markdown).catch(() => {});
        }
        ed.off('update');
        editorPool.release(ed);
        editorRef.current = null;
      }
      // Reset acquisition flag so re-mount can acquire again
      editorAcquiredRef.current = false;
      setEditor(null);
    };
  }, []); // Only run once on mount

  // Update pool callbacks when filePath or vaultPath changes + log editor readiness
  useEffect(() => {
    if (editor) {
      editorPool.updateCallbacks(editor, {
        getFileTree: () => fileTreeRef.current,
        notePath: win.filePath,
        vaultPath: vaultPathRef.current,
      });
      logTiming('Editor reference available');
    }
  }, [editor, win.filePath, vaultPath]);

  const saveFile = useCallback(async (currentBody?: string) => {
    const fm = frontmatterRef.current;
    const bodyToSave = currentBody !== undefined ? currentBody : bodyRef.current;
    if (!win.filePath || !fm) return;

    // Guard: never save while content is still loading (prevents empty-body overwrites
    // during HMR re-mounts or rapid file switches)
    if (isLoadingRef.current) {
      log('[HoverEditor] saveFile skipped — content still loading');
      return;
    }

    // Optimistic locking: check if file was modified externally (Synology sync)
    if (mtimeOnLoadRef.current > 0) {
      const currentMtime = await fileCommands.getFileMtime(win.filePath);
      if (currentMtime > mtimeOnLoadRef.current) {
        log(`[HoverEditor] External modification detected, showing conflict UI`);
        setConflictState({
          myContent: bodyToSave,
          myFrontmatter: { ...fm },
          externalMtime: currentMtime,
        });
        return;
      }
    }

    const updatedFm: NoteFrontmatter = {
      ...fm,
      modified: getCurrentTimestamp(),
    };
    const fmString = serializeFrontmatter(updatedFm);

    // Optimistic patch BEFORE disk write: update Search UI instantly (0ms)
    // Even if writeFile fails, next Tantivy refresh will correct the data
    const noteFileName = win.filePath.split(/[\\/]/).pop()?.replace(/\.md$/, '') || '';
    refreshActions.patchNote({
      path: win.filePath,
      title: updatedFm.title || noteFileName,
      note_type: updatedFm.type || '',
      tags: updatedFm.tags || [],
      created: updatedFm.created || '',
      modified: updatedFm.modified,
      has_body: bodyToSave.length > 0,
      comment_count: commentsRef.current.length,
    });
    // Keep noteTypeCache in sync so wiki link decorations show correct icons/colors
    if (updatedFm.type && noteFileName) {
      noteTypeCacheActions.patchNoteType(noteFileName, updatedFm.type);
    }

    try {
      await fileCommands.writeFile(win.filePath, fmString, bodyToSave);
      setFrontmatter(updatedFm);
      setIsDirty(false);

      // Mark as self-saved to prevent false "external change" warnings
      markAsSelfSaved(win.filePath);

      // Update content cache immediately with estimated mtime (non-blocking)
      const estimatedMtime = Date.now();
      contentCacheActions.updateContent(win.filePath, bodyToSave, updatedFm, estimatedMtime);

      // Immediately update mtime ref to prevent race condition:
      // rapid consecutive saves (e.g., link paste → link card generation)
      // could trigger false conflict if async getFileMtime hasn't resolved yet
      mtimeOnLoadRef.current = estimatedMtime;

      // Correct with real mtime from disk (non-blocking)
      fileCommands.getFileMtime(win.filePath).then(realMtime => {
        mtimeOnLoadRef.current = realMtime;
        // Correct cache mtime if significantly different
        if (Math.abs(realMtime - estimatedMtime) > 1000) {
          contentCacheActions.updateContent(win.filePath, bodyToSave, updatedFm, realMtime);
        }
      }).catch(() => {});

      // Notify other windows about save (for cache invalidation)
      notifyFileSaved(win.filePath).catch(() => {});

      // Refresh calendar (search already handled by patchNote above)
      refreshActions.batchRefresh({ calendar: true });

      // Index note in background, then refresh again with fully accurate data
      searchCommands.indexNote(win.filePath).then(() => {
        refreshActions.batchRefresh({ search: true, calendar: true });
        notifySearchIndexUpdated(win.filePath).catch(() => {});
      }).catch(() => {});
      memoCommands.indexNoteMemos(win.filePath).catch(() => {});
    } catch (e) {
      console.error('HoverEditor: Failed to save:', e);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [win.filePath]);

  // ========== EMERGENCY SAVE REGISTRY (beforeunload) ==========
  // Register a flush callback so that on page refresh/close, any pending
  // auto-save timers are flushed and dirty content is written immediately.
  const isDirtyRef = useRef(false);
  isDirtyRef.current = isDirty;

  useEffect(() => {
    registerEditorSave(win.id, () => {
      // Clear any pending debounced save
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
        saveTimeoutRef.current = null;
      }
      // If dirty, write file immediately (fire-and-forget)
      const ed = editorRef.current;
      const fm = frontmatterRef.current;
      if (isDirtyRef.current && ed && !ed.isDestroyed && fm && !isLoadingRef.current) {
        const markdown = (ed.storage as any).markdown.getMarkdown();
        const updatedFm = { ...fm, modified: getCurrentTimestamp() };
        const fmString = serializeFrontmatter(updatedFm);
        // Fire-and-forget: Tauri IPC sends the message before page unloads
        fileCommands.writeFile(win.filePath, fmString, markdown).catch(() => {});
      }
    });
    return () => unregisterEditorSave(win.id);
  }, [win.id, win.filePath]);

  // ========== CONFLICT RESOLUTION HANDLERS ==========

  // Accept external changes (discard my edits)
  const handleConflictAcceptExternal = useCallback(() => {
    if (!conflictState || !win.filePath) return;
    conflictResolvedAtRef.current = Date.now();
    contentCacheActions.invalidateContent(win.filePath);
    refreshHoverWindowsForFile(win.filePath);
    setConflictState(null);
    setIsDirty(false);
  }, [conflictState, win.filePath, refreshHoverWindowsForFile]);

  // Force save my changes (overwrite external)
  const handleConflictKeepMine = useCallback(async () => {
    if (!conflictState || !win.filePath) return;

    // Update mtime ref so save proceeds
    const currentMtime = await fileCommands.getFileMtime(win.filePath);
    mtimeOnLoadRef.current = currentMtime;

    const updatedFm: NoteFrontmatter = {
      ...conflictState.myFrontmatter,
      modified: getCurrentTimestamp(),
    };
    const fmString = serializeFrontmatter(updatedFm);

    try {
      await fileCommands.writeFile(win.filePath, fmString, conflictState.myContent);
      markAsSelfSaved(win.filePath);
      setFrontmatter(updatedFm);
      setIsDirty(false);
      fileCommands.getFileMtime(win.filePath).then(m => { mtimeOnLoadRef.current = m; });
      contentCacheActions.updateContent(win.filePath, conflictState.myContent, updatedFm);
      notifyFileSaved(win.filePath).catch(() => {});
      searchCommands.indexNote(win.filePath).then(() => {
        refreshActions.batchRefresh({ search: true, calendar: true });
        notifySearchIndexUpdated(win.filePath).catch(() => {});
      }).catch(() => {});
      memoCommands.indexNoteMemos(win.filePath).catch(() => {});
    } catch (e) {
      console.error('HoverEditor: Conflict force save failed:', e);
    }
    conflictResolvedAtRef.current = Date.now();
    setConflictState(null);
  }, [conflictState, win.filePath]);

  // Save mine as copy (keep both)
  const handleConflictSaveBoth = useCallback(async () => {
    if (!conflictState || !win.filePath || !vaultPath) return;

    const timestamp = new Date().toISOString().slice(0, 10);
    const parts = win.filePath.split(/[/\\]/);
    const sep = win.filePath.includes('\\') ? '\\' : '/';
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
      appStoreActionsRef.current.refreshFileTree();
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
    contentCacheActions.invalidateContent(win.filePath);
    refreshHoverWindowsForFile(win.filePath);
    conflictResolvedAtRef.current = Date.now();
    setConflictState(null);
    setIsDirty(false);
  }, [conflictState, win.filePath, vaultPath, refreshHoverWindowsForFile]);

  // ========== CONFLICT COPY RESOLUTION HANDLERS ==========

  // Replace original with this conflict copy's content
  const handleConflictCopyReplace = useCallback(async () => {
    if (!conflictCopyInfo || !win.filePath || !frontmatter || !editor) return;
    const currentBody = (editor.storage as any).markdown?.getMarkdown() || body;
    const updatedFm: NoteFrontmatter = {
      ...frontmatter,
      modified: getCurrentTimestamp(),
    };
    const fmString = serializeFrontmatter(updatedFm);
    try {
      // Write this copy's content to original path
      await fileCommands.writeFile(conflictCopyInfo.originalPath, fmString, currentBody);
      // Remove copy from search index first (always, even if delete fails)
      await searchCommands.removeFromIndex(win.filePath).catch(() => {});
      // Delete this copy file (delete_file, not delete_note — protect _att)
      await fileCommands.deleteFile(win.filePath).catch(() => {});
      // Refresh any open editors showing the original
      contentCacheActions.invalidateContent(conflictCopyInfo.originalPath);
      refreshHoverWindowsForFile(conflictCopyInfo.originalPath);
      // Re-index original in background, then refresh search
      searchCommands.indexNote(conflictCopyInfo.originalPath).then(() => {
        refreshActions.batchRefresh({ search: true, calendar: true });
        notifySearchIndexUpdated(conflictCopyInfo.originalPath).catch(() => {});
      }).catch(() => {});
      memoCommands.indexNoteMemos(conflictCopyInfo.originalPath).catch(() => {});
      appStoreActionsRef.current.refreshFileTree();
      // Close this copy window
      hoverActions.startClosing(win.id);
      setTimeout(() => hoverActions.finishClosing(win.id), HOVER_ANIMATION.CLOSE_DURATION);
    } catch (e) {
      console.error('HoverEditor: Conflict copy replace failed:', e);
    }
  }, [conflictCopyInfo, win.filePath, win.id, frontmatter, editor, body, refreshHoverWindowsForFile]);

  // Keep original, delete this conflict copy
  const handleConflictCopyDiscard = useCallback(async () => {
    if (!conflictCopyInfo || !win.filePath) return;
    // Always remove from search index (even if file already deleted by sync)
    await searchCommands.removeFromIndex(win.filePath).catch(() => {});
    // Delete this copy file (delete_file, not delete_note — protect _att)
    await fileCommands.deleteFile(win.filePath).catch(() => {});
    refreshActions.batchRefresh({ search: true, calendar: true });
    appStoreActionsRef.current.refreshFileTree();
    // Close this copy window
    hoverActions.startClosing(win.id);
    setTimeout(() => hoverActions.finishClosing(win.id), HOVER_ANIMATION.CLOSE_DURATION);
  }, [conflictCopyInfo, win.filePath, win.id]);

  const handleCanvasChange = useCallback((data: CanvasData) => {
    setCanvasData(data);
    setIsDirty(true);

    // Check for orphaned Canvas comments
    const currentComments = commentsRef.current;
    if (currentComments.length > 0) {
      const validComments = currentComments.filter(comment => {
        // Only check Canvas comments (those with canvasNodeId)
        if (!comment.canvasNodeId) return true; // Keep non-canvas comments as-is

        // Find the node this comment belongs to
        const node = data.nodes.find(n => n.id === comment.canvasNodeId);
        if (!node) return false; // Node deleted

        // Check if text at position matches anchorText
        const { from, to } = comment.canvasTextPosition || comment.position;
        const nodeText = node.text || '';
        if (from < 0 || to > nodeText.length || from >= to) return false;

        const textAtPosition = nodeText.substring(from, to);
        return textAtPosition === comment.anchorText;
      });

      // If some comments were removed, update state
      if (validComments.length < currentComments.length) {
        setComments(validComments);
        saveComments(win.filePath, validComments, commentsMtimeRef.current).then((result) => {
          commentsMtimeRef.current = result.mtime;
          if (result.comments !== validComments) setComments(result.comments);
          refreshActions.batchRefresh({ search: true, calendar: true });
        });
      }
    }

    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = setTimeout(() => {
      const jsonBody = JSON.stringify(data, null, 2);
      saveFile(jsonBody);
    }, 300); // Reduced for faster content reflection to main view
  }, [saveFile, win.filePath]);

  // Process loaded content (used by both sync and async paths)
  const processLoadedContent = useCallback((cached: { frontmatter: any; body: string }) => {
    const fm = cached.frontmatter;
    setFrontmatter(fm);
    setBody(cached.body);
    setIsDirty(false);
    // Record mtime for optimistic locking (detect Synology sync overwrites)
    if (win.filePath) {
      fileCommands.getFileMtime(win.filePath).then(m => { mtimeOnLoadRef.current = m; });
    }
    logTiming('State updated (frontmatter, body)');

    // Update the window's noteType if frontmatter has a type
    if (fm?.type && !win.noteType) {
      updateHoverWindow(win.id, { noteType: fm.type.toLowerCase() });
    }

    // If this is a canvas note, parse canvas data from body
    if (fm?.canvas) {
      try {
        const parsed = JSON.parse(cached.body || '{"nodes":[],"edges":[]}');
        setCanvasData(parsed);
      } catch {
        setCanvasData({ nodes: [], edges: [] });
      }
      // If body is empty, initialize with empty canvas JSON
      if (!cached.body || cached.body.trim() === '') {
        const initialJson = JSON.stringify({ nodes: [], edges: [] }, null, 2);
        setBody(initialJson);
        // Save initial canvas structure
        setTimeout(() => {
          saveFile(initialJson);
        }, 100);
      }
      logTiming('Canvas data parsed');
    } else {
      // Regular markdown note - set content immediately if editor is available
      if (editorRef.current && !contentSetRef.current) {
        const setContentStart = performance.now();
        editorRef.current.commands.setContent(cached.body || '');
        contentSetRef.current = true;
        logTiming(`Editor setContent (immediate) (${(performance.now() - setContentStart).toFixed(1)}ms)`);
      } else if (!editorRef.current) {
        // Store body for when editor becomes available
        pendingBodyRef.current = cached.body || '';
        logTiming('Body loaded, stored for editor');
      }
    }

    isLoadingRef.current = false;
    setIsContentLoading(false); // Hide skeleton
    logTiming('Loading complete');

    // OPTIMIZATION: Preload wiki-linked notes for instant opening
    const wikiLinkMatches = cached.body.match(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g);
    if (wikiLinkMatches) {
      const linkedNames = wikiLinkMatches.map((m: string) => m.replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/, '$1'));
      // Preload first 5 linked notes (to avoid overloading)
      linkedNames.slice(0, 5).forEach((name: string) => {
        const linkedPath = resolveFilePathRef.current(name);
        if (linkedPath && linkedPath.endsWith('.md')) {
          contentCacheActions.preloadContent(linkedPath);
        }
      });
    }
  }, [win.id, win.noteType, updateHoverWindow, saveFile]);

  // Load file - uses content cache for instant loading of recently viewed files
  useEffect(() => {
    if (!win.filePath || win.filePath === prevFilePathRef.current) return;
    prevFilePathRef.current = win.filePath;

    // Reset flags for new file
    contentSetRef.current = false;
    pendingBodyRef.current = null;

    logTiming('File load started');
    isLoadingRef.current = true;

    // Try synchronous cache access first (no Promise overhead)
    const syncCached = contentCacheActions.getContentSync(win.filePath);
    if (syncCached) {
      // SYNC PATH: Process cached content immediately without Promise
      logTiming('SYNC cache hit - processing immediately');
      processLoadedContent(syncCached);
      return;
    }

    // ASYNC PATH: Cache miss - load from disk
    setIsContentLoading(true); // Show skeleton only for async loads
    const loadStartTime = performance.now();
    contentCacheActions.getContent(win.filePath)
      .then(cached => {
        const loadTime = performance.now() - loadStartTime;
        logTiming(`Disk load complete (${loadTime.toFixed(1)}ms)`);
        processLoadedContent(cached);
      })
      .catch(err => {
        console.error('HoverEditor: Failed to load:', err);
        logTiming('Loading FAILED');
        isLoadingRef.current = false;
        setIsContentLoading(false); // Hide skeleton on error too
      });

    // Load comments
    loadComments(win.filePath).then((result) => {
      setComments(result.comments);
      commentsMtimeRef.current = result.mtime;
    });
  }, [win.filePath, processLoadedContent]); // processLoadedContent is stable via useCallback

  // Set editor content when both editor and body are ready
  // This handles the case where body loads before editor is available (async path)
  // NOTE: Sync path already sets content in processLoadedContent, this is fallback only
  useEffect(() => {
    // Skip for canvas notes
    if (!editor || !body || frontmatter?.canvas) return;
    // Skip if content was already set by sync path
    if (contentSetRef.current) return;

    const setContentStart = performance.now();
    isLoadingRef.current = true;
    editor.commands.setContent(body);
    isLoadingRef.current = false;
    contentSetRef.current = true;
    logTiming(`Editor setContent (fallback) (${(performance.now() - setContentStart).toFixed(1)}ms)`);
  }, [editor, body, frontmatter?.canvas]);

  // Reload content when contentReloadTrigger changes (for immediate refresh after wiki-link updates)
  // Track previous trigger to detect actual changes (not re-runs from other deps)
  const prevReloadTriggerRef = useRef(win.contentReloadTrigger);
  useEffect(() => {
    // Skip if this is the initial load (contentReloadTrigger is undefined or 0)
    if (!win.contentReloadTrigger || !win.filePath) return;

    // Only process when contentReloadTrigger actually changed
    if (prevReloadTriggerRef.current === win.contentReloadTrigger) return;
    prevReloadTriggerRef.current = win.contentReloadTrigger;

    // Skip reload during active conflict resolution (user needs to decide first)
    if (conflictState) {
      log('[HoverEditor] Skipping content reload during active conflict resolution');
      return;
    }

    // Skip if file is being loaded for the first time
    if (!editor || isLoadingRef.current) return;

    // If user is editing (isDirty), show conflict UI instead of silently overwriting
    // BUT skip if conflict was JUST resolved (watcher event from our own save after Keep Mine / Save Both)
    if (isDirty) {
      const msSinceResolved = Date.now() - conflictResolvedAtRef.current;
      if (msSinceResolved < 5000) {
        log(`[HoverEditor] Suppressing re-trigger — conflict resolved ${msSinceResolved}ms ago`);
        return;
      }
      log('[HoverEditor] External change detected while editing — showing conflict UI');
      // Capture current content directly from editor (always fresh, not stale closure)
      const currentContent = (editor.storage as any).markdown?.getMarkdown() || '';
      fileCommands.getFileMtime(win.filePath).then(mtime => {
        setConflictState({
          myContent: currentContent,
          myFrontmatter: { ...frontmatter! },
          externalMtime: mtime,
        });
      });
      // Cancel any pending auto-save (conflict UI will handle it)
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
        saveTimeoutRef.current = null;
      }
      return;
    }

    log(`[HoverEditor] Reloading content for ${win.filePath} (trigger: ${win.contentReloadTrigger})`);

    // Cancel any pending auto-save before reloading external content
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = null;
    }

    isLoadingRef.current = true;

    // Invalidate cache first, then reload fresh from disk
    contentCacheActions.invalidateContent(win.filePath);
    contentCacheActions.getContent(win.filePath)
      .then(cached => {
        // Content hash comparison: skip reload if only mtime changed (phantom change)
        const currentBody = frontmatter?.canvas ? body : ((editor?.storage as any).markdown?.getMarkdown() || body);
        if (cached.body === currentBody) {
          log('[HoverEditor] Phantom change detected (mtime changed but content identical) — skipping reload');
          fileCommands.getFileMtime(win.filePath).then(m => { mtimeOnLoadRef.current = m; });
          isLoadingRef.current = false;
          return;
        }

        const fm = cached.frontmatter;
        setFrontmatter(fm);
        setBody(cached.body);
        setIsDirty(false);
        // Update mtime after external reload
        fileCommands.getFileMtime(win.filePath).then(m => { mtimeOnLoadRef.current = m; });

        // Show brief "externally updated" notice
        setExternalReloadNotice(true);
        setTimeout(() => setExternalReloadNotice(false), 3000);

        // If this is a canvas note, parse canvas data from body
        if (fm?.canvas) {
          try {
            const parsed = JSON.parse(cached.body || '{"nodes":[],"edges":[]}');
            setCanvasData(parsed);
          } catch {
            setCanvasData({ nodes: [], edges: [] });
          }
        } else {
          // Regular markdown note - update editor content
          if (editor) {
            editor.commands.setContent(cached.body || '');
          }
        }

        setTimeout(() => { isLoadingRef.current = false; }, 50);
      })
      .catch(err => {
        console.error('HoverEditor: Failed to reload:', err);
        isLoadingRef.current = false;
      });

    // Reload comments
    loadComments(win.filePath).then((result) => {
      setComments(result.comments);
      commentsMtimeRef.current = result.mtime;
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [win.contentReloadTrigger, win.filePath, editor]);

  // ========== NOTE-LEVEL EDITING LOCK ==========

  // Note-level editing lock: acquire + heartbeat + remote check (consolidated)
  useEffect(() => {
    if (!win.filePath || !vaultPath) return;

    // Acquire lock (editor type only) + heartbeat every 30s
    const isEditor = win.type === 'editor';
    if (isEditor) {
      noteLockCommands.acquireNoteLock(vaultPath, win.filePath).catch(() => {});
    }
    const heartbeatInterval = isEditor ? setInterval(() => {
      noteLockCommands.updateHeartbeat(vaultPath, win.filePath).catch(() => {});
    }, 30000) : null;

    // Check for remote locks every 10s
    const checkLock = () => {
      noteLockCommands.checkNoteLock(vaultPath, win.filePath)
        .then(setRemoteLock)
        .catch(() => {});
    };
    checkLock();
    const lockCheckInterval = setInterval(checkLock, 10000);

    return () => {
      if (heartbeatInterval) clearInterval(heartbeatInterval);
      clearInterval(lockCheckInterval);
      if (isEditor) {
        noteLockCommands.releaseNoteLock(vaultPath, win.filePath).catch(() => {});
      }
    };
  }, [win.filePath, vaultPath, win.type]);

  // Update comment decorations when comments actually change (deep equality check)
  useEffect(() => {
    const storage = editor?.storage as { commentMarks?: { comments: typeof comments } } | undefined;
    if (editor && storage?.commentMarks) {
      // Always sync data to storage
      storage.commentMarks.comments = comments;
      // Only dispatch (expensive re-render) if comments actually changed
      const key = comments.map(c => `${c.id}:${c.resolved}`).join(',');
      if (key !== prevCommentsKeyRef.current) {
        prevCommentsKeyRef.current = key;
        editor.view.dispatch(editor.state.tr);
      }
    }
  }, [comments, editor]);

  // NOTE: Removed empty transaction dispatch on fileTree change.
  // Wiki-link resolution uses ref-based callbacks (resolveLinkRef.current)
  // which automatically access the latest fileTree without needing a re-render.

  // Helper: optimistic patch for comment changes (instant Search UI update)
  const patchNoteForComments = useCallback((commentCount: number) => {
    const fm = frontmatterRef.current;
    if (!fm || !win.filePath) return;
    refreshActions.patchNote({
      path: win.filePath,
      title: fm.title || win.filePath.split(/[\\/]/).pop()?.replace(/\.md$/, '') || '',
      note_type: fm.type || '',
      tags: fm.tags || [],
      created: fm.created || '',
      modified: getCurrentTimestamp(),
      has_body: bodyRef.current.length > 0,
      comment_count: commentCount,
    });
  }, [win.filePath]);

  // Helper: after saveComments (which calls touchNoteModified), refresh the .md mtime
  // so HoverEditor's conflict detection doesn't mistake our own save as external
  const refreshMtimeAfterCommentSave = useCallback(() => {
    if (!win.filePath) return;
    // Delay slightly to ensure touchNoteModified's disk write has completed
    setTimeout(() => {
      fileCommands.getFileMtime(win.filePath).then(mtime => {
        mtimeOnLoadRef.current = mtime;
      }).catch(() => {});
    }, 200);
  }, [win.filePath]);

  const handleAddComment = useCallback(async (comment: NoteComment) => {
    const updated = [...comments, comment];
    setComments(updated);
    patchNoteForComments(updated.length);
    const result = await saveComments(win.filePath, updated, commentsMtimeRef.current);
    commentsMtimeRef.current = result.mtime;
    if (result.comments !== updated) setComments(result.comments);
    refreshActions.batchRefresh({ calendar: true });
    notifyMemoChanged(win.filePath).catch(() => {});
    refreshMtimeAfterCommentSave();
    // Clear preserved selection and task mode after adding comment
    setPreservedSelection(null);
    setPendingTaskMode(false);
  }, [comments, win.filePath, patchNoteForComments, refreshMtimeAfterCommentSave]);

  const handleDeleteComment = useCallback(async (commentId: string) => {
    const updated = comments.filter(c => c.id !== commentId);
    setComments(updated);
    patchNoteForComments(updated.length);
    const result = await saveComments(win.filePath, updated, commentsMtimeRef.current);
    commentsMtimeRef.current = result.mtime;
    if (result.comments !== updated) setComments(result.comments);
    refreshActions.batchRefresh({ calendar: true });
    notifyMemoChanged(win.filePath).catch(() => {});
    refreshMtimeAfterCommentSave();
    if (activeCommentId === commentId) setActiveCommentId(null);
  }, [comments, win.filePath, activeCommentId, patchNoteForComments, refreshMtimeAfterCommentSave]);

  const handleResolveComment = useCallback(async (commentId: string) => {
    const updated = comments.map(c => c.id === commentId ? { ...c, resolved: !c.resolved } : c);
    setComments(updated);
    patchNoteForComments(updated.length);
    const result = await saveComments(win.filePath, updated, commentsMtimeRef.current);
    commentsMtimeRef.current = result.mtime;
    if (result.comments !== updated) setComments(result.comments);
    refreshActions.batchRefresh({ calendar: true });
    notifyMemoChanged(win.filePath).catch(() => {});
    refreshMtimeAfterCommentSave();
  }, [comments, win.filePath, patchNoteForComments, refreshMtimeAfterCommentSave]);

  const handleUpdateComment = useCallback(async (commentId: string, updatedComment: NoteComment) => {
    const updated = comments.map(c => c.id === commentId ? updatedComment : c);
    setComments(updated);
    patchNoteForComments(updated.length);
    const result = await saveComments(win.filePath, updated, commentsMtimeRef.current);
    commentsMtimeRef.current = result.mtime;
    if (result.comments !== updated) setComments(result.comments);
    refreshActions.batchRefresh({ calendar: true });
    notifyMemoChanged(win.filePath).catch(() => {});
    refreshMtimeAfterCommentSave();
  }, [comments, win.filePath, patchNoteForComments, refreshMtimeAfterCommentSave]);

  // Optimistic patch when tags are saved via TagPanel
  const handleTagPanelSaved = useCallback((newTags: FacetedTags) => {
    const fm = frontmatterRef.current;
    if (!fm || !win.filePath) return;

    refreshActions.patchNote({
      path: win.filePath,
      title: fm.title || win.filePath.split(/[\\/]/).pop()?.replace(/\.md$/, '') || '',
      note_type: fm.type || '',
      tags: getFlatTags(newTags),
      created: fm.created || '',
      modified: getCurrentTimestamp(),
      has_body: bodyRef.current.length > 0,
      comment_count: commentsRef.current.length,
    });

    // Refresh mtime so HoverEditor's conflict detection doesn't mistake
    // TagPanel's own save as an external modification
    fileCommands.getFileMtime(win.filePath).then(mtime => {
      mtimeOnLoadRef.current = mtime;
    }).catch(() => {});
  }, [win.filePath]);

  // Toggle comment panel (view only — memo/task adding is via context menu)
  const handleToggleComments = useCallback(() => {
    if (showComments) {
      // Closing comment panel - clear preserved selection
      setPreservedSelection(null);
      setPendingTaskMode(false);
    }
    setShowComments(!showComments);
  }, [showComments]);

  // Add memo from context menu (preserves selection + opens comment panel)
  const handleAddMemoFromMenu = useCallback(() => {
    if (!editor || editor.state.selection.empty) return;
    const selectedText = editor.state.doc.textBetween(
      editor.state.selection.from,
      editor.state.selection.to,
      ' '
    );
    setPreservedSelection({
      text: selectedText,
      range: {
        from: editor.state.selection.from,
        to: editor.state.selection.to,
      },
    });
    setPendingTaskMode(false);
    setShowComments(true);
    setEditorMenuPos(null);
  }, [editor]);

  // Add task from context menu (same as memo but with task mode)
  const handleAddTaskFromMenu = useCallback(() => {
    if (!editor || editor.state.selection.empty) return;
    const selectedText = editor.state.doc.textBetween(
      editor.state.selection.from,
      editor.state.selection.to,
      ' '
    );
    setPreservedSelection({
      text: selectedText,
      range: {
        from: editor.state.selection.from,
        to: editor.state.selection.to,
      },
    });
    setPendingTaskMode(true);
    setShowComments(true);
    setEditorMenuPos(null);
  }, [editor]);

  // Clean broken wiki-links before closing
  const handleClose = useCallback(async () => {
    const closeStartTime = performance.now();

    // Get window reference once
    const currentWin = getCurrentWindow();
    const windowLabel = currentWin.label;
    const urlParams = new URLSearchParams(window.location.search);
    const isHoverFromUrl = urlParams.get('hover') === 'true';
    const isMultiWindow = windowLabel.startsWith('hover-') || isHoverFromUrl;

    log(`[HoverWindow] handleClose() - label: ${windowLabel}, isMultiWindow: ${isMultiWindow}`);

    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = null;
    }

    // Multi-window mode: save, index, then close
    if (isMultiWindow) {
      log('[HoverWindow] Multi-window mode detected, closing...');
      // If conflict UI is showing, auto-save my changes as a copy before closing (prevent data loss)
      if (conflictState && win.filePath && vaultPath) {
        try {
          const timestamp = new Date().toISOString().slice(0, 10);
          const closeParts = win.filePath.split(/[/\\]/);
          const closeSep = win.filePath.includes('\\') ? '\\' : '/';
          const closeBaseName = closeParts.pop()?.replace(/\.md$/, '') || 'note';
          const closeDir = closeParts.join(closeSep);
          const copyPath = `${closeDir}${closeSep}${closeBaseName} (내 변경 ${timestamp}).md`;
          const fmString = serializeFrontmatter({
            ...conflictState.myFrontmatter,
            modified: getCurrentTimestamp(),
          });
          await fileCommands.writeFile(copyPath, fmString, conflictState.myContent);
          markAsSelfSaved(copyPath);
          log(`[HoverWindow] Conflict auto-saved as copy before close: ${copyPath}`);
        } catch (err) {
          console.error('[HoverWindow] Conflict auto-save FAILED on close:', err);
        }
      } else if (isDirty && frontmatter && editor) {
        // Save before closing if dirty
        try {
          const currentBody = (editor.storage as any).markdown.getMarkdown();
          await saveFile(currentBody);
          // Explicitly wait for indexing to complete BEFORE closing
          // This ensures search index is updated before the window is destroyed
          await searchCommands.indexNote(win.filePath);
          refreshActions.incrementSearchRefresh();
          notifySearchIndexUpdated(win.filePath).catch(() => {});
          log('[HoverWindow] Saved and indexed before close');
        } catch (err) {
          console.error('Save/index before close failed:', err);
        }
      }
      // Close the OS window using destroy() for immediate closing
      log('[HoverWindow] Calling currentWin.destroy()...');
      try {
        await currentWin.destroy();
        log('[HoverWindow] destroy() completed');
      } catch (err) {
        console.error('[HoverWindow] Window destroy failed:', err);
      }
      return;
    }

    // DOM overlay mode: use animations
    const el = hoverEditorRef.current;
    if (el) {
      hoverActions.startClosing(win.id);
      runAnimation(el, 'close', HOVER_ANIMATION.CLOSE_DURATION).then(() => {
        hoverActions.finishClosing(win.id);
        log(`  [HoverWindow ${win.id.slice(-6)}] close animation finished (${(performance.now() - closeStartTime).toFixed(1)}ms total)`);
      });
    } else {
      hoverActions.startClosing(win.id);
      setTimeout(() => hoverActions.finishClosing(win.id), HOVER_ANIMATION.CLOSE_DURATION);
    }

    // If conflict UI is showing, auto-save my changes as a copy (prevent data loss)
    if (conflictState && win.filePath && vaultPath) {
      try {
        const timestamp = new Date().toISOString().slice(0, 10);
        const closeParts = win.filePath.split(/[/\\]/);
        const closeSep = win.filePath.includes('\\') ? '\\' : '/';
        const closeBaseName = closeParts.pop()?.replace(/\.md$/, '') || 'note';
        const closeDir = closeParts.join(closeSep);
        const copyPath = `${closeDir}${closeSep}${closeBaseName} (내 변경 ${timestamp}).md`;
        const fmString = serializeFrontmatter({
          ...conflictState.myFrontmatter,
          modified: getCurrentTimestamp(),
        });
        await fileCommands.writeFile(copyPath, fmString, conflictState.myContent);
        markAsSelfSaved(copyPath);
        appStoreActionsRef.current.refreshFileTree();
        searchCommands.indexNote(copyPath).then(() => {
          refreshActions.incrementSearchRefresh();
          notifySearchIndexUpdated(copyPath).catch(() => {});
        }).catch(() => {});
        log(`[HoverEditor] Conflict auto-saved as copy: ${copyPath}`);
      } catch (err) {
        console.error('[HoverEditor] Conflict auto-save FAILED on close:', err);
      }
      return;
    }

    // Save before closing
    if (isDirty && frontmatter) {
      const currentBody = editor ? (editor.storage as any).markdown.getMarkdown() : body;
      const syncGrace = remoteLock ? new Promise(r => setTimeout(r, 2000)) : Promise.resolve();
      await syncGrace;
      await saveFile(currentBody).catch(err => console.error('Background save failed:', err));
    }
  }, [isDirty, frontmatter, body, editor, saveFile, win.id, remoteLock, conflictState, vaultPath, win.filePath]);

  const handleMinimize = useCallback(async () => {
    const minimizeStartTime = performance.now();
    log(`[HoverWindow ${win.id.slice(-6)}] MINIMIZE BUTTON CLICKED`);

    // Multi-window mode: minimize the OS window directly
    const isMultiWindow = isHoverWindow();

    if (isMultiWindow) {
      // Save before minimizing
      if (isDirty && frontmatter) {
        await saveFile().catch(err => console.error('Background save failed:', err));
      }
      getCurrentWindow().minimize();
      log(`  [HoverWindow] handleMinimize() OS window minimized (${(performance.now() - minimizeStartTime).toFixed(2)}ms)`);
      return;
    }

    // DOM overlay mode: use animations
    const el = hoverEditorRef.current;
    if (el) {
      hoverActions.startMinimizing(win.id);
      runAnimation(el, 'minimize', HOVER_ANIMATION.MINIMIZE_DURATION).then(() => {
        hoverActions.finishMinimizing(win.id);
        log(`  [HoverWindow ${win.id.slice(-6)}] minimize animation finished (${(performance.now() - minimizeStartTime).toFixed(1)}ms total)`);
      });
    } else {
      hoverActions.startMinimizing(win.id);
      setTimeout(() => hoverActions.finishMinimizing(win.id), HOVER_ANIMATION.MINIMIZE_DURATION);
    }

    // If conflict UI is showing, auto-save my changes as a copy (prevent data loss)
    if (conflictState && win.filePath && vaultPath) {
      const timestamp = new Date().toISOString().slice(0, 10);
      const minParts = win.filePath.split(/[/\\]/);
      const minSep = win.filePath.includes('\\') ? '\\' : '/';
      const minBaseName = minParts.pop()?.replace(/\.md$/, '') || 'note';
      const minDir = minParts.join(minSep);
      const copyPath = `${minDir}${minSep}${minBaseName} (내 변경 ${timestamp}).md`;
      const fmString = serializeFrontmatter({
        ...conflictState.myFrontmatter,
        modified: getCurrentTimestamp(),
      });
      fileCommands.writeFile(copyPath, fmString, conflictState.myContent).then(() => {
        appStoreActionsRef.current.refreshFileTree();
        searchCommands.indexNote(copyPath).then(() => {
          refreshActions.incrementSearchRefresh();
          notifySearchIndexUpdated(copyPath).catch(() => {});
        }).catch(() => {});
        log(`[HoverEditor] Conflict auto-saved as copy on minimize: ${copyPath}`);
      }).catch(err => console.error('Conflict auto-save on minimize failed:', err));
    } else if (isDirty && frontmatter) {
      // Save in background (with sync grace period if another device was editing)
      const syncGrace = remoteLock ? new Promise(r => setTimeout(r, 2000)) : Promise.resolve();
      syncGrace.then(() => saveFile()).catch(err => console.error('Background save failed:', err));
    }
    log(`  [HoverWindow] handleMinimize() TOTAL: ${(performance.now() - minimizeStartTime).toFixed(2)}ms`);
  }, [isDirty, frontmatter, saveFile, win.id, remoteLock, conflictState, vaultPath, win.filePath]);

  // Ctrl+Wheel zoom state ref (to access current values in event handler)
  const zoomStateRef = useRef({ enabled: hoverZoomEnabled, level: hoverZoomLevel, isCanvas: false });
  zoomStateRef.current = { enabled: hoverZoomEnabled, level: hoverZoomLevel, isCanvas: !!frontmatter?.canvas };


  // Set up wheel event listener on the whole hover-editor window (using capture phase)
  useEffect(() => {
    const el = hoverEditorRef.current;
    if (!el) return;

    const handleWheel = (e: WheelEvent) => {
      const { enabled, level, isCanvas } = zoomStateRef.current;
      // Skip Ctrl+zoom for canvas notes (they have their own zoom via scroll)
      if (!enabled || !e.ctrlKey || isCanvas) return;

      // Prevent default browser zoom and TipTap scroll behavior
      e.preventDefault();
      e.stopPropagation();

      // Update zoom level
      const delta = e.deltaY > 0 ? -10 : 10;
      const newLevel = Math.min(200, Math.max(50, level + delta));
      appStoreActionsRef.current.setHoverZoomLevel(newLevel);
    };

    // Use capture phase to catch event before TipTap/ProseMirror
    el.addEventListener('wheel', handleWheel, { passive: false, capture: true });

    return () => {
      el.removeEventListener('wheel', handleWheel, { capture: true });
    };
  }, []);

  // Keyboard shortcuts for hover window (Ctrl+D, Ctrl+M, Ctrl+Shift+M)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Only handle if this window is focused (has highest zIndex)
      // The window should be focused when clicked

      // Ctrl+M: Toggle comments/memo panel
      if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'm') {
        e.preventDefault();
        setShowComments(prev => !prev);
        return;
      }

      // Ctrl+Shift+M: Toggle tag panel
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'm') {
        e.preventDefault();
        setShowTags(prev => !prev);
        return;
      }

      // Ctrl+D: Delete note (not for root containers)
      if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        const noteName = win.filePath.split(/[/\\]/).pop()?.replace(/\.md$/, '') || '';

        // Check if this is a folder note (filename matches parent folder name)
        const parts = win.filePath.replace(/\\/g, '/').split('/');
        const fileNameNoExt = (parts[parts.length - 1] || '').replace(/\.md$/, '');
        const parentFolder = parts[parts.length - 2] || '';
        const isFolderNote = fileNameNoExt.toLowerCase() === parentFolder.toLowerCase();

        if (isFolderNote) {
          // Check if this is a root container (parent folder is directly under vault)
          const folderPath = parts.slice(0, -1).join('/');
          const vaultNormalized = vaultPath?.replace(/\\/g, '/') || '';
          const folderDepth = folderPath.split('/').length;
          const vaultDepth = vaultNormalized.split('/').length;
          const isRootContainer = folderDepth === vaultDepth + 1;

          if (isRootContainer) {
            // Don't allow deletion of root containers via Ctrl+D
            return;
          }

          // Delete folder note and folder
          appStoreActionsRef.current.showConfirmDelete(parentFolder, 'folder', async () => {
            try {
              await appStoreActionsRef.current.deleteFolder(folderPath);
              await appStoreActionsRef.current.refreshFileTree();
            } catch (err) {
              console.error('Failed to delete folder:', err);
            }
          });
        } else {
          // Delete just the note
          appStoreActionsRef.current.showConfirmDelete(noteName, 'note', async () => {
            try {
              await appStoreActionsRef.current.deleteNote(win.filePath);
              await appStoreActionsRef.current.refreshFileTree();
            } catch (err) {
              console.error('Failed to delete note:', err);
            }
          });
        }
        return;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [win.filePath, vaultPath]);

  const handleMouseDown = () => {
    focusHoverFile(win.id);
  };

  // Double-click to toggle maximize
  const handleDoubleClick = useCallback(() => {
    // Multi-window mode: use Tauri's native maximize toggle
    if (isHoverWindow()) {
      getCurrentWindow().toggleMaximize();
      return;
    }

    // DOM overlay mode: manual maximize/restore
    const screenWidth = window.innerWidth;
    const screenHeight = window.innerHeight;

    // Check if currently maximized (fullscreen)
    const isMaximized = win.position.x === 0 && win.position.y === 0 &&
                        win.size.width === screenWidth && win.size.height === screenHeight;

    if (isMaximized) {
      // Restore to previous size/position
      if (preMaximizeStateRef.current) {
        updateHoverWindow(win.id, {
          position: preMaximizeStateRef.current.position,
          size: preMaximizeStateRef.current.size,
        });
        preMaximizeStateRef.current = null;
      } else {
        // If no saved state, restore to default center position
        updateHoverWindow(win.id, {
          position: { x: 350, y: 120 },
          size: { width: 1000, height: 800 },
        });
      }
    } else {
      // Save current state and maximize
      preMaximizeStateRef.current = {
        position: { ...win.position },
        size: { ...win.size },
      };
      updateHoverWindow(win.id, {
        position: { x: 0, y: 0 },
        size: { width: screenWidth, height: screenHeight },
      });
    }
  }, [win.id, win.position, win.size, updateHoverWindow]);

  // Drag
  const handleDragStart = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('.hover-editor-close') ||
        (e.target as HTMLElement).closest('.hover-editor-minimize') ||
        (e.target as HTMLElement).closest('.hover-editor-fm-toggle')) return;
    e.preventDefault();

    // Multi-window mode: use Tauri's native window dragging
    if (isHoverWindow()) {
      getCurrentWindow().startDragging();
      return;
    }

    // DOM overlay mode: track mouse positions manually
    setIsDragging(true);
    dragStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      posX: win.position.x,
      posY: win.position.y,
    };

    // Save size before snap ONLY if not already snapped
    const screenWidth = window.innerWidth;
    const screenHeight = window.innerHeight;
    const isFullscreen = (win.size.width === screenWidth && win.size.height === screenHeight);
    const isHalfWidth = (win.size.width === screenWidth / 2 && win.size.height === screenHeight);

    // If currently snapped and we don't have a saved size, something is wrong - save current size
    // If not snapped, save the current size as the pre-snap size
    if (!isFullscreen && !isHalfWidth) {
      preSnapSizeRef.current = {
        width: win.size.width,
        height: win.size.height,
      };
    }
    // If already snapped, keep the existing preSnapSizeRef (don't overwrite)
  };

  // Resize
  const handleResizeStart = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsResizing(true);
    resizeStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      w: win.size.width,
      h: win.size.height,
    };
  };

  // Ref to track current position during drag (for DOM manipulation)
  const currentPosRef = useRef({ x: win.position.x, y: win.position.y });
  const currentSizeRef = useRef({ width: win.size.width, height: win.size.height });
  // Track current snap zone - use ref to avoid ANY React re-renders during drag
  const currentSnapZoneRef = useRef<'left' | 'right' | null>(null);
  // Direct DOM ref for snap preview - bypasses React completely
  const snapPreviewRef = useRef<HTMLDivElement | null>(null);

  // Sync refs when win props change (from external updates)
  useEffect(() => {
    if (!isDragging) {
      currentPosRef.current = { x: win.position.x, y: win.position.y };
    }
    if (!isResizing) {
      currentSizeRef.current = { width: win.size.width, height: win.size.height };
    }
  }, [win.position.x, win.position.y, win.size.width, win.size.height, isDragging, isResizing]);

  useEffect(() => {
    if (!isDragging && !isResizing) return;

    let rafId: number | null = null;
    let lastMouseEvent: MouseEvent | null = null;

    const processMouseMove = () => {
      if (!lastMouseEvent || !hoverEditorRef.current) return;
      const e = lastMouseEvent;

      if (isDragging) {
        const dx = e.clientX - dragStartRef.current.x;
        const dy = e.clientY - dragStartRef.current.y;
        let finalX = dragStartRef.current.posX + dx;
        let finalY = dragStartRef.current.posY + dy;

        // Get current window/screen dimensions for boundary checking
        const windowWidth = currentSizeRef.current.width;
        const screenWidth = window.innerWidth;
        const screenHeight = window.innerHeight;

        // Boundary constraints - keep at least 100px visible on screen
        const MIN_VISIBLE = 100;
        const maxX = screenWidth - MIN_VISIBLE;
        const maxY = screenHeight - MIN_VISIBLE;
        const minX = MIN_VISIBLE - windowWidth;
        const minY = 0; // Don't allow dragging above the top edge

        finalX = Math.max(minX, Math.min(maxX, finalX));
        finalY = Math.max(minY, Math.min(maxY, finalY));

        // Update ref (not state)
        currentPosRef.current = { x: finalX, y: finalY };

        // Direct DOM manipulation - no React re-render
        hoverEditorRef.current.style.transform = `translate3d(${finalX}px, ${finalY}px, 0)`;

        // Snap detection - only left/right edges, small threshold (5px)
        const SNAP_THRESHOLD = 5;
        const currentWidth = preSnapSizeRef.current?.width || win.size.width;

        // Only detect left/right snap zones (no top fullscreen)
        let newZone: 'left' | 'right' | null = null;
        if (finalX < SNAP_THRESHOLD) {
          newZone = 'left';
        } else if (finalX + currentWidth > screenWidth - SNAP_THRESHOLD) {
          newZone = 'right';
        }

        // Minimal snap preview - only update if zone changed
        if (newZone !== currentSnapZoneRef.current) {
          currentSnapZoneRef.current = newZone;
          if (!snapPreviewRef.current) {
            snapPreviewRef.current = document.createElement('div');
            document.body.appendChild(snapPreviewRef.current);
          }
          const el = snapPreviewRef.current;
          if (newZone === 'left') {
            el.style.cssText = `position:fixed;left:0;top:0;width:${screenWidth >> 1}px;height:${screenHeight}px;display:block;background:rgba(100,150,255,0.1);border:1px solid rgba(100,150,255,0.4);pointer-events:none;z-index:9999;`;
          } else if (newZone === 'right') {
            el.style.cssText = `position:fixed;left:${screenWidth >> 1}px;top:0;width:${screenWidth >> 1}px;height:${screenHeight}px;display:block;background:rgba(100,150,255,0.1);border:1px solid rgba(100,150,255,0.4);pointer-events:none;z-index:9999;`;
          } else {
            el.style.display = 'none';
          }
        }
      }
      if (isResizing) {
        const dx = e.clientX - resizeStartRef.current.x;
        const dy = e.clientY - resizeStartRef.current.y;
        const newWidth = Math.max(300, resizeStartRef.current.w + dx);
        const newHeight = Math.max(200, resizeStartRef.current.h + dy);

        // Update ref (not state)
        currentSizeRef.current = { width: newWidth, height: newHeight };

        // Direct DOM manipulation - no React re-render
        hoverEditorRef.current.style.width = `${newWidth}px`;
        hoverEditorRef.current.style.height = `${newHeight}px`;
      }
      rafId = null;
    };

    const handleMouseMove = (e: MouseEvent) => {
      lastMouseEvent = e;
      if (rafId === null) {
        rafId = requestAnimationFrame(processMouseMove);
      }
    };

    const handleMouseUp = () => {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      if (isDragging) {
        const screenWidth = window.innerWidth;
        const screenHeight = window.innerHeight;
        const SNAP_THRESHOLD = 5;

        const finalX = currentPosRef.current.x;
        const currentWidth = preSnapSizeRef.current?.width || win.size.width;
        let snapped = false;

        // Left edge snap only
        if (finalX < SNAP_THRESHOLD) {
          if (!preSnapSizeRef.current) {
            preSnapSizeRef.current = { width: win.size.width, height: win.size.height };
          }
          updateHoverWindow(win.id, {
            position: { x: 0, y: 0 },
            size: { width: screenWidth >> 1, height: screenHeight },
          });
          snapped = true;
        }
        // Right edge snap only
        else if (finalX + currentWidth > screenWidth - SNAP_THRESHOLD) {
          if (!preSnapSizeRef.current) {
            preSnapSizeRef.current = { width: win.size.width, height: win.size.height };
          }
          updateHoverWindow(win.id, {
            position: { x: screenWidth >> 1, y: 0 },
            size: { width: screenWidth >> 1, height: screenHeight },
          });
          snapped = true;
        }

        // If not snapped, commit final position to state
        if (!snapped) {
          preSnapSizeRef.current = null;
          updateHoverWindow(win.id, {
            position: currentPosRef.current,
          });
        } else {
          // Trigger snap animation for smooth size transition
          setIsSnapping(true);
        }

        // Clean up snap preview DOM element (no React state needed)
        if (snapPreviewRef.current) {
          snapPreviewRef.current.remove();
          snapPreviewRef.current = null;
        }
        currentSnapZoneRef.current = null;
      }

      // Commit final size to state after resize
      if (isResizing) {
        updateHoverWindow(win.id, {
          size: currentSizeRef.current,
        });
      }

      setIsDragging(false);
      setIsResizing(false);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
      }
      // Clean up snap preview DOM element on unmount
      if (snapPreviewRef.current) {
        snapPreviewRef.current.remove();
        snapPreviewRef.current = null;
      }
    };
  }, [isDragging, isResizing, win.id, updateHoverWindow]);


  // Drag-drop via Tauri native events
  const handleFileDrop = useCallback(async (importedPaths: string[], position?: { x: number; y: number }) => {
    // Skip for canvas notes - they have their own drop handler in CanvasEditor
    if (frontmatter?.canvas) return;
    if (!editor) return;

    // IMPORTANT: Refresh file tree FIRST so new attachments are found by resolveLink
    // This must complete BEFORE inserting wikiLink nodes
    await appStoreActionsRef.current.refreshFileTree();

    // Build proper HTML structure for list items with wikilinks
    // NOTE: All importedPaths are in _att folder (attachments), so keep full filename with extension
    const listItems = importedPaths.map(path => {
      const fileName = path.split(/[/\\]/).pop() || '';
      return {
        type: 'listItem',
        content: [
          {
            type: 'paragraph',
            content: [
              {
                type: 'wikiLink',
                attrs: { fileName, isAttachmentAttr: true },
              },
            ],
          },
        ],
      };
    });

    // Find "첨부파일" or "Attachments" heading in the document
    const { doc, tr } = editor.state;
    let attachmentHeadingPos: number | null = null;
    let attachmentHeadingEndPos: number | null = null;
    let headingLevel: number = 1;
    let wasCollapsed = false;

    doc.descendants((node, pos) => {
      if (node.type.name === 'heading') {
        const text = node.textContent.trim().toLowerCase();
        if (text === '첨부파일' || text === 'attachments' || text === '# 첨부파일') {
          attachmentHeadingPos = pos;
          attachmentHeadingEndPos = pos + node.nodeSize;
          headingLevel = node.attrs.level || 1;
          wasCollapsed = node.attrs.collapsed || false;
          return false; // Stop searching
        }
      }
      return true;
    });

    let insertPos: number;

    if (attachmentHeadingPos !== null && attachmentHeadingEndPos !== null) {
      // Expand if collapsed
      if (wasCollapsed) {
        editor.chain()
          .focus()
          .command(({ tr }) => {
            tr.setNodeMarkup(attachmentHeadingPos!, undefined, {
              ...doc.nodeAt(attachmentHeadingPos!)?.attrs,
              collapsed: false,
            });
            return true;
          })
          .run();
      }

      // Find the END of the attachment section and check if the LAST element is a bulletList
      // We want to add attachments at the VERY END of the section
      let sectionEndPos: number = attachmentHeadingEndPos;
      let lastNodeInSection: { type: string; pos: number; endPos: number } | null = null;

      doc.nodesBetween(attachmentHeadingEndPos, doc.content.size, (node, pos) => {
        // Stop at next heading of same or higher level (end of attachment section)
        if (node.type.name === 'heading' && node.attrs.level <= headingLevel) {
          return false;
        }
        // Track each top-level node in the section
        const nodeEndPos = pos + node.nodeSize;
        sectionEndPos = nodeEndPos;
        lastNodeInSection = {
          type: node.type.name,
          pos,
          endPos: nodeEndPos,
        };
        return false; // Don't descend
      });

      if (lastNodeInSection && lastNodeInSection.type === 'bulletList') {
        // The LAST element in the section is a bulletList - append to it
        editor.chain()
          .focus()
          .insertContentAt(lastNodeInSection.endPos - 1, listItems)
          .run();
      } else if (lastNodeInSection && lastNodeInSection.type === 'paragraph') {
        // Last element is a paragraph - check if it's empty
        const lastNode = doc.nodeAt(lastNodeInSection.pos);
        if (lastNode && lastNode.textContent.trim() === '') {
          // Empty paragraph - replace it with bulletList
          editor.chain()
            .focus()
            .command(({ tr, state }) => {
              const bulletListNode = state.schema.nodeFromJSON({
                type: 'bulletList',
                content: listItems,
              });
              tr.replaceWith(lastNodeInSection.pos, lastNodeInSection.endPos, bulletListNode);
              return true;
            })
            .run();
        } else {
          // Non-empty paragraph - insert bulletList right after it (no gap)
          editor.chain()
            .focus()
            .command(({ tr, state }) => {
              const bulletListNode = state.schema.nodeFromJSON({
                type: 'bulletList',
                content: listItems,
              });
              // Insert right at the end position of the paragraph
              tr.insert(lastNodeInSection.endPos, bulletListNode);
              return true;
            })
            .run();
        }
      } else {
        // No content or other node type - create new list at the end
        editor.chain()
          .focus()
          .command(({ tr, state }) => {
            const bulletListNode = state.schema.nodeFromJSON({
              type: 'bulletList',
              content: listItems,
            });
            tr.insert(sectionEndPos, bulletListNode);
            return true;
          })
          .run();
      }
    } else {
      // No attachment section found - create one at the end
      const endPos = doc.content.size;
      editor.chain()
        .focus()
        .insertContentAt(endPos, [
          { type: 'paragraph' }, // Empty line before heading
          {
            type: 'heading',
            attrs: { level: 1 },
            content: [{ type: 'text', text: '첨부파일' }],
          },
          {
            type: 'bulletList',
            content: listItems,
          },
        ])
        .run();
    }

    // Clear any pending save timeout and save immediately
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = null;
    }

    refreshActions.incrementSearchRefresh();

    // Force editor to re-render decorations after React state updates
    // Need a small delay for React to update fileTree state from refreshFileTree()
    setTimeout(() => {
      if (editor && !editor.isDestroyed) {
        editor.view.dispatch(editor.state.tr);
      }
    }, 100);

    // Additional refresh after a longer delay to ensure all links are resolved
    setTimeout(() => {
      if (editor && !editor.isDestroyed) {
        editor.view.dispatch(editor.state.tr);
      }
    }, 500);

    // Manually trigger save to ensure changes are persisted immediately
    // Use the editor's markdown content
    const currentMarkdown = (editor.storage as any).markdown.getMarkdown();
    saveFile(currentMarkdown).then(() => {
      // After save, refresh all other hover windows showing this file
      refreshHoverWindowsForFile(win.filePath);
    });
  }, [editor, frontmatter?.canvas, saveFile, refreshHoverWindowsForFile, win.filePath]);

  const dropTargetRef = useDropTarget(
    `hover-editor-${win.id}`,
    win.filePath,
    handleFileDrop
  );

  const fileName = win.filePath.split(/[/\\]/).pop()?.replace(/\.md$/, '') || '';
  // Display name: replace underscores with spaces for better readability
  const displayFileName = fileName.replace(/_/g, ' ');

  // Check if this file is an attachment (in _att folder) - should not show metadata/memo buttons
  const isAttachmentFile = useMemo(() => {
    const normalizedPath = win.filePath.replace(/\\/g, '/');
    return normalizedPath.includes('_att/');
  }, [win.filePath]);

  // Container notes cannot have tags assigned
  const isContainerNote = frontmatter?.type?.toUpperCase() === 'CONTAINER';

  // Detect if this is a folder note (filename matches parent folder name)
  const folderPath = useMemo(() => {
    const parts = win.filePath.replace(/\\/g, '/').split('/');
    if (parts.length < 2) return null;
    const fileNameNoExt = (parts[parts.length - 1] || '').replace(/\.md$/, '');
    const parentFolder = parts[parts.length - 2] || '';
    if (fileNameNoExt.toLowerCase() === parentFolder.toLowerCase()) {
      // It's a folder note - return the parent folder path
      return parts.slice(0, -1).join('/');
    }
    return null;
  }, [win.filePath]);

  // Get note type CSS class and custom color
  const noteTypeClass = frontmatter?.type ? `${frontmatter.type.toLowerCase()}-type` : '';

  // Detect multi-window mode (separate OS window vs DOM overlay)
  const inMultiWindowMode = isHoverWindow();

  // Look up template custom color by note type
  const templateCustomColor = useMemo(() => {
    if (!frontmatter?.type) return undefined;
    const noteType = frontmatter.type.toLowerCase();
    const template = noteTemplates.find(t =>
      t.frontmatter.type?.toLowerCase() === noteType ||
      t.prefix.toLowerCase() === noteType
    );
    return template?.customColor;
  }, [frontmatter?.type, noteTemplates]);

  // Compute sync status for indicator
  const syncStatus: SyncStatus = conflictState ? 'conflict'
    : remoteLock ? 'editing-elsewhere'
    : isDirty ? 'editing'
    : 'synced';

  return (
    <div
      ref={(el) => {
        // Combine refs: hoverEditorRef and dropTargetRef for entire hover window drop target
        (hoverEditorRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
        if (!frontmatter?.canvas) {
          dropTargetRef(el);
        }
      }}
      className={`hover-editor${noteTypeClass ? ' ' + noteTypeClass : ''}${frontmatter?.cssclasses ? ' ' + frontmatter.cssclasses.join(' ') : ''}${isDragging ? ' is-dragging' : ''}${isResizing ? ' is-resizing' : ''}${isSnapping ? ' is-snapping' : ''}${templateCustomColor ? ' has-custom-color' : ''}`}
      style={{
        // Multi-window mode: fill the entire viewport
        // DOM overlay mode: use fixed positioning with transform
        ...(inMultiWindowMode ? {
          position: 'relative' as const,
          width: '100%',
          height: '100%',
          transform: 'none',
          border: 'none',
          borderRadius: 0,
          boxShadow: 'none',
        } : {
          transform: `translate3d(${win.position.x}px, ${win.position.y}px, 0)`,
          width: win.size.width,
          height: win.size.height,
          zIndex: win.zIndex,
        }),
        ...(templateCustomColor ? { '--template-color': templateCustomColor } as React.CSSProperties : {}),
      }}
      onMouseDown={handleMouseDown}
      data-drop-target={frontmatter?.canvas ? undefined : `hover-editor-${win.id}`}
      data-hover-id={win.id}
    >
      <div className="hover-editor-header" onMouseDown={handleDragStart} onDoubleClick={handleDoubleClick}>
        <span className="hover-editor-title">{displayFileName}</span>
        <SyncStatusIndicator status={syncStatus} deviceName={remoteLock?.hostname} />
        <div className="hover-editor-header-actions">
          {!isAttachmentFile && (
            <>
              {!isContainerNote && (
                <button
                  className={`hover-editor-fm-toggle ${showTags ? 'active' : ''}`}
                  onClick={() => setShowTags(!showTags)}
                  onMouseDown={(e) => e.stopPropagation()}
                  onDoubleClick={(e) => e.stopPropagation()}
                  title={t('tags', language)}
                >
                  <Tags size={14} />
                </button>
              )}
              <button
                className={`hover-editor-fm-toggle ${showComments ? 'active' : ''}`}
                onClick={handleToggleComments}
                onMouseDown={(e) => e.stopPropagation()}
                onDoubleClick={(e) => e.stopPropagation()}
                title={t('memo', language)}
              >
                <MessageSquare size={14} />
              </button>
            </>
          )}
          <button
            className="hover-editor-minimize"
            onClick={handleMinimize}
            onMouseDown={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
            title={t('minimize', language)}
          >
            <Minus size={14} />
          </button>
          <button
            className="hover-editor-close"
            onClick={handleClose}
            onMouseDown={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
          >
            <X size={14} />
          </button>
        </div>
      </div>
      {!frontmatter?.canvas && <EditorToolbar editor={editor} defaultCollapsed={toolbarDefaultCollapsed} />}
      {conflictState && (
        <div className="hover-editor-conflict-bar">
          <span className="conflict-bar-message">{t('conflictDetected', language)}</span>
          <div className="conflict-bar-actions">
            <button className="conflict-btn accept-external" onClick={handleConflictAcceptExternal}>
              {t('acceptExternal', language)}
            </button>
            <button className="conflict-btn keep-mine" onClick={handleConflictKeepMine}>
              {t('keepMine', language)}
            </button>
            <button className="conflict-btn save-both" onClick={handleConflictSaveBoth}>
              {t('keepBoth', language)}
            </button>
          </div>
        </div>
      )}
      {externalReloadNotice && !conflictState && (
        <div className="hover-editor-external-reload-notice">
          <span>{t('externallyUpdated', language)}</span>
        </div>
      )}
      {conflictCopyInfo && !conflictState && !conflictCopyBarDismissed && (
        <div className="hover-editor-conflict-copy-bar">
          <span className="conflict-copy-bar-message">{t('conflictCopy', language)} {conflictCopyInfo.originalName}</span>
          <div className="conflict-copy-bar-actions">
            <button className="conflict-copy-btn replace-original" onClick={handleConflictCopyReplace}>
              {t('replaceOriginal', language)}
            </button>
            <button className="conflict-copy-btn keep-original" onClick={handleConflictCopyDiscard}>
              {t('keepOriginal', language)}
            </button>
            <button className="conflict-copy-btn keep-both" onClick={() => setConflictCopyBarDismissed(true)}>
              {t('preserveBoth', language)}
            </button>
          </div>
        </div>
      )}
      {isNasSynced && isBulkSyncing && (
        <div className="hover-editor-sync-bar">
          <span className="sync-bar-spinner">↻</span>
          {t('syncInProgressHover', language)}
        </div>
      )}
      <div className={`hover-editor-content-row${folderPath ? ' is-folder-note' : ''}`}>
        <div
          ref={editorBodyRef}
          className={`hover-editor-body${frontmatter?.cssclasses ? ' ' + frontmatter.cssclasses.join(' ') : ''}`}
          style={frontmatter?.canvas ? undefined : { zoom: hoverZoomLevel / 100 }}
        >
          {(isContentLoading || (!editor && !frontmatter?.canvas)) ? (
            <div className="hover-editor-skeleton">
              <div className="skeleton-line skeleton-title" />
              <div className="skeleton-line skeleton-full" />
              <div className="skeleton-line skeleton-full" />
              <div className="skeleton-line skeleton-short" />
              <div className="skeleton-line skeleton-full" />
              <div className="skeleton-line skeleton-medium" />
            </div>
          ) : frontmatter?.canvas ? (
            <CanvasEditor
              data={canvasData}
              onChange={handleCanvasChange}
              readOnly={false}
              notePath={win.filePath}
              onSelectionChange={setCanvasSelection}
            />
          ) : editor ? (
            <EditorContent editor={editor} />
          ) : null}
        </div>
        {showComments && (
          <CommentPanel
            comments={comments}
            onAddComment={handleAddComment}
            onDeleteComment={handleDeleteComment}
            onResolveComment={handleResolveComment}
            onUpdateComment={handleUpdateComment}
            onCancel={() => {
              setPreservedSelection(null);
              setPendingTaskMode(false);
            }}
            selectedText={
              frontmatter?.canvas
                ? (canvasSelection?.text || '')
                : (preservedSelection?.text || '')
            }
            selectionRange={
              frontmatter?.canvas
                ? (canvasSelection ? { from: canvasSelection.from, to: canvasSelection.to } : null)
                : (preservedSelection?.range || null)
            }
            activeCommentId={activeCommentId}
            canvasSelection={frontmatter?.canvas ? canvasSelection : undefined}
            initialTaskMode={pendingTaskMode}
          />
        )}
        {showTags && vaultPath && !folderPath && (
          <div className="hover-editor-tag-panel">
            <TagPanel filePath={win.filePath} vaultPath={vaultPath} onSaved={handleTagPanelSaved} />
          </div>
        )}
      </div>
      {showTags && vaultPath && folderPath && (
        <div className="hover-editor-tag-section" data-drop-target={`hover-editor-${win.id}`}>
          <TagPanel filePath={win.filePath} vaultPath={vaultPath} onSaved={handleTagPanelSaved} />
        </div>
      )}
      {folderPath && (
        <div className="hover-editor-search-section" data-drop-target={`hover-editor-${win.id}`}>
          <Search
            containerPath={folderPath}
            refreshTrigger={searchRefreshTrigger}
            onCreateNote={async (e?: React.MouseEvent) => {
              const pos = e ? { x: e.clientX, y: e.clientY } : { x: 200, y: 200 };
              appStoreActionsRef.current.showTemplateSelector(pos, async (templateId: string) => {
                try {
                  // All templates now use modals for input
                  const newPath = await appStoreActionsRef.current.createNoteWithTemplate('', templateId, folderPath);
                  openHoverFile(newPath);
                } catch (e) {
                  console.error('Failed to create note:', e);
                }
              });
            }}
            onCreateFolder={async () => {
              try {
                await appStoreActionsRef.current.createFolder(t('newFolder', language), folderPath);
              } catch (e) {
                console.error('Failed to create folder:', e);
              }
            }}
          />
        </div>
      )}
      {!inMultiWindowMode && <div className="hover-editor-resize" onMouseDown={handleResizeStart} />}
      {editorMenuPos && editor && (
        <EditorContextMenu
          editor={editor}
          position={editorMenuPos}
          onClose={() => setEditorMenuPos(null)}
          onAddMemo={handleAddMemoFromMenu}
          onAddTask={handleAddTaskFromMenu}
        />
      )}
    </div>
  );
}, hoverWindowPropsAreEqual);

