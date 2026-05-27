/**
 * PART 7 (HanBin 2026-05-14) — modal-driven migration UX. Replaces the
 * silent auto-run that previously hid the operation behind a console.log.
 *
 * States rendered:
 *   • prompt  — explain the upgrade, show note count, Upgrade / Skip / Don't ask
 *   • running — progress bar + "{completed}/{total} notes" counter
 *   • done    — success summary, failed-count chip if any, Close
 *   • error   — error message, Retry, Close
 *
 * 5.0.8a (2026-05-17, HanBin) — Dialog primitive wrapper applied (per plan
 * delta: Dialog wrapper only, internal structure preserved). All Korean
 * strings routed through i18n. `forcedAction` during `running` so the user
 * can't cancel mid-migration via backdrop click or ESC.
 */

import { useMigrationStore } from '../stores/migrationStore';
import { Dialog } from '../../../design-system/components';
import { t, tf } from '../../../core/utils/i18n';
import { useLanguage } from '../../../core/stores/settingsStore';

export default function MigrationModal() {
  const language = useLanguage();
  const phase = useMigrationStore((s) => s.phase);
  const preReport = useMigrationStore((s) => s.preReport);
  const completed = useMigrationStore((s) => s.completed);
  const total = useMigrationStore((s) => s.total);
  const finalState = useMigrationStore((s) => s.finalState);
  const errorMessage = useMigrationStore((s) => s.errorMessage);
  const runUpgrade = useMigrationStore((s) => s.runUpgrade);
  const skip = useMigrationStore((s) => s.skip);
  const reset = useMigrationStore((s) => s.reset);

  if (phase === 'idle') return null;

  const percent = total > 0 ? Math.min(100, Math.round((completed / total) * 100)) : 0;

  const title =
    phase === 'prompt'  ? t('migTitlePrompt',  language) :
    phase === 'running' ? t('migTitleRunning', language) :
    phase === 'done'    ? t('migTitleDone',    language) :
                          t('migTitleError',   language);

  // Backdrop click / ESC behavior: prompt closes (= skip-for-session),
  // every other phase is forced (running can't be aborted; done/error
  // require an explicit Close click).
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
            {t('migBodyPrompt', language)}<br />
            <strong>{tf('migBodyPromptCount', language, { count: preReport.total_notes })}</strong>
          </p>
          <p className="migration-modal-hint">{t('migHintBackup', language)}</p>
          <div className="migration-modal-actions">
            <button className="migration-modal-btn migration-modal-btn-secondary" onClick={() => skip(true)}>
              {t('migBtnSkipForever', language)}
            </button>
            <button className="migration-modal-btn migration-modal-btn-secondary" onClick={() => skip(false)}>
              {t('migBtnSkipNow', language)}
            </button>
            <button className="migration-modal-btn migration-modal-btn-primary" onClick={() => void runUpgrade()} autoFocus>
              {t('migBtnUpgrade', language)}
            </button>
          </div>
        </>
      )}

      {phase === 'running' && (
        <>
          <p className="migration-modal-body">{t('migBodyRunning', language)}</p>
          <div className="migration-progress-bar-wrapper" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
            <div className="migration-progress-bar-fill" style={{ width: `${percent}%` }} />
          </div>
          <p className="migration-progress-label">
            <span className="migration-progress-count">{completed}</span>
            <span className="migration-progress-sep"> / </span>
            <span className="migration-progress-total">{total}</span>
            <span className="migration-progress-percent"> ({percent}%)</span>
          </p>
        </>
      )}

      {phase === 'done' && finalState && (
        <>
          <p className="migration-modal-body">
            <strong>{tf('migBodyDone', language, { count: finalState.migrated_notes })}</strong>
            {finalState.failed_notes.length > 0 && (
              <>
                {' '}
                <span className="migration-modal-warn">
                  {tf('migBodyFailed', language, { count: finalState.failed_notes.length })}
                </span>
              </>
            )}
          </p>
          {finalState.failed_notes.length > 0 && (
            <details className="migration-modal-failures">
              <summary>{t('migFailedSummary', language)}</summary>
              <ul>
                {finalState.failed_notes.slice(0, 10).map((f, i) => (
                  <li key={i}><code>{f.path}</code> — {f.reason}</li>
                ))}
                {finalState.failed_notes.length > 10 && (
                  <li>{tf('migFailedMore', language, { count: finalState.failed_notes.length - 10 })}</li>
                )}
              </ul>
            </details>
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
          <p className="migration-modal-body migration-modal-error-text">{t('migBodyError', language)}</p>
          {errorMessage && <pre className="migration-modal-error-detail">{errorMessage}</pre>}
          <div className="migration-modal-actions">
            <button className="migration-modal-btn migration-modal-btn-secondary" onClick={reset}>
              {t('migBtnClose', language)}
            </button>
            <button className="migration-modal-btn migration-modal-btn-primary" onClick={() => void runUpgrade()} autoFocus>
              {t('migBtnRetry', language)}
            </button>
          </div>
        </>
      )}
    </Dialog>
  );
}
