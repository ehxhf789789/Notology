import { useState, useEffect, useMemo, useDeferredValue, memo } from 'react';
import React from 'react';
import { useHoverStore } from '../../stores/zustand/hoverStore';
import { HoverEditorWindow } from '../HoverEditor';
import HoverPdfViewer from './HoverPdfViewer';
import HoverImageViewer from './HoverImageViewer';
import HoverCodeViewer from './HoverCodeViewer';
import HoverWebViewer from './HoverWebViewer';
import HoverDocumentViewer from './HoverDocumentViewer';

// Conditional logging - only in development
const DEV = import.meta.env.DEV;
const log = DEV ? console.log.bind(console) : () => {};

// Stable style objects for wrapper (prevents recreating objects on every render)
const HIDDEN_WRAPPER_STYLE: React.CSSProperties = {
  position: 'absolute',
  visibility: 'hidden',
  pointerEvents: 'none',
  left: '-9999px',
  top: '-9999px'
};
const VISIBLE_WRAPPER_STYLE: React.CSSProperties = {};

// ========== Warm-up Component for First Render Optimization ==========
// Renders a hidden skeleton on mount to pre-pay React's first-render overhead
// This reduces animation delay when the first actual hover window opens
const WarmUpSkeleton = memo(function WarmUpSkeleton() {
  const [warmedUp, setWarmedUp] = useState(false);

  useEffect(() => {
    // Mark as warmed up after initial render, then unmount skeleton to free memory
    const timer = setTimeout(() => {
      log('[WarmUp] Skeleton rendered, React component tree primed');
      setWarmedUp(true);
    }, 100);
    return () => clearTimeout(timer);
  }, []);

  // After warm-up, return null to free memory
  if (warmedUp) return null;

  log('[WarmUp] Rendering skeleton to prime React component tree');

  // Minimal skeleton that mimics HoverEditorWindow structure
  // This primes React's internal structures without expensive operations
  return (
    <div style={HIDDEN_WRAPPER_STYLE} aria-hidden="true">
      <div className="hover-editor">
        <div className="hover-editor-header">
          <div className="hover-editor-title-area">
            <span className="hover-editor-title" />
          </div>
          <div className="hover-editor-actions">
            <button className="hover-editor-minimize" />
            <button className="hover-editor-close" />
          </div>
        </div>
        <div className="hover-editor-content-row">
          <div className="hover-editor-body">
            <div className="hover-editor-skeleton">
              <div className="skeleton-line skeleton-title" />
              <div className="skeleton-line skeleton-full" />
              <div className="skeleton-line skeleton-short" />
            </div>
          </div>
        </div>
        <div className="hover-editor-resize" />
      </div>
    </div>
  );
});

// Layer component that renders all hover windows
// Note: Snap preview is handled via direct DOM manipulation for zero React overhead
// OPTIMIZATION: Keep minimized windows in DOM (hidden) for instant restore without reload
const HoverEditorLayer = memo(function HoverEditorLayer() {
  const renderStart = performance.now();
  // OPTIMIZATION: Use Zustand selective subscription instead of Context
  // This prevents re-renders when unrelated appStore values change
  const hoverFiles = useHoverStore((state) => state.hoverFiles);
  // Subscribe to animation state to keep windows visible during close/minimize animations
  const closingWindowIds = useHoverStore((state) => state.closingWindowIds);
  const minimizingWindowIds = useHoverStore((state) => state.minimizingWindowIds);

  // OPTIMIZATION: useDeferredValue allows React to prioritize urgent updates (animations)
  // over rendering window content. This reduces animation blocking during state updates.
  // Note: Animation state (closingWindowIds, minimizingWindowIds) uses immediate values
  // to ensure visibility transitions are not deferred.
  const deferredHoverFiles = useDeferredValue(hoverFiles);
  const isStale = hoverFiles !== deferredHoverFiles;

  // Memoize counts to avoid recalculating on each render
  const { activeCount, cachedCount } = useMemo(() => ({
    activeCount: deferredHoverFiles.filter(w => !w.minimized && !w.cached).length,
    cachedCount: deferredHoverFiles.filter(w => w.cached).length,
  }), [deferredHoverFiles]);

  log(`[HoverEditorLayer] Render: ${deferredHoverFiles.length} total, ${activeCount} active, ${cachedCount} cached, closing: ${closingWindowIds.size}, minimizing: ${minimizingWindowIds.size}, stale: ${isStale} (${(performance.now() - renderStart).toFixed(1)}ms)`);

  // Render ALL windows (including minimized AND cached) but hide them with CSS
  // This keeps the editor instance alive, so restore is INSTANT (no file reload, no TipTap init)
  // CACHED windows are soft-closed windows kept in memory for instant re-open
  // OPTIMIZATION: Use stable style object references to prevent unnecessary re-renders
  // OPTIMIZATION: WarmUpSkeleton renders on mount to pre-prime React component tree
  // OPTIMIZATION: Use deferredHoverFiles for rendering, but immediate animation state for visibility
  return (
    <>
      {/* Warm-up skeleton - primes React component tree on app load */}
      <WarmUpSkeleton />
      {deferredHoverFiles.map(win => {
        // Wrapper div that hides minimized/cached windows without unmounting them
        // Use stable style references (no new object creation)
        // CRITICAL: Keep windows visible during close/minimize animation for smooth transitions
        // Animation state uses immediate values (not deferred) to ensure visibility is always current
        const isAnimating = closingWindowIds.has(win.id) || minimizingWindowIds.has(win.id);
        const wrapperStyle = ((win.minimized || win.cached) && !isAnimating) ? HIDDEN_WRAPPER_STYLE : VISIBLE_WRAPPER_STYLE;

        if (win.type === 'pdf') return <div key={win.id} style={wrapperStyle}><HoverPdfViewer window={win} /></div>;
        if (win.type === 'image') return <div key={win.id} style={wrapperStyle}><HoverImageViewer window={win} /></div>;
        if (win.type === 'document') return <div key={win.id} style={wrapperStyle}><HoverDocumentViewer window={win} /></div>;
        if (win.type === 'code') return <div key={win.id} style={wrapperStyle}><HoverCodeViewer window={win} /></div>;
        if (win.type === 'web') return <div key={win.id} style={wrapperStyle}><HoverWebViewer window={win} /></div>;
        return <div key={win.id} style={wrapperStyle}><HoverEditorWindow window={win} /></div>;
      })}
    </>
  );
});

export default HoverEditorLayer;
