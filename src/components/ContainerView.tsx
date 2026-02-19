import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import { fileCommands, searchCommands, utilCommands } from '../services/tauriCommands';
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
} from '../stores/zustand';
import { useContainerConfigs } from '../stores/zustand/vaultConfigStore';
import { useTemplateStore } from '../stores/zustand/templateStore';
import { useNoteTypeCacheStore } from '../stores/zustand/noteTypeCacheStore';
import { createNote, createFolder, createNoteWithTemplate, selectContainer } from '../stores/appActions';
import { useDropTarget } from '../hooks/useDragDrop';
import { getEditorExtensions } from '../utils/editorConfig';
import { useSettingsStore } from '../stores/zustand/settingsStore';
import { t } from '../utils/i18n';
import EditorToolbar from './EditorToolbar';
import EditorContextMenu from './EditorContextMenu';
import Search from './Search';
import type { FileContent, NoteFrontmatter, NoteMetadata, FileNode } from '../types';
import { parseFrontmatter, serializeFrontmatter, getCurrentTimestamp } from '../utils/frontmatter';
import { markAsSelfSaved } from '../utils/selfSaveTracker';

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
    // FIRST: Check the _att folder for ALL files (regardless of extension)
    // This ensures .md attachments are found before searching globally
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
      const isPreviewable = /\.(md|pdf|png|jpg|jpeg|gif|webp|svg|bmp|ico|json|py|js|ts|jsx|tsx|css|html|xml|yaml|yml|toml|rs|go|java|c|cpp|h|hpp|cs|rb|php|sh|bash|sql|lua|r|swift|kt|scala)$/i.test(path);
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
          editor.commands.setContent(content.body || '');
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
  // NOTE: All importedPaths are in _att folder (attachments), so keep full filename with extension
  const handleFileDrop = useCallback((importedPaths: string[], position?: { x: number; y: number }) => {
    if (!editor) return;

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

    // Build content string for all attachments
    const links = importedPaths.map(importedPath => {
      const fileName = importedPath.split(/[/\\]/).pop() || '';
      return `[[${fileName}]]`;
    }).join('\n');

    if (insertPos !== null) {
      // Insert at drop position
      editor.chain()
        .focus()
        .insertContentAt(insertPos, links + '\n')
        .run();
    } else {
      // Fallback: insert at end of document
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
              // Storage container: use assigned template directly
              const rootPath = getRootContainerPath(selectedContainer);
              createNoteWithTemplate('', storageTemplateId, rootPath || selectedContainer);
            } else {
              // Standard container: show template selector
              const pos = e ? { x: e.clientX, y: e.clientY } : { x: 200, y: 200 };
              modalActions.showTemplateSelector(pos, async (templateId: string) => {
                await createNoteWithTemplate('', templateId, selectedContainer);
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
