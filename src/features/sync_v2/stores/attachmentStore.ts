/**
 * AttachmentStore — frontend mirror of the backend AttachmentRef index.
 *
 * Single-surface principle (track_b_attachment_design.md §13):
 *   - The wikilink chip is the only user-facing attachment surface.
 *   - `.attachments/` folder is hidden in the file tree.
 *   - Wikilink resolver consults THIS store first to render chips with the
 *     correct color (resolved vs. unresolved) and to power the redesigned
 *     Attachments tab without `_att/` folder scanning.
 *
 * Lifecycle:
 *   - Hydrate on vault open via `attachment_list_all`.
 *   - Update incrementally on EventBus `attachment:saved` / `attachment:deleted`
 *     by re-fetching the same command (cheap — N small JSONs).
 *   - Clear on `vault:closed`.
 */

import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import { syncV2Commands, type AttachmentRefDto } from '../syncV2Commands';
import { EventBus } from '../../../core/infrastructure/eventBus';
import { useFileTreeStore } from '../../../core/stores/fileTreeStore';

interface AttachmentIndex {
  /** id → ref */
  byId: Map<string, AttachmentRefDto>;
  /** lowercased original_name → ids (collisions yield multiple) */
  byName: Map<string, string[]>;
  /** lowercased display path basename → ids */
  byDisplayBasename: Map<string, string[]>;
  /** lowercased note_id → set of attachment ids linked to that note */
  byNoteId: Map<string, Set<string>>;
}

interface AttachmentState {
  index: AttachmentIndex;
  hydrated: boolean;
  hydratedAt: number;
  loading: boolean;
  error: string | null;

  /**
   * Lowercased file basenames currently in flight for `attachment_add`.
   * Used by WikiLink to paint a chip's amber "processing" state from the
   * moment of drop, instead of waiting for the AttachmentRef to land in the
   * store. Bridges the visual gap during sha256 + CAS write (~30 s for a
   * 600 MB file).
   */
  pendingNames: Set<string>;

  hydrate: () => Promise<void>;
  refresh: () => Promise<void>;
  clear: () => void;

  /** Mark a basename as being processed; safe to call repeatedly. */
  markPending: (fileName: string) => void;
  unmarkPending: (fileName: string) => void;
  isPending: (fileName: string) => boolean;

  /** Sync lookups (read-side hot path) */
  resolveByName: (fileName: string, noteId?: string) => AttachmentRefDto | null;
  listForNote: (noteId: string) => AttachmentRefDto[];
  all: () => AttachmentRefDto[];
}

function emptyIndex(): AttachmentIndex {
  return {
    byId: new Map(),
    byName: new Map(),
    byDisplayBasename: new Map(),
    byNoteId: new Map(),
  };
}

function buildIndex(refs: AttachmentRefDto[]): AttachmentIndex {
  const idx = emptyIndex();
  for (const r of refs) {
    idx.byId.set(r.attachmentId, r);

    const nameKey = r.originalName.toLowerCase();
    const nameList = idx.byName.get(nameKey) ?? [];
    nameList.push(r.attachmentId);
    idx.byName.set(nameKey, nameList);

    const displayBase = r.displayPath.split('/').pop()?.toLowerCase() ?? '';
    if (displayBase && displayBase !== nameKey) {
      const dispList = idx.byDisplayBasename.get(displayBase) ?? [];
      dispList.push(r.attachmentId);
      idx.byDisplayBasename.set(displayBase, dispList);
    } else if (displayBase) {
      // Same as originalName — both maps point at the same list. Skip dup add.
    }

    for (const noteId of r.linkedNotes) {
      const key = noteId.toLowerCase();
      const set = idx.byNoteId.get(key) ?? new Set();
      set.add(r.attachmentId);
      idx.byNoteId.set(key, set);
    }
  }
  return idx;
}

