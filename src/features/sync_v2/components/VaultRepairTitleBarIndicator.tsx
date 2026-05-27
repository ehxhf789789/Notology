/**
 * VaultRepairTitleBarIndicator — 2026-05-24 (HanBin).
 *
 * Small pill in the TitleBar that shows the vault_repair progress when
 * an apply is running in the background. Hidden when the backend is
 * idle. Click → re-opens the full VaultRepairModal so the user can
 * monitor or cancel a backgrounded operation.
 *
 * Subscribes to the same `vault-repair:progress` Tauri event the modal
 * uses, plus a one-time poll on mount so it picks up an apply that
 * started before this component existed.
 *
 * `vault-repair:done` / `vault-repair:error` events emit a toast so
 * the user gets closure even when the modal is closed.
 */

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { listen } from '@tauri-apps/api/event';
import { Wrench, X as XIcon } from 'lucide-react';
import {
  syncV2Commands,
  type VaultRepairProgress,
  type VaultRepairOutcome,
} from '../syncV2Commands';
import { useSettingsStore } from '../../../core/stores/settingsStore';

export function VaultRepairTitleBarIndicator() {
  const language = useSettingsStore((s) => s.language);
  const [progress, setProgress] = useState<VaultRepairProgress | null>(null);
  const [toast, setToast] = useState<{
    kind: 'done' | 'error';
    text: string;
    at: number;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const unlistenFns: Array<() => void> = [];
    (async () => {
      try {
        const initial = await syncV2Commands.vaultRepairStatus();
        if (!cancelled) setProgress(initial);
      } catch {}
      try {
        unlistenFns.push(await listen<VaultRepairProgress>('vault-repair:progress', (e) => {
          setProgress(e.payload);
        }));
        unlistenFns.push(await listen<VaultRepairOutcome>('vault-repair:done', (e) => {
          const o = e.payload;
          const ko = language === 'ko';
          const totalFixed = o.legacyAttMigrated + o.sketchExternalImported + o.sketchUnresolvedImported
            + o.wikilinkResolved + o.sharedRefsSplit + o.orphanBlobsSwept;
          const text = ko
            ? `보관소 복구 완료 — ${totalFixed}건 처리${o.errors.length > 0 ? `, 오류 ${o.errors.length}건` : ''}`
            : `Vault repair complete — ${totalFixed} items${o.errors.length > 0 ? `, ${o.errors.length} errors` : ''}`;
          setToast({ kind: 'done', text, at: Date.now() });
        }));
        unlistenFns.push(await listen<string>('vault-repair:error', (e) => {
          const ko = language === 'ko';
          setToast({
            kind: 'error',
            text: ko ? `보관소 복구 실패: ${e.payload}` : `Vault repair failed: ${e.payload}`,
            at: Date.now(),
          });
        }));
      } catch (err) {
        console.error('[VaultRepairTitleBarIndicator] listen failed:', err);
      }
    })();
    return () => {
      cancelled = true;
      unlistenFns.forEach(f => f());
    };
  }, [language]);

  // Auto-dismiss toast after 6s.
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(id);
  }, [toast]);

  const running = progress && progress.stage !== 'idle'
    && progress.stage !== 'completed'
    && progress.stage !== 'cancelled'
    && progress.stage !== 'failed';

  return (
    <>
      {running && (
        <div
          className="vault-repair-titlebar-indicator"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => {
            // Dispatch a global custom event the App layer can subscribe
            // to in order to re-open the modal. We don't import App here
            // to avoid a circular dep.
            window.dispatchEvent(new CustomEvent('vault-repair:open-modal'));
          }}
          title={language === 'ko' ? '복구 진행 상태 보기' : 'View repair progress'}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            height: 22,
            padding: '0 8px',
            margin: '0 8px',
            background: 'color-mix(in srgb, var(--tx-1) 8%, transparent)',
            border: '0.5px solid var(--sep-l)',
            borderRadius: 11,
            cursor: 'pointer',
            color: 'var(--tx-2)',
            fontSize: 'var(--fs-11)',
            WebkitAppRegion: 'no-drag' as unknown as undefined,
          }}
        >
          <div style={{
            width: 10, height: 10,
            border: '1.5px solid var(--sep-l)',
            borderTopColor: progress!.cancelRequested ? 'var(--c-orange, #f97316)' : 'var(--tx-1)',
            borderRadius: '50%',
            animation: 'spin 0.8s linear infinite',
          }} />
          <Wrench size={10} strokeWidth={2} />
          <span>
            {progress!.total > 0
              ? `${progress!.current}/${progress!.total}`
              : (language === 'ko' ? '복구 중' : 'Repairing')}
          </span>
        </div>
      )}
      {toast && createPortal(
        <div
          onClick={() => setToast(null)}
          style={{
            position: 'fixed',
            bottom: 24, right: 24,
            zIndex: 9999,
            minWidth: 280, maxWidth: 480,
            padding: '10px 14px 10px 12px',
            background: 'var(--bg-base)',
            border: '0.5px solid var(--sep-l)',
            borderLeft: `3px solid ${toast.kind === 'error' ? 'var(--c-red, #ef4444)' : 'var(--c-green, #34d399)'}`,
            borderRadius: 6,
            boxShadow: '0 4px 16px rgba(0,0,0,0.15)',
            fontSize: 'var(--fs-12)',
            color: 'var(--tx-1)',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
          }}
        >
          <Wrench size={14} strokeWidth={2} color="var(--tx-3)" />
          <span style={{ flex: 1 }}>{toast.text}</span>
          <XIcon size={12} color="var(--tx-3)" />
        </div>,
        document.body,
      )}
    </>
  );
}
