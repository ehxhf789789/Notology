import { create } from 'zustand';
import type { FileContent, NoteFrontmatter } from '../../types';
import { parseFrontmatter } from '../../utils/frontmatter';
import { fileCommands, cacheCommands } from '../../services/tauriCommands';
import type { FrontmatterOnly, FileMeta } from '../../services/tauriCommands';
import { subscribeToWindowSync, type FileSavedPayload, type MemoChangedPayload, type SearchIndexUpdatedPayload } from '../../utils/windowSync';
import { refreshActions } from './refreshStore';
import { markAsSelfSaved } from '../../utils/selfSaveTracker';

// Conditional logging - only in development
const DEV = import.meta.env.DEV;
const log = DEV ? console.log.bind(console) : () => {};

interface CachedContent {
  frontmatter: NoteFrontmatter | null;
  body: string;
  rawContent: FileContent;
  timestamp: number;
  filePath: string;
  mtime?: number; // File modification time in ms since epoch
}

// Persistent cache format stored in .notology/content-cache.json
interface PersistentCacheEntry {
  mtime: number;
  frontmatter: NoteFrontmatter | null;
  bodyPreview: string; // First 500 chars of body for quick preview
}

interface PersistentCache {
  version: number;
  entries: Record<string, PersistentCacheEntry>;
}

// Lightweight metadata cache entry (frontmatter only, no body)
interface MetadataCacheEntry {
  frontmatter: NoteFrontmatter | null;
  mtime: number;
}

interface ContentCacheState {
  // Cache: filePath -> CachedContent (full content)
  cache: Map<string, CachedContent>;
  // Metadata-only cache: filePath -> MetadataCacheEntry (Obsidian-style fast path)
  metadataCache: Map<string, MetadataCacheEntry>;
  // Loading states: filePath -> Promise (for deduplication)
  loadingPromises: Map<string, Promise<CachedContent>>;

  // Max cache size (number of items) - set high for full cache warming
  maxCacheSize: number;

  // Warmup state
  isWarming: boolean;
  warmupProgress: { loaded: number; total: number; fromCache: number };

  // Persistent cache state
  persistentCache: PersistentCache | null;
  vaultPath: string | null;

  // Actions
  getContent: (filePath: string) => Promise<CachedContent>;
  getContentSync: (filePath: string) => CachedContent | null; // Sync, instant access for cache hits
  hasContent: (filePath: string) => boolean; // Silent check if content is cached
  getFrontmatter: (filePath: string) => NoteFrontmatter | null; // Sync, instant access
  preloadContent: (filePath: string) => void;
  preloadMetadata: (filePaths: string[]) => Promise<void>; // Batch frontmatter loading
  invalidateContent: (filePath: string) => void;
  invalidateAll: () => void;
  updateContent: (filePath: string, body: string, frontmatter: NoteFrontmatter | null, mtime?: number) => void;

  // Cache warming with persistent cache support
  warmupCache: (filePaths: string[], vaultPath?: string) => Promise<void>;
  loadPersistentCache: (vaultPath: string) => Promise<void>;
  savePersistentCache: () => Promise<void>;
}

const CACHE_VERSION = 1;
const BODY_PREVIEW_LENGTH = 500;

