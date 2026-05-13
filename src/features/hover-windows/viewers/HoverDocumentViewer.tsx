import { useState, useEffect, useRef, useCallback, memo } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Minus, X, ExternalLink, RefreshCw, FileWarning } from 'lucide-react';
import { utilCommands, previewCommands } from '../../../core/services/tauriCommands';
import { useHoverStore, hoverActions, useIsClosing, useIsMinimizing, HOVER_ANIMATION } from '../stores/hoverStore';
import { useLanguage } from '../../../core/stores/zustand';
import { t } from '../../../core/utils/i18n';
import { isHoverWindow } from '../../../core/utils/multiWindow';
import { runAnimation, HOVER_WINDOW_OPEN_DURATION, hoverWindowPropsAreEqual, type HoverEditorWindowProps } from '../hoverAnimationUtils';
import { DocxViewer } from './docx';
import { XlsxViewer } from './XlsxViewer';
import { PptxViewer } from './pptx';
import { HwpxViewer } from './hwpx';
import { HwpViewer } from './HwpViewer';
import { convertFileSrc } from '@tauri-apps/api/core';

const DEV = import.meta.env.DEV;
const log = DEV ? console.log.bind(console) : () => {};

type ViewerState = 'idle' | 'loading' | 'docx' | 'xlsx' | 'pptx' | 'hwpx' | 'hwp' | 'pdf' | 'error';

// Legacy formats that should open with external app immediately (no internal viewer)
const LEGACY_EXTENSIONS = ['ppt', 'doc', 'xls', 'hwp'];

// Check if file is a legacy format
function isLegacyFormat(filePath: string): boolean {
  const ext = filePath.toLowerCase().split('.').pop() || '';
  return LEGACY_EXTENSIONS.includes(ext);
}

// Determine viewer type from file extension
function getViewerType(filePath: string): ViewerState {
  const ext = filePath.toLowerCase().split('.').pop() || '';
  switch (ext) {
    case 'docx': return 'docx';
    case 'xlsx': return 'xlsx';
    case 'pptx': return 'pptx';
    case 'hwpx': return 'hwp'; // HWPX also uses Rust hwpers backend (supports both formats)
    case 'hwp': return 'hwp';
    default: return 'pdf'; // fallback to PDF conversion for unknown types
  }
}

