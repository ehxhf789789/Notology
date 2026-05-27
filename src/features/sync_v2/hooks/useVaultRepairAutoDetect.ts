/**
 * useVaultRepairAutoDetect — 2026-05-24 (HanBin).
 *
 * Decides whether the VaultRepairModal should auto-open after a vault
 * opens, based on Q4 policy:
 *   • A vault is "legacy" the first time this device opens it, AND
 *     `vaultRepairScan` finds at least one auto-fixable inconsistency.
 *   • Already-repaired vaults never auto-prompt — the user accesses
 *     repair manually via Settings → Dev Mode.
 *
 * "First-time" is per-device, tracked in localStorage keyed by vaultPath.
 * The marker is set the moment the dialog is shown (whether the user
 * accepts or skips), so dismissals stick until the user re-runs from
 * Settings or the legacy state is fully cleared.
 *
 * Returns `{ report, ready, dismiss }` — the caller renders the modal
 * when `report` is non-null.
 */

import { useEffect, useState } from 'react';
import { useVaultPath } from '../../../core/stores/fileTreeStore';
import { syncV2Commands, type VaultRepairReport } from '../syncV2Commands';

const LS_KEY = (vaultPath: string) => `notology.vault_repair.shown.${vaultPath}`;

export function useVaultRepairAutoDetect() {
  const vaultPath = useVaultPath();
  const [report, setReport] = useState<VaultRepairReport | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!vaultPath) { setReport(null); setReady(false); return; }
    let cancelled = false;

    // Skip if we've already shown the dialog for this vault on this device.
    try {
      if (localStorage.getItem(LS_KEY(vaultPath)) === '1') {
        setReady(true);
        return;
      }
    } catch {
      // localStorage unavailable — fail open (scan runs every open).
    }

    // Delay 3s after vault open so the sync engine bootstrap +
    // auto-reconcile have a chance to settle first (they may resolve
    // some patterns and reduce the user-facing finding count).
    const timer = setTimeout(async () => {
      try {
        const r = await syncV2Commands.vaultRepairScan();
        if (cancelled) return;
        if (r.repairRecommended) {
          setReport(r);
        }
      } catch (err) {
        console.error('[useVaultRepairAutoDetect] scan failed:', err);
      } finally {
        if (!cancelled) setReady(true);
      }
    }, 3_000);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [vaultPath]);

  const dismiss = () => {
    if (vaultPath) {
      try { localStorage.setItem(LS_KEY(vaultPath), '1'); } catch {}
    }
    setReport(null);
  };

  return { report, ready, dismiss };
}
