import { useState, useMemo } from 'react';
import { useLanguage } from '../../core/stores/zustand';
import { t, tf } from '../../core/utils/i18n';
import type { NoteTemplate } from '../../core/types';

interface NoteTemplateEditorProps {
  template?: NoteTemplate;
  onSave: (template: NoteTemplate) => void;
  onCancel: () => void;
}

const COLOR_THEMES = [
  { label: 'Purple (NOTE)', value: 'note-type', color: '#a78bfa' },
  { label: 'Blue (MTG)', value: 'mtg-type', color: '#60a5fa' },
  { label: 'Green (OFA)', value: 'ofa-type', color: '#34d399' },
  { label: 'Orange (SEM)', value: 'sem-type', color: '#fb923c' },
  { label: 'Red (EVENT)', value: 'event-type', color: '#f87171' },
  { label: 'Cyan (CONTACT)', value: 'contact-type', color: '#22d3ee' },
  { label: 'Gray (SETUP)', value: 'setup-type', color: '#9ca3af' },
  { label: 'Amber (DATA)', value: 'data-type', color: '#fbbf24' },
  { label: 'Indigo (THEO)', value: 'theo-type', color: '#818cf8' },
  { label: 'Teal (PAPER)', value: 'paper-type', color: '#5eead4' },
  { label: 'Pink (SKETCH)', value: 'sketch-type', color: '#f472b6' },
  { label: 'Rose (LIT)', value: 'lit-type', color: '#fb7185' },
];

const ICON_KEYS: { value: string; key: string }[] = [
  { value: 'note', key: 'templateIconNote' },
  { value: 'mtg', key: 'templateIconMeeting' },
  { value: 'ofa', key: 'templateIconOfa' },
  { value: 'sem', key: 'templateIconSeminar' },
  { value: 'event', key: 'templateIconEvent' },
  { value: 'contact', key: 'templateIconContact' },
  { value: 'setup', key: 'templateIconSetup' },
  { value: 'data', key: 'templateIconData' },
  { value: 'theo', key: 'templateIconTheory' },
  { value: 'paper', key: 'templateIconPaper' },
  { value: 'sketch', key: 'templateIconSketch' },
  { value: 'lit', key: 'templateIconLiterature' },
];

