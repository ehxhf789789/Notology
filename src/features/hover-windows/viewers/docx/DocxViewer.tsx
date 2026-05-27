import { useState, useEffect, useLayoutEffect, useRef } from 'react';
import { useViewerZoom } from '../shared/useViewerZoom';
import { log } from '../shared/viewerConstants';
import type {
  DocxViewerProps, DocumentData, PageContent, ViewerPhase, SectionProps,
  PageMeasurements, TableRowMeasurements, CellParaMeasurements,
} from './docxTypes';
import { DocGridContext } from './docxTypes';
import { parseDocx } from './docxParser';
import { paginateContent, splitOversizedPages, splitOversizedPagesWithMeasured } from './docxPagination';
import { MeasurableContent, RenderContent } from './DocxRenderComponents';

// ==================== Main Component ====================

export function DocxViewer({ data }: DocxViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const measureContainerRef = useRef<HTMLDivElement>(null);
  const [docData, setDocData] = useState<DocumentData | null>(null);
  const [pages, setPages] = useState<PageContent[]>([]);
  const [rawPages, setRawPages] = useState<PageContent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<ViewerPhase>('loading');
  const [currentPage, setCurrentPage] = useState(1);

  // Zoom with scroll position preservation
  const { zoom, zoomRef } = useViewerZoom(containerRef, {
    onZoom: (e, oldZoom, newZoom) => {
      const scrollContainer = scrollContainerRef.current;
      if (!scrollContainer) return;
      const pagesContainer = scrollContainer.querySelector('.docx-pages-container') as HTMLElement;
      if (!pagesContainer) return;

      // Preserve scroll position: keep the same content point at the viewport center
      const scrollTop = scrollContainer.scrollTop;
      const viewportCenter = scrollTop + scrollContainer.clientHeight / 2;
      const contentPos = viewportCenter / oldZoom;
      const newScrollTop = contentPos * newZoom - scrollContainer.clientHeight / 2;

      // Apply transform directly to DOM synchronously (no React re-render delay)
      pagesContainer.style.transform = `scale(${newZoom})`;
      scrollContainer.scrollTop = Math.max(0, newScrollTop);
    },
  });

  // Effect 1: Parse document and create raw pages (no overflow splitting)
  useEffect(() => {
    const loadDocument = async () => {
      try {
        setPhase('loading');
        setError(null);
        const documentData = await parseDocx(data);
        setDocData(documentData);
        const rawPaginatedPages = paginateContent(
          documentData.content, documentData.defaultSection, documentData.docDefaults
        );
        setRawPages(rawPaginatedPages);
        setPhase('measuring');
        log('[DocxViewer] Parse complete, entering measurement phase. Raw pages:', rawPaginatedPages.length);
      } catch (err) {
        console.error('[DocxViewer] Parse error:', err);
        setError(err instanceof Error ? err.message : 'Failed to parse document');
        setPhase('ready');
      }
    };
    loadDocument();
  }, [data]);

  // Effect 2: Measure DOM heights from hidden container, then finalize pagination
  useLayoutEffect(() => {
    if (phase !== 'measuring' || !measureContainerRef.current || !docData || rawPages.length === 0) return;

    const rafId = requestAnimationFrame(() => {
      const container = measureContainerRef.current;
      if (!container) return;

      const images = container.querySelectorAll('img');
      const unloaded = Array.from(images).filter(img => !img.complete);

      const doMeasure = () => {
        const pageMeasurements: PageMeasurements = new Map();
        const tableRowMeasurements: TableRowMeasurements = new Map();
        const cellParagraphMeasurements: CellParaMeasurements = new Map();
        // Accurate total page content heights (includes margin collapse)
        const pageContentHeights = new Map<number, number>();

        const pageElements = container.querySelectorAll('[data-page-idx]');
        for (const pageEl of pageElements) {
          const pageIdx = parseInt(pageEl.getAttribute('data-page-idx')!);
          const itemHeights = new Map<number, number>();
          const rowHeights = new Map<string, number>();
          const cellParaHeights = new Map<string, number[]>();

          // Measure total page content height from the container (accurate, with margin collapse)
          const el = pageEl as HTMLElement;
          const section = rawPages[pageIdx]?.section;
          if (section) {
            const totalContentH = el.scrollHeight - section.marginTop - section.marginBottom;
            pageContentHeights.set(pageIdx, totalContentH);
          }

          const itemWrappers = pageEl.querySelectorAll(':scope > [data-item-idx]');
          for (const wrapper of itemWrappers) {
            const itemIdx = parseInt(wrapper.getAttribute('data-item-idx')!);
            itemHeights.set(itemIdx, wrapper.getBoundingClientRect().height);

            // Measure individual table rows for potential row-level splitting
            const rows = wrapper.querySelectorAll(':scope table > tbody > tr');
            rows.forEach((tr, rowIdx) => {
              rowHeights.set(`${itemIdx}:${rowIdx}`, tr.getBoundingClientRect().height);

              // Measure individual cell paragraph heights for cell content splitting
              const tds = tr.querySelectorAll(':scope > td');
              tds.forEach((td, cellIdx) => {
                const children = (td as HTMLElement).children;
                const heights: number[] = [];
                for (let ci = 0; ci < children.length; ci++) {
                  heights.push((children[ci] as HTMLElement).getBoundingClientRect().height);
                }
                if (heights.length > 0) {
                  cellParaHeights.set(`${itemIdx}:${rowIdx}:${cellIdx}`, heights);
                }
              });
            });
          }

          pageMeasurements.set(pageIdx, itemHeights);
          tableRowMeasurements.set(pageIdx, rowHeights);
          cellParagraphMeasurements.set(pageIdx, cellParaHeights);
        }

        const totalMeasured = Array.from(pageMeasurements.values())
          .reduce((sum, m) => sum + m.size, 0);
        log('[DocxViewer] Measured', totalMeasured, 'items across', pageMeasurements.size, 'pages');

        // Diagnostic: log a few pages' measurement details
        for (let di = 0; di < Math.min(3, rawPages.length); di++) {
          const mMap = pageMeasurements.get(di);
          if (mMap) {
            const total = Array.from(mMap.values()).reduce((s, h) => s + h, 0);
            const section = rawPages[di].section;
            const avail = section.pageHeight - section.marginTop - section.marginBottom;
            log(`[DocxViewer] Page ${di}: measured=${total.toFixed(0)}px, avail=${avail.toFixed(0)}px, items=${mMap.size}, overflow=${total > avail ? 'YES' : 'no'}`);
          }
        }

        if (totalMeasured > 0) {
          const finalPages = splitOversizedPagesWithMeasured(
            rawPages, pageMeasurements, tableRowMeasurements, docData.docDefaults, pageContentHeights, cellParagraphMeasurements
          );
          setPages(finalPages);
          log('[DocxViewer] Final pages after measurement:', finalPages.length);
        } else {
          log('[DocxViewer] Measurement failed, falling back to estimation');
          const finalPages = splitOversizedPages(rawPages, docData.docDefaults);
          setPages(finalPages);
        }
        setPhase('ready');
      };

      if (unloaded.length > 0) {
        Promise.all(unloaded.map(img => new Promise<void>(resolve => {
          img.onload = () => resolve();
          img.onerror = () => resolve();
        }))).then(doMeasure);
      } else {
        doMeasure();
      }
    });

    return () => cancelAnimationFrame(rafId);
  }, [phase, docData, rawPages]);

  // Zoom is handled by useViewerZoom hook with scroll position preservation callback

  // Track visible page
  useEffect(() => {
    const scrollContainer = scrollContainerRef.current;
    if (!scrollContainer || pages.length === 0) return;

    const handleScroll = () => {
      const pageElements = scrollContainer.querySelectorAll('.docx-page');
      if (pageElements.length === 0) return;
      const containerRect = scrollContainer.getBoundingClientRect();
      const containerCenter = containerRect.top + containerRect.height / 3;

      let visiblePage = 1;
      for (let i = 0; i < pageElements.length; i++) {
        const pageRect = pageElements[i].getBoundingClientRect();
        if (pageRect.top <= containerCenter && pageRect.bottom > containerCenter) {
          visiblePage = i + 1;
          break;
        } else if (pageRect.top > containerCenter) {
          visiblePage = Math.max(1, i);
          break;
        } else if (i === pageElements.length - 1) {
          visiblePage = pageElements.length;
        }
      }
      setCurrentPage(visiblePage);
    };

    scrollContainer.addEventListener('scroll', handleScroll);
    handleScroll();
    return () => scrollContainer.removeEventListener('scroll', handleScroll);
  }, [pages, zoom]);

  // Compute default font and line-height for both measuring and rendering phases
  const defaultFont = docData?.docDefaults.run.fontFamily || 'Times New Roman, 바탕, Batang, serif';
  const defaultFontSize = docData?.docDefaults.run.fontSize || 10;
  // Default line-height: from docDefaults (auto multiplier) or OOXML standard 1.15
  const defaultLineHeight: string | number = docData?.docDefaults.para.lineHeightType === 'auto'
    ? (docData.docDefaults.para.lineHeightValue || 1.15)
    : docData?.docDefaults.para.lineHeightType === 'exact' || docData?.docDefaults.para.lineHeightType === 'atLeast'
      ? `${docData.docDefaults.para.lineHeightValue || 16}px`
      : 1.15;

  // Phase: loading
  if (phase === 'loading') {
    return (
      <div className="office-viewer-container docx-viewer" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div>Loading document...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="office-viewer-container docx-viewer" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div className="office-viewer-error">Error: {error}</div>
      </div>
    );
  }

  // Phase: measuring — show loading + hidden measurement container
  if (phase === 'measuring' && docData && rawPages.length > 0) {
    return (
      <div ref={containerRef} className="office-viewer-container docx-viewer">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 1 }}>
          <div>Loading document...</div>
        </div>
        {/* Off-screen measurement container — same CSS classes for identical rendering */}
        <div
          ref={measureContainerRef}
          style={{ position: 'absolute', left: '-9999px', top: 0, visibility: 'hidden', pointerEvents: 'none' }}
        >
          {rawPages.map((page, pageIdx) => (
            <div
              key={pageIdx}
              className="docx-page"
              data-page-idx={pageIdx}
              style={{
                width: page.section.pageWidth,
                minHeight: 'auto',
                paddingTop: page.section.marginTop,
                paddingBottom: page.section.marginBottom,
                paddingLeft: page.section.marginLeft,
                paddingRight: page.section.marginRight,
                fontFamily: defaultFont,
                fontSize: `${defaultFontSize}pt`,
                boxSizing: 'border-box',
                lineHeight: page.section.linePitch ? `${page.section.linePitch}px` : defaultLineHeight,
              }}
            >
              <DocGridContext.Provider value={page.section.linePitch || 0}>
                <MeasurableContent items={page.items} />
              </DocGridContext.Provider>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // Phase: ready — normal page rendering
  if (!docData || pages.length === 0) {
    return (
      <div className="office-viewer-container docx-viewer" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div>No content to display</div>
      </div>
    );
  }

  // Compute per-section page numbers using OOXML rules:
  // - w:pgNumType w:start → ALWAYS reset counter to that value (not "forward jump only")
  // - No w:start → counter continues from previous section
  // - Visibility: per-section hasPageNumberInFooter / hasPageNumberInFirstFooter
  // - titlePage: first page of section uses "first" footer (may or may not have PAGE field)
  const pageDisplayNumbers: (number | null)[] = [];
  {
    let counter = 1;
    let prevSection: SectionProps | null = null;
    for (let i = 0; i < pages.length; i++) {
      const page = pages[i];
      const section = page.section;
      const isSectionChange = section !== prevSection;

      // Reset counter on section change with w:start (unconditionally per OOXML spec)
      if (isSectionChange && section.pageNumberStart !== undefined) {
        counter = section.pageNumberStart;
      }

      // Determine visibility based on per-section footer PAGE field status
      const isTitlePage = isSectionChange && section.titlePage;
      const showNumber = isTitlePage
        ? (section.hasPageNumberInFirstFooter === true)
        : (section.hasPageNumberInFooter === true);

      pageDisplayNumbers.push(showNumber ? counter : null);
      counter++;
      prevSection = section;
    }
  }

  return (
    <div ref={containerRef} className="office-viewer-container docx-viewer">
      <div className="viewer-toolbar docx-toolbar">
        <div className="docx-page-indicator">
          {currentPage} / {pages.length}
        </div>
        <div className="docx-zoom-indicator">{Math.round(zoom * 100)}%</div>
      </div>
      <div ref={scrollContainerRef} className="docx-scroll-container">
        <div
          className="docx-pages-container"
          style={{
            transform: `scale(${zoom})`,
            transformOrigin: 'top center',
          }}
        >
          {pages.map((page, idx) => {
            const section = page.section;
            const displayPageNum = pageDisplayNumbers[idx];
            const contentHeight = section.pageHeight - section.marginTop - section.marginBottom;
            return (
              <div
                key={idx}
                className="docx-page"
                style={{
                  width: section.pageWidth,
                  height: section.pageHeight,
                  fontFamily: defaultFont,
                  fontSize: `${defaultFontSize}pt`,
                  boxSizing: 'border-box',
                  lineHeight: section.linePitch ? `${section.linePitch}px` : defaultLineHeight,
                  position: 'relative',
                }}
              >
                {/* Content area — clipped precisely at margins */}
                <div
                  style={{
                    position: 'absolute',
                    top: section.marginTop,
                    left: section.marginLeft,
                    right: section.marginRight,
                    height: contentHeight,
                    overflow: 'hidden',
                  }}
                >
                  <DocGridContext.Provider value={section.linePitch || 0}>
                    <RenderContent items={page.items} />
                  </DocGridContext.Provider>
                </div>
                {/* Footer page number */}
                {docData.hasFooterPageNumber && displayPageNum != null && (
                  <div
                    style={{
                      position: 'absolute',
                      bottom: section.footerMargin || 48,
                      left: section.marginLeft,
                      right: section.marginRight,
                      textAlign: 'center',
                      fontSize: '10pt',
                      color: '#000',
                      pointerEvents: 'none',
                    }}
                  >
                    {displayPageNum}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export default DocxViewer;
