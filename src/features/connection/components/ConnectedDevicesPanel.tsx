/**
 * ConnectedDevicesPanel — Settings tab showing all registered devices.
 * Registered via SettingsRegistry in connection/index.ts as "보관소 상태"
 * (renamed from "연결된 기기" per HanBin 5.0.6d).
 *
 * 5.0.6j (2026-05-17, HanBin) — rewrite for Settings UX consistency:
 *   • i18n — Korean-only strings replaced with t() + tf() (en added)
 *   • emoji device icons (📱/💻) → lucide Smartphone/Laptop
 *   • native confirm() → modalActions.showConfirmDelete (matches the
 *     template-delete confirmation pattern)
 *   • inline-styled remove button → design-system <Button variant="danger" size="sm">
 *   • inline-style device cards → .vault-status-* CSS classes
 *   • status indicator uses theme tokens (--c-success/--c-warning/--c-danger)
 *     so dark/light modes both work without literal hex
 */
import { useState, useEffect, useCallback } from 'react';
import { Smartphone, Laptop, AlertCircle, Info } from 'lucide-react';
import * as conn from '../connectionCommands';
import type { DeviceInfo } from '../types';
import { t, tf, type LanguageSetting } from '../../../core/utils/i18n';
import { useLanguage } from '../../../core/stores/settingsStore';
import { modalActions } from '../../modals/stores/modalStore';
import { Button } from '../../../design-system/components';

const HEARTBEAT_INTERVAL_SEC = 10;
const STALE_THRESHOLD_SEC = HEARTBEAT_INTERVAL_SEC * 3; // 30s

/** Status info now resolves through i18n + theme tokens, not literal Korean
 *  strings + hex. Color names are CSS var keys that themes.css defines for
 *  both modes. */
type StatusTone = 'success' | 'warning' | 'danger' | 'neutral';

function computeStatus(device: DeviceInfo, lang: LanguageSetting): { label: string; tone: StatusTone } {
  const isOffline = String(device.status || '').toLowerCase() === 'offline';
  if (isOffline) {
    return {
      label: device.logoutAt
        ? tf('vaultStatusOfflineSinceLogout', lang, { when: formatRelative(device.logoutAt, lang) })
        : t('vaultStatusOffline', lang),
      tone: 'neutral',
    };
  }

  const sinceMs = Date.now() - new Date(device.lastSeenAt).getTime();
  const sinceSec = sinceMs / 1000;

  if (sinceSec < STALE_THRESHOLD_SEC) {
    return { label: t('vaultStatusActive', lang), tone: 'success' };
  }
  if (sinceSec < 300) {
    return {
      label: tf('vaultStatusMinutesAgo', lang, { count: String(Math.ceil(sinceSec / 60)) }),
      tone: 'warning',
    };
  }
  if (sinceSec < 86400) {
    return {
      label: tf('vaultStatusHoursAgo', lang, { count: String(Math.ceil(sinceSec / 3600)) }),
      tone: 'danger',
    };
  }
  return {
    label: tf('vaultStatusLastSeen', lang, { when: formatRelative(device.lastSeenAt, lang) }),
    tone: 'neutral',
  };
}

function formatRelative(iso: string, lang: LanguageSetting): string {
  try {
    const sec = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
    if (sec < 60) return t('vaultStatusJustNow', lang);
    const min = Math.floor(sec / 60);
    if (min < 60) return tf('vaultStatusMinAgo', lang, { min: String(min) });
    const hr = Math.floor(min / 60);
    if (hr < 24) return tf('vaultStatusHrAgo', lang, { hr: String(hr) });
    return tf('vaultStatusDayAgo', lang, { day: String(Math.floor(hr / 24)) });
  } catch {
    return '';
  }
}

