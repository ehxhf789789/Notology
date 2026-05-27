// Sidebar footer sync status for sync_v2.
// Renders status button + popover + conflict/branch modals (portaled).
//
// 5.0.6l (2026-05-17, HanBin) — popover rewrite. The previous panel was
// inline-styled throughout and gave "지금 동기화" the largest visual weight
// (full-width primary blue button) even though sync runs automatically
// on the standard 5s cadence — users almost never need to push it. New
// hierarchy:
//   1. Status block — dot + label + last-sync timestamp (informational).
//   2. Conditional metadata + state messages (only when present).
//   3. Manual "Sync Now" — secondary button, NOT primary. Promoted to
//      primary tone ONLY when the user is in a state where manual sync
//      meaningfully changes things (Error / Offline / Paused).
//   4. Footer row: Pause/Resume + Trash, equal weight (sync controls).
// design-system <Button> primitive replaces the ad-hoc inline styles and
// the `secondaryBtn` helper.

import { useRef, useState, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { Pause, Play, Trash2, RefreshCw, AlertTriangle } from 'lucide-react';
import { useSyncV2Store } from '../stores/syncV2Store';
import { useLanguage } from '../../../core/stores/settingsStore';
import { useSyncV2Events } from '../hooks/useSyncV2Events';
import { useDirtyQueueBridge } from '../hooks/useDirtyQueueBridge';
import { useEscapeKey } from '../../shared/useEscapeKey';
import { ConflictListModal } from './ConflictListModal';
import { BranchPickerModal } from './BranchPickerModal';
import { Button } from '../../../design-system/components';

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
  const reportHistory = useSyncV2Store(s => s.reportHistory);
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

  // "Sync Now" tone: primary only when the user is in a state where the
  // manual push actually matters. In the Synced steady state the button is
  // a low-emphasis secondary so the panel doesn't scream a CTA users never
  // need to use.
  const syncNowNeedsAttention =
    syncState.type === 'Error' || !online || !syncEnabled;
  const syncNowDisabled = !syncEnabled || syncState.type === 'Syncing';

  // 5.0.6n (2026-05-17, HanBin) — sidebar footer label. The green dot
  // already conveys "synced" — the redundant 동기화됨 text was pure
  // visual noise next to the folder name + ⚙ in the cramped footer row.
  // Drop the text in the steady-Synced state; keep it in every other
  // state where the user needs to know WHAT is wrong (Syncing / Conflict /
  // Error / Offline / Paused). Tooltip on the button still carries the
  // full state explanation regardless.
  const isSteadySynced =
    syncState.type !== 'Syncing'
    && syncState.type !== 'Error'
    && conflicts.length === 0
    && syncEnabled
    && online;

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
          {/* 5.0.6o — footer text. HanBin: "동기화 점만 있으니까 알림
              표시로 안 느껴져." Bare dot was too quiet as a status signal.
              Synced steady: show last-sync relative time so the user sees
              the sync system is alive ("5분 전") without the redundant
              "동기화됨" tautology. Other states: show the explicit label so
              the user knows why the system isn't in normal mode. */}
          {isSteadySynced ? (
            <span className="sync-status-label sync-status-label--meta">
              {lastReport
                ? relativeTime(lastReport.started_at, ko)
                : (ko ? '준비됨' : 'Ready')}
            </span>
          ) : (
            <span className="sync-status-label">{label}</span>
          )}
          {conflicts.length > 0 && (
            <span className="sync-v2-conflict-badge">{conflicts.length}</span>
          )}
        </button>

        {showPopover && createPortal(
          <div
            className="sync-activity-panel"
            ref={popRef}
            style={popStyle}
          >
            {/* ── Status block: information-density first.
                 HanBin 5.0.6m feedback: "동기화됨이라고 표현할 필요가
                 뭐가 있냐고. 동기화 로그를 보여주는것도 아니면서."
                 In the Synced steady state the redundant "동기화됨" label
                 is dropped — the user opened the popover to see WHAT
                 happened, not to read a status they already inferred from
                 the green dot in the footer.

                 New hierarchy by state:
                   • Synced + lastReport → "마지막 동기화 5분 전" + log
                     (file counts uploaded/downloaded). No "동기화됨" label.
                   • Synced + no lastReport → muted "아직 동기화 안 됨"
                     (informational; sync hasn't run yet this session).
                   • Syncing → "동기화 중..." + spinning dot (transient).
                   • Conflict/Error/Offline/Paused → the explicit `label`
                     stays because the user does need to know WHY the
                     panel is in that state.

                 The status block's primary text is now the most useful
                 fact for each state, not a tautology. */}
            <div className="sync-activity-panel__status">
              {(() => {
                if (isSteadySynced) {
                  return (
                    <>
                      <div className="sync-activity-panel__status-row">
                        <span className={`sync-dot ${dotClass}`} />
                        {lastReport ? (
                          <span
                            className="sync-activity-panel__primary-info"
                            title={new Date(lastReport.started_at).toLocaleString()}
                          >
                            {ko ? '마지막 동기화 ' : 'Last sync '}
                            <strong>{relativeTime(lastReport.started_at, ko)}</strong>
                          </span>
                        ) : (
                          <span className="sync-activity-panel__primary-info sync-activity-panel__primary-info--muted">
                            {ko ? '아직 동기화 기록 없음' : 'No sync activity yet'}
                          </span>
                        )}
                      </div>
                      {/* Sync log — counts surfaced as the primary content
                          when there's actual data to show. */}
                      {lastReport && (
                        lastReport.objects_uploaded + lastReport.objects_downloaded +
                        lastReport.refs_pushed.length + lastReport.refs_pulled.length > 0
                      ) && (
                        <div className="sync-activity-panel__meta">
                          {(lastReport.refs_pushed.length > 0 || lastReport.objects_uploaded > 0) && (
                            <span>↑ {lastReport.refs_pushed.length} {ko ? '노트' : 'notes'}</span>
                          )}
                          {(lastReport.refs_pulled.length > 0 || lastReport.objects_downloaded > 0) && (
                            <span>↓ {lastReport.refs_pulled.length} {ko ? '노트' : 'notes'}</span>
                          )}
                          {lastReport.conflicts_detected > 0 && (
                            <span className="sync-activity-panel__meta--danger">
                              <AlertTriangle size={11} /> {lastReport.conflicts_detected} {ko ? '충돌' : 'conflicts'}
                            </span>
                          )}
                        </div>
                      )}
                    </>
                  );
                }
                // Non-steady states keep the explicit label — user needs
                // to know WHY sync isn't in its normal mode.
                return (
                  <>
                    <div className="sync-activity-panel__status-row">
                      <span
                        className={`sync-dot ${dotClass} ${spinning ? 'spinning' : ''}`}
                      />
                      <span className="sync-activity-panel__label">{label}</span>
                      {lastReport && (
                        <span
                          className="sync-activity-panel__when"
                          title={new Date(lastReport.started_at).toLocaleString()}
                        >
                          {relativeTime(lastReport.started_at, ko)}
                        </span>
                      )}
                    </div>
                    {syncState.type === 'Error' && (
                      <div className="sync-activity-panel__error">
                        {syncState.message}
                      </div>
                    )}
                    {!syncEnabled && (
                      <div className="sync-activity-panel__hint">
                        {ko
                          ? '동기화 일시 정지됨. 변경사항은 로컬에만 저장됩니다.'
                          : 'Sync paused. Changes stored locally only.'}
                      </div>
                    )}
                    {!online && syncEnabled && (
                      <div className="sync-activity-panel__hint">
                        {ko
                          ? '오프라인 — 변경사항이 큐에 저장됩니다. 연결이 복구되면 자동 동기화됩니다.'
                          : 'Offline — changes queued; will sync automatically when connection is restored.'}
                      </div>
                    )}
                  </>
                );
              })()}
            </div>

            {/* ── Sync log: actual activity, not just current state.
                 HanBin 5.0.6o feedback: "동기화 로그를 보여주지도 않는데
                 왜 이런 디자인인데? 동기화 로그를 보여주던가."
                 Shows the recent meaningful sync cycles (uploads / downloads
                 / conflicts / errors) with the file names that moved. Idle
                 polling cycles (no work) are filtered out at store level so
                 the log isn't drowned in noise. */}
            {reportHistory.length > 0 && (
              <div className="sync-activity-panel__log">
                <div className="sync-activity-panel__log-header">
                  {ko ? '최근 활동' : 'Recent activity'}
                </div>
                <ul className="sync-activity-panel__log-list">
                  {reportHistory.slice(0, 6).map((r, idx) => {
                    const totalUp = r.refs_pushed.length;
                    const totalDown = r.refs_pulled.length;
                    // Names shown inline (max 3 per direction) so the row
                    // tells you WHICH notes moved, not just a count.
                    const upNames = r.refs_pushed.slice(0, 3).join(', ');
                    const downNames = r.refs_pulled.slice(0, 3).join(', ');
                    const moreUp = Math.max(0, totalUp - 3);
                    const moreDown = Math.max(0, totalDown - 3);
                    const hasErr = r.errors.length > 0;
                    const hasConflict = r.conflicts_detected > 0;
                    return (
                      <li
                        key={`${r.started_at}-${idx}`}
                        className="sync-activity-panel__log-item"
                        title={new Date(r.started_at).toLocaleString()}
                      >
                        <span className="sync-activity-panel__log-when">
                          {relativeTime(r.started_at, ko)}
                        </span>
                        <span className="sync-activity-panel__log-body">
                          {totalUp > 0 && (
                            <span className="sync-activity-panel__log-dir">
                              ↑ {upNames}{moreUp > 0 ? (ko ? ` 외 ${moreUp}` : ` +${moreUp}`) : ''}
                            </span>
                          )}
                          {totalDown > 0 && (
                            <span className="sync-activity-panel__log-dir">
                              ↓ {downNames}{moreDown > 0 ? (ko ? ` 외 ${moreDown}` : ` +${moreDown}`) : ''}
                            </span>
                          )}
                          {hasConflict && (
                            <span className="sync-activity-panel__log-dir sync-activity-panel__log-dir--danger">
                              <AlertTriangle size={10} /> {r.conflicts_detected} {ko ? '충돌' : 'conflicts'}
                            </span>
                          )}
                          {hasErr && (
                            <span className="sync-activity-panel__log-dir sync-activity-panel__log-dir--danger">
                              {ko ? '오류' : 'Error'}: {r.errors[0].message}
                            </span>
                          )}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}

            {/* ── Manual sync trigger ── tone adapts to context.
                 Steady "Synced" state: secondary (sync is automatic; this
                 is a low-emphasis "if you really want to right now" knob).
                 Error / Offline / Paused: primary (manual push or resume
                 is the actionable next step). */}
            <div className="sync-activity-panel__actions">
              <Button
                variant={syncNowNeedsAttention ? 'primary' : 'secondary'}
                size="sm"
                fullWidth
                disabled={syncNowDisabled}
                leftIcon={<RefreshCw size={12} className={spinning ? 'spinning' : ''} />}
                onClick={() => { setShowPopover(false); triggerSync(); }}
                title={syncEnabled
                  ? (ko ? '즉시 동기화' : 'Sync immediately')
                  : (ko ? '동기화가 일시 정지됨' : 'Sync is paused')}
              >
                {syncState.type === 'Syncing'
                  ? (ko ? '동기화 중...' : 'Syncing...')
                  : (ko ? '지금 동기화' : 'Sync now')}
              </Button>
            </div>

            {/* ── Secondary action row: sync-specific only.
                 Settings is intentionally NOT here — the sidebar footer
                 already has a global ⚙ entry point; duplicating it
                 inside this sync popover violates UX consistency. ── */}
            <div className="sync-activity-panel__footer-row">
              <button
                className="sync-activity-panel__footer-btn"
                onClick={() => { setShowPopover(false); toggleSyncEnabled(); }}
                title={syncEnabled
                  ? (ko ? '동기화 일시 정지' : 'Pause sync')
                  : (ko ? '동기화 재개' : 'Resume sync')}
              >
                {syncEnabled ? <Pause size={13} /> : <Play size={13} />}
                <span>{syncEnabled ? (ko ? '일시정지' : 'Pause') : (ko ? '재개' : 'Resume')}</span>
              </button>
              <button
                className="sync-activity-panel__footer-btn"
                onClick={() => {
                  setShowPopover(false);
                  useSyncV2Store.setState({ showTrashPanel: true });
                }}
                title={ko
                  ? '동기화에 의해 휴지통으로 이동된 노트 보기'
                  : 'View notes moved to trash by sync'}
              >
                <Trash2 size={13} />
                <span>{ko ? '휴지통' : 'Trash'}</span>
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
