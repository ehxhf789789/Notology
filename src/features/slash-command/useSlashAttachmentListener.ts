/**
 * Stage 5.0.4b-2 part B (2026-05-15) — slash-attachment host.
 *
 * The slash palette's "첨부파일" command dispatches a
 * `slash-attachment-requested` CustomEvent with `{ detail: { editor } }`
 * (see features/slash-command/commands.ts). This hook is the receiver:
 * each editor host (ContainerView, HoverEditor) registers it once. The
 * `editor === event.detail.editor` filter ensures only the targeted
 * editor reacts.
 *
 * Behavior:
 *   1. Open Tauri file picker (multi-select).
 *   2. Dedup against wikilinks already in the doc (matches the drag-drop
 *      path's invariant — the chip render assumes uniqueness within a
 *      note for the resolve-by-name lookup).
 *   3. Insert at the current cursor: single file → inline chip; multiple
 *      files → bullet list of chips. (Differs from drag-drop, which always
 *      appends to the "첨부파일" section because drop has no cursor context.
 *      Slash-typed input has cursor context — putting results elsewhere
 *      would surprise the user.)
 *   4. Fire `attachment_add` for every source path in the background,
 *      mirroring the orphan-prevention pipeline from useDragDrop.ts:
 *        markPending → attachmentAdd / importAttachment fallback →
 *        store refresh → unmarkPending → 8 s no-ref sanity check.
 */
import { useEffect } from 'react';
import type { Editor } from '@tiptap/core';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { syncV2Commands } from '../sync_v2/syncV2Commands';
import { noteCommands } from '../../core/services/tauriCommands';
import { useAttachmentStore } from '../sync_v2/stores/attachmentStore';
import { EventBus } from '../../core/infrastructure/eventBus';
import { addPersistentFailedAdd } from '../sync_v2/orphanRemoval';
import { classifyMediaKind } from '../../core/editor/extensions/MediaEmbed';

/**
 * v20.5 (2026-05-16, HanBin) — optional override for hosts that need to
 * place imported attachments somewhere OTHER than the editor's text
 * stream. Sketch passes one to add each picked file as a CANVAS NODE
 * instead of a wikilink chip. Called once per picked file with the
 * resolved attachment basename and source path; the host is responsible
 * for the visual representation. When omitted, the legacy behavior
 * (insert wikilink chip / mediaEmbed) runs.
 */
export interface SlashAttachmentInsertOverride {
  insertOne: (args: { basename: string; sourcePath: string }) => void;
}

