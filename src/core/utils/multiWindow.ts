/**
 * Multi-window utilities for Tauri WebviewWindow management
 */
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { invoke } from '@tauri-apps/api/core';
import { emit } from '@tauri-apps/api/event';

// Track open hover windows: label -> { webview, filePath }
const openWindows = new Map<string, { webview: WebviewWindow; filePath: string }>();

// In-flight open requests keyed by normalized file path. Without this, a
// fast double-click (or two listeners on the same chip) can both pass the
// `openWindows` dedup check before either has called `openWindows.set()`,
// causing two `create_hover_window` invocations with different labels.
// Manifestation: log shows two `hover-<hash>-N` / `hover-<hash>-N+1` windows
// for the same file path at the same timestamp.
const openInFlight = new Map<string, Promise<WebviewWindow | null>>();

// Counter for unique window IDs
let windowCounter = 0;

// Track cascade position for diagonal offset effect
let cascadeIndex = 0;
const WINDOW_CASCADE_OFFSET = 30; // Pixels to offset each new window diagonally
const WINDOW_CASCADE_MAX = 8; // Reset cascade after this many windows

/**
 * Simple hash function for creating window labels from file paths
 * Handles Unicode characters properly
 */
function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  // Convert to alphanumeric string
  return Math.abs(hash).toString(36);
}

/**
 * Get a unique window label for a file path
 * Uses simple hash to create safe window labels (alphanumeric only)
 */
function getWindowLabel(filePath: string): string {
  const hash = simpleHash(filePath);
  return `hover-${hash}-${++windowCounter}`;
}

/**
 * Get file name from path for window title
 * Removes extension and replaces underscores with spaces
 */
function getFileName(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const parts = normalized.split('/');
  let fileName = parts[parts.length - 1] || 'Untitled';
  // Remove extension
  const lastDot = fileName.lastIndexOf('.');
  if (lastDot > 0) {
    fileName = fileName.substring(0, lastDot);
  }
  // Replace underscores with spaces for taskbar display
  return fileName.replace(/_/g, ' ');
}

/**
 * Detect file type for icon selection
 * Maps file extensions to general categories for taskbar icons
 */
