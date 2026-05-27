import { Node, mergeAttributes } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import LinkCardView from '../../../features/note-editor/LinkCardView';

export interface LinkCardOptions {
  HTMLAttributes: Record<string, any>;
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    linkCard: {
      setLinkCard: (options: { url: string; title?: string; description?: string; image?: string; favicon?: string }) => ReturnType;
    };
  }
}

/**
 * HTML-attribute-safe escape for serialize output. Without this, a URL
 * containing `"` or `&` (rare but possible) would produce broken HTML
 * that parseHTML can't recover from.
 */
function escapeHtmlAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export default Node.create<LinkCardOptions>({
  name: 'linkCard',

  group: 'block',

  atom: true,

  // v3 (HanBin 2026-05-15): treat as text-like atom (selectable: false).
  // Click on card → opens URL (handled by React onClick in LinkCardView);
  // click adjacent → caret lands there; Backspace deletes the card.
  selectable: false,

  addAttributes() {
    return {
      url: {
        default: '',
      },
      title: {
        default: '',
      },
      description: {
        default: '',
      },
      image: {
        default: '',
      },
      favicon: {
        default: '',
      },
    };
  },

  parseHTML() {
    // Stage 5.0.4b-2e (2026-05-15) — extract ALL attrs from data-*. Without
    // these getAttrs, reload from saved markdown produces a linkCard node
    // with empty attrs (the previous bug — title/description/image/favicon
    // were lost on every save/reload cycle, leaving only the URL behind).
    return [
      {
        tag: 'div[data-link-card]',
        getAttrs: (el: HTMLElement) => ({
          url: el.getAttribute('data-url') || '',
          title: el.getAttribute('data-title') || '',
          description: el.getAttribute('data-description') || '',
          image: el.getAttribute('data-image') || '',
          favicon: el.getAttribute('data-favicon') || '',
        }),
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    const attrs = node.attrs as {
      url: string; title: string; description: string; image: string; favicon: string;
    };
    return ['div', mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
      'data-link-card': '',
      'data-url': attrs.url || '',
      'data-title': attrs.title || '',
      'data-description': attrs.description || '',
      'data-image': attrs.image || '',
      'data-favicon': attrs.favicon || '',
    })];
  },

  addStorage() {
    // Stage 5.0.4b-2e (2026-05-15) — HTML-fallback markdown serialize.
    // LinkCard has no first-class markdown syntax (unlike `![[file]]` or
    // `$math$`), so we serialize as a self-contained HTML `<div>` block
    // with all card metadata in data-* attributes. On reload the same
    // div is parsed back via parseHTML above.
    //
    // Critical: `state.closeBlock(node)` separates the div from the next
    // block element with a blank line — without it, a following heading
    // gets concatenated (same root cause that broke header recognition
    // for MediaEmbed in v4.1).
    return {
      markdown: {
        serialize(state: any, node: any) {
          const a = node.attrs as {
            url: string; title: string; description: string; image: string; favicon: string;
          };
          const tag = '<div data-link-card="" '
            + `data-url="${escapeHtmlAttr(a.url || '')}" `
            + `data-title="${escapeHtmlAttr(a.title || '')}" `
            + `data-description="${escapeHtmlAttr(a.description || '')}" `
            + `data-image="${escapeHtmlAttr(a.image || '')}" `
            + `data-favicon="${escapeHtmlAttr(a.favicon || '')}"></div>`;
          state.write(tag);
          state.closeBlock(node);
        },
        parse: {
          // Parsing of `<div data-link-card>` happens via parseHTML above.
        },
      },
    };
  },

  addNodeView() {
    return ReactNodeViewRenderer(LinkCardView);
  },

  addCommands() {
    return {
      setLinkCard:
        (options) =>
        ({ commands }) => {
          return commands.insertContent({
            type: this.name,
            attrs: options,
          });
        },
    };
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('linkCardPaste'),
        props: {
          handlePaste: (view, event) => {
            // Get clipboard data
            const text = event.clipboardData?.getData('text/plain');
            if (!text) return false;

            // Check if entire pasted content is a URL
            const trimmed = text.trim();
            const urlRegex = /^https?:\/\/[^\s]+$/;

            if (!urlRegex.test(trimmed)) {
              return false;
            }

            // Even if HTML is present, if plain text is a URL, create link card
            // Prevent default paste
            event.preventDefault();

            // Insert link card node
            const { state } = view;
            const node = this.type.create({ url: trimmed });
            const transaction = state.tr.replaceSelectionWith(node);
            view.dispatch(transaction);

            return true;
          },
        },
      }),
    ];
  },
});
