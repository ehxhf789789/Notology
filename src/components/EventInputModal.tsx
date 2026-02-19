import { useState, useEffect, useRef } from 'react';
import { useModalStore, modalActions } from '../stores/zustand/modalStore';
import { useSettingsStore } from '../stores/zustand/settingsStore';
import { t } from '../utils/i18n';
import ParticipantInput from './ParticipantInput';
import TagInputSection, { type FacetedTagSelection } from './TagInputSection';

export interface EventFormData {
  title: string;
  date: string;
  location: string;
  organizer: string;
  participants: string;
  tags?: FacetedTagSelection;
}

const DEFAULT_TAGS: FacetedTagSelection = {
  domain: [],
  who: [],
  org: [],
  ctx: [],
};

function EventInputModal() {
  const eventInputModalState = useModalStore(s => s.eventInputModalState);
  const hideEventInputModal = useModalStore(s => s.hideEventInputModal);
  const language = useSettingsStore(s => s.language);
  const [formData, setFormData] = useState<EventFormData>({
    title: '',
    date: '',
    location: '',
    organizer: '',
    participants: '',
  });
  const [selectedTags, setSelectedTags] = useState<FacetedTagSelection>(DEFAULT_TAGS);
  const titleInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (eventInputModalState) {
      // Set default date to today
      const today = new Date();
      const dateStr = today.toISOString().split('T')[0];
      setFormData(prev => ({ ...prev, date: dateStr }));

      if (titleInputRef.current) {
        titleInputRef.current.focus();
      }
    }
  }, [eventInputModalState]);

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') hideEventInputModal();
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [hideEventInputModal]);

  if (!eventInputModalState || !eventInputModalState.visible) return null;

  const { callback } = eventInputModalState;

  const handleSubmit = () => {
    if (!formData.title.trim()) {
      modalActions.showAlertModal(t('warning', language), t('eventTitleRequired', language));
      return;
    }
    callback({ ...formData, tags: selectedTags });
    hideEventInputModal();
    setFormData({ title: '', date: '', location: '', organizer: '', participants: '' });
    setSelectedTags(DEFAULT_TAGS);
  };

  const handleCancel = () => {
    hideEventInputModal();
    setFormData({ title: '', date: '', location: '', organizer: '', participants: '' });
    setSelectedTags(DEFAULT_TAGS);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && e.ctrlKey) {
      handleSubmit();
    }
  };

  return (
    <div className="modal-overlay">
      <div className="event-input-modal" onKeyDown={handleKeyDown}>
        <div className="event-input-header">{t('eventTitle', language)}</div>

        <div className="event-input-body">
          <div className="event-input-field">
            <label className="event-input-label">{t('eventTitleField', language)}</label>
            <input
              ref={titleInputRef}
              className="event-input-input"
              type="text"
              value={formData.title}
              onChange={e => setFormData({ ...formData, title: e.target.value })}
              placeholder={t('eventTitlePlaceholder', language)}
            />
          </div>

          <div className="event-input-field">
            <label className="event-input-label">{t('eventDate', language)}</label>
            <input
              className="event-input-input"
              type="date"
              value={formData.date}
              onChange={e => setFormData({ ...formData, date: e.target.value })}
            />
          </div>

          <div className="event-input-field">
            <label className="event-input-label">{t('eventLocation', language)}</label>
            <input
              className="event-input-input"
              type="text"
              value={formData.location}
              onChange={e => setFormData({ ...formData, location: e.target.value })}
              placeholder={t('eventLocationPlaceholder', language)}
            />
          </div>

          <div className="event-input-field">
            <label className="event-input-label">{t('eventOrganizer', language)}</label>
            <input
              className="event-input-input"
              type="text"
              value={formData.organizer}
              onChange={e => setFormData({ ...formData, organizer: e.target.value })}
              placeholder={t('eventOrganizerPlaceholder', language)}
            />
          </div>

          <div className="event-input-field">
            <label className="event-input-label">{t('eventParticipants', language)}</label>
            <ParticipantInput
              value={formData.participants}
              onChange={(participants) => setFormData({ ...formData, participants })}
              placeholder={t('eventParticipantsPlaceholder', language)}
            />
          </div>

          <TagInputSection
            value={selectedTags}
            onChange={setSelectedTags}
            language={language}
            collapsed={true}
          />
        </div>

        <div className="event-input-actions">
          <button className="event-input-btn event-input-cancel" onClick={handleCancel}>
            {t('cancel', language)}
          </button>
          <button className="event-input-btn event-input-submit" onClick={handleSubmit}>
            {t('createCtrlEnter', language)}
          </button>
        </div>
      </div>
    </div>
  );
}

export default EventInputModal;
