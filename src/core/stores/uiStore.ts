import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';

const MIN_SIDEBAR_WIDTH = 200;
const MAX_SIDEBAR_WIDTH = 500;
const DEFAULT_SIDEBAR_WIDTH = 280;

/* Stage 5.0.3a-rework (2026-05-15) — RightPanel reverted to single-surface
   Calendar; 4 per-note tabs (Tags/Comments/Outline/Metadata) were a design
   mistake (per-note panels belong inside hover windows, not the main right
   panel). The const + type remain as a no-op stub in case 5.0.7 introduces
   a different tab structure that wants the same name. */
export const RIGHT_PANEL_TABS = ['calendar'] as const;
export type RightPanelTab = (typeof RIGHT_PANEL_TABS)[number];

// Load sidebar width from localStorage
const loadSidebarWidth = (): number => {
  try {
    const stored = localStorage.getItem('notology-sidebar-width');
    if (stored) {
      const width = parseInt(stored, 10);
      if (!isNaN(width) && width >= MIN_SIDEBAR_WIDTH && width <= MAX_SIDEBAR_WIDTH) {
        return width;
      }
    }
  } catch {}
  return DEFAULT_SIDEBAR_WIDTH;
};

const loadSidebarCollapsed = (): boolean => {
  try {
    return localStorage.getItem('notology-sidebar-collapsed') === '1';
  } catch {
    return false;
  }
};

// Track animation timeouts to prevent memory leaks on rapid toggling
let sidebarAnimTimeout: ReturnType<typeof setTimeout> | null = null;
let hoverPanelAnimTimeout: ReturnType<typeof setTimeout> | null = null;

interface UIState {
  // State
  showSearch: boolean;
  /** dobbin 홈이 중앙에 서 있나 (UIUX_PLAN P0) */
  showDobbinHome: boolean;
  showCalendar: boolean;
  showHoverPanel: boolean;
  showSidebar: boolean;
  sidebarAnimState: 'idle' | 'opening' | 'closing';
  hoverPanelAnimState: 'idle' | 'opening' | 'closing';
  sidebarWidth: number;
  /** Stage 5.0.3b: when true, sidebar renders icon-only at SIDEBAR_ICON_WIDTH. */
  sidebarCollapsed: boolean;

  // Actions
  setShowSearch: (show: boolean) => void;
  setShowDobbinHome: (show: boolean) => void;
  setShowCalendar: (show: boolean) => void;
  setShowSidebar: (show: boolean) => void;
  setShowHoverPanel: (show: boolean) => void;
  /**
   * Stage 5.0.3b-simplify follow-up (2026-05-15): drag-resize was imprecise
   * because every mousemove triggered a synchronous localStorage write.
   * `persist=false` lets the resize loop skip the I/O — call once with
   * `persist=true` on mouseup to commit the final width.
   */
  setSidebarWidth: (width: number, persist?: boolean) => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
}

export const SIDEBAR_ICON_WIDTH = 52;

