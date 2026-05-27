/**
 * CommandPalette — global Cmd/Ctrl+K palette.
 *
 * Stage 5.0.4a landed the base palette (filename navigation + 4 static
 * commands). Stage 5.0.7a (2026-05-17, HanBin) wires it to the Search
 * pipeline so it works as the global "search anything" surface the plan
 * §8.1 calls for:
 *   • Empty query → "최근 노트" section (mtime-sorted file-tree leaves) +
 *     "명령" section. The old behavior of dumping the first 10 notes from
 *     the tree was meaningless ordering.
 *   • Query ≥ 2 chars → "노트" (filename fuzzy match) + "본문 검색" section
 *     (debounced 200 ms `full_text_search` Tantivy query with snippet) +
 *     filtered commands.
 *   • "Search '{query}' in panel" action — opens the Search panel with
 *     the query pre-filled in the Contents tab (`open-search-with-query`
 *     window event consumed by Search.tsx).
 *
 * Sections render as headers in the list. Headers are non-interactive
 * (skipped during ArrowUp/Down nav).
 */
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
  Clock,
} from 'lucide-react';
import {
  useFileTree,
  hoverActions,
  uiActions,
  useSidebarCollapsed,
  useShowHoverPanel,
  useLanguage,
} from '../../core/stores/zustand';
import { Dialog, KeyboardHint } from '../../design-system/components';
import { t, tf } from '../../core/utils/i18n';
import { searchCommands } from '../../core/services/tauriCommands';
import type { FileNode, SearchResult } from '../../core/types';

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
  /** When set, this row renders the snippet (content-search match). */
  snippet?: string;
}
interface PaletteHeader {
  type: 'header';
  id: string;
  label: string;
}
type PaletteItem = PaletteCommand | PaletteNote | PaletteHeader;

const MAX_NOTE_RESULTS = 30;
const MAX_CONTENT_RESULTS = 20;
const MAX_RECENT_RESULTS = 8;
const CONTENT_SEARCH_DEBOUNCE_MS = 200;
const CONTENT_SEARCH_MIN_CHARS = 2;

/**
 * Flatten the file tree into a list of note paths (.md only).
 * Folders/attachments are excluded — only navigable notes.
 */
