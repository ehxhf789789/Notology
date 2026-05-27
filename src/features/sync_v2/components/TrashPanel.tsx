/**
 * Trash panel — browse, restore, and purge soft-deleted notes.
 *
 * Items land here when:
 *   - Another device deletes a note from NAS (Track H silent trash)
 *   - Future: user-initiated local deletion (not yet wired)
 *
 * Retention is 30 days; the "purge expired" button uses the backend
 * `sync_v2_purge_expired_trash` command to clear anything past the cutoff.
 * Per-entry purge is also available.
 *
 * 5.0.6q (2026-05-17, HanBin) — full rewrite for Settings UX consistency:
 *   • i18n — 25+ Korean-only strings routed through t()/tf() (en added)
 *   • inline-styled buttons → design-system <Button> primitive
 *   • inline-styled rows → .trash-panel-* CSS classes (theme tokens)
 *   • native window.confirm() → modalActions.showConfirmDelete
 *     (matches the template-delete + ConnectedDevices patterns)
 *   • lucide icons consistent with the rest of the chrome
 */
import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Trash2, RotateCcw, XCircle, X } from 'lucide-react';
import { useSyncV2Store } from '../stores/syncV2Store';
import { syncV2Commands } from '../syncV2Commands';
import { showToast } from '../../shared/Toast';
import { useLanguage } from '../../../core/stores/settingsStore';
import { t, tf } from '../../../core/utils/i18n';
import { modalActions } from '../../modals/stores/modalStore';
import { Button } from '../../../design-system/components';

interface TrashEntry {
  note_id: string;
  original_path: string;
  deleted_at: string;
  trash_filename: string;
}

const RETENTION_DAYS = 30;

/** Trash entries can carry Windows backslash paths depending on which
 *  code path saved them. Always render forward slashes so the list looks
 *  consistent. */
function displayPath(p: string): string {
  return p.replace(/\\/g, '/');
}

function daysLeft(deletedAt: string): number {
  const deleted = new Date(deletedAt).getTime();
  const cutoff = deleted + RETENTION_DAYS * 24 * 60 * 60 * 1000;
  return Math.max(0, Math.ceil((cutoff - Date.now()) / (24 * 60 * 60 * 1000)));
}

/** Is this trash entry a *user-visible* item? Anything under `.notology/`
 *  is vault metadata managed by the engine — hidden by default. */
function isUserVisible(originalPath: string): boolean {
  const normalized = originalPath.replace(/\\/g, '/');
  if (normalized.startsWith('.notology/')) return false;
  if (normalized.includes('/.notology/')) return false;
  return true;
}

