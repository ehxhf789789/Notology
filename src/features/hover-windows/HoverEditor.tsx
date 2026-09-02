
import { isHoverWindow } from '../../web/hoverContext';
import { useAttachmentStore } from '../attachments/stores/attachmentStore';
import { removeOrphanWikiLinkNodes, consumeFailedAdds } from '../attachments/orphanRemoval';
import { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo, memo } from 'react';
import { EditorContent } from '@tiptap/react';
import type { Editor } from '@tiptap/core';
import { fileCommands, searchCommands, memoCommands } from '../../core/services/tauriCommands';
import { editorPool } from '../../core/editor/editorPool';

import { Tags, MessageSquare, Minus, X, ListTree } from 'lucide-react';
import { SyncStatusIndicator, type SyncStatus } from '../shared/SyncStatusIndicator';
import { useIsClosing, useIsMinimizing } from './stores/hoverStore';
import { refreshActions } from '../../core/stores/refreshStore';
import { t } from '../../core/utils/i18n';
import type { NoteFrontmatter, NoteComment, SketchData, SketchSelection } from '../../core/types';
import { serializeFrontmatter, getCurrentTimestamp } from '../../core/utils/frontmatter';
import { markAsSelfSaved } from '../../core/utils/selfSaveTracker';
import { setWindowDirty, forgetWindow } from './dirtyRegistry';
import { registerEditorSave, unregisterEditorSave } from '../../core/editor/editorSaveRegistry';
import { notifyFileSaved, notifySearchIndexUpdated } from '../../core/utils/windowSync';
import { saveComments } from '../comments/comments';
import EditorToolbar from '../note-editor/EditorToolbar';
import SpeakerBar from '../note-editor/SpeakerBar';
import EditorBubbleMenu from '../note-editor/EditorBubbleMenu';
import OutlinePanel from '../outline/OutlinePanel';
import EditorContextMenu from '../note-editor/EditorContextMenu';
import CommentPanel from '../comments/CommentPanel';
import Search from '../search/Search';
import SketchEditor from '../sketch/SketchEditor';
import TagPanel from '../tags/TagPanel';
import { hoverWindowPropsAreEqual, type HoverEditorWindowProps } from './hoverAnimationUtils';
import { preprocessWikiLinks } from '../../core/utils/wikiLinkPreprocess';
import { useDropTarget } from '../../core/hooks/useDragDrop';
import { useSlashAttachmentListener } from '../slash-command';
import { EventBus } from '../../core/infrastructure/eventBus';
import { contentCacheActions } from '../content-cache/stores/contentCacheStore';
import { getTemplateCustomColor } from '../content-cache/noteTypeHelpers';
import { useFileLookupStore } from '../../core/stores/fileLookupStore';
import { useSettingsStore, type PaperStyle } from '../../core/stores/settingsStore';

/**
 * Round 2 R3 v6 (HanBin 2026-05-23) — paper pattern.
 *
 * Strategy switch from background-pattern → per-element text-decoration
 * for the RULED style. Background patterns can't follow Korean characters
 * (which fill the full em-box, leaving no half-leading gap), so any tile-
 * positioned line cuts through text. text-decoration positions itself
 * relative to each text line's OWN baseline + element font-size, so it
 * naturally adapts to every element type (h1/h2/h3/p/li) and to every
 * wrap-line within a multi-line paragraph.
 *
 * Dot / Grid stay as continuous-lattice CSS background patterns on the
 * editor element — those work fine because they're decorative grids, not
 * baseline-anchored lines.
 *
 * Plain → no decoration, no background.
 *
 * All this is now driven by a `data-paper` attribute on `.tiptap-editor`,
 * with the actual rules living in editor.css (see ".tiptap-editor[data-paper=…]"
 * block) so cascade order is predictable and CSS does the heavy lifting.
 */