export function ConnectedDevicesPanel() {
  const language = useLanguage();
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

  const handleDelete = useCallback((deviceId: string, hostname: string) => {
    const isSelf = deviceId === selfDeviceId;
    const warning = isSelf
      ? t('vaultStatusRemoveConfirmSelf', language)
      : t('vaultStatusRemoveConfirmOther', language);

    modalActions.showConfirmDelete(
      hostname,
      'file',
      async () => {
        try {
          await conn.deleteConnectedDevice(deviceId);
          if (isSelf) {
            await conn.logout(true);
            window.location.reload();
          } else {
            load();
          }
        } catch (e: any) {
          setError(e?.toString() || 'Failed to delete device');
        }
      },
      undefined,
      { warningOverride: warning },
    );
  }, [selfDeviceId, load, language]);

  if (!devices.length && !isLoading) {
    return (
      <div className="settings-panel">
        <section className="settings-section">
          {error && (
            <div className="settings-row vault-status-error">
              <AlertCircle size={14} />
              <span>{error}</span>
            </div>
          )}
          <div className="vault-status-empty">{t('vaultStatusEmpty', language)}</div>
        </section>
      </div>
    );
  }

  return (
    <div className="settings-panel">
      <section className="settings-section">
        {error && (
          <div className="vault-status-error">
            <AlertCircle size={14} />
            <span>{error}</span>
          </div>
        )}
        {isLoading && devices.length === 0 && (
          <div className="vault-status-loading">{t('vaultStatusLoading', language)}</div>
        )}
        <div className="vault-status-list">
          {devices.map(d => {
            const isSelf = d.deviceId === selfDeviceId;
            const statusInfo = computeStatus(d, language);
            const isMobile = d.os === 'android' || d.os === 'ios';
            const isOffline = String(d.status || '').toLowerCase() === 'offline';
            const DeviceIcon = isMobile ? Smartphone : Laptop;
            const kindLabel = isMobile
              ? t('vaultStatusKindMobile', language)
              : t('vaultStatusKindDesktop', language);
            // Pretty heartbeat tooltip — drives the dot's `title` so a hover
            // surfaces "last heartbeat: 2026-05-17 14:23:01" for diagnostics
            // without putting the wall clock into the visible meta row.
            let heartbeatTip = '';
            try {
              heartbeatTip = tf('vaultStatusHeartbeatTip', language, {
                when: new Date(d.lastSeenAt).toLocaleString(),
              });
            } catch { /* malformed timestamp — skip the tooltip */ }
            return (
              <div
                key={d.deviceId}
                className={`vault-status-card${isSelf ? ' is-self' : ''}${isOffline ? ' is-offline' : ''}`}
                data-kind={isMobile ? 'mobile' : 'desktop'}
              >
                <span className="vault-status-card__icon" aria-hidden="true">
                  <DeviceIcon size={20} strokeWidth={1.75} />
                </span>
                <div className="vault-status-card__body">
                  <div className="vault-status-card__title-row">
                    <strong className="vault-status-card__name">{d.hostname}</strong>
                    <span
                      className="vault-status-card__kind-badge"
                      data-kind={isMobile ? 'mobile' : 'desktop'}
                    >
                      {kindLabel}
                    </span>
                    {isOffline && (
                      <span className="vault-status-card__offline-badge">
                        {t('vaultStatusOfflinePill', language)}
                      </span>
                    )}
                    {isSelf && (
                      <span className="vault-status-card__self-badge">
                        {t('vaultStatusSelfBadge', language)}
                      </span>
                    )}
                  </div>
                  <div className="vault-status-card__meta">
                    <span
                      className="vault-status-card__status"
                      title={heartbeatTip || undefined}
                    >
                      <span
                        className="vault-status-card__dot"
                        data-tone={statusInfo.tone}
                        aria-hidden="true"
                      />
                      <span>{statusInfo.label}</span>
                    </span>
                    <span className="vault-status-card__platform">{d.os} · v{d.appVersion}</span>
                  </div>
                </div>
                {!isSelf && (
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() => handleDelete(d.deviceId, d.hostname)}
                  >
                    {t('vaultStatusRemoveBtn', language)}
                  </Button>
                )}
              </div>
            );
          })}
        </div>
        <div className="vault-status-footer">
          <Info size={12} aria-hidden="true" />
          <span>{t('vaultStatusFooterHint', language)}</span>
        </div>
      </section>
    </div>
  );
}
