import { useState, useEffect, useRef, useCallback } from 'react';
import type { Editor } from '@tiptap/core';
import { fileCommands } from '../../core/services/tauriCommands';
import { contentCacheActions } from '../content-cache/stores/contentCacheStore';
import type { NoteFrontmatter, NoteComment, SketchData, HoverWindow } from '../../core/types';
import { loadComments } from '../comments/comments';
import { preprocessWikiLinks } from '../../core/utils/wikiLinkPreprocess';
import { looksSame } from '../../core/utils/markdownShape';
import type { ConflictState } from './useConflictResolution';

// Conditional logging - only in development
const DEV = import.meta.env.DEV;
const log = DEV ? console.log.bind(console) : () => {};

export interface UseContentLoaderParams {
  win: HoverWindow;
  editor: Editor | null;
  editorRef: React.MutableRefObject<Editor | null>;
  frontmatter: NoteFrontmatter | null;
  body: string;
  isDirty: boolean;
  setFrontmatter: React.Dispatch<React.SetStateAction<NoteFrontmatter | null>>;
  setBody: React.Dispatch<React.SetStateAction<string>>;
  setIsDirty: React.Dispatch<React.SetStateAction<boolean>>;
  setSketchData: React.Dispatch<React.SetStateAction<SketchData>>;
  setComments: React.Dispatch<React.SetStateAction<NoteComment[]>>;
  setConflictState: React.Dispatch<React.SetStateAction<ConflictState | null>>;
  setExternalReloadNotice: React.Dispatch<React.SetStateAction<boolean>>;
  mtimeOnLoadRef: React.MutableRefObject<number>;
  commentsMtimeRef: React.MutableRefObject<number>;
  isLoadingRef: React.MutableRefObject<boolean>;
  contentSetRef: React.MutableRefObject<boolean>;
  pendingBodyRef: React.MutableRefObject<string | null>;
  saveTimeoutRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>;
  conflictResolvedAtRef: React.MutableRefObject<number>;
  resolveFilePathRef: React.MutableRefObject<(name: string) => string | null>;
  conflictState: ConflictState | null;
  updateHoverWindow: (id: string, updates: Partial<HoverWindow>) => void;
  saveFile: (currentBody?: string) => Promise<void>;
  logTiming: (step: string) => void;
}

