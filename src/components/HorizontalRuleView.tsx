import { NodeViewWrapper } from '@tiptap/react';
import type { NodeViewProps } from '@tiptap/react';
import { useCallback, useState } from 'react';

function HorizontalRuleView({ editor, getPos, deleteNode }: NodeViewProps) {
  const [showActions, setShowActions] = useState(false);

  const handleDelete = useCallback(() => {
    deleteNode();
  }, [deleteNode]);

  const handleInsertBefore = useCallback(() => {
    const pos = getPos();
    if (pos !== undefined) {
      editor.chain()
        .focus()
        .insertContentAt(pos, { type: 'paragraph' })
        .run();
    }
  }, [editor, getPos]);

  const handleInsertAfter = useCallback(() => {
    const pos = getPos();
    if (pos !== undefined) {
      editor.chain()
        .focus()
        .insertContentAt(pos + 1, { type: 'paragraph' })
        .run();
    }
  }, [editor, getPos]);

  return (
    <NodeViewWrapper
      className="horizontal-rule-wrapper"
      onMouseEnter={() => setShowActions(true)}
      onMouseLeave={() => setShowActions(false)}
    >
      <div className="horizontal-rule-container">
        <div
          className="horizontal-rule-insert-zone horizontal-rule-insert-before"
          onClick={handleInsertBefore}
          title="Insert paragraph before"
        >
          <span className="horizontal-rule-insert-line" />
        </div>

        <hr className="horizontal-rule-line" />

        <div
          className="horizontal-rule-insert-zone horizontal-rule-insert-after"
          onClick={handleInsertAfter}
          title="Insert paragraph after"
        >
          <span className="horizontal-rule-insert-line" />
        </div>

        {showActions && (
          <div className="horizontal-rule-actions" contentEditable={false}>
            <button
              className="horizontal-rule-btn"
              onClick={handleDelete}
              title="Delete"
              type="button"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <line x1="6" y1="6" x2="18" y2="18"></line>
                <line x1="18" y1="6" x2="6" y2="18"></line>
              </svg>
            </button>
          </div>
        )}
      </div>
    </NodeViewWrapper>
  );
}

export default HorizontalRuleView;
