/**
 * v18 (2026-05-16, HanBin) — TitleInputModal now also collects user-input
 * variable values inline. Previously this modal only asked for a title and
 * delegated variable collection to a SEPARATE NoteCreationWizard modal,
 * which the user explicitly rejected: "이 창에서 진행되어야 한다."
 *
 * The modal is the single create-from-template UI:
 *   - Template icon (lucide component, fixes the missing-icon bug for
 *     custom templates whose `icon-${type}` CSS class never existed)
 *   - Title (required)
 *   - Dynamic per-variable inputs (grouped by category, semantic types
 *     for email/tel/url) — only rendered when the template declares
 *     `{{vars}}` in its body
 *   - Tags (collapsible)
 *   - Submit returns { title, tags, varValues }
 *
 * The standalone NoteCreationWizard is now superseded by this modal and
 * can be removed once we confirm no other entry point calls it.
 */
import { useState, useEffect, useRef, useMemo } from 'react';
import { AlertCircle } from 'lucide-react';
import { useModalStore } from './stores/modalStore';
import { useSettingsStore } from '../../core/stores/settingsStore';
import { t } from '../../core/utils/i18n';
import TagInputSection, { emptyFacetSelection, type FacetedTagSelection } from '../shared/TagInputSection';
import { resolveTemplateIcon } from '../templates/templateIconCatalog';
import { Type as TypeIcon } from 'lucide-react';
import { TEMPLATE_VAR_CATALOG, TEMPLATE_VAR_CATEGORIES, type TemplateVarSpec } from '../templates/templateVarCatalog';

const DEFAULT_TAGS: FacetedTagSelection = emptyFacetSelection();

// v18 — semantic HTML input types for known tokens so browsers can offer
// the right virtual keyboard / autofill / basic validation. Unknown
// tokens fall through to plain text.
function getInputTypeForToken(token: string): 'email' | 'tel' | 'url' | 'text' {
  switch (token) {
    case '{{email}}': return 'email';
    case '{{phone}}': return 'tel';
    case '{{url}}':
    case '{{doi}}':   return 'url';
    default: return 'text';
  }
}

const SPEC_BY_TOKEN: Record<string, TemplateVarSpec> = (() => {
  const m: Record<string, TemplateVarSpec> = {};
  for (const s of TEMPLATE_VAR_CATALOG) m[s.token] = s;
  return m;
})();

