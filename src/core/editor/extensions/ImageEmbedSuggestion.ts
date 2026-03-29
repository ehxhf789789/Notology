import { Extension, type Editor } from '@tiptap/core';
import Suggestion from '@tiptap/suggestion';
import { PluginKey, type EditorState } from '@tiptap/pm/state';
import type { Range } from '@tiptap/core';

export interface ImageEmbedSuggestionOptions {
  suggestion: any;
}

export const ImageEmbedSuggestionPluginKey = new PluginKey('imageEmbedSuggestion');

export const ImageEmbedSuggestion = Extension.create<ImageEmbedSuggestionOptions>({
  name: 'imageEmbedSuggestion',

  addOptions() {
    return {
      suggestion: {
        char: '@@',
        pluginKey: ImageEmbedSuggestionPluginKey,
        command: ({ editor, range, props }: { editor: Editor; range: Range; props: { fileName: string } }) => {
          // Delete the @@ trigger and insert image embed syntax
          editor
            .chain()
            .focus()
            .deleteRange(range)
            .insertContent(`![[${props.fileName}]]`)
            .run();
        },
        allow: ({ editor, state }: { editor: Editor; state: EditorState }) => {
          // Don't allow if not editable (fast check first)
          if (!editor.isEditable) return false;

          // Check if we're inside a wiki link [[ ]]
          // Only check last 200 chars for performance
          const $from = state.selection.$from;
          const text = $from.parent.textContent;
          const posInParent = $from.parentOffset;

          // Limit check range for long paragraphs
          const checkStart = Math.max(0, posInParent - 200);
          const beforeCursor = checkStart === 0
            ? text.slice(0, posInParent)
            : text.slice(checkStart, posInParent);

          // Don't trigger inside wiki links [[ ]]
          const lastOpen = beforeCursor.lastIndexOf('[[');
          if (lastOpen === -1) return true; // No [[ found, allow

          const lastClose = beforeCursor.lastIndexOf(']]');
          return lastOpen <= lastClose; // Allow only if [[ is closed
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

export default ImageEmbedSuggestion;
