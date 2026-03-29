import { fileCommands } from '../services/tauriCommands';
import { join } from '@tauri-apps/api/path';

// Default animation snippet that will be created if none exists
const DEFAULT_ANIMATIONS_CSS = `/* Notology Animation Snippets
 * Customize animations for sidebar, hover windows, and panels
 * GPU-accelerated with will-change for optimal performance
 */

/* ============================================================ */
/* Sidebar Slide Animations                                      */
/* ============================================================ */

/* Override animation duration (default: 0.12s for opening, 0.1s for closing) */
/*
.sidebar-wrapper.opening > .sidebar {
  animation-duration: 0.15s;
}

.sidebar-wrapper.closing > .sidebar {
  animation-duration: 0.12s;
}
*/

/* ============================================================ */
/* Hover Panel Slide Animations                                  */
/* ============================================================ */

/* Override animation duration for right panel */
/*
.hover-panel-wrapper.opening > .hover-windows-panel {
  animation-duration: 0.15s;
}

.hover-panel-wrapper.closing > .hover-windows-panel {
  animation-duration: 0.12s;
}
*/

/* ============================================================ */
/* Hover Window Animations                                       */
/* ============================================================ */

/* Custom hover window animations (override defaults in App.css) */
/*
@keyframes hover-window-open {
  0% {
    opacity: 0;
    transform: scale(0.95);
  }
  100% {
    opacity: 1;
    transform: scale(1);
  }
}
*/

/* ============================================================ */
/* Custom Styles                                                 */
/* ============================================================ */

/* Add your custom CSS here */
`;

let snippetStyleElement: HTMLStyleElement | null = null;
let loadedSnippetPaths = new Set<string>();

/**
 * Ensure .notology/snippets directory exists and create default animation snippet
 */
export async function initializeSnippets(vaultPath: string): Promise<void> {
  try {
    const snippetsDir = await join(vaultPath, '.notology', 'snippets');

    // Ensure snippets directory exists
    await fileCommands.ensureDirectory(snippetsDir);

    // Check if default animation snippet exists
    const animationsPath = await join(snippetsDir, 'animations.css');

    try {
      await fileCommands.readTextFile(animationsPath);
      // File exists, don't overwrite
    } catch {
      // File doesn't exist, create it
      await fileCommands.writeFile(animationsPath, null, DEFAULT_ANIMATIONS_CSS);
      console.log('[SnippetLoader] Created default animations.css snippet');
    }
  } catch (error) {
    console.error('[SnippetLoader] Failed to initialize snippets:', error);
  }
}

/**
 * Load all CSS snippets from .notology/snippets/ and apply to document
 * Only loads enabled snippets (*.css files, excludes *.disabled.css)
 */
export async function loadSnippets(vaultPath: string): Promise<void> {
  try {
    const snippetsDir = await join(vaultPath, '.notology', 'snippets');

    // Get all .css files in snippets directory
    let files: string[] = [];
    try {
      files = await fileCommands.listFilesInDirectory(snippetsDir, 'css');
    } catch {
      // Directory might not exist yet
      return;
    }

    // Filter out disabled snippets
    const enabledFiles = files.filter(f => !f.endsWith('.disabled.css'));

    // Create or get style element
    if (!snippetStyleElement) {
      snippetStyleElement = document.createElement('style');
      snippetStyleElement.id = 'notology-snippets';
      document.head.appendChild(snippetStyleElement);
    }

    // Load and concatenate all snippet contents
    let combinedCss = '/* Notology Custom Snippets */\n';

    for (const file of enabledFiles) {
      const filePath = await join(snippetsDir, file);

      try {
        const content = await fileCommands.readTextFile(filePath);
        combinedCss += `\n/* === ${file} === */\n${content}\n`;
        loadedSnippetPaths.add(filePath);
        console.log(`[SnippetLoader] Loaded snippet: ${file}`);
      } catch (error) {
        console.error(`[SnippetLoader] Failed to load snippet ${file}:`, error);
      }
    }

    snippetStyleElement.textContent = combinedCss;
    console.log(`[SnippetLoader] Applied ${enabledFiles.length} snippets`);
  } catch (error) {
    console.error('[SnippetLoader] Failed to load snippets:', error);
  }
}

/**
 * Reload a specific snippet (called when file changes)
 */
export async function reloadSnippet(vaultPath: string, fileName: string): Promise<void> {
  // For now, just reload all snippets
  await loadSnippets(vaultPath);
}

/**
 * Remove all loaded snippets (called when vault changes)
 */
export function clearSnippets(): void {
  if (snippetStyleElement) {
    snippetStyleElement.textContent = '';
    loadedSnippetPaths.clear();
  }
}

/**
 * Check if snippets are loaded
 */
export function hasSnippets(): boolean {
  return loadedSnippetPaths.size > 0;
}