function TitleInputModal() {
  const titleInputModalState = useModalStore(s => s.titleInputModalState);
  const hideTitleInputModal = useModalStore(s => s.hideTitleInputModal);
  const language = useSettingsStore(s => s.language);
  const [inputValue, setInputValue] = useState('');
  const [selectedTags, setSelectedTags] = useState<FacetedTagSelection>(DEFAULT_TAGS);
  const [varValues, setVarValues] = useState<Record<string, string>>({});
  const [titleError, setTitleError] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Group user-input tokens by their catalog category so the modal stays
  // scannable when several variables are present.
  //
  // Hotfix (2026-05-17, HanBin) — unknown tokens (anything outside
  // TEMPLATE_VAR_CATALOG) are now treated as `custom` category plain-text
  // inputs instead of being silently dropped. Previously templates with
  // author-defined variables produced an empty wizard form even though the
  // editor's Fields tab promised they'd render.
  const tokens = titleInputModalState?.userInputTokens ?? [];
  const groupedVars = useMemo(() => {
    if (tokens.length === 0) return [];
    const seen = new Set<string>();
    const specs: TemplateVarSpec[] = [];
    for (const tok of tokens) {
      if (seen.has(tok)) continue;
      seen.add(tok);
      const spec = SPEC_BY_TOKEN[tok];
      if (spec) {
        // Catalog token — skip auto-fill (those don't need a form input).
        if (!spec.autoFill) specs.push(spec);
      } else {
        // Unknown token — synthesize a plain-text input spec under the
        // `custom` category so the wizard renders it. Label is the bare
        // token name; t() falls through to the key string itself when
        // unknown, giving a sensible default without per-template i18n.
        specs.push({
          token: tok,
          labelI18n: tok.replace(/^\{\{|\}\}$/g, ''),
          Icon: TypeIcon,
          category: 'custom',
          autoFill: false,
        });
      }
    }
    if (specs.length === 0) return [];
    return TEMPLATE_VAR_CATEGORIES
      .map(cat => ({ ...cat, entries: specs.filter(s => s.category === cat.id) }))
      .filter(g => g.entries.length > 0);
    // tokens reference is recomputed each render — depend on its joined form
    // to keep this memo stable across re-renders that didn't change content.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tokens.join('|')]);

  useEffect(() => {
    if (titleInputModalState && inputRef.current) {
      inputRef.current.focus();
    }
  }, [titleInputModalState]);

  // Reset all field state whenever the modal is opened fresh (templateId
  // change is implicit — visibility cycles between opens).
  //
  // Hotfix (2026-05-17, HanBin) — honor `initialInputValue` so callers
  // (migration flow) can pre-fill the title box with the existing note's
  // filename. Default Ctrl+N flow doesn't pass this → input opens empty.
  //
  // 10th hotfix (2026-05-17, HanBin) — honor `initialTags` so the
  // template's pre-defined tagCategories appear as visible chips before
  // the user clicks 생성. Without this they were applied silently at
  // save time and the wizard tag section was always empty.
  useEffect(() => {
    if (!titleInputModalState?.visible) return;
    setInputValue(titleInputModalState.initialInputValue ?? '');
    setSelectedTags(titleInputModalState.initialTags ?? DEFAULT_TAGS);
    setVarValues({});
    setTitleError(false);
  }, [
    titleInputModalState?.visible,
    titleInputModalState?.templateInfo?.name,
    titleInputModalState?.initialInputValue,
    titleInputModalState?.initialTags,
  ]);

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') hideTitleInputModal();
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [hideTitleInputModal]);

  if (!titleInputModalState || !titleInputModalState.visible) return null;

  const { callback, placeholder, title, templateInfo } = titleInputModalState;

  const handleSubmit = () => {
    if (!inputValue.trim()) {
      setTitleError(true);
      inputRef.current?.focus();
      return;
    }
    // Capture deep copy of tags BEFORE any state changes to avoid race conditions
    const capturedTags: FacetedTagSelection = { ...selectedTags };
    const capturedVarValues = { ...varValues };
    const capturedData = {
      title: inputValue.trim(),
      tags: capturedTags,
      varValues: capturedVarValues,
    };

    // Reset state first, then call callback to ensure data is captured
    setInputValue('');
    setSelectedTags(DEFAULT_TAGS);
    setVarValues({});
    setTitleError(false);
    hideTitleInputModal();

    // Call callback AFTER modal state is reset (values already captured)
    callback(capturedData);
  };

  const handleCancel = () => {
    hideTitleInputModal();
    setInputValue('');
    setSelectedTags(DEFAULT_TAGS);
    setVarValues({});
    setTitleError(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  // v18 — resolve the lucide icon component for the template. Falls back to
  // 'sticky-note' for legacy/unknown ids so the chip never renders blank.
  const iconEntry = templateInfo ? resolveTemplateIcon(templateInfo.icon) : null;
  const IconComp = iconEntry?.Icon;
  const tileColor = templateInfo?.customColor || 'var(--tx-2)';

  return (
    <div className="modal-overlay">
      <div className={`modal-shell title-input-modal ${templateInfo ? 'with-template-info' : ''}`}>
        <div className="title-input-header">{title || t('createNewNoteTitle', language)}</div>
        {templateInfo && IconComp && (
          <div className="title-input-template-info">
            <span
              className="title-input-template-icon-tile"
              style={{
                backgroundColor: `color-mix(in srgb, ${tileColor} 16%, transparent)`,
                color: tileColor,
              }}
            >
              <IconComp size={16} strokeWidth={2} />
            </span>
            <div className="title-input-template-details">
              <div className="title-input-template-name">{templateInfo.name}</div>
              <div className="title-input-template-desc">{templateInfo.description}</div>
            </div>
          </div>
        )}
        <div className="title-input-body">
          <input
            ref={inputRef}
            className={`title-input-field${titleError ? ' has-error' : ''}`}
            type="text"
            value={inputValue}
            onChange={e => { setInputValue(e.target.value); if (e.target.value.trim()) setTitleError(false); }}
            onKeyDown={handleKeyDown}
            placeholder={placeholder || t('enterNoteTitlePlaceholder', language)}
            aria-invalid={titleError}
          />
          {titleError && (
            <span className="title-input-error-text">
              <AlertCircle size={11} /> {t('templateFieldRequired', language)}
            </span>
          )}

          {/* v18 — inline variable inputs. Only rendered when the template
              body declares user-input `{{vars}}`. Grouped by catalog
              category so the modal stays scannable when several are
              present (e.g., {{name}} {{email}} {{phone}}). */}
          {groupedVars.length > 0 && (
            <div className="title-input-vars">
              {groupedVars.map(group => (
                <div key={group.id} className="title-input-vars__group">
                  <div className="title-input-vars__group-label">{t(group.labelI18n, language)}</div>
                  {group.entries.map(spec => {
                    const FieldIcon = spec.Icon;
                    const key = spec.token.replace(/^\{\{|\}\}$/g, '');
                    const inputType = getInputTypeForToken(spec.token);
                    return (
                      <div key={spec.token} className="title-input-vars__field">
                        <label className="title-input-vars__label">
                          <FieldIcon size={12} strokeWidth={2} />
                          <span>{t(spec.labelI18n, language)}</span>
                          <code className="title-input-vars__token">{spec.token}</code>
                        </label>
                        <input
                          type={inputType}
                          className="title-input-field"
                          value={varValues[key] || ''}
                          onChange={e => setVarValues(prev => ({ ...prev, [key]: e.target.value }))}
                          placeholder={t(spec.labelI18n, language)}
                          autoComplete={inputType === 'email' ? 'email' : inputType === 'tel' ? 'tel' : 'off'}
                          inputMode={inputType === 'tel' ? 'tel' : inputType === 'email' ? 'email' : inputType === 'url' ? 'url' : undefined}
                          onKeyDown={handleKeyDown}
                        />
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          )}

          <TagInputSection
            value={selectedTags}
            onChange={setSelectedTags}
            language={language}
            collapsed={true}
          />
        </div>
        <div className="title-input-actions">
          <button className="title-input-btn title-input-cancel" onClick={handleCancel}>
            {t('cancel', language)}
          </button>
          <button className="title-input-btn title-input-submit" onClick={handleSubmit}>
            {t('createEnter', language)}
          </button>
        </div>
      </div>
    </div>
  );
}

export default TitleInputModal;
