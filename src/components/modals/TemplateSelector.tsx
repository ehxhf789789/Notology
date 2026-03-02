import { useState, useEffect, useRef, useLayoutEffect } from 'react';
import { useModalStore } from '../../stores/zustand/modalStore';
import { useTemplateStore } from '../../stores/zustand/templateStore';
import { useSettingsStore } from '../../stores/zustand/settingsStore';
import { useModalClose } from '../../hooks/useModalListeners';
import { t } from '../../utils/i18n';
import type { LanguageSetting } from '../../utils/i18n';

// Template description key map for each type
const TEMPLATE_DESC_KEYS: Record<string, string> = {
  'NOTE': 'templateDescNote',
  'SKETCH': 'templateDescSketch',
  'MTG': 'templateDescMtg',
  'SEM': 'templateDescSem',
  'EVENT': 'templateDescEvent',
  'OFA': 'templateDescOfa',
  'PAPER': 'templateDescPaper',
  'LIT': 'templateDescLit',
  'DATA': 'templateDescData',
  'THEO': 'templateDescTheo',
  'CONTACT': 'templateDescContact',
  'SETUP': 'templateDescSetup',
};

function getTemplateDescription(type: string, lang: LanguageSetting): string {
  const key = TEMPLATE_DESC_KEYS[type];
  return key ? t(key, lang) : t('templateDescCustom', lang);
}

function TemplateSelector() {
  const templateSelectorState = useModalStore(s => s.templateSelectorState);
  const hideTemplateSelector = useModalStore(s => s.hideTemplateSelector);
  const noteTemplates = useTemplateStore(s => s.noteTemplates);
  const language = useSettingsStore(s => s.language);
  const enabledTemplateIds = useTemplateStore(s => s.enabledTemplateIds);
  const menuRef = useRef<HTMLDivElement>(null);
  const [adjustedPos, setAdjustedPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [searchTerm, setSearchTerm] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Use optimized hook for click-outside and escape handling
  useModalClose(menuRef, hideTemplateSelector, !!templateSelectorState?.visible);

  // Reset search term and focus input when state changes
  useEffect(() => {
    if (!templateSelectorState) {
      setSearchTerm('');
      return;
    }
    // Focus search input when opened
    setTimeout(() => searchInputRef.current?.focus(), 50);
  }, [templateSelectorState]);

  useLayoutEffect(() => {
    if (!templateSelectorState?.visible || !menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    const { position } = templateSelectorState;
    let x = position.x, y = position.y;
    if (x + rect.width > window.innerWidth - 8) x = window.innerWidth - rect.width - 8;
    if (y + rect.height > window.innerHeight - 8) y = window.innerHeight - rect.height - 8;
    if (x < 8) x = 8;
    if (y < 8) y = 8;
    setAdjustedPos({ x, y });
  }, [templateSelectorState]);

  if (!templateSelectorState || !templateSelectorState.visible) return null;

  const { callback } = templateSelectorState;

  const handleSelect = (templateId: string) => {
    callback(templateId);
    hideTemplateSelector();
  };

  // Filter templates based on enabled status and search term
  const filteredTemplates = noteTemplates.filter(t => {
    // Only show enabled templates
    if (!enabledTemplateIds.includes(t.id)) return false;
    // Apply search filter
    if (!searchTerm) return true;
    const search = searchTerm.toLowerCase();
    return (
      t.name.toLowerCase().includes(search) ||
      t.prefix.toLowerCase().includes(search) ||
      (t.frontmatter.type?.toLowerCase() || '').includes(search)
    );
  });

  // Separate default and custom templates
  const defaultTemplates = filteredTemplates.filter(t => t.id.startsWith('note-') && !t.id.startsWith('note-custom-'));
  const customTemplates = filteredTemplates.filter(t => !t.id.startsWith('note-') || t.id.startsWith('note-custom-'));

  const getDescription = (template: typeof noteTemplates[0]): string => {
    const type = template.frontmatter.type?.toUpperCase() || '';
    return getTemplateDescription(type, language);
  };

  const renderTemplateItem = (t: typeof noteTemplates[0]) => {
    const typeClass = t.frontmatter.cssclasses?.[0] || '';
    const noteType = t.frontmatter.type?.toLowerCase() || '';
    const customColor = t.customColor;
    const description = getDescription(t);

    const itemStyle = customColor ? {
      '--template-color': customColor,
      borderLeftColor: customColor,
    } as React.CSSProperties : undefined;

    return (
      <button
        key={t.id}
        className={`template-selector-item-v2${typeClass ? ' ' + typeClass : ''}${customColor ? ' has-custom-color' : ''}`}
        onClick={() => handleSelect(t.id)}
        style={itemStyle}
      >
        <span
          className={`template-selector-icon-v2 icon-${noteType}`}
          style={customColor ? { backgroundColor: customColor } : undefined}
        />
        <div className="template-selector-content">
          <div className="template-selector-header-row">
            <span className="template-selector-name-v2">{t.name}</span>
            <span className="template-selector-prefix">{t.prefix}</span>
          </div>
          <span className="template-selector-desc">{description}</span>
        </div>
      </button>
    );
  };

  return (
    <div
      ref={menuRef}
      className="template-selector-v2"
      style={{ left: adjustedPos.x, top: adjustedPos.y }}
    >
      <div className="template-selector-header-v2">
        <span>{t('templateSelectorTitle', language)}</span>
        <span className="template-selector-hint">Ctrl+N</span>
      </div>

      <div className="template-selector-search">
        <input
          ref={searchInputRef}
          type="text"
          placeholder={t('templateSearchPlaceholder', language)}
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          className="template-selector-search-input"
        />
      </div>

      <div className="template-selector-list">
        {defaultTemplates.length > 0 && (
          <>
            <div className="template-selector-section-label">{t('defaultTemplates', language)}</div>
            {defaultTemplates.map(renderTemplateItem)}
          </>
        )}

        {customTemplates.length > 0 && (
          <>
            <div className="template-selector-section-label">{t('customTemplates', language)}</div>
            {customTemplates.map(renderTemplateItem)}
          </>
        )}

        {filteredTemplates.length === 0 && (
          <div className="template-selector-empty">
            {t('noSearchResultsTemplate', language)}
          </div>
        )}
      </div>
    </div>
  );
}

export default TemplateSelector;
