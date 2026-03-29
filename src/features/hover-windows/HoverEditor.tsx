import { useState, useEffect, useRef, useCallback, useMemo, memo } from 'react';
import { EditorContent } from '@tiptap/react';
import type { Editor } from '@tiptap/core';
import { fileCommands, searchCommands, memoCommands } from '../../core/services/tauriCommands';
import { editorPool } from '../../core/editor/editorPool';
import { isHoverWindow } from '../../core/utils/multiWindow';
import { Tags, MessageSquare, Minus, X } from 'lucide-react';
import { SyncStatusIndicator, type SyncStatus } from '../shared/SyncStatusIndicator';
import { useIsClosing, useIsMinimizing } from './stores/hoverStore';
import { refreshActions } from '../../core/stores/refreshStore';
import { t } from '../../core/utils/i18n';
import type { NoteFrontmatter, NoteComment, CanvasData, CanvasSelection } from '../../core/types';
import { serializeFrontmatter, getCurrentTimestamp } from '../../core/utils/frontmatter';
import { markAsSelfSaved } from '../../core/utils/selfSaveTracker';
import { registerEditorSave, unregisterEditorSave } from '../../core/editor/editorSaveRegistry';
import { notifyFileSaved, notifySearchIndexUpdated } from '../../core/utils/windowSync';
import { saveComments } from '../comments/comments';
import EditorToolbar from '../note-editor/EditorToolbar';
import EditorContextMenu from '../note-editor/EditorContextMenu';
import CommentPanel from '../comments/CommentPanel';
import Search from '../search/Search';
import CanvasEditor from '../canvas/CanvasEditor';
import TagPanel from '../tags/TagPanel';
import { hoverWindowPropsAreEqual, type HoverEditorWindowProps } from './hoverAnimationUtils';
import { preprocessWikiLinks } from '../../core/utils/wikiLinkPreprocess';
import { useDropTarget } from '../../core/hooks/useDragDrop';
import { contentCacheActions } from '../content-cache/stores/contentCacheStore';

// Extracted hooks
import { useHoverEditorStores, useFileResolution } from './hooks/useHoverEditorState';
import { useConflictResolution } from '../note-editor/useConflictResolution';
import { useNoteLock } from '../note-editor/useNoteLock';
import { useNoteCommentHandlers } from '../comments/useNoteCommentHandlers';
import { useContentLoader } from '../note-editor/useContentLoader';
import {
  useWindowAnimation,
  useDragResize,
  useCloseMinimize,
  useCtrlWheelZoom,
  useKeyboardShortcuts,
  useFileDrop,
} from './hooks/useHoverEditorHandlers';

// Conditional logging - only in development
const DEV = import.meta.env.DEV;
const log = DEV ? console.log.bind(console) : () => {};

