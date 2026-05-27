/**
 * Round 2 R5 v5 (HanBin 2026-05-23) — Permanent sync failure banner.
 *
 * Renders a non-blocking notification when the sync queue has dropped
 * any entries after their max-retry budget (5 attempts). Without this
 * UI the user would not know that NAS uploads silently failed and their
 * files might exist locally but not on the remote.
 *
 * Behaviour:
 *   • Hidden when `failed.length === 0`.
 *   • Shows count + first item summary + retry-all / dismiss actions.
 *   • Mounted at the app root (both App.tsx and HoverWindowApp.tsx) so it
 *     surfaces regardless of which window has focus.
 *   • Vault-scoped implicitly — the store mirrors the active engine's
 *     queue, which is one-per-vault.
 */
import { useMemo } from 'react';
import { AlertTriangle, RefreshCw, X } from 'lucide-react';
import { useAttachmentSyncStore, attachmentSyncActions } from '../stores/attachmentSyncStore';
import { useSettingsStore } from '../../../core/stores/settingsStore';
import { t, tf } from '../../../core/utils/i18n';

export function SyncFailureBanner() {
  // Defensive guards (HanBin 2026-05-23): the store might be in any state
  // during early mount or after HMR — falling back to safe defaults rather
  // than throwing keeps a glitch here from blank-screening the parent app.
  const failed = useAttachmentSyncStore(s => s.failed) ?? [];
  const language = useSettingsStore(s => s.language) ?? 'ko';

  const summary = useMemo(() => {
    if (!Array.isArray(failed) || failed.length === 0) return null;
    const first = failed[0];
    if (!first || typeof first.targetPath !== 'string') return null;
    const base = first.targetPath.split(/[/\\]/).pop() || first.targetPath;
    return {
      count: failed.length,
      firstName: base,
      firstError: typeof first.lastError === 'string' ? first.lastError : '',
    };
  }, [failed]);

  if (!summary) return null;

  return (
    <div className="sync-failure-banner" role="alert">
      <div className="sync-failure-banner__icon">
        <AlertTriangle size={16} strokeWidth={2} aria-hidden="true" />
      </div>
      <div className="sync-failure-banner__body">
        <div className="sync-failure-banner__title">
          {tf('syncFailureCount', language, { count: summary.count })}
        </div>
        <div className="sync-failure-banner__detail" title={summary.firstError}>
          {summary.firstName}
          {summary.count > 1 && ` (+${summary.count - 1})`}
        </div>
      </div>
      <div className="sync-failure-banner__actions">
        <button
          type="button"
          className="sync-failure-banner__btn sync-failure-banner__btn--retry"
          onClick={() => void attachmentSyncActions.retryAllFailed()}
          title={t('syncRetryAll', language)}
        >
          <RefreshCw size={12} strokeWidth={2} aria-hidden="true" />
          <span>{t('syncRetryAll', language)}</span>
        </button>
        <button
          type="button"
          className="sync-failure-banner__btn sync-failure-banner__btn--dismiss"
          onClick={() => void attachmentSyncActions.clearAllFailed()}
          title={t('dismiss', language)}
          aria-label={t('dismiss', language)}
        >
          <X size={12} strokeWidth={2} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

export default SyncFailureBanner;
