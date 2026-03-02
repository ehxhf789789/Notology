import { forwardRef, useEffect, useImperativeHandle, useState } from 'react';
import type { AttachmentResult } from '../../../utils/attachmentSuggestion';
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

  // Detect theme from document
  const isLightMode = typeof document !== 'undefined' &&
    document.documentElement.getAttribute('data-theme') === 'light';

  const listStyle = {
    backgroundColor: isLightMode ? '#ffffff' : '#1e1e2e',
    border: isLightMode ? '1px solid #ddd' : '1px solid #3a3a4a',
    color: isLightMode ? '#1a1a1a' : '#e0e0e0',
  };

  const headerStyle = {
    color: isLightMode ? '#555' : '#888',
    borderBottomColor: isLightMode ? '#ddd' : '#3a3a4a',
  };

  const itemStyle = (selected: boolean) => ({
    color: selected ? '#fff' : (isLightMode ? '#1a1a1a' : '#e0e0e0'),
    backgroundColor: selected ? '#7aa2f7' : 'transparent',
  });

  const nameStyle = (selected: boolean) => ({
    color: selected ? '#fff' : (isLightMode ? '#1a1a1a' : '#e0e0e0'),
  });

  if (props.items.length === 0) {
    return (
      <div className="attachment-suggestion-list" style={listStyle}>
        <div className="attachment-suggestion-empty" style={{ color: isLightMode ? '#666' : '#888' }}>
          No attachments found in att/ folder
        </div>
      </div>
    );
  }

  return (
    <div className="attachment-suggestion-list" style={listStyle}>
      <div className="attachment-suggestion-header" style={headerStyle}>
        <Paperclip size={12} style={{ marginRight: 6 }} />
        Attachments (att/)
      </div>
      {props.items.map((item, index) => {
        const selected = index === selectedIndex;
        return (
          <button
            key={item.path}
            className={`attachment-suggestion-item${selected ? ' selected' : ''}`}
            style={itemStyle(selected)}
            onClick={() => selectItem(index)}
          >
            <div className="attachment-suggestion-item-icon">
              {getFileIcon(item.fileName)}
            </div>
            <div className="attachment-suggestion-item-info">
              <div className="attachment-suggestion-item-name" style={nameStyle(selected)}>
                {item.fileName}
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
});

AttachmentSuggestionList.displayName = 'AttachmentSuggestionList';

export default AttachmentSuggestionList;
