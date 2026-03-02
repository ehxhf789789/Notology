import type {
  TextRun, Paragraph, Table, TableRow, TableCell, DrawingElement,
  ContentItem, ResolvedStyle, NumberingDef, DocDefaults, StyleNumMap,
  TableStyleMap, SectionProps, TabStop,
} from './docxTypes';
import { getElements, getElement, getDirectChildren, getVal, getAttr } from './docxXmlHelpers';
import { TWIP_PER_PIXEL, log } from '../shared/viewerConstants';
import { parseColor, fixFontLatin, fixFont, buildFontFamily } from './docxStyleParser';
import { parseBorders } from './docxTableParser';
import { parseDrawing } from './docxDrawing';
import { resolveNumberingText } from './docxNumbering';
import { parseSectionProps } from './docxPagination';

// ==================== Parse Run Properties ====================

export function parseRunProps(rPr: Element): Partial<TextRun> {
  const run: Partial<TextRun> = {};

  // Bold: w:b with val="0"/"false" means explicitly NOT bold; absent val or val="1" means bold
  const bEl = getElement(rPr, 'w:b');
  if (bEl) {
    const bVal = getVal(bEl);
    run.bold = bVal !== '0' && bVal !== 'false';
  }
  // Italic: same val handling as bold
  const iEl = getElement(rPr, 'w:i');
  if (iEl) {
    const iVal = getVal(iEl);
    run.italic = iVal !== '0' && iVal !== 'false';
  }
  if (getElement(rPr, 'w:u')) run.underline = true;
  if (getElement(rPr, 'w:strike')) run.strikethrough = true;

  // w:sz = font size for Latin/CJK text (half-points). w:szCs = complex script only (Arabic/Hebrew).
  // Do NOT fall back to szCs — it causes wrong sizes when only szCs is set (e.g., caption style).
  // OOXML default when w:sz is absent: 10pt (20 half-points).
  const szEl = getElement(rPr, 'w:sz');
  if (szEl) {
    run.fontSize = parseInt(getVal(szEl) || '20') / 2;
  }

  const colorEl = getElement(rPr, 'w:color');
  if (colorEl) run.color = parseColor(getVal(colorEl));

  const highlightEl = getElement(rPr, 'w:highlight');
  if (highlightEl) run.highlight = getVal(highlightEl) || undefined;

  const shdEl = getElement(rPr, 'w:shd');
  if (shdEl) run.backgroundColor = parseColor(getAttr(shdEl, 'fill'));

  // Per-range font fields: set individually, NOT as combined fontFamily.
  // fontFamily is computed later via buildFontFamily() after all merge levels are applied.
  // This enables correct OOXML behavior where a run may specify hAnsi="바탕" but inherit
  // ascii="Times New Roman" from the paragraph/style level.
  const fontEl = getElement(rPr, 'w:rFonts');
  if (fontEl) {
    // Latin ranges use fixFontLatin: garbled → null (inherit docDefaults, matching Word)
    // eastAsia uses fixFont: garbled → converted Korean name (Word can resolve CJK fonts)
    const ascii = fixFontLatin(getAttr(fontEl, 'ascii'));
    const eastAsia = fixFont(getAttr(fontEl, 'eastAsia'));
    const hAnsi = fixFontLatin(getAttr(fontEl, 'hAnsi'));
    const cs = fixFontLatin(getAttr(fontEl, 'cs'));
    if (ascii) run.asciiFont = ascii;
    if (hAnsi) run.hAnsiFont = hAnsi;
    if (eastAsia) run.eastAsiaFont = eastAsia;
    if (cs) run.csFont = cs;
    // Do NOT set run.fontFamily — it would override inherited fonts from other ranges
  }

  const vertAlignEl = getElement(rPr, 'w:vertAlign');
  if (vertAlignEl) {
    const val = getVal(vertAlignEl);
    if (val === 'superscript') run.superscript = true;
    if (val === 'subscript') run.subscript = true;
  }

  // Character spacing (rPr > w:spacing w:val) — affects letter-spacing
  // Note: this is DIFFERENT from pPr > w:spacing (which is line/paragraph spacing)
  const rSpacingEl = getElement(rPr, 'w:spacing');
  if (rSpacingEl) {
    const spacingVal = getVal(rSpacingEl);
    if (spacingVal) {
      run.letterSpacing = parseInt(spacingVal) / TWIP_PER_PIXEL;
    }
  }

  // w:kern — font kerning. val="0" means kerning disabled; val>0 means enabled above that size.
  // When kerning is disabled (val="0"), set fontKerning=false → CSS font-kerning:none.
  // This prevents browser from applying default kerning which differs from Word.
  const kernEl = getElement(rPr, 'w:kern');
  if (kernEl) {
    const kernVal = getVal(kernEl);
    if (kernVal === '0') {
      run.fontKerning = false;
    }
  }

  return run;
}

// ==================== Step 3: Paragraph Properties (lineHeight fix) ====================