export const useAttachmentStore = create<AttachmentState>()(
  subscribeWithSelector((set, get) => ({
    index: emptyIndex(),
    hydrated: false,
    hydratedAt: 0,
    loading: false,
    error: null,
    pendingNames: new Set<string>(),

    markPending(fileName) {
      const key = fileName.toLowerCase();
      set((s) => {
        if (s.pendingNames.has(key)) return s;
        const next = new Set(s.pendingNames);
        next.add(key);
        return { ...s, pendingNames: next };
      });
    },

    unmarkPending(fileName) {
      const key = fileName.toLowerCase();
      set((s) => {
        if (!s.pendingNames.has(key)) return s;
        const next = new Set(s.pendingNames);
        next.delete(key);
        return { ...s, pendingNames: next };
      });
    },

    isPending(fileName) {
      return get().pendingNames.has(fileName.toLowerCase());
    },

    async hydrate() {
      if (get().loading) return;
      set({ loading: true, error: null });
      try {
        const refs = await syncV2Commands.attachmentListAll();
        set({
          index: buildIndex(refs),
          hydrated: true,
          hydratedAt: Date.now(),
          loading: false,
        });
        console.log(`[attachmentStore] hydrated ${refs.length} refs`);
        maybeStartUploadPolling();
      } catch (err) {
        set({ loading: false, error: String(err) });
        console.error('[attachmentStore] hydrate failed:', err);
      }
    },

    async refresh() {
      // refresh = hydrate without the early-return guard, used by event handlers.
      set({ loading: true, error: null });
      try {
        const refs = await syncV2Commands.attachmentListAll();
        set({
          index: buildIndex(refs),
          hydrated: true,
          hydratedAt: Date.now(),
          loading: false,
        });
        console.log(`[attachmentStore] refreshed → ${refs.length} refs`);
        maybeStartUploadPolling();
      } catch (err) {
        set({ loading: false, error: String(err) });
        console.warn('[attachmentStore] refresh failed:', err);
      }
    },

    clear() {
      set({ index: emptyIndex(), hydrated: false, hydratedAt: 0, error: null });
    },

    resolveByName(fileName, noteId) {
      const { index } = get();
      const key = fileName.toLowerCase();
      // Prefer name match; fall back to display basename (covers collision
      // suffixes like `Report_1.pdf` when a note body still has the original).
      const ids = index.byName.get(key) ?? index.byDisplayBasename.get(key);
      if (!ids || ids.length === 0) return null;
      if (ids.length === 1 || !noteId) {
        return index.byId.get(ids[0]) ?? null;
      }
      // Multiple candidates → prefer one linked to this note.
      const noteKey = noteId.toLowerCase();
      for (const id of ids) {
        const r = index.byId.get(id);
        if (r && r.linkedNotes.some((n) => n.toLowerCase() === noteKey)) {
          return r;
        }
      }
      return index.byId.get(ids[0]) ?? null;
    },

    listForNote(noteId) {
      const { index } = get();
      const ids = index.byNoteId.get(noteId.toLowerCase());
      if (!ids) return [];
      const out: AttachmentRefDto[] = [];
      for (const id of ids) {
        const r = index.byId.get(id);
        if (r) out.push(r);
      }
      return out;
    },

    all() {
      return Array.from(get().index.byId.values());
    },
  })),
);

/**
 * Wire the store to the EventBus + Tauri events. Call once from app bootstrap.
 *
 * Multi-path subscription rationale: the `vault:opened` event is emitted from
 * specific user-interactive code paths (selectVault, etc.), but on a fresh app
 * start a vault may be restored from settings via a different code path that
 * sets `fileTreeStore.vaultPath` without going through that event. We also
 * subscribe to the vaultPath selector directly so the store hydrates regardless
 * of which code path activated the vault.
 *
 * Returns an unsubscribe function for test teardown.
 */
export function initAttachmentStoreSubscriptions(): () => void {
  const off1 = EventBus.on('vault:opened', () => {
    void useAttachmentStore.getState().hydrate();
  });
  const off2 = EventBus.on('vault:closed', () => {
    useAttachmentStore.getState().clear();
  });
  const off3 = EventBus.on('attachment:saved', () => {
    void useAttachmentStore.getState().refresh();
  });
  const off4 = EventBus.on('attachment:deleted', () => {
    void useAttachmentStore.getState().refresh();
  });

  // Catch the "vault already open at init time" race — fired during app boot
  // before our subscriptions land. Also catches HMR reloads where the vault is
  // already set in the store but `vault:opened` won't fire again.
  const initialVault = useFileTreeStore.getState().vaultPath;
  if (initialVault) {
    void useAttachmentStore.getState().hydrate();
  }
  // Watch subsequent vaultPath changes — covers any bootstrap path that sets
  // the vault without going through the EventBus emit site.
  const off5 = useFileTreeStore.subscribe(
    (state) => state.vaultPath,
    (vault, prevVault) => {
      if (vault && vault !== prevVault) {
        void useAttachmentStore.getState().hydrate();
      } else if (!vault && prevVault) {
        useAttachmentStore.getState().clear();
      }
    },
  );

  return () => {
    off1();
    off2();
    off3();
    off4();
    off5();
  };
}

// Convenience selectors for components
export const useAttachmentResolver = () =>
  useAttachmentStore((s) => s.resolveByName);

export const useAttachmentList = () => useAttachmentStore((s) => s.all());

// ── Upload-status polling ──────────────────────────────────────────────────
// While any ref has `syncEtag === null` we are mid-push to NAS. The backend
// owns the actual sync_etag write — there's no Tauri event for "this single
// attachment's push finished" yet, so the frontend polls the store every
// few seconds to detect the transition. As soon as every ref has an etag,
// polling stops. Cheap (one Tauri command per tick) and bounded by the
// user actually having pending uploads.
const UPLOAD_POLL_INTERVAL_MS = 4000;
let uploadPollTimer: ReturnType<typeof setInterval> | null = null;

function hasUploadingRef(): boolean {
  for (const r of useAttachmentStore.getState().index.byId.values()) {
    if (!r.syncEtag) return true;
  }
  return false;
}

function maybeStartUploadPolling() {
  if (uploadPollTimer !== null) return;
  if (!hasUploadingRef()) return;
  uploadPollTimer = setInterval(() => {
    if (!hasUploadingRef()) {
      // Nothing left in flight — stop polling. A future drag-in or NAS
      // pull triggers refresh()/hydrate() which will restart polling if
      // new uploading refs appear.
      if (uploadPollTimer !== null) {
        clearInterval(uploadPollTimer);
        uploadPollTimer = null;
      }
      return;
    }
    void useAttachmentStore.getState().refresh();
  }, UPLOAD_POLL_INTERVAL_MS);
}
