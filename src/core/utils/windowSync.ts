/**
 * Window Synchronization - Real-time state sharing between windows
 * Uses Tauri's event system for IPC between main and hover windows
 */
import { emit, listen, type UnlistenFn } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';

// Event types for window communication
export const WINDOW_EVENTS = {
  FILE_OPENED: 'notology://file-opened',
  FILE_CLOSED: 'notology://file-closed',
  FILE_EDITING: 'notology://file-editing',
  FILE_SAVED: 'notology://file-saved',
  REQUEST_FILE_STATUS: 'notology://request-file-status',
  FILE_STATUS_RESPONSE: 'notology://file-status-response',
  MEMO_CHANGED: 'notology://memo-changed',
  SEARCH_INDEX_UPDATED: 'notology://search-index-updated',
} as const;

// Payload types
export interface FileOpenedPayload {
  filePath: string;
  windowLabel: string;
  timestamp: number;
}

export interface FileClosedPayload {
  filePath: string;
  windowLabel: string;
}

export interface FileEditingPayload {
  filePath: string;
  windowLabel: string;
  isDirty: boolean;
  timestamp: number;
}

export interface FileSavedPayload {
  filePath: string;
  windowLabel: string;
  timestamp: number;
}

export interface FileStatusRequest {
  filePath: string;
  requestingWindow: string;
}

export interface FileStatusResponse {
  filePath: string;
  windowLabel: string;
  isOpen: boolean;
  isDirty: boolean;
  timestamp: number;
}

export interface MemoChangedPayload {
  filePath: string;
  windowLabel: string;
  timestamp: number;
}

export interface SearchIndexUpdatedPayload {
  filePath: string;
  windowLabel: string;
  timestamp: number;
}

// Track which files are open in this window
const localOpenFiles = new Map<string, { isDirty: boolean; lastEdit: number }>();

/**
 * Notify other windows that a file has been opened
 */
export async function notifyFileOpened(filePath: string): Promise<void> {
  const windowLabel = getCurrentWindow().label;
  localOpenFiles.set(filePath, { isDirty: false, lastEdit: Date.now() });

  await emit(WINDOW_EVENTS.FILE_OPENED, {
    filePath,
    windowLabel,
    timestamp: Date.now(),
  } as FileOpenedPayload);
}

/**
 * Notify other windows that a file has been closed
 */
export async function notifyFileClosed(filePath: string): Promise<void> {
  const windowLabel = getCurrentWindow().label;
  localOpenFiles.delete(filePath);

  await emit(WINDOW_EVENTS.FILE_CLOSED, {
    filePath,
    windowLabel,
  } as FileClosedPayload);
}

/**
 * Notify other windows that a file is being edited
 */
export async function notifyFileEditing(filePath: string, isDirty: boolean): Promise<void> {
  const windowLabel = getCurrentWindow().label;
  const existing = localOpenFiles.get(filePath);
  if (existing) {
    existing.isDirty = isDirty;
    existing.lastEdit = Date.now();
  }

  await emit(WINDOW_EVENTS.FILE_EDITING, {
    filePath,
    windowLabel,
    isDirty,
    timestamp: Date.now(),
  } as FileEditingPayload);
}

/**
 * Notify other windows that a file has been saved
 */
export async function notifyFileSaved(filePath: string): Promise<void> {
  const windowLabel = getCurrentWindow().label;
  const existing = localOpenFiles.get(filePath);
  if (existing) {
    existing.isDirty = false;
  }

  await emit(WINDOW_EVENTS.FILE_SAVED, {
    filePath,
    windowLabel,
    timestamp: Date.now(),
  } as FileSavedPayload);
}

/**
 * Request file status from all windows
 */
export async function requestFileStatus(filePath: string): Promise<void> {
  const windowLabel = getCurrentWindow().label;

  await emit(WINDOW_EVENTS.REQUEST_FILE_STATUS, {
    filePath,
    requestingWindow: windowLabel,
  } as FileStatusRequest);
}

/**
 * Notify other windows that memo/todo content has changed
 * Used for cross-window calendar synchronization
 */
export async function notifyMemoChanged(filePath: string): Promise<void> {
  const windowLabel = getCurrentWindow().label;

  await emit(WINDOW_EVENTS.MEMO_CHANGED, {
    filePath,
    windowLabel,
    timestamp: Date.now(),
  } as MemoChangedPayload);
}

/**
 * Notify other windows that search index has been updated
 * Used for cross-window search synchronization
 */
export async function notifySearchIndexUpdated(filePath: string): Promise<void> {
  const windowLabel = getCurrentWindow().label;

  await emit(WINDOW_EVENTS.SEARCH_INDEX_UPDATED, {
    filePath,
    windowLabel,
    timestamp: Date.now(),
  } as SearchIndexUpdatedPayload);
}

/**
 * Callbacks for handling events from other windows
 */
