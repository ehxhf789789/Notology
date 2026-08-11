

import { useAttachmentStore } from '../../../features/attachments/stores/attachmentStore';
import { requestAttachmentDelete } from '../../../features/attachments/attachmentDelete';
import { Node, mergeAttributes } from '@tiptap/core';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import { GapCursor } from '@tiptap/pm/gapcursor';
import { useFileTreeStore } from '../../stores/fileTreeStore';
import { contentCacheActions } from '../../../features/content-cache/stores/contentCacheStore';
import { modalActions } from '../../../features/modals/stores/modalStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { t } from '../../utils/i18n';

/**
 * HanBin 2026-05-14: inline media embed as a proper ProseMirror atom node.
 *
 * Previously `![[file]]` was kept as raw text + rendered via a widget
 * decoration with the text hidden by `display: none`. That broke cursor
 * navigation: the caret would silently traverse the invisible characters
 * and the user couldn't reliably click before/after the player to insert
 * text. As an atom node, the embed occupies exactly one position — Arrow
 * keys, click, Backspace, and Delete all behave the way users expect.
 *
 * Conversion `![[file]]` (raw text) ↔ atom is handled by the
 * appendTransaction plugin below. Markdown round-trips via the
 * `addStorage().markdown.serialize` writer.
 */

export type MediaEmbedKind = 'image' | 'video' | 'audio';

/**
 * Extension-based classifier. Mirrors `kindFromName` in
 * `attachmentSuggestion.tsx` and `classifyEmbedKind` in `WikiLink.ts` —
 * keep these three in sync. Returns `null` for unrecognized extensions so
 * `![[doc.pdf]]` style references stay as a wikiLink chip.
 */
export function classifyMediaKind(fileName: string): MediaEmbedKind | null {
  if (/\.(png|jpg|jpeg|gif|webp|svg|bmp|ico)$/i.test(fileName)) return 'image';
  if (/\.(mp4|webm|mov|mkv|avi|m4v|ogv)$/i.test(fileName)) return 'video';
  if (/\.(m4a|mp3|wav|ogg|aac|flac|opus|wma)$/i.test(fileName)) return 'audio';
  return null;
}

/** Resolve the user-visible filename to an absolute path via the
 *  AttachmentRef store (CAS layout) with a legacy `_att/` fallback for
 *  vaults migrated from older Notology versions. */
function resolveAbsolutePath(fileName: string, notePath: string): string | null {
  const vaultPath = useFileTreeStore.getState().vaultPath;
  const fm = notePath ? contentCacheActions.getFrontmatter(notePath) : null;
  const noteId = typeof (fm as Record<string, unknown> | null)?.id === 'string'
    ? (fm as Record<string, unknown>).id as string
    : undefined;
  const ref = useAttachmentStore.getState().resolveByName(fileName, noteId);
  if (ref && vaultPath) {
    return `${vaultPath.replace(/\\/g, '/')}/${ref.displayPath.replace(/\\/g, '/')}`;
  }
  if (notePath) {
    const noteDir = notePath.replace(/[^/\\]+$/, '').replace(/\\/g, '/');
    const noteStem = notePath.replace(/^.*[/\\]/, '').replace(/\.md$/, '');
    return `${noteDir}${noteStem}_att/${fileName}`;
  }
  return null;
}

function toAssetUrl(absolutePath: string): string {
  const win = window as unknown as { __TAURI__?: { core?: { convertFileSrc?: (path: string) => string } } };
  if (win.__TAURI__?.core?.convertFileSrc) {
    return win.__TAURI__.core.convertFileSrc(absolutePath);
  }
  return `asset://localhost/${absolutePath}`;
}

/**
 * HanBin 2026-05-14: inferring the MIME type from the file extension fixes
 * a class of bugs around the native `<video>` controls when the asset://
 * protocol doesn't set an authoritative Content-Type — without the hint
 * the browser sniffs from the byte stream, which works for playback but
 * leaves the seek cache confused (slider drag was scrubbing the time text
 * forward without the actual frame advancing, per HanBin's report).
 */
