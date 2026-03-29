import { useState, useEffect, useCallback } from 'react';
import { useVaultPath } from '../../core/stores/fileTreeStore';
import { useLanguage } from '../../core/stores/settingsStore';
import { syncCommands, type SyncStatus, type SyncConfigPublic } from './syncCommands';
import { NasFolderBrowser } from './NasFolderBrowser';

function SyncSettingsPanel() {
  const vaultPath = useVaultPath();
  const language = useLanguage();

  const [url, setUrl] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [remoteBase, setRemoteBase] = useState('');

  const [status, setStatus] = useState<SyncStatus>({ type: 'Disconnected' });
  const [testResult, setTestResult] = useState<'idle' | 'testing' | 'success' | 'fail'>('idle');
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [lastSyncTime, setLastSyncTime] = useState<Date | null>(null);
  const [errorMsg, setErrorMsg] = useState('');
  const [showBrowser, setShowBrowser] = useState(false);
  const [connectionValid, setConnectionValid] = useState(false);
  const ko = language === 'ko';

  // Load existing config on mount
  useEffect(() => {
    syncCommands.getConfig().then(config => {
      if (config) {
        setUrl(config.url);
        setUsername(config.username);
        setRemoteBase(config.remote_base);
      }
    });
    syncCommands.getStatus().then(setStatus);
  }, []);

  // Poll status every 5s
  useEffect(() => {
    const interval = setInterval(() => {
      syncCommands.getStatus().then(setStatus);
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  const handleTestConnection = useCallback(async () => {
    if (!url || !username || !password) return;
    setTestResult('testing');
    setErrorMsg('');
    setConnectionValid(false);
    try {
      // Just test the WebDAV connection — don't save config yet
      const client = await syncCommands.browseFolder(url, username, password, '/');
      // If browseFolder succeeds, connection is valid
      setTestResult('success');
      setConnectionValid(true);
      setShowBrowser(true); // Open folder browser
    } catch (e: any) {
      setTestResult('fail');
      setConnectionValid(false);
      setErrorMsg(e?.toString() || 'Connection failed');
    }
  }, [url, username, password]);

  const handleFolderSelect = useCallback(async (selectedPath: string, isVault: boolean) => {
    setShowBrowser(false);
    setRemoteBase(selectedPath);
    setSaving(true);
    setErrorMsg('');
    try {
      // Build full URL with selected path as remote base
      const ok = await syncCommands.connect(url, username, password, vaultPath || '');
      if (ok) {
        await syncCommands.startMonitor();
        setTestResult('success');
        const s = await syncCommands.getStatus();
        setStatus(s);
      } else {
        setErrorMsg(ko ? '연결 실패 — 설정을 확인하세요' : 'Connection failed — check settings');
      }
    } catch (e: any) {
      setErrorMsg(e?.toString() || 'Error');
    } finally {
      setSaving(false);
    }
  }, [url, username, password, vaultPath, ko]);

  const handleDisconnect = useCallback(async () => {
    if (!vaultPath) return;
    try {
      await syncCommands.disconnect(vaultPath);
      setStatus({ type: 'Disconnected' });
      setTestResult('idle');
      setUrl('');
      setUsername('');
      setPassword('');
      setRemoteBase('');
    } catch (e: any) {
      setErrorMsg(e?.toString() || 'Error');
    }
  }, [vaultPath]);

  const handleSyncNow = useCallback(async () => {
    setSyncing(true);
    try {
      await syncCommands.syncNow();
      setLastSyncTime(new Date());
      const s = await syncCommands.getStatus();
      setStatus(s);
    } catch (e: any) {
      setErrorMsg(e?.toString() || 'Sync failed');
    } finally {
      setSyncing(false);
    }
  }, []);

  const isConnected = status.type !== 'Disconnected';

  return (
    <div className="settings-panel">
      <section className="settings-section">
        <h3 className="settings-section-title">
          {ko ? 'NAS 동기화 설정' : 'NAS Sync Settings'}
        </h3>

        <div className="settings-row">
          <div className="settings-row-info">
            <span className="settings-row-label">{ko ? '서버 주소' : 'Server URL'}</span>
            <span className="settings-row-desc">{ko ? 'WebDAV 서버 주소' : 'WebDAV server address'}</span>
          </div>
          <input
            className="sync-input"
            type="text"
            value={url}
            onChange={e => setUrl(e.target.value)}
            placeholder="https://nas.example.com:5006/vault"
            disabled={isConnected}
          />
        </div>

        <div className="settings-row">
          <div className="settings-row-info">
            <span className="settings-row-label">{ko ? '사용자명' : 'Username'}</span>
          </div>
          <input
            className="sync-input"
            type="text"
            value={username}
            onChange={e => setUsername(e.target.value)}
            placeholder={ko ? '사용자명' : 'Username'}
            disabled={isConnected}
          />
        </div>

        <div className="settings-row">
          <div className="settings-row-info">
            <span className="settings-row-label">{ko ? '비밀번호' : 'Password'}</span>
          </div>
          <input
            className="sync-input"
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            placeholder="••••••••"
            disabled={isConnected}
          />
        </div>

        {remoteBase && (
          <div className="settings-row">
            <div className="settings-row-info">
              <span className="settings-row-label">{ko ? 'Vault 경로' : 'Vault Path'}</span>
              <span className="settings-row-desc">{remoteBase}</span>
            </div>
          </div>
        )}

        {errorMsg && (
          <div className="sync-error">{errorMsg}</div>
        )}

        <div className="sync-actions">
          {!isConnected ? (
            <>
              <button
                className="settings-action-btn"
                onClick={handleTestConnection}
                disabled={!url || !username || !password || testResult === 'testing'}
              >
                {testResult === 'testing'
                  ? (ko ? '연결 중...' : 'Connecting...')
                  : (ko ? '연결 및 폴더 선택' : 'Connect & Browse')}
              </button>
              {testResult === 'success' && !showBrowser && <span className="sync-test-ok">&#10003; {ko ? '연결됨' : 'Connected'}</span>}
              {testResult === 'fail' && <span className="sync-test-fail">&#10007; {ko ? '실패' : 'Failed'}</span>}
            </>
          ) : (
            <button
              className="settings-action-btn danger"
              onClick={handleDisconnect}
            >
              {ko ? '연결 해제' : 'Disconnect'}
            </button>
          )}
        </div>

        {/* NAS Folder Browser — shown after successful connection */}
        {showBrowser && connectionValid && (
          <NasFolderBrowser
            url={url}
            username={username}
            password={password}
            onSelect={handleFolderSelect}
            onCancel={() => setShowBrowser(false)}
          />
        )}

        {saving && (
          <div className="sync-saving">
            {ko ? '설정 저장 중...' : 'Saving configuration...'}
          </div>
        )}
      </section>

      {isConnected && (
        <section className="settings-section">
          <h3 className="settings-section-title">{ko ? '동기화 상태' : 'Sync Status'}</h3>

          <div className="sync-status-row">
            <SyncStatusBadge status={status} language={language} />
            {lastSyncTime && status.type === 'Idle' && (
              <span className="sync-last-time">
                {ko ? `마지막 동기화 ${formatTimeAgo(lastSyncTime, 'ko')}` : `Last synced ${formatTimeAgo(lastSyncTime, 'en')}`}
              </span>
            )}
          </div>

          <div className="sync-actions">
            <button
              className="settings-action-btn"
              onClick={handleSyncNow}
              disabled={syncing || status.type === 'Syncing'}
            >
              {status.type === 'Syncing'
                ? (ko ? `동기화 중... ${Math.round((status.progress || 0) * 100)}%` : `Syncing... ${Math.round((status.progress || 0) * 100)}%`)
                : syncing
                ? (ko ? '동기화 중...' : 'Syncing...')
                : (ko ? '지금 동기화' : 'Sync Now')}
            </button>
          </div>
        </section>
      )}
    </div>
  );
}

function SyncStatusBadge({ status, language }: { status: SyncStatus; language: string }) {
  const ko = language === 'ko';

  switch (status.type) {
    case 'Idle':
      return <span className="sync-badge sync-badge-idle">&#9679; {ko ? '동기화됨' : 'Synced'}</span>;
    case 'Syncing':
      return <span className="sync-badge sync-badge-syncing">&#8635; {ko ? '동기화 중' : 'Syncing'}{status.current_file ? `: ${status.current_file}` : ''}</span>;
    case 'Offline':
      return <span className="sync-badge sync-badge-offline">&#9679; {ko ? '오프라인' : 'Offline'}</span>;
    case 'Conflict':
      return <span className="sync-badge sync-badge-conflict">&#9679; {ko ? `충돌 ${status.files?.length || 0}건` : `${status.files?.length || 0} conflicts`}</span>;
    case 'Error':
      return <span className="sync-badge sync-badge-error">&#9679; {ko ? '오류' : 'Error'}: {status.message}</span>;
    default:
      return <span className="sync-badge sync-badge-disconnected">&#9679; {ko ? '연결 안 됨' : 'Disconnected'}</span>;
  }
}

function formatTimeAgo(date: Date, lang: string): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  const ko = lang === 'ko';

  if (seconds < 10) return ko ? '방금 전' : 'just now';
  if (seconds < 60) return ko ? `${seconds}초 전` : `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return ko ? `${minutes}분 전` : `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return ko ? `${hours}시간 전` : `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return ko ? `${days}일 전` : `${days}d ago`;
}

export default SyncSettingsPanel;
