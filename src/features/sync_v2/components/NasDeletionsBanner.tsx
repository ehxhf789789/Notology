/**
 * Track H — bulk NAS-deletion confirmation banner.
 *
 * Shown when a sync cycle detects ≥ NAS_DELETION_BULK_THRESHOLD refs
 * that were deleted from NAS by another device. The user is asked to
 * confirm Trash (apply deletion locally) or Reject (re-push local
 * copies back to NAS).
 *
 * For deletion counts below the threshold the engine silently trashes
 * the notes and surfaces a toast; this banner is the "are you sure?"
 * surface for the higher-impact case only.
 *
 * 5.0.6r (2026-05-17, HanBin) — rewrite for Settings UX consistency:
 *   • Korean-only strings → t()/tf() with en added
 *   • inline-styled buttons → design-system <Button> (secondary/danger)
 *   • inline-styled container/list → .nas-del-banner-* CSS classes
 *     using theme tokens (dark/light parity automatic)
 *   • hardcoded `#fff` on danger button gone via Button primitive
 */
import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { useSyncV2Store } from '../stores/syncV2Store';
import { syncV2Commands } from '../syncV2Commands';
import { showToast } from '../../shared/Toast';
import { useLanguage } from '../../../core/stores/settingsStore';
import { t, tf } from '../../../core/utils/i18n';
import { Button } from '../../../design-system/components';

interface PendingItem {
  noteId: string;
  relativePath: string;
  headHash: string;
  detectedAt: string;
}

export function NasDeletionsBanner() {
  const language = useLanguage();
  const pendingCount = useSyncV2Store(s => s.pendingNasDeletionCount);
  const [expanded, setExpanded] = useState(false);
  const [items, setItems] = useState<PendingItem[]>([]);
  const [busy, setBusy] = useState(false);

  // Fetch the full list when the banner is expanded.
  useEffect(() => {
    if (!expanded || items.length > 0) return;
    syncV2Commands
      .listPendingNasDeletions()
      .then(list => setItems(list))
      .catch(e => console.warn('[NasDeletionsBanner] list failed:', e));
  }, [expanded, items.length]);

  if (pendingCount === 0) return null;

  const apply = async (action: 'trash' | 'reject') => {
    if (busy) return;
    setBusy(true);
    try {
      const fn = action === 'trash'
        ? syncV2Commands.confirmNasDeletionsTrash
        : syncV2Commands.confirmNasDeletionsReject;
      const count = await fn();
      showToast({
        type: 'success',
        title: action === 'trash'
          ? tf('nasDelBannerTrashDone', language, { count: String(count) })
          : tf('nasDelBannerRestoreDone', language, { count: String(count) }),
      });
      // Reset banner state — pending count will refresh on next sync.
      useSyncV2Store.setState({ pendingNasDeletionCount: 0 });
      setItems([]);
      setExpanded(false);
    } catch (e: any) {
      showToast({
        type: 'error',
        title: t('nasDelBannerFailed', language),
        description: String(e),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div role="alert" className="nas-del-banner">
      <div className="nas-del-banner__row">
        <AlertTriangle size={14} className="nas-del-banner__icon" />
        <span className="nas-del-banner__msg">
          {tf('nasDelBannerMsg', language, { count: String(pendingCount) })}
        </span>
        <button
          type="button"
          className="nas-del-banner__toggle"
          onClick={() => setExpanded(prev => !prev)}
        >
          {expanded ? t('nasDelBannerHideList', language) : t('nasDelBannerShowList', language)}
        </button>
      </div>

      {expanded && items.length > 0 && (
        <ul className="nas-del-banner__list">
          {items.map(it => (
            <li key={it.noteId}>{it.relativePath}</li>
          ))}
        </ul>
      )}

      <div className="nas-del-banner__actions">
        <Button
          variant="secondary"
          size="sm"
          onClick={() => apply('reject')}
          disabled={busy}
          title={t('nasDelBannerRejectTooltip', language)}
        >
          {t('nasDelBannerReject', language)}
        </Button>
        <Button
          variant="danger"
          size="sm"
          onClick={() => apply('trash')}
          disabled={busy}
          loading={busy}
        >
          {busy ? t('nasDelBannerWorking', language) : t('nasDelBannerTrash', language)}
        </Button>
      </div>
    </div>
  );
}
