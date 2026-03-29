import type {
  ContentItem, SectionProps, PageContent, DocDefaults, Table, TableCell,
  TableRow, Paragraph, TextRun,
  PageMeasurements, TableRowMeasurements, CellParaMeasurements,
} from './docxTypes';
import { getElement, getAttr, getVal } from './docxXmlHelpers';
import { TWIP_PER_PIXEL, log } from '../shared/viewerConstants';

// ==================== Section Properties ====================

export function parseSectionProps(sectPr: Element): SectionProps {
  const pgSzEl = getElement(sectPr, 'w:pgSz');
  const pgMarEl = getElement(sectPr, 'w:pgMar');
  const docGridEl = getElement(sectPr, 'w:docGrid');

  const props: SectionProps = {
    pageWidth: pgSzEl ? parseInt(getAttr(pgSzEl, 'w') || '12240') / TWIP_PER_PIXEL : 816,
    pageHeight: pgSzEl ? parseInt(getAttr(pgSzEl, 'h') || '15840') / TWIP_PER_PIXEL : 1056,
    marginTop: pgMarEl ? parseInt(getAttr(pgMarEl, 'top') || '1440') / TWIP_PER_PIXEL : 96,
    marginBottom: pgMarEl ? parseInt(getAttr(pgMarEl, 'bottom') || '1440') / TWIP_PER_PIXEL : 96,
    marginLeft: pgMarEl ? parseInt(getAttr(pgMarEl, 'left') || '1440') / TWIP_PER_PIXEL : 96,
    marginRight: pgMarEl ? parseInt(getAttr(pgMarEl, 'right') || '1440') / TWIP_PER_PIXEL : 96,
    footerMargin: pgMarEl ? parseInt(getAttr(pgMarEl, 'footer') || '720') / TWIP_PER_PIXEL : 48,
  };

  // w:docGrid — document grid for CJK line spacing
  // Only apply linePitch when type is "lines" or "linesAndChars" (active grid).
  // type=null or "default" means no grid — linePitch should NOT affect line spacing.
  if (docGridEl) {
    const linePitch = getAttr(docGridEl, 'linePitch');
    const gridType = getAttr(docGridEl, 'type');
    log(`[DocxViewer] docGrid: type=${gridType}, linePitch=${linePitch} twips → ${linePitch ? parseInt(linePitch) / TWIP_PER_PIXEL : 0}px`);
    if (linePitch && (gridType === 'lines' || gridType === 'linesAndChars')) {
      props.linePitch = parseInt(linePitch) / TWIP_PER_PIXEL;
    }
  } else {
    log(`[DocxViewer] docGrid: NOT FOUND in sectPr`);
  }

  // w:pgNumType — page numbering restart
  const pgNumTypeEl = getElement(sectPr, 'w:pgNumType');
  if (pgNumTypeEl) {
    const startVal = getAttr(pgNumTypeEl, 'start');
    if (startVal) props.pageNumberStart = parseInt(startVal);
  }

  // w:titlePg — first page of section has different header/footer (often none)
  const titlePgEl = getElement(sectPr, 'w:titlePg');
  if (titlePgEl) {
    props.titlePage = true;
  }

  // w:type — section break type (nextPage is default)
  const typeEl = getElement(sectPr, 'w:type');
  if (typeEl) {
    const typeVal = getVal(typeEl) as SectionProps['sectionType'];
    if (typeVal) props.sectionType = typeVal;
  }

  log(`[DocxViewer] sectionProps: ${JSON.stringify(props)}`);
  return props;
}

// ==================== Step 4: Pagination (pageBreak-based) ====================

export function paginateContent(content: ContentItem[], defaultSection: SectionProps, docDefaults: DocDefaults): PageContent[] {
  const pages: PageContent[] = [];
  let currentPage: ContentItem[] = [];
  let pageNumber = 1;

  // DOCX section model: each paragraph sectPr applies to content BEFORE it.
  // Collect all section properties in order: [sect0, sect1, ..., sectN, bodyDefault]
  const allSections: SectionProps[] = [];
  for (const item of content) {
    if (item.type === 'sectionBreak' && item.sectionProps) {
      allSections.push(item.sectionProps);
    }
  }
  allSections.push(defaultSection); // body sectPr = last section

  // Section 0 content → allSections[0], after first sectionBreak → allSections[1], etc.
  let sectionIdx = 0;
  let currentSection = allSections[0] || defaultSection;

  let isFirstItem = true;
  let isNextPageSectionFirst = true; // First page of the document is section-first
  let hasSkippedLRPB = false; // Track if current page has merged LRPB content

  for (let ci = 0; ci < content.length; ci++) {
    const item = content[ci];

    if (item.type === 'pageBreak') {
      // Skip if very first item (no page before first content)
      if (isFirstItem) { isFirstItem = false; continue; }

      // Skip consecutive LRPB breaks that confirm an already-processed boundary.
      // But allow EXPLICIT page breaks through — they create intentional blank pages in Word.
      if (currentPage.length === 0 && pages.length > 0 && item.breakSource === 'lrpb') {
        continue;
      }

      // Trust all LRPBs from Word — they define the exact page boundaries.
      pages.push({ items: currentPage, pageNumber, section: currentSection, isFirstInSection: isNextPageSectionFirst, hasSkippedLRPB });
      pageNumber++;
      currentPage = [];
      isNextPageSectionFirst = false;
      hasSkippedLRPB = false;
      continue;
    }

    if (item.type === 'sectionBreak') {
      const nextSectionIdx = sectionIdx + 1;
      const nextSection = allSections[nextSectionIdx] || defaultSection;
      const breakType = item.sectionProps?.sectionType || 'nextPage';

      if (breakType === 'continuous') {
        // Continuous section break — no new page, just switch section properties
        sectionIdx = nextSectionIdx;
        currentSection = nextSection;
        // Don't start a new page; content continues on the same page
        continue;
      }

      // nextPage, oddPage, evenPage — all start a new page
      if (currentPage.length > 0 || pages.length > 0) {
        pages.push({ items: currentPage, pageNumber, section: currentSection, isFirstInSection: isNextPageSectionFirst, hasSkippedLRPB });
        pageNumber++;
        currentPage = [];
        hasSkippedLRPB = false;
      }

      // oddPage/evenPage: insert blank page if needed to reach correct parity
      if (breakType === 'oddPage' && pageNumber % 2 === 0) {
        // Current pageNumber is even → need to skip to odd → insert blank page
        pages.push({ items: [], pageNumber, section: currentSection, isFirstInSection: false });
        pageNumber++;
        log(`[DocxViewer] oddPage section break: inserted blank page to reach odd page ${pageNumber}`);
      } else if (breakType === 'evenPage' && pageNumber % 2 === 1) {
        // Current pageNumber is odd → need to skip to even → insert blank page
        pages.push({ items: [], pageNumber, section: currentSection, isFirstInSection: false });
        pageNumber++;
        log(`[DocxViewer] evenPage section break: inserted blank page to reach even page ${pageNumber}`);
      }

      // Move to next section — next page will be first in the new section
      sectionIdx = nextSectionIdx;
      currentSection = nextSection;
      isNextPageSectionFirst = true;
      continue;
    }

    isFirstItem = false;
    currentPage.push(item);
  }

  if (currentPage.length > 0) {
    pages.push({ items: currentPage, pageNumber, section: currentSection, isFirstInSection: isNextPageSectionFirst, hasSkippedLRPB });
  }

  log(`[DocxViewer] paginateContent: ${content.length} items → ${pages.length} raw pages (pageNumber=${pageNumber})`);

  return pages;
}

