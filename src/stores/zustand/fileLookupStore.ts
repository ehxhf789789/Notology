/**
 * File Lookup Index Store
 *
 * Optimized O(1) file lookups for wiki-link resolution.
 * Instead of traversing the entire file tree (O(n)) for every link,
 * we maintain pre-computed lookup maps that update incrementally.
 *
 * Performance improvement: 50+ wiki-links per note × O(n) traversal = O(50n)
 * With index: 50+ lookups × O(1) = O(50)
 *
 * For a vault with 1000 files and 50 links per note:
 * - Before: ~50,000 node visits per keystroke
 * - After: ~50 hash lookups per keystroke
 */

import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import type { FileNode } from '../../types';

// Conditional logging
const DEV = import.meta.env.DEV;
const log = DEV ? console.log.bind(console) : () => {};

// Normalize Unicode string for consistent comparison (NFC for Windows/Linux, NFD for macOS)
// This ensures filenames with Korean characters match regardless of how they were encoded
function normalizeFileName(name: string): string {
  return name.normalize('NFC').toLowerCase();
}

interface FileLookupIndex {
  // Primary lookups (case-insensitive keys)
  byName: Map<string, string>;           // fileName.toLowerCase() → fullPath
  byNameNoExt: Map<string, string>;      // fileNameWithoutExtension.toLowerCase() → fullPath
  byTitle: Map<string, string>;          // noteTitle.toLowerCase() → fullPath

  // Secondary lookups for attachments
  attachmentPaths: Set<string>;          // Set of all attachment paths
  notePaths: Set<string>;                // Set of all note paths
  folderPaths: Set<string>;              // Set of all folder paths

  // _att folder lookups (O(1) for attachment resolution)
  // Maps _att folder path → Map of (fileNameLower → fullPath)
  attFolderContents: Map<string, Map<string, string>>;

  // Reverse lookup
  pathToName: Map<string, string>;       // fullPath → fileName

  // Note counts per folder (cached)
  noteCountByFolder: Map<string, number>; // folderPath → noteCount
}

interface FileLookupState {
  index: FileLookupIndex;
  version: number;  // Incremented on each rebuild for cache invalidation
  lastBuildTime: number;

  // Actions
  rebuildIndex: (fileTree: FileNode[]) => void;
  incrementalUpdate: (added: FileNode[], removed: string[]) => void;

  // Fast lookups
  resolveNotePath: (name: string) => string | null;
  resolveAttachmentPath: (name: string, basePath?: string) => string | null;
  isNote: (path: string) => boolean;
  isAttachment: (path: string) => boolean;
  getNoteCount: (folderPath: string) => number;

  // _att folder specific lookups (O(1))
  isInAttFolder: (fileName: string, noteStemPath: string) => boolean;
  resolveInAttFolder: (fileName: string, noteStemPath: string) => string | null;
}

function createEmptyIndex(): FileLookupIndex {
  return {
    byName: new Map(),
    byNameNoExt: new Map(),
    byTitle: new Map(),
    attachmentPaths: new Set(),
    notePaths: new Set(),
    folderPaths: new Set(),
    attFolderContents: new Map(),
    pathToName: new Map(),
    noteCountByFolder: new Map(),
  };
}

// Image and common attachment extensions
const ATTACHMENT_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico', '.tiff', '.tif',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.hwp', '.hwpx', '.pages', '.key', '.odt', '.odp', '.ods',  // Korean/Mac/ODF documents
  '.zip', '.rar', '.7z', '.tar', '.gz', '.bz2', '.xz', '.zst',
  '.mp3', '.mp4', '.wav', '.avi', '.mov', '.mkv', '.ogg', '.flac', '.webm',
  '.vcf', '.vcard', '.ics', '.eml', '.msg',  // contact/calendar/email files
  '.txt', '.csv', '.rtf',          // text files
  '.json', '.xml', '.yaml', '.yml', '.toml',  // data files
  '.py', '.js', '.ts', '.jsx', '.tsx', '.rs', '.go', '.java', '.c', '.cpp', '.h',  // code files
]);

function isAttachmentFile(name: string): boolean {
  const ext = name.substring(name.lastIndexOf('.')).toLowerCase();
  return ATTACHMENT_EXTENSIONS.has(ext);
}

