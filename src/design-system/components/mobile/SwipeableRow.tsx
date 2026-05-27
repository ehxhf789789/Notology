/**
 * SwipeableRow — Wraps a list item with swipe-to-reveal-delete gesture.
 * Left-swipe reveals red delete button behind the content.
 */
import { type ReactNode, useCallback } from 'react';
import { Trash2 } from 'lucide-react';
import { useSwipeAction } from '../../../hooks/useSwipeAction';

interface Props {
  children: ReactNode;
  onDelete: () => void;
  disabled?: boolean;
}

export function SwipeableRow({ children, onDelete, disabled = false }: Props) {
  const handleAction = useCallback(() => {
    onDelete();
  }, [onDelete]);

  const { handlers, style, state, close } = useSwipeAction({
    onAction: handleAction,
    disabled,
  });

  return (
    <div className="m-swipeable-row" onClick={state.revealed ? close : undefined}>
      {/* Delete action background */}
      <div
        className={`m-swipeable-row-action ${state.revealed ? 'visible' : ''}`}
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
          close();
        }}
      >
        <Trash2 size={20} />
      </div>
      {/* Foreground content */}
      <div
        className="m-swipeable-row-content"
        style={style}
        {...handlers}
      >
        {children}
      </div>
    </div>
  );
}
