import type {
  ContentItem, Section, Paragraph, Table, ImageElement,
} from './hwpxTypes';

// ==================== Page Pagination ====================

/** Estimate height of a content item for fallback pagination */
export function estimateItemHeight(item: ContentItem): number {
  if (item.type === 'paragraph') {
    const para = item.data as Paragraph;
    const lineCount = Math.max(1, Math.ceil(para.runs.reduce((acc, r) => acc + r.text.length, 0) / 60));
    const fontSize = (para.runs[0]?.fontSize || 10);
    const lineH = typeof para.lineHeight === 'number' ? para.lineHeight * fontSize / 100 : fontSize * 1.6;
    return lineCount * lineH + (para.marginTop || 0) + (para.marginBottom || 0);
  }
  if (item.type === 'table') {
    const table = item.data as Table;
    return table.rows.reduce((sum, r) => sum + (r.height || 24), 0);
  }
  if (item.type === 'image') {
    const img = item.data as ImageElement;
    if (img.textWrap === 'BEHIND_TEXT' || img.textWrap === 'IN_FRONT_OF_TEXT') return 0;
    return img.height || 100;
  }
  return 20;
}

export function paginateSection(section: Section): ContentItem[][] {
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

  // Fallback: explicit pageBreak + height estimation
  const pageH = section.pageHeight || 1122;
  const mT = section.marginTop || 56;
  const mB = section.marginBottom || 56;
  const contentAreaHeight = pageH - mT - mB;

  const pages: ContentItem[][] = [];
  let currentPage: ContentItem[] = [];
  let currentHeight = 0;

  for (const item of section.content) {
    // Explicit page break
    if (item.type === 'paragraph' && item.data.pageBreakBefore && currentPage.length > 0) {
      pages.push(currentPage);
      currentPage = [];
      currentHeight = 0;
    }

    const itemHeight = estimateItemHeight(item);

    // Height-based page split
    if (currentPage.length > 0 && currentHeight + itemHeight > contentAreaHeight) {
      pages.push(currentPage);
      currentPage = [];
      currentHeight = 0;
    }

    currentPage.push(item);
    currentHeight += itemHeight;
  }
  if (currentPage.length > 0) pages.push(currentPage);
  return pages.length > 0 ? pages : [[]];
}
