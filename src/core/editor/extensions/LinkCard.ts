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

export default Node.create<LinkCardOptions>({
  name: 'linkCard',

  group: 'block',

  atom: true,

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
    return [
      {
        tag: 'div[data-link-card]',
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, { 'data-link-card': '' })];
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
