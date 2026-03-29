import { useState, useEffect, useCallback } from 'react';
import { useLanguage } from '../../core/stores/settingsStore';
import { syncCommands, type SyncStatus, type ConflictChoice } from './syncCommands';

interface ConflictResolverPanelProps {
  onClose?: () => void;
}

export function ConflictResolverPanel({ onClose }: ConflictResolverPanelProps) {
  const language = useLanguage();
  const ko = language === 'ko';

  const [status, setStatus] = useState<SyncStatus>({ type: 'Disconnected' });
  const [currentFile, setCurrentFile] = useState<string | null>(null);
  const [localContent, setLocalContent] = useState('');
  const [remoteContent, setRemoteContent] = useState('');
  const [resolving, setResolving] = useState(false);

  useEffect(() => {
    syncCommands.getStatus().then(s => {
      setStatus(s);
      if (s.type === 'Conflict' && s.files && s.files.length > 0) {
        setCurrentFile(s.files[0]);
      }
    });
  }, []);

  // Load file contents when conflict file is selected
  useEffect(() => {
    if (!currentFile) return;

    // Read local file
    (async () => {
      try {
        const { fileCommands } = await import('../../core/services/tauriCommands');
        const content = await fileCommands.readTextFile(currentFile);
        setLocalContent(content);
      } catch {
        setLocalContent(ko ? '(파일을 읽을 수 없습니다)' : '(Cannot read file)');
      }
    })();

    // Fetch remote content from NAS
    (async () => {
      try {
        const remote = await syncCommands.getRemoteFile(currentFile);
        setRemoteContent(remote);
      } catch {
        setRemoteContent(ko ? '(NAS 버전을 불러올 수 없습니다)' : '(Cannot load NAS version)');
      }
    })();
  }, [currentFile, ko]);

  const handleResolve = useCallback(async (choice: ConflictChoice) => {
    if (!currentFile) return;
    setResolving(true);
    try {
      await syncCommands.resolveConflict(currentFile, choice);
      // Move to next conflict or close
      const s = await syncCommands.getStatus();
      setStatus(s);
      if (s.type === 'Conflict' && s.files && s.files.length > 0) {
        setCurrentFile(s.files[0]);
      } else {
        setCurrentFile(null);
        onClose?.();
      }
    } catch (e: any) {
      console.error('Conflict resolution failed:', e);
    } finally {
      setResolving(false);
    }
  }, [currentFile, onClose]);

  if (status.type !== 'Conflict' || !status.files || status.files.length === 0) {
    return (
      <div className="conflict-panel">
        <p className="conflict-empty">
          {ko ? '해결할 충돌이 없습니다.' : 'No conflicts to resolve.'}
        </p>
      </div>
    );
  }

  const fileName = currentFile?.split('/').pop() || currentFile;

  return (
    <div className="conflict-panel">
      <div className="conflict-header">
        <h3>{ko ? '충돌 감지' : 'Conflict Detected'}: {fileName}</h3>
        <span className="conflict-count">
          {ko ? `${status.files.length}건 남음` : `${status.files.length} remaining`}
        </span>
      </div>

      {/* File selector if multiple conflicts */}
      {status.files.length > 1 && (
        <div className="conflict-file-list">
          {status.files.map(f => (
            <button
              key={f}
              className={`conflict-file-btn ${f === currentFile ? 'active' : ''}`}
              onClick={() => setCurrentFile(f)}
            >
              {f.split('/').pop()}
            </button>
          ))}
        </div>
      )}

      <div className="conflict-diff">
        <div className="conflict-side">
          <div className="conflict-side-header">
            {ko ? '내 버전 (로컬)' : 'My Version (Local)'}
          </div>
          <pre className="conflict-content">{localContent}</pre>
        </div>
        <div className="conflict-side">
          <div className="conflict-side-header">
            {ko ? 'NAS 버전 (원격)' : 'NAS Version (Remote)'}
          </div>
          <pre className="conflict-content">{remoteContent}</pre>
        </div>
      </div>

      <div className="conflict-actions">
        <button
          className="settings-action-btn"
          onClick={() => handleResolve('KeepLocal')}
          disabled={resolving}
        >
          {ko ? '내 버전 유지' : 'Keep Mine'}
        </button>
        <button
          className="settings-action-btn"
          onClick={() => handleResolve('KeepRemote')}
          disabled={resolving}
        >
          {ko ? 'NAS 버전 사용' : 'Keep NAS'}
        </button>
        <button
          className="settings-action-btn"
          onClick={() => handleResolve('KeepBoth')}
          disabled={resolving}
        >
          {ko ? '두 버전 모두 보존' : 'Keep Both'}
        </button>
      </div>
    </div>
  );
}
