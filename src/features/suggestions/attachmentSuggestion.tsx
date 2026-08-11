
import { useAttachmentStore } from '../attachments/stores/attachmentStore';
import { ReactRenderer } from '@tiptap/react';
import tippy from 'tippy.js';
import { AttachmentSuggestionPluginKey } from '../../core/editor/extensions/AttachmentSuggestion';
import AttachmentSuggestionList from './AttachmentSuggestionList';
import type { AttachmentSuggestionListRef } from './AttachmentSuggestionList';
import type { Editor, Range } from '@tiptap/core';
import type { EditorState } from '@tiptap/pm/state';
import { contentCacheActions } from '../content-cache/stores/contentCacheStore';

type TippyInstance = ReturnType<typeof tippy>;

/**
 * What kind of inline render the wikilink should produce when this entry is
 * picked. Image / video / audio all use `![[file]]` (renders as inline media
 * element via WikiLink's image-embed decoration). Anything else falls back to
 * a plain `[[file]]` chip.
 */
export type AttachmentEmbedKind = 'image' | 'video' | 'audio' | 'other';

export interface AttachmentResult {
  /** Original filename (the user-visible label). */
  fileName: string;
  /** AttachmentRef id (14-digit timestamp). Used as React key + dedup. */
  attachmentId: string;
  /** Drives embed-vs-chip choice and the picker icon. */
  kind: AttachmentEmbedKind;
}

/**
 * HanBin 2026-05-13: classifier for embed kind. Mirrors the WikiLink.ts
 * regexes that decide which inline element to render — keep these in sync.
 */
function kindFromName(fileName: string): AttachmentEmbedKind {
  if (/\.(png|jpg|jpeg|gif|webp|svg|bmp|ico)$/i.test(fileName)) return 'image';
  if (/\.(mp4|webm|mov|mkv|avi|m4v|ogv)$/i.test(fileName)) return 'video';
  if (/\.(m4a|mp3|wav|ogg|aac|flac|opus|wma)$/i.test(fileName)) return 'audio';
  return 'other';
}

/**
 * Resolve a note's id from its on-disk path via the content cache (frontmatter
 * `id:` field). Returns null when the note has no id yet (brand-new note that
 * has never been opened, or legacy pre-CAS notes without a frontmatter id).
 */
