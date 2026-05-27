// Modal listing all notes with unresolved conflicts.
//
// PART 8 polish (HanBin 2026-05-14):
//   • Sort oldest-first (most urgent surfaces top).
//   • Per-row branch-count badge for at-a-glance severity.
//   • Batch "Resolve all with Smart Merge" CTA when > 1 conflict pending —
//     attempts smart merge for each note; falls back to manual picker if
//     merge isn't possible.
//
// 5.0.8b (2026-05-17, HanBin) — Dialog primitive wrapper (gets backdrop,
// focus trap, Esc-to-close for free; drops the bespoke .modal-overlay +
// .sync-v2-close-btn). Korean strings moved to i18n; toast text + branch
// count label routed through t()/tf().

import { useEffect, useMemo, useState } from 'react';
import { useSyncV2Store } from '../stores/syncV2Store';
import { useLanguage } from '../../../core/stores/settingsStore';
import { syncV2Commands } from '../syncV2Commands';
import { showToast } from '../../shared/Toast';
import { Dialog } from '../../../design-system/components';
import { t, tf } from '../../../core/utils/i18n';

export function ConflictListModal() {
  const language = useLanguage();
  const show = useSyncV2Store(s => s.showConflictList);
  const conflicts = useSyncV2Store(s => s.conflicts);
  const close = useSyncV2Store(s => s.closeConflictList);
  const openBranchPicker = useSyncV2Store(s => s.openBranchPicker);
  const refreshConflicts = useSyncV2Store(s => s.refreshConflicts);

  const [batchRunning, setBatchRunning] = useState(false);

  // Refresh on open
  useEffect(() => {
    if (show) refreshConflicts();
  }, [show, refreshConflicts]);

  // Oldest first — most-urgent surface order. Tie-break by note_id so the
  // list is stable across re-renders.
  const sortedConflicts = useMemo(() => {
    return [...conflicts].sort((a, b) => {
      const da = Date.parse(a.earliest_detected) || 0;
      const db = Date.parse(b.earliest_detected) || 0;
      if (da !== db) return da - db;
      return a.note_id.localeCompare(b.note_id);
    });
  }, [conflicts]);

  const handleResolveAll = async () => {
    if (batchRunning || sortedConflicts.length === 0) return;
    setBatchRunning(true);
    let merged = 0;
    const unresolvable: string[] = [];
    for (const c of sortedConflicts) {
      // Smart-merge first branch against the others — backend chooses the
      // best path. If merge isn't possible it returns a non-Merged status.
      const headBranch = c.branches[0];
      if (!headBranch) continue;
      try {
        const result = await syncV2Commands.smartMergeBranch(c.note_id, headBranch.branch_id);
        if (result && typeof result === 'object' && 'status' in result && (result as { status: string }).status === 'Merged') {
          merged++;
        } else {
          unresolvable.push(c.note_id);
        }
      } catch (e) {
        console.warn('[ConflictListModal] smart-merge failed for', c.note_id, e);
        unresolvable.push(c.note_id);
      }
    }
    setBatchRunning(false);
    await refreshConflicts();
    showToast({
      type: merged > 0 ? 'success' : 'info',
      title: tf('conflictListBatchDoneMerged', language, { count: merged }),
      description: unresolvable.length > 0
        ? tf('conflictListBatchDoneManual', language, { count: unresolvable.length })
        : undefined,
    });
  };

  return (
    <Dialog
      open={show}
      onClose={close}
      title={t('conflictListTitle', language)}
      size="md"
      className="sync-v2-conflict-modal"
    >
      {sortedConflicts.length === 0 ? (
        <div className="sync-v2-conflict-empty">{t('conflictListEmpty', language)}</div>
      ) : (
        <>
          <div className="sync-v2-conflict-list">
            {sortedConflicts.map((c, idx) => {
              const detected = new Date(c.earliest_detected);
              const detectedLabel = isNaN(detected.getTime())
                ? '—'
                : detected.toLocaleString(language === 'ko' ? 'ko-KR' : undefined, {
                    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
                  });
              return (
                <button
                  key={c.note_id}
                  className={`sync-v2-conflict-item${idx === 0 ? ' sync-v2-conflict-item-urgent' : ''}`}
                  onClick={() => openBranchPicker(c.note_id)}
                >
                  <span className="sync-v2-conflict-note-id">{c.note_id}</span>
                  <span className="sync-v2-conflict-branch-count">
                    {c.branches.length} {t('conflictListBranches', language)}
                  </span>
                  <span className="sync-v2-conflict-time">{detectedLabel}</span>
                </button>
              );
            })}
          </div>
          {sortedConflicts.length > 1 && (
            <div className="sync-v2-conflict-batch-bar">
              <button
                className="sync-v2-conflict-batch-btn"
                onClick={() => void handleResolveAll()}
                disabled={batchRunning}
              >
                {batchRunning
                  ? t('conflictListBatchMerging', language)
                  : tf('conflictListBatchCta', language, { count: sortedConflicts.length })}
              </button>
            </div>
          )}
        </>
      )}
    </Dialog>
  );
}
