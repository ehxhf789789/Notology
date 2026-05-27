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
// 5.0.6k (2026-05-17, HanBin) — i18n + design-system primitives migration.
// The vault selector was Korean-only with 23+ hardcoded strings + 28 .nas-*
// CSS classes + zero design-system primitive consumption. This pass routes
// every label through t()/tf() and replaces ad-hoc <button>/<input> with
// Button/Input primitives. Theme-token compliance is automatic once the
// primitives are in.
import { t, tf } from '../../../core/utils/i18n';
import { useLanguage } from '../../../core/stores/settingsStore';
import { Button, Input, EmptyState } from '../../../design-system/components';

interface Props {
  onVaultSelected: (localPath: string, vaultName: string) => void;
}

// 5.0.6m-2 (2026-05-17, HanBin) — popover shell + positioning moved to
// .vault-popover-panel CSS (sync.css). Three positional variants exist:
//   - `--connection` : drops down under the connection chip
//   - `--row-more`   : drops up above a vault row's ⋯ trigger
//   - `--add`        : drops up above the "+ 보관소 추가" tile, full-width
// Item-level styling lives on .vault-popover-item (+ --danger).

type Phase =
  | 'loading'
  | 'login'
  | 'connecting'
  | 'vaults'
  | 'browse'
  | 'offline';

