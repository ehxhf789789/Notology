import { useState, useEffect, useRef, useLayoutEffect, useMemo, memo, startTransition } from 'react';
import { CalendarDays, Image, FileText, BookOpen, Globe, FileCode } from 'lucide-react';
import type { HoverWindow } from '../../types';
import {
  useHoverStore,
  hoverActions,
  useClosingWindowIds,
  useMinimizingWindowIds,
  HOVER_ANIMATION,
  useLanguage,
  useNoteTemplates,
  uiActions,
} from '../../stores/zustand';
import { useTodayMemoCount } from './RightPanel';
import { getNoteTypeFromFileName, getTemplateCustomColor } from '../../utils/noteTypeHelpers';
import { t } from '../../utils/i18n';

// File type icon component for collapsed sidebar
function CollapsedFileTypeIcon({ type }: { type: HoverWindow['type'] }) {
  switch (type) {
    case 'pdf': return <BookOpen size={14} />;
    case 'image': return <Image size={14} />;
    case 'code': return <FileCode size={14} />;
    case 'web': return <Globe size={14} />;
    case 'document': return <FileText size={14} />;
    default: return <FileText size={14} />;
  }
}

// Animated window list with exit animations - synchronized with HoverWindow
interface AnimatedWindow {
  id: string;
  isExiting: boolean;
  cachedData?: HoverWindow; // Cache data for exiting items
}

// Animation timing constants (from hoverStore)
const COLLAPSED_BTN_ENTER_DURATION = 180; // CSS: 0.18s
const COLLAPSED_BTN_EXIT_BUFFER = 20;     // Extra buffer for safety

