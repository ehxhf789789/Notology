import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react';
import { useState, useEffect } from 'react';
import { utilCommands } from '../../core/services/tauriCommands';

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
    // If we already have metadata, don't fetch again
    if (title) {
      setIsLoading(false);
      return;
    }

    // Fetch metadata for the URL
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
      // Open URL in system default browser
      try {
        await utilCommands.openUrlInBrowser(url);
      } catch (err) {
        console.error('Failed to open URL:', err);
      }
    }
  };

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    deleteNode();
  };

  if (isLoading) {
    return (
      <NodeViewWrapper className="link-card loading">
        <div className="link-card-loading">Loading preview...</div>
      </NodeViewWrapper>
    );
  }

  if (error) {
    return (
      <NodeViewWrapper className="link-card error">
        <div className="link-card-content">
          <div className="link-card-error">{error}</div>
          <a href={url} target="_blank" rel="noopener noreferrer" className="link-card-url">
            {url}
          </a>
          <button className="link-card-delete" onClick={handleDelete}>×</button>
        </div>
      </NodeViewWrapper>
    );
  }

  return (
    <NodeViewWrapper className="link-card">
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
        <button className="link-card-delete" onClick={handleDelete}>×</button>
      </div>
    </NodeViewWrapper>
  );
}

export default LinkCardView;
