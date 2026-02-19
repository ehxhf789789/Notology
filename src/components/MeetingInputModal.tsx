import { useState, useEffect, useRef } from 'react';
import { useModalStore, modalActions } from '../stores/zustand/modalStore';
import { useSettingsStore } from '../stores/zustand/settingsStore';
import { t } from '../utils/i18n';
import ParticipantInput from './ParticipantInput';
import TagInputSection, { type FacetedTagSelection } from './TagInputSection';

export interface MeetingFormData {
  title: string;
  participants: string;
  date: string;
  time: string;
  tags?: FacetedTagSelection;
}

const DEFAULT_TAGS: FacetedTagSelection = {
  domain: [],
  who: [],
  org: [],
  ctx: [],
};

function MeetingInputModal() {
  const meetingInputModalState = useModalStore(s => s.meetingInputModalState);
  const hideMeetingInputModal = useModalStore(s => s.hideMeetingInputModal);
  const language = useSettingsStore(s => s.language);
  const [formData, setFormData] = useState<MeetingFormData>({
    title: '',
    participants: '',
    date: '',
    time: '',
  });
  const [selectedTags, setSelectedTags] = useState<FacetedTagSelection>(DEFAULT_TAGS);
  const titleInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (meetingInputModalState) {
      // Set default date to today
      const today = new Date();
      const dateStr = today.toISOString().split('T')[0];
      const timeStr = `${String(today.getHours()).padStart(2, '0')}:${String(today.getMinutes()).padStart(2, '0')}`;
      setFormData(prev => ({ ...prev, date: dateStr, time: timeStr }));

      if (titleInputRef.current) {
        titleInputRef.current.focus();
      }
    }
  }, [meetingInputModalState]);

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') hideMeetingInputModal();
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [hideMeetingInputModal]);

  if (!meetingInputModalState || !meetingInputModalState.visible) return null;

  const { callback } = meetingInputModalState;

  const handleSubmit = () => {
    if (!formData.title.trim()) {
      modalActions.showAlertModal(t('warning', language), t('meetingTitleRequired', language));
      return;
    }
    callback({ ...formData, tags: selectedTags });
    hideMeetingInputModal();
    setFormData({ title: '', participants: '', date: '', time: '' });
    setSelectedTags(DEFAULT_TAGS);
  };

  const handleCancel = () => {
    hideMeetingInputModal();
    setFormData({ title: '', participants: '', date: '', time: '' });
    setSelectedTags(DEFAULT_TAGS);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && e.ctrlKey) {
      handleSubmit();
    }
  };

  return (
    <div className="modal-overlay">
      <div className="meeting-input-modal" onKeyDown={handleKeyDown}>
        <div className="meeting-input-header">{t('meetingTitle', language)}</div>

        <div className="meeting-input-body">
          <div className="meeting-input-field">
            <label className="meeting-input-label">{t('meetingTitleField', language)}</label>
            <input
              ref={titleInputRef}
              className="meeting-input-input"
              type="text"
              value={formData.title}
              onChange={e => setFormData({ ...formData, title: e.target.value })}
              placeholder={t('meetingTitlePlaceholder', language)}
            />
          </div>

          <div className="meeting-input-field">
            <label className="meeting-input-label">{t('meetingParticipants', language)}</label>
            <ParticipantInput
              value={formData.participants}
              onChange={(participants) => setFormData({ ...formData, participants })}
              placeholder={t('meetingParticipantsPlaceholder', language)}
            />
          </div>

          <div className="meeting-input-row">
            <div className="meeting-input-field">
              <label className="meeting-input-label">{t('meetingDate', language)}</label>
              <input
                className="meeting-input-input"
                type="date"
                value={formData.date}
                onChange={e => setFormData({ ...formData, date: e.target.value })}
              />
            </div>

            <div className="meeting-input-field">
              <label className="meeting-input-label">{t('meetingTime', language)}</label>
              <input
                className="meeting-input-input"
                type="time"
                lang={language === 'en' ? 'en-US' : 'ko-KR'}
                value={formData.time}
                onChange={e => setFormData({ ...formData, time: e.target.value })}
              />
            </div>
          </div>

          <TagInputSection
            value={selectedTags}
            onChange={setSelectedTags}
            language={language}
            collapsed={true}
          />
        </div>

        <div className="meeting-input-actions">
          <button className="meeting-input-btn meeting-input-cancel" onClick={handleCancel}>
            {t('cancel', language)}
          </button>
          <button className="meeting-input-btn meeting-input-submit" onClick={handleSubmit}>
            {t('createCtrlEnter', language)}
          </button>
        </div>
      </div>
    </div>
  );
}

export default MeetingInputModal;
