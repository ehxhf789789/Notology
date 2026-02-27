import React, { useState, useEffect, useRef } from 'react';
import JSZip from 'jszip';

interface PptxViewerProps {
  data: ArrayBuffer;
}

// EMU (English Metric Units) conversion: 914400 EMU = 1 inch = 96 CSS pixels
const EMU_PER_PIXEL = 914400 / 96;

// ─── Interfaces ───

interface TextRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  fontSize?: number;
  fontFamily?: string;
  color?: string;
  hyperlink?: string;
  letterSpacing?: number; // in pt
}

interface Paragraph {
  runs: TextRun[];
  align?: 'left' | 'center' | 'right' | 'justify';
  bulletChar?: string;
  level?: number;
  lineHeight?: number;    // percentage (e.g. 120 = 120%)
  lineHeightPt?: number;  // exact points
  spaceBefore?: number;   // px
  spaceAfter?: number;    // px
  marginLeft?: number;    // px
  indent?: number;        // first line indent px
}

interface TextBodyProps {
  wrap?: 'none' | 'square';
  paddingLeft: number;
  paddingRight: number;
  paddingTop: number;
  paddingBottom: number;
  verticalAlign?: 'top' | 'middle' | 'bottom';
  verticalText?: boolean;
  autoFit?: boolean;
  fontScale?: number;       // 0-1 ratio from a:normAutofit fontScale
  lnSpcReduction?: number;  // 0-1 ratio from a:normAutofit lnSpcReduction
}

interface CellBorder {
  color: string;
  width: number;
}

interface TableCell {
  paragraphs: Paragraph[];
  colSpan?: number;
  rowSpan?: number;
  backgroundColor?: string;
  borderColor?: string;
  borders?: {
    left?: CellBorder;
    right?: CellBorder;
    top?: CellBorder;
    bottom?: CellBorder;
  };
  vertAlign?: 'top' | 'middle' | 'bottom';
  noFill?: boolean;
  margins?: { left: number; right: number; top: number; bottom: number };
}

interface TableRow {
  cells: TableCell[];
  height?: number;
}

interface TableProps {
  firstRow?: boolean;
  lastRow?: boolean;
  bandRow?: boolean;
  bandCol?: boolean;
  firstCol?: boolean;
  lastCol?: boolean;
  backgroundColor?: string;
  tblStyleId?: string;
}

interface TableElement {
  type: 'table';
  x: number;
  y: number;
  width: number;
  height: number;
  rows: TableRow[];
  colWidths: number[];
  frameHeight?: number;
  tblProps?: TableProps;
}

interface ArrowHead {
  type: 'triangle' | 'stealth' | 'oval' | 'diamond' | 'arrow' | 'none';
  w?: 'sm' | 'med' | 'lg';
  len?: 'sm' | 'med' | 'lg';
}

interface GradientFill {
  type: 'linear' | 'radial';
  angle?: number;
  stops: { position: number; color: string }[];
}

interface ShadowProps {
  offsetX: number;
  offsetY: number;
  blur: number;
  color: string;
  inset?: boolean;
}

interface ShapeElement {
  type: 'shape' | 'image' | 'line';
  x: number;
  y: number;
  width: number;
  height: number;
  paragraphs?: Paragraph[];
  imageSrc?: string;
  imageRelId?: string;
  imageCrop?: { left: number; top: number; right: number; bottom: number };
  backgroundColor?: string;
  gradientFill?: GradientFill;
  borderColor?: string;
  borderWidth?: number;
  rotation?: number;
  flipH?: boolean;
  flipV?: boolean;
  shapeType?: string;
  customPath?: string;
  connectorType?: string;
  adjustValues?: Record<string, number>;
  headEnd?: ArrowHead;
  tailEnd?: ArrowHead;
  dashStyle?: string;
  textBody?: TextBodyProps;
  shadow?: ShadowProps;
  duotoneColors?: [string, string]; // [shadowColor, highlightColor]
}

interface SlideBackground {
  color?: string;
  gradient?: GradientFill;
  imageRelId?: string;
}

interface GroupShapeElement {
  type: 'group';
  x: number;
  y: number;
  width: number;
  height: number;
  childOffsetX: number;
  childOffsetY: number;
  childExtX: number;
  childExtY: number;
  rotation?: number;
  flipH?: boolean;
  flipV?: boolean;
  children: (ShapeElement | TableElement | GroupShapeElement)[];
}

type SlideShape = ShapeElement | TableElement | GroupShapeElement;

interface SlideData {
  shapes: SlideShape[];
  width: number;
  height: number;
  background?: SlideBackground;
  showMasterSp?: boolean;
}

// ─── Theme ───

type ThemeColors = Record<string, string>;

interface ThemeFonts {
  majorLatin: string;
  minorLatin: string;
  majorEA: string;
  minorEA: string;
}

interface ThemeData {
  colors: ThemeColors;
  fonts: ThemeFonts;
}

// ─── RelId Prefixing (prevent collision between slide/layout/master) ───

/** Deep-clone shapes and prefix all imageRelIds to avoid relId collisions */
function prefixShapeRelIds(shapes: SlideShape[], prefix: string): SlideShape[] {
  const prefixRelId = (relId: string | undefined): string | undefined => {
    if (!relId) return relId;
    return `${prefix}:${relId}`;
  };

  const cloneShape = (shape: SlideShape): SlideShape => {
    if (shape.type === 'group') {
      const group = shape as GroupShapeElement;
      return {
        ...group,
        children: group.children.map(cloneShape),
      };
    } else if (shape.type === 'table') {
      return { ...shape }; // tables don't have imageRelId
    } else {
      const se = shape as ShapeElement;
      return {
        ...se,
        imageRelId: prefixRelId(se.imageRelId),
      };
    }
  };

  return shapes.map(cloneShape);
}

/** Prefix all keys in an imageMap */
function prefixImageMap(imageMap: Map<string, string>, prefix: string): Map<string, string> {
  const prefixed = new Map<string, string>();
  for (const [id, src] of imageMap) {
    prefixed.set(`${prefix}:${id}`, src);
  }
  return prefixed;
}

function parseThemeXml(xmlString: string): ThemeData {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlString, 'application/xml');
  const colors: ThemeColors = {};

  const clrScheme = doc.getElementsByTagName('a:clrScheme')[0];
  if (clrScheme) {
    const tagMap: Record<string, string> = {
      'a:dk1': 'dk1', 'a:dk2': 'dk2', 'a:lt1': 'lt1', 'a:lt2': 'lt2',
      'a:accent1': 'accent1', 'a:accent2': 'accent2', 'a:accent3': 'accent3',
      'a:accent4': 'accent4', 'a:accent5': 'accent5', 'a:accent6': 'accent6',
      'a:hlink': 'hlink', 'a:folHlink': 'folHlink',
    };
    for (const [tag, key] of Object.entries(tagMap)) {
      const el = clrScheme.getElementsByTagName(tag)[0];
      if (el) {
        const srgb = el.getElementsByTagName('a:srgbClr')[0];
        const sys = el.getElementsByTagName('a:sysClr')[0];
        if (srgb) colors[key] = '#' + srgb.getAttribute('val');
        else if (sys) colors[key] = '#' + (sys.getAttribute('lastClr') || sys.getAttribute('val') || '000000');
      }
    }
  }

  colors['tx1'] = colors['dk1'] || '#000000';
  colors['tx2'] = colors['dk2'] || '#44546A';
  colors['bg1'] = colors['lt1'] || '#FFFFFF';
  colors['bg2'] = colors['lt2'] || '#E7E6E6';

  const fonts: ThemeFonts = { majorLatin: 'Calibri Light', minorLatin: 'Calibri', majorEA: '', minorEA: '' };
  const majorFont = doc.getElementsByTagName('a:majorFont')[0];
  if (majorFont) {
    const latin = majorFont.getElementsByTagName('a:latin')[0];
    if (latin) fonts.majorLatin = latin.getAttribute('typeface') || 'Calibri Light';
    const ea = majorFont.getElementsByTagName('a:ea')[0];
    if (ea) fonts.majorEA = ea.getAttribute('typeface') || '';
  }
  const minorFont = doc.getElementsByTagName('a:minorFont')[0];
  if (minorFont) {
    const latin = minorFont.getElementsByTagName('a:latin')[0];
    if (latin) fonts.minorLatin = latin.getAttribute('typeface') || 'Calibri';
    const ea = minorFont.getElementsByTagName('a:ea')[0];
    if (ea) fonts.minorEA = ea.getAttribute('typeface') || '';
  }

  return { colors, fonts };
}

// ─── Color Utilities ───

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const h = hex.replace('#', '');
  return {
    r: parseInt(h.substring(0, 2), 16),
    g: parseInt(h.substring(2, 4), 16),
    b: parseInt(h.substring(4, 6), 16),
  };
}

function rgbToHex(r: number, g: number, b: number): string {
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  return '#' + [clamp(r), clamp(g), clamp(b)].map(v => v.toString(16).padStart(2, '0')).join('');
}

function applyColorMods(baseHex: string, modElement: Element): string {
  const { r, g, b } = hexToRgb(baseHex);

  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  let h = 0, s = 0, l = (max + min) / 2;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case rn: h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6; break;
      case gn: h = ((bn - rn) / d + 2) / 6; break;
      case bn: h = ((rn - gn) / d + 4) / 6; break;
    }
  }

  const lumMod = modElement.getElementsByTagName('a:lumMod')[0];
  const lumOff = modElement.getElementsByTagName('a:lumOff')[0];
  const tint = modElement.getElementsByTagName('a:tint')[0];
  const shade = modElement.getElementsByTagName('a:shade')[0];

  if (lumMod) {
    const val = parseInt(lumMod.getAttribute('val') || '100000') / 100000;
    l = l * val;
  }
  if (lumOff) {
    const val = parseInt(lumOff.getAttribute('val') || '0') / 100000;
    l = l + val;
  }

  l = Math.max(0, Math.min(1, l));

  const hue2rgb = (p: number, q: number, t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1/6) return p + (q - p) * 6 * t;
    if (t < 1/2) return q;
    if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
    return p;
  };

  let rr: number, gg: number, bb: number;
  if (s === 0) {
    rr = gg = bb = l;
  } else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    rr = hue2rgb(p, q, h + 1/3);
    gg = hue2rgb(p, q, h);
    bb = hue2rgb(p, q, h - 1/3);
  }

  let finalR = rr * 255, finalG = gg * 255, finalB = bb * 255;

  if (tint) {
    const val = parseInt(tint.getAttribute('val') || '100000') / 100000;
    finalR = finalR * val + 255 * (1 - val);
    finalG = finalG * val + 255 * (1 - val);
    finalB = finalB * val + 255 * (1 - val);
  }
  if (shade) {
    const val = parseInt(shade.getAttribute('val') || '100000') / 100000;
    finalR = finalR * val;
    finalG = finalG * val;
    finalB = finalB * val;
  }

  return rgbToHex(finalR, finalG, finalB);
}

const DEFAULT_SCHEME_COLORS: ThemeColors = {
  'tx1': '#000000', 'tx2': '#44546A', 'bg1': '#FFFFFF', 'bg2': '#E7E6E6',
  'accent1': '#4472C4', 'accent2': '#ED7D31', 'accent3': '#A5A5A5',
  'accent4': '#FFC000', 'accent5': '#5B9BD5', 'accent6': '#70AD47',
  'dk1': '#000000', 'dk2': '#44546A', 'lt1': '#FFFFFF', 'lt2': '#E7E6E6',
  'hlink': '#0563C1', 'folHlink': '#954F72',
};

function parseColor(colorNode: Element | null, themeColors?: ThemeColors): string | undefined {
  if (!colorNode) return undefined;

  const srgb = colorNode.getElementsByTagName('a:srgbClr')[0];
  if (srgb) {
    const val = srgb.getAttribute('val');
    if (!val) return undefined;
    let color = '#' + val;

    const hasMods = srgb.getElementsByTagName('a:lumMod')[0] ||
                    srgb.getElementsByTagName('a:tint')[0] ||
                    srgb.getElementsByTagName('a:shade')[0];
    if (hasMods) {
      color = applyColorMods(color, srgb);
    }

    const alpha = srgb.getElementsByTagName('a:alpha')[0];
    if (alpha) {
      const alphaVal = parseInt(alpha.getAttribute('val') || '100000') / 100000;
      const { r, g, b } = hexToRgb(color);
      return `rgba(${r}, ${g}, ${b}, ${alphaVal})`;
    }
    return color;
  }

  const scheme = colorNode.getElementsByTagName('a:schemeClr')[0];
  if (scheme) {
    const val = scheme.getAttribute('val');
    const colors = themeColors || DEFAULT_SCHEME_COLORS;
    let baseColor = colors[val || ''];
    if (!baseColor) return undefined;

    const hasMods = scheme.getElementsByTagName('a:lumMod')[0] ||
                    scheme.getElementsByTagName('a:lumOff')[0] ||
                    scheme.getElementsByTagName('a:tint')[0] ||
                    scheme.getElementsByTagName('a:shade')[0];
    if (hasMods) {
      baseColor = applyColorMods(baseColor, scheme);
    }

    const alpha = scheme.getElementsByTagName('a:alpha')[0];
    if (alpha) {
      const alphaVal = parseInt(alpha.getAttribute('val') || '100000') / 100000;
      const { r, g, b } = hexToRgb(baseColor);
      return `rgba(${r}, ${g}, ${b}, ${alphaVal})`;
    }
    return baseColor;
  }

  // System color (e.g., windowText → black, window → white)
  const sysClr = colorNode.getElementsByTagName('a:sysClr')[0];
  if (sysClr) {
    const lastClr = sysClr.getAttribute('lastClr');
    if (lastClr) {
      let color = '#' + lastClr;
      const alpha = sysClr.getElementsByTagName('a:alpha')[0];
      if (alpha) {
        const alphaVal = parseInt(alpha.getAttribute('val') || '100000') / 100000;
        const { r, g, b } = hexToRgb(color);
        return `rgba(${r}, ${g}, ${b}, ${alphaVal})`;
      }
      return color;
    }
    // Fallback by system color name
    const val = sysClr.getAttribute('val');
    if (val === 'windowText') return '#000000';
    if (val === 'window') return '#FFFFFF';
    return '#000000';
  }

  // Preset color (e.g., "black", "white", "red")
  const prstClr = colorNode.getElementsByTagName('a:prstClr')[0];
  if (prstClr) {
    const PRESET_COLORS: Record<string, string> = {
      black: '#000000', white: '#FFFFFF', red: '#FF0000', green: '#008000',
      blue: '#0000FF', yellow: '#FFFF00', cyan: '#00FFFF', magenta: '#FF00FF',
      gray: '#808080', darkGray: '#A9A9A9', lightGray: '#D3D3D3', darkRed: '#8B0000',
      darkGreen: '#006400', darkBlue: '#00008B', navy: '#000080', orange: '#FFA500',
    };
    const val = prstClr.getAttribute('val') || '';
    let color = PRESET_COLORS[val] || '#000000';
    const alpha = prstClr.getElementsByTagName('a:alpha')[0];
    if (alpha) {
      const alphaVal = parseInt(alpha.getAttribute('val') || '100000') / 100000;
      const { r, g, b } = hexToRgb(color);
      return `rgba(${r}, ${g}, ${b}, ${alphaVal})`;
    }
    return color;
  }

  return undefined;
}

// Resolve a direct color element (a:schemeClr, a:srgbClr, a:sysClr, a:prstClr)
// Unlike parseColor which searches children, this handles the element itself
function resolveDirectColor(el: Element, themeColors?: ThemeColors): string | undefined {
  const tag = el.tagName;
  if (tag === 'a:srgbClr') {
    let color = '#' + (el.getAttribute('val') || '000000');
    const hasMods = el.getElementsByTagName('a:lumMod')[0] || el.getElementsByTagName('a:tint')[0] || el.getElementsByTagName('a:shade')[0];
    if (hasMods) color = applyColorMods(color, el);
    const alpha = el.getElementsByTagName('a:alpha')[0];
    if (alpha) {
      const a = parseInt(alpha.getAttribute('val') || '100000') / 100000;
      const { r, g, b } = hexToRgb(color);
      return `rgba(${r}, ${g}, ${b}, ${a})`;
    }
    return color;
  }
  if (tag === 'a:schemeClr') {
    const val = el.getAttribute('val');
    const colors = themeColors || DEFAULT_SCHEME_COLORS;
    let baseColor = colors[val || ''];
    if (!baseColor) return undefined;
    const hasMods = el.getElementsByTagName('a:lumMod')[0] || el.getElementsByTagName('a:lumOff')[0] || el.getElementsByTagName('a:tint')[0] || el.getElementsByTagName('a:shade')[0];
    if (hasMods) baseColor = applyColorMods(baseColor, el);
    return baseColor;
  }
  if (tag === 'a:sysClr') {
    const lastClr = el.getAttribute('lastClr');
    if (lastClr) return '#' + lastClr;
    const val = el.getAttribute('val');
    return val === 'windowText' ? '#000000' : '#FFFFFF';
  }
  if (tag === 'a:prstClr') {
    const PRESET: Record<string, string> = { black: '#000000', white: '#FFFFFF', red: '#FF0000', green: '#008000', blue: '#0000FF', yellow: '#FFFF00' };
    return PRESET[el.getAttribute('val') || ''] || '#000000';
  }
  // Fallback: try parseColor treating it as a container
  return parseColor(el, themeColors);
}

// ─── Gradient ───

function parseGradientFill(gradFill: Element, themeColors?: ThemeColors): GradientFill | undefined {
  const stops: { position: number; color: string }[] = [];
  const gsLst = gradFill.getElementsByTagName('a:gsLst')[0];

  if (gsLst) {
    const gsElements = gsLst.getElementsByTagName('a:gs');
    for (let i = 0; i < gsElements.length; i++) {
      const gs = gsElements[i];
      const pos = parseInt(gs.getAttribute('pos') || '0') / 1000;
      const color = parseColor(gs, themeColors);
      if (color) {
        stops.push({ position: pos, color });
      }
    }
  }

  if (stops.length === 0) return undefined;

  const lin = gradFill.getElementsByTagName('a:lin')[0];
  if (lin) {
    const ang = parseInt(lin.getAttribute('ang') || '0') / 60000;
    return { type: 'linear', angle: ang, stops };
  }

  const path = gradFill.getElementsByTagName('a:path')[0];
  if (path && path.getAttribute('path') === 'circle') {
    return { type: 'radial', stops };
  }

  return { type: 'linear', angle: 0, stops };
}

function gradientToCSS(gradient: GradientFill): string {
  const colorStops = gradient.stops
    .sort((a, b) => a.position - b.position)
    .map(s => `${s.color} ${s.position}%`)
    .join(', ');

  if (gradient.type === 'radial') {
    return `radial-gradient(circle, ${colorStops})`;
  }

  const angle = gradient.angle || 0;
  return `linear-gradient(${90 - angle}deg, ${colorStops})`;
}

// ─── Preset Shape Geometry ───

type ShapePathFn = (w: number, h: number, adj?: Record<string, number>) => string;

function generateStarPath(w: number, h: number, points: number, innerRatio: number): string {
  const cx = w / 2, cy = h / 2;
  const outerRx = w / 2, outerRy = h / 2;
  const innerRx = outerRx * innerRatio, innerRy = outerRy * innerRatio;
  const parts: string[] = [];
  for (let i = 0; i < points * 2; i++) {
    const angle = (Math.PI * i) / points - Math.PI / 2;
    const rx = i % 2 === 0 ? outerRx : innerRx;
    const ry = i % 2 === 0 ? outerRy : innerRy;
    parts.push(`${i === 0 ? 'M' : 'L'}${cx + rx * Math.cos(angle)},${cy + ry * Math.sin(angle)}`);
  }
  return parts.join(' ') + ' Z';
}