export function useSlashAttachmentListener(
  editor: Editor | null,
  notePath: string | null,
  override?: SlashAttachmentInsertOverride,
) {
  useEffect(() => {
    if (!editor || !notePath) return;

    const handler = async (e: Event) => {
      const ev = e as CustomEvent<{ editor: Editor }>;
      if (ev.detail?.editor !== editor) return;

      let selected: string | string[] | null = null;
      try {
        selected = await openDialog({ multiple: true, title: '첨부파일 선택' });
      } catch (err) {
        console.warn('[slash-attachment] file dialog failed:', err);
        return;
      }
      if (!selected) return;
      const sourcePaths = Array.isArray(selected) ? selected : [selected];
      if (sourcePaths.length === 0) return;

      // Dedup against existing wikilinks in the doc (same invariant as the
      // drag-drop path — duplicates would otherwise produce two chips that
      // race for the same attachment ref on resolve-by-name).
      const existingNames = new Set<string>();
      editor.state.doc.descendants((n) => {
        if (n.type.name === 'wikiLink' && typeof n.attrs.fileName === 'string') {
          existingNames.add(n.attrs.fileName.toLowerCase());
        }
      });

      const toInsert: Array<{ sourcePath: string; basename: string }> = [];
      let skipped = 0;
      for (const p of sourcePaths) {
        const basename = p.split(/[\\/]/).pop() || '';
        if (!basename) continue;
        if (existingNames.has(basename.toLowerCase())) { skipped++; continue; }
        toInsert.push({ sourcePath: p, basename });
        existingNames.add(basename.toLowerCase());
      }
      if (skipped > 0) {
        console.info(`[slash-attachment] skipped ${skipped} already-attached file(s)`);
      }
      if (toInsert.length === 0) return;

      // v20.5 (2026-05-16, HanBin) — sketch override path. The host wants
      // each picked attachment to become a canvas node, NOT a wikilink in
      // the text. We still run the background CAS upload below (same
      // markPending → attachmentAdd → unmarkPending pipeline) so the
      // attachment is durable on disk and visible in the attachment
      // store; only the visual placement diverges.
      if (override) {
        for (const { sourcePath, basename } of toInsert) {
          override.insertOne({ basename, sourcePath });
        }
        // Background import / push — identical to the legacy branch.
        for (const { sourcePath, basename } of toInsert) {
          useAttachmentStore.getState().markPending(basename);
          void (async () => {
            let bothFailedError: unknown = null;
            let succeeded = false;
            try {
              await syncV2Commands.attachmentAdd(sourcePath, { notePath });
              succeeded = true;
            } catch (err) {
              console.warn('[slash-attachment override] attachmentAdd failed, fallback:', err);
              try {
                await noteCommands.importAttachment(sourcePath, notePath);
                succeeded = true;
              } catch (err2) {
                bothFailedError = err2;
              }
            }
            if (succeeded) {
              try { await useAttachmentStore.getState().refresh(); } catch {}
            }
            useAttachmentStore.getState().unmarkPending(basename);
            if (bothFailedError !== null) {
              try { addPersistentFailedAdd(notePath, basename); } catch {}
              EventBus.emit('attachment:addFailed', {
                fileName: basename, notePath, error: String(bothFailedError),
              });
            }
          })();
        }
        return;
      }

      // Insert at the current cursor. v4.1 (2026-05-15): split files by
      // kind so users get the right node type for each:
      //   • Media (audio/video/image) → mediaEmbed block atom (visual player)
      //   • Other files (PDF, docx, zip, …) → wikiLink chip (inline)
      // This is critical because there's no other UI for inserting a
      // mediaEmbed — HanBin asked "how am I supposed to test this?".
      // Mixed selection inserts each file appropriately at the cursor;
      // mediaEmbeds become their own block, wikilinks stay inline (in a
      // bullet list if 2+).
      const mediaFiles = toInsert.filter((f) => classifyMediaKind(f.basename) !== null);
      const otherFiles = toInsert.filter((f) => classifyMediaKind(f.basename) === null);

      const insertChain = editor.chain().focus();

      // Insert mediaEmbed blocks one by one (each is a separate block atom).
      // insertContentAt at the current selection splits the surrounding
      // paragraph if needed.
      for (const { basename } of mediaFiles) {
        const kind = classifyMediaKind(basename)!;
        insertChain.insertContent({
          type: 'mediaEmbed',
          attrs: { fileName: basename, kind },
        });
      }

      // Then insert wikiLink chips for non-media files (single chip or
      // bullet list, same as before).
      if (otherFiles.length === 1) {
        insertChain.insertContent([
          { type: 'wikiLink', attrs: { fileName: otherFiles[0].basename, isAttachmentAttr: true } },
        ]);
      } else if (otherFiles.length > 1) {
        const listItems = otherFiles.map(({ basename }) => ({
          type: 'listItem',
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'wikiLink', attrs: { fileName: basename, isAttachmentAttr: true } }],
            },
          ],
        }));
        insertChain.insertContent({ type: 'bulletList', content: listItems });
      }

      insertChain.run();

      // Background CAS upload — mirrors useDragDrop.ts. Each file goes
      // through markPending → attachmentAdd → unmarkPending so chips
      // transition amber → tier-color atomically once the ref lands.
      for (const { sourcePath, basename } of toInsert) {
        useAttachmentStore.getState().markPending(basename);
        void (async () => {
          let bothFailedError: unknown = null;
          let succeeded = false;
          try {
            await syncV2Commands.attachmentAdd(sourcePath, { notePath });
            succeeded = true;
          } catch (err) {
            console.warn('[slash-attachment] attachmentAdd failed, trying legacy import:', err);
            try {
              await noteCommands.importAttachment(sourcePath, notePath);
              succeeded = true;
            } catch (err2) {
              console.error('[slash-attachment] both attachmentAdd and importAttachment failed:', err2);
              bothFailedError = err2;
            }
          }

          if (succeeded) {
            try { await useAttachmentStore.getState().refresh(); }
            catch (e) { console.warn('[slash-attachment] post-add refresh failed:', e); }
          }
          useAttachmentStore.getState().unmarkPending(basename);

          if (bothFailedError !== null) {
            try { addPersistentFailedAdd(notePath, basename); } catch {}
            EventBus.emit('attachment:addFailed', {
              fileName: basename,
              notePath,
              error: String(bothFailedError),
            });
            return;
          }

          // Same 8 s sanity check as useDragDrop — guards the "add reported
          // success but ref never appeared" case (sync engine restart race).
          setTimeout(() => {
            const ref = useAttachmentStore.getState().resolveByName(basename);
            if (!ref) {
              console.warn(
                '[slash-attachment] attachment_add reported success but no ref appeared after 8 s — treating as orphan:',
                basename,
              );
              try { addPersistentFailedAdd(notePath, basename); } catch {}
              EventBus.emit('attachment:addFailed', {
                fileName: basename,
                notePath,
                error: 'no-ref-after-success',
              });
            }
          }, 8000);
        })();
      }
    };

    window.addEventListener('slash-attachment-requested', handler);
    return () => window.removeEventListener('slash-attachment-requested', handler);
  }, [editor, notePath]);
}
