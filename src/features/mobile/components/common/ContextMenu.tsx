/**
 * ContextMenu — Long-press popup menu for notes/folders.
 */
import type { ReactNode } from 'react';

interface ContextMenuItem {
  icon?: ReactNode;
  label: string;
  destructive?: boolean;
  onPress: () => void;
}

interface Props {
  items: ContextMenuItem[];
  position: { x: number; y: number };
  onClose: () => void;
}

export function ContextMenu({ items, position, onClose }: Props) {
  return (
    <>
      <div className="m-ctx-backdrop" onClick={onClose} />
      <div
        className="m-ctx-menu"
        style={{
          left: position.x,
          top: position.y,
          transformOrigin: `${position.x < window.innerWidth / 2 ? 'left' : 'right'} top`,
        }}
      >
        {items.map((item, i) => (
          <button
            key={i}
            className={`m-ctx-item ${item.destructive ? 'm-ctx-item--destructive' : ''}`}
            onClick={() => { item.onPress(); onClose(); }}
          >
            {item.icon && <span className="m-ctx-item-icon">{item.icon}</span>}
            <span>{item.label}</span>
          </button>
        ))}
      </div>
    </>
  );
}
