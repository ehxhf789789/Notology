import { memo } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { ExternalLink } from 'lucide-react';
import { utilCommands } from '../../../core/services/tauriCommands';
import { useLanguage } from '../../../core/stores/zustand';
import { t } from '../../../core/utils/i18n';
import { hoverWindowPropsAreEqual, type HoverEditorWindowProps } from '../hoverAnimationUtils';
import { HoverWindowChrome } from '../components/HoverWindowChrome';

/**
 * HoverPdfViewer — Stage 5.0.9d migration.
 *
 * Renders PDFs via native WebView2 (full toolbar, full speed). The
 * `chrome://settings` nav escape from the ⋮ menu is blocked at the
 * WebView2 controller level (see `WebviewWindowBuilder::on_navigation`
 * in src-tauri/.../system.rs — search `[hover-nav-guard]`). No PDF.js
 * fallback on the hot path, no click-blocker overlay needed.
 *
 * Chrome (drag/resize/min/close/animation) owned by `<HoverWindowChrome>`.
 * Pre-migration: ~345 lines.
 */
const HoverPdfViewer = memo(function HoverPdfViewer({ window: win }: HoverEditorWindowProps) {
  const language = useLanguage();
  const fileName = win.filePath.split(/[/\\]/).pop() || '';
  const displayFileName = fileName.replace(/_/g, ' ');

  return (
    <HoverWindowChrome
      window={win}
      title={displayFileName}
      bodyClassName="pdf-viewer-body"
      logLabel="HoverPdfViewer"
      externalAction={{
        onClick: () => utilCommands.openInDefaultApp(win.filePath),
        icon: <ExternalLink size={14} />,
        label: t('openInApp', language),
      }}
    >
      <iframe
        src={convertFileSrc(win.filePath)}
        referrerPolicy="no-referrer"
        style={{ width: '100%', height: '100%', border: 'none' }}
        title={fileName}
      />
    </HoverWindowChrome>
  );
}, hoverWindowPropsAreEqual);

export default HoverPdfViewer;
