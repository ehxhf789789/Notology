import { create } from 'zustand';
import { searchCommands } from '../../../core/services/tauriCommands';
import { editorPool } from '../../../core/editor/editorPool';
import { fileLookupActions } from '../../../core/stores/fileLookupStore';
import { contentCacheActions } from './contentCacheStore';
import { useTemplateStore } from '../../templates/stores/templateStore';
import type { NoteMetadata } from '../../../core/types';

// Track in-flight lazy fetches to avoid duplicate requests
const pendingTypeFetches = new Set<string>();

interface NoteTypeCacheState {
  // Cache: fileName -> noteType
  cache: Map<string, string>;
  isLoading: boolean;
  lastRefresh: number;
  /**
   * 5.0.5a-migration (2026-05-17, HanBin) — set of distinct frontmatter
   * `type:` values seen on disk that don't match any currently-registered
   * NoteTemplate. These are the candidates the TemplateMigrationModal
   * lets the user remap onto current templates (e.g. legacy `MTG` → new
   * `DOC`). Populated by `refreshCache()`; recomputed on the same cadence.
   */
  unmatchedTypes: Map<string, number>; // type → file count

  // Actions
  refreshCache: () => Promise<void>;
  getNoteType: (fileName: string) => string | null;
  patchNoteType: (fileName: string, noteType: string) => void;
  invalidate: () => void;
  /** Full state wipe — used on vault switch so previous-vault data
   *  doesn't surface in the UI between switch and next refresh. */
  reset: () => void;
  /** Returns paths of every note whose frontmatter.type === `legacyType`. */
  listNotesWithType: (legacyType: string) => Promise<string[]>;
}

