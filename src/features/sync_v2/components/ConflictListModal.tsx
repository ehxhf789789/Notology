// Modal listing all notes with unresolved conflicts.

import { useEffect } from 'react';
import { useSyncV2Store } from '../stores/syncV2Store';
import { useLanguage } from '../../../core/stores/settingsStore';

export function ConflictListModal() {
  const language = useLanguage();
  const show = useSyncV2Store(s => s.showConflictList);
  const conflicts = useSyncV2Store(s => s.conflicts);
  const close = useSyncV2Store(s => s.closeConflictList);
  const openBranchPicker = useSyncV2Store(s => s.openBranchPicker);
  const refreshConflicts = useSyncV2Store(s => s.refreshConflicts);

  const ko = language === 'ko';

  // Refresh on open
  useEffect(() => {
    if (show) refreshConflicts();
  }, [show, refreshConflicts]);

  // Escape to close
  useEffect(() => {
    if (!show) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [show, close]);

  if (!show) return null;

  return (
    <div className="modal-overlay" onClick={close}>
      <div className="sync-v2-conflict-modal" onClick={e => e.stopPropagation()}>
        <div className="sync-v2-conflict-modal-header">
          <h3>{ko ? '충돌 목록' : 'Conflicts'}</h3>
          <button className="sync-v2-close-btn" onClick={close}>×</button>
        </div>

        {conflicts.length === 0 ? (
          <div className="sync-v2-conflict-empty">
            {ko ? '충돌이 없습니다' : 'No conflicts'}
          </div>
        ) : (
          <div className="sync-v2-conflict-list">
            {conflicts.map(c => (
              <button
                key={c.note_id}
                className="sync-v2-conflict-item"
                onClick={() => openBranchPicker(c.note_id)}
              >
                <span className="sync-v2-conflict-note-id">{c.note_id}</span>
                <span className="sync-v2-conflict-branch-count">
                  {c.branches.length} {ko ? '개 브랜치' : 'branches'}
                </span>
                <span className="sync-v2-conflict-time">
                  {new Date(c.earliest_detected).toLocaleDateString()}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
