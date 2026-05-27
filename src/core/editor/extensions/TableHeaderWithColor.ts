import { TableHeader } from '@tiptap/extension-table';
import { mergeAttributes } from '@tiptap/core';

/** Valid semantic cell color keys */
const CELL_COLOR_KEYS = new Set([
  'cell-dark-gray', 'cell-gray', 'cell-blue', 'cell-green',
  'cell-brown', 'cell-purple', 'cell-red',
]);

/** Map legacy hardcoded hex colors to semantic keys */
const LEGACY_COLOR_MAP: Record<string, string> = {
  // Dark theme legacy
  '#2d2d2d': 'cell-dark-gray', '#3c3c3c': 'cell-gray',
  '#1e3a5f': 'cell-blue', '#2d4a2c': 'cell-green',
  '#5f3a1e': 'cell-brown', '#5f1e3a': 'cell-purple',
  '#4a2d2d': 'cell-red',
  // Light theme legacy
  '#e5e5e5': 'cell-dark-gray', '#e0e0e0': 'cell-dark-gray',
  '#f0f0f0': 'cell-gray',
  '#dbeafe': 'cell-blue', '#dcfce7': 'cell-green',
  '#fef3c7': 'cell-brown', '#f3e8ff': 'cell-purple',
  '#fee2e2': 'cell-red',
};

function normalizeColor(value: string | null | undefined): string | null {
  if (!value || value === 'transparent') return null;
  const v = value.trim().toLowerCase();
  if (CELL_COLOR_KEYS.has(v)) return v;
  return LEGACY_COLOR_MAP[v] || null;
}

export const TableHeaderWithColor = TableHeader.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      backgroundColor: {
        default: null,
        parseHTML: (element) => {
          const attr = element.getAttribute('data-background-color');
          if (attr) return normalizeColor(attr);
          const style = element.style.backgroundColor;
          if (style) return normalizeColor(style);
          return null;
        },
        renderHTML: (attributes) => {
          if (!attributes.backgroundColor) return {};
          return {
            'data-background-color': attributes.backgroundColor,
          };
        },
      },
    };
  },

  renderHTML({ HTMLAttributes }) {
    return ['th', mergeAttributes(this.options.HTMLAttributes, HTMLAttributes), 0];
  },
});

export default TableHeaderWithColor;
