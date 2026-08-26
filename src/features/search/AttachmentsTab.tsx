/**
 * Track B Phase B-3 PART 6 — Attachments tab (HanBin 2026-05-13).
 *
 * Driven by `useAttachmentStore` (the AttachmentRef index). Layout +
 * row styling all inherit from the shared `.search-table` design
 * tokens used by the other Search tabs so the tab feels native.
 *
 * Session 2 adds:
 *   • tier filter pills (image / document / media / data / code / other)
 *   • sync-state filter pills (uploading / stuck / orphan / synced)
 *   • Ctrl/Shift+click multi-select
 *   • right-click context menu via the shared modalActions surface
 *
 * Drag-out from rows lands in session 2.5 (next commit).
 */





import { useAttachmentStore } from '../attachments/stores/attachmentStore';
import { syncV2Commands, type AttachmentRefDto } from '../attachments/attachmentCommands';
import { requestAttachmentDelete } from '../attachments/attachmentDelete';
import { isWeb } from '../../web/files';
import { startAttachmentDrag, startMultiAttachmentDrag } from '../attachments/attachmentDragOut';
import { useMemo, useCallback, useState, useRef, useEffect } from 'react';
import { useVaultPath } from '../../core/stores/fileTreeStore';
import { fileLookupActions } from '../../core/stores/fileLookupStore';
import { hoverActions } from '../hover-windows/stores/hoverStore';
import { useSettingsStore } from '../../core/stores/settingsStore';
import { modalActions } from '../modals/stores/modalStore';
import { utilCommands } from '../../core/services/tauriCommands';
import { getAttachmentCategory } from '../suggestions/attachmentCategory';
import { t } from '../../core/utils/i18n';
import { sortGlyph } from '../../design-system/components';
import { useNoteIdToPath } from './useNoteIdToPath';

/** Extensions that the hover-window viewer system knows how to render
 *  inline. Anything else (e.g. m4a / mp4 / mp3) opens via the OS default
 *  application. Must stay in sync with the same regex in
 *  `useHoverEditorState.ts handleLinkClick` — that's the canonical list,
 *  this is its tab-side mirror. */
const PREVIEWABLE_RE = /\.(md|pdf|png|jpg|jpeg|gif|webp|svg|bmp|ico|json|py|js|ts|jsx|tsx|css|html|xml|yaml|yml|toml|rs|go|java|c|cpp|h|hpp|cs|rb|php|sh|bash|sql|lua|r|swift|kt|scala|csv|doc|docx|ppt|pptx|xls|xlsx|hwp|hwpx)$/i;

interface AttachmentsTabProps {
  /** Optional filter: when set, only show refs linked to this folder. */
  containerPath?: string | null;
  /** Text query forwarded from the parent Search component. */
  query: string;
  /**
   * 2026-05-22 — filter state lifted up to Search.tsx. AttachmentsTab is
   * now presentational with respect to filters: it just receives values
   * and renders rows that match. Chip bar + Add-filter popover live in
   * the parent Search toolbar (unified with Frontmatter/Contents).
   */
  extensionFilter: string;
  notePathFilter: string;
  tierFilter: Set<TierKey>;
  syncFilter: Set<SyncState>;
}

type SyncState = 'synced' | 'uploading' | 'stuck' | 'orphan';
type TierKey = 'image' | 'document' | 'media' | 'data' | 'code' | 'archive' | 'contact' | 'markdown' | 'other';

interface AttachmentRow {
  ref: AttachmentRefDto;
  syncState: SyncState;
  tier: TierKey;
  /** Absolute local path (vault + display_path), normalized to forward slashes. */
  localPath: string;
}

const STUCK_THRESHOLD_MS = 15 * 60 * 1000;

export const TIER_KEYS: TierKey[] = ['image', 'document', 'media', 'data', 'code', 'archive', 'other'];
export const SYNC_KEYS: SyncState[] = ['uploading', 'stuck', 'orphan', 'synced'];
export type { TierKey, SyncState };

// Column sort (Session 3, HanBin 2026-05-13). The default order is "newest
// first" (attachmentId desc), matching what users see when nothing is
// clicked. Click on a header rotates: default-direction → reversed → off
// (back to default). At most one column drives the sort at a time.
type SortColumn = 'name' | 'linked' | 'sync' | 'size' | 'created';
type SortDir = 'asc' | 'desc';
interface SortState { col: SortColumn; dir: SortDir; }
const DEFAULT_SORT: SortState = { col: 'created', dir: 'desc' };
const DEFAULT_DIR: Record<SortColumn, SortDir> = {
  name: 'asc',     // A→Z reads natural
  linked: 'desc',  // most-referenced first
  sync: 'asc',     // problems first (orphan/stuck come before synced)
  size: 'desc',    // biggest first — usually what you want to triage
  created: 'desc', // newest first
};

