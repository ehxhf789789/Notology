import { useEffect, useRef, useState, useCallback } from 'react';
import { renderAsync } from 'docx-preview';

interface DocxViewerProps {
  data: ArrayBuffer;
}

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 3;
const ZOOM_STEP = 0.1;

export function DocxViewer({ data }: DocxViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);

  useEffect(() => {
    if (contentRef.current && data) {
      // Clear previous content
      contentRef.current.innerHTML = '';

      renderAsync(data, contentRef.current, undefined, {
        className: 'docx-content',
        inWrapper: true,
        ignoreWidth: false,
        ignoreHeight: false,
        ignoreFonts: false,
        breakPages: true,
        useBase64URL: true,
      }).catch(err => {
        console.error('[DocxViewer] Render failed:', err);
        if (contentRef.current) {
          contentRef.current.innerHTML = `<div class="office-viewer-error">Failed to render document: ${err.message}</div>`;
        }
      });
    }
  }, [data]);

  const handleWheel = useCallback((e: WheelEvent) => {
    if (e.ctrlKey) {
      e.preventDefault();
      const delta = e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP;
      setZoom(prev => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, prev + delta)));
    }
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (container) {
      container.addEventListener('wheel', handleWheel, { passive: false });
      return () => container.removeEventListener('wheel', handleWheel);
    }
  }, [handleWheel]);

  return (
    <div ref={containerRef} className="office-viewer-container docx-viewer">
      <div className="docx-zoom-indicator">{Math.round(zoom * 100)}%</div>
      <div
        ref={contentRef}
        className="docx-content-wrapper"
        style={{ transform: `scale(${zoom})`, transformOrigin: 'top left' }}
      />
    </div>
  );
}

export default DocxViewer;
