import { useMemo, useState, useCallback, useRef, useEffect } from 'react';
import * as XLSX from 'xlsx';

interface XlsxViewerProps {
  data: ArrayBuffer;
}

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 3;
const ZOOM_STEP = 0.1;

export function XlsxViewer({ data }: XlsxViewerProps) {
  const [currentSheet, setCurrentSheet] = useState(0);
  const [zoom, setZoom] = useState(1);
  const containerRef = useRef<HTMLDivElement>(null);

  const { sheetNames, html, error } = useMemo(() => {
    try {
      const workbook = XLSX.read(data, { type: 'array' });
      const sheetNames = workbook.SheetNames;
      const sheetName = sheetNames[currentSheet] || sheetNames[0];
      const sheet = workbook.Sheets[sheetName];
      const html = XLSX.utils.sheet_to_html(sheet, { editable: false });
      return { sheetNames, html, error: null };
    } catch (err) {
      console.error('[XlsxViewer] Parse failed:', err);
      return { sheetNames: [], html: '', error: err instanceof Error ? err.message : String(err) };
    }
  }, [data, currentSheet]);

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

  if (error) {
    return (
      <div className="office-viewer-container xlsx-viewer">
        <div className="office-viewer-error">Failed to parse spreadsheet: {error}</div>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="office-viewer-container xlsx-viewer">
      {sheetNames.length > 1 && (
        <div className="xlsx-sheet-tabs">
          {sheetNames.map((name, idx) => (
            <button
              key={name}
              className={`xlsx-sheet-tab${idx === currentSheet ? ' active' : ''}`}
              onClick={() => setCurrentSheet(idx)}
            >
              {name}
            </button>
          ))}
        </div>
      )}
      <div className="xlsx-zoom-indicator">{Math.round(zoom * 100)}%</div>
      <div
        className="xlsx-content"
        style={{ transform: `scale(${zoom})`, transformOrigin: 'top left' }}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}

export default XlsxViewer;