function generateRegularPolygon(w: number, h: number, sides: number): string {
  const cx = w / 2, cy = h / 2;
  const parts: string[] = [];
  for (let i = 0; i < sides; i++) {
    const angle = (2 * Math.PI * i) / sides - Math.PI / 2;
    parts.push(`${i === 0 ? 'M' : 'L'}${cx + (w / 2) * Math.cos(angle)},${cy + (h / 2) * Math.sin(angle)}`);
  }
  return parts.join(' ') + ' Z';
}

const PRESET_SHAPE_PATHS: Record<string, ShapePathFn> = {
  // Basic shapes
  'rect': (w, h) => `M0,0 L${w},0 L${w},${h} L0,${h} Z`,
  'triangle': (w, h) => `M${w / 2},0 L${w},${h} L0,${h} Z`,
  'rtTriangle': (w, h) => `M0,0 L${w},${h} L0,${h} Z`,
  'diamond': (w, h) => `M${w / 2},0 L${w},${h / 2} L${w / 2},${h} L0,${h / 2} Z`,
  'parallelogram': (w, h) => { const d = w * 0.25; return `M${d},0 L${w},0 L${w - d},${h} L0,${h} Z`; },
  'trapezoid': (w, h) => { const d = w * 0.2; return `M${d},0 L${w - d},0 L${w},${h} L0,${h} Z`; },
  'pentagon': (w, h) => generateRegularPolygon(w, h, 5),
  'hexagon': (w, h) => generateRegularPolygon(w, h, 6),
  'heptagon': (w, h) => generateRegularPolygon(w, h, 7),
  'octagon': (w, h) => generateRegularPolygon(w, h, 8),
  'decagon': (w, h) => generateRegularPolygon(w, h, 10),
  'dodecagon': (w, h) => generateRegularPolygon(w, h, 12),
  'ellipse': (w, h) => `M${w / 2},0 A${w / 2},${h / 2} 0 1 1 ${w / 2},${h} A${w / 2},${h / 2} 0 1 1 ${w / 2},0 Z`,
  'roundRect': (w, h, adj) => {
    const r = Math.min(w, h) * (adj?.['adj'] ?? 16667) / 100000;
    return `M${r},0 L${w - r},0 Q${w},0 ${w},${r} L${w},${h - r} Q${w},${h} ${w - r},${h} L${r},${h} Q0,${h} 0,${h - r} L0,${r} Q0,0 ${r},0 Z`;
  },
  'snipRndRect': (w, h) => { const r = Math.min(w, h) * 0.167; const s = Math.min(w, h) * 0.167; return `M${r},0 L${w - s},0 L${w},${s} L${w},${h - r} Q${w},${h} ${w - r},${h} L${r},${h} Q0,${h} 0,${h - r} L0,${r} Q0,0 ${r},0 Z`; },
  'round1Rect': (w, h) => { const r = Math.min(w, h) * 0.167; return `M0,0 L${w - r},0 Q${w},0 ${w},${r} L${w},${h} L0,${h} Z`; },
  'round2SameRect': (w, h) => { const r = Math.min(w, h) * 0.167; return `M${r},0 L${w - r},0 Q${w},0 ${w},${r} L${w},${h} L0,${h} L0,${r} Q0,0 ${r},0 Z`; },
  'round2DiagRect': (w, h) => { const r = Math.min(w, h) * 0.167; return `M${r},0 L${w},0 L${w},${h - r} Q${w},${h} ${w - r},${h} L0,${h} L0,${r} Q0,0 ${r},0 Z`; },
  'plus': (w, h) => { const a = w * 0.3, b = h * 0.3; return `M${a},0 L${w - a},0 L${w - a},${b} L${w},${b} L${w},${h - b} L${w - a},${h - b} L${w - a},${h} L${a},${h} L${a},${h - b} L0,${h - b} L0,${b} L${a},${b} Z`; },
  'cross': (w, h) => { const a = w * 0.3, b = h * 0.3; return `M${a},0 L${w - a},0 L${w - a},${b} L${w},${b} L${w},${h - b} L${w - a},${h - b} L${w - a},${h} L${a},${h} L${a},${h - b} L0,${h - b} L0,${b} L${a},${b} Z`; },
  'frame': (w, h) => { const t = Math.min(w, h) * 0.125; return `M0,0 L${w},0 L${w},${h} L0,${h} Z M${t},${t} L${t},${h - t} L${w - t},${h - t} L${w - t},${t} Z`; },
  'donut': (w, h) => { const rx = w / 2, ry = h / 2, irx = rx * 0.5, iry = ry * 0.5; return `M${rx},0 A${rx},${ry} 0 1 1 ${rx},${h} A${rx},${ry} 0 1 1 ${rx},0 Z M${rx},${ry - iry} A${irx},${iry} 0 1 0 ${rx},${ry + iry} A${irx},${iry} 0 1 0 ${rx},${ry - iry} Z`; },
  'foldedCorner': (w, h) => { const f = Math.min(w, h) * 0.2; return `M0,0 L${w - f},0 L${w},${f} L${w},${h} L0,${h} Z M${w - f},0 L${w - f},${f} L${w},${f}`; },
  'can': (w, h) => { const ry = h * 0.1; return `M0,${ry} A${w / 2},${ry} 0 0 1 ${w},${ry} L${w},${h - ry} A${w / 2},${ry} 0 0 1 0,${h - ry} Z M0,${ry} A${w / 2},${ry} 0 0 0 ${w},${ry}`; },
  'cube': (w, h) => { const d = Math.min(w, h) * 0.25; return `M0,${d} L${w - d},${d} L${w - d},${h} L0,${h} Z M0,${d} L${d},0 L${w},0 L${w - d},${d} Z M${w - d},${d} L${w},0 L${w},${h - d} L${w - d},${h} Z`; },
  'bevel': (w, h) => { const t = Math.min(w, h) * 0.12; return `M0,0 L${w},0 L${w},${h} L0,${h} Z M${t},${t} L${w - t},${t} L${w - t},${h - t} L${t},${h - t} Z`; },
  'plaque': (w, h) => { const r = Math.min(w, h) * 0.167; return `M0,${r} Q${r},0 ${r * 2},0 L${w - r * 2},0 Q${w - r},0 ${w},${r} L${w},${h - r} Q${w - r},${h} ${w - r * 2},${h} L${r * 2},${h} Q${r},${h} 0,${h - r} Z`; },
  'noSmoking': (w, h) => { const rx = w / 2, ry = h / 2; return `M${rx},0 A${rx},${ry} 0 1 1 ${rx},${h} A${rx},${ry} 0 1 1 ${rx},0 Z`; },
  'blockArc': (w, h) => { const rx = w / 2, ry = h / 2, ir = 0.6; return `M${rx},0 A${rx},${ry} 0 1 1 ${rx},${h} A${rx},${ry} 0 1 1 ${rx},0 Z M${rx},${ry * (1 - ir)} A${rx * ir},${ry * ir} 0 1 0 ${rx},${ry * (1 + ir)} A${rx * ir},${ry * ir} 0 1 0 ${rx},${ry * (1 - ir)} Z`; },

  // Stars
  'star4': (w, h) => generateStarPath(w, h, 4, 0.38),
  'star5': (w, h) => generateStarPath(w, h, 5, 0.38),
  'star6': (w, h) => generateStarPath(w, h, 6, 0.45),
  'star8': (w, h) => generateStarPath(w, h, 8, 0.38),
  'star10': (w, h) => generateStarPath(w, h, 10, 0.38),
  'star12': (w, h) => generateStarPath(w, h, 12, 0.38),
  'star16': (w, h) => generateStarPath(w, h, 16, 0.38),
  'star24': (w, h) => generateStarPath(w, h, 24, 0.38),
  'star32': (w, h) => generateStarPath(w, h, 32, 0.38),
  'irregularSeal1': (w, h) => `M${w * 0.15},${h * 0.35} L${w * 0.3},0 L${w * 0.45},${h * 0.25} L${w * 0.7},${h * 0.05} L${w * 0.65},${h * 0.35} L${w},${h * 0.3} L${w * 0.75},${h * 0.55} L${w * 0.9},${h * 0.85} L${w * 0.6},${h * 0.7} L${w * 0.4},${h} L${w * 0.35},${h * 0.65} L0,${h * 0.7} L${w * 0.2},${h * 0.5} Z`,
  'irregularSeal2': (w, h) => `M0,${h * 0.4} L${w * 0.2},${h * 0.1} L${w * 0.35},${h * 0.25} L${w * 0.5},0 L${w * 0.55},${h * 0.3} L${w * 0.8},${h * 0.15} L${w * 0.7},${h * 0.45} L${w},${h * 0.5} L${w * 0.75},${h * 0.65} L${w * 0.85},${h} L${w * 0.55},${h * 0.75} L${w * 0.3},${h * 0.9} L${w * 0.35},${h * 0.6} L0,${h * 0.7} Z`,

  // Flowchart
  'flowChartProcess': (w, h) => `M0,0 L${w},0 L${w},${h} L0,${h} Z`,
  'flowChartAlternateProcess': (w, h) => { const r = Math.min(w, h) * 0.1; return `M${r},0 L${w - r},0 Q${w},0 ${w},${r} L${w},${h - r} Q${w},${h} ${w - r},${h} L${r},${h} Q0,${h} 0,${h - r} L0,${r} Q0,0 ${r},0 Z`; },
  'flowChartDecision': (w, h) => `M${w / 2},0 L${w},${h / 2} L${w / 2},${h} L0,${h / 2} Z`,
  'flowChartInputOutput': (w, h) => { const d = w * 0.2; return `M${d},0 L${w},0 L${w - d},${h} L0,${h} Z`; },
  'flowChartPredefinedProcess': (w, h) => { const d = w * 0.12; return `M0,0 L${w},0 L${w},${h} L0,${h} Z M${d},0 L${d},${h} M${w - d},0 L${w - d},${h}`; },
  'flowChartTerminator': (w, h) => { const r = h / 2; return `M${r},0 L${w - r},0 A${r},${r} 0 0 1 ${w - r},${h} L${r},${h} A${r},${r} 0 0 1 ${r},0 Z`; },
  'flowChartPreparation': (w, h) => { const d = w * 0.17; return `M${d},0 L${w - d},0 L${w},${h / 2} L${w - d},${h} L${d},${h} L0,${h / 2} Z`; },
  'flowChartManualInput': (w, h) => { const d = h * 0.2; return `M0,${d} L${w},0 L${w},${h} L0,${h} Z`; },
  'flowChartManualOperation': (w, h) => { const d = w * 0.15; return `M0,0 L${w},0 L${w - d},${h} L${d},${h} Z`; },
  'flowChartConnector': (w, h) => `M${w / 2},0 A${w / 2},${h / 2} 0 1 1 ${w / 2},${h} A${w / 2},${h / 2} 0 1 1 ${w / 2},0 Z`,
  'flowChartOffpageConnector': (w, h) => { const d = h * 0.2; return `M0,0 L${w},0 L${w},${h - d} L${w / 2},${h} L0,${h - d} Z`; },
  'flowChartDocument': (w, h) => { const cy = h * 0.85; return `M0,0 L${w},0 L${w},${cy} C${w * 0.75},${h * 1.05} ${w * 0.25},${h * 0.7} 0,${cy} Z`; },
  'flowChartMultidocument': (w, h) => { const d = w * 0.08, dy = h * 0.08; return `M${d * 2},${dy * 2} L${w},${dy * 2} L${w},${h * 0.85} C${w * 0.75},${h * 1.05} ${w * 0.3},${h * 0.7} ${d * 2},${h * 0.85} Z M${d},${dy} L${w - d},${dy} M0,0 L${w - d * 2},0`; },
  'flowChartInternalStorage': (w, h) => { const d = Math.min(w, h) * 0.15; return `M0,0 L${w},0 L${w},${h} L0,${h} Z M${d},0 L${d},${h} M0,${d} L${w},${d}`; },
  'flowChartDelay': (w, h) => `M0,0 L${w * 0.6},0 A${w * 0.4},${h / 2} 0 0 1 ${w * 0.6},${h} L0,${h} Z`,
  'flowChartDisplay': (w, h) => { const d = w * 0.17; return `M${d},0 L${w * 0.7},0 A${w * 0.3},${h / 2} 0 0 1 ${w * 0.7},${h} L${d},${h} L0,${h / 2} Z`; },
  'flowChartSort': (w, h) => `M${w / 2},0 L${w},${h / 2} L${w / 2},${h} L0,${h / 2} Z M0,${h / 2} L${w},${h / 2}`,
  'flowChartExtract': (w, h) => `M${w / 2},0 L${w},${h} L0,${h} Z`,
  'flowChartMerge': (w, h) => `M0,0 L${w},0 L${w / 2},${h} Z`,

  // Callouts
  'wedgeRectCallout': (w, h) => { const tx = w * 0.5, ty = h + h * 0.15; return `M0,0 L${w},0 L${w},${h} L${w * 0.55},${h} L${tx},${ty} L${w * 0.45},${h} L0,${h} Z`; },
  'wedgeRoundRectCallout': (w, h) => { const r = Math.min(w, h) * 0.1, tx = w * 0.5, ty = h + h * 0.15; return `M${r},0 L${w - r},0 Q${w},0 ${w},${r} L${w},${h - r} Q${w},${h} ${w - r},${h} L${w * 0.55},${h} L${tx},${ty} L${w * 0.45},${h} L${r},${h} Q0,${h} 0,${h - r} L0,${r} Q0,0 ${r},0 Z`; },
  'wedgeEllipseCallout': (w, h) => { const rx = w / 2, ry = h / 2; return `M${rx},0 A${rx},${ry} 0 1 1 ${rx},${h} A${rx},${ry} 0 1 1 ${rx},0 Z M${rx},${h} L${rx - w * 0.05},${h + h * 0.15} L${rx + w * 0.05},${h}`; },
  'cloudCallout': (w, h) => `M${w * 0.2},${h * 0.55} A${w * 0.2},${h * 0.2} 0 1 1 ${w * 0.35},${h * 0.3} A${w * 0.2},${h * 0.2} 0 1 1 ${w * 0.6},${h * 0.2} A${w * 0.22},${h * 0.2} 0 1 1 ${w * 0.8},${h * 0.35} A${w * 0.15},${h * 0.18} 0 1 1 ${w * 0.85},${h * 0.6} A${w * 0.18},${h * 0.2} 0 1 1 ${w * 0.7},${h * 0.8} A${w * 0.2},${h * 0.15} 0 1 1 ${w * 0.4},${h * 0.85} A${w * 0.2},${h * 0.2} 0 1 1 ${w * 0.2},${h * 0.55} Z`,

  // Misc
  'heart': (w, h) => `M${w / 2},${h * 0.3} C${w / 2},${h * 0.1} ${w * 0.25},0 0,${h * 0.1} C0,${h * 0.4} ${w / 2},${h * 0.7} ${w / 2},${h} C${w / 2},${h * 0.7} ${w},${h * 0.4} ${w},${h * 0.1} C${w * 0.75},0 ${w / 2},${h * 0.1} ${w / 2},${h * 0.3} Z`,
  'lightningBolt': (w, h) => `M${w * 0.4},0 L${w * 0.55},${h * 0.35} L${w},${h * 0.3} L${w * 0.4},${h * 0.65} L${w * 0.65},${h * 0.6} L0,${h} L${w * 0.35},${h * 0.45} L0,${h * 0.5} Z`,
  'moon': (w, h) => `M${w},0 A${w * 0.6},${h / 2} 0 1 1 ${w},${h} A${w * 0.35},${h / 2} 0 1 0 ${w},0 Z`,
  'cloud': (w, h) => `M${w * 0.2},${h * 0.55} A${w * 0.2},${h * 0.2} 0 1 1 ${w * 0.35},${h * 0.3} A${w * 0.2},${h * 0.2} 0 1 1 ${w * 0.6},${h * 0.2} A${w * 0.22},${h * 0.2} 0 1 1 ${w * 0.8},${h * 0.35} A${w * 0.15},${h * 0.18} 0 1 1 ${w * 0.85},${h * 0.6} A${w * 0.18},${h * 0.2} 0 1 1 ${w * 0.7},${h * 0.8} A${w * 0.2},${h * 0.15} 0 1 1 ${w * 0.4},${h * 0.85} A${w * 0.2},${h * 0.2} 0 1 1 ${w * 0.2},${h * 0.55} Z`,
  'sun': (w, h) => { const cx = w / 2, cy = h / 2, r = Math.min(w, h) * 0.3; let p = `M${cx},${cy - r} A${r},${r} 0 1 1 ${cx},${cy + r} A${r},${r} 0 1 1 ${cx},${cy - r} Z`; for (let i = 0; i < 8; i++) { const a = (Math.PI * i) / 4; const x1 = cx + r * 1.1 * Math.cos(a), y1 = cy + r * 1.1 * Math.sin(a); const x2 = cx + r * 1.6 * Math.cos(a), y2 = cy + r * 1.6 * Math.sin(a); p += ` M${x1},${y1} L${x2},${y2}`; } return p; },
  'smileyFace': (w, h) => `M${w / 2},0 A${w / 2},${h / 2} 0 1 1 ${w / 2},${h} A${w / 2},${h / 2} 0 1 1 ${w / 2},0 Z`,
  'bracketPair': (w, h) => { const r = Math.min(w, h) * 0.2; return `M${r},0 Q0,0 0,${r} L0,${h - r} Q0,${h} ${r},${h} M${w - r},0 Q${w},0 ${w},${r} L${w},${h - r} Q${w},${h} ${w - r},${h}`; },
  'bracePair': (w, h) => { const r = Math.min(w, h) * 0.12; return `M${r},0 Q0,0 0,${r} L0,${h / 2 - r} Q0,${h / 2} ${-r * 0.3},${h / 2} Q0,${h / 2} 0,${h / 2 + r} L0,${h - r} Q0,${h} ${r},${h} M${w - r},0 Q${w},0 ${w},${r} L${w},${h / 2 - r} Q${w},${h / 2} ${w + r * 0.3},${h / 2} Q${w},${h / 2} ${w},${h / 2 + r} L${w},${h - r} Q${w},${h} ${w - r},${h}`; },
  'leftBracket': (w, h) => { const r = Math.min(w, h) * 0.2; return `M${w},0 L${r},0 Q0,0 0,${r} L0,${h - r} Q0,${h} ${r},${h} L${w},${h}`; },
  'rightBracket': (w, h) => { const r = Math.min(w, h) * 0.2; return `M0,0 L${w - r},0 Q${w},0 ${w},${r} L${w},${h - r} Q${w},${h} ${w - r},${h} L0,${h}`; },

  // Arrow shapes
  'rightArrow': (w, h) => { const aw = w * 0.6, ah = h * 0.3; return `M0,${ah} L${aw},${ah} L${aw},0 L${w},${h / 2} L${aw},${h} L${aw},${h - ah} L0,${h - ah} Z`; },
  'leftArrow': (w, h) => { const aw = w * 0.6, ah = h * 0.3; return `M${w},${ah} L${w - aw},${ah} L${w - aw},0 L0,${h / 2} L${w - aw},${h} L${w - aw},${h - ah} L${w},${h - ah} Z`; },
  'upArrow': (w, h) => { const aw = w * 0.3, ah = h * 0.6; return `M${aw},${h} L${aw},${ah} L0,${ah} L${w / 2},0 L${w},${ah} L${w - aw},${ah} L${w - aw},${h} Z`; },
  'downArrow': (w, h) => { const aw = w * 0.3, ah = h * 0.4; return `M${aw},0 L${aw},${ah} L0,${ah} L${w / 2},${h} L${w},${ah} L${w - aw},${ah} L${w - aw},0 Z`; },
  'leftRightArrow': (w, h) => { const hw = w * 0.2, hh = h * 0.3; return `M0,${h / 2} L${hw},0 L${hw},${hh} L${w - hw},${hh} L${w - hw},0 L${w},${h / 2} L${w - hw},${h} L${w - hw},${h - hh} L${hw},${h - hh} L${hw},${h} Z`; },
  'upDownArrow': (w, h) => { const aw = w * 0.3, ah = h * 0.2; return `M${w / 2},0 L${w},${ah} L${w - aw},${ah} L${w - aw},${h - ah} L${w},${h - ah} L${w / 2},${h} L0,${h - ah} L${aw},${h - ah} L${aw},${ah} L0,${ah} Z`; },
  'chevron': (w, h) => { const d = w * 0.2; return `M0,0 L${w - d},0 L${w},${h / 2} L${w - d},${h} L0,${h} L${d},${h / 2} Z`; },
  'homePlate': (w, h) => { const d = w * 0.2; return `M0,0 L${w - d},0 L${w},${h / 2} L${w - d},${h} L0,${h} Z`; },
  'notchedRightArrow': (w, h) => { const aw = w * 0.6, ah = h * 0.3; return `M0,${ah} L${aw},${ah} L${aw},0 L${w},${h / 2} L${aw},${h} L${aw},${h - ah} L0,${h - ah} L${w * 0.15},${h / 2} Z`; },
  'stripedRightArrow': (w, h) => { const aw = w * 0.6, ah = h * 0.3; return `M0,${ah} L${aw},${ah} L${aw},0 L${w},${h / 2} L${aw},${h} L${aw},${h - ah} L0,${h - ah} Z`; },
  'bentUpArrow': (w, h) => { const aw = w * 0.3, ah = h * 0.3; return `M${w / 2},0 L${w},${ah} L${w - aw},${ah} L${w - aw},${h - ah} L${aw},${h - ah} L${aw},${h} L0,${h} L0,${h - ah} L${w / 2 - aw / 2},${h - ah} L${w / 2 - aw / 2},${ah} L${w / 2 - aw},${ah} Z`; },

  // Math
  'mathPlus': (w, h) => { const a = w * 0.3, b = h * 0.3; return `M${a},0 L${w - a},0 L${w - a},${b} L${w},${b} L${w},${h - b} L${w - a},${h - b} L${w - a},${h} L${a},${h} L${a},${h - b} L0,${h - b} L0,${b} L${a},${b} Z`; },
  'mathMinus': (w, h) => { const b = h * 0.35; return `M0,${b} L${w},${b} L${w},${h - b} L0,${h - b} Z`; },
  'mathMultiply': (w, h) => { const d = Math.min(w, h) * 0.15; return `M${d},0 L${w / 2},${h / 2 - d} L${w - d},0 L${w},${d} L${w / 2 + d},${h / 2} L${w},${h - d} L${w - d},${h} L${w / 2},${h / 2 + d} L${d},${h} L0,${h - d} L${w / 2 - d},${h / 2} L0,${d} Z`; },
  'mathDivide': (w, h) => { const b = h * 0.35, r = Math.min(w, h) * 0.1; return `M0,${b} L${w},${b} L${w},${h - b} L0,${h - b} Z M${w / 2},${b - r * 2} A${r},${r} 0 1 1 ${w / 2},${b - r * 2 + 0.01} Z M${w / 2},${h - b + r * 2} A${r},${r} 0 1 1 ${w / 2},${h - b + r * 2 + 0.01} Z`; },
  'mathEqual': (w, h) => { const g = h * 0.15, t = h * 0.15; return `M0,${g} L${w},${g} L${w},${g + t} L0,${g + t} Z M0,${h - g - t} L${w},${h - g - t} L${w},${h - g} L0,${h - g} Z`; },

  // Action buttons (just rectangles with icon inside — render as rect)
  'actionButtonBlank': (w, h) => `M0,0 L${w},0 L${w},${h} L0,${h} Z`,
};