function flattenNotes(tree: FileNode[]): Array<{ name: string; path: string; mtime?: number }> {
  const out: Array<{ name: string; path: string; mtime?: number }> = [];
  const walk = (nodes: FileNode[]) => {
    for (const n of nodes) {
      if (n.is_dir) {
        if (n.children) walk(n.children);
      } else if (n.name.toLowerCase().endsWith('.md')) {
        out.push({
          name: n.name.replace(/\.md$/i, ''),
          path: n.path,
          mtime: n.mtime,
        });
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
  const sidebarCollapsed = useSidebarCollapsed();
  const showHoverPanel = useShowHoverPanel();

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [contentResults, setContentResults] = useState<SearchResult[]>([]);
  const [contentLoading, setContentLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    setQuery('');
    setActiveIndex(0);
    setContentResults([]);
    setContentLoading(false);
  }, []);

  // Listen for the Ctrl+K window event dispatched by useAppKeyboardShortcuts.
  useEffect(() => {
    const handler = () => {
      setOpen(true);
      setQuery('');
      setActiveIndex(0);
      setContentResults([]);
    };
    window.addEventListener('open-command-palette', handler);
    return () => window.removeEventListener('open-command-palette', handler);
  }, []);

  /** Debounced full-text search. Runs only when query length crosses
   *  the minimum threshold — otherwise we'd hit Tantivy on every keystroke. */
  useEffect(() => {
    const q = query.trim();
    if (!open || q.length < CONTENT_SEARCH_MIN_CHARS) {
      setContentResults([]);
      setContentLoading(false);
      return;
    }
    setContentLoading(true);
    const handle = setTimeout(async () => {
      try {
        const results = await searchCommands.fullTextSearch(q, MAX_CONTENT_RESULTS);
        setContentResults(results);
      } catch (err) {
        console.warn('[CommandPalette] full-text search failed', err);
        setContentResults([]);
      } finally {
        setContentLoading(false);
      }
    }, CONTENT_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [query, open]);

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
        matchText: t('cmdToggleSidebar', language) + ' sidebar 사이드바 축소',
        onSelect: () => uiActions.setSidebarCollapsed(!sidebarCollapsed),
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
  }, [language, sidebarCollapsed, showHoverPanel]);

  /** All notes in vault (memoized — flatten + matchText only when tree changes). */
  const allNotes = useMemo(() => flattenNotes(fileTree), [fileTree]);

  /** Recent notes: mtime-sorted, top N. Same approach as the mobile
   *  SearchView. Falls back to first-N when mtime is missing on all rows. */
  const recentNotes = useMemo<PaletteNote[]>(() => {
    const sorted = [...allNotes].sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0));
    return sorted.slice(0, MAX_RECENT_RESULTS).map((n) => ({
      type: 'note' as const,
      id: `recent:${n.path}`,
      name: n.name,
      path: n.path,
      matchText: n.name + ' ' + n.path,
    }));
  }, [allNotes]);

  /** Filtered + ranked items, split into sections with headers. */
  const items = useMemo<PaletteItem[]>(() => {
    const q = query.trim();
    const out: PaletteItem[] = [];

    if (!q) {
      // Empty query: recent notes first (the most useful default), then commands.
      if (recentNotes.length > 0) {
        out.push({ type: 'header', id: 'h-recent', label: t('cmdPaletteSectionRecent', language) });
        out.push(...recentNotes);
      }
      out.push({ type: 'header', id: 'h-actions', label: t('cmdPaletteSectionActions', language) });
      out.push(...commands);
      return out;
    }

    // Query-driven: fuzzy filename → "노트", Tantivy hits → "본문 검색", filtered cmds → "명령".
    const noteRanked: PaletteNote[] = allNotes
      .map((n) => ({ n, score: fuzzyScore(q, n.name + ' ' + n.path) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_NOTE_RESULTS)
      .map((x) => ({
        type: 'note' as const,
        id: `note:${x.n.path}`,
        name: x.n.name,
        path: x.n.path,
        matchText: x.n.name + ' ' + x.n.path,
      }));

    // Content matches — dedupe against filename matches so a note doesn't
    // appear twice (once as a filename hit and once as a body hit).
    const filenameMatched = new Set(noteRanked.map((n) => n.path));
    const contentMatches: PaletteNote[] = contentResults
      .filter((r) => !filenameMatched.has(r.path))
      .map((r) => ({
        type: 'note' as const,
        id: `content:${r.path}`,
        name: r.title || r.path.split(/[/\\]/).pop() || r.path,
        path: r.path,
        matchText: r.title + ' ' + r.path,
        snippet: r.snippet,
      }));

    const cmdRanked = commands
      .map((c) => ({ c, score: fuzzyScore(q, c.matchText) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((x) => x.c);

    // "Search this query in the full Search panel" — always at the top of
    // the Actions section when the user has typed anything substantial.
    const searchPanelCmd: PaletteCommand = {
      type: 'command',
      id: 'searchPanelHere',
      label: tf('cmdSearchPanelHere', language, { query: q }),
      icon: <Search size={14} />,
      matchText: 'search panel ' + q,
      onSelect: () => {
        uiActions.setShowSearch(true);
        window.dispatchEvent(new CustomEvent('open-search-with-query', { detail: { query: q } }));
      },
    };

    if (noteRanked.length > 0) {
      out.push({ type: 'header', id: 'h-notes', label: t('cmdPaletteSectionNotes', language) });
      out.push(...noteRanked);
    }
    if (contentMatches.length > 0 || contentLoading) {
      out.push({ type: 'header', id: 'h-content', label: t('cmdPaletteSectionContent', language) });
      if (contentLoading && contentMatches.length === 0) {
        // Loading placeholder as a header-only row so users see "검색 중...".
        out.push({ type: 'header', id: 'h-content-loading', label: t('cmdContentSearching', language) });
      }
      out.push(...contentMatches);
    }
    out.push({ type: 'header', id: 'h-actions', label: t('cmdPaletteSectionActions', language) });
    out.push(searchPanelCmd, ...cmdRanked);

    return out;
  }, [query, commands, allNotes, recentNotes, contentResults, contentLoading, language]);

  /** Indices of selectable rows — used for keyboard nav to skip headers. */
  const selectableIndices = useMemo(() => {
    const idx: number[] = [];
    items.forEach((it, i) => { if (it.type !== 'header') idx.push(i); });
    return idx;
  }, [items]);

  // Clamp activeIndex to the first selectable row when items change.
  useEffect(() => {
    if (selectableIndices.length === 0) {
      setActiveIndex(0);
      return;
    }
    if (!selectableIndices.includes(activeIndex)) {
      setActiveIndex(selectableIndices[0]);
    }
  }, [selectableIndices, activeIndex]);

  const handleSelect = useCallback(
    (item: PaletteItem) => {
      if (item.type === 'header') return;
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
    if (selectableIndices.length === 0) return;
    const currentPos = selectableIndices.indexOf(activeIndex);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const next = currentPos < 0 ? 0 : (currentPos + 1) % selectableIndices.length;
      setActiveIndex(selectableIndices[next]);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const next = currentPos < 0
        ? selectableIndices.length - 1
        : (currentPos - 1 + selectableIndices.length) % selectableIndices.length;
      setActiveIndex(selectableIndices[next]);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const item = items[activeIndex];
      if (item) handleSelect(item);
    } else if (e.key === 'Home') {
      e.preventDefault();
      setActiveIndex(selectableIndices[0]);
    } else if (e.key === 'End') {
      e.preventDefault();
      setActiveIndex(selectableIndices[selectableIndices.length - 1]);
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
            onChange={(e) => { setQuery(e.target.value); }}
            spellCheck={false}
            autoComplete="off"
          />
          <KeyboardHint keys={['Esc']} size="sm" className="command-palette__hint" />
        </div>

        <div ref={listRef} className="command-palette__list" role="listbox">
          {selectableIndices.length === 0 ? (
            <div className="command-palette__empty">{t('commandPaletteNoResults', language)}</div>
          ) : (
            items.map((item, idx) => {
              if (item.type === 'header') {
                return (
                  <div key={item.id} className="command-palette__section-header" role="presentation">
                    {item.label}
                  </div>
                );
              }
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
              // Note row (recent / filename match / content match)
              const isRecent = item.id.startsWith('recent:');
              const isContent = item.id.startsWith('content:');
              return (
                <div
                  key={item.id}
                  role="option"
                  aria-selected={active}
                  data-palette-index={idx}
                  className={cls + (item.snippet ? ' command-palette__row--with-snippet' : '')}
                  onMouseEnter={() => setActiveIndex(idx)}
                  onClick={() => handleSelect(item)}
                >
                  <span className="command-palette__row-icon" aria-hidden="true">
                    {isRecent ? <Clock size={14} /> : isContent ? <Search size={14} /> : <FileIcon size={14} />}
                  </span>
                  <div className="command-palette__row-body">
                    <span className="command-palette__row-label">{item.name}</span>
                    {item.snippet && (
                      <span className="command-palette__row-snippet">{item.snippet}</span>
                    )}
                  </div>
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