const HoverDocumentViewer = memo(function HoverDocumentViewer({ window: win }: HoverEditorWindowProps) {
  const closeHoverFile = useHoverStore((s) => s.closeHoverFile);
  const focusHoverFile = useHoverStore((s) => s.focusHoverFile);
  const minimizeHoverFile = useHoverStore((s) => s.minimizeHoverFile);
  const language = useLanguage();
  const updateHoverWindow = useHoverStore((s) => s.updateHoverWindow);
  const [isDragging, setIsDragging] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const [isOpening, setIsOpening] = useState(true);
  const isClosing = useIsClosing(win.id);
  const isMinimizing = useIsMinimizing(win.id);
  const dragStartRef = useRef({ x: 0, y: 0, posX: 0, posY: 0 });
  const resizeStartRef = useRef({ x: 0, y: 0, w: 0, h: 0 });
  const preMaximizeStateRef = useRef<{ position: { x: number; y: number }; size: { width: number; height: number } } | null>(null);
  const hoverEditorRef = useRef<HTMLDivElement>(null);
  const currentPosRef = useRef({ x: win.position.x, y: win.position.y });
  const currentSizeRef = useRef({ width: win.size.width, height: win.size.height });
  const prevCachedRef = useRef(win.cached);
  const prevMinimizedRef = useRef(win.minimized);

  // Document viewer state
  const [viewerState, setViewerState] = useState<ViewerState>('idle');
  const [documentData, setDocumentData] = useState<ArrayBuffer | null>(null);
  const [pdfPath, setPdfPath] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string>('');
  const [hwpxFallback, setHwpxFallback] = useState(false);
  const loadAbortRef = useRef(false);

  // Load document when window opens or is restored
  const loadDocument = useCallback(async () => {
    if (!win.filePath) return;
    loadAbortRef.current = false;

    // For legacy formats (PPT, DOC, XLS), open with external app immediately and close
    if (isLegacyFormat(win.filePath)) {
      log(`[DocViewer ${win.id.slice(-6)}] Legacy format detected, opening externally: ${win.filePath}`);
      utilCommands.openInDefaultApp(win.filePath);
      // Close this hover window
      closeHoverFile(win.id);
      return;
    }

    const targetType = getViewerType(win.filePath);
    log(`[DocViewer ${win.id.slice(-6)}] Loading: ${win.filePath}, type: ${targetType}`);

    setViewerState('loading');
    setErrorMessage('');

    try {
      // HWP/HWPX: Use Rust backend directly (HwpViewer handles file reading)
      if (targetType === 'hwp') {
        setViewerState('hwp');
        log(`[DocViewer ${win.id.slice(-6)}] Using Rust hwpers backend for: ${win.filePath}`);
      }
      // For JavaScript-rendered formats (docx, xlsx, pptx)
      else if (targetType === 'docx' || targetType === 'xlsx' || targetType === 'pptx') {
        const bytes = await previewCommands.readBinaryFile(win.filePath);
        if (loadAbortRef.current) return;

        // Convert number[] to ArrayBuffer
        const arrayBuffer = new Uint8Array(bytes).buffer;
        setDocumentData(arrayBuffer);
        setViewerState(targetType);
        log(`[DocViewer ${win.id.slice(-6)}] Loaded ${bytes.length} bytes for ${targetType}`);
      } else {
        // Fallback to PDF conversion for unknown types
        const result = await previewCommands.convertToPreviewPdf(win.filePath);
        if (loadAbortRef.current) return;
        setPdfPath(result);
        setViewerState('pdf');
        log(`[DocViewer ${win.id.slice(-6)}] PDF conversion complete: ${result}`);
      }
    } catch (err) {
      if (loadAbortRef.current) return;
      const msg = err instanceof Error ? err.message : String(err);
      log(`[DocViewer ${win.id.slice(-6)}] Load failed: ${msg}`);
      setErrorMessage(msg);
      setViewerState('error');
    }
  }, [win.filePath, win.id]);

  // Start loading on mount
  useEffect(() => {
    if (viewerState === 'idle') {
      loadDocument();
    }
    return () => { loadAbortRef.current = true; };
  }, []);  // eslint-disable-line react-hooks/exhaustive-deps

  // Re-load on content reload trigger
  useEffect(() => {
    if (win.contentReloadTrigger && win.contentReloadTrigger > 0) {
      loadDocument();
    }
  }, [win.contentReloadTrigger, loadDocument]);

  // Detect cache/minimized restoration and re-trigger opening animation
  useEffect(() => {
    const restoredFromCache = prevCachedRef.current === true && win.cached === false;
    const restoredFromMinimized = prevMinimizedRef.current === true && win.minimized === false;

    if (restoredFromCache) {
      log(`[DocViewer ${win.id.slice(-6)}] RESTORE from cache`);
      setIsOpening(true);
      // Re-load in case file changed while cached
      loadDocument();
    } else if (restoredFromMinimized) {
      if (hoverEditorRef.current) {
        hoverEditorRef.current.getAnimations().forEach(a => a.cancel());
      }
      setIsOpening(true);
    }

    prevCachedRef.current = win.cached;
    prevMinimizedRef.current = win.minimized;
  }, [win.cached, win.minimized, win.id, loadDocument]);

  // Run opening animation
  useEffect(() => {
    if (isOpening && hoverEditorRef.current) {
      const el = hoverEditorRef.current;
      runAnimation(el, 'open', HOVER_WINDOW_OPEN_DURATION).then(() => {
        setIsOpening(false);
      });
    }
  }, [isOpening, win.id]);

  // Sync refs when win props change
  useEffect(() => {
    if (!isDragging) {
      currentPosRef.current = { x: win.position.x, y: win.position.y };
    }
    if (!isResizing) {
      currentSizeRef.current = { width: win.size.width, height: win.size.height };
    }
  }, [win.position.x, win.position.y, win.size.width, win.size.height, isDragging, isResizing]);

  const handleMouseDown = () => { focusHoverFile(win.id); };

  const handleClose = useCallback(async () => {
    const currentWin = getCurrentWindow();
    const windowLabel = currentWin.label;
    const urlParams = new URLSearchParams(window.location.search);
    const isHoverFromUrl = urlParams.get('hover') === 'true';
    const isMultiWindow = windowLabel.startsWith('hover-') || isHoverFromUrl;

    if (isMultiWindow) {
      try { await currentWin.destroy(); } catch (err) { console.error('[DocViewer] Window destroy failed:', err); }
      return;
    }

    const el = hoverEditorRef.current;
    if (el) {
      hoverActions.startClosing(win.id);
      runAnimation(el, 'close', HOVER_ANIMATION.CLOSE_DURATION).then(() => {
        hoverActions.finishClosing(win.id);
      });
    } else {
      hoverActions.startClosing(win.id);
      setTimeout(() => hoverActions.finishClosing(win.id), HOVER_ANIMATION.CLOSE_DURATION);
    }
  }, [win.id]);

  const handleMinimize = useCallback(async () => {
    const currentWin = getCurrentWindow();
    const windowLabel = currentWin.label;
    const urlParams = new URLSearchParams(window.location.search);
    const isHoverFromUrl = urlParams.get('hover') === 'true';
    const isMultiWindow = windowLabel.startsWith('hover-') || isHoverFromUrl;

    if (isMultiWindow) {
      try { await currentWin.minimize(); } catch (err) { console.error('[DocViewer] Window minimize failed:', err); }
      return;
    }

    const el = hoverEditorRef.current;
    if (el) {
      hoverActions.startMinimizing(win.id);
      runAnimation(el, 'minimize', HOVER_ANIMATION.MINIMIZE_DURATION).then(() => {
        hoverActions.finishMinimizing(win.id);
      });
    } else {
      hoverActions.startMinimizing(win.id);
      setTimeout(() => hoverActions.finishMinimizing(win.id), HOVER_ANIMATION.MINIMIZE_DURATION);
    }
  }, [win.id]);

  const handleDoubleClick = useCallback(() => {
    if (isHoverWindow()) {
      getCurrentWindow().toggleMaximize();
      return;
    }
    const screenWidth = window.innerWidth;
    const screenHeight = window.innerHeight;
    const isMaximized = win.position.x === 0 && win.position.y === 0 &&
                        win.size.width === screenWidth && win.size.height === screenHeight;
    if (isMaximized && preMaximizeStateRef.current) {
      updateHoverWindow(win.id, { position: preMaximizeStateRef.current.position, size: preMaximizeStateRef.current.size });
      preMaximizeStateRef.current = null;
    } else if (isMaximized) {
      updateHoverWindow(win.id, { position: { x: 350, y: 120 }, size: { width: 1000, height: 800 } });
    } else {
      preMaximizeStateRef.current = { position: { ...win.position }, size: { ...win.size } };
      updateHoverWindow(win.id, { position: { x: 0, y: 0 }, size: { width: screenWidth, height: screenHeight } });
    }
  }, [win.id, win.position, win.size, updateHoverWindow]);

  const handleDragStart = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('.hover-editor-close, .hover-editor-minimize')) return;
    e.preventDefault();
    if (isHoverWindow()) { getCurrentWindow().startDragging(); return; }
    setIsDragging(true);
    dragStartRef.current = { x: e.clientX, y: e.clientY, posX: win.position.x, posY: win.position.y };
  };

  const handleResizeStart = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsResizing(true);
    resizeStartRef.current = { x: e.clientX, y: e.clientY, w: win.size.width, h: win.size.height };
  };

  useEffect(() => {
    if (!isDragging && !isResizing) return;

    let rafId: number | null = null;
    let lastMouseEvent: MouseEvent | null = null;

    const processMouseMove = () => {
      if (!lastMouseEvent || !hoverEditorRef.current) return;
      const e = lastMouseEvent;
      if (isDragging) {
        const dx = e.clientX - dragStartRef.current.x;
        const dy = e.clientY - dragStartRef.current.y;
        let finalX = dragStartRef.current.posX + dx;
        let finalY = dragStartRef.current.posY + dy;
        const windowWidth = currentSizeRef.current.width;
        const screenWidth = window.innerWidth;
        const screenHeight = window.innerHeight;
        const MIN_VISIBLE = 100;
        finalX = Math.max(MIN_VISIBLE - windowWidth, Math.min(screenWidth - MIN_VISIBLE, finalX));
        finalY = Math.max(0, Math.min(screenHeight - MIN_VISIBLE, finalY));
        currentPosRef.current = { x: finalX, y: finalY };
        hoverEditorRef.current.style.transform = `translate3d(${finalX}px, ${finalY}px, 0)`;
      }
      if (isResizing) {
        const dx = e.clientX - resizeStartRef.current.x;
        const dy = e.clientY - resizeStartRef.current.y;
        const newWidth = Math.max(300, resizeStartRef.current.w + dx);
        const newHeight = Math.max(200, resizeStartRef.current.h + dy);
        currentSizeRef.current = { width: newWidth, height: newHeight };
        hoverEditorRef.current.style.width = `${newWidth}px`;
        hoverEditorRef.current.style.height = `${newHeight}px`;
      }
      rafId = null;
    };

    const handleMouseMove = (e: MouseEvent) => {
      lastMouseEvent = e;
      if (rafId === null) { rafId = requestAnimationFrame(processMouseMove); }
    };

    const handleMouseUp = () => {
      if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
      if (isDragging) {
        const finalX = currentPosRef.current.x;
        const screenWidth = window.innerWidth;
        const screenHeight = window.innerHeight;
        if (finalX < 5) {
          updateHoverWindow(win.id, { position: { x: 0, y: 0 }, size: { width: screenWidth >> 1, height: screenHeight } });
        } else if (finalX + currentSizeRef.current.width > screenWidth - 5) {
          updateHoverWindow(win.id, { position: { x: screenWidth >> 1, y: 0 }, size: { width: screenWidth >> 1, height: screenHeight } });
        } else {
          updateHoverWindow(win.id, { position: currentPosRef.current });
        }
      }
      if (isResizing) updateHoverWindow(win.id, { size: currentSizeRef.current });
      setIsDragging(false);
      setIsResizing(false);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [isDragging, isResizing, win.id, updateHoverWindow]);

  const fileName = win.filePath.split(/[/\\]/).pop() || '';
  const displayFileName = fileName.replace(/_/g, ' ');

  const inMultiWindowMode = isHoverWindow();

  const renderBody = () => {
    switch (viewerState) {
      case 'idle':
      case 'loading':
        return (
          <div className="hover-editor-body doc-viewer-status">
            <div className="doc-viewer-converting">
              <RefreshCw size={32} className="doc-viewer-spinner" />
              <p>{t('docPreviewLoading', language)}</p>
            </div>
          </div>
        );

      case 'error':
        return (
          <div className="hover-editor-body doc-viewer-status">
            <div className="doc-viewer-error">
              <FileWarning size={32} />
              <p>{t('docPreviewFailed', language)}</p>
              <p className="doc-viewer-error-detail">{errorMessage}</p>
              <button className="doc-viewer-retry-btn" onClick={loadDocument}>
                {t('docPreviewRetry', language)}
              </button>
            </div>
          </div>
        );

      case 'docx':
        return (
          <div className="hover-editor-body office-viewer-body">
            {documentData && <DocxViewer data={documentData} />}
          </div>
        );

      case 'xlsx':
        return (
          <div className="hover-editor-body office-viewer-body">
            {documentData && <XlsxViewer data={documentData} />}
          </div>
        );

      case 'pptx':
        return (
          <div className="hover-editor-body office-viewer-body">
            {documentData && <PptxViewer data={documentData} />}
          </div>
        );

      case 'hwp':
        // HWPX fallback: if Rust failed, use JavaScript parser
        if (hwpxFallback && documentData) {
          return (
            <div className="hover-editor-body office-viewer-body">
              <HwpxViewer data={documentData} />
            </div>
          );
        }
        // Used for both .hwp and .hwpx files (hwpers Rust backend supports both)
        return (
          <div className="hover-editor-body office-viewer-body">
            <HwpViewer
              filePath={win.filePath}
              onRustFailed={win.filePath.toLowerCase().endsWith('.hwpx') ? async (err) => {
                log(`[DocViewer ${win.id.slice(-6)}] Rust hwpers failed for HWPX, falling back to JS viewer: ${err}`);
                // Show loading spinner immediately while reading binary
                setViewerState('loading');
                try {
                  const bytes = await previewCommands.readBinaryFile(win.filePath);
                  if (loadAbortRef.current) return;
                  const arrayBuffer = new Uint8Array(bytes).buffer;
                  setDocumentData(arrayBuffer);
                  setHwpxFallback(true);
                  setViewerState('hwp');
                } catch (readErr) {
                  setErrorMessage(String(readErr));
                  setViewerState('error');
                }
              } : undefined}
            />
          </div>
        );

      case 'pdf':
        return (
          <div className="hover-editor-body pdf-viewer-body" style={{ position: 'relative' }}>
            {/* HanBin 2026-05-13 round 10: native WebView2 PDF + ⋮-menu
                click blocker overlay. See HoverPdfViewer.tsx for the
                rationale. */}
            {pdfPath && <iframe
              src={convertFileSrc(pdfPath)}
              referrerPolicy="no-referrer"
              width="100%"
              height="100%"
              style={{ border: 'none' }}
            />}
            <div
              className="pdf-overflow-blocker"
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}
              onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
              aria-hidden="true"
              title=""
            />
          </div>
        );
    }
  };

  return (
    <div
      ref={hoverEditorRef}
      className={`hover-editor${isDragging ? ' is-dragging' : ''}${isResizing ? ' is-resizing' : ''}`}
      style={{
        ...(inMultiWindowMode ? {
          position: 'relative' as const,
          width: '100%',
          height: '100%',
          transform: 'none',
          border: 'none',
          borderRadius: 0,
          boxShadow: 'none',
        } : {
          transform: `translate3d(${win.position.x}px, ${win.position.y}px, 0)`,
          width: win.size.width,
          height: win.size.height,
          zIndex: win.zIndex,
        }),
      }}
      onMouseDown={handleMouseDown}
    >
      <div className="hover-editor-header" onMouseDown={handleDragStart} onDoubleClick={handleDoubleClick}>
        <span className="hover-editor-title">{displayFileName}</span>
        <div className="hover-editor-header-actions">
          <button
            className="hover-editor-open-external"
            onClick={() => utilCommands.openInDefaultApp(win.filePath)}
            onMouseDown={(e) => e.stopPropagation()}
            title={t('openInApp', language)}
          >
            <ExternalLink size={14} />
          </button>
          <button
            className="hover-editor-minimize"
            onClick={handleMinimize}
            onMouseDown={(e) => e.stopPropagation()}
            title={t('minimize', language)}
          >
            <Minus size={14} />
          </button>
          <button
            className="hover-editor-close"
            onClick={handleClose}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <X size={14} />
          </button>
        </div>
      </div>
      {renderBody()}
      {!inMultiWindowMode && <div className="hover-editor-resize" onMouseDown={handleResizeStart} />}
    </div>
  );
}, hoverWindowPropsAreEqual);

export default HoverDocumentViewer;