// ─── Custom Geometry Parser ───

function parseCustomGeometry(pathLst: Element, shapeW: number, shapeH: number): string {
  const paths = pathLst.getElementsByTagName('a:path');
  const allParts: string[] = [];

  for (let pi = 0; pi < paths.length; pi++) {
    const pathEl = paths[pi];
    const pathW = parseInt(pathEl.getAttribute('w') || '0') || shapeW * EMU_PER_PIXEL;
    const pathH = parseInt(pathEl.getAttribute('h') || '0') || shapeH * EMU_PER_PIXEL;
    const scaleX = shapeW / (pathW / EMU_PER_PIXEL || shapeW);
    const scaleY = shapeH / (pathH / EMU_PER_PIXEL || shapeH);

    for (let ci = 0; ci < pathEl.children.length; ci++) {
      const cmd = pathEl.children[ci];
      const tag = cmd.tagName;
      if (tag === 'a:moveTo') {
        const pt = cmd.getElementsByTagName('a:pt')[0];
        if (pt) allParts.push(`M${parseInt(pt.getAttribute('x') || '0') / EMU_PER_PIXEL * scaleX},${parseInt(pt.getAttribute('y') || '0') / EMU_PER_PIXEL * scaleY}`);
      } else if (tag === 'a:lnTo') {
        const pt = cmd.getElementsByTagName('a:pt')[0];
        if (pt) allParts.push(`L${parseInt(pt.getAttribute('x') || '0') / EMU_PER_PIXEL * scaleX},${parseInt(pt.getAttribute('y') || '0') / EMU_PER_PIXEL * scaleY}`);
      } else if (tag === 'a:cubicBezTo') {
        const pts = cmd.getElementsByTagName('a:pt');
        if (pts.length >= 3) {
          const p = Array.from(pts).map(pt => ({ x: parseInt(pt.getAttribute('x') || '0') / EMU_PER_PIXEL * scaleX, y: parseInt(pt.getAttribute('y') || '0') / EMU_PER_PIXEL * scaleY }));
          allParts.push(`C${p[0].x},${p[0].y} ${p[1].x},${p[1].y} ${p[2].x},${p[2].y}`);
        }
      } else if (tag === 'a:arcTo') {
        // Arc: wR, hR = radii in EMU, stAng, swAng in 60000ths of a degree
        const wR = parseInt(cmd.getAttribute('wR') || '0') / EMU_PER_PIXEL * scaleX;
        const hR = parseInt(cmd.getAttribute('hR') || '0') / EMU_PER_PIXEL * scaleY;
        const stAng = parseInt(cmd.getAttribute('stAng') || '0') / 60000;
        const swAng = parseInt(cmd.getAttribute('swAng') || '0') / 60000;
        if (wR > 0 && hR > 0) {
          const largeArc = Math.abs(swAng) > 180 ? 1 : 0;
          const sweep = swAng > 0 ? 1 : 0;
          const endAng = (stAng + swAng) * Math.PI / 180;
          // Calculate endpoint relative to arc center
          // Since we don't track current point, approximate with relative arc
          const ex = wR * Math.cos(endAng);
          const ey = hR * Math.sin(endAng);
          const sx = wR * Math.cos(stAng * Math.PI / 180);
          const sy = hR * Math.sin(stAng * Math.PI / 180);
          const dx = ex - sx;
          const dy = ey - sy;
          allParts.push(`a${wR},${hR} 0 ${largeArc} ${sweep} ${dx},${dy}`);
        }
      } else if (tag === 'a:close') {
        allParts.push('Z');
      }
    }
  }

  return allParts.join(' ');
}

// ─── Connector Path Builder ───

function buildConnectorPath(w: number, h: number, connType: string, adj: Record<string, number>, pad: number): string {
  const x1 = pad, y1 = pad, x2 = pad + w, y2 = pad + h;

  if (connType === 'straightConnector1' || !connType) {
    return `M${x1},${y1} L${x2},${y2}`;
  }

  if (connType === 'bentConnector2') {
    return `M${x1},${y1} L${x2},${y1} L${x2},${y2}`;
  }
  if (connType === 'bentConnector3') {
    const a = adj['adj1'] ?? 0.5;
    const midX = x1 + (x2 - x1) * a;
    return `M${x1},${y1} L${midX},${y1} L${midX},${y2} L${x2},${y2}`;
  }
  if (connType === 'bentConnector4') {
    const a1 = adj['adj1'] ?? 0.5;
    const a2 = adj['adj2'] ?? 0.5;
    const midX = x1 + (x2 - x1) * a1;
    const midY = y1 + (y2 - y1) * a2;
    return `M${x1},${y1} L${midX},${y1} L${midX},${midY} L${x2},${midY} L${x2},${y2}`;
  }
  if (connType === 'bentConnector5') {
    const a1 = adj['adj1'] ?? 0.33, a2 = adj['adj2'] ?? 0.5, a3 = adj['adj3'] ?? 0.67;
    const mx1 = x1 + (x2 - x1) * a1, my = y1 + (y2 - y1) * a2, mx2 = x1 + (x2 - x1) * a3;
    return `M${x1},${y1} L${mx1},${y1} L${mx1},${my} L${mx2},${my} L${mx2},${y2} L${x2},${y2}`;
  }

  if (connType === 'curvedConnector2') {
    return `M${x1},${y1} Q${x2},${y1} ${x2},${y2}`;
  }
  if (connType === 'curvedConnector3') {
    const a = adj['adj1'] ?? 0.5;
    const midX = x1 + (x2 - x1) * a;
    return `M${x1},${y1} C${midX},${y1} ${midX},${y2} ${x2},${y2}`;
  }
  if (connType === 'curvedConnector4' || connType === 'curvedConnector5') {
    const a1 = adj['adj1'] ?? 0.5, a2 = adj['adj2'] ?? 0.5;
    const mx = x1 + (x2 - x1) * a1, my = y1 + (y2 - y1) * a2;
    return `M${x1},${y1} C${mx},${y1} ${mx},${my} ${mx},${my} S${x2},${y2} ${x2},${y2}`;
  }

  return `M${x1},${y1} L${x2},${y2}`;
}

// ─── Table Style Parser ───

interface TableStyleBorder {
  width: number;
  color: string;
}

interface TableStyleBand {
  fillColor?: string;
  fontColor?: string;
  fontBold?: boolean;
  borders?: {
    left?: TableStyleBorder | null;   // null = noFill (no border)
    right?: TableStyleBorder | null;
    top?: TableStyleBorder | null;
    bottom?: TableStyleBorder | null;
    insideH?: TableStyleBorder | null;
    insideV?: TableStyleBorder | null;
  };
}

interface TableStyleDef {
  wholeTbl?: TableStyleBand;
  band1H?: TableStyleBand;
  band2H?: TableStyleBand;
  firstRow?: TableStyleBand;
  lastRow?: TableStyleBand;
  firstCol?: TableStyleBand;
  lastCol?: TableStyleBand;
}

function parseTableStylesXml(xmlString: string, themeColors?: ThemeColors): Map<string, TableStyleDef> {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlString, 'application/xml');
  const styles = new Map<string, TableStyleDef>();

  const tblStyleElements = doc.getElementsByTagName('a:tblStyle');
  for (let i = 0; i < tblStyleElements.length; i++) {
    const tblStyle = tblStyleElements[i];
    const styleId = tblStyle.getAttribute('styleId') || '';
    const def: TableStyleDef = {};

    const bandNames = ['wholeTbl', 'band1H', 'band2H', 'firstRow', 'lastRow', 'firstCol', 'lastCol'] as const;
    for (const bandName of bandNames) {
      const bandEl = tblStyle.getElementsByTagName(`a:${bandName}`)[0];
      if (bandEl) {
        const band: TableStyleBand = {};
        const tcStyle = bandEl.getElementsByTagName('a:tcStyle')[0];
        if (tcStyle) {
          const fill = tcStyle.getElementsByTagName('a:fill')[0];
          if (fill) {
            const solidFill = fill.getElementsByTagName('a:solidFill')[0];
            if (solidFill) {
              band.fillColor = parseColor(solidFill, themeColors);
            } else {
              // fillRef — references theme fill by index
              const fillRef = fill.getElementsByTagName('a:fillRef')[0];
              if (fillRef) {
                const refColor = parseColor(fillRef, themeColors);
                if (refColor) band.fillColor = refColor;
              }
            }
          }
          // Also check tcStyle > fillRef (without a:fill wrapper)
          if (!band.fillColor) {
            const fillRef = tcStyle.getElementsByTagName('a:fillRef')[0];
            if (fillRef) {
              const refColor = parseColor(fillRef, themeColors);
              if (refColor) band.fillColor = refColor;
            }
          }
          // Parse tcBdr (border definitions)
          const tcBdr = tcStyle.getElementsByTagName('a:tcBdr')[0];
          if (tcBdr) {
            const parseBorderSide = (sideTag: string): TableStyleBorder | null | undefined => {
              const sideEl = tcBdr.getElementsByTagName(`a:${sideTag}`)[0];
              if (!sideEl) return undefined;
              const ln = sideEl.getElementsByTagName('a:ln')[0];
              if (!ln) return undefined;
              const noFill = ln.getElementsByTagName('a:noFill')[0];
              if (noFill) return null; // explicitly no border
              const solidFill = ln.getElementsByTagName('a:solidFill')[0];
              if (solidFill) {
                const color = parseColor(solidFill, themeColors) || '#000000';
                const width = parseInt(ln.getAttribute('w') || '12700') / EMU_PER_PIXEL;
                return { width, color };
              }
              return undefined;
            };
            band.borders = {
              left: parseBorderSide('left'),
              right: parseBorderSide('right'),
              top: parseBorderSide('top'),
              bottom: parseBorderSide('bottom'),
              insideH: parseBorderSide('insideH'),
              insideV: parseBorderSide('insideV'),
            };
          }
        }
        const tcTxStyle = bandEl.getElementsByTagName('a:tcTxStyle')[0];
        if (tcTxStyle) {
          if (tcTxStyle.getAttribute('b') === 'on') band.fontBold = true;
          band.fontColor = parseColor(tcTxStyle, themeColors);
        }
        def[bandName] = band;
      }
    }

    if (Object.keys(def).length > 0) styles.set(styleId, def);
  }

  return styles;
}

function getDefaultTableStyle(themeColors?: ThemeColors): TableStyleDef {
  const accent1 = themeColors?.accent1 || '#4472C4';
  const { r, g, b } = hexToRgb(accent1);
  const tint40 = rgbToHex(r + (255 - r) * 0.6, g + (255 - g) * 0.6, b + (255 - b) * 0.6);
  const tint20 = rgbToHex(r + (255 - r) * 0.8, g + (255 - g) * 0.8, b + (255 - b) * 0.8);
  return {
    firstRow: { fillColor: accent1, fontColor: '#FFFFFF', fontBold: true },
    band1H: { fillColor: tint20 },
    band2H: { fillColor: tint40 },
    wholeTbl: { fillColor: '#FFFFFF' },
  };
}

// ─── Text Parsing ───

function parseRunProperties(rPr: Element | null, themeColors?: ThemeColors, themeFonts?: ThemeFonts): Partial<TextRun> {
  if (!rPr) return {};

  const props: Partial<TextRun> = {};

  const bold = rPr.getAttribute('b');
  if (bold === '1' || bold === 'true') props.bold = true;

  const italic = rPr.getAttribute('i');
  if (italic === '1' || italic === 'true') props.italic = true;

  const underline = rPr.getAttribute('u');
  if (underline && underline !== 'none') props.underline = true;

  const strike = rPr.getAttribute('strike');
  if (strike && strike !== 'noStrike') props.strikethrough = true;

  const sz = rPr.getAttribute('sz');
  if (sz) props.fontSize = parseInt(sz) / 100;

  // Character spacing (hundredths of a point)
  const spc = rPr.getAttribute('spc');
  if (spc) {
    const spcVal = parseInt(spc);
    if (!isNaN(spcVal)) props.letterSpacing = spcVal / 100;
  }

  // Font resolution (resolve theme references like +mj-lt)
  const resolveFont = (tf: string | null): string | undefined => {
    if (!tf) return undefined;
    if (themeFonts) {
      if (tf === '+mj-lt') return themeFonts.majorLatin;
      if (tf === '+mn-lt') return themeFonts.minorLatin;
      if (tf === '+mj-ea') return themeFonts.majorEA || undefined;
      if (tf === '+mn-ea') return themeFonts.minorEA || undefined;
    }
    if (tf.startsWith('+')) return undefined; // unresolved theme ref
    return tf;
  };

  const latin = rPr.getElementsByTagName('a:latin')[0];
  const ea = rPr.getElementsByTagName('a:ea')[0];
  if (latin) {
    const resolved = resolveFont(latin.getAttribute('typeface'));
    if (resolved) props.fontFamily = resolved;
  }
  if (!props.fontFamily && ea) {
    const resolved = resolveFont(ea.getAttribute('typeface'));
    if (resolved) props.fontFamily = resolved;
  }

  // Text fill: use direct children to avoid picking up a:ln's nested solidFill
  let solidFill: Element | null = null;
  let gradFillRun: Element | null = null;
  for (let ci = 0; ci < rPr.childNodes.length; ci++) {
    const cn = rPr.childNodes[ci];
    if (cn.nodeType === 1) {
      const tag = (cn as Element).tagName;
      if (tag === 'a:solidFill') solidFill = cn as Element;
      else if (tag === 'a:gradFill') gradFillRun = cn as Element;
    }
  }
  if (solidFill) {
    props.color = parseColor(solidFill, themeColors);
  } else if (gradFillRun) {
    // Gradient text fill — use first stop color as approximation
    const gsLst = gradFillRun.getElementsByTagName('a:gsLst')[0];
    if (gsLst) {
      const gs = gsLst.getElementsByTagName('a:gs')[0];
      if (gs) props.color = parseColor(gs, themeColors);
    }
  }

  return props;
}

// Parse spacing value (spcPct or spcPts)
function parseSpacing(spacingEl: Element | null): { pct?: number; pts?: number } | undefined {
  if (!spacingEl) return undefined;
  const spcPct = spacingEl.getElementsByTagName('a:spcPct')[0];
  if (spcPct) {
    const val = parseInt(spcPct.getAttribute('val') || '0');
    return { pct: val / 1000 }; // thousandths of percent → percent
  }
  const spcPts = spacingEl.getElementsByTagName('a:spcPts')[0];
  if (spcPts) {
    const val = parseInt(spcPts.getAttribute('val') || '0');
    return { pts: val / 100 }; // hundredths of point → point
  }
  return undefined;
}

function parseParagraphAlign(pPr: Element | null): Paragraph['align'] {
  if (!pPr) return undefined;
  const algn = pPr.getAttribute('algn');
  switch (algn) {
    case 'l': return 'left';
    case 'ctr': return 'center';
    case 'r': return 'right';
    case 'just': return 'justify';
    default: return undefined;
  }
}

function parseBullet(pPr: Element | null): { bulletChar?: string; level?: number } {
  if (!pPr) return {};

  const level = parseInt(pPr.getAttribute('lvl') || '0');
  const buChar = pPr.getElementsByTagName('a:buChar')[0];
  const buAutoNum = pPr.getElementsByTagName('a:buAutoNum')[0];
  const buNone = pPr.getElementsByTagName('a:buNone')[0];

  if (buNone) return { level };
  if (buChar) return { bulletChar: buChar.getAttribute('char') || '•', level };
  if (buAutoNum) return { bulletChar: '1.', level };

  return { level };
}

