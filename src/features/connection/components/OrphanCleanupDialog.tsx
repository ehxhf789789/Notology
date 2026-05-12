/**
 * Cleanup dialog for stale local vault caches.
 *
 * The local vault dir is just a sync cache of the NAS vault. After a
 * rename / delete that didn't fully tear down (or after switching to a
 * different NAS account), local cache dirs accumulate that don't
 * correspond to any current NAS vault. This dialog lists them, lets the
 * user pick which to remove, and confirms before deletion.
 *
 * Safety: the active vault is excluded server-side. Quarantined dirs
 * (`<name>.orphan-<ts>` from prior failed renames) are pre-checked since
 * the user already implicitly accepted them as disposable. Everything
 * else starts unchecked so the user must opt in deliberately.
 */
import { useState, useCallback, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { syncV2Commands } from '../../sync_v2/syncV2Commands';
import { showToast } from '../../shared/Toast';

export interface Orphan {
  localPath: string;
  name: string;
  fileCount: number;
  sizeBytes: number;
  alreadyQuarantined: boolean;
}

interface Props {
  ko: boolean;
  orphans: Orphan[];
  onClose: () => void;
  /** Called with the count of removed dirs after a successful delete. */
  onCleaned: (removedCount: number) => void;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function OrphanCleanupDialog({ ko, orphans, onClose, onCleaned }: Props) {
  const [checked, setChecked] = useState<Set<string>>(() => {
    // Pre-check anything already quarantined (.orphan-<ts>) — user
    // already accepted those as disposable when they were quarantined.
    return new Set(orphans.filter(o => o.alreadyQuarantined).map(o => o.localPath));
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const allChecked = orphans.length > 0 && orphans.every(o => checked.has(o.localPath));
  const toggleAll = useCallback(() => {
    setChecked(prev => {
      if (allChecked) return new Set();
      return new Set(orphans.map(o => o.localPath));
    });
  }, [allChecked, orphans]);

  const toggleOne = useCallback((path: string) => {
    setChecked(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const handleSubmit = useCallback(async () => {
    if (checked.size === 0) return;
    setBusy(true);
    setErr('');
    try {
      const targets = Array.from(checked);
      const outcomes = await syncV2Commands.deleteOrphanLocalDirs(targets);
      const removed = outcomes.filter(o => o.removed).length;
      const failed = outcomes.filter(o => !o.removed);
      if (failed.length > 0) {
        // Partial failure — surface enough info for the user to act.
        const sample = failed[0];
        setErr(
          ko
            ? `${failed.length}개 폴더 삭제 실패. 예: "${sample.localPath}" — ${sample.error ?? '알 수 없음'}`
            : `${failed.length} dir(s) failed. e.g. "${sample.localPath}" — ${sample.error ?? 'unknown'}`
        );
        setBusy(false);
        // Still notify caller so it can refresh the list (some succeeded)
        if (removed > 0) onCleaned(removed);
        return;
      }
      showToast({
        type: 'success',
        title: ko ? '정리 완료' : 'Cleanup complete',
        description: ko
          ? `${removed}개 폴더 삭제됨`
          : `${removed} folder(s) removed`,
      });
      onCleaned(removed);
      onClose();
    } catch (e: any) {
      setErr(e?.toString() || (ko ? '정리 실패' : 'Cleanup failed'));
      setBusy(false);
    }
  }, [checked, ko, onClose, onCleaned]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <div className="nas-browser-overlay" onClick={onClose}>
      <div
        className="nas-browser-modal"
        onClick={e => e.stopPropagation()}
        style={{ width: 'min(560px, 92vw)', maxHeight: '80vh', display: 'flex', flexDirection: 'column' }}
      >
        <div className="nas-browser-header">
          <div className="nas-browser-title">
            {ko ? '오래된 로컬 캐시 정리' : 'Clean Stale Local Caches'}
          </div>
          <button className="nas-browser-close" onClick={onClose}>✕</button>
        </div>

        <div style={{ padding: '14px 18px 8px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          <p style={{ fontSize: 12, color: 'var(--tx-2)', margin: 0, lineHeight: 1.5 }}>
            {ko
              ? '아래 폴더는 NAS에 대응 보관소가 없는 로컬 캐시입니다. 삭제해도 NAS 데이터에는 영향이 없지만, 동기화되지 않은 편집이 있다면 손실될 수 있으니 삭제할 항목만 체크하세요.'
              : "These local cache dirs have no matching NAS vault. Deletion doesn't touch NAS data, but unsynced local edits will be lost. Check only what you want to remove."}
          </p>
          {orphans.length > 1 && (
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--tx-1)', cursor: 'pointer' }}>
              <input type="checkbox" checked={allChecked} onChange={toggleAll} disabled={busy} />
              {ko ? '전체 선택' : 'Select all'}
            </label>
          )}
        </div>

        <div style={{
          padding: '0 18px',
          flex: 1,
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
          minHeight: 80,
        }}>
          {orphans.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--tx-2)', padding: 20, textAlign: 'center' }}>
              {ko ? '정리할 폴더가 없습니다.' : 'Nothing to clean.'}
            </div>
          ) : (
            orphans.map(o => (
              <label
                key={o.localPath}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '8px 10px',
                  borderRadius: 6,
                  background: 'var(--bg-base)',
                  cursor: busy ? 'default' : 'pointer',
                  opacity: busy ? 0.6 : 1,
                }}
              >
                <input
                  type="checkbox"
                  checked={checked.has(o.localPath)}
                  onChange={() => toggleOne(o.localPath)}
                  disabled={busy}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--tx-1)' }}>
                    <span style={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {o.name}
                    </span>
                    {o.alreadyQuarantined && (
                      <span style={{
                        fontSize: 10,
                        padding: '1px 6px',
                        borderRadius: 4,
                        background: 'var(--bg-hover)',
                        color: 'var(--tx-2)',
                        whiteSpace: 'nowrap',
                      }}>
                        {ko ? '격리됨' : 'quarantined'}
                      </span>
                    )}
                  </div>
                  <div style={{
                    fontSize: 11,
                    color: 'var(--tx-2)',
                    marginTop: 2,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }} title={o.localPath}>
                    {o.fileCount} {ko ? '파일' : 'files'} · {formatSize(o.sizeBytes)}
                  </div>
                </div>
              </label>
            ))
          )}
        </div>

        {err && (
          <div style={{ padding: '0 18px', marginTop: 8 }}>
            <div className="nas-error">{err}</div>
          </div>
        )}

        <div className="nas-browser-footer">
          <div style={{ flex: 1, fontSize: 11, color: 'var(--tx-2)' }}>
            {orphans.length > 0 && (
              ko
                ? `${checked.size} / ${orphans.length} 선택됨`
                : `${checked.size} of ${orphans.length} selected`
            )}
          </div>
          <button className="nas-btn" onClick={onClose} disabled={busy}>
            {ko ? '취소' : 'Cancel'}
          </button>
          <button
            className="nas-btn settings-btn-danger"
            onClick={handleSubmit}
            disabled={checked.size === 0 || busy}
          >
            {busy
              ? (ko ? '삭제 중...' : 'Deleting...')
              : (ko ? `${checked.size}개 삭제` : `Delete ${checked.size}`)}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