// ==================== Height Estimation & Overflow Splitting ====================

export function estimateItemHeight(item: ContentItem, availWidth: number, docDefaults: DocDefaults): number {
  if (item.type === 'paragraph') {
    const para = item.data;
    const fontSize = para.runs.reduce((max, r) => Math.max(max, r.fontSize || 0), 0) ||
                     (docDefaults.run.fontSize || 10);
    const fontSizePx = fontSize * 1.333; // pt → px

    // Line height in px
    let lineHeightPx: number;
    if (para.lineHeightType === 'exact' && para.lineHeightValue) {
      lineHeightPx = para.lineHeightValue;
    } else if (para.lineHeightType === 'auto' && para.lineHeightValue) {
      lineHeightPx = fontSizePx * para.lineHeightValue;
    } else {
      const defLH = docDefaults.para.lineHeightValue || 1.15;
      lineHeightPx = fontSizePx * defLH;
    }

    // Spacing before/after (use ?? to distinguish explicit 0 from undefined)
    const spaceBefore = para.spaceBefore ?? docDefaults.para.spaceBefore ?? 0;
    const spaceAfter = para.spaceAfter ?? docDefaults.para.spaceAfter ?? 0;

    // Count total text characters
    const totalChars = para.runs.reduce((sum, r) => sum + r.text.length, 0);
    if (totalChars === 0) return spaceBefore + lineHeightPx + spaceAfter;

    // Estimate average char width using font size in px
    // Latin chars: ~0.5em, CJK chars: ~1.0em (fullwidth)
    const text = para.runs.map(r => r.text).join('');
    const cjkCount = (text.match(/[\u3000-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF]/g) || []).length;
    const latinCount = totalChars - cjkCount;
    const avgCharWidth = fontSizePx * (0.5 * latinCount + 1.0 * cjkCount) / totalChars;

    // Effective text width (account for indent/margin)
    const indent = para.indent || para.numberingIndent || 0;
    const effectiveWidth = Math.max(availWidth - indent - (para.marginLeft || 0) - (para.marginRight || 0), 100);

    const charsPerLine = Math.max(1, Math.floor(effectiveWidth / (avgCharWidth || 6)));
    const lineCount = Math.max(1, Math.ceil(totalChars / charsPerLine));

    return spaceBefore + (lineCount * lineHeightPx) + spaceAfter;
  }

  if (item.type === 'table') {
    const table = item.data;
    let totalHeight = 0;
    for (const row of table.rows) {
      if (row.height && row.height > 0) {
        totalHeight += row.height;
      } else {
        // Estimate: each row has at least 1 line of text
        const cellMaxLines = row.cells.reduce((max, cell) => {
          const cellLines = cell.content.reduce((sum, ci) => {
            if (ci.type === 'paragraph') {
              const text = ci.data.runs.map(r => r.text).join('');
              return sum + Math.max(1, Math.ceil(text.length / 40));
            }
            return sum + 1;
          }, 0);
          return Math.max(max, cellLines);
        }, 1);
        totalHeight += cellMaxLines * 18 + 8; // ~18px per line + padding
      }
    }
    return totalHeight;
  }

  if (item.type === 'drawing') {
    return item.data.height || 100;
  }

  return 0;
}

export function splitOversizedPages(pages: PageContent[], docDefaults: DocDefaults): PageContent[] {
  const result: PageContent[] = [];
  let pageNum = 1;

  for (const page of pages) {
    const section = page.section;
    const availHeight = section.pageHeight - section.marginTop - section.marginBottom;
    const availWidth = section.pageWidth - section.marginLeft - section.marginRight;

    // Estimate total height of this page's content
    let totalHeight = 0;
    const heights: number[] = [];
    for (const item of page.items) {
      const h = estimateItemHeight(item, availWidth, docDefaults);
      heights.push(h);
      totalHeight += h;
    }

    // Section-height-aware overflow detection:
    // - Small sections (< 700px available, e.g. title/approval pages): skip splitting entirely.
    // - Pages with merged LRPBs (hasSkippedLRPB): use 1.6x threshold. These pages had a stale
    //   LRPB removed; height estimation overestimates by 40-60% for front-matter content
    //   (Korean abstract text + empty spacing paragraphs). The high threshold prevents
    //   re-splitting content that Word renders on a single page.
    // - Section-first pages: use 1.25x threshold.
    // - Regular body pages: use 1.15x threshold.
    // Cap at max 2 sub-pages per source page (max +1 split).
    const threshold = availHeight < 700 ? Infinity
      : page.hasSkippedLRPB ? 1.6
      : page.isFirstInSection ? 1.25
      : 1.15;
    if (totalHeight <= availHeight * threshold || page.items.length <= 1) {
      result.push({ items: page.items, pageNumber: pageNum, section });
      pageNum++;
    } else {
      // Log split decisions for debugging
      const firstText = page.items.find(i => i.type === 'paragraph')?.data?.runs?.map(r => r.text).join('').slice(0, 40) || '';
      log(`[DocxViewer] Splitting page ${page.pageNumber}: ${totalHeight.toFixed(0)}px > ${(availHeight * threshold).toFixed(0)}px (${(totalHeight/availHeight*100).toFixed(0)}%) "${firstText}"`);

      // Find the split point closest to available height
      let currentItems: ContentItem[] = [];
      let currentHeight = 0;
      let didSplit = false;

      for (let i = 0; i < page.items.length; i++) {
        const itemHeight = heights[i];

        if (!didSplit && currentHeight + itemHeight > availHeight && currentItems.length > 0) {
          // Minimum content guard: never create a first sub-page with very little content
          // (e.g., a heading alone before a large table). This prevents isolated headings
          // that should visually stay with their following content.
          if (currentHeight < availHeight * 0.15) {
            // Don't split here — keep accumulating items
          } else {
            result.push({ items: currentItems, pageNumber: pageNum, section });
            pageNum++;
            currentItems = [];
            currentHeight = 0;
            didSplit = true;
          }
        }

        currentItems.push(page.items[i]);
        currentHeight += itemHeight;
      }

      if (currentItems.length > 0) {
        result.push({ items: currentItems, pageNumber: pageNum, section });
        pageNum++;
      }
    }
  }

  log(`[DocxViewer] splitOversizedPages: ${pages.length} raw → ${result.length} final (${result.length - pages.length} splits)`);
  return result;
}

