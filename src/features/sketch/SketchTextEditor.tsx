/**
 * SketchTextEditor — TipTap editor instance for sketch text nodes.
 * Stores content as HTML (not markdown) to preserve math, tables, etc.
 * Only one instance exists at a time (when a text node is in edit mode).
 */
import { useState, useRef, useCallback, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useEditor, EditorContent } from '@tiptap/react';
import { getEditorExtensions } from '../../core/editor/editorConfig';
// v20.7 — fileTreeActions import removed; no longer pass `getFileTree`
// so the WikiLinkSuggestion popup doesn't fire inside sketch text nodes.
import { hoverActions } from '../hover-windows/stores/hoverStore';
import EditorContextMenu from '../note-editor/EditorContextMenu';
import type { SketchNode } from '../../core/types';

interface SketchTextEditorProps {
  node: SketchNode;
  onUpdate: (nodeId: string, html: string) => void;
  onExit: () => void;
  readOnly?: boolean;
  textAlign?: 'top-left' | 'center';
  /** v20.4 (2026-05-16, HanBin) — host note path. Required for `//`
   *  attachment suggestion since attach-add commands need the parent note. */
  notePath?: string;
  /**
   * v20.5 (2026-05-16, HanBin) — handler the parent sketch passes to
   * convert a `//` attachment pick into a NEW CANVAS NODE adjacent to
   * the currently-editing text node, instead of inserting a wikilink
   * into the text. Receives the picked attachment + the text-node id so
   * the parent can compute a sensible spawn position. SketchTextEditor
   * is responsible for clearing the `//` trigger text from the editor.
   */
  onAttachmentPickAsNode?: (args: {
    attachment: import('../suggestions/attachmentSuggestion').AttachmentResult;
    fromNodeId: string;
  }) => void;
  /**
   * v20.5 (2026-05-16, HanBin) — for `/` slash → 첨부파일 path. The TipTap
   * editor instance + the node id this editor belongs to are surfaced
   * upward so SketchEditor can register the slash-attachment listener
   * with the right `editor` filter + node-id closure for placement.
   */
  onReady?: (args: { editor: import('@tiptap/core').Editor; fromNodeId: string }) => void;
}

