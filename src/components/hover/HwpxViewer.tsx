import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import JSZip from 'jszip';

interface HwpxViewerProps {
  data: ArrayBuffer;
}

// HWPX units: 7200 hwpunit = 1 inch = 96 CSS pixels
const HWPUNIT_PER_PIXEL = 7200 / 96;

/** Parse HWPX integer that may be uint32-encoded signed int32 (e.g., 4294967281 = -15) */
function parseHwpInt(val: string): number {
  const n = parseInt(val);
  return n > 0x7FFFFFFF ? n - 0x100000000 : n;
}

const DEV = import.meta.env.DEV;
const log = DEV ? console.log.bind(console) : (() => {}) as (...args: unknown[]) => void;

// ==================== Interfaces ====================

interface TextRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  fontSize?: number;
  fontFamily?: string;
  color?: string;
  backgroundColor?: string;
  superscript?: boolean;
  subscript?: boolean;
  isTab?: boolean;
  tabLeader?: string;
  tabWidth?: number;
  equationHtml?: string;
  letterSpacing?: number;  // 자간 (% of font size)
  charRatio?: number;      // 장평 (character width %)
}

interface TabStop {
  pos: number;
  type: 'LEFT' | 'RIGHT' | 'CENTER';
  leader: string;
}

interface Paragraph {
  runs: TextRun[];
  align?: 'left' | 'center' | 'right' | 'justify' | 'distribute';
  lineHeight?: number | string;
  marginTop?: number;
  marginBottom?: number;
  indent?: number;
  marginLeft?: number;
  isHeading?: boolean;
  headingLevel?: number;
  bulletChar?: string;
  numberingText?: string;
  numberingStyle?: Partial<TextRun>;
  tabStops?: TabStop[];
  pageBreakBefore?: boolean;
}

interface BorderStyle {
  width?: number;
  color?: string;
  type?: string;
}

interface TableCell {
  content: ContentItem[];
  colSpan: number;
  rowSpan: number;
  colAddr: number;
  rowAddr: number;
  width: number;
  height: number;
  backgroundColor?: string;
  backgroundImgRef?: string;
  borderTop?: BorderStyle;
  borderBottom?: BorderStyle;
  borderLeft?: BorderStyle;
  borderRight?: BorderStyle;
  vertAlign?: 'top' | 'middle' | 'bottom';
}

interface TableRow {
  cells: TableCell[];
  height?: number;
}

interface Table {
  rows: TableRow[];
  width?: number;
  colWidths: number[];
  rowCnt: number;
  colCnt: number;
  caption?: string;
  captionSide?: 'TOP' | 'BOTTOM';
}

interface ImageElement {
  id: string;
  width: number;
  height: number;
  inline?: boolean;
  src?: string;
  caption?: string;
  captionSide?: 'TOP' | 'BOTTOM';
  horzAlign?: string;
  orgWidth?: number;
  orgHeight?: number;
  imgClip?: { left: number; right: number; top: number; bottom: number };
  imgDimWidth?: number;
  imgDimHeight?: number;
  textWrap?: string;
  vertOffset?: number;
  horzOffset?: number;
  zOrder?: number;
}

interface EquationElement {
  script: string;
  width: number;
  height: number;
  baseLine?: number;
  baseUnit?: number;
  inline?: boolean;
}

interface TextBoxElement {
  paragraphs: Paragraph[];
  width: number;
  height: number;
  textWrap?: string;
  vertOffset?: number;
  horzOffset?: number;
  vertRelTo?: string;
  zOrder?: number;
  vertAlign?: string;
}

interface FootnoteData {
  number: number;
  content: ContentItem[];
  marker?: string;
  pageIndex?: number;
}

type ContentItem =
  | { type: 'paragraph'; data: Paragraph; pageIndex?: number }
  | { type: 'table'; data: Table; pageIndex?: number }
  | { type: 'image'; data: ImageElement; pageIndex?: number }
  | { type: 'equation'; data: EquationElement; pageIndex?: number }
  | { type: 'textBox'; data: TextBoxElement; pageIndex?: number };

interface Section {
  content: ContentItem[];
  pageWidth?: number;
  pageHeight?: number;
  marginLeft?: number;
  marginRight?: number;
  marginTop?: number;
  marginBottom?: number;
  headerMargin?: number;
  footerMargin?: number;
  pageNumPos?: string;
  pageNumSideChar?: string;
  pageNumHidden?: boolean;
  pageStartNo?: number;
  pageNumResets?: Map<number, number>; // pageIndex → new start number (from newNum PAGE)
  hiddenPageNumPages?: Set<number>;
  footerContent?: ContentItem[];
  headerContent?: ContentItem[];
  footnotes?: FootnoteData[];
}

// ==================== Header Style Definitions ====================

interface CharPropDef {
  height: number;
  textColor: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strikethrough: boolean;
  superscript: boolean;
  subscript: boolean;
  hangulFontId: number;
  latinFontId: number;
  spacing?: number;  // 자간 (% of font size, e.g., -5 = tighter)
  ratio?: number;    // 장평 (character width %, e.g., 80 = narrower)
}

interface NumberingLevelDef {
  format: string;
  numFormat: string;
  textOffset: number;
  start: number;
  charPrIDRef?: number;
}

interface NumberingDef {
  start: number;
  levels: Map<number, NumberingLevelDef>;
}

interface BulletDef {
  char: string;
}

interface ParaPropDef {
  align: 'left' | 'center' | 'right' | 'justify' | 'distribute';
  lineSpacingType: string;
  lineSpacingValue: number;
  indent: number;
  marginLeft: number;
  marginRight: number;
  marginTop: number;
  marginBottom: number;
  headingType?: string;
  headingIdRef?: number;
  headingLevel?: number;
  tabStops?: TabStop[];
  pageBreakBefore?: boolean;
}

interface BorderFillDef {
  leftBorder: BorderStyle;
  rightBorder: BorderStyle;
  topBorder: BorderStyle;
  bottomBorder: BorderStyle;
  fillColor?: string;
  imgRef?: string;
}

interface HeaderData {
  charProps: Map<number, CharPropDef>;
  paraProps: Map<number, ParaPropDef>;
  hangulFonts: Map<number, string>;
  latinFonts: Map<number, string>;
  borderFills: Map<number, BorderFillDef>;
  numberings: Map<number, NumberingDef>;
  bullets: Map<number, BulletDef>;
  tabDefs: Map<number, TabStop[]>;
}

/** Auto-numbering counters for PICTURE, TABLE, EQUATION */
interface AutoNumCounters {
  PICTURE: number;
  TABLE: number;
  EQUATION: number;
  PAGE: number;
  [key: string]: number;
}

// ==================== XML Helpers ====================

function directChildren(parent: Element, localName: string): Element[] {
  const results: Element[] = [];
  for (let i = 0; i < parent.children.length; i++) {
    const child = parent.children[i];
    const tag = child.localName || child.tagName.split(':').pop() || '';
    if (tag === localName) results.push(child);
  }
  return results;
}

function directChild(parent: Element, localName: string): Element | null {
  for (let i = 0; i < parent.children.length; i++) {
    const child = parent.children[i];
    const tag = child.localName || child.tagName.split(':').pop() || '';
    if (tag === localName) return child;
  }
  return null;
}

function findElement(parent: Element, localName: string): Element | null {
  return parent.getElementsByTagName(`hp:${localName}`)[0] ||
         parent.getElementsByTagName(`hh:${localName}`)[0] ||
         parent.getElementsByTagName(`hc:${localName}`)[0] ||
         parent.getElementsByTagName(localName)[0] || null;
}

// ==================== Character Mapping ====================

/** Map PUA (Private Use Area) character codes to Unicode equivalents (Wingdings/Symbol/HWP) */
function mapPuaChar(code: number): string {
  // PUA range 0xF020-0xF0FF: Wingdings/HWP symbol characters
  if (code >= 0xF020 && code <= 0xF0FF) {
    const wc = code - 0xF000;
    const MAP: Record<number, number> = {
      0x6B: 0x263A, 0x6C: 0x2605, 0x6D: 0x2606, 0x6E: 0x2611, 0x6F: 0x2610,
      0x71: 0x2612, 0x73: 0x25C6, 0x75: 0x25C6, 0x76: 0x25CF, 0x77: 0x25CB,
      0x9E: 0x25CB, 0x9F: 0x25CF, // ○ ● (common HWP bullet)
      0xA1: 0x270E, 0xA3: 0x2702, 0xA4: 0x2709, 0xA5: 0x270D,
      0xA7: 0x25AA, 0xA8: 0x25A0, 0xA9: 0x25A1, 0xAA: 0x25A3,
      0xB6: 0x25B6, 0xB7: 0x25C0, // ▶ ◀
      0xD5: 0x232B, 0xFC: 0x2714, 0xFD: 0x2718, 0xFE: 0x2716,
    };
    const mapped = MAP[wc];
    if (mapped) return String.fromCodePoint(mapped);
    // Fallback for unmapped PUA: use common bullet
    return '●';
  }
  return String.fromCodePoint(code);
}

// ==================== Number Formatting ====================

