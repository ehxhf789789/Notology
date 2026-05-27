import { Extension, type Editor } from '@tiptap/core';
import Suggestion from '@tiptap/suggestion';
import { PluginKey, type EditorState } from '@tiptap/pm/state';
import type { Range } from '@tiptap/core';

export interface WikiLinkSuggestionOptions {
  suggestion: any;
}

export const WikiLinkSuggestionPluginKey = new PluginKey('wikiLinkSuggestion');

export const WikiLinkSuggestion = Extension.create<WikiLinkSuggestionOptions>({
  name: 'wikiLinkSuggestion',

  // Stage 5.0.5a-γ5 v8 fix (2026-05-16, HanBin) — bump priority above the
  // list/task-item keymap (default 100) so the suggestion plugin's
  // handleKeyDown intercepts Tab BEFORE the list-sink keymap when the
  // popover is open. HanBin: "[[ 입력 후 tab → 들여쓰기가 동작함" — root
  // cause was plugin-order: ProseMirror processed Tab through list keymap
  // first, sunk the bullet item, and never reached the suggestion handler.
  // TipTap StarterKit lists have priority 100; 1000 wins reliably.
  priority: 1000,

  addOptions() {
    return {
      suggestion: {
        char: '[[',
        pluginKey: WikiLinkSuggestionPluginKey,
        command: ({ editor, range, props }: { editor: Editor; range: Range; props: { fileName: string } }) => {
          // Delete the [[ trigger and insert wiki link
          editor
            .chain()
            .focus()
            .deleteRange(range)
            .insertContent(`[[${props.fileName}]] `)
            .run();
        },
        allow: ({ editor, state }: { editor: Editor; state: EditorState; range: Range }) => {
          // Don't allow if not editable
          if (!editor.isEditable) return false;

          const $from = state.selection.$from;
          const text = $from.parent.textContent;
          const posInParent = $from.parentOffset;

          // Get text before and after cursor
          const beforeCursor = text.substring(0, posInParent);
          const afterCursor = text.substring(posInParent);

          // Don't allow if cursor is immediately after ]]
          if (beforeCursor.endsWith(']]')) {
            return false;
          }

          // Find the last [[ before cursor
          const lastOpenIndex = beforeCursor.lastIndexOf('[[');

          if (lastOpenIndex !== -1) {
            // Check if there's a ]] between the last [[ and cursor
            const textAfterLastOpen = beforeCursor.substring(lastOpenIndex + 2);
            if (textAfterLastOpen.includes(']]')) {
              // We're after a completed link, don't show suggestions
              return false;
            }

            // Check if there's a ]] after cursor (we're inside a completed link)
            if (afterCursor.includes(']]')) {
              // We're inside a completed link, don't show suggestions
              return false;
            }

            // We're inside an uncompleted [[, allow suggestions
            return true;
          }

          // No [[ before cursor, allow (will trigger when typing [[)
          return true;
        },
      },
    };
  },

  addProseMirrorPlugins() {
    return [
      Suggestion({
        editor: this.editor,
        ...this.options.suggestion,
      }),
    ];
  },
});

export default WikiLinkSuggestion;
