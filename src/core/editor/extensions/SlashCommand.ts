import { Extension, type Editor } from '@tiptap/core';
import Suggestion from '@tiptap/suggestion';
import { PluginKey, type EditorState } from '@tiptap/pm/state';
import type { Range } from '@tiptap/core';

/**
 * Slash command extension (Stage 5.0.4b-1).
 *
 * Adds a `/` trigger inside the editor that opens the slash palette
 * — single entry point for inserting structured content per
 * HanBin's 5.0.4-pre sign-off:
 *   - inline math, block math (was `$`, `$$` triggers — removed)
 *   - wiki link            (was `[[name]]` InputRule — removed)
 *   - attachment embed     (was `![[file]]` InputRule — removed)
 *   - headings, lists, quotes, dividers, code, callout
 *
 * Trigger condition: `/` typed at start-of-line or directly after
 * whitespace. Prevents accidental triggers on URLs (`https://`,
 * `path/to/file`, `1/2` etc.) per Q2 sign-off.
 */

export interface SlashCommandOptions {
  /** Suggestion config — bind via React renderer in the consumer file. */
  suggestion: Record<string, unknown>;
}

export const SlashCommandPluginKey = new PluginKey('slashCommand');

export interface SlashCommandItem {
  id: string;
  /** Localised label shown to the user. */
  label: string;
  /** One-line hint (optional). */
  description?: string;
  /** Lucide icon name (resolved at render time). */
  icon?: string;
  /** Filter keywords (Korean + English) for fuzzy matching. */
  keywords?: string;
  /** Visual shortcut hint to display on the row (no key handling). */
  shortcut?: string[];
  /** Run the command. The `range` covers the `/` + query text. */
  run: (editor: Editor, range: Range) => void;
}

export const SlashCommand = Extension.create<SlashCommandOptions>({
  name: 'slashCommand',

  // Stage 5.0.5a-γ5 v8 fix — same priority bump as WikiLinkSuggestion so
  // Tab/Enter/arrow shortcuts are intercepted by the / palette before the
  // editor's keymap. (Less critical for `/` because slash typically opens
  // outside a list, but consistent with sibling suggestions.)
  priority: 1000,

  addOptions() {
    return {
      suggestion: {
        char: '/',
        pluginKey: SlashCommandPluginKey,
        // Default command — replaced by consumer's React renderer.
        command: ({ editor, range, props }: {
          editor: Editor;
          range: Range;
          props: { item: SlashCommandItem };
        }) => {
          props.item.run(editor, range);
        },
        // Word-boundary gate. Reject `/` inside URL / path / fraction:
        //   "https://"  → reject
        //   "path/file" → reject
        //   "1/2"       → reject
        //   "/"         → accept (start of line)
        //   " /"        → accept (whitespace before)
        allow: ({ editor, state }: { editor: Editor; state: EditorState; range: Range }) => {
          if (!editor.isEditable) return false;

          const $from = state.selection.$from;
          const text = $from.parent.textContent;
          const posInParent = $from.parentOffset;
          const beforeCursor = text.substring(0, posInParent);

          // Find the last `/` in the prefix
          const lastSlash = beforeCursor.lastIndexOf('/');
          if (lastSlash < 0) return false;

          // Char before the `/` must be start-of-line or whitespace
          if (lastSlash === 0) return true;
          const prev = beforeCursor[lastSlash - 1];
          return /\s/.test(prev);
        },
      },
    };
  },

  addProseMirrorPlugins() {
    return [
      Suggestion({
        editor: this.editor,
        ...this.options.suggestion,
      }),
    ];
  },
});