function formatNumber(num: number, numFormat: string): string {
  const hangulSyllables = ['가', '나', '다', '라', '마', '바', '사', '아', '자', '차', '카', '타', '파', '하'];
  const hangulJamo = ['ㄱ', 'ㄴ', 'ㄷ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅅ', 'ㅇ', 'ㅈ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];
  switch (numFormat) {
    case 'DIGIT':
      return String(num);
    case 'CIRCLED_DIGIT': {
      // ① ② ③ ... ⑳
      if (num >= 1 && num <= 20) return String.fromCharCode(0x2460 + num - 1);
      return String(num);
    }
    case 'ROMAN_CAPITAL': {
      const vals = [1000, 900, 500, 400, 100, 90, 50, 40, 10, 9, 5, 4, 1];
      const syms = ['M', 'CM', 'D', 'CD', 'C', 'XC', 'L', 'XL', 'X', 'IX', 'V', 'IV', 'I'];
      let result = '';
      let n = num;
      for (let i = 0; i < vals.length && n > 0; i++) {
        while (n >= vals[i]) { result += syms[i]; n -= vals[i]; }
      }
      return result || String(num);
    }
    case 'ROMAN_SMALL':
      return formatNumber(num, 'ROMAN_CAPITAL').toLowerCase();
    case 'LATIN_CAPITAL':
      return num >= 1 && num <= 26 ? String.fromCharCode(64 + num) : String(num);
    case 'LATIN_SMALL':
      return num >= 1 && num <= 26 ? String.fromCharCode(96 + num) : String(num);
    case 'CIRCLED_LATIN_SMALL': {
      // ⓐ ⓑ ⓒ ...
      if (num >= 1 && num <= 26) return String.fromCharCode(0x24D0 + num - 1);
      return String.fromCharCode(96 + num);
    }
    case 'HANGUL':
    case 'HANGUL_SYLLABLE': {
      return hangulSyllables[num - 1] || String(num);
    }
    case 'CIRCLED_HANGUL_SYLLABLE': {
      // ㉮ ㉯ ㉰ ... (U+326E+)
      if (num >= 1 && num <= 14) return String.fromCharCode(0x326E + num - 1);
      return hangulSyllables[num - 1] || String(num);
    }
    case 'HANGUL_JAMO': {
      return hangulJamo[num - 1] || String(num);
    }
    default:
      return String(num);
  }
}

// ==================== Equation Script Renderer ====================

/** Symbol mapping for Hangul equation scripts (sorted longest-first for matching) */
const EQ_SYMBOLS: [string, string][] = [
  // Multi-char first (longest match) — uppercase Greek
  ['TRIANGLE', 'Δ'], ['APPROX', '≈'], ['EQUIV', '≡'], ['SUBSET', '⊂'], ['SUPSET', '⊃'],
  ['UNION', '∪'], ['INTER', '∩'],
  ['DELTA', 'Δ'], ['SIGMA', 'Σ'], ['OMEGA', 'Ω'], ['THETA', 'Θ'],
  ['GAMMA', 'Γ'], ['LAMBDA', 'Λ'], ['ALPHA', 'Α'], ['BETA', 'Β'],
  ['EPSILON', 'Ε'], ['KAPPA', 'Κ'], ['XI', 'Ξ'], ['PSI', 'Ψ'],
  // Operators & dots
  ['TIMES', '×'], ['CDOTS', '⋯'], ['CDOT', '·'],
  ['LDOTS', '…'], ['VDOTS', '⋮'], ['DDOTS', '⋱'],
  // Lowercase Greek
  ['alpha', 'α'], ['beta', 'β'], ['gamma', 'γ'], ['delta', 'δ'], ['epsilon', 'ε'],
  ['zeta', 'ζ'], ['eta', 'η'], ['theta', 'θ'], ['iota', 'ι'], ['kappa', 'κ'],
  ['lambda', 'λ'], ['mu', 'μ'], ['nu', 'ν'], ['xi', 'ξ'], ['pi', 'π'],
  ['rho', 'ρ'], ['sigma', 'σ'], ['tau', 'τ'], ['upsilon', 'υ'], ['phi', 'φ'],
  ['chi', 'χ'], ['psi', 'ψ'], ['omega', 'ω'],
  // Operators & relations
  ['partial', '∂'], ['infty', '∞'], ['inf', '∞'], ['neq', '≠'],
  ['leq', '≤'], ['geq', '≥'], ['LEQ', '≤'], ['GEQ', '≥'], ['NEQ', '≠'],
  ['INF', '∞'], ['PHI', 'Φ'], ['PI', 'Π'],
  ['cdots', '⋯'], ['ldots', '…'], ['vdots', '⋮'], ['ddots', '⋱'],
  ['pm', '±'], ['mp', '∓'], ['cdot', '·'], ['times', '×'], ['div', '÷'],
  ['rarrow', '→'], ['larrow', '←'], ['darrow', '↓'], ['uarrow', '↑'],
  ['lrarrow', '↔'], ['Rarrow', '⇒'], ['Larrow', '⇐'],
  ['forall', '∀'], ['exists', '∃'], ['in', '∈'], ['notin', '∉'],
  ['nabla', '∇'], ['hbar', 'ℏ'], ['ell', 'ℓ'],
  ['prime', '′'], ['dprime', '″'],
];

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Parse Hangul equation script and convert to HTML with proper math formatting.
 * Handles: subscripts, superscripts, fractions (over), sqrt, sum/prod/int with limits,
 * Greek letters, grouping with braces, rm (roman), backtick (space), # (newline).
 */
function equationScriptToHtml(script: string): string {
  let pos = 0;
  const len = script.length;

  function peek(): string { return pos < len ? script[pos] : ''; }
  function advance(): string { return pos < len ? script[pos++] : ''; }
  function skipSpaces(): void { while (pos < len && script[pos] === ' ') pos++; }

  function matchWord(word: string): boolean {
    if (pos + word.length > len) return false;
    if (script.substring(pos, pos + word.length) !== word) return false;
    // Check character BEFORE: if it's alphanumeric, this isn't a standalone keyword
    if (pos > 0 && /[a-zA-Z0-9]/.test(script[pos - 1])) return false;
    // Check character AFTER: if it's alphanumeric, this isn't a standalone keyword
    const after = pos + word.length;
    if (after < len && /[a-zA-Z0-9]/.test(script[after])) return false;
    pos += word.length;
    return true;
  }

  function parseGroup(): string {
    let html = '';
    while (pos < len && peek() !== '}') {
      html += parseExpr();
    }
    if (peek() === '}') advance();
    return html;
  }

  function parseSingleOrGroup(): string {
    skipSpaces();
    if (peek() === '{') { advance(); return parseGroup(); }
    return parseExpr();
  }

  function parseExpr(): string {
    skipSpaces();
    if (pos >= len) return '';

    const c = peek();

    // Braced group — may be followed by 'over' for fraction
    if (c === '{') {
      advance();
      const content = parseGroup();
      skipSpaces();
      if (matchWord('over')) {
        const denom = parseSingleOrGroup();
        return '<span style="display:inline-flex;flex-direction:column;align-items:center;vertical-align:middle;margin:0 1px">'
          + '<span style="border-bottom:1px solid currentColor;padding:0 3px;line-height:1.3;text-align:center">' + content + '</span>'
          + '<span style="padding:0 3px;line-height:1.3;text-align:center">' + denom + '</span></span>';
      }
      return content;
    }

    // Subscript
    if (c === '_') {
      advance();
      const sub = parseSingleOrGroup();
      return '<sub style="font-size:0.7em;vertical-align:sub">' + sub + '</sub>';
    }

    // Superscript
    if (c === '^') {
      advance();
      const sup = parseSingleOrGroup();
      return '<sup style="font-size:0.7em;vertical-align:super">' + sup + '</sup>';
    }

    // Space / newline
    if (c === '`') { advance(); return ' '; }
    if (c === '#') { advance(); return '<br/>'; }

    // Quoted literal text
    if (c === '"') {
      advance();
      let text = '';
      while (pos < len && peek() !== '"') text += escapeHtml(advance());
      if (peek() === '"') advance();
      return '<span style="font-style:normal">' + text + '</span>';
    }

    // Big operators: sum, prod, int
    if (matchWord('sum')) return '<span style="font-size:1.4em;font-style:normal;vertical-align:middle">Σ</span>';
    if (matchWord('prod')) return '<span style="font-size:1.4em;font-style:normal;vertical-align:middle">Π</span>';
    if (matchWord('int')) return '<span style="font-size:1.4em;font-style:normal;vertical-align:middle">∫</span>';

    // sqrt — radical sign with overline bar
    if (matchWord('sqrt')) {
      const content = parseSingleOrGroup();
      return '<span style="display:inline-flex;align-items:stretch;vertical-align:middle;white-space:nowrap">'
        + '<span style="font-size:1.1em;line-height:1">√</span>'
        + '<span style="border-top:1px solid currentColor;padding:0 2px;line-height:1.2">' + content + '</span></span>';
    }

    // Accent/decoration above or below: bar, dot, ddot, hat, tilde, vec, overline, underline
    if (matchWord('bar') || matchWord('overline')) {
      const content = parseSingleOrGroup();
      return '<span style="text-decoration:overline;text-decoration-thickness:1px">' + content + '</span>';
    }
    if (matchWord('dot')) {
      const content = parseSingleOrGroup();
      return '<span style="display:inline-flex;flex-direction:column;align-items:center;vertical-align:middle">'
        + '<span style="font-size:0.6em;line-height:0.5">·</span>'
        + '<span>' + content + '</span></span>';
    }
    if (matchWord('ddot')) {
      const content = parseSingleOrGroup();
      return '<span style="display:inline-flex;flex-direction:column;align-items:center;vertical-align:middle">'
        + '<span style="font-size:0.6em;line-height:0.5">··</span>'
        + '<span>' + content + '</span></span>';
    }
    if (matchWord('hat')) {
      const content = parseSingleOrGroup();
      return '<span style="display:inline-flex;flex-direction:column;align-items:center;vertical-align:middle">'
        + '<span style="font-size:0.65em;line-height:0.5">^</span>'
        + '<span>' + content + '</span></span>';
    }
    if (matchWord('tilde')) {
      const content = parseSingleOrGroup();
      return '<span style="display:inline-flex;flex-direction:column;align-items:center;vertical-align:middle">'
        + '<span style="font-size:0.7em;line-height:0.5">~</span>'
        + '<span>' + content + '</span></span>';
    }
    if (matchWord('vec')) {
      const content = parseSingleOrGroup();
      return '<span style="display:inline-flex;flex-direction:column;align-items:center;vertical-align:middle">'
        + '<span style="font-size:0.6em;line-height:0.5">→</span>'
        + '<span>' + content + '</span></span>';
    }
    if (matchWord('underline')) {
      const content = parseSingleOrGroup();
      return '<span style="text-decoration:underline">' + content + '</span>';
    }

    // over (standalone, without preceding group — treat as fraction bar)
    if (matchWord('over')) {
      const denom = parseSingleOrGroup();
      return '<span style="display:inline-flex;flex-direction:column;align-items:center;vertical-align:middle;margin:0 1px">'
        + '<span style="border-bottom:1px solid currentColor;padding:0 3px;line-height:1.3"></span>'
        + '<span style="padding:0 3px;line-height:1.3">' + denom + '</span></span>';
    }

    // rm (roman/upright text)
    if (matchWord('rm')) {
      skipSpaces();
      let text: string;
      if (peek() === '{') { advance(); text = parseGroup(); }
      else {
        text = '';
        while (pos < len && /[a-zA-Z0-9]/.test(peek())) text += advance();
      }
      return '<span style="font-style:normal">' + text + '</span>';
    }

    // LEFT/RIGHT delimiters
    if (matchWord('LEFT') || matchWord('left')) {
      skipSpaces();
      const d = peek();
      if ('([|'.includes(d)) { advance(); return escapeHtml(d); }
      if (d === '{') { advance(); return '{'; }
      if (matchWord('lbrace')) return '{';
      return '';
    }
    if (matchWord('RIGHT') || matchWord('right')) {
      skipSpaces();
      const d = peek();
      if (')]|'.includes(d)) { advance(); return escapeHtml(d); }
      if (d === '}') { advance(); return '}'; }
      if (matchWord('rbrace')) return '}';
      return '';
    }

    // Greek letters and symbols (longest match first)
    for (const [key, val] of EQ_SYMBOLS) {
      if (matchWord(key)) return val;
    }

    // Regular character
    advance();
    return escapeHtml(c);
  }

  let result = '';
  while (pos < len) {
    result += parseExpr();
  }
  return result;
}

// ==================== Tab Mapping Helpers ====================

/** Map numeric leader code from inline <hp:tab> to string */
function mapTabLeader(val: string): string {
  switch (val) {
    case '0': return 'NONE';
    case '1': return 'SOLID';
    case '2': return 'DOT';
    case '3': return 'DASH';
    case '4': return 'DASH_DOT';
    case '5': return 'DASH_DOT_DOT';
    default: return val; // already a string like 'DASH'
  }
}

/** Map numeric type code from inline <hp:tab> to string */
function mapTabType(val: string): 'LEFT' | 'RIGHT' | 'CENTER' {
  switch (val) {
    case '0': return 'LEFT';
    case '1': return 'CENTER';
    case '2': return 'RIGHT';
    default: return (val as 'LEFT' | 'RIGHT' | 'CENTER') || 'LEFT';
  }
}

// ==================== Header Parsing ====================

function parseHeaderXml(xmlString: string): HeaderData {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlString, 'application/xml');
  const headerData: HeaderData = {
    charProps: new Map(),
    paraProps: new Map(),
    hangulFonts: new Map(),
    latinFonts: new Map(),
    borderFills: new Map(),
    numberings: new Map(),
    bullets: new Map(),
    tabDefs: new Map(),
  };

  // Parse tab property definitions from <hh:tabProperties> section
  const tabPropsSection = doc.getElementsByTagName('hh:tabProperties')[0];
  if (tabPropsSection) {
    const tabPrEls = tabPropsSection.getElementsByTagName('hh:tabPr');
    for (let i = 0; i < tabPrEls.length; i++) {
      const tp = tabPrEls[i];
      const id = parseInt(tp.getAttribute('id') || '-1');
      if (id < 0) continue;
      const tabs: TabStop[] = [];
      // Check for tabItem inside hp:switch (HwpUnitChar case preferred, then default)
      const switchEl = tp.getElementsByTagName('hp:switch')[0];
      if (switchEl) {
        const caseEl = switchEl.getElementsByTagName('hp:case')[0];
        const defaultEl = switchEl.getElementsByTagName('hp:default')[0];
        const source = caseEl || defaultEl;
        if (source) {
          const tabItems = source.getElementsByTagName('hh:tabItem');
          for (let t = 0; t < tabItems.length; t++) {
            const ti = tabItems[t];
            tabs.push({
              pos: parseInt(ti.getAttribute('pos') || '0') / HWPUNIT_PER_PIXEL,
              type: mapTabType(ti.getAttribute('type') || 'LEFT'),
              leader: ti.getAttribute('leader') || 'NONE',
            });
          }
        }
      }
      // Also check direct tabItem children (no switch)
      if (tabs.length === 0) {
        const tabItems = tp.getElementsByTagName('hh:tabItem');
        for (let t = 0; t < tabItems.length; t++) {
          const ti = tabItems[t];
          tabs.push({
            pos: parseInt(ti.getAttribute('pos') || '0') / HWPUNIT_PER_PIXEL,
            type: mapTabType(ti.getAttribute('type') || 'LEFT'),
            leader: ti.getAttribute('leader') || 'NONE',
          });
        }
      }
      if (tabs.length > 0) headerData.tabDefs.set(id, tabs);
    }
  }

  // Parse font faces
  const fontfaces = doc.getElementsByTagName('hh:fontface');
  for (let i = 0; i < fontfaces.length; i++) {
    const ff = fontfaces[i];
    const lang = ff.getAttribute('lang');
    const fonts = ff.getElementsByTagName('hh:font');
    for (let j = 0; j < fonts.length; j++) {
      const font = fonts[j];
      const id = parseInt(font.getAttribute('id') || '0');
      const face = font.getAttribute('face') || '';
      if (lang === 'HANGUL') headerData.hangulFonts.set(id, face);
      else if (lang === 'LATIN') headerData.latinFonts.set(id, face);
    }
  }

  // Parse character properties
  const charPrs = doc.getElementsByTagName('hh:charPr');
  for (let i = 0; i < charPrs.length; i++) {
    const cp = charPrs[i];
    const id = parseInt(cp.getAttribute('id') || '-1');
    if (id < 0) continue;
    const fontRef = cp.getElementsByTagName('hh:fontRef')[0];
    const hangulFontId = parseInt(fontRef?.getAttribute('hangul') || '0');
    const latinFontId = parseInt(fontRef?.getAttribute('latin') || '0');
    // <hh:spacing hangul="-5" latin="-5" .../> — per-script character spacing (자간)
    const spacingEl = cp.getElementsByTagName('hh:spacing')[0];
    const spacingVal = spacingEl ? parseInt(spacingEl.getAttribute('hangul') || spacingEl.getAttribute('latin') || '0') : 0;
    // <hh:ratio hangul="100" latin="100" .../> — per-script character width ratio (장평)
    const ratioEl = cp.getElementsByTagName('hh:ratio')[0];
    const ratioVal = ratioEl ? parseInt(ratioEl.getAttribute('hangul') || ratioEl.getAttribute('latin') || '100') : 100;
    headerData.charProps.set(id, {
      height: parseInt(cp.getAttribute('height') || '1000'),
      textColor: cp.getAttribute('textColor') || '#000000',
      bold: cp.getElementsByTagName('hh:bold').length > 0,
      italic: cp.getElementsByTagName('hh:italic').length > 0,
      underline: (() => { const el = cp.getElementsByTagName('hh:underline')[0]; return el ? el.getAttribute('type') !== 'NONE' : false; })(),
      strikethrough: (() => { const el = cp.getElementsByTagName('hh:strikeout')[0]; return el ? el.getAttribute('shape') !== 'NONE' : false; })(),
      superscript: cp.getElementsByTagName('hh:supscript').length > 0,
      subscript: cp.getElementsByTagName('hh:subscript').length > 0,
      hangulFontId,
      latinFontId,
      spacing: spacingVal !== 0 ? spacingVal : undefined,
      ratio: ratioVal !== 100 ? ratioVal : undefined,
    });
  }

  // Parse paragraph properties
  const paraPrs = doc.getElementsByTagName('hh:paraPr');
  for (let i = 0; i < paraPrs.length; i++) {
    const pp = paraPrs[i];
    const id = parseInt(pp.getAttribute('id') || '-1');
    if (id < 0) continue;
    const alignEl = pp.getElementsByTagName('hh:align')[0];
    const horizontal = alignEl?.getAttribute('horizontal') || 'JUSTIFY';
    let align: 'left' | 'center' | 'right' | 'justify' | 'distribute' = 'justify';
    if (horizontal === 'LEFT') align = 'left';
    else if (horizontal === 'CENTER') align = 'center';
    else if (horizontal === 'RIGHT') align = 'right';
    else if (horizontal === 'DISTRIBUTE_SPACE') align = 'distribute';

    let lineSpacingType = 'PERCENT', lineSpacingValue = 160;
    const caseEl = pp.getElementsByTagName('hp:case')[0] || pp.getElementsByTagName('hp:default')[0];
    const lsEl = (caseEl ? caseEl.getElementsByTagName('hh:lineSpacing')[0] : null)
      || pp.getElementsByTagName('hh:lineSpacing')[0]
      || pp.getElementsByTagName('hp:lineSpacing')[0];
    if (lsEl) {
      lineSpacingType = lsEl.getAttribute('type') || 'PERCENT';
      lineSpacingValue = parseInt(lsEl.getAttribute('value') || '160');
    }

    let indent = 0, marginLeft = 0, marginRight = 0, marginTop = 0, marginBottom = 0;
    if (caseEl) {
      const marginEl = caseEl.getElementsByTagName('hh:margin')[0];
      if (marginEl) {
        const gv = (tag: string) => { const el = marginEl.getElementsByTagName(`hc:${tag}`)[0]; return parseInt(el?.getAttribute('value') || '0'); };
        indent = gv('intent'); marginLeft = gv('left'); marginRight = gv('right'); marginTop = gv('prev'); marginBottom = gv('next');
      }
    }

    let headingType: string | undefined, headingIdRef: number | undefined, headingLevel: number | undefined;
    // Search heading element: first in switch/case, then as direct child of paraPr
    const headingEl = (caseEl ? caseEl.getElementsByTagName('hh:heading')[0] : null)
      || pp.getElementsByTagName('hh:heading')[0];
    if (headingEl) {
      headingType = headingEl.getAttribute('type') || undefined;
      const ir = headingEl.getAttribute('idRef'); if (ir) headingIdRef = parseInt(ir);
      const lv = headingEl.getAttribute('level'); if (lv) headingLevel = parseInt(lv);
    }

    // Resolve tab stops via tabPrIDRef → tabDefs lookup
    let tabStops: TabStop[] | undefined;
    if (caseEl) {
      const tabPrEl = caseEl.getElementsByTagName('hh:tabPr')[0];
      if (tabPrEl) {
        const tabPrId = tabPrEl.getAttribute('id');
        if (tabPrId) {
          const defs = headerData.tabDefs.get(parseInt(tabPrId));
          if (defs) tabStops = defs;
        }
      }
    }
    // Also check tabPrIDRef directly on paraPr element
    if (!tabStops) {
      const tabPrIDRef = pp.getAttribute('tabPrIDRef');
      if (tabPrIDRef) {
        const defs = headerData.tabDefs.get(parseInt(tabPrIDRef));
        if (defs) tabStops = defs;
      }
    }

    // pageBreakBefore is read from <hp:p> attribute, not from paraPr definition
    const pageBreakBefore = false;

    headerData.paraProps.set(id, {
      align, lineSpacingType, lineSpacingValue,
      indent: indent / HWPUNIT_PER_PIXEL, marginLeft: marginLeft / HWPUNIT_PER_PIXEL,
      marginRight: marginRight / HWPUNIT_PER_PIXEL, marginTop: marginTop / HWPUNIT_PER_PIXEL,
      marginBottom: marginBottom / HWPUNIT_PER_PIXEL,
      headingType, headingIdRef, headingLevel,
      tabStops, pageBreakBefore,
    });
  }

  // Parse border fills
  const borderFills = doc.getElementsByTagName('hh:borderFill');
  for (let i = 0; i < borderFills.length; i++) {
    const bf = borderFills[i];
    const id = parseInt(bf.getAttribute('id') || '-1');
    if (id < 0) continue;
    const parseBorderSide = (sideName: string): BorderStyle => {
      const el = bf.getElementsByTagName(`hh:${sideName}`)[0];
      if (!el) return { type: 'NONE', width: 0, color: '#000000' };
      const type = el.getAttribute('type') || 'NONE';
      const widthStr = el.getAttribute('width') || '0.1 mm';
      const color = el.getAttribute('color') || '#000000';
      const mmMatch = widthStr.match(/([\d.]+)\s*mm/);
      const widthPx = mmMatch ? parseFloat(mmMatch[1]) * 3.78 : 1;
      return { type, width: Math.max(type === 'NONE' ? 0 : 1, widthPx), color };
    };

    let fillColor: string | undefined;
    const windowBrush = bf.getElementsByTagName('hc:windowBrush')[0] || bf.getElementsByTagName('hc:winBrush')[0];
    if (windowBrush) {
      const fc = windowBrush.getAttribute('faceColor');
      if (fc && fc !== 'none') {
        if (fc.startsWith('#')) fillColor = fc;
        else { const cn = parseInt(fc); if (!isNaN(cn)) fillColor = `rgb(${(cn >> 16) & 0xff}, ${(cn >> 8) & 0xff}, ${cn & 0xff})`; else fillColor = fc; }
      }
    }
    // Fallback: gradient fill (use first stop color)
    if (!fillColor) {
      const gradColors = bf.getElementsByTagName('hc:color');
      for (let j = 0; j < gradColors.length; j++) {
        const val = gradColors[j].getAttribute('value');
        if (val && val !== 'none') {
          if (val.startsWith('#')) fillColor = val;
          else { const cn = parseInt(val); if (!isNaN(cn)) fillColor = `rgb(${(cn >> 16) & 0xff}, ${(cn >> 8) & 0xff}, ${cn & 0xff})`; else fillColor = val; }
          break;
        }
      }
    }

    // Check for image background (imgBrush in fillBrush)
    let imgRef: string | undefined;
    const imgBrush = bf.getElementsByTagName('hc:imgBrush')[0];
    if (imgBrush) {
      const imgEl = imgBrush.getElementsByTagName('hc:img')[0];
      if (imgEl) imgRef = imgEl.getAttribute('binaryItemIDRef') || undefined;
    }

    headerData.borderFills.set(id, {
      leftBorder: parseBorderSide('leftBorder'), rightBorder: parseBorderSide('rightBorder'),
      topBorder: parseBorderSide('topBorder'), bottomBorder: parseBorderSide('bottomBorder'),
      fillColor, imgRef,
    });
  }

  // Parse numbering definitions
  const numberingEls = doc.getElementsByTagName('hh:numbering');
  for (let i = 0; i < numberingEls.length; i++) {
    const numEl = numberingEls[i];
    const id = parseInt(numEl.getAttribute('id') || '-1');
    if (id < 0) continue;
    const start = parseInt(numEl.getAttribute('start') || '1');
    const levels = new Map<number, NumberingLevelDef>();
    const paraHeads = numEl.getElementsByTagName('hh:paraHead');
    for (let j = 0; j < paraHeads.length; j++) {
      const ph = paraHeads[j];
      const level = parseInt(ph.getAttribute('level') || '1');
      const phCharPrIDRef = ph.getAttribute('charPrIDRef');
      levels.set(level, {
        format: ph.textContent || `^${level}.`,
        numFormat: ph.getAttribute('numFormat') || 'DIGIT',
        textOffset: parseInt(ph.getAttribute('textOffset') || '50'),
        start: parseInt(ph.getAttribute('start') || '1'),
        charPrIDRef: phCharPrIDRef ? parseInt(phCharPrIDRef) : undefined,
      });
    }
    headerData.numberings.set(id, { start, levels });
  }

  // Parse bullet definitions
  const bulletEls = doc.getElementsByTagName('hh:bullet');
  for (let i = 0; i < bulletEls.length; i++) {
    const bEl = bulletEls[i];
    const id = parseInt(bEl.getAttribute('id') || '-1');
    if (id < 0) continue;
    const charStr = bEl.getAttribute('char') || '';
    const charCode = parseInt(charStr);
    let char = '●';
    if (charStr && !isNaN(charCode) && charCode > 0) {
      char = mapPuaChar(charCode);
    } else if (charStr.length >= 1) {
      // Literal character — check if PUA and map to Unicode
      const cp = charStr.codePointAt(0) || 0;
      char = (cp >= 0xF000 && cp <= 0xF0FF) ? mapPuaChar(cp) : charStr;
    }
    const cc = bEl.getAttribute('checkedChar');
    if (cc) {
      const n = parseInt(cc);
      if (!isNaN(n) && n > 0) char = mapPuaChar(n);
      else if (cc.length >= 1) {
        const ccp = cc.codePointAt(0) || 0;
        if (ccp >= 0xF000 && ccp <= 0xF0FF) char = mapPuaChar(ccp);
      }
    }
    headerData.bullets.set(id, { char });
  }

  log('[HwpxViewer] Header: charProps=' + headerData.charProps.size +
    ' paraProps=' + headerData.paraProps.size + ' borderFills=' + headerData.borderFills.size +
    ' numberings=' + headerData.numberings.size + ' fonts=' + headerData.hangulFonts.size +
    ' tabDefs=' + headerData.tabDefs.size);

  return headerData;
}