// Parse full paragraph properties including spacing
function parseParagraphProperties(pPr: Element | null): Partial<Paragraph> {
  if (!pPr) return {};

  const result: Partial<Paragraph> = {};

  result.align = parseParagraphAlign(pPr);
  const bullet = parseBullet(pPr);
  result.bulletChar = bullet.bulletChar;
  result.level = bullet.level;

  // Line spacing
  const lnSpc = pPr.getElementsByTagName('a:lnSpc')[0];
  const lineSpacing = parseSpacing(lnSpc);
  if (lineSpacing) {
    if (lineSpacing.pct !== undefined) {
      result.lineHeight = lineSpacing.pct; // percentage
    } else if (lineSpacing.pts !== undefined) {
      result.lineHeightPt = lineSpacing.pts;
    }
  }

  // Space before/after
  const spcBef = pPr.getElementsByTagName('a:spcBef')[0];
  const spcBefVal = parseSpacing(spcBef);
  if (spcBefVal?.pts !== undefined) {
    result.spaceBefore = spcBefVal.pts * 1.333; // pt → px approx
  } else if (spcBefVal?.pct !== undefined) {
    result.spaceBefore = spcBefVal.pct * 0.2; // rough conversion
  }

  const spcAft = pPr.getElementsByTagName('a:spcAft')[0];
  const spcAftVal = parseSpacing(spcAft);
  if (spcAftVal?.pts !== undefined) {
    result.spaceAfter = spcAftVal.pts * 1.333;
  } else if (spcAftVal?.pct !== undefined) {
    result.spaceAfter = spcAftVal.pct * 0.2;
  }

  // Paragraph margins
  const marL = pPr.getAttribute('marL');
  if (marL) {
    result.marginLeft = parseInt(marL) / EMU_PER_PIXEL;
  }

  // First line indent
  const indent = pPr.getAttribute('indent');
  if (indent) {
    result.indent = parseInt(indent) / EMU_PER_PIXEL;
  }

  return result;
}

// Parse a text body (txBody) element
function parseTextBody(txBody: Element, themeColors?: ThemeColors, themeFonts?: ThemeFonts): Paragraph[] {
  const paragraphs: Paragraph[] = [];
  const pElements = txBody.getElementsByTagName('a:p');

  for (let i = 0; i < pElements.length; i++) {
    const p = pElements[i];
    if (p.parentElement?.tagName !== 'p:txBody' && p.parentElement?.tagName !== 'a:txBody') {
      continue;
    }

    const runs: TextRun[] = [];
    const pPr = p.getElementsByTagName('a:pPr')[0];
    const paraProps = parseParagraphProperties(pPr);

    // Default paragraph run properties
    const defRPr = pPr?.getElementsByTagName('a:defRPr')[0];
    const defaultProps = parseRunProperties(defRPr, themeColors, themeFonts);

    // Parse child elements in document order (a:r, a:br, a:fld)
    for (let j = 0; j < p.childNodes.length; j++) {
      const child = p.childNodes[j];
      if (child.nodeType !== 1) continue;
      const el = child as Element;
      const tag = el.tagName;

      if (tag === 'a:r') {
        const rPr = el.getElementsByTagName('a:rPr')[0];
        const t = el.getElementsByTagName('a:t')[0];
        if (t && t.textContent) {
          const runProps = parseRunProperties(rPr, themeColors, themeFonts);
          runs.push({
            text: t.textContent,
            ...defaultProps,
            ...runProps,
          });
        }
      } else if (tag === 'a:br') {
        // Explicit line break (Shift+Enter in PowerPoint)
        runs.push({ text: '\n', ...defaultProps });
      } else if (tag === 'a:fld') {
        const t = el.getElementsByTagName('a:t')[0];
        if (t && t.textContent) {
          runs.push({ text: t.textContent, ...defaultProps });
        }
      }
    }

    // Include empty paragraphs for spacing (line breaks)
    paragraphs.push({
      runs: runs.length > 0 ? runs : [{ text: '' }],
      ...paraProps,
    });
  }

  return paragraphs;
}

// Parse a:bodyPr for text box properties
function parseTextBodyProps(txBody: Element): TextBodyProps {
  const bodyPr = txBody.getElementsByTagName('a:bodyPr')[0];

  const defaults: TextBodyProps = {
    wrap: 'square',
    paddingLeft: 91440 / EMU_PER_PIXEL,   // ~9.6px
    paddingRight: 91440 / EMU_PER_PIXEL,
    paddingTop: 45720 / EMU_PER_PIXEL,     // ~4.8px
    paddingBottom: 45720 / EMU_PER_PIXEL,
    verticalAlign: 'top',
  };

  if (!bodyPr) return defaults;

  const wrap = bodyPr.getAttribute('wrap');
  if (wrap === 'none') defaults.wrap = 'none';

  const lIns = bodyPr.getAttribute('lIns');
  if (lIns !== null) defaults.paddingLeft = parseInt(lIns) / EMU_PER_PIXEL;
  const rIns = bodyPr.getAttribute('rIns');
  if (rIns !== null) defaults.paddingRight = parseInt(rIns) / EMU_PER_PIXEL;
  const tIns = bodyPr.getAttribute('tIns');
  if (tIns !== null) defaults.paddingTop = parseInt(tIns) / EMU_PER_PIXEL;
  const bIns = bodyPr.getAttribute('bIns');
  if (bIns !== null) defaults.paddingBottom = parseInt(bIns) / EMU_PER_PIXEL;

  const anchor = bodyPr.getAttribute('anchor');
  if (anchor === 'ctr') defaults.verticalAlign = 'middle';
  else if (anchor === 'b') defaults.verticalAlign = 'bottom';
  else defaults.verticalAlign = 'top';

  const vert = bodyPr.getAttribute('vert');
  if (vert === 'eaVert' || vert === 'vert' || vert === 'vert270') {
    defaults.verticalText = true;
  }

  // Auto-fit
  const normAutofit = bodyPr.getElementsByTagName('a:normAutofit')[0];
  if (normAutofit) {
    defaults.autoFit = true;
    const fontScale = normAutofit.getAttribute('fontScale');
    if (fontScale) defaults.fontScale = parseInt(fontScale) / 100000;
    const lnSpcReduction = normAutofit.getAttribute('lnSpcReduction');
    if (lnSpcReduction) defaults.lnSpcReduction = parseInt(lnSpcReduction) / 100000;
  }

  return defaults;
}

// ─── Border & Table Parsing ───

function parseBorderLine(lineEl: Element | undefined, themeColors?: ThemeColors): CellBorder | undefined {
  if (!lineEl) return undefined;
  const w = parseInt(lineEl.getAttribute('w') || '0') / EMU_PER_PIXEL;
  if (w <= 0) return undefined;
  const fill = lineEl.getElementsByTagName('a:solidFill')[0];
  const color = fill ? (parseColor(fill, themeColors) || '#000000') : '#000000';
  return { color, width: Math.max(w, 0.5) };
}

function parseTable(graphicData: Element, themeColors?: ThemeColors, themeFonts?: ThemeFonts): TableElement | null {
  const tbl = graphicData.getElementsByTagName('a:tbl')[0];
  if (!tbl) return null;

  // Parse a:tblPr (table properties)
  const tblPr = tbl.getElementsByTagName('a:tblPr')[0];
  const tblProps: TableProps = {};
  if (tblPr) {
    tblProps.firstRow = tblPr.getAttribute('firstRow') === '1';
    tblProps.lastRow = tblPr.getAttribute('lastRow') === '1';
    tblProps.bandRow = tblPr.getAttribute('bandRow') === '1';
    tblProps.bandCol = tblPr.getAttribute('bandCol') === '1';
    tblProps.firstCol = tblPr.getAttribute('firstCol') === '1';
    tblProps.lastCol = tblPr.getAttribute('lastCol') === '1';
    // tblStyle can be attribute OR child <a:tableStyleId> element
    tblProps.tblStyleId = tblPr.getAttribute('tblStyle') || undefined;
    if (!tblProps.tblStyleId) {
      const tblStyleIdEl = tblPr.getElementsByTagName('a:tableStyleId')[0];
      if (tblStyleIdEl) tblProps.tblStyleId = tblStyleIdEl.textContent?.trim() || undefined;
    }

    // Table-level fill — direct children only
    for (let fi = 0; fi < tblPr.children.length; fi++) {
      const child = tblPr.children[fi];
      if (child.tagName === 'a:noFill') {
        tblProps.backgroundColor = 'transparent';
        break;
      } else if (child.tagName === 'a:solidFill') {
        tblProps.backgroundColor = parseColor(child, themeColors);
        break;
      } else if (child.tagName === 'a:gradFill') {
        const gs = child.getElementsByTagName('a:gs')[0];
        if (gs) tblProps.backgroundColor = parseColor(gs, themeColors);
        break;
      }
    }
  }

  const tblGrid = tbl.getElementsByTagName('a:tblGrid')[0];
  const colWidths: number[] = [];
  if (tblGrid) {
    const gridCols = tblGrid.getElementsByTagName('a:gridCol');
    for (let i = 0; i < gridCols.length; i++) {
      const w = parseInt(gridCols[i].getAttribute('w') || '0') / EMU_PER_PIXEL;
      colWidths.push(w);
    }
  }

  const rows: TableRow[] = [];
  const trElements: Element[] = [];
  for (let i = 0; i < tbl.children.length; i++) {
    if (tbl.children[i].tagName === 'a:tr') trElements.push(tbl.children[i]);
  }

  for (const tr of trElements) {
    const rowHeight = parseInt(tr.getAttribute('h') || '0') / EMU_PER_PIXEL;
    const cells: TableCell[] = [];

    const tcElements: Element[] = [];
    for (let j = 0; j < tr.children.length; j++) {
      if (tr.children[j].tagName === 'a:tc') tcElements.push(tr.children[j]);
    }

    for (const tc of tcElements) {
      // Skip continuation cells (vertical/horizontal merge)
      const vMerge = tc.getAttribute('vMerge');
      if (vMerge !== null && vMerge !== '0') continue;
      const hMerge = tc.getAttribute('hMerge');
      if (hMerge !== null && hMerge !== '0') continue;

      const txBody = tc.getElementsByTagName('a:txBody')[0];
      const paragraphs = txBody ? parseTextBody(txBody, themeColors, themeFonts) : [];

      const tcPr = tc.getElementsByTagName('a:tcPr')[0];
      let backgroundColor: string | undefined;
      let noFill = false;
      let borders: TableCell['borders'];
      let vertAlign: TableCell['vertAlign'];
      let margins: TableCell['margins'];

      if (tcPr) {
        // CRITICAL: Only check DIRECT children of tcPr for fill
        // getElementsByTagName would find fills inside border elements (a:lnL, a:lnR etc.)
        let cellFillFound = false;
        for (let fi = 0; fi < tcPr.children.length; fi++) {
          const child = tcPr.children[fi];
          if (child.tagName === 'a:noFill') {
            noFill = true;
            cellFillFound = true;
            break;
          } else if (child.tagName === 'a:solidFill') {
            backgroundColor = parseColor(child, themeColors);
            cellFillFound = true;
            break;
          } else if (child.tagName === 'a:gradFill') {
            const gs = child.getElementsByTagName('a:gs')[0];
            if (gs) backgroundColor = parseColor(gs, themeColors);
            cellFillFound = true;
            break;
          }
        }
        // If no explicit fill on cell, keep backgroundColor undefined (use table bg)
        if (!cellFillFound) {
          // No direct fill specified — transparent (inherits table/style background)
        }

        borders = {
          left: parseBorderLine(tcPr.getElementsByTagName('a:lnL')[0], themeColors),
          right: parseBorderLine(tcPr.getElementsByTagName('a:lnR')[0], themeColors),
          top: parseBorderLine(tcPr.getElementsByTagName('a:lnT')[0], themeColors),
          bottom: parseBorderLine(tcPr.getElementsByTagName('a:lnB')[0], themeColors),
        };

        const anchor = tcPr.getAttribute('anchor');
        if (anchor === 't') vertAlign = 'top';
        else if (anchor === 'b') vertAlign = 'bottom';
        else vertAlign = 'middle';

        // Cell margins
        const marL = parseInt(tcPr.getAttribute('marL') || '91440') / EMU_PER_PIXEL;
        const marR = parseInt(tcPr.getAttribute('marR') || '91440') / EMU_PER_PIXEL;
        const marT = parseInt(tcPr.getAttribute('marT') || '45720') / EMU_PER_PIXEL;
        const marB = parseInt(tcPr.getAttribute('marB') || '45720') / EMU_PER_PIXEL;
        margins = { left: marL, right: marR, top: marT, bottom: marB };
      }

      const gridSpan = parseInt(tc.getAttribute('gridSpan') || '1');
      const rowSpan = parseInt(tc.getAttribute('rowSpan') || '1');

      cells.push({
        paragraphs,
        colSpan: gridSpan > 1 ? gridSpan : undefined,
        rowSpan: rowSpan > 1 ? rowSpan : undefined,
        backgroundColor,
        noFill,
        borders,
        vertAlign,
        margins,
      });
    }

    rows.push({ cells, height: rowHeight > 0 ? rowHeight : undefined });
  }

  const totalWidth = colWidths.reduce((a, b) => a + b, 0);
  const totalHeight = rows.reduce((sum, r) => sum + (r.height || 30), 0);

  return {
    type: 'table',
    x: 0, y: 0,
    width: totalWidth,
    height: totalHeight,
    rows,
    colWidths,
    tblProps: Object.keys(tblProps).length > 0 ? tblProps : undefined,
  };
}

// ─── Slide Background ───

function parseSlideBackground(doc: Document, themeColors?: ThemeColors): SlideBackground | undefined {
  const bg = doc.getElementsByTagName('p:bg')[0];
  if (!bg) return undefined;

  const bgPr = bg.getElementsByTagName('p:bgPr')[0];
  if (bgPr) {
    const solidFill = bgPr.getElementsByTagName('a:solidFill')[0];
    if (solidFill) {
      return { color: parseColor(solidFill, themeColors) };
    }

    const gradFill = bgPr.getElementsByTagName('a:gradFill')[0];
    if (gradFill) {
      return { gradient: parseGradientFill(gradFill, themeColors) };
    }

    const blipFill = bgPr.getElementsByTagName('a:blipFill')[0];
    if (blipFill) {
      const blip = blipFill.getElementsByTagName('a:blip')[0];
      const relId = blip?.getAttribute('r:embed');
      if (relId) {
        return { imageRelId: relId };
      }
    }
  }

  const bgRef = bg.getElementsByTagName('p:bgRef')[0];
  if (bgRef) {
    const color = parseColor(bgRef, themeColors);
    if (color) return { color };
  }

  return undefined;
}

// ─── Shape Parsing ───

function parseTransform(spPr: Element): { x: number; y: number; width: number; height: number; rotation?: number; flipH?: boolean; flipV?: boolean } | null {
  const xfrm = spPr.getElementsByTagName('a:xfrm')[0];
  if (!xfrm) return null;

  const off = xfrm.getElementsByTagName('a:off')[0];
  const ext = xfrm.getElementsByTagName('a:ext')[0];

  if (!off || !ext) return null;

  const x = parseInt(off.getAttribute('x') || '0') / EMU_PER_PIXEL;
  const y = parseInt(off.getAttribute('y') || '0') / EMU_PER_PIXEL;
  const width = parseInt(ext.getAttribute('cx') || '0') / EMU_PER_PIXEL;
  const height = parseInt(ext.getAttribute('cy') || '0') / EMU_PER_PIXEL;

  const rot = xfrm.getAttribute('rot');
  const rotation = rot ? parseInt(rot) / 60000 : undefined;

  const flipH = xfrm.getAttribute('flipH') === '1';
  const flipV = xfrm.getAttribute('flipV') === '1';

  return { x, y, width, height, rotation, flipH: flipH || undefined, flipV: flipV || undefined };
}

function getDirectChildElements(parent: Element, tagName: string): Element[] {
  const result: Element[] = [];
  for (let i = 0; i < parent.children.length; i++) {
    const child = parent.children[i];
    if (child.tagName === tagName) {
      result.push(child);
    } else if (child.tagName === 'mc:AlternateContent') {
      // Prefer Fallback for browser compatibility
      let fallback: Element | null = null;
      let choice: Element | null = null;
      for (let j = 0; j < child.children.length; j++) {
        if (child.children[j].tagName === 'mc:Fallback') fallback = child.children[j];
        else if (child.children[j].tagName === 'mc:Choice') choice = child.children[j];
      }
      const container = fallback || choice;
      if (container) {
        for (let j = 0; j < container.children.length; j++) {
          if (container.children[j].tagName === tagName) {
            result.push(container.children[j]);
          }
        }
      }
    }
  }
  return result;
}

