/**
 * Track B Phase B-3 PART 6 — orphan wikilink removal helpers.
 *
 * Used by the editor's `attachment:addFailed` subscriber. When the
 * backend rejects an `attachment_add` (and its legacy `import_attachment`
 * fallback also fails), the optimistic chip we inserted in the doc points
 * at no AttachmentRef and no file on disk. This module finds those chips
 * and removes them so the user is never stuck with a "gray ghost" link.
 *
 * The transaction is dispatched with `wikiLink/skipDeleteGuard` meta so
 * the deletion-guard plugin does NOT show the Option C confirmation
 * modal — there is nothing for the user to confirm: the attachment never
 * existed in the first place.
 */

import type { Editor } from '@tiptap/core';

/**
 * Remove every wikilink atom whose `fileName` matches `targetFileName`
 * from the editor's document. Returns the number of nodes removed.
 *
 * Match is case-insensitive on the basename so a chip inserted as
 * `Report.PDF` is still found when the failure event carries `report.pdf`.
 */
export function removeOrphanWikiLinkNodes(
  editor: Editor,
  targetFileName: string,
): number {
  if (editor.isDestroyed) return 0;

  const target = targetFileName.toLowerCase();
  const positions: Array<{ from: number; to: number }> = [];

  editor.state.doc.descendants((node, pos) => {
    if (node.type.name !== 'wikiLink') return;
    const name: string | null = node.attrs?.fileName ?? null;
    if (!name) return;
    if (name.toLowerCase() !== target) return;
    positions.push({ from: pos, to: pos + node.nodeSize });
  });

  if (positions.length === 0) return 0;

  // Apply in reverse so earlier positions stay valid.
  const tr = editor.state.tr;
  for (let i = positions.length - 1; i >= 0; i--) {
    tr.delete(positions[i].from, positions[i].to);
  }
  tr.setMeta('wikiLink/skipDeleteGuard', true);
  editor.view.dispatch(tr);
  return positions.length;
}
