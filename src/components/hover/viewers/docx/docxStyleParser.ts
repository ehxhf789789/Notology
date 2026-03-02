import type { TextRun, DocDefaults, StyleDef, ResolvedStyle, TableStyleMap } from './docxTypes';
import { getElements, getElement, getVal, getAttr } from './docxXmlHelpers';
import { TWIP_PER_PIXEL } from '../shared/viewerConstants';
import { parseBorders } from './docxTableParser';
import { parseRunProps, parseParagraphProps } from './docxContentParser';

// ==================== Color ====================

export function parseColor(colorVal: string | null): string | undefined {
  if (!colorVal || colorVal === 'auto') return undefined;
  if (colorVal.startsWith('#')) return colorVal;
  if (/^[0-9A-Fa-f]{6}$/.test(colorVal)) return `#${colorVal}`;
  return undefined;
}

export const HIGHLIGHT_COLORS: Record<string, string> = {
  yellow: '#ffff00', green: '#00ff00', cyan: '#00ffff', magenta: '#ff00ff',
  blue: '#0000ff', red: '#ff0000', darkBlue: '#00008b', darkCyan: '#008b8b',
  darkGreen: '#006400', darkMagenta: '#8b008b', darkRed: '#8b0000',
  darkYellow: '#808000', darkGray: '#a9a9a9', lightGray: '#d3d3d3', black: '#000000',
};

// ==================== Step 1: docDefaults ====================

export function parseDocDefaults(stylesDoc: Document): DocDefaults {
  const defaults: DocDefaults = { run: {}, para: {} };
  const docDefaultsEl = getElement(stylesDoc.documentElement, 'w:docDefaults');
  if (!docDefaultsEl) return defaults;

  // Run defaults
  const rPrDefault = getElement(docDefaultsEl, 'w:rPrDefault');
  if (rPrDefault) {
    const rPr = getElement(rPrDefault, 'w:rPr');
    if (rPr) defaults.run = parseRunProps(rPr);
  }

  // Paragraph defaults
  const pPrDefault = getElement(docDefaultsEl, 'w:pPrDefault');
  if (pPrDefault) {
    const pPr = getElement(pPrDefault, 'w:pPr');
    if (pPr) defaults.para = parseParagraphProps(pPr);
  }

  return defaults;
}

// ==================== Step 2: Style Resolution ====================

export function parseStyles(xml: Document): { styles: Map<string, StyleDef>; defaultParaStyleId: string | null; tableStyles: TableStyleMap } {
  const styles = new Map<string, StyleDef>();
  const tableStyles: TableStyleMap = new Map();
  const styleEls = getElements(xml.documentElement, 'w:style');
  let defaultParaStyleId: string | null = null;

  for (const styleEl of styleEls) {
    const styleId = getAttr(styleEl, 'styleId');
    if (!styleId) continue;

    const isDefault = styleEl.getAttribute('w:default');
    const styleType = styleEl.getAttribute('w:type');
    if (isDefault === '1' && styleType === 'paragraph') {
      defaultParaStyleId = styleId;
    }

    // Parse table styles for border resolution
    if (styleType === 'table') {
      const tblPrEl = getElement(styleEl, 'w:tblPr');
      const tblBordersEl = tblPrEl ? getElement(tblPrEl, 'w:tblBorders') : null;
      const basedOnEl = getElement(styleEl, 'w:basedOn');
      tableStyles.set(styleId, {
        borders: parseBorders(tblBordersEl),
        basedOn: getVal(basedOnEl) || undefined,
      });
    }

    const nameEl = getElement(styleEl, 'w:name');
    const basedOnEl = getElement(styleEl, 'w:basedOn');
    const pPrEl = getElement(styleEl, 'w:pPr');
    const rPrEl = getElement(styleEl, 'w:rPr');

    styles.set(styleId, {
      name: getVal(nameEl) || styleId,
      basedOn: getVal(basedOnEl) || undefined,
      paragraph: pPrEl ? parseParagraphProps(pPrEl) : undefined,
      run: rPrEl ? parseRunProps(rPrEl) : undefined,
    });
  }

  return { styles, defaultParaStyleId, tableStyles };
}