function inferMediaMime(fileName: string): string {
  const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
  switch (ext) {
    case 'mp4': case 'm4v': return 'video/mp4';
    case 'webm':            return 'video/webm';
    case 'mov':             return 'video/quicktime';
    case 'mkv':             return 'video/x-matroska';
    case 'avi':             return 'video/x-msvideo';
    case 'ogv':             return 'video/ogg';
    case 'mp3':             return 'audio/mpeg';
    case 'm4a':             return 'audio/mp4';
    case 'wav':             return 'audio/wav';
    case 'ogg': case 'opus': return 'audio/ogg';
    case 'aac':             return 'audio/aac';
    case 'flac':            return 'audio/flac';
    case 'wma':             return 'audio/x-ms-wma';
    default:                return '';
  }
}

export interface MediaEmbedOptions {
  getNotePath?: () => string;
  onClickLink?: (fileName: string) => void;
}

/**
 * Count all references (wikiLink chips + mediaEmbed atoms) to a filename in
 * the given doc. The × delete button uses this to decide whether to show the
 * unlink confirmation modal (only when this would be the last reference in
 * the note).
 */
function countRefs(doc: import('@tiptap/pm/model').Node, targetFileName: string): number {
  let count = 0;
  doc.descendants((node) => {
    if ((node.type.name === 'wikiLink' || node.type.name === 'mediaEmbed')
      && node.attrs.fileName === targetFileName) {
      count++;
      return false;
    }
  });
  return count;
}

// v4: regex moved inline into appendTransaction (matches whole-paragraph
// `![[file]]` patterns only — see plugin definition below).

/**
 * v5 (2026-05-15) — block-gap predicate. Returns true if `node` is a
 * block-level node that should participate in the gap UX (auto-fill empty
 * paragraph on click, safe Backspace/Delete that doesn't delete it,
 * cleanup of orphan empty paragraphs adjacent to it).
 *
 * Excludes plain paragraphs (they're already valid caret targets and
 * shouldn't trigger gap logic when they sit between other paragraphs).
 *
 * Includes: heading, codeBlock, blockquote, bulletList, orderedList,
 * taskList, callout, table, horizontalRule, mathBlock, mediaEmbed,
 * linkCard, and any future block-level node added to the schema.
 */
function isStandaloneBlock(node: import('@tiptap/pm/model').Node | null | undefined): boolean {
  if (!node) return false;
  if (!node.type.isBlock) return false;
  if (node.type.name === 'paragraph') return false;
  return true;
}

