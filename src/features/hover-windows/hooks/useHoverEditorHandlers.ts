import { useState, useEffect, useRef, useCallback } from 'react';
import type { Editor } from '@tiptap/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { fileCommands, searchCommands, memoCommands } from '../../../core/services/tauriCommands';
import { isHoverWindow } from '../../../core/utils/multiWindow';
import { hoverActions, HOVER_ANIMATION } from '../stores/hoverStore';
import { refreshActions } from '../../../core/stores/refreshStore';
import type { NoteFrontmatter, CanvasData, HoverWindow } from '../../../core/types';
import { serializeFrontmatter, getCurrentTimestamp } from '../../../core/utils/frontmatter';
import { markAsSelfSaved } from '../../../core/utils/selfSaveTracker';
import { notifyFileSaved, notifySearchIndexUpdated } from '../../../core/utils/windowSync';
import type { ConflictState } from '../../note-editor/useConflictResolution';
import type { NoteLockInfo } from '../../../core/services/tauriCommands';
import { runAnimation, HOVER_WINDOW_OPEN_DURATION } from '../hoverAnimationUtils';

// Conditional logging - only in development
const DEV = import.meta.env.DEV;
const log = DEV ? console.log.bind(console) : () => {};

// ========== ANIMATION HOOK ==========

export interface UseWindowAnimationParams {
  winId: string;
  winCached?: boolean;
  winMinimized?: boolean;
  isClosing: boolean;
  isMinimizing: boolean;
  hoverEditorRef: React.RefObject<HTMLDivElement | null>;
}

export function useWindowAnimation({
  winId,
  winCached,
  winMinimized,
  isClosing,
  isMinimizing,
  hoverEditorRef,
}: UseWindowAnimationParams) {
  const [isOpening, setIsOpening] = useState(true);
  const [isSnapping, setIsSnapping] = useState(false);

  // Track previous states to detect restoration
  const prevCachedRef = useRef(winCached);
  const prevMinimizedRef = useRef(winMinimized);

  // Debug: Log animation state changes
  useEffect(() => {
    log(`[HoverEditor ${winId.slice(-6)}] Animation states: opening=${isOpening}, closing=${isClosing}, minimizing=${isMinimizing}`);
  }, [isOpening, isClosing, isMinimizing, winId]);

  // Detect cache OR minimized restoration and re-trigger opening animation
  useEffect(() => {
    const restoredFromCache = prevCachedRef.current === true && winCached === false;
    const restoredFromMinimized = prevMinimizedRef.current === true && winMinimized === false;

    if (restoredFromCache) {
      log(`[HoverEditor ${winId.slice(-6)}] Restored from CACHE - triggering opening animation`);
      setIsOpening(true);
    } else if (restoredFromMinimized) {
      log(`[HoverEditor ${winId.slice(-6)}] Restored from MINIMIZED - triggering opening animation`);
      // Reset opacity before starting new animation
      if (hoverEditorRef.current) {
        hoverEditorRef.current.style.opacity = '0';
      }
      setIsOpening(true);
    }

    prevCachedRef.current = winCached;
    prevMinimizedRef.current = winMinimized;
  }, [winCached, winMinimized, winId, hoverEditorRef]);

  // Run opening animation using Web Animations API
  useEffect(() => {
    if (isOpening && hoverEditorRef.current) {
      const el = hoverEditorRef.current;
      const startTime = performance.now();
      log(`[HoverWindow ${winId.slice(-6)}] OPEN - Web Animation started`);

      runAnimation(el, 'open', HOVER_WINDOW_OPEN_DURATION).then(() => {
        const elapsed = performance.now() - startTime;
        log(`[HoverWindow ${winId.slice(-6)}] OPEN - animation completed (${elapsed.toFixed(1)}ms)`);
        setIsOpening(false);
      });
    }
  }, [isOpening, winId, hoverEditorRef]);

  // Clear snapping animation after it completes
  useEffect(() => {
    if (isSnapping) {
      const timer = setTimeout(() => setIsSnapping(false), 100); // Match CSS 80ms + buffer
      return () => clearTimeout(timer);
    }
  }, [isSnapping]);

  return { isOpening, isSnapping, setIsSnapping };
}

// ========== DRAG/RESIZE HOOK ==========

export interface UseDragResizeParams {
  win: HoverWindow;
  hoverEditorRef: React.RefObject<HTMLDivElement | null>;
  updateHoverWindow: (id: string, updates: Partial<HoverWindow>) => void;
  focusHoverFile: (id: string) => void;
  setIsSnapping: (v: boolean) => void;
}

