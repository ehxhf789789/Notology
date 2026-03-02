import { HWPUNIT_PER_PIXEL } from '../shared/viewerConstants';
import type {
  HeaderData, TextRun, Paragraph, ContentItem, Table, TableRow, TableCell,
  ImageElement, EquationElement, TextBoxElement, AutoNumCounters, FootnoteData,
} from './hwpxTypes';
import { parseHwpInt, directChildren, directChild, findElement } from './hwpxXmlHelpers';
import { equationScriptToHtml } from './hwpxEquation';
import { mapTabLeader } from './hwpxNumbering';
import { resolveCharStyle, resolveParaStyle, resolveBorderFill, resolveNumbering } from './hwpxHeaderParser';

// ==================== Character/Paragraph Parsing ====================

export function parseCharProps(charPr: Element | null, defaultStyle?: Partial<TextRun>): Partial<TextRun> {
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

export function parseParaProps(paraPr: Element | null): Partial<Paragraph> {
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
export function processCtrl(
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

export function computeColWidths(cells: TableCell[], colCnt: number, tableWidth: number): number[] {
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
export function parseContentItems(
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

export function parseTableElement(
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

export function parseImageElement(picElement: Element, header?: HeaderData | null, numCounters?: Map<string, number>): ImageElement | null {
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
export function parseContainerElement(containerEl: Element, header: HeaderData | null, numCounters?: Map<string, number>): ContentItem[] {
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
export function parseRectElement(rectElement: Element, header?: HeaderData | null, numCounters?: Map<string, number>): TextBoxElement | null {
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
export function parseEquationElement(eqElement: Element): EquationElement | null {
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
