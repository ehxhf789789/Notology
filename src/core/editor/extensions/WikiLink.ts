


import { useAttachmentStore } from '../../../features/attachments/stores/attachmentStore';
import { requestAttachmentDelete, requestBatchAttachmentDelete } from '../../../features/attachments/attachmentDelete';
import { Node, mergeAttributes } from '@tiptap/core';
import { Plugin, PluginKey, NodeSelection } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { preloadHoverContent } from '../../../features/hover-windows/stores/hoverStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { t } from '../../utils/i18n';
import { getAttachmentCategory } from '../../../features/suggestions/attachmentCategory';
import { startAttachmentDrag, startMultiAttachmentDrag } from '../../../features/attachments/attachmentDragOut';
import { isWeb } from '../../../web/files';
import { useFileTreeStore } from '../../stores/fileTreeStore';
import { contentCacheActions } from '../../../features/content-cache/stores/contentCacheStore';

/**
 * HanBin 2026-05-14: count every reference to `fileName` anywhere in the
 * doc — wikiLink atom chips + mediaEmbed atom (inline image / video /
 * audio) nodes. Both are atoms now (since MediaEmbed.ts), so this is a
 * straightforward two-name match.
 *
 * The result drives "is this the last reference in this note?" gating on
 * the delete paths: > 1 → silent delete (the attachment is still linked
 * via the other refs), == 1 → show the unlink confirmation modal first.
 */
function countAttachmentRefsInDoc(
  doc: import('@tiptap/pm/model').Node,
  targetFileName: string,
): number {
  let count = 0;
  doc.descendants((node) => {
    if (node.type.name === 'wikiLink' && node.attrs.fileName === targetFileName) {
      count++;
      return false;
    }
    if (node.type.name === 'mediaEmbed' && node.attrs.fileName === targetFileName) {
      count++;
      return false;
    }
  });
  return count;
}

// ── Track B Phase B-3 PART 5: multi-chip selection + marquee ────────────────
//
// Selection is keyed by fileName (the node.attrs.fileName string). All chip
// occurrences of `[[Report.pdf]]` in the doc highlight together — same
// underlying attachment, same drag-out result.
//
// Gestures:
//   - Click chip                : single-select (clear others)
//   - Shift / Ctrl / Meta+click : toggle in selection
//   - Click outside chip (no mod): clear selection (text caret still works)
//   - Ctrl / Cmd + drag in editor: marquee — every chip intersecting the rect
//                                  joins the selection (file-manager style)
//   - Drag a selected chip      : group drag-out of every fileName in the set
//   - Esc                       : clear selection
//   - Doc edit                  : selection auto-clears (positions invalidate)
const wikiLinkSelectionPluginKey = new PluginKey<Set<string>>('wikiLinkSelection');

const MARQUEE_THRESHOLD_PX = 3;
const MARQUEE_OVERLAY_CLASS = 'wiki-link-marquee';

function setWikiSelection(view: import('@tiptap/pm/view').EditorView, names: Set<string>) {
  view.dispatch(view.state.tr.setMeta(wikiLinkSelectionPluginKey, names));
}

function clearWikiSelection(view: import('@tiptap/pm/view').EditorView) {
  const cur = wikiLinkSelectionPluginKey.getState(view.state);
  if (cur && cur.size > 0) {
    view.dispatch(view.state.tr.setMeta(wikiLinkSelectionPluginKey, new Set<string>()));
  }
}

function getWikiSelection(state: import('@tiptap/pm/state').EditorState): Set<string> {
  return wikiLinkSelectionPluginKey.getState(state) ?? new Set();
}

/**
 * Begin a marquee selection from a mousedown event. Attaches document-level
 * mousemove + mouseup listeners that paint an overlay div and compute which
 * attachment chips intersect the rectangle. Selection is committed on
 * mouseup; the overlay is removed regardless of outcome.
 *
 * The overlay only materializes once the mouse has actually moved past
 * `MARQUEE_THRESHOLD_PX` — a Ctrl+click that doesn't move shouldn't draw
 * a phantom rectangle.
 */
