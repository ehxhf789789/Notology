import { useState, useEffect, useCallback } from 'react';
import { useLanguage } from '../../core/stores/settingsStore';
import { syncCommands, type SyncStatus } from './syncCommands';

interface SyncStatusIndicatorProps {
  onClick?: () => void;
}

export function SyncStatusIndicator({ onClick }: SyncStatusIndicatorProps) {
  const language = useLanguage();
  const [status, setStatus] = useState<SyncStatus>({ type: 'Disconnected' });

  useEffect(() => {
    syncCommands.getStatus().then(setStatus).catch(() => {});

    const interval = setInterval(() => {
      syncCommands.getStatus().then(setStatus).catch(() => {});
    }, 5000);

    return () => clearInterval(interval);
  }, []);

  // Listen for Tauri events
  useEffect(() => {
    let cleanup: (() => void) | undefined;
    (async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');
        const unlisten1 = await listen('sync:online', () => {
          syncCommands.getStatus().then(setStatus);
        });
        const unlisten2 = await listen('sync:offline', () => {
          setStatus({ type: 'Offline' });
        });
        const unlisten3 = await listen('sync:completed', () => {
          syncCommands.getStatus().then(setStatus);
        });
        cleanup = () => {
          unlisten1();
          unlisten2();
          unlisten3();
        };
      } catch {}
    })();
    return () => cleanup?.();
  }, []);

  // Don't render if not configured
  if (status.type === 'Disconnected') return null;

  const ko = language === 'ko';

  let dotClass = 'sync-dot-idle';
  let label = ko ? '동기화됨' : 'Synced';
  let spinning = false;

  switch (status.type) {
    case 'Idle':
      dotClass = 'sync-dot-idle';
      label = ko ? '동기화됨' : 'Synced';
      break;
    case 'Syncing':
      dotClass = 'sync-dot-syncing';
      label = ko ? '동기화 중' : 'Syncing';
      spinning = true;
      break;
    case 'Offline':
      dotClass = 'sync-dot-offline';
      label = ko ? '오프라인' : 'Offline';
      break;
    case 'Conflict':
      dotClass = 'sync-dot-conflict';
      label = ko ? `충돌 ${status.files?.length || 0}건` : `${status.files?.length || 0} conflicts`;
      break;
    case 'Error':
      dotClass = 'sync-dot-error';
      label = ko ? '동기화 오류' : 'Sync Error';
      break;
  }

  return (
    <button
      className={`sync-status-indicator ${status.type === 'Conflict' ? 'clickable' : ''}`}
      onClick={onClick}
      title={label}
    >
      <span className={`sync-dot ${dotClass} ${spinning ? 'spinning' : ''}`} />
      <span className="sync-status-label">{label}</span>
    </button>
  );
}
