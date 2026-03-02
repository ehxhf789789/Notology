import type { TextRun, Paragraph, TextBodyProps, ThemeColors, ThemeFonts } from './pptxTypes';
import { parseColor } from './pptxColor';
import { EMU_PER_PIXEL } from '../shared/viewerConstants';

export function parseRunProperties(rPr: Element | null, themeColors?: ThemeColors, themeFonts?: ThemeFonts): Partial<TextRun> {
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
    // Gradient text fill -- use first stop color as approximation
    const gsLst = gradFillRun.getElementsByTagName('a:gsLst')[0];
    if (gsLst) {
      const gs = gsLst.getElementsByTagName('a:gs')[0];
      if (gs) props.color = parseColor(gs, themeColors);
    }
  }

  return props;
}

// Parse spacing value (spcPct or spcPts)
export function parseSpacing(spacingEl: Element | null): { pct?: number; pts?: number } | undefined {
  if (!spacingEl) return undefined;
  const spcPct = spacingEl.getElementsByTagName('a:spcPct')[0];
  if (spcPct) {
    const val = parseInt(spcPct.getAttribute('val') || '0');
    return { pct: val / 1000 }; // thousandths of percent -> percent
  }
  const spcPts = spacingEl.getElementsByTagName('a:spcPts')[0];
  if (spcPts) {
    const val = parseInt(spcPts.getAttribute('val') || '0');
    return { pts: val / 100 }; // hundredths of point -> point
  }
  return undefined;
}

export function parseParagraphAlign(pPr: Element | null): Paragraph['align'] {
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

export function parseBullet(pPr: Element | null): { bulletChar?: string; level?: number } {
  if (!pPr) return {};

  const level = parseInt(pPr.getAttribute('lvl') || '0');
  const buChar = pPr.getElementsByTagName('a:buChar')[0];
  const buAutoNum = pPr.getElementsByTagName('a:buAutoNum')[0];
  const buNone = pPr.getElementsByTagName('a:buNone')[0];

  if (buNone) return { level };
  if (buChar) return { bulletChar: buChar.getAttribute('char') || '\u2022', level };
  if (buAutoNum) return { bulletChar: '1.', level };

  return { level };
}

// Parse full paragraph properties including spacing
export function parseParagraphProperties(pPr: Element | null): Partial<Paragraph> {
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
    result.spaceBefore = spcBefVal.pts * 1.333; // pt -> px approx
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
export function parseTextBody(txBody: Element, themeColors?: ThemeColors, themeFonts?: ThemeFonts): Paragraph[] {
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
export function parseTextBodyProps(txBody: Element): TextBodyProps {
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
