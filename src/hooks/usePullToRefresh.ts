/**
 * usePullToRefresh — Pull-to-refresh gesture hook for mobile views.
 * Shows a spinner indicator when user pulls down from top of scroll area.
 */
import { useRef, useState, useCallback, useEffect } from 'react';

interface UsePullToRefreshOptions {
  onRefresh: () => Promise<void>;
  threshold?: number; // px to pull before triggering (default: 60)
  disabled?: boolean;
}

export function usePullToRefresh({ onRefresh, threshold = 60, disabled = false }: UsePullToRefreshOptions) {
  const [pulling, setPulling] = useState(false);
  const [pullDistance, setPullDistance] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const startYRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const activeRef = useRef(false);

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if (disabled || refreshing) return;
    const el = scrollRef.current;
    if (el && el.scrollTop <= 0) {
      startYRef.current = e.touches[0].clientY;
      activeRef.current = true;
    }
  }, [disabled, refreshing]);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (!activeRef.current || disabled || refreshing) return;
    const dy = e.touches[0].clientY - startYRef.current;
    if (dy > 0) {
      // Apply resistance (diminishing returns)
      const dist = Math.min(dy * 0.5, threshold * 2);
      setPullDistance(dist);
      setPulling(true);
    } else {
      setPullDistance(0);
      setPulling(false);
    }
  }, [disabled, refreshing, threshold]);

  const handleTouchEnd = useCallback(async () => {
    if (!activeRef.current) return;
    activeRef.current = false;

    if (pullDistance >= threshold && !refreshing) {
      setRefreshing(true);
      setPullDistance(threshold); // Hold at threshold during refresh
      try {
        await onRefresh();
      } catch (e) {
        console.error('[pull-to-refresh] refresh failed:', e);
      }
      setRefreshing(false);
    }

    setPullDistance(0);
    setPulling(false);
  }, [pullDistance, threshold, refreshing, onRefresh]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      activeRef.current = false;
    };
  }, []);

  return {
    scrollRef,
    pulling: pulling || refreshing,
    pullDistance,
    refreshing,
    handlers: {
      onTouchStart: handleTouchStart,
      onTouchMove: handleTouchMove,
      onTouchEnd: handleTouchEnd,
    },
  };
}
