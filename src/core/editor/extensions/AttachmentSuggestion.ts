import { Extension, type Editor } from '@tiptap/core';
import Suggestion from '@tiptap/suggestion';
import { PluginKey, type EditorState } from '@tiptap/pm/state';
import type { Range } from '@tiptap/core';

export interface AttachmentSuggestionOptions {
  suggestion: any;
}

export const AttachmentSuggestionPluginKey = new PluginKey('attachmentSuggestion');

export const AttachmentSuggestion = Extension.create<AttachmentSuggestionOptions>({
  name: 'attachmentSuggestion',

  addOptions() {
    return {
      suggestion: {
        char: '//',  // Trigger: double slash for "local path" (att folder)
        pluginKey: AttachmentSuggestionPluginKey,
        command: ({ editor, range, props }: { editor: Editor; range: Range; props: { fileName: string; isImage: boolean } }) => {
          // Delete the // trigger and insert wiki link to attachment
          const prefix = props.isImage ? '!' : '';
          editor
            .chain()
            .focus()
            .deleteRange(range)
            .insertContent(`${prefix}[[${props.fileName}]]`)
            .run();
        },
        allow: ({ editor, state }: { editor: Editor; state: EditorState; range: Range }) => {
          // Don't allow if not editable
          if (!editor.isEditable) return false;

          const $from = state.selection.$from;
          const text = $from.parent.textContent;
          const posInParent = $from.parentOffset;

          // Get text before cursor
          const beforeCursor = text.substring(0, posInParent);

          // Don't trigger inside wiki links [[ ]]
          const lastOpenBracket = beforeCursor.lastIndexOf('[[');
          const lastCloseBracket = beforeCursor.lastIndexOf(']]');
          if (lastOpenBracket > lastCloseBracket) {
            // We're inside an unclosed [[, don't trigger
            return false;
          }

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

export default AttachmentSuggestion;
