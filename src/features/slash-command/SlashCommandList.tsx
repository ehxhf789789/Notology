import { forwardRef, useImperativeHandle } from 'react';
import {
  Heading1, Heading2, Heading3,
  List, ListOrdered, ListChecks,
  Quote, Minus,
  Link, Paperclip,
  Code, Code2,
  Sigma, SquareSigma,
  FileText,
  Info, AlertTriangle, AlertOctagon, CheckCircle, StickyNote, Lightbulb,
  Table,
  Search,
} from 'lucide-react';
import type { SlashCommandItem } from '../../core/editor/extensions/SlashCommand';
import { KeyboardHint } from '../../design-system/components';
import { useSuggestionList } from '../../core/hooks/useSuggestionList';
import { useSettingsStore } from '../../core/stores/settingsStore';
import { t } from '../../core/utils/i18n';

const ICONS: Record<string, React.ComponentType<{ size?: number }>> = {
  Heading1, Heading2, Heading3,
  List, ListOrdered, ListChecks,
  Quote, Minus,
  Link, Paperclip,
  Code, Code2,
  Sigma, SquareSigma,
  FileText,
  Info, AlertTriangle, AlertOctagon, CheckCircle, StickyNote, Lightbulb,
  Table,
};

export interface SlashCommandListProps {
  items: SlashCommandItem[];
  command: (item: { item: SlashCommandItem }) => void;
  query?: string;
}
export interface SlashCommandListRef {
  onKeyDown: (props: { event: KeyboardEvent }) => boolean;
}

export const SlashCommandList = forwardRef<SlashCommandListRef, SlashCommandListProps>(
  function SlashCommandList({ items, command, query = '' }, ref) {
    const language = useSettingsStore((s) => s.language);
    // v5.5 (2026-05-16) — keyboard nav via useSuggestionList. Slash keeps
    // Home/End shortcuts and autoScroll (the active row scrolls into view
    // as the user arrows past the visible region). Enter-only commit;
    // unlike `[[`/`//` we don't accept Tab because slash items can have
    // multi-line descriptions and Tab is more naturally an indent gesture.
    const { activeIndex, setActiveIndex, onKeyDown, listRef } = useSuggestionList(
      items,
      (item) => command({ item }),
      { autoScroll: true, edgeKeys: true },
    );

    useImperativeHandle(ref, () => ({
      onKeyDown: ({ event }) => onKeyDown(event),
    }));

    // v9 i18n cleanup — single-language placeholder via i18n.
    const headerNode = (
      <div className="slash-palette__search">
        <Search size={14} className="slash-palette__search-icon" />
        <span className={`slash-palette__search-query${query ? '' : ' slash-palette__search-query--empty'}`}>
          {query || t('suggestionSearchCommands', language)}
        </span>
      </div>
    );

    if (items.length === 0) {
      return (
        <div className="slash-palette slash-palette--empty">
          {headerNode}
          <div className="slash-palette__empty-text">No matching command</div>
        </div>
      );
    }

    return (
      <div ref={listRef} className="slash-palette" role="listbox">
        {headerNode}
        {items.map((item, idx) => {
          const Icon = item.icon ? ICONS[item.icon] : null;
          const active = idx === activeIndex;
          return (
            <div
              key={item.id}
              data-suggestion-index={idx}
              role="option"
              aria-selected={active}
              className={`slash-palette__row${active ? ' slash-palette__row--active' : ''}`}
              onMouseEnter={() => setActiveIndex(idx)}
              onMouseDown={(e) => {
                e.preventDefault();
              }}
              onClick={() => command({ item })}
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
