// Sidebar footer sync status for sync_v2.
// Renders status button + popover + conflict/branch modals (portaled).

import { useRef, useState, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { Pause, Play, Trash2, RefreshCw } from 'lucide-react';
import { useSyncV2Store } from '../stores/syncV2Store';
import { useLanguage } from '../../../core/stores/settingsStore';
import { useSyncV2Events } from '../hooks/useSyncV2Events';
import { useDirtyQueueBridge } from '../hooks/useDirtyQueueBridge';
import { useEscapeKey } from '../../shared/useEscapeKey';
import { ConflictListModal } from './ConflictListModal';
import { BranchPickerModal } from './BranchPickerModal';

/** Compact secondary-action button style for the panel footer row.
 *  `withLeftBorder` adds a 1px divider to visually separate columns
 *  inside the 3-up grid. */
function secondaryBtn(withLeftBorder: boolean): React.CSSProperties {
  return {
    padding: '8px 6px',
    fontSize: 11,
    background: 'transparent',
    border: 'none',
    borderLeft: withLeftBorder ? '1px solid var(--sep-o)' : 'none',
    cursor: 'pointer',
    color: 'var(--tx-1)',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    transition: 'background 120ms',
  };
}

/** "5 minutes ago" formatter — small enough not to need a library. */
function relativeTime(iso: string | null | undefined, ko: boolean): string {
  if (!iso) return ko ? '없음' : 'never';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return ko ? '없음' : 'never';
  const sec = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (sec < 10) return ko ? '방금' : 'just now';
  if (sec < 60) return ko ? `${sec}초 전` : `${sec}s ago`;
  const m = Math.floor(sec / 60);
  if (m < 60) return ko ? `${m}분 전` : `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return ko ? `${h}시간 전` : `${h}h ago`;
  const d = Math.floor(h / 24);
  return ko ? `${d}일 전` : `${d}d ago`;
}

export function SyncV2StatusIndicator() {
  // Subscribe to backend events once (idempotent via useEffect)
  useSyncV2Events();
  // Bridge frontend events → dirty queue + visibility/activity signals
  useDirtyQueueBridge();

  const language = useLanguage();
  const syncState = useSyncV2Store(s => s.syncState);
  const online = useSyncV2Store(s => s.online);
  const syncEnabled = useSyncV2Store(s => s.syncEnabled);
  const conflicts = useSyncV2Store(s => s.conflicts);
  const lastReport = useSyncV2Store(s => s.lastReport);
  const openConflictList = useSyncV2Store(s => s.openConflictList);
  const triggerSync = useSyncV2Store(s => s.triggerSync);
  const toggleSyncEnabled = useSyncV2Store(s => s.toggleSyncEnabled);

  const [showPopover, setShowPopover] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  const ko = language === 'ko';

  // Esc key closes popover (consistent with all other dismissable surfaces).
  useEscapeKey(() => setShowPopover(false), showPopover);

  // Close popover on outside click
  useEffect(() => {
    if (!showPopover) return;
    const handler = (e: MouseEvent) => {
      if (popRef.current && !popRef.current.contains(e.target as Node)
          && btnRef.current && !btnRef.current.contains(e.target as Node)) {
        setShowPopover(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showPopover]);

  const popStyle = useMemo(() => {
    if (!showPopover || !btnRef.current) return {};
    const rect = btnRef.current.getBoundingClientRect();
    return {
      position: 'fixed' as const,
      bottom: window.innerHeight - rect.top + 8,
      left: rect.left,
    };
  }, [showPopover]);

  // Derive display state. Priority order:
  //   conflict (user action) > syncing > error > paused (user toggle)
  //   > offline (involuntary) > synced.
  // Paused outranks offline because it's a deliberate user state and the
  // tooltip wording differs ("일시 정지" vs "오프라인").
  let dotClass = 'sync-dot-idle';
  let label = ko ? '동기화됨' : 'Synced';
  let spinning = false;

  if (syncState.type === 'Syncing') {
    dotClass = 'sync-dot-syncing';
    spinning = true;
    label = ko ? '동기화 중' : 'Syncing';
  } else if (conflicts.length > 0) {
    dotClass = 'sync-dot-conflict';
    label = ko ? `충돌 ${conflicts.length}건` : `${conflicts.length} conflicts`;
  } else if (syncState.type === 'Error') {
    dotClass = 'sync-dot-error';
    label = ko ? '동기화 오류' : 'Sync Error';
  } else if (!syncEnabled) {
    dotClass = 'sync-dot-offline';
    label = ko ? '일시 정지됨' : 'Paused';
  } else if (!online) {
    dotClass = 'sync-dot-offline';
    label = ko ? '오프라인' : 'Offline';
  }

  const offlineTooltip = ko
    ? '오프라인 — 변경사항이 큐에 저장됩니다. 연결이 복구되면 자동 동기화됩니다.'
    : 'Offline — changes are queued and will sync automatically when connection is restored.';
  const pausedTooltip = ko
    ? '동기화 일시 정지됨 — 변경사항은 로컬에만 저장됩니다. 다시 시작하려면 클릭하세요.'
    : 'Sync paused — changes are kept locally only. Click to resume.';

  const handleClick = () => {
    if (conflicts.length > 0) {
      openConflictList();
    } else {
      setShowPopover(p => !p);
    }
  };

  return (
    <>
      <div style={{ display: 'inline-flex' }}>
        <button
          ref={btnRef}
          className="sync-status-indicator clickable"
          onClick={handleClick}
          title={
            syncState.type === 'Error' ? syncState.message
              : !syncEnabled ? pausedTooltip
              : !online ? offlineTooltip
              : label
          }
        >
          <span className={`sync-dot ${dotClass} ${spinning ? 'spinning' : ''}`} />
          <span className="sync-status-label">{label}</span>
          {conflicts.length > 0 && (
            <span className="sync-v2-conflict-badge">{conflicts.length}</span>
          )}
        </button>

        {showPopover && createPortal(
          <div
            className="sync-activity-panel"
            ref={popRef}
            style={{
              ...popStyle,
              minWidth: 260,
              padding: 0,
              overflow: 'hidden',
            }}
          >
            {/* ── Status block: dot + state + last-sync metadata ── */}
            <div style={{ padding: '12px 14px 10px' }}>
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
              }}>
                <span
                  className={`sync-dot ${dotClass} ${spinning ? 'spinning' : ''}`}
                  style={{ flexShrink: 0 }}
                />
                <span style={{
                  fontSize: 13,
                  color: 'var(--tx-1)',
                  fontWeight: 500,
                  flex: 1,
                }}>
                  {label}
                </span>
                {lastReport && (
                  <span
                    style={{ fontSize: 11, color: 'var(--tx-2)' }}
                    title={new Date(lastReport.started_at).toLocaleString()}
                  >
                    {relativeTime(lastReport.started_at, ko)}
                  </span>
                )}
              </div>

              {/* Compact metadata row — only if there's data to show */}
              {lastReport && (
                lastReport.objects_uploaded + lastReport.objects_downloaded +
                lastReport.refs_pushed.length + lastReport.refs_pulled.length > 0
              ) && (
                <div style={{
                  marginTop: 6,
                  fontSize: 11,
                  color: 'var(--tx-2)',
                  display: 'flex',
                  gap: 10,
                  flexWrap: 'wrap',
                }}>
                  {(lastReport.refs_pushed.length > 0 || lastReport.objects_uploaded > 0) && (
                    <span>↑ {lastReport.refs_pushed.length} {ko ? '노트' : 'notes'}</span>
                  )}
                  {(lastReport.refs_pulled.length > 0 || lastReport.objects_downloaded > 0) && (
                    <span>↓ {lastReport.refs_pulled.length} {ko ? '노트' : 'notes'}</span>
                  )}
                  {lastReport.conflicts_detected > 0 && (
                    <span style={{ color: 'var(--tx-danger)' }}>
                      ⚠ {lastReport.conflicts_detected} {ko ? '충돌' : 'conflicts'}
                    </span>
                  )}
                </div>
              )}

              {syncState.type === 'Error' && (
                <div
                  style={{
                    marginTop: 8,
                    padding: '6px 8px',
                    background: 'var(--bg-hover)',
                    border: '1px solid var(--tx-danger)',
                    borderRadius: 4,
                    fontSize: 11,
                    color: 'var(--tx-danger)',
                  }}
                >
                  {syncState.message}
                </div>
              )}

              {!syncEnabled && (
                <div
                  style={{
                    marginTop: 8,
                    padding: '6px 8px',
                    background: 'var(--bg-hover)',
                    borderRadius: 4,
                    fontSize: 11,
                    color: 'var(--tx-2)',
                    lineHeight: 1.4,
                  }}
                >
                  {ko
                    ? '동기화 일시 정지됨. 변경사항은 로컬에만 저장됩니다.'
                    : 'Sync paused. Changes stored locally only.'}
                </div>
              )}
            </div>

            {/* ── Primary CTA: "지금 동기화" (full-width) ── */}
            <div style={{ padding: '0 14px 12px' }}>
              <button
                onClick={() => { setShowPopover(false); triggerSync(); }}
                disabled={!syncEnabled || syncState.type === 'Syncing'}
                style={{
                  width: '100%',
                  padding: '8px 12px',
                  fontSize: 12,
                  fontWeight: 500,
                  background: syncEnabled && syncState.type !== 'Syncing'
                    ? 'var(--tx-link, #0A84FF)'
                    : 'var(--bg-hover)',
                  color: syncEnabled && syncState.type !== 'Syncing'
                    ? '#fff'
                    : 'var(--tx-2)',
                  border: 'none',
                  borderRadius: 5,
                  cursor: syncEnabled && syncState.type !== 'Syncing' ? 'pointer' : 'default',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 6,
                }}
                title={syncEnabled
                  ? (ko ? '즉시 동기화' : 'Sync immediately')
                  : (ko ? '동기화가 일시 정지됨' : 'Sync is paused')}
              >
                <RefreshCw size={12} className={spinning ? 'spinning' : ''} />
                {syncState.type === 'Syncing'
                  ? (ko ? '동기화 중...' : 'Syncing...')
                  : (ko ? '지금 동기화' : 'Sync Now')}
              </button>
            </div>

            {/* ── Secondary action row: sync-specific only.
                 Settings is intentionally NOT here — the sidebar footer
                 already has a global ⚙ entry point; duplicating it
                 inside this sync popover violates UX consistency. ── */}
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr 1fr',
                borderTop: '1px solid var(--sep-o)',
                background: 'var(--bg-hover)',
              }}
            >
              <button
                onClick={() => { setShowPopover(false); toggleSyncEnabled(); }}
                title={syncEnabled
                  ? (ko ? '동기화 일시 정지' : 'Pause sync')
                  : (ko ? '동기화 재개' : 'Resume sync')}
                style={secondaryBtn(false)}
              >
                {syncEnabled ? <Pause size={13} /> : <Play size={13} />}
                <span style={{ marginLeft: 4 }}>
                  {syncEnabled ? (ko ? '일시정지' : 'Pause') : (ko ? '재개' : 'Resume')}
                </span>
              </button>
              <button
                onClick={() => {
                  setShowPopover(false);
                  useSyncV2Store.setState({ showTrashPanel: true });
                }}
                title={ko
                  ? '동기화에 의해 휴지통으로 이동된 노트 보기'
                  : 'View notes moved to trash by sync'}
                style={secondaryBtn(true)}
              >
                <Trash2 size={13} />
                <span style={{ marginLeft: 4 }}>{ko ? '휴지통' : 'Trash'}</span>
              </button>
            </div>
          </div>,
          document.body
        )}
      </div>

      {/* Conflict resolution modals — portaled to body */}
      <ConflictListModal />
      <BranchPickerModal />
    </>
  );
}
