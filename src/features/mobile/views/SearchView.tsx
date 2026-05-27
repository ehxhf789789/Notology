/**
 * SearchView — Mobile search with 4-tab parity to desktop (Stage 5.0.10d).
 *
 * Tabs (matches desktop `Search.tsx` modes):
 *   - frontmatter : queryNotes({}) + client-side title/tag filter
 *   - contents    : full-text body search (legacy default, preserved)
 *   - attachments : searchAttachments
 *   - graph       : inline mobile GraphView (same component as the
 *                   container-list graph mode)
 *
 * Selected tab persists in localStorage so the user lands on whatever
 * mode they last used. The pre-search state (stats + recent searches +
 * recent notes) is shown when the active tab has no query, except for
 * `graph` which always renders the canvas.
 */
import { useState, useCallback, useRef, useMemo, useEffect, lazy, Suspense } from 'react';
import { Search, FileText, Clock, Paperclip, Network, Tag } from 'lucide-react';
import { searchCommands } from '../../../core/services/tauriCommands';
import { useFileTreeStore } from '../../../core/stores/fileTreeStore';
import { useSettingsStore } from '../../../core/stores/settingsStore';
import { SearchBar, EmptyState } from '../components/common';
import { t, tf, type LanguageSetting } from '../../../core/utils/i18n';
import type {
  SearchResult,
  FileNode,
  NoteMetadata,
  AttachmentInfo,
} from '../../../core/types';

const GraphView = lazy(() => import('./GraphView'));

interface Props {
  onOpenNote?: (notePath: string, name: string) => void;
  /** Opens a container when the user activates a node in the embedded graph. */
  onOpenContainer?: (containerPath: string, name: string) => void;
}

type MobileSearchMode = 'frontmatter' | 'contents' | 'attachments' | 'graph';

const MODE_STORAGE_KEY = 'notology-mobile-search-mode';
const MAX_RECENT = 8;

// Recursively count .md files
function countMdFiles(nodes: FileNode[]): number {
  let count = 0;
  for (const n of nodes) {
    if (!n.is_dir && n.name.endsWith('.md') && !n.is_folder_note) count++;
    if (n.is_dir && n.children) count += countMdFiles(n.children);
  }
  return count;
}

// Recursively count containers (directories, excluding _att and hidden)
function countContainers(nodes: FileNode[]): number {
  let count = 0;
  for (const n of nodes) {
    if (n.is_dir && !n.name.startsWith('.') && !n.name.endsWith('_att')) {
      count++;
      if (n.children) count += countContainers(n.children);
    }
  }
  return count;
}

// Flatten all .md files and sort by mtime descending
function getRecentNotes(nodes: FileNode[], limit: number): FileNode[] {
  const all: FileNode[] = [];
  function collect(ns: FileNode[]) {
    for (const n of ns) {
      if (!n.is_dir && n.name.endsWith('.md') && !n.is_folder_note) all.push(n);
      if (n.is_dir && n.children) collect(n.children);
    }
  }
  collect(nodes);
  return all.sort((a, b) => (b.mtime || 0) - (a.mtime || 0)).slice(0, limit);
}

