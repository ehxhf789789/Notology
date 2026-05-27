/**
 * Notology iOS-style glyph constants (2026-05-22, HanBin).
 *
 * Single source of truth for the small directional/status glyphs that
 * scatter across the codebase as inline string literals
 * (`▲ ▼ ↑ ↓ ✓ ✕ ○ ● ⋯` etc.). Each constant has a clear semantic name
 * so usages read as intent, not as ad-hoc Unicode.
 *
 * Why this matters:
 *   - Previously a sort indicator was `↑/↓` in one file (Search.tsx)
 *     and `▲/▼` in another (AttachmentsTab.tsx). The user (HanBin)
 *     correctly pointed out that this is a *system* failure, not a
 *     "human review" oversight.
 *   - Type-checked import + grep-able names make this enforceable:
 *     reviewers can spot `<span>{"▲"}</span>` and ask "why not
 *     SORT_DESC?", and a future ESLint rule can ban inline glyphs.
 *
 * Conventions:
 *   - SORT_*    — sort indicators (thin arrows, iOS table tone)
 *   - CHEVRON_* — disclosure / dropdown carets
 *   - CHECK     — selection / confirmation tick
 *   - DISMISS   — close / clear glyph (X-ish)
 *   - STATUS_*  — dot / triangle indicators for sync / error / unread
 *   - DOT       — generic neutral dot
 *
 * NOTE: lucide-react icons (the React component family) are preferred
 * for *interactive* affordances (buttons, toggles, etc.). This module
 * is reserved for *typographic* glyphs that render inline with text —
 * sort arrows next to column labels, check marks inside menu rows, etc.
 */

// ── Sort indicators (thin arrows, iOS Files / Mail tone) ──
/** Ascending sort indicator. Renders next to active sort column header. */
export const SORT_ASC = '↑';
/** Descending sort indicator. */
export const SORT_DESC = '↓';

// ── Disclosure / chevrons ──
/** Right-pointing chevron — used for "this expands" / breadcrumb separator. */
export const CHEVRON_RIGHT = '›';
/** Left-pointing chevron — used for back navigation. */
export const CHEVRON_LEFT = '‹';
/** Down chevron — used for collapsed accordion / dropdown trigger. */
export const CHEVRON_DOWN = '⌄';

// ── Confirmation marks ──
/** Selection / "this option is chosen" mark. Menu rows, checklists. */
export const CHECK = '✓';
/** Dismiss / "clear this" glyph. Close buttons, remove chips. */
export const DISMISS = '✕';

// ── Status dots & triangles ──
/** Neutral status dot. Generic "online", "active", "ready" indicator. */
export const DOT = '●';
/** Hollow dot — "inactive", "open" (un-resolved comment, etc.). */
export const DOT_HOLLOW = '○';
/** Warning / conflict triangle (filled). Sync conflict, error state. */
export const STATUS_WARN = '▲';

// ── Misc ──
/** Vertical ellipsis — row-level "more" menu trigger. */
export const ELLIPSIS_V = '⋯';
/** Horizontal ellipsis — text truncation marker. */
export const ELLIPSIS_H = '…';

/**
 * Helper: returns the sort glyph for a given direction, or empty string
 * when not active. Centralizes the `active ? (asc ? ↑ : ↓) : ''` pattern
 * that was duplicated across Search.tsx and AttachmentsTab.tsx.
 */
export function sortGlyph(active: boolean, dir: 'asc' | 'desc'): string {
  if (!active) return '';
  return dir === 'asc' ? SORT_ASC : SORT_DESC;
}
