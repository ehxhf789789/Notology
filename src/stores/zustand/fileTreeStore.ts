import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import { fileCommands } from '../../services/tauriCommands';
import type { FileNode } from '../../types';
import { contentCacheActions } from './contentCacheStore';
import { fileLookupActions } from './fileLookupStore';

// Extract all .md file paths from file tree
function extractMdFilePaths(nodes: FileNode[]): string[] {
  const paths: string[] = [];
  for (const node of nodes) {
    if (!node.is_dir && node.name.endsWith('.md')) {
      paths.push(node.path);
    }
    if (node.children) {
      paths.push(...extractMdFilePaths(node.children));
    }
  }
  return paths;
}

interface FileTreeState {
  // State
  fileTree: FileNode[];
  selectedContainer: string | null;
  vaultPath: string | null;

  // Actions
  setFileTree: (tree: FileNode[]) => void;
  setSelectedContainer: (path: string | null) => void;
  setVaultPath: (path: string | null) => void;
  refreshFileTree: () => Promise<void>;
  clearAll: () => void;

  // Selectors
  findNodeByPath: (path: string) => FileNode | undefined;
}

// Helper function to find node by path recursively
function findNode(nodes: FileNode[], targetPath: string): FileNode | undefined {
  for (const node of nodes) {
    if (node.path === targetPath) return node;
    if (node.children) {
      const found = findNode(node.children, targetPath);
      if (found) return found;
    }
  }
  return undefined;
}

export const useFileTreeStore = create<FileTreeState>()(
  subscribeWithSelector((set, get) => ({
    // Initial state
    fileTree: [],
    selectedContainer: null,
    vaultPath: null,

    // Set file tree (also rebuilds file lookup index for O(1) lookups)
    setFileTree: (tree: FileNode[]) => {
      set({ fileTree: tree });
      // Rebuild file lookup index synchronously so newly inserted wikilinks
      // can resolve against the updated index immediately (e.g. after drag-drop)
      fileLookupActions.rebuildIndex(tree);
    },

    // Set selected container
    setSelectedContainer: (path: string | null) => {
      set({ selectedContainer: path });
    },

    // Set vault path
    setVaultPath: (path: string | null) => {
      set({ vaultPath: path });
    },

    // Refresh file tree from disk
    refreshFileTree: async () => {
      const { vaultPath, selectedContainer } = get();
      if (!vaultPath) return;
      try {
        const tree = await fileCommands.readDirectory(vaultPath);
        // Use setFileTree to also rebuild the file lookup index synchronously
        get().setFileTree(tree);
        // Validate selectedContainer still exists (handles external rename/delete via Synology sync)
        if (selectedContainer && !findNode(tree, selectedContainer)) {
          set({ selectedContainer: null });
        }
      } catch (e) {
        console.error('Failed to refresh file tree:', e);
      }
    },

    // Clear all state (used when closing vault)
    clearAll: () => {
      set({ fileTree: [], selectedContainer: null, vaultPath: null });
    },

    // Find node by path
    findNodeByPath: (path: string) => findNode(get().fileTree, path),
  }))
);

// Optimized selector hooks
export const useFileTree = () =>
  useFileTreeStore((state) => state.fileTree);

export const useSelectedContainer = () =>
  useFileTreeStore((state) => state.selectedContainer);

export const useVaultPath = () =>
  useFileTreeStore((state) => state.vaultPath);

// Actions (stable references - can be called outside React)
export const fileTreeActions = {
  setFileTree: (tree: FileNode[]) =>
    useFileTreeStore.getState().setFileTree(tree),
  setSelectedContainer: (path: string | null) =>
    useFileTreeStore.getState().setSelectedContainer(path),
  setVaultPath: (path: string | null) =>
    useFileTreeStore.getState().setVaultPath(path),
  refreshFileTree: () =>
    useFileTreeStore.getState().refreshFileTree(),
  clearAll: () =>
    useFileTreeStore.getState().clearAll(),
  findNodeByPath: (path: string) =>
    useFileTreeStore.getState().findNodeByPath(path),
  getFileTree: () =>
    useFileTreeStore.getState().fileTree,
};

// Subscribe to fileTree changes (for components that need ref-based access)
export const subscribeToFileTree = (callback: (tree: FileNode[]) => void) => {
  return useFileTreeStore.subscribe(
    (state) => state.fileTree,
    callback
  );
};

// Auto-start cache warming when fileTree is loaded
// This ensures all notes are cached for instant access
// Uses Obsidian-style persistent cache for fast startup
let warmupScheduled = false;
let currentWarmupVault: string | null = null;
useFileTreeStore.subscribe(
  (state) => ({ fileTree: state.fileTree, vaultPath: state.vaultPath }),
  ({ fileTree, vaultPath }) => {
    // Reset warmup flag when vault changes or closes
    if (vaultPath !== currentWarmupVault) {
      warmupScheduled = false;
      currentWarmupVault = vaultPath;
    }

    if (fileTree.length > 0 && vaultPath && !warmupScheduled) {
      warmupScheduled = true;
      // Start warmup immediately (no delay) for faster perceived performance
      const mdPaths = extractMdFilePaths(fileTree);
      console.log(`[FileTreeStore] Auto-warming cache for ${mdPaths.length} markdown files (vault: ${vaultPath})`);
      // Pass vault path for persistent cache support
      contentCacheActions.warmupCache(mdPaths, vaultPath);
    }
  },
  { equalityFn: (a, b) => a.fileTree === b.fileTree && a.vaultPath === b.vaultPath }
);

