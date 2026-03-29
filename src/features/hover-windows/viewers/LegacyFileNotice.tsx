import { FileWarning, ExternalLink } from 'lucide-react';
import { utilCommands } from '../../../core/services/tauriCommands';
import { t, type LanguageSetting } from '../../../core/utils/i18n';

interface LegacyFileNoticeProps {
  filePath: string;
  language: LanguageSetting;
}

export function LegacyFileNotice({ filePath, language }: LegacyFileNoticeProps) {
  const handleOpenExternal = () => {
    utilCommands.openInDefaultApp(filePath);
  };

  return (
    <div className="office-viewer-unsupported">
      <FileWarning size={48} className="office-viewer-unsupported-icon" />
      <p className="office-viewer-unsupported-text">
        {t('legacyFormatNotice', language)}
      </p>
      <p className="office-viewer-unsupported-hint">
        {t('legacyFormatHint', language)}
      </p>
      <button
        className="office-viewer-external-btn"
        onClick={handleOpenExternal}
      >
        <ExternalLink size={16} />
        {t('openInExternalApp', language)}
      </button>
    </div>
  );
}

export default LegacyFileNotice;