// ==================== Style Resolution ====================

function resolveCharStyle(charPrIDRef: string | null, header: HeaderData | null): Partial<TextRun> {
  if (!header || !charPrIDRef) return {};
  const def = header.charProps.get(parseInt(charPrIDRef));
  if (!def) return {};
  const props: Partial<TextRun> = { fontSize: def.height / 100 };
  if (def.textColor && def.textColor !== '#000000') props.color = def.textColor;
  if (def.bold) props.bold = true;
  if (def.italic) props.italic = true;
  if (def.underline) props.underline = true;
  if (def.strikethrough) props.strikethrough = true;
  if (def.superscript) props.superscript = true;
  if (def.subscript) props.subscript = true;
  const fontName = header.hangulFonts.get(def.hangulFontId) || header.latinFonts.get(def.latinFontId);
  if (fontName) props.fontFamily = fontName;
  if (def.spacing != null && def.spacing !== 0) props.letterSpacing = def.spacing;
  if (def.ratio != null && def.ratio !== 100) props.charRatio = def.ratio;
  return props;
}

function resolveParaStyle(paraPrIDRef: string | null, header: HeaderData | null): Partial<Paragraph> {
  if (!header || !paraPrIDRef) return {};
  const def = header.paraProps.get(parseInt(paraPrIDRef));
  if (!def) return {};
  const props: Partial<Paragraph> = { align: def.align };
  if (def.lineSpacingType === 'PERCENT') {
    props.lineHeight = def.lineSpacingValue / 100;
  } else if (def.lineSpacingType === 'FIXED') {
    // Fixed line pitch in HWPUNIT
    props.lineHeight = `${def.lineSpacingValue / HWPUNIT_PER_PIXEL}px`;
  } else if (def.lineSpacingType === 'BETWEEN_LINES') {
    // Space added between lines in HWPUNIT (not total line height)
    // We approximate by converting to a pixel value and using it as additional spacing
    // CSS doesn't have "add N px between lines" directly, so we use a calculated line-height
    props.lineHeight = `calc(1em + ${def.lineSpacingValue / HWPUNIT_PER_PIXEL}px)`;
  }
  if (def.indent) props.indent = def.indent;
  if (def.marginLeft) props.marginLeft = def.marginLeft;
  if (def.marginTop) props.marginTop = def.marginTop;
  if (def.marginBottom) props.marginBottom = def.marginBottom;
  if (def.tabStops) props.tabStops = def.tabStops;
  if (def.pageBreakBefore) props.pageBreakBefore = true;
  return props;
}

function resolveBorderFill(borderFillIDRef: string | null, header: HeaderData | null): {
  borders?: { top: BorderStyle; bottom: BorderStyle; left: BorderStyle; right: BorderStyle };
  fillColor?: string;
  imgRef?: string;
} {
  if (!header || !borderFillIDRef) return {};
  const def = header.borderFills.get(parseInt(borderFillIDRef));
  if (!def) return {};
  return {
    borders: { top: def.topBorder, bottom: def.bottomBorder, left: def.leftBorder, right: def.rightBorder },
    fillColor: def.fillColor,
    imgRef: def.imgRef,
  };
}

function resolveNumbering(
  paraPrIDRef: string | null, header: HeaderData | null, counters: Map<string, number>,
): { bulletChar?: string; numberingText?: string; numberingStyle?: Partial<TextRun> } {
  if (!header || !paraPrIDRef) return {};
  const def = header.paraProps.get(parseInt(paraPrIDRef));
  if (!def || !def.headingType || def.headingType === 'NONE') return {};
  if (def.headingType === 'BULLET' && def.headingIdRef !== undefined) {
    const bd = header.bullets.get(def.headingIdRef);
    return { bulletChar: bd?.char || '●' };
  }
  if (def.headingType !== 'BULLET' && def.headingType !== 'NONE' && def.headingIdRef !== undefined) {
    const nd = header.numberings.get(def.headingIdRef);
    if (nd) {
      const level = def.headingLevel || 1;
      const ld = nd.levels.get(level);
      if (ld) {
        const key = `${def.headingIdRef}-${level}`;
        const cur = (counters.get(key) || (ld.start - 1)) + 1;
        counters.set(key, cur);
        for (let l = level + 1; l <= 10; l++) counters.delete(`${def.headingIdRef}-${l}`);
        let text = ld.format;
        for (let l = 1; l <= level; l++) {
          text = text.replace(`^${l}`, formatNumber(counters.get(`${def.headingIdRef}-${l}`) || 1, ld.numFormat));
        }
        text = text.replace(/\^\d+/g, '');
        // Resolve char style for numbering text
        let numberingStyle: Partial<TextRun> | undefined;
        if (ld.charPrIDRef !== undefined) {
          numberingStyle = resolveCharStyle(String(ld.charPrIDRef), header);
        }
        return { numberingText: text.trim(), numberingStyle };
      }
    }
  }
  return {};
}

// ==================== Character/Paragraph Parsing ====================

function parseCharProps(charPr: Element | null, defaultStyle?: Partial<TextRun>): Partial<TextRun> {
  const props: Partial<TextRun> = { ...defaultStyle };
  if (!charPr) return props;
  const bold = charPr.getAttribute('bold');
  if (bold === '1' || bold === 'true') props.bold = true;
  const italic = charPr.getAttribute('italic');
  if (italic === '1' || italic === 'true') props.italic = true;
  const underline = charPr.getAttribute('underline');
  if (underline && underline !== 'none' && underline !== '0') props.underline = true;
  const strike = charPr.getAttribute('strikeout');
  if (strike && strike !== 'none' && strike !== '0') props.strikethrough = true;
  const height = charPr.getAttribute('height');
  if (height) props.fontSize = parseInt(height) / 100;
  const fontRef = charPr.getAttribute('fontRef');
  const hangulFontRef = charPr.getAttribute('hangulFontRef');
  if (fontRef) props.fontFamily = fontRef;
  else if (hangulFontRef) props.fontFamily = hangulFontRef;
  const textColor = charPr.getAttribute('textColor');
  if (textColor && textColor !== '0' && textColor.startsWith('#')) props.color = textColor;
  else if (textColor && textColor !== '0') {
    const cn = parseInt(textColor);
    if (!isNaN(cn)) props.color = `rgb(${(cn >> 16) & 0xff}, ${(cn >> 8) & 0xff}, ${cn & 0xff})`;
  }
  const hl = charPr.getAttribute('highlightColor');
  if (hl && hl !== '0' && hl !== '-1') {
    const cn = parseInt(hl);
    if (!isNaN(cn)) props.backgroundColor = `rgb(${(cn >> 16) & 0xff}, ${(cn >> 8) & 0xff}, ${cn & 0xff})`;
  }
  const va = charPr.getAttribute('vertAlign');
  if (va === 'superscript') props.superscript = true;
  if (va === 'subscript') props.subscript = true;
  // Character spacing: check <hh:spacing>/<hp:spacing> child element first, then attribute
  const spacingEl = charPr.getElementsByTagName('hh:spacing')[0] || charPr.getElementsByTagName('hp:spacing')[0];
  if (spacingEl) {
    const sv = parseInt(spacingEl.getAttribute('hangul') || spacingEl.getAttribute('latin') || '0');
    if (sv !== 0) props.letterSpacing = sv;
  } else {
    const spacing = charPr.getAttribute('spacing');
    if (spacing) { const sv = parseInt(spacing); if (sv !== 0) props.letterSpacing = sv; }
  }
  // Character ratio: check <hh:ratio>/<hp:ratio> child element first, then attribute
  const ratioEl = charPr.getElementsByTagName('hh:ratio')[0] || charPr.getElementsByTagName('hp:ratio')[0];
  if (ratioEl) {
    const rv = parseInt(ratioEl.getAttribute('hangul') || ratioEl.getAttribute('latin') || '100');
    if (rv !== 100) props.charRatio = rv;
  } else {
    const ratio = charPr.getAttribute('ratio');
    if (ratio) { const rv = parseInt(ratio); if (rv !== 100) props.charRatio = rv; }
  }
  return props;
}

function parseParaProps(paraPr: Element | null): Partial<Paragraph> {
  const props: Partial<Paragraph> = {};
  if (!paraPr) return props;
  const align = paraPr.getAttribute('align');
  switch (align) {
    case 'left': props.align = 'left'; break;
    case 'center': props.align = 'center'; break;
    case 'right': props.align = 'right'; break;
    case 'justify': case 'both': props.align = 'justify'; break;
  }
  // Line spacing: check <hp:lineSpacing> sub-element first, then lineHeight attribute
  const lsEl = paraPr.getElementsByTagName('hp:lineSpacing')[0]
    || paraPr.getElementsByTagName('hh:lineSpacing')[0];
  if (lsEl) {
    const lsType = lsEl.getAttribute('type') || 'PERCENT';
    const lsValue = parseInt(lsEl.getAttribute('value') || '160');
    if (lsType === 'PERCENT') {
      props.lineHeight = lsValue / 100;
    } else if (lsType === 'FIXED') {
      props.lineHeight = `${lsValue / HWPUNIT_PER_PIXEL}px`;
    } else if (lsType === 'BETWEEN_LINES') {
      props.lineHeight = `calc(1em + ${lsValue / HWPUNIT_PER_PIXEL}px)`;
    }
  } else {
    const lh = paraPr.getAttribute('lineHeight');
    if (lh) props.lineHeight = parseInt(lh) / 100;
  }
  const mt = paraPr.getAttribute('marginTop');
  const mb = paraPr.getAttribute('marginBottom');
  if (mt) props.marginTop = parseInt(mt) / HWPUNIT_PER_PIXEL;
  if (mb) props.marginBottom = parseInt(mb) / HWPUNIT_PER_PIXEL;
  const ind = paraPr.getAttribute('indent');
  if (ind) props.indent = parseInt(ind) / HWPUNIT_PER_PIXEL;

  // Note: tab stops and page breaks are resolved elsewhere
  // (tabStops via tabPrIDRef in header, pageBreak via <hp:p> attribute)
  return props;
}

