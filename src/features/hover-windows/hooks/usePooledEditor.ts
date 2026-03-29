import { useEffect, useRef, useState, useCallback } from 'react';
import { Editor } from '@tiptap/core';
import { editorPool } from '../../../core/editor/editorPool';
import type { FileNode } from '../../../core/types';

interface UsePooledEditorOptions {
  onClickLink: (name: string) => void;
  onContextMenu: (name: string, pos: { x: number; y: number }, deleteCallback?: () => void) => void;
  resolveLink: (name: string) => boolean;
  getNoteType: (name: string) => string | null;
  isAttachment: (name: string) => boolean;
  onEditorContextMenu: (pos: { x: number; y: number }) => void;
  onCommentClick: (commentId: string) => void;
  getFileTree: () => FileNode[];
  notePath: string;
  vaultPath: string;
  resolveFilePath: (name: string) => string | null;
  onUpdate?: (editor: Editor) => void;
  onCreate?: () => void;
}

interface UsePooledEditorResult {
  editor: Editor | null;
  isPooled: boolean;
}

export function usePooledEditor(options: UsePooledEditorOptions): UsePooledEditorResult {
  const [editor, setEditor] = useState<Editor | null>(null);
  const [isPooled, setIsPooled] = useState(false);
  const editorRef = useRef<Editor | null>(null);
  const isAcquiringRef = useRef(false);
  const isMountedRef = useRef(true);

  // Store callbacks in refs to avoid triggering re-acquisition
  const optionsRef = useRef(options);
  optionsRef.current = options;

  // Acquire editor on mount
  useEffect(() => {
    isMountedRef.current = true;

    if (isAcquiringRef.current || editorRef.current) return;
    isAcquiringRef.current = true;

    const start = performance.now();
    console.log('[usePooledEditor] Attempting to acquire from pool');

    // Check if pool is ready
    if (editorPool.isReady()) {
      const acquiredEditor = editorPool.acquire({
        onClickLink: (name) => optionsRef.current.onClickLink(name),
        onContextMenu: (name, pos, cb) => optionsRef.current.onContextMenu(name, pos, cb),
        resolveLink: (name) => optionsRef.current.resolveLink(name),
        getNoteType: (name) => optionsRef.current.getNoteType(name),
        isAttachment: (name) => optionsRef.current.isAttachment(name),
        onEditorContextMenu: (pos) => optionsRef.current.onEditorContextMenu(pos),
        onCommentClick: (id) => optionsRef.current.onCommentClick(id),
        getFileTree: () => optionsRef.current.getFileTree(),
        notePath: optionsRef.current.notePath,
        vaultPath: optionsRef.current.vaultPath,
        resolveFilePath: (name) => optionsRef.current.resolveFilePath(name),
      });

      if (acquiredEditor && isMountedRef.current) {
        setupEditor(acquiredEditor, true);
        console.log(`[usePooledEditor] Acquired from pool in ${(performance.now() - start).toFixed(1)}ms`);
      }
    } else {
      // Pool not ready, wait for it
      console.log('[usePooledEditor] Pool not ready, waiting...');
      editorPool.init().then(() => {
        if (!isMountedRef.current) return;

        const acquiredEditor = editorPool.acquire({
          onClickLink: (name) => optionsRef.current.onClickLink(name),
          onContextMenu: (name, pos, cb) => optionsRef.current.onContextMenu(name, pos, cb),
          resolveLink: (name) => optionsRef.current.resolveLink(name),
          getNoteType: (name) => optionsRef.current.getNoteType(name),
          isAttachment: (name) => optionsRef.current.isAttachment(name),
          onEditorContextMenu: (pos) => optionsRef.current.onEditorContextMenu(pos),
          onCommentClick: (id) => optionsRef.current.onCommentClick(id),
          getFileTree: () => optionsRef.current.getFileTree(),
          notePath: optionsRef.current.notePath,
          vaultPath: optionsRef.current.vaultPath,
          resolveFilePath: (name) => optionsRef.current.resolveFilePath(name),
        });

        if (acquiredEditor && isMountedRef.current) {
          setupEditor(acquiredEditor, true);
          console.log(`[usePooledEditor] Acquired from pool (after init) in ${(performance.now() - start).toFixed(1)}ms`);
        }
      });
    }

    // Release on unmount
    return () => {
      isMountedRef.current = false;
      if (editorRef.current) {
        console.log('[usePooledEditor] Releasing editor to pool');
        // Remove update listener before releasing
        editorRef.current.off('update');
        editorPool.release(editorRef.current);
        editorRef.current = null;
        setEditor(null);
      }
      isAcquiringRef.current = false;
    };
  }, []); // Empty deps - only acquire once on mount

  const setupEditor = useCallback((ed: Editor, pooled: boolean) => {
    // Set up update handler
    ed.on('update', ({ editor: updatedEditor }) => {
      optionsRef.current.onUpdate?.(updatedEditor);
    });

    editorRef.current = ed;
    setEditor(ed);
    setIsPooled(pooled);

    // Call onCreate after a microtask to ensure state is updated
    queueMicrotask(() => {
      optionsRef.current.onCreate?.();
    });
  }, []);

  // Update callbacks when dependencies change
  useEffect(() => {
    if (editorRef.current) {
      editorPool.updateCallbacks(editorRef.current, {
        onClickLink: (name) => optionsRef.current.onClickLink(name),
        onContextMenu: (name, pos, cb) => optionsRef.current.onContextMenu(name, pos, cb),
        resolveLink: (name) => optionsRef.current.resolveLink(name),
        getNoteType: (name) => optionsRef.current.getNoteType(name),
        isAttachment: (name) => optionsRef.current.isAttachment(name),
        onEditorContextMenu: (pos) => optionsRef.current.onEditorContextMenu(pos),
        onCommentClick: (id) => optionsRef.current.onCommentClick(id),
        getFileTree: () => optionsRef.current.getFileTree(),
        notePath: optionsRef.current.notePath,
        vaultPath: optionsRef.current.vaultPath,
        resolveFilePath: (name) => optionsRef.current.resolveFilePath(name),
      });
    }
  }, [options.notePath, options.vaultPath]); // Update when notePath or vaultPath changes

  return { editor, isPooled };
}
