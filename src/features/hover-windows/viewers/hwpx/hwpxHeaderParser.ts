import { HWPUNIT_PER_PIXEL, log } from '../shared/viewerConstants';
import type {
  HeaderData, TextRun, Paragraph, BorderStyle, TabStop,
} from './hwpxTypes';
import { findElement } from './hwpxXmlHelpers';
import { mapPuaChar } from './hwpxCharMap';
import { formatNumber } from './hwpxNumbering';
import { mapTabType } from './hwpxNumbering';

// ==================== Header Parsing ====================

export function parseHeaderXml(xmlString: string): HeaderData {
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
    const levels = new Map<number, import('./hwpxTypes').NumberingLevelDef>();
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

export function resolveCharStyle(charPrIDRef: string | null, header: HeaderData | null): Partial<TextRun> {
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

export function resolveParaStyle(paraPrIDRef: string | null, header: HeaderData | null): Partial<Paragraph> {
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

export function resolveBorderFill(borderFillIDRef: string | null, header: HeaderData | null): {
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

export function resolveNumbering(
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
