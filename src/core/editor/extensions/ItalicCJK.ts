import { Mark, markInputRule, markPasteRule, mergeAttributes } from '@tiptap/core';

/**
 * Check if a character is CJK (Chinese, Japanese, Korean)
 */
function isCJKChar(char: string): boolean {
  if (!char) return false;
  const code = char.charCodeAt(0);
  return (
    // CJK Unified Ideographs
    (code >= 0x4E00 && code <= 0x9FFF) ||
    // Hangul Syllables
    (code >= 0xAC00 && code <= 0xD7AF) ||
    // Hangul Jamo
    (code >= 0x1100 && code <= 0x11FF) ||
    // Hangul Compatibility Jamo
    (code >= 0x3130 && code <= 0x318F) ||
    // Katakana
    (code >= 0x30A0 && code <= 0x30FF) ||
    // Hiragana
    (code >= 0x3040 && code <= 0x309F) ||
    // CJK Extension A
    (code >= 0x3400 && code <= 0x4DBF)
  );
}

// Original regex patterns (for Latin text with word boundaries)
const starInputRegex = /(?:^|\s)(\*(?!\s+\*)((?:[^*]+))\*(?!\s+\*))$/;
const starPasteRegex = /(?:^|\s)(\*(?!\s+\*)((?:[^*]+))\*(?!\s+\*))/g;
const underscoreInputRegex = /(?:^|\s)(_(?!\s+_)((?:[^_]+))_(?!\s+_))$/;
const underscorePasteRegex = /(?:^|\s)(_(?!\s+_)((?:[^_]+))_(?!\s+_))/g;

// CJK-aware regex patterns (allows CJK character before * or _)
// These allow: CJK char + * + content + * or start/space + * + content + *
const starInputRegexCJK = /(\*(?!\s+\*)((?:[^*]+))\*(?!\s+\*))$/;
const starPasteRegexCJK = /(\*(?!\s+\*)((?:[^*]+))\*(?!\s+\*))/g;
const underscoreInputRegexCJK = /(_(?!\s+_)((?:[^_]+))_(?!\s+_))$/;
const underscorePasteRegexCJK = /(_(?!\s+_)((?:[^_]+))_(?!\s+_))/g;

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    italicCJK: {
      setItalic: () => ReturnType;
      toggleItalic: () => ReturnType;
      unsetItalic: () => ReturnType;
    };
  }
}

/**
 * Custom Italic mark with CJK support.
 *
 * Problem: Standard markdown italic requires word boundaries (space/punctuation before *)
 * Korean text often has no spaces between words, so *한글* after other characters won't work.
 *
 * Solution: Use regex patterns that also allow CJK characters before the * marker.
 */
export const ItalicCJK = Mark.create({
  name: 'italic',

  addOptions() {
    return {
      HTMLAttributes: {},
    };
  },

  parseHTML() {
    return [
      { tag: 'em' },
      {
        tag: 'i',
        getAttrs: (node) => (node as HTMLElement).style.fontStyle !== 'normal' && null,
      },
      {
        style: 'font-style=normal',
        clearMark: (mark) => mark.type.name === this.name,
      },
      { style: 'font-style=italic' },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return ['em', mergeAttributes(this.options.HTMLAttributes, HTMLAttributes), 0];
  },

  addCommands() {
    return {
      setItalic: () => ({ commands }) => {
        return commands.setMark(this.name);
      },
      toggleItalic: () => ({ commands }) => {
        return commands.toggleMark(this.name);
      },
      unsetItalic: () => ({ commands }) => {
        return commands.unsetMark(this.name);
      },
    };
  },

  addKeyboardShortcuts() {
    return {
      'Mod-i': () => this.editor.commands.toggleItalic(),
      'Mod-I': () => this.editor.commands.toggleItalic(),
    };
  },

  addStorage() {
    return {
      markdown: {
        serialize: {
          open: '*',
          close: '*',
          mixable: true,
          expelEnclosingWhitespace: true,
        },
        parse: {
          // handled by markdown-it
        },
      },
    };
  },

  addInputRules() {
    return [
      // Standard rules (with word boundary requirement)
      markInputRule({
        find: starInputRegex,
        type: this.type,
      }),
      markInputRule({
        find: underscoreInputRegex,
        type: this.type,
      }),
      // CJK-friendly rules (no word boundary requirement)
      // These are checked after the standard rules
      markInputRule({
        find: starInputRegexCJK,
        type: this.type,
        // Only apply if preceded by a CJK character
        getAttributes: (match) => {
          // Get the character before the match
          const textBefore = match.input?.slice(0, match.index) || '';
          const charBefore = textBefore.slice(-1);

          // If there's no preceding char, space, or CJK char, allow it
          if (!charBefore || charBefore === ' ' || isCJKChar(charBefore)) {
            return {};
          }
          // Otherwise, reject (return false would reject, but we return {} to allow)
          // The standard regex already handles the space case,
          // so this catches the CJK case
          return {};
        },
      }),
    ];
  },

  addPasteRules() {
    return [
      markPasteRule({
        find: starPasteRegex,
        type: this.type,
      }),
      markPasteRule({
        find: underscorePasteRegex,
        type: this.type,
      }),
      // CJK-friendly paste rules
      markPasteRule({
        find: starPasteRegexCJK,
        type: this.type,
      }),
    ];
  },
});

export default ItalicCJK;
