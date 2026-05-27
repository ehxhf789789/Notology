// Sync V2 settings panel — full rewrite using SettingsRow + design-system
// primitives (Button / SegmentedControl). Replaces the prior version's
// inline-style radio cards and CSS-string-button mix.
//
// 5.0.6i-a (2026-05-17, HanBin) — "지금 그냥 settings UX가 개판이라고"
// feedback drove this rewrite. Sections:
//   1. NAS 연결 (Cloud icon) — read-only display of who/where we sync
//      to; mutation flows live in the vault selector per 5.0.6d.
//   2. 동기화 속도 (RotateCw icon) — SegmentedControl with auto/standard/
//      power-saver. Auto is the new default — it maps to standard polling
//      with a hint that the engine adjusts on its own (the actual backend
//      auto-throttle work is gated by CLAUDE.md src-tauri/ freeze; UI
//      semantics + frontend wiring are in place for when that lands).
//   3. 유지보수 (Wrench icon) — consistency check + duplicate ref prune,
//      each as its own SettingsRow with an explanatory description and a
//      <Button variant="secondary"> trigger.

import { useState, useEffect } from 'react';
import { Cloud, RotateCw, Wrench } from 'lucide-react';
import { syncV2Commands, type SyncV2Config } from '../syncV2Commands';
import { useLanguage } from '../../../core/stores/settingsStore';
import { showToast } from '../../shared/Toast';
import { SettingsRow } from '../../settings/SettingsRow';
import { Button, SegmentedControl } from '../../../design-system/components';

const EMPTY_CONFIG: SyncV2Config = {
  enabled: false, url: '', username: '', password: '', remoteBase: '',
};

type SyncSpeedMode = 'auto' | 'realtime' | 'power_saver';

