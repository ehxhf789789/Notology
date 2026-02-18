import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { Folder, FolderOpen, FolderDot, FolderRoot, FolderOpenDot, ChevronsUpDown, ChevronsDownUp, FolderPlus, RefreshCw, Check, Pause, Circle, GripVertical } from 'lucide-react';
import { useFileTree, useSelectedContainer } from '../stores/zustand/fileTreeStore';
import { useContainerConfigs, useFolderStatuses, useContainerOrder, vaultConfigActions } from '../stores/zustand/vaultConfigStore';
import { modalActions } from '../stores/zustand/modalStore';
import { useTemplateStore } from '../stores/zustand/templateStore';
import { selectContainer } from '../stores/appActions';
import { uiActions } from '../stores/zustand/uiStore';
import type { FileNode, FolderStatus } from '../types';
import { FOLDER_STATUS_INFO } from '../types';
import { useSettingsStore } from '../stores/zustand/settingsStore';
import { t } from '../utils/i18n';

// Render folder status icon using Lucide
function renderStatusIcon(status: FolderStatus) {
  const iconSize = 12;
  switch (status) {
    case 'in_progress':
      return <RefreshCw size={iconSize} />;
    case 'completed':
      return <Check size={iconSize} />;
    case 'on_hold':
      return <Pause size={iconSize} />;
    default:
      return <Circle size={iconSize} />;
  }
}