export const useUIStore = create<UIState>()(
  subscribeWithSelector((set, get) => ({
    // Initial state
    showSearch: false,
    showDobbinHome: false,
    showCalendar: false,
    showHoverPanel: false,
    showSidebar: true,
    sidebarAnimState: 'idle',
    hoverPanelAnimState: 'idle',
    sidebarWidth: loadSidebarWidth(),
    sidebarCollapsed: loadSidebarCollapsed(),

    // Show search (mutually exclusive with calendar)
    // v22 (HanBin 2026-05-23) — entering search mode clears the selected
    // container so the sidebar doesn't show a stale "currently focused"
    // highlight on the container the user was just in. Search is a
    // VAULT-WIDE view; pointing back at one container would mislead.
    // 🔴 dobbin 홈 — 검색과 **같은 층**이다 (중앙 무대). 셋(검색·홈·컨테이너)이
    //    서로 배타인 것은 화면이 하나이기 때문이지 dobbin 이 보조라서가 아니다.
    setShowDobbinHome: (show: boolean) => {
      set({ showDobbinHome: show });
      if (show) {
        set({ showSearch: false, showCalendar: false });
        import('./fileTreeStore').then(({ fileTreeActions }) => {
          fileTreeActions.setSelectedContainer(null);
        }).catch(() => { /* defensive */ });
      }
    },

    setShowSearch: (show: boolean) => {
      set({ showSearch: show });
      if (show) {
        set({ showCalendar: false, showDobbinHome: false });
        // Lazy import to avoid circular dep — fileTreeActions lives in
        // fileTreeStore which imports settings.
        import('./fileTreeStore').then(({ fileTreeActions }) => {
          fileTreeActions.setSelectedContainer(null);
        }).catch(() => { /* defensive — actions not loaded */ });
      }
    },

    // Show calendar (mutually exclusive with search)
    setShowCalendar: (show: boolean) => {
      set({ showCalendar: show });
      if (show) {
        set({ showSearch: false });
      }
    },

    // Animated sidebar toggle (180ms open, 180ms close for smooth transition)
    setShowSidebar: (show: boolean) => {
      if (show === get().showSidebar) return;
      // Clear previous timeout to prevent memory leaks on rapid toggling
      if (sidebarAnimTimeout) {
        clearTimeout(sidebarAnimTimeout);
        sidebarAnimTimeout = null;
      }
      if (show) {
        set({ sidebarAnimState: 'opening', showSidebar: true });
        sidebarAnimTimeout = setTimeout(() => {
          set({ sidebarAnimState: 'idle' });
          sidebarAnimTimeout = null;
        }, 200);
      } else {
        set({ sidebarAnimState: 'closing' });
        sidebarAnimTimeout = setTimeout(() => {
          set({ showSidebar: false, sidebarAnimState: 'idle' });
          sidebarAnimTimeout = null;
        }, 180);
      }
    },

    // Animated hover panel toggle (180ms open, 180ms close for smooth transition)
    setShowHoverPanel: (show: boolean) => {
      if (show === get().showHoverPanel) return;
      // Clear previous timeout to prevent memory leaks on rapid toggling
      if (hoverPanelAnimTimeout) {
        clearTimeout(hoverPanelAnimTimeout);
        hoverPanelAnimTimeout = null;
      }
      if (show) {
        set({ hoverPanelAnimState: 'opening', showHoverPanel: true });
        hoverPanelAnimTimeout = setTimeout(() => {
          set({ hoverPanelAnimState: 'idle' });
          hoverPanelAnimTimeout = null;
        }, 200);
      } else {
        set({ hoverPanelAnimState: 'closing' });
        hoverPanelAnimTimeout = setTimeout(() => {
          set({ showHoverPanel: false, hoverPanelAnimState: 'idle' });
          hoverPanelAnimTimeout = null;
        }, 180);
      }
    },

    // Set sidebar width. `persist=false` (used during drag) skips the
    // localStorage write — call once with `persist=true` (default) on mouseup
    // to commit. Without this, mousemove triggered a sync I/O write on every
    // event (~100×/sec), causing visible lag in the drag-resize loop.
    setSidebarWidth: (width: number, persist: boolean = true) => {
      const clampedWidth = Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, width));
      if (clampedWidth === get().sidebarWidth) return;
      set({ sidebarWidth: clampedWidth });
      if (persist) {
        try {
          localStorage.setItem('notology-sidebar-width', String(clampedWidth));
        } catch {}
      }
    },

    // Toggle sidebar icon-only mode with persistence
    setSidebarCollapsed: (collapsed: boolean) => {
      if (collapsed === get().sidebarCollapsed) return;
      set({ sidebarCollapsed: collapsed });
      try {
        localStorage.setItem('notology-sidebar-collapsed', collapsed ? '1' : '0');
      } catch {}
    },
  }))
);

// Selector hooks
export const useShowSearch = () => useUIStore((s) => s.showSearch);
export const useShowDobbinHome = () => useUIStore((s) => s.showDobbinHome);
export const useShowCalendar = () => useUIStore((s) => s.showCalendar);
export const useShowHoverPanel = () => useUIStore((s) => s.showHoverPanel);
export const useShowSidebar = () => useUIStore((s) => s.showSidebar);
export const useSidebarAnimState = () => useUIStore((s) => s.sidebarAnimState);
export const useHoverPanelAnimState = () => useUIStore((s) => s.hoverPanelAnimState);
export const useSidebarWidth = () => useUIStore((s) => s.sidebarWidth);
export const useSidebarCollapsed = () => useUIStore((s) => s.sidebarCollapsed);

// Actions (stable references)
export const uiActions = {
  setShowSearch: (show: boolean) => useUIStore.getState().setShowSearch(show),
  setShowCalendar: (show: boolean) => useUIStore.getState().setShowCalendar(show),
  setShowSidebar: (show: boolean) => useUIStore.getState().setShowSidebar(show),
  setShowHoverPanel: (show: boolean) => useUIStore.getState().setShowHoverPanel(show),
  setSidebarWidth: (width: number, persist?: boolean) => useUIStore.getState().setSidebarWidth(width, persist),
  setSidebarCollapsed: (collapsed: boolean) => useUIStore.getState().setSidebarCollapsed(collapsed),
};
