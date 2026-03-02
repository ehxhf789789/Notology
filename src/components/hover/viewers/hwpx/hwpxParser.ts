import { HWPUNIT_PER_PIXEL, log } from '../shared/viewerConstants';
import type {
  HeaderData, TextRun, ContentItem, Section, AutoNumCounters, FootnoteData,
} from './hwpxTypes';
import { directChildren, directChild, findElement } from './hwpxXmlHelpers';
import { equationScriptToHtml } from './hwpxEquation';
import { mapTabLeader } from './hwpxNumbering';
import { resolveCharStyle, resolveParaStyle, resolveNumbering } from './hwpxHeaderParser';
import {
  parseCharProps, parseParaProps, processCtrl,
  parseTableElement, parseImageElement, parseRectElement,
  parseContainerElement, parseEquationElement,
} from './hwpxContentParser';

// ==================== Section Parsing ====================

export function parseSectionXml(xmlString: string, header: HeaderData | null): Section {
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
    const pp: Partial<import('./hwpxTypes').Paragraph> = { ...hps, ...ipp };
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