export const useNoteTypeCacheStore = create<NoteTypeCacheState>()((set, get) => ({
  cache: new Map(),
  isLoading: false,
  lastRefresh: 0,
  unmatchedTypes: new Map(),

  refreshCache: async () => {
    const state = get();
    // Debounce: don't refresh if we did so in the last 2 seconds
    const now = Date.now();
    if (state.isLoading || (now - state.lastRefresh < 2000)) {
      return;
    }

    set({ isLoading: true });

    try {
      const notes = await searchCommands.queryNotes({});
      const newCache = new Map<string, string>();

      // 5.0.5a-migration — build the registered-types set from the
      // current NoteTemplate registry so we can tell which on-disk types
      // are "unidentified" (no current template owns them). Comparison
      // is case-insensitive because frontmatter type is often shouted
      // (NOTE / MTG / DOC) while template type can be either form.
      const registeredTypes = new Set<string>();
      for (const tpl of useTemplateStore.getState().noteTemplates) {
        const tpe = (tpl.frontmatter.type || '').toString().trim().toLowerCase();
        if (tpe) registeredTypes.add(tpe);
      }

      // 11th hotfix (2026-05-18, HanBin) — system structural types that
      // are NEVER user-migratable. Folder notes (CONTAINER) are produced
      // when a container is created, not from any user template. Counting
      // them as "unmatched templates needing migration" misled the badge
      // — user sees "5개 정리 필요" but 3 of those are just folder notes
      // they can't migrate anywhere.
      //
      // Add more system markers here as they surface (e.g. archived notes,
      // sketch-canvas containers). All comparisons are lowercase.
      const SYSTEM_EXEMPT_TYPES = new Set<string>(['container']);
      const unmatched = new Map<string, number>();

      for (const note of notes) {
        const fileName = note.path.split(/[/\\]/).pop()?.replace(/\.md$/, '');
        if (fileName && note.note_type) {
          // Store both original case and lowercase for case-insensitive lookups
          newCache.set(fileName, note.note_type);
          newCache.set(fileName + '.md', note.note_type);
          const lower = fileName.toLowerCase();
          if (lower !== fileName) {
            newCache.set(lower, note.note_type);
            newCache.set(lower + '.md', note.note_type);
          }
          const tLower = note.note_type.trim().toLowerCase();
          if (
            tLower
            && !registeredTypes.has(tLower)
            && !SYSTEM_EXEMPT_TYPES.has(tLower)
          ) {
            // Preserve the original casing from the note for the UI.
            unmatched.set(note.note_type, (unmatched.get(note.note_type) ?? 0) + 1);
          }
        }
      }

      set({ cache: newCache, unmatchedTypes: unmatched, isLoading: false, lastRefresh: now });

      // Force all active editors to recalculate wiki link decorations
      // (decorations read noteType from this cache but only recompute on state changes)
      editorPool.refreshDecorations();
    } catch (err) {
      // "Search index not initialized" is expected during background indexing — don't log
      const errStr = String(err);
      if (!errStr.includes('not initialized')) {
        console.error('Failed to load note types:', err);
      }
      // 11th hotfix (2026-05-18, HanBin) — don't keep `lastRefresh = now`
      // on failure. Otherwise the 2-sec debounce + the failed-refresh
      // combo leaves stale data visible AND blocks the next attempt for
      // 2 seconds. Reset lastRefresh so the very next trigger retries.
      // (Stale data itself is now cleared on vault switch via reset(),
      // so a transient index-not-ready failure is safe — it'll just
      // retry until ready.)
      set({ isLoading: false, lastRefresh: 0 });
    }
  },

  getNoteType: (fileName: string): string | null => {
    const { cache } = get();
    const noExt = fileName.replace(/\.md$/, '');

    // 1) Primary: search-index cache
    const fromCache = cache.get(noExt) || cache.get(noExt.toLowerCase());
    if (fromCache) return fromCache;

    // 2) Secondary: contentCache / metadataCache (notes that have been loaded or preloaded)
    const filePath = fileLookupActions.resolveNotePath(noExt);
    if (filePath) {
      const fm = contentCacheActions.getFrontmatter(filePath);
      if (fm?.type) {
        // Back-fill the primary cache so subsequent lookups are instant
        cache.set(noExt, fm.type);
        return fm.type;
      }

      // 3) Lazy-fetch: file exists but frontmatter not cached yet
      // Trigger async metadata load → update cache → refresh decorations
      if (!pendingTypeFetches.has(noExt)) {
        pendingTypeFetches.add(noExt);
        contentCacheActions.preloadMetadata([filePath]).then(() => {
          const loadedFm = contentCacheActions.getFrontmatter(filePath);
          if (loadedFm?.type) {
            const currentCache = get().cache;
            currentCache.set(noExt, loadedFm.type);
            const lower = noExt.toLowerCase();
            if (lower !== noExt) currentCache.set(lower, loadedFm.type);
            editorPool.refreshDecorations();
          }
        }).catch(() => {}).finally(() => {
          pendingTypeFetches.delete(noExt);
        });
      }
    }

    return null;
  },

  // Direct cache update — called from patchNote / save operations
  // so the cache stays current even if the search index hasn't re-indexed yet
  patchNoteType: (fileName: string, noteType: string) => {
    if (!noteType) return;
    const { cache } = get();
    const noExt = fileName.replace(/\.md$/, '');
    const prev = cache.get(noExt);
    if (prev === noteType) return; // no change
    cache.set(noExt, noteType);
    const lower = noExt.toLowerCase();
    if (lower !== noExt) cache.set(lower, noteType);
  },

  invalidate: () => {
    set({ lastRefresh: 0 });
  },

  /**
   * 11th hotfix (2026-05-18, HanBin) — full reset for vault switch.
   * `invalidate()` only clears the timestamp (forces next refresh); this
   * also wipes the cache + unmatchedTypes so the stale-vault data
   * doesn't surface in UI between the vault switch and the next
   * successful refresh. Called from vault-open / vault-switch / logout.
   */
  reset: () => {
    set({
      cache: new Map(),
      unmatchedTypes: new Map(),
      lastRefresh: 0,
      isLoading: false,
    });
  },

  /**
   * 5.0.5a-migration — list the absolute paths of every note whose
   * frontmatter.type matches `legacyType` (case-insensitive). Used by
   * the migration modal to know which files to rewrite when the user
   * picks "MTG → DOC".
   */
  listNotesWithType: async (legacyType: string): Promise<string[]> => {
    const target = legacyType.trim().toLowerCase();
    if (!target) return [];
    try {
      const notes = await searchCommands.queryNotes({});
      return notes
        .filter(n => (n.note_type || '').toString().trim().toLowerCase() === target)
        .map(n => n.path);
    } catch (err) {
      console.error('[noteTypeCache] listNotesWithType failed:', err);
      return [];
    }
  },
}));

// Selector hooks
export const useNoteTypeCache = () => useNoteTypeCacheStore((state) => state.cache);
export const useNoteTypeCacheLoading = () => useNoteTypeCacheStore((state) => state.isLoading);
export const useUnmatchedNoteTypes = () => useNoteTypeCacheStore((state) => state.unmatchedTypes);

// Actions (stable references)
export const noteTypeCacheActions = {
  refreshCache: () => useNoteTypeCacheStore.getState().refreshCache(),
  getNoteType: (fileName: string) => useNoteTypeCacheStore.getState().getNoteType(fileName),
  patchNoteType: (fileName: string, noteType: string) => useNoteTypeCacheStore.getState().patchNoteType(fileName, noteType),
  invalidate: () => useNoteTypeCacheStore.getState().invalidate(),
  reset: () => useNoteTypeCacheStore.getState().reset(),
  listNotesWithType: (legacyType: string) =>
    useNoteTypeCacheStore.getState().listNotesWithType(legacyType),
};
