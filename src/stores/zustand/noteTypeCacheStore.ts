import { create } from 'zustand';
import { searchCommands } from '../../services/tauriCommands';
import { editorPool } from '../../utils/editorPool';
import { fileLookupActions } from './fileLookupStore';
import { contentCacheActions } from './contentCacheStore';
import type { NoteMetadata } from '../../types';

// Track in-flight lazy fetches to avoid duplicate requests
const pendingTypeFetches = new Set<string>();

interface NoteTypeCacheState {
  // Cache: fileName -> noteType
  cache: Map<string, string>;
  isLoading: boolean;
  lastRefresh: number;

  // Actions
  refreshCache: () => Promise<void>;
  getNoteType: (fileName: string) => string | null;
  patchNoteType: (fileName: string, noteType: string) => void;
  invalidate: () => void;
}

export const useNoteTypeCacheStore = create<NoteTypeCacheState>()((set, get) => ({
  cache: new Map(),
  isLoading: false,
  lastRefresh: 0,

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
        }
      }

      set({ cache: newCache, isLoading: false, lastRefresh: now });

      // Force all active editors to recalculate wiki link decorations
      // (decorations read noteType from this cache but only recompute on state changes)
      editorPool.refreshDecorations();
    } catch (err) {
      // "Search index not initialized" is expected during background indexing — don't log
      const errStr = String(err);
      if (!errStr.includes('not initialized')) {
        console.error('Failed to load note types:', err);
      }
      set({ isLoading: false });
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
}));

// Selector hooks
export const useNoteTypeCache = () => useNoteTypeCacheStore((state) => state.cache);
export const useNoteTypeCacheLoading = () => useNoteTypeCacheStore((state) => state.isLoading);

// Actions (stable references)
export const noteTypeCacheActions = {
  refreshCache: () => useNoteTypeCacheStore.getState().refreshCache(),
  getNoteType: (fileName: string) => useNoteTypeCacheStore.getState().getNoteType(fileName),
  patchNoteType: (fileName: string, noteType: string) => useNoteTypeCacheStore.getState().patchNoteType(fileName, noteType),
  invalidate: () => useNoteTypeCacheStore.getState().invalidate(),
};
