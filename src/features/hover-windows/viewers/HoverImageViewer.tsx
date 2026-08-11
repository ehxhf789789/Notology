import { memo } from 'react';
import { convertFileSrc } from '../../../web/core';
import { ExternalLink } from 'lucide-react';
import { utilCommands } from '../../../core/services/tauriCommands';
import { useLanguage } from '../../../core/stores/zustand';
import { t } from '../../../core/utils/i18n';
import { hoverWindowPropsAreEqual, type HoverEditorWindowProps } from '../hoverAnimationUtils';
import { HoverWindowChrome } from '../components/HoverWindowChrome';

/**
 * HoverImageViewer — Stage 5.0.9d migration.
 *
 * Pre-5.0.9d this file was ~327 lines: ~250 of chrome boilerplate (drag,
 * resize, min, close, animation, multi-window detection) + ~30 of actual
 * image rendering. Chrome moved to `<HoverWindowChrome>` (5.0.9b). This
 * file is now ~25 lines of pure viewer logic: pick the title, pick the
 * external action (open-in-app), render `<img>`.
 */
const HoverImageViewer = memo(function HoverImageViewer({ window: win }: HoverEditorWindowProps) {
  const language = useLanguage();
  const fileName = win.filePath.split(/[/\\]/).pop() || '';
  const displayFileName = fileName.replace(/_/g, ' ');
  const imgSrc = convertFileSrc(win.filePath);

  return (
    <HoverWindowChrome
      window={win}
      title={displayFileName}
      bodyClassName="image-viewer-body"
      logLabel="HoverImageViewer"
      externalAction={{
        onClick: () => utilCommands.openInDefaultApp(win.filePath),
        icon: <ExternalLink size={14} />,
        label: t('openInApp', language),
      }}
    >
      <img src={imgSrc} alt={fileName} />
    </HoverWindowChrome>
  );
}, hoverWindowPropsAreEqual);

export default HoverImageViewer;
