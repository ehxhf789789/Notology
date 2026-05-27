/**
 * Stage 4.6.2 (HanBin 2026-05-14) — Faststart bulk migration modal.
 *
 * Mirror of `migration/components/MigrationModal.tsx`. States:
 *   • prompt  — explain re-mux + show candidate count + Skip / Later / Run
 *   • running — progress bar + "{done}/{total}" counter
 *   • done    — counts of converted / already optimized / failed + open
 *                backup folder action
 *   • error   — message + Retry / Close
 *
 * Visual classes piggyback on `.migration-modal-*` so the existing CSS
 * (animations, button styles) is shared.
 *
 * 5.0.8a (2026-05-17, HanBin) — Dialog primitive wrapper applied (internal
 * structure preserved per plan delta), all Korean strings routed through
 * i18n, `forcedAction` while running.
 */

import { useFaststartMigrationStore } from '../stores/faststartMigrationStore';
import { utilCommands } from '../../../core/services/tauriCommands';
import { Dialog, PathDisplay } from '../../../design-system/components';
import { t, tf } from '../../../core/utils/i18n';
import { useLanguage } from '../../../core/stores/settingsStore';

function formatMb(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb < 1) return `${(bytes / 1024).toFixed(0)} KB`;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

export default function FaststartMigrationModal() {
  const language = useLanguage();
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

  const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;

  const title =
    phase === 'prompt'  ? t('fsmigTitlePrompt',  language) :
    phase === 'running' ? t('fsmigTitleRunning', language) :
    phase === 'done'    ? t('fsmigTitleDone',    language) :
                          t('fsmigTitleError',   language);

  const handleClose = () => {
    if (phase === 'prompt') skip(false);
    else if (phase === 'done' || phase === 'error') reset();
  };

  return (
    <Dialog
      open={true}
      onClose={handleClose}
      title={title}
      size="md"
      forcedAction={phase === 'running'}
      hideCloseButton={phase === 'running'}
      className="migration-modal"
    >
      {phase === 'prompt' && preReport && (
        <>
          <p className="migration-modal-body">
            <strong>{tf('fsmigBodyPrompt', language, { count: preReport.candidates })}</strong>
            <br />
            {t('fsmigBodySubtle', language)}
          </p>
          <p className="migration-modal-hint">
            {tf('fsmigHintDisk', language, { size: formatMb(preReport.estimated_disk_required) })}
            <br />
            {t('fsmigHintBackup', language)}
          </p>
          <div className="migration-modal-actions">
            <button className="migration-modal-btn migration-modal-btn-secondary" onClick={() => skip(true)}>
              {t('migBtnSkipForever', language)}
            </button>
            <button className="migration-modal-btn migration-modal-btn-secondary" onClick={() => skip(false)}>
              {t('migBtnSkipNow', language)}
            </button>
            <button className="migration-modal-btn migration-modal-btn-primary" onClick={() => void runConversion()} autoFocus>
              {t('fsmigRunNow', language)}
            </button>
          </div>
        </>
      )}

      {phase === 'running' && (
        <>
          <p className="migration-modal-body">{t('fsmigBodyRunning', language)}</p>
          <div className="migration-progress-bar-wrapper" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
            <div className="migration-progress-bar-fill" style={{ width: `${percent}%` }} />
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
            <strong>{tf('fsmigBodyDone', language, { count: finalState.converted })}</strong>
            {finalState.skipped_already_faststart > 0 && (
              <>
                {' '}
                <span className="migration-modal-hint">
                  {tf('fsmigBodyAlreadyOptimized', language, { count: finalState.skipped_already_faststart })}
                </span>
              </>
            )}
            {finalState.failed.length > 0 && (
              <>
                {' '}
                <span className="migration-modal-warn">
                  {tf('fsmigBodyFailed', language, { count: finalState.failed.length })}
                </span>
              </>
            )}
          </p>
          {finalState.failed.length > 0 && (
            <details className="migration-modal-failures">
              <summary>{t('fsmigFailedSummary', language)}</summary>
              <ul>
                {finalState.failed.slice(0, 10).map((id, i) => (
                  <li key={i}><code>{id}</code></li>
                ))}
                {finalState.failed.length > 10 && (
                  <li>{tf('migFailedMore', language, { count: finalState.failed.length - 10 })}</li>
                )}
              </ul>
            </details>
          )}
          {finalState.backup_dir && (
            <div className="migration-modal-backup">
              <div className="migration-modal-backup-label">{t('fsmigBackupLabel', language)}</div>
              {/* 5.0.8d — replaces inline `.migration-modal-backup-path` div
                   + separate "open folder" button with PathDisplay primitive. */}
              <PathDisplay
                path={finalState.backup_dir}
                onReveal={(p) => void utilCommands.revealInExplorer(p).catch(() => {})}
                revealLabel={t('fsmigOpenBackupBtn', language)}
              />
            </div>
          )}
          <div className="migration-modal-actions">
            <button className="migration-modal-btn migration-modal-btn-primary" onClick={reset} autoFocus>
              {t('migBtnClose', language)}
            </button>
          </div>
        </>
      )}

      {phase === 'error' && (
        <>
          <p className="migration-modal-body migration-modal-error-text">{t('fsmigBodyError', language)}</p>
          {errorMessage && <pre className="migration-modal-error-detail">{errorMessage}</pre>}
          <div className="migration-modal-actions">
            <button className="migration-modal-btn migration-modal-btn-secondary" onClick={reset}>
              {t('migBtnClose', language)}
            </button>
            <button className="migration-modal-btn migration-modal-btn-primary" onClick={() => void runConversion()} autoFocus>
              {t('migBtnRetry', language)}
            </button>
          </div>
        </>
      )}
    </Dialog>
  );
}
