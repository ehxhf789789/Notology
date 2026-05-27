import { forwardRef, useImperativeHandle } from 'react';
import type { AttachmentResult } from './attachmentSuggestion';
import { Paperclip, Image as ImageIcon, FileText, File as FileIcon, Film, Music, Search } from 'lucide-react';
import { useSuggestionList } from '../../core/hooks/useSuggestionList';
import { useSettingsStore } from '../../core/stores/settingsStore';
import { t } from '../../core/utils/i18n';

interface AttachmentSuggestionListProps {
  items: AttachmentResult[];
  command: (props: AttachmentResult) => void;
  /** Current query the user is typing after `//`. TipTap suggestion passes this in. */
  query?: string;
}

export interface AttachmentSuggestionListRef {
  onKeyDown: (props: { event: KeyboardEvent }) => boolean;
}

// Per-kind icon. Mirrors the WikiLink embed renderer's branching so the icon
// the user sees in the picker matches the inline element they get on commit.
function getKindIcon(kind: AttachmentResult['kind'], fileName: string) {
  if (kind === 'image') return <ImageIcon size={14} />;
  if (kind === 'video') return <Film size={14} />;
  if (kind === 'audio') return <Music size={14} />;
  if (/\.(pdf|docx?|hwpx?|pptx?|xlsx?|txt|md)$/i.test(fileName)) return <FileText size={14} />;
  return <FileIcon size={14} />;
}

export const AttachmentSuggestionList = forwardRef<
  AttachmentSuggestionListRef,
  AttachmentSuggestionListProps
>((props, ref) => {
  const language = useSettingsStore((s) => s.language);
  // v5.5 (2026-05-16) — keyboard nav via useSuggestionList. Tab+Enter accept
  // to match the WikiLink picker (both popovers used to share this behavior).
  // v18 fix (2026-05-16) — added autoScroll + listRef so keyboard ↑↓ scrolls
  // the active row into view (was inconsistent with `/` slash palette which
  // already had this).
  const { activeIndex, setActiveIndex, onKeyDown, listRef } = useSuggestionList(
    props.items,
    (item) => props.command(item),
    { acceptKeys: ['Enter', 'Tab'], autoScroll: true },
  );

  useImperativeHandle(ref, () => ({
    onKeyDown: ({ event }) => onKeyDown(event),
  }));

  const query = props.query ?? '';
  // v9 i18n cleanup — single-language placeholder via i18n.
  const searchNode = (
    <div className="suggestion-search">
      <Search size={14} className="suggestion-search__icon" />
      <span className={`suggestion-search__query${query ? '' : ' suggestion-search__query--empty'}`}>
        {query || t('suggestionSearchAttachments', language)}
      </span>
    </div>
  );

  if (props.items.length === 0) {
    return (
      <div className="attachment-suggestion-list">
        {searchNode}
        <div className="attachment-suggestion-empty">
          첨부파일이 없습니다
        </div>
      </div>
    );
  }

  return (
    <div ref={listRef} className="attachment-suggestion-list">
      {searchNode}
      <div className="attachment-suggestion-header">
        <Paperclip size={12} />
        <span>Attachments</span>
      </div>
      {props.items.map((item, index) => {
        const selected = index === activeIndex;
        return (
          <button
            key={item.attachmentId}
            data-suggestion-index={index}
            className={`attachment-suggestion-item${selected ? ' selected' : ''}`}
            onMouseEnter={() => setActiveIndex(index)}
            onClick={() => props.command(item)}
          >
            <div className="attachment-suggestion-item-icon">
              {getKindIcon(item.kind, item.fileName)}
            </div>
            <div className="attachment-suggestion-item-name">
              {item.fileName}
            </div>
          </button>
        );
      })}
    </div>
  );
});

AttachmentSuggestionList.displayName = 'AttachmentSuggestionList';

export default AttachmentSuggestionList;
