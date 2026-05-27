/**
 * Dropdown — Trigger + option list with check mark.
 */
import { useState, useRef, useEffect, useCallback } from 'react';
import { ChevronDown, Check } from 'lucide-react';

interface Option<T extends string> {
  id: T;
  label: string;
}

interface Props<T extends string> {
  options: Option<T>[];
  value: T;
  onChange: (value: T) => void;
  placeholder?: string;
}

export function Dropdown<T extends string>({ options, value, onChange, placeholder }: Props<T>) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const selectedLabel = options.find(o => o.id === value)?.label ?? placeholder ?? '';

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const handleSelect = useCallback((id: T) => {
    onChange(id);
    setOpen(false);
  }, [onChange]);

  return (
    <div className="m-dropdown" ref={ref}>
      <button className="m-dropdown-trigger" onClick={() => setOpen(o => !o)}>
        <span className="m-dropdown-label">{selectedLabel}</span>
        <ChevronDown size={16} className={`m-dropdown-chevron ${open ? 'open' : ''}`} />
      </button>
      {open && (
        <div className="m-dropdown-menu">
          {options.map(o => (
            <button
              key={o.id}
              className={`m-dropdown-option ${o.id === value ? 'active' : ''}`}
              onClick={() => handleSelect(o.id)}
            >
              <span>{o.label}</span>
              {o.id === value && <Check size={16} className="m-dropdown-check" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
