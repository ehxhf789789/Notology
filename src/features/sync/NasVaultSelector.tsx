import { useState, useEffect, useCallback } from 'react';
import { syncCommands, nasCommands, type NasConnection, type NasVaultEntry } from './syncCommands';
import { NasFolderBrowser } from './NasFolderBrowser';
import { useVaultPath } from '../../core/stores/fileTreeStore';

interface NasVaultSelectorProps {
  onVaultSelected: (localPath: string, vaultName: string) => void;
}

type Phase =
  | 'loading'
  | 'connect'
  | 'connecting'
  | 'vaults'
  | 'browse-open'
  | 'browse-create'
  | 'create-name'
  | 'downloading'
  | 'offline'
  | 'port-change';     // Port change detected — ask user to migrate

/** Validate registered vaults against actual NAS state.
 *  NAS is the source of truth — sync display names accordingly.
 */
async function validateVaultsAgainstNas(conn: import('./syncCommands').NasConnection) {
  for (const vault of conn.vaults) {
    // Verify vault actually exists on NAS
    try {
      const exists = await syncCommands.checkVault(conn.url, conn.username, conn.password, vault.remote_path);
      if (!exists) {
        // Vault path exists but no .notology → might be wrong path
        console.warn(`[validateVaults] ${vault.remote_path} exists but is not a Notology vault`);
      }
    } catch {
      // Vault path doesn't exist on NAS at all
      console.error(`[validateVaults] ${vault.remote_path} NOT FOUND on NAS — vault may have been moved or deleted`);
      // Don't auto-fix — let user handle this
      continue;
    }

    // Sync display name with NAS folder name
    const nasName = vault.remote_path.replace(/\/+$/, '').split('/').pop() || vault.name;
    if (nasName !== vault.name) {
      console.log(`[validateVaults] Syncing name: "${vault.name}" → "${nasName}" (NAS truth)`);
      await nasCommands.updateVaultName(conn.id, vault.remote_path, nasName).catch(() => {});
    }
  }
}