export function TrashPanel() {
  const language = useLanguage();
  const open = useSyncV2Store(s => s.showTrashPanel);
  const [entries, setEntries] = useState<TrashEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null); // note_id being acted on
  const [showSystem, setShowSystem] = useState(false);

  const close = useCallback(() => {
    useSyncV2Store.setState({ showTrashPanel: false });
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const list = await syncV2Commands.listTrash();
      setEntries(list);
    } catch (e) {
      console.warn('[TrashPanel] list failed:', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) refresh();
  }, [open, refresh]);

  // Esc to close
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open, close]);

  if (!open) return null;

  // Partition: user-visible (notes / attachments) vs system (.notology/*)
  const userEntries = entries.filter(e => isUserVisible(e.original_path));
  const systemEntries = entries.filter(e => !isUserVisible(e.original_path));
  const visibleEntries = showSystem ? entries : userEntries;

  const handleRestore = async (entry: TrashEntry) => {
    if (busy) return;
    setBusy(entry.note_id);
    try {
      await syncV2Commands.restoreFromTrash(entry.note_id);
      showToast({
        type: 'success',
        title: t('trashRestoreDone', language),
        description: displayPath(entry.original_path),
      });
      await refresh();
    } catch (e: any) {
      showToast({ type: 'error', title: t('trashRestoreFailed', language), description: String(e) });
    } finally {
      setBusy(null);
    }
  };

  const handlePurge = (entry: TrashEntry) => {
    if (busy) return;
    const path = displayPath(entry.original_path);
    modalActions.showConfirmDelete(
      path,
      'file',
      async () => {
        setBusy(entry.note_id);
        try {
          await syncV2Commands.purgeTrashEntry(entry.note_id);
          showToast({ type: 'success', title: t('trashPurgeDone', language) });
          await refresh();
        } catch (e: any) {
          showToast({ type: 'error', title: t('trashPurgeFailed', language), description: String(e) });
        } finally {
          setBusy(null);
        }
      },
      undefined,
      { warningOverride: tf('trashPurgeConfirm', language, { path }) },
    );
  };

  const handlePurgeExpired = async () => {
    if (busy) return;
    setBusy('__expired__');
    try {
      const n = await syncV2Commands.purgeExpiredTrash();
      showToast({
        type: 'success',
        title: tf('trashPurgeExpiredDone', language, { count: String(n) }),
      });
      await refresh();
    } catch (e: any) {
      showToast({ type: 'error', title: t('trashPurgeFailed', language), description: String(e) });
    } finally {
      setBusy(null);
    }
  };

  return createPortal(
    <div className="nas-browser-overlay" onClick={close}>
      <div
        className="nas-browser-modal trash-panel-modal"
        onClick={e => e.stopPropagation()}
      >
        <div className="nas-browser-header">
          <div className="nas-browser-title trash-panel-title">
            <Trash2 size={15} />
            <span>{t('trashTitle', language)}</span>
            <span className="trash-panel-title__meta">
              {tf('trashItemsRetention', language, {
                count: String(userEntries.length),
                days: String(RETENTION_DAYS),
              })}
            </span>
          </div>
          <button
            className="nas-browser-close"
            onClick={close}
            aria-label={t('close', language)}
            title={t('close', language)}
          >
            <X size={16} />
          </button>
        </div>

        <div className="trash-panel-toolbar">
          {systemEntries.length > 0 && (
            <label
              className="trash-panel-system-toggle"
              title={t('trashShowSystemTooltip', language)}
            >
              <input
                type="checkbox"
                checked={showSystem}
                onChange={e => setShowSystem(e.target.checked)}
              />
              <span>
                {tf('trashShowSystem', language, { count: String(systemEntries.length) })}
              </span>
            </label>
          )}
          <div className="trash-panel-toolbar__spacer" />
          <Button
            variant="secondary"
            size="sm"
            onClick={handlePurgeExpired}
            disabled={busy !== null}
            loading={busy === '__expired__'}
            title={tf('trashPurgeExpiredTooltip', language, { days: String(RETENTION_DAYS) })}
          >
            {busy === '__expired__'
              ? t('trashPurgeExpiredWorking', language)
              : t('trashPurgeExpired', language)}
          </Button>
        </div>

        <div className="trash-panel-list">
          {loading ? (
            <div className="trash-panel-empty">{t('trashLoading', language)}</div>
          ) : visibleEntries.length === 0 ? (
            <div className="trash-panel-empty">
              {entries.length > 0 && !showSystem
                ? t('trashSystemHiddenHint', language)
                : t('trashEmpty', language)}
            </div>
          ) : (
            visibleEntries.map(e => {
              const left = daysLeft(e.deleted_at);
              const expiring = left <= 7;
              const isSystem = !isUserVisible(e.original_path);
              return (
                <div key={e.note_id} className="trash-panel-entry">
                  <div className="trash-panel-entry__body">
                    <div
                      className="trash-panel-entry__path-row"
                      title={displayPath(e.original_path)}
                    >
                      <span className="trash-panel-entry__path">
                        {displayPath(e.original_path)}
                      </span>
                      {isSystem && (
                        <span
                          className="trash-panel-entry__system-badge"
                          title={t('trashSystemBadgeTooltip', language)}
                        >
                          {t('trashSystemBadge', language)}
                        </span>
                      )}
                    </div>
                    <div className="trash-panel-entry__meta">
                      <span>
                        {t('trashDeletedAt', language)}: {new Date(e.deleted_at).toLocaleString()}
                      </span>
                      <span className={expiring ? 'trash-panel-entry__meta--expiring' : ''}>
                        {tf('trashAutoPurgeIn', language, { days: String(left) })}
                      </span>
                    </div>
                  </div>
                  <Button
                    variant="secondary"
                    size="sm"
                    leftIcon={<RotateCcw size={12} />}
                    onClick={() => handleRestore(e)}
                    disabled={busy !== null}
                    loading={busy === e.note_id}
                    title={t('trashRestoreTooltip', language)}
                  >
                    {t('trashRestore', language)}
                  </Button>
                  <Button
                    variant="danger"
                    size="sm"
                    leftIcon={<XCircle size={12} />}
                    onClick={() => handlePurge(e)}
                    disabled={busy !== null}
                    title={t('trashPurgeTooltip', language)}
                  >
                    {t('trashPurge', language)}
                  </Button>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