function startMarquee(
  view: import('@tiptap/pm/view').EditorView,
  startEvent: MouseEvent,
) {
  const startX = startEvent.clientX;
  const startY = startEvent.clientY;
  let overlay: HTMLDivElement | null = null;
  let confirmed = false;

  const onMove = (e: MouseEvent) => {
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (!confirmed) {
      if (Math.abs(dx) < MARQUEE_THRESHOLD_PX && Math.abs(dy) < MARQUEE_THRESHOLD_PX) {
        return;
      }
      confirmed = true;
      overlay = document.createElement('div');
      overlay.className = MARQUEE_OVERLAY_CLASS;
      document.body.appendChild(overlay);
    }
    const left = Math.min(startX, e.clientX);
    const top = Math.min(startY, e.clientY);
    const width = Math.abs(dx);
    const height = Math.abs(dy);
    if (overlay) {
      overlay.style.left = `${left}px`;
      overlay.style.top = `${top}px`;
      overlay.style.width = `${width}px`;
      overlay.style.height = `${height}px`;
    }
  };

  const onUp = (e: MouseEvent) => {
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('mouseup', onUp, true);
    if (overlay) {
      overlay.remove();
      overlay = null;
    }
    if (!confirmed) return; // bare Ctrl+click — nothing to do here
    const left = Math.min(startX, e.clientX);
    const top = Math.min(startY, e.clientY);
    const right = Math.max(startX, e.clientX);
    const bottom = Math.max(startY, e.clientY);

    // Walk every chip rendered inside this editor view, keeping only those
    // whose bounding box overlaps the marquee. additive=Ctrl+click already
    // toggles; here we union with the existing set so a user can extend a
    // selection across multiple marquee drags.
    const next = new Set(getWikiSelection(view.state));
    const chips = view.dom.querySelectorAll<HTMLElement>('[data-wiki-link]');
    chips.forEach((chip) => {
      if (!chip.classList.contains('attachment')) return;
      const r = chip.getBoundingClientRect();
      const overlaps = r.right >= left && r.left <= right && r.bottom >= top && r.top <= bottom;
      if (overlaps) {
        const fileName = chip.getAttribute('data-wiki-link');
        if (fileName) next.add(fileName);
      }
    });
    setWikiSelection(view, next);
  };

  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('mouseup', onUp, true);
}

export interface WikiLinkOptions {
  onClickLink: (fileName: string) => void;
  onContextMenu: (fileName: string, position: { x: number; y: number }, deleteCallback?: () => void) => void;
  resolveLink: (fileName: string) => boolean;
  getNoteType?: (fileName: string) => string | null;
  onEditorContextMenu?: (position: { x: number; y: number }) => void;
  // Getter function for notePath - allows dynamic updates without extension recreation
  getNotePath?: () => string;
  // Check if a file is an attachment (exists in current note's _att folder)
  // This is needed to distinguish .md attachments from vault notes
  isAttachment?: (fileName: string) => boolean;
  // Resolve fileName to full file path (for preloading on hover)
  resolveFilePath?: (fileName: string) => string | null;
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    wikiLink: {
      insertWikiLink: (fileName: string) => ReturnType;
    };
  }
}

// Non-greedy matching to support ] in filenames (e.g., [[디자인여백플러스] 파일.pdf]])
// Use Unicode flag for proper handling of Korean characters
const IMAGE_EMBED_REGEX = /!\[\[(.+?)\]\]/gu;

// classifyEmbedKind / resolveEmbedAbsolutePath / toAssetUrl moved to
// MediaEmbed.ts (2026-05-14) — only the IMAGE_EMBED_REGEX above stays here
// for the chip-converter pre-scan that excludes `![[…]]` ranges so the
// inner `[[…]]` doesn't get mistakenly converted to a chip.

// Helper to parse wiki link content: "fileName" or "fileName|displayText"
function parseWikiLinkContent(content: string): { fileName: string; displayText: string } {
  const pipeIndex = content.indexOf('|');
  if (pipeIndex >= 0) {
    return {
      fileName: content.substring(0, pipeIndex),
      displayText: content.substring(pipeIndex + 1)
    };
  }
  return { fileName: content, displayText: content };
}

// Helper function to infer note type from filename
function inferNoteType(fileName: string): string {
  const prefixes = ['NOTE', 'MTG', 'ADM', 'SEM', 'TASK', 'CONTACT', 'SETUP', 'DATA', 'THEO', 'PAPER', 'SKETCH'];
  const fileNameUpper = fileName.toUpperCase();

  for (const prefix of prefixes) {
    if (fileNameUpper.startsWith(prefix + '-') || fileNameUpper === prefix) {
      return prefix.toLowerCase();
    }
  }
  return '';
}

