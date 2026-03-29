import { useState, useMemo, useCallback, useSyncExternalStore } from 'react';
import { SettingsRegistry } from './SettingsRegistry';

// Feature plugin registrations (side-effect imports)
import '../sync/index';
import { useVaultPath } from '../../core/stores/fileTreeStore';
import { useSettingsStore, type ThemeSetting, type FontSetting, type LanguageSetting, type CustomFont } from '../../core/stores/settingsStore';
import { useTemplateStore } from '../templates/stores/templateStore';
import { refreshActions } from '../../core/stores/refreshStore';
import { t, tf } from '../../core/utils/i18n';
import NoteTemplateEditor from '../templates/NoteTemplateEditor';
import KeyboardShortcuts from './KeyboardShortcuts';
import type { NoteTemplate } from '../../core/types';
import { getUnusedTags, removeUnusedTags } from '../tags/tagOntologyUtils';
import { Moon, Sun, Monitor } from 'lucide-react';

interface WindowSizePreset {
  id: string;
  labelKey: 'windowSizeSmall' | 'windowSizeMedium' | 'windowSizeLarge' | 'windowSizeWide';
  width: number;
  height: number;
}

const WINDOW_SIZE_PRESETS: WindowSizePreset[] = [
  { id: 'small', labelKey: 'windowSizeSmall', width: 600, height: 500 },
  { id: 'medium', labelKey: 'windowSizeMedium', width: 800, height: 600 },
  { id: 'large', labelKey: 'windowSizeLarge', width: 1000, height: 800 },
  { id: 'wide', labelKey: 'windowSizeWide', width: 1200, height: 700 },
];

interface SettingsProps {
  onClose: () => void;
}

type SettingsTab = string;

