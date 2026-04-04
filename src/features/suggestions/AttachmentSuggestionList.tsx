import { forwardRef, useEffect, useImperativeHandle, useState } from 'react';
import type { AttachmentResult } from './attachmentSuggestion';
import { Paperclip, Image, FileText, File } from 'lucide-react';

interface AttachmentSuggestionListProps {
  items: AttachmentResult[];
  command: (props: any) => void;
}

export interface AttachmentSuggestionListRef {
  onKeyDown: (props: { event: KeyboardEvent }) => boolean;
}

// Get icon based on file extension
function getFileIcon(fileName: string) {
  const ext = fileName.split('.').pop()?.toLowerCase() || '';
  const imageExts = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'];
  const docExts = ['pdf', 'doc', 'docx', 'hwp', 'hwpx', 'txt', 'md'];

  if (imageExts.includes(ext)) return <Image size={14} />;
  if (docExts.includes(ext)) return <FileText size={14} />;
  return <File size={14} />;
}

export const AttachmentSuggestionList = forwardRef<
  AttachmentSuggestionListRef,
  AttachmentSuggestionListProps
>((props, ref) => {
  const [selectedIndex, setSelectedIndex] = useState(0);

  const selectItem = (index: number) => {
    const item = props.items[index];
    if (item) {
      props.command({ fileName: item.fileName, isImage: item.isImage });
    }
  };

  const upHandler = () => {
    if (props.items.length === 0) return;
    setSelectedIndex((selectedIndex + props.items.length - 1) % props.items.length);
  };

  const downHandler = () => {
    if (props.items.length === 0) return;
    setSelectedIndex((selectedIndex + 1) % props.items.length);
  };

  const enterHandler = () => {
    selectItem(selectedIndex);
  };

  useEffect(() => setSelectedIndex(0), [props.items]);

  useImperativeHandle(ref, () => ({
    onKeyDown: ({ event }) => {
      if (event.key === 'ArrowUp') {
        upHandler();
        return true;
      }

      if (event.key === 'ArrowDown') {
        downHandler();
        return true;
      }

      if (event.key === 'Enter' || event.key === 'Tab') {
        enterHandler();
        return true;
      }

      return false;
    },
  }));

  if (props.items.length === 0) {
    return (
      <div className="attachment-suggestion-list">
        <div className="attachment-suggestion-empty">
          첨부파일이 없습니다
        </div>
      </div>
    );
  }

  return (
    <div className="attachment-suggestion-list">
      <div className="attachment-suggestion-header">
        <Paperclip size={12} />
        <span>Attachments (att/)</span>
      </div>
      {props.items.map((item, index) => {
        const selected = index === selectedIndex;
        return (
          <button
            key={item.path}
            className={`attachment-suggestion-item${selected ? ' selected' : ''}`}
            onClick={() => selectItem(index)}
          >
            <div className="attachment-suggestion-item-icon">
              {getFileIcon(item.fileName)}
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