// 5.0.10a — i18n-aware relative time. Same keys as NoteListView.formatDate.
function formatDate(mtime: number | undefined, language: LanguageSetting): string {
  if (!mtime) return '';
  const d = new Date(mtime * 1000);
  const now = new Date();
  const diffMin = Math.floor((now.getTime() - d.getTime()) / 60000);
  if (diffMin < 1) return t('mRelJustNow', language);
  if (diffMin < 60) return tf('mRelMinAgo', language, { n: diffMin });
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return tf('mRelHrAgo', language, { n: diffHr });
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return tf('mRelDayAgo', language, { n: diffDay });
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function getFolderFromPath(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/');
  return parts.length >= 2 ? parts[parts.length - 2] : '';
}

function loadInitialMode(): MobileSearchMode {
  try {
    const raw = localStorage.getItem(MODE_STORAGE_KEY);
    if (raw === 'frontmatter' || raw === 'contents' || raw === 'attachments' || raw === 'graph') {
      return raw;
    }
  } catch {}
  return 'contents';
}

export default function SearchView({ onOpenNote, onOpenContainer }: Props) {
  const fileTree = useFileTreeStore(s => s.fileTree);
  const vaultPath = useFileTreeStore(s => s.vaultPath);
  const language = useSettingsStore(s => s.language);

  const [mode, setMode] = useState<MobileSearchMode>(loadInitialMode);
  const [query, setQuery] = useState('');
  const [contentResults, setContentResults] = useState<SearchResult[]>([]);
  const [frontmatterResults, setFrontmatterResults] = useState<NoteMetadata[]>([]);
  const [attachmentResults, setAttachmentResults] = useState<AttachmentInfo[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchTime, setSearchTime] = useState(0);
  const [recentSearches, setRecentSearches] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem('notology-recent-searches') || '[]'); }
    catch { return []; }
  });
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    try { localStorage.setItem(MODE_STORAGE_KEY, mode); } catch {}
  }, [mode]);

  // Stats
  const totalNotes = useMemo(() => countMdFiles(fileTree), [fileTree]);
  const containerCount = useMemo(() => countContainers(fileTree), [fileTree]);
  const recentNotes = useMemo(() => getRecentNotes(fileTree, 5), [fileTree]);

  const saveRecent = useCallback((q: string) => {
    setRecentSearches(prev => {
      const next = [q, ...prev.filter(s => s !== q)].slice(0, MAX_RECENT);
      localStorage.setItem('notology-recent-searches', JSON.stringify(next));
      return next;
    });
  }, []);

  const runSearch = useCallback(async (value: string, currentMode: MobileSearchMode) => {
    if (!value.trim()) {
      setContentResults([]);
      setFrontmatterResults([]);
      setAttachmentResults([]);
      return;
    }

    setSearching(true);
    const start = performance.now();
    const lower = value.trim().toLowerCase();

    try {
      if (currentMode === 'contents') {
        const res = await searchCommands.fullTextSearch(value, 50);
        setContentResults(res);
      } else if (currentMode === 'frontmatter') {
        // No backend text-on-metadata command — fetch all notes and filter
        // client-side on title + tags. Matches the desktop "frontmatter" mode
        // semantic without needing a separate Tauri command.
        const all = await searchCommands.queryNotes({});
        const filtered = all.filter(n =>
          n.title?.toLowerCase().includes(lower)
          || (Array.isArray(n.tags) && n.tags.some(tag => tag?.toLowerCase().includes(lower)))
        ).slice(0, 50);
        setFrontmatterResults(filtered);
      } else if (currentMode === 'attachments') {
        if (vaultPath) {
          const res = await searchCommands.searchAttachments(vaultPath, value);
          setAttachmentResults(res.slice(0, 50));
        }
      }
      setSearchTime(Math.round((performance.now() - start) / 10) / 100);
      saveRecent(value.trim());
    } catch (err) {
      console.warn('[SearchView] search failed:', err);
      if (currentMode === 'contents') setContentResults([]);
      else if (currentMode === 'frontmatter') setFrontmatterResults([]);
      else if (currentMode === 'attachments') setAttachmentResults([]);
    } finally {
      setSearching(false);
    }
  }, [vaultPath, saveRecent]);

  const handleSearch = useCallback((value: string) => {
    setQuery(value);
    if (timerRef.current) clearTimeout(timerRef.current);
    if (!value.trim()) {
      setContentResults([]);
      setFrontmatterResults([]);
      setAttachmentResults([]);
      return;
    }
    timerRef.current = setTimeout(() => {
      runSearch(value, mode);
    }, 300);
  }, [runSearch, mode]);

  // Re-run the current query against the active mode when the user
  // switches tabs (so they see the right kind of results without retyping).
  useEffect(() => {
    if (mode === 'graph') return;
    if (!query.trim()) return;
    runSearch(query, mode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  const handleRecentClick = useCallback((q: string) => {
    setQuery(q);
    handleSearch(q);
  }, [handleSearch]);

  const clearRecent = useCallback(() => {
    setRecentSearches([]);
    localStorage.removeItem('notology-recent-searches');
  }, []);

  const getTitle = (r: SearchResult) =>
    r.title || r.path.split(/[/\\]/).pop()?.replace(/\.md$/, '') || '';

  const hasQuery = query.trim().length > 0;
  const isGraph = mode === 'graph';

  // Active mode result count for the status line.
  const activeResultCount =
    mode === 'contents' ? contentResults.length
      : mode === 'frontmatter' ? frontmatterResults.length
      : mode === 'attachments' ? attachmentResults.length
      : 0;

  return (
    <div className="mobile-container-list">
      <h1 className="mobile-large-title">{t('mSearch', language)}</h1>

      {/* 5.0.10d — 4-tab navigation mirrors desktop Search modes. */}
      <div className="m-search-tabs" role="tablist" aria-label={t('mSearch', language)}>
        <button
          role="tab"
          aria-selected={mode === 'frontmatter'}
          className={`m-search-tab ${mode === 'frontmatter' ? 'active' : ''}`}
          onClick={() => setMode('frontmatter')}
        >
          <Tag size={14} strokeWidth={2} />
          <span>{t('notes', language)}</span>
        </button>
        <button
          role="tab"
          aria-selected={mode === 'contents'}
          className={`m-search-tab ${mode === 'contents' ? 'active' : ''}`}
          onClick={() => setMode('contents')}
        >
          <FileText size={14} strokeWidth={2} />
          <span>{t('body', language)}</span>
        </button>
        <button
          role="tab"
          aria-selected={mode === 'attachments'}
          className={`m-search-tab ${mode === 'attachments' ? 'active' : ''}`}
          onClick={() => setMode('attachments')}
        >
          <Paperclip size={14} strokeWidth={2} />
          <span>{t('attachments', language)}</span>
        </button>
        <button
          role="tab"
          aria-selected={mode === 'graph'}
          className={`m-search-tab ${mode === 'graph' ? 'active' : ''}`}
          onClick={() => setMode('graph')}
        >
          <Network size={14} strokeWidth={2} />
          <span>{t('graph', language)}</span>
        </button>
      </div>

      {/* Search bar — hidden in graph mode (graph has its own gestures). */}
      {!isGraph && (
        <div style={{ padding: '0 16px 12px' }}>
          <SearchBar
            value={query}
            onChange={handleSearch}
            placeholder={t('mSearchPlaceholder', language)}
          />
        </div>
      )}

      {/* Graph mode — inline canvas, no query bar. */}
      {isGraph ? (
        <div className="m-search-graph">
          <Suspense fallback={<div className="m-search-status">{t('mSearching', language)}</div>}>
            <GraphView onOpenNote={onOpenNote} onOpenContainer={onOpenContainer} />
          </Suspense>
        </div>
      ) : hasQuery ? (
        <div className="m-search-results">
          {searching ? (
            <div className="m-search-status">{t('mSearching', language)}</div>
          ) : activeResultCount > 0 ? (
            <>
              <div className="m-search-status">
                {activeResultCount}개 결과 · {searchTime}초
              </div>

              {mode === 'contents' && contentResults.map((r, i) => (
                <button
                  key={r.path}
                  className="m-search-result-card stagger-item"
                  style={{ animationDelay: `${Math.min(i, 10) * 40}ms` }}
                  onClick={() => onOpenNote?.(r.path, getTitle(r))}
                >
                  <div className="m-search-result-title">
                    <FileText size={14} />
                    <span>{getTitle(r)}</span>
                  </div>
                  {r.snippet && (
                    <div
                      className="m-search-result-snippet"
                      dangerouslySetInnerHTML={{ __html: r.snippet }}
                    />
                  )}
                  <div className="m-search-result-meta">
                    {getFolderFromPath(r.path) && (
                      <span className="m-search-result-folder">
                        {getFolderFromPath(r.path)}
                      </span>
                    )}
                  </div>
                </button>
              ))}

              {mode === 'frontmatter' && frontmatterResults.map((n, i) => {
                const name = n.title || n.path.split(/[/\\]/).pop()?.replace(/\.md$/, '') || '';
                return (
                  <button
                    key={n.path}
                    className="m-search-result-card stagger-item"
                    style={{ animationDelay: `${Math.min(i, 10) * 40}ms` }}
                    onClick={() => onOpenNote?.(n.path, name)}
                  >
                    <div className="m-search-result-title">
                      <Tag size={14} />
                      <span>{name}</span>
                    </div>
                    {n.tags && n.tags.length > 0 && (
                      <div className="m-search-result-snippet">
                        {n.tags.slice(0, 6).join(' · ')}
                      </div>
                    )}
                    <div className="m-search-result-meta">
                      {n.note_type && (
                        <span className="m-search-result-folder">{n.note_type}</span>
                      )}
                      {getFolderFromPath(n.path) && (
                        <span className="m-search-result-folder">
                          {getFolderFromPath(n.path)}
                        </span>
                      )}
                    </div>
                  </button>
                );
              })}

              {mode === 'attachments' && attachmentResults.map((a, i) => (
                <button
                  key={a.path}
                  className="m-search-result-card stagger-item"
                  style={{ animationDelay: `${Math.min(i, 10) * 40}ms` }}
                  onClick={() => {
                    // Attachments are owned by a parent note — open that note.
                    if (a.inferred_note_path) onOpenNote?.(a.inferred_note_path, a.note_name || a.file_name);
                  }}
                >
                  <div className="m-search-result-title">
                    <Paperclip size={14} />
                    <span>{a.file_name}</span>
                  </div>
                  {a.note_name && (
                    <div className="m-search-result-snippet">
                      {tf('mAttachOf', language, { note: a.note_name })}
                    </div>
                  )}
                  <div className="m-search-result-meta">
                    {a.container && (
                      <span className="m-search-result-folder">{a.container}</span>
                    )}
                    {a.is_conflict && (
                      <span className="m-search-result-folder">{t('mConflict', language)}</span>
                    )}
                  </div>
                </button>
              ))}
            </>
          ) : (
            <EmptyState
              icon={<Search size={48} />}
              title={t('mNoResults', language)}
              description={t('mNoResultsHint', language)}
            />
          )}
        </div>
      ) : (
        /* Pre-search state — stats + recent. Shared across non-graph modes. */
        <div className="m-search-presearch">
          {/* Stats cards */}
          <div className="m-search-stats">
            <div className="m-search-stat-card">
              <span className="m-search-stat-icon">📝</span>
              <span className="m-search-stat-number">{totalNotes}</span>
              <span className="m-search-stat-label">{t('mTotalNotes', language)}</span>
            </div>
            <div className="m-search-stat-card">
              <span className="m-search-stat-icon">📁</span>
              <span className="m-search-stat-number">{containerCount}</span>
              <span className="m-search-stat-label">{t('mContainers', language)}</span>
            </div>
            <div className="m-search-stat-card">
              <span className="m-search-stat-icon">📄</span>
              <span className="m-search-stat-number">{recentNotes.length}</span>
              <span className="m-search-stat-label">{t('mRecentModified', language)}</span>
            </div>
          </div>

          {/* Recent searches */}
          {recentSearches.length > 0 && (
            <div className="m-search-section">
              <div className="m-search-section-header">
                <span>{t('mRecentSearch', language)}</span>
                <button className="m-search-section-action" onClick={clearRecent}>{t('mClearAll', language)}</button>
              </div>
              {recentSearches.map((q, i) => (
                <button
                  key={`${q}-${i}`}
                  className="m-search-recent-item"
                  onClick={() => handleRecentClick(q)}
                >
                  <Clock size={14} className="m-search-recent-icon" />
                  <span>{q}</span>
                </button>
              ))}
            </div>
          )}

          {/* Recent notes */}
          {recentNotes.length > 0 && (
            <div className="m-search-section m-search-recent-notes">
              <div className="m-search-section-header">
                <span>{t('mRecentNotes', language)}</span>
              </div>
              {recentNotes.map(n => {
                const name = n.name.replace(/\.md$/, '');
                const folder = getFolderFromPath(n.path);
                return (
                  <button
                    key={n.path}
                    className="m-search-recent-note"
                    onClick={() => onOpenNote?.(n.path, name)}
                  >
                    <span className="m-search-recent-note-dot" />
                    <div className="m-search-recent-note-body">
                      <div className="m-search-recent-note-title">{name}</div>
                      <div className="m-search-recent-note-meta">
                        {folder && `${folder} · `}{formatDate(n.mtime, language)}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