export const MediaEmbed = Node.create<MediaEmbedOptions>({
  name: 'mediaEmbed',
  // Stage 5.0.4b-2d v4 (2026-05-15) — schema-CSS reconciliation. Previously
  // the node was `inline + group:inline`, but CSS always rendered it as
  // `display:block`. That mismatch broke cursor placement: TextSelection
  // BETWEEN two stacked inline atoms is schema-valid, but the browser
  // can't render a visible caret there because there's no inline line
  // flow at the position (atoms are block-displayed).
  //
  // The fix: make it a block atom. Schema and CSS now agree. Two stacked
  // mediaEmbeds become adjacent BLOCK boundaries, and ProseMirror's
  // built-in Gapcursor extension (included in StarterKit) automatically
  // handles "click in the gap between blocks → gap cursor → type → new
  // paragraph with text appears between them" — exactly the UX HanBin
  // asked for, with NO custom click/mousedown handlers needed.
  group: 'block',
  atom: true,
  draggable: true,
  // selectable:false stops PM from creating NodeSelection on click, so a
  // click on the card's whitespace edges falls through to Gapcursor /
  // natural caret placement instead of selecting the whole atom.
  selectable: false,

  addOptions() {
    return { getNotePath: undefined, onClickLink: undefined, countRefs: undefined };
  },

  addAttributes() {
    return {
      fileName: { default: null },
      kind: {
        default: 'image' as MediaEmbedKind,
        parseHTML: (el: HTMLElement) => (el.getAttribute('data-media-kind') as MediaEmbedKind) || 'image',
        renderHTML: (attrs: { kind?: MediaEmbedKind }) => ({ 'data-media-kind': attrs.kind ?? 'image' }),
      },
    };
  },

  parseHTML() {
    // v4: accept both `div` (new block) and `span` (legacy inline) parse
    // tags so existing rendered HTML from older notes still loads.
    return [
      {
        tag: 'div[data-media-embed]',
        getAttrs: (el: HTMLElement) => ({
          fileName: el.getAttribute('data-media-embed'),
          kind: (el.getAttribute('data-media-kind') as MediaEmbedKind) || classifyMediaKind(el.getAttribute('data-media-embed') ?? '') || 'image',
        }),
      },
      {
        tag: 'span[data-media-embed]',
        getAttrs: (el: HTMLElement) => ({
          fileName: el.getAttribute('data-media-embed'),
          kind: (el.getAttribute('data-media-kind') as MediaEmbedKind) || classifyMediaKind(el.getAttribute('data-media-embed') ?? '') || 'image',
        }),
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    const fileName = node.attrs.fileName ?? '';
    const kind: MediaEmbedKind = node.attrs.kind ?? classifyMediaKind(fileName) ?? 'image';
    return ['div', mergeAttributes(HTMLAttributes, {
      'data-media-embed': fileName,
      'data-media-kind': kind,
      class: `wiki-image-embed-wrapper wiki-embed-${kind}`,
    })];
  },

  addStorage() {
    return {
      markdown: {
        serialize(state: any, node: any) {
          // v4 CRITICAL FIX (2026-05-15): block atom MUST call closeBlock(node)
          // after write. Without it, consecutive block content (e.g., the
          // `# 첨부파일` heading right after a mediaEmbed) gets concatenated
          // onto the same markdown line — `![[file]]# 첨부파일` — and on
          // reload the `#` is no longer at line start, so the markdown parser
          // doesn't recognize the heading. This is what corrupted HanBin's
          // notes when v4 first shipped (header recognition failed).
          state.write(`![[${node.attrs.fileName || ''}]]`);
          state.closeBlock(node);
        },
        parse: {
          // Conversion of raw `![[…]]` text → atom is handled by the
          // appendTransaction plugin below; no special parser needed.
        },
      },
    };
  },

  // v4 (2026-05-15): `addInputRules` removed (was also planned for
  // 5.0.4b-1.5). The input rule fired when the user typed `![[file]]` at
  // an inline position — now that mediaEmbed is a block atom, replacing
  // inline text with block content would throw a schema error. Conversion
  // happens via the appendTransaction plugin below, which only matches
  // `![[file]]` when it's the sole content of a paragraph (on its own line).

  // v5 (2026-05-15) — gap logic now applies to ALL block-level "standalone"
  // siblings (per HanBin: "표, 팁, 헤더, 구분선도 모두 간격로직이 서로간에
  // 구현되어야 함"). Previously v4.4 restricted to block ATOMS only — but
  // gaps between e.g. a callout and a heading, or a code block and a table,
  // need the same UX:
  //   • Click in gap → auto-fill inserts empty paragraph + caret inside
  //   • Backspace in that empty paragraph → only the paragraph deleted,
  //     never the adjacent block
  //   • Cursor leaves empty paragraph without typing → cleanup removes it
  //
  // "Standalone block" = any block-level node that's NOT a regular paragraph.
  // Includes: heading, codeBlock, blockquote, bulletList/orderedList/taskList,
  // callout, table, horizontalRule, mathBlock, mediaEmbed, linkCard.
  addKeyboardShortcuts() {
    return {
      Backspace: ({ editor }) => {
        const { selection, doc } = editor.state;
        if (!selection.empty) return false;
        const $pos = (selection as TextSelection).$from;
        if (!$pos) return false;
        // Cursor must be at start of an empty textblock.
        if ($pos.parentOffset !== 0) return false;
        const parent = $pos.parent;
        if (!parent.isTextblock) return false;
        if (parent.content.size !== 0) return false;
        // Previous sibling must be a standalone block (not a paragraph).
        const posBeforeParagraph = $pos.before();
        if (posBeforeParagraph < 0) return false;
        const $beforePos = doc.resolve(posBeforeParagraph);
        const prevSibling = $beforePos.nodeBefore;
        if (!isStandaloneBlock(prevSibling)) return false;
        // Delete the empty paragraph; don't touch the standalone block.
        const tr = editor.state.tr;
        tr.delete(posBeforeParagraph, posBeforeParagraph + parent.nodeSize);
        tr.setMeta('blockGapSafeEdit', true);
        editor.view.dispatch(tr);
        return true;
      },
      Delete: ({ editor }) => {
        const { selection, doc } = editor.state;
        if (!selection.empty) return false;
        const $pos = (selection as TextSelection).$from;
        if (!$pos) return false;
        const parent = $pos.parent;
        if (!parent.isTextblock) return false;
        if ($pos.parentOffset !== parent.content.size) return false; // not at end
        if (parent.content.size !== 0) return false; // not empty
        const posAfterParagraph = $pos.after();
        const $afterPos = doc.resolve(posAfterParagraph);
        const nextSibling = $afterPos.nodeAfter;
        if (!isStandaloneBlock(nextSibling)) return false;
        const tr = editor.state.tr;
        const paraStart = $pos.before();
        tr.delete(paraStart, paraStart + parent.nodeSize);
        tr.setMeta('blockGapSafeEdit', true);
        editor.view.dispatch(tr);
        return true;
      },
    };
  },

  addNodeView() {
    return ({ node, getPos, editor }) => {
      const fileName: string = node.attrs.fileName || '';
      const kind: MediaEmbedKind = node.attrs.kind ?? classifyMediaKind(fileName) ?? 'image';
      const notePath = this.options.getNotePath?.() || '';
      const onClickLink = this.options.onClickLink;

      // v4: block atom → `<div>` wrapper matches the block schema.
      const wrapper = document.createElement('div');
      wrapper.className = `wiki-image-embed-wrapper wiki-embed-${kind}`;
      wrapper.setAttribute('data-media-embed', fileName);
      wrapper.setAttribute('data-media-kind', kind);
      // Stop the contentEditable from receiving the events the media element
      // owns (play / scrub / volume) so the user can actually use the controls.
      wrapper.setAttribute('contenteditable', 'false');

      // HanBin 2026-05-14: unified filename label for *all* embed kinds
      // (image / video / audio). Lives OUTSIDE the inner container — for
      // video the container is a black `overflow: hidden` frame so a
      // label inside it would be clipped; this lifts the label to the
      // wrapper-level so it always renders above the media.
      const label = document.createElement('span');
      label.className = `wiki-embed-label wiki-embed-label-${kind}`;
      label.textContent = fileName;
      wrapper.appendChild(label);

      const container = document.createElement('span');
      container.className = 'wiki-image-embed-container';

      const absolutePath = resolveAbsolutePath(fileName, notePath);
      const src = absolutePath ? toAssetUrl(absolutePath) : '';

      let media: HTMLElement;
      if (kind === 'image') {
        const img = document.createElement('img');
        img.src = src;
        img.className = 'wiki-image-embed';
        img.alt = fileName;
        img.ondblclick = () => onClickLink?.(fileName);
        media = img;
      } else if (kind === 'video') {
        const video = document.createElement('video');
        video.controls = true;
        video.preload = 'metadata';
        // `playsInline` is the iOS contract but doesn't hurt anywhere — it
        // also disables WebView2's autoplay-into-fullscreen quirk on some
        // window sizes.
        video.playsInline = true;
        video.className = 'wiki-video-embed';
        video.ondblclick = () => onClickLink?.(fileName);
        const source = document.createElement('source');
        source.src = src;
        const mime = inferMediaMime(fileName);
        if (mime) source.type = mime;
        video.appendChild(source);
        media = video;
      } else {
        const audio = document.createElement('audio');
        audio.controls = true;
        audio.preload = 'metadata';
        audio.className = 'wiki-audio-embed';
        const source = document.createElement('source');
        source.src = src;
        const mime = inferMediaMime(fileName);
        if (mime) source.type = mime;
        audio.appendChild(source);
        // The wiki-embed-label (added at wrapper level above) covers the
        // filename display for all kinds — no per-audio label needed here.
        media = audio;
      }

      // v4: no custom click handler — block atom + Gapcursor (from
      // StarterKit) handles "click between two stacked embeds → gap
      // cursor → type → new paragraph" natively. Right-click → context
      // menu (delete) is still wired via the view-level plugin below.
      container.appendChild(media);
      wrapper.appendChild(container);

      return {
        dom: wrapper,
        update(updatedNode) {
          if (updatedNode.type.name !== 'mediaEmbed') return false;
          return updatedNode.attrs.fileName === fileName && updatedNode.attrs.kind === kind;
        },
        // Native media controls handle their own DOM mutations.
        ignoreMutation: () => true,
        // Stage 5.0.4b-2 part C (2026-05-15) — HanBin: clicking around the
        // audio/video embed couldn't focus text adjacent to it. Root cause:
        // `stopEvent: () => true` swallowed *every* event, so ProseMirror
        // never saw the clicks it needs to position the caret, create a
        // NodeSelection, or start a drag.
        //
        // The original concern (native media controls owning their events)
        // is satisfied by the browser dispatching those events to the
        // <audio>/<video> shadow DOM regardless of what we return here —
        // returning `true` only matters as a hint to ProseMirror. So we
        // narrow to: stop events that target the media element itself or
        // the delete button (so PM doesn't also NodeSelect when the user
        // is clicking play / scrub / ×). For wrapper / label / container-
        // padding clicks, let ProseMirror handle: single-click → atom
        // NodeSelection (with `draggable: true` this also kicks off drag-
        // reorder); arrow keys then place the caret in the adjacent
        // paragraph so the user can type text right next to the embed.
        stopEvent: (event: Event) => {
          const target = event.target as HTMLElement | null;
          if (!target) return false;
          // 5.0.4b-2d removed the `.wiki-image-embed-delete` button; selector
          // kept here in case other-track WT changes still render one. Safe
          // no-op if the element is absent.
          return !!target.closest('audio, video, .wiki-image-embed-delete');
        },
      };
    };
  },

  /**
   * Convert raw `![[file]]` text → atom nodes after every doc change. This
   * mirrors WikiLink's `[[file]]` → chip conversion. Without this, a note
   * loaded fresh from markdown would show literal `![[file]]` text until
   * the user typed something.
   */
  addProseMirrorPlugins() {
    const nodeType = this.type;
    const options = this.options;
    return [
      // v4.3 (2026-05-15) — Obsidian-style cursor placement between block
      // atoms. HanBin: "임베딩 영역을 자유롭게 컨트롤이 안되잖아" — the
      // GapCursor's horizontal-bar visual was unfamiliar and users didn't
      // realize typing would auto-create a paragraph. Fix: whenever PM
      // would place a GapCursor (click in a gap between two block atoms,
      // or click at doc start/end where no textblock exists), we instead
      // INSERT an empty paragraph at that position and set a TextSelection
      // inside it. The user sees a normal I-beam in a real paragraph and
      // can type naturally — matching the Obsidian-style fluid UX.
      //
      // Stable: after conversion the selection is TextSelection, not
      // GapCursor, so the plugin no-ops on subsequent transactions.
      // Keyboard navigation rarely creates GapCursors between mediaEmbed
      // blocks (selectable:false makes arrows skip through atoms), so the
      // false-positive risk of "phantom empty paragraph on arrow key" is
      // minimal.
      new Plugin({
        key: new PluginKey('blockGapAutoFill'),
        appendTransaction: (transactions, _oldState, newState) => {
          // If the user just did a safe Backspace/Delete that removed an
          // empty paragraph, DON'T auto-insert another one — that would
          // negate the deletion. The GapCursor stays visible (styled via
          // .ProseMirror-gapcursor CSS); clicking again re-spawns a paragraph.
          if (transactions.some((tr) => tr.getMeta('blockGapSafeEdit'))) {
            return null;
          }

          const sel = newState.selection;
          if (!(sel instanceof GapCursor)) return null;

          const pos = sel.from;
          const paragraph = newState.schema.nodes.paragraph?.create();
          if (!paragraph) return null;

          const tr = newState.tr.insert(pos, paragraph);
          try {
            // pos + 1 = inside the open-paragraph token, where the caret
            // belongs as a TextSelection.
            tr.setSelection(TextSelection.create(tr.doc, Math.min(pos + 1, tr.doc.content.size)));
          } catch {
            return null;
          }
          return tr.scrollIntoView();
        },
      }),

      // v5.1 (2026-05-15) — HanBin: gap auto-fill DIDN'T work between two
      // textblocks (heading↔codeBlock, callout↔heading, etc.) because PM's
      // GapCursor only activates when at least one side is a non-textblock
      // (atom) — between two textblocks the cursor naturally jumps INTO
      // one of them and no gap state exists.
      //
      // Fix: explicit mousedown handler that detects clicks at the visual
      // boundary between two standalone blocks (regardless of textblock vs
      // atom). When detected: insert an empty paragraph at the boundary +
      // place caret inside. This makes the gap UX consistent across ALL
      // block types per HanBin's request.
      //
      // Detection: posAtCoords returns the resolved doc position; we check
      // whether the click Y lies OUTSIDE the resolved block's DOM bounding
      // box (above → "above this block", below → "below this block"). If
      // both the adjacent block and the current block are standalone, the
      // user clicked in the visual gap between them.
      new Plugin({
        key: new PluginKey('blockGapClickAutoFill'),
        props: {
          handleDOMEvents: {
            mousedown(view, event) {
              if (event.button !== 0) return false;
              const target = event.target as HTMLElement | null;
              if (target?.closest('audio, video, button, a, input, textarea')) return false;
              // If click lands inside a wikilink chip / math node / linkcard
              // / mediaEmbed wrapper, let those handlers run.
              if (target?.closest(
                '[data-wiki-link], .math-node, .link-card, .wiki-image-embed-wrapper',
              )) return false;

              const coords = { left: event.clientX, top: event.clientY };
              const posInfo = view.posAtCoords(coords);
              if (!posInfo) return false;

              const { doc } = view.state;
              const $pos = doc.resolve(posInfo.pos);

              // Try to find which top-level block the click is closest to,
              // then determine if click Y is above/below that block.
              let gapPos: number | null = null;

              if ($pos.depth === 0) {
                // Position is naturally between top-level blocks.
                gapPos = posInfo.pos;
              } else {
                // Walk to depth 1 (a top-level block in the doc).
                const blockPos = $pos.before(1);
                const blockNode = doc.nodeAt(blockPos);
                if (!blockNode) return false;
                const blockDom = view.nodeDOM(blockPos);
                if (!(blockDom instanceof Element)) return false;
                const rect = blockDom.getBoundingClientRect();
                const ABOVE_THRESHOLD = 6; // px slack — clicks just inside the edge still count
                if (event.clientY < rect.top + ABOVE_THRESHOLD) {
                  gapPos = blockPos; // before this block
                } else if (event.clientY > rect.bottom - ABOVE_THRESHOLD) {
                  gapPos = blockPos + blockNode.nodeSize; // after this block
                }
              }
              if (gapPos === null) return false;

              // Check that at least one adjacent sibling at the gap is a
              // standalone block; if BOTH sides are regular paragraphs (or
              // doc edges), don't intervene — PM's normal behavior covers it.
              const $gap = doc.resolve(gapPos);
              if ($gap.depth !== 0) return false;
              const parent = $gap.parent;
              const idx = $gap.index();
              const prev = idx > 0 ? parent.maybeChild(idx - 1) : null;
              const next = idx < parent.childCount ? parent.maybeChild(idx) : null;
              if (!isStandaloneBlock(prev) && !isStandaloneBlock(next)) return false;

              // If there's already an empty paragraph at this position
              // (e.g., from a previous click that the cleanup hasn't fired
              // on yet), don't insert another — just place the caret inside.
              if (next && next.type.name === 'paragraph' && next.content.size === 0) {
                event.preventDefault();
                const tr = view.state.tr.setSelection(
                  TextSelection.create(view.state.doc, gapPos + 1),
                );
                view.dispatch(tr.scrollIntoView());
                view.focus();
                return true;
              }
              if (prev && prev.type.name === 'paragraph' && prev.content.size === 0) {
                event.preventDefault();
                const prevStart = gapPos - prev.nodeSize;
                const tr = view.state.tr.setSelection(
                  TextSelection.create(view.state.doc, prevStart + 1),
                );
                view.dispatch(tr.scrollIntoView());
                view.focus();
                return true;
              }

              const paragraph = view.state.schema.nodes.paragraph?.create();
              if (!paragraph) return false;

              event.preventDefault();
              const tr = view.state.tr.insert(gapPos, paragraph);
              try {
                tr.setSelection(TextSelection.create(tr.doc, gapPos + 1));
              } catch {
                return false;
              }
              view.dispatch(tr.scrollIntoView());
              view.focus();
              return true;
            },
          },
        },
      }),

      // v5 (2026-05-15) — empty-paragraph cleanup between ANY two standalone
      // blocks (per HanBin: "표, 팁, 헤더, 구분선도 모두 간격로직이
      // 서로간에 구현되어야 함"). Was previously limited to block atoms only.
      // When the user clicks between two standalone blocks (heading/callout/
      // table/code/embed/etc.) an empty paragraph is auto-filled; if they
      // leave it without typing, this plugin removes it on next transaction.
      new Plugin({
        key: new PluginKey('blockGapEmptyParaCleanup'),
        appendTransaction: (transactions, _oldState, newState) => {
          // Guard against re-firing on our own cleanup tx.
          if (transactions.some((tr) => tr.getMeta('blockGapEmptyParaCleanup'))) {
            return null;
          }
          const { doc, selection } = newState;
          const removals: Array<{ from: number; to: number }> = [];

          doc.descendants((node, pos, parent, index) => {
            if (parent !== doc) return false; // top-level only
            if (node.type.name !== 'paragraph') return false;
            if (node.content.size !== 0) return false; // not empty

            const prev = index !== null && index !== undefined && index > 0
              ? parent.maybeChild(index - 1) : null;
            const next = index !== null && index !== undefined && index < parent.childCount - 1
              ? parent.maybeChild(index + 1) : null;
            if (!isStandaloneBlock(prev)) return false;
            if (!isStandaloneBlock(next)) return false;

            // Don't cleanup if the cursor is INSIDE this paragraph — the
            // user may still be about to type. Only clean once cursor has
            // moved out (click or arrow-key navigation).
            const from = pos;
            const to = pos + node.nodeSize;
            if (selection.from >= from && selection.from <= to) return false;

            removals.push({ from, to });
            return false;
          });

          if (removals.length === 0) return null;
          const tr = newState.tr;
          for (let i = removals.length - 1; i >= 0; i--) {
            tr.delete(removals[i].from, removals[i].to);
          }
          tr.setMeta('blockGapEmptyParaCleanup', true);
          return tr;
        },
      }),

      // v3 (HanBin reframe 2026-05-15): only right-click intercept needed.
      // mousedown (edge-zone cursor placement) was eliminated because with
      // selectable: false the browser places the caret naturally adjacent
      // to the contenteditable=false wrapper. WikiLink's contextmenu
      // handler was modified to early-skip `.wiki-image-embed-wrapper`
      // targets so this plugin gets to handle them.
      new Plugin({
        key: new PluginKey('mediaEmbedContextMenu'),
        props: {
          handleDOMEvents: {
            contextmenu(view, event) {
              const target = event.target as HTMLElement | null;
              const wrapper = target?.closest('.wiki-image-embed-wrapper') as HTMLElement | null;
              if (!wrapper) return false;
              event.preventDefault();
              event.stopPropagation();

              const fileName = wrapper.getAttribute('data-media-embed') || '';
              const pos = view.posAtDOM(wrapper, 0);
              if (typeof pos !== 'number' || pos < 0) return false;

              const node = view.state.doc.nodeAt(pos);
              if (!node || node.type.name !== 'mediaEmbed') return false;

              const triggerDelete = () => {
                const dispatchDelete = () => {
                  const tr = view.state.tr.delete(pos, pos + node.nodeSize);
                  tr.setMeta('wikiLink/skipDeleteGuard', true);
                  view.dispatch(tr);
                };

                const totalRefs = countRefs(view.state.doc, fileName);
                if (totalRefs > 1) {
                  dispatchDelete();
                  return;
                }

                void (async () => {
                  const notePathNow = options.getNotePath?.() || '';
                  const noteId = notePathNow.replace(/\\/g, '/').split('/').pop()?.replace(/\.md$/i, '') ?? '';
                  const ref = useAttachmentStore.getState().resolveByName(fileName, noteId);
                  if (!ref) {
                    dispatchDelete();
                    return;
                  }
                  const result = await requestAttachmentDelete({
                    attachmentId: ref.attachmentId,
                    originalName: ref.originalName,
                    noteId,
                  });
                  if (!result.confirmed) return;
                  // Re-resolve position in case doc shifted while modal was open.
                  let pos2 = -1;
                  view.state.doc.descendants((n, p) => {
                    if (pos2 >= 0) return false;
                    if (n.type.name === 'mediaEmbed' && n.attrs.fileName === fileName) {
                      pos2 = p;
                      return false;
                    }
                  });
                  if (pos2 < 0) return;
                  const tr2 = view.state.tr.delete(pos2, pos2 + node.nodeSize);
                  tr2.setMeta('wikiLink/skipDeleteGuard', true);
                  view.dispatch(tr2);
                })();
              };

              // v4: with block atom + Gapcursor, the user can natively place
              // the caret between/around embeds without needing the "insert
              // line above/below" UX fallback. Right-click menu simplified
              // back to just "삭제".
              const lang = useSettingsStore.getState().language;
              modalActions.showAtomContextMenu(
                { x: event.clientX, y: event.clientY },
                [{ label: t('deleteEmbed', lang), onClick: triggerDelete, danger: true }],
              );
              return true;
            },

          },
        },
      }),
      new Plugin({
        key: new PluginKey('mediaEmbedTransform'),
        // v4 (2026-05-15) — block-atom paragraph normalization.
        //
        // Three cases handled:
        //   1. Paragraph is exactly `![[file]]` (trimmed): replace the
        //      whole paragraph with a mediaEmbed block.
        //   2. Paragraph contains MULTIPLE `![[file]]` patterns with no
        //      other text (concatenation bug from missing closeBlock in
        //      older saves): split into N mediaEmbed blocks. This recovers
        //      already-corrupted notes.
        //   3. Paragraph has `![[file]]` mixed with other text: leave as
        //      text (conservative — user should put on own line).
        appendTransaction: (transactions, _oldState, newState) => {
          if (!transactions.some((tr) => tr.docChanged)) return null;

          const { tr, doc } = newState;
          let modified = false;

          interface Pending {
            paraPos: number;
            paraSize: number;
            fileNames: Array<{ fileName: string; kind: MediaEmbedKind }>;
          }
          const toReplace: Pending[] = [];

          doc.descendants((node, pos) => {
            if (node.type.name !== 'paragraph') return;
            const text = node.textContent.trim();
            if (!text) return;

            // Case 1 & 2: paragraph is made up entirely of `![[file]]`
            // patterns (separated only by whitespace).
            // /^(\s*!\[\[(.+?)\]\]\s*)+$/ — but we also need each match's
            // fileName, so use repeated match against /![[file]]/.
            const allPatternRegex = /^(\s*!\[\[(.+?)\]\]\s*)+$/;
            if (!allPatternRegex.test(text)) return;

            const matches: Array<{ fileName: string; kind: MediaEmbedKind }> = [];
            const itemRegex = /!\[\[(.+?)\]\]/gu;
            let m: RegExpExecArray | null;
            let allKindsKnown = true;
            while ((m = itemRegex.exec(text)) !== null) {
              const fileName = m[1];
              const kind = classifyMediaKind(fileName);
              if (!kind) { allKindsKnown = false; break; }
              matches.push({ fileName, kind });
            }
            if (!allKindsKnown || matches.length === 0) return;

            toReplace.push({ paraPos: pos, paraSize: node.nodeSize, fileNames: matches });
            return false; // don't descend
          });

          // Replace from the end so earlier positions stay valid.
          for (let i = toReplace.length - 1; i >= 0; i--) {
            const { paraPos, paraSize, fileNames } = toReplace[i];
            const nodes = fileNames.map(({ fileName, kind }) =>
              nodeType.create({ fileName, kind }),
            );
            tr.replaceWith(paraPos, paraPos + paraSize, nodes);
            modified = true;
          }

          return modified ? tr : null;
        },
      }),
    ];
  },
});

export default MediaEmbed;
