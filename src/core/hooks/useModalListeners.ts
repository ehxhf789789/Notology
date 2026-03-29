import { useEffect, useCallback, useRef, type RefObject } from 'react';

/**
 * Hook for handling click outside of a ref element
 * Optimized to use a single event listener registration per component
 *
 * @param ref - React ref to the container element
 * @param onClickOutside - Callback when clicking outside
 * @param enabled - Whether the listener is active (default: true)
 */
export function useClickOutside<T extends HTMLElement>(
  ref: RefObject<T | null>,
  onClickOutside: () => void,
  enabled: boolean = true
): void {
  // Memoize callback to prevent recreating on every render
  const callbackRef = useRef(onClickOutside);
  callbackRef.current = onClickOutside;

  useEffect(() => {
    if (!enabled) return;

    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        callbackRef.current();
      }
    };

    // Use capture phase for faster response
    document.addEventListener('mousedown', handleClick, { capture: false });
    return () => document.removeEventListener('mousedown', handleClick, { capture: false });
  }, [ref, enabled]);
}

/**
 * Hook for handling Escape key press
 * Optimized to use a single event listener registration per component
 *
 * @param onEscape - Callback when Escape is pressed
 * @param enabled - Whether the listener is active (default: true)
 */
export function useEscapeKey(
  onEscape: () => void,
  enabled: boolean = true
): void {
  // Memoize callback to prevent recreating on every render
  const callbackRef = useRef(onEscape);
  callbackRef.current = onEscape;

  useEffect(() => {
    if (!enabled) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        callbackRef.current();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [enabled]);
}

/**
 * Combined hook for modal-like components that need both click outside and escape handling
 *
 * @param ref - React ref to the container element
 * @param onClose - Callback when clicking outside or pressing Escape
 * @param enabled - Whether the listeners are active (default: true)
 */
export function useModalClose<T extends HTMLElement>(
  ref: RefObject<T | null>,
  onClose: () => void,
  enabled: boolean = true
): void {
  useClickOutside(ref, onClose, enabled);
  useEscapeKey(onClose, enabled);
}

/**
 * Hook for handling Enter key press (form submission)
 *
 * @param onEnter - Callback when Enter is pressed
 * @param enabled - Whether the listener is active (default: true)
 */
export function useEnterKey(
  onEnter: () => void,
  enabled: boolean = true
): void {
  const callbackRef = useRef(onEnter);
  callbackRef.current = onEnter;

  useEffect(() => {
    if (!enabled) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        callbackRef.current();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [enabled]);
}
