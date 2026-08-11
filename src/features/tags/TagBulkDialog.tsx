import { useState, useEffect, useRef } from 'react';
import { listen, type UnlistenFn } from '../../web/event';
import { searchCommands } from '../../core/services/tauriCommands';
import { deleteTagFromOntology, renameTagInOntology } from './tagOntologyUtils';
import { refreshActions } from '../../core/stores/refreshStore';
import { useSettingsStore } from '../../core/stores/settingsStore';
import { t, tf } from '../../core/utils/i18n';

interface TagBulkProgress {
  total: number;
  completed: number;
  current_path: string;
}

interface TagDeleteDialogProps {
  tagId: string;
  tagLabel: string;
  namespace: string;
  noteCount: number;
  vaultPath: string;
  onClose: () => void;
}

export function TagDeleteConfirmDialog({
  tagId,
  tagLabel,
  namespace,
  noteCount,
  vaultPath,
  onClose,
}: TagDeleteDialogProps) {
  const language = useSettingsStore(s => s.language);
  const [progress, setProgress] = useState<TagBulkProgress | null>(null);
  const [result, setResult] = useState<{ affected: number; failed: number; cancelled: boolean } | null>(null);
  const [isRunning, setIsRunning] = useState(false);

  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    listen<TagBulkProgress>('tag-operation-progress', (event) => {
      setProgress(event.payload);
    }).then(fn => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, []);

  const handleConfirm = async () => {
    setIsRunning(true);
    try {
      const res = await searchCommands.bulkDeleteTag(tagId);
      // Remove from ontology after bulk file operation
      try {
        await deleteTagFromOntology(vaultPath, tagId);
      } catch (e) {
        console.warn('Ontology delete failed (tag may not exist in ontology):', e);
      }
      setResult({
        affected: res.affected_count,
        failed: res.failed_paths.length,
        cancelled: res.cancelled,
      });
      refreshActions.incrementOntologyRefresh();
      refreshActions.incrementSearchRefresh();
    } catch (e) {
      console.error('Bulk delete failed:', e);
      setResult({ affected: 0, failed: 0, cancelled: false });
    } finally {
      setIsRunning(false);
    }
  };

  const handleCancel = async () => {
    if (isRunning) {
      await searchCommands.cancelBulkOperation();
    } else {
      onClose();
    }
  };

  return (
    <div className="tag-bulk-dialog-overlay" onClick={(e) => { if (e.target === e.currentTarget && !isRunning) onClose(); }}>
      <div className="tag-bulk-dialog">
        <h3>{t('tagDelete', language)}</h3>
        <p className="tag-bulk-tag-name">{namespace}/{tagLabel}</p>

        {!result ? (
          <>
            {progress && isRunning ? (
              <div className="tag-bulk-progress">
                <div className="tag-bulk-progress-bar">
                  <div
                    className="tag-bulk-progress-fill"
                    style={{ width: `${progress.total > 0 ? (progress.completed / progress.total) * 100 : 0}%` }}
                  />
                </div>
                <span className="tag-bulk-progress-text">
                  {tf('tagBulkProgress', language, { completed: progress.completed, total: progress.total })}
                </span>
              </div>
            ) : (
              <p className="tag-bulk-info">
                {tf('tagDeleteConfirm', language, { count: noteCount })}
              </p>
            )}
            <div className="tag-bulk-actions">
              <button className="tag-bulk-btn-cancel" onClick={handleCancel}>
                {t('cancel', language)}
              </button>
              <button
                className="tag-bulk-btn-confirm tag-bulk-btn-danger"
                onClick={handleConfirm}
                disabled={isRunning}
              >
                {t('confirm', language)}
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="tag-bulk-result">
              {result.cancelled
                ? tf('tagBulkCancelled', language, { count: result.affected })
                : tf('tagBulkComplete', language, { count: result.affected })}
            </p>
            {result.failed > 0 && (
              <p className="tag-bulk-result-error">
                {tf('tagBulkFailed', language, { count: result.failed })}
              </p>
            )}
            <div className="tag-bulk-actions">
              <button className="tag-bulk-btn-confirm" onClick={onClose}>
                {t('close', language)}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

interface TagRenameDialogProps {
  tagId: string;
  tagLabel: string;
  namespace: string;
  noteCount: number;
  vaultPath: string;
  onClose: () => void;
}

export function TagRenameDialog({
  tagId,
  tagLabel,
  namespace,
  noteCount,
  vaultPath,
  onClose,
}: TagRenameDialogProps) {
  const language = useSettingsStore(s => s.language);
  const [newName, setNewName] = useState(tagLabel);
  const [progress, setProgress] = useState<TagBulkProgress | null>(null);
  const [result, setResult] = useState<{ affected: number; failed: number; cancelled: boolean } | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.select();
    let unlisten: UnlistenFn | null = null;
    listen<TagBulkProgress>('tag-operation-progress', (event) => {
      setProgress(event.payload);
    }).then(fn => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, []);

  const handleConfirm = async () => {
    const trimmed = newName.trim();
    if (!trimmed || trimmed === tagLabel) return;

    const newTagId = `${namespace}/${trimmed}`;
    setIsRunning(true);
    try {
      const res = await searchCommands.bulkRenameTag(tagId, newTagId);
      // Update ontology
      try {
        await renameTagInOntology(vaultPath, tagId, newTagId, trimmed);
      } catch (e) {
        console.warn('Ontology rename failed:', e);
      }
      setResult({
        affected: res.affected_count,
        failed: res.failed_paths.length,
        cancelled: res.cancelled,
      });
      refreshActions.incrementOntologyRefresh();
      refreshActions.incrementSearchRefresh();
    } catch (e) {
      console.error('Bulk rename failed:', e);
      setResult({ affected: 0, failed: 0, cancelled: false });
    } finally {
      setIsRunning(false);
    }
  };

  const handleCancel = async () => {
    if (isRunning) {
      await searchCommands.cancelBulkOperation();
    } else {
      onClose();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !isRunning) {
      e.preventDefault();
      handleConfirm();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      handleCancel();
    }
  };

  return (
    <div className="tag-bulk-dialog-overlay" onClick={(e) => { if (e.target === e.currentTarget && !isRunning) onClose(); }}>
      <div className="tag-bulk-dialog">
        <h3>{t('tagRenameTitle', language)}</h3>

        {!result ? (
          <>
            <div className="tag-bulk-form">
              <label>{t('tagRenameFrom', language)}</label>
              <div className="tag-bulk-current">{namespace}/{tagLabel}</div>
              <label>{t('tagRenameTo', language)}</label>
              <div className="tag-bulk-input-row">
                <span className="tag-bulk-ns-prefix">{namespace}/</span>
                <input
                  ref={inputRef}
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={handleKeyDown}
                  disabled={isRunning}
                  autoFocus
                />
              </div>
            </div>

            {progress && isRunning ? (
              <div className="tag-bulk-progress">
                <div className="tag-bulk-progress-bar">
                  <div
                    className="tag-bulk-progress-fill"
                    style={{ width: `${progress.total > 0 ? (progress.completed / progress.total) * 100 : 0}%` }}
                  />
                </div>
                <span className="tag-bulk-progress-text">
                  {tf('tagBulkProgress', language, { completed: progress.completed, total: progress.total })}
                </span>
              </div>
            ) : (
              <p className="tag-bulk-info">
                {tf('tagRenameConfirm', language, { count: noteCount })}
              </p>
            )}
            <div className="tag-bulk-actions">
              <button className="tag-bulk-btn-cancel" onClick={handleCancel}>
                {t('cancel', language)}
              </button>
              <button
                className="tag-bulk-btn-confirm"
                onClick={handleConfirm}
                disabled={isRunning || !newName.trim() || newName.trim() === tagLabel}
              >
                {t('confirm', language)}
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="tag-bulk-result">
              {result.cancelled
                ? tf('tagBulkCancelled', language, { count: result.affected })
                : tf('tagBulkComplete', language, { count: result.affected })}
            </p>
            {result.failed > 0 && (
              <p className="tag-bulk-result-error">
                {tf('tagBulkFailed', language, { count: result.failed })}
              </p>
            )}
            <div className="tag-bulk-actions">
              <button className="tag-bulk-btn-confirm" onClick={onClose}>
                {t('close', language)}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
