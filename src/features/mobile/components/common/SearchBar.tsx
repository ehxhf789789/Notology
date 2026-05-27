/**
 * SearchBar — Rounded search input with icon and clear button.
 */
import { useRef, useCallback } from 'react';
import { Search, X } from 'lucide-react';

interface Props {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
}

export function SearchBar({ value, onChange, placeholder = '검색...', autoFocus }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);

  const handleClear = useCallback(() => {
    onChange('');
    inputRef.current?.focus();
  }, [onChange]);

  return (
    <div className={`m-search-bar ${value ? 'm-search-bar--active' : ''}`}>
      <Search size={18} className="m-search-bar-icon" />
      <input
        ref={inputRef}
        className="m-search-bar-input"
        type="text"
        placeholder={placeholder}
        value={value}
        onChange={e => onChange(e.target.value)}
        autoFocus={autoFocus}
      />
      {value && (
        <button className="m-search-bar-clear" onClick={handleClear} aria-label="Clear">
          <X size={16} />
        </button>
      )}
    </div>
  );
}
