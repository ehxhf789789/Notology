import { ReactRenderer } from '@tiptap/react';
import tippy from 'tippy.js';
import { AttachmentSuggestionPluginKey } from '../../core/editor/extensions/AttachmentSuggestion';
import AttachmentSuggestionList from './AttachmentSuggestionList';
import type { AttachmentSuggestionListRef } from './AttachmentSuggestionList';
import type { Editor, Range } from '@tiptap/core';
import type { EditorState } from '@tiptap/pm/state';
import { fileCommands } from '../../core/services/tauriCommands';

type TippyInstance = ReturnType<typeof tippy>;

export interface AttachmentResult {
  fileName: string;
  path: string;
  isImage: boolean;
}

/**
 * Get the _att folder absolute path for a note
 */
function getAttFolderPath(notePath: string): string {
  if (!notePath) return '';

  // Note path: C:/Users/.../Vault/Folder/MyNote.md
  // Att folder: C:/Users/.../Vault/Folder/MyNote_att/
  const normalizedPath = notePath.replace(/\\/g, '/');
  const noteDir = normalizedPath.substring(0, normalizedPath.lastIndexOf('/'));
  const noteFileName = normalizedPath.substring(normalizedPath.lastIndexOf('/') + 1);
  const noteName = noteFileName.replace(/\.md$/, '');

  return `${noteDir}/${noteName}_att`;
}

/**
 * Async function to read attachment files from _att folder
 * Reads directly from filesystem for fresh results, sorted by mtime (most recent first)
 */
async function findAttachmentFilesAsync(
  notePath: string,
  query: string
): Promise<AttachmentResult[]> {
  if (!notePath) return [];

  const attFolderPath = getAttFolderPath(notePath);
  if (!attFolderPath) return [];

  try {
    const files = await fileCommands.readAttachmentFolder(attFolderPath, query);
    return files.map(f => ({
      fileName: f.file_name,
      path: f.path,
      isImage: f.is_image,
    }));
  } catch (error) {
    console.error('[attachmentSuggestion] Failed to read attachment folder:', error);
    return [];
  }
}

/**
 * Create attachment suggestion configuration
 * @param getNotePath Function to get the current note's path
 */
export function createAttachmentSuggestion(
  getNotePath: () => string,
) {
  return {
    char: '//', // Trigger: double slash for "local path" (att folder)
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
    allow: ({ editor, state }: { editor: Editor; state: EditorState }) => {
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
        return false;
      }

      // Check if there's a note path (att folder only makes sense for saved notes)
      const notePath = getNotePath();
      if (!notePath) return false;

      return true;
    },
    // items() is async - reads directly from filesystem for fresh results
    // Results are sorted by mtime (most recently modified first)
    items: async ({ query }: { query: string }) => {
      const notePath = getNotePath();
      return findAttachmentFilesAsync(notePath, query);
    },

    render: () => {
      let component: ReactRenderer<AttachmentSuggestionListRef> | undefined;
      let popup: TippyInstance | undefined;

      return {
        onStart: (props: any) => {
          component = new ReactRenderer(AttachmentSuggestionList, {
            props,
            editor: props.editor,
          });

          if (!props.clientRect) {
            return;
          }

          popup = tippy('body', {
            getReferenceClientRect: props.clientRect as () => DOMRect,
            appendTo: () => document.body,
            content: component.element,
            showOnCreate: true,
            interactive: true,
            trigger: 'manual',
            placement: 'bottom-start',
            maxWidth: '400px',
            theme: 'attachment-suggestion',
          });
        },

        onUpdate(props: any) {
          component?.updateProps(props);

          if (!props.clientRect) {
            return;
          }

          popup?.[0]?.setProps({
            getReferenceClientRect: props.clientRect as () => DOMRect,
          });
        },

        onKeyDown(props: any) {
          if (props.event.key === 'Escape') {
            popup?.[0]?.hide();
            return true;
          }

          return component?.ref?.onKeyDown(props) || false;
        },

        onExit() {
          popup?.[0]?.destroy();
          component?.destroy();
        },
      };
    },
  };
}