// ==================== 2-Pass: Measured Overflow Splitting ====================

// Counts how many DOM children correspond to content[0..upToIdx).
// RenderContent groups paragraphs with their following inline drawings into one DOM child.
function countDomChildrenForContent(content: ContentItem[], upToIdx: number): number {
  let domCount = 0;
  let i = 0;
  while (i < upToIdx && i < content.length) {
    if (content[i].type === 'paragraph') {
      let j = i + 1;
      while (j < upToIdx && j < content.length && content[j].type === 'drawing' && (content[j] as any).data?.inline) {
        j++;
      }
      domCount++;
      i = j > i + 1 ? j : i + 1;
    } else {
      domCount++;
      i++;
    }
  }
  return domCount;
}

// Maps content indices to DOM child heights.
// RenderContent groups paragraphs with their following inline drawings into one DOM child.
function mapContentToDomHeights(content: ContentItem[], domHeights: number[]): number[] {
  const heights: number[] = new Array(content.length).fill(0);
  let domIdx = 0;
  let i = 0;
  while (i < content.length) {
    if (domIdx >= domHeights.length) break;
    if (content[i].type === 'paragraph') {
      heights[i] = domHeights[domIdx];
      // Check for following inline drawings (absorbed into this DOM child)
      let j = i + 1;
      while (j < content.length && content[j].type === 'drawing') {
        if ((content[j] as any).data?.inline) {
          heights[j] = 0; // absorbed into paragraph's DOM child
        } else {
          domIdx++;
          heights[j] = domIdx < domHeights.length ? domHeights[domIdx] : 0;
        }
        j++;
      }
      domIdx++;
      i = j > i + 1 ? j : i + 1;
    } else {
      heights[i] = domHeights[domIdx];
      domIdx++;
      i++;
    }
  }
  return heights;
}

// Keep paragraph + inline drawings together when splitting cell content.
// In the content array, inline drawings follow their owning paragraph:
//   [paragraph, drawing, drawing, paragraph, ...]
// If a split index lands on a drawing, it would orphan it from the paragraph,
// causing the image to disappear (paragraph can't find its inline drawing,
// and the standalone inline drawing is silently skipped by RenderContent).
// This function adjusts splitIdx to include all drawings with their paragraph.
function adjustSplitForInlineDrawings(content: ContentItem[], splitIdx: number): number {
  if (splitIdx <= 0 || splitIdx >= content.length) return splitIdx;

  // Case 1: splitIdx lands on a drawing — include it (and all subsequent drawings) in top part
  // This keeps the preceding paragraph's drawings together with it.
  if (content[splitIdx].type === 'drawing') {
    // First verify there's a paragraph before these drawings
    let firstDrawing = splitIdx;
    while (firstDrawing > 0 && content[firstDrawing - 1].type === 'drawing') firstDrawing--;
    if (firstDrawing > 0 && content[firstDrawing - 1].type === 'paragraph') {
      // Push forward past all consecutive drawings
      let adj = splitIdx;
      while (adj < content.length && content[adj].type === 'drawing') adj++;
      return adj;
    }
  }

  return splitIdx;
}

