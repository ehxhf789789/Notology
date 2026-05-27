import { ReactRenderer } from '@tiptap/react';
import tippy from 'tippy.js';
import type { Editor, Range } from '@tiptap/core';
import { SlashCommandPluginKey, type SlashCommandItem } from '../../core/editor/extensions/SlashCommand';
import { SlashCommandList, type SlashCommandListRef } from './SlashCommandList';
import { buildSlashCommands, filterCommands } from './commands';
import { useSettingsStore } from '../../core/stores/settingsStore';

type TippyInstance = ReturnType<typeof tippy>;

/** Create the slash-command suggestion config (Stage 5.0.4b-1). */
export function createSlashCommandSuggestion(opts: { excludeIds?: string[] } = {}) {
  // v20.21 (2026-05-17, HanBin) — `excludeIds` filters out specific
  // commands by id at build time. Used by sketch text-node editors to
  // remove `/위키 링크` and any other item that conflicts with sketch
  // UX (where wikilinks and attachments are spawned as canvas NODES,
  // not inline references). HanBin: "스케치에서 / 명령어에서 위키링크
  // 등 스케치에서 지원하지 않는 기능은 제거. 스케치 노트 한정."
  const excluded = new Set(opts.excludeIds ?? []);
  return {
    char: '/',
    pluginKey: SlashCommandPluginKey,

    items: ({ query }: { query: string }): SlashCommandItem[] => {
      const language = useSettingsStore.getState().language;
      const all = buildSlashCommands(language);
      const filtered = excluded.size > 0 ? all.filter(it => !excluded.has(it.id)) : all;
      return filterCommands(filtered, query);
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
      let closeOnEvent: (() => void) | undefined;

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
            // v5.4 — strip Tippy's default dark wrapper. HanBin: "검은색
            // 배경 테두리" was the `.tippy-box` default background showing
            // through behind our `.slash-palette` content.
            theme: 'slash-command',
          });

          // v5.3 + v5.4 (2026-05-15) — popover MUST close on:
          //   1. dragstart (HanBin v5.3) — don't linger over drag preview
          //   2. scroll (HanBin v5.4) — anchor goes stale otherwise
          // v5.5.1 (2026-05-16, HanBin): popover 내부 스크롤은 무시.
          // 팔레트 자체가 max-height 360px 으로 스크롤 가능하므로 항목 탐색
          // 시 닫히면 안 됨. 호버 본문 스크롤만 닫기.
          closeOnEvent = (e?: Event) => {
            if (e?.type === 'scroll') {
              const popperEl = popup?.[0]?.popper;
              const target = e.target as Node | null;
              if (popperEl && target && popperEl.contains(target)) return;
            }
            popup?.[0]?.hide();
          };
          document.addEventListener('dragstart', closeOnEvent, { capture: true });
          window.addEventListener('scroll', closeOnEvent, { capture: true });
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
          if (closeOnEvent) {
            document.removeEventListener('dragstart', closeOnEvent, { capture: true });
            window.removeEventListener('scroll', closeOnEvent, { capture: true });
            closeOnEvent = undefined;
          }
          popup?.[0]?.destroy();
          component?.destroy();
        },
      };
    },
  };
}
