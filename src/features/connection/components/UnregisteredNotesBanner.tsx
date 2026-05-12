/**
 * UnregisteredNotesBanner — surfaces NAS .md files that exist on the server
 * but are not yet registered in the sync model. User can click to import them.
 *
 * Triggered by `vault:opened` event (sets vault path) — runs a dry-run scan
 * after a short delay so the sync engine has time to start. If unregistered
 * notes are found, banner appears with import action.
 */
import { useState, useEffect, useCallback } from 'react';
import { CloudDownload, X } from 'lucide-react';
import { listen } from '@tauri-apps/api/event';
import * as conn from '../connectionCommands';
import { useVaultPath, fileTreeActions } from '../../../core/stores/fileTreeStore';
import { refreshActions } from '../../../core/stores/refreshStore';

type State = 'idle' | 'scanning' | 'available' | 'importing' | 'done' | 'error' | 'dismissed';

export function UnregisteredNotesBanner() {
  const vaultPath = useVaultPath();
  const [state, setState] = useState<State>('idle');
  const [count, setCount] = useState(0);
  const [errorMsg, setErrorMsg] = useState('');
  const [importedCount, setImportedCount] = useState(0);

  // On vault open / change → schedule a dry-run scan after sync engine warms up
  useEffect(() => {
    if (!vaultPath) {
      setState('idle');
      setCount(0);
      return;
    }
    setState('idle');
    setCount(0);

    // Wait ~3s so sync engine + ref pull settle before scanning
    const timer = setTimeout(async () => {
      setState('scanning');
      try {
        const report = await conn.scanUnregisteredNotes(true);
        if (report.errors.length > 0 && report.foundMdFiles === 0) {
          // Scan failed (no NAS, etc.) — stay quiet
          setState('idle');
          return;
        }
        // newly_registered in dry-run = how many WOULD be imported
        const wouldImport = report.newlyRegistered;
        if (wouldImport > 0) {
          setCount(wouldImport);
          setState('available');
        } else {
          setState('idle');
        }
      } catch (e) {
        // No engine, no remote_base, etc. — stay quiet
        setState('idle');
      }
    }, 3000);

    return () => clearTimeout(timer);
  }, [vaultPath]);

  // Listen for vault-selected event from selector window (also re-trigger scan)
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen('vault-selected', () => {
      // useEffect above will re-run when vaultPath changes
    }).then(fn => { unlisten = fn; });
    return () => unlisten?.();
  }, []);

  const handleImport = useCallback(async () => {
    setState('importing');
    setErrorMsg('');
    try {
      const report = await conn.scanUnregisteredNotes(false);
      setImportedCount(report.newlyRegistered);
      setState('done');
      // Force file tree + search reindex so newly-imported notes appear immediately
      await fileTreeActions.refreshFileTree();
      refreshActions.incrementSearchRefresh();
      // Auto-dismiss after a short delay
      setTimeout(() => setState('dismissed'), 4000);
    } catch (e: any) {
      setErrorMsg(e?.toString() || '가져오기 실패');
      setState('error');
    }
  }, []);

  const handleDismiss = useCallback(() => setState('dismissed'), []);

  if (state === 'idle' || state === 'dismissed' || state === 'scanning') {
    return null;
  }

  const baseStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '10px 16px',
    background: 'var(--bg-1)',
    borderBottom: '1px solid var(--border)',
    fontSize: 13,
    color: 'var(--tx-1)',
  };

  if (state === 'available') {
    return (
      <div style={baseStyle}>
        <CloudDownload size={18} style={{ color: '#3b82f6', flexShrink: 0 }} />
        <div style={{ flex: 1 }}>
          <strong>동기화되지 않은 NAS 노트 {count}개를 발견했습니다.</strong>
          <span style={{ color: 'var(--tx-3)', marginLeft: 6 }}>
            가져오면 사이드바에 표시되고 다른 기기와 동기화됩니다.
          </span>
        </div>
        <button
          onClick={handleImport}
          style={{
            padding: '6px 14px',
            background: '#3b82f6',
            color: '#fff',
            border: 'none',
            borderRadius: 6,
            fontSize: 12,
            fontWeight: 600,
            cursor: 'pointer',
            flexShrink: 0,
          }}
        >
          지금 가져오기
        </button>
        <button
          onClick={handleDismiss}
          aria-label="닫기"
          style={{
            background: 'none',
            border: 'none',
            color: 'var(--tx-3)',
            cursor: 'pointer',
            padding: 4,
            flexShrink: 0,
          }}
        >
          <X size={16} />
        </button>
      </div>
    );
  }

  if (state === 'importing') {
    return (
      <div style={baseStyle}>
        <CloudDownload size={18} style={{ color: '#3b82f6' }} />
        <span>가져오는 중... ({count}개 노트)</span>
      </div>
    );
  }

  if (state === 'done') {
    return (
      <div style={{ ...baseStyle, background: 'rgba(34, 197, 94, 0.08)' }}>
        <CloudDownload size={18} style={{ color: '#22c55e' }} />
        <span>✓ {importedCount}개 노트를 가져왔습니다. 사이드바를 새로고침합니다.</span>
      </div>
    );
  }

  if (state === 'error') {
    return (
      <div style={{ ...baseStyle, background: 'rgba(239, 68, 68, 0.08)' }}>
        <X size={18} style={{ color: '#ef4444' }} />
        <span>가져오기 실패: {errorMsg}</span>
        <button onClick={handleDismiss} style={{ background: 'none', border: 'none', color: 'var(--tx-3)', cursor: 'pointer' }}>닫기</button>
      </div>
    );
  }

  return null;
}