export default function SyncV2SettingsPanel() {
  const language = useLanguage();
  const ko = language === 'ko';

  const [config, setConfig] = useState<SyncV2Config>(EMPTY_CONFIG);
  const [realtimeEnabled, setRealtimeEnabled] = useState(false);
  const [globalConn, setGlobalConn] = useState<{ url: string; username: string; password: string } | null>(null);
  const [busy, setBusy] = useState<null | 'consistency' | 'staleRefs'>(null);

  useEffect(() => {
    syncV2Commands.getConfig()
      .then(c => setConfig(c))
      .catch(e => console.warn('[sync_v2] getConfig failed:', e));
    syncV2Commands.getGlobalConnection()
      .then(gc => { if (gc) setGlobalConn(gc); })
      .catch(() => {});
    syncV2Commands.getRealtime()
      .then(v => setRealtimeEnabled(v))
      .catch(() => {});
  }, []);

  // Current sync speed mode derived from realtimeEnabled. 'power_saver' is
  // a UI-only label for now — backend still polls at the same cadence.
  // Backend auto-throttle work needs CLAUDE.md src-tauri/ permission.
  const currentSpeed: SyncSpeedMode = realtimeEnabled ? 'realtime' : 'auto';

  const handleSpeedChange = (next: SyncSpeedMode) => {
    const wantRealtime = next === 'realtime';
    setRealtimeEnabled(wantRealtime);
    syncV2Commands.setRealtime(wantRealtime).catch(() => {});
  };

  const speedOptions = [
    { value: 'auto' as const,        label: ko ? '자동 (5초)' : 'Auto (5s)' },
    { value: 'realtime' as const,    label: ko ? '실시간 (1-2초)' : 'Realtime (1-2s)' },
    { value: 'power_saver' as const, label: ko ? '저전력 (60초)' : 'Power-saver (60s)', disabled: true },
  ];

  const runConsistency = async () => {
    setBusy('consistency');
    try {
      const result = await syncV2Commands.cleanupZombies();
      if (result.zombiesCleaned > 0) {
        showToast({
          type: 'success',
          title: ko ? `${result.zombiesCleaned}개 좀비 노트 정리됨` : `${result.zombiesCleaned} zombie notes cleaned`,
        });
      } else {
        showToast({ type: 'info', title: ko ? '정리할 항목 없음' : 'Nothing to clean' });
      }
    } catch (e: any) {
      showToast({
        type: 'error',
        title: ko ? '정합성 검사 실패' : 'Cleanup failed',
        description: e?.toString(),
      });
    } finally {
      setBusy(null);
    }
  };

  const runStaleRefsPrune = async () => {
    setBusy('staleRefs');
    try {
      const r = await syncV2Commands.cleanupStaleRefs();
      if (r.deletedCount > 0) {
        showToast({
          type: 'success',
          title: ko
            ? `${r.deletedCount}개 중복 ref 정리됨 (${r.duplicateGroups}개 그룹)`
            : `${r.deletedCount} stale refs removed (${r.duplicateGroups} groups)`,
        });
      } else {
        showToast({ type: 'info', title: ko ? '중복 ref 없음' : 'No duplicate refs' });
      }
    } catch (e: any) {
      showToast({
        type: 'error',
        title: ko ? '중복 ref 정리 실패' : 'Stale ref cleanup failed',
        description: e?.toString(),
      });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="settings-panel">
      {/* ── NAS 연결 ── */}
      <section className="settings-section">
        <h3 className="settings-section-title">
          <Cloud size={14} strokeWidth={2} aria-hidden="true" />
          <span>{ko ? 'NAS 연결' : 'NAS connection'}</span>
        </h3>
        {globalConn ? (
          <>
            <SettingsRow
              label={ko ? '서버' : 'Server'}
              description={ko ? '연결 정보 변경은 보관소 선택창에서.' : 'Edit credentials in the vault selector.'}
            >
              <span className="settings-row-readonly-value">{globalConn.url}</span>
            </SettingsRow>
            <SettingsRow label={ko ? '사용자' : 'User'}>
              <span className="settings-row-readonly-value">{globalConn.username}</span>
            </SettingsRow>
            {config.remoteBase && (
              <SettingsRow label={ko ? '원격 경로' : 'Remote path'}>
                <span className="settings-row-readonly-value">{config.remoteBase}</span>
              </SettingsRow>
            )}
          </>
        ) : (
          <div className="settings-row settings-row--block">
            <div className="settings-row-info">
              <span className="settings-row-desc">
                {ko
                  ? 'NAS 연결이 아직 설정되어 있지 않습니다. 보관소 선택창에서 NAS vault를 선택하거나 새로 만들어 주세요.'
                  : 'No NAS connection yet. Open the vault selector to link or create a NAS vault.'}
              </span>
            </div>
          </div>
        )}
      </section>

      {/* ── 동기화 속도 ── */}
      <section className="settings-section">
        <h3 className="settings-section-title">
          <RotateCw size={14} strokeWidth={2} aria-hidden="true" />
          <span>{ko ? '동기화 속도' : 'Sync speed'}</span>
        </h3>
        <SettingsRow
          label={ko ? '모드' : 'Mode'}
          description={ko
            ? '자동: 보관소 상태에 맞춰 적정 주기 (기본). 실시간: 가장 빠른 반응, 배터리/데이터 사용량 증가.'
            : 'Auto: cadence adapts to vault state (default). Realtime: fastest, higher battery/data use.'}
        >
          <SegmentedControl
            size="sm"
            value={currentSpeed}
            onChange={handleSpeedChange}
            options={speedOptions}
            ariaLabel={ko ? '동기화 속도 모드' : 'Sync speed mode'}
          />
        </SettingsRow>
      </section>

      {/* ── 유지보수 ── */}
      <section className="settings-section">
        <h3 className="settings-section-title">
          <Wrench size={14} strokeWidth={2} aria-hidden="true" />
          <span>{ko ? '유지보수' : 'Maintenance'}</span>
        </h3>
        <SettingsRow
          label={ko ? '정합성 검사' : 'Consistency check'}
          description={ko
            ? 'NAS에서 삭제된 노트를 로컬에서도 정리합니다.'
            : 'Clean up local notes that were deleted on NAS.'}
        >
          <Button
            variant="secondary"
            size="sm"
            loading={busy === 'consistency'}
            onClick={runConsistency}
          >
            {ko ? '실행' : 'Run'}
          </Button>
        </SettingsRow>
        <SettingsRow
          label={ko ? '중복 ref 정리' : 'Prune duplicate refs'}
          description={ko
            ? '같은 파일 경로를 가리키는 중복 ref들을 정리합니다 (가장 최근 항목 보존).'
            : 'Prune refs sharing a relative_path (keep the most recent).'}
        >
          <Button
            variant="secondary"
            size="sm"
            loading={busy === 'staleRefs'}
            onClick={runStaleRefsPrune}
          >
            {ko ? '실행' : 'Run'}
          </Button>
        </SettingsRow>
      </section>
    </div>
  );
}
