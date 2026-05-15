import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import {
  Search,
  Settings as SettingsIcon,
  PanelLeftClose,
  PanelRightOpen,
  FileText as FileIcon,
  ArrowRight,
} from 'lucide-react';
import {
  useFileTree,
  hoverActions,
  uiActions,
  useShowSidebar,
  useShowHoverPanel,
  useLanguage,
} from '../../core/stores/zustand';
import { Dialog, KeyboardHint } from '../../design-system/components';
import { t } from '../../core/utils/i18n';
import type { FileNode } from '../../core/types';

interface PaletteCommand {
  type: 'command';
  id: string;
  label: string;
  icon: ReactNode;
  shortcut?: string[];
  onSelect: () => void;
  matchText: string;
}
interface PaletteNote {
  type: 'note';
  id: string;
  name: string;
  path: string;
  matchText: string;
}
type PaletteItem = PaletteCommand | PaletteNote;

const MAX_NOTE_RESULTS = 30;

/**
 * Flatten the file tree into a list of note paths (.md only).
 * Folders/attachments are excluded — only navigable notes.
 */
function flattenNotes(tree: FileNode[]): Array<{ name: string; path: string }> {
  const out: Array<{ name: string; path: string }> = [];
  const walk = (nodes: FileNode[]) => {
    for (const n of nodes) {
      if (n.is_dir) {
        if (n.children) walk(n.children);
      } else if (n.name.toLowerCase().endsWith('.md')) {
        out.push({ name: n.name.replace(/\.md$/i, ''), path: n.path });
      }
    }
  };
  walk(tree);
  return out;
}

function fuzzyScore(needle: string, haystack: string): number {
  if (!needle) return 1;
  const n = needle.toLowerCase();
  const h = haystack.toLowerCase();
  if (h.includes(n)) return 100 - (h.indexOf(n));
  // every needle char appears in order
  let hi = 0;
  for (const c of n) {
    const idx = h.indexOf(c, hi);
    if (idx === -1) return 0;
    hi = idx + 1;
  }
  return 50 - n.length;
}

