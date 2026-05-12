/**
 * Trash panel — browse, restore, and purge soft-deleted notes.
 *
 * Items land here when:
 *   - Another device deletes a note from NAS (Track H silent trash)
 *   - Future: user-initiated local deletion (not yet wired)
 *
 * Retention is 30 days; the "만료된 항목 비우기" button uses the
 * backend `sync_v2_purge_expired_trash` command to clear anything past
 * the cutoff. Per-entry purge is also available.
 */
import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Trash2, RotateCcw, XCircle, X } from 'lucide-react';
import { useSyncV2Store } from '../stores/syncV2Store';
import { syncV2Commands } from '../syncV2Commands';
import { showToast } from '../../shared/Toast';
import { useLanguage } from '../../../core/stores/settingsStore';

interface TrashEntry {
  note_id: string;
  original_path: string;
  deleted_at: string;
  trash_filename: string;
}

const RETENTION_DAYS = 30;

/** Trash entries can carry Windows backslash paths depending on which
 *  code path saved them (some pre-normalize to `/`, some don't). Always
 *  render forward slashes so the list looks consistent. */
function displayPath(p: string): string {
  return p.replace(/\\/g, '/');
}

function daysLeft(deletedAt: string): number {
  const deleted = new Date(deletedAt).getTime();
  const cutoff = deleted + RETENTION_DAYS * 24 * 60 * 60 * 1000;
  return Math.max(0, Math.ceil((cutoff - Date.now()) / (24 * 60 * 60 * 1000)));
}

/**
 * Is this trash entry a *user-visible* item — a note, attachment, or
 * other file the user explicitly created/owns?
 *
 * Anything under `.notology/` is vault metadata (config, refs, history,
 * snippets, the trash dir itself). The user can't meaningfully judge
 * whether to restore those — they're managed by the engine. Hide them
 * from the main view; a "시스템 파일 표시" toggle still lets advanced
 * users see and act on them if needed.
 */
function isUserVisible(originalPath: string): boolean {
  const normalized = originalPath.replace(/\\/g, '/');
  if (normalized.startsWith('.notology/')) return false;
  if (normalized.includes('/.notology/')) return false;
  return true;
}

