
import { useAttachmentStore } from '../attachments/stores/attachmentStore';
import { useState, useEffect, useCallback, useMemo, useRef, lazy, Suspense, type CSSProperties } from 'react';
import { searchCommands, utilCommands } from '../../core/services/tauriCommands';
import { FilePlus, Filter, Search as SearchIcon, X as XIcon, ArrowUpDown, WholeWord, Library } from 'lucide-react';
import { useHoverStore, hoverActions } from '../hover-windows/stores/hoverStore';
import { useVaultPath } from '../../core/stores/fileTreeStore';
import { fileTreeActions } from '../../core/stores/fileTreeStore';
import { useSearchReady, useSearchIndexing, useRefreshStore } from '../../core/stores/refreshStore';
import { refreshActions } from '../../core/stores/refreshStore';
import { modalActions } from '../modals/stores/modalStore';
import { useSettingsStore } from '../../core/stores/settingsStore';
import { useTemplateStore } from '../templates/stores/templateStore';
import { useIsNasSynced, useIsBulkSyncing } from '../vault-config/stores/vaultConfigStore';
import { selectContainer, refreshHoverWindowsForFile } from '../../core/stores/appActions';
import { contentCacheActions } from '../content-cache/stores/contentCacheStore';
import type { NoteFilter, NoteMetadata, SearchResult, SearchMode } from '../../core/types';
import { t, tf, type LanguageSetting } from '../../core/utils/i18n';
import { getTemplateCustomColor as getTemplateColor } from '../content-cache/noteTypeHelpers';
import { FilterAddButton, FilterChipList, AnchoredPopover, type FilterField } from './FilterChipBar';
import { NOTE_TYPES } from './searchHelpers';
import { observe } from '../dobbin/observe';
import { FrontmatterResultRow, ContentResultCard } from './SearchResultItem';
import AttachmentsTab, { TIER_KEYS, SYNC_KEYS, type TierKey, type SyncState } from './AttachmentsTab';
import { useNoteIdToPath } from './useNoteIdToPath';
import { fileLookupActions } from '../../core/stores/fileLookupStore';
import BulkTagModal from '../modals/BulkTagModal';
// FloatingWords 컴포넌트는 2026-05-22 시점에 컨텐츠 탭 빈-상태에서
// 제거되었습니다(HanBin: 화면보호기 같이 느껴지고 효용 X). 컴포넌트
// 파일 자체는 그래프/다른 view에서 재사용 가능성 있어 유지.
// 5.0.7a (2026-05-17, HanBin) — design-system primitives. Search input
// + filter toggle buttons swap to <Input> + <IconButton pressed> so the
// toolbar rides theme tokens directly + gains aria-pressed.
import { Input, IconButton, sortGlyph, SORT_ASC, SORT_DESC } from '../../design-system/components';

// 🔴 `GraphView` 선언이 없어 그래프 탭이 검은 화면이었다 (2026-08-11).
//    본가(데스크톱)에도 없다 — `<GraphView>`를 쓰면서 `lazy` 임포트 줄이
//    어느 시점에 사라진 채였다. 웹에서 처음 드러났을 뿐이다.
//    `lazy`로 받는다: 그래프는 202KB짜리라 탭을 눌러야 받는 게 맞다.
const GraphView = lazy(() => import('../graph/GraphView'));


// Conditional logging - only in development
const DEV = import.meta.env.DEV;
const log = DEV ? console.log.bind(console) : () => {};

function stripTagNamespace(tag: string): string {
  if (tag.startsWith('domain/')) return tag.substring(7);
  if (tag.startsWith('who/')) return tag.substring(4);
  if (tag.startsWith('org/')) return tag.substring(4);
  if (tag.startsWith('ctx/')) return tag.substring(4);
  return tag;
}

function formatDateRange(after: string, before: string): string {
  if (after && before) return `${after} ~ ${before}`;
  if (after) return `${after} ~`;
  if (before) return `~ ${before}`;
  return '';
}

/** Small sort dropdown used in the Contents tab. Mirrors the
 *  FilterAddButton visual (ghost trigger + AnchoredPopover with field
 *  list popover) so the toolbar feels coherent. */
function ContentsSortDropdown({
  value,
  onChange,
  language,
}: {
  value: 'relevance' | 'title' | 'path';
  onChange: (v: 'relevance' | 'title' | 'path') => void;
  language: LanguageSetting;
}) {
  const [open, setOpen] = useState(false);
  const options: { value: 'relevance' | 'title' | 'path'; label: string }[] = [
    { value: 'relevance', label: t('sortByRelevance', language) },
    { value: 'title', label: t('sortByTitle', language) },
    { value: 'path', label: t('sortByPath', language) },
  ];
  return (
    <AnchoredPopover
      open={open}
      onOpenChange={setOpen}
      placement="bottom-end"
      trigger={(refProps) => (
        <button
          type="button"
          className="search-filter-trigger"
          aria-label={t('sortLabel', language)}
          title={t('sortLabel', language)}
          {...refProps}
        >
          <ArrowUpDown size={14} />
        </button>
      )}
    >
      <div className="filter-chip-popover__field-list" role="menu">
        {options.map(o => (
          <button
            key={o.value}
            type="button"
            role="menuitem"
            className={`filter-chip-popover__field-list-item${value === o.value ? ' is-selected' : ''}`}
            onClick={() => { onChange(o.value); setOpen(false); }}
          >
            {o.label}
          </button>
        ))}
      </div>
    </AnchoredPopover>
  );
}

function formatMultiValue(labels: string[]): string {
  if (labels.length === 0) return '';
  if (labels.length === 1) return labels[0];
  if (labels.length === 2) return labels.join(', ');
  return `${labels[0]}, ${labels[1]} +${labels.length - 2}`;
}

interface SearchProps {
  containerPath?: string | null;
  refreshTrigger?: number;
  onCreateNote?: (e?: React.MouseEvent) => void;
  onCreateFolder?: () => void;
}

