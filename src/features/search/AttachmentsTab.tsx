/**
 * Track B Phase B-3 PART 6 — Attachments tab (HanBin 2026-05-13).
 *
 * Driven by `useAttachmentStore` (the AttachmentRef index). Layout +
 * row styling all inherit from the shared `.search-table` design
 * tokens used by the other Search tabs so the tab feels native.
 *
 * Session 2 adds:
 *   • tier filter pills (image / document / media / data / code / other)
 *   • sync-state filter pills (uploading / stuck / orphan / synced)
 *   • Ctrl/Shift+click multi-select
 *   • right-click context menu via the shared modalActions surface
 *
 * Drag-out from rows lands in session 2.5 (next commit).
 */

import { useMemo, useCallback, useState, useRef } from 'react';
import { useAttachmentStore } from '../sync_v2/stores/attachmentStore';
import { useVaultPath } from '../../core/stores/fileTreeStore';
import { hoverActions } from '../hover-windows/stores/hoverStore';
import { useSettingsStore } from '../../core/stores/settingsStore';
import { syncV2Commands, type AttachmentRefDto } from '../sync_v2/syncV2Commands';
import { modalActions } from '../modals/stores/modalStore';
import { getAttachmentCategory } from '../suggestions/attachmentCategory';
import { requestAttachmentDelete } from '../sync_v2/attachmentDelete';
import { t } from '../../core/utils/i18n';

interface AttachmentsTabProps {
  /** Optional filter: when set, only show refs linked to this folder. */
  containerPath?: string | null;
  /** Text query forwarded from the parent Search component. */
  query: string;
}

type SyncState = 'synced' | 'uploading' | 'stuck' | 'orphan';
type TierKey = 'image' | 'document' | 'media' | 'data' | 'code' | 'archive' | 'contact' | 'markdown' | 'other';

interface AttachmentRow {
  ref: AttachmentRefDto;
  syncState: SyncState;
  tier: TierKey;
  /** Absolute local path (vault + display_path), normalized to forward slashes. */
  localPath: string;
}

const STUCK_THRESHOLD_MS = 15 * 60 * 1000;

const TIER_KEYS: TierKey[] = ['image', 'document', 'media', 'data', 'code', 'archive', 'other'];
const SYNC_KEYS: SyncState[] = ['uploading', 'stuck', 'orphan', 'synced'];

function parseAttachmentIdMs(id: string): number | null {
  const m = id.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);
  if (!m) return null;
  const [, Y, M, D, h, mn, s] = m;
  const t = Date.UTC(+Y, +M - 1, +D, +h, +mn, +s);
  return Number.isFinite(t) ? t : null;
}

