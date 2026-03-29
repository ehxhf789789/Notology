import { ReactRenderer } from '@tiptap/react';
import tippy from 'tippy.js';
import { ImageEmbedSuggestionPluginKey } from '../../core/editor/extensions/ImageEmbedSuggestion';
import ImageEmbedSuggestionList from './ImageEmbedSuggestionList';
import type { ImageEmbedSuggestionListRef } from './ImageEmbedSuggestionList';
import type { Editor, Range } from '@tiptap/core';
import type { EditorState } from '@tiptap/pm/state';

type TippyInstance = ReturnType<typeof tippy>;

export interface ImageAttachment {
  fileName: string;
  displayName: string;
  filePath?: string; // Full path to the image file for thumbnail preview
}

// Image file extensions (use Set for O(1) lookup)
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg']);

// Pre-compiled regex patterns
const WIKI_LINK_PATTERN = /!?\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g;
const HTML_WIKI_LINK_PATTERN = /data-wiki-link="([^"]+)"/g;

/**
 * Check if filename is an image
 */
function isImageFile(fileName: string): boolean {
  const dotIndex = fileName.lastIndexOf('.');
  if (dotIndex === -1) return false;
  return IMAGE_EXTENSIONS.has(fileName.slice(dotIndex).toLowerCase());
}

/**
 * Extract image attachments from note body
 * @param noteBody The markdown content of the note
 * @param notePath Optional full path to the note file for constructing attachment paths
 */
export function extractImageAttachments(noteBody: string, notePath?: string): ImageAttachment[] {
  if (!noteBody) return [];

  const attachments: ImageAttachment[] = [];
  const seen = new Set<string>();

  // Construct attachment folder path if notePath is provided
  let attachmentDir = '';
  if (notePath) {
    const noteDir = notePath.replace(/[^/\\]+$/, '');
    const noteStem = notePath.replace(/^.*[/\\]/, '').replace(/\.md$/, '');
    attachmentDir = `${noteDir}${noteStem}_att/`;
  }

  WIKI_LINK_PATTERN.lastIndex = 0;
  HTML_WIKI_LINK_PATTERN.lastIndex = 0;

  let match;

  while ((match = WIKI_LINK_PATTERN.exec(noteBody)) !== null) {
    const fileName = match[1].trim();
    const lowerFileName = fileName.toLowerCase();

    if (isImageFile(fileName) && !seen.has(lowerFileName)) {
      seen.add(lowerFileName);
      attachments.push({
        fileName,
        displayName: fileName,
        filePath: attachmentDir ? `${attachmentDir}${fileName}` : undefined,
      });
    }
  }

  while ((match = HTML_WIKI_LINK_PATTERN.exec(noteBody)) !== null) {
    const fileName = match[1].trim();
    const lowerFileName = fileName.toLowerCase();

    if (isImageFile(fileName) && !seen.has(lowerFileName)) {
      seen.add(lowerFileName);
      attachments.push({
        fileName,
        displayName: fileName,
        filePath: attachmentDir ? `${attachmentDir}${fileName}` : undefined,
      });
    }
  }

  return attachments;
}

// No-op function (kept for compatibility, does nothing now)
export function setCurrentNoteBody(_body: string): void {
  // Intentionally empty - we get markdown directly from editor when @@ is triggered
}

export function createImageEmbedSuggestion(getNotePath?: () => string) {
  return {
    char: '@@', // Trigger character for image embed
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
      // Don't allow if not editable
      if (!editor.isEditable) return false;

      // Check if we're inside a wiki link [[ ]]
      const $from = state.selection.$from;
      const text = $from.parent.textContent;
      const posInParent = $from.parentOffset;

      const checkStart = Math.max(0, posInParent - 200);
      const beforeCursor = checkStart === 0
        ? text.slice(0, posInParent)
        : text.slice(checkStart, posInParent);

      // Don't trigger inside wiki links [[ ]]
      const lastOpen = beforeCursor.lastIndexOf('[[');
      if (lastOpen === -1) return true;

      const lastClose = beforeCursor.lastIndexOf(']]');
      return lastOpen <= lastClose;
    },
    items: async ({ query, editor }: { query: string; editor: any }) => {
      // Get body directly from editor when @@ is triggered
      let noteBody = '';
      try {
        if (editor?.storage?.markdown?.getMarkdown) {
          noteBody = editor.storage.markdown.getMarkdown();
        }
      } catch (e) {
        // Silently fail
      }

      // Get current note path for constructing image paths
      const notePath = getNotePath?.() || '';
      const attachments = extractImageAttachments(noteBody, notePath);

      if (!query) {
        return attachments;
      }

      const lowerQuery = query.toLowerCase();
      return attachments.filter(att =>
        att.displayName.toLowerCase().includes(lowerQuery)
      );
    },

    render: () => {
      let component: ReactRenderer<ImageEmbedSuggestionListRef> | undefined;
      let popup: TippyInstance | undefined;

      return {
        onStart: (props: any) => {
          component = new ReactRenderer(ImageEmbedSuggestionList, {
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
            maxWidth: '350px',
            theme: 'image-embed-suggestion',
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
