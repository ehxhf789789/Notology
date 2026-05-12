/**
 * Rename + delete dialogs for vault lifecycle management.
 *
 * Separated from SyncV2SettingsPanel because vault lifecycle is *not* a
 * sync-config concern — it's a vault-level action that belongs next to
 * the vault selector (where the user already thinks about vaults as a
 * whole). The Settings panel stays focused on sync behavior knobs.
 *
 * Both dialogs operate on the **currently-open vault** via the existing
 * `sync_v2_rename_vault` / `sync_v2_delete_vault` Tauri commands. The
 * caller is expected to be the vault selector window, which can act on
 * the currently-open vault and react to the result by re-opening the
 * vault under its new path or refreshing the vault list.
 */
import { useState, useCallback, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { syncV2Commands } from '../../sync_v2/syncV2Commands';
import { showToast } from '../../shared/Toast';
import { useEscapeKey } from '../../shared/useEscapeKey';

interface RenameProps {
  ko: boolean;
  /** Display the current name in the dialog header. */
  currentName: string;
  /** NAS path of the target vault (e.g. "/Colony/MyVault"). */
  remotePath: string;
  /** Local cache path of the target vault. */
  localPath: string;
  onClose: () => void;
  /**
   * Called after the backend rename completes successfully. The caller
   * should re-open the vault under the new local path so the editor +
   * sync engine pick it up.
   */
  onRenamed: (result: { newLocalPath: string; newRemotePath: string; newName: string }) => void;
}

export function RenameVaultDialog({ ko, currentName, remotePath, localPath, onClose, onRenamed }: RenameProps) {
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEscapeKey(() => { if (!busy) onClose(); });

  const handleSubmit = useCallback(async () => {
    const trimmed = newName.trim();
    if (!trimmed || trimmed === currentName) return;
    setBusy(true);
    setErr('');
    try {
      const result = await syncV2Commands.renameVaultAtPath(remotePath, localPath, trimmed);
      showToast({
        type: 'success',
        title: ko ? '이름 변경 완료' : 'Vault renamed',
        description: result.newRemotePath,
      });
      onClose();
      onRenamed({ ...result, newName: trimmed });
    } catch (e: any) {
      setErr(e?.toString() || '이름 변경 실패');
      setBusy(false);
    }
  }, [newName, currentName, remotePath, localPath, ko, onClose, onRenamed]);

  return createPortal(
    <div className="nas-browser-overlay" onClick={onClose}>
      <div className="nas-browser-modal" onClick={e => e.stopPropagation()} style={{ width: 'min(440px, 90vw)' }}>
        <div className="nas-browser-header">
          <div className="nas-browser-title">{ko ? '보관소 이름 변경' : 'Rename Vault'}</div>
          <button className="nas-browser-close" onClick={onClose}>✕</button>
        </div>
        <div style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <p style={{ fontSize: 12, color: 'var(--tx-2)', margin: 0 }}>
            {ko
              ? `현재 이름: "${currentName}". NAS 폴더와 로컬 디렉토리, 동기화 설정이 함께 변경됩니다.`
              : `Current name: "${currentName}". NAS folder, local directory, and sync config rename together.`}
          </p>
          <input
            className="nas-input"
            type="text"
            placeholder={ko ? '새 보관소 이름' : 'New vault name'}
            value={newName}
            onChange={e => setNewName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && newName.trim() && !busy && handleSubmit()}
            autoFocus
            disabled={busy}
          />
          {err && <div className="nas-error">{err}</div>}
        </div>
        <div className="nas-browser-footer">
          <div style={{ flex: 1 }} />
          <button className="nas-btn" onClick={onClose} disabled={busy}>
            {ko ? '취소' : 'Cancel'}
          </button>
          <button
            className="nas-btn primary"
            onClick={handleSubmit}
            disabled={!newName.trim() || newName.trim() === currentName || busy}
          >
            {busy ? (ko ? '변경 중...' : 'Renaming...') : (ko ? '이름 변경' : 'Rename')}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

interface DeleteProps {
  ko: boolean;
  currentName: string;
  remotePath: string;
  localPath: string;
  onClose: () => void;
  /** Called after the backend delete completes successfully. */
  onDeleted: (result: { localRemoved: boolean; remoteRemoved: boolean; configRemoved: boolean }) => void;
}

export function DeleteVaultDialog({ ko, currentName, remotePath, localPath, onClose, onDeleted }: DeleteProps) {
  const [confirmName, setConfirmName] = useState('');
  const [deleteRemote, setDeleteRemote] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEscapeKey(() => { if (!busy) onClose(); });

  const canDelete = !!currentName && confirmName.trim() === currentName && !busy;

  const handleSubmit = useCallback(async () => {
    if (!canDelete) return;
    setBusy(true);
    setErr('');
    try {
      const result = await syncV2Commands.deleteVaultAtPath(remotePath, localPath, deleteRemote);
      const summary = ko
        ? `로컬 ${result.localRemoved ? '삭제' : '보존'}, NAS ${result.remoteRemoved ? '삭제' : '보존'}`
        : `local: ${result.localRemoved ? 'removed' : 'kept'}, NAS: ${result.remoteRemoved ? 'removed' : 'kept'}`;
      showToast({
        type: 'success',
        title: ko ? '보관소 삭제 완료' : 'Vault deleted',
        description: summary,
      });
      onClose();
      onDeleted(result);
    } catch (e: any) {
      setErr(e?.toString() || '삭제 실패');
      setBusy(false);
    }
  }, [canDelete, deleteRemote, remotePath, localPath, ko, onClose, onDeleted]);

  return createPortal(
    <div className="nas-browser-overlay" onClick={onClose}>
      <div className="nas-browser-modal" onClick={e => e.stopPropagation()} style={{ width: 'min(480px, 90vw)' }}>
        <div className="nas-browser-header">
          <div className="nas-browser-title" style={{ color: 'var(--tx-danger)' }}>
            {ko ? '⚠ 보관소 삭제' : '⚠ Delete Vault'}
          </div>
          <button className="nas-browser-close" onClick={onClose}>✕</button>
        </div>
        <div style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <p style={{ fontSize: 12, color: 'var(--tx-2)', margin: 0 }}>
            {ko
              ? `이 작업은 되돌릴 수 없습니다. 진행하려면 보관소 이름 "${currentName}"을(를) 그대로 입력하세요.`
              : `This cannot be undone. To proceed, type the vault name "${currentName}" exactly.`}
          </p>
          <input
            className="nas-input"
            type="text"
            placeholder={currentName}
            value={confirmName}
            onChange={e => setConfirmName(e.target.value)}
            disabled={busy}
            autoFocus
          />
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--tx-1)' }}>
            <input
              type="checkbox"
              checked={deleteRemote}
              onChange={e => setDeleteRemote(e.target.checked)}
              disabled={busy}
            />
            {ko
              ? 'NAS에서도 삭제 (모든 기기에서 사라집니다)'
              : 'Also delete on NAS (vanishes from every device)'}
          </label>
          {err && <div className="nas-error">{err}</div>}
        </div>
        <div className="nas-browser-footer">
          <div style={{ flex: 1 }} />
          <button className="nas-btn" onClick={onClose} disabled={busy}>
            {ko ? '취소' : 'Cancel'}
          </button>
          <button
            className="nas-btn settings-btn-danger"
            onClick={handleSubmit}
            disabled={!canDelete}
          >
            {busy ? (ko ? '삭제 중...' : 'Deleting...') : (ko ? '삭제' : 'Delete')}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
