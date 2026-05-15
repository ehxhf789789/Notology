import { t, type LanguageSetting } from './i18n';

export interface ShortcutBinding {
  id: string;
  labelKey: string;
  category: 'text' | 'heading' | 'list' | 'block' | 'system' | 'navigation';
  defaultKeys: string;
  customKeys?: string;
}

export const DEFAULT_SHORTCUTS: ShortcutBinding[] = [
  // Text
  { id: 'bold', labelKey: 'scBold', category: 'text', defaultKeys: 'Ctrl+B' },
  { id: 'italic', labelKey: 'scItalic', category: 'text', defaultKeys: 'Ctrl+I' },
  { id: 'underline', labelKey: 'scUnderline', category: 'text', defaultKeys: 'Ctrl+U' },
  { id: 'strikethrough', labelKey: 'scStrikethrough', category: 'text', defaultKeys: 'Ctrl+Shift+X' },
  { id: 'code', labelKey: 'scCode', category: 'text', defaultKeys: 'Ctrl+E' },
  { id: 'highlight', labelKey: 'scHighlight', category: 'text', defaultKeys: 'Ctrl+Shift+H' },

  // Heading
  { id: 'heading1', labelKey: 'scHeading1', category: 'heading', defaultKeys: 'Ctrl+1' },
  { id: 'heading2', labelKey: 'scHeading2', category: 'heading', defaultKeys: 'Ctrl+2' },
  { id: 'heading3', labelKey: 'scHeading3', category: 'heading', defaultKeys: 'Ctrl+3' },
  { id: 'heading4', labelKey: 'scHeading4', category: 'heading', defaultKeys: 'Ctrl+4' },
  { id: 'heading5', labelKey: 'scHeading5', category: 'heading', defaultKeys: 'Ctrl+5' },
  { id: 'heading6', labelKey: 'scHeading6', category: 'heading', defaultKeys: 'Ctrl+6' },

  // List
  { id: 'bulletList', labelKey: 'scBulletList', category: 'list', defaultKeys: 'Ctrl+Shift+8' },
  { id: 'orderedList', labelKey: 'scOrderedList', category: 'list', defaultKeys: 'Ctrl+Shift+7' },
  { id: 'taskList', labelKey: 'scTaskList', category: 'list', defaultKeys: 'Ctrl+Shift+9' },
  { id: 'indent', labelKey: 'scIndent', category: 'list', defaultKeys: 'Tab' },
  { id: 'outdent', labelKey: 'scOutdent', category: 'list', defaultKeys: 'Shift+Tab' },

  // Block
  { id: 'blockquote', labelKey: 'scBlockquote', category: 'block', defaultKeys: 'Ctrl+Shift+B' },
  { id: 'codeBlock', labelKey: 'scCodeBlock', category: 'block', defaultKeys: 'Ctrl+Shift+E' },
  { id: 'horizontalRule', labelKey: 'scHorizontalRule', category: 'block', defaultKeys: 'Ctrl+Shift+-' },

  // System (Stage 5.0.4a — dead bindings removed: save / toggleMemo / toggleMetadata)
  { id: 'undo', labelKey: 'scUndo', category: 'system', defaultKeys: 'Ctrl+Z' },
  { id: 'redo', labelKey: 'scRedo', category: 'system', defaultKeys: 'Ctrl+Shift+Z' },
  { id: 'deleteNote', labelKey: 'scDeleteNote', category: 'system', defaultKeys: 'Ctrl+Shift+Delete' },

  // Navigation (Stage 5.0.4a — Ctrl+K = command palette, Ctrl+Shift+C calendar removed)
  { id: 'newNote', labelKey: 'scNewNote', category: 'navigation', defaultKeys: 'Ctrl+N' },
  { id: 'newFolder', labelKey: 'scNewFolder', category: 'navigation', defaultKeys: 'Ctrl+Shift+N' },
  { id: 'commandPalette', labelKey: 'scCommandPalette', category: 'navigation', defaultKeys: 'Ctrl+K' },
  { id: 'search', labelKey: 'scSearch', category: 'navigation', defaultKeys: 'Ctrl+Shift+F' },
  { id: 'settings', labelKey: 'scSettings', category: 'navigation', defaultKeys: 'Ctrl+,' },
  { id: 'toggleSidebar', labelKey: 'scToggleSidebar', category: 'navigation', defaultKeys: 'Ctrl+ArrowLeft' },
  { id: 'toggleRightPanel', labelKey: 'scToggleRightPanel', category: 'navigation', defaultKeys: 'Ctrl+ArrowRight' },
];

export function getActiveKeys(binding: ShortcutBinding): string {
  return binding.customKeys || binding.defaultKeys;
}

export function parseShortcut(keys: string): { ctrl: boolean; shift: boolean; alt: boolean; key: string } {
  const parts = keys.split('+');
  const result = { ctrl: false, shift: false, alt: false, key: '' };
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (lower === 'ctrl' || lower === 'mod') result.ctrl = true;
    else if (lower === 'shift') result.shift = true;
    else if (lower === 'alt') result.alt = true;
    else result.key = part;
  }
  return result;
}

const CATEGORY_KEYS: Record<string, string> = {
  text: 'scCatText',
  heading: 'scCatHeading',
  list: 'scCatList',
  block: 'scCatBlock',
  system: 'scCatSystem',
  navigation: 'scCatNavigation',
};

export function getCategoryLabel(category: string, lang: LanguageSetting): string {
  const key = CATEGORY_KEYS[category];
  return key ? t(key, lang) : category;
}

export function getShortcutLabel(binding: ShortcutBinding, lang: LanguageSetting): string {
  return t(binding.labelKey, lang);
}

// QWERTY keyboard layout
export const KEYBOARD_ROWS = [
  ['`', '1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '-', '='],
  ['Q', 'W', 'E', 'R', 'T', 'Y', 'U', 'I', 'O', 'P', '[', ']', '\\'],
  ['A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L', ';', "'"],
  ['Z', 'X', 'C', 'V', 'B', 'N', 'M', ',', '.', '/'],
];

export function getKeyBindings(shortcuts: ShortcutBinding[]): Map<string, ShortcutBinding[]> {
  const map = new Map<string, ShortcutBinding[]>();
  for (const binding of shortcuts) {
    const keys = getActiveKeys(binding);
    const parsed = parseShortcut(keys);
    const keyUpper = parsed.key.toUpperCase();
    if (!map.has(keyUpper)) {
      map.set(keyUpper, []);
    }
    map.get(keyUpper)!.push(binding);
  }
  return map;
}
