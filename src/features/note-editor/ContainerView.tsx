import { useAttachmentStore } from '../attachments/stores/attachmentStore';
import { removeOrphanWikiLinkNodes, consumeFailedAdds } from '../attachments/orphanRemoval';
import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import { fileCommands, searchCommands, utilCommands } from '../../core/services/tauriCommands';
import { ChevronLeft } from 'lucide-react';
import {
  useSelectedContainer,
  useFileTree,
  useVaultPath,
  useSearchRefreshTrigger,
  hoverActions,
  fileTreeActions,
  refreshActions,
  modalActions,
  useToolbarDefaultCollapsed,
  noteTypeCacheActions,
} from '../../core/stores/zustand';
import { useContainerConfigs } from '../vault-config/stores/vaultConfigStore';
import { useTemplateStore } from '../templates/stores/templateStore';
import { useNoteTypeCacheStore } from '../content-cache/stores/noteTypeCacheStore';
import { createNote, createFolder, createNoteWithTemplate, createNoteFromTemplateInteractive, selectContainer } from '../../core/stores/appActions';
import { useDropTarget } from '../../core/hooks/useDragDrop';
import { useSlashAttachmentListener } from '../slash-command';
import { EventBus } from '../../core/infrastructure/eventBus';
import { getEditorExtensions } from '../../core/editor/editorConfig';
import { useSettingsStore } from '../../core/stores/settingsStore';
import { t } from '../../core/utils/i18n';
import EditorToolbar from './EditorToolbar';
import EditorBubbleMenu from './EditorBubbleMenu';
import EditorContextMenu from './EditorContextMenu';
import Search from '../search/Search';
import type { FileContent, NoteFrontmatter, NoteMetadata, FileNode } from '../../core/types';
import { parseFrontmatter, serializeFrontmatter, getCurrentTimestamp } from '../../core/utils/frontmatter';
import { markAsSelfSaved } from '../../core/utils/selfSaveTracker';
import { preprocessWikiLinks } from '../../core/utils/wikiLinkPreprocess';

// Check if a folder has a folder note (FolderName/FolderName.md)
function hasFolderNote(node: FileNode): boolean {
  if (!node.is_dir || !node.children) return false;
  if (node.is_folder_note) return true;
  const folderNoteName = `${node.name}.md`;
  return node.children.some(child => !child.is_dir && child.name === folderNoteName);
}

// Recursively find a node by path in the file tree
function findNodeByPath(nodes: FileNode[], targetPath: string): FileNode | undefined {
  for (const node of nodes) {
    if (node.path === targetPath) return node;
    if (node.children) {
      const found = findNodeByPath(node.children, targetPath);
      if (found) return found;
    }
  }
  return undefined;
}

