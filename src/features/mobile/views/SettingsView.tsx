/**
 * SettingsView — Settings wired to Zustand store.
 * Sections: 외관, 언어, 에디터, 동기화, 볼트, 정보
 * Removed: spell check, keyboard shortcuts, storage stats, data reset, manual sync
 * Sync: always auto (즉각 동기화), no interval selection
 */
import { useState, useCallback, useMemo, useEffect } from 'react';
import { Check, ChevronRight, ChevronLeft, ExternalLink, Loader2 } from 'lucide-react';
import { useSettingsStore, settingsActions, type ThemeSetting, type FontSetting } from '../../../core/stores/settingsStore';
import { useFileTreeStore } from '../../../core/stores/fileTreeStore';
import { SegmentControl, Slider, TextInput, showToast } from '../components/common';
// v1 sync 의존성 stub (M-4b에서 v2로 재구현 예정)
const syncCommands = {
  getConfig: async () => null as any,
  getStatus: async () => ({ type: 'Disconnected' as const }),
  testConnection: async (..._args: any[]) => false,
  connect: async (..._args: any[]) => { console.warn('[mobile] sync.connect: v1 disabled'); },
  syncNow: async () => {},
};
import { useResponsiveLayout } from '../../../hooks/useResponsiveLayout';
import { colors as tokenColors } from '../../../styles/tokens/colors';
import { t } from '../../../core/utils/i18n';
import { MobileVaultSelector } from '../components/MobileVaultSelector';

const THEMES = [
  { id: 'light' as const, label: '☀ 라이트' },
  { id: 'dark' as const, label: '🌙 다크' },
  { id: 'system' as const, label: '⚙ 시스템' },
];

const LANGUAGES = [
  { id: 'ko' as const, label: '한국어' },
  { id: 'en' as const, label: 'English' },
];

const FONTS = [
  { value: 'default', label: '기본 (Pretendard)', fontFamily: "'Pretendard Variable', -apple-system, system-ui, sans-serif" },
  { value: 'nanum', label: '나눔고딕', fontFamily: "'NanumGothic', sans-serif" },
  { value: 'noto', label: 'Noto Sans KR', fontFamily: "'Noto Sans KR', sans-serif" },
];

type SubPage = null | 'font' | 'accent' | 'webdav' | 'vault-browse';
type Category = 'appearance' | 'language' | 'editor' | 'sync' | 'vault' | 'about';

const CATEGORY_ITEMS: { id: Category; label: string }[] = [
  { id: 'appearance', label: '외관' },
  { id: 'language', label: '언어' },
  { id: 'editor', label: '에디터' },
  { id: 'sync', label: '동기화' },
  { id: 'vault', label: '볼트' },
  { id: 'about', label: '정보' },
];