function applyPaperPatternToEditorDOM(
  dom: HTMLElement | null,
  style: PaperStyle,
) {
  if (!dom) return;
  dom.setAttribute('data-paper', style);
}

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
  const isSketchNote = !!((frontmatter as any)?.sketch || (frontmatter as any)?.canvas || (!frontmatter && body.trimStart().startsWith('{') && body.includes('"nodes":')));
  const [isDirty, setIsDirty] = useState(false);
  useEffect(() => () => forgetWindow(win.id), [win.id]);

  // Round 2 R3 — paper pattern for this note. Per-note override via
  // frontmatter `paper:`, falling back to the global settingsStore default.
  // Sketch notes skip this entirely (their canvas has its own visual model).
  const globalPaperStyle = useSettingsStore(s => s.paperStyle);
  const [paperStyle, setPaperStyle] = useState<PaperStyle>(globalPaperStyle);
  useEffect(() => {
    if (isSketchNote) return;
    const fm = frontmatter as { paper?: unknown } | null;
    const fromFm = typeof fm?.paper === 'string' ? fm.paper : null;
    const next: PaperStyle = (fromFm === 'plain' || fromFm === 'ruled')
      ? fromFm
      : globalPaperStyle;
    setPaperStyle(next);
  }, [frontmatter, globalPaperStyle, isSketchNote]);

  const handlePaperStyleChange = useCallback((next: PaperStyle) => {
    setPaperStyle(next);
    // Persist to this note's frontmatter so re-opens preserve the choice.
    setFrontmatter(prev => ({ ...(prev ?? {}), paper: next } as NoteFrontmatter));
    setIsDirty(true);
  }, []);
  // Round 2 R3 (fix) — directly stamp data-paper onto the editor's view DOM
  // (the .tiptap-editor element). EditorContent mounts the ProseMirror view
  // as a grandchild of the wrapper, and the editor pool reuses one DOM node
  // across hover windows so a React-wrapper data attribute alone was getting
  // bypassed. Setting it on the actual rendered element guarantees the CSS
  // selector .tiptap-editor[data-paper="X"] matches.
  const mtimeOnLoadRef = useRef<number>(0) as React.MutableRefObject<number> & { current: number; __lastUpdateAt?: number };
  const lastSavedBodyRef = useRef<string | null>(null); // Tracks what WE last wrote/loaded from disk
  // Initialize lastSavedBodyRef when content is loaded (isDirty becomes false)
  useEffect(() => {
    if (!isDirty && body) { lastSavedBodyRef.current = body; }
  }, [isDirty, body]);
  const [editorMenuPos, setEditorMenuPos] = useState<{ x: number; y: number } | null>(null);
  // Stage 5.0.4b-4 (2026-05-16) — outline panel visibility. Local state because
  // it's editor-side concern, not a saved-per-vault preference like showTags.
  const [showOutline, setShowOutline] = useState(false);
  const [sketchData, setSketchData] = useState<SketchData>({ nodes: [], edges: [] });
  const [sketchSelection, setSketchSelection] = useState<SketchSelection | null>(null);
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

  // Round 2 R3 v4 — apply paper pattern directly to the editor's view DOM.
  // useLayoutEffect (not useEffect) so the style is set synchronously after
  // commit, before the browser paints — eliminates the "no pattern visible
  // for one frame after picking" flicker.
  // Pool reuse — the same view.dom may travel between hover windows, so we
  // always re-apply on (editor, paperStyle) change. Sketch notes skip.
  useLayoutEffect(() => {
    if (!editor || isSketchNote) {
      applyPaperPatternToEditorDOM(editor?.view?.dom as HTMLElement | null, 'plain');
      return;
    }
    applyPaperPatternToEditorDOM(editor.view.dom as HTMLElement, paperStyle);
    return () => {
      applyPaperPatternToEditorDOM(editor.view?.dom as HTMLElement | null, 'plain');
    };
  }, [editor, paperStyle, isSketchNote]);

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
        if (isDirtyRef.current && fm && !isLoadingRef.current) {
          const updatedFm = { ...fm, modified: getCurrentTimestamp() };
          const fmString = serializeFrontmatter(updatedFm);
          // SKETCH: use bodyRef (canvas JSON), not TipTap markdown
          const content = ((fm as any)?.sketch || (fm as any)?.canvas) ? bodyRef.current : (ed && !ed.isDestroyed ? (ed.storage as any).markdown.getMarkdown() : bodyRef.current);
          // Safety: never overwrite a file with empty body (prevents data loss on HMR/restart)
          if (content && content.trim().length > 0) {
            fileCommands.writeFile(win.filePath, fmString, content).catch(() => {});
          } else {
            console.warn('[HoverEditor] Unmount save SKIPPED: empty body would cause data loss');
          }
        }
        if (ed && !ed.isDestroyed) {
          ed.off('update');
          editorPool.release(ed);
        }
        editorRef.current = null;
      }
      editorAcquiredRef.current = false;
      setEditor(null);
    };
  }, []); // Only run once on mount

  // Force ProseMirror to re-run decorations when fileLookupStore changes (e.g., file deleted)
  const fileLookupVersion = useFileLookupStore((s) => s.version);
  useEffect(() => {
    if (editorRef.current?.view) {
      editorRef.current.view.dispatch(
        editorRef.current.state.tr.setMeta('fileTreeChanged', true)
      );
    }
  }, [fileLookupVersion]);

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
    const isSketch = bodyToSave ? (bodyToSave.trimStart().startsWith('{') && bodyToSave.includes('"nodes":')) : false;
    console.log('[saveFile]', { hasFm: !!fm, isSketch, bodyLen: bodyToSave?.length, isLoading: isLoadingRef.current, mtime: mtimeOnLoadRef.current });
    if (!win.filePath || !fm) { console.log('[saveFile] SKIP: no path or fm'); return; }

    if (isLoadingRef.current) {
      log('[HoverEditor] saveFile skipped -- content still loading');
      return;
    }

    // Note: External change detection is handled by contentReloadTrigger (file watcher path).
    // Pre-save mtime checks cause false conflicts because:
    // 1. Sync engine changes mtime without changing content
    // 2. Rust parser and TipTap markdown serialize differently (e.g. $math$)
    // 3. Self-save atomic writes create brief mtime gaps
    // So we just update mtime to current before saving — real conflicts are caught by the watcher.

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

    // Guard: never write empty body over existing content (prevents data loss)
    if (!isSketch && (!bodyToSave || bodyToSave.trim().length === 0)) {
      console.warn('[saveFile] BLOCKED: empty body would cause data loss', { filePath: win.filePath });
      return;
    }

    try {
      await fileCommands.writeFile(win.filePath, fmString, bodyToSave);
      lastSavedBodyRef.current = bodyToSave; // Track what we wrote for conflict detection
      setFrontmatter(updatedFm);
      setIsDirty(false);
      markAsSelfSaved(win.filePath);

      const estimatedMtime = Date.now();
      contentCacheActions.updateContent(win.filePath, bodyToSave, updatedFm, estimatedMtime);
      mtimeOnLoadRef.current = estimatedMtime;
      (mtimeOnLoadRef as any).__lastUpdateAt = Date.now();

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
  // 🔴 감시자가 「고치던 중인 창」을 알아야 지우기에 안 닫는다 (dirtyRegistry)
  setWindowDirty(win.id, isDirty);

  useEffect(() => {
    registerEditorSave(win.id, () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
        saveTimeoutRef.current = null;
      }
      const fm = frontmatterRef.current;
      if (isDirtyRef.current && fm && !isLoadingRef.current) {
        const updatedFm = { ...fm, modified: getCurrentTimestamp() };
        const fmString = serializeFrontmatter(updatedFm);
        // SKETCH: use bodyRef (canvas JSON), not TipTap markdown
        const ed = editorRef.current;
        const content = ((fm as any)?.sketch || (fm as any)?.canvas) ? bodyRef.current : (ed && !ed.isDestroyed ? (ed.storage as any).markdown.getMarkdown() : bodyRef.current);
        // Safety: never overwrite a file with empty body (prevents data loss on HMR/restart)
        if (content && content.trim().length > 0) {
          fileCommands.writeFile(win.filePath, fmString, content).catch(() => {});
        } else {
          console.warn('[HoverEditor] Emergency save SKIPPED: empty body would cause data loss');
        }
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
  const handleSketchChange = useCallback((data: SketchData) => {
    const jsonBody = JSON.stringify(data, null, 2);
    setSketchData(data);
    setBody(jsonBody);
    setIsDirty(true);

    const currentComments = commentsRef.current;
    if (currentComments.length > 0) {
      const validComments = currentComments.filter(comment => {
        if (!comment.sketchNodeId) return true;
        const node = data.nodes.find(n => n.id === comment.sketchNodeId);
        if (!node) return false;
        const { from, to } = comment.sketchTextPosition || comment.position;
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
    setSketchData,
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

  // Track B Phase B-3: refresh wikilink decorations when attachmentStore
  // hydrates or invalidates. Mirrors ContainerView's pattern so hover windows
  // also re-color chips immediately after the attachment index updates.
  const attachmentHydratedAt = useAttachmentStore((s) => s.hydratedAt);
  useEffect(() => {
    if (editor && editor.view && attachmentHydratedAt > 0) {
      editor.view.dispatch(editor.state.tr);
    }
  }, [attachmentHydratedAt, editor]);

  // Track B Phase B-3 PART 6: orphan prevention — drop into a hover window
  // and the backend rejects, strip the optimistic chip. Mirrors the
  // ContainerView wiring; filters by this hover window's note path so a
  // failure in a different open window does not strip from this one.
  //
  // Two-stage cleanup (HanBin 2026-05-13): mount-scan drains failures that
  // landed during a remount race (hover window reopened, HMR cycle), then
  // the live subscription handles failures while mounted.
  useEffect(() => {
    if (!editor || !win.filePath) return;
    const queued = consumeFailedAdds(win.filePath);
    if (queued.length > 0) {
      let total = 0;
      for (const fileName of queued) {
        total += removeOrphanWikiLinkNodes(editor, fileName);
      }
      if (total > 0) {
        console.warn(
          `[HoverEditor] mount-scan removed ${total} orphan wikilink(s):`,
          queued,
        );
      }
    }
    const off = EventBus.on('attachment:addFailed', ({ fileName, notePath }) => {
      const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase();
      if (norm(notePath) !== norm(win.filePath)) return;
      const removed = removeOrphanWikiLinkNodes(editor, fileName);
      if (removed > 0) {
        console.warn(
          `[HoverEditor] removed ${removed} orphan wikilink(s) for ${fileName} after attachment_add failure`,
        );
      }
    });
    return off;
  }, [editor, win.filePath]);

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
    isSketch: !!isSketchNote,
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
    handleClose,
    hoverEditorRef,
  });

  // ========== FILE DROP (extracted hook) ==========
  const { handleFileDrop } = useFileDrop({
    editor,
    isSketch: !!isSketchNote,
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

  // Stage 5.0.4b-2 part B (2026-05-15): wire the slash palette's "첨부파일"
  // command — opens a file picker, inserts wikilink chip(s) at the cursor,
  // and fires `attachment_add` in the background (same pipeline as drop).
  useSlashAttachmentListener(editor, win.filePath);

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

  // v18 fix (2026-05-16, HanBin) — defer to the shared helper so the editor
  // gets the same color resolution as the note list / search rows. The
  // helper returns:
  //   1. template.customColor if set (HSL picker / custom hex)
  //   2. PRESET_HEX[kind] if cssclasses[0] matches a known preset (so a
  //      user picking "Pink (SKETCH)" preset still tints the editor)
  //   3. undefined otherwise (built-in CSS rules take over)
  // Without this fallback, picking a preset would color the note list but
  // leave the editor stuck on the default note-type (purple) styling.
  // 🔴 **앞머리에 `type:` 이 없는 노트가 있다** (2026-08-25 실측: 행정 노트
  //    15/15 가 `cssclasses: adm-type` 만 갖고 `type:` 이 없다). 여기서
  //    바로 나가면 그 타입은 **영영 회색**이다 — 사용자가 두 번 지적한
  //    *"행정 타입은 hover 창에 색이 반영이 안되고 있다"* 가 이 한 줄이다.
  //
  //    → 세 곳을 차례로 본다. 하나라도 있으면 색을 준다:
  //        ① `type:`            앞머리가 밝힌 것
  //        ② `cssclasses`       `adm-type` → `adm`  (사람이 실제로 쓰는 것)
  //        ③ 파일 이름 접두      `ADM-231215-…` → `adm`  (3-1 의 명명 규칙)
  const templateCustomColor = useMemo(() => {
    const css = (frontmatter?.cssclasses as string[] | undefined)
      ?.find(c => typeof c === 'string' && c.endsWith('-type'));
    const fromName = (win.filePath?.split(/[/\\]/).pop() || '')
      .match(/^([A-Z]{2,8})-\d{6}-/)?.[1];
    const kind = frontmatter?.type
      || (css ? css.replace(/-type$/, '') : undefined)
      || fromName;
    if (!kind) return undefined;
    return getTemplateCustomColor(String(kind).toLowerCase(), noteTemplates);
  }, [frontmatter?.type, frontmatter?.cssclasses, win.filePath, noteTemplates]);

  const syncStatus: SyncStatus = conflictState ? 'conflict'
    : remoteLock ? 'editing-elsewhere'
    : isDirty ? 'editing'
    : 'synced';

  // ========== RENDER ==========
  return (
    <div
      ref={(el) => {
        (hoverEditorRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
        if (!isSketchNote) {
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
      data-drop-target={isSketchNote ? undefined : `hover-editor-${win.id}`}
      data-hover-id={win.id}
    >
      <div className="hover-editor-header" onMouseDown={handleDragStart} onDoubleClick={handleDoubleClick}>
        <span className="hover-editor-title">{displayFileName}</span>
        <SyncStatusIndicator status={syncStatus} deviceName={remoteLock?.hostname} />
        <div className="hover-editor-header-actions">
          {/* Stage 5.0.9 (2026-05-16) — Tab order is left-to-right by DOM
              source order. Each interactive button has an explicit aria-label
              for screen-readers (title alone isn't always announced). Toggle
              state communicated via aria-pressed. */}
          {!isAttachmentFile && (
            <>
              {/* Stage 5.0.4b-4: outline toggle. Available for all notes incl.
                  container notes (folder notes can have headings too).
                  v20 (2026-05-16, HanBin) — hidden on sketch notes: sketches
                  are canvases with no headings, so an outline is meaningless
                  ("스케치 노트에서는 outliner와 같은 기능이 없어야지"). */}
              {!isSketchNote && (
                <button
                  className={`hover-editor-fm-toggle ${showOutline ? 'active' : ''}`}
                  onClick={() => setShowOutline(v => !v)}
                  onMouseDown={(e) => e.stopPropagation()}
                  onDoubleClick={(e) => e.stopPropagation()}
                  title={t('outline', language)}
                  aria-label={t('outline', language)}
                  aria-pressed={showOutline}
                >
                  <ListTree size={14} />
                </button>
              )}
              {!isContainerNote && (
                <button
                  className={`hover-editor-fm-toggle ${commentHandlers.showTags ? 'active' : ''}`}
                  onClick={() => commentHandlers.setShowTags(!commentHandlers.showTags)}
                  onMouseDown={(e) => e.stopPropagation()}
                  onDoubleClick={(e) => e.stopPropagation()}
                  title={`${t('tags', language)} (Ctrl+Shift+M)`}
                  aria-label={t('tags', language)}
                  aria-pressed={commentHandlers.showTags}
                >
                  <Tags size={14} />
                </button>
              )}
              <button
                className={`hover-editor-fm-toggle ${commentHandlers.showComments ? 'active' : ''}`}
                onClick={commentHandlers.handleToggleComments}
                onMouseDown={(e) => e.stopPropagation()}
                onDoubleClick={(e) => e.stopPropagation()}
                title={`${t('memo', language)} (Ctrl+M)`}
                aria-label={t('memo', language)}
                aria-pressed={commentHandlers.showComments}
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
            aria-label={t('minimize', language)}
          >
            <Minus size={14} />
          </button>
          <button
            className="hover-editor-close"
            onClick={handleClose}
            onMouseDown={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
            title={`${t('close', language)} (Ctrl+W / Esc)`}
            aria-label={t('close', language)}
          >
            <X size={14} />
          </button>
        </div>
      </div>
      {!isSketchNote && (
        <EditorToolbar
          editor={editor}
          defaultCollapsed={toolbarDefaultCollapsed}
          paperStyle={paperStyle}
          onPaperStyleChange={handlePaperStyleChange}
          vaultPath={null}
        />
      )}
      {!isSketchNote && <EditorBubbleMenu editor={editor as Editor} />}
      {/* 회의 화자 칩 — 분리는 dobbin, 이름은 사람 (2026-09-02). 화자 없는
          노트에서는 스스로 아무것도 안 그린다. */}
      {win.filePath && (
        <SpeakerBar notePath={win.filePath}
          onRenamed={() => { try { (window as { __reloadNote?: (p: string) => void }).__reloadNote?.(win.filePath!); } catch { /* 새로고침 훅 없으면 다음 열람 때 보인다 */ } }} />
      )}
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
          // Round 2 R3 v4 — paper pattern is applied to the editor's view DOM
          // (.tiptap-editor) by useLayoutEffect above, NOT here. This keeps the
          // pattern aligned with the editor's own padding + font-size rhythm.
          data-paper={!isSketchNote ? paperStyle : undefined}
          style={isSketchNote ? undefined : { zoom: hoverZoomLevel / 100 }}
        >
          {(isContentLoading || (!editor && !isSketchNote)) ? (
            <div className="hover-editor-skeleton">
              <div className="skeleton-line skeleton-title" />
              <div className="skeleton-line skeleton-full" />
              <div className="skeleton-line skeleton-full" />
              <div className="skeleton-line skeleton-short" />
              <div className="skeleton-line skeleton-full" />
              <div className="skeleton-line skeleton-medium" />
            </div>
          ) : isSketchNote ? (
            <SketchEditor
              data={sketchData}
              onChange={handleSketchChange}
              readOnly={false}
              notePath={win.filePath}
              onSelectionChange={setSketchSelection}
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
              isSketchNote
                ? (sketchSelection?.text || '')
                : (commentHandlers.preservedSelection?.text || '')
            }
            selectionRange={
              isSketchNote
                ? (sketchSelection ? { from: sketchSelection.from, to: sketchSelection.to } : null)
                : (commentHandlers.preservedSelection?.range || null)
            }
            activeCommentId={commentHandlers.activeCommentId}
            sketchSelection={isSketchNote ? sketchSelection : undefined}
            initialTaskMode={commentHandlers.pendingTaskMode}
          />
        )}
        {/* Stage 5.0.4b-4 (2026-05-16) — unified panel placement.
            Previously TagPanel split between right-sidebar (no folderPath) and
            below-section (with folderPath). Now both folder and non-folder
            notes render TagPanel as a right-sidebar inside `.hover-editor-content-row`,
            matching CommentPanel's placement contract per plan §18d. */}
        {commentHandlers.showTags && vaultPath && (
          <div className="hover-editor-tag-panel">
            <TagPanel filePath={win.filePath} vaultPath={vaultPath} onSaved={commentHandlers.handleTagPanelSaved} />
          </div>
        )}
        {/* v20 — outline panel suppressed for sketches even if state somehow stays
            true from a prior non-sketch note (defense-in-depth). */}
        {showOutline && editor && !isSketchNote && (
          <OutlinePanel editor={editor as Editor} />
        )}
      </div>
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
