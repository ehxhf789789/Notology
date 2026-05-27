/**
 * useEdgeSwipeBack — Left-edge swipe gesture for back navigation (mobile).
 *
 * Activates when touch starts within 20px of left viewport edge.
 * Shows interactive back-arrow indicator during swipe.
 * Fires goBack() when swipe exceeds 100px threshold.
 */
import { useRef, useState, useCallback, useEffect } from 'react';

interface UseEdgeSwipeBackOptions {
  /** Called when swipe completes (past threshold) */
  onBack: () => void;
  /** Left edge detection width in px (default 20) */
  edgeWidth?: number;
  /** Minimum horizontal swipe to trigger back (default 100) */
  threshold?: number;
  /** Disable (e.g. when BottomSheet is open) */
  disabled?: boolean;
}

interface EdgeSwipeState {
  active: boolean;
  progress: number; // 0 to 1
}

export function useEdgeSwipeBack({
  onBack,
  edgeWidth = 20,
  threshold = 100,
  disabled = false,
}: UseEdgeSwipeBackOptions) {
  const [state, setState] = useState<EdgeSwipeState>({ active: false, progress: 0 });
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const decidedRef = useRef<boolean | null>(null); // true = horizontal

  const handleTouchStart = useCallback(
    (e: TouchEvent) => {
      if (disabled) return;
      const touch = e.touches[0];
      if (touch.clientX > edgeWidth) return;
      startRef.current = { x: touch.clientX, y: touch.clientY };
      decidedRef.current = null;
    },
    [disabled, edgeWidth],
  );

  const handleTouchMove = useCallback(
    (e: TouchEvent) => {
      if (!startRef.current) return;
      const touch = e.touches[0];
      const dx = touch.clientX - startRef.current.x;
      const dy = touch.clientY - startRef.current.y;

      // Decide direction
      if (decidedRef.current === null) {
        if (Math.abs(dx) < 5 && Math.abs(dy) < 5) return;
        decidedRef.current = Math.abs(dx) > Math.abs(dy);
        if (!decidedRef.current) {
          // Vertical — cancel
          startRef.current = null;
          setState({ active: false, progress: 0 });
          return;
        }
      }

      if (!decidedRef.current) return;

      const progress = Math.min(1, Math.max(0, dx / threshold));
      setState({ active: true, progress });

      // Prevent default scroll when we've committed to edge swipe
      if (progress > 0.1) {
        e.preventDefault();
      }
    },
    [threshold],
  );

  const handleTouchEnd = useCallback(() => {
    if (!startRef.current) return;
    const wasActive = state.active;
    const completed = state.progress >= 1;

    startRef.current = null;
    decidedRef.current = null;
    setState({ active: false, progress: 0 });

    if (wasActive && completed) {
      onBack();
    }
  }, [state, onBack]);

  useEffect(() => {
    if (disabled) return;
    const opts: AddEventListenerOptions = { passive: false };
    document.addEventListener('touchstart', handleTouchStart, opts);
    document.addEventListener('touchmove', handleTouchMove, opts);
    document.addEventListener('touchend', handleTouchEnd);
    document.addEventListener('touchcancel', handleTouchEnd);
    return () => {
      document.removeEventListener('touchstart', handleTouchStart);
      document.removeEventListener('touchmove', handleTouchMove);
      document.removeEventListener('touchend', handleTouchEnd);
      document.removeEventListener('touchcancel', handleTouchEnd);
    };
  }, [disabled, handleTouchStart, handleTouchMove, handleTouchEnd]);

  return state;
}