function Settings({ onClose }: SettingsProps) {
  const vaultPath = useVaultPath();
  const {
    toolbarDefaultCollapsed, setToolbarDefaultCollapsed,
    hoverZoomEnabled, setHoverZoomEnabled, hoverZoomLevel, hoverDefaultWidth, hoverDefaultHeight, setHoverDefaultSize,
    theme, setTheme, font, setFont, customFonts, selectedCustomFont, addCustomFont, removeCustomFont, language, setLanguage,
    devMode, setDevMode,
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

  // Find current size preset
  const currentSizePreset = useMemo(() => {
    return WINDOW_SIZE_PRESETS.find(
      p => p.width === hoverDefaultWidth && p.height === hoverDefaultHeight
    )?.id || 'custom';
  }, [hoverDefaultWidth, hoverDefaultHeight]);

  // Plugin tabs from SettingsRegistry
  const pluginTabs = useSyncExternalStore(
    SettingsRegistry.subscribe,
    SettingsRegistry.getPlugins,
  );

  const TABS: { id: SettingsTab; label: string }[] = [
    { id: 'general', label: t('general', language) },
    { id: 'editor', label: t('editor', language) },
    { id: 'templates', label: t('templates', language) },
    { id: 'shortcuts', label: t('shortcuts', language) },
    ...pluginTabs.map(p => ({ id: p.id, label: (p.icon ? p.icon + ' ' : '') + p.label })),
    { id: 'developer', label: t('developer', language) },
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
          <button className="settings-modal-close" onClick={onClose}>×</button>
        </div>

        <div className="settings-modal-content">
          {/* Tab Navigation */}
          <nav className="settings-tabs">
            {TABS.map((tab) => (
              <button
                key={tab.id}
                className={`settings-tab ${activeTab === tab.id ? 'active' : ''}`}
                onClick={() => setActiveTab(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </nav>

          {/* Tab Content */}
          <div className="settings-tab-content">
            {activeTab === 'general' && (
              <div className="settings-panel">
                <section className="settings-section">
                  <h3 className="settings-section-title">{t('appearance', language)}</h3>
                  <div className="settings-row">
                    <div className="settings-row-info">
                      <span className="settings-row-label">{t('theme', language)}</span>
                      <span className="settings-row-desc">{t('themeDesc', language)}</span>
                    </div>
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
                  </div>
                  <div className="settings-row">
                    <div className="settings-row-info">
                      <span className="settings-row-label">{t('font', language)}</span>
                      <span className="settings-row-desc">{t('fontDesc', language)}</span>
                    </div>
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
                  </div>

                  {/* Custom Fonts Section */}
                  <div className="settings-row">
                    <div className="settings-row-info">
                      <span className="settings-row-label">{t('customFonts', language)}</span>
                      <span className="settings-row-desc">{t('addSystemFont', language)}</span>
                    </div>
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
                          >
                            ×
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </section>

                <section className="settings-section">
                  <h3 className="settings-section-title">{t('languageRegion', language)}</h3>
                  <div className="settings-row">
                    <div className="settings-row-info">
                      <span className="settings-row-label">{t('language', language)}</span>
                      <span className="settings-row-desc">{t('languageDesc', language)}</span>
                    </div>
                    <select
                      className="settings-select"
                      value={language}
                      onChange={e => setLanguage(e.target.value as LanguageSetting, vaultPath)}
                    >
                      <option value="ko">한국어</option>
                      <option value="en">English</option>
                    </select>
                  </div>
                </section>
              </div>
            )}

            {activeTab === 'editor' && (
              <div className="settings-panel">
                <section className="settings-section">
                  <h3 className="settings-section-title">{t('editingToolbar', language)}</h3>
                  <div className="settings-row">
                    <div className="settings-row-info">
                      <span className="settings-row-label">{t('defaultCollapsed', language)}</span>
                      <span className="settings-row-desc">{t('defaultCollapsedDesc', language)}</span>
                    </div>
                    <button
                      className={`settings-toggle-btn ${toolbarDefaultCollapsed ? 'active' : ''}`}
                      onClick={() => setToolbarDefaultCollapsed(!toolbarDefaultCollapsed, vaultPath)}
                    >
                      {toolbarDefaultCollapsed ? t('on', language) : t('off', language)}
                    </button>
                  </div>
                </section>

                <section className="settings-section">
                  <h3 className="settings-section-title">{t('popupWindow', language)}</h3>
                  <div className="settings-row">
                    <div className="settings-row-info">
                      <span className="settings-row-label">{t('ctrlScrollZoom', language)}</span>
                      <span className="settings-row-desc">{t('ctrlScrollZoomDesc', language)}</span>
                    </div>
                    <button
                      className={`settings-toggle-btn ${hoverZoomEnabled ? 'active' : ''}`}
                      onClick={() => setHoverZoomEnabled(!hoverZoomEnabled, vaultPath)}
                    >
                      {hoverZoomEnabled ? t('on', language) : t('off', language)}
                    </button>
                  </div>
                  {hoverZoomEnabled && (
                    <div className="settings-row">
                      <div className="settings-row-info">
                        <span className="settings-row-label">{t('currentZoomLevel', language)}</span>
                        <span className="settings-row-desc">{hoverZoomLevel}% (50% ~ 200%)</span>
                      </div>
                    </div>
                  )}
                  <div className="settings-row">
                    <div className="settings-row-info">
                      <span className="settings-row-label">{t('defaultWindowSize', language)}</span>
                      <span className="settings-row-desc">{t('defaultWindowSizeDesc', language)}</span>
                    </div>
                  </div>
                  <div className="window-size-selector">
                    {WINDOW_SIZE_PRESETS.map(preset => (
                      <button
                        key={preset.id}
                        className={`window-size-option ${currentSizePreset === preset.id ? 'active' : ''}`}
                        onClick={() => setHoverDefaultSize(preset.width, preset.height, vaultPath)}
                        title={`${preset.width} × ${preset.height}`}
                      >
                        <div className="window-size-preview-container">
                          <div
                            className="window-size-preview"
                            style={{
                              width: `${(preset.width / 1400) * 100}%`,
                              height: `${(preset.height / 900) * 100}%`,
                            }}
                          />
                        </div>
                        <span className="window-size-label">{t(preset.labelKey, language)}</span>
                        <span className="window-size-dimensions">{preset.width} × {preset.height}</span>
                      </button>
                    ))}
                  </div>
                </section>
              </div>
            )}

            {activeTab === 'templates' && (
              <div className="settings-panel">
                {(editingNoteTemplate || isCreatingNoteTemplate) ? (
                  <NoteTemplateEditor
                    template={editingNoteTemplate || undefined}
                    onSave={(tmpl) => {
                      if (editingNoteTemplate) {
                        updateNoteTemplate(tmpl, vaultPath);
                      } else {
                        addNoteTemplate(tmpl, vaultPath);
                      }
                      setEditingNoteTemplate(null);
                      setIsCreatingNoteTemplate(false);
                    }}
                    onCancel={() => {
                      setEditingNoteTemplate(null);
                      setIsCreatingNoteTemplate(false);
                    }}
                  />
                ) : (
                  <section className="settings-section">
                    <div className="settings-section-header">
                      <h3 className="settings-section-title">{t('noteTemplates', language)}</h3>
                      <button
                        className="template-add-btn-v2"
                        onClick={() => setIsCreatingNoteTemplate(true)}
                        title={t('newTemplate', language)}
                      >
                        <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
                          <path d="M7 0a1 1 0 0 1 1 1v5h5a1 1 0 1 1 0 2H8v5a1 1 0 1 1-2 0V8H1a1 1 0 0 1 0-2h5V1a1 1 0 0 1 1-1z"/>
                        </svg>
                        <span>{t('newTemplate', language)}</span>
                      </button>
                    </div>
                    <p className="settings-section-desc">{t('noteTemplatesDesc', language)}</p>
                    <div className="template-grid">
                      {noteTemplates.map(nt => {
                        const typeClass = nt.frontmatter.cssclasses?.[0] || '';
                        const noteType = nt.frontmatter.type?.toLowerCase() || 'note';
                        const customColor = nt.customColor;
                        const isBuiltIn = nt.id.startsWith('note-') && !nt.id.startsWith('note-custom-');
                        const isEnabled = enabledTemplateIds.includes(nt.id);
                        const descKeys: Record<string, string> = {
                          'NOTE': 'templateDescNoteShort',
                          'SKETCH': 'templateDescSketchShort',
                          'MTG': 'templateDescMtgShort',
                          'SEM': 'templateDescSemShort',
                          'EVENT': 'templateDescEventShort',
                          'OFA': 'templateDescOfaShort',
                          'PAPER': 'templateDescPaperShort',
                          'LIT': 'templateDescLitShort',
                          'DATA': 'templateDescDataShort',
                          'THEO': 'templateDescTheoShort',
                          'CONTACT': 'templateDescContactShort',
                          'SETUP': 'templateDescSetupShort',
                        };
                        const descKey = descKeys[nt.frontmatter.type || 'NOTE'] || 'templateDescCustomShort';
                        return (
                          <div
                            key={nt.id}
                            className={`template-card${typeClass ? ' ' + typeClass : ''}${customColor ? ' has-custom-color' : ''}${!isEnabled ? ' template-disabled' : ''}`}
                            style={customColor ? { '--template-color': customColor } as React.CSSProperties : undefined}
                          >
                            <div className="template-card-header">
                              <label className="template-card-checkbox">
                                <input
                                  type="checkbox"
                                  checked={isEnabled}
                                  onChange={() => toggleTemplateEnabled(nt.id, vaultPath)}
                                />
                              </label>
                              <span
                                className={`template-card-icon icon-${noteType}`}
                                style={customColor ? { backgroundColor: customColor } : undefined}
                              />
                            </div>
                            <div className="template-card-body">
                              <div className="template-card-title-row">
                                <span className="template-card-name">{nt.name}</span>
                                <span
                                  className="template-card-prefix"
                                  style={customColor ? { color: customColor, borderColor: customColor } : undefined}
                                >
                                  {nt.prefix}
                                </span>
                              </div>
                              <p className="template-card-desc">{t(descKey, language)}</p>
                            </div>
                            <div className="template-card-footer">
                              {isBuiltIn ? (
                                <span className="template-card-badge">{t('builtIn', language)}</span>
                              ) : (
                                <div className="template-card-actions">
                                  <button className="template-card-action-btn" onClick={() => setEditingNoteTemplate(nt)}>
                                    <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
                                      <path d="M9.1 1.2a1 1 0 0 1 1.4 0l.3.3a1 1 0 0 1 0 1.4l-7 7-2.1.4.4-2.1 7-7zM8 2.6L2.2 8.4l-.2.9.9-.2L8.7 3.3 8 2.6z"/>
                                    </svg>
                                  </button>
                                  <button className="template-card-action-btn delete" onClick={() => removeNoteTemplate(nt.id, vaultPath)}>
                                    <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
                                      <path d="M4.5 1.5a.5.5 0 0 1 .5-.5h2a.5.5 0 0 1 .5.5V2h2.5a.5.5 0 0 1 0 1H2a.5.5 0 0 1 0-1h2.5v-.5zM3 4v6.5a1 1 0 0 0 1 1h4a1 1 0 0 0 1-1V4H3zm2 1.5a.5.5 0 0 1 1 0v4a.5.5 0 0 1-1 0v-4zm2.5 0a.5.5 0 0 1 1 0v4a.5.5 0 0 1-1 0v-4z"/>
                                    </svg>
                                  </button>
                                </div>
                              )}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </section>
                )}
              </div>
            )}

            {activeTab === 'shortcuts' && (
              <div className="settings-panel">
                <KeyboardShortcuts
                  customShortcuts={customShortcuts}
                  onUpdateShortcuts={(shortcuts) => setCustomShortcuts(shortcuts, vaultPath)}
                />

                {/* Suggestion Triggers Section */}
                <section className="settings-section suggestion-triggers-section">
                  <h3 className="settings-section-title">{t('suggestionTriggers', language)}</h3>
                  <p className="settings-section-desc">{t('suggestionTriggersDesc', language)}</p>
                  <div className="suggestion-triggers-list">
                    <div className="suggestion-trigger-item">
                      <code className="trigger-code">[[</code>
                      <span className="trigger-desc">{t('triggerWikiLink', language)}</span>
                    </div>
                    <div className="suggestion-trigger-item">
                      <code className="trigger-code">@</code>
                      <span className="trigger-desc">{t('triggerMention', language)}</span>
                    </div>
                    <div className="suggestion-trigger-item">
                      <code className="trigger-code">//</code>
                      <span className="trigger-desc">{t('triggerAttachment', language)}</span>
                    </div>
                  </div>
                </section>
              </div>
            )}

            {activeTab === 'developer' && (
              <div className="settings-panel">
                <section className="settings-section">
                  <h3 className="settings-section-title">{t('developerTools', language)}</h3>
                  <div className="settings-row">
                    <div className="settings-row-info">
                      <span className="settings-row-label">{t('devModeLabel', language)}</span>
                      <span className="settings-row-desc">{t('devModeDesc', language)}</span>
                    </div>
                    <button
                      className={`settings-toggle-btn ${devMode ? 'active' : ''}`}
                      onClick={() => setDevMode(!devMode)}
                    >
                      {devMode ? t('on', language) : t('off', language)}
                    </button>
                  </div>
                </section>
              </div>
            )}

            {/* Plugin tabs */}
            {pluginTabs.map(plugin => (
              activeTab === plugin.id ? <plugin.component key={plugin.id} /> : null
            ))}

          </div>
        </div>
      </div>

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