// ==================== Control Element Handling ====================

/** Process <hp:ctrl> child and return text if it produces visible content */
function processCtrl(
  ctrlElement: Element,
  autoCounters: AutoNumCounters,
  sectionMeta: {
    pageNumPos?: string; pageNumSideChar?: string; pageNumHidden?: boolean; pageStartNo?: number; hiddenPageNumPages?: Set<number>;
    footerContent?: ContentItem[]; headerContent?: ContentItem[];
    footnotes?: FootnoteData[];
    pageNumResets?: Map<number, number>;
  },
  header: HeaderData | null,
  numCounters: Map<string, number>,
  currentPageIdx?: number,
): string | null {
  for (let i = 0; i < ctrlElement.children.length; i++) {
    const child = ctrlElement.children[i];
    const tag = child.localName || child.tagName.split(':').pop() || '';

    switch (tag) {
      case 'pageNum': {
        sectionMeta.pageNumPos = child.getAttribute('pos') || undefined;
        sectionMeta.pageNumSideChar = child.getAttribute('sideChar') || undefined;
        const startNo = child.getAttribute('startNo');
        if (startNo) sectionMeta.pageStartNo = parseInt(startNo);
        return null;
      }
      case 'pageHiding': {
        // Attributes: hidePageNum, hideHeader, hideFooter, hideMasterPage, hideBorder, hideFill
        if (child.getAttribute('hidePageNum') === '1' || child.getAttribute('pageNumPos') === '1') {
          sectionMeta.pageNumHidden = true;
        }
        return null;
      }
      case 'newNum': {
        const numType = child.getAttribute('numType') || '';
        const num = parseInt(child.getAttribute('num') || '1');
        if (numType === 'PAGE') {
          // Store page reset; section-level code will track the pageIndex
          sectionMeta.pageStartNo = num;
        }
        if (numType in autoCounters) autoCounters[numType] = num - 1;
        return null;
      }
      case 'autoNum': {
        const numType = child.getAttribute('numType') || '';
        // Dynamic page number placeholder (resolved during footer rendering)
        if (numType === 'PAGE') return '__PAGE_NUM__';
        if (numType in autoCounters) {
          autoCounters[numType]++;
          return String(autoCounters[numType]);
        }
        const num = child.getAttribute('num');
        return num || null;
      }
      case 'fieldBegin': {
        const params = child.getElementsByTagName('hp:stringParam');
        for (let j = 0; j < params.length; j++) {
          if (params[j].getAttribute('name') === 'LastResult') {
            return params[j].textContent || null;
          }
        }
        return null;
      }
      case 'fieldEnd':
        return null;
      case 'footNote': {
        // Parse footnote content and collect with page assignment
        const number = parseInt(child.getAttribute('number') || '0');
        const userChar = child.getAttribute('userChar');
        const marker = userChar ? String.fromCharCode(parseInt(userChar)) : String(number);
        const subList = child.getElementsByTagName('hp:subList')[0];
        if (subList && sectionMeta.footnotes) {
          const content = parseContentItems(subList, header, numCounters, autoCounters);
          sectionMeta.footnotes.push({ number, content, marker, pageIndex: currentPageIdx });
        }
        // Return superscript marker in the text flow
        return marker;
      }
      case 'footer': {
        sectionMeta.footerContent = parseContentItems(child.getElementsByTagName('hp:subList')[0] || child, header, numCounters, autoCounters);
        return null;
      }
      case 'header': {
        sectionMeta.headerContent = parseContentItems(child.getElementsByTagName('hp:subList')[0] || child, header, numCounters, autoCounters);
        return null;
      }
      case 'colPr':
        return null;
      default:
        return null;
    }
  }
  return null;
}

// ==================== Table Parsing ====================

function computeColWidths(cells: TableCell[], colCnt: number, tableWidth: number): number[] {
  const cw = new Array<number>(colCnt).fill(0);
  for (const cell of cells) {
    if (cell.colSpan === 1 && cell.colAddr < colCnt) {
      if (cell.width > 0 && (cw[cell.colAddr] === 0 || cell.width < cw[cell.colAddr])) cw[cell.colAddr] = cell.width;
    }
  }
  for (const cell of cells) {
    if (cell.colSpan > 1 && cell.colAddr + cell.colSpan <= colCnt) {
      let ks = 0, ui = -1, uc = 0;
      for (let c = cell.colAddr; c < cell.colAddr + cell.colSpan; c++) {
        if (cw[c] === 0) { ui = c; uc++; } else ks += cw[c];
      }
      if (uc === 1 && ui >= 0) cw[ui] = Math.max(1, cell.width - ks);
    }
  }
  const su = cw.reduce((n, w) => n + (w === 0 ? 1 : 0), 0);
  if (su > 0) {
    const kt = cw.reduce((s, w) => s + w, 0);
    const rem = Math.max(0, tableWidth - kt);
    const pc = rem / su;
    for (let c = 0; c < colCnt; c++) { if (cw[c] === 0) cw[c] = pc > 0 ? pc : tableWidth / colCnt; }
  }
  return cw;
}

/** Parse content items from an element that contains <hp:p> children */
function parseContentItems(
  container: Element,
  header: HeaderData | null,
  numCounters: Map<string, number>,
  autoCounters: AutoNumCounters,
  sectionMeta?: {
    pageNumPos?: string; pageNumSideChar?: string; pageNumHidden?: boolean; pageStartNo?: number; hiddenPageNumPages?: Set<number>;
    footerContent?: ContentItem[]; headerContent?: ContentItem[];
  },
): ContentItem[] {
  const items: ContentItem[] = [];
  const ps = directChildren(container, 'p');

  for (const para of ps) {
    const runs = directChildren(para, 'run');
    const textRuns: TextRun[] = [];
    const paraPrIDRef = para.getAttribute('paraPrIDRef');
    const hps = resolveParaStyle(paraPrIDRef, header);
    const paraPr = findElement(para, 'paraPr');
    const ipp = parseParaProps(paraPr);
    const pp: Partial<Paragraph> = { ...hps, ...ipp };
    // Read pageBreak directly from <hp:p> element attribute
    if (para.getAttribute('pageBreak') === '1') pp.pageBreakBefore = true;
    const ni = resolveNumbering(paraPrIDRef, header, numCounters);
    let hasNonText = false;

    for (const run of runs) {
      const charPrIDRef = run.getAttribute('charPrIDRef');
      const hcs = resolveCharStyle(charPrIDRef, header);
      const charPr = findElement(run, 'charPr');
      const dp = parseCharProps(charPr, hcs);

      for (let ci = 0; ci < run.children.length; ci++) {
        const child = run.children[ci];
        const cln = child.localName || child.tagName.split(':').pop() || '';
        switch (cln) {
          case 'pic': {
            if (textRuns.length > 0 && textRuns.some(r => r.text.trim())) {
              items.push({ type: 'paragraph', data: { runs: [...textRuns], ...pp, ...ni } });
              textRuns.length = 0;
            }
            const img = parseImageElement(child, header, numCounters);
            if (img) { items.push({ type: 'image', data: img }); hasNonText = true; }
            break;
          }
          case 'rect': {
            const tb = parseRectElement(child, header, numCounters);
            if (tb) {
              if (textRuns.length > 0 && textRuns.some(r => r.text.trim())) {
                items.push({ type: 'paragraph', data: { runs: [...textRuns], ...pp, ...ni } });
                textRuns.length = 0;
              }
              items.push({ type: 'textBox', data: tb }); hasNonText = true;
            }
            break;
          }
          case 'container': {
            if (textRuns.length > 0 && textRuns.some(r => r.text.trim())) {
              items.push({ type: 'paragraph', data: { runs: [...textRuns], ...pp, ...ni } });
              textRuns.length = 0;
            }
            const groupItems = parseContainerElement(child, header || null, numCounters);
            items.push(...groupItems); hasNonText = true;
            break;
          }
          case 'tbl': {
            if (textRuns.length > 0 && textRuns.some(r => r.text.trim())) {
              items.push({ type: 'paragraph', data: { runs: [...textRuns], ...pp, ...ni } });
              textRuns.length = 0;
            }
            const table = parseTableElement(child, header, numCounters, autoCounters);
            if (table.rows.length > 0) { items.push({ type: 'table', data: table }); hasNonText = true; }
            break;
          }
          case 't': {
            // Handle mixed content: text nodes and inline elements (tab, lineBreak, fwSpace, titleMark)
            for (let ni2 = 0; ni2 < child.childNodes.length; ni2++) {
              const node = child.childNodes[ni2];
              if (node.nodeType === Node.TEXT_NODE) {
                const text = node.textContent;
                if (text) textRuns.push({ text, ...dp });
              } else if (node.nodeType === Node.ELEMENT_NODE) {
                const el = node as Element;
                const tag = el.localName || el.tagName.split(':').pop() || '';
                if (tag === 'tab') {
                  const leader = el.getAttribute('leader');
                  const width = el.getAttribute('width');
                  textRuns.push({
                    text: '\t', ...dp, isTab: true,
                    tabLeader: leader ? mapTabLeader(leader) : undefined,
                    tabWidth: width ? parseInt(width) / HWPUNIT_PER_PIXEL : undefined,
                  });
                } else if (tag === 'lineBreak') {
                  textRuns.push({ text: '\n', ...dp });
                } else if (tag === 'fwSpace') {
                  textRuns.push({ text: '\u3000', ...dp });
                }
                // titleMark, autoNumFormat etc. are silently ignored
              }
            }
            break;
          }
          case 'tab': {
            const leader = child.getAttribute('leader');
            const width = child.getAttribute('width');
            textRuns.push({
              text: '\t', ...dp, isTab: true,
              tabLeader: leader ? mapTabLeader(leader) : undefined,
              tabWidth: width ? parseInt(width) / HWPUNIT_PER_PIXEL : undefined,
            });
            break;
          }
          case 'equation': {
            const eq = parseEquationElement(child);
            if (eq) {
              if (eq.inline) {
                const html = equationScriptToHtml(eq.script);
                textRuns.push({ text: eq.script, ...dp, equationHtml: html });
              } else {
                if (textRuns.length > 0 && textRuns.some(r => r.text.trim())) {
                  items.push({ type: 'paragraph', data: { runs: [...textRuns], ...pp, ...ni } });
                  textRuns.length = 0;
                }
                items.push({ type: 'equation', data: eq });
                hasNonText = true;
              }
            }
            break;
          }
          case 'lineBreak':
            textRuns.push({ text: '\n', ...dp });
            break;
          case 'fwSpace':
            textRuns.push({ text: '\u3000', ...dp }); // full-width space
            break;
          case 'ctrl': {
            const ctrlResult = processCtrl(child, autoCounters,
              sectionMeta || { pageNumPos: undefined, pageNumSideChar: undefined, footerContent: undefined, headerContent: undefined, footnotes: [] },
              header, numCounters, undefined);
            if (ctrlResult) textRuns.push({ text: ctrlResult, ...dp });
            break;
          }
          default:
            break;
        }
      }
    }

    if (textRuns.length > 0 && (textRuns.some(r => r.text.trim()) || textRuns.some(r => r.isTab))) {
      items.push({ type: 'paragraph', data: { runs: textRuns, ...pp, ...ni } });
    } else if (!hasNonText) {
      // Preserve empty paragraphs as blank lines for proper spacing
      items.push({ type: 'paragraph', data: { runs: [{ text: '' }], ...pp } });
    }
  }
  return items;
}

function parseTableElement(
  tblElement: Element, header: HeaderData | null,
  numCounters: Map<string, number>, autoCounters: AutoNumCounters,
): Table {
  const colCnt = parseInt(tblElement.getAttribute('colCnt') || '0');
  const szEl = directChild(tblElement, 'sz');
  const tableWidth = parseInt(szEl?.getAttribute('width') || '0') / HWPUNIT_PER_PIXEL;
  const rows: TableRow[] = [];
  const allCells: TableCell[] = [];

  for (const tr of directChildren(tblElement, 'tr')) {
    const rowCells: TableCell[] = [];
    for (const tc of directChildren(tr, 'tc')) {
      const ca = directChild(tc, 'cellAddr');
      const colAddr = parseInt(ca?.getAttribute('colAddr') || '0');
      const rowAddr = parseInt(ca?.getAttribute('rowAddr') || '0');
      const cs = directChild(tc, 'cellSpan');
      const colSpan = parseInt(cs?.getAttribute('colSpan') || '1');
      const rowSpan = parseInt(cs?.getAttribute('rowSpan') || '1');
      const csz = directChild(tc, 'cellSz');
      const cellWidth = parseInt(csz?.getAttribute('width') || '0') / HWPUNIT_PER_PIXEL;
      const cellHeight = parseInt(csz?.getAttribute('height') || '0') / HWPUNIT_PER_PIXEL;

      const subList = directChild(tc, 'subList');
      const cellContent = subList
        ? parseContentItems(subList, header, numCounters, autoCounters)
        : [];

      let vertAlign: 'top' | 'middle' | 'bottom' = 'top';
      const va = subList?.getAttribute('vertAlign');
      if (va === 'CENTER') vertAlign = 'middle';
      else if (va === 'BOTTOM') vertAlign = 'bottom';

      const bfIDRef = tc.getAttribute('borderFillIDRef');
      const { borders, fillColor, imgRef } = resolveBorderFill(bfIDRef, header);

      const cell: TableCell = {
        content: cellContent, colSpan, rowSpan, colAddr, rowAddr,
        width: cellWidth, height: cellHeight,
        backgroundColor: fillColor, backgroundImgRef: imgRef,
        borderTop: borders?.top, borderBottom: borders?.bottom,
        borderLeft: borders?.left, borderRight: borders?.right,
        vertAlign,
      };
      rowCells.push(cell);
      allCells.push(cell);
    }
    rows.push({ cells: rowCells, height: rowCells.length > 0 ? rowCells[0].height : undefined });
  }

  // Parse table caption with autoNum support
  let caption: string | undefined;
  let captionSide: 'TOP' | 'BOTTOM' | undefined;
  const captionEl = directChild(tblElement, 'caption');
  if (captionEl) {
    captionSide = captionEl.getAttribute('side') === 'TOP' ? 'TOP' : 'BOTTOM';
    const texts: string[] = [];
    const subList = directChild(captionEl, 'subList');
    if (subList) {
      for (const p of directChildren(subList, 'p')) {
        // Resolve paragraph numbering for caption (야매 캡션 번호: <표 1.^1> 등)
        const capParaPrIDRef = p.getAttribute('paraPrIDRef');
        if (capParaPrIDRef && header) {
          const cni = resolveNumbering(capParaPrIDRef, header, numCounters);
          if (cni.numberingText) texts.push(cni.numberingText + ' ');
        }
        for (const run of directChildren(p, 'run')) {
          for (let ci2 = 0; ci2 < run.children.length; ci2++) {
            const child = run.children[ci2];
            const tag = child.localName || child.tagName.split(':').pop() || '';
            if (tag === 't') {
              for (let ni2 = 0; ni2 < child.childNodes.length; ni2++) {
                const node = child.childNodes[ni2];
                if (node.nodeType === Node.TEXT_NODE && node.textContent) {
                  texts.push(node.textContent);
                }
              }
            } else if (tag === 'ctrl') {
              const autoNumEl = child.getElementsByTagName('hp:autoNum')[0];
              if (autoNumEl) {
                const num = autoNumEl.getAttribute('num');
                if (num) texts.push(num);
              }
            }
          }
        }
      }
    }
    if (texts.length > 0) caption = texts.join('');
  }

  const colWidths = computeColWidths(allCells, colCnt, tableWidth);
  return { rows, width: tableWidth, colWidths, rowCnt: rows.length, colCnt, caption, captionSide };
}

