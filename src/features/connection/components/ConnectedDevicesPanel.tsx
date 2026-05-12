/**
 * ConnectedDevicesPanel — Settings tab showing all registered devices.
 * Registered via SettingsRegistry in connection/index.ts.
 */
import { useState, useEffect, useCallback } from 'react';
import * as conn from '../connectionCommands';
import type { DeviceInfo } from '../types';

const HEARTBEAT_INTERVAL_SEC = 10;
const STALE_THRESHOLD_SEC = HEARTBEAT_INTERVAL_SEC * 3; // 30s

export function ConnectedDevicesPanel() {
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [selfDeviceId, setSelfDeviceId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setIsLoading(true);
    setError('');
    try {
      const status = await conn.getStatus();
      setSelfDeviceId(status.device?.deviceId || null);
      const list = await conn.listConnectedDevices();
      setDevices(list);
    } catch (e: any) {
      setError(e?.toString() || 'Failed to load devices');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, 15000); // refresh every 15s
    return () => clearInterval(interval);
  }, [load]);

  const handleDelete = useCallback(async (deviceId: string) => {
    const isSelf = deviceId === selfDeviceId;
    const msg = isSelf
      ? '이 기기를 NAS에서 제거합니다. 다음 실행 시 새 ID로 재등록됩니다.'
      : '이 기기를 NAS에서 제거합니다.';
    if (!confirm(msg)) return;

    try {
      await conn.deleteConnectedDevice(deviceId);
      if (isSelf) {
        await conn.logout(true);
        // Force reload to show login screen
        window.location.reload();
      } else {
        load();
      }
    } catch (e: any) {
      setError(e?.toString() || 'Failed to delete device');
    }
  }, [selfDeviceId, load]);

  if (!devices.length && !isLoading) {
    return (
      <div className="settings-section">
        <h3 className="settings-section-title">연결된 기기</h3>
        {error && <div className="nas-error">{error}</div>}
        <div className="settings-row-info">
          <span className="settings-label">동기화 엔진이 활성화되지 않았습니다.</span>
        </div>
      </div>
    );
  }

  return (
    <div className="settings-section">
      <h3 className="settings-section-title">연결된 기기</h3>
      {error && <div className="nas-error" style={{ marginBottom: 8 }}>{error}</div>}
      {isLoading && devices.length === 0 && (
        <div style={{ padding: 16, textAlign: 'center', color: 'var(--tx-3)' }}>로딩 중...</div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {devices.map(d => {
          const isSelf = d.deviceId === selfDeviceId;
          const statusInfo = computeStatus(d);
          return (
            <div
              key={d.deviceId}
              className="connected-device-card"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: '12px 14px',
                background: 'var(--bg-1)',
                border: '1px solid var(--border)',
                borderRadius: 8,
              }}
            >
              <span style={{ fontSize: 22, flexShrink: 0 }}>{d.os === 'android' || d.os === 'ios' ? '📱' : '💻'}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                  <strong style={{
                    fontSize: 14,
                    color: 'var(--tx-1)',
                    fontWeight: 600,
                  }}>
                    {d.hostname}
                  </strong>
                  {isSelf && (
                    <span style={{
                      fontSize: 10,
                      padding: '2px 8px',
                      borderRadius: 999,
                      background: '#3b82f6',
                      color: '#ffffff',
                      fontWeight: 700,
                      letterSpacing: 0.3,
                      lineHeight: 1.4,
                      boxShadow: '0 1px 2px rgba(59, 130, 246, 0.3)',
                    }}>현재</span>
                  )}
                </div>
                <div style={{
                  fontSize: 12,
                  color: 'var(--tx-2)',
                  display: 'flex',
                  gap: 12,
                  alignItems: 'center',
                  flexWrap: 'wrap',
                }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                    <span style={{
                      width: 7,
                      height: 7,
                      borderRadius: '50%',
                      background: statusInfo.color,
                      display: 'inline-block',
                      boxShadow: `0 0 4px ${statusInfo.color}`,
                    }} />
                    <span style={{ color: 'var(--tx-1)' }}>{statusInfo.label}</span>
                  </span>
                  <span style={{ color: 'var(--tx-3)' }}>{d.os} · v{d.appVersion}</span>
                </div>
              </div>
              {/* Self device cannot be removed here — use vault selector's "연결 해제" instead */}
              {!isSelf && (
                <button
                  className="nas-btn-sm danger"
                  onClick={() => handleDelete(d.deviceId)}
                  style={{ flexShrink: 0 }}
                >
                  제거
                </button>
              )}
            </div>
          );
        })}
      </div>
      <div style={{
        marginTop: 12,
        padding: '8px 12px',
        fontSize: 11,
        color: 'var(--tx-3)',
        lineHeight: 1.5,
      }}>
        💡 이 기기를 NAS 연결에서 해제하려면 보관소 선택창의 <strong>[연결 해제]</strong> 버튼을 사용하세요.
        다른 기기는 위 <strong>[제거]</strong> 버튼으로 정리할 수 있습니다.
      </div>
    </div>
  );
}

function computeStatus(device: DeviceInfo): { label: string; color: string } {
  // Backend serializes enum as camelCase ("online"/"offline"). Compare case-insensitively.
  const isOffline = String(device.status || '').toLowerCase() === 'offline';
  if (isOffline) {
    return {
      label: device.logoutAt ? `${formatRelative(device.logoutAt)} 종료` : '오프라인',
      color: '#888',
    };
  }

  const sinceMs = Date.now() - new Date(device.lastSeenAt).getTime();
  const sinceSec = sinceMs / 1000;

  if (sinceSec < STALE_THRESHOLD_SEC) {
    return { label: '활동 중', color: '#4caf50' };
  }
  if (sinceSec < 300) {
    return { label: `${Math.ceil(sinceSec / 60)}분 전 활동`, color: '#ff9800' };
  }
  if (sinceSec < 86400) {
    return {
      label: `${Math.ceil(sinceSec / 3600)}시간 전 (비정상 종료 추정)`,
      color: '#f44336',
    };
  }
  return { label: `${formatRelative(device.lastSeenAt)} 마지막`, color: '#888' };
}

function formatRelative(iso: string): string {
  try {
    const sec = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
    if (sec < 60) return '방금';
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}분 전`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}시간 전`;
    return `${Math.floor(hr / 24)}일 전`;
  } catch {
    return '';
  }
}
