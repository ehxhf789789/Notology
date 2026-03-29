import { TableCell } from '@tiptap/extension-table';
import { mergeAttributes } from '@tiptap/core';

export const TableCellWithColor = TableCell.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      backgroundColor: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-background-color') || element.style.backgroundColor,
        renderHTML: (attributes) => {
          if (!attributes.backgroundColor) {
            return {};
          }
          return {
            'data-background-color': attributes.backgroundColor,
            style: `background-color: ${attributes.backgroundColor}`,
          };
        },
      },
    };
  },

  renderHTML({ HTMLAttributes }) {
    return ['td', mergeAttributes(this.options.HTMLAttributes, HTMLAttributes), 0];
  },
});

export default TableCellWithColor;
