/**
 * Stage 5.0.4b-3 (2026-05-16) — selection-driven bubble menu for inline marks.
 *
 * Plan §18d canonical role: "How do I style the selected text?" Answers via
 * Bold / Italic / Code / Highlight / Strike / Link — the six marks that
 * operate on a non-empty text selection. Block-level transforms live in `/`
 * (slash palette); these are intentionally absent here.
 *
 * Implementation: register the BubbleMenuPlugin directly on the editor view
 * (not as a configured extension) so we don't have to recreate the editor
 * each time this component mounts/unmounts. The plugin reads from a hidden
 * DOM element we own; on the editor side it manages the floating position
 * via Floating UI.
 */
import { useEffect, useRef, useCallback } from 'react';
import type { Editor } from '@tiptap/react';
import { BubbleMenuPlugin } from '@tiptap/extension-bubble-menu';
import { PluginKey } from '@tiptap/pm/state';
import { Bold, Italic, Code, Highlighter, Strikethrough, Link as LinkIcon } from 'lucide-react';

const bubbleMenuPluginKey = new PluginKey('editorBubbleMenu');

interface Props {
  editor: Editor | null;
}

export function EditorBubbleMenu({ editor }: Props) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!editor || !menuRef.current) return;
    if (editor.isDestroyed) return;

    const plugin = BubbleMenuPlugin({
      pluginKey: bubbleMenuPluginKey,
      editor,
      element: menuRef.current,
      // Only show on text selection. Hide for: empty selection, atom nodes
      // (mediaEmbed/math/linkCard/etc.), code blocks (no marks make sense
      // inside fenced code), and table-cell empty state.
      shouldShow: ({ editor: ed, from, to, state }) => {
        if (from === to) return false;
        if (!ed.isEditable) return false;
        if (ed.isActive('codeBlock')) return false;
        // Don't show when selection covers an atom node (selectedNode case).
        const { selection } = state;
        // `NodeSelection` (atom) — checked by selection class name to avoid
        // importing the entire prosemirror-state types here.
        if (selection.constructor.name === 'NodeSelection') return false;
        return true;
      },
      options: {
        placement: 'top',
        offset: 8,
      },
    });

    editor.registerPlugin(plugin);
    return () => {
      try {
        editor.unregisterPlugin(bubbleMenuPluginKey);
      } catch {
        // editor may already be destroyed during teardown
      }
    };
  }, [editor]);

  const toggleBold = useCallback(() => editor?.chain().focus().toggleBold().run(), [editor]);
  const toggleItalic = useCallback(() => editor?.chain().focus().toggleItalic().run(), [editor]);
  const toggleCode = useCallback(() => editor?.chain().focus().toggleCode().run(), [editor]);
  const toggleHighlight = useCallback(() => editor?.chain().focus().toggleHighlight().run(), [editor]);
  const toggleStrike = useCallback(() => editor?.chain().focus().toggleStrike().run(), [editor]);
  const toggleLink = useCallback(() => {
    if (!editor) return;
    if (editor.isActive('link')) {
      editor.chain().focus().unsetLink().run();
      return;
    }
    const previous = (editor.getAttributes('link') as { href?: string }).href ?? '';
    // eslint-disable-next-line no-alert -- intentionally simple link prompt for now;
    // a proper inline link editor is a later sub-stage (5.0.6 polish).
    const url = window.prompt('URL', previous);
    if (url === null) return;
    if (url === '') {
      editor.chain().focus().unsetLink().run();
      return;
    }
    editor.chain().focus().setLink({ href: url }).run();
  }, [editor]);

  if (!editor) return null;

  // BubbleMenuPlugin reads from this element and toggles its display.
  // Start hidden so it doesn't flash at (0,0) before the plugin attaches.
  return (
    <div
      ref={menuRef}
      className="editor-bubble-menu"
      style={{ display: 'none' }}
      onMouseDown={(e) => e.preventDefault()} /* prevent selection collapse */
    >
      <button
        type="button"
        className={`editor-bubble-menu__btn${editor.isActive('bold') ? ' is-active' : ''}`}
        onClick={toggleBold}
        title="Bold (Ctrl+B)"
        aria-label="Bold"
      >
        <Bold size={14} />
      </button>
      <button
        type="button"
        className={`editor-bubble-menu__btn${editor.isActive('italic') ? ' is-active' : ''}`}
        onClick={toggleItalic}
        title="Italic (Ctrl+I)"
        aria-label="Italic"
      >
        <Italic size={14} />
      </button>
      <button
        type="button"
        className={`editor-bubble-menu__btn${editor.isActive('code') ? ' is-active' : ''}`}
        onClick={toggleCode}
        title="Inline code (Ctrl+E)"
        aria-label="Inline code"
      >
        <Code size={14} />
      </button>
      <button
        type="button"
        className={`editor-bubble-menu__btn${editor.isActive('strike') ? ' is-active' : ''}`}
        onClick={toggleStrike}
        title="Strikethrough"
        aria-label="Strikethrough"
      >
        <Strikethrough size={14} />
      </button>
      <button
        type="button"
        className={`editor-bubble-menu__btn${editor.isActive('highlight') ? ' is-active' : ''}`}
        onClick={toggleHighlight}
        title="Highlight"
        aria-label="Highlight"
      >
        <Highlighter size={14} />
      </button>
      <button
        type="button"
        className={`editor-bubble-menu__btn${editor.isActive('link') ? ' is-active' : ''}`}
        onClick={toggleLink}
        title="Link"
        aria-label="Link"
      >
        <LinkIcon size={14} />
      </button>
    </div>
  );
}

export default EditorBubbleMenu;