export const useContentCacheStore = create<ContentCacheState>()((set, get) => ({
  cache: new Map(),
  metadataCache: new Map(),
  loadingPromises: new Map(),
  maxCacheSize: 2000, // Higher limit for full cache warming
  isWarming: false,
  warmupProgress: { loaded: 0, total: 0, fromCache: 0 },
  persistentCache: null,
  vaultPath: null,

  // Get frontmatter synchronously (instant access from cache)
  // Returns null if not in cache - use preloadMetadata first for batch loading
  getFrontmatter: (filePath: string): NoteFrontmatter | null => {
    // First check full content cache
    const cached = get().cache.get(filePath);
    if (cached) return cached.frontmatter;

    // Then check metadata-only cache
    const metadata = get().metadataCache.get(filePath);
    if (metadata) return metadata.frontmatter;

    // Check persistent cache as fallback
    const persistentEntry = get().persistentCache?.entries[filePath];
    if (persistentEntry) return persistentEntry.frontmatter;

    return null;
  },

  // Get content synchronously - returns cached content or null
  // Use this for instant cache access without Promise overhead
  getContentSync: (filePath: string): CachedContent | null => {
    const cached = get().cache.get(filePath);
    if (cached) {
      log(`[ContentCache] SYNC HIT: ${filePath.split(/[/\\]/).pop()}`);
      return cached;
    }
    return null;
  },

  // Check if content is cached (silent, no logging)
  hasContent: (filePath: string): boolean => {
    return get().cache.has(filePath);
  },

  // Batch preload frontmatter only (Obsidian-style metadata-first loading)
  // Much faster than full content loading - uses optimized Rust command
  preloadMetadata: async (filePaths: string[]): Promise<void> => {
    const state = get();

    // Filter out paths already in cache
    const pathsToLoad = filePaths.filter(p =>
      !state.cache.has(p) && !state.metadataCache.has(p)
    );

    if (pathsToLoad.length === 0) return;

    const loadStart = performance.now();
    try {
      const results = await cacheCommands.readFrontmattersBatch(pathsToLoad);

      const newMetadataCache = new Map(get().metadataCache);
      for (const { path, frontmatter, mtime } of results) {
        const parsed = frontmatter ? parseFrontmatter(frontmatter) : null;
        newMetadataCache.set(path, { frontmatter: parsed, mtime });
      }

      set({ metadataCache: newMetadataCache });

      const elapsed = performance.now() - loadStart;
      log(`[ContentCache] Preloaded metadata for ${results.length} files in ${elapsed.toFixed(0)}ms`);
    } catch (err) {
      console.error('[ContentCache] Failed to preload metadata:', err);
    }
  },

  // Get content with caching
  getContent: async (filePath: string): Promise<CachedContent> => {
    const startTime = performance.now();
    const state = get();

    // Check if already cached - INSTANT return
    const cached = state.cache.get(filePath);
    if (cached) {
      // CACHE HIT — silent (too frequent to log)
      return cached; // Skip LRU update for speed
    }

    // CACHE MISS — silent (logged in bulk during warmup)


    // Check if already loading (deduplicate concurrent requests)
    const existingPromise = state.loadingPromises.get(filePath);
    if (existingPromise) {
      return existingPromise;
    }

    // Start loading
    const loadPromise = (async (): Promise<CachedContent> => {
      try {
        // Check if we have metadata cached (from persistent cache)
        const cachedMetadata = get().metadataCache.get(filePath);

        const rawContent = await fileCommands.readFile(filePath);

        // Get file mtime in parallel with reading (or use cached if available)
        let mtime: number;
        if (cachedMetadata?.mtime) {
          mtime = cachedMetadata.mtime;
        } else {
          const mtimes = await cacheCommands.getFilesMtime([filePath]);
          mtime = mtimes.length > 0 ? mtimes[0].mtime : Date.now();
        }

        // Use cached frontmatter if mtime matches (skip re-parsing)
        let frontmatter: NoteFrontmatter | null;
        if (cachedMetadata && cachedMetadata.mtime === mtime) {
          frontmatter = cachedMetadata.frontmatter;
        } else {
          frontmatter = rawContent.frontmatter ? parseFrontmatter(rawContent.frontmatter) : null;
        }

        const cachedContent: CachedContent = {
          frontmatter,
          body: rawContent.body,
          rawContent,
          timestamp: Date.now(),
          filePath,
          mtime,
        };

        // Update cache
        set((state) => {
          const newCache = new Map(state.cache);

          // Evict oldest if over limit (LRU)
          if (newCache.size >= state.maxCacheSize) {
            const firstKey = newCache.keys().next().value;
            if (firstKey) newCache.delete(firstKey);
          }

          newCache.set(filePath, cachedContent);

          // Remove from loading promises
          const newLoadingPromises = new Map(state.loadingPromises);
          newLoadingPromises.delete(filePath);

          return { cache: newCache, loadingPromises: newLoadingPromises };
        });

        return cachedContent;
      } catch (err) {
        // Remove from loading promises on error
        set((state) => {
          const newLoadingPromises = new Map(state.loadingPromises);
          newLoadingPromises.delete(filePath);
          return { loadingPromises: newLoadingPromises };
        });
        throw err;
      }
    })();

    // Register loading promise
    set((state) => {
      const newLoadingPromises = new Map(state.loadingPromises);
      newLoadingPromises.set(filePath, loadPromise);
      return { loadingPromises: newLoadingPromises };
    });

    return loadPromise;
  },

  // Preload content in background (fire and forget)
  preloadContent: (filePath: string) => {
    const state = get();

    // Skip if already cached or loading
    if (state.cache.has(filePath) || state.loadingPromises.has(filePath)) {
      return;
    }

    // Start loading in background
    state.getContent(filePath).catch(() => {
      // Silently ignore preload errors
    });
  },

  // Invalidate specific file (when saved externally)
  invalidateContent: (filePath: string) => {
    set((state) => {
      const newCache = new Map(state.cache);
      newCache.delete(filePath);
      return { cache: newCache };
    });
  },

  // Invalidate all (when vault changes)
  invalidateAll: () => {
    set({ cache: new Map(), metadataCache: new Map(), loadingPromises: new Map(), persistentCache: null });
  },

  // Update cached content (after save)
  updateContent: (filePath: string, body: string, frontmatter: NoteFrontmatter | null, mtime?: number) => {
    set((state) => {
      const cached = state.cache.get(filePath);
      if (!cached) return state;

      const newCache = new Map(state.cache);
      newCache.set(filePath, {
        ...cached,
        body,
        frontmatter,
        timestamp: Date.now(),
        mtime: mtime ?? Date.now(),
      });
      return { cache: newCache };
    });
  },

  // Load persistent cache from vault .notology folder
  loadPersistentCache: async (vaultPath: string) => {
    const loadStart = performance.now();
    log('[ContentCache] Loading persistent cache...');

    try {
      const cacheJson = await cacheCommands.readMetaCache(vaultPath);

      if (!cacheJson) {
        log('[ContentCache] No persistent cache found');
        set({ persistentCache: null, vaultPath });
        return;
      }

      const parsed = JSON.parse(cacheJson) as PersistentCache;

      if (parsed.version !== CACHE_VERSION) {
        log(`[ContentCache] Cache version mismatch (${parsed.version} vs ${CACHE_VERSION}), discarding`);
        set({ persistentCache: null, vaultPath });
        return;
      }

      const entryCount = Object.keys(parsed.entries).length;
      const elapsed = performance.now() - loadStart;
      log(`[ContentCache] Loaded persistent cache: ${entryCount} entries in ${elapsed.toFixed(0)}ms`);

      set({ persistentCache: parsed, vaultPath });
    } catch (err) {
      console.error('[ContentCache] Failed to load persistent cache:', err);
      set({ persistentCache: null, vaultPath });
    }
  },

  // Save persistent cache to vault .notology folder
  savePersistentCache: async () => {
    const state = get();
    if (!state.vaultPath) {
      console.warn('[ContentCache] Cannot save: no vault path set');
      return;
    }

    const saveStart = performance.now();
    log('[ContentCache] Saving persistent cache...');

    try {
      // Build persistent cache from in-memory cache
      const entries: Record<string, PersistentCacheEntry> = {};

      state.cache.forEach((content, filePath) => {
        entries[filePath] = {
          mtime: content.mtime || content.timestamp,
          frontmatter: content.frontmatter,
          bodyPreview: content.body.slice(0, BODY_PREVIEW_LENGTH),
        };
      });

      const persistentCache: PersistentCache = {
        version: CACHE_VERSION,
        entries,
      };

      const cacheJson = JSON.stringify(persistentCache);

      await cacheCommands.writeMetaCache(state.vaultPath, cacheJson);

      const elapsed = performance.now() - saveStart;
      log(`[ContentCache] Saved persistent cache: ${Object.keys(entries).length} entries in ${elapsed.toFixed(0)}ms`);
    } catch (err) {
      console.error('[ContentCache] Failed to save persistent cache:', err);
    }
  },

  // Cache warming with persistent cache support - Obsidian-style smart invalidation
  warmupCache: async (filePaths: string[], vaultPath?: string) => {
    const state = get();
    if (state.isWarming) return; // Already warming

    const warmupStart = performance.now();
    log(`[ContentCache] Starting cache warmup for ${filePaths.length} files`);

    set({ isWarming: true, warmupProgress: { loaded: 0, total: filePaths.length, fromCache: 0 } });

    // Step 1: Load persistent cache if vault path provided
    if (vaultPath) {
      await get().loadPersistentCache(vaultPath);
    }

    const persistentCache = get().persistentCache;
    const persistentEntries = persistentCache?.entries || {};

    // Step 2: Get all file mtimes in one batch call (fast Rust command)
    const mtimeStart = performance.now();
    let fileMtimes: FileMeta[] = [];
    try {
      fileMtimes = await cacheCommands.getFilesMtime(filePaths);
    } catch (err) {
      console.error('[ContentCache] Failed to get file mtimes:', err);
    }
    log(`[ContentCache] Got mtimes for ${fileMtimes.length} files in ${(performance.now() - mtimeStart).toFixed(0)}ms`);

    // Build mtime lookup map
    const mtimeMap = new Map<string, number>();
    for (const { path, mtime } of fileMtimes) {
      mtimeMap.set(path, mtime);
    }

    // Step 3: Determine which files need reloading
    const filesToReload: string[] = [];
    const filesFromCache: string[] = [];

    for (const filePath of filePaths) {
      const currentMtime = mtimeMap.get(filePath);
      const cachedEntry = persistentEntries[filePath];

      // Skip if already in memory cache
      if (get().cache.has(filePath)) {
        continue;
      }

      // If file doesn't exist anymore, skip
      if (currentMtime === undefined) {
        continue;
      }

      // If no cached entry or mtime changed, need to reload from disk
      if (!cachedEntry || cachedEntry.mtime !== currentMtime) {
        filesToReload.push(filePath);
      } else {
        // mtime matches - can use cached frontmatter, but still need body
        // For now, we'll reload the full file but this is a place for future optimization
        // (could store full body in cache, or lazy-load body on demand)
        filesFromCache.push(filePath);
      }
    }

    log(`[ContentCache] Files to reload: ${filesToReload.length}, from persistent cache (lazy): ${filesFromCache.length}`);

    // Step 4: Obsidian-style lazy loading
    // For files with matching mtime: populate metadata cache only (NO disk read)
    // Full body will be loaded on-demand when getContent() is called
    let fromCacheCount = 0;

    // Process cached files: only populate metadata cache (instant, no I/O)
    if (filesFromCache.length > 0) {
      const newMetadataCache = new Map(get().metadataCache);
      for (const filePath of filesFromCache) {
        const cachedEntry = persistentEntries[filePath];
        const currentMtime = mtimeMap.get(filePath);
        if (cachedEntry && currentMtime) {
          // Store frontmatter in metadata cache for instant access
          // Body will be loaded on-demand
          newMetadataCache.set(filePath, {
            frontmatter: cachedEntry.frontmatter,
            mtime: currentMtime,
          });
          fromCacheCount++;
        }
      }
      set({ metadataCache: newMetadataCache });
      log(`[ContentCache] Populated metadata cache for ${fromCacheCount} files (no disk I/O)`);
    }

    // Step 5: Load ONLY changed files from disk (in background batches)
    const BATCH_SIZE = 10;
    const BATCH_DELAY = 5;

    let loaded = fromCacheCount; // Count cached files as loaded

    // Only reload files that actually changed
    // Batch Map updates: collect results per batch, then ONE set() call per batch
    for (let i = 0; i < filesToReload.length; i += BATCH_SIZE) {
      const batch = filesToReload.slice(i, i + BATCH_SIZE);
      const batchResults: { filePath: string; content: CachedContent }[] = [];

      await Promise.all(
        batch.map(async (filePath) => {
          try {
            const rawContent = await fileCommands.readFile(filePath);
            const frontmatter = rawContent.frontmatter ? parseFrontmatter(rawContent.frontmatter) : null;
            const mtime = mtimeMap.get(filePath) || Date.now();

            batchResults.push({
              filePath,
              content: {
                frontmatter,
                body: rawContent.body,
                rawContent,
                timestamp: Date.now(),
                filePath,
                mtime,
              },
            });

            loaded++;
          } catch {
            loaded++;
          }
        })
      );

      // Single set() per batch instead of per-file (avoids N Map copies)
      if (batchResults.length > 0) {
        set((state) => {
          const newCache = new Map(state.cache);
          for (const { filePath: fp, content } of batchResults) {
            newCache.set(fp, content);
          }
          return { cache: newCache, warmupProgress: { loaded, total: filePaths.length, fromCache: fromCacheCount } };
        });
      }

      // Yield to main thread
      if (i + BATCH_SIZE < filesToReload.length) {
        await new Promise(resolve => setTimeout(resolve, BATCH_DELAY));
      }
    }

    const elapsed = performance.now() - warmupStart;
    log(`[ContentCache] Cache warmup complete: ${loaded}/${filePaths.length} files in ${elapsed.toFixed(0)}ms (${fromCacheCount} from cache)`);

    set({ isWarming: false });

    // Step 5: Save updated cache to disk (async, non-blocking)
    if (vaultPath) {
      get().savePersistentCache().catch(err => {
        console.error('[ContentCache] Background cache save failed:', err);
      });
    }
  },
}));