function splitTableAtRowBoundary(
  table: Table, itemIdx: number, availableHeight: number,
  rowMeasured?: Map<string, number>, rowOffset = 0,
  cellParaMeasured?: Map<string, number[]>
): { firstPart: Table; secondPart: Table; secondPartHeight: number; rowsConsumed: number;
     updatedCellParaHeights?: Map<string, number[]>; remainingRowHeight?: number } | null {
  if (!rowMeasured) return null;

  let accHeight = 0;
  let splitAfterRow = -1;

  for (let ri = 0; ri < table.rows.length; ri++) {
    const originalRowIdx = ri + rowOffset;
    const rowH = rowMeasured.get(`${itemIdx}:${originalRowIdx}`) || 20;
    if (accHeight + rowH > availableHeight && ri > 0) {
      splitAfterRow = ri - 1;
      break;
    }
    accHeight += rowH;
  }

  // If first row itself overflows, try to split the row's cell content (paragraph-level).
  // This handles oversized single-row tables (e.g., Algorithm pseudocode blocks).
  if (splitAfterRow < 0 && table.rows.length > 0) {
    const firstRowH = rowMeasured.get(`${itemIdx}:${rowOffset}`) || 20;
    if (firstRowH > availableHeight && availableHeight > 30) {
      const row = table.rows[0];
      const topCells: TableCell[] = [];
      const bottomCells: TableCell[] = [];
      let didSplit = false;

      for (let ci = 0; ci < row.cells.length; ci++) {
        const cell = row.cells[ci];
        const totalItems = cell.content.length;

        // Get DOM-measured heights for this cell's children
        const domHeights = cellParaMeasured?.get(`${itemIdx}:${rowOffset}:${ci}`);

        // Determine border for the split cut point — use any existing visible border
        const cutBorder = cell.borderLeft || cell.borderRight || cell.borderTop || cell.borderBottom ||
                          table.defaultBorders?.top || table.defaultBorders?.bottom;

        if (totalItems <= 1 || !domHeights || domHeights.length === 0) {
          topCells.push({ ...cell, borderBottom: cell.borderBottom || cutBorder });
          bottomCells.push({ ...cell, content: [], borderTop: cell.borderTop || cutBorder });
        } else {
          // Map content indices to DOM child heights
          // RenderContent groups: paragraph + following inline drawings = 1 DOM child
          const contentHeights = mapContentToDomHeights(cell.content, domHeights);

          // Accumulate heights to find the split point
          let accH = 0;
          let splitIdx = totalItems; // default: no split
          for (let pi = 0; pi < totalItems; pi++) {
            const itemH = contentHeights[pi] || 0;
            if (accH + itemH > availableHeight && pi > 0) {
              splitIdx = pi;
              break;
            }
            accH += itemH;
          }
          // Keep paragraph + inline drawings together (prevent orphaned images)
          splitIdx = adjustSplitForInlineDrawings(cell.content, splitIdx);
          if (splitIdx < totalItems && splitIdx > 0) {
            topCells.push({ ...cell, content: cell.content.slice(0, splitIdx), borderBottom: cell.borderBottom || cutBorder });
            bottomCells.push({ ...cell, content: cell.content.slice(splitIdx), borderTop: cell.borderTop || cutBorder });
            didSplit = true;
          } else {
            topCells.push({ ...cell, borderBottom: cell.borderBottom || cutBorder });
            bottomCells.push({ ...cell, content: [], borderTop: cell.borderTop || cutBorder });
          }
        }
      }
      if (didSplit) {
        const topRow: TableRow = { ...row, cells: topCells };
        const bottomRow: TableRow = { ...row, cells: bottomCells };
        // Calculate top height from DOM-measured values & build updated measurements for remaining content
        let topH = 0;
        const updatedCellParaHeights = new Map<string, number[]>();
        for (let ci = 0; ci < topCells.length; ci++) {
          const origHeights = cellParaMeasured?.get(`${itemIdx}:${rowOffset}:${ci}`);
          if (!origHeights) continue;
          const contentHeights = mapContentToDomHeights(topCells[ci].content, origHeights);
          const cellH = contentHeights.reduce((s, h) => s + h, 0);
          topH = Math.max(topH, cellH);
          // Compute remaining DOM heights for the bottom part
          if (bottomCells[ci].content.length > 0) {
            const consumed = countDomChildrenForContent(row.cells[ci].content, topCells[ci].content.length);
            updatedCellParaHeights.set(`${itemIdx}:${rowOffset}:${ci}`, origHeights.slice(consumed));
          }
        }
        const cellRemainingH = Math.max(firstRowH - topH, 50);
        const remainingRows = table.rows.slice(1);
        let totalRemainingH = cellRemainingH;
        for (let ri = 1; ri < table.rows.length; ri++) {
          totalRemainingH += rowMeasured.get(`${itemIdx}:${ri + rowOffset}`) || 20;
        }
        log(`[DocxViewer] Split oversized row: top=${topH.toFixed(0)}px (${topCells[0]?.content.length} items), remaining=${cellRemainingH.toFixed(0)}px`);
        return {
          firstPart: { ...table, rows: [topRow] },
          secondPart: { ...table, rows: [bottomRow, ...remainingRows] },
          secondPartHeight: totalRemainingH,
          rowsConsumed: 0,
          updatedCellParaHeights,
          remainingRowHeight: cellRemainingH,
        };
      }
    }
  }

  if (splitAfterRow < 0 || splitAfterRow >= table.rows.length - 1) return null;

  // After row-level split, try to also fit partial content from the next row
  // This fills the remaining space on the page (e.g., Algorithm box: title row + partial content)
  const spaceAfterRowSplit = availableHeight - accHeight;
  if (spaceAfterRowSplit > 30 && cellParaMeasured) {
    const nextRowIdx = splitAfterRow + 1;
    const nextOrigRowIdx = nextRowIdx + rowOffset;
    const nextRow = table.rows[nextRowIdx];

    const topCells: TableCell[] = [];
    const bottomCells: TableCell[] = [];
    const updatedHeights = new Map<string, number[]>();
    let canPartialSplit = false;

    for (let ci = 0; ci < nextRow.cells.length; ci++) {
      const cell = nextRow.cells[ci];
      const domH = cellParaMeasured.get(`${itemIdx}:${nextOrigRowIdx}:${ci}`);
      // Border for the split cut point
      const cutBorder = cell.borderLeft || cell.borderRight || cell.borderTop || cell.borderBottom ||
                        table.defaultBorders?.top || table.defaultBorders?.bottom;

      if (cell.content.length > 1 && domH && domH.length > 0) {
        const contentH = mapContentToDomHeights(cell.content, domH);
        let cellAccH = 0;
        let splitIdx = cell.content.length;
        for (let pi = 0; pi < cell.content.length; pi++) {
          if (cellAccH + (contentH[pi] || 0) > spaceAfterRowSplit && pi > 0) {
            splitIdx = pi;
            break;
          }
          cellAccH += contentH[pi] || 0;
        }
        // Keep paragraph + inline drawings together (prevent orphaned images)
        splitIdx = adjustSplitForInlineDrawings(cell.content, splitIdx);
        if (splitIdx < cell.content.length && splitIdx > 0) {
          topCells.push({ ...cell, content: cell.content.slice(0, splitIdx), borderBottom: cell.borderBottom || cutBorder });
          bottomCells.push({ ...cell, content: cell.content.slice(splitIdx), borderTop: cell.borderTop || cutBorder });
          canPartialSplit = true;
          const consumed = countDomChildrenForContent(cell.content, splitIdx);
          updatedHeights.set(`${itemIdx}:${nextOrigRowIdx}:${ci}`, domH.slice(consumed));
        } else {
          topCells.push({ ...cell, borderBottom: cell.borderBottom || cutBorder });
          bottomCells.push({ ...cell, content: [], borderTop: cell.borderTop || cutBorder });
        }
      } else {
        topCells.push({ ...cell, borderBottom: cell.borderBottom || cutBorder });
        bottomCells.push({ ...cell, content: [], borderTop: cell.borderTop || cutBorder });
      }
    }

    if (canPartialSplit) {
      const nextRowH = rowMeasured.get(`${itemIdx}:${nextOrigRowIdx}`) || 20;
      let topRowH = 0;
      for (let ci = 0; ci < topCells.length; ci++) {
        const domH = cellParaMeasured.get(`${itemIdx}:${nextOrigRowIdx}:${ci}`);
        if (domH) {
          const ch = mapContentToDomHeights(topCells[ci].content, domH);
          topRowH = Math.max(topRowH, ch.reduce((s, h) => s + h, 0));
        }
      }
      const cellRemainingH = Math.max(nextRowH - topRowH, 50);
      const firstPartRows = [
        ...table.rows.slice(0, splitAfterRow + 1),
        { ...nextRow, cells: topCells } as TableRow,
      ];
      const secondPartRows = [
        { ...nextRow, cells: bottomCells } as TableRow,
        ...table.rows.slice(nextRowIdx + 1),
      ];
      let totalRemaining = cellRemainingH;
      for (let ri = nextRowIdx + 1; ri < table.rows.length; ri++) {
        totalRemaining += rowMeasured.get(`${itemIdx}:${ri + rowOffset}`) || 20;
      }
      log(`[DocxViewer] Row split + partial cell: rows 0..${splitAfterRow} + partial row ${nextRowIdx} (${topCells[0]?.content.length} items), remaining=${cellRemainingH.toFixed(0)}px`);
      return {
        firstPart: { ...table, rows: firstPartRows },
        secondPart: { ...table, rows: secondPartRows },
        secondPartHeight: totalRemaining,
        rowsConsumed: splitAfterRow + 1,
        updatedCellParaHeights: updatedHeights,
        remainingRowHeight: cellRemainingH,
      };
    }
  }

  // Standard row-level split (no partial content from next row)
  let secondPartHeight = 0;
  for (let ri = splitAfterRow + 1; ri < table.rows.length; ri++) {
    const originalRowIdx = ri + rowOffset;
    secondPartHeight += rowMeasured.get(`${itemIdx}:${originalRowIdx}`) || 20;
  }

  return {
    firstPart: { ...table, rows: table.rows.slice(0, splitAfterRow + 1) },
    secondPart: { ...table, rows: table.rows.slice(splitAfterRow + 1) },
    secondPartHeight,
    rowsConsumed: splitAfterRow + 1,
  };
}