// Parse markdown body to extract headers
function parseHeaders(body: string): string[] {
  const lines = body.split('\n');
  const headers: string[] = [];
  for (const line of lines) {
    const match = line.match(/^#+\s+(.+)$/);
    if (match) {
      headers.push(match[1]);
    }
  }
  return headers.length > 0 ? headers : ['Overview', 'Content'];
}

// Generate markdown body from headers
// Format: # Header\n\n***\n for each section (separator after content area)
function generateBody(headers: string[]): string {
  if (headers.length === 0) return '# Overview\n\n***\n# Content\n\n***\n';
  return headers.map(h => `# ${h}\n\n***\n`).join('');
}

function NoteTemplateEditor({ template, onSave, onCancel }: NoteTemplateEditorProps) {
  const language = useLanguage();
  const iconOptions = useMemo(() => ICON_KEYS.map(i => ({ value: i.value, label: t(i.key, language) })), [language]);
  const [name, setName] = useState(template?.name || '');
  const [prefix, setPrefix] = useState(template?.prefix || '');
  const [namePattern, setNamePattern] = useState(template?.namePattern || '{{title}}');
  const [headers, setHeaders] = useState<string[]>(template?.body ? parseHeaders(template.body) : ['Overview', 'Content']);
  const [tags, setTags] = useState(template?.frontmatter.tags?.join(', ') || '');
  const [cssclasses, setCssclasses] = useState(template?.frontmatter.cssclasses?.join(', ') || '');
  const [type, setType] = useState(template?.frontmatter.type || 'NOTE');
  const [customColor, setCustomColor] = useState(template?.customColor || '');
  const [useCustomColor, setUseCustomColor] = useState(!!template?.customColor);
  const [icon, setIcon] = useState(template?.icon || 'note');
  // Tag categories
  const [domainTags, setDomainTags] = useState(template?.tagCategories?.domain?.join(', ') || '');
  const [whoTags, setWhoTags] = useState(template?.tagCategories?.who?.join(', ') || '');
  const [orgTags, setOrgTags] = useState(template?.tagCategories?.org?.join(', ') || '');
  const [ctxTags, setCtxTags] = useState(template?.tagCategories?.ctx?.join(', ') || '');

  const handleSave = () => {
    if (!name.trim() || !prefix.trim()) return;

    const newTemplate: NoteTemplate = {
      id: template?.id || `note-custom-${Date.now()}`,
      name: name.trim(),
      prefix: prefix.trim().toUpperCase(),
      namePattern: namePattern.trim(),
      frontmatter: {
        type: type as string,
        cssclasses: cssclasses ? cssclasses.split(',').map(s => s.trim()).filter(Boolean) : [],
        tags: tags ? tags.split(',').map(s => s.trim()).filter(Boolean) : [],
      },
      body: generateBody(headers),
      customColor: useCustomColor && customColor ? customColor : undefined,
      icon,
      tagCategories: {
        domain: domainTags ? domainTags.split(',').map(s => s.trim()).filter(Boolean) : [],
        who: whoTags ? whoTags.split(',').map(s => s.trim()).filter(Boolean) : [],
        org: orgTags ? orgTags.split(',').map(s => s.trim()).filter(Boolean) : [],
        ctx: ctxTags ? ctxTags.split(',').map(s => s.trim()).filter(Boolean) : [],
      },
    };

    onSave(newTemplate);
  };

  return (
    <div className="template-editor">
      <div className="template-editor-header">
        <button className="template-editor-back-btn" onClick={onCancel} title={t('goBack', language)}>
          <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor">
            <path d="M7.707 14.707a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414l4-4a1 1 0 011.414 1.414L5.414 9H17a1 1 0 110 2H5.414l2.293 2.293a1 1 0 010 1.414z"/>
          </svg>
        </button>
        <h3 className="template-editor-title">
          {template ? t('templateEditTitle', language) : t('templateNewTitle', language)}
        </h3>
      </div>

      {/* Basic Info Section */}
      <div className="template-editor-section">
        <h4 className="template-editor-section-title">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
            <polyline points="14 2 14 8 20 8"/>
          </svg>
          {t('basicInfo', language)}
        </h4>
        <div className="template-editor-row">
          <div className="template-editor-field">
            <label className="template-editor-label">{t('templateNameField', language)}</label>
            <input
              className="template-editor-input"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder={t('exampleName', language)}
            />
          </div>
          <div className="template-editor-field">
            <label className="template-editor-label">{t('prefix', language)}</label>
            <input
              className="template-editor-input"
              value={prefix}
              onChange={e => setPrefix(e.target.value)}
              placeholder={t('examplePrefix', language)}
              style={{ textTransform: 'uppercase' }}
            />
          </div>
        </div>
        <div className="template-editor-field">
          <label className="template-editor-label">{t('noteType', language)}</label>
          <input
            className="template-editor-input"
            value={type}
            onChange={e => setType(e.target.value)}
            placeholder="NOTE"
            style={{ width: '120px', textTransform: 'uppercase' }}
          />
        </div>
      </div>

      {/* Appearance Section */}
      <div className="template-editor-section">
        <h4 className="template-editor-section-title">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10"/>
            <circle cx="12" cy="12" r="4"/>
            <line x1="21.17" y1="8" x2="12" y2="8"/>
            <line x1="3.95" y1="6.06" x2="8.54" y2="14"/>
            <line x1="10.88" y1="21.94" x2="15.46" y2="14"/>
          </svg>
          {t('appearanceSection', language)}
        </h4>
        <div className="template-editor-field">
          <label className="template-editor-label">{t('icon', language)}</label>
          <div className="icon-selector-grid">
            {iconOptions.map(opt => {
              const isSelected = icon === opt.value;
              const iconClass = `icon-${opt.value}`;
              return (
                <button
                  key={opt.value}
                  type="button"
                  className={`icon-selector-option${isSelected ? ' selected' : ''}`}
                  onClick={() => setIcon(opt.value)}
                  title={opt.label}
                >
                  <span className={`icon-selector-preview template-selector-icon ${iconClass}`} />
                  <span className="icon-selector-label">{opt.label}</span>
                </button>
              );
            })}
          </div>
        </div>
        <div className="template-editor-field">
          <label className="template-editor-label">{t('colorTheme', language)}</label>
          <div className="color-theme-picker">
            {COLOR_THEMES.map(theme => {
              const isSelected = !useCustomColor && cssclasses === theme.value;
              return (
                <button
                  key={theme.value}
                  className={`color-theme-swatch${isSelected ? ' selected' : ''}`}
                  style={{
                    backgroundColor: theme.color,
                    borderColor: theme.color,
                  }}
                  onClick={() => {
                    setCssclasses(theme.value);
                    setUseCustomColor(false);
                  }}
                  title={theme.label}
                  type="button"
                >
                  {isSelected && (
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="white">
                      <path d="M13.854 3.646a.5.5 0 0 1 0 .708l-7 7a.5.5 0 0 1-.708 0l-3.5-3.5a.5.5 0 1 1 .708-.708L6.5 10.293l6.646-6.647a.5.5 0 0 1 .708 0z"/>
                    </svg>
                  )}
                </button>
              );
            })}
          </div>
          <div className="color-custom-picker">
            <label className="template-editor-checkbox">
              <input
                type="checkbox"
                checked={useCustomColor}
                onChange={e => setUseCustomColor(e.target.checked)}
              />
              {t('customColor', language)}
            </label>
            {useCustomColor && (
              <div className="color-custom-input-row">
                <input
                  type="color"
                  className="color-picker-input"
                  value={customColor || '#a78bfa'}
                  onChange={e => setCustomColor(e.target.value)}
                />
                <input
                  type="text"
                  className="template-editor-input"
                  value={customColor}
                  onChange={e => setCustomColor(e.target.value)}
                  placeholder="#a78bfa"
                  style={{ width: '100px' }}
                />
              </div>
            )}
          </div>
          <span className="template-editor-hint">
            {t('colorHint', language)}
          </span>
        </div>
      </div>

      {/* Tags Section */}
      <div className="template-editor-section">
        <h4 className="template-editor-section-title">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/>
            <line x1="7" y1="7" x2="7.01" y2="7"/>
          </svg>
          {t('tagsSection', language)}
        </h4>
        <div className="template-editor-field">
          <label className="template-editor-label">{t('defaultTags', language)}</label>
          <input
            className="template-editor-input"
            value={tags}
            onChange={e => setTags(e.target.value)}
            placeholder={t('tagsCommaSeparated', language)}
          />
        </div>
        <div className="template-editor-field">
          <label className="template-editor-label">{t('tagCategories', language)}</label>
          <div className="tag-categories-grid">
            <div className="tag-category-row">
              <span className="tag-category-label">domain/</span>
              <input
                className="template-editor-input"
                value={domainTags}
                onChange={e => setDomainTags(e.target.value)}
                placeholder={t('domainTags', language)}
              />
            </div>
            <div className="tag-category-row">
              <span className="tag-category-label">who/</span>
              <input
                className="template-editor-input"
                value={whoTags}
                onChange={e => setWhoTags(e.target.value)}
                placeholder={t('peopleTags', language)}
              />
            </div>
            <div className="tag-category-row">
              <span className="tag-category-label">org/</span>
              <input
                className="template-editor-input"
                value={orgTags}
                onChange={e => setOrgTags(e.target.value)}
                placeholder={t('orgTags', language)}
              />
            </div>
            <div className="tag-category-row">
              <span className="tag-category-label">ctx/</span>
              <input
                className="template-editor-input"
                value={ctxTags}
                onChange={e => setCtxTags(e.target.value)}
                placeholder={t('contextTags', language)}
              />
            </div>
          </div>
          <span className="template-editor-hint">
            {t('tagAutocompleteHint', language)}
          </span>
        </div>
      </div>

      {/* Content Section */}
      <div className="template-editor-section">
        <h4 className="template-editor-section-title">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="8" y1="6" x2="21" y2="6"/>
            <line x1="8" y1="12" x2="21" y2="12"/>
            <line x1="8" y1="18" x2="21" y2="18"/>
            <line x1="3" y1="6" x2="3.01" y2="6"/>
            <line x1="3" y1="12" x2="3.01" y2="12"/>
            <line x1="3" y1="18" x2="3.01" y2="18"/>
          </svg>
          {t('bodyStructure', language)}
        </h4>
        <div className="template-editor-field">
          <label className="template-editor-label">{t('sectionHeaders', language)}</label>
          <div className="header-editor-container">
            {headers.map((header, index) => (
              <div key={index} className="header-editor-row">
                <span className="header-editor-number">{index + 1}</span>
                <input
                  type="text"
                  className="template-editor-input"
                  value={header}
                  onChange={e => {
                    const newHeaders = [...headers];
                    newHeaders[index] = e.target.value;
                    setHeaders(newHeaders);
                  }}
                  placeholder={tf('sectionPlaceholder', language, { index: index + 1 })}
                />
                <button
                  type="button"
                  className="header-editor-remove-btn"
                  onClick={() => {
                    if (headers.length > 1) {
                      setHeaders(headers.filter((_, i) => i !== index));
                    }
                  }}
                  title={t('removeSection', language)}
                  disabled={headers.length === 1}
                >
                  ×
                </button>
              </div>
            ))}
            <button
              type="button"
              className="header-editor-add-btn"
              onClick={() => setHeaders([...headers, ''])}
            >
              {t('addSection', language)}
            </button>
          </div>
          <span className="template-editor-hint">
            {t('sectionSeparatorHint', language)}
          </span>
        </div>
      </div>

      <div className="template-editor-actions">
        <button className="template-editor-cancel-btn" onClick={onCancel}>{t('cancel', language)}</button>
        <button className="template-editor-save-btn" onClick={handleSave}>{t('save', language)}</button>
      </div>
    </div>
  );
}

export default NoteTemplateEditor;