function getNoteIdFromPath(notePath: string): string | null {
  if (!notePath) return null;
  const fm = contentCacheActions.getFrontmatter(notePath);
  const id = (fm as Record<string, unknown> | null)?.id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

/**
 * Stage 5.0.4b-IA v2 (2026-05-15) — HanBin revised the IA direction:
 *   `//` shows ONLY the current note's attachments (the original behavior).
 *   `[[` stays vault-wide for note refs.
 * Rationale (HanBin): `//` is contextual ("attach to THIS note's content");
 * users browsing other notes' attachments is rare and confusing. Reverted
 * from the brief vault-wide experiment.
 */
function findAttachmentItems(notePath: string, query: string): AttachmentResult[] {
  const noteId = getNoteIdFromPath(notePath);
  if (!noteId) return [];
  const refs = useAttachmentStore.getState().listForNote(noteId);
  const q = query.trim().toLowerCase();
  const items: AttachmentResult[] = [];
  for (const ref of refs) {
    if (q && !ref.originalName.toLowerCase().includes(q)) continue;
    items.push({
      fileName: ref.originalName,
      attachmentId: ref.attachmentId,
      kind: kindFromName(ref.originalName),
    });
  }
  // Newest first — attachmentId is a sortable UTC timestamp.
  items.sort((a, b) => b.attachmentId.localeCompare(a.attachmentId));
  return items;
}

/**
 * v20.5 (2026-05-16, HanBin) — optional command override. The default
 * behavior inserts an inline wikilink into the editor, which is correct
 * for the main note editor but WRONG for sketch text nodes: in sketch,
 * attachments are first-class CANVAS NODES, not inline text references.
 * HanBin: "스케치 노트의 첨부파일 // 명령어 구조는 달라야 함... 노드로
 * 첨부파일이 추가됨. 노드 내 텍스트 영역에 링크로 추가 되지 않음."
 *
 * Callers that need different on-pick semantics pass `onPick`. The
 * override is responsible for BOTH removing the trigger text from the
 * editor (via `range`) AND applying its own action (e.g., adding a
 * sketch node). When `onPick` is omitted, the original wikilink-insert
 * behavior runs (current main editor behavior — unchanged).
 */
export interface AttachmentSuggestionConfig {
  getNotePath: () => string;
  onPick?: (args: { editor: Editor; range: Range; attachment: AttachmentResult }) => void;
}

/**
 * Create attachment suggestion configuration.
 * Accepts either the legacy `() => notePath` shorthand OR an options
 * object for the override callback variant.
 */
export function createAttachmentSuggestion(
  arg: (() => string) | AttachmentSuggestionConfig,
) {
  const config: AttachmentSuggestionConfig = typeof arg === 'function'
    ? { getNotePath: arg }
    : arg;
  const { getNotePath, onPick } = config;
  return {
    char: '//', // Trigger: double slash
    pluginKey: AttachmentSuggestionPluginKey,
    command: ({ editor, range, props }: { editor: Editor; range: Range; props: AttachmentResult }) => {
      // v20.5 — defer to caller override if present (sketch text editor).
      if (onPick) {
        onPick({ editor, range, attachment: props });
        return;
      }
      // image / video / audio → `![[file]]` embed (renders inline via
      // WikiLink's IMAGE_EMBED decoration); other → `[[file]]` chip.
      const isEmbed = props.kind !== 'other';
      const prefix = isEmbed ? '!' : '';

      // HanBin 2026-05-13: ensure the inserted wikilink can be parsed
      // round-trip. `]]` inside the filename would cause the lazy regex
      // `\[\[(.+?)\]\]` to stop early and capture only a prefix of the
      // name. Filenames *starting* with `[` are fine — the chip
      // converter's image-embed exclusion in WikiLink.ts handles those.
      // For the (rare) `]]` case, fall back to a plain wikilink chip so
      // the user sees something usable instead of mangled markup.
      const hasParseConflict = props.fileName.includes(']]');
      const wrapped = hasParseConflict
        ? `[[${props.fileName.replace(/\]\]/g, '] ]')}]]`
        : `${prefix}[[${props.fileName}]]`;

      editor
        .chain()
        .focus()
        .deleteRange(range)
        .insertContent(wrapped)
        .run();
    },
    allow: ({ editor, state }: { editor: Editor; state: EditorState }) => {
      if (!editor.isEditable) return false;

      const $from = state.selection.$from;
      const text = $from.parent.textContent;
      const posInParent = $from.parentOffset;
      const beforeCursor = text.substring(0, posInParent);

      // Don't trigger inside an unclosed wiki-link `[[ ... ]]`.
      const lastOpenBracket = beforeCursor.lastIndexOf('[[');
      const lastCloseBracket = beforeCursor.lastIndexOf(']]');
      if (lastOpenBracket > lastCloseBracket) return false;

      // Suggestions are tied to a saved note — nothing to recall otherwise.
      const notePath = getNotePath();
      if (!notePath) return false;

      return true;
    },
    items: ({ query }: { query: string }) => {
      const notePath = getNotePath();
      return findAttachmentItems(notePath, query);
    },

    render: () => {
      let component: ReactRenderer<AttachmentSuggestionListRef> | undefined;
      let popup: TippyInstance | undefined;
      let closeOnEvent: (() => void) | undefined;

      return {
        onStart: (props: any) => {
          component = new ReactRenderer(AttachmentSuggestionList, {
            props,
            editor: props.editor,
          });

          if (!props.clientRect) {
            return;
          }

          popup = tippy('body', {
            getReferenceClientRect: props.clientRect as () => DOMRect,
            appendTo: () => document.body,
            content: component.element,
            showOnCreate: true,
            interactive: true,
            trigger: 'manual',
            placement: 'bottom-start',
            maxWidth: '400px',
            theme: 'attachment-suggestion',
          });

          // v5.3 + v5.4 — auto-close on dragstart AND scroll.
          // v5.5.1 (2026-05-16, HanBin): popover 내부 스크롤은 무시.
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

          if (!props.clientRect) {
            return;
          }

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
