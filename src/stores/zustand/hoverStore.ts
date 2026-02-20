import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import { useShallow } from 'zustand/react/shallow';
import type { HoverWindow, SnapPreview } from '../../types';
import { contentCacheActions } from './contentCacheStore';
import { utilCommands } from '../../services/tauriCommands';

// Legacy binary formats that should open directly with external app (no internal viewer)
const LEGACY_DIRECT_OPEN_EXTENSIONS = ['doc', 'ppt', 'xls', 'hwp'];

// Conditional logging - only in development
const DEV = import.meta.env.DEV;
const log = DEV ? console.log.bind(console) : () => {};

// Performance tracking for bottleneck analysis
let globalAnimationStartTime: number | null = null;
const animationTimings = new Map<string, { startClosing?: number; finishClosing?: number; startMinimizing?: number; finishMinimizing?: number }>();

function logBottleneck(tag: string, id: string, message: string, startTime?: number) {
  if (!DEV) return;
  const now = performance.now();
  const elapsed = startTime ? `${(now - startTime).toFixed(1)}ms` : '';
  const globalElapsed = globalAnimationStartTime ? `(global: ${(now - globalAnimationStartTime).toFixed(1)}ms)` : '';
  console.log(`%c[${tag}] ${id.slice(-6)} ${message} ${elapsed} ${globalElapsed}`, 'color: #ff9800; font-weight: bold');
}

let nextHoverZ = 1001;

// Cache configuration
const CACHE_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes - cached windows older than this are destroyed
const CACHE_MAX_COUNT = 10; // Maximum number of cached windows to keep

