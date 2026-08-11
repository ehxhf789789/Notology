/**
 * HoverWindowChrome — Stage 5.0.9b primitive.
 *
 * Owns the entire titlebar + drag + resize + minimize/close + maximize-on-
 * double-click + multi-window-vs-DOM-overlay mode + opening/closing/
 * minimizing animation lifecycle for hover-window viewers.
 *
 * Before 5.0.9b each of HoverImageViewer / HoverCodeViewer / HoverPdfViewer
 * / HoverWebViewer carried ~250 lines of identical chrome boilerplate.
 * This primitive consolidates that into one component; viewers now just
 * supply `title`, an optional `externalAction` for the "open in app"
 * button, and the body content as children.
 *
 * Multi-window mode: when running inside a separate OS hover window
 * (label starts with `hover-` or `?hover=true`), Tauri's native window
 * APIs handle drag / resize / min / close. DOM overlay mode (single
 * window): we drive position/size via React state + transform updates,
 * and animations via Web Animations API.
 */


import { isHoverWindow } from '../../../web/hoverContext';
import {
  useEffect,
  useRef,
  useState,
  useCallback,
  type ReactNode,
} from 'react';
import { getCurrentWindow } from '../../../web/window';
import { Minus, X } from 'lucide-react';
import {
  useHoverStore,
  hoverActions,
  useIsClosing,
  useIsMinimizing,
  HOVER_ANIMATION,
} from '../stores/hoverStore';
import { useLanguage } from '../../../core/stores/zustand';
import { t } from '../../../core/utils/i18n';

import {
  runAnimation,
  HOVER_WINDOW_OPEN_DURATION,
  type HoverEditorWindowProps,
} from '../hoverAnimationUtils';

const DEV = import.meta.env.DEV;
const log = DEV ? console.log.bind(console) : () => {};

export interface HoverWindowChromeProps {
  /** The hover window state — passed straight through from the viewer wrapper. */
  window: HoverEditorWindowProps['window'];
  /** Title text rendered in the chrome header. */
  title: string;
  /** Optional "open externally" action (e.g. open in OS default app).
   *  Rendered just before the minimize button when set. */
  externalAction?: {
    onClick: () => void;
    icon: ReactNode;
    label: string;
  };
  /** Body content. Pass viewer-specific JSX here. */
  children: ReactNode;
  /** Extra className appended to `.hover-editor` root. */
  className?: string;
  /** Extra className appended to the inner body div (replaces the old
   *  `hover-editor-body <viewer>-body` pattern each viewer rolled by hand). */
  bodyClassName?: string;
  /** Debug name shown in DEV log lines. */
  logLabel?: string;
}

