import { useState, useMemo, useRef } from 'react';
import { ChevronLeft, ChevronDown, FileText, Palette, Tag as TagIcon, ListTree, AlertCircle, Search } from 'lucide-react';
import { useLanguage } from '../../core/stores/zustand';
import { t, tf } from '../../core/utils/i18n';
import type { NoteTemplate } from '../../core/types';
import { modalActions } from '../modals/stores/modalStore';
import { useTemplateStore } from './stores/templateStore';
import TemplateBodyEditor, { type TemplateBodyEditorRef } from './TemplateBodyEditor';
import TemplatePreviewPane from './TemplatePreviewPane';
import { TEMPLATE_ICON_CATALOG, ICON_CATEGORIES } from './templateIconCatalog';
import HslColorPicker from './HslColorPicker';
import { Toggle } from '../../design-system/components';
// Hotfix (2026-05-17, HanBin) — chip-based multi-input replaces the
// comma-separated single-line inputs for tag categories.
import TagInputSection, { type FacetedTagSelection, emptyFacetSelection, seedFacetSelection } from '../shared/TagInputSection';

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

// Stage 5.0.5a-γ5 fix (2026-05-16) — REMOVED hardcoded ICON_KEYS bound to
// the old 12-template names ('note'/'mtg'/'paper'/etc.). The catalog now
// lives in templateIconCatalog.ts as lucide-react components, organised by
// USE (document/people/time/academic/visual/admin/general) rather than by
// stale template-type name. Legacy template.icon values still resolve to
// sensible lucide fallbacks via resolveTemplateIcon().

// Stage 5.0.5a-γ4 (2026-05-16) — REMOVED `parseHeaders` / `generateBody`.
// Body editing migrated from "headers list → generated markdown" to a
// real TipTap WYSIWYG editor (TemplateBodyEditor). Authoring a template
// body now works identically to authoring a regular note, including
// paragraphs, lists, tables, callouts, code blocks, etc.

const DEFAULT_INITIAL_BODY = '# Overview\n\n***\n# Content\n\n***\n';

/**
 * Stage 5.0.5a-γ5 v2 (2026-05-16, HanBin) — resolve the user's chosen
 * theme to a concrete CSS color. Used to tint the icon picker so the
 * selected icon previews in the picked color (matches the card preview).
 */
function resolveActiveThemeColor(
  cssclasses: string,
  customColor: string,
  useCustomColor: boolean,
): string {
  if (useCustomColor && customColor) return customColor;
  const preset = COLOR_THEMES.find(t => t.value === cssclasses);
  return preset ? preset.color : '#007AFF';
}