export function useDragResize({
  win,
  hoverEditorRef,
  updateHoverWindow,
  focusHoverFile,
  setIsSnapping,
}: UseDragResizeParams) {
  const [isDragging, setIsDragging] = useState(false);
  const [isResizing, setIsResizing] = useState(false);

  const dragStartRef = useRef({ x: 0, y: 0, posX: 0, posY: 0 });
  const resizeStartRef = useRef({ x: 0, y: 0, w: 0, h: 0 });
  const preSnapSizeRef = useRef<{ width: number; height: number } | null>(null);
  const preMaximizeStateRef = useRef<{ position: { x: number; y: number }; size: { width: number; height: number } } | null>(null);

  // Ref to track current position during drag (for DOM manipulation)
  const currentPosRef = useRef({ x: win.position.x, y: win.position.y });
  const currentSizeRef = useRef({ width: win.size.width, height: win.size.height });
  // Track current snap zone - use ref to avoid ANY React re-renders during drag
  const currentSnapZoneRef = useRef<'left' | 'right' | null>(null);
  // Direct DOM ref for snap preview - bypasses React completely
  const snapPreviewRef = useRef<HTMLDivElement | null>(null);

  // Sync refs when win props change (from external updates)
  useEffect(() => {
    if (!isDragging) {
      currentPosRef.current = { x: win.position.x, y: win.position.y };
    }
    if (!isResizing) {
      currentSizeRef.current = { width: win.size.width, height: win.size.height };
    }
  }, [win.position.x, win.position.y, win.size.width, win.size.height, isDragging, isResizing]);

  const handleMouseDown = () => {
    focusHoverFile(win.id);
  };

  // Double-click to toggle maximize
  const handleDoubleClick = useCallback(() => {
    // Multi-window mode: use Tauri's native maximize toggle
    if (isHoverWindow()) {
      getCurrentWindow().toggleMaximize();
      return;
    }

    // DOM overlay mode: manual maximize/restore
    const screenWidth = window.innerWidth;
    const screenHeight = window.innerHeight;

    // Check if currently maximized (fullscreen)
    const isMaximized = win.position.x === 0 && win.position.y === 0 &&
                        win.size.width === screenWidth && win.size.height === screenHeight;

    if (isMaximized) {
      // Restore to previous size/position
      if (preMaximizeStateRef.current) {
        updateHoverWindow(win.id, {
          position: preMaximizeStateRef.current.position,
          size: preMaximizeStateRef.current.size,
        });
        preMaximizeStateRef.current = null;
      } else {
        // If no saved state, restore to default center position
        updateHoverWindow(win.id, {
          position: { x: 350, y: 120 },
          size: { width: 1000, height: 800 },
        });
      }
    } else {
      // Save current state and maximize
      preMaximizeStateRef.current = {
        position: { ...win.position },
        size: { ...win.size },
      };
      updateHoverWindow(win.id, {
        position: { x: 0, y: 0 },
        size: { width: screenWidth, height: screenHeight },
      });
    }
  }, [win.id, win.position, win.size, updateHoverWindow]);

  // Drag
  const handleDragStart = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('.hover-editor-close') ||
        (e.target as HTMLElement).closest('.hover-editor-minimize') ||
        (e.target as HTMLElement).closest('.hover-editor-fm-toggle')) return;
    e.preventDefault();

    // Multi-window mode: use Tauri's native window dragging
    if (isHoverWindow()) {
      getCurrentWindow().startDragging();
      return;
    }

    // DOM overlay mode: track mouse positions manually
    setIsDragging(true);
    dragStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      posX: win.position.x,
      posY: win.position.y,
    };

    // Save size before snap ONLY if not already snapped
    const screenWidth = window.innerWidth;
    const screenHeight = window.innerHeight;
    const isFullscreen = (win.size.width === screenWidth && win.size.height === screenHeight);
    const isHalfWidth = (win.size.width === screenWidth / 2 && win.size.height === screenHeight);

    // If currently snapped and we don't have a saved size, something is wrong - save current size
    // If not snapped, save the current size as the pre-snap size
    if (!isFullscreen && !isHalfWidth) {
      preSnapSizeRef.current = {
        width: win.size.width,
        height: win.size.height,
      };
    }
    // If already snapped, keep the existing preSnapSizeRef (don't overwrite)
  };

  // Resize
  const handleResizeStart = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsResizing(true);
    resizeStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      w: win.size.width,
      h: win.size.height,
    };
  };

  // Drag/resize mousemove+mouseup effect
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

        // Get current window/screen dimensions for boundary checking
        const windowWidth = currentSizeRef.current.width;
        const screenWidth = window.innerWidth;
        const screenHeight = window.innerHeight;

        // Boundary constraints - keep at least 100px visible on screen
        const MIN_VISIBLE = 100;
        const maxX = screenWidth - MIN_VISIBLE;
        const maxY = screenHeight - MIN_VISIBLE;
        const minX = MIN_VISIBLE - windowWidth;
        const minY = 0; // Don't allow dragging above the top edge

        finalX = Math.max(minX, Math.min(maxX, finalX));
        finalY = Math.max(minY, Math.min(maxY, finalY));

        // Update ref (not state)
        currentPosRef.current = { x: finalX, y: finalY };

        // Direct DOM manipulation - no React re-render
        hoverEditorRef.current.style.transform = `translate3d(${finalX}px, ${finalY}px, 0)`;

        // Snap detection - only left/right edges, small threshold (5px)
        const SNAP_THRESHOLD = 5;
        const currentWidth = preSnapSizeRef.current?.width || win.size.width;

        // Only detect left/right snap zones (no top fullscreen)
        let newZone: 'left' | 'right' | null = null;
        if (finalX < SNAP_THRESHOLD) {
          newZone = 'left';
        } else if (finalX + currentWidth > screenWidth - SNAP_THRESHOLD) {
          newZone = 'right';
        }

        // Minimal snap preview - only update if zone changed
        if (newZone !== currentSnapZoneRef.current) {
          currentSnapZoneRef.current = newZone;
          if (!snapPreviewRef.current) {
            snapPreviewRef.current = document.createElement('div');
            document.body.appendChild(snapPreviewRef.current);
          }
          const el = snapPreviewRef.current;
          if (newZone === 'left') {
            el.style.cssText = `position:fixed;left:0;top:0;width:${screenWidth >> 1}px;height:${screenHeight}px;display:block;background:rgba(100,150,255,0.1);border:1px solid rgba(100,150,255,0.4);pointer-events:none;z-index:9999;`;
          } else if (newZone === 'right') {
            el.style.cssText = `position:fixed;left:${screenWidth >> 1}px;top:0;width:${screenWidth >> 1}px;height:${screenHeight}px;display:block;background:rgba(100,150,255,0.1);border:1px solid rgba(100,150,255,0.4);pointer-events:none;z-index:9999;`;
          } else {
            el.style.display = 'none';
          }
        }
      }

      if (isResizing) {
        const dx = e.clientX - resizeStartRef.current.x;
        const dy = e.clientY - resizeStartRef.current.y;
        const newWidth = Math.max(300, resizeStartRef.current.w + dx);
        const newHeight = Math.max(200, resizeStartRef.current.h + dy);

        // Update ref (not state)
        currentSizeRef.current = { width: newWidth, height: newHeight };

        // Direct DOM manipulation - no React re-render
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
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      if (isDragging) {
        const screenWidth = window.innerWidth;
        const screenHeight = window.innerHeight;
        const SNAP_THRESHOLD = 5;

        const finalX = currentPosRef.current.x;
        const currentWidth = preSnapSizeRef.current?.width || win.size.width;
        let snapped = false;

        // Left edge snap only
        if (finalX < SNAP_THRESHOLD) {
          if (!preSnapSizeRef.current) {
            preSnapSizeRef.current = { width: win.size.width, height: win.size.height };
          }
          updateHoverWindow(win.id, {
            position: { x: 0, y: 0 },
            size: { width: screenWidth >> 1, height: screenHeight },
          });
          snapped = true;
        }
        // Right edge snap only
        else if (finalX + currentWidth > screenWidth - SNAP_THRESHOLD) {
          if (!preSnapSizeRef.current) {
            preSnapSizeRef.current = { width: win.size.width, height: win.size.height };
          }
          updateHoverWindow(win.id, {
            position: { x: screenWidth >> 1, y: 0 },
            size: { width: screenWidth >> 1, height: screenHeight },
          });
          snapped = true;
        }

        // If not snapped, commit final position to state
        if (!snapped) {
          preSnapSizeRef.current = null;
          updateHoverWindow(win.id, {
            position: currentPosRef.current,
          });
        } else {
          // Trigger snap animation for smooth size transition
          setIsSnapping(true);
        }

        // Clean up snap preview DOM element (no React state needed)
        if (snapPreviewRef.current) {
          snapPreviewRef.current.remove();
          snapPreviewRef.current = null;
        }
        currentSnapZoneRef.current = null;
      }

      // Commit final size to state after resize
      if (isResizing) {
        updateHoverWindow(win.id, {
          size: currentSizeRef.current,
        });
      }

      setIsDragging(false);
      setIsResizing(false);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
      }
      // Clean up snap preview DOM element on unmount
      if (snapPreviewRef.current) {
        snapPreviewRef.current.remove();
        snapPreviewRef.current = null;
      }
    };
  }, [isDragging, isResizing, win.id, win.size.width, win.size.height, updateHoverWindow, setIsSnapping, hoverEditorRef]);

  return {
    isDragging,
    isResizing,
    handleMouseDown,
    handleDoubleClick,
    handleDragStart,
    handleResizeStart,
  };
}

