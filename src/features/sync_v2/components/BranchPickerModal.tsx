// Branch picker: select which branch wins for a conflicted note.

import { useState, useEffect } from 'react';
import { X } from 'lucide-react';
import { useSyncV2Store } from '../stores/syncV2Store';
import { syncV2Commands } from '../syncV2Commands';
import { showToast } from '../../shared/Toast';
import { useLanguage } from '../../../core/stores/settingsStore';
import { BranchPreview } from './BranchPreview';
import { ResolveConfirmDialog } from './ResolveConfirmDialog';
import type { Branch } from '../../../core/types/sync';

export function BranchPickerModal() {
  const language = useLanguage();
  const noteId = useSyncV2Store(s => s.resolvingNoteId);
  const conflicts = useSyncV2Store(s => s.conflicts);
  const closeBranchPicker = useSyncV2Store(s => s.closeBranchPicker);
  const refreshConflicts = useSyncV2Store(s => s.refreshConflicts);

  const [selectedBranch, setSelectedBranch] = useState<Branch | null>(null);
  const [showConfirm, setShowConfirm] = useState(false);
  // Smart Merge state. `attempted` flips on after a try so the button
  // can disable itself + show the fallback banner if the result was a
  // conflict. `pending` is the in-flight spinner state.
  const [smartMergeAttempted, setSmartMergeAttempted] = useState(false);
  const [smartMergePending, setSmartMergePending] = useState(false);
  const [smartMergeMessage, setSmartMergeMessage] = useState<string | null>(null);

  const ko = language === 'ko';
  const note = conflicts.find(c => c.note_id === noteId);

  // Reset selection + smart-merge state when note changes
  useEffect(() => {
    setSelectedBranch(null);
    setShowConfirm(false);
    setSmartMergeAttempted(false);
    setSmartMergePending(false);
    setSmartMergeMessage(null);
  }, [noteId]);

  // Escape to close
  useEffect(() => {
    if (!noteId) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') closeBranchPicker(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [noteId, closeBranchPicker]);

  if (!noteId || !note) return null;

  const handleResolve = async () => {
    if (!selectedBranch) return;
    try {
      await syncV2Commands.resolveConflict(noteId, selectedBranch.branch_id);
      showToast({ type: 'success', title: ko ? '충돌 해결됨' : 'Conflict resolved' });
      await refreshConflicts();
      closeBranchPicker();
    } catch (e) {
      showToast({ type: 'error', title: ko ? '해결 실패' : 'Resolve failed', description: String(e) });
    }
    setShowConfirm(false);
  };

  const handleSmartMerge = async () => {
    if (!selectedBranch || smartMergePending) return;
    setSmartMergePending(true);
    setSmartMergeMessage(null);
    try {
      const result = await syncV2Commands.smartMergeBranch(noteId, selectedBranch.branch_id);
      if (result.kind === 'success') {
        showToast({
          type: 'success',
          title: ko ? '자동 병합 완료' : 'Smart Merge applied',
        });
        await refreshConflicts();
        closeBranchPicker();
        return;
      }
      // Mark attempted so the user can't keep retrying the same impossible
      // merge; the manual 2-way buttons stay enabled as fallback.
      setSmartMergeAttempted(true);
      if (result.kind === 'conflict') {
        setSmartMergeMessage(
          ko
            ? `자동 병합 실패 — ${result.conflictCount}개 충돌 영역이 있어 직접 선택이 필요합니다.`
            : `Smart Merge failed — ${result.conflictCount} conflict region(s). Pick a branch manually.`
        );
      } else {
        setSmartMergeMessage(
          ko
            ? '공통 조상이 없어 자동 병합할 수 없습니다. 직접 선택해 주세요.'
            : 'No common ancestor — manual selection required.'
        );
      }
    } catch (e) {
      setSmartMergeAttempted(true);
      setSmartMergeMessage(
        ko
          ? `자동 병합 오류: ${String(e)}`
          : `Smart Merge error: ${String(e)}`
      );
    } finally {
      setSmartMergePending(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={closeBranchPicker}>
      <div className="modal-shell sync-v2-branch-picker" onClick={e => e.stopPropagation()}>
        <div className="sync-v2-branch-picker-header">
          <h3>{ko ? '브랜치 선택' : 'Pick a Branch'} — {noteId}</h3>
          <button
            className="sync-v2-close-btn"
            onClick={closeBranchPicker}
            aria-label={ko ? '닫기' : 'Close'}
            title={ko ? '닫기' : 'Close'}
          >
            <X size={16} strokeWidth={2} />
          </button>
        </div>

        <div className="sync-v2-branch-picker-body">
          {/* Branch list */}
          <div className="sync-v2-branch-list">
            {note.branches.map(b => (
              <button
                key={b.branch_id}
                className={`sync-v2-branch-item ${selectedBranch?.branch_id === b.branch_id ? 'selected' : ''}`}
                onClick={() => setSelectedBranch(b)}
              >
                <span className="sync-v2-branch-device">{b.source_device}</span>
                <span className="sync-v2-branch-hash">{b.head_hash.slice(0, 8)}</span>
                <span className="sync-v2-branch-time">
                  {new Date(b.created_at).toLocaleString()}
                </span>
              </button>
            ))}
          </div>

          {/* Preview */}
          <div className="sync-v2-branch-preview-area">
            {selectedBranch ? (
              <BranchPreview noteId={noteId} branchId={selectedBranch.branch_id} />
            ) : (
              <div className="sync-v2-preview-placeholder">
                {ko ? '브랜치를 선택하세요' : 'Select a branch to preview'}
              </div>
            )}
          </div>
        </div>

        {smartMergeMessage && (
          <div role="status" className="sync-v2-branch-picker-message">
            {smartMergeMessage}
          </div>
        )}

        <div className="sync-v2-branch-picker-footer">
          <button
            className="sync-v2-resolve-btn sync-v2-resolve-btn--smart"
            disabled={!selectedBranch || smartMergePending || smartMergeAttempted}
            onClick={handleSmartMerge}
            title={
              !selectedBranch
                ? (ko ? '먼저 브랜치를 선택하세요' : 'Select a branch first')
                : smartMergeAttempted
                  ? (ko ? '이미 시도했습니다 — 직접 선택해 주세요' : 'Already attempted — pick manually')
                  : undefined
            }
          >
            {smartMergePending
              ? (ko ? '✨ 분석 중...' : '✨ Merging...')
              : (ko ? '✨ Smart Merge 시도' : '✨ Try Smart Merge')}
          </button>
          <div className="sync-v2-branch-picker-footer__spacer" />
          <button
            className="sync-v2-resolve-btn"
            disabled={!selectedBranch || smartMergePending}
            onClick={() => setShowConfirm(true)}
          >
            {ko ? '이 브랜치로 해결' : 'Resolve with this branch'}
          </button>
        </div>

        {showConfirm && selectedBranch && (
          <ResolveConfirmDialog
            noteId={noteId}
            branch={selectedBranch}
            onConfirm={handleResolve}
            onCancel={() => setShowConfirm(false)}
          />
        )}
      </div>
    </div>
  );
}