export interface WindowSyncCallbacks {
  onFileOpened?: (payload: FileOpenedPayload) => void;
  onFileClosed?: (payload: FileClosedPayload) => void;
  onFileEditing?: (payload: FileEditingPayload) => void;
  onFileSaved?: (payload: FileSavedPayload) => void;
  onFileStatusRequest?: (payload: FileStatusRequest) => void;
  onFileStatusResponse?: (payload: FileStatusResponse) => void;
  onMemoChanged?: (payload: MemoChangedPayload) => void;
  onSearchIndexUpdated?: (payload: SearchIndexUpdatedPayload) => void;
}

/**
 * Subscribe to window sync events
 * Returns an unsubscribe function
 */
export async function subscribeToWindowSync(callbacks: WindowSyncCallbacks): Promise<UnlistenFn> {
  const currentWindowLabel = getCurrentWindow().label;
  const unlisteners: UnlistenFn[] = [];

  // Listen for file opened events
  if (callbacks.onFileOpened) {
    const unlisten = await listen<FileOpenedPayload>(WINDOW_EVENTS.FILE_OPENED, (event) => {
      // Ignore events from our own window
      if (event.payload.windowLabel !== currentWindowLabel) {
        callbacks.onFileOpened!(event.payload);
      }
    });
    unlisteners.push(unlisten);
  }

  // Listen for file closed events
  if (callbacks.onFileClosed) {
    const unlisten = await listen<FileClosedPayload>(WINDOW_EVENTS.FILE_CLOSED, (event) => {
      if (event.payload.windowLabel !== currentWindowLabel) {
        callbacks.onFileClosed!(event.payload);
      }
    });
    unlisteners.push(unlisten);
  }

  // Listen for file editing events
  if (callbacks.onFileEditing) {
    const unlisten = await listen<FileEditingPayload>(WINDOW_EVENTS.FILE_EDITING, (event) => {
      if (event.payload.windowLabel !== currentWindowLabel) {
        callbacks.onFileEditing!(event.payload);
      }
    });
    unlisteners.push(unlisten);
  }

  // Listen for file saved events
  if (callbacks.onFileSaved) {
    const unlisten = await listen<FileSavedPayload>(WINDOW_EVENTS.FILE_SAVED, (event) => {
      if (event.payload.windowLabel !== currentWindowLabel) {
        callbacks.onFileSaved!(event.payload);
      }
    });
    unlisteners.push(unlisten);
  }

  // Listen for file status requests
  if (callbacks.onFileStatusRequest) {
    const unlisten = await listen<FileStatusRequest>(WINDOW_EVENTS.REQUEST_FILE_STATUS, (event) => {
      if (event.payload.requestingWindow !== currentWindowLabel) {
        callbacks.onFileStatusRequest!(event.payload);

        // Auto-respond with our file status
        const fileInfo = localOpenFiles.get(event.payload.filePath);
        if (fileInfo) {
          emit(WINDOW_EVENTS.FILE_STATUS_RESPONSE, {
            filePath: event.payload.filePath,
            windowLabel: currentWindowLabel,
            isOpen: true,
            isDirty: fileInfo.isDirty,
            timestamp: fileInfo.lastEdit,
          } as FileStatusResponse);
        }
      }
    });
    unlisteners.push(unlisten);
  }

  // Listen for file status responses
  if (callbacks.onFileStatusResponse) {
    const unlisten = await listen<FileStatusResponse>(WINDOW_EVENTS.FILE_STATUS_RESPONSE, (event) => {
      if (event.payload.windowLabel !== currentWindowLabel) {
        callbacks.onFileStatusResponse!(event.payload);
      }
    });
    unlisteners.push(unlisten);
  }

  // Listen for memo changed events (cross-window calendar sync)
  if (callbacks.onMemoChanged) {
    const unlisten = await listen<MemoChangedPayload>(WINDOW_EVENTS.MEMO_CHANGED, (event) => {
      if (event.payload.windowLabel !== currentWindowLabel) {
        callbacks.onMemoChanged!(event.payload);
      }
    });
    unlisteners.push(unlisten);
  }

  // Listen for search index updated events (cross-window search sync)
  if (callbacks.onSearchIndexUpdated) {
    const unlisten = await listen<SearchIndexUpdatedPayload>(WINDOW_EVENTS.SEARCH_INDEX_UPDATED, (event) => {
      if (event.payload.windowLabel !== currentWindowLabel) {
        callbacks.onSearchIndexUpdated!(event.payload);
      }
    });
    unlisteners.push(unlisten);
  }

  // Return combined unsubscribe function
  return () => {
    unlisteners.forEach(unlisten => unlisten());
  };
}

/**
 * Check if a file is open in the current window
 */
export function isFileOpenLocally(filePath: string): boolean {
  return localOpenFiles.has(filePath);
}

/**
 * Get local file status
 */
export function getLocalFileStatus(filePath: string): { isDirty: boolean; lastEdit: number } | null {
  return localOpenFiles.get(filePath) || null;
}