// ========== CLOSE/MINIMIZE HOOK ==========

export interface UseCloseMinimizeParams {
  win: HoverWindow;
  isDirty: boolean;
  frontmatter: NoteFrontmatter | null;
  body: string;
  editor: Editor | null;
  saveFile: (currentBody?: string) => Promise<void>;
  remoteLock: NoteLockInfo | null;
  conflictState: ConflictState | null;
  vaultPath: string | null;
  hoverEditorRef: React.RefObject<HTMLDivElement | null>;
  saveTimeoutRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>;
  refreshFileTree: () => void;
}

export function useCloseMinimize({
  win,
  isDirty,
  frontmatter,
  body,
  editor,
  saveFile,
  remoteLock,
  conflictState,
  vaultPath,
  hoverEditorRef,
  saveTimeoutRef,
  refreshFileTree,
}: UseCloseMinimizeParams) {
  // Clean broken wiki-links before closing
  const handleClose = useCallback(async () => {
    const closeStartTime = performance.now();

    // Get window reference once
    const currentWin = getCurrentWindow();
    const windowLabel = currentWin.label;
    const urlParams = new URLSearchParams(window.location.search);
    const isHoverFromUrl = urlParams.get('hover') === 'true';
    const isMultiWindow = windowLabel.startsWith('hover-') || isHoverFromUrl;

    log(`[HoverWindow] handleClose() - label: ${windowLabel}, isMultiWindow: ${isMultiWindow}`);

    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = null;
    }

    // Multi-window mode: save, index, then close
    if (isMultiWindow) {
      log('[HoverWindow] Multi-window mode detected, closing...');
      // If conflict UI is showing, auto-save my changes as a copy before closing (prevent data loss)
      if (conflictState && win.filePath && vaultPath) {
        try {
          const timestamp = new Date().toISOString().slice(0, 10);
          const closeParts = win.filePath.split(/[/\\]/);
          const closeSep = win.filePath.includes('\\') ? '\\' : '/';
          const closeBaseName = closeParts.pop()?.replace(/\.md$/, '') || 'note';
          const closeDir = closeParts.join(closeSep);
          const copyPath = `${closeDir}${closeSep}${closeBaseName} (내 변경 ${timestamp}).md`;
          const fmString = serializeFrontmatter({
            ...conflictState.myFrontmatter,
            modified: getCurrentTimestamp(),
          });
          await fileCommands.writeFile(copyPath, fmString, conflictState.myContent);
          markAsSelfSaved(copyPath);
          log(`[HoverWindow] Conflict auto-saved as copy before close: ${copyPath}`);
        } catch (err) {
          console.error('[HoverWindow] Conflict auto-save FAILED on close:', err);
        }
      } else if (isDirty && frontmatter) {
        // Save before closing if dirty
        try {
          // SKETCH: use body state (canvas JSON), not TipTap markdown
          const currentBody = frontmatter.canvas ? body : (editor ? (editor.storage as any).markdown.getMarkdown() : body);
          await saveFile(currentBody);
          // Explicitly wait for indexing to complete BEFORE closing
          // This ensures search index is updated before the window is destroyed
          await searchCommands.indexNote(win.filePath);
          refreshActions.incrementSearchRefresh();
          notifySearchIndexUpdated(win.filePath).catch(() => {});
          log('[HoverWindow] Saved and indexed before close');
        } catch (err) {
          console.error('Save/index before close failed:', err);
        }
      }
      // Close the OS window using destroy() for immediate closing
      log('[HoverWindow] Calling currentWin.destroy()...');
      try {
        await currentWin.destroy();
        log('[HoverWindow] destroy() completed');
      } catch (err) {
        console.error('[HoverWindow] Window destroy failed:', err);
      }
      return;
    }

    // DOM overlay mode: use animations
    const el = hoverEditorRef.current;
    if (el) {
      hoverActions.startClosing(win.id);
      runAnimation(el, 'close', HOVER_ANIMATION.CLOSE_DURATION).then(() => {
        hoverActions.finishClosing(win.id);
        log(`  [HoverWindow ${win.id.slice(-6)}] close animation finished (${(performance.now() - closeStartTime).toFixed(1)}ms total)`);
      });
    } else {
      hoverActions.startClosing(win.id);
      setTimeout(() => hoverActions.finishClosing(win.id), HOVER_ANIMATION.CLOSE_DURATION);
    }

    // If conflict UI is showing, auto-save my changes as a copy (prevent data loss)
    if (conflictState && win.filePath && vaultPath) {
      try {
        const timestamp = new Date().toISOString().slice(0, 10);
        const closeParts = win.filePath.split(/[/\\]/);
        const closeSep = win.filePath.includes('\\') ? '\\' : '/';
        const closeBaseName = closeParts.pop()?.replace(/\.md$/, '') || 'note';
        const closeDir = closeParts.join(closeSep);
        const copyPath = `${closeDir}${closeSep}${closeBaseName} (내 변경 ${timestamp}).md`;
        const fmString = serializeFrontmatter({
          ...conflictState.myFrontmatter,
          modified: getCurrentTimestamp(),
        });
        await fileCommands.writeFile(copyPath, fmString, conflictState.myContent);
        markAsSelfSaved(copyPath);
        refreshFileTree();
        searchCommands.indexNote(copyPath).then(() => {
          refreshActions.incrementSearchRefresh();
          notifySearchIndexUpdated(copyPath).catch(() => {});
        }).catch(() => {});
        log(`[HoverEditor] Conflict auto-saved as copy: ${copyPath}`);
      } catch (err) {
        console.error('[HoverEditor] Conflict auto-save FAILED on close:', err);
      }
      return;
    }

    // Save before closing
    if (isDirty && frontmatter) {
      // SKETCH: use body state (canvas JSON), not TipTap markdown
      const currentBody = frontmatter.canvas ? body : (editor ? (editor.storage as any).markdown.getMarkdown() : body);
      const syncGrace = remoteLock ? new Promise(r => setTimeout(r, 2000)) : Promise.resolve();
      await syncGrace;
      await saveFile(currentBody).catch(err => console.error('Background save failed:', err));
    }
  }, [isDirty, frontmatter, body, editor, saveFile, win.id, win.filePath, remoteLock, conflictState, vaultPath, hoverEditorRef, saveTimeoutRef, refreshFileTree]);

  const handleMinimize = useCallback(async () => {
    const minimizeStartTime = performance.now();
    log(`[HoverWindow ${win.id.slice(-6)}] MINIMIZE BUTTON CLICKED`);

    // Multi-window mode: minimize the OS window directly
    const isMultiWindow = isHoverWindow();

    if (isMultiWindow) {
      // Save before minimizing
      if (isDirty && frontmatter) {
        await saveFile().catch(err => console.error('Background save failed:', err));
      }
      getCurrentWindow().minimize();
      log(`  [HoverWindow] handleMinimize() OS window minimized (${(performance.now() - minimizeStartTime).toFixed(2)}ms)`);
      return;
    }

    // DOM overlay mode: use animations
    const el = hoverEditorRef.current;
    if (el) {
      hoverActions.startMinimizing(win.id);
      runAnimation(el, 'minimize', HOVER_ANIMATION.MINIMIZE_DURATION).then(() => {
        hoverActions.finishMinimizing(win.id);
        log(`  [HoverWindow ${win.id.slice(-6)}] minimize animation finished (${(performance.now() - minimizeStartTime).toFixed(1)}ms total)`);
      });
    } else {
      hoverActions.startMinimizing(win.id);
      setTimeout(() => hoverActions.finishMinimizing(win.id), HOVER_ANIMATION.MINIMIZE_DURATION);
    }

    // If conflict UI is showing, auto-save my changes as a copy (prevent data loss)
    if (conflictState && win.filePath && vaultPath) {
      const timestamp = new Date().toISOString().slice(0, 10);
      const minParts = win.filePath.split(/[/\\]/);
      const minSep = win.filePath.includes('\\') ? '\\' : '/';
      const minBaseName = minParts.pop()?.replace(/\.md$/, '') || 'note';
      const minDir = minParts.join(minSep);
      const copyPath = `${minDir}${minSep}${minBaseName} (내 변경 ${timestamp}).md`;
      const fmString = serializeFrontmatter({
        ...conflictState.myFrontmatter,
        modified: getCurrentTimestamp(),
      });
      fileCommands.writeFile(copyPath, fmString, conflictState.myContent).then(() => {
        refreshFileTree();
        searchCommands.indexNote(copyPath).then(() => {
          refreshActions.incrementSearchRefresh();
          notifySearchIndexUpdated(copyPath).catch(() => {});
        }).catch(() => {});
        log(`[HoverEditor] Conflict auto-saved as copy on minimize: ${copyPath}`);
      }).catch(err => console.error('Conflict auto-save on minimize failed:', err));
    } else if (isDirty && frontmatter) {
      // Save in background (with sync grace period if another device was editing)
      const syncGrace = remoteLock ? new Promise(r => setTimeout(r, 2000)) : Promise.resolve();
      syncGrace.then(() => saveFile()).catch(err => console.error('Background save failed:', err));
    }
    log(`  [HoverWindow] handleMinimize() TOTAL: ${(performance.now() - minimizeStartTime).toFixed(2)}ms`);
  }, [isDirty, frontmatter, saveFile, win.id, win.filePath, remoteLock, conflictState, vaultPath, hoverEditorRef, refreshFileTree]);

  return { handleClose, handleMinimize };
}

