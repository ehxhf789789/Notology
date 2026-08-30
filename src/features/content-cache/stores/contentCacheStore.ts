import { create } from 'zustand';
import type { FileContent, NoteFrontmatter } from '../../../core/types';
import { parseFrontmatter } from '../../../core/utils/frontmatter';
import { fileCommands, cacheCommands } from '../../../core/services/tauriCommands';
import type { FrontmatterOnly, FileMeta } from '../../../core/services/tauriCommands';
import { subscribeToWindowSync, type FileSavedPayload, type MemoChangedPayload, type SearchIndexUpdatedPayload } from '../../../core/utils/windowSync';
import { refreshActions } from '../../../core/stores/refreshStore';
import { markAsSelfSaved } from '../../../core/utils/selfSaveTracker';

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

//: 🔴 **미리 읽기를 한 프레임 동안 모은다** (2026-08-30).
//    `read_files` 한 번으로 미리 데워 두면, 뒤이어 오는 `getContent` 들이
//    서버를 다시 안 부른다 — HTTP 캐시가 아니라 **브라우저 fetch 중복 제거**
//    가 아니므로, 데운 것을 여기 담아 두고 `getContent` 가 꺼내 쓴다.
const _warm = new Map<string, unknown>();
let _pending: string[] = [];
let _timer: ReturnType<typeof setTimeout> | null = null;
let _flight: Promise<void> | null = null;

export function warmed(path: string): unknown | undefined {
  const v = _warm.get(path);
  if (v !== undefined) _warm.delete(path);      // 한 번만 쓴다
  return v;
}

/** 이 경로가 든 묶음이 끝날 때까지 기다린다.
 *
 * ⚠️ **모으면서 동시에 개별로도 읽으면 아무 소용이 없다** (2026-08-30에
 *    그렇게 짰다가 물렸다 — 왕복이 161로 그대로였다). 모으기를 *기다린 뒤*
 *    읽어야 그때는 이미 데워져 있다. */
function _batchPreload(path: string): Promise<void> {
  if (!_pending.includes(path)) _pending.push(path);
  if (!_timer) {
    _flight = new Promise<void>((done) => {
      _timer = setTimeout(async () => {
        const paths = _pending.slice(0, 200);
        _pending = _pending.slice(200);
        _timer = null;
        try {
          const rows = await fileCommands.readFiles(paths);
          for (const r of rows) if (r.ok && r.file) _warm.set(r.path, r.file);
        } catch {
          /* 못 모으면 옛 길로 — 조용히 느릴 뿐이다 */
        }
        done();
        if (_pending.length) _batchPreload(_pending[0]);
      }, 16);
    });
  }
  return _flight as Promise<void>;
}

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

        // Run readFile and mtime fetch in parallel to minimize IPC round-trips
        let rawContent: FileContent;
        let mtime: number;
        const _w = warmed(filePath) as FileContent | undefined;
        if (_w) {
          rawContent = _w;                     // 모아 읽기가 데워 둔 것
          mtime = cachedMetadata?.mtime
            ?? (await cacheCommands.getFilesMtime([filePath]))[0]?.mtime
            ?? Date.now();
        } else if (cachedMetadata?.mtime) {
          rawContent = await fileCommands.readFile(filePath);
          mtime = cachedMetadata.mtime;
        } else {
          const [content, mtimes] = await Promise.all([
            fileCommands.readFile(filePath),
            cacheCommands.getFilesMtime([filePath]),
          ]);
          rawContent = content;
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
  //
  // 🔴 **한 왕복으로 모아 보낸다** (2026-08-30). 목록이 그려질 때 노트마다
  //    이 함수가 불려 `read_file` 이 141번 날아갔다 — 서버 안에서는 0ms 라
  //    안 보이지만 망 너머에서는 왕복마다 값을 낸다 (20ms × 141 = 2.8초).
  //    16ms(한 프레임) 동안 모았다가 `read_files` 한 번으로 보낸다.
  //    ⚠️ 캐시에 넣는 길은 `getContent` 하나뿐이다 — 여기서 따로 넣으면
  //       파싱·mtime 규칙이 두 벌이 된다. 그래서 **미리 데워만 두고**
  //       해석은 그대로 `getContent` 에 맡긴다.
  preloadContent: (filePath: string) => {
    const state = get();

    // Skip if already cached or loading
    if (state.cache.has(filePath) || state.loadingPromises.has(filePath)) {
      return;
    }
    // 🔴 **모아 읽기가 끝난 뒤에** 읽는다 — 동시에 하면 경주가 되어
    //    개별 왕복이 그대로 난다 (실측으로 물렸다).
    _batchPreload(filePath).then(() => state.getContent(filePath)).catch(() => {
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
    // Safety: never cache empty body over existing content (prevents data loss)
    if ((!body || body.trim().length === 0)) {
      const existing = get().cache.get(filePath);
      if (existing && existing.body && existing.body.trim().length > 0) {
        console.warn('[ContentCache] updateContent BLOCKED: refusing to overwrite non-empty body with empty content for', filePath.split(/[/\\]/).pop());
        return;
      }
    }

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

      // Validate entries: remove corrupted ones (null frontmatter with no body)
      const validEntries: Record<string, PersistentCacheEntry> = {};
      let removedCount = 0;
      for (const [path, entry] of Object.entries(parsed.entries)) {
        if (entry && entry.mtime > 0) {
          validEntries[path] = entry;
        } else {
          removedCount++;
        }
      }
      parsed.entries = validEntries;

      const entryCount = Object.keys(validEntries).length;
      const elapsed = performance.now() - loadStart;
      log(`[ContentCache] Loaded persistent cache: ${entryCount} entries in ${elapsed.toFixed(0)}ms${removedCount > 0 ? ` (removed ${removedCount} corrupted)` : ''}`);

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
        // Skip entries with no frontmatter and empty body (corrupted)
        if (!content.frontmatter && (!content.body || content.body.trim().length === 0)) return;
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

      // 🔴 **묶음을 한 왕복으로 읽는다** (2026-08-30). 여기가 컨테이너를
      //    누를 때 `read_file` 이 141번 날아가던 자리다 — `BATCH_SIZE` 로
      //    나누기는 했지만 **묶음 안에서 파일마다 따로** 불렀다.
      //    서버 안에서는 왕복이 0ms 라 안 보이고, 사람은 Tailscale 너머라
      //    왕복 20ms × 141 = 2.8초를 낸다.
      //    ⚠️ `read_files` 가 없거나 터지면 **옛 길로 돌아간다** — 새 부품이
      //       옛 기능을 망가뜨리면 안 된다.
      let _bulk: Map<string, FileContent> | null = null;
      try {
        const rows = await fileCommands.readFiles(batch);
        _bulk = new Map(rows.filter(r => r.ok && r.file).map(r => [r.path, r.file as FileContent]));
      } catch {
        _bulk = null;
      }

      await Promise.all(
        batch.map(async (filePath) => {
          try {
            const rawContent = _bulk?.get(filePath) ?? await fileCommands.readFile(filePath);
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