function useAnimatedWindowList(hoverFiles: HoverWindow[]) {
  const [animatedItems, setAnimatedItems] = useState<AnimatedWindow[]>([]);
  const prevDataRef = useRef<Map<string, HoverWindow>>(new Map());
  const exitingTimeoutsRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // Subscribe to closingWindowIds for synchronized exit animation
  const closingWindowIds = useClosingWindowIds();
  const minimizingWindowIds = useMinimizingWindowIds();

  // Handle closingWindowIds changes - start exit animation immediately
  useLayoutEffect(() => {
    const effectStartTime = performance.now();
    if (closingWindowIds.size > 0 || minimizingWindowIds.size > 0) {
      console.log(`%c[CollapsedBtn] useLayoutEffect triggered (closing: ${closingWindowIds.size}, minimizing: ${minimizingWindowIds.size})`, 'color: #00bcd4; font-weight: bold');
    }

    setAnimatedItems(prev => {
      const setCallbackStart = performance.now();
      let updated = [...prev];
      let changed = false;

      // Mark items in closingWindowIds as exiting (SYNCHRONIZED with HoverWindow)
      closingWindowIds.forEach(id => {
        const existingIdx = updated.findIndex(item => item.id === id);
        if (existingIdx >= 0 && !updated[existingIdx].isExiting) {
          const cachedData = prevDataRef.current.get(id) || hoverFiles.find(w => w.id === id);
          console.log(`  [CollapsedBtn ${id.slice(-6)}] EXIT (sync) - animation started (CSS: ${HOVER_ANIMATION.CLOSE_DURATION}ms)`);
          console.log(`    [Timing] Effect start to here: ${(performance.now() - effectStartTime).toFixed(2)}ms`);
          updated[existingIdx] = { ...updated[existingIdx], isExiting: true, cachedData };
          changed = true;

          // Set timeout to remove after animation
          const existingTimeout = exitingTimeoutsRef.current.get(id);
          if (existingTimeout) clearTimeout(existingTimeout);

          const exitTimeout = HOVER_ANIMATION.CLOSE_DURATION + COLLAPSED_BTN_EXIT_BUFFER;
          const timeoutSetAt = performance.now();
          const timeout = setTimeout(() => {
            const actualDelay = performance.now() - timeoutSetAt;
            console.log(`  [CollapsedBtn ${id.slice(-6)}] EXIT (sync) - removed from DOM (expected: ${exitTimeout}ms, actual: ${actualDelay.toFixed(1)}ms)`);
            if (actualDelay > exitTimeout + 20) {
              console.log(`  %c[WARNING] setTimeout delay exceeded by ${(actualDelay - exitTimeout).toFixed(1)}ms!`, 'color: #ff9800');
            }
            setAnimatedItems(items => items.filter(item => item.id !== id));
            exitingTimeoutsRef.current.delete(id);
          }, exitTimeout);
          exitingTimeoutsRef.current.set(id, timeout);
        }
      });

      // Minimize: DON'T remove from animatedItems - icon stays visible
      // Only play a brief visual feedback animation, then keep the button
      minimizingWindowIds.forEach(id => {
        const existingIdx = updated.findIndex(item => item.id === id);
        if (existingIdx >= 0 && !updated[existingIdx].isExiting) {
          console.log(`  [CollapsedBtn ${id.slice(-6)}] MINIMIZE - keeping icon visible (window minimized)`);
          // Don't set isExiting - the icon stays visible
          // The HoverWindow component handles the minimize animation
        }
      });

      if (changed) {
        console.log(`  [CollapsedBtn] setAnimatedItems callback: ${(performance.now() - setCallbackStart).toFixed(2)}ms`);
      }
      return changed ? updated : prev;
    });

    if (closingWindowIds.size > 0 || minimizingWindowIds.size > 0) {
      console.log(`  [CollapsedBtn] useLayoutEffect TOTAL: ${(performance.now() - effectStartTime).toFixed(2)}ms`);
    }
  }, [closingWindowIds, minimizingWindowIds, hoverFiles]);

  // Handle hoverFiles changes - add new items, clean up removed
  // NOTE: Also depends on closingWindowIds/minimizingWindowIds to keep animating items
  useLayoutEffect(() => {
    const effectStartTime = performance.now();
    const currentIds = new Set(hoverFiles.map(w => w.id));
    const prevIds = new Set(prevDataRef.current.keys());

    // Update data cache with current hover files
    const newDataCache = new Map<string, HoverWindow>();
    hoverFiles.forEach(w => newDataCache.set(w.id, w));

    // Find added/reopened items
    const addedIds: string[] = [];
    currentIds.forEach(id => {
      if (!prevIds.has(id)) {
        addedIds.push(id);
      }
    });

    // Skip if no items were added and no items are animating
    const hasAnimating = closingWindowIds.size > 0 || minimizingWindowIds.size > 0;
    if (addedIds.length === 0 && prevDataRef.current.size === hoverFiles.length && !hasAnimating) {
      prevDataRef.current = newDataCache;
      return;
    }

    if (addedIds.length > 0) {
      console.log(`%c[CollapsedBtn] hoverFiles changed - ${addedIds.length} new item(s)`, 'color: #8bc34a; font-weight: bold');
    }

    // Update animated items
    setAnimatedItems(prev => {
      const setCallbackStart = performance.now();
      let updated = [...prev];

      // Handle new/reopened items
      addedIds.forEach(id => {
        const existingIdx = updated.findIndex(item => item.id === id);
        if (existingIdx >= 0 && updated[existingIdx].isExiting) {
          // Item was exiting but reopened - cancel exit
          const existingTimeout = exitingTimeoutsRef.current.get(id);
          if (existingTimeout) {
            clearTimeout(existingTimeout);
            exitingTimeoutsRef.current.delete(id);
          }
          console.log(`  [CollapsedBtn ${id.slice(-6)}] REOPEN - cancelled exit, starting enter (CSS: ${COLLAPSED_BTN_ENTER_DURATION}ms)`);
          updated[existingIdx] = { id, isExiting: false };
        } else if (existingIdx < 0) {
          // New item
          console.log(`  [CollapsedBtn ${id.slice(-6)}] ENTER - animation started (CSS: ${COLLAPSED_BTN_ENTER_DURATION}ms)`);
          updated.push({ id, isExiting: false });
        }
      });

      // Filter out items that are no longer current
      // KEEP: items still in hoverFiles, exiting items, OR items in closingWindowIds/minimizingWindowIds
      // (Option B: items are immediately cached but should stay visible during animation)
      updated = updated.filter(item =>
        currentIds.has(item.id) ||
        item.isExiting ||
        closingWindowIds.has(item.id) ||
        minimizingWindowIds.has(item.id)
      );

      if (addedIds.length > 0) {
        console.log(`  [CollapsedBtn] setAnimatedItems callback: ${(performance.now() - setCallbackStart).toFixed(2)}ms`);
      }
      return updated;
    });

    if (addedIds.length > 0) {
      console.log(`  [CollapsedBtn] hoverFiles effect TOTAL: ${(performance.now() - effectStartTime).toFixed(2)}ms`);
    }

    prevDataRef.current = newDataCache;
  }, [hoverFiles, closingWindowIds, minimizingWindowIds]);

  // Cleanup timeouts on unmount
  useEffect(() => {
    return () => {
      exitingTimeoutsRef.current.forEach(timeout => clearTimeout(timeout));
      exitingTimeoutsRef.current.clear();
    };
  }, []);

  // Combine animated items with actual hover files data or cached data
  const result = animatedItems.map(animItem => {
    const hoverFile = hoverFiles.find(w => w.id === animItem.id) || animItem.cachedData;
    return {
      ...animItem,
      hoverFile,
    };
  }).filter(item => item.hoverFile);

  return result;
}