// ========== ZOOM HOOK ==========

export interface UseCtrlWheelZoomParams {
  hoverEditorRef: React.RefObject<HTMLDivElement | null>;
  hoverZoomEnabled: boolean;
  hoverZoomLevel: number;
  isCanvas: boolean;
  setHoverZoomLevel: (level: number) => void;
}

export function useCtrlWheelZoom({
  hoverEditorRef,
  hoverZoomEnabled,
  hoverZoomLevel,
  isCanvas,
  setHoverZoomLevel,
}: UseCtrlWheelZoomParams) {
  // Ctrl+Wheel zoom state ref (to access current values in event handler)
  const zoomStateRef = useRef({ enabled: hoverZoomEnabled, level: hoverZoomLevel, isCanvas });
  zoomStateRef.current = { enabled: hoverZoomEnabled, level: hoverZoomLevel, isCanvas };

  // Set up wheel event listener on the whole hover-editor window (using capture phase)
  useEffect(() => {
    const el = hoverEditorRef.current;
    if (!el) return;

    const handleWheel = (e: WheelEvent) => {
      const { enabled, level, isCanvas: isCanvasNote } = zoomStateRef.current;
      // Skip Ctrl+zoom for canvas notes (they have their own zoom via scroll)
      if (!enabled || !e.ctrlKey || isCanvasNote) return;

      // Prevent default browser zoom and TipTap scroll behavior
      e.preventDefault();
      e.stopPropagation();

      // Update zoom level
      const delta = e.deltaY > 0 ? -10 : 10;
      const newLevel = Math.min(200, Math.max(50, level + delta));
      setHoverZoomLevel(newLevel);
    };

    // Use capture phase to catch event before TipTap/ProseMirror
    el.addEventListener('wheel', handleWheel, { passive: false, capture: true });

    return () => {
      el.removeEventListener('wheel', handleWheel, { capture: true });
    };
  }, [hoverEditorRef, setHoverZoomLevel]);
}

