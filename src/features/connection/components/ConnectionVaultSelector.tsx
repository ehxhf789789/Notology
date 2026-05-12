/**
 * ConnectionVaultSelector — v2 connection model vault selector.
 * Replaces NasVaultSelector in App.tsx when vaultPath is null.
 * Uses v2 backend (webdav_login, vault_discovery, sync_v2_*).
 * Reuses existing NAS CSS classes for visual consistency.
 */
import { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Cloud, Package, FolderOpen, Plus, Search, X, Edit3, Trash2, Trash, MoreHorizontal, LogOut } from 'lucide-react';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import * as conn from '../connectionCommands';
import type { WebDavStatus, DiscoveredVault, ConnectionTestResult } from '../types';
import { NasFolderBrowser } from './NasFolderBrowser';
import { RenameVaultDialog, DeleteVaultDialog } from './VaultLifecycleDialogs';
import { OrphanCleanupDialog, type Orphan } from './OrphanCleanupDialog';
import { syncV2Commands } from '../../sync_v2/syncV2Commands';
import { useEscapeKey } from '../../shared/useEscapeKey';

interface Props {
  onVaultSelected: (localPath: string, vaultName: string) => void;
}

// Shared style for popover menu items (row "⋯", "+" button, connection pill).
// Inline to keep this redesign self-contained; can be promoted to CSS later.
const popoverItemStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '8px 10px',
  background: 'transparent',
  border: 'none',
  fontSize: 13,
  color: 'var(--tx-1)',
  cursor: 'pointer',
  borderRadius: 4,
  textAlign: 'left',
  width: '100%',
};

// Shared popover container style. Heavy shadow + thick border so the
// popover reads as clearly elevated above the vault list it sits over.
// `animation` uses an inline keyframe — keeps this file self-contained
// without touching global CSS.
const popoverPanelStyle: React.CSSProperties = {
  position: 'absolute',
  background: 'var(--bg-elevated)',
  border: '1px solid var(--sep-o)',
  borderRadius: 8,
  boxShadow: '0 10px 28px rgba(0,0,0,0.28), 0 2px 6px rgba(0,0,0,0.15)',
  zIndex: 100,
  padding: 4,
  display: 'flex',
  flexDirection: 'column',
  // Subtle fade + slight downward slide so the popover feels connected
  // to the trigger button it just spawned from.
  animation: 'notology-popover-in 120ms ease-out',
};

// Inject the keyframe once. Idempotent — re-running just no-ops.
if (typeof document !== 'undefined' && !document.getElementById('notology-popover-anim')) {
  const style = document.createElement('style');
  style.id = 'notology-popover-anim';
  style.textContent = `@keyframes notology-popover-in {
    from { opacity: 0; transform: translateY(-4px); }
    to   { opacity: 1; transform: translateY(0); }
  }`;
  document.head.appendChild(style);
}

type Phase =
  | 'loading'
  | 'login'
  | 'connecting'
  | 'vaults'
  | 'browse'
  | 'offline';

