// Design tokens — Colors
// Light/Dark pairs, folder palette, semantic states

export const colors = {
  // Background layers (3-tier)
  bg: {
    primary:   { light: '#FFFFFF', dark: '#1A1A1C' },
    secondary: { light: '#F7F7FA', dark: '#242426' },
    tertiary:  { light: '#EFEFF4', dark: '#2C2C2E' },
  },
  // Text hierarchy (4-tier)
  text: {
    primary:   { light: '#1C1C1E', dark: '#F2F2F7' },
    secondary: { light: '#6C6C70', dark: '#98989D' },
    tertiary:  { light: '#AEAEB2', dark: '#636366' },
    inverse:   { light: '#FFFFFF', dark: '#1C1C1E' },
  },
  // Borders & separators
  border: {
    default: { light: '#E5E5EA', dark: '#38383A' },
    subtle:  { light: '#F2F2F7', dark: '#2C2C2E' },
  },
  // Folder/category palette (10 colors, soft vivid tone)
  folder: [
    '#FF6B6B', // Coral Red
    '#FF922B', // Tangerine
    '#FCC419', // Sunflower
    '#51CF66', // Mint Green
    '#339AF0', // Sky Blue
    '#7950F2', // Iris Purple
    '#F06595', // Rose Pink
    '#20C997', // Teal
    '#845EF7', // Lavender
    '#FD7E14', // Amber
  ] as const,
  // System accent
  accent: { light: '#339AF0', dark: '#5CB8FF' },
  // Semantic states
  success: '#34C759',
  warning: '#FF9500',
  error:   '#FF3B30',
  // Overlay
  overlay: { light: 'rgba(0,0,0,0.35)', dark: 'rgba(0,0,0,0.55)' },
} as const;