// ==================== Image Parsing ====================

function parseImageElement(picElement: Element, header?: HeaderData | null, numCounters?: Map<string, number>): ImageElement | null {
  const imgEl = findElement(picElement, 'img');
  const binaryItemIDRef = imgEl?.getAttribute('binaryItemIDRef');
  if (!binaryItemIDRef) return null;

  // Use findElement (deep search) since these are nested inside shapeObject/shapeComponent
  const szEl = findElement(picElement, 'sz');
  const curSzEl = findElement(picElement, 'curSz');
  const orgSzEl = findElement(picElement, 'orgSz');
  const displaySzEl = szEl || curSzEl || orgSzEl;
  const width = parseInt(displaySzEl?.getAttribute('width') || '0') / HWPUNIT_PER_PIXEL;
  const height = parseInt(displaySzEl?.getAttribute('height') || '0') / HWPUNIT_PER_PIXEL;

  // Original size for crop calculation
  let orgWidth: number | undefined, orgHeight: number | undefined;
  if (orgSzEl) {
    orgWidth = parseInt(orgSzEl.getAttribute('width') || '0') / HWPUNIT_PER_PIXEL;
    orgHeight = parseInt(orgSzEl.getAttribute('height') || '0') / HWPUNIT_PER_PIXEL;
  }

  // imgDim: the coordinate space for imgClip (image at 96 DPI in HWPUNIT)
  let imgDimWidth: number | undefined, imgDimHeight: number | undefined;
  const imgDimEl = findElement(picElement, 'imgDim');
  if (imgDimEl) {
    const dw = imgDimEl.getAttribute('dimwidth');
    const dh = imgDimEl.getAttribute('dimheight');
    if (dw) imgDimWidth = parseInt(dw) / HWPUNIT_PER_PIXEL;
    if (dh) imgDimHeight = parseInt(dh) / HWPUNIT_PER_PIXEL;
  }

  // Image crop region (absolute rect coordinates in imgDim space)
  let imgClip: { left: number; right: number; top: number; bottom: number } | undefined;
  const clipEl = findElement(picElement, 'imgClip');
  if (clipEl) {
    const cl = parseInt(clipEl.getAttribute('left') || '0');
    const cr = parseInt(clipEl.getAttribute('right') || '0');
    const ct = parseInt(clipEl.getAttribute('top') || '0');
    const cb = parseInt(clipEl.getAttribute('bottom') || '0');
    if (cl > 0 || cr > 0 || ct > 0 || cb > 0) {
      imgClip = {
        left: cl / HWPUNIT_PER_PIXEL, right: cr / HWPUNIT_PER_PIXEL,
        top: ct / HWPUNIT_PER_PIXEL, bottom: cb / HWPUNIT_PER_PIXEL,
      };
    }
  }

  const posEl = findElement(picElement, 'pos');
  const treatAsChar = posEl?.getAttribute('treatAsChar') === '1';
  const horzAlign = posEl?.getAttribute('horzAlign') || 'LEFT';
  // textWrap is on the <hp:pic> element itself, NOT on <hp:pos>
  const textWrap = picElement.getAttribute('textWrap') || undefined;
  const vertOffsetAttr = posEl?.getAttribute('vertOffset');
  const horzOffsetAttr = posEl?.getAttribute('horzOffset');
  const vertOffset = vertOffsetAttr ? parseHwpInt(vertOffsetAttr) / HWPUNIT_PER_PIXEL : undefined;
  const horzOffset = horzOffsetAttr ? parseHwpInt(horzOffsetAttr) / HWPUNIT_PER_PIXEL : undefined;

  // Parse caption with autoNum and paragraph numbering support
  let caption: string | undefined;
  let captionSide: 'TOP' | 'BOTTOM' | undefined;
  const captionEl = directChild(picElement, 'caption');
  if (captionEl) {
    captionSide = captionEl.getAttribute('side') === 'TOP' ? 'TOP' : 'BOTTOM';
    const texts: string[] = [];
    const subList = directChild(captionEl, 'subList');
    if (subList) {
      for (const p of directChildren(subList, 'p')) {
        // Resolve paragraph numbering for caption (야매 캡션 번호)
        const capParaPrIDRef = p.getAttribute('paraPrIDRef');
        if (capParaPrIDRef && header && numCounters) {
          const ni = resolveNumbering(capParaPrIDRef, header, numCounters);
          if (ni.numberingText) texts.push(ni.numberingText + ' ');
        }
        for (const run of directChildren(p, 'run')) {
          for (let ci = 0; ci < run.children.length; ci++) {
            const child = run.children[ci];
            const tag = child.localName || child.tagName.split(':').pop() || '';
            if (tag === 't') {
              for (let ni2 = 0; ni2 < child.childNodes.length; ni2++) {
                const node = child.childNodes[ni2];
                if (node.nodeType === Node.TEXT_NODE && node.textContent) {
                  texts.push(node.textContent);
                }
              }
            } else if (tag === 'ctrl') {
              const autoNumEl = child.getElementsByTagName('hp:autoNum')[0];
              if (autoNumEl) {
                const num = autoNumEl.getAttribute('num');
                if (num) texts.push(num);
              }
            }
          }
        }
      }
    }
    if (texts.length > 0) caption = texts.join('');
  }

  const zOrder = parseInt(picElement.getAttribute('zOrder') || '0');
  return { id: binaryItemIDRef, width, height, inline: treatAsChar, caption, captionSide, horzAlign, orgWidth, orgHeight, imgClip, imgDimWidth, imgDimHeight, textWrap, vertOffset, horzOffset, zOrder };
}

/** Parse container (개체 묶기/group shape) — flatten children into content items */
function parseContainerElement(containerEl: Element, header: HeaderData | null, numCounters?: Map<string, number>): ContentItem[] {
  const items: ContentItem[] = [];
  const containerTextWrap = containerEl.getAttribute('textWrap') || 'TOP_AND_BOTTOM';
  const containerPosEl = findElement(containerEl, 'pos');
  const containerVertOffset = containerPosEl ? parseHwpInt(containerPosEl.getAttribute('vertOffset') || '0') / HWPUNIT_PER_PIXEL : 0;
  const containerHorzOffset = containerPosEl ? parseHwpInt(containerPosEl.getAttribute('horzOffset') || '0') / HWPUNIT_PER_PIXEL : 0;
  const containerVertRelTo = containerPosEl?.getAttribute('vertRelTo') || undefined;

  // Iterate direct children of the container
  for (let i = 0; i < containerEl.children.length; i++) {
    const child = containerEl.children[i];
    const tag = child.localName || child.tagName.split(':').pop() || '';

    if (tag === 'pic') {
      const img = parseImageElement(child, header, numCounters);
      if (img) {
        // Child images in a group inherit the container's textWrap and positioning
        img.textWrap = containerTextWrap;
        // Use transMatrix e3/e6 for child position within group
        const transEl = child.getElementsByTagName('hc:transMatrix')[0];
        const e3 = transEl ? parseFloat(transEl.getAttribute('e3') || '0') / HWPUNIT_PER_PIXEL : 0;
        const e6 = transEl ? parseFloat(transEl.getAttribute('e6') || '0') / HWPUNIT_PER_PIXEL : 0;
        img.vertOffset = containerVertOffset + e6;
        img.horzOffset = containerHorzOffset + e3;
        if (containerVertRelTo) img.textWrap = containerTextWrap;
        items.push({ type: 'image', data: img });
      }
    } else if (tag === 'rect') {
      const tb = parseRectElement(child, header, numCounters);
      if (tb) {
        tb.textWrap = containerTextWrap;
        tb.vertRelTo = containerVertRelTo;
        // Position from transMatrix or offset element
        const transEl = child.getElementsByTagName('hc:transMatrix')[0];
        const e3 = transEl ? parseFloat(transEl.getAttribute('e3') || '0') / HWPUNIT_PER_PIXEL : 0;
        const e6 = transEl ? parseFloat(transEl.getAttribute('e6') || '0') / HWPUNIT_PER_PIXEL : 0;
        tb.vertOffset = containerVertOffset + e6;
        tb.horzOffset = containerHorzOffset + e3;
        items.push({ type: 'textBox', data: tb });
      }
    } else if (tag === 'container') {
      // Nested container (groupLevel 1+) — recurse
      const nested = parseContainerElement(child, header, numCounters);
      items.push(...nested);
    }
  }
  return items;
}

/** Parse rect/textBox element — extract text from drawText/subList */
function parseRectElement(rectElement: Element, header?: HeaderData | null, numCounters?: Map<string, number>): TextBoxElement | null {
  const drawText = findElement(rectElement, 'drawText');
  if (!drawText) return null;
  const subList = directChild(drawText, 'subList');
  if (!subList) return null;
  const paragraphs: Paragraph[] = [];
  const vertAlignAttr = subList.getAttribute('vertAlign') || 'TOP';
  for (const p of directChildren(subList, 'p')) {
    const runs: TextRun[] = [];
    const paraPrIDRef = p.getAttribute('paraPrIDRef');
    const hps = resolveParaStyle(paraPrIDRef, header ?? null);
    const ni = numCounters ? resolveNumbering(paraPrIDRef, header ?? null, numCounters) : {};
    for (const run of directChildren(p, 'run')) {
      const charPrIDRef = run.getAttribute('charPrIDRef');
      const dp = resolveCharStyle(charPrIDRef, header ?? null);
      for (let ci = 0; ci < run.children.length; ci++) {
        const child = run.children[ci];
        const tag = child.localName || child.tagName.split(':').pop() || '';
        if (tag === 't') {
          for (let ni2 = 0; ni2 < child.childNodes.length; ni2++) {
            const node = child.childNodes[ni2];
            if (node.nodeType === Node.TEXT_NODE && node.textContent) {
              runs.push({ text: node.textContent, ...dp });
            } else if (node.nodeType === Node.ELEMENT_NODE) {
              const el = node as Element;
              const eln = el.localName || el.tagName.split(':').pop() || '';
              if (eln === 'lineBreak' || eln === 'softHyphen') runs.push({ text: '\n' });
              else if (eln === 'tab') runs.push({ text: '\t', isTab: true });
            }
          }
        }
      }
    }
    if (runs.length > 0 || runs.some(r => r.text.trim())) {
      paragraphs.push({ runs, ...hps, ...ni });
    }
  }
  if (paragraphs.length === 0) return null;
  const szEl = findElement(rectElement, 'sz');
  const orgSzEl = findElement(rectElement, 'orgSz');
  const displaySz = szEl || orgSzEl;
  const width = parseInt(displaySz?.getAttribute('width') || '0') / HWPUNIT_PER_PIXEL;
  const height = parseInt(displaySz?.getAttribute('height') || '0') / HWPUNIT_PER_PIXEL;
  const textWrap = rectElement.getAttribute('textWrap') || undefined;
  const posEl = findElement(rectElement, 'pos');
  const vertOffset = posEl ? parseHwpInt(posEl.getAttribute('vertOffset') || '0') / HWPUNIT_PER_PIXEL : undefined;
  const horzOffset = posEl ? parseHwpInt(posEl.getAttribute('horzOffset') || '0') / HWPUNIT_PER_PIXEL : undefined;
  const vertRelTo = posEl?.getAttribute('vertRelTo') || undefined;
  const zOrder = parseInt(rectElement.getAttribute('zOrder') || '0');
  return { paragraphs, width, height, textWrap, vertOffset, horzOffset, vertRelTo, zOrder, vertAlign: vertAlignAttr };
}

/** Parse equation element */
function parseEquationElement(eqElement: Element): EquationElement | null {
  const scriptEl = directChild(eqElement, 'script');
  const script = scriptEl?.textContent || '';
  if (!script) return null;
  const szEl = directChild(eqElement, 'sz');
  const width = parseInt(szEl?.getAttribute('width') || '0') / HWPUNIT_PER_PIXEL;
  const height = parseInt(szEl?.getAttribute('height') || '0') / HWPUNIT_PER_PIXEL;
  const baseLine = parseInt(eqElement.getAttribute('baseLine') || '0');
  const baseUnit = parseInt(eqElement.getAttribute('baseUnit') || '1000');
  const posEl = directChild(eqElement, 'pos');
  const inline = posEl?.getAttribute('treatAsChar') === '1';
  return { script, width, height, baseLine, baseUnit, inline };
}

// ==================== Section Parsing ====================