function ContainerView() {
  // ========== ZUSTAND SELECTIVE SUBSCRIPTIONS (prevents cascade re-renders) ==========
  const selectedContainer = useSelectedContainer();
  const fileTree = useFileTree();
  const vaultPath = useVaultPath();
  const searchRefreshTrigger = useSearchRefreshTrigger();
  const language = useSettingsStore(s => s.language);

  // ========== STABLE ACTION REFERENCES (never cause re-renders) ==========
  const openHoverFile = hoverActions.open;
  const refreshFileTree = fileTreeActions.refreshFileTree;
  const incrementSearchRefresh = refreshActions.incrementSearchRefresh;

  // ========== ZUSTAND STORE SUBSCRIPTIONS ==========
  const toolbarDefaultCollapsed = useToolbarDefaultCollapsed();
  const containerConfigs = useContainerConfigs();
  const noteTemplates = useTemplateStore(s => s.noteTemplates);
  const [frontmatter, setFrontmatter] = useState<NoteFrontmatter | null>(null);
  const [body, setBody] = useState('');
  const [isDirty, setIsDirty] = useState(false);
  const [folderNotePath, setFolderNotePath] = useState<string | null>(null);
  const [showNewNote, setShowNewNote] = useState(false);
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [newName, setNewName] = useState('');
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
  const [editorMenuPos, setEditorMenuPos] = useState<{ x: number; y: number } | null>(null);
  // noteTypeCache is managed globally by noteTypeCacheStore (refreshed in App.tsx)
  const isLoadingRef = useRef(false);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevContainerRef = useRef<string | null>(null);
  const noteInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  // Find the folder note path for the container
  const findFolderNote = useCallback((): string | null => {
    if (!selectedContainer) return null;
    const containerNode = findNodeByPath(fileTree, selectedContainer);
    if (!containerNode || !containerNode.children) return null;
    const folderNote = containerNode.children.find(c => c.is_folder_note);
    return folderNote?.path || null;
  }, [selectedContainer, fileTree]);

  // Get root container path for a given path
  const getRootContainerPath = useCallback((containerPath: string | null): string | null => {
    if (!containerPath || !vaultPath) return null;
    const normalizedPath = containerPath.replace(/\\/g, '/');
    const normalizedVault = vaultPath.replace(/\\/g, '/');
    const relativePath = normalizedPath.startsWith(normalizedVault)
      ? normalizedPath.slice(normalizedVault.length + 1)
      : normalizedPath;
    const firstSegment = relativePath.split('/')[0];
    if (!firstSegment) return null;
    return `${normalizedVault}/${firstSegment}`.replace(/\//g, '\\');
  }, [vaultPath]);

  // Check if selected container is inside a Storage container and get its assigned template
  const getStorageTemplateId = useCallback((): string | null => {
    const rootPath = getRootContainerPath(selectedContainer);
    if (!rootPath) return null;

    // Normalize the root path for comparison (case-insensitive, forward slashes)
    const normalizedRoot = rootPath.replace(/\\/g, '/').toLowerCase();

    // Try direct lookup first
    let config = containerConfigs[rootPath];

    // If not found, search with normalized path comparison
    if (!config) {
      for (const [key, value] of Object.entries(containerConfigs)) {
        const normalizedKey = key.replace(/\\/g, '/').toLowerCase();
        if (normalizedKey === normalizedRoot) {
          config = value;
          break;
        }
      }
    }

    if (config?.type === 'storage' && config.assignedTemplateId) {
      return config.assignedTemplateId;
    }
    return null;
  }, [selectedContainer, containerConfigs, getRootContainerPath]);

  // Find parent container path (if the parent folder is also a container)
  const parentContainerPath = useMemo((): string | null => {
    if (!selectedContainer) return null;
    // Get parent path by removing last path component
    const pathParts = selectedContainer.split(/[/\\]/);
    if (pathParts.length <= 1) return null;
    pathParts.pop();
    const parentPath = pathParts.join('\\');
    if (!parentPath) return null;

    // Check if parent is a container (has a folder note)
    const parentNode = findNodeByPath(fileTree, parentPath);
    if (parentNode && hasFolderNote(parentNode)) {
      return parentPath;
    }
    return null;
  }, [selectedContainer, fileTree]);

  // noteTypeCache refresh is handled globally by App.tsx → noteTypeCacheActions.refreshCache()

  const resolveLink = useCallback((fileName: string): boolean => {
    // Track B Phase B-3 (2026-05-12): consult the AttachmentRef index FIRST.
    // Post-migration, attachments live in `.attachments/` (hidden in the file
    // tree per single-surface principle), so the legacy `_att/` walk below
    // can never find them. The store is hydrated on `vault:opened` and
    // refreshed on `attachment:saved`/`attachment:deleted`.
    const attRef = useAttachmentStore.getState().resolveByName(fileName);
    if (attRef) return true;

    // Legacy fallback: walk the `_att` folder of the current note. This stays
    // for vaults that haven't been migrated yet (e.g. still loading) and for
    // notes whose attachments haven't propagated through EventBus yet.
    if (folderNotePath) {
      const noteStem = folderNotePath.replace(/\.md$/i, '');
      const attFolderPath = noteStem + '_att';
      const normalizedAttFolder = attFolderPath.replace(/\\/g, '/').toLowerCase();

      const searchAttFolder = (nodes: typeof fileTree): boolean | null => {
        for (const node of nodes) {
          if (node.is_dir) {
            const normalizedNodePath = node.path.replace(/\\/g, '/').toLowerCase();
            if (normalizedNodePath === normalizedAttFolder) {
              if (node.children) {
                for (const child of node.children) {
                  if (!child.is_dir) {
                    // Match exact name OR name with .md extension added
                    if (child.name === fileName || child.name === fileName + '.md') {
                      return true;
                    }
                  }
                }
              }
              return null; // Found att folder but file not in it
            }
            if (node.children) {
              const result = searchAttFolder(node.children);
              if (result !== false) return result;
            }
          }
        }
        return false; // Haven't found att folder yet
      };

      const attResult = searchAttFolder(fileTree);
      if (attResult === true) return true;
    }

    // For non-attachment links (notes), search globally
    const searchTree = (nodes: typeof fileTree): boolean => {
      for (const node of nodes) {
        if (!node.is_dir && (node.name === fileName || node.name.replace(/\.md$/, '') === fileName)) return true;
        if (node.children && searchTree(node.children)) return true;
      }
      return false;
    };
    return searchTree(fileTree);
  }, [fileTree, folderNotePath]);

  const getNoteType = useCallback((fileName: string): string | null => {
    return noteTypeCacheActions.getNoteType(fileName);
  }, []);

  // Check if a file is an attachment (exists in current note's _att folder)
  // This distinguishes .md attachments from vault notes
  const isAttachment = useCallback((fileName: string): boolean => {
    // Track B Phase B-3: post-migration attachments live in `.attachments/`
    // (hidden from the file tree per single-surface principle). Consult the
    // AttachmentRef index FIRST, then the cross-context pending map (so a
    // drop that's still in flight in another webview also resolves true).
    const store = useAttachmentStore.getState();
    if (store.resolveByName(fileName)) return true;
    if (store.isPending(fileName)) return true;

    if (!folderNotePath) return false;

    const noteStem = folderNotePath.replace(/\.md$/i, '');
    const attFolderPath = noteStem + '_att';
    const normalizedAttFolder = attFolderPath.replace(/\\/g, '/').toLowerCase();

    const searchAttFolder = (nodes: typeof fileTree): boolean => {
      for (const node of nodes) {
        if (node.is_dir) {
          const normalizedNodePath = node.path.replace(/\\/g, '/').toLowerCase();
          if (normalizedNodePath === normalizedAttFolder) {
            if (node.children) {
              for (const child of node.children) {
                if (!child.is_dir) {
                  // Match exact name OR name with .md extension added
                  if (child.name === fileName || child.name === fileName + '.md') {
                    return true;
                  }
                }
              }
            }
            return false;
          }
          if (node.children && searchAttFolder(node.children)) return true;
        }
      }
      return false;
    };
    return searchAttFolder(fileTree);
  }, [fileTree, folderNotePath]);

  const handleLinkClick = useCallback((fileName: string) => {
    let path: string | null = null;

    // Helper to find file in the current note's _att folder
    const findInAttFolder = (nodes: typeof fileTree): string | null => {
      if (!folderNotePath) return null;
      const noteStem = folderNotePath.replace(/\.md$/i, '');
      const attFolderPath = noteStem + '_att';
      const normalizedAttFolder = attFolderPath.replace(/\\/g, '/').toLowerCase();

      const search = (nodes: typeof fileTree): string | null => {
        for (const node of nodes) {
          if (node.is_dir) {
            const normalizedNodePath = node.path.replace(/\\/g, '/').toLowerCase();
            if (normalizedNodePath === normalizedAttFolder) {
              if (node.children) {
                for (const child of node.children) {
                  if (!child.is_dir && child.name === fileName) {
                    return child.path;
                  }
                }
              }
              return null;
            }
            if (node.children) {
              const found = search(node.children);
              if (found) return found;
            }
          }
        }
        return null;
      };
      return search(nodes);
    };

    // Helper to find file globally (for notes)
    const findFileGlobally = (nodes: typeof fileTree): string | null => {
      for (const node of nodes) {
        if (!node.is_dir && (node.name === fileName || node.name.replace(/\.md$/, '') === fileName)) return node.path;
        if (node.children) {
          const found = findFileGlobally(node.children);
          if (found) return found;
        }
      }
      return null;
    };

    // First, check if the file is an attachment (exists in current note's _att folder)
    path = findInAttFolder(fileTree);

    // If not found in _att folder, search globally (for notes)
    if (!path) {
      path = findFileGlobally(fileTree);
    }

    if (path) {
      const isPreviewable = /\.(md|pdf|png|jpg|jpeg|gif|webp|svg|bmp|ico|json|py|js|ts|jsx|tsx|css|html|xml|yaml|yml|toml|rs|go|java|c|cpp|h|hpp|cs|rb|php|sh|bash|sql|lua|r|swift|kt|scala|csv|doc|docx|ppt|pptx|xls|xlsx|hwp|hwpx)$/i.test(path);
      if (isPreviewable) {
        openHoverFile(path);
      } else {
        utilCommands.openInDefaultApp(path);
      }
    }
  }, [fileTree, openHoverFile, folderNotePath]);

  const handleContextMenu = useCallback((fileName: string, position: { x: number; y: number }, deleteCallback?: () => void) => {
    if (folderNotePath) {
      modalActions.showContextMenu(fileName, position, folderNotePath, undefined, undefined, undefined, deleteCallback);
    }
  }, [folderNotePath]);

  const handleEditorContextMenu = useCallback((pos: { x: number; y: number }) => {
    setEditorMenuPos(pos);
  }, []);

  // Use refs so WikiLink plugin always calls the latest functions
  const resolveLinkRef = useRef(resolveLink);
  resolveLinkRef.current = resolveLink;
  const getNoteTypeRef = useRef(getNoteType);
  getNoteTypeRef.current = getNoteType;
  const isAttachmentRef = useRef(isAttachment);
  isAttachmentRef.current = isAttachment;
  const handleLinkClickRef = useRef(handleLinkClick);
  handleLinkClickRef.current = handleLinkClick;
  const handleContextMenuRef = useRef(handleContextMenu);
  handleContextMenuRef.current = handleContextMenu;
  const handleEditorContextMenuRef = useRef(handleEditorContextMenu);
  handleEditorContextMenuRef.current = handleEditorContextMenu;

  // Keep fileTree ref for WikiLinkSuggestion (getter-based, no extension recreation)
  const fileTreeRef = useRef(fileTree);
  fileTreeRef.current = fileTree;

  // Memoize extensions to prevent recreation on every render
  const extensions = useMemo(() => getEditorExtensions({
    placeholder: 'Container 설명을 입력하세요...',
    onClickLink: (name: string) => handleLinkClickRef.current(name),
    onContextMenu: (name: string, pos: { x: number; y: number }, deleteCallback?: () => void) => handleContextMenuRef.current(name, pos, deleteCallback),
    resolveLink: (name: string) => resolveLinkRef.current(name),
    getNoteType: (name: string) => getNoteTypeRef.current(name),
    isAttachment: (name: string) => isAttachmentRef.current(name),
    onEditorContextMenu: (pos: { x: number; y: number }) => handleEditorContextMenuRef.current(pos),
    getFileTree: () => fileTreeRef.current,
  }), []); // Empty deps - extensions never need recreation

  const editor = useEditor({
    extensions,
    content: '',
    editorProps: {
      attributes: {
        class: 'tiptap-editor container-description-editor',
        spellcheck: 'false',
        // 2026-05-25 (HanBin) — exclude from Tab focus chain. See
        // editorPool.ts for the same rule + rationale.
        tabindex: '-1',
      },
    },
    onUpdate: ({ editor: ed }) => {
      if (isLoadingRef.current) return;
      const markdown = (ed.storage as any).markdown.getMarkdown();
      setBody(markdown);
      setIsDirty(true);

      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = setTimeout(() => {
        saveFile(markdown);
      }, 1000);
    },
  });

  // Refresh decorations when noteTypeCache updates (wiki link icons/colors)
  useEffect(() => {
    if (!editor) return;
    const unsub = useNoteTypeCacheStore.subscribe((state, prev) => {
      if (state.cache !== prev.cache && !editor.isDestroyed) {
        try {
          const { tr } = editor.state;
          tr.setMeta('externalDecorationRefresh', true);
          editor.view.dispatch(tr);
        } catch { /* editor may be transitional */ }
      }
    });
    return unsub;
  }, [editor]);

  // Refresh decorations when fileTree changes (e.g., file deleted → links become unresolved)
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    try {
      const { tr } = editor.state;
      tr.setMeta('fileTreeChanged', true);
      editor.view.dispatch(tr);
    } catch { /* editor may be transitional */ }
  }, [editor, fileTree]);

  const saveFile = useCallback(async (currentBody?: string) => {
    if (!folderNotePath || !frontmatter) return;
    const bodyToSave = currentBody !== undefined ? currentBody : body;

    const updatedFm: NoteFrontmatter = {
      ...frontmatter,
      modified: getCurrentTimestamp(),
    };
    const fmString = serializeFrontmatter(updatedFm);

    try {
      await fileCommands.writeFile(folderNotePath, fmString, bodyToSave);
      setFrontmatter(updatedFm);
      setIsDirty(false);
      // Mark as self-saved to prevent false "external change" warnings
      markAsSelfSaved(folderNotePath);
      // Index the note immediately for instant search updates
      await searchCommands.indexNote(folderNotePath).catch(() => {});
      // Trigger search refresh after successful save
      incrementSearchRefresh();
    } catch (e) {
      console.error('ContainerView: Failed to save:', e);
    }
  }, [folderNotePath, frontmatter, body, incrementSearchRefresh]);

  // Load folder note when container changes
  useEffect(() => {
    const fnPath = findFolderNote();
    setFolderNotePath(fnPath);

    if (!fnPath || selectedContainer === prevContainerRef.current) return;
    prevContainerRef.current = selectedContainer;

    isLoadingRef.current = true;
    fileCommands.readFile(fnPath)
      .then(content => {
        const fm = content.frontmatter ? parseFrontmatter(content.frontmatter) : null;
        setFrontmatter(fm);
        setBody(content.body);
        setIsDirty(false);
        if (editor) {
          editor.commands.setContent(preprocessWikiLinks(content.body || ''));
        }
        setTimeout(() => { isLoadingRef.current = false; }, 50);
      })
      .catch(err => {
        console.error('ContainerView: Failed to load:', err);
        isLoadingRef.current = false;
      });
  }, [selectedContainer, fileTree, editor, findFolderNote]);

  // Refresh decorations when fileTree changes (for wiki-link resolution)
  useEffect(() => {
    if (editor && editor.view) {
      editor.view.dispatch(editor.state.tr);
    }
  }, [fileTree, editor]);

  // Track B Phase B-3: also refresh when the AttachmentRef index changes, so
  // chips re-color (resolved/unresolved) after vault open hydration or after
  // any `attachment:saved`/`attachment:deleted` event.
  const attachmentHydratedAt = useAttachmentStore((s) => s.hydratedAt);
  useEffect(() => {
    if (editor && editor.view && attachmentHydratedAt > 0) {
      editor.view.dispatch(editor.state.tr);
    }
  }, [attachmentHydratedAt, editor]);

  // Track B Phase B-3 PART 6: orphan prevention. When useDragDrop reports
  // that both `attachment_add` and the legacy `import_attachment` fallback
  // rejected, the optimistic chip we just inserted points at nothing on
  // disk and nothing on NAS. Remove it before the user is stranded with
  // a permanent gray ghost. Filter by notePath so a failed drop in another
  // open note doesn't strip chips from this one.
  //
  // Two-stage cleanup (HanBin 2026-05-13):
  //   1. Mount scan: consume any persistent failure entries that landed
  //      while this editor was being remounted (HMR / navigation race).
  //   2. Live subscription: handle failures that happen while we are
  //      mounted.
  useEffect(() => {
    if (!editor || !folderNotePath) return;
    // Stage 1 — drain anything we missed during remount.
    const queued = consumeFailedAdds(folderNotePath);
    if (queued.length > 0) {
      let total = 0;
      for (const fileName of queued) {
        total += removeOrphanWikiLinkNodes(editor, fileName);
      }
      if (total > 0) {
        console.warn(
          `[ContainerView] mount-scan removed ${total} orphan wikilink(s):`,
          queued,
        );
      }
    }
    // Stage 2 — live subscription.
    const off = EventBus.on('attachment:addFailed', ({ fileName, notePath }) => {
      const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase();
      if (norm(notePath) !== norm(folderNotePath)) return;
      const removed = removeOrphanWikiLinkNodes(editor, fileName);
      if (removed > 0) {
        console.warn(
          `[ContainerView] removed ${removed} orphan wikilink(s) for ${fileName} after attachment_add failure`,
        );
      }
    });
    return off;
  }, [editor, folderNotePath]);

  // Save on unmount if dirty
  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (showNewNote && noteInputRef.current) noteInputRef.current.focus();
  }, [showNewNote]);

  useEffect(() => {
    if (showNewFolder && folderInputRef.current) folderInputRef.current.focus();
  }, [showNewFolder]);

  const handleCreateNote = async () => {
    if (!newName.trim() || !selectedContainer) {
      setShowNewNote(false);
      setNewName('');
      setSelectedTemplateId(null);
      return;
    }
    try {
      if (selectedTemplateId) {
        await createNoteWithTemplate(newName.trim(), selectedTemplateId, selectedContainer);
      } else {
        await createNote(newName.trim(), selectedContainer);
      }
      setShowNewNote(false);
      setNewName('');
      setSelectedTemplateId(null);
    } catch (e) {
      console.error('Failed to create note:', e);
    }
  };

  const handleCreateFolder = async () => {
    if (!newName.trim() || !selectedContainer) {
      setShowNewFolder(false);
      setNewName('');
      return;
    }
    try {
      await createFolder(newName.trim(), selectedContainer);
      setShowNewFolder(false);
      setNewName('');
    } catch (e) {
      console.error('Failed to create folder:', e);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent, action: () => void) => {
    if (e.key === 'Enter') action();
    if (e.key === 'Escape') {
      setShowNewNote(false);
      setShowNewFolder(false);
      setNewName('');
    }
  };

  // Drag-drop via Tauri native events
  // Phase B-3 stabilization: importedPaths are now SOURCE basenames passed
  // optimistically — backend processing happens in the background. We dedup
  // against existing wikilinks here so re-dragging the same file into the
  // same note doesn't double-insert.
  const handleFileDrop = useCallback((importedPaths: string[], position?: { x: number; y: number }) => {
    if (!editor) return;

    // Collect every wikilink name already in the doc — case-insensitive set.
    const existingNames = new Set<string>();
    editor.state.doc.descendants((node) => {
      if (node.type.name === 'wikiLink' && typeof node.attrs.fileName === 'string') {
        existingNames.add(node.attrs.fileName.toLowerCase());
      }
    });

    const toInsert: string[] = [];
    let skipped = 0;
    for (const importedPath of importedPaths) {
      const fileName = importedPath.split(/[/\\]/).pop() || '';
      if (!fileName) continue;
      if (existingNames.has(fileName.toLowerCase())) {
        skipped++;
        continue;
      }
      toInsert.push(fileName);
      existingNames.add(fileName.toLowerCase()); // catch dup within same drop batch
    }

    if (skipped > 0) {
      console.info(`[ContainerView] skipped ${skipped} already-attached file(s)`);
    }
    if (toInsert.length === 0) {
      return;
    }

    // Try to find the editor position from drop coordinates
    let insertPos: number | null = null;
    if (position) {
      const dpr = window.devicePixelRatio || 1;
      const cssX = position.x / dpr;
      const cssY = position.y / dpr;
      const posAtCoords = editor.view.posAtCoords({ left: cssX, top: cssY });
      if (posAtCoords) {
        insertPos = posAtCoords.pos;
      }
    }

    const links = toInsert.map((fileName) => `[[${fileName}]]`).join('\n');

    if (insertPos !== null) {
      editor.chain()
        .focus()
        .insertContentAt(insertPos, links + '\n')
        .run();
    } else {
      editor.chain()
        .focus()
        .command(({ tr, state }) => {
          const endPos = state.doc.content.size;
          tr.insertText('\n' + links + '\n', endPos);
          return true;
        })
        .run();
    }
    refreshFileTree();
  }, [editor, refreshFileTree]);

  const dropTargetRef = useDropTarget(
    'container-editor',
    folderNotePath,
    handleFileDrop
  );

  // Stage 5.0.4b-2 part B (2026-05-15): wire the slash palette's "첨부파일"
  // command — opens a file picker, inserts wikilink chip(s) at the cursor,
  // and fires `attachment_add` in the background (same pipeline as drop).
  useSlashAttachmentListener(editor, folderNotePath);

  if (!selectedContainer) return null;

  const containerName = selectedContainer.split(/[/\\]/).pop() || '';

  return (
    <div className="container-view">
      {/* Description Editor */}
      <div className="container-description-section">
        <div className="container-description-header">
          {parentContainerPath && (
            <button
              className="container-parent-btn"
              onClick={() => selectContainer(parentContainerPath)}
              title={t('goToParent', language)}
            >
              <ChevronLeft size={16} />
            </button>
          )}
          <span className="container-description-title">{containerName}</span>
          {isDirty && <span className="container-dirty-indicator" />}
        </div>
        <EditorToolbar editor={editor} defaultCollapsed={toolbarDefaultCollapsed} />
        <EditorBubbleMenu editor={editor} />
        <div
          ref={dropTargetRef}
          className={`container-description-body${frontmatter?.cssclasses ? ' ' + frontmatter.cssclasses.join(' ') : ''}`}
          data-drop-target="container-editor"
        >
          <EditorContent editor={editor} />
        </div>
      </div>

      {/* New item input */}
      {(showNewNote || showNewFolder) && (
        <div className="container-new-input">
          <input
            ref={showNewNote ? noteInputRef : folderInputRef}
            className="sidebar-input"
            type="text"
            placeholder={showNewNote ? t('noteTitlePlaceholder', language) : t('folderNamePrompt', language)}
            value={newName}
            onChange={e => setNewName(e.target.value)}
            onKeyDown={e => handleKeyDown(e, showNewNote ? handleCreateNote : handleCreateFolder)}
            onBlur={() => { setShowNewNote(false); setShowNewFolder(false); setNewName(''); }}
          />
        </div>
      )}

      {/* Embedded Search */}
      <div className="container-search-section">
        <Search
          containerPath={selectedContainer}
          refreshTrigger={searchRefreshTrigger}
          onCreateNote={(e?: React.MouseEvent) => {
            const storageTemplateId = getStorageTemplateId();

            if (storageTemplateId) {
              // Storage container: use assigned template directly. v18 — routes
              // through the interactive flow so wizard / title / special-modal
              // branching matches every other entry point.
              const rootPath = getRootContainerPath(selectedContainer);
              createNoteFromTemplateInteractive(storageTemplateId, rootPath || selectedContainer);
            } else {
              // Standard container: show template selector, then defer to the
              // shared interactive flow. v18 fix — previously called
              // createNoteWithTemplate('', ...) directly, which bypassed the
              // NoteCreationWizard for templates with user-input `{{vars}}`.
              const pos = e ? { x: e.clientX, y: e.clientY } : { x: 200, y: 200 };
              modalActions.showTemplateSelector(pos, (templateId: string) => {
                createNoteFromTemplateInteractive(templateId, selectedContainer);
              });
            }
          }}
        />
      </div>

      {editorMenuPos && editor && (
        <EditorContextMenu
          editor={editor}
          position={editorMenuPos}
          onClose={() => setEditorMenuPos(null)}
        />
      )}
    </div>
  );
}

export default ContainerView;
