import { useState, useEffect, useRef } from 'react';
import { useModalStore, modalActions } from '../../stores/zustand/modalStore';
import { useSettingsStore } from '../../stores/zustand/settingsStore';
import { t } from '../../utils/i18n';
import ParticipantInput from '../shared/ParticipantInput';
import TagInputSection, { type FacetedTagSelection } from '../shared/TagInputSection';

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
      // Round time to nearest 30 minutes
      const hours = today.getHours();
      const minutes = today.getMinutes();
      const roundedMinutes = minutes < 30 ? 0 : 30;
      const timeStr = `${String(hours).padStart(2, '0')}:${String(roundedMinutes).padStart(2, '0')}`;
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
    // Capture deep copy of tags BEFORE any state changes to avoid race conditions
    const capturedTags: FacetedTagSelection = {
      domain: [...selectedTags.domain],
      who: [...selectedTags.who],
      org: [...selectedTags.org],
      ctx: [...selectedTags.ctx],
    };
    const capturedData = { ...formData, tags: capturedTags };

    // Reset state first, then call callback to ensure tags are captured
    setFormData({ title: '', participants: '', date: '', time: '' });
    setSelectedTags(DEFAULT_TAGS);
    hideMeetingInputModal();

    // Call callback AFTER modal state is reset (tags are already captured)
    callback(capturedData);
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
              <div className="meeting-time-selects">
                <select
                  className="meeting-input-select meeting-time-period"
                  value={parseInt(formData.time.split(':')[0] || '9') < 12 ? 'AM' : 'PM'}
                  onChange={e => {
                    const currentHour = parseInt(formData.time.split(':')[0] || '9');
                    const minute = formData.time.split(':')[1] || '00';
                    const hour12 = currentHour % 12 || 12;
                    const newHour = e.target.value === 'AM'
                      ? (hour12 === 12 ? 0 : hour12)
                      : (hour12 === 12 ? 12 : hour12 + 12);
                    setFormData({ ...formData, time: `${String(newHour).padStart(2, '0')}:${minute}` });
                  }}
                >
                  <option value="AM">{language === 'ko' ? '오전' : 'AM'}</option>
                  <option value="PM">{language === 'ko' ? '오후' : 'PM'}</option>
                </select>
                <select
                  className="meeting-input-select meeting-time-hour"
                  value={(() => {
                    const h = parseInt(formData.time.split(':')[0] || '9');
                    return h % 12 || 12;
                  })()}
                  onChange={e => {
                    const currentHour = parseInt(formData.time.split(':')[0] || '9');
                    const minute = formData.time.split(':')[1] || '00';
                    const isPM = currentHour >= 12;
                    const newHour12 = parseInt(e.target.value);
                    const newHour = isPM
                      ? (newHour12 === 12 ? 12 : newHour12 + 12)
                      : (newHour12 === 12 ? 0 : newHour12);
                    setFormData({ ...formData, time: `${String(newHour).padStart(2, '0')}:${minute}` });
                  }}
                >
                  {[12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map(h => (
                    <option key={h} value={h}>{h}{language === 'ko' ? '시' : ''}</option>
                  ))}
                </select>
                <select
                  className="meeting-input-select meeting-time-minute"
                  value={formData.time.split(':')[1] || '00'}
                  onChange={e => {
                    const hour = formData.time.split(':')[0] || '09';
                    setFormData({ ...formData, time: `${hour}:${e.target.value}` });
                  }}
                >
                  <option value="00">00{language === 'ko' ? '분' : ''}</option>
                  <option value="30">30{language === 'ko' ? '분' : ''}</option>
                </select>
              </div>
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