function resolveRelPath(basePath: string, target: string): string {
  if (target.startsWith('/')) return target.substring(1);
  const parts = basePath.split('/');
  parts.pop();
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

function parseArrowHead(endEl: Element | null): ArrowHead | undefined {
  if (!endEl) return undefined;
  const type = endEl.getAttribute('type');
  if (!type || type === 'none') return undefined;
  return {
    type: type as ArrowHead['type'],
    w: (endEl.getAttribute('w') || 'med') as ArrowHead['w'],
    len: (endEl.getAttribute('len') || 'med') as ArrowHead['len'],
  };
}

// Parse p:style for fill/line/font references
function parseShapeStyle(sp: Element, themeColors?: ThemeColors): { fillColor?: string; lineColor?: string; fontColor?: string; fontRefIdx?: string } {
  const style = sp.getElementsByTagName('p:style')[0];
  if (!style) return {};
  const result: { fillColor?: string; lineColor?: string; fontColor?: string; fontRefIdx?: string } = {};

  const fillRef = style.getElementsByTagName('a:fillRef')[0];
  const fillRefIdx = fillRef ? parseInt(fillRef.getAttribute('idx') || '0') : -1;

  // Debug: always log fillRef info for shapes with p:style
  const cNvPr = sp.getElementsByTagName('p:cNvPr')[0];
  const spName = cNvPr?.getAttribute('name') || '';
  if (spName.includes('육각형') || spName.includes('hexagon')) {
    console.log('[PptxViewer] parseShapeStyle for hexagon:', {
      spName,
      hasStyle: true,
      hasFillRef: !!fillRef,
      fillRefIdx,
      fillRefXml: fillRef?.outerHTML?.substring(0, 500)
    });
  }

  if (fillRef && fillRefIdx > 0) {
    result.fillColor = parseColor(fillRef, themeColors);
    // Debug: log fillRef details if color couldn't be parsed
    if (!result.fillColor) {
      const schemeClr = fillRef.getElementsByTagName('a:schemeClr')[0];
      const srgbClr = fillRef.getElementsByTagName('a:srgbClr')[0];
      console.log('[PptxViewer] fillRef color not parsed:', {
        idx: fillRefIdx,
        hasSchemeClr: !!schemeClr,
        schemeVal: schemeClr?.getAttribute('val'),
        hasSrgbClr: !!srgbClr,
        srgbVal: srgbClr?.getAttribute('val'),
        themeColorKeys: themeColors ? Object.keys(themeColors) : [],
        fillRefXml: fillRef.outerHTML?.substring(0, 300)
      });
    }
  }

  const lnRef = style.getElementsByTagName('a:lnRef')[0];
  if (lnRef) {
    const idx = parseInt(lnRef.getAttribute('idx') || '0');
    if (idx > 0) {
      result.lineColor = parseColor(lnRef, themeColors);
    }
  }

  const fontRef = style.getElementsByTagName('a:fontRef')[0];
  if (fontRef) {
    result.fontColor = parseColor(fontRef, themeColors);
    result.fontRefIdx = fontRef.getAttribute('idx') || undefined;
  }

  return result;
}

function parseShapeTree(parent: Element, rels: Map<string, string>, depth: number, themeColors?: ThemeColors, skipPlaceholders = false, themeFonts?: ThemeFonts, groupFill?: string | { type: 'gradient'; stops: { offset: number; color: string }[]; angle: number }): SlideShape[] {
  const MAX_GROUP_DEPTH = 6;

  // CRITICAL: Process ALL drawable children in document order (= z-order).
  // Previously collected by type (all sp, then all pic, etc.) which broke z-order.
  const orderedChildren: { el: Element; tag: string }[] = [];
  const drawableTags = new Set(['p:sp', 'p:pic', 'p:graphicFrame', 'p:cxnSp', 'p:grpSp']);
  for (let i = 0; i < parent.children.length; i++) {
    const child = parent.children[i];
    if (drawableTags.has(child.tagName)) {
      orderedChildren.push({ el: child, tag: child.tagName });
    } else if (child.tagName === 'mc:AlternateContent') {
      // Prefer mc:Fallback for browser compatibility — mc:Choice often requires
      // WDP/EMF or other formats that browsers cannot render.
      let fallback: Element | null = null;
      let choice: Element | null = null;
      for (let j = 0; j < child.children.length; j++) {
        if (child.children[j].tagName === 'mc:Fallback') fallback = child.children[j];
        else if (child.children[j].tagName === 'mc:Choice') choice = child.children[j];
      }
      const container = fallback || choice;
      if (container) {
        for (let j = 0; j < container.children.length; j++) {
          const cc = container.children[j];
          if (drawableTags.has(cc.tagName)) {
            orderedChildren.push({ el: cc, tag: cc.tagName });
          }
        }
      }
    }
  }

  const shapes: SlideShape[] = [];

  for (const { el: currentEl, tag } of orderedChildren) {

  // ─── p:sp ───
  if (tag === 'p:sp') {
    const sp = currentEl;
    const nvSpPr = sp.getElementsByTagName('p:nvSpPr')[0];

    // Log each p:sp element being processed
    const cNvPr = nvSpPr?.getElementsByTagName('p:cNvPr')[0];
    const shapeName = cNvPr?.getAttribute('name') || '(unnamed)';
    const shapeId = cNvPr?.getAttribute('id') || '?';
    console.log(`[PptxViewer] Processing p:sp: id=${shapeId}, name="${shapeName}", skipPlaceholders=${skipPlaceholders}`);

    if (nvSpPr) {
      const nvPr = nvSpPr.getElementsByTagName('p:nvPr')[0];
      const phEl = nvPr?.getElementsByTagName('p:ph')[0];
      if (phEl) {
        if (skipPlaceholders) {
          // For layout/master: Skip placeholders with INSTRUCTIONAL TEXT
          // Keep placeholders that are DECORATIVE (have fill but no text)
          const txBody = sp.getElementsByTagName('p:txBody')[0];
          const placeholderText = txBody?.textContent?.trim();

          // Check for visual fill (direct or via style reference)
          const spPrCheck = sp.getElementsByTagName('p:spPr')[0];
          const hasDirectFill = spPrCheck && (
            spPrCheck.getElementsByTagName('a:solidFill')[0] ||
            spPrCheck.getElementsByTagName('a:gradFill')[0] ||
            spPrCheck.getElementsByTagName('a:blipFill')[0] ||
            spPrCheck.getElementsByTagName('a:pattFill')[0]
          );

          // Check p:style for fill reference (many decorative elements use this)
          const styleEl = sp.getElementsByTagName('p:style')[0];
          const fillRefEl = styleEl?.getElementsByTagName('a:fillRef')[0];
          const hasStyleFill = fillRefEl && parseInt(fillRefEl.getAttribute('idx') || '0') > 0;

          const hasFill = hasDirectFill || hasStyleFill;
          const phType = phEl.getAttribute('type') || '(none)';

          console.log('[PptxViewer] Placeholder check:', {
            type: phType,
            hasText: !!placeholderText,
            textPreview: placeholderText?.substring(0, 30),
            hasDirectFill: !!hasDirectFill,
            hasStyleFill: !!hasStyleFill,
            decision: placeholderText ? 'SKIP(text)' : (!hasFill ? 'SKIP(noFill)' : 'KEEP')
          });

          // Decision logic:
          // - Has text (instructional) → SKIP
          // - No text, has fill → KEEP (decorative element)
          // - No text, no fill → SKIP (empty placeholder box)
          if (placeholderText) {
            console.log(`[PptxViewer] SKIP p:sp id=${shapeId} name="${shapeName}" - placeholder with text`);
            continue;
          }
          if (!hasFill) {
            console.log(`[PptxViewer] SKIP p:sp id=${shapeId} name="${shapeName}" - placeholder with no fill`);
            continue;
          }
          console.log(`[PptxViewer] KEEP p:sp id=${shapeId} name="${shapeName}" - decorative placeholder with fill`);
          // Otherwise: decorative placeholder with fill, keep it
        } else {
          // On slide: render placeholder text but skip if no text content
          const txBody = sp.getElementsByTagName('p:txBody')[0];
          if (!txBody) continue;
          const hasText = txBody.textContent?.trim();
          if (!hasText) continue;
        }
      }
    }

    const spPr = sp.getElementsByTagName('p:spPr')[0];
    const txBody = sp.getElementsByTagName('p:txBody')[0];

    if (!spPr) {
      console.log(`[PptxViewer] SKIP p:sp id=${shapeId} name="${shapeName}" - no spPr`);
      continue;
    }

    // Debug: log full p:sp XML for hexagons to see if there's a fill we're missing
    if (shapeName.includes('육각형') || shapeName.includes('hexagon')) {
      console.log(`[PptxViewer] Hexagon FULL p:sp XML:`, sp.outerHTML?.substring(0, 2000));
    }

    const transform = parseTransform(spPr);
    if (!transform) {
      console.log(`[PptxViewer] SKIP p:sp id=${shapeId} name="${shapeName}" - no transform (xfrm)`);
      continue;
    }

    // If we got here, shape has spPr and transform
    const shape: ShapeElement = {
          type: 'shape',
          ...transform,
        };

        const prstGeom = spPr.getElementsByTagName('a:prstGeom')[0];
        if (prstGeom) {
          shape.shapeType = prstGeom.getAttribute('prst') || undefined;
        }

        // Fill: check DIRECT children of spPr only (not inside a:ln)
        let solidFill: Element | null = null;
        let noFill: Element | null = null;
        let gradFill: Element | null = null;
        let blipFill: Element | null = null;
        let grpFill: Element | null = null;
        for (let fi = 0; fi < spPr.children.length; fi++) {
          const child = spPr.children[fi];
          if (child.tagName === 'a:solidFill') solidFill = child;
          else if (child.tagName === 'a:noFill') noFill = child;
          else if (child.tagName === 'a:gradFill') gradFill = child;
          else if (child.tagName === 'a:blipFill') blipFill = child;
          else if (child.tagName === 'a:grpFill') grpFill = child;
        }

        if (solidFill) {
          shape.backgroundColor = parseColor(solidFill, themeColors);
          // Debug: log if solid fill was found but color couldn't be parsed
          if (!shape.backgroundColor) {
            const schemeClr = solidFill.getElementsByTagName('a:schemeClr')[0];
            const srgbClr = solidFill.getElementsByTagName('a:srgbClr')[0];
            console.log(`[PptxViewer] solidFill found but no color parsed:`, {
              shapeName, shapeId,
              hasSchemeClr: !!schemeClr,
              schemeVal: schemeClr?.getAttribute('val'),
              hasSrgbClr: !!srgbClr,
              srgbVal: srgbClr?.getAttribute('val'),
              themeColorsAvailable: !!themeColors,
              solidFillXml: solidFill.outerHTML?.substring(0, 200)
            });
          }
        }

        if (gradFill) {
          shape.gradientFill = parseGradientFill(gradFill, themeColors);
        }

        // a:grpFill - inherit fill from parent group
        if (grpFill) {
          if (groupFill) {
            console.log(`[PptxViewer] Shape "${shapeName}" has a:grpFill, inheriting from parent group:`, groupFill);
            if (typeof groupFill === 'string') {
              shape.backgroundColor = groupFill;
            } else {
              shape.gradientFill = groupFill;
            }
          } else {
            console.log(`[PptxViewer] Shape "${shapeName}" has a:grpFill but NO groupFill was passed - check parent group!`);
          }
        }

        // Shape image fill (a:blipFill in p:spPr)
        if (blipFill) {
          const blip = blipFill.getElementsByTagName('a:blip')[0];
          const relId = blip?.getAttribute('r:embed') || blip?.getAttribute('r:link');
          if (relId) {
            shape.type = 'image';
            shape.imageRelId = relId;
            // Parse srcRect for crop
            const srcRect = blipFill.getElementsByTagName('a:srcRect')[0];
            if (srcRect) {
              shape.imageCrop = {
                left: parseInt(srcRect.getAttribute('l') || '0') / 1000,
                top: parseInt(srcRect.getAttribute('t') || '0') / 1000,
                right: parseInt(srcRect.getAttribute('r') || '0') / 1000,
                bottom: parseInt(srcRect.getAttribute('b') || '0') / 1000,
              };
            }
          }
        }

        // Border/outline
        const ln = spPr.getElementsByTagName('a:ln')[0];
        let hasExplicitLine = false;
        if (ln) {
          hasExplicitLine = true;
          // Check if line has noFill (explicitly invisible)
          let lnNoFill = false;
          for (let lni = 0; lni < ln.childNodes.length; lni++) {
            if (ln.childNodes[lni].nodeType === 1 && (ln.childNodes[lni] as Element).tagName === 'a:noFill') {
              lnNoFill = true;
              break;
            }
          }
          if (!lnNoFill) {
            const lnFill = ln.getElementsByTagName('a:solidFill')[0];
            if (lnFill) {
              shape.borderColor = parseColor(lnFill, themeColors);
            }
            const lnWidth = parseInt(ln.getAttribute('w') || '0') / EMU_PER_PIXEL;
            if (lnWidth > 0) {
              shape.borderWidth = lnWidth;
            } else if (shape.borderColor) {
              // Line has fill but no explicit width — use default 1px
              shape.borderWidth = 1;
            }
          }
          const prstDash = ln.getElementsByTagName('a:prstDash')[0];
          if (prstDash) {
            shape.dashStyle = prstDash.getAttribute('val') || undefined;
          }
        }

        // Shadow effects
        const effectLst = spPr.getElementsByTagName('a:effectLst')[0];
        if (effectLst) {
          const outerShdw = effectLst.getElementsByTagName('a:outerShdw')[0];
          const innerShdw = effectLst.getElementsByTagName('a:innerShdw')[0];
          const shdw = outerShdw || innerShdw;
          if (shdw) {
            const blurRad = parseInt(shdw.getAttribute('blurRad') || '0') / EMU_PER_PIXEL;
            const dist = parseInt(shdw.getAttribute('dist') || '0') / EMU_PER_PIXEL;
            const dir = parseInt(shdw.getAttribute('dir') || '0') / 60000;
            const dirRad = (dir * Math.PI) / 180;
            const shdwColor = parseColor(shdw, themeColors) || 'rgba(0,0,0,0.3)';
            shape.shadow = {
              offsetX: Math.round(Math.cos(dirRad) * dist * 10) / 10,
              offsetY: Math.round(Math.sin(dirRad) * dist * 10) / 10,
              blur: Math.round(blurRad * 10) / 10,
              color: shdwColor,
              inset: !!innerShdw && !outerShdw,
            };
          }
        }

        // Custom geometry
        if (!prstGeom) {
          const custGeom = spPr.getElementsByTagName('a:custGeom')[0];
          if (custGeom) {
            const pathLst = custGeom.getElementsByTagName('a:pathLst')[0];
            if (pathLst) shape.customPath = parseCustomGeometry(pathLst, shape.width, shape.height);
          }
        }

        // Parse adjustment values (avLst) for preset shapes
        if (prstGeom) {
          const avLst = prstGeom.getElementsByTagName('a:avLst')[0];
          if (avLst) {
            const adjustValues: Record<string, number> = {};
            const gds = avLst.getElementsByTagName('a:gd');
            for (let g = 0; g < gds.length; g++) {
              const name = gds[g].getAttribute('name') || '';
              const fmla = gds[g].getAttribute('fmla') || '';
              const valMatch = fmla.match(/val\s+(-?\d+)/);
              if (valMatch) adjustValues[name] = parseInt(valMatch[1]);
            }
            shape.adjustValues = adjustValues;
          }
        }

        // p:style fallback for fill (only if no explicit fill type is specified)
        if (!solidFill && !gradFill && !noFill && !blipFill && !grpFill) {
          const styleColors = parseShapeStyle(sp, themeColors);
          console.log(`[PptxViewer] No direct fill, trying p:style fallback:`, {
            shapeName, shapeId,
            styleFillColor: styleColors.fillColor,
            hasStyle: !!sp.getElementsByTagName('p:style')[0]
          });
          if (styleColors.fillColor && !shape.backgroundColor) {
            shape.backgroundColor = styleColors.fillColor;
          }
        }
        // p:style fallback for line (independent of fill, but only if no explicit a:ln)
        if (!hasExplicitLine && !shape.borderColor) {
          const styleColors = parseShapeStyle(sp, themeColors);
          if (styleColors.lineColor) {
            shape.borderColor = styleColors.lineColor;
            if (!shape.borderWidth) shape.borderWidth = 1;
          }
        }

        // Text content
        if (txBody) {
          shape.paragraphs = parseTextBody(txBody, themeColors, themeFonts);
          shape.textBody = parseTextBodyProps(txBody);

          // Apply defaults from p:style (fontRef color + font family)
          const styleColors = parseShapeStyle(sp, themeColors);
          if (shape.paragraphs.length > 0) {
            // Resolve default font from fontRef idx (major/minor → theme font)
            let defaultFont: string | undefined;
            if (styleColors.fontRefIdx && themeFonts) {
              if (styleColors.fontRefIdx === 'major') {
                defaultFont = themeFonts.majorLatin || themeFonts.majorEA || undefined;
              } else if (styleColors.fontRefIdx === 'minor') {
                defaultFont = themeFonts.minorLatin || themeFonts.minorEA || undefined;
              }
            }

            // Parse lstStyle defaults (a:lstStyle > a:lvl1pPr > a:defRPr)
            const lstStyle = txBody.getElementsByTagName('a:lstStyle')[0];
            const lstDefaults: Partial<TextRun>[] = [];
            const lstBullets: (string | undefined)[] = [];
            if (lstStyle) {
              for (let lvl = 1; lvl <= 9; lvl++) {
                const lvlPPr = lstStyle.getElementsByTagName(`a:lvl${lvl}pPr`)[0];
                if (lvlPPr) {
                  const defRPr = lvlPPr.getElementsByTagName('a:defRPr')[0];
                  lstDefaults[lvl - 1] = defRPr ? parseRunProperties(defRPr, themeColors, themeFonts) : {};
                  // Parse bullet from lstStyle level
                  const bullet = parseBullet(lvlPPr);
                  lstBullets[lvl - 1] = bullet.bulletChar;
                }
              }
            }

            for (const para of shape.paragraphs) {
              const level = para.level || 0;
              const lstDefault = lstDefaults[level] || lstDefaults[0];
              // Apply lstStyle bullet if paragraph has no explicit bullet and has actual text
              const hasText = para.runs.some(r => r.text && r.text.trim().length > 0);
              if (!para.bulletChar && hasText && (lstBullets[level] !== undefined || lstBullets[0] !== undefined)) {
                para.bulletChar = lstBullets[level] || lstBullets[0];
              }
              for (const run of para.runs) {
                // Apply lstStyle defaults
                if (lstDefault) {
                  if (!run.color && lstDefault.color) run.color = lstDefault.color;
                  if (!run.fontFamily && lstDefault.fontFamily) run.fontFamily = lstDefault.fontFamily;
                  if (run.fontSize === undefined && lstDefault.fontSize) run.fontSize = lstDefault.fontSize;
                  if (run.letterSpacing === undefined && lstDefault.letterSpacing !== undefined) run.letterSpacing = lstDefault.letterSpacing;
                }
                // Apply p:style fontRef color
                if (!run.color && styleColors.fontColor) run.color = styleColors.fontColor;
                // Apply default font from fontRef
                if (!run.fontFamily && defaultFont) run.fontFamily = defaultFont;
                // Final fallback: theme minor font for shapes with no fontRef at all
                if (!run.fontFamily && themeFonts) {
                  run.fontFamily = themeFonts.minorLatin || themeFonts.minorEA || undefined;
                }
              }
            }
          }

          // Parse hyperlinks
          const runs = txBody.getElementsByTagName('a:r');
          let runIdx = 0;
          for (let ri = 0; ri < runs.length; ri++) {
            const rPr = runs[ri].getElementsByTagName('a:rPr')[0];
            if (rPr) {
              const hlinkClick = rPr.getElementsByTagName('a:hlinkClick')[0];
              if (hlinkClick) {
                const rId = hlinkClick.getAttribute('r:id');
                if (rId) {
                  const url = rels.get(rId);
                  if (url && shape.paragraphs) {
                    let totalRuns = 0;
                    for (const para of shape.paragraphs) {
                      for (const run of para.runs) {
                        if (totalRuns === runIdx && url) {
                          run.hyperlink = url;
                        }
                        totalRuns++;
                      }
                    }
                  }
                }
              }
            }
            runIdx++;
          }
        }

        // Include shapes with visible content OR background/border/geometry
        // For layout/master shapes, be more permissive - include if they have a valid transform
        const hasText = shape.paragraphs && shape.paragraphs.some(p => p.runs.some(r => r.text.length > 0));
        const hasVisual = shape.backgroundColor || shape.gradientFill || shape.borderColor || shape.imageRelId || shape.customPath || shape.shapeType;
        const hasValidTransform = shape.width > 0 && shape.height > 0;
        if (skipPlaceholders) {
          console.log('[PptxViewer] Layout/Master shape:', {
            type: shape.type, shapeType: shape.shapeType,
            x: Math.round(shape.x), y: Math.round(shape.y),
            w: Math.round(shape.width), h: Math.round(shape.height),
            bg: shape.backgroundColor, grad: !!shape.gradientFill,
            border: shape.borderColor, hasText, hasVisual, hasValidTransform
          });
        }
        if (hasText || hasVisual || (skipPlaceholders && hasValidTransform)) {
          shapes.push(shape);
        }
  }

  // ─── p:pic ───
  else if (tag === 'p:pic') {
    const pic = currentEl;
    const spPr = pic.getElementsByTagName('p:spPr')[0];
    const blipFill = pic.getElementsByTagName('p:blipFill')[0];

    if (spPr && blipFill) {
      const transform = parseTransform(spPr);
      const blip = blipFill.getElementsByTagName('a:blip')[0];
      const relId = blip?.getAttribute('r:embed') || blip?.getAttribute('r:link');

      if (transform && relId) {
        const shape: ShapeElement = {
          type: 'image',
          ...transform,
          imageRelId: relId,
        };

        // Parse srcRect for cropping
        const srcRect = blipFill.getElementsByTagName('a:srcRect')[0];
        if (srcRect) {
          shape.imageCrop = {
            left: parseInt(srcRect.getAttribute('l') || '0') / 1000,
            top: parseInt(srcRect.getAttribute('t') || '0') / 1000,
            right: parseInt(srcRect.getAttribute('r') || '0') / 1000,
            bottom: parseInt(srcRect.getAttribute('b') || '0') / 1000,
          };
        }

        // Parse duotone effect from blip
        if (blip) {
          const duotone = blip.getElementsByTagName('a:duotone')[0];
          if (duotone) {
            const colors: string[] = [];
            for (let di = 0; di < duotone.childNodes.length; di++) {
              const dChild = duotone.childNodes[di];
              if (dChild.nodeType !== 1) continue;
              // duotone children are direct color elements — use parseColor on duotone as container
              // but duotone has multiple color children, so we wrap each in a temp approach
              const c = resolveDirectColor(dChild as Element, themeColors);
              if (c) colors.push(c);
            }
            if (colors.length >= 2) {
              shape.duotoneColors = [colors[0], colors[1]];
            }
          }
        }

        shapes.push(shape);
      }
    }
  }

  // ─── p:graphicFrame ───
  else if (tag === 'p:graphicFrame') {
    const gf = currentEl;
    const xfrm = gf.getElementsByTagName('p:xfrm')[0];
    const graphicData = gf.getElementsByTagName('a:graphicData')[0];

    if (xfrm && graphicData) {
      const uri = graphicData.getAttribute('uri') || '';
      const off = xfrm.getElementsByTagName('a:off')[0];
      const ext = xfrm.getElementsByTagName('a:ext')[0];
      const gfX = off ? parseInt(off.getAttribute('x') || '0') / EMU_PER_PIXEL : 0;
      const gfY = off ? parseInt(off.getAttribute('y') || '0') / EMU_PER_PIXEL : 0;
      const gfW = ext ? parseInt(ext.getAttribute('cx') || '0') / EMU_PER_PIXEL : 200;
      const gfH = ext ? parseInt(ext.getAttribute('cy') || '0') / EMU_PER_PIXEL : 100;

      if (uri.includes('/chart') || uri.includes('/diagram')) {
        // Try to find a fallback image via the graphic frame's relationships
        const nvGfPr = gf.getElementsByTagName('p:nvGraphicFramePr')[0];
        const nvPr = nvGfPr?.getElementsByTagName('p:nvPr')[0];
        const extLst = nvPr?.getElementsByTagName('p:extLst')[0];
        let fallbackImageRelId: string | undefined;

        // Check for diagram/chart image fallback via r:id in relationships
        if (extLst) {
          const exts = extLst.getElementsByTagName('p:ext');
          for (let ei = 0; ei < exts.length; ei++) {
            const relId = exts[ei].getElementsByTagName('r:id')?.[0]?.getAttribute('r:id') ||
                          exts[ei].getAttribute('r:id');
            if (relId && rels.has(relId)) {
              const target = rels.get(relId)!;
              if (target.includes('media/') || target.includes('image')) {
                fallbackImageRelId = relId;
                break;
              }
            }
          }
        }

        if (fallbackImageRelId) {
          shapes.push({
            type: 'image', x: gfX, y: gfY, width: gfW, height: gfH,
            imageRelId: fallbackImageRelId,
          });
        } else {
          const label = uri.includes('/chart') ? '[차트]' : '[SmartArt]';
          shapes.push({
            type: 'shape', x: gfX, y: gfY, width: gfW, height: gfH,
            paragraphs: [{ runs: [{ text: label, fontSize: 10, color: '#888' }], align: 'center' }],
            backgroundColor: '#f8f8f8', borderColor: '#ddd', borderWidth: 1,
          });
        }
        continue;
      }

      const table = parseTable(graphicData, themeColors, themeFonts);
      if (table) {
        table.x = gfX;
        table.y = gfY;
        table.frameHeight = gfH;
        // Scale column widths to match graphicFrame width
        if (gfW > 0 && table.width > 0 && Math.abs(table.width - gfW) > 2) {
          const scale = gfW / table.width;
          table.colWidths = table.colWidths.map(w => w * scale);
          table.width = gfW;
        }
        shapes.push(table);
      }
    }
  }

  // ─── p:cxnSp ───
  else if (tag === 'p:cxnSp') {
    const cxn = currentEl;
    const spPr = cxn.getElementsByTagName('p:spPr')[0];

    if (spPr) {
      const transform = parseTransform(spPr);
      if (transform) {
        const ln = spPr.getElementsByTagName('a:ln')[0];
        let borderColor = '#000000';
        let borderWidth = 1;
        let headEnd: ArrowHead | undefined;
        let tailEnd: ArrowHead | undefined;
        let dashStyle: string | undefined;

        if (ln) {
          borderWidth = parseInt(ln.getAttribute('w') || '12700') / EMU_PER_PIXEL;
          const lnFill = ln.getElementsByTagName('a:solidFill')[0];
          if (lnFill) {
            borderColor = parseColor(lnFill, themeColors) || '#000000';
          } else {
            // p:style fallback for connector color
            const styleColors = parseShapeStyle(cxn, themeColors);
            if (styleColors.lineColor) borderColor = styleColors.lineColor;
          }
          headEnd = parseArrowHead(ln.getElementsByTagName('a:headEnd')[0]);
          tailEnd = parseArrowHead(ln.getElementsByTagName('a:tailEnd')[0]);
          const prstDash = ln.getElementsByTagName('a:prstDash')[0];
          if (prstDash) dashStyle = prstDash.getAttribute('val') || undefined;
        }

        // Parse connector type and adjustment values
        const prstGeom = spPr.getElementsByTagName('a:prstGeom')[0];
        const connectorType = prstGeom?.getAttribute('prst') || 'straightConnector1';
        const adjustValues: Record<string, number> = {};
        const avLst = prstGeom?.getElementsByTagName('a:avLst')[0];
        if (avLst) {
          const gds = avLst.getElementsByTagName('a:gd');
          for (let g = 0; g < gds.length; g++) {
            const name = gds[g].getAttribute('name') || '';
            const fmla = gds[g].getAttribute('fmla') || '';
            const valMatch = fmla.match(/val\s+(-?\d+)/);
            if (valMatch) adjustValues[name] = parseInt(valMatch[1]) / 100000;
          }
        }

        shapes.push({
          type: 'line',
          ...transform,
          borderColor,
          borderWidth,
          headEnd,
          tailEnd,
          dashStyle,
          connectorType,
          adjustValues,
        });
      }
    }
  }

  // ─── p:grpSp ───
  else if (tag === 'p:grpSp' && depth < MAX_GROUP_DEPTH) {
    const grpSp = currentEl;
    {
      const grpSpPr = grpSp.getElementsByTagName('p:grpSpPr')[0];
      if (!grpSpPr) continue;

      const xfrm = grpSpPr.getElementsByTagName('a:xfrm')[0];
      if (!xfrm) continue;

      const off = xfrm.getElementsByTagName('a:off')[0];
      const ext = xfrm.getElementsByTagName('a:ext')[0];
      const chOff = xfrm.getElementsByTagName('a:chOff')[0];
      const chExt = xfrm.getElementsByTagName('a:chExt')[0];

      if (!off || !ext || !chOff || !chExt) continue;

      // Extract this group's fill to pass down to children with a:grpFill
      let thisGroupFill: string | { type: 'gradient'; stops: { offset: number; color: string }[]; angle: number } | undefined;

      // Check if this group has its own fill or inherits from parent
      const grpSolidFill = grpSpPr.getElementsByTagName('a:solidFill')[0];
      const grpGradFill = grpSpPr.getElementsByTagName('a:gradFill')[0];
      const grpGrpFill = grpSpPr.getElementsByTagName('a:grpFill')[0];

      if (grpSolidFill) {
        thisGroupFill = parseColor(grpSolidFill, themeColors);
        console.log('[PptxViewer] Group has solidFill:', thisGroupFill);
      } else if (grpGradFill) {
        thisGroupFill = parseGradientFill(grpGradFill, themeColors);
        console.log('[PptxViewer] Group has gradFill:', thisGroupFill);
      } else if (grpGrpFill && groupFill) {
        // This group inherits from its parent group
        thisGroupFill = groupFill;
        console.log('[PptxViewer] Group inherits from parent via a:grpFill:', thisGroupFill);
      } else {
        // Debug: log when no group fill found
        console.log('[PptxViewer] Group has no fill to pass down. grpSpPr XML:', grpSpPr.outerHTML?.substring(0, 500));
      }

      const group: GroupShapeElement = {
        type: 'group',
        x: parseInt(off.getAttribute('x') || '0') / EMU_PER_PIXEL,
        y: parseInt(off.getAttribute('y') || '0') / EMU_PER_PIXEL,
        width: parseInt(ext.getAttribute('cx') || '0') / EMU_PER_PIXEL,
        height: parseInt(ext.getAttribute('cy') || '0') / EMU_PER_PIXEL,
        childOffsetX: parseInt(chOff.getAttribute('x') || '0') / EMU_PER_PIXEL,
        childOffsetY: parseInt(chOff.getAttribute('y') || '0') / EMU_PER_PIXEL,
        childExtX: parseInt(chExt.getAttribute('cx') || '0') / EMU_PER_PIXEL,
        childExtY: parseInt(chExt.getAttribute('cy') || '0') / EMU_PER_PIXEL,
        children: parseShapeTree(grpSp, rels, depth + 1, themeColors, skipPlaceholders, themeFonts, thisGroupFill),
      };

      const rot = xfrm.getAttribute('rot');
      if (rot) group.rotation = parseInt(rot) / 60000;
      if (xfrm.getAttribute('flipH') === '1') group.flipH = true;
      if (xfrm.getAttribute('flipV') === '1') group.flipV = true;

      shapes.push(group);
    }
  }

  } // end for orderedChildren

  return shapes;
}

// ─── Slide Parsing ───

function parseSlideXml(xmlString: string, defaultWidth: number, defaultHeight: number, rels: Map<string, string>, themeColors?: ThemeColors, themeFonts?: ThemeFonts): SlideData {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlString, 'application/xml');

  const spTree = doc.getElementsByTagName('p:spTree')[0];
  const background = parseSlideBackground(doc, themeColors);

  // Check showMasterSp attribute (default is true if not specified)
  const cSld = doc.getElementsByTagName('p:cSld')[0];
  const showMasterSpAttr = cSld?.getAttribute('showMasterSp');
  const showMasterSp = showMasterSpAttr !== '0';

  // Preserve XML order — it defines z-order (first = bottom, last = top)
  const shapes = spTree ? parseShapeTree(spTree, rels, 0, themeColors, false, themeFonts) : [];

  return { shapes, width: defaultWidth, height: defaultHeight, background, showMasterSp };
}

