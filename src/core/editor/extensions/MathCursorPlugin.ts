/**
 * MathCursorPlugin
 *
 * Two responsibilities:
 * 1. Arrow key navigation around math atom nodes
 * 2. Visual selection highlight for atom nodes (math, HR, etc.)
 *
 * Atom nodes rendered via NodeView don't get browser-native ::selection
 * highlighting. This plugin adds Decoration.node with a CSS class when
 * an atom node falls within the current selection range.
 */
import { Plugin, PluginKey, TextSelection, NodeSelection } from '@tiptap/pm/state';
import { Decoration, DecorationSet, EditorView } from '@tiptap/pm/view';
import { Extension } from '@tiptap/core';

const MATH_CURSOR_KEY = new PluginKey('mathCursorGap');

const ATOM_NODE_TYPES = new Set(['mathInline', 'mathBlock', 'horizontalRule']);

export const MathCursorPlugin = Extension.create({
  name: 'mathCursorPlugin',

  addProseMirrorPlugins() {
    let hasFocus = false;
    let hasEverFocused = false;

    return [
      new Plugin({
        key: MATH_CURSOR_KEY,

        view(editorView) {
          const onFocus = () => { hasFocus = true; hasEverFocused = true; };
          const onBlur = () => { hasFocus = false; };

          editorView.dom.addEventListener('focus', onFocus, true);
          editorView.dom.addEventListener('blur', onBlur, true);

          return {
            destroy() {
              editorView.dom.removeEventListener('focus', onFocus, true);
              editorView.dom.removeEventListener('blur', onBlur, true);
            },
          };
        },

        props: {
          decorations(state) {
            // Don't show atom selection highlights until user has interacted
            if (!hasEverFocused) return DecorationSet.empty;

            const { selection } = state;
            const { from, to } = selection;

            if (from === to) return DecorationSet.empty;

            const decorations: Decoration[] = [];

            state.doc.nodesBetween(from, to, (node, pos) => {
              if (ATOM_NODE_TYPES.has(node.type.name)) {
                decorations.push(
                  Decoration.node(pos, pos + node.nodeSize, {
                    class: 'atom-in-selection',
                  })
                );
              }
            });

            if (decorations.length === 0) return DecorationSet.empty;
            return DecorationSet.create(state.doc, decorations);
          },

          handleKeyDown(view, event) {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return false;

            const { state } = view;
            const { selection } = state;

            if (selection instanceof NodeSelection) {
              const node = selection.node;
              if (node.type.name === 'mathInline' || node.type.name === 'mathBlock') {
                const pos = selection.from;
                try {
                  if (event.key === 'ArrowRight') {
                    const $pos = state.doc.resolve(pos + node.nodeSize);
                    view.dispatch(state.tr.setSelection(TextSelection.near($pos, 1)));
                  } else {
                    const $pos = state.doc.resolve(pos);
                    view.dispatch(state.tr.setSelection(TextSelection.near($pos, -1)));
                  }
                  return true;
                } catch { return false; }
              }
            }

            if (selection instanceof TextSelection && selection.empty) {
              const pos = selection.from;

              if (event.key === 'ArrowRight') {
                const nodeAfter = state.doc.nodeAt(pos);
                if (nodeAfter && (nodeAfter.type.name === 'mathInline' || nodeAfter.type.name === 'mathBlock')) {
                  try {
                    const $pos = state.doc.resolve(pos + nodeAfter.nodeSize);
                    view.dispatch(state.tr.setSelection(TextSelection.near($pos, 1)));
                    return true;
                  } catch { return false; }
                }
              } else {
                const $pos = state.doc.resolve(pos);
                const indexBefore = $pos.index($pos.depth) - 1;
                if (indexBefore >= 0) {
                  const parent = $pos.parent;
                  const childBefore = parent.child(indexBefore);
                  if (childBefore.type.name === 'mathInline' || childBefore.type.name === 'mathBlock') {
                    let beforePos = $pos.start($pos.depth);
                    for (let i = 0; i < indexBefore; i++) {
                      beforePos += parent.child(i).nodeSize;
                    }
                    try {
                      const $before = state.doc.resolve(beforePos);
                      view.dispatch(state.tr.setSelection(TextSelection.near($before, -1)));
                      return true;
                    } catch { return false; }
                  }
                }
              }
            }

            return false;
          },
        },
      }),
    ];
  },
});