function Search({ containerPath, refreshTrigger, onCreateNote }: SearchProps) {
  const searchReady = useSearchReady();
  const searchIndexing = useSearchIndexing();
  const vaultPath = useVaultPath();
  // PART 6 (HanBin 2026-05-13): attachments tab count flows through the
  // shared `.search-status-bar` like every other tab. AttachmentsTab no
  // longer renders its own footer — that broke layout parity with 노트 /
  // 본문 / 상세.
  const attachmentRefCount = useAttachmentStore((s) => s.index.byId.size);
  // 2026-05-22 — pull the full attachment index for filter autocomplete
  // (extension pool). Cheap reference equality — re-renders only when
  // refs are added / removed, not on field edits.
  const attachmentRefsById = useAttachmentStore((s) => s.index.byId);
  const noteTemplates = useTemplateStore(s => s.noteTemplates);
  const language = useSettingsStore(s => s.language);
  const isBulkSyncing = useIsBulkSyncing();
  const isNasSynced = useIsNasSynced();

  // Helper function to get template custom color by note type
  const getTemplateCustomColor = useCallback((noteType: string): string | undefined => {
    return getTemplateColor(noteType, noteTemplates);
  }, [noteTemplates]);

  const [frontmatterQuery, setFrontmatterQuery] = useState('');
  const [contentsQuery, setContentsQuery] = useState('');
  const [attachmentsQuery, setAttachmentsQuery] = useState('');
  const [mode, setMode] = useState<SearchMode>('frontmatter');
  const [notes, setNotes] = useState<NoteMetadata[]>([]);
  const [contentResults, setContentResults] = useState<SearchResult[]>([]);
  // attachmentResults state retired 2026-05-20 — `<AttachmentsTab>` v2
  // reads from the AttachmentRef index (`useAttachmentStore`) directly.
  // Legacy `searchCommands.searchAttachments` Tauri call still exists
  // for the mobile SearchView only (separate migration track).
  const [sortBy, setSortBy] = useState('modified');
  const [sortOrder, setSortOrder] = useState('desc');
  // Tag sort: category selection for tag-based sorting
  const [tagSortCategory, setTagSortCategory] = useState<string | null>(null);
  const [showTagCategoryMenu, setShowTagCategoryMenu] = useState(false);
  const tagHeaderRef = useRef<HTMLDivElement>(null);
  // Date filters
  const [createdAfter, setCreatedAfter] = useState('');
  const [createdBefore, setCreatedBefore] = useState('');
  const [modifiedAfter, setModifiedAfter] = useState('');
  const [modifiedBefore, setModifiedBefore] = useState('');
  // 2026-05-22 — `showDateFilters` removed. The Frontmatter chip bar
  // shows/hides itself automatically based on whether any filter is
  // active; the toolbar Filter button is now a popover trigger (not a
  // panel toggle), so there's no second-click "on/off" state to track.
  // Frontmatter tab filters
  const [frontmatterTypeFilter, setFrontmatterTypeFilter] = useState('');
  const [frontmatterTagFilter, setFrontmatterTagFilter] = useState('');
  const [frontmatterMemoFilter, setFrontmatterMemoFilter] = useState<'all' | 'has' | 'none'>('all');
  const [showFolderNotes, setShowFolderNotes] = useState(true);
  // Contents tab filters (2026-05-22 — chip filter, no static panel toggle).
  const [contentsTypeFilter, setContentsTypeFilter] = useState('');
  // 2026-05-22 — body-content sort. 'relevance' uses the backend score
  // order (default); the others are client-side reorders of the same
  // result set, so swapping is instant + cheap.
  const [contentsSortBy, setContentsSortBy] = useState<'relevance' | 'title' | 'path'>('relevance');
  // 2026-05-22 — body-content power-user toggle. When on, query is sent
  // as a quoted phrase (`"foo"`), letting Tantivy match the whole word
  // instead of as a tokenized prefix.
  const [contentsWholeWord, setContentsWholeWord] = useState(false);
  // 2026-05-22 — recent contents searches (vault-scoped, ≤8 entries).
  // Stored to localStorage so they survive reloads; reads in lazy init
  // so component mount doesn't block on storage.
  const recentKey = vaultPath ? `notology.recentContentsSearches.${vaultPath}` : null;
  const [recentSearches, setRecentSearches] = useState<string[]>(() => {
    if (!recentKey) return [];
    try {
      const raw = localStorage.getItem(recentKey);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.slice(0, 8) : [];
    } catch { return []; }
  });
  const recordRecentSearch = useCallback((q: string) => {
    const trimmed = q.trim();
    if (!trimmed || !recentKey) return;
    setRecentSearches(prev => {
      const next = [trimmed, ...prev.filter(x => x !== trimmed)].slice(0, 8);
      try { localStorage.setItem(recentKey, JSON.stringify(next)); } catch { /* quota */ }
      return next;
    });
  }, [recentKey]);
  const clearRecentSearches = useCallback(() => {
    if (recentKey) {
      try { localStorage.removeItem(recentKey); } catch { /* noop */ }
    }
    setRecentSearches([]);
  }, [recentKey]);
  // 2026-05-22 — attachment filter state lifted up from AttachmentsTab
  // so Search.tsx can own the FilterAddButton + FilterChipList in the
  // toolbar (unified with Frontmatter/Contents). AttachmentsTab now
  // receives these as props and stops rendering its own static panel.
  // `showAttachmentsFilters` is gone for the same reason — the chip
  // bar is self-showing (only mounts when ≥1 chip is active).
  const [attachmentExtensionFilter, setAttachmentExtensionFilter] = useState('');
  const [attachmentNotePathFilter, setAttachmentNotePathFilter] = useState('');
  // 2026-05-22 — tier + sync state filters lifted up (formerly the
  // FilterBar pill row inside AttachmentsTab). Sets so user can pick
  // any combination; absorbed into the chip filter system.
  const [attachmentTierFilter, setAttachmentTierFilter] = useState<Set<TierKey>>(new Set());
  const [attachmentSyncFilter, setAttachmentSyncFilter] = useState<Set<SyncState>>(new Set());
  const toggleAttachmentTier = useCallback((k: string) => {
    setAttachmentTierFilter(prev => {
      const next = new Set(prev);
      if (next.has(k as TierKey)) next.delete(k as TierKey);
      else next.add(k as TierKey);
      return next;
    });
  }, []);
  const toggleAttachmentSync = useCallback((k: string) => {
    setAttachmentSyncFilter(prev => {
      const next = new Set(prev);
      if (next.has(k as SyncState)) next.delete(k as SyncState);
      else next.add(k as SyncState);
      return next;
    });
  }, []);
  // Multi-select notes (Ctrl+click, Shift+click; Container single-click also uses this)
  const [selectedNotePaths, setSelectedNotePaths] = useState<Set<string>>(new Set());
  const lastSelectedNoteRef = useRef<string | null>(null);

  // 2026-05-22 — selectionMode toggle removed entirely. All tabs use
  // Excel-style row clicks (single = select, double = open, Ctrl/Shift
  // = multi/range). No checkbox column anywhere.
  // Refs for stable callbacks (avoid dependency churn)
  const selectedNotePathsRef = useRef(selectedNotePaths);
  selectedNotePathsRef.current = selectedNotePaths;
  const filteredNotesRef = useRef<NoteMetadata[]>([]);

  // Optimistic patch: instantly update notes[] when HoverEditor saves (bypasses Tantivy)
  useEffect(() => {
    const unsub = useRefreshStore.subscribe(
      (state) => state.lastNotePatch,
      (patch) => {
        if (!patch) return;
        setNotes((prev) => {
          const idx = prev.findIndex((n) => n.path === patch.meta.path);
          if (idx >= 0) {
            const updated = [...prev];
            updated[idx] = patch.meta;
            return updated;
          }
          // 🔴 **새로 생긴 노트는 넣어준다.** 예전엔 목록에 없으면 그냥
          //    버렸다 — 고친 노트만 따라오고 **새 노트는 영영 안 보였다.**
          //    dobbin이 노트를 만드는 것이 이 서재의 본업인데(3단계),
          //    그게 화면에 안 나타나면 만든 적이 없는 것과 같다.
          return [patch.meta, ...prev];
        });
      }
    );
    return unsub;
  }, []);

  // 5.0.7a (2026-05-17, HanBin) — Cmd-K palette punt: when the user picks
  // "Search '<query>' in panel", the palette dispatches this event with
  // the query string. We pre-fill the Contents tab so they land on the
  // body-search view already populated.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ query: string }>).detail;
      if (!detail?.query) return;
      setMode('contents');
      setContentsQuery(detail.query);
    };
    window.addEventListener('open-search-with-query', handler);
    return () => window.removeEventListener('open-search-with-query', handler);
  }, []);

  // Frontmatter mode search — refreshTrigger excluded from deps (triggered by useEffect below)
  const searchReadyRef = useRef(searchReady);
  searchReadyRef.current = searchReady;
  const searchIndexingRef = useRef(searchIndexing);
  searchIndexingRef.current = searchIndexing;
  const sortByRef = useRef(sortBy);
  sortByRef.current = sortBy;
  const sortOrderRef = useRef(sortOrder);
  sortOrderRef.current = sortOrder;
  const dateFiltersRef = useRef({ createdAfter, createdBefore, modifiedAfter, modifiedBefore });
  dateFiltersRef.current = { createdAfter, createdBefore, modifiedAfter, modifiedBefore };

  const fetchNotes = useCallback(async () => {
    if (!searchReadyRef.current || searchIndexingRef.current) return;

    const df = dateFiltersRef.current;
    // Tags sorting is done client-side; fallback to modified for backend
    const backendSortBy = sortByRef.current === 'tags' ? 'modified' : sortByRef.current;
    const filter: NoteFilter = {
      sort_by: backendSortBy,
      sort_order: sortOrderRef.current,
      created_after: df.createdAfter || undefined,
      created_before: df.createdBefore || undefined,
      modified_after: df.modifiedAfter || undefined,
      modified_before: df.modifiedBefore || undefined,
    };

    try {
      const results = await searchCommands.queryNotes(filter);
      setNotes(results);
    } catch (err) {
      console.error('Failed to query notes:', err);
    }
  }, []);

  // Contents mode search - uses ref to avoid recreating callback on every query change
  const contentsQueryRef = useRef(contentsQuery);
  contentsQueryRef.current = contentsQuery;

  const vaultPathRef = useRef(vaultPath);
  vaultPathRef.current = vaultPath;
  const attachmentsQueryRef = useRef(attachmentsQuery);
  attachmentsQueryRef.current = attachmentsQuery;

  const contentsWholeWordRef = useRef(contentsWholeWord);
  contentsWholeWordRef.current = contentsWholeWord;
  const recordRecentSearchRef = useRef(recordRecentSearch);
  recordRecentSearchRef.current = recordRecentSearch;
  const searchContents = useCallback(async () => {
    const query = contentsQueryRef.current.trim();
    if (!searchReadyRef.current || searchIndexingRef.current || !query) {
      setContentResults([]);
      return;
    }

    try {
      // Whole-word toggle: wrap the query in quotes so Tantivy treats
      // it as a phrase query and matches the term as a whole token
      // (e.g. "cat" won't match "catalog"). Multi-word phrases stay
      // phrase-quoted too — Tantivy handles that natively.
      const effectiveQuery = contentsWholeWordRef.current ? `"${query}"` : query;
      // 🔴 **어떻게 찾는가**가 그 사람의 스타일이다. 질의만 보낸다 — 본문은
      //    이미 서버에 있고, 로그가 자료의 사본이 되면 그 자체가 관리 대상이 된다.
      observe('search', effectiveQuery);
      const results = await searchCommands.fullTextSearch(effectiveQuery, 50);
      if (query === contentsQueryRef.current.trim()) {
        setContentResults(results);
      }
      // 2026-05-23 — recent-search recording was previously done HERE on every
      // 100 ms debounce tick, which polluted history with Korean IME
      // intermediate states ("스", "스ㅋ", "스케", "시", "개", "게", …). Moved
      // to a separate, slower stabilization-based effect below so we only
      // record once the user has stopped typing (committed the query).
    } catch (err) {
      console.error('Failed to search contents:', err);
      setContentResults([]);
    }
  }, []);

  // `searchAttachments` retired 2026-05-20 — AttachmentsTab v2 reads
  // from the in-memory AttachmentRef index directly, so there's no
  // need for the round-trip filesystem scan the legacy command performed.

  // Single trigger for frontmatter-mode metadata refresh
  useEffect(() => {
    if (mode === 'frontmatter') {
      fetchNotes();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, searchReady, searchIndexing, sortBy, sortOrder, createdAfter, createdBefore, modifiedAfter, modifiedBefore, refreshTrigger]);

  useEffect(() => {
    if (mode === 'contents') {
      if (!contentsQuery.trim()) {
        setContentResults([]);
        return;
      }
      const timeout = setTimeout(searchContents, 100);
      return () => clearTimeout(timeout);
    }
  // contentsWholeWord deliberately included so toggling re-runs the search.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, contentsQuery, contentsWholeWord, searchReady, searchIndexing, refreshTrigger]);

  // 2026-05-23 — record recent searches ONLY after the user has paused
  // typing for 1.2s AND there's at least one match. This filters out Korean
  // IME composition garbage ("스", "스ㅋ", "시", "개", …) which used to be
  // recorded on every 100 ms search tick. Query length ≥ 2 to avoid single
  // chars too. The contentResults ref is read at timer-fire time so a slow
  // search returning after the timer still gets the up-to-date result count.
  const contentResultsRef = useRef(contentResults);
  contentResultsRef.current = contentResults;
  useEffect(() => {
    if (mode !== 'contents') return;
    const q = contentsQuery.trim();
    if (q.length < 2) return;
    const timer = setTimeout(() => {
      if (
        contentResultsRef.current.length > 0 &&
        q === contentsQueryRef.current.trim()
      ) {
        recordRecentSearchRef.current(q);
      }
    }, 1200);
    return () => clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, contentsQuery, contentsWholeWord, searchReady, searchIndexing, refreshTrigger]);

  // Attachments tab now reads from the live AttachmentRef store — no
  // per-mode fetch trigger needed. v2 component subscribes to the
  // store and re-renders on any ref change.

  // Compute unique tags from all notes for dropdown
  const uniqueTags = useMemo(() => {
    const tagSet = new Set<string>();
    notes.forEach(n => n.tags.forEach(t => tagSet.add(t)));
    return Array.from(tagSet).sort();
  }, [notes]);

  // Filter results — single-pass loop (avoids 7 intermediate arrays)
  const filteredNotes = useMemo(() => {
    const result: NoteMetadata[] = [];
    const seen = new Set<string>();

    // Pre-compute container filter values
    let prefix: string | undefined;
    let folderNotePath: string | undefined;
    if (containerPath) {
      prefix = containerPath.replace(/\\/g, '/');
      const containerName = prefix.split('/').pop() || '';
      folderNotePath = (prefix + '/' + containerName + '.md').toLowerCase();
    }

    // Pre-compute query
    const q = (frontmatterQuery.trim() && mode === 'frontmatter') ? frontmatterQuery.toLowerCase() : null;

    for (const n of notes) {
      // Container path filter
      if (prefix) {
        const normPath = n.path.replace(/\\/g, '/');
        if (!normPath.startsWith(prefix + '/')) continue;
        if (normPath.toLowerCase() === folderNotePath) continue;

        // 🔴 **직계만 보여준다** (사용자 지적, 2026-08-11: *"국방부 과제
        //    노트가 왜 프로젝트 컨테이너 안에 폴더와 같은 위계에 있는 거지?"*).
        //
        //    한때 재귀로 다 끌어올렸다. 이유는 **배지 숫자와 목록이 어긋나서**
        //    였다 — 배지는 재귀로 세는데 목록은 직계만 보이니 62개라 해놓고
        //    0개를 보여줬다. 그때는 그게 맞는 처방으로 보였다.
        //
        //    **틀렸다.** 어긋난 것은 목록이 아니라 배지였고, 재귀 목록은
        //    위계를 화면에서 지워 버린다 — 하위 과제의 노트가 상위 클래스에서
        //    폴더들과 나란히 섞인다. 1-3의 *"탐색기로 찾을 수 있어야 한다"* 가
        //    무너진다. 폴더가 폴더인 이유는 **그 안에 든 것을 감추기 때문**이다.
        //
        //    서버가 이미 직계만 준다(`query_notes` 의 folder 필터). 여기서는
        //    한 겹 더 확인만 한다 — 하위 폴더의 **폴더노트**는 문이므로 남긴다.
        const relativePath = normPath.slice(prefix.length + 1);
        const depth = relativePath.split('/').length;
        if (depth > 1) {
          const parts = relativePath.split('/');
          const isDoor = n.note_type === 'FOLDER' && parts.length === 2
            && parts[1].toLowerCase() === `${parts[0].toLowerCase()}.md`;
          if (!isDoor) continue;
        }
      }

      // Query filter (2026-05-22) — matches title + tags only. note_type
      // used to be in this list but it leaked English internal tokens
      // (e.g. "SKETCH") so typing "c" surprisingly matched sketch notes
      // because of the raw token, not the visible Korean label. Type
      // filtering belongs in the chip filter dropdown, not the search
      // box.
      if (q && !n.title.toLowerCase().includes(q) &&
          !n.tags.some(t => t.toLowerCase().includes(q))) continue;

      // Type filter
      if (frontmatterTypeFilter && n.note_type !== frontmatterTypeFilter) continue;

      // Tag filter
      if (frontmatterTagFilter && !n.tags.includes(frontmatterTagFilter)) continue;

      // Memo filter
      if (frontmatterMemoFilter === 'has' && n.comment_count <= 0) continue;
      if (frontmatterMemoFilter === 'none' && n.comment_count > 0) continue;

      // Folder notes visibility
      if (!showFolderNotes && n.note_type === 'CONTAINER') continue;

      // Dedup
      const dedupKey = n.path.replace(/\\/g, '/').toLowerCase();
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);

      result.push(n);
    }

    // Sort: containers first, then by tag category if tag sort is active
    result.sort((a, b) => {
      const aIsContainer = a.note_type === 'CONTAINER' ? 0 : 1;
      const bIsContainer = b.note_type === 'CONTAINER' ? 0 : 1;
      if (aIsContainer !== bIsContainer) return aIsContainer - bIsContainer;

      // Client-side tag category sort (secondary: modified date)
      if (sortBy === 'tags' && tagSortCategory) {
        const prefix = tagSortCategory + '/';
        const aTags = a.tags.filter(t => t.startsWith(prefix)).sort();
        const bTags = b.tags.filter(t => t.startsWith(prefix)).sort();
        const aFirst = aTags.length > 0 ? aTags[0] : null;
        const bFirst = bTags.length > 0 ? bTags[0] : null;

        if (!aFirst && !bFirst) return b.modified.localeCompare(a.modified);
        if (!aFirst) return 1; // no tags in category → end
        if (!bFirst) return -1;

        const cmp = aFirst.localeCompare(bFirst);
        const dir = sortOrder === 'asc' ? cmp : -cmp;
        return dir !== 0 ? dir : b.modified.localeCompare(a.modified);
      }

      return 0; // preserve backend sort order
    });

    filteredNotesRef.current = result;
    return result;
  }, [notes, containerPath, frontmatterQuery, mode, frontmatterTypeFilter, frontmatterTagFilter, frontmatterMemoFilter, showFolderNotes, sortBy, sortOrder, tagSortCategory]);

  // Content results filtering — single-pass loop
  const filteredContentResults = useMemo(() => {
    const result: SearchResult[] = [];

    // Pre-compute container filter values
    let prefix: string | undefined;
    let folderNotePath: string | undefined;
    if (containerPath) {
      prefix = containerPath.replace(/\\/g, '/');
      const containerName = prefix.split('/').pop() || '';
      folderNotePath = (prefix + '/' + containerName + '.md').toLowerCase();
    }

    // Pre-compute type filter prefix
    const typePrefix = contentsTypeFilter ? contentsTypeFilter + '-' : null;
    const typeExact = contentsTypeFilter ? contentsTypeFilter + '.MD' : null;

    for (const r of contentResults) {
      const normPath = r.path.replace(/\\/g, '/');

      // Container path filter
      if (prefix) {
        if (!normPath.startsWith(prefix + '/')) continue;
        if (normPath.toLowerCase() === folderNotePath) continue;

        const relativePath = normPath.slice(prefix.length + 1);
        if (relativePath.includes('/')) {
          const parts = relativePath.split('/');
          if (parts.length !== 2) continue;
          if (parts[1].toLowerCase() !== `${parts[0].toLowerCase()}.md`) continue;
        }
      }

      // Type filter
      if (typePrefix) {
        const fileName = normPath.split('/').pop() || '';
        const fileUpper = fileName.toUpperCase();
        if (!fileUpper.startsWith(typePrefix) && fileUpper !== typeExact) continue;
      }

      result.push(r);
    }

    // 2026-05-22 — apply user-chosen sort. 'relevance' = leave backend
    // order (already by score). Other modes do a stable client sort so
    // ties keep their original (relevance) order as the tiebreaker.
    if (contentsSortBy === 'title') {
      result.sort((a, b) => a.title.localeCompare(b.title));
    } else if (contentsSortBy === 'path') {
      result.sort((a, b) =>
        a.path.replace(/\\/g, '/').localeCompare(b.path.replace(/\\/g, '/'))
      );
    }
    return result;
  }, [contentResults, containerPath, contentsTypeFilter, contentsSortBy]);

  // `filteredAttachments` useMemo retired 2026-05-20 along with the
  // 4 legacy filter inputs. AttachmentsTab v2 owns its own filter state
  // and filters the in-memory AttachmentRef list itself.

  // Double-click detection: track first click time, open window only on confirmed double-click
  // This prevents flash when single-clicking (window was being created then closed after 350ms)
  const pendingNoteOpenRef = useRef<{ path: string; time: number } | null>(null);

  const handleNoteClick = useCallback((path: string, noteType?: string) => {
    // 🔴 **폴더노트도 폴더다** — 누르면 그 폴더로 들어간다 (3-4-1).
    //    두 가지가 틀려 있었다:
    //      ① `CONTAINER` 만 보고 `FOLDER` 를 안 봤다
    //      ② 경로를 **역슬래시**로 이었다 — 윈도 시절의 흔적이다.
    //         이 서버의 보관함 경로는 `vault:01_Tasks/국방부 과제` 이므로
    //         역슬래시로 이으면 어떤 폴더와도 안 맞는다. 그래서 눌러도
    //         제자리였다 (실측: 더블클릭해도 01_Tasks 그대로).
    const nt = noteType?.toUpperCase();
    if (nt === 'CONTAINER' || nt === 'FOLDER') {
      const norm = path.replace(/\\/g, '/');
      const folderPath = norm.slice(0, norm.lastIndexOf('/'));
      selectContainer(folderPath);
      return;
    }

    // 🔴 **한 번 클릭으로 연다** (2026-08-11 web notology).
    //    데스크톱은 더블클릭이 규칙이었다 — 파일 탐색기와 같은 관례다.
    //    **웹에서는 한 번이 규칙이다.** 링크를 두 번 누르는 화면은 없다.
    //    사용자가 "노트를 눌러도 열리지 않는다"고 한 것이 이것이었다.
    //
    //    (미리 읽어두는 최적화는 남긴다 — 두 번째 클릭을 기다리던 자리가
    //     이제 곧바로 여는 자리가 됐을 뿐이다)
    const pending = pendingNoteOpenRef.current;
    const now = Date.now();

    if (true) {
      pendingNoteOpenRef.current = null;

      // Check for existing window first
      const existingWindow = useHoverStore.getState().hoverFiles.find(h => h.filePath === path && !h.cached);
      if (existingWindow) {
        if (existingWindow.minimized) {
          hoverActions.restore(existingWindow.id);
        } else {
          hoverActions.focus(existingWindow.id);
        }
        return;
      }

      // Open window on confirmed double-click
      hoverActions.open(path);
      return;
    }

    // First click: record and preload content for instant opening on double-click
    pendingNoteOpenRef.current = { path, time: now };
    if (path.endsWith('.md')) {
      contentCacheActions.preloadContent(path);
    }
  }, []);

  // Preload content when hovering over search results — warms cache for instant loading on click
  const handleNoteHover = useCallback((path: string) => {
    if (path.endsWith('.md')) {
      contentCacheActions.preloadContent(path);
    }
  }, []);

  // Attachment click + context-menu + bulk-delete handlers retired
  // 2026-05-20. AttachmentsTab v2 owns row click (preview-vs-open),
  // row right-click (per-row menu via modalActions.showContextMenu),
  // multi-select (selection-mode toggle + Shift-range), and bulk
  // delete actions itself.

  const searchTableRef = useRef<HTMLDivElement>(null);

  const handleSortChange = useCallback((field: string) => {
    if (field === 'tags') {
      // Tag header: show category dropdown
      setShowTagCategoryMenu(prev => !prev);
      return;
    }
    // Clear tag category when switching to non-tag sort
    setTagSortCategory(null);
    setShowTagCategoryMenu(false);
    setSortBy(prev => {
      if (prev === field) {
        setSortOrder(order => order === 'desc' ? 'asc' : 'desc');
        return prev;
      } else {
        setSortOrder('desc');
        return field;
      }
    });
  }, []);

  const handleTagCategorySelect = useCallback((category: string) => {
    setShowTagCategoryMenu(false);
    if (sortBy === 'tags' && tagSortCategory === category) {
      // Same category → toggle direction
      setSortOrder(order => order === 'desc' ? 'asc' : 'desc');
    } else {
      // New category
      setTagSortCategory(category);
      setSortBy('tags');
      setSortOrder('desc');
    }
  }, [sortBy, tagSortCategory]);

  // Close tag dropdown on outside click
  useEffect(() => {
    if (!showTagCategoryMenu) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (tagHeaderRef.current && !tagHeaderRef.current.contains(e.target as Node)) {
        setShowTagCategoryMenu(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showTagCategoryMenu]);

  const TAG_CATEGORIES = [
    { prefix: 'domain', labelKey: 'facetDomain' },
    { prefix: 'who', labelKey: 'facetWho' },
    { prefix: 'org', labelKey: 'facetOrg' },
    { prefix: 'ctx', labelKey: 'facetCtx' },
  ] as const;

  const getSortIndicator = (field: string) => {
    const g = sortGlyph(sortBy === field, sortOrder);
    return g ? ` ${g}` : '';
  };

  const getTagSortLabel = () => {
    if (sortBy !== 'tags' || !tagSortCategory) return '';
    const cat = TAG_CATEGORIES.find(c => c.prefix === tagSortCategory);
    const catName = cat ? t(cat.labelKey, language) : '';
    const arrow = sortOrder === 'asc' ? SORT_ASC : SORT_DESC;
    return ` · ${catName} ${arrow}`;
  };

  // Multi-select note click handler (returns true if handled as multi-select)
  const handleNoteMultiClick = useCallback((e: React.MouseEvent, note: NoteMetadata, notesList: NoteMetadata[]) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      setSelectedNotePaths(prev => {
        const newSet = new Set(prev);
        if (newSet.has(note.path)) {
          newSet.delete(note.path);
        } else {
          newSet.add(note.path);
        }
        return newSet;
      });
      lastSelectedNoteRef.current = note.path;
      return true;
    }
    if (e.shiftKey && lastSelectedNoteRef.current) {
      e.preventDefault();
      const lastIdx = notesList.findIndex(n => n.path === lastSelectedNoteRef.current);
      const currentIdx = notesList.findIndex(n => n.path === note.path);
      if (lastIdx >= 0 && currentIdx >= 0) {
        const [start, end] = [Math.min(lastIdx, currentIdx), Math.max(lastIdx, currentIdx)];
        const range = new Set(notesList.slice(start, end + 1).map(n => n.path));
        setSelectedNotePaths(prev => new Set([...prev, ...range]));
        return true;
      }
    }
    // 2026-05-22 — Excel-style row selection. A plain click on a row
    // makes it the single selection (replacing any prior multi-select).
    // Double-click on the same row opens the hover window (handled by
    // `handleNoteClick`'s 500 ms pendingNoteOpenRef detection).
    setSelectedNotePaths(new Set([note.path]));
    lastSelectedNoteRef.current = note.path;
    return false;
  }, []);

  // 2026-05-22 — clear selection + shift-range anchor + double-click
  // pending all at once. Bound to wrapper-background clicks so a click
  // in the empty area below the list drops focus and starts fresh.
  // The pending ref is reset so a subsequent click on a row doesn't
  // accidentally complete a 500 ms double-click that bridges the gap.
  const clearAllSelection = useCallback(() => {
    setSelectedNotePaths(new Set());
    lastSelectedNoteRef.current = null;
    pendingNoteOpenRef.current = null;
  }, []);

  // Context menu for notes (single or multi-selected)
  const [noteContextMenu, setNoteContextMenu] = useState<{ x: number; y: number } | null>(null);
  const noteContextMenuRef = useRef<HTMLDivElement>(null);
  const [showBulkTagModal, setShowBulkTagModal] = useState(false);

  const handleNoteContextMenu = useCallback((e: React.MouseEvent, note: NoteMetadata) => {
    e.preventDefault();
    if (selectedNotePathsRef.current.size > 0) {
      if (!selectedNotePathsRef.current.has(note.path)) {
        setSelectedNotePaths(prev => new Set(prev).add(note.path));
      }
      setNoteContextMenu({ x: e.clientX, y: e.clientY });
      return;
    }
    modalActions.showContextMenu(note.title, { x: e.clientX, y: e.clientY }, note.path, note.path, false, true);
  }, []);

  // Stable multi-click callbacks using refs (avoids inline arrow functions in JSX)
  const handleFrontmatterMultiClick = useCallback((e: React.MouseEvent, note: NoteMetadata) => {
    return handleNoteMultiClick(e, note, filteredNotesRef.current);
  }, [handleNoteMultiClick]);

  // 11th hotfix (2026-05-19, HanBin) — explicit checkbox toggle handler.
  // Shift+click on a checkbox extends a range from the last-selected
  // anchor (same as Shift+click on the row); plain click toggles a
  // single row. Keeps the same `selectedNotePaths` state the Ctrl/Shift
  // row-click path uses, so the two entry points stay in sync.
  const handleCheckboxToggle = useCallback((e: React.MouseEvent, note: NoteMetadata) => {
    if (e.shiftKey && lastSelectedNoteRef.current) {
      const list = filteredNotesRef.current;
      const lastIdx = list.findIndex(n => n.path === lastSelectedNoteRef.current);
      const currIdx = list.findIndex(n => n.path === note.path);
      if (lastIdx >= 0 && currIdx >= 0) {
        const [start, end] = [Math.min(lastIdx, currIdx), Math.max(lastIdx, currIdx)];
        const range = new Set(list.slice(start, end + 1).map(n => n.path));
        setSelectedNotePaths(prev => new Set([...prev, ...range]));
        return;
      }
    }
    setSelectedNotePaths(prev => {
      const next = new Set(prev);
      if (next.has(note.path)) next.delete(note.path);
      else next.add(note.path);
      return next;
    });
    lastSelectedNoteRef.current = note.path;
  }, []);

  // Container single-click: toggle in selectedNotePaths (same state as Ctrl+click)
  const handleContainerSelect = useCallback((path: string) => {
    setSelectedNotePaths(prev => {
      const newSet = new Set(prev);
      if (newSet.has(path)) {
        newSet.delete(path);
      } else {
        newSet.add(path);
      }
      return newSet;
    });
    lastSelectedNoteRef.current = path;
  }, []);

  // Close note context menu on outside click
  useEffect(() => {
    if (!noteContextMenu) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (noteContextMenuRef.current && !noteContextMenuRef.current.contains(e.target as Node)) {
        setNoteContextMenu(null);
      }
    };
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setNoteContextMenu(null);
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEsc);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEsc);
    };
  }, [noteContextMenu]);

  // Clear note selection on outside click
  useEffect(() => {
    if (selectedNotePaths.size === 0) return;
    const handleOutsideClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('.context-menu') || target.closest('.note-context-menu')) return;
      if (target.closest('.search-table') || target.closest('.search-virtual-wrapper')) return;
      if (target.closest('.modal-overlay') || target.closest('.bulk-tag-modal')) return;
      if (e.ctrlKey || e.metaKey || e.shiftKey) return;
      setSelectedNotePaths(new Set());
    };
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !showBulkTagModal) {
        // 11th hotfix follow-up #2 — ESC also exits selection-mode, not
        // just clears selection. Keeps the toggle in sync with the
        // visual chrome (column collapses back to 6).
        // 🔴 `selectionMode` 는 2026-05-22 에 없앴는데 이 줄이 남았다.
        //    ESC 를 누를 때마다 `ReferenceError` 가 나서 그 뒤 핸들러가
        //    통째로 죽었다 — 미리보기를 닫고 다음 것을 여는 흐름이 끊긴다.
        setSelectedNotePaths(new Set());
      }
    };
    document.addEventListener('mousedown', handleOutsideClick);
    document.addEventListener('keydown', handleEsc);
    return () => {
      document.removeEventListener('mousedown', handleOutsideClick);
      document.removeEventListener('keydown', handleEsc);
    };
  }, [selectedNotePaths.size, showBulkTagModal]);

  // 2026-05-22 — note `selectionMode` only governs the attachments
  // toolbar toggle now; frontmatter notes use Excel-style row clicks
  // and own their own selection state independently of the toggle.
  // The previous "selectionMode off → drop selection" effect was
  // removed because it cleared note selections when the user toggled
  // attachments-side mode.

  // Bulk move selected notes
  const handleBulkMoveNotes = useCallback(() => {
    if (selectedNotePaths.size === 0) return;
    const paths = Array.from(selectedNotePaths);
    modalActions.showBulkMoveModal(paths);
    setNoteContextMenu(null);
  }, [selectedNotePaths]);

  // Bulk delete selected notes
  const handleBulkDeleteNotes = useCallback(() => {
    if (selectedNotePaths.size === 0) return;
    const count = selectedNotePaths.size;
    const pathsToDelete = Array.from(selectedNotePaths);

    modalActions.showConfirmDelete(tf('selectedNotesCount', language, { count }), 'file', async () => {
      try {
        const deleted = await searchCommands.deleteMultipleFiles(pathsToDelete);
        setSelectedNotePaths(new Set());
        await fileTreeActions.refreshFileTree();
        refreshActions.incrementSearchRefresh();
        modalActions.showAlertModal(t('deleteComplete', language), tf('deletedFilesMsg', language, { count: deleted }));
      } catch (e) {
        console.error('Failed to batch delete notes:', e);
        modalActions.showAlertModal(t('deleteFailed', language), `${t('fileDeleteFailed', language)}\n\n${e}`);
      }
    }, count);
    setNoteContextMenu(null);
  }, [selectedNotePaths, language]);

  // Check if selected notes contain any CONTAINER type (containers cannot have tags)
  const nonContainerSelectedPaths = useMemo(() => {
    if (selectedNotePaths.size === 0) return [];
    const allNotes = [...filteredNotesRef.current];
    const noteMap = new Map(allNotes.map(n => [n.path, n]));
    return Array.from(selectedNotePaths).filter(path => {
      const note = noteMap.get(path);
      return !note || note.note_type.toUpperCase() !== 'CONTAINER';
    });
  }, [selectedNotePaths]);

  // Bulk add tags to selected notes
  const handleBulkAddTags = useCallback(() => {
    if (nonContainerSelectedPaths.length === 0) return;
    setShowBulkTagModal(true);
    setNoteContextMenu(null);
  }, [nonContainerSelectedPaths]);

  // conflictCount tracked by AttachmentsTab v2 internally via the
  // 'orphan' / 'stuck' sync-state chips. Search.tsx no longer needs
  // a top-level count.

  // Lightweight virtual list — no external dependency
  const ROW_HEIGHT = 32;
  const OVERSCAN = 10;
  const virtualContainerRef = useRef<HTMLDivElement>(null);
  const [virtualHeight, setVirtualHeight] = useState(400);
  const [scrollTop, setScrollTop] = useState(0);
  const virtualRoRef = useRef<ResizeObserver | null>(null);

  // Callback ref for virtual body — re-attach ResizeObserver on mount/unmount (tab switch)
  const setVirtualContainerEl = useCallback((el: HTMLDivElement | null) => {
    if (virtualRoRef.current) { virtualRoRef.current.disconnect(); virtualRoRef.current = null; }
    virtualContainerRef.current = el;
    if (el) {
      setVirtualHeight(el.clientHeight || 400);
      virtualRoRef.current = new ResizeObserver(([entry]) => setVirtualHeight(entry.contentRect.height));
      virtualRoRef.current.observe(el);
    }
  }, []);

  useEffect(() => () => { virtualRoRef.current?.disconnect(); }, []);

  const handleVirtualScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    setScrollTop(e.currentTarget.scrollTop);
  }, []);

  // ── Column resize (divider-style, always fits container width) ──
  const COLUMN_STORAGE_KEY = 'search-col-ratios-v3';
  const DEFAULT_RATIOS = [2.5, 0.9, 2.5, 0.5, 1.5, 1.5];
  // 2026-05-22 — memo col min bumped to 60 so the sort indicator
  // ("메모 ↓") doesn't clip on the right edge. Title/dates also got
  // small bumps so headers breathe a bit at the narrowest layout.
  const MIN_COL = [120, 60, 80, 60, 100, 100];

  const wrapperRef = useRef<HTMLDivElement>(null);
  const [wrapperWidth, setWrapperWidth] = useState(0);
  const roRef = useRef<ResizeObserver | null>(null);

  // Callback ref: re-attach ResizeObserver whenever the wrapper element mounts/unmounts
  const setWrapperEl = useCallback((el: HTMLDivElement | null) => {
    if (roRef.current) { roRef.current.disconnect(); roRef.current = null; }
    wrapperRef.current = el;
    if (el) {
      setWrapperWidth(el.getBoundingClientRect().width);
      roRef.current = new ResizeObserver(([entry]) => setWrapperWidth(entry.contentRect.width));
      roRef.current.observe(el);
    }
  }, []);

  // Cleanup observer on unmount
  useEffect(() => () => { roRef.current?.disconnect(); }, []);

  const [ratios, setRatios] = useState<number[]>(() => {
    try {
      const stored = localStorage.getItem(COLUMN_STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed) && parsed.length === 6) return parsed;
      }
    } catch { /* */ }
    return DEFAULT_RATIOS;
  });

  // Compute px widths from ratios (used only for drag-resize reference)
  const colWidths = useMemo(() => {
    const w = wrapperWidth || 900;
    const total = ratios.reduce((a, b) => a + b, 0);
    return ratios.map((r, i) => Math.max(MIN_COL[i], Math.round(w * r / total)));
  }, [wrapperWidth, ratios]);

  const colWidthsRef = useRef(colWidths);
  colWidthsRef.current = colWidths;
  const ratiosRef = useRef(ratios);
  ratiosRef.current = ratios;

  // 11th hotfix follow-up #2 (2026-05-19) — selection mode state lives
  // at the top of the component (see comment near `selectedNotePaths`).
  // Grid-cols simply reacts to the toggle here.
  // 2026-05-22 — Frontmatter rows always use Excel-style click selection
  // (single click = focus, Ctrl/Shift = multi/range, double-click = open).
  // No checkbox column. `selectionMode` only governs the attachments tab now.
  const gridTemplateColumns = useMemo(
    () => ratios.map((r, i) => `minmax(${MIN_COL[i]}px, ${r}fr)`).join(' '),
    [ratios],
  );

  // 2026-05-22 — Frontmatter filter schema for FilterAddButton +
  // FilterChipList. Built here (not in SearchFilters) so the +Add
  // trigger can live in the toolbar and the chip list below it,
  // separated by the search input.
  const frontmatterFields: FilterField[] = useMemo(() => mode !== 'frontmatter' ? [] : [
    {
      id: 'type',
      label: t('noteType', language),
      type: 'select',
      isActive: frontmatterTypeFilter !== '',
      // 2026-05-22 — label-based display via template name. The chip
      // shows what the user actually sees in the row's type column
      // (e.g. "스케치", "테스트3"), not the underlying English token.
      displayValue:
        noteTemplates.find(tmpl => {
          const tok = (tmpl.frontmatter?.type ?? tmpl.prefix ?? '').toUpperCase();
          return tok === frontmatterTypeFilter.toUpperCase();
        })?.name ?? frontmatterTypeFilter,
      clear: () => setFrontmatterTypeFilter(''),
      value: frontmatterTypeFilter,
      setValue: setFrontmatterTypeFilter,
      // Options come from the user's templates so custom templates
      // (e.g. "테스트3") appear with their user-set Korean names. Token
      // (value) stays the raw type so the existing equality match in
      // the filter loop keeps working unchanged.
      options: [
        { value: '', label: t('allTypes', language) },
        ...noteTemplates.map(tmpl => ({
          value: (tmpl.frontmatter?.type ?? tmpl.prefix ?? '').toUpperCase(),
          label: tmpl.name,
        })),
      ],
    },
    {
      id: 'tag',
      label: t('tag', language),
      type: 'select',
      isActive: frontmatterTagFilter !== '',
      displayValue: stripTagNamespace(frontmatterTagFilter),
      clear: () => setFrontmatterTagFilter(''),
      value: frontmatterTagFilter,
      setValue: setFrontmatterTagFilter,
      options: [
        { value: '', label: t('allTags', language) },
        ...uniqueTags.map(tag => ({ value: tag, label: stripTagNamespace(tag) })),
      ],
    },
    {
      id: 'memo',
      label: t('memos', language),
      type: 'select',
      isActive: frontmatterMemoFilter !== 'all',
      displayValue:
        frontmatterMemoFilter === 'has' ? t('hasMemos', language) :
        frontmatterMemoFilter === 'none' ? t('noMemos', language) : '',
      clear: () => setFrontmatterMemoFilter('all'),
      value: frontmatterMemoFilter,
      setValue: v => setFrontmatterMemoFilter(v as 'all' | 'has' | 'none'),
      options: [
        { value: 'all', label: t('all', language) },
        { value: 'has', label: t('hasMemos', language) },
        { value: 'none', label: t('noMemos', language) },
      ],
    },
    {
      id: 'folder-notes',
      label: t('folderNotesLabel', language),
      type: 'select',
      isActive: !showFolderNotes,
      displayValue: showFolderNotes ? '' : t('hideLabel', language),
      clear: () => setShowFolderNotes(true),
      value: showFolderNotes ? 'show' : 'hide',
      setValue: v => setShowFolderNotes(v === 'show'),
      options: [
        { value: 'show', label: t('showLabel', language) },
        { value: 'hide', label: t('hideLabel', language) },
      ],
    },
    {
      id: 'created',
      label: t('createdDate', language),
      type: 'date-range',
      isActive: !!(createdAfter || createdBefore),
      displayValue: formatDateRange(createdAfter, createdBefore),
      clear: () => { setCreatedAfter(''); setCreatedBefore(''); },
      after: createdAfter,
      before: createdBefore,
      setAfter: setCreatedAfter,
      setBefore: setCreatedBefore,
    },
    {
      id: 'modified',
      label: t('modifiedDate', language),
      type: 'date-range',
      isActive: !!(modifiedAfter || modifiedBefore),
      displayValue: formatDateRange(modifiedAfter, modifiedBefore),
      clear: () => { setModifiedAfter(''); setModifiedBefore(''); },
      after: modifiedAfter,
      before: modifiedBefore,
      setAfter: setModifiedAfter,
      setBefore: setModifiedBefore,
    },
  ], [
    mode, language, uniqueTags, noteTemplates,
    frontmatterTypeFilter, frontmatterTagFilter, frontmatterMemoFilter,
    showFolderNotes,
    createdAfter, createdBefore, modifiedAfter, modifiedBefore,
  ]);

  // 2026-05-22 — Contents tab chip schema. Only a single field (type)
  // for now but uses the same primitive as Frontmatter so the toolbar
  // + chip-list rendering stays identical across tabs.
  // (`SearchFilters.tsx` was deleted in this commit — Contents used to
  // own a static panel there but the chip pattern obsoletes it.)
  const contentsFields: FilterField[] = useMemo(() => mode !== 'contents' ? [] : [
    {
      id: 'type',
      label: t('noteType', language),
      type: 'select',
      isActive: contentsTypeFilter !== '',
      displayValue:
        noteTemplates.find(tmpl => {
          const tok = (tmpl.frontmatter?.type ?? tmpl.prefix ?? '').toUpperCase();
          return tok === contentsTypeFilter.toUpperCase();
        })?.name ?? contentsTypeFilter,
      clear: () => setContentsTypeFilter(''),
      value: contentsTypeFilter,
      setValue: setContentsTypeFilter,
      options: [
        { value: '', label: t('allTypes', language) },
        ...noteTemplates.map(tmpl => ({
          value: (tmpl.frontmatter?.type ?? tmpl.prefix ?? '').toUpperCase(),
          label: tmpl.name,
        })),
      ],
    },
  ], [mode, language, noteTemplates, contentsTypeFilter]);

  // 2026-05-22 — Attachments tab chip schema. Same primitive as
  // Frontmatter/Contents. `extension` + `note path` are text fields,
  // `orphan only` is a select with show/hide.
  // Autocomplete pools for the attachments tab text-chip pickers.
  // 2026-05-25 (HanBin) — same `noteIdToPath` AttachmentsTab uses, hoisted
  // so the extension pool below can filter by container scope. Hook
  // hits the backend once per vault open; shared with the tab so the
  // call is dedup'd.
  const noteIdToPath = useNoteIdToPath();

  const attachmentExtensionPool = useMemo(() => {
    if (mode !== 'attachments') return [];
    // 2026-05-25 (HanBin) — container-scope filter, mirroring the
    // notePathPool below. Without it, the dropdown listed every
    // extension in the vault even when a single container was
    // selected — so `test` container's extension picker offered
    // `mp4`/`hwp`/`xlsx`/... that don't exist inside it, leading to
    // empty result lists when the user picked one.
    const cpNorm = (containerPath ?? '')
      .toLowerCase()
      .replace(/\\/g, '/')
      .replace(/^\/+/, '')
      .replace(/\/+$/, '');
    let scopeNorm = cpNorm;
    if (cpNorm && vaultPath) {
      const vpNorm = vaultPath
        .toLowerCase()
        .replace(/\\/g, '/')
        .replace(/^\/+/, '')
        .replace(/\/+$/, '');
      if (vpNorm && cpNorm === vpNorm) {
        scopeNorm = '';
      } else if (vpNorm && cpNorm.startsWith(vpNorm + '/')) {
        scopeNorm = cpNorm.slice(vpNorm.length + 1);
      }
    }
    const set = new Set<string>();
    for (const ref of attachmentRefsById.values()) {
      if (scopeNorm) {
        let inScope = false;
        for (const noteId of ref.linkedNotes) {
          const idLower = noteId.toLowerCase();
          let path = noteIdToPath.get(idLower);
          if (!path) path = fileLookupActions.resolveNotePath(noteId) ?? undefined;
          if (!path) continue;
          const pLower = path.toLowerCase().replace(/\\/g, '/').replace(/^\/+/, '');
          if (pLower === scopeNorm || pLower.startsWith(scopeNorm + '/')) {
            inScope = true;
            break;
          }
        }
        if (!inScope) continue;
      }
      const m = ref.displayPath.match(/\.([A-Za-z0-9]+)$/);
      if (m) set.add(m[1].toLowerCase());
    }
    return Array.from(set).sort();
  }, [mode, attachmentRefsById, containerPath, vaultPath, noteIdToPath]);

  const attachmentNotePathPool = useMemo(() => {
    if (mode !== 'attachments') return [];
    // Strip the vault root so suggestions read as vault-relative paths
    // (e.g. "dd/note.md") instead of the noisy absolute filesystem path
    // (`C:/Users/.../vault/dd/note.md`). The filter loop in
    // AttachmentsTab already matches on substring against the full
    // resolved path, so trimming the visible prefix doesn't affect
    // matching — the user's typed query against the vault-relative
    // string is still a substring of the full path.
    const root = vaultPath ? vaultPath.replace(/\\/g, '/').replace(/\/$/, '') + '/' : '';
    // 2026-05-24 (HanBin) — scope suggestions to the selected container.
    // Previously the dropdown listed every note in the vault, so e.g. the
    // `test` container's filter dropdown surfaced `dd/...` notes. Match
    // the same prefix check the other tabs use; an empty containerPath
    // means "no scope" (vault-wide), so all notes pass.
    const prefix = containerPath
      ? containerPath.replace(/\\/g, '/').replace(/\/$/, '') + '/'
      : '';
    return notes
      .filter(n => {
        if (!prefix) return true;
        return n.path.replace(/\\/g, '/').toLowerCase().startsWith(prefix.toLowerCase());
      })
      .map(n => {
        const norm = n.path.replace(/\\/g, '/');
        return root && norm.toLowerCase().startsWith(root.toLowerCase())
          ? norm.slice(root.length)
          : norm;
      })
      .sort((a, b) => a.localeCompare(b));
  }, [mode, notes, vaultPath, containerPath]);

  const attachmentsFields: FilterField[] = useMemo(() => {
    if (mode !== 'attachments') return [];

    const tierLabel = (k: TierKey) => (t(`tier_${k}` as any, language) || k) as string;
    const syncLabel = (k: SyncState) =>
      k === 'synced' ? t('attachmentSynced', language)
      : k === 'uploading' ? t('attachmentUploading', language)
      : k === 'stuck' ? t('attachmentStuck', language)
      : t('attachmentOrphan', language);
    const activeTierLabels = TIER_KEYS.filter(k => attachmentTierFilter.has(k)).map(tierLabel);
    const activeSyncLabels = SYNC_KEYS.filter(k => attachmentSyncFilter.has(k)).map(syncLabel);

    return [
      {
        id: 'tier',
        label: t('tierFilter', language),
        type: 'multi-select',
        isActive: attachmentTierFilter.size > 0,
        displayValue: formatMultiValue(activeTierLabels),
        clear: () => setAttachmentTierFilter(new Set()),
        values: Array.from(attachmentTierFilter),
        toggleValue: toggleAttachmentTier,
        options: TIER_KEYS.map(k => ({ value: k, label: tierLabel(k) })),
      },
      {
        id: 'sync',
        label: t('syncFilter', language),
        type: 'multi-select',
        isActive: attachmentSyncFilter.size > 0,
        displayValue: formatMultiValue(activeSyncLabels),
        clear: () => setAttachmentSyncFilter(new Set()),
        values: Array.from(attachmentSyncFilter),
        toggleValue: toggleAttachmentSync,
        options: SYNC_KEYS.map(k => ({ value: k, label: syncLabel(k) })),
      },
      {
        id: 'extension',
        label: t('extension', language),
        type: 'text',
        isActive: attachmentExtensionFilter !== '',
        displayValue: attachmentExtensionFilter,
        clear: () => setAttachmentExtensionFilter(''),
        value: attachmentExtensionFilter,
        setValue: setAttachmentExtensionFilter,
        placeholder: t('extensionPlaceholder', language),
        suggestions: attachmentExtensionPool,
      },
      {
        id: 'note-path',
        label: t('attachedNote', language),
        type: 'text',
        isActive: attachmentNotePathFilter !== '',
        displayValue: attachmentNotePathFilter,
        clear: () => setAttachmentNotePathFilter(''),
        value: attachmentNotePathFilter,
        setValue: setAttachmentNotePathFilter,
        placeholder: t('notePathOrContainerPlaceholder', language),
        suggestions: attachmentNotePathPool,
      },
      // 2026-05-22 — "고아 파일" chip retired (HanBin: 효용성 X). The
      // sync-state multi-select already exposes 'orphan' as one of four
      // states, so picking it there gives the exact same filter without
      // a duplicate chip.
    ];
  }, [
    mode, language,
    attachmentExtensionFilter, attachmentNotePathFilter,
    attachmentExtensionPool, attachmentNotePathPool,
    attachmentTierFilter, attachmentSyncFilter,
    toggleAttachmentTier, toggleAttachmentSync,
  ]);

  const resizingRef = useRef<{
    colIdx: number; startX: number;
    leftStartPx: number; rightStartPx: number;
  } | null>(null);

  // Drag = move divider between col[idx] and col[idx+1], update ratios
  const onResizeStart = useCallback((colIdx: number, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const widths = colWidthsRef.current;
    const rightIdx = colIdx + 1;
    if (rightIdx >= widths.length) return;

    resizingRef.current = {
      colIdx,
      startX: e.clientX,
      leftStartPx: widths[colIdx],
      rightStartPx: widths[rightIdx],
    };

    const onMouseMove = (ev: MouseEvent) => {
      const r = resizingRef.current;
      if (!r) return;
      const delta = ev.clientX - r.startX;
      // Clamp both sides to min widths
      const maxDelta = r.rightStartPx - MIN_COL[r.colIdx + 1];
      const minDelta = -(r.leftStartPx - MIN_COL[r.colIdx]);
      const clampedDelta = Math.max(minDelta, Math.min(maxDelta, delta));

      const newLeftPx = r.leftStartPx + clampedDelta;
      const newRightPx = r.rightStartPx - clampedDelta;

      // Convert px back to ratios (preserving total)
      const currentRatios = [...ratiosRef.current];
      const pairSum = currentRatios[r.colIdx] + currentRatios[r.colIdx + 1];
      const pxSum = newLeftPx + newRightPx;
      currentRatios[r.colIdx] = pairSum * (newLeftPx / pxSum);
      currentRatios[r.colIdx + 1] = pairSum * (newRightPx / pxSum);
      setRatios(currentRatios);
    };

    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      try { localStorage.setItem(COLUMN_STORAGE_KEY, JSON.stringify(ratiosRef.current)); } catch { /* */ }
      resizingRef.current = null;
    };

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, []);

  const onResizeReset = useCallback(() => {
    setRatios(DEFAULT_RATIOS);
    try { localStorage.removeItem(COLUMN_STORAGE_KEY); } catch { /* */ }
  }, []);

  return (
    <div className="search-view">
      {/* Bulk sync banner — only visible when NAS sync is detected and bulk sync is active */}
      {isNasSynced && isBulkSyncing && (
        <div className="bulk-sync-banner">
          <span>{t('syncInProgressMsg', language)}</span>
        </div>
      )}
      {/* v22.4 (HanBin 2026-05-23) — vault-wide search header (hero band).
          Previous version was a small pill at the top-left that the user
          flagged as too quiet ("알약안에 작성하는 디자인을 원한게 아니라").
          This redesign uses the top space as an iOS-style section header:
            • Left: Library glyph + large "통합 검색" title (fs-16)
            • Below title: muted "전체 보관소 — {vaultName}" sub-label
          The header sits above the tabs and shares the same hairline
          accent so it reads as one continuous chrome layer. */}
      {!containerPath && (
        <header className="search-hero">
          <div className="search-hero__icon" aria-hidden="true">
            <Library size={18} strokeWidth={1.75} />
          </div>
          <div className="search-hero__text">
            <h1 className="search-hero__title">{t('unifiedSearchTitle', language)}</h1>
            <p className="search-hero__scope">
              {t('unifiedSearchScope', language)}
              {vaultPath && (
                <>
                  <span className="search-hero__sep">·</span>
                  <span className="search-hero__vault">{vaultPath.split(/[/\\]/).filter(Boolean).pop()}</span>
                </>
              )}
            </p>
          </div>
        </header>
      )}
      <div className="search-tabs">
        {/* v22 (HanBin 2026-05-23) — clicking a tab clears all per-tab
            search queries so the user always lands on a fresh state.
            Previously frontmatter/contents/attachments retained their
            queries across switches, which surprised users coming back
            to a tab thinking they'd hit a clean search field. */}
        <button
          className={`search-tab ${mode === 'frontmatter' ? 'active' : ''}`}
          onClick={() => {
            setMode('frontmatter');
            setFrontmatterQuery('');
            setContentsQuery('');
            setAttachmentsQuery('');
          }}
        >
          {t('notes', language)}
        </button>
        <button
          className={`search-tab ${mode === 'contents' ? 'active' : ''}`}
          onClick={() => {
            setMode('contents');
            setFrontmatterQuery('');
            setContentsQuery('');
            setAttachmentsQuery('');
          }}
        >
          {t('body', language)}
        </button>
        <button
          className={`search-tab ${mode === 'attachments' ? 'active' : ''}`}
          onClick={() => {
            setMode('attachments');
            setFrontmatterQuery('');
            setContentsQuery('');
            setAttachmentsQuery('');
          }}
        >
          {t('attachments', language)}
        </button>
        <button
          className={`search-tab ${mode === 'graph' ? 'active' : ''}`}
          onClick={() => {
            setMode('graph');
            setFrontmatterQuery('');
            setContentsQuery('');
            setAttachmentsQuery('');
          }}
        >
          {t('graph', language)}
        </button>
        {containerPath && onCreateNote && (
          <button className="search-create-note-btn" onClick={(e) => onCreateNote(e)} title={t('createNote', language)}>
            <FilePlus size={14} strokeWidth={2} />
            <span>{t('newNote', language)}</span>
          </button>
        )}
      </div>
      {mode !== 'graph' && <div className="search-toolbar">
        <div className="search-bar">
          {/* 2026-05-22 — Filter button = FilterAddButton popover trigger
              on every tab. Same chip filter pattern across Frontmatter,
              Contents, and Attachments. */}
          {mode === 'frontmatter' && (
            <FilterAddButton
              fields={frontmatterFields}
              language={language}
              triggerClassName="search-filter-trigger"
              icon={<Filter size={14} />}
              ariaLabel={t('addFilter', language)}
            />
          )}
          {mode === 'contents' && (
            <FilterAddButton
              fields={contentsFields}
              language={language}
              triggerClassName="search-filter-trigger"
              icon={<Filter size={14} />}
              ariaLabel={t('addFilter', language)}
            />
          )}
          {mode === 'attachments' && (
            <FilterAddButton
              fields={attachmentsFields}
              language={language}
              triggerClassName="search-filter-trigger"
              icon={<Filter size={14} />}
              ariaLabel={t('addFilter', language)}
            />
          )}
          {(() => {
            const activeValue =
              mode === 'frontmatter' ? frontmatterQuery :
              mode === 'contents' ? contentsQuery :
              attachmentsQuery;
            const clearActive = () => {
              if (mode === 'frontmatter') setFrontmatterQuery('');
              else if (mode === 'contents') setContentsQuery('');
              else setAttachmentsQuery('');
            };
            return (
              <Input
                className="search-bar__input"
                type="text"
                leftIcon={<SearchIcon size={14} />}
                rightIcon={
                  <span className="search-bar__right-cluster">
                    {mode === 'contents' && (
                      <button
                        type="button"
                        className={`search-bar__inline-toggle${contentsWholeWord ? ' is-active' : ''}`}
                        aria-pressed={contentsWholeWord}
                        title={t('wholeWord', language)}
                        aria-label={t('wholeWord', language)}
                        onClick={() => setContentsWholeWord(v => !v)}
                      >
                        <WholeWord size={14} />
                      </button>
                    )}
                    {activeValue && (
                      <button
                        type="button"
                        className="search-bar__clear"
                        aria-label={t('clear', language)}
                        onClick={clearActive}
                      >
                        <XIcon size={12} />
                      </button>
                    )}
                  </span>
                }
                placeholder={
                  mode === 'frontmatter' ? t('titleTagTypeSearch', language) :
                  mode === 'contents' ? t('bodyContentSearch', language) :
                  t('attachmentSearch', language)
                }
                value={activeValue}
                onChange={e => {
                  const value = e.target.value;
                  if (mode === 'frontmatter') setFrontmatterQuery(value);
                  else if (mode === 'contents') setContentsQuery(value);
                  else setAttachmentsQuery(value);
                }}
              />
            );
          })()}
          {/* Contents sort dropdown — mirrors the filter trigger on the
              opposite side (filter left, sort right). Only useful when
              there's an actual list to reorder, so contents-only. */}
          {mode === 'contents' && (
            <ContentsSortDropdown
              value={contentsSortBy}
              onChange={setContentsSortBy}
              language={language}
            />
          )}
          {/* CheckSquare removed 2026-05-22 — all tabs now use Excel-style
              row selection. */}
        </div>
      </div>}

      {/* Chip list — appears below toolbar when ≥1 filter is active.
          Same primitive across all three tabs so the visual + interaction
          stay consistent. */}
      {mode === 'frontmatter' && (
        <FilterChipList fields={frontmatterFields} language={language} />
      )}
      {mode === 'contents' && (
        <FilterChipList fields={contentsFields} language={language} />
      )}
      {mode === 'attachments' && (
        <FilterChipList fields={attachmentsFields} language={language} />
      )}

      {mode === 'frontmatter' ? (
        <div
          className="search-virtual-wrapper"
          ref={setWrapperEl}
          style={{ '--grid-cols': gridTemplateColumns } as CSSProperties}
          onClick={(e) => {
            // Any click inside the table viewport that doesn't land on
            // a `.search-row` drops selection + shift anchor. Catches
            // the empty area below the last row (inside `.search-virtual-body`),
            // gaps between rows, and the table header. Row clicks bubble
            // here too but `closest('.search-row')` short-circuits the
            // clear — the row's own onClick has already set selection.
            if (!(e.target as HTMLElement).closest('.search-row')) {
              clearAllSelection();
            }
          }}
        >
          <div className="search-grid-header">
            <div className="search-th clickable" onClick={() => handleSortChange('title')}>
              {t('titleColumn', language)}{getSortIndicator('title')}
              <span className="col-resize-handle" onMouseDown={e => onResizeStart(0, e)} onDoubleClick={onResizeReset} />
            </div>
            <div className="search-th clickable" onClick={() => handleSortChange('type')}>
              {t('noteType', language)}{getSortIndicator('type')}
              <span className="col-resize-handle" onMouseDown={e => onResizeStart(1, e)} onDoubleClick={onResizeReset} />
            </div>
            <div className="search-th clickable" ref={tagHeaderRef} onClick={() => handleSortChange('tags')} style={{ position: 'relative' }}>
              {t('tags', language)}{getTagSortLabel()}
              <span className="col-resize-handle" onMouseDown={e => onResizeStart(2, e)} onDoubleClick={onResizeReset} />
              {showTagCategoryMenu && (
                <div className="tag-category-dropdown">
                  {TAG_CATEGORIES.map(cat => (
                    <button
                      key={cat.prefix}
                      className={`tag-category-option${tagSortCategory === cat.prefix ? ' active' : ''}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleTagCategorySelect(cat.prefix);
                      }}
                    >
                      <span className={`tag-category-dot tag-${cat.prefix}`} />
                      {t(cat.labelKey, language)}
                      {sortBy === 'tags' && tagSortCategory === cat.prefix ? ` ${sortGlyph(true, sortOrder)}` : ''}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="search-th clickable" onClick={() => handleSortChange('memo')}>
              {t('memos', language)}{getSortIndicator('memo')}
              <span className="col-resize-handle" onMouseDown={e => onResizeStart(3, e)} onDoubleClick={onResizeReset} />
            </div>
            <div className="search-th clickable" onClick={() => handleSortChange('created')}>
              {t('createdDate', language)}{getSortIndicator('created')}
              <span className="col-resize-handle" onMouseDown={e => onResizeStart(4, e)} onDoubleClick={onResizeReset} />
            </div>
            <div className="search-th clickable" onClick={() => handleSortChange('modified')}>
              {t('modifiedDate', language)}{getSortIndicator('modified')}
            </div>
          </div>
          <div className="search-virtual-body" ref={setVirtualContainerEl} onScroll={handleVirtualScroll}>
            {filteredNotes.length === 0 ? (
              <div className="search-grid-row search-empty-row">
                <div className="search-td search-empty">
                  {searchIndexing ? t('indexInitializing', language) : t('noResults', language)}
                </div>
              </div>
            ) : (() => {
              const totalHeight = filteredNotes.length * ROW_HEIGHT;
              const startIdx = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
              const endIdx = Math.min(filteredNotes.length - 1, Math.ceil((scrollTop + virtualHeight) / ROW_HEIGHT) + OVERSCAN);
              const rows = [];
              for (let i = startIdx; i <= endIdx; i++) {
                const note = filteredNotes[i];
                rows.push(
                  <FrontmatterResultRow
                    key={note.path}
                    style={{ position: 'absolute', top: i * ROW_HEIGHT, height: ROW_HEIGHT, width: '100%' } as CSSProperties}
                    note={note}
                    frontmatterQuery={frontmatterQuery}
                    getTemplateCustomColor={getTemplateCustomColor}
                    onNoteClick={handleNoteClick}
                    onNoteHover={handleNoteHover}
                    onContextMenu={handleNoteContextMenu}
                    onSelect={handleContainerSelect}
                    isMultiSelected={selectedNotePaths.has(note.path)}
                    onMultiClick={handleFrontmatterMultiClick}
                    tagSortCategory={tagSortCategory}
                    selectRowLabel={t('selectRow', language)}
                  />
                );
              }
              return (
                <div style={{ height: totalHeight, position: 'relative' }}>
                  {rows}
                </div>
              );
            })()}
          </div>
        </div>
      ) : mode === 'contents' ? (
        <div className="search-content-results">
          {filteredContentResults.length === 0 ? (
            <div className="search-content-empty">
              {!contentsQuery.trim() ? (
                <div className="search-content-prompt">
                  <div className="search-content-prompt__headline">
                    {t('contentsSearchPromptHeadline', language)}
                  </div>
                  <div className="search-content-prompt__hint">
                    {t('contentsSearchPromptHint', language)}
                  </div>
                  {recentSearches.length > 0 && (
                    <div className="search-content-recent">
                      <div className="search-content-recent__header">
                        <span>{t('recentSearches', language)}</span>
                        <button
                          type="button"
                          className="search-content-recent__clear"
                          onClick={clearRecentSearches}
                        >
                          {t('clear', language)}
                        </button>
                      </div>
                      <div className="search-content-recent__list">
                        {recentSearches.map(q => (
                          <button
                            key={q}
                            type="button"
                            className="search-content-recent__item"
                            onClick={() => setContentsQuery(q)}
                          >
                            {q}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              ) : searchIndexing ? t('indexInitializing', language) : t('noResults', language)}
            </div>
          ) : (
            filteredContentResults.map(result => (
              <ContentResultCard
                key={result.path}
                result={result}
                contentsQuery={contentsQuery}
                getTemplateCustomColor={getTemplateCustomColor}
                onNoteClick={handleNoteClick}
                onNoteHover={handleNoteHover}
                vaultPath={vaultPath}
              />
            ))
          )}
        </div>
      ) : mode === 'attachments' ? (
        // Track B Phase B-3 PART 6 (HanBin 2026-05-13): the entire tab body
        // is now driven by `AttachmentRef` index via AttachmentsTab. Legacy
        // filesystem-walk rendering (and the AttachmentResultRow path,
        // filteredAttachments memo, selection state, etc.) are kept around
        // through session 2; session 3 will remove them once the new flow
        // covers every action.
        <div className="search-table-wrapper" ref={searchTableRef}>
          <AttachmentsTab
            containerPath={containerPath}
            query={attachmentsQuery}
            extensionFilter={attachmentExtensionFilter}
            notePathFilter={attachmentNotePathFilter}
            tierFilter={attachmentTierFilter}
            syncFilter={attachmentSyncFilter}
          />
        </div>
      ) : mode === 'graph' ? (
        <Suspense fallback={<div className="graph-loading">{t('graphLoadingSearch', language)}</div>}>
          <GraphView containerPath={containerPath} refreshTrigger={refreshTrigger} />
        </Suspense>
      ) : null}

      {mode !== 'graph' && <div className="search-status-bar">
        <span className="search-count">
          {mode === 'frontmatter'
            ? tf('notesCountLabel', language, { count: filteredNotes.length })
            : mode === 'contents'
              ? tf('resultsCountLabel', language, { count: filteredContentResults.length })
              : tf('attachmentsCountLabel', language, { count: attachmentRefCount })}
        </span>
      </div>}

      {/* Custom context menu for multi-select notes */}
      {noteContextMenu && (
        <div
          ref={noteContextMenuRef}
          className="context-menu note-context-menu"
          style={{
            position: 'fixed',
            left: noteContextMenu.x,
            top: noteContextMenu.y,
          }}
        >
          <button
            className="context-menu-item"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={handleBulkMoveNotes}
          >
            {tf('moveSelectedNotes', language, { count: selectedNotePaths.size })}
          </button>
          {nonContainerSelectedPaths.length > 0 && (
            <button
              className="context-menu-item"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={handleBulkAddTags}
            >
              {tf('addTagsToSelectedNotes', language, { count: nonContainerSelectedPaths.length })}
            </button>
          )}
          <button
            className="context-menu-item delete"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={handleBulkDeleteNotes}
          >
            {tf('deleteSelectedNotes', language, { count: selectedNotePaths.size })}
          </button>
        </div>
      )}

      {/* Bulk Tag Modal */}
      {showBulkTagModal && nonContainerSelectedPaths.length > 0 && (
        <BulkTagModal
          paths={nonContainerSelectedPaths}
          language={language}
          onClose={() => setShowBulkTagModal(false)}
          onComplete={() => {
            setShowBulkTagModal(false);
            setSelectedNotePaths(new Set());
          }}
        />
      )}

    </div>
  );
}

export default Search;