export function SketchTextEditor({ node, onUpdate, onExit, readOnly = false, textAlign, notePath, onAttachmentPickAsNode, onReady }: SketchTextEditorProps) {
  const exitRef = useRef(onExit);
  exitRef.current = onExit;
  const updateRef = useRef(onUpdate);
  updateRef.current = onUpdate;
  const nodeIdRef = useRef(node.id);
  nodeIdRef.current = node.id;

  // Editor context menu state
  const [ctxMenuPos, setCtxMenuPos] = useState<{ x: number; y: number } | null>(null);

  // v20.5 (2026-05-16, HanBin) — capture the latest callback via ref so
  // the editor instance (created once) always sees the freshest closure
  // when a `//` pick fires. Without this, the override would be stale
  // after any parent re-render.
  const onAttachmentPickAsNodeRef = useRef(onAttachmentPickAsNode);
  onAttachmentPickAsNodeRef.current = onAttachmentPickAsNode;
  const editor = useEditor({
    extensions: getEditorExtensions({
      placeholder: '',
      onClickLink: (name: string) => hoverActions.open(name),
      onContextMenu: () => {},
      resolveLink: () => true,
      // v20.21 (2026-05-17, HanBin) — strip slash-menu items that conflict
      // with sketch UX. HanBin: "스케치에서 / 명령어에서 위키링크 등
      // 스케치에서 지원하지 않는 기능은 제거... /, // 등에서 스케치 노트
      // 상에서 충돌이 있을 수 있을 만한 모든 내용 제거."
      //   • wikiLink — inserts `[[` which is intentionally a no-op inside
      //     sketch text nodes (sketch-level handler creates a wikilink
      //     CANVAS NODE instead — see v20.7). Picking it from the slash
      //     palette would just leave literal `[[` text dangling.
      //   • divider — block-level <hr> inside a small text node breaks
      //     the box's intended one-line / few-line use; not a true
      //     conflict but visually broken on a 200×100 canvas card.
      //   • table — 3×2 default insert overflows the default node size
      //     and pulls the node into a layout it can't represent well.
      // The `attachment` slash item stays — it's already remapped via
      // useSlashAttachmentListener to spawn a file CANVAS NODE (v20.5).
      slashCommandExclude: ['wikiLink', 'divider', 'table'],
      // v20.7 (2026-05-16, HanBin) — `[[` wikilink suggestion DISABLED
      // inside sketch text nodes. HanBin: "스케치에서 [[ 명령어도 동작을
      // 금지할 것. 위키링크 역시 노드로 관리되고 있었음." The
      // sketch-level `[[` handler (window keydown listener in
      // SketchEditor) opens SketchWikiLinkSearch which creates a
      // wikilink CANVAS NODE — same architecture as // and / →
      // attachments. Omitting `getFileTree` here gates out the
      // WikiLinkSuggestion extension (it's conditional on that
      // option in getEditorExtensions), so the popup never appears
      // inside text nodes. Outside text nodes, the sketch-level
      // listener fires (no editingNode guard satisfied) and the
      // node-creation flow runs.
      // getFileTree: intentionally omitted
      // v20.4 — pass through so `//` attachment suggestion can wire its
      // commands to the host sketch note.
      notePath,
      // v20.5 — divert `//` pick from "insert wikilink in text" to
      // "add file node on canvas" (sketch-specific UX). When the
      // sketch context doesn't supply a handler (legacy callers) the
      // suggestion falls back to its default wikilink-insert behavior.
      onAttachmentPick: ({ editor: ed, range, attachment }) => {
        // Always clear the `//` trigger text first — regardless of
        // whether the host actually spawned a node, the user's
        // typed `//` shouldn't linger as literal text.
        ed.chain().focus().deleteRange(range).run();
        const handler = onAttachmentPickAsNodeRef.current;
        if (handler) {
          handler({ attachment, fromNodeId: nodeIdRef.current });
        }
      },
      onEditorContextMenu: (pos: { x: number; y: number }) => {
        setCtxMenuPos(pos);
      },
    }),
    content: node.text || '',
    editable: !readOnly,
    autofocus: 'end',
    editorProps: {
      attributes: {
        class: `sketch-tiptap-editor${textAlign === 'center' ? ' text-center' : ''}`,
      },
      handleKeyDown: (_view, event) => {
        if (event.key === 'Escape') {
          saveAndExit();
          return true;
        }
        return false;
      },
    },
    onUpdate: ({ editor: ed }) => {
      updateRef.current(nodeIdRef.current, ed.getHTML());
    },
  }, []);

  // v20.5 — surface the live editor ref + node id to the parent so
  // SketchEditor can install slash-attachment listener with the right
  // editor filter.
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  useEffect(() => {
    if (editor) {
      onReadyRef.current?.({ editor, fromNodeId: nodeIdRef.current });
    }
  }, [editor]);

  const saveAndExit = useCallback(() => {
    if (editor) {
      updateRef.current(nodeIdRef.current, editor.getHTML());
    }
    exitRef.current();
  }, [editor]);

  // Serialize on blur (exit)
  const handleBlur = useCallback((e: React.FocusEvent) => {
    const related = e.relatedTarget as HTMLElement | null;
    if (related && (
      related.closest('.tippy-box') ||
      related.closest('.math-edit-container') ||
      related.closest('.math-autocomplete') ||
      related.closest('.editor-context-menu') ||
      related.closest('.sketch-editor-ctx-portal')
    )) {
      return;
    }
    // Check if a math edit container is open in the DOM
    if (document.querySelector('.math-edit-container')) {
      return;
    }
    saveAndExit();
  }, [saveAndExit]);

  if (!editor) return null;

  return (
    <>
      <div
        className="sketch-tiptap-wrapper"
        onDoubleClick={e => e.stopPropagation()}
        onContextMenu={e => {
          e.stopPropagation();
          // Let TipTap/WikiLink handle context menu via onEditorContextMenu
          // If no handler fired (plain text area), show editor context menu
          if (!ctxMenuPos) {
            e.preventDefault();
            setCtxMenuPos({ x: e.clientX, y: e.clientY });
          }
        }}
        onBlur={handleBlur}
      >
        <EditorContent editor={editor} />
      </div>

      {/* Editor Context Menu (portal to body) */}
      {ctxMenuPos && createPortal(
        <div className="sketch-editor-ctx-portal">
          <div
            style={{ position: 'fixed', inset: 0, zIndex: 99998 }}
            onClick={() => setCtxMenuPos(null)}
            onContextMenu={e => { e.preventDefault(); setCtxMenuPos(null); }}
          />
          <EditorContextMenu
            editor={editor}
            position={ctxMenuPos}
            onClose={() => setCtxMenuPos(null)}
          />
        </div>,
        document.body
      )}
    </>
  );
}
