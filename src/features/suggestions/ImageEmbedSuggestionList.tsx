import { forwardRef, useEffect, useImperativeHandle, useState } from 'react';
import { convertFileSrc } from '../../web/core';
import type { ImageAttachment } from './imageEmbedSuggestion';
import { useSettingsStore } from '../../core/stores/settingsStore';
import { t } from '../../core/utils/i18n';

interface ImageEmbedSuggestionListProps {
  items: ImageAttachment[];
  command: (props: { fileName: string }) => void;
}

export interface ImageEmbedSuggestionListRef {
  onKeyDown: (props: { event: KeyboardEvent }) => boolean;
}

export const ImageEmbedSuggestionList = forwardRef<
  ImageEmbedSuggestionListRef,
  ImageEmbedSuggestionListProps
>((props, ref) => {
  const language = useSettingsStore(s => s.language);
  const [selectedIndex, setSelectedIndex] = useState(0);

  const selectItem = (index: number) => {
    const item = props.items[index];
    if (item) {
      props.command({ fileName: item.fileName });
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
      <div className="image-embed-suggestion-list" style={listStyle}>
        <div className="image-embed-suggestion-empty" style={{ color: isLightMode ? '#666' : '#888' }}>
          {t('noImageAttachments', language)}
        </div>
      </div>
    );
  }

  return (
    <div className="image-embed-suggestion-list" style={listStyle}>
      <div className="image-embed-suggestion-header" style={headerStyle}>{t('insertImage', language)}</div>
      {props.items.map((item, index) => {
        const selected = index === selectedIndex;
        return (
          <button
            key={item.fileName}
            className={`image-embed-suggestion-item${selected ? ' selected' : ''}`}
            style={itemStyle(selected)}
            onClick={() => selectItem(index)}
          >
            <div className="image-embed-suggestion-item-thumbnail">
              {item.filePath ? (
                <img
                  src={convertFileSrc(item.filePath)}
                  alt={item.displayName}
                  onError={(e) => {
                    // Fallback to emoji if image fails to load
                    (e.target as HTMLImageElement).style.display = 'none';
                    (e.target as HTMLImageElement).nextElementSibling?.classList.remove('hidden');
                  }}
                />
              ) : null}
              <span className={item.filePath ? 'hidden' : ''}>🖼</span>
            </div>
            <div className="image-embed-suggestion-item-info">
              <div className="image-embed-suggestion-item-name" style={nameStyle(selected)}>
                {item.displayName}
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
});

ImageEmbedSuggestionList.displayName = 'ImageEmbedSuggestionList';

export default ImageEmbedSuggestionList;