function computeSyncState(ref: AttachmentRefDto): SyncState {
  if (ref.linkedNotes.length === 0) return 'orphan';
  if (ref.syncEtag) return 'synced';
  const created = parseAttachmentIdMs(ref.attachmentId);
  if (created !== null && Date.now() - created > STUCK_THRESHOLD_MS) return 'stuck';
  return 'uploading';
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatCreated(attachmentId: string): string {
  const ms = parseAttachmentIdMs(attachmentId);
  if (ms === null) return '—';
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export default function AttachmentsTab({ containerPath, query }: AttachmentsTabProps) {
  const language = useSettingsStore((s) => s.language);
  const vaultPath = useVaultPath();
  const byId = useAttachmentStore((s) => s.index.byId);

  // ── Filter state ─────────────────────────────────────────────────────────
  // Both filters are *additive sets*: empty set = no filter (show all),
  // any item in the set = restrict to those values. Matches the legacy
  // Frontmatter tab's pill behavior so the interaction feels native.
  const [tierFilter, setTierFilter] = useState<Set<TierKey>>(new Set());
  const [syncFilter, setSyncFilter] = useState<Set<SyncState>>(new Set());

  const toggleTier = useCallback((k: TierKey) => {
    setTierFilter((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }, []);
  const toggleSync = useCallback((k: SyncState) => {
    setSyncFilter((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }, []);

  const rows: AttachmentRow[] = useMemo(() => {
    const out: AttachmentRow[] = [];
    const q = query.trim().toLowerCase();

    for (const ref of byId.values()) {
      if (q) {
        const dispBase = (ref.displayPath.split('/').pop() ?? '').toLowerCase();
        if (
          !ref.originalName.toLowerCase().includes(q)
          && !dispBase.includes(q)
        ) continue;
      }

      const tier = getAttachmentCategory(ref.originalName) as TierKey;
      const syncState = computeSyncState(ref);
      if (tierFilter.size > 0 && !tierFilter.has(tier)) continue;
      if (syncFilter.size > 0 && !syncFilter.has(syncState)) continue;

      const localPath = vaultPath
        ? (vaultPath + '/' + ref.displayPath).replace(/\\/g, '/')
        : ref.displayPath;

      out.push({ ref, syncState, tier, localPath });
    }

    out.sort((a, b) => b.ref.attachmentId.localeCompare(a.ref.attachmentId));
    return out;
  }, [byId, query, vaultPath, containerPath, tierFilter, syncFilter]);

  // ── Multi-select (HanBin 2026-05-13) ─────────────────────────────────────
  // Mirrors the Frontmatter tab's Ctrl/Shift+click pattern. Plain click on
  // a row opens its preview (current behavior); modifier clicks toggle
  // selection. The lastSelected ref stores the anchor row for Shift+click
  // range selection.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const lastSelectedRef = useRef<string | null>(null);

  const handleRowClick = useCallback((row: AttachmentRow, e: React.MouseEvent) => {
    const id = row.ref.attachmentId;
    if (e.shiftKey && lastSelectedRef.current) {
      // Range select: pick every id between anchor and current in `rows` order.
      const idx1 = rows.findIndex((r) => r.ref.attachmentId === lastSelectedRef.current);
      const idx2 = rows.findIndex((r) => r.ref.attachmentId === id);
      if (idx1 >= 0 && idx2 >= 0) {
        const [lo, hi] = idx1 < idx2 ? [idx1, idx2] : [idx2, idx1];
        const next = new Set(selectedIds);
        for (let i = lo; i <= hi; i++) next.add(rows[i].ref.attachmentId);
        setSelectedIds(next);
        return;
      }
    }
    if (e.ctrlKey || e.metaKey) {
      // Toggle without opening the preview.
      const next = new Set(selectedIds);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      setSelectedIds(next);
      lastSelectedRef.current = id;
      return;
    }
    // Plain click → open the file. Clears any existing selection so the
    // visual doesn't lie about a stale anchor.
    if (selectedIds.size > 0) setSelectedIds(new Set());
    lastSelectedRef.current = id;
    if (row.localPath) void hoverActions.open(row.localPath);
  }, [rows, selectedIds]);

  // Esc clears selection — same as the editor's wikilink selection plugin.
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape' && selectedIds.size > 0) {
      setSelectedIds(new Set());
    }
  }, [selectedIds]);

  const handleRetryStuck = useCallback((row: AttachmentRow, e: React.MouseEvent) => {
    e.stopPropagation();
    void syncV2Commands.attachmentRetry(row.ref.attachmentId).catch((err) => {
      console.error('[AttachmentsTab] retry failed:', err);
    });
  }, []);

  const handleDeleteOrphan = useCallback((row: AttachmentRow, e: React.MouseEvent) => {
    e.stopPropagation();
    void syncV2Commands.attachmentDelete(row.ref.attachmentId).catch((err) => {
      console.error('[AttachmentsTab] orphan delete failed:', err);
    });
  }, []);

  // ── Right-click context menu ──────────────────────────────────────────────
  // Reuses the shared ContextMenu surface so the menu items + styling
  // match what the editor chip already shows. The deleteCallback routes
  // through Option C semantics when there's a real linked note, and
  // straight to hard-delete for orphan refs (no wikilink to clean up).
  const handleRowContextMenu = useCallback((row: AttachmentRow, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // If user right-clicks a row outside the current selection, treat as
    // a one-off action on that row (matches OS file-manager convention).
    if (!selectedIds.has(row.ref.attachmentId)) {
      setSelectedIds(new Set());
      lastSelectedRef.current = row.ref.attachmentId;
    }

    const firstLinkedNote = row.ref.linkedNotes[0];
    const deleteCallback = () => {
      if (row.syncState === 'orphan' || !firstLinkedNote) {
        // Orphan or no linked note: skip Option C modal — there's nothing
        // to unlink; the user clicked Delete on an already-broken entry.
        void syncV2Commands.attachmentDelete(row.ref.attachmentId).catch((err) => {
          console.error('[AttachmentsTab] orphan ctx-menu delete failed:', err);
        });
        return;
      }
      void requestAttachmentDelete({
        attachmentId: row.ref.attachmentId,
        originalName: row.ref.originalName,
        noteId: firstLinkedNote,
      });
    };

    modalActions.showContextMenu(
      row.ref.originalName,
      { x: e.clientX, y: e.clientY },
      firstLinkedNote ?? '',
      row.localPath,
      false, // isFolder
      true,  // fromSearch
      deleteCallback,
      false, // hideDelete
      true,  // isAttachment
    );
  }, [selectedIds]);

  return (
    <div
      className="attachments-tab-v2-root"
      tabIndex={-1}
      onKeyDown={handleKeyDown}
    >
      <FilterBar
        tierFilter={tierFilter}
        syncFilter={syncFilter}
        onToggleTier={toggleTier}
        onToggleSync={toggleSync}
        language={language}
      />
      <table className="search-table attachments-tab-v2-table">
        <colgroup>
          <col />
          <col style={{ width: 56 }} />
          <col style={{ width: 110 }} />
          <col style={{ width: 80 }} />
          <col style={{ width: 96 }} />
        </colgroup>
        <thead>
          <tr>
            <th className="search-th">{t('fileName', language)}</th>
            <th className="search-th">{t('attachmentLinkedNotesShort', language)}</th>
            <th className="search-th">{t('attachmentSyncShort', language)}</th>
            <th className="search-th">{t('attachmentSize', language)}</th>
            <th className="search-th">{t('attachmentCreatedShort', language)}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <AttachmentRow
              key={row.ref.attachmentId}
              row={row}
              language={language}
              selected={selectedIds.has(row.ref.attachmentId)}
              onClick={handleRowClick}
              onContextMenu={handleRowContextMenu}
              onRetry={handleRetryStuck}
              onDeleteOrphan={handleDeleteOrphan}
            />
          ))}
          {rows.length === 0 && (
            <tr>
              <td className="search-td search-empty" colSpan={5}>
                {t('noAttachments', language)}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

interface FilterBarProps {
  tierFilter: Set<TierKey>;
  syncFilter: Set<SyncState>;
  onToggleTier: (k: TierKey) => void;
  onToggleSync: (k: SyncState) => void;
  language: ReturnType<typeof useSettingsStore.getState>['language'];
}

function FilterBar({ tierFilter, syncFilter, onToggleTier, onToggleSync, language }: FilterBarProps) {
  const tierLabel = (k: TierKey) => {
    // Reuse the existing attachment-category color tokens for the chip
    // background; the text label is the category name in the user's
    // language. Categories without a translation fall through to the key.
    const key = `tier_${k}`;
    return t(key as any, language) || k;
  };
  const syncLabel = (k: SyncState) => {
    return k === 'synced' ? t('attachmentSynced', language)
      : k === 'uploading' ? t('attachmentUploading', language)
      : k === 'stuck' ? t('attachmentStuck', language)
      : t('attachmentOrphan', language);
  };
  return (
    <div className="attachments-tab-v2-filters">
      <div className="attachments-tab-v2-filter-group">
        <span className="attachments-tab-v2-filter-label">{t('tierFilter', language)}</span>
        {TIER_KEYS.map((k) => (
          <button
            key={k}
            className={`attachments-tab-v2-filter-pill att-${k}${tierFilter.has(k) ? ' active' : ''}`}
            onClick={() => onToggleTier(k)}
          >
            {tierLabel(k)}
          </button>
        ))}
      </div>
      <div className="attachments-tab-v2-filter-group">
        <span className="attachments-tab-v2-filter-label">{t('syncFilter', language)}</span>
        {SYNC_KEYS.map((k) => (
          <button
            key={k}
            className={`attachments-tab-v2-filter-pill attachments-tab-v2-filter-pill-${k}${syncFilter.has(k) ? ' active' : ''}`}
            onClick={() => onToggleSync(k)}
          >
            {syncLabel(k)}
          </button>
        ))}
      </div>
    </div>
  );
}

interface RowProps {
  row: AttachmentRow;
  language: ReturnType<typeof useSettingsStore.getState>['language'];
  selected: boolean;
  onClick: (row: AttachmentRow, e: React.MouseEvent) => void;
  onContextMenu: (row: AttachmentRow, e: React.MouseEvent) => void;
  onRetry: (row: AttachmentRow, e: React.MouseEvent) => void;
  onDeleteOrphan: (row: AttachmentRow, e: React.MouseEvent) => void;
}

function AttachmentRow({
  row,
  language,
  selected,
  onClick,
  onContextMenu,
  onRetry,
  onDeleteOrphan,
}: RowProps) {
  const { ref, syncState, tier } = row;

  return (
    <tr
      className={`search-row att-row-${tier}${selected ? ' selected' : ''}`}
      onClick={(e) => onClick(row, e)}
      onContextMenu={(e) => onContextMenu(row, e)}
    >
      <td className="search-td search-title">{ref.originalName}</td>
      <td className="search-td">
        {ref.linkedNotes.length === 0
          ? <span className="attachments-tab-v2-muted">—</span>
          : <span>{ref.linkedNotes.length}</span>}
      </td>
      <td className="search-td">
        <SyncStateBadge state={syncState} language={language} />
        {syncState === 'stuck' && (
          <button
            className="attachments-tab-v2-mini-btn"
            onClick={(e) => onRetry(row, e)}
            title={t('attachmentStuckRetry', language)}
          >
            ↻
          </button>
        )}
        {syncState === 'orphan' && (
          <button
            className="attachments-tab-v2-mini-btn attachments-tab-v2-mini-btn-danger"
            onClick={(e) => onDeleteOrphan(row, e)}
            title={t('attachmentStuckDiscard', language)}
          >
            ✕
          </button>
        )}
      </td>
      <td className="search-td">{formatSize(ref.sizeBytes)}</td>
      <td className="search-td">{formatCreated(ref.attachmentId)}</td>
    </tr>
  );
}

function SyncStateBadge({
  state,
  language,
}: {
  state: SyncState;
  language: ReturnType<typeof useSettingsStore.getState>['language'];
}) {
  const label =
    state === 'synced' ? t('attachmentSynced', language)
    : state === 'uploading' ? t('attachmentUploading', language)
    : state === 'stuck' ? t('attachmentStuck', language)
    : t('attachmentOrphan', language);
  return (
    <span className={`attachments-tab-v2-badge attachments-tab-v2-badge-${state}`}>
      {label}
    </span>
  );
}