function detectFileType(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() || '';
  if (/^(pdf)$/.test(ext)) return 'PDF';
  if (/^(png|jpg|jpeg|gif|webp|svg|bmp|ico)$/.test(ext)) return 'IMAGE';
  if (/^(json|py|js|ts|jsx|tsx|css|html|xml|yaml|yml|toml|rs|go|java|c|cpp|h|hpp|cs|rb|php|sh|bash|zsh|sql|lua|r|swift|kt|scala|zig|vue|svelte|astro|ini|conf|cfg|env)$/.test(ext)) return 'CODE';
  if (/^https?:\/\//i.test(path)) return 'WEB';
  // For .md files, return empty string - caller should provide noteType
  return '';
}

/**
 * Open a file in a new hover window
 * Creates a new Tauri WebviewWindow for the file
 * @param filePath - Full path to the file
 * @param vaultPath - Optional vault path for resolving links
 * @param noteType - Optional note type for taskbar icon (e.g., 'MTG', 'EVENT', 'NOTE')
 */
export async function openHoverWindow(filePath: string, vaultPath?: string, noteType?: string): Promise<WebviewWindow | null> {
  const normalizedPath = normalizePath(filePath);

  // Dedupe in-flight opens for the same file. Two fast clicks (or two
  // listeners firing on the same chip) both pass the openWindows check
  // before either registers, otherwise. See `openInFlight` comment above.
  const pending = openInFlight.get(normalizedPath);
  if (pending) return pending;

  const job = (async (): Promise<WebviewWindow | null> => {
  try {
    // Check if already open for this file path (normalize for comparison)
    for (const [label, entry] of openWindows) {
      if (normalizePath(entry.filePath) === normalizedPath) {
        try {
          // HanBin 2026-05-14: restore from minimized BEFORE focusing.
          // `setFocus()` on Windows is a no-op when the target window is
          // in the SW_MINIMIZE state — the user would click "새노트" in
          // the main window again and see no visible change (the hover
          // stays in the taskbar). `unminimize()` + `show()` + `setFocus()`
          // covers the three states: minimized / hidden / visible-blurred.
          const minimized = await entry.webview.isMinimized().catch(() => false);
          if (minimized) {
            await entry.webview.unminimize();
          }
          const visible = await entry.webview.isVisible().catch(() => true);
          if (!visible) {
            await entry.webview.show();
          }
          await entry.webview.setFocus();
          return entry.webview;
        } catch {
          // Window was destroyed, remove stale entry and create new one
          openWindows.delete(label);
          break;
        }
      }
    }

    const label = getWindowLabel(filePath);
    const fileName = getFileName(filePath);

    // Encode file path and vault path for URL parameters (handles Unicode)
    const encodedPath = encodeURIComponent(filePath);
    const encodedVault = vaultPath ? encodeURIComponent(vaultPath) : '';

    // Build URL with resolved theme (resolve 'system' to actual light/dark for Rust native bg)
    const rawTheme = document.documentElement.dataset.theme
      || (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
    const resolvedTheme = rawTheme === 'system'
      ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      : rawTheme;
    let url = `/?hover=true&path=${encodedPath}&theme=${resolvedTheme}`;
    if (encodedVault) {
      url += `&vault=${encodedVault}`;
    }

    // Calculate cascade position for diagonal offset
    // This prevents windows from stacking exactly on top of each other
    const windowWidth = 900;
    const windowHeight = 700;
    const screenWidth = window.screen.availWidth;
    const screenHeight = window.screen.availHeight;

    // Calculate base center position
    const baseCenterX = Math.round((screenWidth - windowWidth) / 2);
    const baseCenterY = Math.round((screenHeight - windowHeight) / 2);

    // Apply cascade offset (diagonal offset from center)
    const offset = cascadeIndex * WINDOW_CASCADE_OFFSET;
    const x = baseCenterX + offset;
    const y = baseCenterY + offset;

    // Increment cascade index, reset if reaching max or going off-screen
    cascadeIndex = (cascadeIndex + 1) % WINDOW_CASCADE_MAX;

    // Clamp to screen bounds
    const finalX = Math.max(50, Math.min(x, screenWidth - windowWidth - 50));
    const finalY = Math.max(50, Math.min(y, screenHeight - windowHeight - 50));

    // Create window via Rust command (Rust parses theme from URL for native background_color)
    await invoke('create_hover_window', {
      label,
      url,
      title: fileName,
      x: finalX,
      y: finalY,
      width: windowWidth,
      height: windowHeight,
    });

    // Get the WebviewWindow instance after creation
    const webview = await WebviewWindow.getByLabel(label);
    if (!webview) {
      throw new Error('Failed to get window after creation');
    }

    // Track the window
    openWindows.set(label, { webview, filePath });

    // Listen for window close
    webview.onCloseRequested(async () => {
      openWindows.delete(label);
    });

    // Set window icon based on note type (non-blocking)
    const iconType = noteType || detectFileType(filePath) || 'NOTE';
    invoke('set_window_icon', { windowLabel: label, noteType: iconType }).catch((err) => {
      console.warn('[multiWindow] Failed to set window icon:', err);
    });

    return webview;
  } catch (error) {
    console.error('[multiWindow] Failed to open hover window:', error);
    return null;
  }
  })();

  openInFlight.set(normalizedPath, job);
  try {
    return await job;
  } finally {
    openInFlight.delete(normalizedPath);
  }
}

/**
 * Normalize file path for comparison (handle Windows path separators and case)
 */
function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').toLowerCase();
}

/**
 * Close a hover window by file path
 * Uses both local tracking and global event emission to ensure window is closed
 */
export async function closeHoverWindow(filePath: string): Promise<void> {
  const normalizedPath = normalizePath(filePath);

  // First, try to close from our tracked windows
  for (const [label, entry] of openWindows) {
    if (normalizePath(entry.filePath) === normalizedPath) {
      try {
        await entry.webview.close();
      } catch {
        // Window might already be closed
      }
      openWindows.delete(label);
    }
  }

  // Emit a global event for hover windows to check and close themselves
  // This handles windows that weren't tracked in the main window's Map
  try {
    await emit('file-deleted', { filePath, normalizedPath });
  } catch {
    // Event emission might fail
  }
}

/**
 * Close all hover windows
 */
export async function closeAllHoverWindows(): Promise<void> {
  const promises: Promise<void>[] = [];
  for (const [label, entry] of openWindows) {
    promises.push(
      entry.webview.close().catch(() => {}).finally(() => {
        openWindows.delete(label);
      })
    );
  }
  await Promise.all(promises);
}

/**
 * Get count of open hover windows
 */
export function getOpenWindowCount(): number {
  return openWindows.size;
}

/**
 * Check if running in main window
 */
export function isMainWindow(): boolean {
  return getCurrentWindow().label === 'main';
}

/**
 * Check if running in hover window
 */
export function isHoverWindow(): boolean {
  return getCurrentWindow().label.startsWith('hover-');
}
