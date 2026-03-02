import { ReactRenderer } from '@tiptap/react';
import tippy from 'tippy.js';
import { WikiLinkSuggestionPluginKey } from '../extensions/WikiLinkSuggestion';
import WikiLinkSuggestionList from '../components/editor/suggestions/WikiLinkSuggestionList';
import type { WikiLinkSuggestionListRef } from '../components/editor/suggestions/WikiLinkSuggestionList';
import type { FileNode } from '../types';
import type { Editor, Range } from '@tiptap/core';
import type { EditorState } from '@tiptap/pm/state';

type TippyInstance = ReturnType<typeof tippy>;

function searchNotes(fileTree: FileNode[], query: string): Array<{ fileName: string; path: string }> {
  const results: Array<{ fileName: string; path: string }> = [];
  const lowerQuery = query.toLowerCase();

  function traverse(nodes: FileNode[], currentPath: string = '', isInAttFolder: boolean = false) {
    for (const node of nodes) {
      const fullPath = currentPath ? `${currentPath}/${node.name}` : node.name;

      // Check if this is an attachment folder (ends with _att)
      const isAttFolder = node.is_dir && node.name.endsWith('_att');

      // Filter out:
      // - folder notes (notes where filename matches parent folder name)
      // - files in _att folders (attachments)
      if (!node.is_dir && node.name.endsWith('.md') && !node.is_folder_note && !isInAttFolder) {
        const fileName = node.name.replace(/\.md$/, '');
        if (fileName.toLowerCase().includes(lowerQuery)) {
          results.push({ fileName, path: fullPath });
        }
      }

      if (node.children) {
        // Pass isInAttFolder flag to children if this is an _att folder
        traverse(node.children, fullPath, isInAttFolder || isAttFolder);
      }
    }
  }

  traverse(fileTree);
  return results.slice(0, 10); // Limit to 10 results
}

// Accepts a getter function to always get the latest fileTree (avoids extension recreation)
export function createWikiLinkSuggestion(getFileTree: () => FileNode[]) {
  return {
    char: '[[', // Trigger character for wiki link
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
    allow: ({ editor, state }: { editor: Editor; state: EditorState }) => {
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
          return false;
        }

        // Check if there's a ]] after cursor (we're inside a completed link)
        if (afterCursor.includes(']]')) {
          return false;
        }

        return true;
      }

      return true;
    },
    items: ({ query }: { query: string }) => {
      return searchNotes(getFileTree(), query);
    },

    render: () => {
      let component: ReactRenderer<WikiLinkSuggestionListRef> | undefined;
      let popup: TippyInstance | undefined;

      return {
        onStart: (props: any) => {
          component = new ReactRenderer(WikiLinkSuggestionList, {
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