export function parseParagraphProps(pPr: Element): Partial<Paragraph> {
  const para: Partial<Paragraph> = {};

  const jcEl = getElement(pPr, 'w:jc');
  if (jcEl) {
    const val = getVal(jcEl);
    if (val === 'left' || val === 'start') para.align = 'left';
    else if (val === 'center') para.align = 'center';
    else if (val === 'right' || val === 'end') para.align = 'right';
    else if (val === 'both' || val === 'justify') para.align = 'justify';
  }

  const spacingEl = getElement(pPr, 'w:spacing');
  if (spacingEl) {
    const before = getAttr(spacingEl, 'before');
    const after = getAttr(spacingEl, 'after');
    const line = getAttr(spacingEl, 'line');
    const lineRule = getAttr(spacingEl, 'lineRule');

    if (before) para.spaceBefore = parseInt(before) / TWIP_PER_PIXEL;
    if (after) para.spaceAfter = parseInt(after) / TWIP_PER_PIXEL;

    if (line) {
      if (lineRule === 'exact') {
        para.lineHeightType = 'exact';
        para.lineHeightValue = parseInt(line) / TWIP_PER_PIXEL;
      } else if (lineRule === 'atLeast') {
        para.lineHeightType = 'atLeast';
        para.lineHeightValue = parseInt(line) / TWIP_PER_PIXEL;
      } else {
        // auto (default): 240ths of a line
        para.lineHeightType = 'auto';
        para.lineHeightValue = parseInt(line) / 240;
      }
    }
  }

  const indEl = getElement(pPr, 'w:ind');
  if (indEl) {
    const left = getAttr(indEl, 'left') || getAttr(indEl, 'start');
    const right = getAttr(indEl, 'right') || getAttr(indEl, 'end');
    const firstLine = getAttr(indEl, 'firstLine');
    const hanging = getAttr(indEl, 'hanging');

    if (left) para.marginLeft = parseInt(left) / TWIP_PER_PIXEL;
    if (right) para.marginRight = parseInt(right) / TWIP_PER_PIXEL;
    if (firstLine) para.indent = parseInt(firstLine) / TWIP_PER_PIXEL;
    if (hanging) para.hangingIndent = parseInt(hanging) / TWIP_PER_PIXEL;
  }

  const outlineLvlEl = getElement(pPr, 'w:outlineLvl');
  if (outlineLvlEl) para.outlineLevel = parseInt(getVal(outlineLvlEl) || '9');

  if (getElement(pPr, 'w:pageBreakBefore')) para.pageBreakBefore = true;
  if (getElement(pPr, 'w:keepNext')) para.keepNext = true;
  if (getElement(pPr, 'w:keepLines')) para.keepLines = true;
  if (getElement(pPr, 'w:contextualSpacing')) para.contextualSpacing = true;

  // w:wordWrap — controls CJK line breaking. val="0" disables word-boundary-only breaking,
  // allowing character-level breaks (common in HWP-converted DOCX). CSS: word-break: break-all.
  // val="1" (or absent) uses normal word boundary breaking.
  const wordWrapEl = getElement(pPr, 'w:wordWrap');
  if (wordWrapEl) {
    const ww = getVal(wordWrapEl);
    para.wordBreakAll = (ww === '0' || ww === 'false');
  }

  // w:snapToGrid — default is true; only set to false when explicitly disabled
  const snapEl = getElement(pPr, 'w:snapToGrid');
  if (snapEl && getVal(snapEl) === 'false') {
    para.snapToGrid = false;
  } else if (snapEl && getVal(snapEl) === '0') {
    para.snapToGrid = false;
  }

  // w:pStyle — style ID for contextualSpacing comparison
  const pStyleEl = getElement(pPr, 'w:pStyle');
  if (pStyleEl) para.styleId = getVal(pStyleEl) ?? undefined;

  // Numbering reference (w:numPr) — needed for style-based heading numbering
  const numPrEl = getElement(pPr, 'w:numPr');
  if (numPrEl) {
    const numIdEl = getElement(numPrEl, 'w:numId');
    const ilvlEl = getElement(numPrEl, 'w:ilvl');
    const nid = getVal(numIdEl);
    if (nid) {
      para.numId = nid;
      para.numIlvl = parseInt(getVal(ilvlEl) || '0');
    }
  }

  // Tab stops (critical for TOC dot leaders and right-aligned page numbers)
  const tabsEl = getElement(pPr, 'w:tabs');
  if (tabsEl) {
    const tabEls = getElements(tabsEl, 'w:tab');
    const stops: TabStop[] = [];
    for (const tabEl of tabEls) {
      const val = getVal(tabEl);
      if (val === 'clear') continue; // 'clear' removes inherited tabs
      const pos = parseInt(getAttr(tabEl, 'pos') || '0') / TWIP_PER_PIXEL;
      const leaderAttr = getAttr(tabEl, 'leader');
      let alignment: TabStop['alignment'] = 'left';
      if (val === 'right') alignment = 'right';
      else if (val === 'center') alignment = 'center';
      else if (val === 'decimal') alignment = 'decimal';
      let leader: TabStop['leader'] = 'none';
      if (leaderAttr === 'dot') leader = 'dot';
      else if (leaderAttr === 'hyphen') leader = 'hyphen';
      else if (leaderAttr === 'underscore') leader = 'underscore';
      stops.push({ position: pos, alignment, leader });
    }
    if (stops.length > 0) para.tabStops = stops;
  }

  return para;
}

// ==================== Step 8: Math (OMML) ====================

export function parseMathRuns(mathEl: Element): TextRun[] {
  const runs: TextRun[] = [];

  function walkMath(el: Element) {
    const tag = el.tagName || el.nodeName;

    // m:r — math run with text (may also contain w:lastRenderedPageBreak)
    if (tag === 'm:r' || tag === 'r') {
      // Parse w:rPr inside m:r for font size (critical for correct rendering in tables)
      const wRPr = getElement(el, 'w:rPr');
      let mathRunProps: Partial<TextRun> = { italic: true, asciiFont: 'Cambria Math', hAnsiFont: 'Cambria Math', eastAsiaFont: 'Cambria Math' };
      if (wRPr) {
        const szEl = getElement(wRPr, 'w:sz');
        if (szEl) {
          mathRunProps.fontSize = parseInt(getVal(szEl) || '0') / 2;
        }
        const fontEl = getElement(wRPr, 'w:rFonts');
        if (fontEl) {
          const ascii = fixFontLatin(fontEl.getAttribute('w:ascii') || fontEl.getAttribute('ascii'));
          if (ascii) mathRunProps.asciiFont = ascii;
          const hAnsi = fixFontLatin(fontEl.getAttribute('w:hAnsi') || fontEl.getAttribute('hAnsi'));
          if (hAnsi) mathRunProps.hAnsiFont = hAnsi;
          const eastAsia = fixFont(fontEl.getAttribute('w:eastAsia') || fontEl.getAttribute('eastAsia'));
          if (eastAsia) mathRunProps.eastAsiaFont = eastAsia;
        }
      }
      // fontFamily will be computed via buildFontFamily() when merged in parseParagraph
      // Process children in document order to capture LRPB position
      for (let ci = 0; ci < el.childNodes.length; ci++) {
        const rChild = el.childNodes[ci];
        if (rChild.nodeType !== 1) continue;
        const rTag = (rChild as Element).tagName || (rChild as Element).nodeName;
        if (rTag === 'w:lastRenderedPageBreak' || rTag === 'lastRenderedPageBreak') {
          runs.push({ text: '\u000C' }); // page break marker
        } else if (rTag === 'm:t' || rTag === 't') {
          if (rChild.textContent) {
            runs.push({ text: rChild.textContent, ...mathRunProps });
          }
        }
      }
      return;
    }

    // m:f — fraction: render as num/den
    if (tag === 'm:f' || tag === 'f') {
      const num = getElement(el, 'm:num') || getElement(el, 'num');
      const den = getElement(el, 'm:den') || getElement(el, 'den');
      if (num) walkMath(num);
      runs.push({ text: '/', italic: true, asciiFont: 'Cambria Math', hAnsiFont: 'Cambria Math' });
      if (den) walkMath(den);
      return;
    }

    // m:d — delimiter (parentheses)
    if (tag === 'm:d' || tag === 'd') {
      const dPr = getElement(el, 'm:dPr') || getElement(el, 'dPr');
      const begChr = dPr ? getVal(getElement(dPr, 'm:begChr') || getElement(dPr, 'begChr')) : null;
      const endChr = dPr ? getVal(getElement(dPr, 'm:endChr') || getElement(dPr, 'endChr')) : null;
      runs.push({ text: begChr || '(', italic: true, asciiFont: 'Cambria Math', hAnsiFont: 'Cambria Math' });
      const eEl = getElement(el, 'm:e') || getElement(el, 'e');
      if (eEl) walkMath(eEl);
      runs.push({ text: endChr || ')', italic: true, asciiFont: 'Cambria Math', hAnsiFont: 'Cambria Math' });
      return;
    }

    // m:sSub — subscript
    if (tag === 'm:sSub' || tag === 'sSub') {
      const eEl = getElement(el, 'm:e') || getElement(el, 'e');
      const sub = getElement(el, 'm:sub') || getElement(el, 'sub');
      if (eEl) walkMath(eEl);
      if (sub) {
        const subRuns = parseMathRuns(sub);
        subRuns.forEach(r => { r.subscript = true; r.fontSize = (r.fontSize || 10) * 0.7; });
        runs.push(...subRuns);
      }
      return;
    }

    // m:sSup — superscript
    if (tag === 'm:sSup' || tag === 'sSup') {
      const eEl = getElement(el, 'm:e') || getElement(el, 'e');
      const sup = getElement(el, 'm:sup') || getElement(el, 'sup');
      if (eEl) walkMath(eEl);
      if (sup) {
        const supRuns = parseMathRuns(sup);
        supRuns.forEach(r => { r.superscript = true; r.fontSize = (r.fontSize || 10) * 0.7; });
        runs.push(...supRuns);
      }
      return;
    }

    // m:sSubSup — both sub and superscript
    if (tag === 'm:sSubSup' || tag === 'sSubSup') {
      const eEl = getElement(el, 'm:e') || getElement(el, 'e');
      const sub = getElement(el, 'm:sub') || getElement(el, 'sub');
      const sup = getElement(el, 'm:sup') || getElement(el, 'sup');
      if (eEl) walkMath(eEl);
      if (sub) {
        const subRuns = parseMathRuns(sub);
        subRuns.forEach(r => { r.subscript = true; r.fontSize = (r.fontSize || 10) * 0.7; });
        runs.push(...subRuns);
      }
      if (sup) {
        const supRuns = parseMathRuns(sup);
        supRuns.forEach(r => { r.superscript = true; r.fontSize = (r.fontSize || 10) * 0.7; });
        runs.push(...supRuns);
      }
      return;
    }

    // Generic: recurse into children
    for (let i = 0; i < el.childNodes.length; i++) {
      const child = el.childNodes[i];
      if (child.nodeType === 1) walkMath(child as Element);
    }
  }

  walkMath(mathEl);
  return runs;
}