export function HoverWindowChrome({
  window: win,
  title,
  externalAction,
  children,
  className,
  bodyClassName,
  logLabel = 'HoverWindowChrome',
}: HoverWindowChromeProps) {
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
  const preMaximizeStateRef = useRef<{
    position: { x: number; y: number };
    size: { width: number; height: number };
  } | null>(null);
  const hoverEditorRef = useRef<HTMLDivElement>(null);
  const currentPosRef = useRef({ x: win.position.x, y: win.position.y });
  const currentSizeRef = useRef({ width: win.size.width, height: win.size.height });
  const prevCachedRef = useRef(win.cached);
  const prevMinimizedRef = useRef(win.minimized);

  // Suppress lint: imports kept for future per-mode dispatch parity. The
  // multi-window branch calls Tauri APIs directly; DOM-overlay branches
  // dispatch through hoverStore actions which this primitive owns.
  void closeHoverFile;
  void focusHoverFile;
  void minimizeHoverFile;
  void isClosing;
  void isMinimizing;

  // Detect cache OR minimized restoration and re-trigger opening animation
  useEffect(() => {
    const restoredFromCache = prevCachedRef.current === true && win.cached === false;
    const restoredFromMinimized = prevMinimizedRef.current === true && win.minimized === false;

    if (restoredFromCache) {
      log(`[${logLabel} ${win.id.slice(-6)}] RESTORE from cache`);
      setIsOpening(true);
    } else if (restoredFromMinimized) {
      log(`[${logLabel} ${win.id.slice(-6)}] RESTORE from minimized`);
      if (hoverEditorRef.current) {
        hoverEditorRef.current.getAnimations().forEach((a) => a.cancel());
      }
      setIsOpening(true);
    }

    prevCachedRef.current = win.cached;
    prevMinimizedRef.current = win.minimized;
  }, [win.cached, win.minimized, win.id, logLabel]);

  // Run opening animation
  useEffect(() => {
    if (isOpening && hoverEditorRef.current) {
      const el = hoverEditorRef.current;
      runAnimation(el, 'open', HOVER_WINDOW_OPEN_DURATION).then(() => {
        setIsOpening(false);
      });
    }
  }, [isOpening, win.id]);

  useEffect(() => {
    if (!isDragging) currentPosRef.current = { x: win.position.x, y: win.position.y };
    if (!isResizing) currentSizeRef.current = { width: win.size.width, height: win.size.height };
  }, [win.position.x, win.position.y, win.size.width, win.size.height, isDragging, isResizing]);

  const handleMouseDown = () => { focusHoverFile(win.id); };

  const handleClose = useCallback(async () => {
    const currentWin = getCurrentWindow();
    const windowLabel = currentWin.label;
    const urlParams = new URLSearchParams(window.location.search);
    const isHoverFromUrl = urlParams.get('hover') === 'true';
    const isMultiWindow = windowLabel.startsWith('hover-') || isHoverFromUrl;

    if (isMultiWindow) {
      try { await currentWin.destroy(); } catch (err) {
        console.error(`[${logLabel}] Window destroy failed:`, err);
      }
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
  }, [win.id, logLabel]);

  const handleMinimize = useCallback(async () => {
    const currentWin = getCurrentWindow();
    const windowLabel = currentWin.label;
    const urlParams = new URLSearchParams(window.location.search);
    const isHoverFromUrl = urlParams.get('hover') === 'true';
    const isMultiWindow = windowLabel.startsWith('hover-') || isHoverFromUrl;

    if (isMultiWindow) {
      try { await currentWin.minimize(); } catch (err) {
        console.error(`[${logLabel}] Window minimize failed:`, err);
      }
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
  }, [win.id, logLabel]);

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
      updateHoverWindow(win.id, {
        position: preMaximizeStateRef.current.position,
        size: preMaximizeStateRef.current.size,
      });
      preMaximizeStateRef.current = null;
    } else if (isMaximized) {
      updateHoverWindow(win.id, { position: { x: 350, y: 120 }, size: { width: 1000, height: 800 } });
    } else {
      preMaximizeStateRef.current = { position: { ...win.position }, size: { ...win.size } };
      updateHoverWindow(win.id, { position: { x: 0, y: 0 }, size: { width: screenWidth, height: screenHeight } });
    }
  }, [win.id, win.position, win.size, updateHoverWindow]);

  const handleDragStart = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('.hover-editor-close, .hover-editor-minimize, .hover-editor-open-external')) return;
    e.preventDefault();
    if (isHoverWindow()) {
      getCurrentWindow().startDragging();
      return;
    }
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
      if (rafId === null) rafId = requestAnimationFrame(processMouseMove);
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

  const inMultiWindowMode = isHoverWindow();

  const rootCls = `hover-editor${isDragging ? ' is-dragging' : ''}${isResizing ? ' is-resizing' : ''}${className ? ' ' + className : ''}`;

  return (
    <div
      ref={hoverEditorRef}
      className={rootCls}
      style={
        inMultiWindowMode
          ? {
              position: 'relative',
              width: '100%',
              height: '100%',
              transform: 'none',
              border: 'none',
              borderRadius: 0,
              boxShadow: 'none',
            }
          : {
              transform: `translate3d(${win.position.x}px, ${win.position.y}px, 0)`,
              width: win.size.width,
              height: win.size.height,
              zIndex: win.zIndex,
            }
      }
      onMouseDown={handleMouseDown}
    >
      <div className="hover-editor-header" onMouseDown={handleDragStart} onDoubleClick={handleDoubleClick}>
        <span className="hover-editor-title">{title}</span>
        <div className="hover-editor-header-actions">
          {externalAction && (
            <button
              className="hover-editor-open-external"
              onClick={externalAction.onClick}
              onMouseDown={(e) => e.stopPropagation()}
              title={externalAction.label}
              aria-label={externalAction.label}
            >
              {externalAction.icon}
            </button>
          )}
          <button
            className="hover-editor-minimize"
            onClick={handleMinimize}
            onMouseDown={(e) => e.stopPropagation()}
            title={t('minimize', language)}
            aria-label={t('minimize', language)}
          >
            <Minus size={14} />
          </button>
          <button
            className="hover-editor-close"
            onClick={handleClose}
            onMouseDown={(e) => e.stopPropagation()}
            title={t('close', language)}
            aria-label={t('close', language)}
          >
            <X size={14} />
          </button>
        </div>
      </div>
      <div className={`hover-editor-body${bodyClassName ? ' ' + bodyClassName : ''}`}>
        {children}
      </div>
      {!inMultiWindowMode && (
        <div className="hover-editor-resize" onMouseDown={handleResizeStart} />
      )}
    </div>
  );
}
