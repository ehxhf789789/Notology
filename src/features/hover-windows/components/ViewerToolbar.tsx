/**
 * ViewerToolbar — Stage 5.0.9c primitive.
 *
 * A flex-row container for document viewer toolbar buttons (zoom / page
 * nav / sheet tabs / etc.). Per HanBin Q2 sign-off this is a SLOT-based
 * primitive (children + helper subcomponents), not a config-driven
 * `buttons={[...]}` API. Each viewer composes the helpers it needs:
 *
 *   <ViewerToolbar position="top">
 *     <ToolbarZoom value={zoom} onZoom={setZoom} />
 *     <ToolbarPageNav page={p} total={n} onChange={setPage} />
 *   </ViewerToolbar>
 *
 * The helper components (ToolbarZoom, ToolbarPageNav, ToolbarSheetTabs)
 * each follow a consistent visual rhythm + design-token palette so the
 * Office viewers — DOCX/HWPX/PPTX/XLSX — read as one unified surface
 * once they adopt this primitive in 5.0.9e.
 *
 * Token-driven, no inline styles — all rules in `.viewer-toolbar*`
 * classes (see document-viewers.css `.docx-toolbar` / `.hwpx-toolbar`
 * for the visual reference).
 */

import { type ReactNode } from 'react';
import { ChevronLeft, ChevronRight, Minus, Plus } from 'lucide-react';

export interface ViewerToolbarProps {
  /** Toolbar position — drives a CSS modifier class. */
  position?: 'top' | 'bottom';
  /** Toolbar contents — typically ToolbarZoom / ToolbarPageNav / ToolbarSheetTabs. */
  children: ReactNode;
  className?: string;
}

export function ViewerToolbar({ position = 'top', children, className }: ViewerToolbarProps) {
  const cls = `viewer-toolbar viewer-toolbar--${position}${className ? ' ' + className : ''}`;
  return <div className={cls}>{children}</div>;
}

// ─────────────────────────────────────────────────────────────────────
// Toolbar zoom helper — − / pct / +
// ─────────────────────────────────────────────────────────────────────

export interface ToolbarZoomProps {
  /** Current zoom factor (1.0 = 100%). */
  value: number;
  /** Called with the new zoom factor. */
  onZoom: (next: number) => void;
  /** Minimum allowed zoom (default 0.25). */
  min?: number;
  /** Maximum allowed zoom (default 3). */
  max?: number;
  /** Step (default 0.1). */
  step?: number;
  /** Localized label for the zoom-out button. */
  zoomOutLabel?: string;
  /** Localized label for the zoom-in button. */
  zoomInLabel?: string;
}

export function ToolbarZoom({
  value,
  onZoom,
  min = 0.25,
  max = 3,
  step = 0.1,
  zoomOutLabel = 'Zoom out',
  zoomInLabel = 'Zoom in',
}: ToolbarZoomProps) {
  const pct = Math.round(value * 100);
  return (
    <span className="viewer-toolbar__zoom">
      <button
        type="button"
        className="viewer-toolbar__btn"
        onClick={() => onZoom(Math.max(min, +(value - step).toFixed(2)))}
        disabled={value <= min}
        aria-label={zoomOutLabel}
        title={zoomOutLabel}
      >
        <Minus size={14} />
      </button>
      <span className="viewer-toolbar__zoom-pct" aria-live="polite">{pct}%</span>
      <button
        type="button"
        className="viewer-toolbar__btn"
        onClick={() => onZoom(Math.min(max, +(value + step).toFixed(2)))}
        disabled={value >= max}
        aria-label={zoomInLabel}
        title={zoomInLabel}
      >
        <Plus size={14} />
      </button>
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Toolbar page-nav helper — ← page-input / total →
// ─────────────────────────────────────────────────────────────────────

export interface ToolbarPageNavProps {
  page: number;
  total: number;
  onChange: (next: number) => void;
  prevLabel?: string;
  nextLabel?: string;
  pageInputLabel?: string;
}

export function ToolbarPageNav({
  page,
  total,
  onChange,
  prevLabel = 'Previous page',
  nextLabel = 'Next page',
  pageInputLabel = 'Page number',
}: ToolbarPageNavProps) {
  const clamped = (n: number) => Math.max(1, Math.min(total, Math.floor(n) || 1));
  return (
    <span className="viewer-toolbar__page-nav">
      <button
        type="button"
        className="viewer-toolbar__btn"
        onClick={() => onChange(clamped(page - 1))}
        disabled={page <= 1}
        aria-label={prevLabel}
        title={prevLabel}
      >
        <ChevronLeft size={14} />
      </button>
      <input
        type="number"
        className="viewer-toolbar__page-input"
        value={page}
        min={1}
        max={total}
        onChange={(e) => onChange(clamped(Number(e.target.value)))}
        aria-label={pageInputLabel}
      />
      <span className="viewer-toolbar__page-total">/ {total}</span>
      <button
        type="button"
        className="viewer-toolbar__btn"
        onClick={() => onChange(clamped(page + 1))}
        disabled={page >= total}
        aria-label={nextLabel}
        title={nextLabel}
      >
        <ChevronRight size={14} />
      </button>
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Toolbar sheet-tabs helper — XLSX-only sheet selector
// ─────────────────────────────────────────────────────────────────────

export interface ToolbarSheetTabsProps {
  sheets: string[];
  active: number;
  onSelect: (index: number) => void;
}

export function ToolbarSheetTabs({ sheets, active, onSelect }: ToolbarSheetTabsProps) {
  return (
    <span className="viewer-toolbar__sheet-tabs" role="tablist">
      {sheets.map((name, i) => (
        <button
          type="button"
          key={name + i}
          role="tab"
          aria-selected={i === active}
          className={`viewer-toolbar__sheet-tab${i === active ? ' is-active' : ''}`}
          onClick={() => onSelect(i)}
        >
          {name}
        </button>
      ))}
    </span>
  );
}