// ==================== Parse Paragraph ====================

export function parseParagraph(
  pEl: Element,
  images: Map<string, string>,
  resolvedStyles: Map<string, ResolvedStyle>,
  numbering: Map<string, NumberingDef>,
  counters: Map<string, number>,
  docDefaults: DocDefaults,
  defaultParaResolvedStyle?: ResolvedStyle | null,
  styleNumMap?: StyleNumMap,
  tableStyleOverrides?: ResolvedStyle | null
): { para: Paragraph; drawings: DrawingElement[] } {
  const runs: TextRun[] = [];
  const drawings: DrawingElement[] = [];
  // Start with docDefaults, then overlay default paragraph style (e.g. "Normal")
  let paraProps: Partial<Paragraph> = { ...docDefaults.para };
  let runDefaults: Partial<TextRun> = { ...docDefaults.run };
  if (defaultParaResolvedStyle) {
    if (defaultParaResolvedStyle.paragraph) {
      paraProps = { ...paraProps, ...defaultParaResolvedStyle.paragraph };
    }
    if (defaultParaResolvedStyle.run) {
      runDefaults = { ...runDefaults, ...defaultParaResolvedStyle.run };
    }
  }
  // Table style pPr/rPr: overrides docDefaults + Normal style, but paragraph's own style overrides this
  if (tableStyleOverrides) {
    if (tableStyleOverrides.paragraph) {
      paraProps = { ...paraProps, ...tableStyleOverrides.paragraph };
    }
    if (tableStyleOverrides.run) {
      runDefaults = { ...runDefaults, ...tableStyleOverrides.run };
    }
    // Table cell text does not snap to document grid in Word — disable grid snapping
    paraProps.snapToGrid = false;
  }

  // Paragraph properties
  const pPrEl = getElement(pEl, 'w:pPr');
  if (pPrEl) {
    const directProps = parseParagraphProps(pPrEl);

    // Style reference — resolve full chain
    // Skip if styleId equals the default paragraph style (already applied via defaultParaResolvedStyle).
    // Re-applying it here would override table style properties (e.g., spaceAfter=0, lineHeight=1.0).
    const pStyleEl = getElement(pPrEl, 'w:pStyle');
    if (pStyleEl) {
      const styleId = getVal(pStyleEl);
      // Only skip re-applying the default style inside tables (where table style overrides should win)
      const isDefaultStyle = tableStyleOverrides && styleId && docDefaults.defaultParaStyleId && styleId === docDefaults.defaultParaStyleId;
      if (styleId && !isDefaultStyle && resolvedStyles.has(styleId)) {
        const resolved = resolvedStyles.get(styleId)!;
        if (resolved.paragraph) {
          paraProps = { ...paraProps, ...resolved.paragraph };
        }
        if (resolved.run) {
          runDefaults = { ...runDefaults, ...resolved.run };
        }
      }
    }

    // Paragraph-level run defaults (pPr > rPr) — overrides style-based run defaults
    const pRunPrEl = getElement(pPrEl, 'w:rPr');
    if (pRunPrEl) {
      const pRunDefaults = parseRunProps(pRunPrEl);
      runDefaults = { ...runDefaults, ...pRunDefaults };
    }

    // Direct props override style
    paraProps = { ...paraProps, ...directProps };

    // Step 6: Numbering resolution (3 mechanisms, lowest → highest priority)
    let numId: string | undefined;
    let ilvl = 0;
    let numSource = '';

    // 1. Style-linked numbering: w:pStyle in numbering.xml levels
    const paraStyleId = pStyleEl ? getVal(pStyleEl) : undefined;
    if (paraStyleId && styleNumMap?.has(paraStyleId)) {
      const linked = styleNumMap.get(paraStyleId)!;
      numId = linked.numId;
      ilvl = linked.ilvl;
      numSource = 'styleNumMap';
    }

    // 2. Style-resolved numPr (from style chain's w:numPr)
    if (paraProps.numId && paraProps.numId !== '0') {
      numId = paraProps.numId;
      ilvl = paraProps.numIlvl || 0;
      numSource = 'styleChain';
    }

    // 3. Direct pPr numPr overrides all
    const numPrEl = getElement(pPrEl, 'w:numPr');
    if (numPrEl) {
      const numIdEl = getElement(numPrEl, 'w:numId');
      const ilvlEl = getElement(numPrEl, 'w:ilvl');
      const directNumId = getVal(numIdEl);
      if (directNumId) {
        numId = directNumId;
        ilvl = parseInt(getVal(ilvlEl) || '0');
        numSource = 'directPPr';
      }
    }

    if (numId && numId !== '0') {
      const numDef = numbering.get(numId);
      const result = resolveNumberingText(numId, ilvl, numbering, counters);
      if (result) {
        if (result.text.length <= 2 && /[^\w\d]/.test(result.text)) {
          paraProps.bulletChar = result.text;
        } else {
          paraProps.numberingText = result.text;
        }
        if (result.indent) paraProps.numberingIndent = result.indent;
        if (result.hanging) paraProps.hangingIndent = result.hanging;

        // Numbering text font: merge runDefaults (from style chain) with level's rPr
        // OOXML: numbering text = virtual run with docDefaults→style rPr→level rPr
        const numRunProps: Partial<TextRun> = { ...runDefaults };
        if (result.runProps) {
          // Level rPr overrides runDefaults for properties it specifies
          for (const [k, v] of Object.entries(result.runProps)) {
            if (v !== undefined) (numRunProps as any)[k] = v;
          }
        }
        numRunProps.fontFamily = buildFontFamily(numRunProps);
        paraProps.numberingRunProps = numRunProps;
      }
    }
  }

  // Parse runs (direct children only to avoid table nesting)
  for (let i = 0; i < pEl.childNodes.length; i++) {
    const child = pEl.childNodes[i];
    if (child.nodeType !== 1) continue;
    const tag = (child as Element).tagName || (child as Element).nodeName;

    if (tag === 'w:r') {
      const rEl = child as Element;
      const rPrEl = getElement(rEl, 'w:rPr');
      let runProps: Partial<TextRun> = { ...runDefaults };

      if (rPrEl) {
        const directRunProps = parseRunProps(rPrEl);

        // Run style reference
        const rStyleEl = getElement(rPrEl, 'w:rStyle');
        if (rStyleEl) {
          const styleId = getVal(rStyleEl);
          if (styleId && resolvedStyles.has(styleId)) {
            const resolved = resolvedStyles.get(styleId)!;
            if (resolved.run) runProps = { ...runProps, ...resolved.run };
          }
        }

        runProps = { ...runProps, ...directRunProps };
      }
      // Compute fontFamily from merged per-range fonts (ascii/hAnsi/eastAsia/cs)
      runProps.fontFamily = buildFontFamily(runProps);

      // Process children in DOCUMENT ORDER to respect lastRenderedPageBreak position
      for (let ci = 0; ci < rEl.childNodes.length; ci++) {
        const rChild = rEl.childNodes[ci];
        if (rChild.nodeType !== 1) continue;
        const rTag = (rChild as Element).tagName || (rChild as Element).nodeName;

        if (rTag === 'w:t' || rTag === 't') {
          const text = rChild.textContent || '';
          if (text) runs.push({ text, ...runProps });
        } else if (rTag === 'w:lastRenderedPageBreak' || rTag === 'lastRenderedPageBreak') {
          runs.push({ text: '\u000C' });
        } else if (rTag === 'w:br' || rTag === 'br') {
          const brType = getAttr(rChild as Element, 'type');
          if (brType === 'page') {
            runs.push({ text: '\u000B' }); // explicit page break (distinct from LRPB \u000C)
          } else {
            runs.push({ text: '\n' });
          }
        } else if (rTag === 'w:tab' || rTag === 'tab') {
          runs.push({ text: '\t' });
        } else if (rTag === 'w:drawing' || rTag === 'drawing') {
          const drawing = parseDrawing(rChild as Element, images);
          if (drawing) {
            if (drawing.inline) {
              runs.push({ text: '\uFFFC' });
            }
            drawings.push(drawing);
          }
        }
        // Skip w:rPr (already processed above)
      }
    } else if (tag === 'w:hyperlink' || tag === 'hyperlink') {
      // Process w:r children inside hyperlinks (same logic as direct w:r)
      const hlRuns = getDirectChildren(child as Element, 'w:r');
      for (const rEl of hlRuns) {
        const rPrEl = getElement(rEl, 'w:rPr');
        let runProps: Partial<TextRun> = { ...runDefaults };
        if (rPrEl) {
          const directRunProps = parseRunProps(rPrEl);
          const rStyleEl = getElement(rPrEl, 'w:rStyle');
          if (rStyleEl) {
            const styleId = getVal(rStyleEl);
            if (styleId && resolvedStyles.has(styleId)) {
              const resolved = resolvedStyles.get(styleId)!;
              if (resolved.run) runProps = { ...runProps, ...resolved.run };
            }
          }
          runProps = { ...runProps, ...directRunProps };
        }
        runProps.fontFamily = buildFontFamily(runProps);
        for (let ci = 0; ci < rEl.childNodes.length; ci++) {
          const rChild = rEl.childNodes[ci];
          if (rChild.nodeType !== 1) continue;
          const rTag = (rChild as Element).tagName || (rChild as Element).nodeName;
          if (rTag === 'w:t' || rTag === 't') {
            const text = rChild.textContent || '';
            if (text) runs.push({ text, ...runProps });
          } else if (rTag === 'w:lastRenderedPageBreak' || rTag === 'lastRenderedPageBreak') {
            runs.push({ text: '\u000C' });
          } else if (rTag === 'w:br' || rTag === 'br') {
            const brType = getAttr(rChild as Element, 'type');
            runs.push({ text: brType === 'page' ? '\u000B' : '\n' });
          } else if (rTag === 'w:tab' || rTag === 'tab') {
            runs.push({ text: '\t' });
          } else if (rTag === 'w:drawing' || rTag === 'drawing') {
            const drawing = parseDrawing(rChild as Element, images);
            if (drawing) {
              if (drawing.inline) runs.push({ text: '\uFFFC' });
              drawings.push(drawing);
            }
          }
        }
      }
    } else if (tag === 'w:ins' || tag === 'ins') {
      // Track Changes: insertions — process inner w:r elements (same as direct w:r)
      const insChildren = getDirectChildren(child as Element, 'w:r');
      for (const rEl of insChildren) {
        const rPrEl = getElement(rEl, 'w:rPr');
        let runProps: Partial<TextRun> = { ...runDefaults };
        if (rPrEl) {
          const directRunProps = parseRunProps(rPrEl);
          const rStyleEl = getElement(rPrEl, 'w:rStyle');
          if (rStyleEl) {
            const styleId = getVal(rStyleEl);
            if (styleId && resolvedStyles.has(styleId)) {
              const resolved = resolvedStyles.get(styleId)!;
              if (resolved.run) runProps = { ...runProps, ...resolved.run };
            }
          }
          runProps = { ...runProps, ...directRunProps };
        }
        runProps.fontFamily = buildFontFamily(runProps);
        for (let ci = 0; ci < rEl.childNodes.length; ci++) {
          const rChild = rEl.childNodes[ci];
          if (rChild.nodeType !== 1) continue;
          const rTag = (rChild as Element).tagName || (rChild as Element).nodeName;
          if (rTag === 'w:t' || rTag === 't') {
            const text = rChild.textContent || '';
            if (text) runs.push({ text, ...runProps });
          } else if (rTag === 'w:lastRenderedPageBreak' || rTag === 'lastRenderedPageBreak') {
            runs.push({ text: '\u000C' });
          } else if (rTag === 'w:br' || rTag === 'br') {
            const brType = getAttr(rChild as Element, 'type');
            runs.push({ text: brType === 'page' ? '\u000B' : '\n' });
          } else if (rTag === 'w:tab' || rTag === 'tab') {
            runs.push({ text: '\t' });
          } else if (rTag === 'w:drawing' || rTag === 'drawing') {
            const drawing = parseDrawing(rChild as Element, images);
            if (drawing) {
              if (drawing.inline) runs.push({ text: '\uFFFC' });
              drawings.push(drawing);
            }
          }
        }
      }
    } else if (tag === 'w:fldSimple' || tag === 'fldSimple') {
      // Simple field (e.g., PAGE, NUMPAGES, TOC) — render cached field value
      // Structure: <w:fldSimple w:instr=" PAGE "><w:r><w:t>36</w:t></w:r></w:fldSimple>
      const fldRuns = getDirectChildren(child as Element, 'w:r');
      for (const rEl of fldRuns) {
        const rPrEl = getElement(rEl, 'w:rPr');
        let runProps: Partial<TextRun> = { ...runDefaults };
        if (rPrEl) {
          const directRunProps = parseRunProps(rPrEl);
          const rStyleEl = getElement(rPrEl, 'w:rStyle');
          if (rStyleEl) {
            const styleId = getVal(rStyleEl);
            if (styleId && resolvedStyles.has(styleId)) {
              const resolved = resolvedStyles.get(styleId)!;
              if (resolved.run) runProps = { ...runProps, ...resolved.run };
            }
          }
          runProps = { ...runProps, ...directRunProps };
        }
        runProps.fontFamily = buildFontFamily(runProps);
        for (let ci = 0; ci < rEl.childNodes.length; ci++) {
          const rChild = rEl.childNodes[ci];
          if (rChild.nodeType !== 1) continue;
          const rTag = (rChild as Element).tagName || (rChild as Element).nodeName;
          if (rTag === 'w:t' || rTag === 't') {
            const text = rChild.textContent || '';
            if (text) runs.push({ text, ...runProps });
          } else if (rTag === 'w:lastRenderedPageBreak' || rTag === 'lastRenderedPageBreak') {
            runs.push({ text: '\u000C' });
          }
        }
      }
    } else if (tag === 'm:oMath' || tag === 'oMath') {
      // Step 8: Math — apply runDefaults (cascade font size) to math runs
      // Math runs may have their own w:rPr font size; if not, inherit from paragraph cascade
      const mathRuns = parseMathRuns(child as Element);
      for (const mr of mathRuns) {
        const merged = { ...runDefaults, ...mr };
        merged.fontFamily = buildFontFamily(merged);
        runs.push(merged);
      }
    } else if (tag === 'm:oMathPara' || tag === 'oMathPara') {
      const mathEls = getElements(child as Element, 'm:oMath');
      for (const me of mathEls) {
        const mathRuns = parseMathRuns(me);
        for (const mr of mathRuns) {
          const merged = { ...runDefaults, ...mr };
          merged.fontFamily = buildFontFamily(merged);
          runs.push(merged);
        }
      }
    }
  }

  // Store effective font size from cascade for empty paragraph line-height calculation.
  // Empty paragraphs have no runs, so the cascade font size (e.g., 12pt from table style)
  // would be lost. This ensures correct line-height even without actual run content.
  if (runDefaults.fontSize) {
    paraProps.effectiveFontSize = runDefaults.fontSize;
  }

  return { para: { runs, ...paraProps } as Paragraph, drawings };
}