// ========== KEYBOARD SHORTCUTS HOOK ==========

export interface UseKeyboardShortcutsParams {
  winFilePath: string;
  vaultPath: string | null;
  setShowComments: React.Dispatch<React.SetStateAction<boolean>>;
  setShowTags: React.Dispatch<React.SetStateAction<boolean>>;
  showConfirmDelete: (name: string, type: 'note' | 'folder', callback: () => Promise<void>) => void;
  deleteNote: (filePath: string) => Promise<void>;
  deleteFolder: (folderPath: string) => Promise<void>;
  refreshFileTree: () => void;
}

export function useKeyboardShortcuts({
  winFilePath,
  vaultPath,
  setShowComments,
  setShowTags,
  showConfirmDelete,
  deleteNote,
  deleteFolder,
  refreshFileTree,
}: UseKeyboardShortcutsParams) {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ctrl+M: Toggle comments/memo panel
      if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'm') {
        e.preventDefault();
        setShowComments(prev => !prev);
        return;
      }

      // Ctrl+Shift+M: Toggle tag panel
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'm') {
        e.preventDefault();
        setShowTags(prev => !prev);
        return;
      }

      // Ctrl+D: Delete note (not for root containers)
      if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        const noteName = winFilePath.split(/[/\\]/).pop()?.replace(/\.md$/, '') || '';

        // Check if this is a folder note (filename matches parent folder name)
        const parts = winFilePath.replace(/\\/g, '/').split('/');
        const fileNameNoExt = (parts[parts.length - 1] || '').replace(/\.md$/, '');
        const parentFolder = parts[parts.length - 2] || '';
        const isFolderNote = fileNameNoExt.toLowerCase() === parentFolder.toLowerCase();

        if (isFolderNote) {
          // Check if this is a root container (parent folder is directly under vault)
          const folderPath = parts.slice(0, -1).join('/');
          const vaultNormalized = vaultPath?.replace(/\\/g, '/') || '';
          const folderDepth = folderPath.split('/').length;
          const vaultDepth = vaultNormalized.split('/').length;
          const isRootContainer = folderDepth === vaultDepth + 1;

          if (isRootContainer) {
            // Don't allow deletion of root containers via Ctrl+D
            return;
          }

          // Delete folder note and folder
          showConfirmDelete(parentFolder, 'folder', async () => {
            try {
              await deleteFolder(folderPath);
              await refreshFileTree();
            } catch (err) {
              console.error('Failed to delete folder:', err);
            }
          });
        } else {
          // Delete just the note
          showConfirmDelete(noteName, 'note', async () => {
            try {
              await deleteNote(winFilePath);
              await refreshFileTree();
            } catch (err) {
              console.error('Failed to delete note:', err);
            }
          });
        }
        return;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [winFilePath, vaultPath, setShowComments, setShowTags, showConfirmDelete, deleteNote, deleteFolder, refreshFileTree]);
}

