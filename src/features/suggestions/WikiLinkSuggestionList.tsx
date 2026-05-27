import { forwardRef, useImperativeHandle, useMemo, useState, useEffect } from 'react';
import { Search, Filter, ArrowLeft } from 'lucide-react';
import { useFileLookupStore, fileLookupActions } from '../../core/stores/fileLookupStore';
import { useSuggestionList } from '../../core/hooks/useSuggestionList';
import { useNoteTypeCacheStore, noteTypeCacheActions } from '../content-cache/stores/noteTypeCacheStore';
import { useTemplateStore } from '../templates/stores/templateStore';
import { useSettingsStore } from '../../core/stores/settingsStore';
import { t } from '../../core/utils/i18n';

interface WikiLinkSuggestionListProps {
  items: Array<{ fileName: string; path: string }>;
  command: (props: any) => void;
  /** Current query the user is typing after `[[`. TipTap suggestion passes this in. */
  query?: string;
}

export interface WikiLinkSuggestionListRef {
  onKeyDown: (props: { event: KeyboardEvent }) => boolean;
}

/**
 * Stage 5.0.5a-γ5 v6 (2026-05-16, HanBin) — Tab-toggled template filter.
 *
 * UX flow:
 *   1) `[[`        → popover opens with all matching notes
 *   2) `Tab`       → switches to template-category picker (Notes / Entity /
 *                    Document / Sketch + each custom template)
 *   3) pick one    → returns to note list filtered by that template's
 *                    frontmatter `type:`. Header shows "▼ {template} 검색 중"
 *   4) `Tab` again → back to "all notes" mode
 *
 * Notes' type comes from noteTypeCacheStore (populated by frontmatter
 * scanner). When no type cached, the note is included in the "all" view
 * but excluded from any specific template filter.
 */

type ViewMode = 'list' | 'template-picker';

export const WikiLinkSuggestionList = forwardRef<
  WikiLinkSuggestionListRef,
  WikiLinkSuggestionListProps
