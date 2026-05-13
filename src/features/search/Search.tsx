import { useState, useEffect, useCallback, useMemo, useRef, lazy, Suspense, type CSSProperties } from 'react';
import { searchCommands, utilCommands } from '../../core/services/tauriCommands';
import { FilePlus, Filter } from 'lucide-react';

const GraphView = lazy(() => import('../graph/GraphView'));
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
import type { NoteFilter, NoteMetadata, SearchResult, SearchMode, AttachmentInfo } from '../../core/types';
import { t, tf } from '../../core/utils/i18n';
import { getTemplateCustomColor as getTemplateColor } from '../content-cache/noteTypeHelpers';
import { NOTE_TYPES } from './searchHelpers';
import { SearchFilters } from './SearchFilters';
import { FrontmatterResultRow, ContentResultCard, AttachmentResultRow, DetailsResultCard } from './SearchResultItem';
import AttachmentsTab from './AttachmentsTab';
import BulkTagModal from '../modals/BulkTagModal';
import FloatingWords from './FloatingWords';

// Conditional logging - only in development
const DEV = import.meta.env.DEV;
const log = DEV ? console.log.bind(console) : () => {};

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
  const [attachmentResults, setAttachmentResults] = useState<AttachmentInfo[]>([]);
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
  const [showDateFilters, setShowDateFilters] = useState(false);
  // Frontmatter tab filters
  const [frontmatterTypeFilter, setFrontmatterTypeFilter] = useState('');
  const [frontmatterTagFilter, setFrontmatterTagFilter] = useState('');
  const [frontmatterMemoFilter, setFrontmatterMemoFilter] = useState<'all' | 'has' | 'none'>('all');
  const [showFolderNotes, setShowFolderNotes] = useState(true);
  // Details tab filters
  const [detailsTypeFilter, setDetailsTypeFilter] = useState('');
  const [detailsTagFilter, setDetailsTagFilter] = useState('');
  // Contents tab filters
  const [showContentsFilters, setShowContentsFilters] = useState(false);
  const [contentsTypeFilter, setContentsTypeFilter] = useState('');
  // Attachments tab filters
  const [showAttachmentsFilters, setShowAttachmentsFilters] = useState(false);
  const [attachmentsContainerFilter, setAttachmentsContainerFilter] = useState('');
  const [attachmentsExtensionFilter, setAttachmentsExtensionFilter] = useState('');
  const [attachmentsShowDummyOnly, setAttachmentsShowDummyOnly] = useState(false);
  const [attachmentsNotePathFilter, setAttachmentsNotePathFilter] = useState('');
  const [selectedAttachments, setSelectedAttachments] = useState<Set<string>>(new Set());
  // Multi-select notes (Ctrl+click, Shift+click; Container single-click also uses this)
  const [selectedNotePaths, setSelectedNotePaths] = useState<Set<string>>(new Set());
  const lastSelectedNoteRef = useRef<string | null>(null);
  // Refs for stable callbacks (avoid dependency churn)
  const selectedNotePathsRef = useRef(selectedNotePaths);
  selectedNotePathsRef.current = selectedNotePaths;
  const selectedAttachmentsRef = useRef(selectedAttachments);
  selectedAttachmentsRef.current = selectedAttachments;
  const filteredNotesRef = useRef<NoteMetadata[]>([]);
  const filteredDetailsNotesRef = useRef<NoteMetadata[]>([]);

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
          return prev;
        });
      }
    );
    return unsub;
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

  const searchContents = useCallback(async () => {
    const query = contentsQueryRef.current.trim();
    if (!searchReadyRef.current || searchIndexingRef.current || !query) {
      setContentResults([]);
      return;
    }

    try {
      const results = await searchCommands.fullTextSearch(query, 50);
      if (query === contentsQueryRef.current.trim()) {
        setContentResults(results);
      }
    } catch (err) {
      console.error('Failed to search contents:', err);
      setContentResults([]);
    }
  }, []);

  const searchAttachments = useCallback(async () => {
    if (!searchReadyRef.current || searchIndexingRef.current || !vaultPathRef.current) {
      setAttachmentResults([]);
      return;
    }

    try {
      const results = await searchCommands.searchAttachments(
        vaultPathRef.current,
        attachmentsQueryRef.current.trim(),
      );
      setAttachmentResults(results);
    } catch (err) {
      console.error('Failed to search attachments:', err);
    }
  }, []);

  // Single trigger for frontmatter/details refresh
  useEffect(() => {
    if (mode === 'frontmatter' || mode === 'details') {
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, contentsQuery, searchReady, searchIndexing, refreshTrigger]);

  useEffect(() => {
    if (mode === 'attachments') {
      const timeout = setTimeout(searchAttachments, 10);
      return () => clearTimeout(timeout);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, attachmentsQuery, searchReady, searchIndexing, refreshTrigger]);

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

        const relativePath = normPath.slice(prefix.length + 1);
        if (relativePath.includes('/')) {
          // Nested items: only show folder notes (CONTAINER type with matching pattern)
          if (n.note_type !== 'CONTAINER') continue;
          const parts = relativePath.split('/');
          if (parts.length !== 2) continue;
          if (parts[1].toLowerCase() !== `${parts[0].toLowerCase()}.md`) continue;
        }
      }

      // Query filter
      if (q && !n.title.toLowerCase().includes(q) &&
          !n.tags.some(t => t.toLowerCase().includes(q)) &&
          !n.note_type.toLowerCase().includes(q)) continue;

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

  // Details mode filtering — single-pass loop (avoids intermediate arrays)
  const filteredDetailsNotes = useMemo(() => {
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

    // Pre-compute tag query
    const tagQuery = detailsTagFilter.trim() ? detailsTagFilter.toLowerCase() : null;

    for (const n of notes) {
      // Container path filter
      if (prefix) {
        const normPath = n.path.replace(/\\/g, '/');
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
      if (detailsTypeFilter && n.note_type !== detailsTypeFilter) continue;

      // Tag filter
      if (tagQuery && !n.tags.some(t => t.toLowerCase().includes(tagQuery))) continue;

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

      if (sortBy === 'tags' && tagSortCategory) {
        const prefix = tagSortCategory + '/';
        const aTags = a.tags.filter(t => t.startsWith(prefix)).sort();
        const bTags = b.tags.filter(t => t.startsWith(prefix)).sort();
        const aFirst = aTags.length > 0 ? aTags[0] : null;
        const bFirst = bTags.length > 0 ? bTags[0] : null;
        if (!aFirst && !bFirst) return b.modified.localeCompare(a.modified);
        if (!aFirst) return 1;
        if (!bFirst) return -1;
        const cmp = aFirst.localeCompare(bFirst);
        const dir = sortOrder === 'asc' ? cmp : -cmp;
        return dir !== 0 ? dir : b.modified.localeCompare(a.modified);
      }

      return 0;
    });

    filteredDetailsNotesRef.current = result;
    return result;
  }, [notes, containerPath, detailsTypeFilter, detailsTagFilter, sortBy, sortOrder, tagSortCategory]);

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

    return result;
  }, [contentResults, containerPath, contentsTypeFilter]);

  // Attachments filtering — single-pass loop
  const filteredAttachments = useMemo(() => {
    const result: AttachmentInfo[] = [];

    // Pre-compute container prefix
    const prefix = containerPath ? containerPath.replace(/\\/g, '/') : null;

    // Pre-compute filter values
    const containerQuery = attachmentsContainerFilter.trim() ? attachmentsContainerFilter.toLowerCase() : null;
    const ext = attachmentsExtensionFilter.trim() ? attachmentsExtensionFilter.toLowerCase().replace('.', '') : null;
    const pathQuery = attachmentsNotePathFilter.trim() ? attachmentsNotePathFilter.toLowerCase() : null;

    for (const a of attachmentResults) {
      const normPath = a.path.replace(/\\/g, '/');

      // Container path filter
      if (prefix) {
        if (!normPath.startsWith(prefix + '/')) continue;

        const relativePath = normPath.slice(prefix.length + 1);
        const parts = relativePath.split('/');

        // Direct child attachment: note.md_att/file.png (2 parts)
        // Nested attachment: subfolder/note.md_att/file.png (3 parts, folder note only)
        if (parts.length === 2) {
          // OK
        } else if (parts.length === 3) {
          const folderName = parts[0];
          const attFolder = parts[1];
          if (attFolder.toLowerCase() !== `${folderName.toLowerCase()}.md_att`) continue;
        } else {
          continue;
        }
      }

      // Container filter
      if (containerQuery && !a.container.toLowerCase().includes(containerQuery)) continue;

      // Extension filter
      if (ext) {
        const fileExt = a.file_name.split('.').pop()?.toLowerCase() || '';
        if (fileExt !== ext) continue;
      }

      // Dummy file filter
      if (attachmentsShowDummyOnly && a.note_relative_path !== '-') continue;

      // Note path filter
      if (pathQuery) {
        if (!a.inferred_note_path.toLowerCase().includes(pathQuery) &&
            !a.note_relative_path.toLowerCase().includes(pathQuery)) continue;
      }

      result.push(a);
    }

    return result;
  }, [attachmentResults, containerPath, attachmentsContainerFilter, attachmentsExtensionFilter, attachmentsShowDummyOnly, attachmentsNotePathFilter]);

  // Double-click detection: track first click time, open window only on confirmed double-click
  // This prevents flash when single-clicking (window was being created then closed after 350ms)
  const pendingNoteOpenRef = useRef<{ path: string; time: number } | null>(null);

  const handleNoteClick = useCallback((path: string, noteType?: string) => {
    if (noteType?.toUpperCase() === 'CONTAINER') {
      const parts = path.split(/[/\\]/);
      parts.pop();
      const folderPath = parts.join('\\');
      selectContainer(folderPath);
      return;
    }

    const pending = pendingNoteOpenRef.current;
    const now = Date.now();

    // Second click on same note within 500ms → confirmed double-click, open window
    if (pending && pending.path === path && (now - pending.time) < 500) {
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

  const handleAttachmentClick = useCallback((e: React.MouseEvent, att: AttachmentInfo) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      e.stopPropagation();
      setSelectedAttachments(prev => {
        const newSet = new Set(prev);
        if (newSet.has(att.path)) {
          newSet.delete(att.path);
        } else {
          newSet.add(att.path);
        }
        return newSet;
      });
      return;
    }

    setSelectedAttachments(new Set());
    const isPreviewable = /\.(md|pdf|png|jpg|jpeg|gif|webp|svg|bmp|ico|json|py|js|ts|jsx|tsx|css|html|xml|yaml|yml|toml|rs|go|java|c|cpp|h|hpp|cs|rb|php|sh|bash|sql|lua|r|swift|kt|scala|doc|docx|ppt|pptx|xls|xlsx|hwp|hwpx)$/i.test(att.path);
    if (isPreviewable) {
      hoverActions.open(att.path);
    } else {
      utilCommands.openInDefaultApp(att.path);
    }
  }, []);

  const [customContextMenu, setCustomContextMenu] = useState<{ x: number; y: number } | null>(null);
  const customContextMenuRef = useRef<HTMLDivElement>(null);

  const handleAttachmentContextMenu = useCallback((e: React.MouseEvent, att: AttachmentInfo) => {
    e.preventDefault();

    if (selectedAttachmentsRef.current.size > 0) {
      if (!selectedAttachmentsRef.current.has(att.path)) {
        setSelectedAttachments(prev => new Set(prev).add(att.path));
      }
      setCustomContextMenu({ x: e.clientX, y: e.clientY });
      return;
    }

    modalActions.showContextMenu(att.file_name, { x: e.clientX, y: e.clientY }, att.note_path, att.path, false, false, undefined, true, true);
  }, []);

  // Close custom context menu on outside click
  useEffect(() => {
    if (!customContextMenu) return;

    const handleClickOutside = (e: MouseEvent) => {
      // Only close if click is OUTSIDE the custom context menu
      if (customContextMenuRef.current && !customContextMenuRef.current.contains(e.target as Node)) {
        setCustomContextMenu(null);
      }
    };
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setCustomContextMenu(null);
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEsc);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEsc);
    };
  }, [customContextMenu]);

  // Clear selection on outside click (but not when clicking on attachment rows)
  const searchTableRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (selectedAttachments.size === 0) return;

    const handleOutsideClick = (e: MouseEvent) => {
      // Don't clear if clicking on the custom context menu
      const target = e.target as HTMLElement;
      if (target.closest('.context-menu')) return;

      // Don't clear if clicking on the attachment table rows
      if (searchTableRef.current && searchTableRef.current.contains(target)) return;

      // Don't clear if Ctrl/Meta key is held (user is multi-selecting)
      if (e.ctrlKey || e.metaKey) return;

      // Clear selection
      setSelectedAttachments(new Set());
    };

    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setSelectedAttachments(new Set());
      }
    };

    document.addEventListener('mousedown', handleOutsideClick);
    document.addEventListener('keydown', handleEsc);
    return () => {
      document.removeEventListener('mousedown', handleOutsideClick);
      document.removeEventListener('keydown', handleEsc);
    };
  }, [selectedAttachments.size]);

  const handleBatchDeleteDummy = useCallback(() => {
    // Exclude conflict files from batch deletion — they need manual resolution
    const dummyFiles = filteredAttachments.filter(a => a.note_relative_path === '-' && !a.is_conflict);
    const conflictFiles = filteredAttachments.filter(a => a.is_conflict);

    if (dummyFiles.length === 0 && conflictFiles.length > 0) {
      modalActions.showAlertModal(
        t('conflictFilesOnly', language),
        tf('conflictFilesMsg', language, { count: conflictFiles.length })
      );
      return;
    }

    if (dummyFiles.length === 0) {
      return;
    }

    const count = dummyFiles.length;
    const conflictNote = conflictFiles.length > 0
      ? tf('conflictExcluded', language, { count: conflictFiles.length })
      : '';

    // Show confirmation modal - deletion happens in the callback after user confirms
    modalActions.showConfirmDelete(`${t('dummyFile', language)}${conflictNote}`, 'file', async () => {
      try {
        const paths = dummyFiles.map(a => a.path);
        const deleted = await searchCommands.deleteMultipleFiles(paths);

        // Refresh file tree and search
        await fileTreeActions.refreshFileTree();
        refreshActions.incrementSearchRefresh();

        // Refresh attachments list
        await searchAttachments();

        modalActions.showAlertModal(t('deleteComplete', language), `${tf('deletedFilesMsg', language, { count: deleted })}${conflictNote}`);
      } catch (e) {
        console.error('Failed to batch delete dummy files:', e);
        modalActions.showAlertModal(t('deleteFailed', language), `${t('batchDeleteFailed', language)}\n\n${e}`);
      }
    }, count);
  }, [filteredAttachments, searchAttachments]);

  const handleBatchDeleteSelected = useCallback(() => {
    if (selectedAttachments.size === 0) {
      return;
    }

    const count = selectedAttachments.size;
    const pathsToDelete = Array.from(selectedAttachments);

    // Show confirmation modal - deletion happens in the callback after user confirms
    modalActions.showConfirmDelete(t('selectedFiles', language), 'file', async () => {
      try {
        // Use new command that also removes wikilinks from owning notes
        const [deleted, linksRemoved, modifiedNotes] = await searchCommands.deleteAttachmentsWithLinks(pathsToDelete);

        // Clear selection and refresh
        setSelectedAttachments(new Set());
        await fileTreeActions.refreshFileTree();
        refreshActions.incrementSearchRefresh();

        // Refresh attachments list
        await searchAttachments();

        // Refresh any open hover windows that were modified
        for (const notePath of modifiedNotes) {
          refreshHoverWindowsForFile(notePath);
        }

        // Show result using alert modal
        let msg = tf('filesDeletedMsg', language, { count: deleted });
        if (linksRemoved > 0) {
          msg += `\n${tf('wikilinksRemovedMsg', language, { count: linksRemoved })}`;
        }
        modalActions.showAlertModal(t('deleteComplete', language), msg);
      } catch (e) {
        console.error('Failed to batch delete selected files:', e);
        modalActions.showAlertModal(t('deleteFailed', language), `${t('fileDeleteFailed', language)}\n\n${e}`);
      }
    }, count);
  }, [selectedAttachments, searchAttachments]);

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
    if (sortBy !== field) return '';
    return sortOrder === 'asc' ? ' ↑' : ' ↓';
  };

  const getTagSortLabel = () => {
    if (sortBy !== 'tags' || !tagSortCategory) return '';
    const cat = TAG_CATEGORIES.find(c => c.prefix === tagSortCategory);
    const catName = cat ? t(cat.labelKey, language) : '';
    const arrow = sortOrder === 'asc' ? '↑' : '↓';
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
    // Normal click - clear multi-selection
    if (selectedNotePathsRef.current.size > 0) {
      setSelectedNotePaths(new Set());
    }
    lastSelectedNoteRef.current = note.path;
    return false;
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

  const handleDetailsMultiClick = useCallback((e: React.MouseEvent, note: NoteMetadata) => {
    return handleNoteMultiClick(e, note, filteredDetailsNotesRef.current);
  }, [handleNoteMultiClick]);

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
      if (target.closest('.search-table') || target.closest('.search-virtual-wrapper') || target.closest('.search-details-results')) return;
      if (target.closest('.modal-overlay') || target.closest('.bulk-tag-modal')) return;
      if (e.ctrlKey || e.metaKey || e.shiftKey) return;
      setSelectedNotePaths(new Set());
    };
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !showBulkTagModal) setSelectedNotePaths(new Set());
    };
    document.addEventListener('mousedown', handleOutsideClick);
    document.addEventListener('keydown', handleEsc);
    return () => {
      document.removeEventListener('mousedown', handleOutsideClick);
      document.removeEventListener('keydown', handleEsc);
    };
  }, [selectedNotePaths.size, showBulkTagModal]);

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
    const allNotes = [...filteredNotesRef.current, ...filteredDetailsNotesRef.current];
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

  // Count conflict attachments for warning
  const conflictCount = useMemo(() =>
    attachmentResults.filter(a => a.is_conflict).length,
  [attachmentResults]);

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
  const MIN_COL = [80, 50, 60, 30, 80, 80];

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

  // Use CSS fr units — grid natively fills 100% of container (no px measurement gaps)
  const gridTemplateColumns = useMemo(
    () => ratios.map((r, i) => `minmax(${MIN_COL[i]}px, ${r}fr)`).join(' '),
    [ratios],
  );

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
      <div className="search-tabs">
        <button
          className={`search-tab ${mode === 'frontmatter' ? 'active' : ''}`}
          onClick={() => setMode('frontmatter')}
        >
          {t('notes', language)}
        </button>
        <button
          className={`search-tab ${mode === 'contents' ? 'active' : ''}`}
          onClick={() => setMode('contents')}
        >
          {t('body', language)}
        </button>
        <button
          className={`search-tab ${mode === 'attachments' ? 'active' : ''}`}
          onClick={() => setMode('attachments')}
        >
          {t('attachments', language)}
        </button>
        <button
          className={`search-tab ${mode === 'details' ? 'active' : ''}`}
          onClick={() => setMode('details')}
        >
          {t('details', language)}
        </button>
        <button
          className={`search-tab ${mode === 'graph' ? 'active' : ''}`}
          onClick={() => setMode('graph')}
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
        {mode === 'details' ? (
          <div className="search-details-filters">
            <select
              className="search-details-select"
              value={detailsTypeFilter}
              onChange={e => setDetailsTypeFilter(e.target.value)}
            >
              {NOTE_TYPES.map(nt => (
                <option key={nt.value} value={nt.value}>{nt.value === '' ? t('allTypes', language) : nt.label}</option>
              ))}
            </select>
            <input
              className="search-input"
              type="text"
              placeholder={t('tagSearch', language)}
              value={detailsTagFilter}
              onChange={e => setDetailsTagFilter(e.target.value)}
            />
          </div>
        ) : (
          <div className="search-bar">
            <input
              className="search-input"
              type="text"
              placeholder={
                mode === 'frontmatter' ? t('titleTagTypeSearch', language) :
                mode === 'contents' ? t('bodyContentSearch', language) :
                t('attachmentSearch', language)
              }
              value={
                mode === 'frontmatter' ? frontmatterQuery :
                mode === 'contents' ? contentsQuery :
                attachmentsQuery
              }
              onChange={e => {
                const value = e.target.value;
                if (mode === 'frontmatter') setFrontmatterQuery(value);
                else if (mode === 'contents') setContentsQuery(value);
                else setAttachmentsQuery(value);
              }}
            />
            {mode === 'frontmatter' && (
              <button
                className={`search-filter-btn ${showDateFilters ? 'active' : ''}`}
                onClick={() => setShowDateFilters(!showDateFilters)}
                title={t('dateFilter', language)}
              >
                <Filter size={14} />
              </button>
            )}
            {mode === 'contents' && (
              <button
                className={`search-filter-btn ${showContentsFilters ? 'active' : ''}`}
                onClick={() => setShowContentsFilters(!showContentsFilters)}
                title={t('typeFilter', language)}
              >
                <Filter size={14} />
              </button>
            )}
            {mode === 'attachments' && (
              <button
                className={`search-filter-btn ${showAttachmentsFilters ? 'active' : ''}`}
                onClick={() => setShowAttachmentsFilters(!showAttachmentsFilters)}
                title={t('filter', language)}
              >
                <Filter size={14} />
              </button>
            )}
          </div>
        )}
      </div>}

      <SearchFilters
        mode={mode}
        frontmatterTypeFilter={frontmatterTypeFilter}
        setFrontmatterTypeFilter={setFrontmatterTypeFilter}
        frontmatterTagFilter={frontmatterTagFilter}
        setFrontmatterTagFilter={setFrontmatterTagFilter}
        frontmatterMemoFilter={frontmatterMemoFilter}
        setFrontmatterMemoFilter={setFrontmatterMemoFilter}
        showFolderNotes={showFolderNotes}
        setShowFolderNotes={setShowFolderNotes}
        showDateFilters={showDateFilters}
        setShowDateFilters={setShowDateFilters}
        createdAfter={createdAfter}
        setCreatedAfter={setCreatedAfter}
        createdBefore={createdBefore}
        setCreatedBefore={setCreatedBefore}
        modifiedAfter={modifiedAfter}
        setModifiedAfter={setModifiedAfter}
        modifiedBefore={modifiedBefore}
        setModifiedBefore={setModifiedBefore}
        showContentsFilters={showContentsFilters}
        contentsTypeFilter={contentsTypeFilter}
        setContentsTypeFilter={setContentsTypeFilter}
        showAttachmentsFilters={showAttachmentsFilters}
        attachmentsContainerFilter={attachmentsContainerFilter}
        setAttachmentsContainerFilter={setAttachmentsContainerFilter}
        attachmentsExtensionFilter={attachmentsExtensionFilter}
        setAttachmentsExtensionFilter={setAttachmentsExtensionFilter}
        attachmentsShowDummyOnly={attachmentsShowDummyOnly}
        setAttachmentsShowDummyOnly={setAttachmentsShowDummyOnly}
        attachmentsNotePathFilter={attachmentsNotePathFilter}
        setAttachmentsNotePathFilter={setAttachmentsNotePathFilter}
        uniqueTags={uniqueTags}
        filteredAttachments={filteredAttachments}
        selectedAttachments={selectedAttachments}
        onBatchDeleteDummy={handleBatchDeleteDummy}
        onBatchDeleteSelected={handleBatchDeleteSelected}
        detailsTypeFilter={detailsTypeFilter}
        setDetailsTypeFilter={setDetailsTypeFilter}
        detailsTagFilter={detailsTagFilter}
        setDetailsTagFilter={setDetailsTagFilter}
        language={language}
        fetchNotes={fetchNotes}
      />

      {mode === 'frontmatter' ? (
        <div className="search-virtual-wrapper" ref={setWrapperEl} style={{ '--grid-cols': gridTemplateColumns } as CSSProperties}>
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
                      {sortBy === 'tags' && tagSortCategory === cat.prefix ? (sortOrder === 'asc' ? ' ↑' : ' ↓') : ''}
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
                <FloatingWords
                  onWordClick={(word) => setContentsQuery(word)}
                  searchReady={searchReady}
                />
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
          <AttachmentsTab containerPath={containerPath} query={attachmentsQuery} />
        </div>
      ) : mode === 'details' ? (
        /* Details mode - detailed metadata view */
        <div className="search-details-results">
          {filteredDetailsNotes.length === 0 ? (
            <div className="search-content-empty">
              {searchIndexing ? t('indexInitializing', language) : t('noResults', language)}
            </div>
          ) : (
            filteredDetailsNotes.map(note => (
              <DetailsResultCard
                key={note.path}
                note={note}
                getTemplateCustomColor={getTemplateCustomColor}
                onNoteClick={handleNoteClick}
                onNoteHover={handleNoteHover}
                onContextMenu={handleNoteContextMenu}
                onTagClick={setDetailsTagFilter}
                language={language}
                onSelect={handleContainerSelect}
                isMultiSelected={selectedNotePaths.has(note.path)}
                onMultiClick={handleDetailsMultiClick}
                tagSortCategory={tagSortCategory}
              />
            ))
          )}
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
              : mode === 'attachments'
                ? tf('attachmentsCountLabel', language, { count: filteredAttachments.length })
                : tf('notesCountLabel', language, { count: filteredDetailsNotes.length })}
        </span>
      </div>}

      {/* Custom context menu for multi-select attachments */}
      {customContextMenu && (
        <div
          ref={customContextMenuRef}
          className="context-menu"
          style={{
            position: 'fixed',
            left: customContextMenu.x,
            top: customContextMenu.y,
          }}
        >
          <button
            className="context-menu-item delete"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => {
              setCustomContextMenu(null);
              handleBatchDeleteSelected();
            }}
          >
            {tf('deleteSelectedAttachments', language, { count: selectedAttachments.size })}
          </button>
        </div>
      )}

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
