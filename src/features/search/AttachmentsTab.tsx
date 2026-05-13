/**
 * Track B Phase B-3 PART 6 — Attachments tab redesign (HanBin 2026-05-13).
 *
 * Replaces the legacy filesystem-walk based attachments tab with a view
 * driven entirely by the `AttachmentRef` index. The single source of
 * truth is `useAttachmentStore` — no more reconciling `_att/` folders
 * with refs in the new schema.
 *
 * SESSION 1 SCOPE: foundation. Columns, basic click handlers, sync-state
 * badges. Filters / bulk actions / context menu are placeholder-only and
 * land in session 2.
 */

import { useMemo, useCallback, useState } from 'react';
import { useAttachmentStore } from '../sync_v2/stores/attachmentStore';
import { useVaultPath } from '../../core/stores/fileTreeStore';
import { hoverActions } from '../hover-windows/stores/hoverStore';
import { useSettingsStore } from '../../core/stores/settingsStore';
import { syncV2Commands, type AttachmentRefDto } from '../sync_v2/syncV2Commands';
import { utilCommands } from '../../core/services/tauriCommands';
import { getAttachmentCategory } from '../suggestions/attachmentCategory';
import { t, tf } from '../../core/utils/i18n';

interface AttachmentsTabProps {
  /** Optional filter: when set, only show refs linked to this folder. */
  containerPath?: string | null;
  /** Text query forwarded from the parent Search component. */
  query: string;
}

type SyncState = 'synced' | 'uploading' | 'stuck' | 'orphan';

interface AttachmentRow {
  ref: AttachmentRefDto;
  syncState: SyncState;
  /** Absolute local path (vault + display_path), normalized to forward slashes. */
  localPath: string;
}

const STUCK_THRESHOLD_MS = 15 * 60 * 1000;

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
  // Subscribe to the byId map's identity so the table re-renders on every
  // store refresh (hydrate / EventBus / polling).
  const byId = useAttachmentStore((s) => s.index.byId);

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const rows: AttachmentRow[] = useMemo(() => {
    const out: AttachmentRow[] = [];
    const q = query.trim().toLowerCase();
    const containerNormalized = containerPath
      ? containerPath.replace(/\\/g, '/').toLowerCase()
      : null;

    for (const ref of byId.values()) {
      // Text query: match originalName OR displayPath basename.
      if (q) {
        const dispBase = (ref.displayPath.split('/').pop() ?? '').toLowerCase();
        if (
          !ref.originalName.toLowerCase().includes(q)
          && !dispBase.includes(q)
        ) continue;
      }

      // Container filter: keep refs whose ANY linked note path starts with
      // the container path. We only have note_ids here, not paths; for the
      // first cut we skip this filter when containerPath is set (rare —
      // user can still text-filter). Full implementation needs a note_id
      // → note_path resolver, which arrives in session 2.
      if (containerNormalized) {
        // No-op for now (session 2 wires note_path lookup).
      }

      const localPath = vaultPath
        ? (vaultPath + '/' + ref.displayPath).replace(/\\/g, '/')
        : ref.displayPath;

      out.push({
        ref,
        syncState: computeSyncState(ref),
        localPath,
      });
    }

    // Default sort: newest first (by attachment_id timestamp).
    out.sort((a, b) => b.ref.attachmentId.localeCompare(a.ref.attachmentId));
    return out;
  }, [byId, query, containerPath, vaultPath]);

  const handleRowClick = useCallback((row: AttachmentRow) => {
    if (!row.localPath) return;
    void hoverActions.open(row.localPath);
  }, []);

  const handleRevealInExplorer = useCallback((row: AttachmentRow) => {
    if (!row.localPath) return;
    void utilCommands.revealInExplorer(row.localPath).catch((e) => {
      console.error('[AttachmentsTab] revealInExplorer failed:', e);
    });
  }, []);

  const handleRetryStuck = useCallback((row: AttachmentRow) => {
    void syncV2Commands.attachmentRetry(row.ref.attachmentId).catch((e) => {
      console.error('[AttachmentsTab] retry failed:', e);
    });
  }, []);

  const handleDeleteOrphan = useCallback((row: AttachmentRow) => {
    // Orphan ref (linked_notes empty) → safe to hard-delete with no
    // wikilink cleanup needed. Bypass the Option C confirmation modal
    // since the user explicitly clicked Delete on a known-broken entry.
    void syncV2Commands.attachmentDelete(row.ref.attachmentId).catch((e) => {
      console.error('[AttachmentsTab] orphan delete failed:', e);
    });
  }, []);

  // Manual reconcile UI was removed (HanBin 2026-05-13): metadata
  // discrepancies are auto-corrected by the backend at every vault open
  // (`sync_engine::start` → `reconcile_apply_auto`), and what survives
  // surfaces naturally in this tab as orphan rows (✕ button) plus the
  // editor's ✕ chip visual. A separate "Verify" button only added
  // surface area without paying for itself.

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  return (
    <div className="attachments-tab-v2">
      <table className="search-table">
        <thead>
          <tr>
            <th className="search-th" style={{ width: 32 }}>
              <input
                type="checkbox"
                checked={selectedIds.size > 0 && selectedIds.size === rows.length}
                onChange={(e) => {
                  if (e.target.checked) setSelectedIds(new Set(rows.map((r) => r.ref.attachmentId)));
                  else setSelectedIds(new Set());
                }}
              />
            </th>
            <th className="search-th">{t('fileName', language)}</th>
            <th className="search-th" style={{ width: 90 }}>{t('attachmentSize', language)}</th>
            <th className="search-th">{t('attachmentLinkedNotes', language)}</th>
            <th className="search-th" style={{ width: 110 }}>{t('attachmentSyncState', language)}</th>
            <th className="search-th" style={{ width: 110 }}>{t('attachmentCreated', language)}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <AttachmentRow
              key={row.ref.attachmentId}
              row={row}
              selected={selectedIds.has(row.ref.attachmentId)}
              language={language}
              onToggleSelect={toggleSelect}
              onClick={handleRowClick}
              onReveal={handleRevealInExplorer}
              onRetry={handleRetryStuck}
              onDeleteOrphan={handleDeleteOrphan}
            />
          ))}
          {rows.length === 0 && (
            <tr>
              <td className="search-td search-empty" colSpan={6}>
                {t('noAttachments', language)}
              </td>
            </tr>
          )}
        </tbody>
      </table>
      <div className="attachments-tab-v2-footer">
        <span className="search-count">{tf('attachmentsCountLabel', language, { count: rows.length })}</span>
        {selectedIds.size > 0 && (
          <span className="attachments-tab-v2-selected">
            {tf('selectedCount', language, { count: selectedIds.size })}
          </span>
        )}
      </div>
    </div>
  );
}

