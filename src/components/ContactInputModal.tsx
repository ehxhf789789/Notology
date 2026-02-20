import { useState, useEffect, useRef, useCallback } from 'react';
import { useModalStore } from '../stores/zustand/modalStore';
import { useSettingsStore } from '../stores/zustand/settingsStore';
import { t } from '../utils/i18n';
import TagInputSection, { type FacetedTagSelection } from './TagInputSection';

export interface ContactFormData {
  name: string;
  email: string;
  company: string;
  position: string;
  phone: string;
  location: string;
  tags?: FacetedTagSelection;
}

const DEFAULT_TAGS: FacetedTagSelection = {
  domain: [],
  who: [],
  org: [],
  ctx: [],
};

function ContactInputModal() {
  const contactInputModalState = useModalStore(s => s.contactInputModalState);
  const hideContactInputModal = useModalStore(s => s.hideContactInputModal);
  const language = useSettingsStore(s => s.language);
  const [formData, setFormData] = useState<ContactFormData>({
    name: '',
    email: '',
    company: '',
    position: '',
    phone: '',
    location: '',
  });
  const [selectedTags, setSelectedTags] = useState<FacetedTagSelection>(DEFAULT_TAGS);
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef<{ x: number; y: number; posX: number; posY: number } | null>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);

  // Reset position when modal opens
  useEffect(() => {
    if (contactInputModalState?.visible) {
      setPosition(null);
    }
  }, [contactInputModalState?.visible]);

  // Drag handlers
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (!modalRef.current) return;
    e.preventDefault();
    const rect = modalRef.current.getBoundingClientRect();
    dragStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      posX: rect.left,
      posY: rect.top,
    };
    setIsDragging(true);
  }, []);

  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!dragStartRef.current) return;
      const dx = e.clientX - dragStartRef.current.x;
      const dy = e.clientY - dragStartRef.current.y;
      setPosition({
        x: dragStartRef.current.posX + dx,
        y: dragStartRef.current.posY + dy,
      });
    };

    const handleMouseUp = () => {
      setIsDragging(false);
      dragStartRef.current = null;
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging]);

  useEffect(() => {
    if (!contactInputModalState) return;

    // Focus name field when modal opens
    if (nameInputRef.current) {
      nameInputRef.current.focus();
    }

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') hideContactInputModal();
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [contactInputModalState, hideContactInputModal]);

  if (!contactInputModalState || !contactInputModalState.visible) return null;

  const { callback } = contactInputModalState;

  const handleSubmit = () => {
    if (!formData.name.trim()) {
      alert(t('contactNameRequired', language));
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
    setFormData({ name: '', email: '', company: '', position: '', phone: '', location: '' });
    setSelectedTags(DEFAULT_TAGS);
    hideContactInputModal();

    // Call callback AFTER modal state is reset (tags are already captured)
    callback(capturedData);
  };

  const handleCancel = () => {
    hideContactInputModal();
    setFormData({ name: '', email: '', company: '', position: '', phone: '', location: '' });
    setSelectedTags(DEFAULT_TAGS);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && e.ctrlKey) {
      handleSubmit();
    }
  };

  const modalStyle: React.CSSProperties = position
    ? { position: 'fixed', left: position.x, top: position.y, transform: 'none' }
    : {};

  return (
    <div className="modal-overlay">
      <div
        ref={modalRef}
        className="contact-input-modal"
        onKeyDown={handleKeyDown}
        style={modalStyle}
      >
        <div
          className="contact-input-header"
          onMouseDown={handleMouseDown}
          style={{ cursor: 'move' }}
        >
          {t('contactTitle', language)}
        </div>

        <div className="contact-input-body">
          <div className="contact-input-field">
            <label className="contact-input-label">{t('contactNameField', language)}</label>
            <input
              ref={nameInputRef}
              className="contact-input-input"
              type="text"
              value={formData.name}
              onChange={e => setFormData({ ...formData, name: e.target.value })}
              placeholder={t('contactNamePlaceholder', language)}
            />
          </div>

          <div className="contact-input-field">
            <label className="contact-input-label">{t('contactEmail', language)}</label>
            <input
              className="contact-input-input"
              type="email"
              value={formData.email}
              onChange={e => setFormData({ ...formData, email: e.target.value })}
              placeholder="hong@example.com"
            />
          </div>

          <div className="contact-input-field">
            <label className="contact-input-label">{t('contactCompany', language)}</label>
            <input
              className="contact-input-input"
              type="text"
              value={formData.company}
              onChange={e => setFormData({ ...formData, company: e.target.value })}
              placeholder={t('contactCompanyPlaceholder', language)}
            />
          </div>

          <div className="contact-input-field">
            <label className="contact-input-label">{t('contactPosition', language)}</label>
            <input
              className="contact-input-input"
              type="text"
              value={formData.position}
              onChange={e => setFormData({ ...formData, position: e.target.value })}
              placeholder={t('contactPositionPlaceholder', language)}
            />
          </div>

          <div className="contact-input-field">
            <label className="contact-input-label">{t('contactPhone', language)}</label>
            <input
              className="contact-input-input"
              type="tel"
              value={formData.phone}
              onChange={e => setFormData({ ...formData, phone: e.target.value })}
              placeholder={t('contactPhonePlaceholder', language)}
            />
          </div>

          <div className="contact-input-field">
            <label className="contact-input-label">{t('contactLocation', language)}</label>
            <input
              className="contact-input-input"
              type="text"
              value={formData.location}
              onChange={e => setFormData({ ...formData, location: e.target.value })}
              placeholder={t('contactLocationPlaceholder', language)}
            />
          </div>

          <TagInputSection
            value={selectedTags}
            onChange={setSelectedTags}
            language={language}
            collapsed={true}
          />
        </div>

        <div className="contact-input-actions">
          <button className="contact-input-btn contact-input-cancel" onClick={handleCancel}>
            {t('cancel', language)}
          </button>
          <button className="contact-input-btn contact-input-submit" onClick={handleSubmit}>
            {t('createCtrlEnter', language)}
          </button>
        </div>
      </div>
    </div>
  );
}

export default ContactInputModal;
