import { NodeViewWrapper } from '@tiptap/react';
import type { NodeViewProps } from '@tiptap/react';
import { useCallback } from 'react';
import { modalActions } from '../modals/stores/modalStore';
import { useSettingsStore } from '../../core/stores/settingsStore';
import { t } from '../../core/utils/i18n';

/**
 * Stage 5.0.4b v5.2 (2026-05-15) — HanBin:
 *   "구분선에 공백을 만드는 기능 제거. 이미 간격을 생성하는 로직이 들어갔기에.
 *    그리고 구분선을 삭제하는 삭제버튼도 제거."
 *
 * Two HorizontalRule-specific affordances removed:
 *
 * 1. **Insert-paragraph zones above/below the line** — these added ~16-24px
 *    of clickable vertical padding around the rule. With v5.1's
 *    `blockGapClickAutoFill` plugin, clicking in the gap BETWEEN any two
 *    standalone blocks (including horizontal rule) already inserts a
 *    paragraph + caret. The dedicated zones are redundant.
 *
 * 2. **Hover × delete button** — replaced with right-click → "구분선 삭제"
 *    menu (mirrors MediaEmbed / LinkCard / Math atom UX pattern from
 *    5.0.4b-2d v3). Keyboard Backspace at adjacent empty paragraph also
 *    safely removes only the paragraph (v5.0 safe-backspace); explicit
 *    NodeSelection + Backspace deletes the rule itself.
 *
 * Result: the NodeView renders just the `<hr>` line, no extra chrome.
 * Vertical spacing comes from CSS margin on `.horizontal-rule-wrapper`
 * and the surrounding paragraph margins.
 */
function HorizontalRuleView({ deleteNode, selected }: NodeViewProps) {
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const lang = useSettingsStore.getState().language;
    modalActions.showAtomContextMenu(
      { x: e.clientX, y: e.clientY },
      [{ label: t('deleteHorizontalRule', lang), onClick: () => deleteNode(), danger: true }],
    );
  }, [deleteNode]);

  return (
    <NodeViewWrapper
      className={`horizontal-rule-wrapper${selected ? ' ProseMirror-selectednode' : ''}`}
      onContextMenu={handleContextMenu}
    >
      <hr className="horizontal-rule-line" />
    </NodeViewWrapper>
  );
}

export default HorizontalRuleView;
