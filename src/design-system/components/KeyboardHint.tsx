import type { HTMLAttributes } from 'react';

export type KeyboardHintSize = 'sm' | 'md';

export interface KeyboardHintProps extends HTMLAttributes<HTMLSpanElement> {
  /** Sequence of keys to render, e.g. ['Ctrl', 'K']. */
  keys: string[];
  size?: KeyboardHintSize;
  /** Glyph rendered between keys. Defaults to "+" (Win/Linux) or none (macOS). */
  separator?: string;
  /** Force a platform display style. Defaults to OS auto-detect. */
  platform?: 'mac' | 'win';
}

/** Detect macOS at module load. SSR / test fallback is non-mac. */
function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  // navigator.userAgentData is more reliable when available; fall back to platform.
  const ua = navigator.userAgent ?? '';
  const platform = (navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform
    ?? navigator.platform
    ?? '';
  return /Mac|iPhone|iPad|iPod/.test(platform) || /Macintosh/.test(ua);
}
const DEFAULT_IS_MAC = isMacPlatform();

/** Friendly key-name display. Mac and Win/Linux differ for modifiers. */
const COMMON: Record<string, string> = {
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Enter: '⏎',
  Escape: 'Esc',
  Backspace: '⌫',
  Delete: 'Del',
  Tab: 'Tab',
  Space: 'Space',
};
const MAC_DISPLAY: Record<string, string> = {
  ...COMMON,
  Ctrl: '⌃',
  Cmd: '⌘',
  Meta: '⌘',
  Mod: '⌘',     // Mod = Ctrl-on-PC, Cmd-on-Mac (TipTap convention)
  Alt: '⌥',
  Option: '⌥',
  Shift: '⇧',
};
const WIN_DISPLAY: Record<string, string> = {
  ...COMMON,
  Ctrl: 'Ctrl',
  Cmd: 'Win',
  Meta: 'Win',
  Mod: 'Ctrl',
  Alt: 'Alt',
  Option: 'Alt',
  Shift: 'Shift',
};

export function KeyboardHint({
  keys,
  size = 'md',
  separator,
  platform,
  className,
  ...rest
}: KeyboardHintProps) {
  const isMac = platform ? platform === 'mac' : DEFAULT_IS_MAC;
  const display = isMac ? MAC_DISPLAY : WIN_DISPLAY;
  // macOS convention prints modifiers as glyphs without a separator
  // (e.g. ⌘⇧K). Win/Linux keeps the "+" separator (Ctrl+Shift+K).
  const sep = separator ?? (isMac ? '' : '+');

  const cls = [
    'ds-kbd',
    `ds-kbd--${size}`,
    isMac ? 'ds-kbd--mac' : 'ds-kbd--win',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <span className={cls} {...rest}>
      {keys.map((k, i) => (
        <span key={`${k}-${i}`} className="ds-kbd-group">
          {i > 0 && sep && <span className="ds-kbd__plus" aria-hidden="true">{sep}</span>}
          <kbd className="ds-kbd__key">{display[k] ?? k}</kbd>
        </span>
      ))}
    </span>
  );
}
