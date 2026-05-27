/**
 * Mobile GraphView canvas color resolver (Stage 5.0.10b).
 *
 * Same idea as desktop's `features/graph/graph-colors.ts` — canvas
 * `ctx.fillStyle` / `ctx.strokeStyle` only accept raw color strings,
 * so theme-aware colors have to be resolved up-front and re-resolved
 * on theme swap. Mobile differs in that it reads from the JS token
 * module (`styles/tokens/colors.ts`) rather than CSS custom properties,
 * so this resolver is a pure-function lookup keyed on `isDark`.
 *
 * Why a separate module instead of reusing desktop's resolver:
 * - Desktop's palette is built around per-note-type tokens. Mobile
 *   colors notes by folder-hash (intentional UX divergence — see
 *   `getNodeColor` in GraphView.tsx), so the desktop palette shape
 *   doesn't map cleanly.
 * - Mobile carries a dot-grid background colour that desktop doesn't.
 */

import { colors as tokenColors } from '../../../styles/tokens/colors';

export interface MobileGraphPalette {
  /** Dot-grid background pattern. Empty string when grid should be skipped. */
  dotGrid: string;
  /** Edge stroke when one endpoint is the hovered/selected node. */
  edgeHighlight: string;
  /** Edge stroke for non-highlighted edges. */
  edgeDefault: string;
  /** Outline drawn around every node circle. */
  nodeStroke: string;
  /** Pill background behind a node label. */
  labelBg: string;
  /** Label text fill. */
  labelText: string;
  /** Fill for `nodeType === 'tag'` nodes. */
  tagNode: string;
}

const DARK: MobileGraphPalette = {
  dotGrid: '',
  edgeHighlight: tokenColors.accent.dark,
  edgeDefault: 'rgba(255,255,255,0.1)',
  nodeStroke: 'rgba(255,255,255,0.3)',
  // Matches `tokenColors.bg.primary.dark` (#1A1A1C) with 0.8 alpha.
  labelBg: 'rgba(26,26,28,0.8)',
  labelText: 'rgba(255,255,255,0.7)',
  tagNode: tokenColors.folder[5], // Iris Purple — was hardcoded #7950F2
};

const LIGHT: MobileGraphPalette = {
  dotGrid: 'rgba(0,0,0,0.06)',
  edgeHighlight: tokenColors.accent.light,
  edgeDefault: 'rgba(0,0,0,0.08)',
  nodeStroke: '#FFFFFF',
  labelBg: 'rgba(255,255,255,0.85)',
  labelText: 'rgba(0,0,0,0.65)',
  tagNode: tokenColors.folder[5],
};

export function resolveMobileGraphPalette(isDark: boolean): MobileGraphPalette {
  return isDark ? DARK : LIGHT;
}