>((props, ref) => {
  const fileLookupVersion = useFileLookupStore((s) => s.version);
  const noteTypeCache = useNoteTypeCacheStore((s) => s.cache);
  const noteTemplates = useTemplateStore((s) => s.noteTemplates);
  const language = useSettingsStore((s) => s.language);

  const [mode, setMode] = useState<ViewMode>('list');
  // Selected template's frontmatter `type:` value (e.g., 'NOTE', 'ENTITY').
  // null = "all" (no filter).
  const [typeFilter, setTypeFilter] = useState<string | null>(null);

  // Resolve the list of unique frontmatter types present in the vault — drives
  // the template-picker view (only show templates that have ≥ 1 note OR are
  // builtin defaults, so user always sees the canonical 3-category set).
  const templateOptions = useMemo(() => {
    const seenTypes = new Set<string>();
    for (const t of noteTemplates) {
      const type = t.frontmatter?.type;
      if (typeof type === 'string') seenTypes.add(type.toUpperCase());
    }
    return noteTemplates
      .filter(t => typeof t.frontmatter?.type === 'string')
      .map(t => ({
        id: t.id,
        name: t.name,
        prefix: t.prefix,
        type: String(t.frontmatter!.type).toUpperCase(),
        cssclasses: (t.frontmatter?.cssclasses as string[] | undefined)?.[0] || '',
      }));
  }, [noteTemplates]);

  // Filter the note list by:
  //   1. Resolves: drop notes that no longer exist in the vault
  //   2. typeFilter (if active): note's cached type must match
  //
  // v18 fix (2026-05-16, HanBin) — `noteTypeCache` is a `Map<string,string>`,
  // not a plain object. The earlier `noteTypeCache[item.fileName]` access
  // returned undefined for EVERY item → filter dropped all notes when a
  // template was selected ("TEST3 필터인데 해당 템플릿의 노트 ddddd 안 잡힘").
  // Now we route through `noteTypeCacheActions.getNoteType()` which also
  // does a lazy-fetch fallback (search index + content cache + frontmatter
  // load) for notes that haven't been indexed yet.
  const filteredItems = useMemo(() => {
    return props.items.filter(item => {
      const resolved = fileLookupActions.resolveNotePath(item.fileName);
      if (resolved === null) return false;
      if (typeFilter) {
        const noteType = noteTypeCacheActions.getNoteType(item.fileName);
        if (!noteType) return false;
        if (noteType.toUpperCase() !== typeFilter) return false;
      }
      return true;
    });
    // noteTypeCache referenced for reactivity — Map identity changes on
    // refreshCache, triggering re-filter after async type lookups.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.items, fileLookupVersion, typeFilter, noteTypeCache]);

  // Reset selected index when the underlying list changes (filter swap, etc.)
  // v7 fix (2026-05-16, HanBin): removed 'Tab' from acceptKeys — outer
  // onKeyDown intercepts Tab for the template-picker toggle. Enter alone
  // commits the selection in list mode.
  // v18 fix (2026-05-16) — added autoScroll + listRef so keyboard ↑↓ scrolls
  // the active row into view. Previously the list could overflow past the
  // popover but pressing ↓ wouldn't follow the highlight.
  const {
    activeIndex,
    onKeyDown: baseOnKeyDown,
    setActiveIndex,
    listRef: listRefList,
  } = useSuggestionList(
    filteredItems,
    (item) => props.command({ fileName: item.fileName }),
    { acceptKeys: ['Enter'], autoScroll: true },
  );

  // v18 fix (2026-05-16) — picker keyboard nav now includes "전체 노트" as
  // the first virtual entry (index 0). Previously this row sat OUTSIDE the
  // rotation and the user couldn't reach it via ↑↓, plus the initial
  // pickerIndex=0 left no row highlighted (or worse, highlighted the wrong
  // one). Sentinel `{ id: '__all__', ... }` flags the reset path inside
  // the select handler.
  type PickerEntry = { id: string; name: string; prefix: string; type: string; cssclasses: string };
  const pickerEntries: PickerEntry[] = useMemo(() => [
    { id: '__all__', name: '', prefix: '', type: '', cssclasses: '' },
    ...templateOptions,
  ], [templateOptions]);

  const {
    activeIndex: pickerIndex,
    onKeyDown: pickerOnKeyDown,
    setActiveIndex: setPickerIndex,
    listRef: listRefPicker,
  } = useSuggestionList(
    pickerEntries,
    (opt) => {
      if (opt.id === '__all__') {
        setTypeFilter(null);
      } else {
        setTypeFilter(opt.type);
      }
      setMode('list');
      setActiveIndex(0);
    },
    { acceptKeys: ['Enter'], autoScroll: true },
  );

  // Reset both indices when mode changes so we always start at the top.
  useEffect(() => {
    if (mode === 'list') setActiveIndex(0);
    else setPickerIndex(0);
  }, [mode, setActiveIndex, setPickerIndex]);

  useImperativeHandle(ref, () => ({
    onKeyDown: ({ event }) => {
      // Tab: toggle the mode. In list mode → open template picker; in
      // picker mode → exit back to list (or clear filter).
      if (event.key === 'Tab') {
        event.preventDefault();
        if (mode === 'list') {
          setMode('template-picker');
          return true;
        }
        // From picker → back to list, keeping current filter.
        setMode('list');
        return true;
      }
      // Escape inside picker mode → exit picker (don't dismiss popover).
      if (event.key === 'Escape' && mode === 'template-picker') {
        event.preventDefault();
        setMode('list');
        return true;
      }
      // Clear filter shortcut: when in list mode with active filter, Backspace
      // at empty query clears the filter (caller handles query). For now: a
      // dedicated "필터 지우기" row at the top of the list handles this via click.
      return mode === 'list' ? baseOnKeyDown(event) : pickerOnKeyDown(event);
    },
  }));

  const query = props.query ?? '';
  // Stage 5.0.5a-γ5 v9 — i18n keys + single-language strings (was bilingual
  // hardcoded; HanBin: "타이핑해서 노트 검색 — Tab to filter by templa..."
  // 가 너무 길고 언어 전환 무시).
  const placeholder = mode === 'template-picker'
    ? t('suggestionTemplatePicker', language)
    : t('suggestionSearchNotes', language);
  const headerNode = (
    <div className="suggestion-search">
      <Search size={14} className="suggestion-search__icon" />
      <span className={`suggestion-search__query${query ? '' : ' suggestion-search__query--empty'}`}>
        {query || placeholder}
      </span>
      {mode === 'list' && (
        <button
          type="button"
          className={`suggestion-filter-btn${typeFilter ? ' is-active' : ''}`}
          onClick={() => setMode('template-picker')}
          title={t('suggestionTabFilter', language)}
        >
          <Filter size={12} />
          {typeFilter ? <span>{typeFilter}</span> : <kbd>Tab</kbd>}
        </button>
      )}
    </div>
  );

  // ── Template picker view ─────────────────────────────────────────
  if (mode === 'template-picker') {
    return (
      <div ref={listRefPicker} className="wiki-link-suggestion-list">
        {headerNode}
        <div className="wiki-link-suggestion-section-label">
          <ArrowLeft size={12} />
          <span>{t('suggestionTemplatePickerHint', language)}</span>
        </div>
        {pickerEntries.map((opt, index) => {
          const isAll = opt.id === '__all__';
          const isActive = index === pickerIndex;
          return (
            <button
              key={opt.id}
              type="button"
              data-suggestion-index={index}
              className={`wiki-link-suggestion-item${isActive ? ' selected' : ''}${!isAll && opt.cssclasses ? ' ' + opt.cssclasses : ''}`}
              onMouseEnter={() => setPickerIndex(index)}
              onClick={() => {
                if (isAll) setTypeFilter(null);
                else setTypeFilter(opt.type);
                setMode('list');
              }}
            >
              <div className="wiki-link-suggestion-item-name">
                {isAll ? t('suggestionAllNotes', language) : opt.name}
              </div>
              <div className="wiki-link-suggestion-item-path">
                {isAll ? t('suggestionAllNotesHint', language) : `${opt.prefix} · type=${opt.type}`}
              </div>
            </button>
          );
        })}
      </div>
    );
  }

  // ── Note list view (with optional template filter) ────────────────
  if (filteredItems.length === 0) {
    return (
      <div className="wiki-link-suggestion-list">
        {headerNode}
        <div className="wiki-link-suggestion-empty">
          {typeFilter
            ? `${t('suggestionFilterEmpty', language)} · ${t('suggestionFilterEmptyHint', language)}`
            : t('suggestionFilterEmpty', language)}
        </div>
      </div>
    );
  }

  return (
    <div ref={listRefList} className="wiki-link-suggestion-list">
      {headerNode}
      {filteredItems.map((item, index) => (
        <button
          key={item.path}
          data-suggestion-index={index}
          className={`wiki-link-suggestion-item${index === activeIndex ? ' selected' : ''}`}
          onMouseEnter={() => setActiveIndex(index)}
          onClick={() => props.command({ fileName: item.fileName })}
        >
          <div className="wiki-link-suggestion-item-name">{item.fileName.replace(/_/g, ' ')}</div>
          <div className="wiki-link-suggestion-item-path">{item.path}</div>
        </button>
      ))}
    </div>
  );
});

WikiLinkSuggestionList.displayName = 'WikiLinkSuggestionList';

export default WikiLinkSuggestionList;
