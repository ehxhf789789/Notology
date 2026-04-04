import { Node, mergeAttributes } from '@tiptap/core';

export type TextIndentType = 'none' | 'firstLine' | 'hanging';

/**
 * Convert a ProseMirror node's inline content to HTML string.
 * This is needed when serializing indented paragraphs as HTML blocks,
 * because markdown inside HTML blocks is not parsed by markdown-it.
 */
function inlineContentToHTML(node: any): string {
  if (!node.content || node.content.size === 0) {
    return '';
  }

  // Build HTML from inline content
  let html = '';
  node.content.forEach((child: any) => {
    if (child.isText) {
      let text = escapeHTML(child.text || '');

      // Apply marks in order
      if (child.marks && child.marks.length > 0) {
        // Sort marks to ensure consistent ordering
        const marks = [...child.marks].sort((a, b) => {
          const order: Record<string, number> = { bold: 1, italic: 2, strike: 3, underline: 4, code: 5 };
          return (order[a.type.name] || 99) - (order[b.type.name] || 99);
        });

        for (const mark of marks) {
          text = wrapWithMark(text, mark);
        }
      }
      html += text;
    } else if (child.type.name === 'hardBreak') {
      html += '<br>';
    } else if (child.type.name === 'mathInline') {
      // Math inline: preserve formula as $...$
      const formula = child.attrs?.formula || '';
      if (formula) html += `$${formula}$`;
    } else if (child.type.name === 'mathBlock') {
      const formula = child.attrs?.formula || '';
      if (formula) html += `$$${formula}$$`;
    } else if (child.type.name === 'wikiLink') {
      // Wiki links: preserve as [[...]]
      const fileName = child.attrs?.fileName || '';
      const displayText = child.attrs?.displayText || '';
      if (displayText && displayText !== fileName) {
        html += `[[${fileName}|${displayText}]]`;
      } else {
        html += `[[${fileName}]]`;
      }
    } else {
      // Fallback for other inline nodes.
      // WARNING: atom nodes (no textContent) will produce empty tags.
      // If a new atom node type is added, handle it explicitly above.
      const content = child.textContent || '';
      if (content) {
        html += escapeHTML(content);
      }
      // Silently skip empty unhandled nodes rather than creating broken tags
    }
  });

  return html;
}

function escapeHTML(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function wrapWithMark(text: string, mark: any): string {
  const name = mark.type.name;
  switch (name) {
    case 'bold':
      return `<strong>${text}</strong>`;
    case 'italic':
      return `<em>${text}</em>`;
    case 'strike':
      return `<s>${text}</s>`;
    case 'underline':
      return `<u>${text}</u>`;
    case 'code':
      return `<code>${text}</code>`;
    case 'link':
      const href = mark.attrs?.href || '';
      return `<a href="${escapeHTML(href)}">${text}</a>`;
    case 'highlight':
      return `<mark>${text}</mark>`;
    case 'subscript':
      return `<sub>${text}</sub>`;
    case 'superscript':
      return `<sup>${text}</sup>`;
    case 'wikiLink':
      // WikiLinks are rendered as [[linkName]] in markdown
      // But in HTML context, we keep them as-is for the parser
      const linkName = mark.attrs?.href || text;
      return `[[${linkName}]]`;
    case 'comment':
      // Comments are preserved with their ID
      const commentId = mark.attrs?.commentId || '';
      return `<span data-comment-id="${escapeHTML(commentId)}">${text}</span>`;
    default:
      return text;
  }
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    paragraphWithIndent: {
      setFirstLineIndent: () => ReturnType;
      setHangingIndent: () => ReturnType;
      clearTextIndent: () => ReturnType;
    };
  }
}

/**
 * Custom Paragraph node that supports indent attributes and proper markdown serialization.
 * This extends the default paragraph to include data-indent and data-text-indent-type attributes.
 */