// Collapsed hover bar - isolated from AppLayout to prevent re-renders on hover state changes
const CollapsedHoverBar = memo(function CollapsedHoverBar() {
  const hoverFiles = useHoverStore((state) => state.hoverFiles);
  const visibleHoverFiles = useMemo(() => hoverFiles.filter(w => !w.cached), [hoverFiles]);
  const animatedHoverWindows = useAnimatedWindowList(visibleHoverFiles);
  const noteTemplates = useNoteTemplates();
  const language = useLanguage();
  // Today's memo/task count for the badge
  const { total: todayMemoCount } = useTodayMemoCount();

  const [windowContextMenu, setWindowContextMenu] = useState<{ x: number; y: number; windowId: string } | null>(null);
  const [windowContextMenuPos, setWindowContextMenuPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const windowContextMenuRef = useRef<HTMLDivElement>(null);

  // Close window context menu on click outside
  useEffect(() => {
    const handleClick = () => setWindowContextMenu(null);
    if (windowContextMenu) {
      window.addEventListener('click', handleClick);
      return () => window.removeEventListener('click', handleClick);
    }
  }, [windowContextMenu]);

  // Adjust window context menu position to stay within viewport
  useLayoutEffect(() => {
    if (!windowContextMenu || !windowContextMenuRef.current) return;
    const rect = windowContextMenuRef.current.getBoundingClientRect();
    const padding = 16;
    let x = windowContextMenu.x;
    let y = windowContextMenu.y;
    if (x + rect.width > window.innerWidth - padding) {
      x = window.innerWidth - rect.width - padding;
    }
    if (x < padding) x = padding;
    const availableHeight = window.innerHeight - y - padding;
    if (availableHeight < rect.height) {
      if (windowContextMenu.y > rect.height + padding) {
        y = windowContextMenu.y - rect.height;
      } else {
        y = padding;
      }
    }
    if (y < padding) y = padding;
    setWindowContextMenuPos({ x, y });
  }, [windowContextMenu]);

  return (
    <div className="hover-panel-collapsed-bar">
      <button
        className="hover-panel-collapsed-toggle"
        onClick={() => uiActions.setShowHoverPanel(true)}
        title={t('calendar', language)}
      >
        <CalendarDays size={18} />
        {todayMemoCount > 0 && (
          <span className="hover-panel-collapsed-badge">{todayMemoCount}</span>
        )}
      </button>
      {/* All windows in collapsed right panel - with iOS-like animations */}
      {animatedHoverWindows.length > 0 && (
        <div className="hover-panel-collapsed-windows">
          {(() => {
            const activeWindows = visibleHoverFiles.filter(w => !w.minimized);
            const focusedWindow = activeWindows.length > 0
              ? activeWindows.reduce((max, win) => win.zIndex > max.zIndex ? win : max, activeWindows[0])
              : null;

            return animatedHoverWindows.map(animItem => {
              const win = animItem.hoverFile || visibleHoverFiles.find(w => w.id === animItem.id);
              if (!win) return null;

              const fileName = win.filePath.split(/[/\\]/).pop()?.replace(/\.md$/, '') || 'Untitled';
              const noteType = win.type === 'editor' ? (win.noteType || getNoteTypeFromFileName(fileName)) : null;
              const typeClass = noteType ? `${noteType}-type` : '';
              const iconClass = noteType ? `icon-${noteType}` : '';
              const customColor = getTemplateCustomColor(noteType, noteTemplates);

              const isFocused = focusedWindow?.id === win.id;
              const stateClass = win.minimized ? 'minimized' : isFocused ? 'focused' : 'active';
              const exitingClass = animItem.isExiting ? 'is-exiting' : '';

              return (
                <button
                  key={win.id}
                  className={`hover-panel-collapsed-window-btn ${stateClass} ${typeClass}${customColor ? ' has-custom-color' : ''} ${exitingClass}`}
                  onClick={() => {
                    if (animItem.isExiting) return;
                    const state = useHoverStore.getState();
                    const currentWindow = state.hoverFiles.find(h => h.id === animItem.id);
                    if (!currentWindow) return;

                    // Determine if this is the focused window (highest zIndex among non-minimized)
                    const activeWins = state.hoverFiles.filter(w => !w.minimized && !w.cached);
                    const topWindow = activeWins.length > 0
                      ? activeWins.reduce((max, w) => w.zIndex > max.zIndex ? w : max, activeWins[0])
                      : null;
                    const isTopFocused = topWindow?.id === currentWindow.id;

                    startTransition(() => {
                      if (currentWindow.minimized) {
                        // Minimized → restore + focus
                        hoverActions.restore(animItem.id);
                      } else if (isTopFocused) {
                        // Active AND focused → minimize
                        hoverActions.minimize(animItem.id);
                      } else {
                        // Active but NOT focused → bring to front
                        hoverActions.focus(animItem.id);
                      }
                    });
                  }}
                  onContextMenu={(e) => {
                    if (animItem.isExiting) return;
                    e.preventDefault();
                    e.stopPropagation();
                    const menuWidth = 120;
                    const menuHeight = 100;
                    let x = e.clientX;
                    let y = e.clientY;
                    if (x + menuWidth > window.innerWidth) {
                      x = window.innerWidth - menuWidth - 10;
                    }
                    if (y + menuHeight > window.innerHeight) {
                      y = window.innerHeight - menuHeight - 10;
                    }
                    setWindowContextMenu({ x, y, windowId: win.id });
                  }}
                  title={`${fileName} (${win.minimized ? t('windowMinimized', language) : isFocused ? t('windowFocused', language) : t('windowActive', language)})`}
                  style={customColor ? { '--template-color': customColor } as React.CSSProperties : undefined}
                >
                  {win.type === 'editor' && noteType ? (
                    <span
                      className={`hover-panel-collapsed-window-icon template-selector-icon ${iconClass}`}
                      style={customColor ? { backgroundColor: customColor } : undefined}
                    />
                  ) : (
                    <span className="hover-panel-collapsed-window-icon lucide-icon">
                      <CollapsedFileTypeIcon type={win.type} />
                    </span>
                  )}
                </button>
              );
            });
          })()}
        </div>
      )}
      {/* Window Context Menu */}
      {windowContextMenu && (() => {
        const win = visibleHoverFiles.find(h => h.id === windowContextMenu.windowId);
        if (!win) return null;
        return (
          <div
            ref={windowContextMenuRef}
            className="window-context-menu"
            style={{ left: windowContextMenuPos.x, top: windowContextMenuPos.y }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="window-context-menu-item"
              onClick={() => {
                const clickStart = performance.now();
                console.log(`[HoverPanel] Context menu focus: ${win.id.slice(-6)}`);
                setWindowContextMenu(null);
                startTransition(() => {
                  hoverActions.focus(win.id);
                  console.log(`[HoverPanel] focusHoverFile done: ${(performance.now() - clickStart).toFixed(1)}ms`);
                });
              }}
            >
              {t('contextFocus', language)}
            </button>
            {win.minimized ? (
              <button
                className="window-context-menu-item"
                onClick={() => {
                  const clickStart = performance.now();
                  console.log(`[HoverPanel] Context menu restore: ${win.id.slice(-6)}`);
                  setWindowContextMenu(null);
                  startTransition(() => {
                    hoverActions.restore(win.id);
                    console.log(`[HoverPanel] restoreHoverFile done: ${(performance.now() - clickStart).toFixed(1)}ms`);
                  });
                }}
              >
                {t('contextRestore', language)}
              </button>
            ) : (
              <button
                className="window-context-menu-item"
                onClick={() => {
                  const clickStart = performance.now();
                  console.log(`[HoverPanel] Context menu minimize: ${win.id.slice(-6)}`);
                  setWindowContextMenu(null);
                  startTransition(() => {
                    hoverActions.minimize(win.id);
                    console.log(`[HoverPanel] minimizeHoverFile done: ${(performance.now() - clickStart).toFixed(1)}ms`);
                  });
                }}
              >
                {t('contextMinimize', language)}
              </button>
            )}
            <button
              className="window-context-menu-item window-context-menu-item-danger"
              onClick={() => {
                const clickStart = performance.now();
                console.log(`[HoverPanel] Context menu close: ${win.id.slice(-6)}`);
                setWindowContextMenu(null);
                startTransition(() => {
                  hoverActions.close(win.id);
                  console.log(`[HoverPanel] closeHoverFile done: ${(performance.now() - clickStart).toFixed(1)}ms`);
                });
              }}
            >
              {t('close', language)}
            </button>
          </div>
        );
      })()}
    </div>
  );
});

export default CollapsedHoverBar;
