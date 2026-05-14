import type { HTMLAttributes } from 'react';

export type KeyboardHintSize = 'sm' | 'md';

export interface KeyboardHintProps extends HTMLAttributes<HTMLSpanElement> {
  /** Sequence of keys to render, e.g. ['Ctrl', 'K']. */
  keys: string[];
  size?: KeyboardHintSize;
  /** Glyph rendered between keys. Defaults to "+". */
  separator?: string;
}

// Friendly display for common key names (kept simple — full mapping happens in 5.0.4 audit).
const DISPLAY: Record<string, string> = {
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Enter: '⏎',
  Escape: 'Esc',
  Backspace: '⌫',
  Tab: 'Tab',
  Space: 'Space',
  Meta: '⌘',
};

export function KeyboardHint({
  keys,
  size = 'md',
  separator = '+',
  className,
  ...rest
}: KeyboardHintProps) {
  const cls = ['ds-kbd', `ds-kbd--${size}`, className ?? ''].filter(Boolean).join(' ');
  return (
    <span className={cls} {...rest}>
      {keys.map((k, i) => (
        <span key={`${k}-${i}`} className="ds-kbd-group">
          {i > 0 && <span className="ds-kbd__plus" aria-hidden="true">{separator}</span>}
          <kbd className="ds-kbd__key">{DISPLAY[k] ?? k}</kbd>
        </span>
      ))}
    </span>
  );
}