export const useFileLookupStore = create<FileLookupState>()(
  subscribeWithSelector((set, get) => ({
    index: createEmptyIndex(),
    version: 0,
    lastBuildTime: 0,

    // Full rebuild from file tree
    rebuildIndex: (fileTree: FileNode[]) => {
      const startTime = performance.now();
      const index = createEmptyIndex();
      const noteCountMap = new Map<string, number>();

      // Single-pass tree traversal with stack (avoids recursion overhead)
      const stack: Array<{ node: FileNode; parentPath: string }> =
        fileTree.map(n => ({ node: n, parentPath: '' }));

      while (stack.length > 0) {
        const { node, parentPath } = stack.pop()!;
        const normalizedPath = node.path.replace(/\\/g, '/');
        const nameLower = node.name.toLowerCase();

        if (node.is_dir) {
          // Folder
          index.folderPaths.add(normalizedPath);

          // Check if this is an _att folder (attachment folder for a note)
          if (node.name.endsWith('_att') && node.children) {
            // Build O(1) lookup for files in this _att folder
            const attContents = new Map<string, string>();
            for (const child of node.children) {
              if (!child.is_dir) {
                const childPath = child.path.replace(/\\/g, '/');
                // Store both exact name and name without .md extension
                // Use Unicode normalization for consistent matching with Korean filenames
                attContents.set(normalizeFileName(child.name), childPath);
                if (child.name.toLowerCase().endsWith('.md')) {
                  attContents.set(normalizeFileName(child.name.slice(0, -3)), childPath);
                }
              }
            }
            // Key: note stem path (e.g., /path/to/note → /path/to/note_att)
            // We store by the _att folder path for direct lookup
            index.attFolderContents.set(normalizedPath.toLowerCase(), attContents);
          }

          // Add children to stack
          if (node.children) {
            for (const child of node.children) {
              stack.push({ node: child, parentPath: normalizedPath });
            }
          }
        } else {
          // File
          index.pathToName.set(normalizedPath, node.name);

          if (node.name.endsWith('.md')) {
            // Note file
            index.notePaths.add(normalizedPath);
            index.byName.set(nameLower, normalizedPath);

            // Name without extension
            const nameNoExt = nameLower.slice(0, -3);
            index.byNameNoExt.set(nameNoExt, normalizedPath);

            // Title (replace underscores with spaces)
            const title = nameNoExt.replace(/_/g, ' ');
            if (title !== nameNoExt) {
              index.byTitle.set(title, normalizedPath);
            }

            // Increment note count for parent folder
            if (parentPath) {
              noteCountMap.set(parentPath, (noteCountMap.get(parentPath) || 0) + 1);
            }
          } else if (isAttachmentFile(node.name)) {
            // Attachment file
            index.attachmentPaths.add(normalizedPath);
            index.byName.set(nameLower, normalizedPath);
          }
        }
      }

      // Propagate note counts up the folder hierarchy
      // Sort folders by depth (deepest first) for bottom-up propagation
      const foldersByDepth = Array.from(index.folderPaths)
        .sort((a, b) => b.split('/').length - a.split('/').length);

      for (const folderPath of foldersByDepth) {
        const directCount = noteCountMap.get(folderPath) || 0;

        // Sum counts from immediate child folders
        let childCount = 0;
        for (const [childPath, count] of noteCountMap) {
          if (childPath.startsWith(folderPath + '/') &&
              childPath.indexOf('/', folderPath.length + 1) === -1) {
            // Direct child folder
            childCount += count;
          }
        }

        const totalCount = directCount + childCount;
        if (totalCount > 0) {
          index.noteCountByFolder.set(folderPath, totalCount);

          // Propagate to parent
          const parentPath = folderPath.substring(0, folderPath.lastIndexOf('/'));
          if (parentPath) {
            noteCountMap.set(parentPath, (noteCountMap.get(parentPath) || 0) + totalCount);
          }
        }
      }

      const buildTime = performance.now() - startTime;
      log(`[FileLookup] Index rebuilt in ${buildTime.toFixed(1)}ms - ${index.notePaths.size} notes, ${index.attachmentPaths.size} attachments`);

      set({
        index,
        version: get().version + 1,
        lastBuildTime: buildTime,
      });
    },

    // Incremental update (for file watching)
    incrementalUpdate: (added: FileNode[], removed: string[]) => {
      const { index } = get();

      // Remove old entries
      for (const path of removed) {
        const normalizedPath = path.replace(/\\/g, '/');
        const name = index.pathToName.get(normalizedPath);
        if (name) {
          const nameLower = name.toLowerCase();
          index.byName.delete(nameLower);
          index.byNameNoExt.delete(nameLower.replace(/\.md$/, ''));
          index.pathToName.delete(normalizedPath);
        }
        index.notePaths.delete(normalizedPath);
        index.attachmentPaths.delete(normalizedPath);
      }

      // Add new entries
      for (const node of added) {
        const normalizedPath = node.path.replace(/\\/g, '/');
        const nameLower = node.name.toLowerCase();

        if (!node.is_dir) {
          index.pathToName.set(normalizedPath, node.name);

          if (node.name.endsWith('.md')) {
            index.notePaths.add(normalizedPath);
            index.byName.set(nameLower, normalizedPath);
            index.byNameNoExt.set(nameLower.slice(0, -3), normalizedPath);
          } else if (isAttachmentFile(node.name)) {
            index.attachmentPaths.add(normalizedPath);
            index.byName.set(nameLower, normalizedPath);
          }
        }
      }

      set({ version: get().version + 1 });
    },

    // O(1) note path resolution
    resolveNotePath: (name: string): string | null => {
      const { index } = get();
      const nameLower = name.toLowerCase();

      // Try exact match with extension
      if (nameLower.endsWith('.md')) {
        return index.byName.get(nameLower) || null;
      }

      // Try without extension
      let path = index.byNameNoExt.get(nameLower);
      if (path) return path;

      // Try with extension added
      path = index.byName.get(nameLower + '.md');
      if (path) return path;

      // Try title match (underscores as spaces)
      path = index.byTitle.get(nameLower);
      if (path) return path;

      // Try title with underscores replaced
      path = index.byTitle.get(nameLower.replace(/_/g, ' '));
      if (path) return path;

      return null;
    },

    // O(1) attachment path resolution
    resolveAttachmentPath: (name: string, basePath?: string): string | null => {
      const { index } = get();
      const nameLower = name.toLowerCase();

      // If basePath provided, try to find in note's _att folder first
      if (basePath) {
        const normalizedBase = basePath.replace(/\\/g, '/');
        const noteStem = normalizedBase.replace(/\.md$/i, '');
        const attFolderPath = (noteStem + '_att').toLowerCase();
        const attContents = index.attFolderContents.get(attFolderPath);
        if (attContents) {
          const resolved = attContents.get(nameLower);
          if (resolved) return resolved;
        }

        // Try in same folder
        const baseDir = normalizedBase.substring(0, normalizedBase.lastIndexOf('/'));
        const localPath = `${baseDir}/${name}`.replace(/\\/g, '/');
        if (index.attachmentPaths.has(localPath)) {
          return localPath;
        }

        // Try in attachments subfolder
        const attPath = `${baseDir}/attachments/${name}`.replace(/\\/g, '/');
        if (index.attachmentPaths.has(attPath)) {
          return attPath;
        }
      }

      // Fall back to global name lookup
      return index.byName.get(nameLower) || null;
    },

    // O(1) type checks
    isNote: (path: string): boolean => {
      return get().index.notePaths.has(path.replace(/\\/g, '/'));
    },

    isAttachment: (path: string): boolean => {
      return get().index.attachmentPaths.has(path.replace(/\\/g, '/'));
    },

    // O(1) note count lookup
    getNoteCount: (folderPath: string): number => {
      return get().index.noteCountByFolder.get(folderPath.replace(/\\/g, '/')) || 0;
    },

    // O(1) check if file exists in a note's _att folder
    // noteStemPath: full path to note without .md extension (e.g., /path/to/note)
    // Attachment folder is noteStemPath + '_att' (e.g., /path/to/note_att)
    isInAttFolder: (fileName: string, noteStemPath: string): boolean => {
      const { index } = get();
      const attFolderPath = (noteStemPath + '_att').replace(/\\/g, '/').toLowerCase();
      const attContents = index.attFolderContents.get(attFolderPath);
      if (!attContents) return false;
      // Use Unicode normalization for consistent matching with Korean filenames
      return attContents.has(normalizeFileName(fileName));
    },

    // O(1) resolve file path in a note's _att folder
    resolveInAttFolder: (fileName: string, noteStemPath: string): string | null => {
      const { index } = get();
      const attFolderPath = (noteStemPath + '_att').replace(/\\/g, '/').toLowerCase();
      const attContents = index.attFolderContents.get(attFolderPath);
      if (!attContents) return null;
      // Use Unicode normalization for consistent matching with Korean filenames
      return attContents.get(normalizeFileName(fileName)) || null;
    },
  }))
);