export function splitOversizedPagesWithMeasured(
  pages: PageContent[],
  pageMeasurements: PageMeasurements,
  tableRowMeasurements: TableRowMeasurements,
  docDefaults: DocDefaults,
  pageContentHeights?: Map<number, number>,
  cellParagraphMeasurements?: CellParaMeasurements
): PageContent[] {
  const result: PageContent[] = [];
  let pageNum = 1;

  for (let pi = 0; pi < pages.length; pi++) {
    const page = pages[pi];
    const section = page.section;
    const availHeight = section.pageHeight - section.marginTop - section.marginBottom;
    const availWidth = section.pageWidth - section.marginLeft - section.marginRight;

    const measuredMap = pageMeasurements.get(pi);
    const heights: number[] = [];
    let totalHeight = 0;

    for (let ii = 0; ii < page.items.length; ii++) {
      const h = measuredMap?.get(ii) ?? estimateItemHeight(page.items[ii], availWidth, docDefaults);
      heights.push(h);
      totalHeight += h;
    }

    // Use accurate page content height (from scrollHeight, includes margin collapse)
    // Fall back to sum of individual heights if not available
    const accurateHeight = pageContentHeights?.get(pi) ?? totalHeight;
    const hasOversizedItem = heights.some(h => h > availHeight);

    // Page fits: no overflow detected from accurate measurement
    // Use 5% tolerance — minor overflow is due to CSS vs Word rendering differences
    if (accurateHeight <= availHeight * 1.05 || page.items.length <= 1) {
      // keepNext enforcement for nearly-full pages:
      // If page ends with [keepNext paragraphs..., table/drawing] and is >90% full,
      // split before the first keepNext paragraph — matches Word's behavior where
      // keepNext forces the next element to be on the same page, and if both don't fit,
      // both move to the next page.
      let keepNextSplitIdx = -1;
      if (page.items.length >= 3 && accurateHeight > availHeight * 0.90) {
        const lastItem = page.items[page.items.length - 1];
        if (lastItem.type === 'table' || lastItem.type === 'drawing') {
          // Walk backwards to find consecutive keepNext paragraphs before the table/drawing
          let idx = page.items.length - 2;
          while (idx >= 1 && page.items[idx].type === 'paragraph' && (page.items[idx] as { type: 'paragraph'; data: Paragraph }).data.keepNext) {
            idx--;
          }
          // idx+1 is the first keepNext paragraph before the table/drawing
          if (idx < page.items.length - 2) {
            keepNextSplitIdx = idx + 1;
          }
        }
      }

      if (keepNextSplitIdx > 0) {
        const firstPart = page.items.slice(0, keepNextSplitIdx);
        const secondPart = page.items.slice(keepNextSplitIdx);
        log(`[DocxViewer] keepNext split on page ${pi}: items ${keepNextSplitIdx}..${page.items.length - 1} moved to next page`);
        result.push({ items: firstPart, pageNumber: pageNum, section, isFirstInSection: page.isFirstInSection });
        pageNum++;
        result.push({ items: secondPart, pageNumber: pageNum, section });
        pageNum++;
      } else {
        result.push({ items: page.items, pageNumber: pageNum, section, isFirstInSection: page.isFirstInSection });
        pageNum++;
      }
    } else {
      // Page overflows — split at item boundaries and handle oversized tables
      // Scale individual heights to match actual rendered height (margin collapse correction):
      // Individual items are measured separately, so their margins don't collapse.
      // When rendered together, margins collapse → accurateHeight < totalHeight.
      // Apply proportional scaling so split decisions use realistic heights.
      const heightScale = totalHeight > 0 ? Math.min(accurateHeight / totalHeight, 1) : 1;
      log(`[DocxViewer] Page ${pi} overflows (${accurateHeight.toFixed(0)}px > ${availHeight.toFixed(0)}px, avail*1.05=${(availHeight*1.05).toFixed(0)}, scale=${heightScale.toFixed(3)}), splitting`);
      // Diagnostic: log each item in overflowing pages
      for (let di = 0; di < page.items.length; di++) {
        const dItem = page.items[di];
        const rawH = heights[di];
        const scaledH = rawH * heightScale;
        if (dItem.type === 'paragraph') {
          const text = dItem.data.runs.map((r: TextRun) => r.text).join('').substring(0, 50);
          log(`  [${di}] para h=${rawH.toFixed(1)}→${scaledH.toFixed(1)} lh=${dItem.data.lineHeightType}/${dItem.data.lineHeightValue} sa=${dItem.data.spaceAfter} text="${text}"`);
        } else if (dItem.type === 'table') {
          log(`  [${di}] TABLE h=${rawH.toFixed(1)}→${scaledH.toFixed(1)} rows=${dItem.data.rows.length} w=${dItem.data.width} wt=${dItem.data.widthType} layout=${dItem.data.layoutType}`);
        } else if (dItem.type === 'drawing') {
          log(`  [${di}] drawing h=${rawH.toFixed(1)}→${scaledH.toFixed(1)}`);
        } else {
          log(`  [${di}] ${dItem.type} h=${rawH.toFixed(1)}→${scaledH.toFixed(1)}`);
        }
      }

      let currentItems: ContentItem[] = [];
      let currentHeight = 0;

      for (let i = 0; i < page.items.length; i++) {
        const itemHeight = heights[i] * heightScale;

        // Oversized table: split by rows, fitting initial rows with preceding content
        if (page.items[i].type === 'table' && itemHeight > availHeight) {
          let rowMeasured = tableRowMeasurements.get(pi);
          let cellParaMeasured = cellParagraphMeasurements?.get(pi);
          let remainingTable = (page.items[i] as { type: 'table'; data: Table }).data;
          let remainingTableHeight = itemHeight;
          let totalRowsConsumed = 0;

          if (currentItems.length > 0) {
            // Try to fit preceding content + initial table rows on the same page
            const spaceForTable = availHeight - currentHeight;
            let fitted = false;

            if (spaceForTable > 30) {
              const splitResult = splitTableAtRowBoundary(remainingTable, i, spaceForTable, rowMeasured, totalRowsConsumed, cellParaMeasured);
              if (splitResult && splitResult.firstPart.rows.length > 0 && splitResult.secondPart.rows.length > 0) {
                // Keep preceding content + first table rows together
                currentItems.push({ type: 'table', data: splitResult.firstPart });
                result.push({ items: currentItems, pageNumber: pageNum, section, isFirstInSection: page.isFirstInSection });
                pageNum++;
                totalRowsConsumed += splitResult.rowsConsumed;
                remainingTable = splitResult.secondPart;
                remainingTableHeight = splitResult.secondPartHeight;
                currentItems = [];
                currentHeight = 0;
                fitted = true;
                // Update measurements for cell-level splits
                if (splitResult.updatedCellParaHeights) {
                  cellParaMeasured = new Map(cellParaMeasured || new Map());
                  for (const [k, v] of splitResult.updatedCellParaHeights) cellParaMeasured.set(k, v);
                  if (splitResult.remainingRowHeight !== undefined && rowMeasured) {
                    rowMeasured = new Map(rowMeasured);
                    rowMeasured.set(`${i}:${totalRowsConsumed}`, splitResult.remainingRowHeight);
                  }
                }
                log(`[DocxViewer] Fitted preceding content + ${splitResult.firstPart.rows.length} table rows on page ${pageNum - 1}`);
              }
            }

            if (!fitted) {
              // Can't fit any table rows — flush preceding content
              // But move table caption (last short paragraph) with the table
              const movedItems: ContentItem[] = [];
              let movedHeight = 0;
              if (currentItems.length > 1) {
                const lastItem = currentItems[currentItems.length - 1];
                if (lastItem.type === 'paragraph') {
                  const text = lastItem.data.runs.map((r: TextRun) => r.text).join('').replace(/[\u000B\u000C\uFFFC]/g, '').trim();
                  if (text.length > 0 && text.length < 120) {
                    movedItems.unshift(currentItems.pop()!);
                    movedHeight += heights[i - movedItems.length] * heightScale;
                    if (currentItems.length > 1) {
                      const spacer = currentItems[currentItems.length - 1];
                      if (spacer.type === 'paragraph') {
                        const spacerText = spacer.data.runs.map((r: TextRun) => r.text).join('').replace(/[\u000B\u000C\uFFFC]/g, '').trim();
                        if (spacerText.length === 0) {
                          movedItems.unshift(currentItems.pop()!);
                          movedHeight += heights[i - movedItems.length] * heightScale;
                        }
                      }
                    }
                  }
                }
              }
              result.push({ items: currentItems, pageNumber: pageNum, section, isFirstInSection: page.isFirstInSection });
              pageNum++;
              currentItems = [...movedItems];
              currentHeight = movedHeight;

              // If caption moved, try to fit caption + first table rows
              if (currentItems.length > 0 && remainingTableHeight > availHeight) {
                const firstAvail = availHeight - currentHeight;
                if (firstAvail > 30) {
                  const splitResult = splitTableAtRowBoundary(remainingTable, i, firstAvail, rowMeasured, totalRowsConsumed, cellParaMeasured);
                  if (splitResult && splitResult.firstPart.rows.length > 0 && splitResult.secondPart.rows.length > 0) {
                    currentItems.push({ type: 'table', data: splitResult.firstPart });
                    result.push({ items: currentItems, pageNumber: pageNum, section, isFirstInSection: page.isFirstInSection });
                    pageNum++;
                    totalRowsConsumed += splitResult.rowsConsumed;
                    remainingTable = splitResult.secondPart;
                    remainingTableHeight = splitResult.secondPartHeight;
                    currentItems = [];
                    currentHeight = 0;
                    // Update measurements for cell-level splits
                    if (splitResult.updatedCellParaHeights) {
                      cellParaMeasured = new Map(cellParaMeasured || new Map());
                      for (const [k, v] of splitResult.updatedCellParaHeights) cellParaMeasured.set(k, v);
                      if (splitResult.remainingRowHeight !== undefined && rowMeasured) {
                        rowMeasured = new Map(rowMeasured);
                        rowMeasured.set(`${i}:${totalRowsConsumed}`, splitResult.remainingRowHeight);
                      }
                    }
                  }
                }
                if (currentItems.length > 0) {
                  result.push({ items: currentItems, pageNumber: pageNum, section, isFirstInSection: page.isFirstInSection });
                  pageNum++;
                  currentItems = [];
                  currentHeight = 0;
                }
              }
            }
          }

          // Continue splitting remaining table on fresh pages
          while (remainingTableHeight > availHeight) {
            const splitResult = splitTableAtRowBoundary(remainingTable, i, availHeight, rowMeasured, totalRowsConsumed, cellParaMeasured);
            if (splitResult && splitResult.firstPart.rows.length > 0 && splitResult.secondPart.rows.length > 0) {
              result.push({ items: [{ type: 'table', data: splitResult.firstPart }], pageNumber: pageNum, section });
              pageNum++;
              totalRowsConsumed += splitResult.rowsConsumed;
              remainingTable = splitResult.secondPart;
              remainingTableHeight = splitResult.secondPartHeight;
              // Update measurements for cell-level splits
              if (splitResult.updatedCellParaHeights) {
                cellParaMeasured = new Map(cellParaMeasured || new Map());
                for (const [k, v] of splitResult.updatedCellParaHeights) cellParaMeasured.set(k, v);
                if (splitResult.remainingRowHeight !== undefined && rowMeasured) {
                  rowMeasured = new Map(rowMeasured);
                  rowMeasured.set(`${i}:${totalRowsConsumed}`, splitResult.remainingRowHeight);
                }
              }
            } else {
              break;
            }
          }
          currentItems.push({ type: 'table', data: remainingTable });
          currentHeight = remainingTableHeight;

        } else {
          // Regular item: check if adding it overflows the page
          if (currentItems.length > 0 && currentHeight + itemHeight > availHeight) {
            log(`  SPLIT at item ${i}: currentHeight=${currentHeight.toFixed(1)} + itemHeight=${itemHeight.toFixed(1)} = ${(currentHeight+itemHeight).toFixed(1)} > avail=${availHeight.toFixed(1)}, items on page: ${currentItems.length}`);
            // Orphan heading prevention: move ALL consecutive trailing headings to next page.
            // E.g., if page ends with [image, caption, "3.2.", "3.2.1."] and next item overflows,
            // both "3.2." and "3.2.1." move to the next page (keepNext cascade).
            const isItemHeading = (item: ContentItem): boolean => {
              if (item.type !== 'paragraph') return false;
              const p = item.data;
              return !!(
                (p.outlineLevel !== undefined && p.outlineLevel <= 4) ||
                p.keepNext ||
                (p.numberingText && /^\d+(\.\d+)*\.\s*$/.test(p.numberingText))
              );
            };

            // Count consecutive trailing headings
            const headingsToMove: ContentItem[] = [];
            let headingsHeight = 0;
            while (currentItems.length > 1 && isItemHeading(currentItems[currentItems.length - 1])) {
              const h = currentItems.pop()!;
              headingsToMove.unshift(h);
              // Find corresponding height (item index in original page)
              const origIdx = i - headingsToMove.length;
              headingsHeight += heights[origIdx] * heightScale;
            }

            if (headingsToMove.length > 0) {
              // Push current page without orphan headings
              result.push({ items: currentItems, pageNumber: pageNum, section, isFirstInSection: page.isFirstInSection });
              pageNum++;
              // Start new page with all the headings
              currentItems = [...headingsToMove];
              currentHeight = headingsHeight;
            } else if (page.items[i].type === 'table' && currentItems.length > 0) {
              // Table caption prevention: keep caption with its table on the next page
              // Move last short paragraph (table caption) + optional empty spacer before it
              const captionItems: ContentItem[] = [];
              let captionH = 0;
              const lastItem = currentItems[currentItems.length - 1];
              if (lastItem.type === 'paragraph') {
                const text = lastItem.data.runs.map((r: TextRun) => r.text).join('').replace(/[\u000B\u000C\uFFFC]/g, '').trim();
                if (text.length > 0 && text.length < 120) {
                  captionItems.unshift(currentItems.pop()!);
                  captionH += heights[i - captionItems.length] * heightScale;
                  // Also move preceding empty spacer paragraph
                  if (currentItems.length > 0) {
                    const spacer = currentItems[currentItems.length - 1];
                    if (spacer.type === 'paragraph') {
                      const spacerText = spacer.data.runs.map((r: TextRun) => r.text).join('').replace(/[\u000B\u000C\uFFFC]/g, '').trim();
                      if (spacerText.length === 0) {
                        captionItems.unshift(currentItems.pop()!);
                        captionH += heights[i - captionItems.length] * heightScale;
                      }
                    }
                  }
                  log(`  Moved table caption to next page: "${text.substring(0, 50)}"`);
                }
              }
              result.push({ items: currentItems, pageNumber: pageNum, section, isFirstInSection: page.isFirstInSection });
              pageNum++;
              currentItems = [...captionItems];
              currentHeight = captionH;
            } else {
              // Normal split — push current page and start new
              result.push({ items: currentItems, pageNumber: pageNum, section, isFirstInSection: page.isFirstInSection });
              pageNum++;
              currentItems = [];
              currentHeight = 0;
            }
          }
          currentItems.push(page.items[i]);
          currentHeight += itemHeight;

          // Post-addition: if a table was just added and the page overflows,
          // decide whether to split the table or move caption+table to next page.
          if (page.items[i].type === 'table' && currentHeight > availHeight * 1.02 && currentItems.length >= 2) {
            const tableItem = currentItems.pop()!;
            let tableData = (tableItem as { type: 'table'; data: Table }).data;
            let tableH = itemHeight;
            const prevHeight = currentHeight - itemHeight;
            const spaceForTable = availHeight - prevHeight;
            let rowMeasured2 = tableRowMeasurements.get(pi);
            let cellParaMeasured2 = cellParagraphMeasurements?.get(pi);
            let totalRowsConsumed = 0;

            // Word heuristic: if less than ~25% of the table fits on the current page,
            // move the entire table (and its caption) to the next page rather than
            // splitting just a few rows onto the current page.
            const tableFitRatio = spaceForTable / tableH;
            const pageFitRatio = spaceForTable / availHeight;

            if (spaceForTable > 30 && tableFitRatio >= 0.25 && pageFitRatio >= 0.20) {
              // Enough space for a meaningful portion — split the table
              const splitResult = splitTableAtRowBoundary(tableData, i, spaceForTable, rowMeasured2, totalRowsConsumed, cellParaMeasured2);
              if (splitResult && splitResult.firstPart.rows.length > 0 && splitResult.secondPart.rows.length > 0) {
                log(`  Post-split table: ${splitResult.firstPart.rows.length} rows fit (ratio=${tableFitRatio.toFixed(2)}), ${splitResult.secondPart.rows.length} rows overflow`);
                currentItems.push({ type: 'table', data: splitResult.firstPart });
                result.push({ items: currentItems, pageNumber: pageNum, section, isFirstInSection: page.isFirstInSection });
                pageNum++;
                totalRowsConsumed += splitResult.rowsConsumed;
                tableData = splitResult.secondPart;
                tableH = splitResult.secondPartHeight;
                // Update measurements for cell-level splits
                if (splitResult.updatedCellParaHeights) {
                  cellParaMeasured2 = new Map(cellParaMeasured2 || new Map());
                  for (const [k, v] of splitResult.updatedCellParaHeights) cellParaMeasured2.set(k, v);
                  if (splitResult.remainingRowHeight !== undefined && rowMeasured2) {
                    rowMeasured2 = new Map(rowMeasured2);
                    rowMeasured2.set(`${i}:${totalRowsConsumed}`, splitResult.remainingRowHeight);
                  }
                }

                // Continue splitting remaining table if still oversized
                while (tableH > availHeight) {
                  const nextSplit = splitTableAtRowBoundary(tableData, i, availHeight, rowMeasured2, totalRowsConsumed, cellParaMeasured2);
                  if (nextSplit && nextSplit.firstPart.rows.length > 0 && nextSplit.secondPart.rows.length > 0) {
                    result.push({ items: [{ type: 'table', data: nextSplit.firstPart }], pageNumber: pageNum, section });
                    pageNum++;
                    totalRowsConsumed += nextSplit.rowsConsumed;
                    tableData = nextSplit.secondPart;
                    tableH = nextSplit.secondPartHeight;
                    // Update measurements for cell-level splits
                    if (nextSplit.updatedCellParaHeights) {
                      cellParaMeasured2 = new Map(cellParaMeasured2 || new Map());
                      for (const [k, v] of nextSplit.updatedCellParaHeights) cellParaMeasured2.set(k, v);
                      if (nextSplit.remainingRowHeight !== undefined && rowMeasured2) {
                        rowMeasured2 = new Map(rowMeasured2);
                        rowMeasured2.set(`${i}:${totalRowsConsumed}`, nextSplit.remainingRowHeight);
                      }
                    }
                  } else {
                    break;
                  }
                }

                currentItems = [{ type: 'table', data: tableData }];
                currentHeight = tableH;
              } else {
                currentItems.push(tableItem); // can't split, put back
              }
            } else {
              // Not enough space — move caption+table to next page entirely
              // (matches Word behavior: small remainder → move entire table)
              log(`  Moving table to next page: space=${spaceForTable.toFixed(0)}px, tableFit=${(tableFitRatio*100).toFixed(0)}%, pageFit=${(pageFitRatio*100).toFixed(0)}%`);
              // Check if preceding items include a caption to move with the table
              const captionItems: ContentItem[] = [];
              let captionH = 0;
              if (currentItems.length > 0) {
                const lastItem = currentItems[currentItems.length - 1];
                if (lastItem.type === 'paragraph') {
                  const text = lastItem.data.runs.map((r: TextRun) => r.text).join('').replace(/[\u000B\u000C\uFFFC]/g, '').trim();
                  if (text.length > 0 && text.length < 120) {
                    captionItems.unshift(currentItems.pop()!);
                    captionH += heights[i - 1 - captionItems.length + 1] * heightScale;
                    // Also move preceding empty spacer
                    if (currentItems.length > 0) {
                      const spacer = currentItems[currentItems.length - 1];
                      if (spacer.type === 'paragraph') {
                        const spacerText = spacer.data.runs.map((r: TextRun) => r.text).join('').replace(/[\u000B\u000C\uFFFC]/g, '').trim();
                        if (spacerText.length === 0) {
                          captionItems.unshift(currentItems.pop()!);
                          captionH += heights[i - 1 - captionItems.length + 1] * heightScale;
                        }
                      }
                    }
                  }
                }
              }
              if (currentItems.length > 0) {
                result.push({ items: currentItems, pageNumber: pageNum, section, isFirstInSection: page.isFirstInSection });
                pageNum++;
              }
              // Caption + table on new page; continue splitting if needed
              currentItems = [...captionItems];
              currentHeight = captionH;
              currentItems.push(tableItem);
              currentHeight += tableH;

              // If caption+table STILL overflows a full page, split by rows
              if (currentHeight > availHeight * 1.02) {
                const capTableItem = currentItems.pop()!;
                let ctTableData = (capTableItem as { type: 'table'; data: Table }).data;
                let ctTableH = tableH;
                const ctPrevH = currentHeight - tableH;
                const ctSpace = availHeight - ctPrevH;

                if (ctSpace > 30) {
                  let ctRowMeasured = rowMeasured2;
                  let ctCellPara = cellParaMeasured2;
                  const splitResult = splitTableAtRowBoundary(ctTableData, i, ctSpace, ctRowMeasured, 0, ctCellPara);
                  if (splitResult && splitResult.firstPart.rows.length > 0 && splitResult.secondPart.rows.length > 0) {
                    currentItems.push({ type: 'table', data: splitResult.firstPart });
                    result.push({ items: currentItems, pageNumber: pageNum, section, isFirstInSection: page.isFirstInSection });
                    pageNum++;
                    let consumed = splitResult.rowsConsumed;
                    ctTableData = splitResult.secondPart;
                    ctTableH = splitResult.secondPartHeight;
                    // Update measurements for cell-level splits
                    if (splitResult.updatedCellParaHeights) {
                      ctCellPara = new Map(ctCellPara || new Map());
                      for (const [k, v] of splitResult.updatedCellParaHeights) ctCellPara.set(k, v);
                      if (splitResult.remainingRowHeight !== undefined && ctRowMeasured) {
                        ctRowMeasured = new Map(ctRowMeasured);
                        ctRowMeasured.set(`${i}:${consumed}`, splitResult.remainingRowHeight);
                      }
                    }

                    while (ctTableH > availHeight) {
                      const nextSplit = splitTableAtRowBoundary(ctTableData, i, availHeight, ctRowMeasured, consumed, ctCellPara);
                      if (nextSplit && nextSplit.firstPart.rows.length > 0 && nextSplit.secondPart.rows.length > 0) {
                        result.push({ items: [{ type: 'table', data: nextSplit.firstPart }], pageNumber: pageNum, section });
                        pageNum++;
                        consumed += nextSplit.rowsConsumed;
                        ctTableData = nextSplit.secondPart;
                        ctTableH = nextSplit.secondPartHeight;
                        // Update measurements for cell-level splits
                        if (nextSplit.updatedCellParaHeights) {
                          ctCellPara = new Map(ctCellPara || new Map());
                          for (const [k, v] of nextSplit.updatedCellParaHeights) ctCellPara.set(k, v);
                          if (nextSplit.remainingRowHeight !== undefined && ctRowMeasured) {
                            ctRowMeasured = new Map(ctRowMeasured);
                            ctRowMeasured.set(`${i}:${consumed}`, nextSplit.remainingRowHeight);
                          }
                        }
                      } else {
                        break;
                      }
                    }
                    currentItems = [{ type: 'table', data: ctTableData }];
                    currentHeight = ctTableH;
                  } else {
                    currentItems.push(capTableItem);
                  }
                } else {
                  currentItems.push(capTableItem);
                }
              }
            }
          }
        }
      }

      if (currentItems.length > 0) {
        result.push({ items: currentItems, pageNumber: pageNum, section, measuredContentHeight: currentHeight });
        pageNum++;
      }
    }
  }

  // Post-processing: merge underfilled pages (from table splits) with items from the next page.
  // When a table split leaves remaining space on a page and body text follows on the next page,
  // pull paragraph items from the next page to fill the space — matching Word's behavior.
  for (let ri = 0; ri < result.length - 1; ri++) {
    const rPage = result[ri];
    if (rPage.measuredContentHeight === undefined) continue;
    const rSection = rPage.section;
    const rAvailH = rSection.pageHeight - rSection.marginTop - rSection.marginBottom;
    const remaining = rAvailH - rPage.measuredContentHeight;
    if (remaining < 50) continue;

    const nextRPage = result[ri + 1];
    if (nextRPage.section !== rSection) continue;
    if (nextRPage.items.length === 0) continue;

    // Pull items from next page that fit in remaining space
    const rAvailW = rSection.pageWidth - rSection.marginLeft - rSection.marginRight;
    let pulled = 0;
    let pulledH = 0;
    for (let ni = 0; ni < nextRPage.items.length; ni++) {
      const item = nextRPage.items[ni];
      // Only pull paragraphs and inline drawings — not tables (which need their own split logic)
      if (item.type === 'table') break;
      const h = estimateItemHeight(item, rAvailW, docDefaults);
      if (pulledH + h > remaining) break;
      rPage.items.push(item);
      pulledH += h;
      pulled++;
    }

    // Ensure we don't leave orphaned inline drawings on the next page
    // (they must stay with their preceding paragraph)
    while (pulled > 0 && pulled < nextRPage.items.length && nextRPage.items[pulled].type === 'drawing') {
      rPage.items.push(nextRPage.items[pulled]);
      pulled++;
    }

    if (pulled > 0) {
      rPage.measuredContentHeight = (rPage.measuredContentHeight || 0) + pulledH;
      if (pulled === nextRPage.items.length) {
        result.splice(ri + 1, 1);
        ri--; // re-check current page (might pull from new next page)
      } else {
        nextRPage.items = nextRPage.items.slice(pulled);
      }
      log(`[DocxViewer] Merged ${pulled} items from next page into underfilled page ${ri} (remaining=${remaining.toFixed(0)}px, pulled=${pulledH.toFixed(0)}px)`);
    }
  }

  // Renumber pages after merging
  for (let ri = 0; ri < result.length; ri++) {
    result[ri].pageNumber = ri + 1;
  }

  log(`[DocxViewer] splitOversizedPagesWithMeasured: ${pages.length} raw → ${result.length} final (${result.length - pages.length} additional from splits)`);
  return result;
}
