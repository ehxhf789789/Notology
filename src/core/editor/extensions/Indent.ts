import { Extension } from '@tiptap/core';

// Indent type for paragraph styling
export type TextIndentType = 'none' | 'firstLine' | 'hanging';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    indent: {
      indent: () => ReturnType;
      outdent: () => ReturnType;
      setFirstLineIndent: () => ReturnType;
      setHangingIndent: () => ReturnType;
      clearTextIndent: () => ReturnType;
    };
  }
}

// Custom HTML wrapper for preserving indent in markdown
// Format: <p data-indent="N" data-text-indent-type="TYPE">content</p>
const wrapWithIndentHTML = (content: string, indent: number, textIndentType: TextIndentType): string => {
  if (indent === 0 && textIndentType === 'none') {
    return content;
  }

  const attrs: string[] = [];
  if (indent > 0) {
    attrs.push(`data-indent="${indent}"`);
  }
  if (textIndentType !== 'none') {
    attrs.push(`data-text-indent-type="${textIndentType}"`);
  }

  return `<p ${attrs.join(' ')}>${content}</p>`;
};

export const IndentExtension = Extension.create({
  name: 'indent',

  addGlobalAttributes() {
    return [
      {
        types: ['paragraph', 'heading'],
        attributes: {
          indent: {
            default: 0,
            parseHTML: element => {
              const indent = element.getAttribute('data-indent');
              return indent ? parseInt(indent, 10) : 0;
            },
            renderHTML: attributes => {
              if (!attributes.indent || attributes.indent === 0) {
                return {};
              }
              return {
                'data-indent': attributes.indent,
                style: `padding-left: ${attributes.indent * 2}em`,
              };
            },
          },
          textIndentType: {
            default: 'none',
            parseHTML: element => {
              return element.getAttribute('data-text-indent-type') || 'none';
            },
            renderHTML: attributes => {
              const type = attributes.textIndentType as TextIndentType;
              if (!type || type === 'none') {
                return {};
              }
              if (type === 'firstLine') {
                // First-line indent: only first line is indented
                return {
                  'data-text-indent-type': 'firstLine',
                  style: 'text-indent: 2em',
                };
              }
              if (type === 'hanging') {
                // Hanging indent: first line normal, rest indented
                return {
                  'data-text-indent-type': 'hanging',
                  style: 'text-indent: -2em; padding-left: 2em',
                };
              }
              return {};
            },
          },
        },
      },
    ];
  },

  // Add storage for markdown serialization
  addStorage() {
    return {
      markdown: {
        serialize: {
          paragraph: (state: any, node: any) => {
            const indent = node.attrs?.indent || 0;
            const textIndentType = node.attrs?.textIndentType || 'none';

            // If has indent attributes, render as HTML to preserve them
            if (indent > 0 || textIndentType !== 'none') {
              const attrs: string[] = [];
              if (indent > 0) {
                attrs.push(`data-indent="${indent}"`);
                attrs.push(`style="padding-left: ${indent * 2}em${textIndentType === 'firstLine' ? '; text-indent: 2em' : textIndentType === 'hanging' ? '; text-indent: -2em' : ''}"`);
              } else if (textIndentType === 'firstLine') {
                attrs.push(`style="text-indent: 2em"`);
              } else if (textIndentType === 'hanging') {
                attrs.push(`style="text-indent: -2em; padding-left: 2em"`);
              }
              if (textIndentType !== 'none') {
                attrs.push(`data-text-indent-type="${textIndentType}"`);
              }

              state.write(`<p ${attrs.join(' ')}>`);
              state.renderInline(node);
              state.write('</p>');
              state.closeBlock(node);
            } else {
              // Default paragraph handling
              state.renderInline(node);
              state.closeBlock(node);
            }
          },
        },
      },
    };
  },

  addCommands() {
    return {
      // Set first-line indent (들여쓰기)
      setFirstLineIndent: () => ({ tr, state, dispatch }) => {
        const { selection } = state;
        const { $from, $to } = selection;

        let depth = $from.sharedDepth($to.pos);
        if (depth === 0) depth = 1;

        const startPos = $from.before(depth);
        const endPos = $to.after(depth);

        const nodesToModify: Array<{ node: any; pos: number }> = [];

        state.doc.nodesBetween(startPos, endPos, (node, pos) => {
          if (node.type.name === 'paragraph' || node.type.name === 'heading') {
            nodesToModify.push({ node, pos });
            return false;
          }
        });

        nodesToModify.forEach(({ node, pos }) => {
          const currentType = node.attrs.textIndentType || 'none';
          // Toggle: if already firstLine, set to none; otherwise set to firstLine
          const newType = currentType === 'firstLine' ? 'none' : 'firstLine';
          tr.setNodeMarkup(pos, undefined, {
            ...node.attrs,
            textIndentType: newType,
          });
        });

        if (dispatch) {
          dispatch(tr);
        }
        return true;
      },

      // Set hanging indent (내어쓰기)
      setHangingIndent: () => ({ tr, state, dispatch }) => {
        const { selection } = state;
        const { $from, $to } = selection;

        let depth = $from.sharedDepth($to.pos);
        if (depth === 0) depth = 1;

        const startPos = $from.before(depth);
        const endPos = $to.after(depth);

        const nodesToModify: Array<{ node: any; pos: number }> = [];

        state.doc.nodesBetween(startPos, endPos, (node, pos) => {
          if (node.type.name === 'paragraph' || node.type.name === 'heading') {
            nodesToModify.push({ node, pos });
            return false;
          }
        });

        nodesToModify.forEach(({ node, pos }) => {
          const currentType = node.attrs.textIndentType || 'none';
          // Toggle: if already hanging, set to none; otherwise set to hanging
          const newType = currentType === 'hanging' ? 'none' : 'hanging';
          tr.setNodeMarkup(pos, undefined, {
            ...node.attrs,
            textIndentType: newType,
          });
        });

        if (dispatch) {
          dispatch(tr);
        }
        return true;
      },

      // Clear text indent
      clearTextIndent: () => ({ tr, state, dispatch }) => {
        const { selection } = state;
        const { $from, $to } = selection;

        let depth = $from.sharedDepth($to.pos);
        if (depth === 0) depth = 1;

        const startPos = $from.before(depth);
        const endPos = $to.after(depth);

        const nodesToModify: Array<{ node: any; pos: number }> = [];

        state.doc.nodesBetween(startPos, endPos, (node, pos) => {
          if (node.type.name === 'paragraph' || node.type.name === 'heading') {
            nodesToModify.push({ node, pos });
            return false;
          }
        });

        nodesToModify.forEach(({ node, pos }) => {
          tr.setNodeMarkup(pos, undefined, {
            ...node.attrs,
            textIndentType: 'none',
          });
        });

        if (dispatch) {
          dispatch(tr);
        }
        return true;
      },

      // Legacy indent command (for list items)
      indent: () => ({ tr, state, dispatch }) => {
        const { selection } = state;
        const { $from, $to } = selection;

        let depth = $from.sharedDepth($to.pos);
        if (depth === 0) depth = 1;

        const startPos = $from.before(depth);
        const endPos = $to.after(depth);

        const nodesToIndent: Array<{ node: any; pos: number }> = [];

        state.doc.nodesBetween(startPos, endPos, (node, pos) => {
          if (node.type.name === 'paragraph' || node.type.name === 'heading') {
            nodesToIndent.push({ node, pos });
            return false;
          }
        });

        nodesToIndent.forEach(({ node, pos }) => {
          const currentIndent = node.attrs.indent || 0;
          if (currentIndent < 10) {
            tr.setNodeMarkup(pos, undefined, {
              ...node.attrs,
              indent: currentIndent + 1,
            });
          }
        });

        if (dispatch) {
          dispatch(tr);
        }
        return true;
      },

      // Legacy outdent command (for list items)
      outdent: () => ({ tr, state, dispatch }) => {
        const { selection } = state;
        const { $from, $to } = selection;

        let depth = $from.sharedDepth($to.pos);
        if (depth === 0) depth = 1;

        const startPos = $from.before(depth);
        const endPos = $to.after(depth);

        const nodesToOutdent: Array<{ node: any; pos: number }> = [];

        state.doc.nodesBetween(startPos, endPos, (node, pos) => {
          if (node.type.name === 'paragraph' || node.type.name === 'heading') {
            nodesToOutdent.push({ node, pos });
            return false;
          }
        });

        nodesToOutdent.forEach(({ node, pos }) => {
          const currentIndent = node.attrs.indent || 0;
          if (currentIndent > 0) {
            tr.setNodeMarkup(pos, undefined, {
              ...node.attrs,
              indent: currentIndent - 1,
            });
          }
        });

        if (dispatch) {
          dispatch(tr);
        }
        return true;
      },
    };
  },

  addKeyboardShortcuts() {
    return {
      'Tab': () => {
        const { editor } = this;
        if (editor.isActive('listItem')) {
          return editor.commands.sinkListItem('listItem');
        }
        if (editor.isActive('taskItem')) {
          return editor.commands.sinkListItem('taskItem');
        }
        // For regular paragraphs, use first-line indent
        return editor.commands.setFirstLineIndent();
      },
      'Shift-Tab': () => {
        const { editor } = this;
        if (editor.isActive('listItem')) {
          return editor.commands.liftListItem('listItem');
        }
        if (editor.isActive('taskItem')) {
          return editor.commands.liftListItem('taskItem');
        }
        // For regular paragraphs, use hanging indent
        return editor.commands.setHangingIndent();
      },
    };
  },
});

export default IndentExtension;
