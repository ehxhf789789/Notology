import { NodeViewContent, NodeViewWrapper } from '@tiptap/react';
import type { NodeViewProps } from '@tiptap/react';
import { useCallback, createElement } from 'react';

function HeadingView({ node, updateAttributes }: NodeViewProps) {
  const level = node.attrs.level || 1;
  const collapsed = node.attrs.collapsed || false;
  const textAlign = node.attrs.textAlign || 'left';

  const handleToggleCollapse = useCallback(() => {
    updateAttributes({ collapsed: !collapsed });
  }, [updateAttributes, collapsed]);

  // Build style object
  const style: React.CSSProperties = {};
  if (textAlign && textAlign !== 'left') {
    style.textAlign = textAlign;
  }

  const headingTag = `h${level}`;
  const dataAttrs: Record<string, string | undefined> = {};
  if (textAlign !== 'left') {
    dataAttrs['data-text-align'] = textAlign;
  }

  return (
    <NodeViewWrapper
      className={`heading-wrapper heading-level-${level} ${collapsed ? 'collapsed' : ''}`}
      data-collapsed={collapsed ? 'true' : undefined}
    >
      {createElement(
        headingTag,
        { style, ...dataAttrs },
        <>
          <button
            className="heading-toggle-btn"
            onClick={handleToggleCollapse}
            title={collapsed ? 'Expand' : 'Collapse'}
            type="button"
            contentEditable={false}
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              style={{ transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)', transition: 'transform 0.15s ease' }}
            >
              <polyline points="6 9 12 15 18 9"></polyline>
            </svg>
          </button>
          <span className="heading-content"><NodeViewContent /></span>
          {collapsed && (
            <span className="heading-collapsed-indicator" contentEditable={false}>
              ...
            </span>
          )}
        </>
      )}
    </NodeViewWrapper>
  );
}

export default HeadingView;
