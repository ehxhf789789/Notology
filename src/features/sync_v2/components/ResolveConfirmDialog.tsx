// Confirmation dialog before resolving a conflict.

import { useLanguage } from '../../../core/stores/settingsStore';
import { useEscapeKey } from '../../shared/useEscapeKey';
import type { Branch } from '../../../core/types/sync';

interface Props {
  noteId: string;
  branch: Branch;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ResolveConfirmDialog({ noteId, branch, onConfirm, onCancel }: Props) {
  const language = useLanguage();
  const ko = language === 'ko';
  useEscapeKey(onCancel);

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="sync-v2-confirm-dialog" onClick={e => e.stopPropagation()}>
        <div className="sync-v2-confirm-title">
          {ko ? '충돌 해결 확인' : 'Confirm Resolution'}
        </div>
        <div className="sync-v2-confirm-body">
          <p>
            {ko
              ? `노트 "${noteId}"의 충돌을 디바이스 "${branch.source_device}"의 버전으로 해결합니다.`
              : `Resolve conflict for "${noteId}" using version from "${branch.source_device}".`
            }
          </p>
          <p className="sync-v2-confirm-warning">
            {ko
              ? '다른 브랜치의 내용은 CAS에 보존되지만 활성 버전에서 제거됩니다.'
              : 'Other branches will be removed from active versions but preserved in CAS.'
            }
          </p>
        </div>
        <div className="sync-v2-confirm-actions">
          <button className="sync-v2-cancel-btn" onClick={onCancel}>
            {ko ? '취소' : 'Cancel'}
          </button>
          <button className="sync-v2-confirm-btn" onClick={onConfirm}>
            {ko ? '해결' : 'Resolve'}
          </button>
        </div>
      </div>
    </div>
  );
}
