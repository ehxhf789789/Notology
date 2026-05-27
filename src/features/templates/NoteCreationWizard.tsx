/**
 * Stage 5.0.5a-β (2026-05-16, HanBin) — NoteCreationWizard.
 *
 * Triggered when a template's body contains user-input variables (autoFill
 * = false in TEMPLATE_VAR_CATALOG). Renders a single dialog with:
 *   - Title input (required)
 *   - One input field per unique user-input variable (grouped by category)
 *   - Tags input
 *   - Create / Cancel actions
 *
 * HanBin v11: "변수마다 modal 따로 뜨지 않게 — 한 wizard 에 모든 user-input
 * 변수 모아서 한 번에 입력." Implemented as a single form regardless of how
 * many `{{vars}}` appear in body.
 *
 * On submit, callback receives `{ title, varValues, tags }` — caller is
 * responsible for substituting these (+ auto-fill system variables) into
 * body via `buildSubstitutionMap` then `applyTemplateVariables`.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, AlertCircle } from 'lucide-react';
import { useModalStore, useNoteCreationWizardState } from '../modals/stores/modalStore';
import { useTemplateStore } from './stores/templateStore';
import { useSettingsStore } from '../../core/stores/settingsStore';
import { t } from '../../core/utils/i18n';
import { resolveTemplateIcon } from './templateIconCatalog';
import { scanUserInputVars, groupVarsByCategory } from './templateVarScan';

// v18 (2026-05-16, HanBin) — semantic HTML input types for known tokens so
// browsers can offer the right virtual keyboard / validation / autofill.
// Unknown tokens fall through to plain text.
function getInputTypeForToken(token: string): 'email' | 'tel' | 'url' | 'text' {
  switch (token) {
    case '{{email}}': return 'email';
    case '{{phone}}': return 'tel';
    case '{{url}}':
    case '{{doi}}':   return 'url';
    default: return 'text';
  }
}

function NoteCreationWizard() {
  const state = useNoteCreationWizardState();
  const hide = useModalStore((s) => s.hideNoteCreationWizard);
  const template = useTemplateStore((s) =>
    state ? s.noteTemplates.find(t => t.id === state.templateId) : undefined,
  );
  const language = useSettingsStore((s) => s.language);

  const [title, setTitle] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [titleError, setTitleError] = useState(false);
  const titleInputRef = useRef<HTMLInputElement>(null);

  // Scan body once per template change. Memo because TEMPLATE_VAR_CATALOG
  // walk + regex is unnecessary on every render.
  const userInputVars = useMemo(
    () => (template ? scanUserInputVars(template.body) : []),
    [template?.body],
  );
  const groups = useMemo(() => groupVarsByCategory(userInputVars), [userInputVars]);

  // Reset form whenever wizard opens fresh.
  useEffect(() => {
    if (!state) return;
    setTitle('');
    setValues({});
    setTitleError(false);
    setTimeout(() => titleInputRef.current?.focus(), 50);
  }, [state?.templateId]);

  // ESC closes (cancels).
  useEffect(() => {
    if (!state?.visible) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        state.callback(null);
        hide();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [state, hide]);

  if (!state?.visible || !template) return null;

  const handleSubmit = () => {
    const trimmed = title.trim();
    if (!trimmed) {
      setTitleError(true);
      titleInputRef.current?.focus();
      return;
    }
    state.callback({ title: trimmed, varValues: values });
    hide();
  };

  const handleCancel = () => {
    state.callback(null);
    hide();
  };

  const iconEntry = resolveTemplateIcon(template.icon);
  const IconComp = iconEntry.Icon;

  return createPortal(
    <div className="note-wizard-backdrop" onClick={handleCancel}>
      <div
        className="note-wizard"
        role="dialog"
        aria-modal="true"
        aria-labelledby="note-wizard-title"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header — template identity */}
        <div className="note-wizard-header">
          <span className="note-wizard-template">
            <IconComp size={16} strokeWidth={2} />
            <span className="note-wizard-template-name">{template.name}</span>
            <span className="note-wizard-template-prefix">{template.prefix}</span>
          </span>
          <button
            type="button"
            className="note-wizard-close"
            onClick={handleCancel}
            aria-label={t('cancel', language)}
          >
            <X size={16} />
          </button>
        </div>

        <h2 id="note-wizard-title" className="note-wizard-title">
          {t('wizardTitle', language)}
        </h2>

        <div className="note-wizard-body">
          {/* Title — always present, always required */}
          <div className="note-wizard-field">
            <label className="note-wizard-label">
              {t('templateNameField', language)} <span className="note-wizard-required">*</span>
            </label>
            <input
              ref={titleInputRef}
              type="text"
              className={`note-wizard-input${titleError ? ' has-error' : ''}`}
              value={title}
              onChange={(e) => { setTitle(e.target.value); if (e.target.value.trim()) setTitleError(false); }}
              placeholder={t('enterNoteTitlePlaceholder', language)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleSubmit();
                }
              }}
            />
            {titleError && (
              <span className="note-wizard-error">
                <AlertCircle size={11} /> {t('templateFieldRequired', language)}
              </span>
            )}
          </div>

          {/* Dynamic user-input fields grouped by category */}
          {groups.map(group => (
            <div key={group.category} className="note-wizard-group">
              <div className="note-wizard-group-label">{t(group.labelI18n, language)}</div>
              {group.entries.map((spec) => {
                const FieldIcon = spec.Icon;
                const key = spec.token.replace(/^\{\{|\}\}$/g, '');
                // v18 — semantic input type so the OS / browser supplies
                // the right keyboard layout, autofill suggestions, and
                // (for email/url) basic format hints.
                const inputType = getInputTypeForToken(spec.token);
                return (
                  <div key={spec.token} className="note-wizard-field">
                    <label className="note-wizard-label">
                      <FieldIcon size={12} strokeWidth={2} />
                      {t(spec.labelI18n, language)}
                      <code className="note-wizard-token">{spec.token}</code>
                    </label>
                    <input
                      type={inputType}
                      className="note-wizard-input"
                      value={values[key] || ''}
                      onChange={(e) => setValues(prev => ({ ...prev, [key]: e.target.value }))}
                      placeholder={t(spec.labelI18n, language)}
                      autoComplete={inputType === 'email' ? 'email' : inputType === 'tel' ? 'tel' : 'off'}
                      inputMode={inputType === 'tel' ? 'tel' : inputType === 'email' ? 'email' : inputType === 'url' ? 'url' : undefined}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault();
                          handleSubmit();
                        }
                      }}
                    />
                  </div>
                );
              })}
            </div>
          ))}
        </div>

        <div className="note-wizard-actions">
          <button type="button" className="note-wizard-cancel" onClick={handleCancel}>
            {t('cancel', language)}
          </button>
          <button type="button" className="note-wizard-submit" onClick={handleSubmit}>
            {t('wizardCreateNote', language)}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export default NoteCreationWizard;