export function resolveStyle(
  styleId: string,
  styles: Map<string, StyleDef>,
  docDefaults: DocDefaults,
  visited = new Set<string>()
): ResolvedStyle {
  if (visited.has(styleId)) return {};
  visited.add(styleId);

  const style = styles.get(styleId);
  if (!style) return {};

  // Resolve basedOn chain first
  let base: ResolvedStyle = {};
  if (style.basedOn) {
    base = resolveStyle(style.basedOn, styles, docDefaults, visited);
  }

  return {
    paragraph: { ...base.paragraph, ...style.paragraph },
    run: { ...base.run, ...style.run },
  };
}

export function buildResolvedStyles(
  styles: Map<string, StyleDef>,
  docDefaults: DocDefaults
): Map<string, ResolvedStyle> {
  const resolved = new Map<string, ResolvedStyle>();
  for (const [id] of styles) {
    resolved.set(id, resolveStyle(id, styles, docDefaults));
  }
  return resolved;
}

// ==================== Font Helpers ====================

export const MOJIBAKE_MAP: Record<string, string> = {
  '\xB9\xD9\xC5\xC1': '바탕', '\xB1\xBC\xB8\xB2': '굴림',
  '\xB5\xB8\xBF\xF2': '돋움', '\xB1\xC3\xB8\xB2': '궁서',
  'Å\xBB': '탕', '\xB8\xED\xC1\xB6': '명조',
  '\xC8\xD0\xB8\xD5': '휴먼', '\xB8\xC0\xC0\xBA': '맑은',
  '\xB0\xED\xB5\xF1': '고딕', '\xC7\xD1\xC4\xC4': '한컴',
};

/**
 * Fix mojibake font names (EUC-KR bytes in UTF-8 XML from HWP→DOCX conversion).
 * For eastAsia range: converts garbled names to correct Korean names (e.g., "¹ÙÅÁ" → "바탕").
 */
export function fixFont(f: string | null): string | null {
  if (!f) return null;
  if (/[^\x20-\x7E\uAC00-\uD7A3]/.test(f)) {
    for (const [garbled, correct] of Object.entries(MOJIBAKE_MAP)) {
      if (f.includes(garbled)) return f.replace(garbled, correct);
    }
    return null; // still garbled
  }
  return f;
}

/**
 * Fix font names for Latin ranges (ascii/hAnsi/cs).
 * Word cannot recognize mojibake font names in these ranges → falls back to docDefaults.
 * We match Word's behavior: garbled names → null (inherit from parent/docDefaults).
 * Do NOT apply MOJIBAKE_MAP here — that would assign CJK fonts to Latin text.
 */
export function fixFontLatin(f: string | null): string | null {
  if (!f) return null;
  if (/[^\x20-\x7E\uAC00-\uD7A3]/.test(f)) {
    return null; // garbled → let inherit from docDefaults (matches Word behavior)
  }
  return f;
}

export const FONT_ALIASES: Record<string, string> = { 'Times': '"Times New Roman"', 'Times New Roman': 'Times' };
const quoteFont = (f: string) => f.includes(' ') || /[^\x20-\x7Ea-zA-Z가-힣]/.test(f) ? `"${f}"` : f;

/**
 * Build CSS font-family from per-range font fields.
 * OOXML assigns fonts per Unicode range (ascii, hAnsi, eastAsia, cs).
 * CSS font-family tries fonts in order per glyph: Latin chars → ascii font; CJK → eastAsia fallback.
 * Order: ascii first (for Latin text), then hAnsi/eastAsia (for CJK), then cs.
 */
export function buildFontFamily(props: Partial<TextRun>): string | undefined {
  const { asciiFont, hAnsiFont, eastAsiaFont, csFont } = props;
  const fonts: string[] = [];
  if (asciiFont) {
    fonts.push(quoteFont(asciiFont));
    if (FONT_ALIASES[asciiFont]) fonts.push(FONT_ALIASES[asciiFont]);
  }
  if (hAnsiFont && hAnsiFont !== asciiFont) fonts.push(quoteFont(hAnsiFont));
  if (eastAsiaFont && eastAsiaFont !== asciiFont && eastAsiaFont !== hAnsiFont) fonts.push(quoteFont(eastAsiaFont));
  if (csFont && csFont !== asciiFont && csFont !== hAnsiFont && csFont !== eastAsiaFont) fonts.push(quoteFont(csFont));
  return fonts.length > 0 ? fonts.join(', ') : undefined;
}