interface FolderTreeProps {
  containers: FileNode[];
  rootContainer: string | null;
  onRootContainerChange: (path: string | null) => void;
  onNewSubfolder?: () => void;
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

// Check if a folder has a folder note (FolderName/FolderName.md)
function hasFolderNote(node: FileNode): boolean {
  if (!node.is_dir || !node.children) return false;
  if (node.is_folder_note) return true;
  const folderNoteName = `${node.name}.md`;
  return node.children.some(child => !child.is_dir && child.name === folderNoteName);
}

// Count notes in a folder (excluding folder notes)
function countNotesInFolder(node: FileNode, includeSubfolders: boolean): number {
  if (!node.children) return 0;

  let count = 0;
  const folderNoteName = `${node.name}.md`;

  for (const child of node.children) {
    if (!child.is_dir) {
      // Skip folder note
      if (child.name === folderNoteName) continue;
      // Skip _att files
      if (child.name.endsWith('_att')) continue;
      // Count .md files only
      if (child.name.endsWith('.md')) {
        count++;
      }
    } else if (includeSubfolders) {
      // Skip _att and .notology folders
      if (child.name.endsWith('_att') || child.name === '.notology') continue;
      // Recursively count in subfolders
      count += countNotesInFolder(child, true);
    }
  }

  return count;
}

// Get all folder paths recursively
function getAllFolderPaths(node: FileNode): string[] {
  const paths: string[] = [];
  if (!node.children) return paths;

  for (const child of node.children) {
    if (child.is_dir && !child.name.endsWith('_att') && child.name !== '.notology') {
      paths.push(child.path);
      paths.push(...getAllFolderPaths(child));
    }
  }

  return paths;
}

function FolderTree({ containers, rootContainer, onRootContainerChange, onNewSubfolder }: FolderTreeProps) {
  const language = useSettingsStore(s => s.language);
  const fileTree = useFileTree();
  const selectedContainer = useSelectedContainer();
  const containerConfigs = useContainerConfigs();
  const folderStatuses = useFolderStatuses();
  const containerOrder = useContainerOrder();
  const noteTemplates = useTemplateStore(s => s.noteTemplates);

  // Get template prefix for a Storage container
  const getTemplatePrefix = (containerPath: string): string => {
    const config = containerConfigs[containerPath];
    if (!config?.assignedTemplateId) return '?';
    const tmpl = noteTemplates.find(t => t.id === config.assignedTemplateId);
    return tmpl?.prefix || '?';
  };
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [rootExpanded, setRootExpanded] = useState(false);

  // Drag-and-drop state for container reordering (mouse-based)
  const [draggedContainer, setDraggedContainer] = useState<string | null>(null);
  const [dragOverContainer, setDragOverContainer] = useState<string | null>(null);
  const containerRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  // Sort containers by custom order, fallback to alphabetical
  const sortedContainers = useMemo(() => {
    if (!containerOrder || containerOrder.length === 0) {
      // No custom order, sort alphabetically
      return [...containers].sort((a, b) => a.name.localeCompare(b.name));
    }
    // Sort by custom order, containers not in order go to the end (alphabetically)
    return [...containers].sort((a, b) => {
      const aIndex = containerOrder.indexOf(a.name);
      const bIndex = containerOrder.indexOf(b.name);
      // Both in order: sort by order index
      if (aIndex !== -1 && bIndex !== -1) return aIndex - bIndex;
      // Only a in order: a comes first
      if (aIndex !== -1) return -1;
      // Only b in order: b comes first
      if (bIndex !== -1) return 1;
      // Neither in order: alphabetical
      return a.name.localeCompare(b.name);
    });
  }, [containers, containerOrder]);

  // Precompute note counts for all folders to avoid expensive recalculations during render
  // Key: folder path, Value: { collapsed: count when collapsed, expanded: count when expanded }
  const folderNoteCounts = useMemo(() => {
    const counts = new Map<string, { collapsed: number; expanded: number }>();

    const computeForNode = (node: FileNode) => {
      if (!node.is_dir) return;
      counts.set(node.path, {
        collapsed: countNotesInFolder(node, true),  // Include subfolders
        expanded: countNotesInFolder(node, false),  // Only direct children
      });
      // Recursively compute for child folders
      node.children?.forEach(child => {
        if (child.is_dir && !child.name.endsWith('_att') && child.name !== '.notology') {
          computeForNode(child);
        }
      });
    };

    containers.forEach(computeForNode);
    return counts;
  }, [containers]);

  // Helper to get cached note count
  const getNoteCount = useCallback((nodePath: string, isExpanded: boolean): number => {
    const cached = folderNoteCounts.get(nodePath);
    if (!cached) return 0;
    return isExpanded ? cached.expanded : cached.collapsed;
  }, [folderNoteCounts]);

  // Mouse-based drag handler
  const handleMouseDown = useCallback((e: React.MouseEvent, containerName: string) => {
    e.preventDefault();
    e.stopPropagation();

    const startY = e.clientY;
    let currentTarget: string | null = null;

    setDraggedContainer(containerName);

    const handleMouseMove = (moveEvent: MouseEvent) => {
      // Find which container we're over based on Y position
      let foundTarget: string | null = null;
      for (const [name, element] of containerRefs.current) {
        if (name === containerName) continue;
        const rect = element.getBoundingClientRect();
        if (moveEvent.clientY >= rect.top && moveEvent.clientY <= rect.bottom) {
          foundTarget = name;
          break;
        }
      }
      if (foundTarget !== currentTarget) {
        currentTarget = foundTarget;
        setDragOverContainer(foundTarget);
      }
    };

    const handleMouseUp = () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);

      if (currentTarget && currentTarget !== containerName) {
        // Perform the reorder
        const containerNames = sortedContainers.map(c => c.name);
        const sourceIndex = containerNames.indexOf(containerName);
        const targetIndex = containerNames.indexOf(currentTarget);

        if (sourceIndex !== -1 && targetIndex !== -1) {
          const newOrder = [...containerNames];
          newOrder.splice(sourceIndex, 1);
          const adjustedTargetIndex = sourceIndex < targetIndex ? targetIndex - 1 : targetIndex;
          newOrder.splice(adjustedTargetIndex, 0, containerName);
          vaultConfigActions.setContainerOrderWithPersist(newOrder);
        }
      }

      setDraggedContainer(null);
      setDragOverContainer(null);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [sortedContainers]);

  // Reset expanded state when root container changes
  useEffect(() => {
    setRootExpanded(false);
  }, [rootContainer]);

  // When selected container changes, set root container but do NOT auto-expand subfolders
  useEffect(() => {
    if (!selectedContainer) return;

    // Get all path parts
    const pathParts = selectedContainer.split(/[/\\]/);
    const ancestorPaths: string[] = [];

    // Build ancestor paths (from root to selected)
    for (let i = 1; i < pathParts.length; i++) {
      const ancestorPath = pathParts.slice(0, i + 1).join('\\');
      ancestorPaths.push(ancestorPath);
    }

    // Find which ancestor is a root container (in containers list)
    const rootPath = ancestorPaths.find(path =>
      containers.some(c => c.path === path)
    );

    if (rootPath) {
      // Set root container if different
      if (rootContainer !== rootPath) {
        onRootContainerChange(rootPath);
      }
    }
  }, [selectedContainer, containers, rootContainer, onRootContainerChange]);

  // Find the root container node
  const rootContainerNode = useMemo(() => {
    if (!rootContainer) return null;
    return findNodeByPath(fileTree, rootContainer);
  }, [fileTree, rootContainer]);

  // Get all expandable folder paths under root container
  const allFolderPaths = useMemo(() => {
    if (!rootContainerNode) return [];
    return getAllFolderPaths(rootContainerNode);
  }, [rootContainerNode]);

  const toggleFolder = useCallback((path: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setExpandedFolders(prev => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  const expandAll = useCallback(() => {
    setExpandedFolders(new Set(allFolderPaths));
  }, [allFolderPaths]);

  const collapseAll = useCallback(() => {
    setExpandedFolders(new Set());
  }, []);

  const handleFolderClick = useCallback((node: FileNode) => {
    if (!node.is_dir) return;
    // Single click: navigate to folder (or close calendar/search if already selected)
    if (node.path !== selectedContainer) {
      selectContainer(node.path);
    } else {
      // Already selected - still close calendar/search views
      uiActions.setShowCalendar(false);
      uiActions.setShowSearch(false);
    }
  }, [selectedContainer]);

  const handleContextMenu = useCallback((e: React.MouseEvent, node: FileNode) => {
    e.preventDefault();
    modalActions.showContextMenu(node.name, { x: e.clientX, y: e.clientY }, node.path, node.path, true);
  }, []);

  const handleContainerClick = useCallback((node: FileNode) => {
    // Single click: navigate to container (or close calendar/search if already selected)
    if (node.path !== selectedContainer) {
      selectContainer(node.path);
    } else {
      // Already selected - still close calendar/search views
      uiActions.setShowCalendar(false);
      uiActions.setShowSearch(false);
    }
    // Expand tree if not already root
    if (rootContainer !== node.path) {
      onRootContainerChange(node.path);
    }
  }, [selectedContainer, rootContainer, onRootContainerChange]);

  const handleContainerIconClick = useCallback((node: FileNode, e: React.MouseEvent) => {
    e.stopPropagation();
    if (rootContainer === node.path) {
      // Already root: toggle expand/collapse
      setRootExpanded(prev => !prev);
    } else {
      // Not root: set as root (collapsed — useEffect resets rootExpanded)
      onRootContainerChange(node.path);
      // Also navigate
      if (node.path !== selectedContainer) {
        selectContainer(node.path);
      }
    }
  }, [rootContainer, onRootContainerChange, selectedContainer]);

  // Render a folder icon based on state
  const renderFolderIcon = (node: FileNode, isExpanded: boolean, hasChildren: boolean) => {
    const isContainer = hasFolderNote(node);
    const iconSize = 14;
    const childrenClass = hasChildren ? ' has-children' : '';

    if (isContainer) {
      // Container without children: always show FolderDot
      if (!hasChildren) {
        return <FolderDot size={iconSize} className="folder-icon container" />;
      }
      // Container with children: FolderDot when collapsed, FolderOpen when expanded
      return isExpanded
        ? <FolderOpen size={iconSize} className={`folder-icon container expanded${childrenClass}`} />
        : <FolderDot size={iconSize} className={`folder-icon container${childrenClass}`} />;
    }

    // Regular folder without children: always show Folder
    if (!hasChildren) {
      return <Folder size={iconSize} className="folder-icon" />;
    }

    // Regular folder with children: Folder when collapsed, FolderOpen when expanded
    return isExpanded
      ? <FolderOpen size={iconSize} className={`folder-icon expanded${childrenClass}`} />
      : <Folder size={iconSize} className={`folder-icon${childrenClass}`} />;
  };

  const renderNode = (node: FileNode, depth: number = 0) => {
    if (!node.is_dir) return null;
    if (node.name.endsWith('_att')) return null;
    if (node.name === '.notology') return null;

    const isExpanded = expandedFolders.has(node.path);
    const isContainer = hasFolderNote(node);

    const childFolders = node.children?.filter(child =>
      child.is_dir &&
      !child.name.endsWith('_att') &&
      child.name !== '.notology'
    ) || [];

    const hasChildFolders = childFolders.length > 0;
    const isSelected = node.path === selectedContainer;

    // Use cached note count based on expanded state
    const noteCount = getNoteCount(node.path, isExpanded);

    return (
      <div key={node.path} className="folder-tree-item-wrapper">
        <div
          className={`folder-tree-item folder ${isContainer ? 'folder-note' : ''} ${isSelected ? 'selected' : ''}`}
          style={{ paddingLeft: `${depth * 16 + 8}px` }}
          onClick={() => handleFolderClick(node)}
          onContextMenu={(e) => handleContextMenu(e, node)}
        >
          <span
            className="folder-tree-icon"
            onClick={hasChildFolders ? (e) => toggleFolder(node.path, e) : undefined}
          >
            {renderFolderIcon(node, isExpanded, hasChildFolders)}
          </span>
          <span className="folder-tree-name">{node.name}</span>
          {folderStatuses[node.path] && folderStatuses[node.path].status !== 'none' && (
            <span
              className={`folder-status-indicator status-${folderStatuses[node.path].status}`}
              title={t(FOLDER_STATUS_INFO.find(s => s.status === folderStatuses[node.path].status)?.label || '', language)}
            >
              {renderStatusIcon(folderStatuses[node.path].status)}
            </span>
          )}
          {noteCount > 0 && (
            <span className="folder-note-count">{noteCount}</span>
          )}
        </div>
        {hasChildFolders && isExpanded && (
          <div className="folder-tree-children">
            {childFolders
              .sort((a, b) => a.name.localeCompare(b.name))
              .map(child => renderNode(child, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  // Get child folders of root container
  const childFolders = rootContainerNode?.children?.filter(child =>
    child.is_dir &&
    !child.name.endsWith('_att') &&
    child.name !== '.notology'
  ) || [];

  const sortedChildFolders = [...childFolders].sort((a, b) => a.name.localeCompare(b.name));

  // Check if any folders are expanded
  const hasExpandedFolders = expandedFolders.size > 0;

  return (
    <div className="folder-tree-container">
      {/* Container List Header */}
      <div className="folder-tree-unified-header">
        <div className="folder-tree-header-left">
          {rootContainer && allFolderPaths.length > 0 && (
            <button
              className="folder-tree-expand-btn"
              onClick={hasExpandedFolders ? collapseAll : expandAll}
              title={hasExpandedFolders ? t('collapseAll', language) : t('expandAll', language)}
            >
              {hasExpandedFolders ? <ChevronsDownUp size={14} /> : <ChevronsUpDown size={14} />}
            </button>
          )}
          <span className="folder-tree-section-label">Containers</span>
        </div>
        {onNewSubfolder && selectedContainer && (
          <button
            className="folder-tree-new-btn"
            onClick={onNewSubfolder}
            title={t('newFolder', language)}
          >
            <FolderPlus size={14} />
          </button>
        )}
      </div>

      {/* Unified Container and Folder Tree */}
      <div className="folder-tree-content">
        {sortedContainers.map(node => {
          const isRootActive = node.path === rootContainer;
          const isSelected = node.path === selectedContainer;
          const config = containerConfigs[node.path];
          const isStorage = config?.type === 'storage';
          // Use cached note count based on expanded state
          const noteCount = getNoteCount(node.path, isRootActive && rootExpanded);
          // Check if this container has child folders
          const hasChildFolders = node.children?.some(child =>
            child.is_dir && !child.name.endsWith('_att') && child.name !== '.notology'
          ) || false;
          const isDragging = draggedContainer === node.name;
          const isDragOver = dragOverContainer === node.name;

          return (
            <div
              key={node.path}
              ref={(el) => {
                if (el) containerRefs.current.set(node.name, el);
                else containerRefs.current.delete(node.name);
              }}
              className={`container-tree-section ${isDragging ? 'dragging' : ''} ${isDragOver ? 'drag-over' : ''}`}
            >
              {/* Root Container Item */}
              <div
                className={`container-tree-item ${isSelected ? 'selected' : ''} ${isRootActive && !isSelected ? 'root-active' : ''} ${isStorage ? 'storage' : ''}`}
                onClick={() => handleContainerClick(node)}
                onContextMenu={(e) => handleContextMenu(e, node)}
              >
                <span
                  className="container-drag-handle"
                  onMouseDown={(e) => handleMouseDown(e, node.name)}
                >
                  <GripVertical size={12} />
                </span>
                <span
                  className="container-tree-icon"
                  onClick={(e) => handleContainerIconClick(node, e)}
                >
                  {isRootActive && rootExpanded && hasChildFolders
                    ? <FolderOpenDot size={14} className={`folder-icon container root expanded ${isStorage ? 'storage' : ''}`} />
                    : <FolderRoot size={14} className={`folder-icon container root ${isStorage ? 'storage' : ''}`} />
                  }
                </span>
                <span className="container-tree-name">{node.name}</span>
                {isStorage && <span className="container-type-badge" title={t('storageContainer', language)}>{getTemplatePrefix(node.path)}</span>}
                {folderStatuses[node.path] && folderStatuses[node.path].status !== 'none' && (
                  <span
                    className={`folder-status-indicator status-${folderStatuses[node.path].status}`}
                    title={t(FOLDER_STATUS_INFO.find(s => s.status === folderStatuses[node.path].status)?.label || '', language)}
                  >
                    {renderStatusIcon(folderStatuses[node.path].status)}
                  </span>
                )}
                {noteCount > 0 && (
                  <span className="folder-note-count">{noteCount}</span>
                )}
              </div>

              {/* Sub-folders (only show for root container when expanded via icon click) */}
              {isRootActive && rootExpanded && sortedChildFolders.length > 0 && (
                <div className="folder-tree-children">
                  {sortedChildFolders.map(child => renderNode(child, 1))}
                </div>
              )}
            </div>
          );
        })}

        {sortedContainers.length === 0 && (
          <div className="folder-tree-empty">{t('noContainers', language)}</div>
        )}
      </div>
    </div>
  );
}

export default FolderTree;
