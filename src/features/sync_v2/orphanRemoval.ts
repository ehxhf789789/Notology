/**
 * Track B Phase B-3 PART 6 — orphan wikilink removal helpers.
 *
 * Used by the editor's `attachment:addFailed` subscriber and on-mount scan.
 * When the backend rejects an `attachment_add` (and its legacy
 * `import_attachment` fallback also fails), the optimistic chip we
 * inserted in the doc points at no AttachmentRef and no file on disk.
 * This module finds those chips and removes them so the user is never
 * stuck with a "gray ghost" link.
 *
 * Removal transactions are tagged with `wikiLink/skipDeleteGuard` so
 * Option C's confirmation modal does NOT fire — there is nothing for the
 * user to confirm: the attachment never existed in the first place.
 *
 * Persistent failure registry (HanBin 2026-05-13): the EventBus event is
 * fire-and-forget; if the editor that needs to receive it is mid-remount
 * (HMR, navigation, fresh window open), the event is missed and the chip
 * survives. To close that race, useDragDrop also writes failed adds to
 * localStorage with a short TTL. Editor mount scans the registry and
 * applies any pending removals.
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

// ── Persistent failed-add registry ───────────────────────────────────────
//
// Stored shape: `{ [notePathLowercase]: Array<{ name: string, ts: number }> }`
// where `ts` is `Date.now()`. Entries older than FAILED_TTL_MS are pruned on
// read. The TTL is short on purpose: longer than a typical HMR cycle (<3 s)
// but shorter than a user reasonably re-navigating to the note (>30 s would
// surprise them with auto-removal of a chip they don't know failed).

const FAILED_KEY = 'notology.attachment.failed_adds';
const FAILED_TTL_MS = 30 * 1000;

type FailedEntry = { name: string; ts: number };
type FailedMap = Record<string, FailedEntry[]>;

function readFailedMap(): FailedMap {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(FAILED_KEY) : null;
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? (parsed as FailedMap) : {};
  } catch {
    return {};
  }
}

function writeFailedMap(map: FailedMap) {
  try {
    if (typeof localStorage === 'undefined') return;
    // Empty out: drop the key entirely so we don't accumulate garbage.
    const hasAny = Object.keys(map).some((k) => map[k].length > 0);
    if (!hasAny) {
      localStorage.removeItem(FAILED_KEY);
      return;
    }
    localStorage.setItem(FAILED_KEY, JSON.stringify(map));
  } catch {
    /* localStorage quota / private mode — best effort */
  }
}

function normalizeNotePath(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase();
}

/** Record a failed add. Called by `useDragDrop` when both backends reject. */
export function addPersistentFailedAdd(notePath: string, fileName: string) {
  const key = normalizeNotePath(notePath);
  const map = readFailedMap();
  const list = map[key] ?? [];
  list.push({ name: fileName, ts: Date.now() });
  map[key] = list;
  writeFailedMap(map);
}

/**
 * Consume the persistent failure list for `notePath`. Returns every basename
 * that has not yet expired, and clears matching entries from storage so the
 * scan is idempotent across multiple editor mounts.
 */
export function consumeFailedAdds(notePath: string): string[] {
  const key = normalizeNotePath(notePath);
  const map = readFailedMap();
  const list = map[key];
  if (!list || list.length === 0) return [];
  const cutoff = Date.now() - FAILED_TTL_MS;
  const fresh = list.filter((e) => e.ts >= cutoff);
  // Clear regardless of staleness — caller acts on `fresh`, stale entries
  // are dropped silently.
  delete map[key];
  writeFailedMap(map);
  return fresh.map((e) => e.name);
}
