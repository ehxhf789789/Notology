import { syncV2Commands, type VaultRepairReport } from '../attachments/attachmentCommands';
import { useState, useEffect, useMemo, useCallback, useSyncExternalStore } from 'react';
import { SettingsRegistry } from './SettingsRegistry';
import { Toggle, Button } from '../../design-system/components';

// Feature plugin registrations (side-effect imports done in main.tsx)
import { useVaultPath } from '../../core/stores/fileTreeStore';
import { useSettingsStore, type ThemeSetting, type FontSetting, type LanguageSetting, type CustomFont } from '../../core/stores/settingsStore';
import { useTemplateStore } from '../templates/stores/templateStore';
import { refreshActions } from '../../core/stores/refreshStore';
import { t, tf } from '../../core/utils/i18n';
import NoteTemplateEditor from '../templates/NoteTemplateEditor';
import KeyboardShortcuts from './KeyboardShortcuts';
import { SettingsRow } from './SettingsRow';
import { TemplateMigrationModal } from '../templates/TemplateMigrationModal';
import { useUnmatchedNoteTypes, noteTypeCacheActions } from '../content-cache/stores/noteTypeCacheStore';
import type { NoteTemplate } from '../../core/types';
import { getUnusedTags, removeUnusedTags } from '../tags/tagOntologyUtils';
import { Moon, Sun, Monitor, X, SlidersHorizontal, Palette, FileEdit, AppWindow, FileText, Keyboard, Wrench, Pencil, Trash2, Puzzle, Plus, Type as TypeIcon, Save, Languages, Hash, ToggleLeft, Share2, AlertTriangle } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

// 5.0.6ah (2026-05-17, HanBin) — WINDOW_SIZE_PRESETS removed. The
// preset picker was a dummy: setHoverDefaultSize() wrote to the store
// but no hover-window-creation code path ever read those values back.
// Restoring the picker as a real feature needs hover-window integration
// on the OPEN side; deferred until that work happens.

interface SettingsProps {
  onClose: () => void;
}

type SettingsTab = string;

