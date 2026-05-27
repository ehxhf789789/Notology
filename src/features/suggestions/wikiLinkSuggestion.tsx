import { ReactRenderer } from '@tiptap/react';
import tippy from 'tippy.js';
import { WikiLinkSuggestionPluginKey } from '../../core/editor/extensions/WikiLinkSuggestion';
import WikiLinkSuggestionList from './WikiLinkSuggestionList';
import type { WikiLinkSuggestionListRef } from './WikiLinkSuggestionList';
import type { FileNode } from '../../core/types';
import type { Editor, Range } from '@tiptap/core';
import type { EditorState } from '@tiptap/pm/state';

type TippyInstance = ReturnType<typeof tippy>;

export function searchNotes(fileTree: FileNode[], query: string): Array<{ fileName: string; path: string }> {
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
      let closeOnEvent: (() => void) | undefined;

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
            // v5.4 (2026-05-15) — Same fix as slash palette: the CSS
            // override at `.tippy-box[data-theme~='wiki-link-suggestion']`
            // existed but this tippy invocation never set the theme, so
            // the dark default `.tippy-box` background was rendering
            // behind our `.wiki-link-suggestion-list`. Setting theme
            // here activates the transparent override.
            theme: 'wiki-link-suggestion',
          });

          // v5.3 + v5.4 — auto-close on dragstart AND scroll. HanBin:
          // popovers shouldn't linger over drag preview, and stale anchor
          // after scroll leaves the popover at the wrong location.
          // v5.5.1 (2026-05-16, HanBin): popover 내부 스크롤은 무시.
          // 노트 리스트가 max-height 안에서 스크롤될 때 닫히면 안 됨.
          closeOnEvent = (e?: Event) => {
            if (e?.type === 'scroll') {
              const popperEl = popup?.[0]?.popper;
              const target = e.target as Node | null;
              if (popperEl && target && popperEl.contains(target)) return;
            }
            popup?.[0]?.hide();
          };
          document.addEventListener('dragstart', closeOnEvent, { capture: true });
          window.addEventListener('scroll', closeOnEvent, { capture: true });
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

          // Stage 5.0.5a-γ5 v7 fix (2026-05-16, HanBin) — defensively
          // intercept Tab AT THE WRAPPER LEVEL.
          //
          // HanBin: "[[ 입력 후 tab 을 누르면 텍스트 들여쓰기가 동작함".
          // Root cause: TipTap's list/task-item keymap had Tab bindings
          // that fired before / instead of the suggestion's handleKeyDown
          // when the cursor sat inside a list. The previous fix only
          // intercepted Tab inside the React component, which is too
          // deep — by then TipTap's keymap had already consumed the key.
          //
          // Fix: preventDefault + stopPropagation here, delegate to the
          // component for the mode-toggle action, ALWAYS return true so
          // ProseMirror's keymap never sees Tab when the popover is open.
          if (props.event.key === 'Tab') {
            props.event.preventDefault();
            props.event.stopPropagation();
            // Let the React component handle the mode switch (list ↔ picker).
            // Even if it returns false, we still consume the key.
            component?.ref?.onKeyDown(props);
            return true;
          }

          return component?.ref?.onKeyDown(props) || false;
        },

        onExit() {
          if (closeOnEvent) {
            document.removeEventListener('dragstart', closeOnEvent, { capture: true });
            window.removeEventListener('scroll', closeOnEvent, { capture: true });
            closeOnEvent = undefined;
          }
          popup?.[0]?.destroy();
          component?.destroy();
        },
      };
    },
  };
}
