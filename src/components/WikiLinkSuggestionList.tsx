import { forwardRef, useEffect, useImperativeHandle, useState } from 'react';

interface WikiLinkSuggestionListProps {
  items: Array<{ fileName: string; path: string }>;
  command: (props: any) => void;
}

export interface WikiLinkSuggestionListRef {
  onKeyDown: (props: { event: KeyboardEvent }) => boolean;
}

export const WikiLinkSuggestionList = forwardRef<
  WikiLinkSuggestionListRef,
  WikiLinkSuggestionListProps
>((props, ref) => {
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

  if (props.items.length === 0) {
    return (
      <div className="wiki-link-suggestion-list">
        <div className="wiki-link-suggestion-empty">No notes found</div>
      </div>
    );
  }

  return (
    <div className="wiki-link-suggestion-list">
      {props.items.map((item, index) => (
        <button
          key={item.path}
          className={`wiki-link-suggestion-item${index === selectedIndex ? ' selected' : ''}`}
          onClick={() => selectItem(index)}
        >
          <div className="wiki-link-suggestion-item-name">{item.fileName.replace(/_/g, ' ')}</div>
          <div className="wiki-link-suggestion-item-path">{item.path}</div>
        </button>
      ))}
    </div>
  );
});

WikiLinkSuggestionList.displayName = 'WikiLinkSuggestionList';

export default WikiLinkSuggestionList;
