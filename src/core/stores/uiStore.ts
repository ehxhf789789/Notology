import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';

const MIN_SIDEBAR_WIDTH = 200;
const MAX_SIDEBAR_WIDTH = 500;
const DEFAULT_SIDEBAR_WIDTH = 280;

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

// Track animation timeouts to prevent memory leaks on rapid toggling
let sidebarAnimTimeout: ReturnType<typeof setTimeout> | null = null;
let hoverPanelAnimTimeout: ReturnType<typeof setTimeout> | null = null;

interface UIState {
  // State
  showSearch: boolean;
  showCalendar: boolean;
  showHoverPanel: boolean;
  showSidebar: boolean;
  sidebarAnimState: 'idle' | 'opening' | 'closing';
  hoverPanelAnimState: 'idle' | 'opening' | 'closing';
  sidebarWidth: number;

  // Actions
  setShowSearch: (show: boolean) => void;
  setShowCalendar: (show: boolean) => void;
  setShowSidebar: (show: boolean) => void;
  setShowHoverPanel: (show: boolean) => void;
  setSidebarWidth: (width: number) => void;
}

export const useUIStore = create<UIState>()(
  subscribeWithSelector((set, get) => ({
    // Initial state
    showSearch: false,
    showCalendar: false,
    showHoverPanel: false,
    showSidebar: true,
    sidebarAnimState: 'idle',
    hoverPanelAnimState: 'idle',
    sidebarWidth: loadSidebarWidth(),

    // Show search (mutually exclusive with calendar)
    setShowSearch: (show: boolean) => {
      set({ showSearch: show });
      if (show) {
        set({ showCalendar: false });
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

    // Set sidebar width with persistence
    setSidebarWidth: (width: number) => {
      const clampedWidth = Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, width));
      set({ sidebarWidth: clampedWidth });
      try {
        localStorage.setItem('notology-sidebar-width', String(clampedWidth));
      } catch {}
    },
  }))
);

// Selector hooks
export const useShowSearch = () => useUIStore((s) => s.showSearch);
export const useShowCalendar = () => useUIStore((s) => s.showCalendar);
export const useShowHoverPanel = () => useUIStore((s) => s.showHoverPanel);
export const useShowSidebar = () => useUIStore((s) => s.showSidebar);
export const useSidebarAnimState = () => useUIStore((s) => s.sidebarAnimState);
export const useHoverPanelAnimState = () => useUIStore((s) => s.hoverPanelAnimState);
export const useSidebarWidth = () => useUIStore((s) => s.sidebarWidth);

// Actions (stable references)
export const uiActions = {
  setShowSearch: (show: boolean) => useUIStore.getState().setShowSearch(show),
  setShowCalendar: (show: boolean) => useUIStore.getState().setShowCalendar(show),
  setShowSidebar: (show: boolean) => useUIStore.getState().setShowSidebar(show),
  setShowHoverPanel: (show: boolean) => useUIStore.getState().setShowHoverPanel(show),
  setSidebarWidth: (width: number) => useUIStore.getState().setSidebarWidth(width),
};
