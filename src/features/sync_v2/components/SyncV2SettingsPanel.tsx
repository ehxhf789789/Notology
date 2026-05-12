// Sync V2 settings panel — NAS configuration form.
// Registered as Settings tab plugin via SettingsRegistry.
// Follows v1 SyncSettingsPanel design pattern (settings-row-info/label/desc classes).

import { useState, useEffect, useCallback } from 'react';
import { syncV2Commands, type SyncV2Config } from '../syncV2Commands';
import { useSyncV2Store } from '../stores/syncV2Store';
import { useLanguage } from '../../../core/stores/settingsStore';
import { showToast } from '../../shared/Toast';

const EMPTY_CONFIG: SyncV2Config = {
  enabled: false, url: '', username: '', password: '', remoteBase: '',
};

const isComplete = (c: SyncV2Config) =>
  !!c.url && !!c.username && !!c.password && !!c.remoteBase;

export default function SyncV2SettingsPanel() {
  const language = useLanguage();
  const ko = language === 'ko';
  const refreshState = useSyncV2Store(s => s.refreshState);

  const [config, setConfig] = useState<SyncV2Config>(EMPTY_CONFIG);
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
  const [testMessage, setTestMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const [realtimeEnabled, setRealtimeEnabled] = useState(false);

  const [globalConn, setGlobalConn] = useState<{ url: string; username: string; password: string } | null>(null);

  useEffect(() => {
    // Load per-vault config
    syncV2Commands.getConfig()
      .then(c => setConfig(c))
      .catch(e => console.warn('[sync_v2] getConfig failed:', e));
    // Load global NAS connection (auto-fill URL/user/pass)
    syncV2Commands.getGlobalConnection()
      .then(gc => {
        if (gc) {
          setGlobalConn(gc);
          // Auto-fill config fields from global connection
          setConfig(prev => ({
            ...prev,
            url: gc.url,
            username: gc.username,
            password: gc.password,
          }));
        }
      })
      .catch(() => {});
    syncV2Commands.getRealtime()
      .then(v => setRealtimeEnabled(v))
      .catch(() => {});
  }, []);

  const update = useCallback((field: keyof SyncV2Config, value: string | boolean) => {
    setConfig(prev => ({ ...prev, [field]: value }));
    setTestStatus('idle');
    setTestMessage('');
  }, []);

  const handleTest = useCallback(async () => {
    setTestStatus('testing');
    setTestMessage('');
    try {
      const url = globalConn?.url || config.url || '';
      const user = globalConn?.username || config.username || '';
      const pass = globalConn?.password || config.password || '';
      await syncV2Commands.testConnection(url, user, pass, config.remoteBase);
      setTestStatus('success');
      setTestMessage(ko ? '✓ 연결 성공' : '✓ Connection successful');
    } catch (e: any) {
      setTestStatus('error');
      setTestMessage(e?.toString() || 'Connection failed');
    }
  }, [config, ko]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      await syncV2Commands.saveConfig(config);
      await syncV2Commands.applyConfig();
      await refreshState();
      showToast({
        type: 'success',
        title: ko ? '동기화 설정 저장됨' : 'Sync configuration saved',
      });
    } catch (e: any) {
      showToast({
        type: 'error',
        title: ko ? '설정 저장 실패' : 'Failed to save config',
        description: e?.toString(),
      });
    } finally {
      setSaving(false);
    }
  }, [config, ko, refreshState]);

  const canTest = isComplete(config);

  return (
    <div className="settings-panel">
      <section className="settings-section">
        <h3 className="settings-section-title">
          {ko ? 'NAS 동기화 (v2)' : 'NAS Sync (v2)'}
        </h3>

        {/* Guide message when not yet associated with a remote vault */}
        {!config.remoteBase && (
          <div className="settings-row" style={{ opacity: 0.8, fontSize: 13, padding: '8px 0' }}>
            <div className="settings-row-info">
              <span className="settings-row-desc">
                {ko
                  ? '이 보관소는 아직 NAS와 연결되어 있지 않습니다. 보관소 선택창에서 NAS vault를 선택하거나 새로 만들어 주세요.'
                  : 'This vault is not yet linked to NAS. Select or create a NAS vault in the vault selector.'}
              </span>
            </div>
          </div>
        )}

        {/* Sync mode (replaces 'Enable sync' + 'Realtime' checkboxes).
            Sync is implicit when a NAS vault is open — only the *speed* is configurable. */}
        <div className="settings-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
          <div className="settings-row-info" style={{ marginBottom: 4 }}>
            <span className="settings-row-label">{ko ? '동기화 속도' : 'Sync speed'}</span>
            <span className="settings-row-desc">
              {ko
                ? 'NAS와 연결된 보관소는 항상 자동으로 동기화됩니다. 폴링 주기를 선택하세요.'
                : 'NAS-connected vaults always auto-sync. Choose polling cadence.'}
            </span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {[
              {
                key: 'realtime' as const,
                label: ko ? '실시간 (1-2초)' : 'Realtime (1-2s)',
                desc: ko ? '가장 빠른 반응. 배터리/데이터 사용량 증가.' : 'Fastest response. Higher battery/data use.',
              },
              {
                key: 'standard' as const,
                label: ko ? '표준 (5초)' : 'Standard (5s)',
                desc: ko ? '대부분의 사용에 적합 (기본값).' : 'Good for most use (default).',
              },
              {
                key: 'low_power' as const,
                label: ko ? '저전력 (60초)' : 'Power-saver (60s)',
                desc: ko ? '배터리 사용 시 권장. 동기화가 느려집니다.' : 'Recommended on battery. Slower sync.',
              },
            ].map(mode => {
              const current: 'realtime' | 'standard' | 'low_power' = realtimeEnabled
                ? 'realtime'
                : 'standard';
              const selected = current === mode.key;
              return (
                <label
                  key={mode.key}
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: 10,
                    padding: '8px 12px',
                    borderRadius: 8,
                    border: `1px solid ${selected ? '#3b82f6' : 'var(--border)'}`,
                    background: selected ? 'rgba(59,130,246,0.06)' : 'transparent',
                    cursor: 'pointer',
                  }}
                >
                  <input
                    type="radio"
                    name="sync-speed"
                    checked={selected}
                    onChange={() => {
                      // Currently only realtime/standard are wired up; low_power maps to standard for now.
                      const wantRealtime = mode.key === 'realtime';
                      setRealtimeEnabled(wantRealtime);
                      syncV2Commands.setRealtime(wantRealtime).catch(() => {});
                    }}
                    style={{ marginTop: 2 }}
                  />
                  <div style={{ flex: 1 }}>
                    <div style={{ color: 'var(--tx-1)', fontWeight: 500, fontSize: 13 }}>{mode.label}</div>
                    <div style={{ color: 'var(--tx-3)', fontSize: 11, marginTop: 2 }}>{mode.desc}</div>
                  </div>
                </label>
              );
            })}
          </div>
        </div>

        {/* NAS Connection info */}
        {globalConn ? (
          <div className="settings-row" style={{ opacity: 0.7 }}>
            <div className="settings-row-info">
              <span className="settings-row-label">{ko ? 'NAS 연결' : 'NAS Connection'}</span>
              <span className="settings-row-desc">
                {globalConn.url} ({globalConn.username})
                {' — '}
                {ko ? '보관소 선택창에서 관리' : 'Managed in vault selector'}
              </span>
            </div>
          </div>
        ) : (
          <>
            {/* URL */}
            <div className="settings-row">
              <div className="settings-row-info">
                <span className="settings-row-label">{ko ? 'NAS URL' : 'NAS URL'}</span>
                <span className="settings-row-desc">
                  {ko ? 'WebDAV 서버 주소' : 'WebDAV server address'}
                </span>
              </div>
              <input
                className="sync-input"
                type="url"
                value={config.url || ''}
                onChange={e => update('url', e.target.value)}
                placeholder="https://your-nas.synology.me:5006"
              />
            </div>

            {/* Username */}
            <div className="settings-row">
              <div className="settings-row-info">
                <span className="settings-row-label">{ko ? '사용자 이름' : 'Username'}</span>
              </div>
              <input
                className="sync-input"
                type="text"
                value={config.username || ''}
                onChange={e => update('username', e.target.value)}
                placeholder={ko ? '사용자 이름' : 'Username'}
              />
            </div>

            {/* Password */}
            <div className="settings-row">
              <div className="settings-row-info">
                <span className="settings-row-label">{ko ? '비밀번호' : 'Password'}</span>
              </div>
              <input
                className="sync-input"
                type="password"
                value={config.password || ''}
                onChange={e => update('password', e.target.value)}
                placeholder="••••••••"
              />
            </div>
          </>
        )}

        {/* Remote base — read-only (set automatically by vault selector) */}
        <div className="settings-row">
          <div className="settings-row-info">
            <span className="settings-row-label">{ko ? '원격 경로' : 'Remote path'}</span>
            <span className="settings-row-desc" style={{ color: 'var(--tx-2)' }}>
              {config.remoteBase || (ko ? '(아직 vault에 진입하지 않음)' : '(no vault open)')}
            </span>
            <span className="settings-row-desc" style={{ fontSize: 11, color: 'var(--tx-3)', marginTop: 4 }}>
              {ko
                ? '보관소 선택창에서 vault를 선택/생성할 때 자동으로 결정됩니다.'
                : 'Set automatically when you select or create a vault.'}
            </span>
          </div>
        </div>

        {/* Test result */}
        {testStatus === 'success' && (
          <div className="settings-row">
            <span style={{ color: 'var(--color-success, #4caf50)', fontSize: 13 }}>{testMessage}</span>
          </div>
        )}
        {testStatus === 'error' && (
          <div className="settings-row">
            <span className="sync-error" style={{ fontSize: 13 }}>{testMessage}</span>
          </div>
        )}

        {/* Actions */}
        <div className="sync-actions" style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <button
            className="settings-action-btn"
            onClick={handleTest}
            disabled={!canTest || testStatus === 'testing'}
          >
            {testStatus === 'testing'
              ? (ko ? '테스트 중...' : 'Testing...')
              : (ko ? '연결 테스트' : 'Test connection')}
          </button>
          <button
            className="settings-action-btn primary"
            onClick={handleSave}
            disabled={saving}
          >
            {saving ? (ko ? '저장 중...' : 'Saving...') : (ko ? '저장' : 'Save')}
          </button>
        </div>
      </section>

      {/* Reconciliation / Zombie cleanup */}
      <section className="settings-section" style={{ marginTop: 16 }}>
        <h3 className="settings-section-title">
          {ko ? '정합성 검사' : 'Consistency Check'}
        </h3>
        <div className="settings-row">
          <div className="settings-row-info">
            <span className="settings-row-desc">
              {ko
                ? 'NAS에서 삭제된 노트를 로컬에서도 정리합니다.'
                : 'Clean up local notes that were deleted from NAS.'}
            </span>
          </div>
        </div>
        <div className="sync-actions" style={{ display: 'flex', gap: 8 }}>
          <button
            className="settings-action-btn"
            onClick={async () => {
              try {
                const result = await syncV2Commands.cleanupZombies();
                if (result.zombiesCleaned > 0) {
                  showToast({
                    type: 'success',
                    title: ko
                      ? `${result.zombiesCleaned}개 좀비 노트 정리됨`
                      : `${result.zombiesCleaned} zombie notes cleaned`,
                  });
                } else {
                  showToast({
                    type: 'info',
                    title: ko ? '정리할 항목 없음' : 'Nothing to clean',
                  });
                }
              } catch (e: any) {
                showToast({
                  type: 'error',
                  title: ko ? '정합성 검사 실패' : 'Cleanup failed',
                  description: e?.toString(),
                });
              }
            }}
          >
            {ko ? '정합성 검사 실행' : 'Run consistency check'}
          </button>
          <button
            className="settings-action-btn"
            title={ko
              ? '같은 파일 경로를 가리키는 중복 ref들을 정리합니다 (가장 최근 항목 보존).'
              : 'Prune refs that share a relative_path (keep the most recent).'}
            onClick={async () => {
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
                  showToast({
                    type: 'info',
                    title: ko ? '중복 ref 없음' : 'No duplicate refs',
                  });
                }
              } catch (e: any) {
                showToast({
                  type: 'error',
                  title: ko ? '중복 ref 정리 실패' : 'Stale ref cleanup failed',
                  description: e?.toString(),
                });
              }
            }}
          >
            {ko ? '중복 ref 정리' : 'Prune duplicate refs'}
          </button>
        </div>
      </section>
    </div>
  );
}
