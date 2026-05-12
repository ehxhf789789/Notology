/**
 * Shared dismissal hook — call `onEscape` when the Escape key is
 * pressed while `enabled` is true.
 *
 * Centralizing this pattern makes it harder to forget on new modals /
 * popovers, and gives a single place to refine behavior later (e.g.
 * pause/resume listener while a nested dialog is open).
 */
import { useEffect } from 'react';

export function useEscapeKey(onEscape: () => void, enabled: boolean = true): void {
  useEffect(() => {
    if (!enabled) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onEscape();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onEscape, enabled]);
}