interface RowProps {
  row: AttachmentRow;
  selected: boolean;
  language: ReturnType<typeof useSettingsStore.getState>['language'];
  onToggleSelect: (id: string) => void;
  onClick: (row: AttachmentRow) => void;
  onReveal: (row: AttachmentRow) => void;
  onRetry: (row: AttachmentRow) => void;
  onDeleteOrphan: (row: AttachmentRow) => void;
}

function AttachmentRow({
  row,
  selected,
  language,
  onToggleSelect,
  onClick,
  onReveal,
  onRetry,
  onDeleteOrphan,
}: RowProps) {
  const { ref, syncState } = row;
  const category = getAttachmentCategory(ref.originalName);

  const stateBadgeClass = `attachments-tab-v2-badge attachments-tab-v2-badge-${syncState}`;
  const stateLabel =
    syncState === 'synced' ? t('attachmentSynced', language)
    : syncState === 'uploading' ? t('attachmentUploading', language)
    : syncState === 'stuck' ? t('attachmentStuck', language)
    : t('attachmentOrphan', language);

  return (
    <tr
      className={`attachments-tab-v2-row ${selected ? 'selected' : ''}`}
    >
      <td className="search-td" onClick={(e) => e.stopPropagation()}>
        <input
          type="checkbox"
          checked={selected}
          onChange={() => onToggleSelect(ref.attachmentId)}
        />
      </td>
      <td className="search-td" onClick={() => onClick(row)}>
        <span className={`attachments-tab-v2-name att-${category}`}>
          {ref.originalName}
        </span>
      </td>
      <td className="search-td">{formatSize(ref.sizeBytes)}</td>
      <td className="search-td">
        {ref.linkedNotes.length === 0 ? (
          <span className="attachments-tab-v2-empty-links">—</span>
        ) : (
          <span className="attachments-tab-v2-link-count">
            {tf('attachmentLinkedNotesCount', language, { count: ref.linkedNotes.length })}
          </span>
        )}
      </td>
      <td className="search-td">
        <span className={stateBadgeClass}>{stateLabel}</span>
        {syncState === 'stuck' && (
          <button
            className="attachments-tab-v2-mini-btn"
            onClick={() => onRetry(row)}
            title={t('attachmentStuckRetry', language)}
          >
            ↻
          </button>
        )}
        {syncState === 'orphan' && (
          <button
            className="attachments-tab-v2-mini-btn attachments-tab-v2-mini-btn-danger"
            onClick={() => onDeleteOrphan(row)}
            title={t('attachmentStuckDiscard', language)}
          >
            ✕
          </button>
        )}
      </td>
      <td className="search-td">{formatCreated(ref.attachmentId)}</td>
    </tr>
  );
}
