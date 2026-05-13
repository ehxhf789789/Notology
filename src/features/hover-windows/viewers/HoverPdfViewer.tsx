import { useState, useEffect, useRef, useCallback, memo } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Minus, X, ExternalLink } from 'lucide-react';
import { utilCommands } from '../../../core/services/tauriCommands';
import { useHoverStore, hoverActions, useIsClosing, useIsMinimizing, HOVER_ANIMATION } from '../stores/hoverStore';
import { useLanguage } from '../../../core/stores/zustand';
import { t } from '../../../core/utils/i18n';
import { isHoverWindow } from '../../../core/utils/multiWindow';
import { runAnimation, HOVER_WINDOW_OPEN_DURATION, hoverWindowPropsAreEqual, type HoverEditorWindowProps } from '../hoverAnimationUtils';

// Conditional logging - only in development
const DEV = import.meta.env.DEV;
const log = DEV ? console.log.bind(console) : () => {};

// PDF Viewer Window
const HoverPdfViewer = memo(function HoverPdfViewer({ window: win }: HoverEditorWindowProps) {
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

  // Detect cache OR minimized restoration and re-trigger opening animation
  useEffect(() => {
    const restoredFromCache = prevCachedRef.current === true && win.cached === false;
    const restoredFromMinimized = prevMinimizedRef.current === true && win.minimized === false;

    if (restoredFromCache) {
      log(`[HoverWindow ${win.id.slice(-6)}] RESTORE from cache - triggering opening animation`);
      setIsOpening(true);
    } else if (restoredFromMinimized) {
      log(`[HoverWindow ${win.id.slice(-6)}] RESTORE from minimized - clearing animation styles`);
      if (hoverEditorRef.current) {
        hoverEditorRef.current.getAnimations().forEach(a => a.cancel());
      }
      setIsOpening(true);
    }

    prevCachedRef.current = win.cached;
    prevMinimizedRef.current = win.minimized;
  }, [win.cached, win.minimized, win.id]);

  // Run opening animation using Web Animations API
  useEffect(() => {
    if (isOpening && hoverEditorRef.current) {
      const el = hoverEditorRef.current;
      const startTime = performance.now();
      log(`[Viewer ${win.id.slice(-6)}] OPEN - Web Animation started`);

      runAnimation(el, 'open', HOVER_WINDOW_OPEN_DURATION).then(() => {
        log(`[Viewer ${win.id.slice(-6)}] OPEN - completed (${(performance.now() - startTime).toFixed(1)}ms)`);
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
    // Get window reference and check multi-window mode
    const currentWin = getCurrentWindow();
    const windowLabel = currentWin.label;
    const urlParams = new URLSearchParams(window.location.search);
    const isHoverFromUrl = urlParams.get('hover') === 'true';
    const isMultiWindow = windowLabel.startsWith('hover-') || isHoverFromUrl;

    console.log(`%c[Viewer] handleClose() - label: ${windowLabel}, isMultiWindow: ${isMultiWindow}`, 'color: #e91e63; font-weight: bold');

    // Multi-window mode: close the OS window directly using destroy()
    if (isMultiWindow) {
      try {
        await currentWin.destroy();
      } catch (err) {
        console.error('[Viewer] Window destroy failed:', err);
      }
      return;
    }

    // DOM overlay mode: use animations
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
    // Get window reference and check multi-window mode
    const currentWin = getCurrentWindow();
    const windowLabel = currentWin.label;
    const urlParams = new URLSearchParams(window.location.search);
    const isHoverFromUrl = urlParams.get('hover') === 'true';
    const isMultiWindow = windowLabel.startsWith('hover-') || isHoverFromUrl;

    // Multi-window mode: minimize the OS window directly
    if (isMultiWindow) {
      try {
        await currentWin.minimize();
      } catch (err) {
        console.error('[Viewer] Window minimize failed:', err);
      }
      return;
    }

    // DOM overlay mode: use animations
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
    // Multi-window mode: use Tauri's native maximize toggle
    if (isHoverWindow()) {
      getCurrentWindow().toggleMaximize();
      return;
    }

    // DOM overlay mode: manual maximize/restore
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

    // Multi-window mode: use Tauri's native window dragging
    if (isHoverWindow()) {
      getCurrentWindow().startDragging();
      return;
    }

    // DOM overlay mode: track mouse positions manually
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

        // Boundary constraints
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
      if (rafId === null) {
        rafId = requestAnimationFrame(processMouseMove);
      }
    };

    const handleMouseUp = () => {
      if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
      if (isDragging) {
        const finalX = currentPosRef.current.x;
        const screenWidth = window.innerWidth;
        const screenHeight = window.innerHeight;
        // Small snap threshold (5px), left/right only
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
  // Detect multi-window mode (separate OS window vs DOM overlay)
  const inMultiWindowMode = isHoverWindow();

  return (
    <div
      ref={hoverEditorRef}
      className={`hover-editor${isDragging ? ' is-dragging' : ''}${isResizing ? ' is-resizing' : ''}`}
      style={{
        // Multi-window mode: fill the entire viewport
        // DOM overlay mode: use fixed positioning with transform
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
      <div className="hover-editor-body pdf-viewer-body" style={{ flex: 1, overflow: 'hidden' }}>
        {/* HanBin 2026-05-13 round 5: forced back to `#toolbar=0` after
            confirming that the `beforeunload` navguard does NOT prevent
            the chrome://settings navigation that the toolbar's ⋮ menu
            triggers. Tauri's webview has no confirm-dialog UI, so the
            browser proceeds with navigation regardless of the JS guard.
            Sandboxing the iframe doesn't work either (breaks rendering),
            and Tauri builder-level navigation hooks are per-window and
            can't attach to a config-created window.
            The proper fix is either (a) migrate to bundled PDF.js so we
            own the toolbar end-to-end, or (b) recreate the main window
            via WebviewWindowBuilder in setup() so we can attach
            on_navigation. Until then, hide the toolbar — page nav GUI
            is lost but the crash is unreachable. Zoom: Ctrl + wheel.
            Full PDF control: hover-window header → "Open in default app". */}
        <iframe
          src={`${convertFileSrc(win.filePath)}#toolbar=0&navpanes=0&statusbar=0`}
          referrerPolicy="no-referrer"
          style={{ width: '100%', height: '100%', border: 'none' }}
          title={fileName}
        />
      </div>
      {!inMultiWindowMode && <div className="hover-editor-resize" onMouseDown={handleResizeStart} />}
    </div>
  );
}, hoverWindowPropsAreEqual);

export default HoverPdfViewer;