// ========== FILE DROP HOOK ==========

export interface UseFileDropParams {
  editor: Editor | null;
  isCanvas: boolean;
  saveFile: (currentBody?: string) => Promise<void>;
  saveTimeoutRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>;
  refreshHoverWindowsForFile: (filePath: string) => void;
  winFilePath: string;
  refreshFileTree: () => void;
}

export function useFileDrop({
  editor,
  isCanvas,
  saveFile,
  saveTimeoutRef,
  refreshHoverWindowsForFile,
  winFilePath,
  refreshFileTree,
}: UseFileDropParams) {
  const handleFileDrop = useCallback(async (importedPaths: string[], position?: { x: number; y: number }) => {
    // Skip for canvas notes - they have their own drop handler in CanvasEditor
    if (isCanvas) return;
    if (!editor) return;

    // IMPORTANT: Refresh file tree FIRST so new attachments are found by resolveLink
    // This must complete BEFORE inserting wikiLink nodes
    await refreshFileTree();

    // Build proper HTML structure for list items with wikilinks
    // NOTE: All importedPaths are in _att folder (attachments), so keep full filename with extension
    const listItems = importedPaths.map(path => {
      const fileName = path.split(/[/\\]/).pop() || '';
      return {
        type: 'listItem',
        content: [
          {
            type: 'paragraph',
            content: [
              {
                type: 'wikiLink',
                attrs: { fileName, isAttachmentAttr: true },
              },
            ],
          },
        ],
      };
    });

    // Find "첨부파일" or "Attachments" heading in the document
    const { doc, tr } = editor.state;
    let attachmentHeadingPos: number | null = null;
    let attachmentHeadingEndPos: number | null = null;
    let headingLevel: number = 1;
    let wasCollapsed = false;

    doc.descendants((node, pos) => {
      if (node.type.name === 'heading') {
        const text = node.textContent.trim().toLowerCase();
        if (text === '첨부파일' || text === 'attachments' || text === '# 첨부파일') {
          attachmentHeadingPos = pos;
          attachmentHeadingEndPos = pos + node.nodeSize;
          headingLevel = node.attrs.level || 1;
          wasCollapsed = node.attrs.collapsed || false;
          return false; // Stop searching
        }
      }
      return true;
    });

    let insertPos: number;

    if (attachmentHeadingPos !== null && attachmentHeadingEndPos !== null) {
      // Expand if collapsed
      if (wasCollapsed) {
        editor.chain()
          .focus()
          .command(({ tr }) => {
            tr.setNodeMarkup(attachmentHeadingPos!, undefined, {
              ...doc.nodeAt(attachmentHeadingPos!)?.attrs,
              collapsed: false,
            });
            return true;
          })
          .run();
      }

      // Find the END of the attachment section and check if the LAST element is a bulletList
      // We want to add attachments at the VERY END of the section
      let sectionEndPos: number = attachmentHeadingEndPos;
      let lastNodeType: string | null = null;
      let lastNodePos: number | null = null;
      let lastNodeEndPos: number | null = null;

      doc.nodesBetween(attachmentHeadingEndPos, doc.content.size, (node, pos) => {
        // Stop at next heading of same or higher level (end of attachment section)
        if (node.type.name === 'heading' && node.attrs.level <= headingLevel) {
          return false;
        }
        // Track each top-level node in the section
        const nodeEndPos = pos + node.nodeSize;
        sectionEndPos = nodeEndPos;
        lastNodeType = node.type.name;
        lastNodePos = pos;
        lastNodeEndPos = nodeEndPos;
        return false; // Don't descend
      });

      if (lastNodeType === 'bulletList' && lastNodeEndPos !== null) {
        // The LAST element in the section is a bulletList - append to it
        editor.chain()
          .focus()
          .insertContentAt(lastNodeEndPos - 1, listItems)
          .run();
      } else if (lastNodeType === 'paragraph' && lastNodePos !== null && lastNodeEndPos !== null) {
        // Last element is a paragraph - check if it's empty
        const lastNode = doc.nodeAt(lastNodePos);
        if (lastNode && lastNode.textContent.trim() === '') {
          // Empty paragraph - replace it with bulletList
          const replaceStart = lastNodePos;
          const replaceEnd = lastNodeEndPos;
          editor.chain()
            .focus()
            .command(({ tr, state }) => {
              const bulletListNode = state.schema.nodeFromJSON({
                type: 'bulletList',
                content: listItems,
              });
              tr.replaceWith(replaceStart, replaceEnd, bulletListNode);
              return true;
            })
            .run();
        } else {
          // Non-empty paragraph - insert bulletList right after it (no gap)
          const insertAt = lastNodeEndPos;
          editor.chain()
            .focus()
            .command(({ tr, state }) => {
              const bulletListNode = state.schema.nodeFromJSON({
                type: 'bulletList',
                content: listItems,
              });
              tr.insert(insertAt, bulletListNode);
              return true;
            })
            .run();
        }
      } else {
        // No content or other node type - create new list at the end
        const insertAt = sectionEndPos;
        editor.chain()
          .focus()
          .command(({ tr, state }) => {
            const bulletListNode = state.schema.nodeFromJSON({
              type: 'bulletList',
              content: listItems,
            });
            tr.insert(insertAt, bulletListNode);
            return true;
          })
          .run();
      }
    } else {
      // No attachment section found - create one at the end
      const endPos = doc.content.size;
      editor.chain()
        .focus()
        .insertContentAt(endPos, [
          { type: 'paragraph' }, // Empty line before heading
          {
            type: 'heading',
            attrs: { level: 1 },
            content: [{ type: 'text', text: '첨부파일' }],
          },
          {
            type: 'bulletList',
            content: listItems,
          },
        ])
        .run();
    }

    // Clear any pending save timeout and save immediately
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = null;
    }

    refreshActions.incrementSearchRefresh();

    // Force editor to re-render decorations after React state updates
    // Need a small delay for React to update fileTree state from refreshFileTree()
    setTimeout(() => {
      if (editor && !editor.isDestroyed) {
        editor.view.dispatch(editor.state.tr);
      }
    }, 100);

    // Additional refresh after a longer delay to ensure all links are resolved
    setTimeout(() => {
      if (editor && !editor.isDestroyed) {
        editor.view.dispatch(editor.state.tr);
      }
    }, 500);

    // Manually trigger save to ensure changes are persisted immediately
    // Use the editor's markdown content
    const currentMarkdown = (editor.storage as any).markdown.getMarkdown();
    saveFile(currentMarkdown).then(() => {
      // After save, refresh all other hover windows showing this file
      refreshHoverWindowsForFile(winFilePath);
    });
  }, [editor, isCanvas, saveFile, refreshHoverWindowsForFile, winFilePath, saveTimeoutRef, refreshFileTree]);

  return { handleFileDrop };
}