export default function SettingsView() {
  const theme = useSettingsStore(s => s.theme);
  const font = useSettingsStore(s => s.font);
  const language = useSettingsStore(s => s.language);
  const fontSize = useSettingsStore(s => s.fontSize);
  const lineHeight = useSettingsStore(s => s.lineHeight);
  const accentColor = useSettingsStore(s => s.accentColor);
  const vaultPath = useFileTreeStore(s => s.vaultPath);
  const navMode = useResponsiveLayout();
  const isDesktop = navMode === 'sidebar';

  const [subPage, setSubPage] = useState<SubPage>(null);
  const [selectedCategory, setSelectedCategory] = useState<Category>('appearance');

  // WebDAV state
  const [webdavUrl, setWebdavUrl] = useState('');
  const [webdavUser, setWebdavUser] = useState('');
  const [webdavPass, setWebdavPass] = useState('');
  const [webdavTesting, setWebdavTesting] = useState(false);
  const [webdavSaved, setWebdavSaved] = useState(false);
  const [remoteBase, setRemoteBase] = useState('');

  // Load existing WebDAV config on mount — try sync-config first, then nas-connections
  useEffect(() => {
    // First try sync-config (vault-specific, has all fields except password sometimes)
    syncCommands.getConfig().then(config => {
      if (config?.url) {
        setWebdavUrl(config.url);
        if (config.username) setWebdavUser(config.username);
        if (config.remote_base) setRemoteBase(config.remote_base);
        setWebdavSaved(true);
      }
    }).catch(() => {});

    // v1 nasCommands.loadConnections removed — v2 webdav-config 사용 (M-4b 재구현 예정)
  }, []);

  // Sync status — poll every 5s
  const [syncOnline, setSyncOnline] = useState<boolean | null>(null);
  useEffect(() => {
    let mounted = true;
    const checkStatus = async () => {
      try {
        const status = await syncCommands.getStatus();
        if (mounted) setSyncOnline(status.type === 'Idle' || status.type === 'Syncing');
      } catch {
        if (mounted) setSyncOnline(false);
      }
    };
    checkStatus();
    const interval = setInterval(checkStatus, 5000);
    return () => { mounted = false; clearInterval(interval); };
  }, []);

  const vaultName = vaultPath?.split(/[/\\]/).pop() ?? '선택되지 않음';

  // Handlers
  const handleTheme = useCallback((t: string) => {
    settingsActions.setTheme(t as ThemeSetting, vaultPath);
  }, [vaultPath]);

  const handleFont = useCallback((f: string) => {
    settingsActions.setFont(f as FontSetting, vaultPath);
  }, [vaultPath]);

  const handleLanguage = useCallback((l: string) => {
    settingsActions.setLanguage(l as 'ko' | 'en', vaultPath);
  }, [vaultPath]);

  const handleFontSize = useCallback((size: number) => {
    settingsActions.setFontSize(size, vaultPath);
  }, [vaultPath]);

  const handleLineHeight = useCallback((lh: string) => {
    settingsActions.setLineHeight(lh, vaultPath);
  }, [vaultPath]);

  const handleAccentColor = useCallback((index: number) => {
    settingsActions.setAccentColor(index, vaultPath);
  }, [vaultPath]);

  const handleWebdavTest = useCallback(async () => {
    if (!webdavUrl) return;
    setWebdavTesting(true);
    try {
      const ok = await syncCommands.testConnection(webdavUrl, webdavUser, webdavPass);
      showToast(ok ? '연결 성공' : '연결 실패', ok ? 'success' : 'error');
    } catch (e) {
      showToast('연결 실패: ' + String(e), 'error');
    } finally {
      setWebdavTesting(false);
    }
  }, [webdavUrl, webdavUser, webdavPass]);

  // ── Sub-pages ──

  if (subPage === 'font' && !isDesktop) {
    return (
      <div className="settings-ios settings-sub-page">
        <button className="settings-sub-back" onClick={() => setSubPage(null)}>
          <ChevronLeft size={20} /> <span>뒤로</span>
        </button>
        <h2 className="settings-sub-title">{t('font', language)}</h2>
        <div className="settings-ios-card">
          {FONTS.map((f, i) => (
            <button
              key={f.value}
              className={`settings-ios-card-item settings-ios-card-item--tap ${i < FONTS.length - 1 ? 'settings-ios-card-item--separator' : ''}`}
              onClick={() => handleFont(f.value)}
            >
              <span style={{ fontFamily: f.fontFamily }}>{f.label}</span>
              {font === f.value && <Check size={18} className="settings-ios-check" />}
            </button>
          ))}
        </div>
        <div className="settings-ios-section-label" style={{ marginTop: 24 }}>미리보기</div>
        <div className="settings-ios-card" style={{ padding: 16 }}>
          <p style={{ fontFamily: FONTS.find(f => f.value === font)?.fontFamily, fontSize, lineHeight: Number(lineHeight), color: 'var(--tx-1)' }}>
            가나다라마바사 ABCDEFG 12345<br />
            The quick brown fox jumps<br />
            한글 텍스트 미리보기
          </p>
        </div>
      </div>
    );
  }

  if (subPage === 'accent' && !isDesktop) {
    return (
      <div className="settings-ios settings-sub-page">
        <button className="settings-sub-back" onClick={() => setSubPage(null)}>
          <ChevronLeft size={20} /> <span>뒤로</span>
        </button>
        <h2 className="settings-sub-title">{t('mAccentColor', language)}</h2>
        <div className="settings-accent-grid">
          {tokenColors.folder.map((c, i) => (
            <button
              key={c}
              className={`settings-accent-swatch ${accentColor === i ? 'active' : ''}`}
              style={{ background: c, boxShadow: accentColor === i ? `0 0 0 3px var(--bg-base), 0 0 0 5px ${c}` : undefined }}
              onClick={() => handleAccentColor(i)}
            >
              {accentColor === i && <Check size={16} color="#fff" />}
            </button>
          ))}
        </div>
      </div>
    );
  }

  if (subPage === 'webdav' && !isDesktop) {
    return (
      <div className="settings-ios settings-sub-page">
        <button className="settings-sub-back" onClick={() => setSubPage(null)}>
          <ChevronLeft size={20} /> <span>뒤로</span>
        </button>
        <h2 className="settings-sub-title">{t('mWebdavServer', language)}</h2>
        {webdavSaved && (
          <div style={{ padding: '8px 20px 0', fontSize: 13, color: 'var(--c-green, #34C759)' }}>
            ● {t('mServerSaved', language)}
          </div>
        )}
        <div className="settings-ios-card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <TextInput label="서버 URL" placeholder="https://nas.example.com" value={webdavUrl} onChange={e => setWebdavUrl(e.target.value)} />
          <TextInput label="사용자명" placeholder="admin" value={webdavUser} onChange={e => setWebdavUser(e.target.value)} />
          <TextInput label="비밀번호" placeholder="••••••••" type="password" value={webdavPass} onChange={e => setWebdavPass(e.target.value)} />
        </div>
        <div style={{ padding: '16px 20px', display: 'flex', gap: 12 }}>
          <button
            className="m-new-container-btn m-new-container-btn--cancel"
            style={{ flex: 1 }}
            onClick={handleWebdavTest}
            disabled={webdavTesting || !webdavUrl}
          >
            {webdavTesting ? '테스트 중...' : '🔗 연결 테스트'}
          </button>
          <button
            className="m-new-container-btn m-new-container-btn--confirm"
            style={{ flex: 1 }}
            onClick={async () => {
              if (!webdavUrl) return;
              try {
                if (vaultPath) {
                  // Vault exists: full connect + save
                  await syncCommands.connect(webdavUrl, webdavUser, webdavPass, vaultPath);
                  setWebdavSaved(true);
                  showToast('서버 연결 및 저장 완료', 'success');
                } else {
                  // No vault yet: test connection, then go to vault browse
                  const ok = await syncCommands.testConnection(webdavUrl, webdavUser, webdavPass);
                  if (ok) {
                    setWebdavSaved(true);
                    showToast('연결 성공 — 볼트를 선택하세요', 'success');
                    setSubPage('vault-browse');
                  } else {
                    showToast('연결 실패', 'error');
                  }
                }
              } catch (e) {
                showToast('연결 실패: ' + String(e), 'error');
              }
            }}
            disabled={!webdavUrl}
          >
            저장 및 연결
          </button>
        </div>
      </div>
    );
  }

  if (subPage === 'vault-browse' && !isDesktop) {
    return (
      <MobileVaultSelector
        onBack={() => setSubPage(null)}
        onVaultSelected={async (localPath, name) => {
          setSubPage(null);
          showToast(`${t('mOpenVault', language)}: ${name}`, 'success');
          try {
            const { openVault } = await import('../../../core/stores/appActions');
            await openVault(localPath);
          } catch (e) {
            console.error('[SettingsView] openVault failed:', e);
            showToast('볼트 열기 실패: ' + String(e), 'error');
          }
        }}
        initialCredentials={webdavUrl && webdavUser ? { url: webdavUrl, username: webdavUser, password: webdavPass } : undefined}
      />
    );
  }

  // ── Section renderers ──

  const renderSection = (section: Category) => {
    switch (section) {
      case 'appearance':
        return (
          <div className="settings-ios-section">
            <div className="settings-ios-section-label">{t('appearance', language)}</div>
            <div className="settings-ios-card">
              <div className="settings-ios-card-item" style={{ padding: '12px 16px' }}>
                <span className="settings-ios-card-label">{t('theme', language)}</span>
                <SegmentControl segments={THEMES} value={theme} onChange={handleTheme} />
              </div>
              <div className="settings-ios-card-item settings-ios-card-item--separator settings-ios-card-item--tap" onClick={() => setSubPage('accent')}>
                <span className="settings-ios-card-label">{t('mAccentColor', language)}</span>
                <span className="settings-ios-card-value">
                  <span className="settings-accent-dot" style={{ background: tokenColors.folder[accentColor] }} />
                  <ChevronRight size={14} style={{ opacity: 0.3 }} />
                </span>
              </div>
            </div>
          </div>
        );
      case 'language':
        return (
          <div className="settings-ios-section">
            <div className="settings-ios-section-label">{t('language', language)}</div>
            <div className="settings-ios-card">
              <div className="settings-ios-card-item" style={{ padding: '12px 16px', justifyContent: 'center' }}>
                <SegmentControl segments={LANGUAGES} value={language} onChange={handleLanguage} />
              </div>
            </div>
          </div>
        );
      case 'editor':
        return (
          <div className="settings-ios-section">
            <div className="settings-ios-section-label">{t('editor', language)}</div>
            <div className="settings-ios-card">
              <div className="settings-ios-card-item settings-ios-card-item--separator settings-ios-card-item--tap" onClick={() => setSubPage('font')}>
                <span className="settings-ios-card-label">{t('font', language)}</span>
                <span className="settings-ios-card-value">
                  {FONTS.find(f => f.value === font)?.label ?? '기본'}
                  <ChevronRight size={14} style={{ opacity: 0.3 }} />
                </span>
              </div>
              <div className="settings-ios-card-item settings-ios-card-item--separator" style={{ padding: '12px 16px' }}>
                <span className="settings-ios-card-label">{t('mFontSize', language)}</span>
                <Slider min={12} max={24} value={fontSize} onChange={handleFontSize} label={`${fontSize}px`} />
              </div>
              <div className="settings-ios-card-item" style={{ padding: '12px 16px' }}>
                <span className="settings-ios-card-label">{t('mLineHeight', language)}</span>
                <div className="m-line-height-selector">
                  {['1.4', '1.6', '1.8', '2.0'].map(lh => (
                    <button
                      key={lh}
                      className={`m-line-height-btn ${lineHeight === lh ? 'active' : ''}`}
                      onClick={() => handleLineHeight(lh)}
                    >{lh}</button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        );
      case 'sync':
        return (
          <div className="settings-ios-section">
            <div className="settings-ios-section-label">{t('mSync', language)}</div>
            <div className="settings-ios-card">
              <div className="settings-ios-card-item settings-ios-card-item--separator settings-ios-card-item--tap" onClick={() => setSubPage('webdav')}>
                <span className="settings-ios-card-label">{t('mWebdavServer', language)}</span>
                <span className="settings-ios-card-value">
                  {webdavSaved && webdavUrl ? (
                    <span className="settings-ios-card-value-text" style={{ maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'inline-block' }}>
                      {webdavUrl.replace(/^https?:\/\//, '')}
                    </span>
                  ) : null}
                  <ChevronRight size={14} style={{ opacity: 0.3 }} />
                </span>
              </div>
              <div className="settings-ios-card-item">
                <span className="settings-ios-card-label">{t('mSyncStatus', language)}</span>
                <span className="settings-ios-card-value-text" style={{ color: syncOnline ? 'var(--c-green, #34C759)' : syncOnline === false ? 'var(--c-red, #FF3B30)' : 'var(--tx-3)' }}>
                  {syncOnline === null ? t('mChecking', language) : syncOnline ? `● ${t('mOnline', language)}` : `● ${t('mOffline', language)}`}
                </span>
              </div>
            </div>
          </div>
        );
      case 'vault':
        return (
          <div className="settings-ios-section">
            <div className="settings-ios-section-label">{t('mVaultLabel', language)}</div>
            <div className="settings-ios-card">
              <div className="settings-ios-card-item settings-ios-card-item--tap" onClick={() => setSubPage('vault-browse')}>
                <span className="settings-ios-card-label">{t('mVaultPath', language)}</span>
                <span className="settings-ios-card-value">
                  <span className="settings-ios-card-value-text">{vaultName}</span>
                  <ChevronRight size={14} style={{ opacity: 0.3 }} />
                </span>
              </div>
            </div>
          </div>
        );
      case 'about':
        return (
          <div className="settings-ios-section">
            <div className="settings-ios-section-label">{t('mInfo', language)}</div>
            <div className="settings-ios-card">
              <div className="settings-ios-card-item settings-ios-card-item--separator">
                <span className="settings-ios-card-label">{t('mVersion', language)}</span>
                <span className="settings-ios-card-value-text">v3.0.0</span>
              </div>
              <div className="settings-ios-card-item settings-ios-card-item--separator">
                <span className="settings-ios-card-label">{t('mCreator', language)}</span>
                <span className="settings-ios-card-value-text">Notology Team</span>
              </div>
              <div className="settings-ios-card-item settings-ios-card-item--tap">
                <span className="settings-ios-card-label">GitHub</span>
                <span className="settings-ios-card-value"><ExternalLink size={14} style={{ opacity: 0.3 }} /></span>
              </div>
            </div>
          </div>
        );
    }
  };

  // Desktop split view
  if (isDesktop) {
    return (
      <div className="settings-split">
        <aside className="settings-split-nav">
          {CATEGORY_ITEMS.map(c => (
            <button
              key={c.id}
              className={`settings-split-nav-item ${selectedCategory === c.id ? 'active' : ''}`}
              onClick={() => setSelectedCategory(c.id)}
            >{c.label}</button>
          ))}
        </aside>
        <div className="settings-split-content">
          {renderSection(selectedCategory)}
        </div>
      </div>
    );
  }

  // Mobile scroll
  return (
    <div className="settings-ios">
      <h1 className="settings-ios-title">{t('settings', language)}</h1>
      {CATEGORY_ITEMS.map(c => <div key={c.id}>{renderSection(c.id)}</div>)}
      <div style={{ height: 24 }} />
    </div>
  );
}
