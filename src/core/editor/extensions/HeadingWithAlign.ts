import { Heading } from '@tiptap/extension-heading';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import HeadingView from '../../../features/note-editor/HeadingView';

/**
 * Convert a ProseMirror node's inline content to HTML string.
 */
function inlineContentToHTML(node: any): string {
  if (!node.content || node.content.size === 0) {
    return '';
  }

  let html = '';
  node.content.forEach((child: any) => {
    if (child.isText) {
      let text = escapeHTML(child.text || '');

      if (child.marks && child.marks.length > 0) {
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
    } else {
      html += `<${child.type.name}>${escapeHTML(child.textContent)}</${child.type.name}>`;
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
      const linkName = mark.attrs?.href || text;
      return `[[${linkName}]]`;
    default:
      return text;
  }
}

export const HeadingWithAlign = Heading.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
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
    return ReactNodeViewRenderer(HeadingView);
  },

  addStorage() {
    return {
      markdown: {
        serialize(state: any, node: any) {
          const level = node.attrs?.level || 1;
          const textAlign = node.attrs?.textAlign || 'left';
          const collapsed = node.attrs?.collapsed || false;

          // If has alignment or collapsed state, render as HTML to preserve it
          if ((textAlign && textAlign !== 'left') || collapsed) {
            const styles: string[] = [];
            const attrs: string[] = [];

            if (textAlign && textAlign !== 'left') {
              styles.push(`text-align: ${textAlign}`);
              attrs.push(`data-text-align="${textAlign}"`);
            }

            if (collapsed) {
              attrs.push('data-collapsed="true"');
            }

            if (styles.length > 0) {
              attrs.push(`style="${styles.join('; ')}"`);
            }

            const inlineHTML = inlineContentToHTML(node);
            state.write(`<h${level} ${attrs.join(' ')}>${inlineHTML}</h${level}>`);
            state.closeBlock(node);
          } else {
            // Default heading - render as markdown
            state.write(`${'#'.repeat(level)} `);
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

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('headingCollapse'),
        props: {
          decorations: (state) => {
            const { doc } = state;
            const decorations: Decoration[] = [];

            // Find all collapsed headings with their ranges
            const collapsedHeadings: { level: number; endPos: number }[] = [];

            doc.descendants((node, pos) => {
              if (node.type.name === 'heading' && node.attrs.collapsed) {
                collapsedHeadings.push({
                  level: node.attrs.level,
                  endPos: pos + node.nodeSize,
                });
              }
            });

            // For each collapsed heading, hide following content until next heading of same/higher level
            for (const heading of collapsedHeadings) {
              let pos = heading.endPos;

              // Iterate through subsequent top-level blocks
              while (pos < doc.content.size) {
                const $pos = doc.resolve(pos);
                const node = $pos.nodeAfter;

                if (!node) break;

                // Stop at heading of equal or higher level (lower or equal number)
                if (node.type.name === 'heading' && node.attrs.level <= heading.level) {
                  break;
                }

                // Hide this block
                decorations.push(
                  Decoration.node(pos, pos + node.nodeSize, {
                    class: 'heading-collapsed-content',
                  })
                );

                pos += node.nodeSize;
              }
            }

            return DecorationSet.create(doc, decorations);
          },
        },
      }),
    ];
  },

  addKeyboardShortcuts() {
    return {
      'Mod-1': () => this.editor.commands.toggleHeading({ level: 1 }),
      'Mod-2': () => this.editor.commands.toggleHeading({ level: 2 }),
      'Mod-3': () => this.editor.commands.toggleHeading({ level: 3 }),
      'Mod-4': () => this.editor.commands.toggleHeading({ level: 4 }),
      'Mod-5': () => this.editor.commands.toggleHeading({ level: 5 }),
      'Mod-6': () => this.editor.commands.toggleHeading({ level: 6 }),
    };
  },
});

export default HeadingWithAlign;