export function ConnectionVaultSelector({ onVaultSelected }: Props) {
  const [phase, setPhase] = useState<Phase>('loading');
  const [status, setStatus] = useState<WebDavStatus | null>(null);
  const [vaults, setVaults] = useState<DiscoveredVault[]>([]);
  const [error, setError] = useState('');

  // Login form
  const [url, setUrl] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [label, setLabel] = useState('');

  // NAS folder browser ("NAS 탐색" toolbar button) — full explore mode.
  const [showBrowser, setShowBrowser] = useState(false);

  // Create-vault modal ("보관소 생성" toolbar button) — separate, simpler
  // dialog: shows the chosen parent path + name input + [생성]. The path
  // can be changed via a sub-picker that re-uses NasFolderBrowser in
  // `mode="pick"`.
  const [showCreate, setShowCreate] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [createParent, setCreateParent] = useState('/');
  const [createName, setCreateName] = useState('');
  const [creating, setCreating] = useState(false);

  // Vault lifecycle (rename / delete). Backend takes explicit paths and
  // works without opening the target vault. The currently-open vault is
  // off-limits (Windows directory rename fails on locked dirs) — we
  // disable the buttons and the backend refuses defensively.
  const [activeRemotePath, setActiveRemotePath] = useState<string | null>(null);
  const [lifecycleTarget, setLifecycleTarget] = useState<{
    vault: DiscoveredVault;
    localPath: string;
    action: 'rename' | 'delete';
  } | null>(null);
  const [lifecyclePreparing, setLifecyclePreparing] = useState(false);

  // Refresh which vault is currently open. Called on mount + after any
  // action that might change it (rename, vault selection).
  const refreshActiveVault = useCallback(async () => {
    try {
      const p = await syncV2Commands.activeVaultRemotePath();
      setActiveRemotePath(p);
    } catch {
      setActiveRemotePath(null);
    }
  }, []);

  useEffect(() => { refreshActiveVault(); }, [refreshActiveVault]);

  const openLifecycleAction = useCallback(async (vault: DiscoveredVault, action: 'rename' | 'delete') => {
    setError('');
    setLifecyclePreparing(true);
    try {
      // Resolve the canonical local path for the target. We use
      // openVaultFromPath which is idempotent (just verifies + computes the
      // path, doesn't touch the engine). This avoids hard-coding the path
      // derivation in the frontend.
      const resolved = await conn.openVaultFromPath(vault.remotePath);
      setLifecycleTarget({ vault, localPath: resolved.localPath, action });
    } catch (e: any) {
      setError(e?.toString() || 'Failed to resolve vault path');
    } finally {
      setLifecyclePreparing(false);
    }
  }, []);

  const closeLifecycle = useCallback(() => setLifecycleTarget(null), []);

  // Orphan local-cache cleanup state. Scan whenever the vault list
  // changes so the badge stays in sync with what the user sees.
  const [orphans, setOrphans] = useState<Orphan[]>([]);
  const [showOrphanDialog, setShowOrphanDialog] = useState(false);
  // Banner-dismiss persists only for the current session — next entry
  // will re-prompt if orphans still exist. The state is intentionally
  // ephemeral; persisting would hide a real problem indefinitely.
  const [orphanBannerDismissed, setOrphanBannerDismissed] = useState(false);

  // Per-row "⋯" menu: holds the remotePath of the row whose popover
  // is open, or null. Only one open at a time.
  const [rowMenuFor, setRowMenuFor] = useState<string | null>(null);

  // Unified "+" button popover (replaces separate create/browse buttons).
  const [showAddPopover, setShowAddPopover] = useState(false);

  // Connection ambient pill popover (replaces inline connection box).
  const [showConnPopover, setShowConnPopover] = useState(false);

  const scanOrphans = useCallback(async (currentVaults: DiscoveredVault[]) => {
    try {
      const names = currentVaults.map(v => v.name);
      const found = await syncV2Commands.listOrphanLocalDirs(names);
      setOrphans(found);
    } catch (e) {
      // Non-fatal: just don't show the badge.
      console.warn('[vault-selector] orphan scan failed:', e);
      setOrphans([]);
    }
  }, []);

  // Re-scan orphans every time the discovered-vault list changes — the
  // set of "known good" names is the diff key, so a rename or delete can
  // turn an entry into an orphan or vice versa.
  useEffect(() => {
    if (phase === 'vaults') {
      scanOrphans(vaults);
    }
  }, [phase, vaults, scanOrphans]);

  // Global dismiss for popovers — Escape or click outside any popover.
  // We use a simple data-popover marker on popover trigger/content so a
  // click inside doesn't close it. Each popover state is reset together.
  useEffect(() => {
    if (!rowMenuFor && !showAddPopover && !showConnPopover) return;
    const handler = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent && e.key !== 'Escape') return;
      if (e instanceof MouseEvent) {
        const target = e.target as HTMLElement;
        if (target.closest('[data-popover]')) return;
      }
      setRowMenuFor(null);
      setShowAddPopover(false);
      setShowConnPopover(false);
    };
    window.addEventListener('keydown', handler);
    window.addEventListener('mousedown', handler);
    return () => {
      window.removeEventListener('keydown', handler);
      window.removeEventListener('mousedown', handler);
    };
  }, [rowMenuFor, showAddPopover, showConnPopover]);

  const isActiveVault = useCallback((v: DiscoveredVault) => {
    if (!activeRemotePath) return false;
    return activeRemotePath.replace(/\/+$/, '') === v.remotePath.replace(/\/+$/, '');
  }, [activeRemotePath]);

  // ── Init: check existing config ──
  useEffect(() => {
    (async () => {
      try {
        const s = await conn.getStatus();
        setStatus(s);

        if (!s.connected) {
          setPhase('login');
          return;
        }

        // Connected — load cached vaults immediately
        setPhase('connecting');
        const cached = await conn.listDiscoveredVaults();
        if (cached && cached.vaults.length > 0) {
          setVaults(cached.vaults);
          setPhase('vaults');
        }

        // Background refresh
        try {
          const scanRoot = deriveScanRoot(cached?.scanRoot);
          const fresh = await conn.refreshVaultDiscovery(scanRoot);
          setVaults(fresh.vaults);
          setPhase('vaults');
        } catch {
          // Offline — show cached if available
          if (cached && cached.vaults.length > 0) {
            setPhase('vaults');
          } else {
            setPhase('offline');
          }
        }
      } catch {
        setPhase('login');
      }
    })();
  }, []);

  // Listen for background discovery updates
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<{ vaults: DiscoveredVault[] }>('vault-discovery:updated', (e) => {
      if (e.payload?.vaults) {
        setVaults(e.payload.vaults);
      }
    }).then(fn => { unlisten = fn; });
    return () => unlisten?.();
  }, []);

  // ── Login ──
  const handleLogin = useCallback(async () => {
    setError('');
    setPhase('connecting');
    try {
      await conn.login(url, username, password, label || url, true);
      const s = await conn.getStatus();
      setStatus(s);

      // Trigger vault discovery
      try {
        const fresh = await conn.refreshVaultDiscovery('/');
        setVaults(fresh.vaults);
      } catch {
        // NAS connected but no vaults found yet — show empty list
      }
      setPhase('vaults');
    } catch (e: any) {
      setError(e?.toString() || 'Login failed');
      setPhase('login');
    }
  }, [url, username, password, label]);

  // ── Disconnect ──
  const handleDisconnect = useCallback(async () => {
    try {
      await conn.logout(false);
      setStatus(null);
      setVaults([]);
      setUrl('');
      setUsername('');
      setPassword('');
      setPhase('login');
    } catch (e: any) {
      setError(e?.toString() || 'Disconnect failed');
    }
  }, []);

  // ── Select vault ──
  const handleSelectVault = useCallback(async (vault: DiscoveredVault) => {
    setError('');
    try {
      const result = await conn.openVaultFromPath(vault.remotePath);
      onVaultSelected(result.localPath, result.name);
    } catch (e: any) {
      setError(e?.toString() || 'Failed to open vault');
    }
  }, [onVaultSelected]);

  // ── Open create-vault dialog ──
  // Picks a sensible default parent path from cached scanRoot or first
  // discovered vault, so the user only has to type a name in the common case.
  const openCreateDialog = useCallback(async () => {
    let parent = '/';
    try {
      const cached = await conn.listDiscoveredVaults();
      if (cached?.scanRoot && cached.scanRoot !== '' && cached.scanRoot !== '/') {
        parent = cached.scanRoot;
      } else if (vaults.length > 0) {
        const idx = vaults[0].remotePath.lastIndexOf('/');
        parent = idx > 0 ? vaults[0].remotePath.substring(0, idx) : '/';
      }
    } catch {
      // fallback to '/'.
    }
    setCreateParent(parent);
    setCreateName('');
    setError('');
    setShowCreate(true);
  }, [vaults]);

  const openExploreBrowser = useCallback(() => {
    setShowBrowser(true);
  }, []);

  const handleCreateSubmit = useCallback(async () => {
    const name = createName.trim();
    if (!name) return;
    setCreating(true);
    setError('');
    try {
      const cleanParent = createParent.replace(/\/+$/, '');
      const remotePath = cleanParent ? `${cleanParent}/${name}` : `/${name}`;
      const result = await conn.createVault(remotePath);
      setShowCreate(false);
      onVaultSelected(result.localPath, result.name);
    } catch (e: any) {
      setError(e?.toString() || 'Failed to create vault');
    } finally {
      setCreating(false);
    }
  }, [createParent, createName, onVaultSelected]);

  // ── Render ──

  if (phase === 'loading' || phase === 'connecting') {
    return (
      <div className="nas-vault-selector">
        <div className="nas-section nas-phase-enter">
          <div className="nas-loading">
            <div className="nas-loading-spinner" />
            {phase === 'loading' ? '설정 확인 중...' : 'WebDAV 연결 중...'}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="nas-vault-selector">
      {/* ── Connection: ambient pill (vaults phase) or full form (login) ──
          During the vaults phase, the connection lives as a small pill at
          the top — clickable for status + disconnect. During the login
          phase we still render the full form since there's nothing else
          to put here yet. */}
      {phase === 'login' ? (
        <div className="nas-section">
          <div className="nas-section-title"><Cloud size={16} /> WebDAV 연결</div>
          <div className="nas-connect-card nas-phase-enter">
            <div className="nas-connect-form">
              <input
                className="nas-input"
                type="text"
                placeholder="https://nas.example.com:5006"
                value={url}
                onChange={e => setUrl(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleLogin()}
              />
              <input
                className="nas-input"
                type="text"
                placeholder="사용자명"
                value={username}
                onChange={e => setUsername(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleLogin()}
              />
              <input
                className="nas-input"
                type="password"
                placeholder="비밀번호"
                value={password}
                onChange={e => setPassword(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleLogin()}
              />
              {error && <div className="nas-error">{error}</div>}
              <button
                className="nas-btn primary"
                onClick={handleLogin}
                disabled={!url || !username || !password}
              >
                연결
              </button>
            </div>
          </div>
        </div>
      ) : phase === 'vaults' && (
        // Outer flex pushes the pill to the right edge. The inner
        // wrapper (which carries data-popover) is fit-content so empty
        // space LEFT of the pill is still OUTSIDE for the dismiss
        // handler — same anti-pattern as the [+ 보관소 추가] button below.
        <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '8px 4px 6px' }}>
        <div
          style={{ position: 'relative', width: 'fit-content' }}
          data-popover
        >
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              // Mutex: close other popovers when opening this one.
              setShowAddPopover(false);
              setRowMenuFor(null);
              setShowConnPopover(prev => !prev);
            }}
            title="WebDAV 연결 상태"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '4px 10px',
              fontSize: 11,
              background: 'var(--bg-base)',
              border: '1px solid var(--sep-o)',
              borderRadius: 999,
              cursor: 'pointer',
              color: 'var(--tx-1)',
              maxWidth: 220,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            <span style={{
              width: 7, height: 7, borderRadius: '50%',
              background: '#2ea043', flexShrink: 0,
            }} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {status?.label || status?.username || status?.url || url}
            </span>
          </button>
          {showConnPopover && (
            <div
              data-popover
              onClick={e => e.stopPropagation()}
              style={{
                ...popoverPanelStyle,
                top: '100%',
                right: 4,
                marginTop: 4,
                minWidth: 260,
                padding: 12,
                display: 'block',
              }}
            >
              <div style={{ fontSize: 11, color: 'var(--tx-2)', marginBottom: 2 }}>호스트</div>
              <div style={{ fontSize: 12, color: 'var(--tx-1)', marginBottom: 10, wordBreak: 'break-all' }}>
                {status?.url || url}
              </div>
              <div style={{ fontSize: 11, color: 'var(--tx-2)', marginBottom: 2 }}>사용자</div>
              <div style={{ fontSize: 12, color: 'var(--tx-1)', marginBottom: 12 }}>
                {status?.username || username}
              </div>
              <button
                type="button"
                onClick={() => { setShowConnPopover(false); handleDisconnect(); }}
                style={{
                  ...popoverItemStyle,
                  color: 'var(--tx-danger)',
                  padding: '8px 10px',
                  border: '1px solid var(--sep-o)',
                  borderRadius: 4,
                }}
              >
                <LogOut size={13} /> 연결 해제
              </button>
            </div>
          )}
        </div>
        </div>
      )}

      {/* ── Offline Mode ── */}
      {phase === 'offline' && (
        <div className="nas-section nas-phase-enter">
          <div className="nas-section-title">오프라인 모드</div>
          <div className="nas-offline-warning">
            WebDAV에 연결할 수 없습니다. 캐시된 보관소 목록이 없습니다.
          </div>
          <button className="nas-btn" onClick={() => setPhase('login')}>연결 수정</button>
        </div>
      )}

      {/* ── Vault List ── */}
      {phase === 'vaults' && (
        <div className="nas-vaults-section nas-phase-enter">
          {/* Orphan-cleanup banner — passive recommendation, not a button.
              Dismissible per session. Shows only when orphans exist and the
              user hasn't dismissed it this entry. */}
          {orphans.length > 0 && !orphanBannerDismissed && (
            <div
              role="status"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '8px 12px',
                margin: '0 0 10px',
                background: 'var(--bg-base)',
                border: '1px solid var(--sep-o)',
                borderRadius: 6,
                fontSize: 12,
                color: 'var(--tx-1)',
              }}
            >
              <Trash size={14} style={{ flexShrink: 0, opacity: 0.7 }} />
              <span style={{ flex: 1 }}>
                NAS에 없는 로컬 캐시 폴더 <strong>{orphans.length}개</strong>가 있습니다.
              </span>
              <button
                type="button"
                onClick={() => setShowOrphanDialog(true)}
                style={{
                  padding: '4px 10px',
                  fontSize: 12,
                  background: 'var(--bg-elevated)',
                  border: '1px solid var(--sep-o)',
                  borderRadius: 4,
                  cursor: 'pointer',
                  color: 'var(--tx-1)',
                }}
              >
                정리
              </button>
              <button
                type="button"
                onClick={() => setOrphanBannerDismissed(true)}
                title="이번 세션에서 더 이상 표시하지 않습니다"
                style={{
                  padding: '4px 6px',
                  background: 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                  color: 'var(--tx-2)',
                  display: 'flex',
                  alignItems: 'center',
                }}
                aria-label="배너 닫기"
              >
                <X size={13} />
              </button>
            </div>
          )}

          <div
            style={{
              // CRITICAL: width must hug the button (not stretch via flex)
              // so empty space to its right counts as OUTSIDE for the
              // dismiss handler. Previously the data-popover marker
              // covered an invisible 456px-wide hit area and clicks to
              // the right of the button kept the popover open.
              display: 'inline-block',
              width: 'fit-content',
              padding: '4px 0 10px',
              position: 'relative',
            }}
            data-popover
          >
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                // Mutex: opening this popover closes the others. The
                // outside-click handler doesn't run when the click target
                // is inside any [data-popover], so we coordinate here.
                setShowConnPopover(false);
                setRowMenuFor(null);
                setShowAddPopover(prev => !prev);
              }}
              title="보관소 추가"
              aria-label="보관소 추가"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                padding: '5px 10px',
                fontSize: 12,
                background: 'var(--bg-base)',
                border: '1px solid var(--sep-o)',
                borderRadius: 6,
                cursor: 'pointer',
                color: 'var(--tx-1)',
                width: 'fit-content',
              }}
            >
              <Plus size={13} /> 보관소 추가
            </button>
            {showAddPopover && (
              <div
                data-popover
                onClick={e => e.stopPropagation()}
                role="menu"
                style={{
                  ...popoverPanelStyle,
                  top: '100%',
                  left: 0,
                  marginTop: 6,
                  minWidth: 180,
                  padding: 2,
                }}
              >
                <button
                  type="button"
                  role="menuitem"
                  style={popoverItemStyle}
                  onClick={() => { setShowAddPopover(false); openCreateDialog(); }}
                >
                  <Plus size={13} /> 새 보관소 만들기
                </button>
                <button
                  type="button"
                  role="menuitem"
                  style={popoverItemStyle}
                  onClick={() => { setShowAddPopover(false); openExploreBrowser(); }}
                >
                  <Search size={13} /> NAS에서 가져오기
                </button>
              </div>
            )}
          </div>

          {vaults.length === 0 ? (
            <div className="nas-empty-state">
              <Package size={32} className="nas-empty-state-icon" />
              <span className="nas-empty-state-text">
                발견된 보관소가 없습니다.<br />
                위 버튼으로 보관소를 생성하세요.
              </span>
            </div>
          ) : (
            <div className="nas-vault-list-section">
              {vaults.map(v => {
                const active = isActiveVault(v);
                // The "active" vault here is the one whose sync engine is
                // still running in the background. Closing the selector
                // (cancel) returns the user to this vault. We can't
                // rename/delete it without first tearing down the engine
                // (Windows file handle locks), so the per-vault actions
                // are disabled until the user picks a different vault.
                const activeBadgeTitle = '취소 시 이 보관소로 돌아갑니다. 이름 변경·삭제는 다른 보관소로 전환한 뒤에 가능합니다.';
                const blockedTitle = activeBadgeTitle;
                return (
                  <div
                    key={v.remotePath}
                    className={`nas-vault-item${active ? ' current' : ''}`}
                    onClick={() => handleSelectVault(v)}
                  >
                    <span className="nas-vault-icon"><Package size={16} /></span>
                    <div className="nas-vault-info">
                      <span className="nas-vault-name">
                        {v.name}
                        {active && (
                          <span className="nas-vault-current-badge" title={activeBadgeTitle}>
                            ↩ 복귀
                          </span>
                        )}
                      </span>
                      <span className="nas-vault-path">{v.remotePath}</span>
                    </div>
                    <div
                      className="nas-vault-actions-inline"
                      style={{ position: 'relative' }}
                      data-popover
                    >
                      <button
                        type="button"
                        className="nas-vault-action-btn"
                        title={active ? blockedTitle : '더 보기'}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (active) return;
                          // Mutex: close other popovers when opening row menu.
                          setShowAddPopover(false);
                          setShowConnPopover(false);
                          setRowMenuFor(prev => prev === v.remotePath ? null : v.remotePath);
                        }}
                        disabled={lifecyclePreparing || active}
                        aria-label="더 보기"
                      >
                        <MoreHorizontal size={14} />
                      </button>
                      {rowMenuFor === v.remotePath && (
                        <div
                          data-popover
                          onClick={e => e.stopPropagation()}
                          role="menu"
                          style={{
                            ...popoverPanelStyle,
                            top: '100%',
                            right: 0,
                            marginTop: 6,
                            minWidth: 150,
                            padding: 2,
                          }}
                        >
                          <button
                            type="button"
                            className="nas-popover-item"
                            onClick={(e) => {
                              e.stopPropagation();
                              setRowMenuFor(null);
                              openLifecycleAction(v, 'rename');
                            }}
                            style={popoverItemStyle}
                          >
                            <Edit3 size={13} /> 이름 변경
                          </button>
                          <button
                            type="button"
                            className="nas-popover-item danger"
                            onClick={(e) => {
                              e.stopPropagation();
                              setRowMenuFor(null);
                              openLifecycleAction(v, 'delete');
                            }}
                            style={{ ...popoverItemStyle, color: 'var(--tx-danger)' }}
                          >
                            <Trash2 size={13} /> 보관소 삭제
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {error && <div className="nas-error">{error}</div>}
        </div>
      )}

      {/* ── NAS folder browser modal ("NAS 탐색") ── */}
      {showBrowser && (
        <NasFolderBrowser
          initialPath="/"
          onClose={() => setShowBrowser(false)}
          onVaultOpen={async (remotePath) => {
            const result = await conn.openVaultFromPath(remotePath);
            setShowBrowser(false);
            onVaultSelected(result.localPath, result.name);
          }}
          onCreateVault={async (parentPath, name) => {
            const cleanParent = parentPath.replace(/\/+$/, '') || '';
            const remotePath = cleanParent ? `${cleanParent}/${name}` : `/${name}`;
            const result = await conn.createVault(remotePath);
            setShowBrowser(false);
            onVaultSelected(result.localPath, result.name);
          }}
        />
      )}

      {/* ── Create-vault dialog ("보관소 생성") ── */}
      {showCreate && (
        <CreateVaultDialog
          parentPath={createParent}
          name={createName}
          creating={creating}
          error={error}
          onChangeName={setCreateName}
          onChooseLocation={() => setShowPicker(true)}
          onCancel={() => { setShowCreate(false); setError(''); }}
          onSubmit={handleCreateSubmit}
        />
      )}

      {/* ── Location picker (sub-modal of CreateVaultDialog) ── */}
      {showPicker && (
        <NasFolderBrowser
          mode="pick"
          initialPath={createParent}
          onClose={() => setShowPicker(false)}
          onPickPath={(p) => {
            setCreateParent(p);
            setShowPicker(false);
          }}
        />
      )}

      {/* ── Vault lifecycle dialogs (rename / delete) ── */}
      {lifecycleTarget?.action === 'rename' && (
        <RenameVaultDialog
          ko
          currentName={lifecycleTarget.vault.name}
          remotePath={lifecycleTarget.vault.remotePath}
          localPath={lifecycleTarget.localPath}
          onClose={closeLifecycle}
          onRenamed={async (result) => {
            // Refresh the vault list so the renamed entry appears under its
            // new name. User stays in the selector — they can click the
            // renamed vault to enter it (or any other vault).
            closeLifecycle();
            try {
              const cached = await conn.listDiscoveredVaults();
              const scanRoot = deriveScanRoot(cached?.scanRoot);
              const fresh = await conn.refreshVaultDiscovery(scanRoot);
              setVaults(fresh.vaults);
            } catch (e) {
              console.warn('[vault-selector] refresh after rename failed:', e);
            }
            await refreshActiveVault();
            // Surface the new path to the caller in case it wants to enter
            // the renamed vault directly. Currently we just stay; user
            // confirms with a click.
            void result;
          }}
        />
      )}
      {lifecycleTarget?.action === 'delete' && (
        <DeleteVaultDialog
          ko
          currentName={lifecycleTarget.vault.name}
          remotePath={lifecycleTarget.vault.remotePath}
          localPath={lifecycleTarget.localPath}
          onClose={closeLifecycle}
          onDeleted={async () => {
            // Vault is gone — refresh discovery so the list rebuilds without
            // the deleted entry. User stays in the selector.
            closeLifecycle();
            try {
              const cached = await conn.listDiscoveredVaults();
              const scanRoot = deriveScanRoot(cached?.scanRoot);
              const fresh = await conn.refreshVaultDiscovery(scanRoot);
              setVaults(fresh.vaults);
            } catch (e) {
              console.warn('[vault-selector] refresh after delete failed:', e);
            }
            await refreshActiveVault();
          }}
        />
      )}

      {/* ── Orphan local-cache cleanup ── */}
      {showOrphanDialog && (
        <OrphanCleanupDialog
          ko
          orphans={orphans}
          onClose={() => setShowOrphanDialog(false)}
          onCleaned={async () => {
            // After cleanup, re-scan so the badge updates / disappears.
            await scanOrphans(vaults);
          }}
        />
      )}
    </div>
  );
}

/**
 * Standalone create-vault dialog: name input + chosen parent path with
 * "위치 변경" button that opens the location picker. Decoupled from the
 * full NAS browser so the create flow is a clean two-field form.
 */
interface CreateVaultDialogProps {
  parentPath: string;
  name: string;
  creating: boolean;
  error: string;
  onChangeName: (name: string) => void;
  onChooseLocation: () => void;
  onCancel: () => void;
  onSubmit: () => void;
}

function CreateVaultDialog({
  parentPath, name, creating, error,
  onChangeName, onChooseLocation, onCancel, onSubmit,
}: CreateVaultDialogProps) {
  useEscapeKey(() => { if (!creating) onCancel(); });
  return createPortal(
    <div className="nas-browser-overlay" onClick={onCancel}>
      <div className="nas-browser-modal" onClick={e => e.stopPropagation()} style={{ width: 'min(480px, 90vw)' }}>
        <div className="nas-browser-header">
          <div className="nas-browser-title">새 보관소 생성</div>
          <button className="nas-browser-close" onClick={onCancel} aria-label="닫기">
            <X size={18} />
          </button>
        </div>

        <div style={{ padding: '18px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <div className="nas-browser-footer-label" style={{ marginBottom: 6 }}>위치</div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <code className="nas-browser-pick-path">{parentPath}</code>
              <button className="nas-btn" onClick={onChooseLocation} disabled={creating}>
                위치 변경
              </button>
            </div>
          </div>

          <div>
            <div className="nas-browser-footer-label" style={{ marginBottom: 6 }}>보관소 이름</div>
            <input
              className="nas-input"
              type="text"
              placeholder="보관소 이름 (예: MyNotes)"
              value={name}
              onChange={e => onChangeName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && name.trim() && !creating && onSubmit()}
              autoFocus
              disabled={creating}
              style={{ width: '100%' }}
            />
          </div>

          {error && <div className="nas-error">{error}</div>}
        </div>

        <div className="nas-browser-footer">
          <div style={{ flex: 1 }} />
          <button className="nas-btn" onClick={onCancel} disabled={creating}>취소</button>
          <button
            className="nas-btn primary"
            onClick={onSubmit}
            disabled={!name.trim() || creating}
          >
            <Plus size={14} /> {creating ? '생성 중...' : '보관소 생성'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

/** Derive scan root from cached scanRoot or default "/" */
function deriveScanRoot(cached?: string | null): string {
  return cached && cached !== '/' ? cached : '/';
}
