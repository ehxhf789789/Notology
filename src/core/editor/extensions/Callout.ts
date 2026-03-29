import { Node, mergeAttributes, wrappingInputRule } from '@tiptap/core';

export type CalloutType = 'info' | 'warning' | 'error' | 'success' | 'note' | 'tip';

export interface CalloutOptions {
  types: CalloutType[];
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    callout: {
      setCallout: (type: CalloutType) => ReturnType;
      toggleCallout: (type: CalloutType) => ReturnType;
      unsetCallout: () => ReturnType;
    };
  }
}

export const Callout = Node.create<CalloutOptions>({
  name: 'callout',
  group: 'block',
  content: 'block+',
  defining: true,

  addOptions() {
    return {
      types: ['info', 'warning', 'error', 'success', 'note', 'tip'],
    };
  },

  addAttributes() {
    return {
      type: {
        default: 'info',
        parseHTML: (element) => element.getAttribute('data-callout') || 'info',
        renderHTML: (attributes) => ({
          'data-callout': attributes.type,
        }),
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'div[data-callout]',
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes, {
        'data-callout': node.attrs.type,
        class: `callout callout-${node.attrs.type}`,
      }),
      0,
    ];
  },

  addCommands() {
    return {
      setCallout:
        (type: CalloutType) =>
        ({ commands }) => {
          return commands.wrapIn(this.name, { type });
        },
      toggleCallout:
        (type: CalloutType) =>
        ({ commands }) => {
          if (this.editor.isActive(this.name, { type })) {
            return commands.lift(this.name);
          }
          return commands.wrapIn(this.name, { type });
        },
      unsetCallout:
        () =>
        ({ commands }) => {
          return commands.lift(this.name);
        },
    };
  },

  addInputRules() {
    return [
      wrappingInputRule({
        find: /^>\s?\[!(info|warning|error|success|note|tip)\]\s$/,
        type: this.type,
        getAttributes: (match) => ({ type: match[1] }),
      }),
    ];
  },
});

export default Callout;
