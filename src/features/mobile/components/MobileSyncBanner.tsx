/**
 * MobileSyncBanner — slim status banner for sync_v2 on mobile (Stage 5.0.10e).
 *
 * Rendering policy:
 *   - Hidden when sync is in its steady "synced + online + enabled" state.
 *     The dot-only signal lives in the desktop sidebar footer; mobile has
 *     no equivalent footer surface and shouldn't burn vertical space on
 *     "everything is fine" reassurance.
 *   - Visible when something non-trivial is happening:
 *       • Conflicts present       → opens the conflict list on tap
 *       • Error                   → triggers a manual sync on tap
 *       • Offline (sync enabled)  → informational (queued changes message)
 *       • Paused                  → tap toggles sync back on
 *       • Syncing (transient)     → spinner, no tap target
 *
 * Heavy popover + activity log live in the desktop indicator; mobile
 * stays single-line + single-action.
 */


import { useLanguage } from '../../../core/stores/settingsStore';
import { AlertTriangle, CloudOff, RefreshCw, Pause } from 'lucide-react';

export function MobileSyncBanner() {
  // Mobile shell never mounted the desktop indicator, so subscribe to
  // backend events here so the store stays live on mobile-only builds.
  useSyncV2Events();

  const language = useLanguage();
  const syncState = useSyncV2Store(s => s.syncState);
  const online = useSyncV2Store(s => s.online);
  const syncEnabled = useSyncV2Store(s => s.syncEnabled);
  const conflicts = useSyncV2Store(s => s.conflicts);
  const openConflictList = useSyncV2Store(s => s.openConflictList);
  const triggerSync = useSyncV2Store(s => s.triggerSync);
  const toggleSyncEnabled = useSyncV2Store(s => s.toggleSyncEnabled);

  const ko = language === 'ko';

  // Priority order: conflict > error > syncing > paused > offline > synced
  // Steady state — bail early so no DOM is rendered.
  if (
    syncState.type === 'Idle'
    && conflicts.length === 0
    && online
    && syncEnabled
  ) {
    return null;
  }

  let tone: 'danger' | 'warn' | 'info' | 'progress' = 'info';
  let icon = <CloudOff size={14} strokeWidth={2} />;
  let label = '';
  let onTap: (() => void) | undefined;
  let spinning = false;

  if (conflicts.length > 0) {
    tone = 'danger';
    icon = <AlertTriangle size={14} strokeWidth={2} />;
    label = ko ? `충돌 ${conflicts.length}건 — 해결 필요` : `${conflicts.length} conflict(s) — tap to resolve`;
    onTap = openConflictList;
  } else if (syncState.type === 'Error') {
    tone = 'danger';
    icon = <AlertTriangle size={14} strokeWidth={2} />;
    label = ko ? '동기화 오류 — 다시 시도하려면 탭하세요' : 'Sync error — tap to retry';
    onTap = () => { void triggerSync(); };
  } else if (syncState.type === 'Syncing') {
    tone = 'progress';
    icon = <RefreshCw size={14} strokeWidth={2} />;
    label = ko ? '동기화 중…' : 'Syncing…';
    spinning = true;
  } else if (!syncEnabled) {
    tone = 'warn';
    icon = <Pause size={14} strokeWidth={2} />;
    label = ko ? '동기화 일시 정지됨 — 재개하려면 탭하세요' : 'Sync paused — tap to resume';
    onTap = () => { void toggleSyncEnabled(); };
  } else if (!online) {
    tone = 'info';
    icon = <CloudOff size={14} strokeWidth={2} />;
    label = ko
      ? '오프라인 — 변경사항은 큐에 저장됩니다'
      : 'Offline — changes will sync when reconnected';
  }

  const className = `m-sync-banner m-sync-banner--${tone}`;
  const body = (
    <>
      <span className={`m-sync-banner__icon ${spinning ? 'spinning' : ''}`}>{icon}</span>
      <span className="m-sync-banner__label">{label}</span>
    </>
  );

  return onTap
    ? <button type="button" className={className} onClick={onTap}>{body}</button>
    : <div className={className}>{body}</div>;
}
