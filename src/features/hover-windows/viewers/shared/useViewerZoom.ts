import { useState, useEffect, useRef, type RefObject, type Dispatch, type SetStateAction, type MutableRefObject } from 'react';
import { MIN_ZOOM, MAX_ZOOM, ZOOM_STEP } from './viewerConstants';

interface UseViewerZoomOptions {
  min?: number;
  max?: number;
  step?: number;
  /** Custom handler called BEFORE React state update. Receives (event, oldZoom, newZoom).
   *  Return false to prevent the default setZoom call (for custom DOM-level zoom). */
  onZoom?: (e: WheelEvent, oldZoom: number, newZoom: number) => boolean | void;
}

interface UseViewerZoomResult {
  zoom: number;
  setZoom: Dispatch<SetStateAction<number>>;
  zoomRef: MutableRefObject<number>;
}

/**
 * Custom hook for Ctrl+Wheel zoom shared across all document viewers.
 * Uses document-level capture to intercept before WebView2 native zoom.
 */
export function useViewerZoom(
  containerRef: RefObject<HTMLElement | null>,
  options?: UseViewerZoomOptions,
): UseViewerZoomResult {
  const min = options?.min ?? MIN_ZOOM;
  const max = options?.max ?? MAX_ZOOM;
  const step = options?.step ?? ZOOM_STEP;
  const onZoom = options?.onZoom;

  const [zoom, setZoom] = useState(1);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;

  // Store onZoom in ref to avoid re-creating effect
  const onZoomRef = useRef(onZoom);
  onZoomRef.current = onZoom;

  useEffect(() => {
    const handler = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      if (!containerRef.current?.contains(e.target as Node)) return;
      e.preventDefault();
      e.stopPropagation();

      const delta = e.deltaY > 0 ? -step : step;
      const oldZoom = zoomRef.current;
      const newZoom = Math.min(max, Math.max(min, oldZoom + delta));
      if (newZoom === oldZoom) return;

      // Allow custom handler to take over (e.g., DocxViewer scroll preservation)
      if (onZoomRef.current) {
        const result = onZoomRef.current(e, oldZoom, newZoom);
        if (result === false) return; // custom handler handled everything
      }

      zoomRef.current = newZoom;
      setZoom(newZoom);
    };

    document.addEventListener('wheel', handler, { passive: false, capture: true });
    return () => document.removeEventListener('wheel', handler, { capture: true } as EventListenerOptions);
  }, [containerRef, min, max, step]);

  return { zoom, setZoom, zoomRef };
}
