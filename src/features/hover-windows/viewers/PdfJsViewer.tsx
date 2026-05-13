/**
 * PDF.js-backed PDF viewer (HanBin 2026-05-13 round 6).
 *
 * Replaces the iframe → WebView2 internal PDF handler with a bundled
 * `pdfjs-dist` pipeline so we own the toolbar end-to-end. This removes
 * the chrome://settings navigation that was crashing the app to a
 * black screen — there's no native PDF viewer involved at all.
 *
 * Render strategy:
 *   • Load PDF bytes via Tauri's `read_binary_file` command.
 *   • `pdfjsLib.getDocument({ data })` parses on the bundled worker.
 *   • Each page renders to its own `<canvas>` lazily via
 *     IntersectionObserver — only pages in (or near) the viewport
 *     actually rasterize, so a 500-page PDF doesn't allocate 500 huge
 *     canvases up front.
 *   • Toolbar exposes: page nav (prev/next + jump-to), zoom
 *     (out/in/fit-width), rotate. No menu surface that could navigate
 *     anywhere.
 */

import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { previewCommands } from '../../../core/services/tauriCommands';
import { ChevronLeft, ChevronRight, ZoomIn, ZoomOut, Maximize2, RotateCw } from 'lucide-react';

// Wire the worker exactly once, module-load time. Subsequent component
// mounts reuse it. `workerUrl` is a Vite-emitted asset URL pointing at
// the bundled `pdf.worker.min.mjs`.
pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

interface Props {
  filePath: string;
}