// Selector hooks
export const useCachedContent = (filePath: string) =>
  useContentCacheStore((state) => state.cache.get(filePath));

// Actions (stable references)
export const contentCacheActions = {
  getContent: (filePath: string) => useContentCacheStore.getState().getContent(filePath),
  getContentSync: (filePath: string) => useContentCacheStore.getState().getContentSync(filePath),
  hasContent: (filePath: string) => useContentCacheStore.getState().hasContent(filePath),
  getFrontmatter: (filePath: string) => useContentCacheStore.getState().getFrontmatter(filePath),
  preloadContent: (filePath: string) => useContentCacheStore.getState().preloadContent(filePath),
  preloadMetadata: (filePaths: string[]) => useContentCacheStore.getState().preloadMetadata(filePaths),
  invalidateContent: (filePath: string) => useContentCacheStore.getState().invalidateContent(filePath),
  invalidateAll: () => useContentCacheStore.getState().invalidateAll(),
  updateContent: (filePath: string, body: string, frontmatter: NoteFrontmatter | null, mtime?: number) =>
    useContentCacheStore.getState().updateContent(filePath, body, frontmatter, mtime),
  warmupCache: (filePaths: string[], vaultPath?: string) =>
    useContentCacheStore.getState().warmupCache(filePaths, vaultPath),
  loadPersistentCache: (vaultPath: string) =>
    useContentCacheStore.getState().loadPersistentCache(vaultPath),
  savePersistentCache: () =>
    useContentCacheStore.getState().savePersistentCache(),
  getWarmupProgress: () => useContentCacheStore.getState().warmupProgress,
  isWarming: () => useContentCacheStore.getState().isWarming,
};

