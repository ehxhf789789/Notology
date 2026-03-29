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