export function NasVaultSelector({ onVaultSelected }: NasVaultSelectorProps) {
  // useVaultPath() only works in main window's React tree.
  // In the separate vault-selector window, we check if main window is visible.
  const mainVaultPath = useVaultPath();
  const [mainWindowActive, setMainWindowActive] = useState(false);
  const [lastActiveRemotePath, setLastActiveRemotePath] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>('loading');

  // Connection
  const [url, setUrl] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [connectionId, setConnectionId] = useState('');
  const [connection, setConnection] = useState<NasConnection | null>(null);
  const [vaults, setVaults] = useState<NasVaultEntry[]>([]);
  const [error, setError] = useState('');

  // Port change
  const [portChangeInfo, setPortChangeInfo] = useState<{ old_connection_id: string; old_url: string; vault_count: number; vault_names: string[] } | null>(null);

  // Rename vault
  const [renamingVault, setRenamingVault] = useState<string | null>(null); // remote_path
  const [renameValue, setRenameValue] = useState('');

  // Create vault
  const [selectedParentPath, setSelectedParentPath] = useState('');
  const [newVaultName, setNewVaultName] = useState('');
  const [creating, setCreating] = useState(false);

  // Download
  const [downloadProgress, setDownloadProgress] = useState({ total: 0, current: 0, file: '' });

  // ================================================================
  // Init: load saved connection → auto-connect → show vaults or offline
  // ================================================================
  useEffect(() => {
    (async () => {
      try {
        const data = await nasCommands.loadConnections();

        if (data.connections.length === 0) {
          // No saved connection — show login form
          setPhase('connect');
          return;
        }

        // Track which vault is currently active (for "현재" badge)
        // Only show "현재" if main window is actually visible (has a vault open)
        if (data.last_active) {
          setLastActiveRemotePath(data.last_active.remote_path);
          // Check if main window is visible
          try {
            const { getCurrentWindow } = await import('@tauri-apps/api/window');
            const label = getCurrentWindow().label;
            if (label === 'vault-selector') {
              // We're in the selector window — check if main is visible
              const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
              const main = new WebviewWindow('main');
              const visible = await main.isVisible();
              setMainWindowActive(visible);
            } else {
              // We're in the main window
              setMainWindowActive(!!data.last_active);
            }
          } catch {
            setMainWindowActive(false);
          }
        }

        // Use first saved connection (including saved password)
        const conn = data.connections[0];
        setUrl(conn.url);
        setUsername(conn.username);
        setPassword(conn.password || '');
        setConnectionId(conn.id);
        setConnection(conn);
        setVaults(conn.vaults);

        if (!conn.password) {
          // Password not saved — need re-login
          setPhase('connect');
          return;
        }

        // Auto-connect
        setPhase('connecting');
        try {
          await syncCommands.browseFolder(conn.url, conn.username, conn.password, '/');
          // Online — validate vaults against NAS
          await validateVaultsAgainstNas(conn);
          // Reload after validation
          const refreshed = await nasCommands.loadConnections();
          const refreshedConn = refreshed.connections.find(c => c.id === conn.id);
          if (refreshedConn) {
            setConnection(refreshedConn);
            setVaults(refreshedConn.vaults);
          }
          setPhase('vaults');
        } catch {
          // Offline — show local cache vaults
          if (conn.vaults.length > 0) {
            setPhase('offline');
          } else {
            setError('NAS에 연결할 수 없습니다. 네트워크를 확인하세요.');
            setPhase('connect');
          }
        }
      } catch {
        setPhase('connect');
      }
    })();
  }, []);

  // Re-check main window state when this window gets focus
  useEffect(() => {
    const checkMainWindow = async () => {
      try {
        const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
        const main = new WebviewWindow('main');
        const visible = await main.isVisible();
        setMainWindowActive(visible);
      } catch {
        setMainWindowActive(false);
      }
    };

    window.addEventListener('focus', checkMainWindow);
    const interval = setInterval(() => {
      checkMainWindow();
      // Also refresh vault list to update sync times
      if (connectionId) {
        nasCommands.loadConnections().then(data => {
          const conn = data.connections.find(c => c.id === connectionId);
          if (conn) {
            setVaults(conn.vaults);
            if (data.last_active) setLastActiveRemotePath(data.last_active.remote_path);
          }
        }).catch(() => {});
      }
    }, 10000); // Refresh every 10 seconds

    return () => {
      window.removeEventListener('focus', checkMainWindow);
      clearInterval(interval);
    };
  }, [connectionId]);

  // Listen for download progress + online recovery
  useEffect(() => {
    let cleanup: (() => void) | undefined;
    (async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');
        const u1 = await listen<{ total: number; current: number; file: string }>('sync:download-progress', (e) => {
          setDownloadProgress(e.payload);
        });
        // Online recovery while in offline mode
        const u2 = await listen('sync:online', () => {
          if (connection && password) {
            setPhase('vaults');
            setError('');
          }
        });
        cleanup = () => { u1(); u2(); };
      } catch {}
    })();
    return () => cleanup?.();
  }, [connection, password]);

  // ================================================================
  // Handlers
  // ================================================================

  const handleConnect = useCallback(async () => {
    if (!url || !username || !password) return;
    setError('');
    setPhase('connecting');
    try {
      await syncCommands.browseFolder(url, username, password, '/');

      // Check for port change: same host, different port, existing vaults
      const portChange = await nasCommands.checkPortChange(url, username);
      if (portChange) {
        setPortChangeInfo(portChange);
        setPhase('port-change');
        return;
      }

      const id = await nasCommands.registerConnection(url, username, password, url);
      setConnectionId(id);
      const data = await nasCommands.loadConnections();
      const conn = data.connections.find(c => c.id === id) || null;
      setConnection(conn);
      setVaults(conn?.vaults || []);
      setPhase('vaults');
    } catch (e: any) {
      setError(e?.toString() || '연결 실패');
      setPhase('connect');
    }
  }, [url, username, password]);

  const [showDisconnectConfirm, setShowDisconnectConfirm] = useState(false);

  const handleDisconnect = useCallback(async () => {
    // "연결 해제" = 로그아웃 (비밀번호 초기화)
    // 보관소 이력과 로컬 사본은 보존됨
    // 다시 로그인하면 기존 보관소가 표시됨
    if (connectionId) {
      // Re-register without password to clear credentials but keep vaults
      await nasCommands.registerConnection(url, username, '', connection?.display_name || url).catch(() => {});
    }
    setPhase('connect');
    setPassword('');
  }, [connectionId, url, username, connection]);

  const handlePortMigrate = useCallback(async () => {
    if (!portChangeInfo) return;
    try {
      const newId = await nasCommands.migratePort(portChangeInfo.old_connection_id, url, username, password);
      setConnectionId(newId);
      const data = await nasCommands.loadConnections();
      const conn = data.connections.find(c => c.id === newId) || null;
      setConnection(conn);
      setVaults(conn?.vaults || []);
      setPortChangeInfo(null);
      setPhase('vaults');
    } catch (e: any) {
      setError(e?.toString() || '마이그레이션 실패');
      setPhase('connect');
    }
  }, [portChangeInfo, url, username, password]);

  const handlePortSkip = useCallback(async () => {
    // Skip migration — register as new connection
    setPortChangeInfo(null);
    const id = await nasCommands.registerConnection(url, username, password, url);
    setConnectionId(id);
    const data = await nasCommands.loadConnections();
    const conn = data.connections.find(c => c.id === id) || null;
    setConnection(conn);
    setVaults(conn?.vaults || []);
    setPhase('vaults');
  }, [url, username, password]);

  const handleSelectVault = useCallback(async (vault: NasVaultEntry) => {
    await nasCommands.setLastActive(connectionId, vault.remote_path).catch(() => {});

    // Configure sync engine for this vault (writes sync-config.json inside vault)
    await syncCommands.connect(url, username, password, vault.local_cache_path).catch((e) => {
      console.warn('[VaultSelector] sync_connect failed:', e);
    });

    // Sync: pull NAS→local, then push local→NAS
    setPhase('downloading');
    setDownloadProgress({ total: 0, current: 0, file: '동기화 중...' });
    try {
      // Pull NAS data to local
      await nasCommands.initialDownload(url, username, password, vault.remote_path, vault.local_cache_path);
      // Full sync: push any local-only files to NAS
      await syncCommands.syncNow().catch(() => {});
    } catch (e) {
      console.warn('[VaultSelector] sync failed:', e);
    }

    onVaultSelected(vault.local_cache_path, vault.name);
  }, [connectionId, url, username, password, onVaultSelected]);

  const handleOpenExistingVault = useCallback(async (selectedPath: string) => {
    setError('');
    try {
      const vault = await nasCommands.openVault(url, username, password, connectionId, selectedPath);
      setPhase('downloading');
      setDownloadProgress({ total: 0, current: 0, file: '준비 중...' });
      await nasCommands.initialDownload(url, username, password, vault.remote_path, vault.local_cache_path);
      onVaultSelected(vault.local_cache_path, vault.name);
    } catch (e: any) {
      setError(e?.toString() || '보관소 열기 실패');
      setPhase('vaults');
    }
  }, [url, username, password, connectionId, onVaultSelected]);

  const handleCreateVault = useCallback(async () => {
    if (!newVaultName.trim() || !selectedParentPath) return;
    setCreating(true);
    setError('');
    try {
      const vault = await nasCommands.createVault(url, username, password, connectionId, selectedParentPath, newVaultName.trim());
      onVaultSelected(vault.local_cache_path, vault.name);
    } catch (e: any) {
      setError(e?.toString() || '보관소 생성 실패');
      setPhase('vaults');
    } finally {
      setCreating(false);
    }
  }, [url, username, password, connectionId, selectedParentPath, newVaultName, onVaultSelected]);

  const handleOfflineOpen = useCallback((vault: NasVaultEntry) => {
    onVaultSelected(vault.local_cache_path, vault.name);
  }, [onVaultSelected]);

  // ================================================================
  // Render
  // ================================================================

  // Loading
  if (phase === 'loading' || phase === 'connecting') {
    return (
      <div className="nas-vault-selector">
        <div className="nas-section">
          <div className="nas-loading">
            {phase === 'loading' ? '설정 확인 중...' : 'NAS 연결 중...'}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="nas-vault-selector">
      {/* ── Connection Section ── */}
      <div className="nas-section">
        <div className="nas-section-title">☁️ NAS 연결</div>

        {phase === 'connect' ? (
          <div className="nas-connect-form">
            <input className="nas-input" type="text" placeholder="https://nas.example.com:5006" value={url} onChange={e => setUrl(e.target.value)} />
            <input className="nas-input" type="text" placeholder="사용자명" value={username} onChange={e => setUsername(e.target.value)} />
            <input className="nas-input" type="password" placeholder="비밀번호" value={password} onChange={e => setPassword(e.target.value)} />
            {error && <div className="nas-error">{error}</div>}
            <button className="nas-btn primary" onClick={handleConnect} disabled={!url || !username || !password}>
              연결
            </button>
          </div>
        ) : phase !== 'offline' ? (
          <div className="nas-connected-bar">
            <span className="nas-connected-dot" />
            <span className="nas-connected-info">
              <strong>{connection?.display_name || url}</strong>
              <span className="nas-connected-user">{username}</span>
            </span>
            <button className="nas-btn-sm danger" onClick={handleDisconnect}>연결 해제</button>
          </div>
        ) : (
          <div className="nas-connected-bar nas-offline-bar">
            <span className="nas-connected-dot nas-dot-offline" />
            <span className="nas-connected-info">
              <strong>{connection?.display_name || url}</strong>
              <span className="nas-connected-user">⚠ 오프라인 — 네트워크 연결을 확인하세요</span>
            </span>
            <button className="nas-btn-sm" onClick={() => { setPhase('connect'); }}>연결 수정</button>
          </div>
        )}
      </div>

      {/* ── Offline Mode ── */}
      {phase === 'offline' && (
        <div className="nas-section">
          <div className="nas-section-title">오프라인 모드</div>
          <div className="nas-offline-warning">
            NAS에 연결할 수 없습니다. 로컬 사본 보관소를 열 수 있습니다.
            온라인으로 전환되면 자동으로 변경사항이 동기화됩니다.
          </div>
          {vaults.length > 0 ? (
            vaults.map(v => (
              <div key={v.remote_path} className="nas-vault-item nas-vault-offline" onClick={() => handleOfflineOpen(v)}>
                <span className="nas-vault-icon">📦</span>
                <div className="nas-vault-info">
                  <span className="nas-vault-name">{v.name}</span>
                  <span className="nas-vault-path">{v.remote_path}</span>
                </div>
                <span className="nas-vault-synced">오프라인</span>
              </div>
            ))
          ) : (
            <div className="nas-empty">로컬 사본이 없습니다. 온라인 연결 후 보관소를 먼저 열어주세요.</div>
          )}
        </div>
      )}

      {/* ── Vault List (Online) ── */}
      {phase === 'vaults' && (
        <div className="nas-section">
          <div className="nas-section-title">
            {vaults.length > 0 ? '보관소 목록' : '보관소 없음'}
          </div>

          {vaults.length === 0 && (
            <p className="nas-empty">연결된 NAS에 등록된 보관소가 없습니다.</p>
          )}

          {vaults.map(v => {
            const normalizeP = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
            // "현재" = main window is visible AND has this vault open
            const isCurrent = mainVaultPath
              ? normalizeP(mainVaultPath) === normalizeP(v.local_cache_path)
              : (mainWindowActive && !!lastActiveRemotePath && normalizeP(lastActiveRemotePath) === normalizeP(v.remote_path));
            return (
              <div
                key={v.remote_path}
                className={`nas-vault-item ${isCurrent ? 'current' : ''}`}
                onClick={() => !isCurrent && handleSelectVault(v)}
              >
                <span className="nas-vault-icon">📦</span>
                <div className="nas-vault-info">
                  {renamingVault === v.remote_path ? (
                    <form className="nas-vault-rename-form" onSubmit={e => {
                      e.preventDefault();
                      if (renameValue.trim() && renameValue !== v.name) {
                        nasCommands.renameVault(url, username, password, connectionId, v.remote_path, renameValue.trim()).then(() => {
                          nasCommands.loadConnections().then(data => {
                            const conn = data.connections.find(c => c.id === connectionId);
                            if (conn) { setVaults(conn.vaults); setConnection(conn); }
                            // If this was the current vault, reopen with new path
                            if (isCurrent && conn) {
                              const renamed = conn.vaults.find(vv => vv.name === renameValue.trim());
                              if (renamed) onVaultSelected(renamed.local_cache_path, renamed.name);
                            }
                          });
                        }).catch(e => setError(e?.toString() || '이름 변경 실패'));
                      }
                      setRenamingVault(null);
                    }}>
                      <input
                        className="nas-vault-rename-input"
                        value={renameValue}
                        onChange={e => setRenameValue(e.target.value)}
                        autoFocus
                        onBlur={() => setRenamingVault(null)}
                        onKeyDown={e => { if (e.key === 'Escape') setRenamingVault(null); }}
                        onClick={e => e.stopPropagation()}
                      />
                    </form>
                  ) : (
                    <span className="nas-vault-name">
                      {v.name}
                      {isCurrent && <span className="nas-vault-current-badge">현재</span>}
                    </span>
                  )}
                  <span className="nas-vault-path">{v.remote_path}</span>
                </div>
                <div className="nas-vault-meta">
                  {v.last_synced && <span className="nas-vault-synced">{formatTimeAgo(v.last_synced)}</span>}
                  <div className="nas-vault-actions-inline" onClick={e => e.stopPropagation()}>
                    <button
                      className="nas-vault-action-btn"
                      title="이름 변경"
                      onClick={() => {
                        setRenamingVault(v.remote_path);
                        setRenameValue(v.name);
                      }}
                    >✏️</button>
                    {!isCurrent && (
                      <button
                        className="nas-vault-action-btn danger"
                        title="보관소 삭제"
                        onClick={() => {
                          nasCommands.removeVault(connectionId, v.remote_path, false).then(() => {
                            nasCommands.loadConnections().then(data => {
                              const conn = data.connections.find(c => c.id === connectionId);
                              if (conn) { setVaults(conn.vaults); setConnection(conn); }
                            });
                          });
                        }}
                      >🗑️</button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}

          {error && <div className="nas-error">{error}</div>}

          <div className="nas-vault-actions">
            <button className="nas-action-card" onClick={() => { setError(''); setPhase('browse-open'); }}>
              <span className="nas-action-icon">📂</span>
              <div className="nas-action-text">
                <strong>보관소 열기</strong>
                <span>NAS에서 기존 보관소 폴더를 선택</span>
              </div>
            </button>
            <button className="nas-action-card" onClick={() => { setError(''); setPhase('browse-create'); }}>
              <span className="nas-action-icon">＋</span>
              <div className="nas-action-text">
                <strong>보관소 생성</strong>
                <span>NAS에 새 보관소를 만듭니다</span>
              </div>
            </button>
          </div>
        </div>
      )}

      {/* ── Browse: Open ── */}
      {phase === 'browse-open' && (
        <div className="nas-section">
          <div className="nas-section-title">보관소 열기 — 폴더 선택</div>
          {error && <div className="nas-error">{error}</div>}
          <NasFolderBrowser
            url={url} username={username} password={password}
            onSelect={(path) => handleOpenExistingVault(path)}
            onCancel={() => { setError(''); setPhase('vaults'); }}
          />
        </div>
      )}

      {/* ── Browse: Create ── */}
      {phase === 'browse-create' && (
        <div className="nas-section">
          <div className="nas-section-title">보관소 생성 — 상위 폴더 선택</div>
          <NasFolderBrowser
            url={url} username={username} password={password}
            onSelect={(path) => { setSelectedParentPath(path); setPhase('create-name'); }}
            onCancel={() => setPhase('vaults')}
          />
        </div>
      )}

      {/* ── Create: Name ── */}
      {phase === 'create-name' && (
        <div className="nas-section">
          <div className="nas-section-title">보관소 이름 입력</div>
          <p className="nas-hint">위치: {selectedParentPath}</p>
          <input className="nas-input" type="text" placeholder="보관소 이름 (예: MyNotes)" value={newVaultName} onChange={e => setNewVaultName(e.target.value)} autoFocus />
          {error && <div className="nas-error">{error}</div>}
          <div className="nas-btn-row">
            <button className="nas-btn" onClick={() => setPhase('vaults')}>취소</button>
            <button className="nas-btn primary" onClick={handleCreateVault} disabled={creating || !newVaultName.trim()}>
              {creating ? '생성 중...' : '보관소 생성'}
            </button>
          </div>
        </div>
      )}

      {/* ── Port Change ── */}
      {phase === 'port-change' && portChangeInfo && (
        <div className="nas-section">
          <div className="nas-section-title">포트 변경 감지</div>
          <div className="nas-port-change-notice">
            <p>
              이전에 <strong>{portChangeInfo.old_url}</strong>으로 연결했던
              보관소 <strong>{portChangeInfo.vault_count}개</strong>가 있습니다.
            </p>
            <div className="nas-port-change-vaults">
              {portChangeInfo.vault_names.map(n => (
                <span key={n} className="nas-port-change-vault-name">📦 {n}</span>
              ))}
            </div>
            <p>
              포트가 변경된 것으로 보입니다.<br />
              기존 로컬 사본을 새 주소로 전환하시겠습니까?<br />
              <small>(전환 시 다시 다운로드하지 않습니다)</small>
            </p>
          </div>
          {error && <div className="nas-error">{error}</div>}
          <div className="nas-btn-row">
            <button className="nas-btn" onClick={handlePortSkip}>새로 시작</button>
            <button className="nas-btn primary" onClick={handlePortMigrate}>기존 사본 전환</button>
          </div>
        </div>
      )}

      {/* ── Downloading ── */}
      {phase === 'downloading' && (
        <div className="nas-section">
          <div className="nas-section-title">보관소 다운로드 중...</div>
          <div className="nas-download-progress">
            <div className="nas-progress-bar">
              <div className="nas-progress-fill" style={{ width: downloadProgress.total > 0 ? `${(downloadProgress.current / downloadProgress.total) * 100}%` : '0%' }} />
            </div>
            <span className="nas-progress-text">
              {downloadProgress.total > 0 ? `${downloadProgress.current} / ${downloadProgress.total} 파일` : '준비 중...'}
            </span>
            <span className="nas-progress-file">{downloadProgress.file}</span>
          </div>
        </div>
      )}
    </div>
  );
}

function formatTimeAgo(isoStr: string): string {
  try {
    const seconds = Math.floor((Date.now() - new Date(isoStr).getTime()) / 1000);
    if (seconds < 60) return '방금';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}분 전`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}시간 전`;
    return `${Math.floor(hours / 24)}일 전`;
  } catch { return ''; }
}