/** Detect file type for hover windows */
function detectFileType(path: string): HoverWindow['type'] {
  if (/^https?:\/\//i.test(path)) return 'web';
  if (/\.pdf$/i.test(path)) return 'pdf';
  if (/\.(png|jpg|jpeg|gif|webp|svg|bmp|ico)$/i.test(path)) return 'image';
  if (/\.(doc|docx|ppt|pptx|xls|xlsx|hwp|hwpx)$/i.test(path)) return 'document';
  if (/\.(json|py|js|ts|jsx|tsx|css|html|xml|yaml|yml|toml|rs|go|java|c|cpp|h|hpp|cs|rb|php|sh|bash|zsh|sql|lua|r|swift|kt|scala|zig|vue|svelte|astro|ini|conf|cfg|env|gitignore|dockerfile|makefile)$/i.test(path)) return 'code';
  return 'editor';
}

function generateHoverId(): string {
  return `hover_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
}

// Animation timing constants (shared with HoverEditor and App.tsx)
export const HOVER_ANIMATION = {
  CLOSE_DURATION: 150,   // CSS: 0.15s
  MINIMIZE_DURATION: 150, // CSS: 0.15s
} as const;

interface HoverState {
  // State
  hoverFiles: HoverWindow[];
  snapPreview: SnapPreview | null;
  closingWindowIds: Set<string>;    // Shared animation state for synchronized close
  minimizingWindowIds: Set<string>; // Shared animation state for synchronized minimize

  // Default sizes (synced from settings)
  defaultWidth: number;
  defaultHeight: number;

  // Actions
  openHoverFile: (path: string) => void;
  closeHoverFile: (id: string) => void;
  focusHoverFile: (id: string) => void;
  minimizeHoverFile: (id: string) => void;
  restoreHoverFile: (id: string) => void;
  updateHoverWindow: (id: string, updates: Partial<HoverWindow>) => void;
  setSnapPreview: (preview: SnapPreview | null) => void;
  refreshHoverWindowsForFile: (filePath: string) => void;
  refreshHoverWindowsForFiles: (filePaths: string[]) => void;
  setDefaultSize: (width: number, height: number) => void;

  // Synchronized animation actions (for HoverWindow + CollapsedBtn sync)
  startClosing: (id: string) => void;   // Start close animation on both
  finishClosing: (id: string) => void;  // Complete close (cache window)
  startMinimizing: (id: string) => void;
  finishMinimizing: (id: string) => void;

  // Bulk operations (for vault switching, file operations)
  clearAll: () => void;
  closeByFilePath: (filePath: string) => void;
  updateFilePath: (oldPath: string, newPath: string) => void;
  refreshAll: () => void;
  updateFilePathAndRefreshAll: (oldPath: string, newPath: string) => void;

  // Selectors (for optimized subscriptions)
  getWindow: (id: string) => HoverWindow | undefined;
  getActiveWindows: () => HoverWindow[];
  getMinimizedWindows: () => HoverWindow[];
}

export const useHoverStore = create<HoverState>()(
  subscribeWithSelector((set, get) => ({
    // Initial state
    hoverFiles: [],
    snapPreview: null,
    closingWindowIds: new Set<string>(),
    minimizingWindowIds: new Set<string>(),
    defaultWidth: 1000,
    defaultHeight: 800,

    // Open hover file (or bring existing to front, or restore from cache)
    openHoverFile: (path: string) => {
      const openStart = performance.now();
      log(`[HoverStore] openHoverFile START: ${path}`);

      // Legacy formats (doc, ppt, xls, hwp) - open directly with external app, no viewer window
      const ext = path.toLowerCase().split('.').pop() || '';
      if (LEGACY_DIRECT_OPEN_EXTENSIONS.includes(ext)) {
        log(`[HoverStore] Legacy format detected (${ext}), opening with external app: ${path}`);
        utilCommands.openInDefaultApp(path);
        return; // Don't create hover window
      }

      // Check if we have a cached window - if so, skip preload (content is already loaded)
      const state = get();
      const hasCachedWindow = state.hoverFiles.some(h => h.filePath === path && h.cached);
      const hasContentCached = contentCacheActions.hasContent(path);

      // Only preload if content is not already cached and no cached window exists
      if (path.endsWith('.md') && !hasCachedWindow && !hasContentCached) {
        log(`[HoverStore] Preload started: ${(performance.now() - openStart).toFixed(1)}ms`);
        contentCacheActions.preloadContent(path);
        log(`[HoverStore] Preload queued: ${(performance.now() - openStart).toFixed(1)}ms`);
      } else if (hasCachedWindow || hasContentCached) {
        log(`[HoverStore] Preload SKIPPED (already cached): ${(performance.now() - openStart).toFixed(1)}ms`);
      }

      set((state) => {
        log(`[HoverStore] set() callback START: ${(performance.now() - openStart).toFixed(1)}ms`);

        // If already open (not cached), bring to front
        const existing = state.hoverFiles.find(h => h.filePath === path && !h.cached);
        if (existing) {
          nextHoverZ++;
          // Re-detect type to handle upgrades (e.g., previously 'editor' now 'document')
          const correctType = detectFileType(path);
          log(`[HoverStore] Reusing existing window (type: ${existing.type}→${correctType}): ${(performance.now() - openStart).toFixed(1)}ms`);
          if (existing.minimized) {
            log(`%c[STATE] Window ${existing.id.slice(-6)} RESTORED via openHoverFile (was minimized: true -> false)`, 'color: #ff9800; font-weight: bold');
          }
          // If type changed, destroy old window and create new one instead of reusing
          if (existing.type !== correctType) {
            log(`[HoverStore] Type mismatch! Replacing window ${existing.id.slice(-6)} (${existing.type}→${correctType})`);
            const filtered = state.hoverFiles.filter(h => h.id !== existing.id);
            const newWindow: HoverWindow = {
              id: generateHoverId(),
              filePath: path,
              type: correctType,
              position: { ...existing.position },
              size: { ...existing.size },
              zIndex: nextHoverZ,
            };
            return { hoverFiles: [...filtered, newWindow] };
          }
          return {
            hoverFiles: state.hoverFiles.map(h =>
              h.id === existing.id ? { ...h, zIndex: nextHoverZ, minimized: false } : h
            ),
          };
        }

        // Check for cached window with same file path - INSTANT RESTORE
        const cached = state.hoverFiles.find(h => h.filePath === path && h.cached);
        if (cached) {
          nextHoverZ++;
          // Re-detect type in case code was updated (e.g., new document extensions added)
          const correctType = detectFileType(path);
          log(`[HoverStore] CACHE HIT! Restoring from cache (type: ${cached.type}→${correctType}): ${(performance.now() - openStart).toFixed(1)}ms`);
          return {
            hoverFiles: state.hoverFiles.map(h =>
              h.id === cached.id
                ? { ...h, type: correctType, cached: false, cachedAt: undefined, zIndex: nextHoverZ, minimized: false }
                : h
            ),
          };
        }

        // No cache hit - create new window
        log(`[HoverStore] CACHE MISS - creating new window: ${(performance.now() - openStart).toFixed(1)}ms`);

        // Offset from the most recently focused visible window (cascade diagonally)
        nextHoverZ++;
        const visibleWindows = state.hoverFiles.filter(h => !h.cached && !h.minimized);
        let baseX = 350;
        let baseY = 120;
        if (visibleWindows.length > 0) {
          const topWindow = visibleWindows.reduce((a, b) => a.zIndex > b.zIndex ? a : b);
          baseX = topWindow.position.x + 30;
          baseY = topWindow.position.y + 30;
        }
        // Clamp to viewport so the window stays visible
        const maxX = Math.max(200, window.innerWidth - state.defaultWidth - 20);
        const maxY = Math.max(80, window.innerHeight - 100);
        if (baseX > maxX) baseX = 350;
        if (baseY > maxY) baseY = 120;

        // Determine file type
        const fileType = detectFileType(path);

        const newWindow: HoverWindow = {
          id: generateHoverId(),
          filePath: path,
          type: fileType,
          position: { x: baseX, y: baseY },
          size: { width: state.defaultWidth, height: state.defaultHeight },
          zIndex: nextHoverZ,
        };

        // Cleanup old cached windows (keep only CACHE_MAX_COUNT most recent)
        const cachedWindows = state.hoverFiles.filter(h => h.cached);
        const now = Date.now();
        const windowsToRemove = cachedWindows
          .filter(h => (now - (h.cachedAt || 0)) > CACHE_MAX_AGE_MS) // Remove old ones
          .map(h => h.id);

        // Also enforce max count
        if (cachedWindows.length > CACHE_MAX_COUNT) {
          const sortedByAge = [...cachedWindows].sort((a, b) => (a.cachedAt || 0) - (b.cachedAt || 0));
          const excess = sortedByAge.slice(0, cachedWindows.length - CACHE_MAX_COUNT);
          excess.forEach(h => windowsToRemove.push(h.id));
        }

        const cleanedHoverFiles = state.hoverFiles.filter(h => !windowsToRemove.includes(h.id));

        return { hoverFiles: [...cleanedHoverFiles, newWindow] };
      });
    },

    // Close hover file - SOFT CLOSE: Move to cache instead of destroying
    closeHoverFile: (id: string) => {
      const closeStart = performance.now();
      log(`[HoverStore] closeHoverFile START (soft-close to cache): ${id}`);

      set((state) => {
        log(`[HoverStore] closeHoverFile set() callback: ${(performance.now() - closeStart).toFixed(1)}ms`);

        // Move to cache instead of removing
        const result = {
          hoverFiles: state.hoverFiles.map(h =>
            h.id === id
              ? { ...h, cached: true, cachedAt: Date.now(), minimized: false }
              : h
          ),
        };

        log(`[HoverStore] closeHoverFile soft-close complete: ${(performance.now() - closeStart).toFixed(1)}ms`);
        return result;
      });

      log(`[HoverStore] closeHoverFile DONE (window cached for reuse): ${(performance.now() - closeStart).toFixed(1)}ms`);
    },

    // Focus (bring to front) - OPTIMIZED: Skip update for cached/already-focused windows
    focusHoverFile: (id: string) => {
      const state = get();
      const win = state.hoverFiles.find(h => h.id === id);

      // Skip if window doesn't exist, is cached, or is already at highest z-index
      if (!win || win.cached) {
        return; // No-op for cached windows (invisible, can't be focused)
      }

      // Check if already at highest z-index (no update needed)
      const maxZ = Math.max(...state.hoverFiles.filter(h => !h.cached).map(h => h.zIndex));
      if (win.zIndex === maxZ && win.zIndex === nextHoverZ) {
        return; // Already focused, skip update
      }

      const focusStart = performance.now();
      nextHoverZ++;
      set((state) => ({
        hoverFiles: state.hoverFiles.map(h =>
          h.id === id ? { ...h, zIndex: nextHoverZ } : h
        ),
      }));
      log(`[HoverStore] focusHoverFile: ${(performance.now() - focusStart).toFixed(1)}ms`);
    },

    // Minimize
    minimizeHoverFile: (id: string) => {
      const minStart = performance.now();
      set((state) => ({
        hoverFiles: state.hoverFiles.map(h =>
          h.id === id ? { ...h, minimized: true } : h
        ),
      }));
      log(`[HoverStore] minimizeHoverFile: ${(performance.now() - minStart).toFixed(1)}ms`);
    },

    // Restore from minimized
    restoreHoverFile: (id: string) => {
      const restoreStart = performance.now();
      nextHoverZ++;
      set((state) => ({
        hoverFiles: state.hoverFiles.map(h =>
          h.id === id ? { ...h, minimized: false, zIndex: nextHoverZ } : h
        ),
      }));
      log(`[HoverStore] restoreHoverFile: ${(performance.now() - restoreStart).toFixed(1)}ms`);
    },

    // ========== SYNCHRONIZED ANIMATION ACTIONS (Option B: Immediate Cache) ==========
    // These allow HoverWindow and CollapsedBtn to animate simultaneously
    // Key optimization: State changes happen IMMEDIATELY, no waiting for setTimeout

    // Start close animation - IMMEDIATELY cache + add to closingWindowIds (single state update)
    // The window stays visible during animation because HoverEditorLayer renders closingWindowIds
    startClosing: (id: string) => {
      const startTime = performance.now();
      globalAnimationStartTime = startTime;
      animationTimings.set(id, { startClosing: startTime });

      log('%c════════════════════════════════════════════════════════════════', 'color: #f44336');
      log(`%c[BOTTLENECK] ${id.slice(-6)} ▶ CLOSE START (immediate cache)`, 'color: #f44336; font-weight: bold; font-size: 14px');
      log('%c════════════════════════════════════════════════════════════════', 'color: #f44336');

      const preSetTime = performance.now();
      set((state) => {
        const setCallbackStart = performance.now();
        const newClosingIds = new Set(state.closingWindowIds);
        newClosingIds.add(id);
        // IMMEDIATE CACHE: Cache window NOW, but it stays visible via closingWindowIds
        const result = {
          closingWindowIds: newClosingIds,
          hoverFiles: state.hoverFiles.map(h =>
            h.id === id
              ? { ...h, cached: true, cachedAt: Date.now(), minimized: false }
              : h
          ),
        };
        log(`  [Store] set() (cache + closingIds): ${(performance.now() - setCallbackStart).toFixed(2)}ms`);
        return result;
      });
      const postSetTime = performance.now();

      log(`  [Store] startClosing TOTAL: ${(postSetTime - startTime).toFixed(2)}ms`);
      log(`  [Expected] Window cached immediately, CSS animation playing`);
    },

    // Finish close animation - just remove from closingWindowIds (window already cached)
    finishClosing: (id: string) => {
      const startTime = performance.now();
      const timings = animationTimings.get(id);
      const animationDuration = timings?.startClosing ? startTime - timings.startClosing : 0;

      log('%c────────────────────────────────────────────────────────────────', 'color: #4caf50');
      log(`%c[BOTTLENECK] ${id.slice(-6)} ■ CLOSE FINISH (remove from render)`, 'color: #4caf50; font-weight: bold; font-size: 14px');
      log(`  [Animation] Duration: ${animationDuration.toFixed(1)}ms (expected: ${HOVER_ANIMATION.CLOSE_DURATION}ms)`);

      const preSetTime = performance.now();
      set((state) => {
        const newClosingIds = new Set(state.closingWindowIds);
        newClosingIds.delete(id);
        // Window already cached in startClosing - just remove from closingWindowIds
        return { closingWindowIds: newClosingIds };
      });
      const postSetTime = performance.now();

      log(`  [Store] finishClosing TOTAL: ${(postSetTime - startTime).toFixed(2)}ms`);
      log('%c────────────────────────────────────────────────────────────────', 'color: #4caf50');

      animationTimings.delete(id);
      globalAnimationStartTime = null;
    },

    // Start minimize animation - IMMEDIATELY set minimized + add to minimizingWindowIds
    startMinimizing: (id: string) => {
      const startTime = performance.now();
      globalAnimationStartTime = startTime;
      animationTimings.set(id, { startMinimizing: startTime });

      log('%c════════════════════════════════════════════════════════════════', 'color: #2196f3');
      log(`%c[BOTTLENECK] ${id.slice(-6)} ▶ MINIMIZE START (immediate state)`, 'color: #2196f3; font-weight: bold; font-size: 14px');
      log('%c════════════════════════════════════════════════════════════════', 'color: #2196f3');

      const preSetTime = performance.now();
      set((state) => {
        const setCallbackStart = performance.now();
        const newMinimizingIds = new Set(state.minimizingWindowIds);
        newMinimizingIds.add(id);
        // IMMEDIATE STATE: Set minimized NOW, but it stays visible via minimizingWindowIds
        const result = {
          minimizingWindowIds: newMinimizingIds,
          hoverFiles: state.hoverFiles.map(h =>
            h.id === id ? { ...h, minimized: true } : h
          ),
        };
        log(`  [Store] set() (minimize + minimizingIds): ${(performance.now() - setCallbackStart).toFixed(2)}ms`);
        log(`  %c[STATE] Window ${id.slice(-6)} minimized: true`, 'color: #9c27b0; font-weight: bold');
        return result;
      });
      const postSetTime = performance.now();

      log(`  [Store] startMinimizing TOTAL: ${(postSetTime - startTime).toFixed(2)}ms`);
    },

    // Finish minimize animation - just remove from minimizingWindowIds
    finishMinimizing: (id: string) => {
      const startTime = performance.now();
      const timings = animationTimings.get(id);
      const animationDuration = timings?.startMinimizing ? startTime - timings.startMinimizing : 0;

      log('%c────────────────────────────────────────────────────────────────', 'color: #4caf50');
      log(`%c[BOTTLENECK] ${id.slice(-6)} ■ MINIMIZE FINISH (remove from render)`, 'color: #4caf50; font-weight: bold; font-size: 14px');
      log(`  [Animation] Duration: ${animationDuration.toFixed(1)}ms (expected: ${HOVER_ANIMATION.MINIMIZE_DURATION}ms)`);

      const preSetTime = performance.now();
      set((state) => {
        const newMinimizingIds = new Set(state.minimizingWindowIds);
        newMinimizingIds.delete(id);
        // Window already minimized in startMinimizing - just remove from minimizingWindowIds
        return { minimizingWindowIds: newMinimizingIds };
      });
      const postSetTime = performance.now();

      log(`  [Store] finishMinimizing TOTAL: ${(postSetTime - startTime).toFixed(2)}ms`);
      log('%c────────────────────────────────────────────────────────────────', 'color: #4caf50');

      animationTimings.delete(id);
      globalAnimationStartTime = null;
    },

    // Update window (position, size, etc.)
    updateHoverWindow: (id: string, updates: Partial<HoverWindow>) => {
      set((state) => ({
        hoverFiles: state.hoverFiles.map(h =>
          h.id === id ? { ...h, ...updates } : h
        ),
      }));
    },

    // Snap preview during drag
    setSnapPreview: (preview: SnapPreview | null) => {
      set({ snapPreview: preview });
    },

    // Refresh content for a specific file (invalidates cache first for fresh load)
    refreshHoverWindowsForFile: (filePath: string) => {
      // Invalidate cache to ensure fresh content on reload
      contentCacheActions.invalidateContent(filePath);
      set((state) => ({
        hoverFiles: state.hoverFiles.map(h =>
          h.filePath === filePath
            ? { ...h, contentReloadTrigger: (h.contentReloadTrigger || 0) + 1 }
            : h
        ),
      }));
    },

    // Batch refresh for multiple files (single set() call — efficient for bulk sync)
    refreshHoverWindowsForFiles: (filePaths: string[]) => {
      // Invalidate cache for all files
      filePaths.forEach(p => contentCacheActions.invalidateContent(p));
      const pathSet = new Set(filePaths);
      set((state) => ({
        hoverFiles: state.hoverFiles.map(h =>
          pathSet.has(h.filePath)
            ? { ...h, contentReloadTrigger: (h.contentReloadTrigger || 0) + 1 }
            : h
        ),
      }));
    },

    // Set default size for new windows
    setDefaultSize: (width: number, height: number) => {
      set({ defaultWidth: width, defaultHeight: height });
    },

    // Clear all windows (used when switching vaults)
    clearAll: () => {
      set({ hoverFiles: [], snapPreview: null });
    },

    // Close window by file path (used when deleting files)
    closeByFilePath: (filePath: string) => {
      set((state) => ({
        hoverFiles: state.hoverFiles.filter(h => h.filePath !== filePath),
      }));
    },

    // Update file path for a window (used when moving files)
    updateFilePath: (oldPath: string, newPath: string) => {
      set((state) => ({
        hoverFiles: state.hoverFiles.map(h =>
          h.filePath === oldPath ? { ...h, filePath: newPath } : h
        ),
      }));
    },

    // Refresh all windows (increment contentReloadTrigger for all)
    refreshAll: () => {
      set((state) => ({
        hoverFiles: state.hoverFiles.map(h => ({
          ...h,
          contentReloadTrigger: (h.contentReloadTrigger || 0) + 1,
        })),
      }));
    },

    // Update file path and refresh all (for rename with wiki-link updates)
    updateFilePathAndRefreshAll: (oldPath: string, newPath: string) => {
      set((state) => ({
        hoverFiles: state.hoverFiles.map(h => ({
          ...h,
          filePath: h.filePath === oldPath ? newPath : h.filePath,
          contentReloadTrigger: (h.contentReloadTrigger || 0) + 1,
        })),
      }));
    },

    // Selectors (Option B: Include closing/minimizing windows in active list for animation)
    getWindow: (id: string) => get().hoverFiles.find(h => h.id === id),
    // Active windows = not minimized AND not cached, OR currently animating (closing/minimizing)
    getActiveWindows: () => {
      const state = get();
      return state.hoverFiles.filter(h =>
        (!h.minimized && !h.cached) ||
        state.closingWindowIds.has(h.id) ||
        state.minimizingWindowIds.has(h.id)
      );
    },
    // Minimized windows = minimized AND not cached AND not currently minimizing (animation)
    getMinimizedWindows: () => {
      const state = get();
      return state.hoverFiles.filter(h =>
        h.minimized && !h.cached && !state.minimizingWindowIds.has(h.id)
      );
    },
    getCachedWindows: () => get().hoverFiles.filter(h => h.cached && !get().closingWindowIds.has(h.id)),
  }))
);

// Selector hooks for optimized subscriptions
// These prevent re-renders when unrelated state changes
// IMPORTANT: Option B - Include closing/minimizing windows in active list for smooth animation
// NOTE: useShallow is required for selectors that return arrays to prevent infinite loops

export const useHoverWindow = (id: string) =>
  useHoverStore((state) => state.hoverFiles.find(h => h.id === id));

// Active windows = normal active windows + currently animating (closing/minimizing) windows
export const useActiveHoverWindows = () =>
  useHoverStore(useShallow((state) =>
    state.hoverFiles.filter(h =>
      (!h.minimized && !h.cached) ||
      state.closingWindowIds.has(h.id) ||
      state.minimizingWindowIds.has(h.id)
    )
  ));

// Minimized windows = minimized AND not currently minimizing (still animating)
export const useMinimizedHoverWindows = () =>
  useHoverStore(useShallow((state) =>
    state.hoverFiles.filter(h =>
      h.minimized && !h.cached && !state.minimizingWindowIds.has(h.id)
    )
  ));

// Count excludes cached windows that are not animating
export const useHoverWindowCount = () =>
  useHoverStore((state) =>
    state.hoverFiles.filter(h => !h.cached || state.closingWindowIds.has(h.id)).length
  );

export const useCachedHoverWindows = () =>
  useHoverStore(useShallow((state) => state.hoverFiles.filter(h => h.cached)));

export const useSnapPreview = () =>
  useHoverStore((state) => state.snapPreview);

// Animation state selectors (for synchronized animations)
export const useClosingWindowIds = () =>
  useHoverStore((state) => state.closingWindowIds);

export const useMinimizingWindowIds = () =>
  useHoverStore((state) => state.minimizingWindowIds);

export const useIsClosing = (id: string) =>
  useHoverStore((state) => state.closingWindowIds.has(id));

export const useIsMinimizing = (id: string) =>
  useHoverStore((state) => state.minimizingWindowIds.has(id));

// Preload content for a file path (called on hover before click)
export const preloadHoverContent = (path: string) => {
  if (path.endsWith('.md')) {
    contentCacheActions.preloadContent(path);
  }
};

// Import multi-window utility for separate window mode
import { openHoverWindow } from '../../utils/multiWindow';
import { useFileTreeStore } from './fileTreeStore';
import { useContentCacheStore } from './contentCacheStore';

// Actions (stable references - can be called outside React)
export const hoverActions = {
  // Default: open in separate OS window (multi-window mode)
  // Automatically detects note type from content cache for taskbar icon
  open: (path: string, noteType?: string) => {
    const vaultPath = useFileTreeStore.getState().vaultPath;
    // Try to get note type from content cache if not provided
    let type = noteType;
    if (!type && path.endsWith('.md')) {
      const frontmatter = useContentCacheStore.getState().getFrontmatter(path);
      type = frontmatter?.type as string | undefined;
    }
    return openHoverWindow(path, vaultPath || undefined, type);
  },
  // Open as DOM overlay (legacy single-window mode)
  openOverlay: (path: string) => useHoverStore.getState().openHoverFile(path),
  preload: preloadHoverContent,
  close: (id: string) => useHoverStore.getState().closeHoverFile(id),
  focus: (id: string) => useHoverStore.getState().focusHoverFile(id),
  minimize: (id: string) => useHoverStore.getState().minimizeHoverFile(id),
  restore: (id: string) => useHoverStore.getState().restoreHoverFile(id),
  update: (id: string, updates: Partial<HoverWindow>) =>
    useHoverStore.getState().updateHoverWindow(id, updates),
  setSnapPreview: (preview: SnapPreview | null) =>
    useHoverStore.getState().setSnapPreview(preview),
  refreshForFile: (filePath: string) =>
    useHoverStore.getState().refreshHoverWindowsForFile(filePath),
  refreshForFiles: (filePaths: string[]) =>
    useHoverStore.getState().refreshHoverWindowsForFiles(filePaths),
  clearAll: () => useHoverStore.getState().clearAll(),
  closeByFilePath: (filePath: string) =>
    useHoverStore.getState().closeByFilePath(filePath),
  updateFilePath: (oldPath: string, newPath: string) =>
    useHoverStore.getState().updateFilePath(oldPath, newPath),
  refreshAll: () => useHoverStore.getState().refreshAll(),
  updateFilePathAndRefreshAll: (oldPath: string, newPath: string) =>
    useHoverStore.getState().updateFilePathAndRefreshAll(oldPath, newPath),
  setDefaultSize: (width: number, height: number) =>
    useHoverStore.getState().setDefaultSize(width, height),
  // Synchronized animation actions
  startClosing: (id: string) => useHoverStore.getState().startClosing(id),
  finishClosing: (id: string) => useHoverStore.getState().finishClosing(id),
  startMinimizing: (id: string) => useHoverStore.getState().startMinimizing(id),
  finishMinimizing: (id: string) => useHoverStore.getState().finishMinimizing(id),
  isClosing: (id: string) => useHoverStore.getState().closingWindowIds.has(id),
  isMinimizing: (id: string) => useHoverStore.getState().minimizingWindowIds.has(id),
};