function NoteTemplateEditor({ template, onSave, onCancel }: NoteTemplateEditorProps) {
  const language = useLanguage();
  // v13b — name-uniqueness check against the current vault's templates.
  const noteTemplates = useTemplateStore(s => s.noteTemplates);
  // Stage 5.0.5a-γ3 (2026-05-16, HanBin) — icon search query. Filters the
  // catalog by label (i18n) + id (kebab) substring so the user doesn't have
  // to scroll through 30+ icons.
  const [iconSearch, setIconSearch] = useState('');
  // Stage 5.0.5a-γ5 fix — grouped icon catalog (lucide). Memo so the grouping
  // doesn't re-compute on every render.
  // γ3 — also filter each group by the search query (case-insensitive),
  // matching against the translated label and the catalog id. Groups with
  // no surviving entries are dropped so the picker stays compact.
  const iconGroups = useMemo(() => {
    const q = iconSearch.trim().toLowerCase();
    return ICON_CATEGORIES.map(cat => {
      const entries = TEMPLATE_ICON_CATALOG.filter(e => {
        if (e.category !== cat.id) return false;
        if (!q) return true;
        const label = t(e.labelI18n, language).toLowerCase();
        return e.id.toLowerCase().includes(q) || label.includes(q);
      });
      return { ...cat, entries };
    }).filter(g => g.entries.length > 0);
  }, [iconSearch, language]);

  // 2026-05-22 — accordion state for icon groups. The picker had every
  // category expanded by default and a self-scrolling container, which
  // forced the modal into multi-scroll territory (HanBin: "스크롤바를
  // 만들어야만 하는건가"). Now collapsed by default; the group containing
  // the currently selected icon stays open so the user always sees their
  // current choice. Active search auto-expands every group with hits.
  // Tracked as a Set so toggling is per-group.
  const [iconGroupsCollapsed, setIconGroupsCollapsed] = useState<Set<string>>(() => {
    const allIds = new Set(ICON_CATEGORIES.map(c => c.id));
    // Default: collapse all *except* the one carrying the current icon.
    const iconEntry = TEMPLATE_ICON_CATALOG.find(e => e.id === (template?.icon || ''));
    if (iconEntry) allIds.delete(iconEntry.category);
    else allIds.delete(ICON_CATEGORIES[0]?.id); // empty selection → open first group
    return allIds;
  });
  const toggleIconGroup = (groupId: string) => {
    setIconGroupsCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  };
  // When the user is searching, force every result-bearing group open so
  // they don't have to expand each one to see matches.
  const isSearching = iconSearch.trim().length > 0;
  const [name, setName] = useState(template?.name || '');
  const [prefix, setPrefix] = useState(template?.prefix || '');
  const [namePattern, setNamePattern] = useState(template?.namePattern || '{{title}}');
  // Hotfix (2026-05-17, HanBin) — "자동 추가 태그" 평탄 필드 제거됨.
  // 기존 템플릿에서 로드 시 평탄 tags 가 있으면 prefix 파싱해 4-카테고리로
  // 자동 흡수 (마이그레이션 — 기존 데이터 손실 방지). 신규 입력은 모두
  // 아래 TagInputSection (chip 기반 multi-input) 로만.
  const legacyFlatTags = template?.frontmatter.tags;
  const seededFromFlat = useMemo(() => {
    const bucket = emptyFacetSelection();   // 🔴 축은 표에서 (2026-08-29)
    if (Array.isArray(legacyFlatTags)) {
      for (const raw of legacyFlatTags) {
        if (typeof raw !== 'string') continue;
        const v = raw.trim();
        if (!v) continue;
        if (v.startsWith('domain/'))   bucket.domain.push(v.slice('domain/'.length));
        else if (v.startsWith('who/')) bucket.who.push(v.slice('who/'.length));
        else if (v.startsWith('org/')) bucket.org.push(v.slice('org/'.length));
        else if (v.startsWith('ctx/')) bucket.ctx.push(v.slice('ctx/'.length));
        else                            bucket.ctx.push(v);
      }
    }
    return bucket;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // 🔴 축을 손으로 적지 않는다 (2026-08-29) — 넷만 적어 두어 `key`·`proj`
  //    ·`acad` 는 템플릿에서 아예 고를 수 없었다.
  const [tagSelection, setTagSelection] = useState<FacetedTagSelection>(() => {
    const seed = seedFacetSelection(template?.tagCategories);
    const out = emptyFacetSelection();
    for (const k of Object.keys(out) as (keyof FacetedTagSelection)[]) {
      out[k] = [...new Set([...(seed[k] || []), ...(seededFromFlat[k] || [])])];
    }
    return out;
  });
  // v19 (2026-05-16, HanBin) — icon + color now REQUIRED for new templates.
  // Empty initial state forces the user to pick. Editing an existing
  // template inherits its values so it doesn't ask again.
  const [cssclasses, setCssclasses] = useState(template?.frontmatter.cssclasses?.join(', ') || '');
  const [type, setType] = useState(template?.frontmatter.type || 'NOTE');
  const [customColor, setCustomColor] = useState(template?.customColor || '');
  const [useCustomColor, setUseCustomColor] = useState(!!template?.customColor);
  const [icon, setIcon] = useState(template?.icon || '');
  // Hotfix (2026-05-17) — `showAdvanced` disclosure removed; 4-category
  // chip input is now the default + only interface for tags.
  // Removed (2026-05-17): individual `domainTags`/`whoTags`/`orgTags`/`ctxTags`
  // single-line comma-separated inputs. Replaced by the unified
  // <TagInputSection> chip-based multi-input (same component used in note
  // creation wizard) — see `tagSelection` state above.
  // Stage 5.0.5a-γ4 — TipTap body editor ref. getMarkdown() pulled at save.
  const bodyEditorRef = useRef<TemplateBodyEditorRef>(null);
  const initialBody = template?.body || DEFAULT_INITIAL_BODY;
  // Stage 5.0.5a-γ5 — live body markdown mirror for the preview pane.
  // Source of truth at save time is still `bodyEditorRef.current.getMarkdown()`;
  // this state exists only to feed the readonly preview renderer.
  const [bodyMarkdown, setBodyMarkdown] = useState<string>(initialBody);
  // v12 (2026-05-16, HanBin) — tab layout replaces vertical scroll-stack.
  // HanBin: "기본정보, 외관, 태그, 본문구조를 위아래로 드래그형식으로 나열되어
  // 있다보니, 사용하기 불편함. 탭으로 설계할 것."
  // 2026-05-22 — 'fields' tab retired. The fields breakdown (auto-fill /
  // input / unknown) is now surfaced in the right-side preview pane so
  // the author sees what the wizard will ask for next to the body
  // structure itself. One fewer click + one fewer tab.
  type EditorTab = 'basic' | 'appearance' | 'tags' | 'body';
  const [activeTab, setActiveTab] = useState<EditorTab>('basic');
  // v19 (2026-05-16, HanBin) — sub-tabs inside 외관 + 본문 구조 so the long
  // scroll columns (icon grid + chips + editor) split into focused screens.
  // HanBin: "계속 드래그 하는 방식은 직관적으로 안보임. 세부 탭으로 만드는 구조."
  type AppearanceSubTab = 'icon' | 'color';
  type BodySubTab = 'vars' | 'editor';
  const [appearanceSubTab, setAppearanceSubTab] = useState<AppearanceSubTab>('icon');
  const [bodySubTab, setBodySubTab] = useState<BodySubTab>('editor');
  // v13 (2026-05-16, HanBin) — validation fence. Required fields:
  // 템플릿 이름 + 접두어. Empty save → alert modal + tab switch to first
  // invalid field + red error ring on the input.
  const [errors, setErrors] = useState<Set<string>>(new Set());
  const clearError = (key: string) => {
    if (!errors.has(key)) return;
    setErrors(prev => {
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
  };
  const tabs: ReadonlyArray<{ id: EditorTab; labelI18n: string; Icon: typeof FileText }> = [
    { id: 'basic',      labelI18n: 'basicInfo',          Icon: FileText },
    { id: 'appearance', labelI18n: 'appearanceSection',  Icon: Palette },
    { id: 'tags',       labelI18n: 'tagsSection',        Icon: TagIcon },
    { id: 'body',       labelI18n: 'bodyStructure',      Icon: ListTree },
    // 'fields' tab retired 2026-05-22 — moved to TemplatePreviewPane.
  ];

  const handleSave = () => {
    // v13 — validation fence. v13b (HanBin) — also block name duplicates.
    // v19 (HanBin) — icon + color now REQUIRED; prefix must be ASCII
    // letters/digits with no spaces. Errors jump to the relevant tab.
    const next = new Set<string>();
    if (!name.trim()) next.add('name');
    if (!prefix.trim()) {
      next.add('prefix');
    } else if (!/^[A-Za-z0-9]+$/.test(prefix.trim())) {
      // Prefix must be ASCII alphanumeric, no spaces (frontmatter type
      // and filename prefix both rely on this assumption — Korean / spaces
      // break wikilink resolution and graph node IDs).
      next.add('prefix-format');
    }

    // Name duplicate check — case-insensitive, exclude the current template
    // when editing (template?.id matches → same record, not a conflict).
    const trimmedName = name.trim().toLowerCase();
    if (trimmedName) {
      const conflict = noteTemplates.find(
        t => t.id !== template?.id && t.name.trim().toLowerCase() === trimmedName,
      );
      if (conflict) next.add('name-dup');
    }

    // v19 — icon + color required.
    if (!icon || !icon.trim()) next.add('icon');
    if (!useCustomColor && !cssclasses.trim()) next.add('color');
    if (useCustomColor && !customColor.trim()) next.add('color');

    if (next.size > 0) {
      setErrors(next);
      // Pick the first failing tab so the user sees the relevant input.
      if (next.has('name') || next.has('name-dup') || next.has('prefix') || next.has('prefix-format')) {
        setActiveTab('basic');
      } else if (next.has('icon') || next.has('color')) {
        setActiveTab('appearance');
        // Auto-switch sub-tab to the one that's invalid so the field is
        // visible without extra clicks.
        if (next.has('icon')) setAppearanceSubTab('icon');
        else if (next.has('color')) setAppearanceSubTab('color');
      }
      // Build a friendly multi-line message. Duplicate name + format
      // errors read as their own lines rather than being mixed with the
      // missing-field list.
      const lines: string[] = [];
      const missing = Array.from(next)
        .filter(k => k === 'name' || k === 'prefix' || k === 'icon' || k === 'color')
        .map(k => {
          if (k === 'name')   return t('templateNameField', language);
          if (k === 'prefix') return t('prefix', language);
          if (k === 'icon')   return t('icon', language);
          if (k === 'color')  return t('colorTheme', language);
          return k;
        });
      if (missing.length > 0) {
        lines.push(tf('templateValidationMissing', language, { fields: missing.join(', ') }));
      }
      if (next.has('name-dup')) {
        lines.push(t('templateValidationDupName', language));
      }
      if (next.has('prefix-format')) {
        lines.push(t('templateValidationPrefixFormat', language));
      }
      modalActions.showAlertModal(
        t('templateValidationTitle', language),
        lines.join('\n'),
      );
      return;
    }
    setErrors(new Set());

    const body = bodyEditorRef.current?.getMarkdown() ?? initialBody;

    // Stage 5.0.5a-γ5 v2 — auto-derive frontmatter `type` from prefix if
    // the user hasn't explicitly set a different one. The dedicated input
    // for `type` was removed from the UI to reduce cognitive load.
    const resolvedType = (type && type !== 'NOTE') ? type : (prefix.trim().toUpperCase() || 'NOTE');

    const newTemplate: NoteTemplate = {
      id: template?.id || `note-custom-${Date.now()}`,
      name: name.trim(),
      prefix: prefix.trim().toUpperCase(),
      namePattern: namePattern.trim(),
      frontmatter: {
        type: resolvedType,
        cssclasses: cssclasses ? cssclasses.split(',').map(s => s.trim()).filter(Boolean) : [],
        // Hotfix (2026-05-17, HanBin) — flat `tags` field removed from the
        // editor UI; persist as empty so on-disk shape stays valid. All
        // tag data now flows through `tagCategories` (4-facet chip input).
        tags: [],
      },
      body,
      customColor: useCustomColor && customColor ? customColor : undefined,
      icon,
      tagCategories: { ...tagSelection },
    };

    onSave(newTemplate);
  };

  return (
    <div className="template-editor-with-preview">
    <div className="template-editor">
      <div className="template-editor-header">
        {/* Stage 5.0.5a-γ5 v6 (2026-05-16, HanBin) — back button redesigned.
            Previous SVG was barely visible in the 32x32 button. Now uses
            lucide ChevronLeft + "뒤로" label for clarity, with full hover
            affordance. */}
        <button
          type="button"
          className="template-editor-back-btn"
          onClick={onCancel}
          title={t('goBack', language)}
          aria-label={t('goBack', language)}
        >
          <ChevronLeft size={16} strokeWidth={2} />
          <span className="template-editor-back-btn__label">{t('goBack', language)}</span>
        </button>
        <h3 className="template-editor-title">
          {template ? t('templateEditTitle', language) : t('templateNewTitle', language)}
        </h3>
      </div>

      {/* v12 — tab navigation. Single-row, sticky below header. Each tab
          renders only its own section underneath, eliminating the long
          vertical scroll that made navigation cumbersome. */}
      <div className="template-editor-tabs" role="tablist" aria-label={t('templateEditTitle', language)}>
        {tabs.map(tab => {
          const TabIcon = tab.Icon;
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={isActive}
              className={`template-editor-tab${isActive ? ' is-active' : ''}`}
              onClick={() => setActiveTab(tab.id)}
            >
              <TabIcon size={14} strokeWidth={2} />
              <span>{t(tab.labelI18n, language)}</span>
            </button>
          );
        })}
      </div>

      {activeTab === 'basic' && (
      <>
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
            <label className="template-editor-label">
              {t('templateNameField', language)} <span className="template-editor-required">*</span>
            </label>
            <input
              className={`template-editor-input${(errors.has('name') || errors.has('name-dup')) ? ' has-error' : ''}`}
              value={name}
              onChange={e => {
                setName(e.target.value);
                if (e.target.value.trim()) clearError('name');
                // Re-check duplicate as user types — clear if the new value no longer conflicts.
                clearError('name-dup');
              }}
              placeholder={t('exampleName', language)}
              aria-invalid={errors.has('name') || errors.has('name-dup')}
            />
            {errors.has('name') && (
              <span className="template-editor-error-text">
                <AlertCircle size={11} /> {t('templateFieldRequired', language)}
              </span>
            )}
            {errors.has('name-dup') && !errors.has('name') && (
              <span className="template-editor-error-text">
                <AlertCircle size={11} /> {t('templateValidationDupName', language)}
              </span>
            )}
          </div>
          <div className="template-editor-field">
            <label className="template-editor-label">
              {t('prefix', language)} <span className="template-editor-required">*</span>
            </label>
            <input
              className={`template-editor-input${(errors.has('prefix') || errors.has('prefix-format')) ? ' has-error' : ''}`}
              value={prefix}
              onChange={e => {
                // v19 (2026-05-16, HanBin) — strip any non-alphanumeric
                // character on input so the prefix can never contain spaces
                // or Korean. Frontmatter type and filename prefix both rely
                // on ASCII-only here.
                const filtered = e.target.value.replace(/[^A-Za-z0-9]/g, '');
                setPrefix(filtered);
                if (filtered) {
                  clearError('prefix');
                  clearError('prefix-format');
                }
              }}
              placeholder={t('examplePrefix', language)}
              style={{ textTransform: 'uppercase' }}
              aria-invalid={errors.has('prefix') || errors.has('prefix-format')}
              maxLength={16}
            />
            {errors.has('prefix') && (
              <span className="template-editor-error-text">
                <AlertCircle size={11} /> {t('templateFieldRequired', language)}
              </span>
            )}
            {errors.has('prefix-format') && !errors.has('prefix') && (
              <span className="template-editor-error-text">
                <AlertCircle size={11} /> {t('templateValidationPrefixFormat', language)}
              </span>
            )}
          </div>
        </div>
        {/* Stage 5.0.5a-γ5 v2 (2026-05-16, HanBin) — REMOVED "타입" field from
            default UI. Most users don't know what frontmatter `type:` is,
            and the value is auto-derived from prefix on save (if empty).
            Power-user override will move to a future "고급 옵션" expander. */}
      </div>
      </>
      )}

      {activeTab === 'appearance' && (
      <>
      {/* v19 (2026-05-16, HanBin) — Appearance now uses sub-tabs (아이콘 / 색상)
          so each picker has its own focused screen rather than one long
          scrolling column. HanBin: "계속 드래그 하는 방식은 직관적으로
          안보임. 세부 탭으로 만드는 구조로." */}
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
        <div className="template-subtabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={appearanceSubTab === 'icon'}
            className={`template-subtab${appearanceSubTab === 'icon' ? ' is-active' : ''}${errors.has('icon') ? ' has-error' : ''}`}
            onClick={() => setAppearanceSubTab('icon')}
          >
            {t('icon', language)} <span className="template-editor-required">*</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={appearanceSubTab === 'color'}
            className={`template-subtab${appearanceSubTab === 'color' ? ' is-active' : ''}${errors.has('color') ? ' has-error' : ''}`}
            onClick={() => setAppearanceSubTab('color')}
          >
            {t('colorTheme', language)} <span className="template-editor-required">*</span>
          </button>
        </div>

        {appearanceSubTab === 'icon' && (
          <div className="template-editor-field">
            <div className="icon-picker-v2__search">
              <Search size={13} strokeWidth={2} />
              <input
                type="text"
                value={iconSearch}
                onChange={e => setIconSearch(e.target.value)}
                placeholder={t('tplIconSearchPlaceholder', language)}
                className="icon-picker-v2__search-input"
                spellCheck={false}
              />
            </div>
            <div
              className={`icon-picker-v2${errors.has('icon') ? ' has-error' : ''}`}
              style={{ '--picker-accent': resolveActiveThemeColor(cssclasses, customColor, useCustomColor) } as React.CSSProperties}
            >
              {iconGroups.length === 0 && (
                <div className="icon-picker-v2__empty">
                  {t('noSearchResultsTemplate', language)}
                </div>
              )}
              {iconGroups.map(group => {
                // Collapsed unless: user is searching (auto-expand all)
                // OR user has manually opened it (= not in collapsed set).
                const isCollapsed = !isSearching && iconGroupsCollapsed.has(group.id);
                return (
                  <div key={group.id} className={`icon-picker-v2__group${isCollapsed ? ' is-collapsed' : ''}`}>
                    <button
                      type="button"
                      className="icon-picker-v2__group-label"
                      onClick={() => toggleIconGroup(group.id)}
                      aria-expanded={!isCollapsed}
                      aria-controls={`icon-group-${group.id}`}
                    >
                      <ChevronDown
                        size={12}
                        strokeWidth={2.5}
                        className="icon-picker-v2__group-chevron"
                        aria-hidden="true"
                      />
                      <span>{t(group.labelI18n, language)}</span>
                      <span className="icon-picker-v2__group-count">{group.entries.length}</span>
                    </button>
                    {!isCollapsed && (
                      <div className="icon-picker-v2__grid" id={`icon-group-${group.id}`}>
                        {group.entries.map(entry => {
                          const isSelected = icon === entry.id;
                          const IconComp = entry.Icon;
                          const label = t(entry.labelI18n, language);
                          return (
                            <button
                              key={entry.id}
                              type="button"
                              className={`icon-picker-v2__cell${isSelected ? ' is-selected' : ''}`}
                              onClick={() => { setIcon(entry.id); clearError('icon'); }}
                              title={label}
                              aria-label={label}
                              aria-pressed={isSelected}
                            >
                              <IconComp size={18} strokeWidth={1.8} />
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            {errors.has('icon') && (
              <span className="template-editor-error-text">
                <AlertCircle size={11} /> {t('templateFieldRequired', language)}
              </span>
            )}
          </div>
        )}

        {appearanceSubTab === 'color' && (
          <div className="template-editor-field">
            <div className={`color-theme-picker${errors.has('color') ? ' has-error' : ''}`}>
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
                      clearError('color');
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
              {/* 2026-05-22 — iOS-style switch (DS Toggle primitive)
                  replacing the native checkbox. Matches Settings sheets'
                  "section row + trailing switch" pattern. */}
              <Toggle
                label={t('customColor', language)}
                description={t('colorHint', language)}
                checked={useCustomColor}
                onChange={e => {
                  setUseCustomColor(e.target.checked);
                  if (e.target.checked && customColor.trim()) clearError('color');
                  if (!e.target.checked && cssclasses.trim()) clearError('color');
                }}
                className="color-custom-toggle"
              />
              {useCustomColor && (
                <HslColorPicker
                  value={customColor || '#a78bfa'}
                  onChange={(v) => { setCustomColor(v); if (v.trim()) clearError('color'); }}
                />
              )}
            </div>
            {/* colorHint moved into the Toggle's description above. */}
            {errors.has('color') && (
              <span className="template-editor-error-text">
                <AlertCircle size={11} /> {t('templateFieldRequired', language)}
              </span>
            )}
          </div>
        )}
      </div>
      </>
      )}

      {activeTab === 'tags' && (
      <>
      {/* Hotfix (2026-05-17, HanBin) — entire tag tab redesigned:
          • "자동 추가 태그" 평탄 필드 제거 (실제 노트 frontmatter는 4-facet
            객체라서 평탄 array는 dead code였음 — 기존 데이터는 위쪽
            `seededFromFlat`에서 prefix 파싱해 4 카테고리로 자동 흡수).
          • 고급 옵션 disclosure 제거. 4 카테고리가 곧 기본 인터페이스.
          • 카테고리당 단일 쉼표 input → TagInputSection chip-input
            (Enter/Tab 으로 chip 추가, X 로 제거, vault ontology 자동완성).
          단순/직관성 + 노트 생성 wizard와 같은 컴포넌트 = 일관된 UX. */}
      <div className="template-editor-section">
        <h4 className="template-editor-section-title">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/>
            <line x1="7" y1="7" x2="7.01" y2="7"/>
          </svg>
          {t('tagsSection', language)}
        </h4>
        <p className="template-editor-hint" style={{ marginBottom: 'var(--sp-3, 12px)' }}>
          {t('templateTagsSectionHint', language)}
        </p>
        <TagInputSection
          value={tagSelection}
          onChange={setTagSelection}
          language={language}
          collapsed={false}
        />
      </div>
      </>
      )}

      {activeTab === 'body' && (
      <>
      {/* v20 (2026-05-16, HanBin) — REVERTED v19 sub-tabs back to a single
          screen. HanBin: "본문 구조와 변수가 동시에 보여야 함. 변수는 본문
          구조 창에서 우측이나 좌측에 리스트로 구현할 것."
          New layout: variables list pinned to the LEFT (compact, scrollable
          column of chips grouped by category) + TipTap editor takes the
          remaining width. Click a chip → token inserts at cursor. The
          internal `viewMode` of TemplateBodyEditor stays 'both' so both
          surfaces are mounted; CSS column layout puts them side-by-side. */}
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
        <div className="template-editor-field template-body-split">
          <TemplateBodyEditor
            ref={bodyEditorRef}
            // HOTFIX (2026-05-17, HanBin) — pass the CURRENT `bodyMarkdown`
            // state, not `initialBody`. When the user switches to the 필드
            // tab and back, this component unmounts + remounts, the TipTap
            // editor recreates from scratch, and its `useEffect([editor])`
            // seeds content from whichever `initialMarkdown` prop is live
            // at that moment. Passing the constant `initialBody` (the
            // template's original body at load time) discarded everything
            // typed since then. Passing `bodyMarkdown` round-trips through
            // the parent state so the editor always re-seeds with the
            // user's latest content.
            initialMarkdown={bodyMarkdown}
            language={language}
            onChange={setBodyMarkdown}
            viewMode="both"
          />
          <span className="template-editor-hint">
            {t('templateBodyHint', language)}
          </span>
        </div>
      </div>
      </>
      )}

      <div className="template-editor-actions">
        <button className="template-editor-cancel-btn" onClick={onCancel}>{t('cancel', language)}</button>
        <button className="template-editor-save-btn" onClick={handleSave}>{t('save', language)}</button>
      </div>
    </div>
    {/* Stage 5.0.5a-γ5 — live preview pane on the right.
        Updates on every change to name / prefix / icon / color / body.
        v3 (HanBin): pass resolved themeColor so the preview tints whether
        a preset or custom color is selected (not just custom). */}
    <TemplatePreviewPane
      name={name}
      prefix={prefix}
      icon={icon}
      cssclasses={useCustomColor ? '' : cssclasses}
      customColor={useCustomColor ? customColor : undefined}
      themeColor={resolveActiveThemeColor(cssclasses, customColor, useCustomColor)}
      bodyMarkdown={bodyMarkdown}
      language={language}
    />
    </div>
  );
}

export default NoteTemplateEditor;