// Window sync subscription for cross-window cache invalidation
let windowSyncUnsubscribe: (() => void) | null = null;

/**
 * Subscribe to window sync events for automatic cache invalidation
 * Call this once when the app initializes (in main window)
 */
export async function initContentCacheSync(): Promise<void> {
  // Avoid duplicate subscriptions
  if (windowSyncUnsubscribe) return;

  try {
    windowSyncUnsubscribe = await subscribeToWindowSync({
      onFileSaved: (payload: FileSavedPayload) => {
        // Invalidate cache when another window saves a file
        log(`[ContentCache] FILE_SAVED from window ${payload.windowLabel}: ${payload.filePath}`);
        useContentCacheStore.getState().invalidateContent(payload.filePath);
        // Sync self-save tracker across windows so the main window's file watcher
        // won't treat this save as an external change
        markAsSelfSaved(payload.filePath);
      },
      onMemoChanged: (payload: MemoChangedPayload) => {
        // Refresh search + calendar when another window changes memo/todo content
        log(`[ContentCache] MEMO_CHANGED from window ${payload.windowLabel}: ${payload.filePath}`);
        useContentCacheStore.getState().invalidateContent(payload.filePath);
        refreshActions.batchRefresh({ search: true, calendar: true });
      },
      onSearchIndexUpdated: (payload: SearchIndexUpdatedPayload) => {
        // Refresh search when another window updates the index
        log(`[ContentCache] SEARCH_INDEX_UPDATED from window ${payload.windowLabel}: ${payload.filePath}`);
        refreshActions.incrementSearchRefresh();
      },
    });
    log('[ContentCache] Window sync subscription initialized');
  } catch (err) {
    console.error('[ContentCache] Failed to initialize window sync:', err);
  }
}

/**
 * Cleanup window sync subscription
 */
export function cleanupContentCacheSync(): void {
  if (windowSyncUnsubscribe) {
    windowSyncUnsubscribe();
    windowSyncUnsubscribe = null;
    log('[ContentCache] Window sync subscription cleaned up');
  }
}
