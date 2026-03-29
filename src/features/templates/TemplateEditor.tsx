import { useState } from 'react';
import type { FolderNoteTemplate } from '../../core/types';
import { useSettingsStore } from '../../core/stores/settingsStore';
import { t } from '../../core/utils/i18n';

interface TemplateEditorProps {
  template?: FolderNoteTemplate;
  onSave: (template: FolderNoteTemplate) => void;
  onCancel: () => void;
}

function TemplateEditor({ template, onSave, onCancel }: TemplateEditorProps) {
  const language = useSettingsStore(s => s.language);
  const [name, setName] = useState(template?.name || '');
  const [level, setLevel] = useState(template?.level ?? 0);
  const [body, setBody] = useState(template?.body || '# {{title}}\n\n');
  const [tags, setTags] = useState(template?.frontmatter.tags?.join(', ') || '');
  const [cssclasses, setCssclasses] = useState(template?.frontmatter.cssclasses?.join(', ') || '');

  const handleSave = () => {
    if (!name.trim()) return;

    const newTemplate: FolderNoteTemplate = {
      id: template?.id || `b-${Date.now()}`,
      name: name.trim(),
      type: 'B',
      level,
      frontmatter: {
        type: 'FOLDER',
        cssclasses: cssclasses ? cssclasses.split(',').map(s => s.trim()).filter(Boolean) : [],
        tags: tags ? tags.split(',').map(s => s.trim()).filter(Boolean) : [],
      },
      body,
    };

    onSave(newTemplate);
  };

  return (
    <div className="template-editor">
      <div className="template-editor-field">
        <label className="template-editor-label">{t('name', language)}</label>
        <input
          className="template-editor-input"
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder={t('templateNameField', language)}
        />
      </div>

      <div className="template-editor-field">
        <label className="template-editor-label">{t('level', language)}</label>
        <input
          className="template-editor-input template-editor-input-small"
          type="number"
          min={0}
          max={10}
          value={level}
          onChange={e => setLevel(Number(e.target.value))}
        />
      </div>

      <div className="template-editor-field">
        <label className="template-editor-label">{t('templateCssClasses', language)}</label>
        <input
          className="template-editor-input"
          value={cssclasses}
          onChange={e => setCssclasses(e.target.value)}
          placeholder={`folder-custom (${t('commaSeparated', language)})`}
        />
      </div>

      <div className="template-editor-field">
        <label className="template-editor-label">{t('tags', language)}</label>
        <input
          className="template-editor-input"
          value={tags}
          onChange={e => setTags(e.target.value)}
          placeholder={`${t('tags', language)} (${t('commaSeparated', language)})`}
        />
      </div>

      <div className="template-editor-field">
        <label className="template-editor-label">{t('bodyMarkdown', language)}</label>
        <textarea
          className="template-editor-textarea"
          value={body}
          onChange={e => setBody(e.target.value)}
          rows={6}
          placeholder="# {{title}}"
        />
      </div>

      <div className="template-editor-actions">
        <button className="settings-action-btn" onClick={onCancel}>{t('cancel', language)}</button>
        <button className="template-editor-save-btn" onClick={handleSave}>{t('save', language)}</button>
      </div>
    </div>
  );
}

export default TemplateEditor;