export const HoverEditorWindow = memo(function HoverEditorWindow({ window: win }: HoverEditorWindowProps) {
  // ========== PERFORMANCE TIMING ==========
  const mountTimeRef = useRef(performance.now());
  const timingLogRef = useRef<{ step: string; time: number }[]>([]);
  const logTiming = useCallback((step: string) => {
    const elapsed = performance.now() - mountTimeRef.current;
    timingLogRef.current.push({ step, time: elapsed });
    log(`[HoverEditor ${win.id.slice(-6)}] ${step}: ${elapsed.toFixed(1)}ms`);
  }, [win.id]);

  // Log mount
  useEffect(() => {
    logTiming('Component mounted');
    return () => {
      log(`[HoverEditor ${win.id.slice(-6)}] Unmounted. Full timing:`, timingLogRef.current);
    };
  }, []);

  // ========== STORE SUBSCRIPTIONS ==========
  const {
    fileTree,
    focusHoverFile,
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
  } = useHoverEditorStores();

  // ========== CORE STATE & REFS ==========
  const [frontmatter, setFrontmatter] = useState<NoteFrontmatter | null>(null);
  const [body, setBody] = useState('');
  const [isDirty, setIsDirty] = useState(false);
  const mtimeOnLoadRef = useRef<number>(0);
  const [editorMenuPos, setEditorMenuPos] = useState<{ x: number; y: number } | null>(null);
  const [canvasData, setCanvasData] = useState<CanvasData>({ nodes: [], edges: [] });
  const [canvasSelection, setCanvasSelection] = useState<CanvasSelection | null>(null);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const commentValidationTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isLoadingRef = useRef(false);
  const contentSetRef = useRef(false);
  const pendingBodyRef = useRef<string | null>(null);
  const prevCommentsKeyRef = useRef('');
  // Refs for stable saveFile callback
  const frontmatterRef = useRef<NoteFrontmatter | null>(null);
  frontmatterRef.current = frontmatter;
  const bodyRef = useRef('');
  bodyRef.current = body;
  const commentsRef = useRef<NoteComment[]>([]);
  const commentsMtimeRef = useRef<number>(0);

  // ========== ANIMATION ==========
  const isClosing = useIsClosing(win.id);
  const isMinimizing = useIsMinimizing(win.id);
  const hoverEditorRef = useRef<HTMLDivElement>(null);

  const { isOpening, isSnapping, setIsSnapping } = useWindowAnimation({
    winId: win.id,
    winCached: win.cached,
    winMinimized: win.minimized,
    isClosing,
    isMinimizing,
    hoverEditorRef,
  });

  // ========== FILE RESOLUTION ==========
  const conflictCopyInfoForAtt = useMemo(() => {
    if (!win.filePath) return null;
    const fileName = win.filePath.split(/[/\\]/).pop() || '';
    const match = fileName.match(/^(.+) \(내 변경 \d{4}-\d{2}-\d{2}\)\.md$/);
    if (!match) return null;
    return match[1];
  }, [win.filePath]);

  const effectiveAttStem = useMemo(() => {
    if (!win.filePath) return null;
    if (conflictCopyInfoForAtt) {
      const dir = win.filePath.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
      return `${dir}/${conflictCopyInfoForAtt}`;
    }
    return win.filePath.replace(/\.md$/i, '');
  }, [win.filePath, conflictCopyInfoForAtt]);

  const {
    resolveLink,
    getNoteType,
    isAttachment: isAttachmentFn,
    resolveFilePathImpl,
    handleLinkClick,
    handleContextMenu: handleContextMenuFn,
  } = useFileResolution(win.filePath, effectiveAttStem, openHoverFile);

  const handleContextMenu = useCallback((fileName: string, position: { x: number; y: number }, deleteCallback?: () => void) => {
    handleContextMenuFn(fileName, position, appStoreActionsRef.current.showContextMenu, deleteCallback);
  }, [handleContextMenuFn, appStoreActionsRef]);

  const handleEditorContextMenu = useCallback((pos: { x: number; y: number }) => {
    setEditorMenuPos(pos);
  }, []);

  // handleCommentClick uses refs to access commentHandlers (defined later, also used in editor pool closure)
  const commentHandlersRef = useRef<{
    setActiveCommentId: (id: string | null) => void;
    setShowComments: (v: boolean) => void;
    setComments?: React.Dispatch<React.SetStateAction<NoteComment[]>>;
  } | null>(null);
  const handleCommentClick = useCallback((commentId: string) => {
    commentHandlersRef.current?.setActiveCommentId(commentId);
    commentHandlersRef.current?.setShowComments(true);
  }, []);

  const editorBodyRef = useRef<HTMLDivElement>(null);

  // Use refs so WikiLink plugin always calls the latest functions
  const resolveLinkRef = useRef(resolveLink);
  resolveLinkRef.current = resolveLink;
  const getNoteTypeRef = useRef(getNoteType);
  getNoteTypeRef.current = getNoteType;
  const isAttachmentRef = useRef(isAttachmentFn);
  isAttachmentRef.current = isAttachmentFn;
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

  // Keep fileTree ref for WikiLinkSuggestion
  const fileTreeRef = useRef(fileTree);
  fileTreeRef.current = fileTree;
  const vaultPathRef = useRef(vaultPath || '');
  vaultPathRef.current = vaultPath || '';

  // ========== POOLED EDITOR ==========
  const [editor, setEditor] = useState<Editor | null>(null);
  const editorRef = useRef<Editor | null>(null);
  const editorAcquiredRef = useRef(false);

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
                commentHandlersRef.current?.setComments?.(validComments);
                saveComments(win.filePath, validComments, commentsMtimeRef.current).then((result) => {
                  commentsMtimeRef.current = result.mtime;
                  if (result.comments !== validComments) commentHandlersRef.current?.setComments?.(result.comments);
                  refreshActions.batchRefresh({ search: true, calendar: true });
                });
              }
            }
          }, 1000);

          if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
          saveTimeoutRef.current = setTimeout(() => {
            const markdown = (ed.storage as any).markdown.getMarkdown();
            saveFile(markdown);
          }, 300);
        });

        editorRef.current = pooledEditor;
        setEditor(pooledEditor);
        logTiming(`Editor acquired from pool (${(performance.now() - acquireStart).toFixed(1)}ms)`);

        if (pendingBodyRef.current !== null && !contentSetRef.current) {
          const setContentStart = performance.now();
          isLoadingRef.current = true;
          pooledEditor.commands.setContent(preprocessWikiLinks(pendingBodyRef.current));
          isLoadingRef.current = false;
          contentSetRef.current = true;
          pendingBodyRef.current = null;
          logTiming(`Editor setContent (deferred) (${(performance.now() - setContentStart).toFixed(1)}ms)`);
        }
      }
    };

    if (editorPool.isReady()) {
      doAcquire();
    } else {
      editorPool.init().then(doAcquire);
    }

    return () => {
      if (editorRef.current) {
        if (saveTimeoutRef.current) {
          clearTimeout(saveTimeoutRef.current);
          saveTimeoutRef.current = null;
        }
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
      editorAcquiredRef.current = false;
      setEditor(null);
    };
  }, []); // Only run once on mount

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

  // ========== SAVE FILE ==========
  const saveFile = useCallback(async (currentBody?: string) => {
    const fm = frontmatterRef.current;
    const bodyToSave = currentBody !== undefined ? currentBody : bodyRef.current;
    if (!win.filePath || !fm) return;

    if (isLoadingRef.current) {
      log('[HoverEditor] saveFile skipped -- content still loading');
      return;
    }

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

    const updatedFm: NoteFrontmatter = { ...fm, modified: getCurrentTimestamp() };
    const fmString = serializeFrontmatter(updatedFm);

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
    const { noteTypeCacheActions } = await import('../../features/content-cache/stores/noteTypeCacheStore');
    if (updatedFm.type && noteFileName) {
      noteTypeCacheActions.patchNoteType(noteFileName, updatedFm.type);
    }

    try {
      await fileCommands.writeFile(win.filePath, fmString, bodyToSave);
      setFrontmatter(updatedFm);
      setIsDirty(false);
      markAsSelfSaved(win.filePath);

      const estimatedMtime = Date.now();
      contentCacheActions.updateContent(win.filePath, bodyToSave, updatedFm, estimatedMtime);
      mtimeOnLoadRef.current = estimatedMtime;

      fileCommands.getFileMtime(win.filePath).then(realMtime => {
        mtimeOnLoadRef.current = realMtime;
        if (Math.abs(realMtime - estimatedMtime) > 1000) {
          contentCacheActions.updateContent(win.filePath, bodyToSave, updatedFm, realMtime);
        }
      }).catch(() => {});

      notifyFileSaved(win.filePath).catch(() => {});
      refreshActions.batchRefresh({ calendar: true });
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

  // ========== EMERGENCY SAVE REGISTRY ==========
  const isDirtyRef = useRef(false);
  isDirtyRef.current = isDirty;

  useEffect(() => {
    registerEditorSave(win.id, () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
        saveTimeoutRef.current = null;
      }
      const ed = editorRef.current;
      const fm = frontmatterRef.current;
      if (isDirtyRef.current && ed && !ed.isDestroyed && fm && !isLoadingRef.current) {
        const markdown = (ed.storage as any).markdown.getMarkdown();
        const updatedFm = { ...fm, modified: getCurrentTimestamp() };
        const fmString = serializeFrontmatter(updatedFm);
        fileCommands.writeFile(win.filePath, fmString, markdown).catch(() => {});
      }
    });
    return () => unregisterEditorSave(win.id);
  }, [win.id, win.filePath]);

  // ========== CONFLICT RESOLUTION (extracted hook) ==========
  const {
    conflictState,
    setConflictState,
    externalReloadNotice,
    setExternalReloadNotice,
    conflictResolvedAtRef,
    conflictCopyBarDismissed,
    setConflictCopyBarDismissed,
    conflictCopyInfo,
    handleConflictAcceptExternal,
    handleConflictKeepMine,
    handleConflictSaveBoth,
    handleConflictCopyReplace,
    handleConflictCopyDiscard,
  } = useConflictResolution({
    winId: win.id,
    winFilePath: win.filePath,
    vaultPath,
    frontmatterRef,
    bodyRef,
    editor,
    body,
    refreshHoverWindowsForFile,
    refreshFileTree: appStoreActionsRef.current.refreshFileTree,
  });

  // Wrap conflict handlers to update local state
  const handleConflictKeepMineWrapped = useCallback(async () => {
    const result = await handleConflictKeepMine();
    if (result) {
      setFrontmatter(result.updatedFm);
      setIsDirty(false);
      mtimeOnLoadRef.current = result.currentMtime;
      fileCommands.getFileMtime(win.filePath).then(m => { mtimeOnLoadRef.current = m; });
    }
  }, [handleConflictKeepMine, win.filePath]);

  const handleConflictAcceptExternalWrapped = useCallback(() => {
    handleConflictAcceptExternal();
    setIsDirty(false);
  }, [handleConflictAcceptExternal]);

  const handleConflictSaveBothWrapped = useCallback(async () => {
    await handleConflictSaveBoth();
    setIsDirty(false);
  }, [handleConflictSaveBoth]);

  // ========== COMMENT HANDLERS (extracted hook) ==========
  const commentHandlers = useNoteCommentHandlers({
    winFilePath: win.filePath,
    frontmatterRef,
    bodyRef,
    commentsRef,
    commentsMtimeRef,
    mtimeOnLoadRef,
    editor,
  });

  // Keep commentsRef and commentHandlersRef in sync
  commentsRef.current = commentHandlers.comments;
  commentHandlersRef.current = commentHandlers;

  // ========== CANVAS CHANGE ==========
  const handleCanvasChange = useCallback((data: CanvasData) => {
    setCanvasData(data);
    setIsDirty(true);

    const currentComments = commentsRef.current;
    if (currentComments.length > 0) {
      const validComments = currentComments.filter(comment => {
        if (!comment.canvasNodeId) return true;
        const node = data.nodes.find(n => n.id === comment.canvasNodeId);
        if (!node) return false;
        const { from, to } = comment.canvasTextPosition || comment.position;
        const nodeText = node.text || '';
        if (from < 0 || to > nodeText.length || from >= to) return false;
        return nodeText.substring(from, to) === comment.anchorText;
      });
      if (validComments.length < currentComments.length) {
        commentHandlersRef.current?.setComments?.(validComments);
        saveComments(win.filePath, validComments, commentsMtimeRef.current).then((result) => {
          commentsMtimeRef.current = result.mtime;
          if (result.comments !== validComments) commentHandlersRef.current?.setComments?.(result.comments);
          refreshActions.batchRefresh({ search: true, calendar: true });
        });
      }
    }

    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = setTimeout(() => {
      saveFile(JSON.stringify(data, null, 2));
    }, 300);
  }, [saveFile, win.filePath]);

  // ========== CONTENT LOADING (extracted hook) ==========
  const { isContentLoading } = useContentLoader({
    win,
    editor,
    editorRef,
    frontmatter,
    body,
    isDirty,
    setFrontmatter,
    setBody,
    setIsDirty,
    setCanvasData,
    setComments: commentHandlers.setComments,
    setConflictState,
    setExternalReloadNotice,
    mtimeOnLoadRef,
    commentsMtimeRef,
    isLoadingRef,
    contentSetRef,
    pendingBodyRef,
    saveTimeoutRef,
    conflictResolvedAtRef,
    resolveFilePathRef,
    conflictState,
    updateHoverWindow,
    saveFile,
    logTiming,
  });

  // ========== NOTE LOCK (extracted hook) ==========
  const { remoteLock } = useNoteLock({
    filePath: win.filePath,
    vaultPath,
    windowType: win.type,
  });

  // ========== COMMENT DECORATIONS ==========
  useEffect(() => {
    const storage = editor?.storage as { commentMarks?: { comments: typeof commentHandlers.comments } } | undefined;
    if (editor && storage?.commentMarks) {
      storage.commentMarks.comments = commentHandlers.comments;
      const key = commentHandlers.comments.map(c => `${c.id}:${c.resolved}`).join(',');
      if (key !== prevCommentsKeyRef.current) {
        prevCommentsKeyRef.current = key;
        editor.view.dispatch(editor.state.tr);
      }
    }
  }, [commentHandlers.comments, editor]);

  // ========== DRAG/RESIZE (extracted hook) ==========
  const {
    isDragging,
    isResizing,
    handleMouseDown,
    handleDoubleClick,
    handleDragStart,
    handleResizeStart,
  } = useDragResize({
    win,
    hoverEditorRef,
    updateHoverWindow,
    focusHoverFile,
    setIsSnapping,
  });

  // ========== CLOSE/MINIMIZE (extracted hook) ==========
  const { handleClose, handleMinimize } = useCloseMinimize({
    win,
    isDirty,
    frontmatter,
    body,
    editor,
    saveFile,
    remoteLock,
    conflictState,
    vaultPath,
    hoverEditorRef,
    saveTimeoutRef,
    refreshFileTree: appStoreActionsRef.current.refreshFileTree,
  });

  // ========== CTRL+WHEEL ZOOM (extracted hook) ==========
  useCtrlWheelZoom({
    hoverEditorRef,
    hoverZoomEnabled,
    hoverZoomLevel,
    isCanvas: !!frontmatter?.canvas,
    setHoverZoomLevel: appStoreActionsRef.current.setHoverZoomLevel,
  });

  // ========== KEYBOARD SHORTCUTS (extracted hook) ==========
  useKeyboardShortcuts({
    winFilePath: win.filePath,
    vaultPath,
    setShowComments: commentHandlers.setShowComments,
    setShowTags: commentHandlers.setShowTags,
    showConfirmDelete: appStoreActionsRef.current.showConfirmDelete,
    deleteNote: appStoreActionsRef.current.deleteNote,
    deleteFolder: appStoreActionsRef.current.deleteFolder,
    refreshFileTree: appStoreActionsRef.current.refreshFileTree,
  });

  // ========== FILE DROP (extracted hook) ==========
  const { handleFileDrop } = useFileDrop({
    editor,
    isCanvas: !!frontmatter?.canvas,
    saveFile,
    saveTimeoutRef,
    refreshHoverWindowsForFile,
    winFilePath: win.filePath,
    refreshFileTree: appStoreActionsRef.current.refreshFileTree,
  });

  const dropTargetRef = useDropTarget(
    `hover-editor-${win.id}`,
    win.filePath,
    handleFileDrop
  );

  // ========== COMPUTED VALUES ==========
  const fileName = win.filePath.split(/[/\\]/).pop()?.replace(/\.md$/, '') || '';
  const displayFileName = fileName.replace(/_/g, ' ');

  const isAttachmentFile = useMemo(() => {
    return win.filePath.replace(/\\/g, '/').includes('_att/');
  }, [win.filePath]);

  const isContainerNote = frontmatter?.type?.toUpperCase() === 'CONTAINER';

  const folderPath = useMemo(() => {
    const parts = win.filePath.replace(/\\/g, '/').split('/');
    if (parts.length < 2) return null;
    const fileNameNoExt = (parts[parts.length - 1] || '').replace(/\.md$/, '');
    const parentFolder = parts[parts.length - 2] || '';
    if (fileNameNoExt.toLowerCase() === parentFolder.toLowerCase()) {
      return parts.slice(0, -1).join('/');
    }
    return null;
  }, [win.filePath]);

  const noteTypeClass = frontmatter?.type ? `${frontmatter.type.toLowerCase()}-type` : '';
  const inMultiWindowMode = isHoverWindow();

  const templateCustomColor = useMemo(() => {
    if (!frontmatter?.type) return undefined;
    const noteType = frontmatter.type.toLowerCase();
    const template = noteTemplates.find(t =>
      t.frontmatter.type?.toLowerCase() === noteType ||
      t.prefix.toLowerCase() === noteType
    );
    return template?.customColor;
  }, [frontmatter?.type, noteTemplates]);

  const syncStatus: SyncStatus = conflictState ? 'conflict'
    : remoteLock ? 'editing-elsewhere'
    : isDirty ? 'editing'
    : 'synced';

  // ========== RENDER ==========
  return (
    <div
      ref={(el) => {
        (hoverEditorRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
        if (!frontmatter?.canvas) {
          dropTargetRef(el);
        }
      }}
      className={`hover-editor${noteTypeClass ? ' ' + noteTypeClass : ''}${frontmatter?.cssclasses ? ' ' + frontmatter.cssclasses.join(' ') : ''}${isDragging ? ' is-dragging' : ''}${isResizing ? ' is-resizing' : ''}${isSnapping ? ' is-snapping' : ''}${templateCustomColor ? ' has-custom-color' : ''}`}
      style={{
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
                  className={`hover-editor-fm-toggle ${commentHandlers.showTags ? 'active' : ''}`}
                  onClick={() => commentHandlers.setShowTags(!commentHandlers.showTags)}
                  onMouseDown={(e) => e.stopPropagation()}
                  onDoubleClick={(e) => e.stopPropagation()}
                  title={t('tags', language)}
                >
                  <Tags size={14} />
                </button>
              )}
              <button
                className={`hover-editor-fm-toggle ${commentHandlers.showComments ? 'active' : ''}`}
                onClick={commentHandlers.handleToggleComments}
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
            <button className="conflict-btn accept-external" onClick={handleConflictAcceptExternalWrapped}>
              {t('acceptExternal', language)}
            </button>
            <button className="conflict-btn keep-mine" onClick={handleConflictKeepMineWrapped}>
              {t('keepMine', language)}
            </button>
            <button className="conflict-btn save-both" onClick={handleConflictSaveBothWrapped}>
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
          <span className="sync-bar-spinner">&#x21BB;</span>
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
        {commentHandlers.showComments && (
          <CommentPanel
            comments={commentHandlers.comments}
            onAddComment={commentHandlers.handleAddComment}
            onDeleteComment={commentHandlers.handleDeleteComment}
            onResolveComment={commentHandlers.handleResolveComment}
            onUpdateComment={commentHandlers.handleUpdateComment}
            onCancel={() => {
              commentHandlers.setPreservedSelection(null);
              commentHandlers.setPendingTaskMode(false);
            }}
            selectedText={
              frontmatter?.canvas
                ? (canvasSelection?.text || '')
                : (commentHandlers.preservedSelection?.text || '')
            }
            selectionRange={
              frontmatter?.canvas
                ? (canvasSelection ? { from: canvasSelection.from, to: canvasSelection.to } : null)
                : (commentHandlers.preservedSelection?.range || null)
            }
            activeCommentId={commentHandlers.activeCommentId}
            canvasSelection={frontmatter?.canvas ? canvasSelection : undefined}
            initialTaskMode={commentHandlers.pendingTaskMode}
          />
        )}
        {commentHandlers.showTags && vaultPath && !folderPath && (
          <div className="hover-editor-tag-panel">
            <TagPanel filePath={win.filePath} vaultPath={vaultPath} onSaved={commentHandlers.handleTagPanelSaved} />
          </div>
        )}
      </div>
      {commentHandlers.showTags && vaultPath && folderPath && (
        <div className="hover-editor-tag-section" data-drop-target={`hover-editor-${win.id}`}>
          <TagPanel filePath={win.filePath} vaultPath={vaultPath} onSaved={commentHandlers.handleTagPanelSaved} />
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
          onAddMemo={commentHandlers.handleAddMemoFromMenu}
          onAddTask={commentHandlers.handleAddTaskFromMenu}
        />
      )}
    </div>
  );
}, hoverWindowPropsAreEqual);
