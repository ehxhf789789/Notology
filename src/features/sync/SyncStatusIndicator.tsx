import { useState, useEffect } from 'react';
import { useLanguage } from '../../core/stores/settingsStore';
import { syncCommands, type SyncStatus } from './syncCommands';
import { ConflictResolverPanel } from './ConflictResolverPanel';

export function SyncStatusIndicator() {
  const language = useLanguage();
  const [status, setStatus] = useState<SyncStatus>({ type: 'Disconnected' });
  const [showConflict, setShowConflict] = useState(false);

  useEffect(() => {
    syncCommands.getStatus().then(setStatus).catch(() => {});

    const interval = setInterval(() => {
      syncCommands.getStatus().then(setStatus).catch(() => {});
    }, 5000);

    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    let cleanup: (() => void) | undefined;
    (async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');
        const u1 = await listen('sync:online', () => syncCommands.getStatus().then(setStatus));
        const u2 = await listen('sync:offline', () => setStatus({ type: 'Offline' }));
        const u3 = await listen('sync:completed', () => syncCommands.getStatus().then(setStatus));
        cleanup = () => { u1(); u2(); u3(); };
      } catch {}
    })();
    return () => cleanup?.();
  }, []);

  if (status.type === 'Disconnected') return null;

  const ko = language === 'ko';
  let dotClass = 'sync-dot-idle';
  let label = ko ? '동기화됨' : 'Synced';
  let spinning = false;

  switch (status.type) {
    case 'Idle':
      dotClass = 'sync-dot-idle'; label = ko ? '동기화됨' : 'Synced'; break;
    case 'Syncing':
      dotClass = 'sync-dot-syncing'; label = ko ? '동기화 중' : 'Syncing'; spinning = true; break;
    case 'Offline':
      dotClass = 'sync-dot-offline'; label = ko ? '오프라인' : 'Offline'; break;
    case 'Conflict':
      dotClass = 'sync-dot-conflict'; label = ko ? `충돌 ${status.files?.length || 0}건` : `${status.files?.length || 0} conflicts`; break;
    case 'Error':
      dotClass = 'sync-dot-error'; label = ko ? '동기화 오류' : 'Sync Error'; break;
  }

  return (
    <>
      <button
        className={`sync-status-indicator ${status.type === 'Conflict' || status.type === 'Error' ? 'clickable' : ''}`}
        onClick={() => {
          if (status.type === 'Conflict') setShowConflict(true);
        }}
        title={label}
      >
        <span className={`sync-dot ${dotClass} ${spinning ? 'spinning' : ''}`} />
        <span className="sync-status-label">{label}</span>
      </button>

      {showConflict && (
        <div className="sync-conflict-overlay" onClick={() => setShowConflict(false)}>
          <div className="sync-conflict-modal" onClick={e => e.stopPropagation()}>
            <ConflictResolverPanel onClose={() => {
              setShowConflict(false);
              syncCommands.getStatus().then(setStatus);
            }} />
          </div>
        </div>
      )}
    </>
  );
}