export function CommandPalette() {
  const language = useLanguage();
  const fileTree = useFileTree();
  const showSidebar = useShowSidebar();
  const showHoverPanel = useShowHoverPanel();

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    setQuery('');
    setActiveIndex(0);
  }, []);

  // Listen for the Ctrl+K window event dispatched by useAppKeyboardShortcuts.
  useEffect(() => {
    const handler = () => {
      setOpen(true);
      setQuery('');
      setActiveIndex(0);
    };
    window.addEventListener('open-command-palette', handler);
    return () => window.removeEventListener('open-command-palette', handler);
  }, []);

  /** Static commands — order = recency priority when query is empty. */
  const commands = useMemo<PaletteCommand[]>(() => {
    const cmds: PaletteCommand[] = [
      {
        type: 'command',
        id: 'search',
        label: t('cmdSearch', language),
        icon: <Search size={14} />,
        shortcut: ['Ctrl', 'Shift', 'F'],
        matchText: t('cmdSearch', language) + ' search 검색',
        onSelect: () => uiActions.setShowSearch(true),
      },
      {
        type: 'command',
        id: 'settings',
        label: t('cmdSettings', language),
        icon: <SettingsIcon size={14} />,
        shortcut: ['Ctrl', ','],
        matchText: t('cmdSettings', language) + ' settings 설정',
        onSelect: () => window.dispatchEvent(new CustomEvent('open-settings')),
      },
      {
        type: 'command',
        id: 'toggleSidebar',
        label: t('cmdToggleSidebar', language),
        icon: <PanelLeftClose size={14} />,
        shortcut: ['Ctrl', 'ArrowLeft'],
        matchText: t('cmdToggleSidebar', language) + ' sidebar 사이드바',
        onSelect: () => uiActions.setShowSidebar(!showSidebar),
      },
      {
        type: 'command',
        id: 'toggleRightPanel',
        label: t('cmdToggleRightPanel', language),
        icon: <PanelRightOpen size={14} />,
        shortcut: ['Ctrl', 'ArrowRight'],
        matchText: t('cmdToggleRightPanel', language) + ' right panel 우측 캘린더',
        onSelect: () => uiActions.setShowHoverPanel(!showHoverPanel),
      },
    ];
    return cmds;
  }, [language, showSidebar, showHoverPanel]);

  /** All notes in vault (memoized — flatten + matchText only when tree changes). */
  const allNotes = useMemo<PaletteNote[]>(() => {
    return flattenNotes(fileTree).map((n) => ({
      type: 'note' as const,
      id: `note:${n.path}`,
      name: n.name,
      path: n.path,
      matchText: n.name + ' ' + n.path,
    }));
  }, [fileTree]);

  /** Filtered + ranked items. Notes first when query non-empty; commands first when empty. */
  const items = useMemo<PaletteItem[]>(() => {
    const q = query.trim();
    if (!q) {
      // Empty query: show commands first, then top notes (recent if available)
      return [
        ...commands,
        ...allNotes.slice(0, 10),
      ];
    }
    const cmdRanked = commands
      .map((c) => ({ c, score: fuzzyScore(q, c.matchText) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((x) => x.c);

    const noteRanked = allNotes
      .map((n) => ({ n, score: fuzzyScore(q, n.matchText) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_NOTE_RESULTS)
      .map((x) => x.n);

    // Note matches usually more relevant when querying by filename. Notes first.
    return [...noteRanked, ...cmdRanked];
  }, [query, commands, allNotes]);

  // Clamp activeIndex into range when items list changes.
  useEffect(() => {
    if (activeIndex >= items.length) setActiveIndex(0);
  }, [items.length, activeIndex]);

  const handleSelect = useCallback(
    (item: PaletteItem) => {
      close();
      if (item.type === 'command') {
        item.onSelect();
      } else {
        hoverActions.open(item.path);
      }
    },
    [close],
  );

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (items.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % items.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => (i - 1 + items.length) % items.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const item = items[activeIndex];
      if (item) handleSelect(item);
    } else if (e.key === 'Home') {
      e.preventDefault();
      setActiveIndex(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      setActiveIndex(items.length - 1);
    }
  };

  // Scroll active row into view
  useEffect(() => {
    if (!open) return;
    const list = listRef.current;
    if (!list) return;
    const row = list.querySelector<HTMLElement>(`[data-palette-index="${activeIndex}"]`);
    row?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, open]);

  if (!open) return null;

  return (
    <Dialog
      open={open}
      onClose={close}
      size="lg"
      hideCloseButton
      ariaLabel={t('commandPaletteAriaLabel', language)}
      className="command-palette-dialog"
      initialFocus={inputRef as React.RefObject<HTMLElement>}
    >
      <div className="command-palette" onKeyDown={onKeyDown}>
        <div className="command-palette__input-wrap">
          <span className="command-palette__input-icon" aria-hidden="true"><Search size={14} /></span>
          <input
            ref={inputRef}
            className="command-palette__input"
            type="text"
            placeholder={t('commandPalettePlaceholder', language)}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setActiveIndex(0); }}
            spellCheck={false}
            autoComplete="off"
          />
          <KeyboardHint keys={['Esc']} size="sm" className="command-palette__hint" />
        </div>

        <div ref={listRef} className="command-palette__list" role="listbox">
          {items.length === 0 ? (
            <div className="command-palette__empty">{t('commandPaletteNoResults', language)}</div>
          ) : (
            items.map((item, idx) => {
              const active = idx === activeIndex;
              const cls = `command-palette__row${active ? ' command-palette__row--active' : ''}`;
              if (item.type === 'command') {
                return (
                  <div
                    key={item.id}
                    role="option"
                    aria-selected={active}
                    data-palette-index={idx}
                    className={cls}
                    onMouseEnter={() => setActiveIndex(idx)}
                    onClick={() => handleSelect(item)}
                  >
                    <span className="command-palette__row-icon" aria-hidden="true">{item.icon}</span>
                    <span className="command-palette__row-label">{item.label}</span>
                    {item.shortcut && (
                      <KeyboardHint keys={item.shortcut} size="sm" className="command-palette__row-shortcut" />
                    )}
                  </div>
                );
              }
              // Note row
              return (
                <div
                  key={item.id}
                  role="option"
                  aria-selected={active}
                  data-palette-index={idx}
                  className={cls}
                  onMouseEnter={() => setActiveIndex(idx)}
                  onClick={() => handleSelect(item)}
                >
                  <span className="command-palette__row-icon" aria-hidden="true"><FileIcon size={14} /></span>
                  <span className="command-palette__row-label">{item.name}</span>
                  <ArrowRight size={12} className="command-palette__row-trail" aria-hidden="true" />
                </div>
              );
            })
          )}
        </div>

        <footer className="command-palette__footer">
          <span><KeyboardHint keys={['ArrowUp']} size="sm" /> <KeyboardHint keys={['ArrowDown']} size="sm" /> {t('commandPaletteNav', language)}</span>
          <span><KeyboardHint keys={['Enter']} size="sm" /> {t('commandPaletteOpen', language)}</span>
          <span><KeyboardHint keys={['Esc']} size="sm" /> {t('commandPaletteClose', language)}</span>
        </footer>
      </div>
    </Dialog>
  );
}
