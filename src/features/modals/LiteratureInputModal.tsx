import { useState, useEffect, useRef } from 'react';
import { useModalStore } from './stores/modalStore';
import { useSettingsStore } from '../../core/stores/settingsStore';
import { t } from '../../core/utils/i18n';
import TagInputSection, { type FacetedTagSelection } from '../shared/TagInputSection';

export interface LiteratureFormData {
  title: string;
  authors: string;
  year: string;
  publisher: string;
  source: string;
  url: string;
  tags?: FacetedTagSelection;
}

const DEFAULT_TAGS: FacetedTagSelection = {
  domain: [],
  who: [],
  org: [],
  ctx: [],
};

function LiteratureInputModal() {
  const literatureInputModalState = useModalStore(s => s.literatureInputModalState);
  const hideLiteratureInputModal = useModalStore(s => s.hideLiteratureInputModal);
  const language = useSettingsStore(s => s.language);
  const [formData, setFormData] = useState<LiteratureFormData>({
    title: '',
    authors: '',
    year: '',
    publisher: '',
    source: '',
    url: '',
  });
  const [selectedTags, setSelectedTags] = useState<FacetedTagSelection>(DEFAULT_TAGS);
  const titleInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (literatureInputModalState) {
      // Set default year to current year
      const currentYear = new Date().getFullYear().toString();
      setFormData(prev => ({ ...prev, year: currentYear }));

      if (titleInputRef.current) {
        titleInputRef.current.focus();
      }
    }
  }, [literatureInputModalState]);

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') hideLiteratureInputModal();
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [hideLiteratureInputModal]);

  if (!literatureInputModalState || !literatureInputModalState.visible) return null;

  const { callback } = literatureInputModalState;

  const handleSubmit = () => {
    if (!formData.title.trim()) {
      alert(t('literatureTitleRequired', language));
      return;
    }
    // Capture deep copy of tags BEFORE any state changes to avoid race conditions
    const capturedTags: FacetedTagSelection = {
      domain: [...selectedTags.domain],
      who: [...selectedTags.who],
      org: [...selectedTags.org],
      ctx: [...selectedTags.ctx],
    };
    const capturedData = { ...formData, tags: capturedTags };

    // Reset state first, then call callback to ensure tags are captured
    setFormData({ title: '', authors: '', year: '', publisher: '', source: '', url: '' });
    setSelectedTags(DEFAULT_TAGS);
    hideLiteratureInputModal();

    // Call callback AFTER modal state is reset (tags are already captured)
    callback(capturedData);
  };

  const handleCancel = () => {
    hideLiteratureInputModal();
    setFormData({ title: '', authors: '', year: '', publisher: '', source: '', url: '' });
    setSelectedTags(DEFAULT_TAGS);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && e.ctrlKey) {
      handleSubmit();
    }
  };

  return (
    <div className="modal-overlay">
      <div className="literature-input-modal" onKeyDown={handleKeyDown}>
        <div className="literature-input-header">{t('literatureTitle', language)}</div>

        <div className="literature-input-body">
          <div className="literature-input-field">
            <label className="literature-input-label">{t('literatureTitleField', language)}</label>
            <input
              ref={titleInputRef}
              className="literature-input-input"
              type="text"
              value={formData.title}
              onChange={e => setFormData({ ...formData, title: e.target.value })}
              placeholder={t('literatureTitlePlaceholder', language)}
            />
          </div>

          <div className="literature-input-field">
            <label className="literature-input-label">{t('literatureAuthors', language)}</label>
            <input
              className="literature-input-input"
              type="text"
              value={formData.authors}
              onChange={e => setFormData({ ...formData, authors: e.target.value })}
              placeholder="예: Smith, J., Lee, H., Kim, S."
            />
          </div>

          <div className="literature-input-row">
            <div className="literature-input-field">
              <label className="literature-input-label">{t('literatureYear', language)}</label>
              <input
                className="literature-input-input"
                type="text"
                value={formData.year}
                onChange={e => setFormData({ ...formData, year: e.target.value })}
                placeholder="2024"
              />
            </div>

            <div className="literature-input-field">
              <label className="literature-input-label">{t('literaturePublisher', language)}</label>
              <input
                className="literature-input-input"
                type="text"
                value={formData.publisher}
                onChange={e => setFormData({ ...formData, publisher: e.target.value })}
                placeholder="예: Springer"
              />
            </div>
          </div>

          <div className="literature-input-field">
            <label className="literature-input-label">{t('literatureSource', language)}</label>
            <input
              className="literature-input-input"
              type="text"
              value={formData.source}
              onChange={e => setFormData({ ...formData, source: e.target.value })}
              placeholder={t('literatureSourcePlaceholder', language)}
            />
          </div>

          <div className="literature-input-field">
            <label className="literature-input-label">URL</label>
            <input
              className="literature-input-input"
              type="url"
              value={formData.url}
              onChange={e => setFormData({ ...formData, url: e.target.value })}
              placeholder="https://..."
            />
          </div>

          <TagInputSection
            value={selectedTags}
            onChange={setSelectedTags}
            language={language}
            collapsed={true}
          />
        </div>

        <div className="literature-input-actions">
          <button className="literature-input-btn literature-input-cancel" onClick={handleCancel}>
            {t('cancel', language)}
          </button>
          <button className="literature-input-btn literature-input-submit" onClick={handleSubmit}>
            {t('createCtrlEnter', language)}
          </button>
        </div>
      </div>
    </div>
  );
}

export default LiteratureInputModal;
