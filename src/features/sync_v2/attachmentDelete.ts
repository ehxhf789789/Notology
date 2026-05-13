/**
 * Track B Phase B-3 PART 6 — attachment deletion request flow (Option C).
 *
 * When a user removes a wikilink chip from a note body, we treat that as
 * intent to delete the attachment: unlink from the note, and if it was the
 * last reference anywhere, hard-delete the underlying CAS blob + display
 * hardlink + NAS copy.
 *
 * The "all triggers raise a confirmation" requirement (HanBin 2026-05-13)
 * is implemented here so that ProseMirror, ContextMenu, and any future
 * Attachments-tab surface go through the same gate. The confirmation can
 * be disabled per-vault via `settings.confirmAttachmentDelete`.
 */

import { syncV2Commands } from './syncV2Commands';
import { useAttachmentStore } from './stores/attachmentStore';
import { useSettingsStore } from '../../core/stores/settingsStore';
import { modalActions } from '../modals/stores/modalStore';
import { t } from '../../core/utils/i18n';

export interface DeleteRequest {
  attachmentId: string;
  /** Display label for the confirmation modal (original_name). */
  originalName: string;
  /** Which note is being edited — passed to unlink so other links survive. */
  noteId: string;
}

export interface DeleteResult {
  confirmed: boolean;
  /** True iff the attachment was fully hard-deleted (last link). */
  hardDeleted: boolean;
}

/**
 * Request deletion of one attachment. Resolves to `{ confirmed: false }` if
 * the user cancelled the modal (caller must restore the wikilink). Resolves
 * to `{ confirmed: true, hardDeleted }` after the backend call completes.
 *
 * When `confirmAttachmentDelete` is off, this skips the modal entirely and
 * goes straight to the unlink-or-delete call. Cancellation is impossible
 * in that mode (caller will always receive `confirmed: true`).
 */
export async function requestAttachmentDelete(req: DeleteRequest): Promise<DeleteResult> {
  const { attachmentId, originalName, noteId } = req;
  const confirmEnabled = useSettingsStore.getState().confirmAttachmentDelete;

  if (!confirmEnabled) {
    try {
      const hardDeleted = await syncV2Commands.attachmentUnlinkOrDelete(attachmentId, noteId);
      return { confirmed: true, hardDeleted };
    } catch (err) {
      console.error('[attachmentDelete] backend call failed:', err);
      return { confirmed: false, hardDeleted: false };
    }
  }

  // Determine warning copy. If this is the only/last link, surface that the
  // underlying blob (and NAS copy) are going for good.
  const ref = useAttachmentStore.getState().index.byId.get(attachmentId);
  const language = useSettingsStore.getState().language;
  const otherLinkCount =
    ref?.linkedNotes.filter((n) => n.toLowerCase() !== noteId.toLowerCase()).length ?? 0;
  const isLastLink = otherLinkCount === 0;
  const warningOverride = isLastLink
    ? t('warnAttachmentLastLink', language)
    : t('warnAttachmentUnlinkOnly', language);

  return new Promise<DeleteResult>((resolve) => {
    modalActions.showConfirmDelete(
      originalName,
      'file',
      async () => {
        try {
          const hardDeleted = await syncV2Commands.attachmentUnlinkOrDelete(attachmentId, noteId);
          resolve({ confirmed: true, hardDeleted });
        } catch (err) {
          console.error('[attachmentDelete] backend call failed:', err);
          resolve({ confirmed: false, hardDeleted: false });
        }
      },
      undefined,
      {
        onCancel: () => resolve({ confirmed: false, hardDeleted: false }),
        warningOverride,
      },
    );
  });
}

/**
 * Batch deletion: one combined modal for N attachments. The user accepts or
 * rejects the whole set — selecting individual items would require a more
 * elaborate UI than the current ConfirmDeleteModal. This is the path the
 * ProseMirror plugin uses when a single transaction removes multiple chips.
 *
 * Returns the list of attachmentIds that were NOT deleted (caller restores
 * those — typically via editor.commands.undo()).
 */
export async function requestBatchAttachmentDelete(
  requests: DeleteRequest[],
): Promise<{ cancelled: string[] }> {
  if (requests.length === 0) return { cancelled: [] };
  if (requests.length === 1) {
    const r = await requestAttachmentDelete(requests[0]);
    return { cancelled: r.confirmed ? [] : [requests[0].attachmentId] };
  }

  const confirmEnabled = useSettingsStore.getState().confirmAttachmentDelete;
  if (!confirmEnabled) {
    const cancelled: string[] = [];
    for (const r of requests) {
      try {
        await syncV2Commands.attachmentUnlinkOrDelete(r.attachmentId, r.noteId);
      } catch (err) {
        console.error('[attachmentDelete] backend call failed:', err);
        cancelled.push(r.attachmentId);
      }
    }
    return { cancelled };
  }

  // Build a representative name + count for the modal header.
  const displayName =
    requests.length === 1
      ? requests[0].originalName
      : `${requests[0].originalName} +${requests.length - 1}`;

  return new Promise<{ cancelled: string[] }>((resolve) => {
    const cancelled: string[] = requests.map((r) => r.attachmentId);
    modalActions.showConfirmDelete(
      displayName,
      'file',
      async () => {
        const failed: string[] = [];
        for (const r of requests) {
          try {
            await syncV2Commands.attachmentUnlinkOrDelete(r.attachmentId, r.noteId);
          } catch (err) {
            console.error('[attachmentDelete] backend call failed:', err);
            failed.push(r.attachmentId);
          }
        }
        resolve({ cancelled: failed });
      },
      requests.length,
      {
        onCancel: () => resolve({ cancelled }),
      },
    );
  });
}