export function ConnectionVaultSelector({ onVaultSelected }: Props) {
  const language = useLanguage();
  const ko = language === 'ko';
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

  // Global dismiss for popovers — Escape, outside click, drag, or any
  // window-focus loss.
  // 5.0.6ag (2026-05-17, HanBin) — OS-level window drag (Tauri's
  // `-webkit-app-region: drag` on the titlebar) doesn't fire HTML5
  // `dragstart`, so the previous attempt didn't actually dismiss when
  // the user moved the window. Three broader signals cover it now:
  //   • window blur                   — focus moves elsewhere (drag-to-
  //                                     other-app, alt-tab, etc.)
  //   • Tauri window move event       — window position changes (the
  //                                     exact "user is dragging me" signal)
  //   • document mousedown on titlebar→ titlebar mousedown fires even
  //                                     in the drag region; closes the
  //                                     popover before the OS drag begins
  useEffect(() => {
    if (!rowMenuFor && !showAddPopover && !showConnPopover) return;
    const dismissAll = () => {
      setRowMenuFor(null);
      setShowAddPopover(false);
      setShowConnPopover(false);
    };
    const handler = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent && e.key !== 'Escape') return;
      if (e instanceof MouseEvent) {
        const target = e.target as HTMLElement;
        if (target.closest('[data-popover]')) return;
      }
      dismissAll();
    };
    window.addEventListener('keydown', handler);
    window.addEventListener('mousedown', handler);
    window.addEventListener('dragstart', dismissAll, true);
    window.addEventListener('blur', dismissAll);
    // Tauri move event — fires while the user drags the window frame.
    let unlisten: (() => void) | null = null;
    let unlistenResize: (() => void) | null = null;
    (async () => {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        const w = getCurrentWindow();
        unlisten = await w.onMoved(dismissAll);
        unlistenResize = await w.onResized(dismissAll);
      } catch {/* not in Tauri or API missing — non-fatal */}
    })();
    return () => {
      window.removeEventListener('keydown', handler);
      window.removeEventListener('mousedown', handler);
      window.removeEventListener('dragstart', dismissAll, true);
      window.removeEventListener('blur', dismissAll);
      unlisten?.();
      unlistenResize?.();
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
      // 5.0.6w (2026-05-17, HanBin) — remember last-opened time so the
      // selector can show "마지막 사용 N분 전" on each card. Backend
      // DiscoveredVault doesn't carry this; localStorage keyed by remote
      // path is the lightest frontend-only fix.
      try {
        const key = 'notology:vaultLastOpened';
        const raw = localStorage.getItem(key);
        const map = raw ? JSON.parse(raw) as Record<string, string> : {};
        map[vault.remotePath] = new Date().toISOString();
        localStorage.setItem(key, JSON.stringify(map));
      } catch {/* localStorage unavailable — non-fatal */}
      onVaultSelected(result.localPath, result.name);
    } catch (e: any) {
      setError(e?.toString() || 'Failed to open vault');
    }
  }, [onVaultSelected]);

  // 5.0.6w — last-opened map for the per-card "마지막 사용" stamp.
  // Read once at vaults-phase render; we don't need live updates here
  // because the selector closes on selection.
  const lastOpenedMap = (() => {
    try {
      const raw = localStorage.getItem('notology:vaultLastOpened');
      return raw ? JSON.parse(raw) as Record<string, string> : {};
    } catch { return {}; }
  })();
  function vaultRelative(iso: string | undefined, ko: boolean): string | null {
    if (!iso) return null;
    const t = new Date(iso).getTime();
    if (Number.isNaN(t)) return null;
    const sec = Math.max(0, Math.floor((Date.now() - t) / 1000));
    if (sec < 60) return ko ? '방금 사용' : 'just now';
    const m = Math.floor(sec / 60);
    if (m < 60) return ko ? `${m}분 전 사용` : `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return ko ? `${h}시간 전 사용` : `${h}h ago`;
    const d = Math.floor(h / 24);
    if (d < 7) return ko ? `${d}일 전 사용` : `${d}d ago`;
    return ko ? '오래전 사용' : 'a while ago';
  }
  // Hash-based color for the vault avatar — same input always picks the
  // same hue so a vault keeps its "color identity" across launches.
  function vaultAvatarHue(seed: string): number {
    let h = 0;
    for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
    return h % 360;
  }

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
            {phase === 'loading' ? t('vsLoadingConfig', language) : t('vsConnecting', language)}
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
          <div className="nas-section-title"><Cloud size={16} /> {t('vsLoginTitle', language)}</div>
          <div className="nas-connect-card nas-phase-enter">
            <div className="nas-connect-form">
              <Input
                type="text"
                placeholder={t('vsLoginUrlPlaceholder', language)}
                value={url}
                onChange={e => setUrl(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleLogin()}
                aria-label={t('vsLoginTitle', language)}
              />
              <Input
                type="text"
                placeholder={t('vsLoginUsernamePlaceholder', language)}
                value={username}
                onChange={e => setUsername(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleLogin()}
                aria-label={t('vsLoginUsernamePlaceholder', language)}
              />
              <Input
                type="password"
                placeholder={t('vsLoginPasswordPlaceholder', language)}
                value={password}
                onChange={e => setPassword(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleLogin()}
                aria-label={t('vsLoginPasswordPlaceholder', language)}
              />
              {error && <div className="nas-error">{error}</div>}
              <Button
                variant="primary"
                onClick={handleLogin}
                disabled={!url || !username || !password}
                fullWidth
              >
                {t('vsLoginConnectBtn', language)}
              </Button>
            </div>
          </div>
        </div>
      ) : phase === 'vaults' && (
        // 5.0.6u — compact connection chip. Shrunk from a full-width row
        // to an inline pill that reads "● user@host" so the vault grid
        // gets the screen real estate. Click for disconnect popover.
        <div className="vault-connection-chip" data-popover>
          <button
            type="button"
            className="vault-connection-chip__btn"
            onClick={(e) => {
              e.stopPropagation();
              setShowAddPopover(false);
              setRowMenuFor(null);
              setShowConnPopover(prev => !prev);
            }}
            title={`${t('vsConnectedToNas', language)} · ${status?.username || username} · ${status?.url || url}`}
          >
            <span className="vault-connection-chip__dot" aria-hidden="true" />
            <span className="vault-connection-chip__text">
              {(status?.username || username)
                ? `${status?.username || username} · ${stripProtocol(status?.url || url)}`
                : stripProtocol(status?.url || url)}
            </span>
          </button>
          {showConnPopover && (
            <div
              data-popover
              onClick={e => e.stopPropagation()}
              className="vault-popover-panel vault-popover-panel--connection vault-connection-popover"
            >
              <div className="vault-connection-popover__field">
                <div className="vault-connection-popover__label">{t('vsConnPopoverHost', language)}</div>
                <div className="vault-connection-popover__value vault-connection-popover__value--wrap">
                  {status?.url || url}
                </div>
              </div>
              <div className="vault-connection-popover__field">
                <div className="vault-connection-popover__label">{t('vsConnPopoverUser', language)}</div>
                <div className="vault-connection-popover__value">
                  {status?.username || username}
                </div>
              </div>
              <button
                type="button"
                onClick={() => { setShowConnPopover(false); handleDisconnect(); }}
                className="vault-popover-item vault-popover-item--danger"
              >
                <LogOut size={14} /> {t('vsConnPopoverDisconnect', language)}
              </button>
            </div>
          )}
        </div>
      )}

      {/* ── Offline Mode ── */}
      {phase === 'offline' && (
        <div className="nas-section nas-phase-enter">
          <div className="nas-section-title">{t('vsOfflineTitle', language)}</div>
          <div className="nas-offline-warning">{t('vsOfflineDesc', language)}</div>
          <Button variant="secondary" onClick={() => setPhase('login')}>
            {t('vsLoginConnectBtn', language)}
          </Button>
        </div>
      )}

      {/* ── Vault List ── */}
      {phase === 'vaults' && (
        <div className="nas-vaults-section nas-phase-enter">
          {/* Orphan-cleanup banner — passive recommendation, not a button.
              Dismissible per session. Shows only when orphans exist and the
              user hasn't dismissed it this entry. */}
          {orphans.length > 0 && !orphanBannerDismissed && (
            <div role="status" className="vault-orphan-banner">
              <Trash size={14} className="vault-orphan-banner__icon" />
              <span className="vault-orphan-banner__text">
                {tf('vsOrphanBanner', language, { count: String(orphans.length) })}
              </span>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setShowOrphanDialog(true)}
              >
                {t('vsOrphanCleanBtn', language)}
              </Button>
              <button
                type="button"
                onClick={() => setOrphanBannerDismissed(true)}
                title={t('vsOrphanDismiss', language)}
                className="vault-orphan-banner__dismiss"
                aria-label={t('vsOrphanDismiss', language)}
              >
                <X size={13} />
              </button>
            </div>
          )}

          {/* 5.0.6u (2026-05-17, HanBin) — compact 2-column grid. Replaces
              the vertical scroll of section labels + full-width rows. The
              current vault sits in the first cell with a bigger emphasis
              (full-row span if there's an odd count, otherwise just the
              highlighted top-left tile); other vaults flow into the grid;
              the "+ add" tile lives in the last cell. Section labels
              dropped — visual emphasis tells you everything the labels
              were saying twice. */}
          {vaults.length === 0 ? (
            <EmptyState
              icon={<Package size={28} strokeWidth={1.5} />}
              title={t('vsEmptyVaultsTitle', language)}
              description={t('vsEmptyVaultsDesc', language)}
            />
          ) : (() => {
            const currentVault = vaults.find(v => isActiveVault(v));
            const otherVaults = vaults.filter(v => !isActiveVault(v));
            const sortedVaults = currentVault ? [currentVault, ...otherVaults] : vaults;
            const activeBadgeTitle = t('vsVaultRowReturnHint', language);
            const renderVaultCard = (v: DiscoveredVault) => {
              const isCurrent = isActiveVault(v);
              // 5.0.6w — vault identity at a glance: hue from path hash
              // + initial letter avatar. Same vault = same color across
              // launches. Current vault overrides with --c-blue so it
              // ties to the global "active" signal.
              const hue = vaultAvatarHue(v.remotePath);
              const initial = (v.name.trim()[0] || '?').toUpperCase();
              const avatarStyle: React.CSSProperties = isCurrent
                ? {}
                : {
                    background: `hsl(${hue} 70% 92% / 0.7)`,
                    color: `hsl(${hue} 70% 32%)`,
                  };
              const lastOpened = vaultRelative(lastOpenedMap[v.remotePath], ko);
              return (
                <div
                  key={v.remotePath}
                  className={`vault-card${isCurrent ? ' vault-card--current' : ''}`}
                  data-popover
                >
                  <button
                    type="button"
                    className="vault-card__main"
                    onClick={() => handleSelectVault(v)}
                    title={t('vsVaultCardOpen', language)}
                  >
                    <span className="vault-card__avatar" style={avatarStyle} aria-hidden="true">
                      {isCurrent ? <Package size={18} /> : initial}
                    </span>
                    <span className="vault-card__body">
                      <span className="vault-card__name">{v.name}</span>
                      <span className="vault-card__meta">
                        <span className="vault-card__path">{v.remotePath}</span>
                        {lastOpened && (
                          <>
                            <span className="vault-card__meta-sep">·</span>
                            <span className="vault-card__last-opened">{lastOpened}</span>
                          </>
                        )}
                      </span>
                    </span>
                    {isCurrent && (
                      <span className="vault-card__current-badge" title={activeBadgeTitle}>
                        {t('vsCurrentVault', language)}
                      </span>
                    )}
                  </button>
                  {!isCurrent && (
                    <span className="vault-card__actions">
                      <button
                        type="button"
                        className="vault-card__more-btn"
                        title={t('vsVaultCardMore', language)}
                        aria-label={t('vsVaultCardMore', language)}
                        onClick={(e) => {
                          e.stopPropagation();
                          setShowAddPopover(false);
                          setShowConnPopover(false);
                          setRowMenuFor(prev => prev === v.remotePath ? null : v.remotePath);
                        }}
                        disabled={lifecyclePreparing}
                      >
                        <MoreHorizontal size={13} />
                      </button>
                      {rowMenuFor === v.remotePath && (
                        <div
                          data-popover
                          onClick={e => e.stopPropagation()}
                          role="menu"
                          className="vault-popover-panel vault-popover-panel--row-more vault-popover-list"
                        >
                          <button
                            type="button"
                            role="menuitem"
                            className="vault-popover-item"
                            onClick={(e) => {
                              e.stopPropagation();
                              setRowMenuFor(null);
                              openLifecycleAction(v, 'rename');
                            }}
                          >
                            <Edit3 size={14} /> {t('vsVaultRowRename', language)}
                          </button>
                          <button
                            type="button"
                            role="menuitem"
                            className="vault-popover-item vault-popover-item--danger"
                            onClick={(e) => {
                              e.stopPropagation();
                              setRowMenuFor(null);
                              openLifecycleAction(v, 'delete');
                            }}
                          >
                            <Trash2 size={14} /> {t('vsVaultRowDelete', language)}
                          </button>
                        </div>
                      )}
                    </span>
                  )}
                </div>
              );
            };
            return (
              <div className="vault-grid">
                {sortedVaults.map(renderVaultCard)}
                {/* + add tile lives in the grid's last cell, not a stranded
                    row below. Dashed border = "available slot". Popover
                    opens upward so it never clips the window bottom. */}
                <div className="vault-grid__add" data-popover>
                  <button
                    type="button"
                    className="vault-add-card"
                    onClick={(e) => {
                      e.stopPropagation();
                      setShowConnPopover(false);
                      setRowMenuFor(null);
                      setShowAddPopover(prev => !prev);
                    }}
                    title={t('vsAddVaultBtn', language)}
                    aria-label={t('vsAddVaultBtn', language)}
                    aria-haspopup="menu"
                    aria-expanded={showAddPopover}
                  >
                    <span className="vault-add-card__icon"><Plus size={18} strokeWidth={2} /></span>
                    <span className="vault-add-card__name">{t('vsAddVaultBtn', language)}</span>
                  </button>
                  {showAddPopover && (
                    <div
                      data-popover
                      onClick={e => e.stopPropagation()}
                      role="menu"
                      className="vault-popover-panel vault-popover-panel--add vault-popover-list"
                    >
                      <button
                        type="button"
                        role="menuitem"
                        className="vault-popover-item"
                        onClick={() => { setShowAddPopover(false); openCreateDialog(); }}
                      >
                        <Plus size={14} /> {t('vsAddOptionCreate', language)}
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        className="vault-popover-item"
                        onClick={() => { setShowAddPopover(false); openExploreBrowser(); }}
                      >
                        <Search size={14} /> {t('vsAddOptionImport', language)}
                      </button>
                    </div>
                  )}
                </div>
              </div>
            );
          })()}

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
          onMigrateAndOpen={async (remotePath, _legacyKind) => {
            // Legacy bootstrap = same as create_vault. It writes
            // .notology/vault.json into the existing folder, turning it
            // into a Notology vault. The vault-repair auto-detect modal
            // fires 3s after vault open and picks up the legacy patterns
            // (Obsidian wikilinks/attachments, plain-md tree, etc.).
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
  const language = useLanguage();
  useEscapeKey(() => { if (!creating) onCancel(); });
  return createPortal(
    <div className="nas-browser-overlay" onClick={onCancel}>
      <div className="nas-browser-modal vault-create-dialog" onClick={e => e.stopPropagation()}>
        <div className="nas-browser-header">
          <div className="nas-browser-title">{t('vsCreateDialogTitle', language)}</div>
          <button className="nas-browser-close" onClick={onCancel} aria-label={t('close', language)}>
            <X size={18} />
          </button>
        </div>

        <div className="vault-create-dialog__body">
          <div>
            <div className="nas-browser-footer-label vault-create-dialog__field-label">{t('vsCreateDialogLocation', language)}</div>
            <div className="vault-create-dialog__location-row">
              <code className="nas-browser-pick-path">{parentPath}</code>
              <Button variant="secondary" size="sm" onClick={onChooseLocation} disabled={creating}>
                {t('vsCreateDialogChangeLocation', language)}
              </Button>
            </div>
          </div>

          <div>
            <div className="nas-browser-footer-label vault-create-dialog__field-label">{t('vsCreateDialogNameLabel', language)}</div>
            <Input
              type="text"
              placeholder={t('vsCreateDialogNamePlaceholder', language)}
              value={name}
              onChange={e => onChangeName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && name.trim() && !creating && onSubmit()}
              autoFocus
              disabled={creating}
              className="vault-create-dialog__name-input"
              aria-label={t('vsCreateDialogNameLabel', language)}
            />
          </div>

          {error && <div className="nas-error">{error}</div>}
        </div>

        <div className="nas-browser-footer">
          <div className="vault-create-dialog__footer-spacer" />
          <Button variant="secondary" onClick={onCancel} disabled={creating}>
            {t('cancel', language)}
          </Button>
          <Button
            variant="primary"
            leftIcon={<Plus size={14} />}
            onClick={onSubmit}
            disabled={!name.trim() || creating}
            loading={creating}
          >
            {creating ? t('vsCreateDialogSubmitting', language) : t('vsCreateDialogSubmit', language)}
          </Button>
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

/** 5.0.6u — render NAS hosts as `host:port` instead of full `https://host:port`
 *  in the compact connection chip. The protocol is always WebDAV and adds
 *  no information; dropping it lets `user · host:port` fit on one line. */
function stripProtocol(u: string): string {
  return u.replace(/^https?:\/\//, '');
}
