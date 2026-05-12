/**
 * Track H — bulk NAS-deletion confirmation banner.
 *
 * Shown when a sync cycle detects ≥ NAS_DELETION_BULK_THRESHOLD refs
 * that were deleted from NAS by another device. The user is asked to
 * confirm Trash (apply deletion locally) or Reject (re-push local
 * copies back to NAS).
 *
 * For deletion counts below the threshold the engine silently trashes
 * the notes and surfaces a toast; this banner is the "are you sure?"
 * surface for the higher-impact case only.
 */
import { useEffect, useState } from 'react';
import { useSyncV2Store } from '../stores/syncV2Store';
import { syncV2Commands } from '../syncV2Commands';
import { showToast } from '../../shared/Toast';
import { useLanguage } from '../../../core/stores/settingsStore';

interface PendingItem {
  noteId: string;
  relativePath: string;
  headHash: string;
  detectedAt: string;
}

export function NasDeletionsBanner() {
  const language = useLanguage();
  const ko = language === 'ko';
  const pendingCount = useSyncV2Store(s => s.pendingNasDeletionCount);
  const [expanded, setExpanded] = useState(false);
  const [items, setItems] = useState<PendingItem[]>([]);
  const [busy, setBusy] = useState(false);

  // Fetch the full list when the banner is expanded.
  useEffect(() => {
    if (!expanded || items.length > 0) return;
    syncV2Commands
      .listPendingNasDeletions()
      .then(list => setItems(list))
      .catch(e => console.warn('[NasDeletionsBanner] list failed:', e));
  }, [expanded, items.length]);

  if (pendingCount === 0) return null;

  const apply = async (action: 'trash' | 'reject') => {
    if (busy) return;
    setBusy(true);
    try {
      const fn = action === 'trash'
        ? syncV2Commands.confirmNasDeletionsTrash
        : syncV2Commands.confirmNasDeletionsReject;
      const count = await fn();
      showToast({
        type: 'success',
        title: action === 'trash'
          ? (ko ? `${count}개 노트를 휴지통으로 이동` : `${count} notes moved to Trash`)
          : (ko ? `${count}개 노트를 NAS로 복원 예약` : `${count} notes queued for re-push`),
      });
      // Reset banner state — pending count will refresh on next sync.
      useSyncV2Store.setState({ pendingNasDeletionCount: 0 });
      setItems([]);
      setExpanded(false);
    } catch (e: any) {
      showToast({
        type: 'error',
        title: ko ? '처리 실패' : 'Operation failed',
        description: String(e),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="alert"
      style={{
        margin: '10px 14px',
        padding: '12px 14px',
        background: 'var(--bg-base)',
        border: '1px solid var(--sep-o)',
        borderLeft: '3px solid var(--tx-danger)',
        borderRadius: 6,
        fontSize: 13,
        color: 'var(--tx-1)',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ flex: 1, lineHeight: 1.5 }}>
          {ko ? (
            <>
              다른 기기에서 <strong>{pendingCount}개</strong> 노트가
              NAS에서 삭제되었습니다. 이 기기에서도 휴지통으로 이동할까요?
            </>
          ) : (
            <>
              <strong>{pendingCount}</strong> notes were deleted from NAS
              on another device. Move them to Trash here too?
            </>
          )}
        </span>
        <button
          type="button"
          onClick={() => setExpanded(prev => !prev)}
          style={{
            padding: '4px 8px',
            fontSize: 11,
            background: 'transparent',
            border: '1px solid var(--sep-o)',
            borderRadius: 4,
            cursor: 'pointer',
            color: 'var(--tx-2)',
          }}
        >
          {expanded ? (ko ? '목록 닫기' : 'Hide list') : (ko ? '목록 보기' : 'Show list')}
        </button>
      </div>

      {expanded && items.length > 0 && (
        <ul
          style={{
            margin: 0,
            padding: '6px 0 6px 18px',
            maxHeight: 160,
            overflowY: 'auto',
            fontSize: 12,
            color: 'var(--tx-2)',
            lineHeight: 1.6,
            background: 'var(--bg-hover)',
            borderRadius: 4,
          }}
        >
          {items.map(it => (
            <li key={it.noteId} style={{ wordBreak: 'break-all' }}>
              {it.relativePath}
            </li>
          ))}
        </ul>
      )}

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button
          type="button"
          onClick={() => apply('reject')}
          disabled={busy}
          style={{
            padding: '6px 14px',
            fontSize: 12,
            background: 'transparent',
            border: '1px solid var(--sep-o)',
            borderRadius: 4,
            cursor: 'pointer',
            color: 'var(--tx-1)',
          }}
          title={ko ? '로컬 노트를 유지하고 NAS로 다시 푸시' : 'Keep locally and re-push to NAS'}
        >
          {ko ? '복원 (NAS로 다시 푸시)' : 'Restore (re-push to NAS)'}
        </button>
        <button
          type="button"
          onClick={() => apply('trash')}
          disabled={busy}
          style={{
            padding: '6px 14px',
            fontSize: 12,
            background: 'var(--tx-danger)',
            color: '#fff',
            border: 'none',
            borderRadius: 4,
            cursor: 'pointer',
          }}
        >
          {busy ? (ko ? '처리 중...' : 'Working...') : (ko ? '휴지통으로' : 'Move to Trash')}
        </button>
      </div>
    </div>
  );
}