// Sync-state ordinal for sorting "problems first" when sort dir = asc.
const SYNC_ORDER: Record<SyncState, number> = {
  orphan: 0, stuck: 1, uploading: 2, synced: 3,
};

function parseAttachmentIdMs(id: string): number | null {
  const m = id.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);
  if (!m) return null;
  const [, Y, M, D, h, mn, s] = m;
  const t = Date.UTC(+Y, +M - 1, +D, +h, +mn, +s);
  return Number.isFinite(t) ? t : null;
}

function computeSyncState(ref: AttachmentRefDto): SyncState {
  if (ref.linkedNotes.length === 0) return 'orphan';
  if (ref.syncEtag) return 'synced';
  const created = parseAttachmentIdMs(ref.attachmentId);
  if (created !== null && Date.now() - created > STUCK_THRESHOLD_MS) return 'stuck';
  return 'uploading';
}

function formatSize(bytes: number | undefined | null): string {
  // 🔴 값이 없으면 NaN GB 가 찍힌다 — 화면 가득 NaN 이 뜨는 것을 봤다.
  if (bytes == null || !Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatCreated(attachmentId: string): string {
  const ms = parseAttachmentIdMs(attachmentId);
  if (ms === null) return '—';
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export default function AttachmentsTab({
  containerPath,
  query,
  extensionFilter,
  notePathFilter,
  tierFilter,
  syncFilter,
}: AttachmentsTabProps) {
  const language = useSettingsStore((s) => s.language);
  const vaultPath = useVaultPath();
  const byId = useAttachmentStore((s) => s.index.byId);

  // 2026-05-23 (HanBin) — CRITICAL FIX. The user observed that sketch/canvas
  // notes containing file nodes (e.g. dddsaa.md with HWP / XLSX / PDF
  // refs) showed "첨부파일 없음" when filtered by the note in this tab,
  // even though the same attachments appeared in the graph view.
  //
  // Root cause: `AttachmentRef.linked_notes` is the authoritative source
  // for "which note links this attachment", and reconcile is the only
  // process that populates it from sketch refs. Reconcile auto-runs in
  // sync_engine.rs:297 at vault open (after a 2s delay), but:
  //   1. It can race with the user opening AttachmentsTab in the first
  //      few seconds after vault open.
  //   2. If the user edits/adds a sketch DURING the session, the new
  //      sketch refs aren't reflected until the next vault open.
  //   3. Bulk-delete-orphans was the only other trigger, and it requires
  //      the user to click into the bulk-delete flow.
  //
  // Fix: every time the tab mounts in a fresh vault session, trigger a
  // reconcile + apply pass, then re-hydrate the store. Idempotent
  // (reconcile compares chip-vs-ref state and only changes what needs
  // to change). One-shot per vault per session via the module-level
  // set above so tab re-mounts during the session don't re-pay the cost.
  const refreshStore = useAttachmentStore((s) => s.refresh);

  // 2026-05-24 (HanBin) — silent self-healing. The user should NEVER
  // need to push a "re-verify" button. Reconcile runs invisibly:
  //   1. Once per vault session on mount (catches stale state from
  //      vault open).
  //   2. Again whenever the note-path filter changes — the user is
  //      actively inspecting a specific note, so a fresh scan ensures
  //      the displayed list reflects current ref state. Debounced
  //      300ms so a fast-typing user doesn't trigger N scans.
  //   3. Implicitly via the `attachment:saved` / `attachment:deleted`
  //      EventBus → useAttachmentStore.refresh() (already wired in the
  //      store layer; no work needed here).
  // No user-facing button. If a finding can't be auto-resolved, that's
  // the failure surface — not "click here to retry".
  const lastReconcileForVaultRef = useRef<string | null>(null);
  const runReconcileSilent = useCallback(async () => {
    if (!vaultPath) return;
    try {
      const report = await syncV2Commands.attachmentReconcile();
      const needsApply =
        report.missingRefLinks.length > 0 || report.staleRefLinks.length > 0;
      if (needsApply) {
        const filtered = { ...report, dummyChips: [] };
        await syncV2Commands.attachmentReconcileApply(filtered);
        await refreshStore();
      }
    } catch (err) {
      console.error('[AttachmentsTab] silent reconcile failed:', err);
    }
  }, [vaultPath, refreshStore]);

  // Mount + vault change → reconcile once.
  useEffect(() => {
    if (!vaultPath) return;
    if (lastReconcileForVaultRef.current === vaultPath) return;
    lastReconcileForVaultRef.current = vaultPath;
    runReconcileSilent();
  }, [vaultPath, runReconcileSilent]);

  // Filter change → debounced silent reconcile so the list reflects
  // current state for the inspected note. 300ms is short enough to feel
  // instant when the user clicks a filter chip, long enough to coalesce
  // fast successive changes (e.g. typing a path).
  useEffect(() => {
    if (!vaultPath || !notePathFilter) return;
    const id = setTimeout(() => { runReconcileSilent(); }, 300);
    return () => clearTimeout(id);
  }, [notePathFilter, vaultPath, runReconcileSilent]);

  // 2026-05-25 (HanBin) — UNIFIED note-id resolution. Extracted to
  // `useNoteIdToPath` hook so Search.tsx can consume the same map
  // (needed by `attachmentExtensionPool` container-scope filter).
  // See the hook for full rationale; the short version:
  // `noteIdIndex` Tauri call returns the full
  // `note_id_lowercase → vault_relative_path` map using the same
  // resolution rule as `apply.rs` and `get_graph_data`.
  const noteIdToPath = useNoteIdToPath();

  // ── Filter state ─────────────────────────────────────────────────────────
  // tier + sync filters lifted up to Search.tsx as of 2026-05-22 — they
  // now flow in via props and live in the chip filter bar above. Only
  // the column sort state remains local because nothing outside this
  // tab needs it.
  const [sort, setSort] = useState<SortState>(DEFAULT_SORT);

  const toggleSort = useCallback((col: SortColumn) => {
    setSort((prev) => {
      if (prev.col !== col) return { col, dir: DEFAULT_DIR[col] };
      const flipped: SortDir = prev.dir === DEFAULT_DIR[col] ? (prev.dir === 'asc' ? 'desc' : 'asc') : DEFAULT_DIR[col];
      if (flipped === DEFAULT_DIR[col] && col !== DEFAULT_SORT.col) {
        return DEFAULT_SORT;
      }
      return { col, dir: flipped };
    });
  }, []);

  const rows: AttachmentRow[] = useMemo(() => {
    const out: AttachmentRow[] = [];
    const q = query.trim().toLowerCase();
    const extQ = extensionFilter.trim().toLowerCase().replace(/^\./, '');
    const noteQ = notePathFilter.trim().toLowerCase();

    // 2026-05-24 (HanBin) — container-scope filter. The Frontmatter /
    // Contents tabs compare two ABSOLUTE paths (their row.path AND
    // containerPath are both absolute), so a plain `startsWith` works.
    // AttachmentsTab is different: `noteIdToPath` and
    // `fileLookupActions.resolveNotePath` both return **vault-relative**
    // paths (e.g. `dd/ddddd.md`). So the comparison key has to also be
    // vault-relative. We normalize containerPath to a vault-relative
    // prefix by stripping the vaultPath when it's an absolute path; a
    // first-cut fix forgot this and turned the whole tab empty.
    let cpNorm = (containerPath ?? '')
      .toLowerCase()
      .replace(/\\/g, '/')
      .replace(/^\/+/, '')
      .replace(/\/+$/, '');
    if (cpNorm && vaultPath) {
      const vpNorm = vaultPath
        .toLowerCase()
        .replace(/\\/g, '/')
        .replace(/^\/+/, '')
        .replace(/\/+$/, '');
      if (vpNorm && cpNorm === vpNorm) {
        cpNorm = '';                              // vault root selected → no scope filter
      } else if (vpNorm && cpNorm.startsWith(vpNorm + '/')) {
        cpNorm = cpNorm.slice(vpNorm.length + 1); // strip vault prefix → vault-relative
      }
      // else: containerPath was already vault-relative (defensive — keep as-is).
    }

    for (const ref of byId.values()) {
      if (cpNorm) {
        let inContainer = false;
        for (const noteId of ref.linkedNotes) {
          const idLower = noteId.toLowerCase();
          let path = noteIdToPath.get(idLower);
          if (!path) path = fileLookupActions.resolveNotePath(noteId) ?? undefined;
          if (!path) continue;
          const pLower = path.toLowerCase().replace(/\\/g, '/').replace(/^\/+/, '');
          if (pLower === cpNorm || pLower.startsWith(cpNorm + '/')) {
            inContainer = true;
            break;
          }
        }
        if (!inContainer) continue;
      }

      if (q) {
        const dispBase = (ref.displayPath.split('/').pop() ?? '').toLowerCase();
        if (
          !ref.originalName.toLowerCase().includes(q)
          && !dispBase.includes(q)
        ) continue;
      }

      // 2026-05-22 — file extension filter. Empty input = pass.
      if (extQ) {
        const ext = ref.originalName.split('.').pop()?.toLowerCase() ?? '';
        if (ext !== extQ) continue;
      }
      // 2026-05-22 — note path filter. Four lookup paths in order:
      //   1. `noteId` itself (catches stem-style IDs from pre-migration
      //      vaults, e.g. "dddsaa").
      //   2. **Stem-only fallback (HanBin 2026-05-24)**: if noteQ is a
      //      `.md` path like "dd/dddsaa.md", extract the stem ("dddsaa")
      //      and compare against noteId directly. Fixes the case where
      //      the apply path stored note_id as a stem (no frontmatter id)
      //      but the filter input was a full vault-relative path → no
      //      previous match path resolved this correctly.
      //   3. `noteIdToPath` reverse cache built from contentCacheStore
      //      (catches timestamp IDs from migrated vaults, e.g.
      //      "20260516183000" → "dd/note.md").
      //   4. `fileLookupActions.resolveNotePath(noteId)` final fallback.
      if (noteQ) {
        // Compute the stem of the query ONCE (e.g. "dd/dddsaa.md" → "dddsaa").
        const noteQBasename = noteQ.split(/[\\/]/).pop() ?? noteQ;
        const noteQStem = noteQBasename.replace(/\.md$/i, '');

        let hit = false;
        for (const noteId of ref.linkedNotes) {
          const idLower = noteId.toLowerCase();
          // 1. Raw id substring (legacy path-style ids).
          if (idLower.includes(noteQ)) { hit = true; break; }
          // 2. Stem fallback — handles the case where apply.rs stored
          //    note_id as a filename stem (most sketches without
          //    frontmatter `id:` end up here).
          if (idLower === noteQStem.toLowerCase()) { hit = true; break; }
          // 3. + 4. Path resolution via metadata cache or file lookup.
          let path = noteIdToPath.get(idLower);
          if (!path) path = fileLookupActions.resolveNotePath(noteId) ?? undefined;
          if (path && path.toLowerCase().replace(/\\/g, '/').includes(noteQ)) {
            hit = true; break;
          }
        }
        if (!hit) continue;
      }
      const tier = getAttachmentCategory(ref.originalName) as TierKey;
      const syncState = computeSyncState(ref);
      if (tierFilter.size > 0 && !tierFilter.has(tier)) continue;
      if (syncFilter.size > 0 && !syncFilter.has(syncState)) continue;

      const localPath = vaultPath
        ? (vaultPath + '/' + ref.displayPath).replace(/\\/g, '/')
        : ref.displayPath;

      out.push({ ref, syncState, tier, localPath });
    }

    const cmpStr = (x: string, y: string) => x.localeCompare(y, undefined, { numeric: true, sensitivity: 'base' });
    const sign = sort.dir === 'asc' ? 1 : -1;
    out.sort((a, b) => {
      let d = 0;
      switch (sort.col) {
        case 'name':
          d = cmpStr(a.ref.originalName, b.ref.originalName);
          break;
        case 'linked':
          d = a.ref.linkedNotes.length - b.ref.linkedNotes.length;
          break;
        case 'sync':
          d = SYNC_ORDER[a.syncState] - SYNC_ORDER[b.syncState];
          break;
        case 'size':
          d = a.ref.sizeBytes - b.ref.sizeBytes;
          break;
        case 'created':
        default:
          // attachmentId is timestamp-based so string compare = chronological
          d = cmpStr(a.ref.attachmentId, b.ref.attachmentId);
          break;
      }
      // Stable tiebreaker by attachmentId desc (newest first), so equal-key
      // rows don't jump around between renders.
      if (d === 0) return b.ref.attachmentId.localeCompare(a.ref.attachmentId);
      return sign * d;
    });
    return out;
  }, [byId, query, vaultPath, containerPath, tierFilter, syncFilter, sort, extensionFilter, notePathFilter, noteIdToPath]);

  // ── Multi-select (HanBin 2026-05-13) ─────────────────────────────────────
  // Mirrors the Frontmatter tab's Ctrl/Shift+click pattern. Plain click on
  // a row opens its preview (current behavior); modifier clicks toggle
  // selection. The lastSelected ref stores the anchor row for Shift+click
  // range selection.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const lastSelectedRef = useRef<string | null>(null);

  // 2026-05-22 — Excel-style row selection. Plain click sets single,
  // Ctrl+click toggles, Shift+click ranges. Double-click opens (was
  // plain click). No selection-mode toggle, no checkbox column —
  // matches the Frontmatter tab UX.
  const handleRowClick = useCallback((row: AttachmentRow, e: React.MouseEvent) => {
    const id = row.ref.attachmentId;
    if (e.shiftKey && lastSelectedRef.current) {
      const idx1 = rows.findIndex((r) => r.ref.attachmentId === lastSelectedRef.current);
      const idx2 = rows.findIndex((r) => r.ref.attachmentId === id);
      if (idx1 >= 0 && idx2 >= 0) {
        const [lo, hi] = idx1 < idx2 ? [idx1, idx2] : [idx2, idx1];
        const next = new Set(selectedIds);
        for (let i = lo; i <= hi; i++) next.add(rows[i].ref.attachmentId);
        setSelectedIds(next);
        return;
      }
    }
    if (e.ctrlKey || e.metaKey) {
      const next = new Set(selectedIds);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      setSelectedIds(next);
      lastSelectedRef.current = id;
      return;
    }
    // 🔴 **그냥 누르면 고르지 않는다** (사용자 요청, 2026-08-11:
    //    *"일반 한번 클릭으로 선택된 첨부, 일괄삭제 트리거가 되지 않도록"*).
    //    첫 클릭이 곧 선택이면 스치기만 해도 **일괄 삭제 버튼이 켜진다** —
    //    지우는 일이 실수로 시작되면 안 된다. 고르는 것은 Ctrl(⌘)이나
    //    Shift 로만 한다. 그냥 클릭은 자리만 옮기고, 여는 것은 더블클릭이다.
    lastSelectedRef.current = id;
    if (selectedIds.size > 0) setSelectedIds(new Set());   // 누르면 선택 해제
  }, [rows, selectedIds]);

  const handleRowDoubleClick = useCallback((row: AttachmentRow) => {
    if (!row.localPath) return;
    // Same routing as the editor's wikilink click handler — previewable
    // formats open in a hover viewer; everything else hands off to the
    // OS default app.
    if (PREVIEWABLE_RE.test(row.localPath)) {
      void hoverActions.open(row.localPath);
    } else {
      void utilCommands.openInDefaultApp(row.localPath).catch((err) => {
        console.error('[AttachmentsTab] openInDefaultApp failed:', err);
      });
    }
  }, []);

  const clearAllSelection = useCallback(() => {
    setSelectedIds(new Set());
    lastSelectedRef.current = null;
  }, []);

  // Esc clears selection — same as the editor's wikilink selection plugin.
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape' && selectedIds.size > 0) {
      setSelectedIds(new Set());
    }
  }, [selectedIds]);

  const handleRetryStuck = useCallback((row: AttachmentRow, e: React.MouseEvent) => {
    e.stopPropagation();
    void syncV2Commands.attachmentRetry(row.ref.attachmentId).catch((err) => {
      console.error('[AttachmentsTab] retry failed:', err);
    });
  }, []);

  const handleDeleteOrphan = useCallback((row: AttachmentRow, e: React.MouseEvent) => {
    e.stopPropagation();
    void syncV2Commands.attachmentDelete(row.ref.attachmentId).catch((err) => {
      console.error('[AttachmentsTab] orphan delete failed:', err);
    });
  }, []);

  // ── Drag-out (Session 2.5, HanBin 2026-05-13) ─────────────────────────────
  // Same native OS drag-out infrastructure the editor chips use: route
  // through `attachmentDragOut.ts` → `tauri-plugin-drag`. Two paths:
  //   • dragstart on a row inside the current selection (size > 1)
  //     → drag every selected ref at once (`startMultiAttachmentDrag`)
  //   • dragstart anywhere else → single ref drag for that row
  // The row itself carries `draggable={true}`; preventDefault on dragstart
  // is required so the browser doesn't fall back to its own text-drag
  // payload (which WebView2 can't promote to a file promise — confirmed
  // in PART 5 POC).
  const handleRowDragStart = useCallback((row: AttachmentRow, e: React.DragEvent) => {
    // 🔴 웹에서는 preventDefault 를 하면 안 된다 (2026-08-26). DownloadURL
    //    드래그는 **브라우저의 기본 드래그**에 실어 보내는 것이라, 막으면
    //    startAttachmentDrag 안의 웹 갈래가 영영 죽은 코드가 된다 — 실제로
    //    그 상태였다 (지어 놓고 안 부른 세 번째 사례).
    if (isWeb()) {
      e.stopPropagation();
      // 브라우저 드래그는 한 번에 한 파일이다 — 여러 개는 차례로 끌거나
      // 내려받기를 쓴다 (DownloadURL 규격의 한계).
      void startAttachmentDrag(row.ref.originalName, row.ref.linkedNotes[0],
                               e.nativeEvent as DragEvent);
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'none';

    const id = row.ref.attachmentId;
    if (selectedIds.size > 1 && selectedIds.has(id)) {
      // Multi-drag: every currently selected ref.
      const refs = rows.filter((r) => selectedIds.has(r.ref.attachmentId)).map((r) => r.ref);
      void startMultiAttachmentDrag(refs).catch((err) => {
        console.error('[AttachmentsTab] multi drag-out failed:', err);
      });
      return;
    }
    // Single-row drag — pass the first linked note (if any) so the
    // attachment store's resolver can disambiguate name collisions.
    const noteId = row.ref.linkedNotes[0];
    void startAttachmentDrag(row.ref.originalName, noteId).catch((err) => {
      console.error('[AttachmentsTab] drag-out failed:', err);
    });
  }, [rows, selectedIds]);

  // ── Right-click context menu ──────────────────────────────────────────────
  // Reuses the shared ContextMenu surface so the menu items + styling
  // match what the editor chip already shows. The deleteCallback routes
  // through Option C semantics when there's a real linked note, and
  // straight to hard-delete for orphan refs (no wikilink to clean up).
  const handleRowContextMenu = useCallback((row: AttachmentRow, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // If user right-clicks a row outside the current selection, treat as
    // a one-off action on that row (matches OS file-manager convention).
    if (!selectedIds.has(row.ref.attachmentId)) {
      setSelectedIds(new Set());
      lastSelectedRef.current = row.ref.attachmentId;
    }

    const firstLinkedNote = row.ref.linkedNotes[0];
    const deleteCallback = () => {
      if (row.syncState === 'orphan' || !firstLinkedNote) {
        // Orphan or no linked note: skip Option C modal — there's nothing
        // to unlink; the user clicked Delete on an already-broken entry.
        void syncV2Commands.attachmentDelete(row.ref.attachmentId).catch((err) => {
          console.error('[AttachmentsTab] orphan ctx-menu delete failed:', err);
        });
        return;
      }
      void requestAttachmentDelete({
        attachmentId: row.ref.attachmentId,
        originalName: row.ref.originalName,
        noteId: firstLinkedNote,
      });
    };

    modalActions.showContextMenu(
      row.ref.originalName,
      { x: e.clientX, y: e.clientY },
      firstLinkedNote ?? '',
      row.localPath,
      false, // isFolder
      true,  // fromSearch
      deleteCallback,
      false, // hideDelete
      true,  // isAttachment
    );
  }, [selectedIds]);

  // 2026-05-20 — orphan files visible under the current filter set.
  // Used by the bulk-delete-orphans action button in selection-mode +
  // the count badge in the filter panel.
  const orphanRowsInView = useMemo(
    () => rows.filter(r => r.ref.linkedNotes.length === 0),
    [rows],
  );

  // 2026-05-20 — bulk delete of currently-selected attachments.
  // Goes through the same `attachmentUnlinkOrDelete` path the per-row
  // context menu uses, but without the per-row confirmation modal —
  // the user already opted in by selecting + clicking the action.
  const handleBulkDeleteSelected = useCallback(() => {
    if (selectedIds.size === 0) return;
    const targets = Array.from(selectedIds);
    modalActions.showConfirmDelete(
      t('selectedAttachments', language),
      'file',
      async () => {
        for (const id of targets) {
          try {
            await syncV2Commands.attachmentDelete(id);
          } catch (err) {
            console.error('[AttachmentsTab] bulk delete failed for', id, err);
          }
        }
        setSelectedIds(new Set());
      },
      targets.length,
    );
  }, [selectedIds, language]);

  // 2026-05-20 — delete every orphan visible under the current filter
  // set. Replaces the legacy "더미 파일 일괄 삭제" path.
  //
  // R6 (HanBin 2026-05-22) — run reconcile-apply BEFORE the sweep so
  // sketch/canvas node refs get added to `linked_notes`. Without this,
  // an attachment referenced only by a sketch is misclassified as orphan
  // and gets hard-deleted, leaving a broken node on the canvas.
  const handleBulkDeleteOrphans = useCallback(() => {
    if (orphanRowsInView.length === 0) return;
    const candidateIds = new Set(orphanRowsInView.map(r => r.ref.attachmentId));
    modalActions.showConfirmDelete(
      t('orphanFile', language),
      'file',
      async () => {
        // Reconcile first so sketch/canvas node refs populate linked_notes.
        // Without this, an attachment referenced only by a sketch node is
        // misclassified as orphan and gets hard-deleted.
        try {
          const report = await syncV2Commands.attachmentReconcile();
          if (report.missingRefLinks.length > 0 || report.staleRefLinks.length > 0 || report.dummyChips.length > 0) {
            await syncV2Commands.attachmentReconcileApply(report);
          }
        } catch (err) {
          console.error('[AttachmentsTab] reconcile-before-sweep failed:', err);
        }
        // Re-fetch authoritative state and delete only ids that are STILL
        // orphan after reconcile. Anything picked up as referenced by a
        // sketch node (or any newly-discovered chip) is now spared.
        let confirmedOrphans: string[] = [...candidateIds];
        try {
          const fresh = await syncV2Commands.attachmentListAll();
          confirmedOrphans = fresh
            .filter(r => candidateIds.has(r.attachmentId) && r.linkedNotes.length === 0)
            .map(r => r.attachmentId);
        } catch (err) {
          console.error('[AttachmentsTab] refresh-before-sweep failed:', err);
        }
        for (const id of confirmedOrphans) {
          try {
            await syncV2Commands.attachmentDelete(id);
          } catch (err) {
            console.error('[AttachmentsTab] bulk orphan delete failed for', id, err);
          }
        }
        setSelectedIds(new Set());
      },
      candidateIds.size,
    );
  }, [orphanRowsInView, language]);

  return (
    <div
      className="attachments-tab-v2-root"
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      onClick={(e) => {
        // Click outside any row clears selection + shift anchor.
        // Matches the Frontmatter tab's empty-area behavior.
        if (!(e.target as HTMLElement).closest('tr')) {
          clearAllSelection();
        }
      }}
    >
      {/* 2026-05-22 — text/orphan filter panel removed. Filters are now
          chip-style and rendered by the parent Search toolbar
          (`FilterAddButton` + `FilterChipList`) to keep all three tabs
          consistent. Bulk-orphan button moves up to the bulk-action bar. */}
      {/* Bulk action bar — shows whenever any row is selected, regardless
          of how the user got there (single click, Ctrl+click, Shift-range
          via row clicks). Includes Delete Selected + Delete Orphans
          (visible only when orphans are in current view). */}
      {(selectedIds.size > 0 || orphanRowsInView.length > 0) && (
        <div className="attachments-tab-v2-bulk-bar">
          {selectedIds.size > 0 && (
            <>
              <span className="attachments-tab-v2-bulk-count">
                {t('selectedAttachments', language)}: {selectedIds.size}
              </span>
              <button
                type="button"
                className="attachments-tab-v2-bulk-delete-btn"
                onClick={handleBulkDeleteSelected}
              >
                {t('batchDelete', language)}
              </button>
            </>
          )}
          {orphanRowsInView.length > 0 && (
            <button
              type="button"
              className="attachments-tab-v2-bulk-orphan-btn"
              onClick={handleBulkDeleteOrphans}
            >
              {t('batchDeleteOrphans', language)} ({orphanRowsInView.length})
            </button>
          )}
        </div>
      )}
      <table className="search-table attachments-tab-v2-table">
        <colgroup>
          <col />
          <col style={{ width: 56 }} />
          <col style={{ width: 110 }} />
          <col style={{ width: 80 }} />
          <col style={{ width: 96 }} />
        </colgroup>
        <thead>
          <tr>
            <SortableHeader col="name"    sort={sort} onToggle={toggleSort} label={t('fileName', language)} />
            <SortableHeader col="linked"  sort={sort} onToggle={toggleSort} label={t('attachmentLinkedNotesShort', language)} />
            {/* 🔴 동기화 열 제거 (2026-08-26 사용자: "첨부 탭에 동기화
                열은 대체 왜 있나?") — Synology 데스크톱 잔재. 웹은 서버가
                원본이라 «동기화 상태» 라는 개념 자체가 없다. */}
            <SortableHeader col="size"    sort={sort} onToggle={toggleSort} label={t('attachmentSize', language)} />
            <SortableHeader col="created" sort={sort} onToggle={toggleSort} label={t('attachmentCreatedShort', language)} />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <AttachmentRow
              key={row.ref.attachmentId}
              row={row}
              language={language}
              selected={selectedIds.has(row.ref.attachmentId)}
              onClick={handleRowClick}
              onDoubleClick={handleRowDoubleClick}
              onContextMenu={handleRowContextMenu}
              onDragStart={handleRowDragStart}
              onRetry={handleRetryStuck}
              onDeleteOrphan={handleDeleteOrphan}
            />
          ))}
          {rows.length === 0 && (
            <tr>
              <td className="search-td search-empty" colSpan={4}>
                {t('noAttachments', language)}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

interface RowProps {
  row: AttachmentRow;
  language: ReturnType<typeof useSettingsStore.getState>['language'];
  selected: boolean;
  onClick: (row: AttachmentRow, e: React.MouseEvent) => void;
  onDoubleClick: (row: AttachmentRow) => void;
  onContextMenu: (row: AttachmentRow, e: React.MouseEvent) => void;
  onDragStart: (row: AttachmentRow, e: React.DragEvent) => void;
  onRetry: (row: AttachmentRow, e: React.MouseEvent) => void;
  onDeleteOrphan: (row: AttachmentRow, e: React.MouseEvent) => void;
}

function AttachmentRow({
  row,
  language,
  selected,
  onClick,
  onDoubleClick,
  onContextMenu,
  onDragStart,
  onRetry,
  onDeleteOrphan,
}: RowProps) {
  const { ref, syncState, tier } = row;

  return (
    <tr
      className={`search-row att-row-${tier}${selected ? ' selected multi-selected' : ''}`}
      onClick={(e) => onClick(row, e)}
      onDoubleClick={() => onDoubleClick(row)}
      onContextMenu={(e) => onContextMenu(row, e)}
      draggable
      onDragStart={(e) => onDragStart(row, e)}
    >
      <td className="search-td search-title">{ref.originalName}</td>
      <td className="search-td">
        {ref.linkedNotes.length === 0
          ? <span className="attachments-tab-v2-muted">—</span>
          : <span>{ref.linkedNotes.length}</span>}
      </td>
      <td className="search-td">{formatSize(ref.sizeBytes)}</td>
      <td className="search-td">{formatCreated(ref.attachmentId)}</td>
    </tr>
  );
}

function SortableHeader({
  col,
  sort,
  onToggle,
  label,
}: {
  col: SortColumn;
  sort: SortState;
  onToggle: (c: SortColumn) => void;
  label: string;
}) {
  const active = sort.col === col;
  // 2026-05-22 — uses the shared `sortGlyph` helper so both this table
  // and the Frontmatter grid stay in lock-step on the glyph choice.
  // Was inline `▲/▼` then inline `↑/↓` — now there's exactly one
  // place to change the glyph (`src/design-system/glyphs.ts`).
  const arrow = sortGlyph(active, sort.dir);
  return (
    <th
      className={`search-th attachments-tab-v2-th-sort${active ? ' active' : ''}`}
      onClick={() => onToggle(col)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(col); } }}
    >
      <span>{label}</span>
      {active && <span className="attachments-tab-v2-sort-arrow">{arrow}</span>}
    </th>
  );
}

function SyncStateBadge({
  state,
  language,
}: {
  state: SyncState;
  language: ReturnType<typeof useSettingsStore.getState>['language'];
}) {
  const label =
    state === 'synced' ? t('attachmentSynced', language)
    : state === 'uploading' ? t('attachmentUploading', language)
    : state === 'stuck' ? t('attachmentStuck', language)
    : t('attachmentOrphan', language);
  return (
    <span className={`attachments-tab-v2-badge attachments-tab-v2-badge-${state}`}>
      {label}
    </span>
  );
}
