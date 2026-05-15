import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import {
  Heading1, Heading2, Heading3,
  List, ListOrdered, ListChecks,
  Quote, Minus,
  Link, Paperclip,
  Code, Code2,
  Sigma, SquareSigma,
  FileText,
} from 'lucide-react';
import type { SlashCommandItem } from '../../core/editor/extensions/SlashCommand';
import { KeyboardHint } from '../../design-system/components';

/** Resolve an icon name string to the lucide component. */
const ICONS: Record<string, React.ComponentType<{ size?: number }>> = {
  Heading1, Heading2, Heading3,
  List, ListOrdered, ListChecks,
  Quote, Minus,
  Link, Paperclip,
  Code, Code2,
  Sigma, SquareSigma,
  FileText,
};

export interface SlashCommandListProps {
  items: SlashCommandItem[];
  command: (item: { item: SlashCommandItem }) => void;
}
export interface SlashCommandListRef {
  onKeyDown: (props: { event: KeyboardEvent }) => boolean;
}

export const SlashCommandList = forwardRef<SlashCommandListRef, SlashCommandListProps>(
  function SlashCommandList({ items, command }, ref) {
    const [activeIndex, setActiveIndex] = useState(0);
    const listRef = useRef<HTMLDivElement>(null);

    // Reset active when item list changes (typing filters down)
    useEffect(() => {
      setActiveIndex(0);
    }, [items]);

    // Scroll active row into view
    useEffect(() => {
      const row = listRef.current?.querySelector<HTMLElement>(
        `[data-slash-index="${activeIndex}"]`,
      );
      row?.scrollIntoView({ block: 'nearest' });
    }, [activeIndex]);

    const select = (idx: number) => {
      const item = items[idx];
      if (item) command({ item });
    };

    useImperativeHandle(ref, () => ({
      onKeyDown: ({ event }) => {
        if (items.length === 0) return false;
        if (event.key === 'ArrowDown') {
          setActiveIndex((i) => (i + 1) % items.length);
          return true;
        }
        if (event.key === 'ArrowUp') {
          setActiveIndex((i) => (i - 1 + items.length) % items.length);
          return true;
        }
        if (event.key === 'Enter') {
          select(activeIndex);
          return true;
        }
        if (event.key === 'Home') {
          setActiveIndex(0);
          return true;
        }
        if (event.key === 'End') {
          setActiveIndex(items.length - 1);
          return true;
        }
        return false;
      },
    }), [items, activeIndex]);

    if (items.length === 0) {
      return (
        <div className="slash-palette slash-palette--empty">
          <div className="slash-palette__empty-text">No matching command</div>
        </div>
      );
    }

    return (
      <div ref={listRef} className="slash-palette" role="listbox">
        {items.map((item, idx) => {
          const Icon = item.icon ? ICONS[item.icon] : null;
          const active = idx === activeIndex;
          return (
            <div
              key={item.id}
              data-slash-index={idx}
              role="option"
              aria-selected={active}
              className={`slash-palette__row${active ? ' slash-palette__row--active' : ''}`}
              onMouseEnter={() => setActiveIndex(idx)}
              onMouseDown={(e) => {
                // Prevent editor blur; let click-handler fire commit
                e.preventDefault();
              }}
              onClick={() => select(idx)}
            >
              <span className="slash-palette__icon" aria-hidden="true">
                {Icon ? <Icon size={16} /> : <span className="slash-palette__icon-placeholder" />}
              </span>
              <span className="slash-palette__label">
                {item.label}
                {item.description && (
                  <span className="slash-palette__desc">{item.description}</span>
                )}
              </span>
              {item.shortcut && (
                <KeyboardHint keys={item.shortcut} size="sm" className="slash-palette__shortcut" />
              )}
            </div>
          );
        })}
      </div>
    );
  },
);
