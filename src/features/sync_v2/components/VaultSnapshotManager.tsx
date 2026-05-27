/**
 * VaultSnapshotManager — Phase 1 B3 (HanBin 2026-05-24).
 *
 * Dev Mode UI for full-vault snapshots: create, list, restore, delete.
 * Lives in Settings → Dev Mode → "보관소 스냅샷" section. Targeted at
 * users (developer / cautious) who want a manual safety net before
 * running risky operations (e.g. legacy vault migration on important
 * data). vault_repair_apply also creates snapshots automatically, so
 * this section primarily serves manual create + restore flows.
 */

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Camera, RotateCcw, Trash2, RefreshCw, FlaskConical } from 'lucide-react';
import {
  syncV2Commands,
  type VaultSnapshotInfo,
  type VaultSnapshotRestoreOutcome,
  type VaultSandboxOutcome,
} from '../syncV2Commands';
import type { LanguageSetting } from '../../../core/stores/settingsStore';

interface Props {
  language: LanguageSetting;
}

export function VaultSnapshotManager({ language }: Props) {
  const ko = language === 'ko';
  const [snapshots, setSnapshots] = useState<VaultSnapshotInfo[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastRestore, setLastRestore] = useState<VaultSnapshotRestoreOutcome | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const list = await syncV2Commands.vaultSnapshotList();
      setSnapshots(list);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const onCreate = async () => {
    setBusy('create');
    setError(null);
    try {
      const m = await syncV2Commands.vaultSnapshotCreate('manual');
      console.log('[VaultSnapshotManager] created:', m.snapshotId);
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const onRestore = async (id: string, label: string) => {
    // P1 #6 — preview first so the user sees the actual cost (which
    // files get deleted) before any destructive action.
    setBusy(id);
    setError(null);
    let preview;
    try {
      preview = await syncV2Commands.vaultSnapshotPreviewRestore(id);
    } catch (e) {
      setError(String(e));
      setBusy(null);
      return;
    }

    const deleteSample = preview.filesToDelete.slice(0, 10).join('\n  • ');
    const moreDel = preview.filesToDelete.length > 10
      ? `\n  ... 외 ${preview.filesToDelete.length - 10}개`
      : '';

    const confirm1 = ko
      ? `보관소를 스냅샷 "${id}" 시점으로 복원합니다.\n\n` +
        `▸ 덮어쓰기: ${preview.filesToOverwrite.length}개 파일 (${formatBytes(preview.bytesToOverwrite)})\n` +
        `▸ 변경 없음: ${preview.filesUnchanged}개\n` +
        `▸ 영구 삭제: ${preview.filesToDelete.length}개\n` +
        (preview.filesToDelete.length > 0
          ? `\n삭제될 파일:\n  • ${deleteSample}${moreDel}\n\n`
          : '\n') +
        `계속하시겠습니까?`
      : `Restore vault to snapshot "${id}":\n\n` +
        `▸ Overwrite: ${preview.filesToOverwrite.length} files (${formatBytes(preview.bytesToOverwrite)})\n` +
        `▸ Unchanged: ${preview.filesUnchanged}\n` +
        `▸ Permanently delete: ${preview.filesToDelete.length}\n` +
        (preview.filesToDelete.length > 0
          ? `\nWill be deleted:\n  • ${deleteSample}${moreDel}\n\n`
          : '\n') +
        `Continue?`;
    if (!window.confirm(confirm1)) { setBusy(null); return; }

    const confirm2 = ko
      ? `정말 복원하시겠습니까?\n스냅샷: ${label} (${id})\n${preview.filesToDelete.length}개 파일이 영구 삭제됩니다.`
      : `Final confirmation:\nSnapshot: ${label} (${id})\n${preview.filesToDelete.length} files will be permanently deleted.`;
    if (!window.confirm(confirm2)) { setBusy(null); return; }

    try {
      const outcome = await syncV2Commands.vaultSnapshotRestore(id);
      setLastRestore(outcome);
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const onDelete = async (id: string) => {
    const msg = ko
      ? `스냅샷 "${id}"를 영구 삭제합니다. 디스크에서 제거되며 복구 불가합니다. 계속할까요?`
      : `Permanently delete snapshot "${id}"? Cannot be undone.`;
    if (!window.confirm(msg)) return;

    setBusy(id);
    setError(null);
    try {
      await syncV2Commands.vaultSnapshotDelete(id);
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="settings-section">
      <h3 className="settings-section-title">
        <Camera size={14} strokeWidth={2} aria-hidden="true" />
        <span>{ko ? '보관소 스냅샷' : 'Vault snapshots'}</span>
      </h3>
      <p style={{
        margin: '0 0 12px', fontSize: 'var(--fs-12)', color: 'var(--tx-3)',
      }}>
        {ko
          ? '전체 보관소를 sha256 무결성 매니페스트와 함께 스냅샷으로 저장합니다. 외부 위치(%LOCALAPPDATA%)에 저장되므로 NAS와 동기화되지 않습니다. 위험한 작업 전 안전망 역할.'
          : 'Full vault snapshot with sha256 integrity manifest. Stored outside the vault (%LOCALAPPDATA%) so it never syncs. Safety net before risky operations.'}
      </p>

      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12,
      }}>
        <button
          type="button"
          onClick={onCreate}
          disabled={busy !== null}
          style={primaryBtn}
        >
          <Camera size={12} />
          {busy === 'create'
            ? (ko ? '생성 중...' : 'Creating...')
            : (ko ? '새 스냅샷 생성' : 'Create snapshot')}
        </button>
        <button
          type="button"
          onClick={refresh}
          disabled={busy !== null}
          style={ghostBtn}
          title={ko ? '목록 새로고침' : 'Refresh list'}
        >
          <RefreshCw size={12} />
        </button>
      </div>

      {error && (
        <div style={errorBoxStyle}>
          <AlertTriangle size={12} /> {error}
        </div>
      )}

      {lastRestore && (
        <div style={{
          padding: '8px 10px', marginBottom: 10,
          background: 'color-mix(in srgb, var(--c-green, #34d399) 12%, transparent)',
          border: '0.5px solid color-mix(in srgb, var(--c-green, #34d399) 50%, transparent)',
          borderRadius: 6, fontSize: 'var(--fs-12)', color: 'var(--tx-2)',
        }}>
          {ko
            ? `복원 완료 — 복구 ${lastRestore.filesRestored}건, 삭제 ${lastRestore.filesDeleted}건, 오류 ${lastRestore.errors.length}건`
            : `Restore complete — ${lastRestore.filesRestored} restored, ${lastRestore.filesDeleted} deleted, ${lastRestore.errors.length} errors`}
        </div>
      )}

      {snapshots.length === 0 ? (
        <div style={{
          padding: 16, textAlign: 'center', fontSize: 'var(--fs-12)',
          color: 'var(--tx-3)', background: 'var(--bg-elevated)',
          borderRadius: 6,
        }}>
          {ko ? '저장된 스냅샷 없음' : 'No snapshots yet'}
        </div>
      ) : null}

      {/* Phase 5 B8 — sandbox section. Stays compact next to snapshots
          since they share the same "safety primitives" mental model. */}
      <div style={{ marginTop: 16, paddingTop: 12, borderTop: '0.5px solid var(--sep-l)' }}>
        <h4 style={{
          margin: '0 0 6px', fontSize: 'var(--fs-13)', fontWeight: 600,
          display: 'flex', alignItems: 'center', gap: 6, color: 'var(--tx-1)',
        }}>
          <FlaskConical size={12} strokeWidth={2} />
          {ko ? '샌드박스 (테스트 복제)' : 'Sandbox (test clone)'}
        </h4>
        <p style={{
          margin: '0 0 10px', fontSize: 'var(--fs-11)', color: 'var(--tx-3)',
        }}>
          {ko
            ? '현재 보관소를 외부 위치에 완전 복제합니다. 위험한 마이그레이션을 실 데이터 전 복제본에 먼저 적용해 결과를 확인할 수 있습니다. 큰 보관소(GB 단위)는 수 분 소요.'
            : 'Clones the open vault to an external location so you can run risky migrations against a copy first. Large vaults (GB-scale) take minutes.'}
        </p>
        <SandboxButton ko={ko} />
      </div>

      {snapshots.length === 0 ? null : (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0, marginTop: 12 }}>
          {snapshots.map(s => (
            <li key={s.snapshotId} style={snapshotRowStyle}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                  <strong style={{ fontSize: 'var(--fs-13)', color: 'var(--tx-1)' }}>
                    {s.label}
                  </strong>
                  {!s.complete && (
                    <span style={{
                      fontSize: 'var(--fs-10)', color: 'var(--c-orange, #f97316)',
                      padding: '0 4px', border: '0.5px solid currentColor', borderRadius: 3,
                    }}>
                      {ko ? '미완료' : 'incomplete'}
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 'var(--fs-11)', color: 'var(--tx-3)' }}>
                  {new Date(s.startedAt).toLocaleString()} · {s.fileCount} files · {formatBytes(s.totalBytes)}
                </div>
                <div style={{
                  fontSize: 'var(--fs-10)', color: 'var(--tx-4, var(--tx-3))',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  fontFamily: 'monospace',
                }} title={s.dir}>
                  {s.snapshotId}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                <button
                  type="button"
                  onClick={() => onRestore(s.snapshotId, s.label)}
                  disabled={busy !== null || !s.complete}
                  style={dangerBtn}
                  title={ko ? '이 스냅샷으로 복원' : 'Restore to this snapshot'}
                >
                  <RotateCcw size={12} />
                  {ko ? '복원' : 'Restore'}
                </button>
                <button
                  type="button"
                  onClick={() => onDelete(s.snapshotId)}
                  disabled={busy !== null}
                  style={ghostBtn}
                  title={ko ? '삭제' : 'Delete'}
                >
                  <Trash2 size={12} />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function SandboxButton({ ko }: { ko: boolean }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<VaultSandboxOutcome | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const onClick = async () => {
    setBusy(true);
    setErr(null);
    setResult(null);
    try {
      const outcome = await syncV2Commands.vaultSandboxCreate('manual');
      setResult(outcome);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={onClick}
        disabled={busy}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          height: 28, padding: '0 10px', border: '0.5px solid var(--sep-l)',
          background: 'var(--bg-elevated)',
          cursor: busy ? 'wait' : 'pointer', borderRadius: 6,
          fontSize: 'var(--fs-12)', color: 'var(--tx-2)',
        }}
      >
        <FlaskConical size={12} />
        {busy
          ? (ko ? '복제 중...' : 'Cloning...')
          : (ko ? '샌드박스 생성' : 'Create sandbox')}
      </button>
      {err && (
        <div style={{
          marginTop: 8, padding: '6px 10px',
          background: 'color-mix(in srgb, var(--c-red, #ef4444) 12%, transparent)',
          color: 'var(--tx-2)', fontSize: 'var(--fs-11)', borderRadius: 6,
        }}>
          {err}
        </div>
      )}
      {result && (
        <div style={{
          marginTop: 8, padding: '8px 10px',
          background: 'color-mix(in srgb, var(--c-green, #34d399) 12%, transparent)',
          border: '0.5px solid color-mix(in srgb, var(--c-green, #34d399) 50%, transparent)',
          borderRadius: 6, fontSize: 'var(--fs-12)', color: 'var(--tx-2)',
        }}>
          <div>
            {ko ? '✅ 복제 완료 — ' : '✅ Clone complete — '}
            {result.filesCopied} files, {formatBytes(result.bytesCopied)}
            {result.errors.length > 0 ? ` (${result.errors.length} ${ko ? '오류' : 'errors'})` : ''}
          </div>
          <div style={{
            marginTop: 4, fontSize: 'var(--fs-10)', color: 'var(--tx-3)',
            fontFamily: 'monospace', wordBreak: 'break-all',
          }}>
            {result.sandboxPath}
          </div>
          <div style={{ marginTop: 4, fontSize: 'var(--fs-11)', color: 'var(--tx-3)' }}>
            {ko
              ? '이 경로를 보관소로 열어 Notology에서 테스트하세요. 실 보관소는 영향 0.'
              : 'Open this path as a vault in Notology to test. The original is untouched.'}
          </div>
        </div>
      )}
    </>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

const primaryBtn: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 6,
  height: 30, padding: '0 12px', border: 'none',
  background: 'var(--btn-primary-bg)', color: 'var(--btn-primary-fg)',
  cursor: 'pointer', borderRadius: 6, fontSize: 'var(--fs-12)', fontWeight: 500,
};

const ghostBtn: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 6,
  height: 28, padding: '0 10px', border: '0.5px solid var(--sep-l)',
  background: 'transparent', color: 'var(--tx-2)',
  cursor: 'pointer', borderRadius: 6, fontSize: 'var(--fs-12)',
};

const dangerBtn: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 6,
  height: 28, padding: '0 10px',
  border: '0.5px solid color-mix(in srgb, var(--c-red, #ef4444) 45%, transparent)',
  background: 'transparent', color: 'var(--c-red, #ef4444)',
  cursor: 'pointer', borderRadius: 6, fontSize: 'var(--fs-12)',
};

const errorBoxStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 6,
  padding: '8px 10px', marginBottom: 10,
  background: 'color-mix(in srgb, var(--c-red, #ef4444) 12%, transparent)',
  border: '0.5px solid color-mix(in srgb, var(--c-red, #ef4444) 50%, transparent)',
  borderRadius: 6, fontSize: 'var(--fs-12)', color: 'var(--tx-2)',
};

const snapshotRowStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 10,
  padding: '10px 12px', marginBottom: 6,
  background: 'var(--bg-elevated)', borderRadius: 6,
};
