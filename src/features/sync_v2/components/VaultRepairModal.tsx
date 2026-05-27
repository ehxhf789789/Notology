/**
 * VaultRepairModal — 2026-05-24 (HanBin).
 *
 * Surfaces the result of `vaultRepairScan` and lets the user trigger
 * `vaultRepairApply`. Modal is portaled to body, dismissible via
 * backdrop click / Esc / "건너뛰기" button.
 *
 * Trigger model (per HanBin decision 2026-05-24):
 *   • Auto-open on vault first-open IF the scan returns
 *     `repairRecommended=true` AND no `.notology/repair_history.json`
 *     marker exists (handled by the caller — see useVaultRepairAutoDetect).
 *   • Manually invokable via Settings → Dev Mode tab.
 *
 * Stage flow:
 *   1. SCAN  — modal opens with summary counts + "복구 시작" button.
 *   2. APPLY — progress shown via a transient state; backend logs the
 *      manifest path on completion.
 *   3. VERIFY — invariant check runs automatically after apply; any
 *      failures are surfaced inline as warnings.
 *
 * No automatic body rewrites (P5/ambiguous P4) — those need user
 * decisions and are shown as a "수동 확인 필요" sub-list.
 */

import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { listen } from '@tauri-apps/api/event';
import { AlertTriangle, CheckCircle2, X as XIcon, Wrench } from 'lucide-react';
import {
  syncV2Commands,
  type VaultRepairReport,
  type VaultRepairOutcome,
  type VaultRepairVerificationFailure,
  type VaultRepairProgress,
} from '../syncV2Commands';
import { useSettingsStore } from '../../../core/stores/settingsStore';
import { t } from '../../../core/utils/i18n';

type Stage = 'idle' | 'applying' | 'done' | 'error';

interface Props {
  report: VaultRepairReport;
  onClose: () => void;
  /** Hide the "이번엔 건너뛰기" affordance (forced repair). Default: false. */
  forceComplete?: boolean;
}