// ==================== Parse Table ====================

export function parseTable(
  tblEl: Element,
  images: Map<string, string>,
  resolvedStyles: Map<string, ResolvedStyle>,
  numbering: Map<string, NumberingDef>,
  counters: Map<string, number>,
  docDefaults: DocDefaults,
  defaultParaResolvedStyle?: ResolvedStyle | null,
  styleNumMap?: StyleNumMap,
  tableStyles?: TableStyleMap
): Table {
  const rows: TableRow[] = [];
  const colWidths: number[] = [];

  const tblGridEl = getElement(tblEl, 'w:tblGrid');
  if (tblGridEl) {
    const gridCols = getElements(tblGridEl, 'w:gridCol');
    for (const col of gridCols) {
      colWidths.push(parseInt(getAttr(col, 'w') || '0') / TWIP_PER_PIXEL);
    }
  }

  // Table-level default borders: style borders → direct tblBorders override
  const tblPr = getElement(tblEl, 'w:tblPr');

  // Extract table style ID (used for both borders and pPr/rPr)
  const tblStyleEl = tblPr ? getElement(tblPr, 'w:tblStyle') : null;
  const tblStyleId = tblStyleEl ? getVal(tblStyleEl) : null;

  // Resolve table style pPr/rPr — applied as overrides to paragraphs within the table
  // OOXML cascade: docDefaults → Normal style → table style pPr/rPr → paragraph style → direct formatting
  let tblStyleOverrides: ResolvedStyle | null = null;
  if (tblStyleId && resolvedStyles.has(tblStyleId)) {
    tblStyleOverrides = resolvedStyles.get(tblStyleId) || null;
  }

  // 1) Resolve table style borders (with basedOn chain)
  let styleBorders: ReturnType<typeof parseBorders> = undefined;
  if (tblPr && tableStyles && tableStyles.size > 0 && tblStyleId) {
    // Walk basedOn chain to resolve inherited borders
    const visited = new Set<string>();
    let currentId: string | undefined = tblStyleId;
    const chain: string[] = [];
    while (currentId && !visited.has(currentId)) {
      visited.add(currentId);
      chain.push(currentId);
      const entry = tableStyles.get(currentId);
      currentId = entry?.basedOn;
    }
    // Merge from base → derived (later overrides earlier)
    for (let ci = chain.length - 1; ci >= 0; ci--) {
      const entry = tableStyles.get(chain[ci]);
      if (entry?.borders) {
        if (!styleBorders) {
          styleBorders = { ...entry.borders };
        } else {
          // Override each side that the derived style specifies
          if (entry.borders.top) styleBorders.top = entry.borders.top;
          if (entry.borders.bottom) styleBorders.bottom = entry.borders.bottom;
          if (entry.borders.left) styleBorders.left = entry.borders.left;
          if (entry.borders.right) styleBorders.right = entry.borders.right;
          if (entry.borders.insideH) styleBorders.insideH = entry.borders.insideH;
          if (entry.borders.insideV) styleBorders.insideV = entry.borders.insideV;
        }
      }
    }
  }

  // 2) Direct tblBorders from document override style borders
  const tblBordersEl = tblPr ? getElement(tblPr, 'w:tblBorders') : null;
  const directBorders = parseBorders(tblBordersEl);

  // 3) Merge: style as base, direct overrides per-side
  let defaultBorders = styleBorders;
  if (directBorders) {
    if (!defaultBorders) {
      defaultBorders = directBorders;
    } else {
      defaultBorders = { ...defaultBorders };
      if (directBorders.top) defaultBorders.top = directBorders.top;
      if (directBorders.bottom) defaultBorders.bottom = directBorders.bottom;
      if (directBorders.left) defaultBorders.left = directBorders.left;
      if (directBorders.right) defaultBorders.right = directBorders.right;
      if (directBorders.insideH) defaultBorders.insideH = directBorders.insideH;
      if (directBorders.insideV) defaultBorders.insideV = directBorders.insideV;
    }
  }

  const trEls = getDirectChildren(tblEl, 'w:tr');
  const totalRows = trEls.length;
  for (let rowIdx = 0; rowIdx < totalRows; rowIdx++) {
    const tr = trEls[rowIdx];
    const cells: TableCell[] = [];
    const tcEls = getDirectChildren(tr, 'w:tc');
    const totalCols = tcEls.length;

    let colIdx = 0;
    for (const tc of tcEls) {
      const tcPr = getElement(tc, 'w:tcPr');

      const gridSpanEl = tcPr ? getElement(tcPr, 'w:gridSpan') : null;
      const gridSpan = gridSpanEl ? parseInt(getVal(gridSpanEl) || '1') : 1;

      const vMergeEl = tcPr ? getElement(tcPr, 'w:vMerge') : null;
      let vMerge: 'restart' | 'continue' | undefined;
      if (vMergeEl) {
        vMerge = getVal(vMergeEl) === 'restart' ? 'restart' : 'continue';
      }

      const tcWEl = tcPr ? getElement(tcPr, 'w:tcW') : null;
      const cellWidth = tcWEl ? parseInt(getAttr(tcWEl, 'w') || '0') / TWIP_PER_PIXEL : undefined;

      const shdEl = tcPr ? getElement(tcPr, 'w:shd') : null;
      const backgroundColor = shdEl ? parseColor(getAttr(shdEl, 'fill')) : undefined;

      const vAlignEl = tcPr ? getElement(tcPr, 'w:vAlign') : null;
      const vertAlign = vAlignEl ? getVal(vAlignEl) as 'top' | 'center' | 'bottom' : undefined;

      // Cell-level borders (override table defaults)
      const tcBordersEl = tcPr ? getElement(tcPr, 'w:tcBorders') : null;
      const cellBorders = parseBorders(tcBordersEl);

      const content = parseBodyContent(tc, images, resolvedStyles, numbering, counters, docDefaults, defaultParaResolvedStyle, styleNumMap, tableStyles, tblStyleOverrides);

      // Position-aware border resolution per OOXML spec:
      // Outer edges use top/bottom/left/right, inner edges use insideH/insideV
      const isFirstRow = rowIdx === 0;
      const isLastRow = rowIdx === totalRows - 1;
      const isFirstCol = colIdx === 0;
      const isLastCol = colIdx + gridSpan >= totalCols;

      cells.push({
        content,
        colSpan: gridSpan,
        rowSpan: 1,
        width: cellWidth,
        backgroundColor,
        vertAlign,
        vMerge,
        borderTop: cellBorders?.top || (isFirstRow ? defaultBorders?.top : defaultBorders?.insideH),
        borderBottom: cellBorders?.bottom || (isLastRow ? defaultBorders?.bottom : defaultBorders?.insideH),
        borderLeft: cellBorders?.left || (isFirstCol ? defaultBorders?.left : defaultBorders?.insideV),
        borderRight: cellBorders?.right || (isLastCol ? defaultBorders?.right : defaultBorders?.insideV),
      });
      colIdx++;
    }

    const trPr = getElement(tr, 'w:trPr');
    const trHeightEl = trPr ? getElement(trPr, 'w:trHeight') : null;
    const rowHeight = trHeightEl ? parseInt(getVal(trHeightEl) || '0') / TWIP_PER_PIXEL : undefined;
    const isHeader = trPr ? !!getElement(trPr, 'w:tblHeader') : false;

    rows.push({ cells, height: rowHeight, isHeader });
  }

  // Calculate vMerge row spans
  for (let col = 0; col < colWidths.length; col++) {
    let mergeStart = -1;
    for (let row = 0; row < rows.length; row++) {
      const cell = rows[row].cells[col];
      if (!cell) continue;
      if (cell.vMerge === 'restart') {
        mergeStart = row;
      } else if (cell.vMerge === 'continue' && mergeStart >= 0) {
        if (rows[mergeStart].cells[col]) {
          rows[mergeStart].cells[col].rowSpan++;
        }
      }
    }
  }

  const tblWEl = tblPr ? getElement(tblPr, 'w:tblW') : null;
  const tblWType = tblWEl ? (getAttr(tblWEl, 'type') as 'auto' | 'pct' | 'dxa' | null) : null;
  const tblWVal = tblWEl ? parseInt(getAttr(tblWEl, 'w') || '0') : 0;
  let tableWidth: number | undefined;
  let widthType: 'auto' | 'pct' | 'dxa' = 'auto';
  if (tblWType === 'pct' && tblWVal > 0) {
    // pct: value in 1/50ths of a percent (5000 = 100%)
    tableWidth = undefined; // will use percentage in rendering
    widthType = 'pct';
  } else if (tblWType === 'dxa' && tblWVal > 0) {
    tableWidth = tblWVal / TWIP_PER_PIXEL;
    widthType = 'dxa';
  } else {
    tableWidth = undefined;
    widthType = 'auto';
  }

  // Parse table cell margins (tblCellMar)
  const tblCellMarEl = tblPr ? getElement(tblPr, 'w:tblCellMar') : null;
  let cellPadding: { left: number; right: number; top: number; bottom: number } | undefined;
  if (tblCellMarEl) {
    const leftEl = getElement(tblCellMarEl, 'w:left') || getElement(tblCellMarEl, 'w:start');
    const rightEl = getElement(tblCellMarEl, 'w:right') || getElement(tblCellMarEl, 'w:end');
    const topEl = getElement(tblCellMarEl, 'w:top');
    const bottomEl = getElement(tblCellMarEl, 'w:bottom');
    cellPadding = {
      left: leftEl ? parseInt(getAttr(leftEl, 'w') || '0') / TWIP_PER_PIXEL : 7.2,
      right: rightEl ? parseInt(getAttr(rightEl, 'w') || '0') / TWIP_PER_PIXEL : 7.2,
      top: topEl ? parseInt(getAttr(topEl, 'w') || '0') / TWIP_PER_PIXEL : 0,
      bottom: bottomEl ? parseInt(getAttr(bottomEl, 'w') || '0') / TWIP_PER_PIXEL : 0,
    };
  }

  const jcEl = tblPr ? getElement(tblPr, 'w:jc') : null;
  const alignment = jcEl ? getVal(jcEl) as 'left' | 'center' | 'right' : undefined;

  // Parse tblLayout — 'fixed' means column widths from tblGrid are honored
  const tblLayoutEl = tblPr ? getElement(tblPr, 'w:tblLayout') : null;
  const layoutTypeRaw = tblLayoutEl ? getAttr(tblLayoutEl, 'type') : null;
  const layoutType: 'fixed' | 'autofit' | undefined = layoutTypeRaw === 'fixed' ? 'fixed' : layoutTypeRaw === 'autofit' ? 'autofit' : undefined;

  // When table width is auto and grid columns are defined, derive width from column sum.
  // Covers both explicit 'fixed' layout and unspecified layout (common in HWP-converted DOCX).
  // Skip only for explicit 'autofit' which means auto-size to content.
  if (widthType === 'auto' && colWidths.length > 0 && layoutType !== 'autofit') {
    const colSum = colWidths.reduce((sum, w) => sum + w, 0);
    if (colSum > 0) {
      tableWidth = colSum;
      widthType = 'dxa';
    }
  }

  // Extract table style's font size for CSS inheritance in <td> elements.
  // This ensures unstyled content (strut, &nbsp;) inherits the correct size from the table style.
  const styleFontSize = tblStyleOverrides?.run?.fontSize as number | undefined;

  return { rows, width: tableWidth, widthType, layoutType, colWidths, alignment, cellPadding, defaultBorders, styleFontSize };
}

