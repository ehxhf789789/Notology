import type { BorderStyle } from './docxTypes';
import { getElement, getVal, getAttr } from './docxXmlHelpers';
import { parseColor } from './docxStyleParser';

// ==================== Step 7: Table Border Parsing ====================

export function parseBorderSide(el: Element | null): BorderStyle | undefined {
  if (!el) return undefined;
  const val = getVal(el);
  if (val === 'nil' || val === 'none') return { style: 'none', width: 0, color: 'transparent' };

  const sz = parseInt(getAttr(el, 'sz') || '4') / 8; // eighths of a point → pt
  const color = parseColor(getAttr(el, 'color')) || '#000000';
  const styleMap: Record<string, string> = {
    single: 'solid', dotted: 'dotted', dashed: 'dashed',
    double: 'double', thick: 'solid', nil: 'none', none: 'none',
    dashSmallGap: 'dashed', dashDotStroked: 'dashed',
  };

  return { style: styleMap[val || 'single'] || 'solid', width: Math.max(0.5, sz), color };
}

export function parseBorders(bordersEl: Element | null): {
  top?: BorderStyle; bottom?: BorderStyle; left?: BorderStyle; right?: BorderStyle;
  insideH?: BorderStyle; insideV?: BorderStyle;
} | undefined {
  if (!bordersEl) return undefined;
  return {
    top: parseBorderSide(getElement(bordersEl, 'w:top')),
    bottom: parseBorderSide(getElement(bordersEl, 'w:bottom')),
    left: parseBorderSide(getElement(bordersEl, 'w:left')),
    right: parseBorderSide(getElement(bordersEl, 'w:right')),
    insideH: parseBorderSide(getElement(bordersEl, 'w:insideH')),
    insideV: parseBorderSide(getElement(bordersEl, 'w:insideV')),
  };
}

export function borderToCSS(b: BorderStyle | undefined): string {
  if (!b || b.style === 'none') return 'none';
  return `${b.width}px ${b.style} ${b.color}`;
}
