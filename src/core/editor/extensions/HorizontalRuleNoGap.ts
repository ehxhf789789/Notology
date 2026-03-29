import HorizontalRule from '@tiptap/extension-horizontal-rule';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { InputRule } from '@tiptap/core';
import { TextSelection, NodeSelection } from '@tiptap/pm/state';
import HorizontalRuleView from '../../../features/note-editor/HorizontalRuleView';

/**
 * Custom HorizontalRule extension with improved UX:
 * - Visual NodeView with hover actions
 * - Easy insertion of paragraphs before/after
 * - Delete button on hover
 * - Keyboard shortcuts for deletion
 */
const HorizontalRuleNoGap = HorizontalRule.extend({
  addNodeView() {
    return ReactNodeViewRenderer(HorizontalRuleView);
  },

  addKeyboardShortcuts() {
    return {
      // Delete horizontal rule when selected and Backspace/Delete is pressed
      'Backspace': () => {
        const { selection } = this.editor.state;
        if (selection instanceof NodeSelection && selection.node?.type.name === this.name) {
          return this.editor.commands.deleteSelection();
        }
        return false;
      },
      'Delete': () => {
        const { selection } = this.editor.state;
        if (selection instanceof NodeSelection && selection.node?.type.name === this.name) {
          return this.editor.commands.deleteSelection();
        }
        return false;
      },
      // Arrow keys to navigate past horizontal rule
      'ArrowDown': () => {
        const { selection, doc } = this.editor.state;
        if (selection instanceof NodeSelection && selection.node?.type.name === this.name) {
          const pos = selection.from + 1;
          if (pos < doc.content.size) {
            const $pos = doc.resolve(pos);
            const newSel = TextSelection.near($pos, 1);
            this.editor.view.dispatch(
              this.editor.state.tr.setSelection(newSel)
            );
            return true;
          }
        }
        return false;
      },
      'ArrowUp': () => {
        const { selection, doc } = this.editor.state;
        if (selection instanceof NodeSelection && selection.node?.type.name === this.name) {
          const pos = selection.from - 1;
          if (pos > 0) {
            const $pos = doc.resolve(pos);
            const newSel = TextSelection.near($pos, -1);
            this.editor.view.dispatch(
              this.editor.state.tr.setSelection(newSel)
            );
            return true;
          }
        }
        return false;
      },
    };
  },

  addInputRules() {
    return [
      // Match *** at start of line
      new InputRule({
        find: /^\*\*\*$/,
        handler: ({ state, range }) => {
          const { tr } = state;
          const start = range.from;
          const end = range.to;

          // Replace the *** with horizontal rule
          tr.delete(start, end);
          tr.insert(start, this.type.create());

          // Set selection right after the horizontal rule (no extra paragraph)
          const newPos = start + 1;
          tr.setSelection(TextSelection.near(tr.doc.resolve(newPos)));
        },
      }),
      // Match --- at start of line (for backwards compatibility)
      new InputRule({
        find: /^---$/,
        handler: ({ state, range }) => {
          const { tr } = state;
          const start = range.from;
          const end = range.to;

          tr.delete(start, end);
          tr.insert(start, this.type.create());

          const newPos = start + 1;
          tr.setSelection(TextSelection.near(tr.doc.resolve(newPos)));
        },
      }),
    ];
  },
});

export default HorizontalRuleNoGap;