function parseSectionXml(xmlString: string, header: HeaderData | null): Section {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlString, 'application/xml');
  const numCounters = new Map<string, number>();
  const autoCounters: AutoNumCounters = { PICTURE: 0, TABLE: 0, EQUATION: 0, PAGE: 0 };
  const sectionMeta: {
    pageNumPos?: string; pageNumSideChar?: string; pageNumHidden?: boolean; pageStartNo?: number;
    pageNumResets?: Map<number, number>; hiddenPageNumPages?: Set<number>;
    footerContent?: ContentItem[]; headerContent?: ContentItem[];
    footnotes?: FootnoteData[];
  } = { footnotes: [] };

  let pageWidth: number | undefined, pageHeight: number | undefined;
  let marginLeft: number | undefined, marginRight: number | undefined;
  let marginTop: number | undefined, marginBottom: number | undefined;
  let headerMargin: number | undefined, footerMargin: number | undefined;

  const root = doc.documentElement;
  const topLevelPs = directChildren(root, 'p');
  const content: ContentItem[] = [];

  // Hybrid pagination: pageBreak="1" + lineseg vertpos detection (inter + intra paragraph)
  let currentPageIndex = 0;
  let prevMaxVertPos = -1;

  for (const para of topLevelPs) {
    const isPageBreak = para.getAttribute('pageBreak') === '1';

    // Inter-paragraph page break (explicit attribute)
    if (isPageBreak && content.length > 0) {
      currentPageIndex++;
      prevMaxVertPos = -1;
    }

    // Detect page breaks from lineseg data
    const linesegArray = directChild(para, 'linesegarray');
    if (linesegArray) {
      const linesegs = directChildren(linesegArray, 'lineseg');
      if (linesegs.length > 0) {
        const firstVP = parseInt(linesegs[0].getAttribute('vertpos') || '0');

        // Inter-paragraph lineseg detection: first line of this paragraph
        // is above the last line of the previous paragraph → page break between them
        if (!isPageBreak && prevMaxVertPos > 0 && firstVP < prevMaxVertPos - 2000) {
          currentPageIndex++;
        }

        // Intra-paragraph: vertpos decrease within this paragraph's linesegs
        let prevVP = firstVP;
        for (let li = 1; li < linesegs.length; li++) {
          const vp = parseInt(linesegs[li].getAttribute('vertpos') || '0');
          if (vp < prevVP - 2000) {
            currentPageIndex++;
          }
          prevVP = vp;
        }

        // Track last vertpos for next paragraph's inter-paragraph check
        const lastLS = linesegs[linesegs.length - 1];
        const lastVP = parseInt(lastLS.getAttribute('vertpos') || '0');
        const lastVS = parseInt(lastLS.getAttribute('vertsize') || '0');
        prevMaxVertPos = lastVP + lastVS;
      }
    } else if (!isPageBreak) {
      // No lineseg data — reset tracker
      prevMaxVertPos = -1;
    }

    const pageIdx = currentPageIndex;
    const runs = directChildren(para, 'run');
    const textRuns: TextRun[] = [];
    const paraPrIDRef = para.getAttribute('paraPrIDRef');
    const hps = resolveParaStyle(paraPrIDRef, header);
    const paraPr = findElement(para, 'paraPr');
    const ipp = parseParaProps(paraPr);
    const pp: Partial<Paragraph> = { ...hps, ...ipp };
    if (para.getAttribute('pageBreak') === '1') pp.pageBreakBefore = true;
    const ni = resolveNumbering(paraPrIDRef, header, numCounters);
    let hasNonText = false;

    // Track items added from this paragraph to assign pageIndex
    const contentStartIdx = content.length;

    for (const run of runs) {
      const charPrIDRef = run.getAttribute('charPrIDRef');
      const hcs = resolveCharStyle(charPrIDRef, header);
      const charPr = findElement(run, 'charPr');
      const dp = parseCharProps(charPr, hcs);

      for (let ci = 0; ci < run.children.length; ci++) {
        const child = run.children[ci];
        const cln = child.localName || child.tagName.split(':').pop() || '';
        switch (cln) {
          case 'secPr': {
            if (!pageWidth) {
              const pagePr = findElement(child, 'pagePr');
              if (pagePr) {
                const w = pagePr.getAttribute('width');
                const h = pagePr.getAttribute('height');
                if (w) pageWidth = parseInt(w) / HWPUNIT_PER_PIXEL;
                if (h) pageHeight = parseInt(h) / HWPUNIT_PER_PIXEL;
                const m = findElement(pagePr, 'margin') || findElement(child, 'pageMargin');
                if (m) {
                  const gv = (a: string) => { const v = m.getAttribute(a); return v ? parseInt(v) / HWPUNIT_PER_PIXEL : undefined; };
                  marginLeft = gv('left'); marginRight = gv('right');
                  marginTop = gv('top'); marginBottom = gv('bottom');
                  headerMargin = gv('header'); footerMargin = gv('footer');
                }
              }
            }
            // Parse page number settings from secPr (always, not gated by pageWidth)
            const secPageNum = findElement(child, 'pageNum');
            if (secPageNum) {
              const pos = secPageNum.getAttribute('pos');
              if (pos) sectionMeta.pageNumPos = pos;
              const sc = secPageNum.getAttribute('sideChar');
              if (sc) sectionMeta.pageNumSideChar = sc;
              const startNo = secPageNum.getAttribute('startNo');
              if (startNo) sectionMeta.pageStartNo = parseInt(startNo);
            }
            // Parse startNum: <hp:startNum page="N"> for page start number
            const startNumEl = findElement(child, 'startNum');
            if (startNumEl) {
              const pageStart = startNumEl.getAttribute('page');
              if (pageStart && parseInt(pageStart) > 0) sectionMeta.pageStartNo = parseInt(pageStart);
            }
            // Parse visibility: <hp:visibility hideFirstPageNum="1">
            const visibilityEl = findElement(child, 'visibility');
            if (visibilityEl) {
              if (visibilityEl.getAttribute('hideFirstPageNum') === '1') {
                // hideFirstPageNum only hides first page's number — handled differently
              }
            }
            // Parse pageHiding: hide page numbers, headers, footers etc.
            const pageHiding = findElement(child, 'pageHiding');
            if (pageHiding) {
              if (pageHiding.getAttribute('hidePageNum') === '1' || pageHiding.getAttribute('pageNumPos') === '1') {
                sectionMeta.pageNumHidden = true;
              }
            }
            break;
          }
          case 'tbl': {
            if (textRuns.length > 0 && textRuns.some(r => r.text.trim())) {
              content.push({ type: 'paragraph', data: { runs: [...textRuns], ...pp, ...ni } });
              textRuns.length = 0;
            }
            const table = parseTableElement(child, header, numCounters, autoCounters);
            if (table.rows.length > 0) { content.push({ type: 'table', data: table }); hasNonText = true; }
            break;
          }
          case 'pic': {
            if (textRuns.length > 0 && textRuns.some(r => r.text.trim())) {
              content.push({ type: 'paragraph', data: { runs: [...textRuns], ...pp, ...ni } });
              textRuns.length = 0;
            }
            const img = parseImageElement(child, header, numCounters);
            if (img) { content.push({ type: 'image', data: img }); hasNonText = true; }
            break;
          }
          case 'rect': {
            const tb = parseRectElement(child, header, numCounters);
            if (tb) {
              if (textRuns.length > 0 && textRuns.some(r => r.text.trim())) {
                content.push({ type: 'paragraph', data: { runs: [...textRuns], ...pp, ...ni } });
                textRuns.length = 0;
              }
              content.push({ type: 'textBox', data: tb }); hasNonText = true;
            }
            break;
          }
          case 'container': {
            if (textRuns.length > 0 && textRuns.some(r => r.text.trim())) {
              content.push({ type: 'paragraph', data: { runs: [...textRuns], ...pp, ...ni } });
              textRuns.length = 0;
            }
            const groupItems = parseContainerElement(child, header, numCounters);
            for (const gi of groupItems) content.push(gi);
            hasNonText = true;
            break;
          }
          case 'equation': {
            const eq = parseEquationElement(child);
            if (eq) {
              // Inline equations (treatAsChar="1") become part of text flow
              if (eq.inline) {
                const html = equationScriptToHtml(eq.script);
                textRuns.push({ text: eq.script, ...dp, equationHtml: html });
              } else {
                // Block equation: flush text, emit as separate item
                if (textRuns.length > 0 && textRuns.some(r => r.text.trim())) {
                  content.push({ type: 'paragraph', data: { runs: [...textRuns], ...pp, ...ni } });
                  textRuns.length = 0;
                }
                content.push({ type: 'equation', data: eq });
                hasNonText = true;
              }
            }
            break;
          }
          case 't': {
            // Handle mixed content: text nodes and inline elements (tab, lineBreak, fwSpace, titleMark)
            for (let ni2 = 0; ni2 < child.childNodes.length; ni2++) {
              const node = child.childNodes[ni2];
              if (node.nodeType === Node.TEXT_NODE) {
                const text = node.textContent;
                if (text) textRuns.push({ text, ...dp });
              } else if (node.nodeType === Node.ELEMENT_NODE) {
                const el = node as Element;
                const etag = el.localName || el.tagName.split(':').pop() || '';
                if (etag === 'tab') {
                  const leader = el.getAttribute('leader');
                  const w = el.getAttribute('width');
                  textRuns.push({
                    text: '\t', ...dp, isTab: true,
                    tabLeader: leader ? mapTabLeader(leader) : undefined,
                    tabWidth: w ? parseInt(w) / HWPUNIT_PER_PIXEL : undefined,
                  });
                } else if (etag === 'lineBreak') {
                  textRuns.push({ text: '\n', ...dp });
                } else if (etag === 'fwSpace') {
                  textRuns.push({ text: '\u3000', ...dp });
                }
              }
            }
            break;
          }
          case 'tab': {
            const leader = child.getAttribute('leader');
            const w = child.getAttribute('width');
            textRuns.push({
              text: '\t', ...dp, isTab: true,
              tabLeader: leader ? mapTabLeader(leader) : undefined,
              tabWidth: w ? parseInt(w) / HWPUNIT_PER_PIXEL : undefined,
            });
            break;
          }
          case 'lineBreak':
            textRuns.push({ text: '\n', ...dp });
            break;
          case 'fwSpace':
            textRuns.push({ text: '\u3000', ...dp }); // full-width space
            break;
          case 'ctrl': {
            const prevHidden = sectionMeta.pageNumHidden;
            const prevPageStart = sectionMeta.pageStartNo;
            const ctrlResult = processCtrl(child, autoCounters, sectionMeta, header, numCounters, pageIdx);
            if (ctrlResult) textRuns.push({ text: ctrlResult, ...dp });
            // Track per-page pageHiding
            if (sectionMeta.pageNumHidden && !prevHidden) {
              if (!sectionMeta.hiddenPageNumPages) sectionMeta.hiddenPageNumPages = new Set();
              sectionMeta.hiddenPageNumPages.add(pageIdx);
              sectionMeta.pageNumHidden = false; // Reset for next page
            }
            // Track per-page page number reset (newNum PAGE)
            if (sectionMeta.pageStartNo !== prevPageStart && sectionMeta.pageStartNo !== undefined) {
              if (!sectionMeta.pageNumResets) sectionMeta.pageNumResets = new Map();
              sectionMeta.pageNumResets.set(pageIdx, sectionMeta.pageStartNo);
            }
            break;
          }
          default:
            break;
        }
      }
    }

    if (textRuns.length > 0 && (textRuns.some(r => r.text.trim()) || textRuns.some(r => r.isTab))) {
      content.push({ type: 'paragraph', data: { runs: textRuns, ...pp, ...ni } });
    } else if (!hasNonText) {
      content.push({ type: 'paragraph', data: { runs: [{ text: '' }], ...pp } });
    }

    // Assign pageIndex to all items added from this paragraph
    for (let idx = contentStartIdx; idx < content.length; idx++) {
      content[idx].pageIndex = pageIdx;
    }
  }

  // Fallback: deep search
  if (content.length === 0) {
    log('[HwpxViewer] Fallback: deep search');
    const allTexts = doc.getElementsByTagName('hp:t');
    const seen = new Set<string>();
    for (let i = 0; i < allTexts.length; i++) {
      const text = allTexts[i].textContent?.trim();
      if (text && !seen.has(text)) { seen.add(text); content.push({ type: 'paragraph', data: { runs: [{ text }] } }); }
    }
  }

  log('[HwpxViewer] Section:', content.length, 'items, pages:', currentPageIndex + 1,
    'footnotes:', sectionMeta.footnotes?.length || 0);

  return {
    content, pageWidth, pageHeight, marginLeft, marginRight, marginTop, marginBottom,
    headerMargin, footerMargin,
    pageNumPos: sectionMeta.pageNumPos, pageNumSideChar: sectionMeta.pageNumSideChar,
    pageNumHidden: sectionMeta.pageNumHidden, pageStartNo: sectionMeta.pageStartNo,
    pageNumResets: sectionMeta.pageNumResets, hiddenPageNumPages: sectionMeta.hiddenPageNumPages,
    footerContent: sectionMeta.footerContent, headerContent: sectionMeta.headerContent,
    footnotes: sectionMeta.footnotes,
  };
}

// ==================== Page Pagination ====================

function paginateSection(section: Section): ContentItem[][] {
  // Use lineseg-based pageIndex if available (most accurate)
  const hasPageIndex = section.content.some(item => item.pageIndex !== undefined);
  if (hasPageIndex) {
    const pageMap = new Map<number, ContentItem[]>();
    for (const item of section.content) {
      const pi = item.pageIndex ?? 0;
      if (!pageMap.has(pi)) pageMap.set(pi, []);
      pageMap.get(pi)!.push(item);
    }
    const sorted = Array.from(pageMap.entries()).sort((a, b) => a[0] - b[0]);
    return sorted.length > 0 ? sorted.map(([, items]) => items) : [[]];
  }

  // Fallback: use explicit pageBreak="1" only (no height estimation)
  const pages: ContentItem[][] = [];
  let currentPage: ContentItem[] = [];
  for (const item of section.content) {
    if (item.type === 'paragraph' && item.data.pageBreakBefore && currentPage.length > 0) {
      pages.push(currentPage);
      currentPage = [];
    }
    currentPage.push(item);
  }
  if (currentPage.length > 0) pages.push(currentPage);
  return pages.length > 0 ? pages : [[]];
}

// ==================== React Component ====================