export default function PdfJsViewer({ filePath }: Props) {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [totalPages, setTotalPages] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [scale, setScale] = useState(1.0);
  const [rotation, setRotation] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [fitWidth, setFitWidth] = useState(true);

  const scrollRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef<Map<number, HTMLDivElement>>(new Map());

  // ── Load + parse PDF ────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    let loadingTask: ReturnType<typeof pdfjsLib.getDocument> | null = null;

    (async () => {
      setLoading(true);
      setError(null);
      try {
        const bytes = await previewCommands.readBinaryFile(filePath);
        if (cancelled) return;
        const data = new Uint8Array(bytes);
        loadingTask = pdfjsLib.getDocument({ data });
        const doc = await loadingTask.promise;
        if (cancelled) {
          doc.destroy();
          return;
        }
        setPdf(doc);
        setTotalPages(doc.numPages);
        setCurrentPage(1);
        setLoading(false);
      } catch (e) {
        if (!cancelled) {
          setError(String(e));
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      if (loadingTask) loadingTask.destroy();
    };
  }, [filePath]);

  // Destroy doc on unmount to free worker memory.
  useEffect(() => {
    return () => {
      pdf?.destroy();
    };
  }, [pdf]);

  // ── "Current page" derived from scroll position ──────────────────────────
  // Whichever page's top edge is closest to the viewport center wins. Keeps
  // the page-number indicator in the toolbar in sync with scrolling.
  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll || totalPages === 0) return;
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const containerTop = scroll.scrollTop;
        const viewportCenter = containerTop + scroll.clientHeight / 2;
        let bestPage = 1;
        let bestDist = Infinity;
        pageRefs.current.forEach((el, pageNum) => {
          const elTop = el.offsetTop;
          const elBottom = elTop + el.offsetHeight;
          // distance from viewport center to page midpoint
          const pageMid = (elTop + elBottom) / 2;
          const dist = Math.abs(pageMid - viewportCenter);
          if (dist < bestDist) {
            bestDist = dist;
            bestPage = pageNum;
          }
        });
        setCurrentPage(bestPage);
      });
    };
    scroll.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      scroll.removeEventListener('scroll', onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [totalPages]);

  // ── Toolbar actions ──────────────────────────────────────────────────────
  const scrollToPage = useCallback((pageNum: number) => {
    const el = pageRefs.current.get(pageNum);
    if (el && scrollRef.current) {
      scrollRef.current.scrollTo({ top: el.offsetTop - 8, behavior: 'smooth' });
    }
  }, []);

  const handlePrev = useCallback(() => {
    const next = Math.max(1, currentPage - 1);
    scrollToPage(next);
  }, [currentPage, scrollToPage]);

  const handleNext = useCallback(() => {
    const next = Math.min(totalPages, currentPage + 1);
    scrollToPage(next);
  }, [currentPage, totalPages, scrollToPage]);

  const handleZoomIn = useCallback(() => {
    setFitWidth(false);
    setScale((s) => Math.min(4.0, +(s + 0.25).toFixed(2)));
  }, []);

  const handleZoomOut = useCallback(() => {
    setFitWidth(false);
    setScale((s) => Math.max(0.25, +(s - 0.25).toFixed(2)));
  }, []);

  const handleFitWidth = useCallback(() => {
    setFitWidth(true);
  }, []);

  const handleRotate = useCallback(() => {
    setRotation((r) => (r + 90) % 360);
  }, []);

  // Ctrl + wheel = zoom (mirrors the previous WebView2 viewer behavior).
  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        if (e.deltaY < 0) handleZoomIn();
        else handleZoomOut();
      }
    };
    scroll.addEventListener('wheel', onWheel, { passive: false });
    return () => scroll.removeEventListener('wheel', onWheel);
  }, [handleZoomIn, handleZoomOut]);

  // Keyboard shortcuts: PageUp / PageDown / arrows for nav, Ctrl+0 for fit.
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'PageDown' || (e.key === 'ArrowDown' && (e.ctrlKey || e.metaKey))) {
      e.preventDefault();
      handleNext();
    } else if (e.key === 'PageUp' || (e.key === 'ArrowUp' && (e.ctrlKey || e.metaKey))) {
      e.preventDefault();
      handlePrev();
    } else if ((e.ctrlKey || e.metaKey) && e.key === '0') {
      e.preventDefault();
      handleFitWidth();
    }
  }, [handleNext, handlePrev, handleFitWidth]);

  const setPageRef = useCallback((pageNum: number, el: HTMLDivElement | null) => {
    if (el) pageRefs.current.set(pageNum, el);
    else pageRefs.current.delete(pageNum);
  }, []);

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="pdfjs-viewer" tabIndex={0} onKeyDown={handleKeyDown}>
      <div className="pdfjs-toolbar">
        <button
          className="pdfjs-toolbar-btn"
          onClick={handlePrev}
          disabled={currentPage <= 1}
          title="이전 페이지"
        >
          <ChevronLeft size={14} />
        </button>
        <span className="pdfjs-toolbar-pageinfo">
          {totalPages > 0 ? `${currentPage} / ${totalPages}` : '— / —'}
        </span>
        <button
          className="pdfjs-toolbar-btn"
          onClick={handleNext}
          disabled={currentPage >= totalPages}
          title="다음 페이지"
        >
          <ChevronRight size={14} />
        </button>
        <span className="pdfjs-toolbar-divider" />
        <button className="pdfjs-toolbar-btn" onClick={handleZoomOut} title="축소">
          <ZoomOut size={14} />
        </button>
        <span className="pdfjs-toolbar-zoom">{fitWidth ? '맞춤' : `${Math.round(scale * 100)}%`}</span>
        <button className="pdfjs-toolbar-btn" onClick={handleZoomIn} title="확대">
          <ZoomIn size={14} />
        </button>
        <button
          className={`pdfjs-toolbar-btn${fitWidth ? ' active' : ''}`}
          onClick={handleFitWidth}
          title="너비 맞춤"
        >
          <Maximize2 size={14} />
        </button>
        <span className="pdfjs-toolbar-divider" />
        <button className="pdfjs-toolbar-btn" onClick={handleRotate} title="회전">
          <RotateCw size={14} />
        </button>
      </div>
      <div className="pdfjs-pages" ref={scrollRef}>
        {loading && <div className="pdfjs-status">PDF 로딩 중...</div>}
        {error && <div className="pdfjs-status pdfjs-status-error">로딩 실패: {error}</div>}
        {pdf && Array.from({ length: totalPages }, (_, i) => (
          <PdfPage
            key={`${filePath}-${i}-${rotation}`}
            pdf={pdf}
            pageNum={i + 1}
            scale={scale}
            rotation={rotation}
            fitWidth={fitWidth}
            scrollContainer={scrollRef.current}
            registerRef={setPageRef}
          />
        ))}
      </div>
    </div>
  );
}

