/**
 * useSwipeAction — Horizontal swipe gesture for reveal-to-delete on list items.
 *
 * Returns ref + style + state to apply to a swipeable row.
 * 80px reveals delete button, 160px auto-triggers.
 * Vertical movement priority cancels horizontal swipe (scroll protection).
 */
import { useRef, useState, useCallback } from 'react';
import { triggerHaptic } from '../features/shared/haptics';

interface UseSwipeActionOptions {
  /** Called when swipe exceeds auto-trigger threshold or delete button tapped */
  onAction: () => void;
  /** Threshold to reveal action button (default 80) */
  revealThreshold?: number;
  /** Threshold to auto-trigger action (default 160) */
  autoTriggerThreshold?: number;
  /** Disable */
  disabled?: boolean;
}

interface SwipeState {
  /** Current translateX offset */
  offsetX: number;
  /** Whether action area is revealed */
  revealed: boolean;
  /** Whether actively swiping */
  swiping: boolean;
}

export function useSwipeAction({
  onAction,
  revealThreshold = 80,
  autoTriggerThreshold = 160,
  disabled = false,
}: UseSwipeActionOptions) {
  const [state, setState] = useState<SwipeState>({
    offsetX: 0,
    revealed: false,
    swiping: false,
  });

  const startRef = useRef<{ x: number; y: number } | null>(null);
  const decidedRef = useRef<'horizontal' | 'vertical' | null>(null);
  const hapticFiredRef = useRef(false);

  const onTouchStart = useCallback(
    (e: React.TouchEvent) => {
      if (disabled) return;
      const touch = e.touches[0];
      startRef.current = { x: touch.clientX, y: touch.clientY };
      decidedRef.current = null;
      hapticFiredRef.current = false;
      setState(s => ({ ...s, swiping: true }));
    },
    [disabled],
  );

  const onTouchMove = useCallback(
    (e: React.TouchEvent) => {
      if (!startRef.current || disabled) return;
      const touch = e.touches[0];
      const dx = touch.clientX - startRef.current.x;
      const dy = touch.clientY - startRef.current.y;

      // Decide direction on first significant move
      if (!decidedRef.current) {
        if (Math.abs(dx) < 5 && Math.abs(dy) < 5) return;
        decidedRef.current = Math.abs(dy) > Math.abs(dx) ? 'vertical' : 'horizontal';
      }

      if (decidedRef.current === 'vertical') {
        // Cancel swipe — let scroll happen
        setState(s => ({ ...s, offsetX: 0, swiping: false }));
        startRef.current = null;
        return;
      }

      // Only allow left swipe (negative dx)
      const offset = Math.min(0, dx);
      const absDx = Math.abs(offset);

      if (absDx >= revealThreshold && !hapticFiredRef.current) {
        triggerHaptic('light');
        hapticFiredRef.current = true;
      }

      setState({
        offsetX: offset,
        revealed: absDx >= revealThreshold,
        swiping: true,
      });
    },
    [disabled, revealThreshold],
  );

  const onTouchEnd = useCallback(() => {
    if (!startRef.current) return;
    startRef.current = null;

    const absDx = Math.abs(state.offsetX);

    if (absDx >= autoTriggerThreshold) {
      // Auto-trigger
      triggerHaptic('medium');
      onAction();
      setState({ offsetX: 0, revealed: false, swiping: false });
      return;
    }

    if (absDx >= revealThreshold) {
      // Snap to revealed position
      setState({ offsetX: -revealThreshold, revealed: true, swiping: false });
    } else {
      // Spring back
      setState({ offsetX: 0, revealed: false, swiping: false });
    }
  }, [state.offsetX, revealThreshold, autoTriggerThreshold, onAction]);

  /** Close revealed state */
  const close = useCallback(() => {
    setState({ offsetX: 0, revealed: false, swiping: false });
  }, []);

  const style: React.CSSProperties = {
    transform: `translateX(${state.offsetX}px)`,
    transition: state.swiping ? 'none' : 'transform 200ms cubic-bezier(0.25, 1, 0.5, 1)',
  };

  return {
    handlers: { onTouchStart, onTouchMove, onTouchEnd },
    style,
    state,
    close,
  };
}