export function TrashPanel() {
  const language = useLanguage();
  const ko = language === 'ko';
  const open = useSyncV2Store(s => s.showTrashPanel);
  const [entries, setEntries] = useState<TrashEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null); // note_id being acted on
  const [showSystem, setShowSystem] = useState(false);

  const close = useCallback(() => {
    useSyncV2Store.setState({ showTrashPanel: false });
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const list = await syncV2Commands.listTrash();
      setEntries(list);
    } catch (e) {
      console.warn('[TrashPanel] list failed:', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) refresh();
  }, [open, refresh]);

  // Esc to close
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open, close]);

  if (!open) return null;

  // Partition: user-visible (notes / attachments) vs system (.notology/*)
  const userEntries = entries.filter(e => isUserVisible(e.original_path));
  const systemEntries = entries.filter(e => !isUserVisible(e.original_path));
  const visibleEntries = showSystem ? entries : userEntries;

  const handleRestore = async (entry: TrashEntry) => {
    if (busy) return;
    setBusy(entry.note_id);
    try {
      await syncV2Commands.restoreFromTrash(entry.note_id);
      showToast({
        type: 'success',
        title: ko ? '복원 완료' : 'Restored',
        description: displayPath(entry.original_path),
      });
      await refresh();
    } catch (e: any) {
      showToast({ type: 'error', title: ko ? '복원 실패' : 'Restore failed', description: String(e) });
    } finally {
      setBusy(null);
    }
  };

  const handlePurge = async (entry: TrashEntry) => {
    if (busy) return;
    const path = displayPath(entry.original_path);
    const confirmMsg = ko
      ? `"${path}" 을(를) 영구 삭제합니다. 되돌릴 수 없습니다. 계속할까요?`
      : `Permanently delete "${path}"? This cannot be undone.`;
    if (!window.confirm(confirmMsg)) return;
    setBusy(entry.note_id);
    try {
      await syncV2Commands.purgeTrashEntry(entry.note_id);
      showToast({ type: 'success', title: ko ? '영구 삭제됨' : 'Permanently deleted' });
      await refresh();
    } catch (e: any) {
      showToast({ type: 'error', title: ko ? '삭제 실패' : 'Purge failed', description: String(e) });
    } finally {
      setBusy(null);
    }
  };

  const handlePurgeExpired = async () => {
    if (busy) return;
    setBusy('__expired__');
    try {
      const n = await syncV2Commands.purgeExpiredTrash();
      showToast({
        type: 'success',
        title: ko ? `만료된 ${n}개 항목 비움` : `Purged ${n} expired items`,
      });
      await refresh();
    } catch (e: any) {
      showToast({ type: 'error', title: ko ? '실패' : 'Failed', description: String(e) });
    } finally {
      setBusy(null);
    }
  };

  return createPortal(
    <div className="nas-browser-overlay" onClick={close}>
      <div
        className="nas-browser-modal"
        onClick={e => e.stopPropagation()}
        style={{
          width: 'min(680px, 92vw)',
          maxHeight: '82vh',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div className="nas-browser-header">
          <div className="nas-browser-title">
            <Trash2 size={15} style={{ verticalAlign: -2, marginRight: 6 }} />
            {ko ? '휴지통' : 'Trash'}
            <span style={{ marginLeft: 8, fontSize: 12, color: 'var(--tx-2)' }}>
              {ko
                ? `${userEntries.length}개 항목 · ${RETENTION_DAYS}일 보관`
                : `${userEntries.length} items · ${RETENTION_DAYS}-day retention`}
            </span>
          </div>
          <button className="nas-browser-close" onClick={close} aria-label="Close"><X size={16} /></button>
        </div>

        <div
          style={{
            padding: '8px 14px 4px',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}
        >
          {/* System-file toggle. Only renders when system entries exist
              so casual users never see it. Advanced/debug use case. */}
          {systemEntries.length > 0 && (
            <label
              style={{
                fontSize: 11,
                color: 'var(--tx-2)',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                cursor: 'pointer',
              }}
              title={ko
                ? '.notology/ 폴더의 시스템 파일은 일반적으로 동기화 엔진이 자동 관리합니다. 표시 후 직접 복원/삭제할 수 있습니다.'
                : '.notology/ system files are normally managed by the sync engine. Enable to see and act on them.'}
            >
              <input
                type="checkbox"
                checked={showSystem}
                onChange={e => setShowSystem(e.target.checked)}
              />
              {ko
                ? `시스템 파일 표시 (${systemEntries.length})`
                : `Show system files (${systemEntries.length})`}
            </label>
          )}
          <div style={{ flex: 1 }} />
          <button
            type="button"
            onClick={handlePurgeExpired}
            disabled={busy !== null}
            style={{
              padding: '5px 10px',
              fontSize: 12,
              background: 'transparent',
              border: '1px solid var(--sep-o)',
              borderRadius: 4,
              cursor: 'pointer',
              color: 'var(--tx-1)',
            }}
            title={ko ? `${RETENTION_DAYS}일 지난 항목 일괄 삭제` : `Purge items older than ${RETENTION_DAYS} days`}
          >
            {busy === '__expired__'
              ? (ko ? '처리 중...' : 'Working...')
              : (ko ? '만료된 항목 비우기' : 'Purge expired')}
          </button>
        </div>

        <div
          style={{
            padding: '4px 14px 14px',
            flex: 1,
            overflowY: 'auto',
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            minHeight: 80,
          }}
        >
          {loading ? (
            <div style={{ padding: 30, textAlign: 'center', color: 'var(--tx-2)', fontSize: 13 }}>
              {ko ? '불러오는 중...' : 'Loading...'}
            </div>
          ) : visibleEntries.length === 0 ? (
            <div style={{ padding: 30, textAlign: 'center', color: 'var(--tx-2)', fontSize: 13 }}>
              {entries.length > 0 && !showSystem
                ? (ko
                    ? '표시할 항목이 없습니다. (시스템 파일은 숨김 처리 — 좌상단 체크박스로 표시)'
                    : 'No user items. System files are hidden — toggle the checkbox above to see them.')
                : (ko ? '휴지통이 비어있습니다.' : 'Trash is empty.')}
            </div>
          ) : (
            visibleEntries.map(e => {
              const left = daysLeft(e.deleted_at);
              const expiring = left <= 7;
              const isSystem = !isUserVisible(e.original_path);
              return (
                <div
                  key={e.note_id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    padding: '10px 12px',
                    background: 'var(--bg-base)',
                    border: '1px solid var(--sep-o)',
                    borderRadius: 6,
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: 13,
                        color: 'var(--tx-1)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                      }}
                      title={displayPath(e.original_path)}
                    >
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {displayPath(e.original_path)}
                      </span>
                      {isSystem && (
                        <span
                          style={{
                            fontSize: 10,
                            padding: '1px 6px',
                            borderRadius: 4,
                            background: 'var(--bg-hover)',
                            color: 'var(--tx-2)',
                            whiteSpace: 'nowrap',
                            flexShrink: 0,
                          }}
                          title={ko
                            ? '시스템 파일 — 동기화 엔진이 자동 관리'
                            : 'System file — managed by sync engine'}
                        >
                          {ko ? '시스템' : 'system'}
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--tx-2)', marginTop: 2 }}>
                      {ko ? '삭제일' : 'Deleted'}: {new Date(e.deleted_at).toLocaleString()}
                      {' · '}
                      <span style={{ color: expiring ? 'var(--tx-danger)' : 'var(--tx-2)' }}>
                        {ko ? `${left}일 후 자동 삭제` : `auto-purge in ${left}d`}
                      </span>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleRestore(e)}
                    disabled={busy !== null}
                    title={ko ? '원위치로 복원' : 'Restore to original path'}
                    style={{
                      padding: '6px 10px',
                      fontSize: 12,
                      background: 'transparent',
                      border: '1px solid var(--sep-o)',
                      borderRadius: 4,
                      cursor: 'pointer',
                      color: 'var(--tx-1)',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 4,
                    }}
                  >
                    <RotateCcw size={12} /> {busy === e.note_id ? '...' : (ko ? '복원' : 'Restore')}
                  </button>
                  <button
                    type="button"
                    onClick={() => handlePurge(e)}
                    disabled={busy !== null}
                    title={ko ? '영구 삭제 (되돌릴 수 없음)' : 'Permanently delete'}
                    style={{
                      padding: '6px 10px',
                      fontSize: 12,
                      background: 'transparent',
                      border: '1px solid var(--sep-o)',
                      borderRadius: 4,
                      cursor: 'pointer',
                      color: 'var(--tx-danger)',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 4,
                    }}
                  >
                    <XCircle size={12} /> {ko ? '영구 삭제' : 'Purge'}
                  </button>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
