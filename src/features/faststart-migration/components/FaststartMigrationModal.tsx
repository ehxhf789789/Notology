/**
 * Stage 4.6.2 (HanBin 2026-05-14) — Faststart bulk migration modal.
 *
 * Mirror of `migration/components/MigrationModal.tsx`. States:
 *   • prompt  — "X 개의 영상 파일이 변환됩니다 / 지금 / 나중에 / 다시 묻지 않기"
 *   • running — progress bar + "{done}/{total}" counter
 *   • done    — "Y 개 변환, Z 개 이미 최적화됨, W 개 실패", Close
 *   • error   — message + Retry / Close
 *
 * Visual classes piggyback on `.migration-modal-*` so the existing CSS
 * (animations, backdrop, button styles) is shared. No new CSS file
 * needed — these classes are defined in App.css.
 */

import { useFaststartMigrationStore } from '../stores/faststartMigrationStore';
import { utilCommands } from '../../../core/services/tauriCommands';

function formatMb(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb < 1) return `${(bytes / 1024).toFixed(0)} KB`;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

export default function FaststartMigrationModal() {
  const phase = useFaststartMigrationStore((s) => s.phase);
  const preReport = useFaststartMigrationStore((s) => s.preReport);
  const done = useFaststartMigrationStore((s) => s.done);
  const total = useFaststartMigrationStore((s) => s.total);
  const finalState = useFaststartMigrationStore((s) => s.finalState);
  const errorMessage = useFaststartMigrationStore((s) => s.errorMessage);
  const runConversion = useFaststartMigrationStore((s) => s.runConversion);
  const skip = useFaststartMigrationStore((s) => s.skip);
  const reset = useFaststartMigrationStore((s) => s.reset);

  if (phase === 'idle') return null;

  const percent =
    total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;

  return (
    <div
      className="migration-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="faststart-modal-title"
      onClick={(e) => {
        if (e.target !== e.currentTarget) return;
        if (phase === 'prompt') skip(false);
      }}
    >
      <div className="migration-modal">
        <h2 id="faststart-modal-title" className="migration-modal-title">
          {phase === 'prompt' && '기존 영상 파일 최적화'}
          {phase === 'running' && '영상 파일 변환 중'}
          {phase === 'done' && '영상 파일 최적화 완료'}
          {phase === 'error' && '영상 파일 최적화 실패'}
        </h2>

        {phase === 'prompt' && preReport && (
          <>
            <p className="migration-modal-body">
              <strong>{preReport.candidates}</strong>개의 영상 파일이
              재생/탐색 호환성 향상을 위해 변환됩니다.
              <br />
              화질이나 길이 변경 없이 메타데이터 위치만 재배치됩니다.
            </p>
            <p className="migration-modal-hint">
              예상 처리 용량: {formatMb(preReport.estimated_disk_required)}
              <br />
              변환 전 데이터는{' '}
              <code>.notology/attachments.pre-faststart-migration</code>{' '}
              폴더에 자동 백업됩니다.
            </p>
            <div className="migration-modal-actions">
              <button
                className="migration-modal-btn migration-modal-btn-secondary"
                onClick={() => skip(true)}
              >
                다시 묻지 않기
              </button>
              <button
                className="migration-modal-btn migration-modal-btn-secondary"
                onClick={() => skip(false)}
              >
                나중에
              </button>
              <button
                className="migration-modal-btn migration-modal-btn-primary"
                onClick={() => void runConversion()}
                autoFocus
              >
                지금 변환
              </button>
            </div>
          </>
        )}

        {phase === 'running' && (
          <>
            <p className="migration-modal-body">
              영상 파일을 변환하고 있습니다. 창을 닫지 마세요.
            </p>
            <div
              className="migration-progress-bar-wrapper"
              role="progressbar"
              aria-valuenow={percent}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div
                className="migration-progress-bar-fill"
                style={{ width: `${percent}%` }}
              />
            </div>
            <p className="migration-progress-label">
              <span className="migration-progress-count">{done}</span>
              <span className="migration-progress-sep"> / </span>
              <span className="migration-progress-total">{total}</span>
              <span className="migration-progress-percent"> ({percent}%)</span>
            </p>
          </>
        )}

        {phase === 'done' && finalState && (
          <>
            <p className="migration-modal-body">
              <strong>{finalState.converted}</strong>개 영상 변환 완료.
              {finalState.skipped_already_faststart > 0 && (
                <>
                  {' '}
                  <span className="migration-modal-hint">
                    ({finalState.skipped_already_faststart}개는 이미 최적화됨)
                  </span>
                </>
              )}
              {finalState.failed.length > 0 && (
                <>
                  {' '}
                  <span className="migration-modal-warn">
                    {finalState.failed.length}개 실패
                  </span>
                </>
              )}
            </p>
            {finalState.failed.length > 0 && (
              <details className="migration-modal-failures">
                <summary>실패한 파일 보기</summary>
                <ul>
                  {finalState.failed.slice(0, 10).map((id, i) => (
                    <li key={i}>
                      <code>{id}</code>
                    </li>
                  ))}
                  {finalState.failed.length > 10 && (
                    <li>… 그리고 {finalState.failed.length - 10}개 더</li>
                  )}
                </ul>
              </details>
            )}
            {finalState.backup_dir && (
              <div className="migration-modal-backup">
                <div className="migration-modal-backup-label">
                  변환 전 데이터 백업
                </div>
                <div
                  className="migration-modal-backup-path"
                  title={finalState.backup_dir}
                >
                  {finalState.backup_dir}
                </div>
              </div>
            )}
            <div className="migration-modal-actions">
              {finalState.backup_dir && (
                <button
                  className="migration-modal-btn migration-modal-btn-secondary"
                  onClick={() =>
                    void utilCommands
                      .revealInExplorer(finalState.backup_dir!)
                      .catch(() => {})
                  }
                >
                  백업 폴더 열기
                </button>
              )}
              <button
                className="migration-modal-btn migration-modal-btn-primary"
                onClick={reset}
                autoFocus
              >
                닫기
              </button>
            </div>
          </>
        )}

        {phase === 'error' && (
          <>
            <p className="migration-modal-body migration-modal-error-text">
              영상 파일 최적화 중 오류가 발생했습니다.
            </p>
            {errorMessage && (
              <pre className="migration-modal-error-detail">{errorMessage}</pre>
            )}
            <div className="migration-modal-actions">
              <button
                className="migration-modal-btn migration-modal-btn-secondary"
                onClick={reset}
              >
                닫기
              </button>
              <button
                className="migration-modal-btn migration-modal-btn-primary"
                onClick={() => void runConversion()}
                autoFocus
              >
                재시도
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
