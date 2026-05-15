import { ReactRenderer } from '@tiptap/react';
import tippy from 'tippy.js';
import type { Editor, Range } from '@tiptap/core';
import { SlashCommandPluginKey, type SlashCommandItem } from '../../core/editor/extensions/SlashCommand';
import { SlashCommandList, type SlashCommandListRef } from './SlashCommandList';
import { buildSlashCommands, filterCommands } from './commands';
import { useSettingsStore } from '../../core/stores/settingsStore';

type TippyInstance = ReturnType<typeof tippy>;

/** Create the slash-command suggestion config (Stage 5.0.4b-1). */
export function createSlashCommandSuggestion() {
  return {
    char: '/',
    pluginKey: SlashCommandPluginKey,

    items: ({ query }: { query: string }): SlashCommandItem[] => {
      const language = useSettingsStore.getState().language;
      const all = buildSlashCommands(language);
      return filterCommands(all, query);
    },

    command: ({ editor, range, props }: {
      editor: Editor;
      range: Range;
      props: { item: SlashCommandItem };
    }) => {
      props.item.run(editor, range);
    },

    render: () => {
      let component: ReactRenderer<SlashCommandListRef> | undefined;
      let popup: TippyInstance | undefined;

      return {
        onStart: (props: any) => {
          component = new ReactRenderer(SlashCommandList, {
            props,
            editor: props.editor,
          });

          if (!props.clientRect) return;

          popup = tippy('body', {
            getReferenceClientRect: props.clientRect as () => DOMRect,
            appendTo: () => document.body,
            content: component.element,
            showOnCreate: true,
            interactive: true,
            trigger: 'manual',
            placement: 'bottom-start',
            maxWidth: '420px',
          });
        },

        onUpdate(props: any) {
          component?.updateProps(props);
          if (!props.clientRect) return;
          popup?.[0]?.setProps({
            getReferenceClientRect: props.clientRect as () => DOMRect,
          });
        },

        onKeyDown(props: any) {
          if (props.event.key === 'Escape') {
            popup?.[0]?.hide();
            return true;
          }
          return component?.ref?.onKeyDown(props) || false;
        },

        onExit() {
          popup?.[0]?.destroy();
          component?.destroy();
        },
      };
    },
  };
}
