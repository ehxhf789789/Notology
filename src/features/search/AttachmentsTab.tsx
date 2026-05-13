/**
 * Track B Phase B-3 PART 6 — Attachments tab (HanBin 2026-05-13).
 *
 * Driven by `useAttachmentStore` (the AttachmentRef index). To stay
 * visually consistent with the other Search tabs (노트, 본문, 상세) it
 * piggy-backs on the existing `.search-table` / `.search-row` /
 * `.search-th` / `.search-td` classes — no bespoke layout system. Tier
 * is shown the same way the legacy tab showed it: via the colored
 * `.att-row-{category}` left border, NOT inline icons.
 *
 * Session 1 scope: index-driven listing + inline retry/discard for the
 * stuck/orphan rows. Bulk multi-select (Ctrl/Shift+click), filter pills,
 * and right-click context menu land in session 2.
 */

import { useMemo, useCallback } from 'react';
import { useAttachmentStore } from '../sync_v2/stores/attachmentStore';
import { useVaultPath } from '../../core/stores/fileTreeStore';
import { hoverActions } from '../hover-windows/stores/hoverStore';
import { useSettingsStore } from '../../core/stores/settingsStore';
import { syncV2Commands, type AttachmentRefDto } from '../sync_v2/syncV2Commands';
import { getAttachmentCategory } from '../suggestions/attachmentCategory';
import { t } from '../../core/utils/i18n';

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
      // containerPath filter requires note_id→path resolver; arrives in session 2.

      const localPath = vaultPath
        ? (vaultPath + '/' + ref.displayPath).replace(/\\/g, '/')
        : ref.displayPath;

      out.push({
        ref,
        syncState: computeSyncState(ref),
        localPath,
      });
    }

    out.sort((a, b) => b.ref.attachmentId.localeCompare(a.ref.attachmentId));
    return out;
  }, [byId, query, vaultPath, containerPath]);

  const handleRowClick = useCallback((row: AttachmentRow) => {
    if (!row.localPath) return;
    void hoverActions.open(row.localPath);
  }, []);

  const handleRetryStuck = useCallback((row: AttachmentRow, e: React.MouseEvent) => {
    e.stopPropagation();
    void syncV2Commands.attachmentRetry(row.ref.attachmentId).catch((err) => {
      console.error('[AttachmentsTab] retry failed:', err);
    });
  }, []);

  const handleDeleteOrphan = useCallback((row: AttachmentRow, e: React.MouseEvent) => {
    e.stopPropagation();
    // Orphan ref (linked_notes empty) → safe to hard-delete; nothing to unlink.
    // Bypasses the Option C confirmation modal since the user explicitly
    // clicked ✕ on a known-broken entry.
    void syncV2Commands.attachmentDelete(row.ref.attachmentId).catch((err) => {
      console.error('[AttachmentsTab] orphan delete failed:', err);
    });
  }, []);

  // Auto-reconcile runs at vault open in `sync_engine::start`; there is no
  // manual "Verify links" surface. What survives surfaces as orphan rows
  // below + the editor's ✕ chip visual.

  return (
    <table className="search-table">
      <thead>
        <tr>
          <th className="search-th">{t('fileName', language)}</th>
          <th className="search-th">{t('attachmentLinkedNotes', language)}</th>
          <th className="search-th">{t('attachmentSyncState', language)}</th>
          <th className="search-th">{t('attachmentSize', language)}</th>
          <th className="search-th">{t('attachmentCreated', language)}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <AttachmentRow
            key={row.ref.attachmentId}
            row={row}
            language={language}
            onClick={handleRowClick}
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
  );
}

interface RowProps {
  row: AttachmentRow;
  language: ReturnType<typeof useSettingsStore.getState>['language'];
  onClick: (row: AttachmentRow) => void;
  onRetry: (row: AttachmentRow, e: React.MouseEvent) => void;
  onDeleteOrphan: (row: AttachmentRow, e: React.MouseEvent) => void;
}

function AttachmentRow({ row, language, onClick, onRetry, onDeleteOrphan }: RowProps) {
  const { ref, syncState } = row;
  const category = getAttachmentCategory(ref.originalName);

  return (
    <tr
      className={`search-row att-row-${category}`}
      onClick={() => onClick(row)}
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