export const WikiLink = Node.create<WikiLinkOptions>({
  name: 'wikiLink',
  group: 'inline',
  inline: true,
  atom: true,
  // Track B Phase B-3 (2026-05-12): mark as draggable so ProseMirror sets
  // `draggable="true"` on the rendered chip span and routes drag events
  // through NodeSelection. Without this, the browser fires dragstart on the
  // surrounding contenteditable instead of the chip, our handleDOMEvents
  // misses it, and the user sees a text drag (the bug HanBin hit).
  draggable: true,

  addOptions() {
    return {
      onClickLink: () => {},
      onContextMenu: () => {},
      resolveLink: () => true,
      getNoteType: undefined,
      onEditorContextMenu: undefined,
      getNotePath: undefined,
      isAttachment: undefined,
      resolveFilePath: undefined,
    };
  },

  addAttributes() {
    return {
      fileName: {
        default: null,
      },
      // Display text for alias links like [[fileName|displayText]]
      displayText: {
        default: null,
      },
      // Store whether this is an attachment - persists even if file is deleted
      isAttachmentAttr: {
        default: false,
        parseHTML: (element: HTMLElement) => {
          // Check if the element has 'attachment' class
          return element.classList.contains('attachment');
        },
        renderHTML: (attributes: { isAttachmentAttr?: boolean }) => {
          // Don't render as HTML attribute - we use classes instead
          return {};
        },
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'span[data-wiki-link]',
        getAttrs: (element: HTMLElement) => {
          return {
            fileName: element.getAttribute('data-wiki-link'),
            displayText: element.getAttribute('data-display-text'),
            isAttachmentAttr: element.classList.contains('attachment'),
          };
        },
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    const fileName = node.attrs.fileName;
    const displayText = node.attrs.displayText || fileName;
    // Show underscores as spaces in display (only when no custom alias)
    const shownText = node.attrs.displayText ? displayText : fileName.replace(/_/g, ' ');
    const hasExtension = /\.[a-zA-Z0-9]+$/.test(fileName);
    const isMarkdown = fileName.endsWith('.md');
    const storedIsAttachment = node.attrs.isAttachmentAttr;

    // Determine if this is an attachment. Trusted-first cues:
    //   1. Backend callback says yes → ref in store.
    //   2. Pending drop (in-memory or persisted in localStorage) → optimistic.
    //      The persistent layer survives close+reopen across webviews and
    //      auto-expires after 5 minutes — long enough for any reasonable
    //      sha256 + CAS write, short enough that a backend that died mid-
    //      `attachment_add` falls back to plain "unresolved" gray instead
    //      of spinning forever (HanBin's infinite-spinner report).
    //   3. Stored attribute (node was inserted as attachment in this doc).
    //
    // Extension-only fallback was deliberately removed: it made every
    // broken `[[wrongfile.pdf]]` look like "uploading" indefinitely.
    const callbackResult = this.options.isAttachment ? this.options.isAttachment(fileName) : null;
    const isPendingInsert = useAttachmentStore.getState().isPending(fileName);
    const isAttachment = callbackResult === true
      || isPendingInsert
      || storedIsAttachment;

    const isResolved = this.options.resolveLink(fileName);

    // Use getNoteType callback if available, otherwise fall back to inferring from filename
    // If displayText starts with "@", treat as contact type (@ mentions are always contacts)
    const isMention = displayText && displayText.startsWith('@');
    const noteType = isAttachment ? '' :
      isMention ? 'contact' :
      (this.options.getNoteType ? (this.options.getNoteType(fileName) || '').toLowerCase() : inferNoteType(fileName));

    // Render shownText (underscores replaced with spaces for non-alias links)
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        'data-wiki-link': fileName,
        'data-display-text': displayText !== fileName ? displayText : null,
        class: `wiki-link-inline wiki-link-node ${isAttachment ? `attachment att-${getAttachmentCategory(fileName)}` : ''} ${noteType ? `note-type-${noteType}` : ''} ${isResolved ? '' : 'unresolved'}`,
      }),
      shownText,
    ];
  },

  addStorage() {
    return {
      markdown: {
        serialize(state: any, node: any) {
          const fileName = node.attrs.fileName || '';
          const displayText = node.attrs.displayText;
          if (displayText && displayText !== fileName) {
            state.write(`[[${fileName}|${displayText}]]`);
          } else {
            state.write(`[[${fileName}]]`);
          }
        },
        parse: {
          // Parsing is handled by the transform plugin (appendTransaction)
        },
      },
    };
  },

  addCommands() {
    const isAttachmentCallback = this.options.isAttachment;
    return {
      insertWikiLink: (fileName: string) => ({ commands }) => {
        const isAttachmentAttr = isAttachmentCallback ? isAttachmentCallback(fileName) : false;
        return commands.insertContent({
          type: this.name,
          attrs: { fileName, isAttachmentAttr },
        });
      },
    };
  },

  // v5.5 (2026-05-16) — Stage 5.0.4b-1.5: REMOVED `addInputRules`.
  // The `[[...]]` → chip conversion is already handled by the
  // `wikiLinkTransform` appendTransaction plugin below (line ~500), which
  // runs after EVERY doc change (typing, paste, markdown load). The
  // InputRule was a duplicate that only fired during live-typing — and
  // worse, it could fire prematurely when the user typed `]]` and intended
  // to keep typing. The appendTransaction waits for the next dispatch
  // boundary, so it's safer and equally responsive.
  //
  // MediaEmbed already removed its `![[...]]` InputRule in v4 for similar
  // schema reasons. Both atoms now exclusively use appendTransaction.

  addProseMirrorPlugins() {
    const { onClickLink, onContextMenu, resolveLink, getNoteType, onEditorContextMenu, getNotePath, isAttachment: isAttachmentCallback, resolveFilePath } = this.options;
    const wikiLinkType = this.type;
    // Captured so the deletion-guard plugin can call editor.commands.undo()
    // from outside the ProseMirror dispatch cycle (after the modal resolves).
    const editor = this.editor;

    return [
      // ── Selection plugin (PART 5) ────────────────────────────────────────
      // Owns the multi-chip selection state + marquee gesture. Decoration
      // emits the `.wiki-link-selected` class so CSS paints the highlight.
      new Plugin({
        key: wikiLinkSelectionPluginKey,
        state: {
          init: () => new Set<string>(),
          apply(tr, prev) {
            const meta = tr.getMeta(wikiLinkSelectionPluginKey);
            if (meta instanceof Set) return meta as Set<string>;
            // Doc edits invalidate the selection set conceptually; clearing
            // avoids stale highlights on chips that may have shifted/deleted.
            if (tr.docChanged) return new Set();
            return prev ?? new Set();
          },
        },
        props: {
          decorations(state) {
            const sel = wikiLinkSelectionPluginKey.getState(state);
            if (!sel || sel.size === 0) return DecorationSet.empty;
            const decos: Decoration[] = [];
            state.doc.descendants((node, pos) => {
              if (node.type.name !== 'wikiLink') return;
              const name = node.attrs.fileName;
              if (name && sel.has(name)) {
                decos.push(
                  Decoration.node(pos, pos + node.nodeSize, {
                    class: 'wiki-link-selected',
                  }),
                );
              }
            });
            return DecorationSet.create(state.doc, decos);
          },
          handleDOMEvents: {
            mousedown(view, event) {
              // Ctrl/Cmd+drag anywhere in the editor = marquee selection.
              // We commit to marquee only once the mouse actually moves
              // past the threshold; a plain Ctrl+click on a chip still
              // performs the toggle path below.
              const isMarqueeKey = event.ctrlKey || event.metaKey;
              const evTarget = event.target;
              const evEl =
                evTarget instanceof Element
                  ? evTarget
                  : (evTarget as Node | null)?.parentElement ?? null;
              const chipEl = evEl?.closest('[data-wiki-link]') as HTMLElement | null;

              if (chipEl) {
                const fileName = chipEl.getAttribute('data-wiki-link');
                if (!fileName) return false;
                const isAttachmentChip = chipEl.classList.contains('attachment');
                if (!isAttachmentChip) {
                  // Note wikilinks: clear any attachment-selection and pass
                  // through so the normal click/double-click flow runs.
                  clearWikiSelection(view);
                  return false;
                }

                const sel = new Set(getWikiSelection(view.state));
                const toggle = event.shiftKey || event.ctrlKey || event.metaKey;
                if (toggle) {
                  if (sel.has(fileName)) sel.delete(fileName);
                  else sel.add(fileName);
                  setWikiSelection(view, sel);
                  // Block the synthetic text-selection that ProseMirror
                  // would otherwise create on a contenteditable=false atom.
                  event.preventDefault();
                  return true;
                }
                // Plain click. If this chip is already part of a group
                // selection, *preserve* the group so the user can drag the
                // whole set with the same gesture. Otherwise reset to just
                // this chip.
                if (!sel.has(fileName)) {
                  const next = new Set<string>();
                  next.add(fileName);
                  setWikiSelection(view, next);
                }
                return false; // let dragstart proceed
              }

              // Click outside any chip.
              if (isMarqueeKey) {
                // Begin tracking for marquee — actual overlay only spawns on
                // mouse movement beyond the threshold (see startMarquee).
                startMarquee(view, event);
                event.preventDefault();
                return true;
              }
              // Bare click outside chip → clear selection (text caret still
              // gets placed by ProseMirror after this returns false).
              clearWikiSelection(view);
              return false;
            },
            keydown(view, event) {
              if (event.key === 'Escape') {
                const sel = getWikiSelection(view.state);
                if (sel.size > 0) {
                  clearWikiSelection(view);
                  return true;
                }
              }
              return false;
            },
          },
        },
      }),

      // Plugin to convert text [[...]] patterns to wiki link nodes
      new Plugin({
        key: new PluginKey('wikiLinkTransform'),
        appendTransaction: (transactions, _oldState, newState) => {
          // Only transform if there was a change
          if (!transactions.some(tr => tr.docChanged)) return null;

          const { tr, doc } = newState;
          let modified = false;

          // Find all text nodes with [[...]] patterns (but not ![[...]] for images)
          const nodesToReplace: Array<{ from: number; to: number; fileName: string; displayText: string | null }> = [];

          // HanBin 2026-05-13: pre-scan for image-embed ranges so we don't
          // accidentally eat the inner `[[...]]` of an `![[...]]` whose
          // *filename* starts with `[`. The single-char `(?<!!)` lookbehind
          // in the regex below only excludes `[[` directly preceded by `!`,
          // not by `![`. Without this guard, a filename like
          // `[Course] week1.mp4` got converted into a chip with mangled
          // name `[Course] week1.mp4` (no closing `]` since lazy match
          // stopped early) and the leftover `![` + `]` stayed as text.
          const imageEmbedRanges: Array<{ from: number; to: number }> = [];
          doc.descendants((node, pos) => {
            if (!node.isText || !node.text) return;
            IMAGE_EMBED_REGEX.lastIndex = 0;
            let m: RegExpExecArray | null;
            while ((m = IMAGE_EMBED_REGEX.exec(node.text)) !== null) {
              imageEmbedRanges.push({ from: pos + m.index, to: pos + m.index + m[0].length });
            }
          });
          const insideImageEmbed = (from: number, to: number): boolean => {
            for (const r of imageEmbedRanges) {
              if (from >= r.from && to <= r.to) return true;
            }
            return false;
          };

          doc.descendants((node, pos) => {
            if (!node.isText || !node.text) return;

            const text = node.text;
            // Match [[...]] but not ![[...]]
            // Use Unicode flag for proper handling of Korean characters
            const regex = /(?<!!)\[\[(.+?)\]\]/gu;
            let match;

            while ((match = regex.exec(text)) !== null) {
              const from = pos + match.index;
              const to = from + match[0].length;
              // Skip if this `[[...]]` lives inside an `![[...]]` embed —
              // the outer image-embed decoration handles it.
              if (insideImageEmbed(from, to)) continue;
              const parsed = parseWikiLinkContent(match[1]);
              nodesToReplace.push({ from, to, fileName: parsed.fileName, displayText: parsed.displayText !== parsed.fileName ? parsed.displayText : null });
            }
          });

          // Replace text patterns with wiki link nodes (in reverse order to preserve positions)
          for (let i = nodesToReplace.length - 1; i >= 0; i--) {
            const { from, to, fileName, displayText } = nodesToReplace[i];
            // Check if this file is an attachment
            const isAttachmentAttr = isAttachmentCallback ? isAttachmentCallback(fileName) : false;
            const wikiLinkNode = wikiLinkType.create({ fileName, displayText, isAttachmentAttr });
            tr.replaceWith(from, to, wikiLinkNode);
            modified = true;
          }

          return modified ? tr : null;
        },
      }),
      new Plugin({
        key: new PluginKey('wikiLinkDecorations'),
        props: {
          decorations(state) {
            const decorations: Decoration[] = [];
            const { doc } = state;

            doc.descendants((node, pos) => {
              // Handle wikiLink atom nodes - add decoration to update resolved/unresolved class dynamically
              if (node.type.name === 'wikiLink') {
                const fileName = node.attrs.fileName;
                const isResolved = resolveLink(fileName);
                const hasExtension = /\.[a-zA-Z0-9]+$/.test(fileName);
                const isMarkdown = fileName.endsWith('.md');
                const storedIsAttachment = node.attrs.isAttachmentAttr;

                // See renderHTML's matching comment. Same three cues:
                // backend callback, persistent-pending (localStorage-aware
                // so it survives close+reopen + auto-expires after 5 min),
                // and stored node attribute.
                const callbackResult = isAttachmentCallback ? isAttachmentCallback(fileName) : null;
                const isPending = useAttachmentStore.getState().isPending(fileName);
                const isAttachment = callbackResult === true
                  || isPending
                  || storedIsAttachment;

                const noteType = isAttachment ? '' :
                  (getNoteType ? (getNoteType(fileName) || '').toLowerCase() : inferNoteType(fileName));

                // Track B Phase B-3 stabilization: surface sync status on
                // the chip so a 600 MB upload doesn't look like the drop
                // failed. Five states (added PART 6 stuck + orphan):
                //   - pending / unresolved (no ref yet) : `attachment_add`
                //     in flight (sha + CAS write). Paint via the
                //     `.unresolved.attachment` CSS rule.
                //   - uploading (ref exists, no etag)   : NAS push in flight.
                //   - stuck (ref + no etag + >15 min)   : push likely failed
                //     beyond max retries — user must retry/discard.
                //   - orphan (no ref + not pending +    : the optimistic
                //     intent-was-attachment cue)          chip survived a
                //     failed attachment_add (rare: editor was unmounted
                //     before the failure event reached it, or chip was
                //     typed manually). Paint distinctly so the user can
                //     act instead of mistaking it for a broken note link.
                //   - resolved (etag present)           : fully synced.
                let attachmentSyncClass = '';
                let isOrphan = false;
                if (isAttachment && !isPending) {
                  const store = useAttachmentStore.getState();
                  const attRef = store.resolveByName(fileName);
                  if (attRef && !attRef.syncEtag) {
                    attachmentSyncClass = store.isStuck(attRef.attachmentId)
                      ? 'wiki-link-stuck'
                      : 'wiki-link-uploading';
                  } else if (attRef) {
                    attachmentSyncClass = 'wiki-link-synced';
                  } else if (storedIsAttachment) {
                    // Orphan classification requires the chip to have been
                    // *deliberately* inserted as an attachment (stored attr
                    // set to true at insertion time by the drop handler).
                    //
                    // The extension-only heuristic was removed (HanBin
                    // 2026-05-13): it false-positived during the brief gap
                    // between `unmarkPending` and the failure event handler
                    // removing the chip, painting freshly-dropped chips as
                    // orphan ✕ for files that were still on disk.
                    //
                    // Manually-typed wikilinks like `[[file.m4a]]` that lack
                    // a real ref now just render as plain unresolved (gray
                    // underline). That is acceptable — the user typed it,
                    // they know it is a guess, not a confirmed attachment.
                    isOrphan = true;
                    attachmentSyncClass = 'wiki-link-orphan';
                  }
                }

                // When orphan, force-apply attachment + category classes so
                // the chip still surfaces its file-type icon (alongside the
                // red dashed border) instead of looking like a plain
                // unresolved note link.
                const effectiveIsAttachment = isAttachment || isOrphan;

                decorations.push(
                  Decoration.node(pos, pos + node.nodeSize, {
                    class: `wiki-link-decoration ${effectiveIsAttachment ? `attachment att-${getAttachmentCategory(fileName)}` : ''} ${noteType ? `note-type-${noteType}` : ''} ${isResolved ? 'resolved' : 'unresolved'} ${attachmentSyncClass}`,
                  })
                );
                return false; // Don't descend into atom node
              }

              // HanBin 2026-05-14: media embeds (`![[file]]`) are now atom
              // nodes — see MediaEmbed.ts. The widget + display:none decoration
              // that previously rendered them here has been removed because it
              // broke cursor navigation (the caret silently traversed the
              // hidden characters). The conversion from raw text to atom is
              // owned by the MediaEmbed plugin's appendTransaction.
            });

            return DecorationSet.create(doc, decorations);
          },
          handleDoubleClick(_view, _pos, event) {
            if (event.button !== 0) return false;
            const target = event.target as HTMLElement;
            const wikiLink = target.closest('[data-wiki-link]');
            if (wikiLink) {
              const fileName = wikiLink.getAttribute('data-wiki-link');
              if (fileName) {
                onClickLink(fileName);
                return true;
              }
            }
            return false;
          },
          handleDOMEvents: {
            contextmenu(view, event) {
              // Stage 5.0.4b-2d (2026-05-15) — atom nodes own their own
              // right-click handlers (MediaEmbed plugin, MathTrigger plugin,
              // LinkCard React onContextMenu). Without this skip, WikiLink's
              // fallback to onEditorContextMenu intercepts those clicks
              // first (plugin priority) and the atom menus never fire.
              const rawTarget = event.target as HTMLElement | null;
              if (rawTarget?.closest('.wiki-image-embed-wrapper, .math-node, .link-card')) {
                return false;
              }
              const target = rawTarget?.closest('[data-wiki-link]') ?? null;
              if (target) {
                event.preventDefault();
                const fileName = target.getAttribute('data-wiki-link');
                if (fileName) {
                  // Find the position of this wiki link in the document
                  const pos = view.posAtDOM(target, 0);

                  // Delete callback — branches on whether this chip is the
                  // *canonical* first link (in the 첨부파일 section) or an
                  // *additional* link (an inline reference elsewhere).
                  //
                  //   • additional → silent delete, no modal, no backend call
                  //   • canonical  → modal first, only delete on confirm
                  //                  (avoids the previous flash-then-undo UX)
                  const deleteCallback = () => {
                    const { state } = view;
                    const { doc } = state;

                    // Find the decoration/node at this position
                    let foundPos = -1;
                    let foundEnd = -1;

                    doc.descendants((node, nodePos) => {
                      if (foundPos >= 0) return false;

                      // Check for atom node (wikiLink type)
                      if (node.type.name === 'wikiLink' && node.attrs.fileName === fileName) {
                        if (nodePos <= pos && pos <= nodePos + node.nodeSize) {
                          foundPos = nodePos;
                          foundEnd = nodePos + node.nodeSize;
                          return false;
                        }
                      }

                      // Check for text node with wiki link decoration
                      if (node.isText && node.text) {
                        const regex = /\[\[(.+?)\]\]/g;
                        let match;
                        while ((match = regex.exec(node.text)) !== null) {
                          const parsedMatch = parseWikiLinkContent(match[1]);
                          if (parsedMatch.fileName === fileName) {
                            const start = nodePos + match.index;
                            const end = start + match[0].length;
                            if (start <= pos && pos <= end) {
                              foundPos = start;
                              foundEnd = end;
                              return false;
                            }
                          }
                        }
                      }
                    });

                    if (foundPos < 0) return;

                    const dispatchDelete = (from: number, to: number) => {
                      const tr = view.state.tr.delete(from, to);
                      tr.setMeta('wikiLink/skipDeleteGuard', true);
                      view.dispatch(tr);
                    };

                    // HanBin 2026-05-13 (revised): count ALL references to
                    // this attachment in the doc — both chips and inline
                    // `![[...]]` embeds. If removing this one would still
                    // leave references in this note, the attachment is
                    // still linked → silent delete, no modal. Only the
                    // last-remaining reference triggers the confirmation.
                    const totalRefs = countAttachmentRefsInDoc(doc, fileName);
                    if (totalRefs > 1) {
                      dispatchDelete(foundPos, foundEnd);
                      return;
                    }

                    // Branch: last reference in this note → modal first.
                    void (async () => {
                      const notePath = getNotePath?.() || '';
                      const noteId = notePath
                        .replace(/\\/g, '/')
                        .split('/')
                        .pop()
                        ?.replace(/\.md$/i, '') ?? '';
                      const ref = useAttachmentStore.getState().resolveByName(fileName, noteId);
                      if (!ref) {
                        // No backing ref (manual wikilink or pre-CAS) — no
                        // confirmation is meaningful, just delete the text.
                        dispatchDelete(foundPos, foundEnd);
                        return;
                      }

                      const result = await requestAttachmentDelete({
                        attachmentId: ref.attachmentId,
                        originalName: ref.originalName,
                        noteId,
                      });
                      if (!result.confirmed) return; // user cancelled — chip stays

                      // Re-find the chip position (doc may have shifted while
                      // the modal was open) and delete in a guard-skipping tx
                      // so the deletionGuard plugin doesn't double-fire the
                      // modal on this confirmed removal.
                      let pos2 = -1, end2 = -1;
                      view.state.doc.descendants((node, nodePos) => {
                        if (pos2 >= 0) return false;
                        if (node.type.name === 'wikiLink' && node.attrs.fileName === fileName) {
                          pos2 = nodePos;
                          end2 = nodePos + node.nodeSize;
                          return false;
                        }
                      });
                      if (pos2 >= 0) dispatchDelete(pos2, end2);
                    })();
                  };

                  onContextMenu(fileName, { x: event.clientX, y: event.clientY }, deleteCallback);
                  return true;
                }
              }
              // Not a wiki link - show editor formatting context menu
              if (onEditorContextMenu) {
                event.preventDefault();
                // Force-flush the current selection state before opening the menu.
                // This prevents table cell multi-selection from being cancelled
                // when right-clicking immediately after drag-selecting cells.
                view.focus();
                onEditorContextMenu({ x: event.clientX, y: event.clientY });
                return true;
              }
              return false;
            },
            // Preload content on hover for faster window opening
            mouseover(_view, event) {
              const target = (event.target as HTMLElement).closest('[data-wiki-link]');
              if (target) {
                const fileName = target.getAttribute('data-wiki-link');
                if (fileName && !target.classList.contains('attachment') && resolveFilePath) {
                  // Resolve fileName to full path and preload
                  const filePath = resolveFilePath(fileName);
                  if (filePath) {
                    preloadHoverContent(filePath);
                  }
                }
              }
              return false;
            },
            // Track B Phase B-3 (2026-05-12): native OS drag-out via
            // tauri-plugin-drag. Intercept the dragstart so it never falls
            // through to TipTap's default text drag — that emits plain text
            // payload which WebView2 cannot promote to a file promise.
            //
            // Detection strategy (two paths — atom nodes can route either way):
            //   1. ProseMirror NodeSelection of a wikiLink → preferred, fires
            //      even when event.target is the editor container (.ProseMirror)
            //      rather than the chip span.
            //   2. DOM closest('[data-wiki-link]') → fallback for cases where
            //      the chip was the actual dragstart target.
            dragstart(view, event) {
              let fileName: string | null = null;
              let isAttachmentChip = false;

              // Path 1: NodeSelection (typical for atom-node drag)
              const sel = view.state.selection;
              if (sel instanceof NodeSelection && sel.node.type.name === 'wikiLink') {
                fileName = sel.node.attrs.fileName ?? null;
                isAttachmentChip =
                  sel.node.attrs.isAttachmentAttr === true
                  || (!!fileName && isAttachmentCallback?.(fileName) === true);
              }

              // Path 2: DOM target (cases where the chip itself fires).
              // Guard with `instanceof Element` — drag events can fire with
              // event.target being a Text node, Document, or window, none of
              // which have `closest()`. Hit during initial B-3 testing.
              if (!fileName) {
                const evTarget = event.target;
                const el = evTarget instanceof Element
                  ? evTarget
                  : (evTarget as Node | null)?.parentElement;
                const target = el?.closest('[data-wiki-link]') ?? null;
                if (target) {
                  fileName = target.getAttribute('data-wiki-link');
                  isAttachmentChip = target.classList.contains('attachment');
                }
              }

              if (!fileName) return false;
              if (!isAttachmentChip) {
                console.log('[WikiLink dragstart] ignored — not an attachment:', fileName);
                return false;
              }

              if (isWeb()) {
                // 🔴 웹: preventDefault 금지 — DownloadURL 은 **브라우저의
                //    기본 드래그**에 실린다. 탐색기·바탕화면에 놓으면 진짜
                //    파일이 된다 (2026-08-26 사용자 요구). 여태 이 자리는
                //    import 가 빠져 ReferenceError 로 죽어 있었다.
                event.stopPropagation();
                const nid = getNotePath?.()
                  ?.replace(/\\/g, '/').split('/').pop()
                  ?.replace(/\.md$/i, '');
                void startAttachmentDrag(fileName, nid, event);
                return true;
              }
              event.preventDefault();
              event.stopPropagation();
              if (event.dataTransfer) {
                // Clear what TipTap would have written so the OS doesn't
                // race a partial DataTransfer setup with our native drag.
                event.dataTransfer.effectAllowed = 'none';
              }
              const noteId = getNotePath?.()
                ?.replace(/\\/g, '/')
                .split('/')
                .pop()
                ?.replace(/\.md$/i, '');

              // PART 5: if this chip is part of a multi-selection, drag the
              // whole group at once. Otherwise fall back to the single-chip
              // path. Resolution happens here (sync) so the plugin's OS-
              // level drag-initiation call sees the full payload.
              const selectionSet = getWikiSelection(view.state);
              if (selectionSet.size > 1 && selectionSet.has(fileName)) {
                const store = useAttachmentStore.getState();
                const refs = Array.from(selectionSet)
                  .map((name) => store.resolveByName(name, noteId))
                  .filter((r): r is NonNullable<typeof r> => r !== null);
                // Dedup by attachment_id so the same file selected twice
                // isn't dragged twice (covers the rare case of duplicate
                // chips for the same attachment in one note body).
                const unique = new Map<string, (typeof refs)[number]>();
                for (const r of refs) unique.set(r.attachmentId, r);
                console.log(
                  '[WikiLink dragstart] intercepting multi-attachment:',
                  unique.size,
                  'files',
                );
                void startMultiAttachmentDrag(Array.from(unique.values()));
                return true;
              }

              console.log('[WikiLink dragstart] intercepting attachment:', fileName);
              // Fire-and-forget — the plugin uses the native OS drag API
              // (IDataObject on Windows) which captures the mouse-down
              // state synchronously inside its initiation call.
              void startAttachmentDrag(fileName, noteId);
              return true;
            },
          },
        },
      }),

      // ── Track B Phase B-3 PART 6: deletion guard (Option C) ───────────────
      //
      // Detects attachment wikilink atoms that disappear from the doc between
      // transactions and routes them through `requestBatchAttachmentDelete`.
      // The user's chosen policy (HanBin 2026-05-13) is hard delete on the
      // last link, gated by a confirmation modal that can be disabled in
      // settings. Sources of "wikilink disappearance" include:
      //   - Backspace/Delete adjacent to chip
      //   - Cut / paste-over selection containing the chip
      //   - Context-menu Delete (also wrapped at the menu level)
      //   - Programmatic editor commands
      //
      // On cancel, we issue `editor.commands.undo()` as a best-effort restore.
      // The history plugin reverses the latest transaction; if intervening
      // edits piled up while the modal was open, those are reversed too —
      // acceptable since the modal blocks ~the entire UI surface anyway.
      //
      // Set `tr.setMeta('wikiLink/skipDeleteGuard', true)` on any transaction
      // that is itself the cleanup pass after a confirmed deletion, so this
      // guard does not re-trigger the modal.
      new Plugin({
        key: new PluginKey('wikiLinkDeletionGuard'),
        appendTransaction(transactions, oldState, newState) {
          if (!transactions.some((tr) => tr.docChanged)) return null;
          if (transactions.some((tr) => tr.getMeta('wikiLink/skipDeleteGuard'))) return null;

          // HanBin 2026-05-13 (revised): count-based, not section-based.
          // For every chip atom that disappeared between transactions, check
          // whether the new doc still has ANY reference (chip or inline
          // `![[…]]` embed) to the same attachment. If yes, the note is
          // still linked — silent. Only when zero references remain do we
          // raise the unlink-confirmation modal.
          const oldNames = countAttachmentAtoms(oldState.doc, isAttachmentCallback);
          const newNames = countAttachmentAtoms(newState.doc, isAttachmentCallback);

          const removed: string[] = [];
          for (const [name, oldCount] of oldNames) {
            const newCount = newNames.get(name) ?? 0;
            if (newCount >= oldCount) continue;
            // Count ALL remaining refs in newState (atoms + raw embeds).
            const remainingRefs = countAttachmentRefsInDoc(newState.doc, name);
            if (remainingRefs > 0) continue; // still linked via something else
            for (let i = newCount; i < oldCount; i++) removed.push(name);
          }
          if (removed.length === 0) return null;

          // Defer the modal flow — never call into React state synchronously
          // from inside appendTransaction.
          queueMicrotask(() => {
            void handleRemovedAttachmentWikilinks(removed, editor, getNotePath);
          });
          return null;
        },
      }),
    ];
  },
});

