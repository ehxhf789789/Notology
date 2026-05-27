/**
 * useLongPress — 500ms long-press detection with visual + haptic feedback.
 *
 * Returns pointer event handlers to spread onto any element.
 * Cancels on 10px movement (scroll intent).
 * Suppresses tap event after long-press fires.
 * Only one long-press active at a time (global guard).
 */
import { useRef, useCallback } from 'react';
import { triggerHaptic } from '../features/shared/haptics';

interface UseLongPressOptions {
  /** Time in ms to recognize long-press (default 500) */
  threshold?: number;
  /** Called when long-press fires */
  onLongPress: (e: { clientX: number; clientY: number; target: EventTarget | null }) => void;
  /** Called on normal tap (if long-press didn't fire) */
  onPress?: () => void;
  /** Disable the hook */
  disabled?: boolean;
}

// Global guard: only one long-press at a time
let activeLongPressId: number | null = null;
let nextId = 0;

export function useLongPress({
  threshold = 500,
  onLongPress,
  onPress,
  disabled = false,
}: UseLongPressOptions) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const firedRef = useRef(false);
  const idRef = useRef(nextId++);
  const targetRef = useRef<HTMLElement | null>(null);

  const cancel = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (activeLongPressId === idRef.current) {
      activeLongPressId = null;
    }
    if (targetRef.current) {
      targetRef.current.classList.remove('touch-pressing');
      targetRef.current = null;
    }
    startRef.current = null;
  }, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (disabled) return;
      if (activeLongPressId !== null) return; // another long-press active

      firedRef.current = false;
      startRef.current = { x: e.clientX, y: e.clientY };
      activeLongPressId = idRef.current;

      // Visual feedback
      const el = e.currentTarget as HTMLElement;
      targetRef.current = el;
      el.classList.add('touch-pressing');

      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        firedRef.current = true;

        // Remove visual feedback
        el.classList.remove('touch-pressing');
        targetRef.current = null;

        // Haptic feedback
        triggerHaptic('selection');

        onLongPress({
          clientX: startRef.current?.x ?? e.clientX,
          clientY: startRef.current?.y ?? e.clientY,
          target: e.target,
        });
      }, threshold);
    },
    [disabled, onLongPress, threshold, cancel],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!startRef.current) return;
      const dx = e.clientX - startRef.current.x;
      const dy = e.clientY - startRef.current.y;
      if (Math.hypot(dx, dy) > 10) {
        cancel();
      }
    },
    [cancel],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent) => {
      cancel();
      if (firedRef.current) {
        // Suppress tap after long-press
        e.preventDefault();
        e.stopPropagation();
        firedRef.current = false;
        return;
      }
      // Normal tap
      onPress?.();
    },
    [cancel, onPress],
  );

  const onPointerCancel = useCallback(() => {
    cancel();
    firedRef.current = false;
  }, [cancel]);

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
  };
}
