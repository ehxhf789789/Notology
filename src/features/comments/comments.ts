import { memoCommands, noteCommands, searchCommands } from '../../core/services/tauriCommands';
import type { NoteComment } from '../../core/types';
import { markAsSelfSaved } from '../../core/utils/selfSaveTracker';
import { notifySearchIndexUpdated } from '../../core/utils/windowSync';

export interface LoadCommentsResult {
  comments: NoteComment[];
  mtime: number;
}

export async function loadComments(notePath: string): Promise<LoadCommentsResult> {
  try {
    const result = await memoCommands.readComments(notePath);
    const comments: NoteComment[] = JSON.parse(result.comments);
    return { comments, mtime: result.mtime };
  } catch (e) {
    console.error('Failed to load comments:', e);
    return { comments: [], mtime: 0 };
  }
}

/**
 * Save comments with mtime-based merge for Synology sync safety.
 * If the disk file changed since we last loaded (mtime mismatch),
 * re-read from disk, merge, then save the merged result.
 * Returns the merged comments and new mtime so the caller can update state.
 */
export async function saveComments(
  notePath: string,
  comments: NoteComment[],
  knownMtime: number
): Promise<{ comments: NoteComment[]; mtime: number }> {
  try {
    // Re-read disk to check for external changes
    const diskResult = await memoCommands.readComments(notePath);
    let commentsToSave = comments;

    if (diskResult.mtime > knownMtime && knownMtime > 0) {
      // Disk was modified externally — merge
      const diskComments: NoteComment[] = JSON.parse(diskResult.comments);
      commentsToSave = mergeComments(comments, diskComments);
      console.log(`[comments] Merged: local=${comments.length}, disk=${diskComments.length}, result=${commentsToSave.length}`);
    }

    // Sanitize: strip null/undefined task fields to prevent Rust null misdetection
    const sanitized = commentsToSave.map(c => {
      if (c.task === null || c.task === undefined) {
        const { task, ...rest } = c;
        return rest;
      }
      return c;
    });
    const commentsJson = JSON.stringify(sanitized, null, 2);
    const newMtime = await memoCommands.writeComments(notePath, commentsJson);

    // Index memos after saving
    try {
      await memoCommands.indexNoteMemos(notePath);
    } catch (indexError) {
      console.warn('Failed to index memos:', indexError);
    }

    // Mark as self-saved BEFORE touchNoteModified writes to .md,
    // so the file watcher won't treat it as an external change
    markAsSelfSaved(notePath);

    // Update the parent note's modified timestamp, then re-index for search
    noteCommands.touchNoteModified(notePath).then(() => {
      return searchCommands.indexNote(notePath);
    }).then(() => {
      notifySearchIndexUpdated(notePath).catch(() => {});
    }).catch(err => {
      console.warn('Failed to touch/index note:', err);
    });

    return { comments: commentsToSave, mtime: newMtime };
  } catch (e) {
    console.error('Failed to save comments:', e);
    return { comments, mtime: knownMtime };
  }
}

/**
 * Merge local and disk comments (ID-based union).
 * - Same ID on both sides: keep the one with newer createdTime
 * - Unique IDs: include from both sides
 */
export function mergeComments(local: NoteComment[], disk: NoteComment[]): NoteComment[] {
  const merged = new Map<string, NoteComment>();

  // Add all disk comments first
  for (const c of disk) {
    merged.set(c.id, c);
  }

  // Overlay local comments — newer wins for same ID
  for (const c of local) {
    const existing = merged.get(c.id);
    if (!existing) {
      merged.set(c.id, c);
    } else {
      // Compare timestamps: prefer the newer one
      const localTime = c.createdTime || c.created || '';
      const existingTime = existing.createdTime || existing.created || '';
      if (localTime >= existingTime) {
        merged.set(c.id, c);
      }
      // else keep existing (disk version is newer)
    }
  }

  return Array.from(merged.values());
}

export function generateCommentId(): string {
  return `comment_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
}
