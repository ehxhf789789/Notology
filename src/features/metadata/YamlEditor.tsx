import { useState, useEffect } from 'react';
import type { Frontmatter } from '../../core/types/frontmatter';
import { frontmatterToYaml, yamlToFrontmatter } from '../../core/utils/frontmatterUtils';
import { useSettingsStore } from '../../core/stores/settingsStore';
import { t } from '../../core/utils/i18n';

interface YamlEditorProps {
  frontmatter: Frontmatter;
  onChange: (fm: Frontmatter) => void;
}

function YamlEditor({ frontmatter, onChange }: YamlEditorProps) {
  const language = useSettingsStore(s => s.language);
  const [yamlText, setYamlText] = useState('');
  const [parseError, setParseError] = useState<string | null>(null);

  // Convert frontmatter to YAML when it changes
  useEffect(() => {
    const convertToYaml = async () => {
      try {
        const yaml = await frontmatterToYaml(frontmatter);
        setYamlText(yaml);
        setParseError(null);
      } catch (error) {
        console.error('Failed to convert to YAML:', error);
        setParseError(String(error));
      }
    };

    convertToYaml();
  }, [frontmatter]);

  // Parse YAML and update frontmatter
  const handleYamlChange = async (newYaml: string) => {
    setYamlText(newYaml);

    try {
      const parsed = await yamlToFrontmatter(newYaml);
      onChange(parsed);
      setParseError(null);
    } catch (error) {
      // Don't update frontmatter on parse error, just show the error
      setParseError(String(error));
    }
  };

  return (
    <div className="yaml-editor">
      {parseError && (
        <div className="yaml-editor-error">
          <strong>{t('yamlParseError', language)}</strong> {parseError}
        </div>
      )}

      <textarea
        className="yaml-editor-textarea"
        value={yamlText}
        onChange={(e) => handleYamlChange(e.target.value)}
        spellCheck={false}
        placeholder={t('yamlPlaceholder', language)}
      />

      <div className="yaml-editor-hint">
        <p>
          {t('yamlTip', language)} {t('yamlFormModeTip', language)}
        </p>
      </div>
    </div>
  );
}

export default YamlEditor;