function Settings({ onClose }: SettingsProps) {
  const vaultPath = useVaultPath();
  const {
    toolbarDefaultCollapsed, setToolbarDefaultCollapsed,
    hoverZoomEnabled, setHoverZoomEnabled, hoverZoomLevel, setHoverZoomLevel,
    theme, setTheme, font, setFont, customFonts, selectedCustomFont, addCustomFont, removeCustomFont, language, setLanguage,
    devMode, setDevMode,
    confirmAttachmentDelete, setConfirmAttachmentDelete,
    autoSaveDelay, setAutoSaveDelay,
    // 5.0.6ah — fontSize / lineHeight / spellCheck removed: their store
    // values were never consumed by any editor surface, so the toggles
    // they powered in Settings were dummies.
    // v22 (2026-05-23) — graphSettings UI surfaces removed from this dialog;
    // controls live in GraphView's own overlay. Store values still mutated
    // by GraphView, so the destructure here is intentionally absent.
  } = useSettingsStore();
  const {
    noteTemplates, enabledTemplateIds, addNoteTemplate, updateNoteTemplate, removeNoteTemplate, toggleTemplateEnabled,
    customShortcuts, setCustomShortcuts,
  } = useTemplateStore();
  const [activeTab, setActiveTab] = useState<SettingsTab>('general');
  const [editingNoteTemplate, setEditingNoteTemplate] = useState<NoteTemplate | null>(null);
  const [isCreatingNoteTemplate, setIsCreatingNoteTemplate] = useState(false);
  const [newFontName, setNewFontName] = useState('');
  const [newFontFamily, setNewFontFamily] = useState('');
  const [showAddFontModal, setShowAddFontModal] = useState(false);

  // 5.0.5a-migration — entry to TemplateMigrationModal + live count badge.
  // Refresh on mount so the badge reflects current vault state.
  const [showMigrationModal, setShowMigrationModal] = useState(false);
  const unmatchedTypes = useUnmatchedNoteTypes();
  const unmatchedCount = Array.from(unmatchedTypes.values()).reduce((a, b) => a + b, 0);
  useEffect(() => { noteTypeCacheActions.refreshCache(); }, []);

  // Unused tag cleanup state
  const [unusedTags, setUnusedTags] = useState<string[]>([]);
  const [isLoadingUnused, setIsLoadingUnused] = useState(false);
  const [showUnusedTagsModal, setShowUnusedTagsModal] = useState(false);

  // Load unused tags
  const handleLoadUnusedTags = useCallback(async () => {
    if (!vaultPath) return;
    setIsLoadingUnused(true);
    try {
      const tags = await getUnusedTags(vaultPath);
      setUnusedTags(tags);
      setShowUnusedTagsModal(true);
    } catch (error) {
      console.error('Failed to load unused tags:', error);
    } finally {
      setIsLoadingUnused(false);
    }
  }, [vaultPath]);

  // Remove selected unused tags
  const handleRemoveUnusedTags = useCallback(async (tagIds: string[]) => {
    if (!vaultPath || tagIds.length === 0) return;
    try {
      await removeUnusedTags(vaultPath, tagIds);
      // Refresh the list
      const remaining = unusedTags.filter(t => !tagIds.includes(t));
      setUnusedTags(remaining);
      refreshActions.incrementOntologyRefresh();
      if (remaining.length === 0) {
        setShowUnusedTagsModal(false);
      }
    } catch (error) {
      console.error('Failed to remove unused tags:', error);
    }
  }, [vaultPath, unusedTags]);

  // 5.0.6ah — currentSizePreset memo removed alongside the dummy
  // WINDOW_SIZE_PRESETS picker.

  // Plugin tabs from SettingsRegistry
  const pluginTabs = useSyncExternalStore(
    SettingsRegistry.subscribe,
    SettingsRegistry.getPlugins,
  );

  // 5.0.6b (2026-05-17, HanBin) — tabs now declare a lucide icon. Replaces
  // the inconsistent state where built-in tabs were text-only and plugin
  // tabs jammed an emoji onto the label string ("🔄 Sync"). Plugin tabs
  // can still ship an emoji via `plugin.icon` as a fallback when they
  // don't pre-pack a lucide name, but every built-in uses lucide for
  // visual consistency with the rest of the app chrome.
  // 5.0.6c (2026-05-17, HanBin) — 8-tab structure. Splits Appearance out
  // of General (was: theme/font/lang lumped together) and pulls Window
  // out of Editor (was: editor toolbar + popup zoom + default size all
  // crammed into "Editor"). Each tab now has one clear concern.
  const TABS: { id: SettingsTab; label: string; Icon: LucideIcon; emoji?: string }[] = [
    { id: 'general',    label: t('general', language),    Icon: SlidersHorizontal },
    { id: 'appearance', label: t('appearance', language), Icon: Palette },
    { id: 'editor',     label: t('editor', language),     Icon: FileEdit },
    { id: 'window',     label: t('window', language),     Icon: AppWindow },
    { id: 'templates',  label: t('templates', language),  Icon: FileText },
    { id: 'shortcuts',  label: t('shortcuts', language),  Icon: Keyboard },
    ...pluginTabs.map(p => ({
      id: p.id,
      // 5.0.6d — plugin label can be a string or resolver function.
      // Resolver pattern lets the label react to language switches.
      label: typeof p.label === 'function' ? p.label() : p.label,
      Icon: p.Icon ?? Puzzle,
      emoji: p.Icon ? undefined : p.icon,
    })),
  ];

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') onClose();
  };

  const handleAddFont = () => {
    if (newFontName.trim() && newFontFamily.trim()) {
      const fontData: CustomFont = {
        name: newFontName.trim(),
        family: newFontFamily.trim(),
      };
      addCustomFont(fontData, vaultPath);
      setNewFontName('');
      setNewFontFamily('');
      setShowAddFontModal(false);
    }
  };

  return (
    <div className="settings-overlay" onClick={handleBackdropClick} onKeyDown={handleKeyDown}>
      <div className="settings-modal">
        <div className="settings-modal-header">
          <h2 className="settings-modal-title">{t('settings', language)}</h2>
          <button
            className="settings-modal-close"
            onClick={onClose}
            aria-label={t('close', language)}
            title={t('close', language)}
          >
            <X size={16} strokeWidth={2} />
          </button>
        </div>

        <div className="settings-modal-content">
          {/* Tab Navigation */}
          <nav className="settings-tabs">
            {TABS.map((tab) => {
              const TabIcon = tab.Icon;
              return (
                <button
                  key={tab.id}
                  className={`settings-tab ${activeTab === tab.id ? 'active' : ''}`}
                  onClick={() => setActiveTab(tab.id)}
                >
                  <TabIcon size={14} strokeWidth={2} aria-hidden="true" />
                  <span className="settings-tab-label">{tab.label}</span>
                  {tab.emoji && <span className="settings-tab-emoji" aria-hidden="true">{tab.emoji}</span>}
                </button>
              );
            })}
          </nav>

          {/* Tab Content */}
          <div className="settings-tab-content">
            {activeTab === 'appearance' && (
              <div className="settings-panel">
                <section className="settings-section">
                  <h3 className="settings-section-title">
                    <Palette size={14} strokeWidth={2} aria-hidden="true" />
                    <span>{t('appearance', language)}</span>
                  </h3>
                  <SettingsRow label={t('theme', language)} description={t('themeDesc', language)}>
                    <div className="settings-theme-toggle">
                      {(['dark', 'light', 'system'] as const).map(mode => (
                        <button
                          key={mode}
                          className={`settings-theme-btn${theme === mode ? ' active' : ''}`}
                          onClick={() => setTheme(mode, vaultPath)}
                        >
                          {mode === 'dark' ? <Moon size={14} /> : mode === 'light' ? <Sun size={14} /> : <Monitor size={14} />}
                          {t(`theme${mode.charAt(0).toUpperCase() + mode.slice(1)}` as any, language)}
                        </button>
                      ))}
                    </div>
                  </SettingsRow>
                  {/* 5.0.6ah (2026-05-17, HanBin) — dummy rows removed.
                      HanBin: "실제 동작하지 않는다면, 이런 방식의 더미
                      기능은 모두 제거해. 실제로 동작가능하고 변경할 수
                      있는 기능만 설정창에 구비하라고." Audit found:
                        • spellCheck — editor hardcodes `spellcheck='false'`
                                       (editorPool / ContainerView); store
                                       value is never read. Toggle had
                                       zero effect.
                        • fontSize  — store has setter but no consumer
                                       (only mobile SettingsView uses it,
                                       desktop editor ignores).
                        • lineHeight — same as fontSize.
                      Rows + the corresponding store hooks (fontSize /
                      lineHeight / spellCheck) are gone from this UI. The
                      store fields stay for now so persisted vault config
                      doesn't blow up; a later cleanup can drop them
                      entirely once consumer side is wired or confirmed
                      dead. */}
                  <SettingsRow label={t('font', language)} description={t('fontDesc', language)}>
                    <select
                      className="settings-select"
                      value={font === 'custom' ? `custom:${selectedCustomFont}` : font}
                      onChange={e => {
                        const value = e.target.value;
                        if (value.startsWith('custom:')) {
                          const fontName = value.replace('custom:', '');
                          setFont('custom', vaultPath, fontName);
                        } else {
                          setFont(value as FontSetting, vaultPath);
                        }
                      }}
                    >
                      <option value="default">{t('fontDefault', language)}</option>
                      <option value="nanum">Nanum Gothic</option>
                      <option value="noto">Noto Sans KR</option>
                      <option value="malgun">Malgun Gothic</option>
                      {customFonts.map(cf => (
                        <option key={cf.name} value={`custom:${cf.name}`}>{cf.name}</option>
                      ))}
                    </select>
                  </SettingsRow>

                  {/* 5.0.6b (2026-05-17, HanBin) — Custom Fonts row uses the
                      block variant so the registered-font list sits BELOW the
                      "+ 추가" button instead of overflowing the row's flex
                      layout. Previously the list rendered as a sibling of
                      the row, breaking the section's visual hierarchy. */}
                  <div className="settings-row settings-row--block">
                    <div className="settings-row-info settings-row-info--inline">
                      <span className="settings-row-label">{t('customFonts', language)}</span>
                      <span className="settings-row-desc">{t('addSystemFont', language)}</span>
                      <button
                        className="settings-action-btn"
                        onClick={() => setShowAddFontModal(true)}
                      >
                        + {t('addFont', language)}
                      </button>
                    </div>
                    {customFonts.length > 0 && (
                      <div className="custom-fonts-list">
                        {customFonts.map(cf => (
                          <div key={cf.name} className="custom-font-item">
                            <span className="custom-font-name" style={{ fontFamily: cf.family }}>{cf.name}</span>
                            <span className="custom-font-family">{cf.family}</span>
                            <button
                              className="custom-font-remove"
                              onClick={() => removeCustomFont(cf.name, vaultPath)}
                              title={t('removeFont', language)}
                              aria-label={t('removeFont', language)}
                            >
                              <X size={12} strokeWidth={2} />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </section>

              </div>
            )}

            {activeTab === 'general' && (
              <div className="settings-panel">
                <section className="settings-section">
                  <h3 className="settings-section-title">
                    <Languages size={14} strokeWidth={2} aria-hidden="true" />
                    <span>{t('languageRegion', language)}</span>
                  </h3>
                  <SettingsRow label={t('language', language)} description={t('languageDesc', language)}>
                    <select
                      className="settings-select"
                      value={language}
                      onChange={e => setLanguage(e.target.value as LanguageSetting, vaultPath)}
                    >
                      <option value="ko">한국어</option>
                      <option value="en">English</option>
                    </select>
                  </SettingsRow>
                </section>

                {/* 5.0.6h Phase 1 (2026-05-17, HanBin) — Settings was the
                    "main control" surface but General had only one row.
                    Auto-save delay was defined in settingsStore but had no
                    UI; the editor saved on a hard-coded 1000ms regardless
                    of the stored value. Exposing it here makes it a real
                    knob. Stepped select (250/500/1000/2000/4000) matches
                    the actual useful range — sub-second loses NAS write
                    coalescing, multi-second feels laggy. */}
                {/* 🔴 **자동저장 지연 설정을 없앴다** (사용자 지적, 2026-08-12:
                    *"자동저장 지연 설정도 로컬 플랫폼의 잔재가 아닌가?"*).

                    맞다. 그리고 그보다 나쁘다 — **아무 일도 하지 않고
                    있었다.** `autoSaveDelay` 는 저장되고 불러와지는데
                    **읽는 편집기가 하나도 없다** (실측: `useAutoSaveDelay`
                    를 쓰는 곳 0곳). 있는 척하는 손잡이는 없느니만 못하다.

                    되살릴 이유도 없다. 기기가 여럿인 지금(2-14-15) 저장
                    간격을 짧게 잡으면 **충돌만 늘어난다.** 저장 시점은
                    사람이 조절할 것이 아니라 서버가 지킬 것이다. */}
              </div>
            )}

            {activeTab === 'editor' && (
              <div className="settings-panel">
                <section className="settings-section">
                  <h3 className="settings-section-title">
                    <FileEdit size={14} strokeWidth={2} aria-hidden="true" />
                    <span>{t('editingToolbar', language)}</span>
                  </h3>
                  <SettingsRow label={t('defaultCollapsed', language)} description={t('defaultCollapsedDesc', language)}>
                    <Toggle
                      checked={toolbarDefaultCollapsed}
                      onChange={e => setToolbarDefaultCollapsed(e.currentTarget.checked, vaultPath)}
                      aria-label={t('defaultCollapsed', language)}
                    />
                  </SettingsRow>
                  {/* Track B Phase B-3 PART 6 (HanBin 2026-05-13): toggle the
                      attachment-deletion confirmation modal. */}
                  <SettingsRow label={t('confirmAttachmentDeleteLabel', language)} description={t('confirmAttachmentDeleteHint', language)}>
                    <Toggle
                      checked={confirmAttachmentDelete}
                      onChange={e => setConfirmAttachmentDelete(e.currentTarget.checked, vaultPath)}
                      aria-label={t('confirmAttachmentDeleteLabel', language)}
                    />
                  </SettingsRow>
                </section>

                {/* 5.0.6b (2026-05-17, HanBin) — Suggestion Triggers moved here
                    from the Shortcuts tab. The `[[` / `//` / `/` triggers are
                    INPUT semantics inside the editor — they belong with editor
                    settings, not with key-binding configuration. The `@` row
                    was removed because mention is not actually wired. */}
                <section className="settings-section">
                  <h3 className="settings-section-title">
                    <Hash size={14} strokeWidth={2} aria-hidden="true" />
                    <span>{t('suggestionTriggers', language)}</span>
                  </h3>
                  <p className="settings-section-desc">{t('suggestionTriggersDesc', language)}</p>
                  <div className="suggestion-triggers-list">
                    <div className="suggestion-trigger-item">
                      <code className="trigger-code">[[</code>
                      <span className="trigger-desc">{t('triggerWikiLink', language)}</span>
                    </div>
                    <div className="suggestion-trigger-item">
                      <code className="trigger-code">//</code>
                      <span className="trigger-desc">{t('triggerAttachment', language)}</span>
                    </div>
                    <div className="suggestion-trigger-item">
                      <code className="trigger-code">/</code>
                      <span className="trigger-desc">{t('triggerSlash', language)}</span>
                    </div>
                  </div>
                </section>

                {/* v22 (HanBin 2026-05-23) — graph section removed.
                    Reason: every graph control (toggles, sliders, reset)
                    now lives in the graph-tab's own overlay panel where
                    the user sees live preview. Duplicating two of those
                    toggles here was confusing and inverted the "one
                    canonical control" rule. Settings keeps the data
                    (graphSettings store) but no UI surface here. */}
              </div>
            )}

            {activeTab === 'window' && (
              <div className="settings-panel">
                <section className="settings-section">
                  <h3 className="settings-section-title">
                    <AppWindow size={14} strokeWidth={2} aria-hidden="true" />
                    <span>{t('popupWindow', language)}</span>
                  </h3>
                  <SettingsRow label={t('ctrlScrollZoom', language)} description={t('ctrlScrollZoomDesc', language)}>
                    <Toggle
                      checked={hoverZoomEnabled}
                      onChange={e => setHoverZoomEnabled(e.currentTarget.checked, vaultPath)}
                      aria-label={t('ctrlScrollZoom', language)}
                    />
                  </SettingsRow>
                  {hoverZoomEnabled && (
                    <SettingsRow
                      label={t('currentZoomLevel', language)}
                      description={`${hoverZoomLevel}% (50% – 200%)`}
                    >
                      <input
                        type="range"
                        className="settings-range"
                        min={50}
                        max={200}
                        step={10}
                        value={hoverZoomLevel}
                        onChange={e => setHoverZoomLevel(parseInt(e.target.value, 10), vaultPath)}
                        aria-label={t('currentZoomLevel', language)}
                      />
                    </SettingsRow>
                  )}
                  {/* 5.0.6ah — "기본 창 크기" preset grid removed. Audit
                      found hoverDefaultWidth / hoverDefaultHeight have
                      zero consumers outside settingsStore + this Settings
                      UI. setHoverDefaultSize() persisted a value that
                      hover-window creation never read, so the picker was
                      a dummy. */}
                </section>
              </div>
            )}

            {/* 🔴 **템플릿·TYPE 은 dobbin 이 관리한다** (2-2-0, 사용자 재확인
                2026-08-12: *"설정창에서 dobbin이 템플릿·타입·태그를 모두
                관리하므로 수동 수정 관련은 모두 제거"*).

                두 곳에서 같은 것을 고치면 어긋난다. 만드는 것도 고치는 것도
                dobbin이 하고, 사람은 **볼 수 있어야 한다** — 볼 수 없으면
                2-2-0의 규율 ⑤("사람은 볼 수 있다")가 성립하지 않는다. */}
            {activeTab === 'templates' && (
              <div className="settings-panel">
                <section className="settings-section">
                  <h3 className="settings-section-title">
                    <FileText size={14} strokeWidth={2} aria-hidden="true" />
                    <span>노트 종류 (dobbin 관리)</span>
                  </h3>
                  <p className="settings-hint">
                    종류와 템플릿은 dobbin이 보관소를 재서 관리합니다.
                    바꾸시려면 dobbin에게 말씀하십시오 — 두 곳에서 고치면 어긋납니다.
                  </p>
                  <div className="tpl-readonly">
                    {noteTemplates.map((tpl) => (
                      <div className="tpl-readonly__row" key={tpl.id}>
                        <span className="tpl-readonly__dot"
                              style={{ background: tpl.customColor || 'var(--tx-3)' }} />
                        <span className="tpl-readonly__prefix">{tpl.prefix}</span>
                        <span className="tpl-readonly__name">{tpl.name}</span>
                        <span className="tpl-readonly__pattern">{tpl.namePattern}</span>
                      </div>
                    ))}
                  </div>
                </section>
              </div>
            )}

            {activeTab === 'shortcuts' && (
              <div className="settings-panel">
                {/* 5.0.6b (2026-05-17, HanBin) — Suggestion Triggers section
                    moved out to the Editor tab. Keybindings only here.
                    The `@` mention trigger was removed entirely — mention
                    UI is not wired and the row was misleading. */}
                <KeyboardShortcuts
                  customShortcuts={customShortcuts}
                  onUpdateShortcuts={(shortcuts) => setCustomShortcuts(shortcuts, vaultPath)}
                />
              </div>
            )}

            {/* 🔴 개발자 탭 제거 — 보관소 복구·개발자 모드는 데스크톱 시절의
                잔재다. 웹에서는 dobbin이 감시하고 고친다 (consistency.py). */}

            {pluginTabs.map(plugin => (
              activeTab === plugin.id ? <plugin.component key={plugin.id} /> : null
            ))}

          </div>
        </div>
      </div>

      {/* 5.0.5a-migration — unidentified-template migration modal */}
      <TemplateMigrationModal
        open={showMigrationModal}
        onClose={() => setShowMigrationModal(false)}
      />

      {/* Add Font Modal */}
      {showAddFontModal && (
        <div className="settings-modal-overlay" onClick={() => setShowAddFontModal(false)}>
          <div className="add-font-modal" onClick={e => e.stopPropagation()}>
            <h3>{t('addFont', language)}</h3>
            <div className="add-font-form">
              <label>
                {t('fontNameLabel', language)}
                <input
                  type="text"
                  value={newFontName}
                  onChange={e => setNewFontName(e.target.value)}
                  placeholder={t('fontNamePlaceholder', language)}
                />
              </label>
              <label>
                {t('fontFamilyLabel', language)}
                <input
                  type="text"
                  value={newFontFamily}
                  onChange={e => setNewFontFamily(e.target.value)}
                  placeholder={t('fontFamilyPlaceholder', language)}
                />
              </label>
              <div className="add-font-help">
                <p className="add-font-help-title">
                  {t('howToUse', language)}
                </p>
                <ol className="add-font-help-list">
                  <li>{t('fontNameTip', language)}</li>
                  <li>{t('fontFamilyTip', language)}</li>
                </ol>
                <p className="add-font-help-example">
                  {t('examplesLabel', language)}
                </p>
                <ul className="add-font-example-list">
                  <li><code>"D2Coding"</code></li>
                  <li><code>"Noto Sans KR", sans-serif</code></li>
                  <li><code>"JetBrains Mono", monospace</code></li>
                </ul>
              </div>
              <div className="add-font-actions">
                <button onClick={() => setShowAddFontModal(false)}>{t('cancel', language)}</button>
                <button onClick={handleAddFont} className="primary">{t('save', language)}</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Unused Tags Modal */}
      {showUnusedTagsModal && (
        <div className="settings-modal-overlay" onClick={() => setShowUnusedTagsModal(false)}>
          <div className="unused-tags-modal" onClick={e => e.stopPropagation()}>
            <h3>{t('unusedTags', language)}</h3>
            {unusedTags.length === 0 ? (
              <p className="unused-tags-empty">
                {t('noUnusedTags', language)}
              </p>
            ) : (
              <>
                <p className="unused-tags-info">
                  {tf('unusedTagsMsg', language, { count: unusedTags.length })}
                </p>
                <div className="unused-tags-list">
                  {unusedTags.map(tagId => (
                    <div key={tagId} className="unused-tag-item">
                      <span className="unused-tag-name">#{tagId}</span>
                      <button
                        className="unused-tag-remove"
                        onClick={() => handleRemoveUnusedTags([tagId])}
                        title={t('remove', language)}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
                <div className="unused-tags-actions">
                  <button onClick={() => setShowUnusedTagsModal(false)}>
                    {t('close', language)}
                  </button>
                  <button
                    className="danger"
                    onClick={() => handleRemoveUnusedTags(unusedTags)}
                  >
                    {tf('removeAll', language, { count: unusedTags.length })}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default Settings;

// 🔴 VaultRepairSection을 걷어냈다. WebDAV 동기화가 깨졌을 때 보관함을
//    고치던 화면인데, web notology는 동기화를 하지 않는다 — 서버가 NAS를
//    직접 들고 있어 어긋날 두 벌이 없다.