export function HwpxViewer({ data }: HwpxViewerProps) {
  const [sections, setSections] = useState<Section[]>([]);
  const [images, setImages] = useState<Map<string, string>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [zoom, setZoom] = useState(1);
  const [currentPageIdx, setCurrentPageIdx] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef<(HTMLDivElement | null)[]>([]);

  useEffect(() => {
    const loadHwpx = async () => {
      try {
        setLoading(true);
        setError(null);
        const zip = await JSZip.loadAsync(data);
        const loadedSections: Section[] = [];
        const loadedImages = new Map<string, string>();

        let headerData: HeaderData | null = null;
        const headerFile = zip.file('Contents/header.xml');
        if (headerFile) headerData = parseHeaderXml(await headerFile.async('string'));

        const sectionFiles: string[] = [];
        zip.forEach((path) => { if (path.match(/Contents\/section\d+\.xml$/i)) sectionFiles.push(path); });
        sectionFiles.sort((a, b) => {
          const nA = parseInt(a.match(/section(\d+)/i)?.[1] || '0');
          const nB = parseInt(b.match(/section(\d+)/i)?.[1] || '0');
          return nA - nB;
        });

        for (const sp of sectionFiles) {
          const xml = await zip.file(sp)?.async('string');
          if (xml) loadedSections.push(parseSectionXml(xml, headerData));
        }

        if (loadedSections.length === 0) {
          const pf = zip.file('Preview/PrvText.txt');
          if (pf) {
            const text = await pf.async('string');
            if (text) loadedSections.push({
              content: text.split(/\n/).filter(l => l.trim()).map(l => ({
                type: 'paragraph' as const, data: { runs: [{ text: l }] },
              })),
            });
          }
        }

        // Load embedded images
        const imagePromises: Promise<void>[] = [];
        zip.forEach((path, file) => {
          if (path.startsWith('BinData/') && !file.dir) {
            imagePromises.push((async () => {
              try {
                const imgData = await file.async('base64');
                const ext = path.split('.').pop()?.toLowerCase() || 'png';
                const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' :
                            ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' :
                            ext === 'bmp' ? 'image/bmp' : ext === 'wmf' ? 'image/x-wmf' :
                            ext === 'emf' ? 'image/x-emf' : ext === 'svg' ? 'image/svg+xml' : 'image/png';
                const dataUrl = `data:${mime};base64,${imgData}`;
                loadedImages.set(path, dataUrl);
                const fn = path.split('/').pop() || '';
                if (fn) { loadedImages.set(fn, dataUrl); loadedImages.set(fn.replace(/\.[^.]+$/, ''), dataUrl); }
              } catch (e) { console.warn('[HwpxViewer] Image load failed:', path, e); }
            })());
          }
        });
        await Promise.all(imagePromises);

        setSections(loadedSections);
        setImages(loadedImages);
        setLoading(false);
      } catch (err) {
        console.error('[HwpxViewer] Parse failed:', err);
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      }
    };
    loadHwpx();
  }, [data]);

  // Ctrl+Scroll zoom — use document-level capture to intercept before browser native zoom
  useEffect(() => {
    const handler = (e: WheelEvent) => {
      if (!e.ctrlKey || !containerRef.current) return;
      if (!containerRef.current.contains(e.target as Node)) return;
      e.preventDefault();
      e.stopPropagation();
      setZoom(prev => Math.min(3, Math.max(0.25, prev + (e.deltaY > 0 ? -0.1 : 0.1))));
    };
    document.addEventListener('wheel', handler, { passive: false, capture: true } as AddEventListenerOptions);
    return () => document.removeEventListener('wheel', handler, { capture: true } as EventListenerOptions);
  }, []);

  // ==================== Rendering ====================

  const resolveImageSrc = (id: string): string | undefined => {
    return images.get(`BinData/${id}`) || images.get(id) ||
      Array.from(images.entries()).find(([k]) => k.includes(id))?.[1];
  };

  const renderTextRun = (run: TextRun, index: number) => {
    // Inline equation — render as formatted math HTML
    if (run.equationHtml) {
      return <span key={index} style={{
        fontFamily: "'Cambria Math', 'Latin Modern Math', 'Times New Roman', serif",
        fontStyle: 'italic',
        display: 'inline',
        verticalAlign: 'middle',
      }} dangerouslySetInnerHTML={{ __html: run.equationHtml }} />;
    }

    // Line break (Shift+Enter) — render as <br/>
    if (run.text === '\n') return <br key={index} />;

    const style: React.CSSProperties = {};
    if (run.bold) style.fontWeight = 'bold';
    if (run.italic) style.fontStyle = 'italic';
    if (run.underline) style.textDecoration = 'underline';
    if (run.strikethrough) style.textDecoration = style.textDecoration ? `${style.textDecoration} line-through` : 'line-through';
    if (run.fontSize) style.fontSize = `${run.fontSize}pt`;
    if (run.fontFamily) style.fontFamily = run.fontFamily;
    if (run.color) style.color = run.color;
    if (run.backgroundColor) style.backgroundColor = run.backgroundColor;
    if (run.superscript) { style.verticalAlign = 'super'; style.fontSize = '0.65em'; style.lineHeight = '0'; }
    if (run.subscript) { style.verticalAlign = 'sub'; style.fontSize = '0.65em'; style.lineHeight = '0'; }
    if (run.letterSpacing) style.letterSpacing = `${run.letterSpacing / 100}em`;
    if (run.charRatio && run.charRatio !== 100) style.transform = `scaleX(${run.charRatio / 100})`;
    return <span key={index} style={style}>{run.text}</span>;
  };

  const renderParagraph = (para: Paragraph, key: string) => {
    const alignValue = para.align === 'distribute' ? 'justify' : (para.align || 'justify');
    const style: React.CSSProperties = {
      margin: 0, textAlign: alignValue, lineHeight: para.lineHeight || 1.6,
    };
    // DISTRIBUTE_SPACE: justify all lines including the last, preserve spaces for centering
    if (para.align === 'distribute') {
      (style as Record<string, unknown>)['textAlignLast'] = 'justify';
      style.whiteSpace = 'pre-wrap';
    }
    if (para.marginTop != null && para.marginTop > 0) style.marginTop = para.marginTop;
    if (para.marginBottom != null && para.marginBottom > 0) style.marginBottom = para.marginBottom;
    if (para.indent) style.textIndent = para.indent;
    if (para.marginLeft) style.marginLeft = para.marginLeft;

    const hasContent = para.runs.some(run => run.text.trim() || run.equationHtml);
    const hasTabs = para.runs.some(run => run.isTab);

    // Empty paragraph — render as proper blank line with correct height
    if (!hasContent && !hasTabs && !para.bulletChar && !para.numberingText) {
      const fontSize = para.runs[0]?.fontSize;
      if (fontSize) style.fontSize = `${fontSize}pt`;
      return <p key={key} style={style}>&nbsp;</p>;
    }

    // Tab-separated rendering (e.g., TOC entries with dot/dash leaders)
    if (hasTabs) {
      const segments: TextRun[][] = [[]];
      const tabRuns: (TextRun | undefined)[] = [undefined]; // tab run preceding each segment
      for (const run of para.runs) {
        if (run.isTab) {
          tabRuns.push(run);
          segments.push([]);
        } else {
          segments[segments.length - 1].push(run);
        }
      }

      style.display = 'flex';
      style.alignItems = 'baseline';
      style.textIndent = 0; // reset indent for flex layout

      const children: React.ReactNode[] = [];
      let tabIdx = 0;
      for (let si = 0; si < segments.length; si++) {
        if (si > 0) {
          const tabRun = tabRuns[si];
          const tabStop = para.tabStops?.[tabIdx] || para.tabStops?.[0];
          tabIdx++;
          // Prefer inline tab leader (from <hp:tab> attributes) over tabStop definition
          const leader = tabRun?.tabLeader || tabStop?.leader || 'NONE';
          if (leader === 'DOT') {
            children.push(
              <span key={`tl-${si}`} style={{
                flex: 1, overflow: 'hidden', whiteSpace: 'nowrap',
                letterSpacing: '1.5px', opacity: 0.5, margin: '0 4px',
              }}>
                {'·'.repeat(300)}
              </span>
            );
          } else if (leader === 'LONG_DASH' || leader === 'DASH' || leader === 'DASH_DOT' || leader === 'DASH_DOT_DOT' || leader === 'HYPHEN') {
            children.push(
              <span key={`tl-${si}`} style={{
                flex: 1, overflow: 'hidden', whiteSpace: 'nowrap',
                opacity: 0.5, margin: '0 4px',
              }}>
                {(leader === 'LONG_DASH' ? '─' : '-').repeat(300)}
              </span>
            );
          } else if (leader === 'SOLID') {
            children.push(
              <span key={`tl-${si}`} style={{
                flex: 1, overflow: 'hidden', whiteSpace: 'nowrap',
                opacity: 0.5, margin: '0 4px',
              }}>
                {'─'.repeat(300)}
              </span>
            );
          } else {
            children.push(<span key={`tl-${si}`} style={{ flex: 1, minWidth: '1em' }} />);
          }
        }
        if (segments[si].length > 0) {
          children.push(
            <span key={`ts-${si}`} style={{ flexShrink: 0, whiteSpace: si > 0 ? 'nowrap' : undefined }}>
              {segments[si].map((run, ri) => renderTextRun(run, ri))}
            </span>
          );
        }
      }

      return <p key={key} style={style}>{children}</p>;
    }

    // Bullet or numbering prefix
    if (para.bulletChar || para.numberingText) {
      style.display = 'flex';
      style.gap = '4px';
      const prefix = para.bulletChar || para.numberingText || '';
      if (!hasContent) return <p key={key} style={style}>&nbsp;</p>;
      // Apply numbering font: from paraHead charPrIDRef, or fallback to first text run
      const prefixStyle: React.CSSProperties = {
        flexShrink: 0, minWidth: para.bulletChar ? '1em' : 'auto',
        textAlign: 'right', paddingRight: '4px',
      };
      const ns = para.numberingStyle;
      const fontSource = ns && (ns.fontSize || ns.fontFamily || ns.bold)
        ? ns : para.runs.find(r => r.text.trim());
      if (fontSource) {
        if (fontSource.bold) prefixStyle.fontWeight = 'bold';
        if (fontSource.italic) prefixStyle.fontStyle = 'italic';
        if (fontSource.fontSize) prefixStyle.fontSize = `${fontSource.fontSize}pt`;
        if (fontSource.fontFamily) prefixStyle.fontFamily = fontSource.fontFamily;
        if (fontSource.color) prefixStyle.color = fontSource.color;
      }
      return (
        <p key={key} style={style}>
          <span style={prefixStyle}>{prefix}</span>
          <span style={{ flex: 1 }}>{para.runs.map((run, i) => renderTextRun(run, i))}</span>
        </p>
      );
    }

    // Distribute alignment
    if (para.align === 'distribute') {
      // Detect centered equation pattern: [spaces...][equation][...spaces (N)]
      const eqIdx = para.runs.findIndex(r => r.equationHtml);
      if (eqIdx >= 0) {
        const allLeadingWhitespace = para.runs.slice(0, eqIdx).every(r => !r.text.trim() && !r.equationHtml);
        if (allLeadingWhitespace && eqIdx > 0) {
          // Separate equation content from trailing number like "(1)"
          const trailingRuns: TextRun[] = [];
          for (let i = eqIdx + 1; i < para.runs.length; i++) {
            const trimmed = para.runs[i].text.trim();
            if (trimmed) trailingRuns.push({ ...para.runs[i], text: trimmed });
          }
          const eqStyle: React.CSSProperties = {
            margin: style.margin, lineHeight: style.lineHeight,
            marginTop: style.marginTop, marginBottom: style.marginBottom,
            marginLeft: style.marginLeft,
            display: 'flex', alignItems: 'baseline',
          };
          return (
            <p key={key} style={eqStyle}>
              <span style={{ flex: 1, textAlign: 'center' }}>
                {renderTextRun(para.runs[eqIdx], eqIdx)}
              </span>
              {trailingRuns.length > 0 && (
                <span style={{ flexShrink: 0 }}>
                  {trailingRuns.map((run, i) => renderTextRun(run, eqIdx + 1 + i))}
                </span>
              )}
            </p>
          );
        }
      }
      // General distribute: insert word-break spaces between runs so CSS justify works
      return (
        <p key={key} style={style}>
          {para.runs.map((run, i) => (
            <>{renderTextRun(run, i)}{i < para.runs.length - 1 && run.text !== '\n' && para.runs[i + 1]?.text !== '\n' ? ' ' : null}</>
          ))}
        </p>
      );
    }

    return <p key={key} style={style}>{para.runs.map((run, i) => renderTextRun(run, i))}</p>;
  };

  const borderToCSS = (border?: BorderStyle): string => {
    if (!border || border.type === 'NONE') return 'none';
    const w = Math.max(1, border.width || 1);
    const color = border.color && border.color !== 'none' ? border.color : '#000';
    const type = border.type === 'DOUBLE' ? 'double' : border.type === 'DOTTED' ? 'dotted' : border.type === 'DASHED' ? 'dashed' : 'solid';
    return `${w}px ${type} ${color}`;
  };

  const renderTable = (table: Table, key: string) => {
    const totalWidth = table.colWidths.reduce((a, b) => a + b, 0);

    const captionEl = table.caption ? (
      <div style={{ fontSize: '0.85em', color: '#555', textAlign: 'center', padding: '4px 0' }}>{table.caption}</div>
    ) : null;

    return (
      <div key={key} style={{ margin: '2px 0' }}>
        {table.captionSide === 'TOP' && captionEl}
        <table className="hwpx-table" style={{ borderCollapse: 'collapse', width: totalWidth || table.width || '100%', tableLayout: 'fixed' }}>
          {table.colWidths.length > 0 && (
            <colgroup>{table.colWidths.map((w, i) => <col key={i} style={{ width: w }} />)}</colgroup>
          )}
          <tbody>
            {table.rows.map((row, ri) => (
              <tr key={ri} style={{ height: row.height }}>
                {row.cells.map((cell, ci) => {
                  const cellStyle: React.CSSProperties = {
                    backgroundColor: cell.backgroundColor,
                    borderTop: borderToCSS(cell.borderTop), borderBottom: borderToCSS(cell.borderBottom),
                    borderLeft: borderToCSS(cell.borderLeft), borderRight: borderToCSS(cell.borderRight),
                    verticalAlign: cell.vertAlign || 'top', padding: '2px 4px',
                    wordBreak: 'break-word', overflow: 'hidden',
                  };
                  // Cell background image
                  if (cell.backgroundImgRef) {
                    const src = resolveImageSrc(cell.backgroundImgRef);
                    if (src) {
                      cellStyle.backgroundImage = `url(${src})`;
                      cellStyle.backgroundSize = 'contain';
                      cellStyle.backgroundRepeat = 'no-repeat';
                      cellStyle.backgroundPosition = 'center';
                    }
                  }
                  return (
                    <td key={ci}
                      colSpan={cell.colSpan > 1 ? cell.colSpan : undefined}
                      rowSpan={cell.rowSpan > 1 ? cell.rowSpan : undefined}
                      style={cellStyle}
                    >
                      {cell.content.map((item, ii) => renderContentItem(item, `${key}-r${ri}-c${ci}-i${ii}`))}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        {table.captionSide !== 'TOP' && captionEl}
      </div>
    );
  };

  const renderImage = (image: ImageElement, key: string) => {
    const src = resolveImageSrc(image.id);
    if (!src) return null;

    // Image cropping: imgClip values are ABSOLUTE COORDINATES in imgDim coordinate space
    // Use percentage-based approach so it works regardless of actual image pixel dimensions
    const refW = image.imgDimWidth || image.orgWidth;
    const refH = image.imgDimHeight || image.orgHeight;
    if (image.imgClip && refW && refH && (image.imgClip.right > 0 || image.imgClip.bottom > 0)) {
      const displayW = image.width > 0 ? image.width : 200;
      const displayH = image.height > 0 ? image.height : 200;
      // Calculate crop as percentage of the full image
      const leftPct = image.imgClip.left / refW;
      const topPct = image.imgClip.top / refH;
      const visibleWPct = (image.imgClip.right - image.imgClip.left) / refW;
      const visibleHPct = (image.imgClip.bottom - image.imgClip.top) / refH;
      // Full image size so visible portion = displayW x displayH
      const fullImgW = visibleWPct > 0 ? displayW / visibleWPct : displayW;
      const fullImgH = visibleHPct > 0 ? displayH / visibleHPct : displayH;
      // Offset to show only the visible portion
      const offsetX = -fullImgW * leftPct;
      const offsetY = -fullImgH * topPct;

      const containerStyle: React.CSSProperties = {
        width: displayW, height: displayH,
        overflow: 'hidden', position: 'relative',
        display: image.inline ? 'inline-block' : 'block',
      };
      if (!image.inline) {
        containerStyle.margin = image.horzAlign === 'CENTER' ? '8px auto' : image.horzAlign === 'RIGHT' ? '8px 0 8px auto' : '8px 0';
      }
      const imgEl = (
        <div style={containerStyle}>
          <img src={src} alt={image.caption || ''} style={{
            position: 'absolute',
            width: fullImgW, height: fullImgH,
            left: offsetX, top: offsetY,
          }} />
        </div>
      );

      if (image.caption) {
        const figStyle: React.CSSProperties = { margin: '8px 0', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center' };
        if (image.horzAlign === 'CENTER') figStyle.margin = '8px auto';
        else if (image.horzAlign === 'RIGHT') figStyle.alignItems = 'flex-end';
        const cap = <figcaption style={{ fontSize: '0.85em', color: '#555', marginTop: image.captionSide === 'BOTTOM' ? '4px' : undefined, marginBottom: image.captionSide === 'TOP' ? '4px' : undefined }}>{image.caption}</figcaption>;
        return <figure key={key} style={figStyle}>{image.captionSide === 'TOP' && cap}{imgEl}{image.captionSide !== 'TOP' && cap}</figure>;
      }
      return <div key={key}>{imgEl}</div>;
    }

    // No cropping — simple image render
    const imgStyle: React.CSSProperties = {
      maxWidth: '100%',
      width: image.width > 0 ? image.width : 'auto',
      height: image.height > 0 ? image.height : 'auto',
      display: image.inline ? 'inline' : 'block',
    };

    if (image.caption) {
      const figStyle: React.CSSProperties = { margin: '8px 0', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center' };
      if (image.horzAlign === 'CENTER') figStyle.margin = '8px auto';
      else if (image.horzAlign === 'RIGHT') figStyle.alignItems = 'flex-end';
      const cap = <figcaption style={{ fontSize: '0.85em', color: '#555', marginTop: image.captionSide === 'BOTTOM' ? '4px' : undefined, marginBottom: image.captionSide === 'TOP' ? '4px' : undefined }}>{image.caption}</figcaption>;
      return (
        <figure key={key} style={figStyle}>
          {image.captionSide === 'TOP' && cap}
          <img src={src} alt={image.caption} className="hwpx-inline-image" style={imgStyle} />
          {image.captionSide !== 'TOP' && cap}
        </figure>
      );
    }

    if (!image.inline) {
      imgStyle.margin = image.horzAlign === 'CENTER' ? '8px auto' : image.horzAlign === 'RIGHT' ? '8px 0 8px auto' : '8px 0';
    } else {
      imgStyle.margin = '0 2px';
    }
    return <img key={key} src={src} alt="" className="hwpx-inline-image" style={imgStyle} />;
  };

  const renderEquation = (eq: EquationElement, key: string) => {
    const html = equationScriptToHtml(eq.script);
    const style: React.CSSProperties = {
      display: 'block',
      fontFamily: "'Cambria Math', 'Latin Modern Math', 'STIX Two Math', 'Times New Roman', serif",
      fontStyle: 'italic',
      fontSize: eq.baseUnit ? `${eq.baseUnit / 100}pt` : '11pt',
      textAlign: 'center',
      padding: '8px 0',
      lineHeight: 1.4,
      margin: '4px auto',
    };
    return <div key={key} style={style} title={eq.script} dangerouslySetInnerHTML={{ __html: html }} />;
  };

  const renderTextBox = (tb: TextBoxElement, key: string) => {
    const style: React.CSSProperties = {};
    if (tb.width > 0) style.width = tb.width;
    if (tb.vertAlign === 'BOTTOM') { style.display = 'flex'; style.flexDirection = 'column'; style.justifyContent = 'flex-end'; }
    else if (tb.vertAlign === 'CENTER') { style.display = 'flex'; style.flexDirection = 'column'; style.justifyContent = 'center'; }
    return (
      <div key={key} style={style}>
        {tb.paragraphs.map((p, i) => renderParagraph(p, `${key}-p${i}`))}
      </div>
    );
  };

  const renderContentItem = (item: ContentItem, key: string) => {
    switch (item.type) {
      case 'paragraph': return renderParagraph(item.data, key);
      case 'table': return renderTable(item.data, key);
      case 'image': return renderImage(item.data, key);
      case 'equation': return renderEquation(item.data, key);
      case 'textBox': return renderTextBox(item.data, key);
    }
  };

  const renderFooterHeader = (content: ContentItem[] | undefined, key: string, pageNum?: number) => {
    if (!content || content.length === 0) return null;
    // Replace __PAGE_NUM__ placeholder with actual page number
    const resolvedContent = pageNum !== undefined ? content.map(item => {
      if (item.type !== 'paragraph') return item;
      const hasPlaceholder = item.data.runs.some(r => r.text.includes('__PAGE_NUM__'));
      if (!hasPlaceholder) return item;
      return { ...item, data: { ...item.data, runs: item.data.runs.map(r =>
        r.text.includes('__PAGE_NUM__') ? { ...r, text: r.text.replace('__PAGE_NUM__', String(pageNum)) } : r
      ) } };
    }) : content;
    return (
      <div key={key} style={{ fontSize: '0.85em' }}>
        {resolvedContent.map((item, i) => renderContentItem(item, `${key}-${i}`))}
      </div>
    );
  };

  // Pre-compute paginated pages with footnote assignment
  const paginatedPages = useMemo(() => {
    if (sections.length === 0) return [];
    const result: { section: Section; pageContent: ContentItem[]; globalPageNum: number; sectionPageIdx: number; pageFootnotes: FootnoteData[]; backgroundImages: ImageElement[]; overlayImages: ImageElement[]; overlayTextBoxes: TextBoxElement[] }[] = [];
    let gp = 0;
    for (const section of sections) {
      const sectionPages = paginateSection(section);
      // Distribute footnotes to pages using pageIndex recorded during parsing
      const footnotesByPage = new Map<number, FootnoteData[]>();
      if (section.footnotes) {
        for (const fn of section.footnotes) {
          const pi = fn.pageIndex ?? 0;
          // Clamp to valid page range
          const clampedPi = Math.min(pi, sectionPages.length - 1);
          if (!footnotesByPage.has(clampedPi)) footnotesByPage.set(clampedPi, []);
          footnotesByPage.get(clampedPi)!.push(fn);
        }
      }

      // Apply page start number if specified (only if no per-page resets exist)
      if (section.pageStartNo !== undefined && !section.pageNumResets?.size) gp = section.pageStartNo - 1;

      for (let pi = 0; pi < sectionPages.length; pi++) {
        // Per-page page number reset (from newNum PAGE)
        if (section.pageNumResets?.has(pi)) {
          gp = section.pageNumResets.get(pi)! - 1;
        }
        gp++;
        // Separate behind-text images, overlay images/textboxes from content
        const bgImages: ImageElement[] = [];
        const overlayImgs: ImageElement[] = [];
        const overlayTBs: TextBoxElement[] = [];
        const filteredContent: ContentItem[] = [];
        for (const item of sectionPages[pi]) {
          if (item.type === 'image' && (item.data.textWrap === 'BEHIND_TEXT' || item.data.textWrap === 'behindText')) {
            bgImages.push(item.data);
          } else if (item.type === 'image' && item.data.textWrap === 'IN_FRONT_OF_TEXT') {
            overlayImgs.push(item.data);
          } else if (item.type === 'textBox' && item.data.textWrap === 'BEHIND_TEXT') {
            // BEHIND_TEXT text boxes (sidebar labels) — skip, not visible in preview
          } else if (item.type === 'textBox' && item.data.textWrap === 'IN_FRONT_OF_TEXT') {
            overlayTBs.push(item.data);
          } else {
            filteredContent.push(item);
          }
        }
        result.push({
          section, pageContent: filteredContent, globalPageNum: gp, sectionPageIdx: pi,
          pageFootnotes: footnotesByPage.get(pi) || [], backgroundImages: bgImages, overlayImages: overlayImgs, overlayTextBoxes: overlayTBs,
        });
      }
    }
    return result;
  }, [sections]);

  // ==================== Page Navigation ====================

  // IntersectionObserver to track current visible page
  useEffect(() => {
    const root = contentRef.current;
    if (!root || paginatedPages.length === 0) return;
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          const idx = parseInt(entry.target.getAttribute('data-page-idx') || '0');
          setCurrentPageIdx(idx);
          break;
        }
      }
    }, { root, threshold: 0.3 });
    pageRefs.current.forEach(ref => ref && observer.observe(ref));
    return () => observer.disconnect();
  }, [paginatedPages]);

  const jumpToPage = useCallback((idx: number) => {
    const clamped = Math.max(0, Math.min(paginatedPages.length - 1, idx));
    pageRefs.current[clamped]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [paginatedPages.length]);

  const goToPrevPage = useCallback(() => jumpToPage(currentPageIdx - 1), [jumpToPage, currentPageIdx]);
  const goToNextPage = useCallback(() => jumpToPage(currentPageIdx + 1), [jumpToPage, currentPageIdx]);

  // ==================== Component Rendering ====================

  if (loading) return <div className="office-viewer-container hwpx-viewer"><div className="hwpx-loading">문서 로딩 중...</div></div>;
  if (error) return <div className="office-viewer-container hwpx-viewer"><div className="office-viewer-error">HWPX 파싱 실패: {error}</div></div>;
  if (sections.length === 0 || sections.every(s => s.content.length === 0)) {
    return <div className="office-viewer-container hwpx-viewer"><div className="office-viewer-error">문서 내용을 찾을 수 없습니다.</div></div>;
  }

  const s0 = sections[0];
  const pageW = s0.pageWidth || 793;
  const pageH = s0.pageHeight || 1122;
  const mL = s0.marginLeft || 56;
  const mR = s0.marginRight || 56;
  const mT = s0.marginTop || 56;
  const mB = s0.marginBottom || 56;

  return (
    <div ref={containerRef} className="office-viewer-container hwpx-viewer">
      {/* Page navigation toolbar */}
      <div className="hwpx-toolbar">
        <button className="hwpx-nav-btn" onClick={goToPrevPage} disabled={currentPageIdx === 0}>
          <ChevronLeft size={18} />
        </button>
        <input
          type="number"
          className="hwpx-page-input"
          value={currentPageIdx + 1}
          onChange={e => {
            const val = parseInt(e.target.value);
            if (!isNaN(val)) jumpToPage(val - 1);
          }}
          min={1}
          max={paginatedPages.length}
        />
        <span className="hwpx-page-total">/ {paginatedPages.length}</span>
        <button className="hwpx-nav-btn" onClick={goToNextPage} disabled={currentPageIdx >= paginatedPages.length - 1}>
          <ChevronRight size={18} />
        </button>
        <span className="hwpx-zoom-label">{Math.round(zoom * 100)}%</span>
      </div>
      <div ref={contentRef} className="hwpx-content" style={{ zoom: zoom }}>
        {paginatedPages.map((page, idx) => {
          const { section, pageContent, globalPageNum, sectionPageIdx, pageFootnotes, backgroundImages, overlayImages, overlayTextBoxes } = page;
          const pw = section.pageWidth || pageW;
          const ph = section.pageHeight || pageH;
          const ml = section.marginLeft || mL;
          const mr = section.marginRight || mR;
          const mt = section.marginTop || mT;
          const mb = section.marginBottom || mB;
          const hm = section.headerMargin || 0;
          const fm = section.footerMargin || 0;

          return (
            <div key={idx} className="hwpx-page" data-page-idx={idx}
              ref={el => { pageRefs.current[idx] = el; }}
              style={{
                width: pw, minHeight: ph, position: 'relative', boxSizing: 'border-box', overflow: 'hidden',
              }}>
              {/* Background images (behind text) */}
              {backgroundImages.map((img, bi) => {
                const bgSrc = resolveImageSrc(img.id);
                if (!bgSrc) return null;
                return <img key={`bg-${bi}`} src={bgSrc} alt="" style={{
                  position: 'absolute', zIndex: 0, pointerEvents: 'none',
                  top: img.vertOffset || 0, left: img.horzOffset || 0,
                  width: img.width || pw, height: img.height || 'auto',
                }} />;
              })}

              {/* Overlay images (IN_FRONT_OF_TEXT, e.g. container background pics) */}
              {overlayImages.map((img, oi) => {
                const oSrc = resolveImageSrc(img.id);
                if (!oSrc) return null;
                return <img key={`oi-${oi}`} src={oSrc} alt="" style={{
                  position: 'absolute', zIndex: Math.max(1, img.zOrder || 1), pointerEvents: 'none',
                  top: img.vertOffset || 0, left: img.horzOffset || 0,
                  width: img.width || pw, height: img.height || ph,
                  objectFit: 'fill',
                }} />;
              })}

              {/* Header area — repeated on every page */}
              {section.headerContent && section.headerContent.length > 0 && (
                <div style={{
                  position: 'absolute', top: mt, left: ml, right: mr,
                  height: hm > 0 ? hm : 'auto', overflow: 'hidden', zIndex: 1,
                }}>
                  {renderFooterHeader(section.headerContent, `hdr-${idx}`)}
                </div>
              )}

              {/* Main content area + footnotes in flow layout */}
              <div className="hwpx-section" style={{
                paddingLeft: ml, paddingRight: mr,
                paddingTop: mt + (hm > 0 ? hm : 0),
                paddingBottom: mb + (fm > 0 ? fm : 0),
                position: 'relative', zIndex: 1,
                display: 'flex', flexDirection: 'column',
                boxSizing: 'border-box',
                minHeight: ph,
              }}>
                <div style={{ flex: 1 }}>
                  {(() => {
                    // Group consecutive inline images into flex rows
                    const elements: React.ReactNode[] = [];
                    let i = 0;
                    while (i < pageContent.length) {
                      const item = pageContent[i];
                      if (item.type === 'image' && item.data.inline) {
                        // Collect consecutive inline images
                        const group: ContentItem[] = [item];
                        let j = i + 1;
                        while (j < pageContent.length && pageContent[j].type === 'image' && (pageContent[j] as { type: 'image'; data: ImageElement }).data.inline) {
                          group.push(pageContent[j]);
                          j++;
                        }
                        if (group.length > 1) {
                          elements.push(
                            <div key={`imgrow-${idx}-${i}`} style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', alignItems: 'flex-start', justifyContent: 'center', margin: '8px 0' }}>
                              {group.map((g, gi) => renderContentItem(g, `p${idx}-i${i + gi}`))}
                            </div>
                          );
                        } else {
                          elements.push(renderContentItem(item, `p${idx}-i${i}`));
                        }
                        i = j;
                      } else {
                        elements.push(renderContentItem(item, `p${idx}-i${i}`));
                        i++;
                      }
                    }
                    return elements;
                  })()}
                </div>

                {/* Footnotes — pushed to bottom of content area via flex */}
                {pageFootnotes.length > 0 && (
                  <div style={{ marginTop: 'auto', paddingTop: '8px' }}>
                    <hr style={{ border: 'none', borderTop: '1px solid #999', width: '30%', margin: '0 0 4px 0' }} />
                    {pageFootnotes.map((fn, fi) => (
                      <div key={fi} style={{ fontSize: '0.8em', lineHeight: 1.4, marginBottom: '2px', display: 'flex', gap: '4px' }}>
                        <span style={{ fontSize: '0.75em', verticalAlign: 'super', flexShrink: 0 }}>{fn.marker || fn.number}</span>
                        <span>{fn.content.map((item, ii) => renderContentItem(item, `fn-${idx}-${fi}-${ii}`))}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Footer area — repeated on every page */}
              {section.footerContent && section.footerContent.length > 0 && (
                <div style={{
                  position: 'absolute', bottom: mb, left: ml, right: mr,
                  height: fm > 0 ? fm : 'auto', overflow: 'hidden', zIndex: 1,
                }}>
                  {renderFooterHeader(section.footerContent, `ftr-${idx}`, globalPageNum)}
                </div>
              )}

              {/* Overlay text boxes (IN_FRONT_OF_TEXT, positioned on page) */}
              {overlayTextBoxes.map((tb, ti) => (
                <div key={`otb-${ti}`} style={{
                  position: 'absolute',
                  top: tb.vertOffset || 0, left: tb.horzOffset || 0,
                  width: tb.width > 0 ? tb.width : undefined,
                  height: tb.height > 0 ? tb.height : undefined,
                  zIndex: Math.max(3, tb.zOrder || 3),
                  pointerEvents: 'none', overflow: 'hidden',
                  display: 'flex', flexDirection: 'column',
                  justifyContent: tb.vertAlign === 'BOTTOM' ? 'flex-end' : tb.vertAlign === 'CENTER' ? 'center' : 'flex-start',
                }}>
                  {tb.paragraphs.map((p, pi) => renderParagraph(p, `otb-${idx}-${ti}-p${pi}`))}
                </div>
              ))}

              {/* Page number (hidden by section-level pageHiding or per-page ctrl) */}
              {section.pageNumPos && !section.pageNumHidden && !section.hiddenPageNumPages?.has(sectionPageIdx) && (() => {
                const pos = section.pageNumPos;
                const sc = section.pageNumSideChar || '';
                const numText = sc ? `${sc} ${globalPageNum} ${sc}` : String(globalPageNum);
                const isTop = pos.startsWith('TOP');
                const isCenter = pos.includes('CENTER');
                const isRight = pos.includes('RIGHT');
                // Position in margin area: between footer and page edge
                const bottomPos = Math.max(4, (mb - 16) / 2);
                const topPos = Math.max(4, (mt - 16) / 2);
                const style: React.CSSProperties = {
                  position: 'absolute', left: ml, right: mr,
                  textAlign: isCenter ? 'center' : isRight ? 'right' : 'left',
                  fontSize: '9pt', color: '#666',
                };
                if (isTop) style.top = topPos;
                else style.bottom = bottomPos;
                return <div style={style}>{numText}</div>;
              })()}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default HwpxViewer;
