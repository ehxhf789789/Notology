import { memo } from 'react';
import { hoverWindowPropsAreEqual, type HoverEditorWindowProps } from '../hoverAnimationUtils';
import { HoverWindowChrome } from '../components/HoverWindowChrome';

/**
 * HoverWebViewer — Stage 5.0.9d migration.
 *
 * Sandboxed iframe inside HoverWindowChrome. The chrome owns all
 * drag/resize/min/close/animation logic; this file is the viewer-specific
 * remainder: title (truncated URL) + body (iframe).
 *
 * Sandbox: scripts + same-origin + forms + popups + downloads are
 * intentional; top-frame navigation is NOT allowed so a hostile / buggy
 * page can't escape and black-screen Notology.
 */
const HoverWebViewer = memo(function HoverWebViewer({ window: win }: HoverEditorWindowProps) {
  const url = win.filePath;
  const displayUrl = url.length > 50 ? url.substring(0, 47) + '...' : url;

  return (
    <HoverWindowChrome
      window={win}
      title={displayUrl}
      bodyClassName="web-viewer-body"
      logLabel="HoverWebViewer"
    >
      <iframe
        src={url}
        title="Web Viewer"
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads"
        referrerPolicy="no-referrer-when-downgrade"
        style={{ width: '100%', height: '100%', border: 'none' }}
      />
    </HoverWindowChrome>
  );
}, hoverWindowPropsAreEqual);

export default HoverWebViewer;