// Export actions for use outside React
export const fileLookupActions = {
  rebuildIndex: (fileTree: FileNode[]) =>
    useFileLookupStore.getState().rebuildIndex(fileTree),
  incrementalUpdate: (added: FileNode[], removed: string[]) =>
    useFileLookupStore.getState().incrementalUpdate(added, removed),
  resolveNotePath: (name: string) =>
    useFileLookupStore.getState().resolveNotePath(name),
  resolveAttachmentPath: (name: string, basePath?: string) =>
    useFileLookupStore.getState().resolveAttachmentPath(name, basePath),
  isNote: (path: string) =>
    useFileLookupStore.getState().isNote(path),
  isAttachment: (path: string) =>
    useFileLookupStore.getState().isAttachment(path),
  getNoteCount: (folderPath: string) =>
    useFileLookupStore.getState().getNoteCount(folderPath),
  // O(1) _att folder lookups
  isInAttFolder: (fileName: string, noteStemPath: string) =>
    useFileLookupStore.getState().isInAttFolder(fileName, noteStemPath),
  resolveInAttFolder: (fileName: string, noteStemPath: string) =>
    useFileLookupStore.getState().resolveInAttFolder(fileName, noteStemPath),
};

// Selector hooks
export const useFileLookupVersion = () =>
  useFileLookupStore((s) => s.version);

export const useResolveNotePath = () =>
  useFileLookupStore((s) => s.resolveNotePath);

export const useResolveAttachmentPath = () =>
  useFileLookupStore((s) => s.resolveAttachmentPath);

export const useGetNoteCount = () =>
  useFileLookupStore((s) => s.getNoteCount);
