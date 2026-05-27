/**
 * FAB — Floating Action Button with expandable menu.
 * Single tap: if items provided, expand menu; otherwise fire onPress.
 * Expanded: staggered options above + dim backdrop.
 */
import { useState, useCallback } from 'react';
import { Plus, X } from 'lucide-react';
import type { ReactNode } from 'react';

interface FABItem {
  icon: ReactNode;
  label: string;
  onPress: () => void;
}

interface Props {
  items?: FABItem[];
  onPress?: () => void;
}

export function FAB({ items, onPress }: Props) {
  const [open, setOpen] = useState(false);

  const handleClick = useCallback(() => {
    if (items && items.length > 0) {
      setOpen(o => !o);
    } else {
      onPress?.();
    }
  }, [items, onPress]);

  const handleItemClick = useCallback((item: FABItem) => {
    item.onPress();
    setOpen(false);
  }, []);

  return (
    <>
      {open && <div className="m-fab-backdrop" onClick={() => setOpen(false)} />}
      <div className="m-fab-container">
        {open && items && (
          <div className="m-fab-menu">
            {items.map((item, i) => (
              <button
                key={i}
                className="m-fab-menu-item"
                onClick={() => handleItemClick(item)}
                style={{ animationDelay: `${i * 60}ms` }}
              >
                <span className="m-fab-menu-icon">{item.icon}</span>
                <span className="m-fab-menu-label">{item.label}</span>
              </button>
            ))}
          </div>
        )}
        <button className="m-fab-btn" onClick={handleClick} aria-label="Action">
          {open ? <X size={24} /> : <Plus size={24} />}
        </button>
      </div>
    </>
  );
}