/**
 * Count attachment-flavored atoms in a doc, grouped by fileName. Includes
 * both wikiLink chips and mediaEmbed inline players — both are attachment
 * references and both should arm the deletion guard when removed.
 */
function countAttachmentAtoms(
  doc: import('@tiptap/pm/model').Node,
  isAttachmentCallback: WikiLinkOptions['isAttachment'],
): Map<string, number> {
  const map = new Map<string, number>();
  doc.descendants((node) => {
    if (node.type.name === 'mediaEmbed') {
      const fileName = node.attrs.fileName;
      if (!fileName) return;
      // mediaEmbed is always an attachment reference — no callback gate needed.
      map.set(fileName, (map.get(fileName) ?? 0) + 1);
      return;
    }
    if (node.type.name !== 'wikiLink') return;
    const fileName = node.attrs.fileName;
    if (!fileName) return;
    // Cheapest discriminator that holds: the stored attribute set at insert
    // time. Fall back to the callback (live state) so chips that just
    // resolved before this deletion still get the confirmation path.
    const isAtt =
      node.attrs.isAttachmentAttr === true
      || isAttachmentCallback?.(fileName) === true;
    if (!isAtt) return;
    map.set(fileName, (map.get(fileName) ?? 0) + 1);
  });
  return map;
}


async function handleRemovedAttachmentWikilinks(
  removedFileNames: string[],
  editor: import('@tiptap/core').Editor,
  getNotePath: WikiLinkOptions['getNotePath'],
) {
  const store = useAttachmentStore.getState();
  const noteId = getNotePath?.()
    ?.replace(/\\/g, '/')
    .split('/')
    .pop()
    ?.replace(/\.md$/i, '') ?? '';

  const requests = removedFileNames
    .map((fileName) => {
      const ref = store.resolveByName(fileName, noteId);
      if (!ref) return null;
      return {
        attachmentId: ref.attachmentId,
        originalName: ref.originalName,
        noteId,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  if (requests.length === 0) return;

  const { cancelled } = await requestBatchAttachmentDelete(requests);
  if (cancelled.length > 0) {
    // Best-effort restore. The undo command reverses the most recent
    // transaction in the history stack; the chip's deletion is the trigger
    // we just confirmed, so undoing it brings the chip(s) back.
    editor.chain().focus().undo().run();
  }
}

export default WikiLink;