function parseRelsXml(xmlString: string): Map<string, string> {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlString, 'application/xml');
  const rels = new Map<string, string>();

  const relationships = doc.getElementsByTagName('Relationship');
  for (let i = 0; i < relationships.length; i++) {
    const rel = relationships[i];
    const id = rel.getAttribute('Id');
    const target = rel.getAttribute('Target');
    if (id && target) {
      rels.set(id, target);
    }
  }

  return rels;
}

function parsePresentationXml(xmlString: string): { width: number; height: number } {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlString, 'application/xml');

  const sldSz = doc.getElementsByTagName('p:sldSz')[0];
  if (sldSz) {
    const cx = parseInt(sldSz.getAttribute('cx') || '9144000');
    const cy = parseInt(sldSz.getAttribute('cy') || '6858000');
    return {
      width: cx / EMU_PER_PIXEL,
      height: cy / EMU_PER_PIXEL,
    };
  }

  return { width: 960, height: 540 };
}

// ─── Component ───

export function PptxViewer({ data }: PptxViewerProps) {
  const [slides, setSlides] = useState<SlideData[]>([]);
  const [slideImages, setSlideImages] = useState<Map<number, Map<string, string>>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [zoom, setZoom] = useState(1);
  const [slideSize, setSlideSize] = useState({ width: 960, height: 540 });
  const [visibleSlide, setVisibleSlide] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const slideRefs = useRef<(HTMLDivElement | null)[]>([]);
  const tableStylesRef = useRef<Map<string, TableStyleDef>>(new Map());

  useEffect(() => {
    const loadImagesFromRels = async (
      zip: JSZip, rels: Map<string, string>, basePath: string, imageMap: Map<string, string>
    ) => {
      const MIME_MAP: Record<string, string> = {
        'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'png': 'image/png',
        'gif': 'image/gif', 'svg': 'image/svg+xml', 'bmp': 'image/bmp',
        'tif': 'image/tiff', 'tiff': 'image/tiff', 'webp': 'image/webp',
      };
      const SKIP_FORMATS = new Set(['emf', 'wmf', 'wdp']);

      for (const [id, target] of rels) {
        if (imageMap.has(id)) continue;
        if (!target.includes('media/') && !target.includes('image')) continue;
        if (target.startsWith('http://') || target.startsWith('https://')) continue;

        const ext = target.split('.').pop()?.toLowerCase() || '';
        if (SKIP_FORMATS.has(ext)) continue;

        const resolvedPath = resolveRelPath(basePath, target);
        const imageFile = zip.file(resolvedPath);

        if (imageFile) {
          const imageData = await imageFile.async('base64');
          const mimeType = MIME_MAP[ext] || 'image/png';
          imageMap.set(id, `data:${mimeType};base64,${imageData}`);
        }
      }
    };

    const loadPptx = async () => {
      try {
        setLoading(true);
        setError(null);

        const zip = await JSZip.loadAsync(data);
        const slideContents: SlideData[] = [];
        const allSlideImages = new Map<number, Map<string, string>>();

        // Parse presentation.xml for slide size
        const presentationXml = await zip.file('ppt/presentation.xml')?.async('string');
        let defaultSize = { width: 960, height: 540 };
        if (presentationXml) {
          defaultSize = parsePresentationXml(presentationXml);
          setSlideSize(defaultSize);
        }

        // Parse theme
        let themeColors: ThemeColors | undefined;
        let themeFonts: ThemeFonts | undefined;
        const themeFile = zip.file('ppt/theme/theme1.xml');
        if (themeFile) {
          const themeXml = await themeFile.async('string');
          const themeData = parseThemeXml(themeXml);
          themeColors = themeData.colors;
          themeFonts = themeData.fonts;
          console.log('[PptxViewer] Theme colors - dk1:', themeColors.dk1, 'dk2:', themeColors.dk2, 'accent1:', themeColors.accent1);
          console.log('[PptxViewer] All theme colors:', JSON.stringify(themeColors));
        }

        // Parse table styles
        let tableStyles = new Map<string, TableStyleDef>();
        const tableStylesFile = zip.file('ppt/tableStyles.xml');
        if (tableStylesFile) {
          const tableStylesXml = await tableStylesFile.async('string');
          tableStyles = parseTableStylesXml(tableStylesXml, themeColors);
        }
        // Add default table style fallback
        const defaultStyleId = '{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}';
        if (!tableStyles.has(defaultStyleId)) {
          tableStyles.set(defaultStyleId, getDefaultTableStyle(themeColors));
        }
        tableStylesRef.current = tableStyles;

        // Layout and master caches
        const layoutCache = new Map<string, { background?: SlideBackground; shapes: SlideShape[]; imageMap: Map<string, string> }>();
        const masterCache = new Map<string, { background?: SlideBackground; shapes: SlideShape[]; imageMap: Map<string, string> }>();

        // Find and sort slide files
        const slideFiles: string[] = [];
        zip.forEach((path) => {
          if (path.match(/^ppt\/slides\/slide\d+\.xml$/)) {
            slideFiles.push(path);
          }
        });

        slideFiles.sort((a, b) => {
          const numA = parseInt(a.match(/slide(\d+)/)?.[1] || '0');
          const numB = parseInt(b.match(/slide(\d+)/)?.[1] || '0');
          return numA - numB;
        });

        // Parse each slide
        for (let i = 0; i < slideFiles.length; i++) {
          const slidePath = slideFiles[i];
          const slideXml = await zip.file(slidePath)?.async('string');
          if (!slideXml) continue;

          const slideNum = slidePath.match(/slide(\d+)/)?.[1];
          const relsPath = `ppt/slides/_rels/slide${slideNum}.xml.rels`;
          const relsXml = await zip.file(relsPath)?.async('string');
          const rels = relsXml ? parseRelsXml(relsXml) : new Map<string, string>();

          const content = parseSlideXml(slideXml, defaultSize.width, defaultSize.height, rels, themeColors, themeFonts);

          const imageMap = new Map<string, string>();
          await loadImagesFromRels(zip, rels, slidePath, imageMap);

          // Slide Layout support
          let layoutPath: string | undefined;
          for (const [, target] of rels) {
            if (target.includes('slideLayout')) {
              layoutPath = resolveRelPath(slidePath, target);
              break;
            }
          }

          let masterPath: string | undefined;

          if (layoutPath && !layoutCache.has(layoutPath)) {
            const layoutXml = await zip.file(layoutPath)?.async('string');
            if (layoutXml) {
              const layoutName = layoutPath.match(/slideLayout\d+/)?.[0];
              const layoutRelsPath = `ppt/slideLayouts/_rels/${layoutName}.xml.rels`;
              const layoutRelsXml = await zip.file(layoutRelsPath)?.async('string');
              const layoutRels = layoutRelsXml ? parseRelsXml(layoutRelsXml) : new Map<string, string>();

              const layoutDoc = new DOMParser().parseFromString(layoutXml, 'application/xml');
              const layoutBg = parseSlideBackground(layoutDoc, themeColors);
              console.log('[PptxViewer] Layout background:', layoutPath, layoutBg);
              const layoutSpTree = layoutDoc.getElementsByTagName('p:spTree')[0];

              // Log ALL direct child tag names of layout spTree
              const layoutDirectChildren: string[] = [];
              if (layoutSpTree) {
                for (let ci = 0; ci < layoutSpTree.children.length; ci++) {
                  layoutDirectChildren.push(layoutSpTree.children[ci].tagName);
                }
              }
              console.log('[PptxViewer] Layout spTree direct children:', layoutPath, layoutDirectChildren);
              console.log('[PptxViewer] Layout spTree raw XML snippet:', layoutSpTree?.outerHTML?.substring(0, 3000));

              const layoutShapes = layoutSpTree ? parseShapeTree(layoutSpTree, layoutRels, 0, themeColors, true, themeFonts) : [];
              console.log('[PptxViewer] Parsed layout:', layoutPath, 'shapes:', layoutShapes.length);

              const layoutImageMap = new Map<string, string>();
              await loadImagesFromRels(zip, layoutRels, layoutPath, layoutImageMap);

              for (const [, target] of layoutRels) {
                if (target.includes('slideMaster')) {
                  masterPath = resolveRelPath(layoutPath, target);
                  break;
                }
              }

              if (masterPath && !masterCache.has(masterPath)) {
                const masterXml = await zip.file(masterPath)?.async('string');
                if (masterXml) {
                  const masterName = masterPath.match(/slideMaster\d+/)?.[0];
                  const masterRelsPath = `ppt/slideMasters/_rels/${masterName}.xml.rels`;
                  const masterRelsXml = await zip.file(masterRelsPath)?.async('string');
                  const masterRels = masterRelsXml ? parseRelsXml(masterRelsXml) : new Map<string, string>();

                  const masterDoc = new DOMParser().parseFromString(masterXml, 'application/xml');
                  const masterBg = parseSlideBackground(masterDoc, themeColors);
                  console.log('[PptxViewer] Master background:', masterPath, masterBg);
                  const masterSpTree = masterDoc.getElementsByTagName('p:spTree')[0];

                  // Count all elements before parsing to see what exists
                  const allSpElements = masterSpTree?.getElementsByTagName('p:sp').length || 0;
                  const allPicElements = masterSpTree?.getElementsByTagName('p:pic').length || 0;
                  const allCxnElements = masterSpTree?.getElementsByTagName('p:cxnSp').length || 0;
                  const allGfElements = masterSpTree?.getElementsByTagName('p:graphicFrame').length || 0;
                  const allGrpElements = masterSpTree?.getElementsByTagName('p:grpSp').length || 0;

                  // Log ALL direct child tag names of spTree to find any unhandled types
                  const allDirectChildren: string[] = [];
                  if (masterSpTree) {
                    for (let ci = 0; ci < masterSpTree.children.length; ci++) {
                      allDirectChildren.push(masterSpTree.children[ci].tagName);
                    }
                  }
                  console.log('[PptxViewer] Master spTree direct children:', masterPath, allDirectChildren);

                  // Also log the raw XML to see the actual structure
                  console.log('[PptxViewer] Master spTree raw XML snippet:', masterSpTree?.outerHTML?.substring(0, 3000));

                  console.log('[PptxViewer] Master spTree:', masterPath, {
                    'p:sp': allSpElements, 'p:pic': allPicElements, 'p:cxnSp': allCxnElements,
                    'p:graphicFrame': allGfElements, 'p:grpSp': allGrpElements
                  });

                  const masterShapes = masterSpTree ? parseShapeTree(masterSpTree, masterRels, 0, themeColors, true, themeFonts) : [];
                  console.log('[PptxViewer] Parsed master:', masterPath, 'shapes after parse:', masterShapes.length);

                  const masterImageMap = new Map<string, string>();
                  await loadImagesFromRels(zip, masterRels, masterPath, masterImageMap);

                  masterCache.set(masterPath, { background: masterBg, shapes: masterShapes, imageMap: masterImageMap });
                }
              }

              layoutCache.set(layoutPath, { background: layoutBg, shapes: layoutShapes, imageMap: layoutImageMap });
            }
          }

          // Resolve masterPath if not already found
          if (!masterPath && layoutPath) {
            const layoutName = layoutPath.match(/slideLayout\d+/)?.[0];
            const layoutRelsPath2 = `ppt/slideLayouts/_rels/${layoutName}.xml.rels`;
            const layoutRelsXml2 = await zip.file(layoutRelsPath2)?.async('string');
            if (layoutRelsXml2) {
              const layoutRels2 = parseRelsXml(layoutRelsXml2);
              for (const [, target] of layoutRels2) {
                if (target.includes('slideMaster')) {
                  masterPath = resolveRelPath(layoutPath, target);
                  break;
                }
              }
            }
          }

          // Generate unique prefix for this slide's layout/master to avoid relId collision
          const layoutPrefix = layoutPath ? `L${layoutPath.match(/\d+/)?.[0] || '0'}` : 'L0';
          const masterPrefix = masterPath ? `M${masterPath.match(/\d+/)?.[0] || '0'}` : 'M0';

          // Track background imageRelId source for proper resolution
          let bgSource: 'slide' | 'layout' | 'master' = 'slide';

          // Merge background from layout/master if slide has none
          // Note: Don't prefix here - prefixing is done later after imageMap merge
          if (!content.background && layoutPath) {
            const layout = layoutCache.get(layoutPath);
            if (layout?.background) {
              content.background = { ...layout.background };
              bgSource = 'layout';
            } else if (masterPath) {
              const master = masterCache.get(masterPath);
              if (master?.background) {
                content.background = { ...master.background };
                bgSource = 'master';
              }
            }
          }

          // Merge decorative shapes from layout and master (non-placeholder)
          // Skip if slide says showMasterSp="0"
          if (layoutPath && content.showMasterSp !== false) {
            const layout = layoutCache.get(layoutPath);
            const master = masterPath ? masterCache.get(masterPath) : undefined;

            // Layout/Master shapes are intentionally placed decorative elements
            // Don't filter them - they should be rendered as overlays
            // Only filter truly full-slide SOLID COLOR shapes (not images, as they may have transparency)
            const filterInheritedShapes = (shapes: SlideShape[], source: 'layout' | 'master'): SlideShape[] => {
              return shapes.filter(s => {
                if (s.type !== 'table' && s.type !== 'group') {
                  const se = s as ShapeElement;
                  const wRatio = se.width / defaultSize.width;
                  const hRatio = se.height / defaultSize.height;

                  // Keep all images from layout/master - they're decorative (may have transparency)
                  // Only filter solid color shapes that truly cover the entire slide
                  if (se.type !== 'image' && wRatio > 0.95 && hRatio > 0.95 &&
                      (se.backgroundColor || se.gradientFill) &&
                      !se.paragraphs?.some(p => p.runs.some(r => r.text.length > 0))) {
                    console.log('[PptxViewer] Filtering as BG shape:', source, { w: wRatio.toFixed(2), h: hRatio.toFixed(2), bg: se.backgroundColor });
                    return false;
                  }
                }
                return true;
              });
            };

            // z-order: master (bottom) → layout → slide (top)
            // Prefix relIds to avoid collision between slide/layout/master
            const inheritedShapes: SlideShape[] = [];
            if (master?.shapes && master.shapes.length > 0) {
              console.log('[PptxViewer] Master shapes before filter:', master.shapes.length, masterPath);
              const filtered = filterInheritedShapes(master.shapes, 'master');
              console.log('[PptxViewer] Master shapes after filter:', filtered.length);
              inheritedShapes.push(...prefixShapeRelIds(filtered, masterPrefix));
            }
            if (layout?.shapes && layout.shapes.length > 0) {
              console.log('[PptxViewer] Layout shapes before filter:', layout.shapes.length, layoutPath);
              const filtered = filterInheritedShapes(layout.shapes, 'layout');
              console.log('[PptxViewer] Layout shapes after filter:', filtered.length);
              inheritedShapes.push(...prefixShapeRelIds(filtered, layoutPrefix));
            }
            console.log('[PptxViewer] Total inherited shapes:', inheritedShapes.length, 'Slide shapes:', content.shapes.length);
            if (inheritedShapes.length > 0) {
              content.shapes = [...inheritedShapes, ...content.shapes];
            }

            // Merge images from layout/master into slide imageMap WITH PREFIX
            // This ensures each source's relIds don't collide
            if (layout) {
              const prefixedLayoutImages = prefixImageMap(layout.imageMap, layoutPrefix);
              for (const [id, src] of prefixedLayoutImages) {
                imageMap.set(id, src);
              }
            }
            if (master) {
              const prefixedMasterImages = prefixImageMap(master.imageMap, masterPrefix);
              for (const [id, src] of prefixedMasterImages) {
                imageMap.set(id, src);
              }
            }

            // Background image resolve - apply prefix based on source
            if (content.background?.imageRelId && bgSource !== 'slide') {
              const prefix = bgSource === 'layout' ? layoutPrefix : masterPrefix;
              const prefixedRelId = `${prefix}:${content.background.imageRelId}`;
              content.background.imageRelId = prefixedRelId;
            }
          }

          // Background image resolve (for slide-level backgrounds from layout/master cache)
          if (content.background?.imageRelId && !imageMap.has(content.background.imageRelId)) {
            if (layoutPath) {
              const layout = layoutCache.get(layoutPath);
              // Try unprefixed first (original relId from layout/master XML)
              const bgSrc = layout?.imageMap.get(content.background.imageRelId);
              if (bgSrc) imageMap.set(content.background.imageRelId, bgSrc);
            }
          }

          slideContents.push(content);
          allSlideImages.set(i, imageMap);
        }

        setSlides(slideContents);
        setSlideImages(allSlideImages);
        setLoading(false);
      } catch (err) {
        console.error('[PptxViewer] Parse failed:', err);
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      }
    };

    loadPptx();
  }, [data]);

  // Zoom via Ctrl+Wheel (document-level capture to intercept before WebView2 native zoom)
  useEffect(() => {
    const handler = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      if (!scrollContainerRef.current?.contains(e.target as Node)) return;
      e.preventDefault();
      e.stopPropagation();
      const delta = e.deltaY > 0 ? -0.1 : 0.1;
      setZoom(prev => Math.min(3, Math.max(0.25, prev + delta)));
    };

    document.addEventListener('wheel', handler, { passive: false, capture: true });
    return () => document.removeEventListener('wheel', handler, { capture: true } as EventListenerOptions);
  }, []);

  // Zoom via Ctrl+Drag (drag up = zoom in, drag down = zoom out)
  const dragZoomRef = useRef<{ startY: number; startZoom: number } | null>(null);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;

    const handleMouseDown = (e: MouseEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        e.stopPropagation();
        dragZoomRef.current = { startY: e.clientY, startZoom: zoomRef.current };
        el.style.cursor = 'ns-resize';
      }
    };

    const handleMouseMove = (e: MouseEvent) => {
      if (!dragZoomRef.current) return;
      e.preventDefault();
      const dy = dragZoomRef.current.startY - e.clientY; // up = positive = zoom in
      const sensitivity = 0.008;
      const newZoom = Math.min(3, Math.max(0.25, dragZoomRef.current.startZoom + dy * sensitivity));
      setZoom(newZoom);
    };

    const handleMouseUp = () => {
      if (dragZoomRef.current) {
        dragZoomRef.current = null;
        el.style.cursor = '';
      }
    };

    el.addEventListener('mousedown', handleMouseDown, { capture: true });
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      el.removeEventListener('mousedown', handleMouseDown, { capture: true });
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, []);

  // Track visible slide via IntersectionObserver
  useEffect(() => {
    if (slides.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const idx = slideRefs.current.indexOf(entry.target as HTMLDivElement);
            if (idx >= 0) {
              setVisibleSlide(idx);
            }
          }
        }
      },
      {
        root: scrollContainerRef.current,
        threshold: 0.5,
      }
    );

    slideRefs.current.forEach((ref) => {
      if (ref) observer.observe(ref);
    });

    return () => observer.disconnect();
  }, [slides.length, zoom]);

  if (loading) {
    return (
      <div className="office-viewer-container pptx-viewer">
        <div className="pptx-loading">슬라이드 로딩 중...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="office-viewer-container pptx-viewer">
        <div className="office-viewer-error">PPTX 파싱 실패: {error}</div>
      </div>
    );
  }

  if (slides.length === 0) {
    return (
      <div className="office-viewer-container pptx-viewer">
        <div className="office-viewer-error">슬라이드를 찾을 수 없습니다.</div>
      </div>
    );
  }

  // ─── Rendering Helpers ───

  const renderTextRun = (run: TextRun, index: number) => {
    const style: React.CSSProperties = {};
    if (run.bold) style.fontWeight = 'bold';
    if (run.italic) style.fontStyle = 'italic';
    if (run.underline && run.strikethrough) {
      style.textDecoration = 'underline line-through';
    } else if (run.underline) {
      style.textDecoration = 'underline';
    } else if (run.strikethrough) {
      style.textDecoration = 'line-through';
    }
    if (run.fontSize) style.fontSize = `${run.fontSize}pt`;
    if (run.fontFamily) {
      // Quote multi-word font names for CSS safety
      const ff = run.fontFamily.includes(' ') ? `"${run.fontFamily}"` : run.fontFamily;
      style.fontFamily = ff;
    }
    if (run.color) style.color = run.color;
    if (run.letterSpacing !== undefined) style.letterSpacing = `${run.letterSpacing}pt`;

    if (run.hyperlink) {
      return (
        <a
          key={index}
          href={run.hyperlink}
          target="_blank"
          rel="noopener noreferrer"
          style={{ ...style, color: style.color || '#0563C1', cursor: 'pointer' }}
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); window.open(run.hyperlink!, '_blank'); }}
        >
          {run.text}
        </a>
      );
    }

    // Empty run (line break placeholder) or explicit line break
    if (!run.text) {
      return <br key={index} />;
    }
    if (run.text === '\n') {
      return <br key={index} />;
    }

    return <span key={index} style={style}>{run.text}</span>;
  };

  const renderParagraph = (para: Paragraph, index: number, inTable = false) => {
    const style: React.CSSProperties = {
      textAlign: para.align || 'left',
      paddingLeft: para.level ? para.level * 20 : 0,
      margin: 0,
    };

    // Line height
    // PowerPoint line spacing: 100% = single line (≈1.2 in CSS), 150% = 1.5 lines, etc.
    // CSS line-height percentage is relative to font-size, so we need to convert
    if (para.lineHeightPt) {
      style.lineHeight = `${para.lineHeightPt}pt`;
    } else if (para.lineHeight) {
      // PowerPoint% → CSS: multiply by 1.2 (default line height) and divide by 100
      // e.g., PowerPoint 100% → CSS 1.2, PowerPoint 150% → CSS 1.8
      const cssLineHeight = (para.lineHeight * 1.2) / 100;
      style.lineHeight = cssLineHeight.toString();
    } else {
      style.lineHeight = inTable ? '1.2' : '1.2';
    }

    // Space before/after
    if (para.spaceBefore) {
      style.marginTop = para.spaceBefore;
    }
    if (para.spaceAfter) {
      style.marginBottom = para.spaceAfter;
    }

    // Paragraph margin (left/indent)
    if (para.marginLeft) {
      style.marginLeft = para.marginLeft;
    }
    if (para.indent) {
      style.textIndent = para.indent;
    }

    return (
      <p key={index} style={style}>
        {para.bulletChar && <span style={{ marginRight: 8 }}>{para.bulletChar}</span>}
        {para.runs.map((run, i) => renderTextRun(run, i))}
      </p>
    );
  };

  const buildCellBorderStyle = (cell: TableCell, styleBorders?: TableStyleBand['borders'],
    rowIdx?: number, colIdx?: number, totalRows?: number, totalCols?: number): React.CSSProperties => {
    const style: React.CSSProperties = {};
    const b = cell.borders;

    // Helper: apply border from cell or style fallback
    const applyBorder = (side: 'left' | 'right' | 'top' | 'bottom', styleSide?: TableStyleBorder | null) => {
      const cellBorder = b?.[side];
      if (cellBorder) {
        return `${cellBorder.width}px solid ${cellBorder.color}`;
      }
      if (styleSide === null) return 'none'; // explicitly no border
      if (styleSide) return `${styleSide.width}px solid ${styleSide.color}`;
      return undefined;
    };

    // For inside borders, use insideH/insideV from style
    const isInnerH = (side: 'top' | 'bottom') => {
      if (side === 'top' && rowIdx !== undefined && rowIdx > 0) return true;
      if (side === 'bottom' && rowIdx !== undefined && totalRows !== undefined && rowIdx < totalRows - 1) return true;
      return false;
    };
    const isInnerV = (side: 'left' | 'right') => {
      if (side === 'left' && colIdx !== undefined && colIdx > 0) return true;
      if (side === 'right' && colIdx !== undefined && totalCols !== undefined && colIdx < totalCols - 1) return true;
      return false;
    };

    if (b || styleBorders) {
      const leftB = applyBorder('left', isInnerV('left') ? (styleBorders?.insideV ?? styleBorders?.left) : styleBorders?.left);
      const rightB = applyBorder('right', isInnerV('right') ? (styleBorders?.insideV ?? styleBorders?.right) : styleBorders?.right);
      const topB = applyBorder('top', isInnerH('top') ? (styleBorders?.insideH ?? styleBorders?.top) : styleBorders?.top);
      const bottomB = applyBorder('bottom', isInnerH('bottom') ? (styleBorders?.insideH ?? styleBorders?.bottom) : styleBorders?.bottom);
      if (leftB) style.borderLeft = leftB;
      if (rightB) style.borderRight = rightB;
      if (topB) style.borderTop = topB;
      if (bottomB) style.borderBottom = bottomB;
    }
    return style;
  };

  const renderTable = (table: TableElement, index: number) => {
    const tp = table.tblProps;
    const tblStyles = tableStylesRef.current;
    const styleDef = tp?.tblStyleId ? tblStyles.get(tp.tblStyleId) : undefined;
    const tblBg = tp?.backgroundColor || styleDef?.wholeTbl?.fillColor || 'transparent';

    // Determine cell background: explicit fill > table style > table bg
    const getCellBg = (cell: TableCell, rowIdx: number, _colIdx: number): string | undefined => {
      if (cell.noFill) return 'transparent';
      if (cell.backgroundColor) return cell.backgroundColor;

      if (styleDef) {
        if (tp?.firstRow && rowIdx === 0 && styleDef.firstRow?.fillColor) return styleDef.firstRow.fillColor;
        if (tp?.lastRow && rowIdx === table.rows.length - 1 && styleDef.lastRow?.fillColor) return styleDef.lastRow.fillColor;
        if (tp?.firstCol && _colIdx === 0 && styleDef.firstCol?.fillColor) return styleDef.firstCol.fillColor;
        if (tp?.bandRow) {
          const dataRow = tp.firstRow ? rowIdx - 1 : rowIdx;
          if (dataRow >= 0) {
            const band = dataRow % 2 === 0 ? styleDef.band1H : styleDef.band2H;
            if (band?.fillColor) return band.fillColor;
          }
        }
        if (styleDef.wholeTbl?.fillColor) return styleDef.wholeTbl.fillColor;
      }

      return undefined;
    };

    // Get text style from table style
    const getCellTextStyle = (rowIdx: number, _colIdx: number): React.CSSProperties => {
      if (!styleDef) return {};
      const style: React.CSSProperties = {};
      if (tp?.firstRow && rowIdx === 0 && styleDef.firstRow) {
        if (styleDef.firstRow.fontColor) style.color = styleDef.firstRow.fontColor;
        if (styleDef.firstRow.fontBold) style.fontWeight = 'bold';
      } else if (tp?.lastRow && rowIdx === table.rows.length - 1 && styleDef.lastRow) {
        if (styleDef.lastRow.fontColor) style.color = styleDef.lastRow.fontColor;
        if (styleDef.lastRow.fontBold) style.fontWeight = 'bold';
      } else if (tp?.firstCol && _colIdx === 0 && styleDef.firstCol) {
        if (styleDef.firstCol.fontColor) style.color = styleDef.firstCol.fontColor;
        if (styleDef.firstCol.fontBold) style.fontWeight = 'bold';
      }
      return style;
    };

    return (
      <div
        key={index}
        ref={(el) => {
          // Auto-shrink table: apply zoom to fit table within frame height
          if (el) {
            const shrinkTable = () => {
              const frameH = table.frameHeight || table.height;
              const tblEl = el.querySelector('table') as HTMLTableElement;
              if (!tblEl || frameH <= 0) return;
              // Reset zoom first to get true content height
              (tblEl.style as any).zoom = '1';
              const actualH = tblEl.scrollHeight;
              if (actualH > frameH + 2) {
                const ratio = Math.max(frameH / actualH, 0.3);
                (tblEl.style as any).zoom = String(ratio);
              }
            };
            // Run twice: once immediately after paint, once after fonts/layout settle
            requestAnimationFrame(shrinkTable);
            setTimeout(shrinkTable, 100);
          }
        }}
        style={{
          position: 'absolute',
          left: table.x,
          top: table.y,
          width: table.width,
          height: table.frameHeight || table.height,
          overflow: 'hidden',
        }}
      >
        <table
          className="pptx-table"
          style={{
            width: table.width,
            borderCollapse: 'collapse',
            tableLayout: 'fixed',
            backgroundColor: tblBg,
          }}
        >
          <colgroup>
            {table.colWidths.map((w, i) => (
              <col key={i} style={{ width: w }} />
            ))}
          </colgroup>
          <tbody>
            {table.rows.map((row, rowIdx) => (
              <tr key={rowIdx} style={{ height: row.height }}>
                {row.cells.map((cell, cellIdx) => (
                  <td
                    key={cellIdx}
                    colSpan={cell.colSpan}
                    rowSpan={cell.rowSpan}
                    style={{
                      backgroundColor: getCellBg(cell, rowIdx, cellIdx),
                      ...buildCellBorderStyle(cell, styleDef?.wholeTbl?.borders, rowIdx, cellIdx, table.rows.length, table.colWidths.length),
                      ...getCellTextStyle(rowIdx, cellIdx),
                      padding: cell.margins
                        ? `${cell.margins.top}px ${cell.margins.right}px ${cell.margins.bottom}px ${cell.margins.left}px`
                        : '5px 10px',
                      verticalAlign: cell.vertAlign || 'middle',
                      wordBreak: 'break-word',
                      overflow: 'hidden',
                    }}
                  >
                    {cell.paragraphs.map((para, paraIdx) => renderParagraph(para, paraIdx, true))}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  };

  // CSS transform for rotation + flip
  const buildTransform = (s: ShapeElement): string | undefined => {
    const transforms: string[] = [];
    if (s.rotation) transforms.push(`rotate(${s.rotation}deg)`);
    if (s.flipH) transforms.push('scaleX(-1)');
    if (s.flipV) transforms.push('scaleY(-1)');
    return transforms.length > 0 ? transforms.join(' ') : undefined;
  };

  const renderShape = (shape: SlideShape, index: number, imageMap: Map<string, string>): React.ReactNode => {
    // Group shape
    if (shape.type === 'group') {
      const group = shape as GroupShapeElement;
      const scaleX = group.childExtX > 0 ? group.width / group.childExtX : 1;
      const scaleY = group.childExtY > 0 ? group.height / group.childExtY : 1;
      const transforms: string[] = [];
      if (group.rotation) transforms.push(`rotate(${group.rotation}deg)`);
      if (group.flipH) transforms.push('scaleX(-1)');
      if (group.flipV) transforms.push('scaleY(-1)');

      // Use CSS transform scale so text inside groups also scales proportionally
      const needsScale = Math.abs(scaleX - 1) > 0.001 || Math.abs(scaleY - 1) > 0.001;
      const innerW = needsScale ? group.childExtX : group.width;
      const innerH = needsScale ? group.childExtY : group.height;

      if (needsScale) {
        transforms.push(`scale(${scaleX}, ${scaleY})`);
      }

      return (
        <div
          key={index}
          style={{
            position: 'absolute',
            left: group.x,
            top: group.y,
            width: innerW,
            height: innerH,
            transformOrigin: 'top left',
            transform: transforms.length > 0 ? transforms.join(' ') : undefined,
            overflow: 'visible',
          }}
        >
          {group.children.map((child, ci) => {
            const mapped = { ...child } as any;
            mapped.x = child.x - group.childOffsetX;
            mapped.y = child.y - group.childOffsetY;
            // Don't manually scale width/height — CSS transform handles it
            return renderShape(mapped, ci, imageMap);
          })}
        </div>
      );
    }

    // Table
    if (shape.type === 'table') {
      return renderTable(shape as TableElement, index);
    }

    const shapeElement = shape as ShapeElement;

    // Image
    if (shapeElement.type === 'image') {
      const imageSrc = shapeElement.imageRelId ? imageMap.get(shapeElement.imageRelId) : undefined;
      if (!imageSrc) return null;

      const crop = shapeElement.imageCrop;
      const hasCrop = crop && (crop.left > 0 || crop.top > 0 || crop.right > 0 || crop.bottom > 0);
      const duo = shapeElement.duotoneColors;

      // Build duotone SVG filter if needed
      let duoFilterId: string | undefined;
      let duoFilterSvg: React.ReactNode = null;
      if (duo) {
        duoFilterId = `duo-${index}`;
        const shadow = hexToRgb(duo[0]);
        const highlight = hexToRgb(duo[1]);
        duoFilterSvg = (
          <svg width="0" height="0" style={{ position: 'absolute' }}>
            <defs>
              <filter id={duoFilterId} colorInterpolationFilters="sRGB">
                <feColorMatrix type="saturate" values="0" />
                <feComponentTransfer>
                  <feFuncR type="table" tableValues={`${shadow.r / 255} ${highlight.r / 255}`} />
                  <feFuncG type="table" tableValues={`${shadow.g / 255} ${highlight.g / 255}`} />
                  <feFuncB type="table" tableValues={`${shadow.b / 255} ${highlight.b / 255}`} />
                </feComponentTransfer>
              </filter>
            </defs>
          </svg>
        );
      }
      const imgFilter = duoFilterId ? `url(#${duoFilterId})` : undefined;

      if (hasCrop && crop) {
        const visibleW = 100 - crop.left - crop.right;
        const visibleH = 100 - crop.top - crop.bottom;
        return (
          <div
            key={index}
            style={{
              position: 'absolute',
              left: shapeElement.x,
              top: shapeElement.y,
              width: shapeElement.width,
              height: shapeElement.height,
              overflow: 'hidden',
              transform: buildTransform(shapeElement),
            }}
          >
            {duoFilterSvg}
            <img
              src={imageSrc}
              alt=""
              style={{
                position: 'absolute',
                left: `${(-crop.left / visibleW) * 100}%`,
                top: `${(-crop.top / visibleH) * 100}%`,
                width: `${10000 / visibleW}%`,
                height: `${10000 / visibleH}%`,
                filter: imgFilter,
              }}
            />
          </div>
        );
      }

      return (
        <React.Fragment key={index}>
          {duoFilterSvg}
          <img
            src={imageSrc}
            alt=""
            style={{
              position: 'absolute',
              left: shapeElement.x,
              top: shapeElement.y,
              width: shapeElement.width,
              height: shapeElement.height,
              objectFit: 'fill',
              transform: buildTransform(shapeElement),
              filter: imgFilter,
            }}
          />
        </React.Fragment>
      );
    }

    // Line/connector — uses buildConnectorPath for bent/curved routing
    if (shapeElement.type === 'line') {
      const w = shapeElement.width || 1;
      const h = shapeElement.height || 1;
      const color = shapeElement.borderColor || '#000';
      const strokeW = Math.max(shapeElement.borderWidth || 1, 0.5);
      const hasHead = shapeElement.headEnd && shapeElement.headEnd.type !== 'none';
      const hasTail = shapeElement.tailEnd && shapeElement.tailEnd.type !== 'none';
      const markerId = `arrow-${index}`;
      const pad = strokeW * 4;
      const svgW = Math.max(w, 1) + pad * 2;
      const svgH = Math.max(h, 1) + pad * 2;

      let strokeDasharray: string | undefined;
      let strokeLinecap: string | undefined;
      if (shapeElement.dashStyle) {
        // OOXML dash patterns: multipliers relative to stroke width
        const dashMul: Record<string, number[]> = {
          'dash': [4, 3], 'dot': [1, 3], 'dashDot': [4, 3, 1, 3],
          'lgDash': [8, 3], 'lgDashDot': [8, 3, 1, 3], 'lgDashDotDot': [8, 3, 1, 3, 1, 3],
          'sysDash': [3, 1], 'sysDot': [1, 1],
          'sysDashDot': [3, 1, 1, 1], 'sysDashDotDot': [3, 1, 1, 1, 1, 1],
        };
        const muls = dashMul[shapeElement.dashStyle];
        if (muls) {
          const sw = Math.max(strokeW, 1);
          strokeDasharray = muls.map(m => Math.max(m * sw, 0.5)).join(' ');
        }
        if (shapeElement.dashStyle.toLowerCase().includes('dot')) {
          strokeLinecap = 'round';
        }
      }

      // Build connector path (straight, bent, or curved)
      const connType = shapeElement.connectorType || 'straightConnector1';
      const adjValues = shapeElement.adjustValues || {};
      const connPath = buildConnectorPath(w, h, connType, adjValues, pad);

      // Arrow marker shapes based on type — use userSpaceOnUse for absolute sizing
      const renderMarker = (end: ArrowHead, id: string, isHead: boolean) => {
        // PowerPoint arrow head sizing — base + proportional to stroke width
        // PPT default (med, 1pt line): ~9px wide, ~11px long
        // For thicker lines, arrow scales but not as fast as lineWidth
        const baseW: Record<string, number> = { 'sm': 6, 'med': 9, 'lg': 14 };
        const baseH: Record<string, number> = { 'sm': 7, 'med': 11, 'lg': 16 };
        const extraW: Record<string, number> = { 'sm': 1.5, 'med': 2.5, 'lg': 4 };
        const extraH: Record<string, number> = { 'sm': 2, 'med': 3, 'lg': 5 };
        const wKey = end.w || 'med';
        const hKey = end.len || 'med';
        const mw = (baseW[wKey] || 9) + (extraW[wKey] || 2.5) * strokeW;
        const mh = (baseH[hKey] || 11) + (extraH[hKey] || 3) * strokeW;
        const refX = isHead ? 1 : mw - 1;
        let shape: React.ReactNode;
        if (end.type === 'oval') {
          shape = <ellipse cx={mw / 2} cy={mh / 2} rx={mw / 2} ry={mh / 2} fill={color} />;
        } else if (end.type === 'diamond') {
          shape = <polygon points={`${mw / 2} 0, ${mw} ${mh / 2}, ${mw / 2} ${mh}, 0 ${mh / 2}`} fill={color} />;
        } else if (end.type === 'stealth') {
          const pts = isHead
            ? `${mw} 0, 0 ${mh / 2}, ${mw} ${mh}, ${mw * 0.65} ${mh / 2}`
            : `0 0, ${mw} ${mh / 2}, 0 ${mh}, ${mw * 0.35} ${mh / 2}`;
          shape = <polygon points={pts} fill={color} />;
        } else {
          // triangle (default)
          const pts = isHead
            ? `${mw} 0, 0 ${mh / 2}, ${mw} ${mh}`
            : `0 0, ${mw} ${mh / 2}, 0 ${mh}`;
          shape = <polygon points={pts} fill={color} />;
        }
        return (
          <marker key={id} id={id} markerWidth={mw} markerHeight={mh}
            refX={refX} refY={mh / 2} orient="auto" markerUnits="userSpaceOnUse">
            {shape}
          </marker>
        );
      };

      return (
        <svg
          key={index}
          style={{
            position: 'absolute',
            left: shapeElement.x - pad,
            top: shapeElement.y - pad,
            width: svgW,
            height: svgH,
            overflow: 'visible',
            transform: buildTransform(shapeElement),
            transformOrigin: 'center',
          }}
        >
          <defs>
            {hasTail && shapeElement.tailEnd && renderMarker(shapeElement.tailEnd, `${markerId}-tail`, false)}
            {hasHead && shapeElement.headEnd && renderMarker(shapeElement.headEnd, `${markerId}-head`, true)}
          </defs>
          <path
            d={connPath}
            fill="none"
            stroke={color}
            strokeWidth={strokeW}
            strokeDasharray={strokeDasharray}
            strokeLinecap={strokeLinecap as any || 'flat'}
            strokeLinejoin="round"
            markerStart={hasHead ? `url(#${markerId}-head)` : undefined}
            markerEnd={hasTail ? `url(#${markerId}-tail)` : undefined}
          />
        </svg>
      );
    }

    // ─── Unified shape rendering (SVG path or div fallback) ───
    const tb = shapeElement.textBody;
    const isNoWrap = tb?.wrap === 'none';
    const vertAlignMap: Record<string, string> = { 'top': 'flex-start', 'middle': 'center', 'bottom': 'flex-end' };
    const hasText = shapeElement.paragraphs?.some(p => p.runs.some(r => r.text.length > 0));

    // Shadow CSS
    const shadowStyle: React.CSSProperties = {};
    if (shapeElement.shadow) {
      const s = shapeElement.shadow;
      if (s.inset) {
        shadowStyle.boxShadow = `inset ${s.offsetX}px ${s.offsetY}px ${s.blur}px ${s.color}`;
      } else {
        shadowStyle.filter = `drop-shadow(${s.offsetX}px ${s.offsetY}px ${s.blur}px ${s.color})`;
      }
    }

    // AutoFit font scale
    const fontScaleStyle: React.CSSProperties = {};
    if (tb?.fontScale && tb.fontScale < 1) {
      fontScaleStyle.fontSize = `${Math.round(tb.fontScale * 100)}%`;
    }
    if (tb?.lnSpcReduction && tb.lnSpcReduction > 0) {
      // Reduce from default 1.2 line height (not percentage of font-size)
      const reducedLineHeight = 1.2 * (1 - tb.lnSpcReduction);
      fontScaleStyle.lineHeight = reducedLineHeight.toFixed(2);
    }

    // Resolve SVG path: customPath > PRESET_SHAPE_PATHS > null (div fallback)
    const shapeType = shapeElement.shapeType;
    let svgPath: string | null = null;
    if (shapeElement.customPath) {
      svgPath = shapeElement.customPath;
    } else if (shapeType && PRESET_SHAPE_PATHS[shapeType]) {
      svgPath = PRESET_SHAPE_PATHS[shapeType](shapeElement.width, shapeElement.height, shapeElement.adjustValues);
    }

    // Auto-shrink text ref callback: use CSS zoom to fit overflowing text
    const autoShrinkRef = (el: HTMLDivElement | null) => {
      if (!el || isNoWrap) return;
      requestAnimationFrame(() => {
        const containerH = el.clientHeight;
        const contentH = el.scrollHeight;
        if (contentH > containerH + 2 && containerH > 0) {
          // Direct ratio calculation: zoom = container / content, clamped to [0.4, 0.95]
          const z = Math.max(Math.min(containerH / contentH, 0.95), 0.4);
          (el.style as any).zoom = String(z);
        }
      });
    };

    // Text overlay for SVG shapes
    const renderTextOverlay = () => {
      if (!hasText) return null;
      return (
        <div ref={autoShrinkRef} style={{
          position: 'relative', zIndex: 1, display: 'flex',
          flexDirection: tb?.verticalText ? 'row' : 'column',
          justifyContent: tb ? vertAlignMap[tb.verticalAlign || 'top'] || 'flex-start' : 'center',
          width: '100%', height: '100%',
          padding: tb ? `${tb.paddingTop}px ${tb.paddingRight}px ${tb.paddingBottom}px ${tb.paddingLeft}px` : '4px 8px',
          boxSizing: 'border-box',
          whiteSpace: isNoWrap ? 'nowrap' : undefined,
          writingMode: tb?.verticalText ? 'vertical-rl' : undefined,
          overflow: isNoWrap ? 'visible' : 'hidden',
          ...fontScaleStyle,
        }}>
          {shapeElement.paragraphs?.map((para, i) => renderParagraph(para, i))}
        </div>
      );
    };

    // SVG path rendering
    if (svgPath) {
      const w = shapeElement.width;
      const h = shapeElement.height;
      const strokeColor = shapeElement.borderColor || 'none';
      const strokeW = shapeElement.borderWidth || 0;
      const gradId = `grad-shape-${index}`;
      const hasGradient = !!shapeElement.gradientFill;
      const fillColor = hasGradient ? `url(#${gradId})` : (shapeElement.backgroundColor || 'transparent');

      let strokeDasharray: string | undefined;
      let shapeStrokeLinecap: string | undefined;
      if (shapeElement.dashStyle) {
        const dashMul: Record<string, number[]> = {
          'dash': [4, 3], 'dot': [1, 3], 'dashDot': [4, 3, 1, 3],
          'lgDash': [8, 3], 'lgDashDot': [8, 3, 1, 3], 'lgDashDotDot': [8, 3, 1, 3, 1, 3],
          'sysDash': [3, 1], 'sysDot': [1, 1],
          'sysDashDot': [3, 1, 1, 1], 'sysDashDotDot': [3, 1, 1, 1, 1, 1],
        };
        const muls = dashMul[shapeElement.dashStyle];
        if (muls) {
          const sw = Math.max(strokeW, 1);
          strokeDasharray = muls.map(m => Math.max(m * sw, 0.5)).join(' ');
        }
        if (shapeElement.dashStyle.toLowerCase().includes('dot')) {
          shapeStrokeLinecap = 'round';
        }
      }

      return (
        <div
          key={index}
          style={{
            position: 'absolute',
            left: shapeElement.x,
            top: shapeElement.y,
            width: w,
            height: h,
            transform: buildTransform(shapeElement),
            ...shadowStyle,
          }}
        >
          <svg width={w} height={h} style={{ position: 'absolute', top: 0, left: 0, overflow: 'visible' }}>
            {hasGradient && shapeElement.gradientFill && (
              <defs>
                {shapeElement.gradientFill.type === 'linear' ? (
                  <linearGradient id={gradId}
                    x1={`${50 - 50 * Math.cos((shapeElement.gradientFill.angle || 0) * Math.PI / 180)}%`}
                    y1={`${50 - 50 * Math.sin((shapeElement.gradientFill.angle || 0) * Math.PI / 180)}%`}
                    x2={`${50 + 50 * Math.cos((shapeElement.gradientFill.angle || 0) * Math.PI / 180)}%`}
                    y2={`${50 + 50 * Math.sin((shapeElement.gradientFill.angle || 0) * Math.PI / 180)}%`}
                  >
                    {shapeElement.gradientFill.stops.map((stop, si) => (
                      <stop key={si} offset={`${stop.position}%`} stopColor={stop.color} />
                    ))}
                  </linearGradient>
                ) : (
                  <radialGradient id={gradId}>
                    {shapeElement.gradientFill.stops.map((stop, si) => (
                      <stop key={si} offset={`${stop.position}%`} stopColor={stop.color} />
                    ))}
                  </radialGradient>
                )}
              </defs>
            )}
            <path d={svgPath} fill={fillColor} stroke={strokeColor} strokeWidth={strokeW}
              strokeDasharray={strokeDasharray} strokeLinecap={shapeStrokeLinecap as any} fillRule="evenodd" />
          </svg>
          {renderTextOverlay()}
        </div>
      );
    }

    // Div fallback (rect without preset, unknown shapes)
    const bgStyle: React.CSSProperties = {};
    if (shapeElement.gradientFill) {
      bgStyle.background = gradientToCSS(shapeElement.gradientFill);
    } else if (shapeElement.backgroundColor) {
      bgStyle.backgroundColor = shapeElement.backgroundColor;
    }
    if (shapeElement.borderColor && shapeElement.borderWidth) {
      const borderStyle = shapeElement.dashStyle
        ? (shapeElement.dashStyle.includes('dot') || shapeElement.dashStyle === 'sysDot' ? 'dotted' : 'dashed')
        : 'solid';
      bgStyle.border = `${shapeElement.borderWidth}px ${borderStyle} ${shapeElement.borderColor}`;
    }

    return (
      <div
        key={index}
        ref={autoShrinkRef}
        className="pptx-shape"
        style={{
          position: 'absolute',
          left: shapeElement.x,
          top: shapeElement.y,
          width: shapeElement.width,
          height: shapeElement.height,
          ...bgStyle,
          ...shadowStyle,
          transform: buildTransform(shapeElement),
          overflow: isNoWrap ? 'visible' : 'hidden',
          display: 'flex',
          flexDirection: tb?.verticalText ? 'row' : 'column',
          justifyContent: tb ? vertAlignMap[tb.verticalAlign || 'top'] || 'flex-start' : 'center',
          padding: tb
            ? `${tb.paddingTop}px ${tb.paddingRight}px ${tb.paddingBottom}px ${tb.paddingLeft}px`
            : '4px 8px',
          boxSizing: 'border-box',
          whiteSpace: isNoWrap ? 'nowrap' : undefined,
          writingMode: tb?.verticalText ? 'vertical-rl' : undefined,
          ...fontScaleStyle,
        }}
      >
        {shapeElement.paragraphs?.map((para, i) => renderParagraph(para, i))}
      </div>
    );
  };

  // Slide background style
  const getSlideBackgroundStyle = (slide: SlideData, imageMap: Map<string, string>): React.CSSProperties => {
    const bg = slide.background;
    if (!bg) return { backgroundColor: '#ffffff' };

    if (bg.gradient) {
      return { background: gradientToCSS(bg.gradient) };
    }

    if (bg.imageRelId) {
      const imageSrc = imageMap.get(bg.imageRelId);
      if (imageSrc) {
        return {
          backgroundImage: `url(${imageSrc})`,
          backgroundSize: '100% 100%',
          backgroundPosition: '0 0',
          backgroundRepeat: 'no-repeat',
        };
      }
    }

    return { backgroundColor: bg.color || '#ffffff' };
  };

  return (
    <div ref={containerRef} className="office-viewer-container pptx-viewer">
      <div className="pptx-toolbar">
        <span className="pptx-slide-indicator">
          {visibleSlide + 1} / {slides.length}
        </span>
        <span className="pptx-zoom-indicator">{Math.round(zoom * 100)}%</span>
      </div>

      <div className="pptx-slides-scroll-container" ref={scrollContainerRef}>
        {slides.map((slide, idx) => {
          const imageMap = slideImages.get(idx) || new Map();
          return (
            <div
              key={idx}
              style={{
                width: slideSize.width * zoom,
                height: slideSize.height * zoom,
                flexShrink: 0,
              }}
            >
              <div
                ref={el => { slideRefs.current[idx] = el; }}
                className="pptx-slide"
                style={{
                  width: slideSize.width,
                  height: slideSize.height,
                  transform: `scale(${zoom})`,
                  transformOrigin: 'top left',
                  position: 'relative',
                  ...getSlideBackgroundStyle(slide, imageMap),
                }}
              >
                {slide.shapes.map((shape, si) => renderShape(shape, si, imageMap))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default PptxViewer;
