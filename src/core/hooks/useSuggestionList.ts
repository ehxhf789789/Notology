/**
 * Shared keyboard-navigation hook for TipTap suggestion popover lists
 * (slash palette, wikilink suggestions, attachment suggestions).
 *
 * Before v5.5 each of the three lists rolled its own copy: same up/down
 * arrow handler, same `useEffect([items], reset)`, same selectedIndex
 * state. Divergences crept in — slash supported Home/End and auto-scroll,
 * wikilink/attachment accepted Tab as well as Enter, and the state name
 * itself was inconsistent (`activeIndex` vs `selectedIndex`). This hook
 * is the single source of truth; per-list quirks are configured via the
 * `options` argument.
 */
import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';

export interface UseSuggestionListOptions {
  /** Keys (besides arrows) that commit the active item. Default: ['Enter']. */
  acceptKeys?: ReadonlyArray<string>;
  /** Auto-scroll the active row into view via `data-suggestion-index`. */
  autoScroll?: boolean;
  /** Support Home/End keys (jump to first/last). */
  edgeKeys?: boolean;
}

export interface UseSuggestionListReturn<T> {
  activeIndex: number;
  setActiveIndex: (i: number) => void;
  select: (i: number) => void;
  onKeyDown: (event: KeyboardEvent) => boolean;
  listRef: RefObject<HTMLDivElement | null>;
}

export function useSuggestionList<T>(
  items: T[],
  onSelect: (item: T) => void,
  options: UseSuggestionListOptions = {},
): UseSuggestionListReturn<T> {
  const { acceptKeys = ['Enter'], autoScroll = false, edgeKeys = false } = options;
  const [activeIndex, setActiveIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => setActiveIndex(0), [items]);

  useEffect(() => {
    if (!autoScroll) return;
    const row = listRef.current?.querySelector<HTMLElement>(
      `[data-suggestion-index="${activeIndex}"]`,
    );
    row?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, autoScroll]);

  const select = (idx: number) => {
    const item = items[idx];
    if (item !== undefined) onSelect(item);
  };

  const onKeyDown = (event: KeyboardEvent): boolean => {
    if (items.length === 0) return false;
    if (event.key === 'ArrowDown') {
      setActiveIndex((i) => (i + 1) % items.length);
      return true;
    }
    if (event.key === 'ArrowUp') {
      setActiveIndex((i) => (i - 1 + items.length) % items.length);
      return true;
    }
    if (acceptKeys.includes(event.key)) {
      select(activeIndex);
      return true;
    }
    if (edgeKeys && event.key === 'Home') {
      setActiveIndex(0);
      return true;
    }
    if (edgeKeys && event.key === 'End') {
      setActiveIndex(items.length - 1);
      return true;
    }
    return false;
  };

  return { activeIndex, setActiveIndex, select, onKeyDown, listRef };
}