export function useContentLoader({
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
  setComments,
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
}: UseContentLoaderParams) {
  const [isContentLoading, setIsContentLoading] = useState(true);
  const prevFilePathRef = useRef<string | null>(null);

  // Process loaded content (used by both sync and async paths)
  const processLoadedContent = useCallback((cached: { frontmatter: any; body: string; mtime?: number }) => {
    const fm = cached.frontmatter;
    setFrontmatter(fm);
    setBody(cached.body);
    setIsDirty(false);
    if (win.filePath) {
      if (cached.mtime) {
        mtimeOnLoadRef.current = cached.mtime;
      } else {
        fileCommands.getFileMtime(win.filePath).then(m => { mtimeOnLoadRef.current = m; });
      }
    }
    logTiming('State updated (frontmatter, body)');

    if (fm?.type && !win.noteType) {
      updateHoverWindow(win.id, { noteType: fm.type.toLowerCase() });
    }

    if ((fm as any)?.sketch || (fm as any)?.canvas) {
      try {
        const parsed = JSON.parse(cached.body || '{"nodes":[],"edges":[]}');
        setSketchData(parsed);
      } catch {
        setSketchData({ nodes: [], edges: [] });
      }
      if (!cached.body || cached.body.trim() === '') {
        const initialJson = JSON.stringify({ nodes: [], edges: [] }, null, 2);
        setBody(initialJson);
        setTimeout(() => { saveFile(initialJson); }, 100);
      }
      logTiming('Canvas data parsed');
    } else {
      if (editorRef.current && !contentSetRef.current) {
        const setContentStart = performance.now();
        editorRef.current.commands.setContent(preprocessWikiLinks(cached.body || ''));
        contentSetRef.current = true;
        logTiming(`Editor setContent (immediate) (${(performance.now() - setContentStart).toFixed(1)}ms)`);
      } else if (!editorRef.current) {
        pendingBodyRef.current = cached.body || '';
        logTiming('Body loaded, stored for editor');
      }
    }

    isLoadingRef.current = false;
    setIsContentLoading(false);
    logTiming('Loading complete');

    // OPTIMIZATION: Preload wiki-linked notes for instant opening
    const wikiLinkMatches = cached.body.match(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g);
    if (wikiLinkMatches) {
      const linkedNames = wikiLinkMatches.map((m: string) => m.replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/, '$1'));
      linkedNames.slice(0, 5).forEach((name: string) => {
        const linkedPath = resolveFilePathRef.current(name);
        if (linkedPath && linkedPath.endsWith('.md')) {
          contentCacheActions.preloadContent(linkedPath);
        }
      });
    }
  }, [win.id, win.filePath, win.noteType, updateHoverWindow, saveFile, setFrontmatter, setBody, setIsDirty, setSketchData, mtimeOnLoadRef, isLoadingRef, contentSetRef, pendingBodyRef, editorRef, resolveFilePathRef, logTiming]);

  // Load file - uses content cache for instant loading of recently viewed files
  useEffect(() => {
    if (!win.filePath || win.filePath === prevFilePathRef.current) return;
    prevFilePathRef.current = win.filePath;

    contentSetRef.current = false;
    pendingBodyRef.current = null;
    logTiming('File load started');
    isLoadingRef.current = true;

    const syncCached = contentCacheActions.getContentSync(win.filePath);
    if (syncCached) {
      logTiming('SYNC cache hit - processing immediately');
      processLoadedContent(syncCached);
      return;
    }

    setIsContentLoading(true);
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
        setIsContentLoading(false);
      });

    loadComments(win.filePath).then((result) => {
      setComments(result.comments);
      commentsMtimeRef.current = result.mtime;
    });
  }, [win.filePath, processLoadedContent, contentSetRef, pendingBodyRef, isLoadingRef, commentsMtimeRef, setComments, logTiming]);

  // Set editor content when both editor and body are ready (fallback for async path)
  useEffect(() => {
    if (!editor || !body || ((frontmatter as any)?.sketch || (frontmatter as any)?.canvas)) return;
    if (contentSetRef.current) return;

    const setContentStart = performance.now();
    isLoadingRef.current = true;
    editor.commands.setContent(preprocessWikiLinks(body));
    isLoadingRef.current = false;
    contentSetRef.current = true;
    logTiming(`Editor setContent (fallback) (${(performance.now() - setContentStart).toFixed(1)}ms)`);
  }, [editor, body, (frontmatter as any)?.sketch, (frontmatter as any)?.canvas, contentSetRef, isLoadingRef, logTiming]);

  // Reload content when contentReloadTrigger changes
  const prevReloadTriggerRef = useRef(win.contentReloadTrigger);
  useEffect(() => {
    if (!win.contentReloadTrigger || !win.filePath) return;
    if (prevReloadTriggerRef.current === win.contentReloadTrigger) return;
    prevReloadTriggerRef.current = win.contentReloadTrigger;

    if (conflictState) {
      log('[HoverEditor] Skipping content reload during active conflict resolution');
      return;
    }
    if (!editor || isLoadingRef.current) return;

    if (isDirty) {
      const msSinceResolved = Date.now() - conflictResolvedAtRef.current;
      if (msSinceResolved < 5000) {
        log(`[HoverEditor] Suppressing re-trigger -- conflict resolved ${msSinceResolved}ms ago`);
        return;
      }
      // Suppress if own save completed recently (within 5s)
      const msSinceLastSave = Date.now() - ((mtimeOnLoadRef as any).__lastUpdateAt || 0);
      if (msSinceLastSave < 5000) {
        log(`[HoverEditor] Suppressing -- own save ${msSinceLastSave}ms ago`);
        return;
      }
      // Content-based conflict detection: compare disk vs what we last saved.
      // If disk still has our content → no external change → suppress.
      const currentContent = (editor.storage as any).markdown?.getMarkdown() || '';
      import('../../core/services/tauriCommands').then(({ fileCommands: fc }) => {
        fc.readFile(win.filePath).then(diskFile => {
          const diskBody = diskFile.body ?? '';
          // Use body state as proxy for "last saved/loaded content"
          if (diskBody.trim() === body.trim()) {
            log('[HoverEditor] Disk matches last loaded content -- suppressing conflict');
            fc.getFileMtime(win.filePath).then(m => { mtimeOnLoadRef.current = m; });
            return;
          }
          // 🔴 꾸밈만 다른 것은 충돌이 아니다 (2026-09-04).
          //    dobbin 이 쓰는 색 칩(`<span style=…>`, 서가 노트 382/420 = 90%)을
          //    이 편집기가 되돌려 쓰지 못한다 — 열기만 해도 `on('update')` 가
          //    돌아 dirty 가 되고, 그러면 이 검사가 늘 「다르다」를 낸다.
          //    그래서 한빈님 화면에 배너가 **창을 열 때마다** 떴다.
          //    아래 재적재 갈래가 이미 「Phantom change」로 하는 일과 같다.
          if (looksSame(diskBody, currentContent)) {
            log('[HoverEditor] Only formatting differs (span/escape/space) -- suppressing conflict');
            fc.getFileMtime(win.filePath).then(m => { mtimeOnLoadRef.current = m; });
            return;
          }
          // Real conflict: someone else changed the file
          log('[HoverEditor] Real external content change -- showing conflict UI');
          fc.getFileMtime(win.filePath).then(mtime => {
            setConflictState({
              myContent: currentContent,
              myFrontmatter: { ...frontmatter! },
              externalMtime: mtime,
            });
          });
          if (saveTimeoutRef.current) {
            clearTimeout(saveTimeoutRef.current);
            saveTimeoutRef.current = null;
          }
        }).catch(() => {
          log('[HoverEditor] Cannot read file for conflict check -- suppressing');
        });
      });
      return;
    }

    log(`[HoverEditor] Reloading content for ${win.filePath} (trigger: ${win.contentReloadTrigger})`);

    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = null;
    }

    isLoadingRef.current = true;
    contentCacheActions.invalidateContent(win.filePath);
    contentCacheActions.getContent(win.filePath)
      .then(cached => {
        const currentBody = ((frontmatter as any)?.sketch || (frontmatter as any)?.canvas) ? body : ((editor?.storage as any).markdown?.getMarkdown() || body);
        if (cached.body === currentBody) {
          log('[HoverEditor] Phantom change detected (mtime changed but content identical) -- skipping reload');
          fileCommands.getFileMtime(win.filePath).then(m => { mtimeOnLoadRef.current = m; });
          isLoadingRef.current = false;
          return;
        }

        const fm = cached.frontmatter;
        setFrontmatter(fm);
        setBody(cached.body);
        setIsDirty(false);
        fileCommands.getFileMtime(win.filePath).then(m => { mtimeOnLoadRef.current = m; });

        setExternalReloadNotice(true);
        setTimeout(() => setExternalReloadNotice(false), 3000);

        if ((fm as any)?.sketch || (fm as any)?.canvas) {
          try {
            const parsed = JSON.parse(cached.body || '{"nodes":[],"edges":[]}');
            setSketchData(parsed);
          } catch {
            setSketchData({ nodes: [], edges: [] });
          }
        } else {
          if (editor) {
            editor.commands.setContent(preprocessWikiLinks(cached.body || ''));
          }
        }

        setTimeout(() => { isLoadingRef.current = false; }, 50);
      })
      .catch(err => {
        console.error('HoverEditor: Failed to reload:', err);
        isLoadingRef.current = false;
      });

    loadComments(win.filePath).then((result) => {
      setComments(result.comments);
      commentsMtimeRef.current = result.mtime;
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [win.contentReloadTrigger, win.filePath, editor]);

  return { isContentLoading };
}
