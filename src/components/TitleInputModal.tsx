import { useState, useEffect, useRef } from 'react';
import { useModalStore } from '../stores/zustand/modalStore';
import { useSettingsStore } from '../stores/zustand/settingsStore';
import { t } from '../utils/i18n';
import TagInputSection, { type FacetedTagSelection } from './TagInputSection';

const DEFAULT_TAGS: FacetedTagSelection = {
  domain: [],
  who: [],
  org: [],
  ctx: [],
};

function TitleInputModal() {
  const titleInputModalState = useModalStore(s => s.titleInputModalState);
  const hideTitleInputModal = useModalStore(s => s.hideTitleInputModal);
  const language = useSettingsStore(s => s.language);
  const [inputValue, setInputValue] = useState('');
  const [selectedTags, setSelectedTags] = useState<FacetedTagSelection>(DEFAULT_TAGS);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (titleInputModalState && inputRef.current) {
      inputRef.current.focus();
    }
  }, [titleInputModalState]);

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
      alert(t('enterTitle', language));
      return;
    }
    // Capture deep copy of tags BEFORE any state changes to avoid race conditions
    const capturedTags: FacetedTagSelection = {
      domain: [...selectedTags.domain],
      who: [...selectedTags.who],
      org: [...selectedTags.org],
      ctx: [...selectedTags.ctx],
    };
    const capturedData = { title: inputValue.trim(), tags: capturedTags };

    // Reset state first, then call callback to ensure tags are captured
    setInputValue('');
    setSelectedTags(DEFAULT_TAGS);
    hideTitleInputModal();

    // Call callback AFTER modal state is reset (tags are already captured)
    callback(capturedData);
  };

  const handleCancel = () => {
    hideTitleInputModal();
    setInputValue('');
    setSelectedTags(DEFAULT_TAGS);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const iconClass = templateInfo ? `icon-${templateInfo.noteType}` : '';

  return (
    <div className="modal-overlay">
      <div className={`title-input-modal ${templateInfo ? 'with-template-info' : ''}`}>
        <div className="title-input-header">{title || t('createNewNoteTitle', language)}</div>
        {templateInfo && (
          <div className="title-input-template-info">
            <span
              className={`title-input-template-icon template-selector-icon ${iconClass}`}
              style={templateInfo.customColor ? { backgroundColor: templateInfo.customColor } : undefined}
            />
            <div className="title-input-template-details">
              <div className="title-input-template-name">{templateInfo.name}</div>
              <div className="title-input-template-desc">{templateInfo.description}</div>
            </div>
          </div>
        )}
        <div className="title-input-body">
          <input
            ref={inputRef}
            className="title-input-field"
            type="text"
            value={inputValue}
            onChange={e => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={placeholder || t('enterNoteTitlePlaceholder', language)}
          />
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