export const ParagraphWithIndent = Node.create({
  name: 'paragraph',
  priority: 1000,

  group: 'block',
  content: 'inline*',

  addAttributes() {
    return {
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
          // When hanging indent is applied, don't use padding-left here
          // (textIndentType will handle all padding with the combined total)
          if (attributes.textIndentType === 'hanging') {
            return {
              'data-indent': attributes.indent,
            };
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
            return {
              'data-text-indent-type': 'firstLine',
              style: 'text-indent: 2em',
            };
          }
          if (type === 'hanging') {
            // Hanging indent: first line at normal position, subsequent lines indented +2em
            // Use padding-left (not margin-left) so text-indent can pull first line back
            // to the padding edge without going outside the element's visible boundary
            const baseIndent = (attributes.indent || 0) * 2;
            const totalPadding = baseIndent + 2;
            return {
              'data-text-indent-type': 'hanging',
              style: `padding-left: ${totalPadding}em; text-indent: -2em`,
            };
          }
          return {};
        },
      },
      textAlign: {
        default: 'left',
        parseHTML: element => {
          return element.getAttribute('data-text-align') || element.style.textAlign || 'left';
        },
        renderHTML: attributes => {
          if (!attributes.textAlign || attributes.textAlign === 'left') {
            return {};
          }
          return {
            'data-text-align': attributes.textAlign,
            style: `text-align: ${attributes.textAlign}`,
          };
        },
      },
    };
  },

  parseHTML() {
    return [
      { tag: 'p' },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return ['p', mergeAttributes(this.options.HTMLAttributes, HTMLAttributes), 0];
  },

  addStorage() {
    return {
      markdown: {
        serialize(state: any, node: any) {
          const indent = node.attrs?.indent || 0;
          const textIndentType = node.attrs?.textIndentType || 'none';
          const textAlign = node.attrs?.textAlign || 'left';

          // If has indent/alignment attributes, render as full HTML to preserve them
          // AND render inline content as HTML (not markdown) because
          // markdown inside HTML blocks is not parsed by markdown-it
          if (indent > 0 || textIndentType !== 'none' || (textAlign && textAlign !== 'left')) {
            const attrs: string[] = [];

            // Build style attribute
            const styles: string[] = [];
            if (indent > 0) {
              attrs.push(`data-indent="${indent}"`);
            }

            if (textIndentType === 'firstLine') {
              // First-line indent: add padding for base indent, text-indent for first line
              if (indent > 0) {
                styles.push(`padding-left: ${indent * 2}em`);
              }
              styles.push('text-indent: 2em');
            } else if (textIndentType === 'hanging') {
              // Hanging indent: use padding-left so text-indent can pull first line
              // back to padding edge without clipping
              const totalPadding = (indent * 2) + 2;
              styles.push(`padding-left: ${totalPadding}em`);
              styles.push('text-indent: -2em');
            } else if (indent > 0) {
              // Only base indent, no text indent type
              styles.push(`padding-left: ${indent * 2}em`);
            }

            // Add text alignment
            if (textAlign && textAlign !== 'left') {
              styles.push(`text-align: ${textAlign}`);
              attrs.push(`data-text-align="${textAlign}"`);
            }

            if (styles.length > 0) {
              attrs.push(`style="${styles.join('; ')}"`);
            }
            if (textIndentType !== 'none') {
              attrs.push(`data-text-indent-type="${textIndentType}"`);
            }

            // Render inline content as HTML (not markdown) to preserve formatting
            const inlineHTML = inlineContentToHTML(node);

            state.write(`<p ${attrs.join(' ')}>${inlineHTML}</p>`);
            state.closeBlock(node);
          } else {
            // Default paragraph handling - render as markdown
            state.renderInline(node);
            state.closeBlock(node);
          }
        },
        parse: {
          // handled by markdown-it
        },
      },
    };
  },

  addCommands() {
    return {
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
        return editor.commands.setHangingIndent();
      },
    };
  },
});

export default ParagraphWithIndent;