// ── Per-page lazy renderer ──────────────────────────────────────────────────
//
// IntersectionObserver tracks whether each page's container is near the
// viewport. Pages within `rootMargin` actually rasterize to canvas; the
// rest stay as fixed-size placeholders so the scroll height stays
// consistent. This is the cheap-and-correct pattern PDF.js's own
// viewer uses internally; without it a 200-page PDF would allocate
// 200 high-DPI canvases up front and blow out the GPU memory.

interface PdfPageProps {
  pdf: PDFDocumentProxy;
  pageNum: number;
  scale: number;
  rotation: number;
  fitWidth: boolean;
  scrollContainer: HTMLDivElement | null;
  registerRef: (pageNum: number, el: HTMLDivElement | null) => void;
}

function PdfPage({
  pdf,
  pageNum,
  scale,
  rotation,
  fitWidth,
  scrollContainer,
  registerRef,
}: PdfPageProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [pageMeta, setPageMeta] = useState<{ width: number; height: number } | null>(null);
  const [visible, setVisible] = useState(false);

  // Resolve the page's natural size once so we can reserve scroll space
  // even before the page paints.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const page = await pdf.getPage(pageNum);
      if (cancelled) return;
      const viewport = page.getViewport({ scale: 1.0, rotation });
      setPageMeta({ width: viewport.width, height: viewport.height });
      page.cleanup();
    })();
    return () => { cancelled = true; };
  }, [pdf, pageNum, rotation]);

  // Visibility tracking — only paint when in (or near) the viewport.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !scrollContainer) return;
    const obs = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) setVisible(true);
        }
      },
      { root: scrollContainer, rootMargin: '600px 0px' },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [scrollContainer]);

  // Compute the effective scale (fit-width if requested).
  const effectiveScale = useMemo(() => {
    if (!fitWidth || !scrollContainer || !pageMeta) return scale;
    const padding = 32; // matches CSS padding-x on .pdfjs-pages
    const available = Math.max(100, scrollContainer.clientWidth - padding);
    return available / pageMeta.width;
  }, [fitWidth, scale, scrollContainer, pageMeta]);

  // Render to canvas whenever (visibility, scale, rotation) changes.
  useEffect(() => {
    if (!visible || !canvasRef.current) return;
    let cancelled = false;
    let renderTask: ReturnType<PDFPageProxy['render']> | null = null;
    (async () => {
      const page = await pdf.getPage(pageNum);
      if (cancelled) {
        page.cleanup();
        return;
      }
      const viewport = page.getViewport({ scale: effectiveScale, rotation });
      const dpr = window.devicePixelRatio || 1;
      const canvas = canvasRef.current!;
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      renderTask = page.render({ canvas, canvasContext: ctx, viewport });
      try {
        await renderTask.promise;
      } catch (e: any) {
        // A new render started before this finished — that's fine.
        if (e?.name !== 'RenderingCancelledException') {
          console.warn(`[PdfJsViewer] page ${pageNum} render failed:`, e);
        }
      } finally {
        page.cleanup();
      }
    })();
    return () => {
      cancelled = true;
      if (renderTask) renderTask.cancel();
    };
  }, [visible, effectiveScale, rotation, pageNum, pdf]);

  // Use the page's natural dimensions (or 850x1100 fallback) to reserve
  // scroll space so the page-number tracker has stable offsets.
  const placeholderStyle: React.CSSProperties = pageMeta
    ? { width: pageMeta.width * effectiveScale, height: pageMeta.height * effectiveScale }
    : { width: 850 * effectiveScale, height: 1100 * effectiveScale };

  return (
    <div
      ref={(el) => {
        containerRef.current = el;
        registerRef(pageNum, el);
      }}
      className="pdfjs-page"
      style={placeholderStyle}
    >
      {visible && <canvas ref={canvasRef} className="pdfjs-page-canvas" />}
    </div>
  );
}
