import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react';
import { useState, useEffect } from 'react';
import { utilCommands } from '../../core/services/tauriCommands';
import { modalActions } from '../modals/stores/modalStore';
import { useSettingsStore } from '../../core/stores/settingsStore';
import { t } from '../../core/utils/i18n';

/**
 * v5.5 (2026-05-16) — single NodeViewWrapper with conditional content.
 * Previously: three separate `return <NodeViewWrapper>...` branches for
 * loading / error / success. Conditional NodeViewWrapper returns unmount
 * the wrapper subtree on state toggle (loading → ready) which destroys
 * any ProseMirror selection that happened to be on this atom mid-fetch.
 * One wrapper + inner branches preserves wrapper identity across state.
 */
function LinkCardView({ node, updateAttributes, deleteNode }: NodeViewProps) {
  const attrs = node.attrs as {
    url: string;
    title: string;
    description: string;
    image: string;
    favicon: string;
  };
  const { url, title, description, image, favicon } = attrs;
  const [isLoading, setIsLoading] = useState(!title);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (title) {
      setIsLoading(false);
      return;
    }
    if (url) {
      setIsLoading(true);
      utilCommands.fetchUrlMetadata(url)
        .then(metadata => {
          updateAttributes(metadata);
          setIsLoading(false);
        })
        .catch(err => {
          console.error('Failed to fetch URL metadata:', err);
          setError('Failed to load link preview');
          setIsLoading(false);
        });
    }
  }, [url, title, updateAttributes]);

  const handleClick = async (e: React.MouseEvent) => {
    e.preventDefault();
    if (url) {
      try {
        await utilCommands.openUrlInBrowser(url);
      } catch (err) {
        console.error('Failed to open URL:', err);
      }
    }
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const lang = useSettingsStore.getState().language;
    modalActions.showAtomContextMenu(
      { x: e.clientX, y: e.clientY },
      [{ label: t('deleteLinkCard', lang), onClick: () => deleteNode(), danger: true }],
    );
  };

  const stateClass = isLoading ? ' loading' : error ? ' error' : '';

  return (
    <NodeViewWrapper className={`link-card${stateClass}`} onContextMenu={handleContextMenu}>
      {isLoading ? (
        <div className="link-card-loading">Loading preview...</div>
      ) : error ? (
        <div className="link-card-content">
          <div className="link-card-error">{error}</div>
          <a href={url} target="_blank" rel="noopener noreferrer" className="link-card-url">
            {url}
          </a>
        </div>
      ) : (
        <div className="link-card-content" onClick={handleClick} contentEditable={false}>
          {image && (
            <div className="link-card-image">
              <img src={image} alt={title || url} />
            </div>
          )}
          <div className="link-card-body">
            <div className="link-card-header">
              {favicon && <img src={favicon} alt="" className="link-card-favicon" />}
              <div className="link-card-title">{title || url}</div>
            </div>
            {description && <div className="link-card-description">{description}</div>}
            <div className="link-card-url">{new URL(url).hostname}</div>
          </div>
        </div>
      )}
    </NodeViewWrapper>
  );
}

export default LinkCardView;