// ==================== Step 5: Parse Body Content (with sections) ====================

export function parseBodyContent(
  parent: Element,
  images: Map<string, string>,
  resolvedStyles: Map<string, ResolvedStyle>,
  numbering: Map<string, NumberingDef>,
  counters: Map<string, number>,
  docDefaults: DocDefaults,
  defaultParaResolvedStyle?: ResolvedStyle | null,
  styleNumMap?: StyleNumMap,
  tableStyles?: TableStyleMap,
  tableStyleOverrides?: ResolvedStyle | null
): ContentItem[] {
  const content: ContentItem[] = [];
  // \u000C = LRPB (lastRenderedPageBreak), \u000B = explicit page break (w:br type="page")
  const LRPB_CHAR = '\u000C';
  const EXPLICIT_CHAR = '\u000B';
  const breakRegex = /[\u000B\u000C]/;

  for (let i = 0; i < parent.childNodes.length; i++) {
    const child = parent.childNodes[i];
    if (child.nodeType !== 1) continue;
    const el = child as Element;
    const tagName = el.tagName || el.nodeName;

    if (tagName === 'w:p') {
      const { para, drawings } = parseParagraph(el, images, resolvedStyles, numbering, counters, docDefaults, defaultParaResolvedStyle, styleNumMap, tableStyleOverrides);

      // Check for section break in paragraph's pPr
      const pPrEl = getElement(el, 'w:pPr');
      const sectPrInPara = pPrEl ? getElement(pPrEl, 'w:sectPr') : null;

      // Split paragraph at page breaks (both LRPB and explicit)
      const hasPageBreak = para.runs.some(r => breakRegex.test(r.text));



      // pageBreakBefore — only if paragraph doesn't already start with LRPB
      if (para.pageBreakBefore && !(hasPageBreak && para.runs.length > 0 && para.runs[0].text === LRPB_CHAR)) {
        content.push({ type: 'pageBreak', breakSource: 'explicit' });
      }

      if (hasPageBreak) {
        let currentRuns: TextRun[] = [];
        let drawingIdx = 0;

        // Helper: push sub-paragraph and its corresponding inline drawings
        const pushSubParagraphWithDrawings = (runs: TextRun[]) => {
          content.push({ type: 'paragraph', data: { ...para, runs } });
          // Push drawings corresponding to \uFFFC placeholders in these runs
          const uffcCount = runs.filter(r => r.text === '\uFFFC').length;
          for (let d = 0; d < uffcCount && drawingIdx < drawings.length; d++) {
            content.push({ type: 'drawing', data: drawings[drawingIdx++] });
          }
        };

        for (const run of para.runs) {
          if (run.text === LRPB_CHAR || run.text === EXPLICIT_CHAR) {
            if (currentRuns.length > 0) {
              pushSubParagraphWithDrawings(currentRuns);
            }
            content.push({ type: 'pageBreak', breakSource: run.text === LRPB_CHAR ? 'lrpb' : 'explicit' });
            currentRuns = [];
          } else if (breakRegex.test(run.text)) {
            // Text mixed with break chars — split carefully
            let remaining = run.text;
            while (remaining.length > 0) {
              const matchIdx = remaining.search(breakRegex);
              if (matchIdx === -1) {
                currentRuns.push({ ...run, text: remaining });
                break;
              }
              if (matchIdx > 0) {
                currentRuns.push({ ...run, text: remaining.substring(0, matchIdx) });
              }
              const breakChar = remaining[matchIdx];
              if (currentRuns.length > 0) {
                pushSubParagraphWithDrawings(currentRuns);
              }
              content.push({ type: 'pageBreak', breakSource: breakChar === LRPB_CHAR ? 'lrpb' : 'explicit' });
              currentRuns = [];
              remaining = remaining.substring(matchIdx + 1);
            }
          } else {
            currentRuns.push(run);
          }
        }

        if (currentRuns.length > 0) {
          pushSubParagraphWithDrawings(currentRuns);
        }
        // Push any remaining drawings (non-inline or extras)
        while (drawingIdx < drawings.length) {
          content.push({ type: 'drawing', data: drawings[drawingIdx++] });
        }
      } else {
        content.push({ type: 'paragraph', data: para });
        // All drawings (inline ones will be matched with \uFFFC placeholders by RenderContent)
        for (const drawing of drawings) {
          content.push({ type: 'drawing', data: drawing });
        }
      }

      // Section break from paragraph properties
      if (sectPrInPara) {
        const sectionProps = parseSectionProps(sectPrInPara);
        log(`[DocxViewer] Section break: type=${sectionProps.sectionType || 'nextPage'}, pageNumStart=${sectionProps.pageNumberStart}, titlePage=${sectionProps.titlePage}`);
        content.push({ type: 'sectionBreak', sectionProps });
      }

    } else if (tagName === 'w:sdt') {
      // Structured Document Tag (TOC, bibliography, etc.) — unwrap and parse content
      const sdtContent = getElement(el, 'w:sdtContent');
      if (sdtContent) {
        const innerContent = parseBodyContent(sdtContent, images, resolvedStyles, numbering, counters, docDefaults, defaultParaResolvedStyle, styleNumMap, tableStyles);
        content.push(...innerContent);
      }

    } else if (tagName === 'w:tbl') {
      // Peek ahead: if next sibling is a table caption paragraph (centered, text starts with "Table"/"표"),
      // move it BEFORE the table's first segment. Korean academic format: table captions go above.
      // Some documents (HWP→DOCX conversion) place caption after table in XML. Word displays above.
      let captionSkipIndex = -1;
      const captionItems: ContentItem[] = [];
      for (let ni = i + 1; ni < parent.childNodes.length; ni++) {
        const nextNode = parent.childNodes[ni];
        if (nextNode.nodeType !== 1) continue;
        const nextEl = nextNode as Element;
        const nextTag = nextEl.tagName || nextEl.nodeName;
        if (nextTag === 'w:p' || nextTag === 'p') {
          const nextPPr = getElement(nextEl, 'w:pPr');
          const nextPStyle = nextPPr ? getElement(nextPPr, 'w:pStyle') : null;
          const nextStyleId = nextPStyle ? getVal(nextPStyle) : null;
          const nextJcEl = nextPPr ? getElement(nextPPr, 'w:jc') : null;
          const isCentered = (nextJcEl ? getVal(nextJcEl) === 'center' : false) ||
            (nextStyleId ? resolvedStyles.get(nextStyleId)?.paragraph?.align === 'center' : false);
          if (nextStyleId && isCentered) {
            const textEls = getElements(nextEl, 'w:t');
            const text = Array.from(textEls).map(t => t.textContent || '').join('').trim();
            if (/^(\s*(Table|표)\s)/i.test(text) && text.length < 200) {
              const { para, drawings } = parseParagraph(nextEl, images, resolvedStyles, numbering, counters, docDefaults, defaultParaResolvedStyle, styleNumMap, tableStyleOverrides);
              captionItems.push({ type: 'paragraph', data: para });
              for (const drawing of drawings) {
                captionItems.push({ type: 'drawing', data: drawing });
              }
              captionSkipIndex = ni;
            }
          }
        }
        break; // Only check the immediate next element sibling
      }

      const table = parseTable(el, images, resolvedStyles, numbering, counters, docDefaults, defaultParaResolvedStyle, styleNumMap, tableStyles);

      // Extract page breaks from table cells and split table at row boundaries
      const rowsWithBreaks: { row: TableRow; breakCount: number; breakAfterRow: boolean }[] = [];
      for (const row of table.rows) {
        let maxBreaksPerCell = 0;
        let anyContentBeforeBreak = false;
        for (const cell of row.cells) {
          let cellBreakCount = 0;
          let seenRealContent = false;
          const filteredContent: ContentItem[] = [];
          for (const item of cell.content) {
            if (item.type === 'pageBreak') {
              cellBreakCount++;
              if (seenRealContent) {
                anyContentBeforeBreak = true;
              }
            } else {
              seenRealContent = true;
              filteredContent.push(item);
            }
          }
          cell.content = filteredContent;
          if (cellBreakCount > maxBreaksPerCell) maxBreaksPerCell = cellBreakCount;
        }
        rowsWithBreaks.push({ row, breakCount: maxBreaksPerCell, breakAfterRow: anyContentBeforeBreak });
      }

      // Split table into segments at page break boundaries
      // Caption (if reordered from after table) is emitted right before the first table segment
      let currentSegmentRows: TableRow[] = [];
      let captionEmitted = captionItems.length === 0; // true if no caption to emit
      for (const { row, breakCount, breakAfterRow } of rowsWithBreaks) {
        if (breakCount > 0) {
          if (breakAfterRow) {
            currentSegmentRows.push(row);
            // Emit caption before first table segment
            if (!captionEmitted) {
              content.push(...captionItems);
              captionEmitted = true;
            }
            content.push({ type: 'table', data: { ...table, rows: currentSegmentRows } });
            for (let b = 0; b < breakCount; b++) {
              content.push({ type: 'pageBreak', breakSource: 'lrpb' });
            }
            currentSegmentRows = [];
          } else {
            if (currentSegmentRows.length > 0) {
              // Emit caption before first table segment
              if (!captionEmitted) {
                content.push(...captionItems);
                captionEmitted = true;
              }
              content.push({ type: 'table', data: { ...table, rows: currentSegmentRows } });
            }
            for (let b = 0; b < breakCount; b++) {
              content.push({ type: 'pageBreak', breakSource: 'lrpb' });
              if (b < breakCount - 1) {
                content.push({ type: 'table', data: { ...table, rows: [row] } });
              }
            }
            currentSegmentRows = [];
            currentSegmentRows.push(row);
          }
        } else {
          currentSegmentRows.push(row);
        }
      }
      if (currentSegmentRows.length > 0) {
        // Emit caption before first (and only) table segment if no LRPBs at all
        if (!captionEmitted) {
          content.push(...captionItems);
          captionEmitted = true;
        }
        content.push({ type: 'table', data: { ...table, rows: currentSegmentRows } });
      }

      // Skip the caption element that was already processed
      if (captionSkipIndex >= 0) {
        i = captionSkipIndex;
      }
    } else if (tagName === 'w:ins' || tagName === 'ins') {
      // Track Changes: insertions at body level — may contain w:p or w:tbl
      for (let j = 0; j < el.childNodes.length; j++) {
        const insChild = el.childNodes[j];
        if (insChild.nodeType !== 1) continue;
        const insTag = (insChild as Element).tagName || (insChild as Element).nodeName;
        if (insTag === 'w:p' || insTag === 'p') {
          const { para, drawings } = parseParagraph(insChild as Element, images, resolvedStyles, numbering, counters, docDefaults, defaultParaResolvedStyle, styleNumMap, tableStyleOverrides);
          content.push({ type: 'paragraph', data: para });
          for (const drawing of drawings) {
            content.push({ type: 'drawing', data: drawing });
          }
        } else if (insTag === 'w:tbl' || insTag === 'tbl') {
          const table = parseTable(insChild as Element, images, resolvedStyles, numbering, counters, docDefaults, defaultParaResolvedStyle, styleNumMap, tableStyles);
          content.push({ type: 'table', data: table });
        }
      }
    }
    // w:sectPr at body level is handled separately in parseDocx
  }

  // Debug: log content summary around "Contents" for TOC debugging
  if (parent.tagName === 'w:body' || parent.nodeName === 'w:body') {
    log(`[DocxViewer] parseBodyContent: ${content.length} items total`);
    // Find "Contents" heading and log surrounding items
    for (let ci = 0; ci < content.length; ci++) {
      const item = content[ci];
      if (item.type === 'paragraph') {
        const text = item.data.runs.map(r => r.text).join('');
        if (text.includes('Contents') || text.includes('contents') || text.includes('목차')) {
          log(`[DocxViewer] Found "Contents" at index ${ci}. Surrounding items:`);
          for (let j = Math.max(0, ci - 3); j < Math.min(content.length, ci + 10); j++) {
            const it = content[j];
            if (it.type === 'paragraph') {
              const t = it.data.runs.map(r => r.text).join('').substring(0, 60);
              log(`  [${j}] paragraph: "${t}" (style=${it.data.styleId})`);
            } else if (it.type === 'pageBreak') {
              log(`  [${j}] pageBreak (${it.breakSource})`);
            } else if (it.type === 'table') {
              log(`  [${j}] table (${it.data.rows.length} rows)`);
            } else if (it.type === 'sectionBreak') {
              log(`  [${j}] sectionBreak`);
            } else {
              log(`  [${j}] ${it.type}`);
            }
          }
          break;
        }
      }
    }
  }

  return content;
}