export default function VaultRepairModal({ report, onClose, forceComplete }: Props) {
  const language = useSettingsStore((s) => s.language);
  const [stage, setStage] = useState<Stage>('idle');
  const [outcome, setOutcome] = useState<VaultRepairOutcome | null>(null);
  const [verifyFails, setVerifyFails] = useState<VaultRepairVerificationFailure[]>([]);
  const [err, setErr] = useState<string | null>(null);

  // Esc closes ALWAYS — even mid-apply. (2026-05-24 HanBin: user
  // observed the spinner appearing stuck for several minutes on large
  // vaults and had no escape. The apply continues running in the
  // background; closing the modal just hides the UI. Status can be
  // re-checked by running scan again from Settings → Dev Mode.)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Stage A — live progress subscription. The backend emits
  // `vault-repair:progress` every 250ms with the current stage +
  // current/total counts + elapsed_ms. On mount we ALSO poll once
  // to handle the case where the apply was triggered by another
  // surface (Settings → Dev Mode) and this modal opened after the
  // first event already fired.
  const [liveProgress, setLiveProgress] = useState<VaultRepairProgress | null>(null);
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    (async () => {
      try {
        const initial = await syncV2Commands.vaultRepairStatus();
        if (!cancelled) setLiveProgress(initial);
      } catch {}
      try {
        unlisten = await listen<VaultRepairProgress>('vault-repair:progress', (e) => {
          setLiveProgress(e.payload);
        });
      } catch (err) {
        console.error('[VaultRepairModal] event listen failed:', err);
      }
    })();
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, []);

  const handleCancel = useCallback(async () => {
    try {
      await syncV2Commands.vaultRepairCancel();
    } catch (err) {
      console.error('[VaultRepairModal] cancel failed:', err);
    }
  }, []);

  // Phase 2 B4 (2026-05-24) — dry-run toggle. When checked, the apply
  // takes a safety snapshot but performs no destructive writes. Lets
  // the user preview "what WOULD happen" before committing — critical
  // for legacy vault migration confidence.
  const [dryRun, setDryRun] = useState(false);

  const runRepair = useCallback(async () => {
    setStage('applying');
    setErr(null);
    try {
      const out = await syncV2Commands.vaultRepairApply(report, {
        autoOnly: true,
        skipOrphanSweep: false,
        dryRun,
      });
      setOutcome(out);
      // Run verify only on real apply — dry-run wrote nothing.
      if (!dryRun) {
        try {
          const fails = await syncV2Commands.vaultRepairVerify();
          setVerifyFails(fails);
        } catch (verifyErr) {
          console.error('[VaultRepairModal] verify failed:', verifyErr);
        }
      }
      setStage('done');
    } catch (e) {
      console.error('[VaultRepairModal] apply failed:', e);
      setErr(String(e));
      setStage('error');
    }
  }, [report]);

  const c = report.counts;
  const total = c.legacyAttFolder
    + c.sketchExternalPath
    + c.sketchUnresolvedRef
    + c.wikilinkResolvable
    + c.wikilinkBroken
    + c.sharedRef
    + c.orphanBlob;

  const ko = language === 'ko';

  return createPortal(
    <div
      className="modal-overlay"
      onClick={() => onClose()}
    >
      <div
        className="modal-shell"
        style={{ width: 'min(560px, 92vw)', maxHeight: '86vh' }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <header style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '14px 16px 10px',
          borderBottom: '0.5px solid var(--sep-l)',
        }}>
          <Wrench size={16} strokeWidth={1.75} color="var(--tx-2)" />
          <span style={{ fontSize: 'var(--fs-14)', fontWeight: 600, color: 'var(--tx-1)' }}>
            {ko ? '보관소 정합성 검사' : 'Vault repair'}
          </span>
          <div style={{ flex: 1 }} />
          {/* Always-available close. Mid-apply: hides UI but backend
              continues. User can re-check via Settings → Dev Mode scan. */}
          <button
            type="button"
            onClick={onClose}
            aria-label={t('close', language)}
            title={stage === 'applying'
              ? (ko ? '백그라운드에서 계속 진행됩니다' : 'Continues in background')
              : t('close', language)}
            style={{
              width: 24, height: 24, padding: 0, border: 'none',
              background: 'transparent', cursor: 'pointer',
              color: 'var(--tx-3)', borderRadius: 6,
            }}
          >
            <XIcon size={14} />
          </button>
        </header>

        {stage === 'idle' && (
          <div style={{ padding: 16 }}>
            <p style={{ margin: '0 0 14px', color: 'var(--tx-2)', fontSize: 'var(--fs-13)' }}>
              {ko
                ? '다음 항목들이 현재 보관소 규칙과 다릅니다. 백업한 뒤 자동 정리할 수 있습니다.'
                : 'The following items deviate from the current vault rules. They will be backed up and auto-repaired.'}
            </p>
            <PatternList counts={c} ko={ko} />
            <div style={{
              marginTop: 12, padding: '8px 10px',
              background: 'var(--bg-elevated)', borderRadius: 6,
              fontSize: 'var(--fs-11)', color: 'var(--tx-3)',
            }}>
              {ko
                ? `백업 위치: .legacy/repair_<현재시각>/  ·  자동 수정 가능: ${total - c.wikilinkBroken}건 / 전체 ${total}건`
                : `Backup: .legacy/repair_<now>/  ·  Auto-fixable: ${total - c.wikilinkBroken} of ${total}`}
            </div>
            {/* Phase 2 B4 — dry-run option. Recommended for first-time
                repair on important vaults: snapshot is taken regardless,
                but no destructive writes happen. Safe preview. */}
            <label style={{
              display: 'flex', alignItems: 'center', gap: 8,
              marginTop: 10, padding: '8px 10px',
              background: 'var(--bg-elevated)', borderRadius: 6,
              fontSize: 'var(--fs-12)', color: 'var(--tx-2)', cursor: 'pointer',
            }}>
              <input
                type="checkbox"
                checked={dryRun}
                onChange={e => setDryRun(e.currentTarget.checked)}
                style={{ cursor: 'pointer' }}
              />
              <span>
                <strong>{ko ? '미리보기 모드 (dry-run)' : 'Dry-run preview'}</strong>
                {' — '}
                <span style={{ color: 'var(--tx-3)' }}>
                  {ko
                    ? '스냅샷만 만들고 실제 변경은 하지 않음. 중요 보관소 첫 적용 시 권장.'
                    : 'Snapshot only, no destructive changes. Recommended for first-time apply on important vaults.'}
                </span>
              </span>
            </label>
            <footer style={{
              marginTop: 16, display: 'flex', justifyContent: 'flex-end', gap: 6,
            }}>
              {!forceComplete && (
                <button
                  type="button"
                  onClick={onClose}
                  style={ghostBtn}
                >
                  {ko ? '이번엔 건너뛰기' : 'Skip for now'}
                </button>
              )}
              <button
                type="button"
                onClick={runRepair}
                disabled={total - c.wikilinkBroken === 0}
                style={primaryBtn}
              >
                {dryRun
                  ? (ko ? '미리보기 실행' : 'Run preview')
                  : (ko ? '복구 시작' : 'Run repair')}
              </button>
            </footer>
          </div>
        )}

        {stage === 'applying' && (
          <div style={{ padding: 20, color: 'var(--tx-2)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
              <div style={{
                width: 22, height: 22, flexShrink: 0,
                border: '2px solid var(--sep-l)',
                borderTopColor: liveProgress?.cancelRequested ? 'var(--c-orange, #f97316)' : 'var(--tx-1)',
                borderRadius: '50%',
                animation: 'spin 0.8s linear infinite',
              }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 'var(--fs-13)', color: 'var(--tx-1)', fontWeight: 500 }}>
                  {liveProgress?.cancelRequested
                    ? (ko ? '취소 중...' : 'Cancelling...')
                    : stageLabel(liveProgress?.stage, ko)}
                </div>
                <div style={{ fontSize: 'var(--fs-11)', color: 'var(--tx-3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {liveProgress?.message || (ko ? '시작 중...' : 'Starting...')}
                </div>
              </div>
              <div style={{ fontSize: 'var(--fs-11)', color: 'var(--tx-3)', flexShrink: 0 }}>
                {liveProgress ? Math.floor(liveProgress.elapsedMs / 1000) : 0}s
              </div>
            </div>
            {liveProgress && liveProgress.total > 0 && (
              <div style={{ marginBottom: 12 }}>
                <div style={{
                  width: '100%', height: 4, background: 'var(--bg-elevated)',
                  borderRadius: 2, overflow: 'hidden',
                }}>
                  <div style={{
                    width: `${Math.min(100, Math.floor((liveProgress.current / liveProgress.total) * 100))}%`,
                    height: '100%',
                    background: 'var(--tx-1)',
                    transition: 'width 0.25s ease',
                  }} />
                </div>
                <div style={{ fontSize: 'var(--fs-11)', color: 'var(--tx-3)', marginTop: 4, textAlign: 'right' }}>
                  {liveProgress.current} / {liveProgress.total}
                </div>
              </div>
            )}
            <p style={{
              margin: '0 0 10px', fontSize: 'var(--fs-11)', color: 'var(--tx-3)',
            }}>
              {ko
                ? '큰 동영상/PDF가 포함된 경우 파일당 수초가 걸릴 수 있습니다. "백그라운드로"를 누르면 모달이 닫혀도 작업은 계속되며, TitleBar에 진행 상태가 표시됩니다.'
                : 'Large media files can take seconds each. "Background" closes the modal but the repair continues — progress is shown in the TitleBar.'}
            </p>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6, marginTop: 12 }}>
              <button
                type="button"
                onClick={handleCancel}
                disabled={liveProgress?.cancelRequested}
                style={{
                  ...ghostBtn,
                  color: liveProgress?.cancelRequested ? 'var(--tx-3)' : 'var(--c-red, #ef4444)',
                  cursor: liveProgress?.cancelRequested ? 'wait' : 'pointer',
                }}
              >
                {liveProgress?.cancelRequested
                  ? (ko ? '취소 요청됨...' : 'Cancelling...')
                  : (ko ? '취소' : 'Cancel')}
              </button>
              <button type="button" onClick={onClose} style={ghostBtn}>
                {ko ? '백그라운드로 (닫기)' : 'Background (close)'}
              </button>
            </div>
          </div>
        )}

        {stage === 'done' && outcome && (
          <div style={{ padding: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
              <CheckCircle2 size={18} color={outcome.wasDryRun ? 'var(--c-blue, #3b82f6)' : 'var(--c-green, #34d399)'} />
              <strong style={{ color: 'var(--tx-1)' }}>
                {outcome.wasDryRun
                  ? (ko ? '미리보기 완료' : 'Dry-run complete')
                  : (ko ? '복구 완료' : 'Repair complete')}
              </strong>
              {outcome.wasDryRun && (
                <span style={{
                  marginLeft: 4, padding: '2px 8px',
                  background: 'color-mix(in srgb, var(--c-blue, #3b82f6) 18%, transparent)',
                  border: '0.5px solid color-mix(in srgb, var(--c-blue, #3b82f6) 50%, transparent)',
                  borderRadius: 10, fontSize: 'var(--fs-10)', color: 'var(--c-blue, #3b82f6)',
                  fontWeight: 600, letterSpacing: '0.04em',
                }}>
                  DRY RUN — NO CHANGES
                </span>
              )}
            </div>
            {outcome.wasDryRun && (
              <p style={{
                margin: '0 0 12px', fontSize: 'var(--fs-12)', color: 'var(--tx-2)',
                padding: '8px 10px', background: 'var(--bg-elevated)', borderRadius: 6,
              }}>
                {ko
                  ? `미리보기만 실행되었습니다. 스냅샷은 생성되었으나 실제 보관소는 변경되지 않았습니다. 결과가 만족스러우면 "미리보기 모드"를 해제하고 다시 실행하세요.`
                  : `Dry-run only — snapshot was created but no vault files were modified. If the preview looks good, uncheck "Dry-run preview" and run again.`}
              </p>
            )}
            {outcome.snapshotId && (
              <div style={{
                marginBottom: 10, padding: '6px 10px',
                background: 'var(--bg-elevated)', borderRadius: 6,
                fontSize: 'var(--fs-11)', color: 'var(--tx-3)',
                fontFamily: 'monospace',
              }}>
                {ko ? '안전 스냅샷: ' : 'Safety snapshot: '}
                <span style={{ color: 'var(--tx-2)' }}>{outcome.snapshotId}</span>
                {' — '}
                <span style={{ color: 'var(--tx-3)' }}>
                  {ko ? 'Settings → 개발자 모드에서 복원 가능' : 'restore via Settings → Dev Mode'}
                </span>
              </div>
            )}
            <OutcomeList outcome={outcome} ko={ko} />
            {verifyFails.length > 0 && (
              <div style={{
                marginTop: 12, padding: 10,
                background: 'color-mix(in srgb, var(--c-orange, #f97316) 12%, transparent)',
                border: '0.5px solid color-mix(in srgb, var(--c-orange, #f97316) 50%, transparent)',
                borderRadius: 6, fontSize: 'var(--fs-12)',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                  <AlertTriangle size={12} color="var(--c-orange, #f97316)" />
                  <strong>{ko ? '검증 경고' : 'Verification warnings'}</strong>
                </div>
                {verifyFails.slice(0, 5).map((v, i) => (
                  <div key={i} style={{ color: 'var(--tx-2)' }}>
                    <code style={{ fontSize: 'var(--fs-11)' }}>{v.kind}</code>: {v.detail}
                  </div>
                ))}
              </div>
            )}
            <div style={{
              marginTop: 12, padding: '8px 10px',
              background: 'var(--bg-elevated)', borderRadius: 6,
              fontSize: 'var(--fs-11)', color: 'var(--tx-3)',
              wordBreak: 'break-all',
            }}>
              {ko ? '백업: ' : 'Backup: '}<code>{outcome.backupDir}</code>
            </div>
            <footer style={{ marginTop: 16, display: 'flex', justifyContent: 'flex-end' }}>
              <button type="button" onClick={onClose} style={primaryBtn}>
                {ko ? '닫기' : 'Close'}
              </button>
            </footer>
          </div>
        )}

        {stage === 'error' && (
          <div style={{ padding: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
              <AlertTriangle size={18} color="var(--c-red, #ef4444)" />
              <strong style={{ color: 'var(--tx-1)' }}>
                {ko ? '복구 실패' : 'Repair failed'}
              </strong>
            </div>
            <pre style={{
              whiteSpace: 'pre-wrap', fontSize: 'var(--fs-12)',
              color: 'var(--tx-2)', background: 'var(--bg-elevated)',
              padding: 10, borderRadius: 6, maxHeight: 200, overflow: 'auto',
            }}>{err}</pre>
            <footer style={{ marginTop: 16, display: 'flex', justifyContent: 'flex-end' }}>
              <button type="button" onClick={onClose} style={primaryBtn}>
                {ko ? '닫기' : 'Close'}
              </button>
            </footer>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

function PatternList({ counts: c, ko }: { counts: VaultRepairReport['counts']; ko: boolean }) {
  const rows: Array<[string, number, string]> = [
    ['📁', c.legacyAttFolder, ko ? '레거시 _att/ 폴더' : 'Legacy _att/ folder'],
    ['🎨', c.sketchExternalPath, ko ? '외부 경로 sketch 노드' : 'External path sketch node'],
    ['🔗', c.sketchUnresolvedRef, ko ? 'ref 없는 sketch 첨부' : 'Sketch attachment without ref'],
    ['🔗', c.wikilinkResolvable, ko ? '자동 해결 가능 wikilink' : 'Auto-resolvable wikilink'],
    ['⚠️', c.wikilinkBroken, ko ? '깨진 wikilink (수동)' : 'Broken wikilink (manual)'],
    ['🔀', c.sharedRef, ko ? '다중 노트 공유 ref' : 'Multi-note shared ref'],
    ['🗑️', c.orphanBlob, ko ? '고아 blob' : 'Orphan blob'],
  ];
  return (
    <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
      {rows.map(([icon, count, label]) =>
        count > 0 ? (
          <li key={label} style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '4px 0', fontSize: 'var(--fs-12)', color: 'var(--tx-2)',
          }}>
            <span style={{ width: 16 }}>{icon}</span>
            <span style={{ flex: 1 }}>{label}</span>
            <strong style={{ color: 'var(--tx-1)' }}>{count}</strong>
          </li>
        ) : null,
      )}
    </ul>
  );
}

function OutcomeList({ outcome, ko }: { outcome: VaultRepairOutcome; ko: boolean }) {
  const rows: Array<[string, number]> = [
    [ko ? '레거시 첨부 마이그레이션' : 'Legacy attachments migrated', outcome.legacyAttMigrated],
    [ko ? '외부 경로 sketch import' : 'External path sketch imported', outcome.sketchExternalImported],
    [ko ? 'ref 없는 sketch import' : 'Unrefed sketch imported', outcome.sketchUnresolvedImported],
    [ko ? 'wikilink 해결' : 'Wikilinks resolved', outcome.wikilinkResolved],
    [ko ? '공유 ref 분리' : 'Shared refs split', outcome.sharedRefsSplit],
    [ko ? '고아 blob 정리' : 'Orphan blobs swept', outcome.orphanBlobsSwept],
  ];
  return (
    <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
      {rows.map(([label, count]) =>
        count > 0 ? (
          <li key={label} style={{
            display: 'flex', justifyContent: 'space-between',
            padding: '3px 0', fontSize: 'var(--fs-12)', color: 'var(--tx-2)',
          }}>
            <span>{label}</span><strong style={{ color: 'var(--tx-1)' }}>{count}</strong>
          </li>
        ) : null,
      )}
      {outcome.errors.length > 0 && (
        <li style={{ marginTop: 6, fontSize: 'var(--fs-11)', color: 'var(--c-red, #ef4444)' }}>
          {ko ? `오류 ${outcome.errors.length}건` : `${outcome.errors.length} errors`} —
          {' '}{outcome.errors.slice(0, 2).join('; ')}
          {outcome.errors.length > 2 ? '...' : ''}
        </li>
      )}
    </ul>
  );
}

function stageLabel(stage: VaultRepairProgress['stage'] | undefined, ko: boolean): string {
  switch (stage) {
    case 'backing_up':         return ko ? '백업 생성 중' : 'Creating backup';
    case 'p1_legacy_att':      return ko ? '레거시 _att/ 폴더 마이그레이션' : 'Migrating _att/ folders';
    case 'p2_p3_sketch':       return ko ? 'sketch 첨부 import' : 'Importing sketch attachments';
    case 'p4_wikilink':        return ko ? 'wikilink 해결' : 'Resolving wikilinks';
    case 'p6_split_shared_ref':return ko ? '공유 ref 분리' : 'Splitting shared refs';
    case 'p7_orphan_sweep':    return ko ? '고아 blob 정리' : 'Sweeping orphan blobs';
    case 'p8_purge_bogus_md':  return ko ? '.md 노이즈 정리' : 'Purging .md noise';
    case 'verifying':          return ko ? '검증 중' : 'Verifying';
    case 'completed':          return ko ? '완료' : 'Completed';
    case 'cancelled':          return ko ? '취소됨' : 'Cancelled';
    case 'failed':             return ko ? '실패' : 'Failed';
    case 'scanning':           return ko ? '스캔 중' : 'Scanning';
    case 'idle':
    default:                   return ko ? '대기 중' : 'Idle';
  }
}

const ghostBtn: React.CSSProperties = {
  height: 30, padding: '0 14px', border: 'none', background: 'transparent',
  color: 'var(--tx-2)', cursor: 'pointer', borderRadius: 6, fontSize: 'var(--fs-12)',
  fontFamily: 'var(--app-font, inherit)', fontWeight: 500,
};

const primaryBtn: React.CSSProperties = {
  height: 30, padding: '0 14px', border: 'none',
  background: 'var(--btn-primary-bg)', color: 'var(--btn-primary-fg)',
  cursor: 'pointer', borderRadius: 6, fontSize: 'var(--fs-12)',
  fontFamily: 'var(--app-font, inherit)', fontWeight: 500,
};
