import { findChildren } from '@tiptap/core';
import { CodeBlock } from '@tiptap/extension-code-block';
import { ReactNodeViewRenderer } from '@tiptap/react';
import type { Node as ProsemirrorNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import CodeBlockView from '../../../features/note-editor/CodeBlockView';

function parseNodes(nodes: any[], className: string[] = []): { text: string; classes: string[] }[] {
  return nodes.flatMap(node => {
    const classes = [...className, ...(node.properties ? node.properties.className : [])];

    if (node.children) {
      return parseNodes(node.children, classes);
    }

    return {
      text: node.value,
      classes,
    };
  });
}

function getHighlightNodes(result: any) {
  return result.value || result.children || [];
}

function getDecorations({
  doc,
  name,
  lowlight,
  defaultLanguage,
}: {
  doc: ProsemirrorNode;
  name: string;
  lowlight: any;
  defaultLanguage: string | null | undefined;
}) {
  const decorations: Decoration[] = [];

  findChildren(doc, node => node.type.name === name).forEach(block => {
    let from = block.pos + 1;
    const language = block.node.attrs.language || defaultLanguage;
    const textContent = block.node.textContent;
    const languages = lowlight.listLanguages();

    const nodes = language && languages.includes(language)
      ? getHighlightNodes(lowlight.highlight(language, textContent))
      : getHighlightNodes(lowlight.highlightAuto(textContent));

    parseNodes(nodes).forEach(node => {
      const to = from + node.text.length;

      if (node.classes.length) {
        const decoration = Decoration.inline(from, to, {
          class: node.classes.join(' '),
        });
        decorations.push(decoration);
      }

      from = to;
    });
  });

  return DecorationSet.create(doc, decorations);
}

export interface CodeBlockWithHighlightOptions {
  lowlight: any;
  defaultLanguage?: string | null;
  languageClassPrefix?: string;
  exitOnTripleEnter?: boolean;
  exitOnArrowDown?: boolean;
  HTMLAttributes?: Record<string, any>;
}

export const CodeBlockWithHighlight = CodeBlock.extend<CodeBlockWithHighlightOptions>({
  name: 'codeBlock',

  addOptions() {
    return {
      ...this.parent?.(),
      lowlight: null,
      defaultLanguage: null,
    };
  },

  addAttributes() {
    return {
      ...this.parent?.(),
      collapsed: {
        default: false,
        parseHTML: element => element.getAttribute('data-collapsed') === 'true',
        renderHTML: attributes => {
          if (!attributes.collapsed) {
            return {};
          }
          return {
            'data-collapsed': 'true',
          };
        },
      },
    };
  },

  addNodeView() {
    return ReactNodeViewRenderer(CodeBlockView);
  },

  addStorage() {
    return {
      markdown: {
        serialize(state: any, node: any) {
          const language = node.attrs?.language || '';
          const collapsed = node.attrs?.collapsed || false;
          const content = node.textContent || '';

          // If collapsed, serialize as HTML to preserve the attribute
          if (collapsed) {
            const langAttr = language ? ` class="language-${language}"` : '';
            state.write(`<pre data-collapsed="true"${langAttr}><code>${content.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</code></pre>`);
            state.closeBlock(node);
          } else {
            // Standard fenced code block
            const fence = '```';
            state.write(`${fence}${language}\n`);
            state.text(content, false);
            state.ensureNewLine();
            state.write(fence);
            state.closeBlock(node);
          }
        },
        parse: {
          // handled by markdown-it
        },
      },
    };
  },

  addKeyboardShortcuts() {
    return {
      ...this.parent?.(),
      // Add paragraph after code block with Mod+Enter
      'Mod-Enter': () => {
        const { state, view } = this.editor;
        const { selection } = state;
        const { $from } = selection;

        // Check if we're in a code block
        if ($from.parent.type.name === this.name) {
          const endOfBlock = $from.end();
          const tr = state.tr.insert(endOfBlock + 1, state.schema.nodes.paragraph.create());
          tr.setSelection(TextSelection.near(tr.doc.resolve(endOfBlock + 2)));
          view.dispatch(tr);
          return true;
        }
        return false;
      },
      // Delete empty code block with Backspace at the start
      'Backspace': () => {
        const { state } = this.editor;
        const { selection } = state;
        const { $from, empty } = selection;

        // Check if cursor is at the very start of an empty code block
        if (empty && $from.parent.type.name === this.name &&
            $from.parentOffset === 0 && $from.parent.textContent === '') {
          return this.editor.commands.deleteNode(this.name);
        }
        return false;
      },
    };
  },

  addProseMirrorPlugins() {
    const lowlight = this.options.lowlight;

    if (!lowlight) {
      console.error('[CodeBlockHighlight] No lowlight instance provided!');
      return this.parent?.() || [];
    }

    const highlightPlugin: Plugin<DecorationSet> = new Plugin({
      key: new PluginKey('codeBlockHighlight'),

      state: {
        init: (_, { doc }): DecorationSet => {
          return getDecorations({
            doc,
            name: this.name,
            lowlight,
            defaultLanguage: this.options.defaultLanguage,
          });
        },
        apply: (transaction, decorationSet, oldState, newState): DecorationSet => {
          const oldNodeName = oldState.selection.$head.parent.type.name;
          const newNodeName = newState.selection.$head.parent.type.name;
          const oldNodes = findChildren(oldState.doc, node => node.type.name === this.name);
          const newNodes = findChildren(newState.doc, node => node.type.name === this.name);

          if (
            transaction.docChanged &&
            ([oldNodeName, newNodeName].includes(this.name) ||
              newNodes.length !== oldNodes.length ||
              transaction.steps.some(step => {
                return (
                  // @ts-ignore
                  step.from !== undefined &&
                  // @ts-ignore
                  step.to !== undefined &&
                  oldNodes.some(node => {
                    return (
                      // @ts-ignore
                      node.pos >= step.from &&
                      // @ts-ignore
                      node.pos + node.node.nodeSize <= step.to
                    );
                  })
                );
              }))
          ) {
            return getDecorations({
              doc: transaction.doc,
              name: this.name,
              lowlight,
              defaultLanguage: this.options.defaultLanguage,
            });
          }

          return decorationSet.map(transaction.mapping, transaction.doc);
        },
      },

      props: {
        decorations(state): DecorationSet | undefined {
          return highlightPlugin.getState(state);
        },
      },
    });

    return [...(this.parent?.() || []), highlightPlugin];
  },
});

export default CodeBlockWithHighlight;
