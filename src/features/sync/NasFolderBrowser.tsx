import { useState, useCallback, useEffect } from 'react';
import { syncCommands, type RemoteFolderEntry } from './syncCommands';

interface NasFolderBrowserProps {
  url: string;
  username: string;
  password: string;
  onSelect: (path: string, isVault: boolean) => void;
  onCancel: () => void;
}

interface FolderNode {
  entry: RemoteFolderEntry;
  children: FolderNode[] | null; // null = not loaded
  isVault: boolean | null;       // null = not checked
  expanded: boolean;
  loading: boolean;
}

export function NasFolderBrowser({ url, username, password, onSelect, onCancel }: NasFolderBrowserProps) {
  const [roots, setRoots] = useState<FolderNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [selectedIsVault, setSelectedIsVault] = useState(false);

  // Load root folders on mount
  useEffect(() => {
    setLoading(true);
    setError('');
    syncCommands.browseFolder(url, username, password, '/')
      .then(entries => {
        console.log('[NasFolderBrowser] Root entries:', JSON.stringify(entries));
        setRoots(entries.map(e => ({
          entry: e,
          children: null,
          isVault: null,
          expanded: false,
          loading: false,
        })));
      })
      .catch(e => setError(e?.toString() || 'Failed to connect'))
      .finally(() => setLoading(false));
  }, [url, username, password]);

  const loadChildren = useCallback(async (node: FolderNode, path: number[]) => {
    // Set loading state
    setRoots(prev => updateNode(prev, path, { loading: true }));

    try {
      const [entries, isVault] = await Promise.all([
        syncCommands.browseFolder(url, username, password, node.entry.path),
        syncCommands.checkVault(url, username, password, node.entry.path),
      ]);

      const children: FolderNode[] = entries
        .filter(e => !e.name.startsWith('.')) // Hide hidden folders
        .map(e => ({
          entry: e,
          children: null,
          isVault: null,
          expanded: false,
          loading: false,
        }));

      setRoots(prev => updateNode(prev, path, {
        children,
        isVault,
        expanded: true,
        loading: false,
      }));
    } catch {
      setRoots(prev => updateNode(prev, path, { loading: false }));
    }
  }, [url, username, password]);

  const toggleExpand = useCallback((node: FolderNode, path: number[]) => {
    if (node.expanded) {
      setRoots(prev => updateNode(prev, path, { expanded: false }));
    } else if (node.children === null) {
      loadChildren(node, path);
    } else {
      setRoots(prev => updateNode(prev, path, { expanded: true }));
    }
  }, [loadChildren]);

  const handleSelect = useCallback((node: FolderNode) => {
    setSelectedPath(node.entry.path);
    setSelectedIsVault(node.isVault === true);
  }, []);

  const handleConfirm = useCallback(() => {
    if (selectedPath) {
      onSelect(selectedPath, selectedIsVault);
    }
  }, [selectedPath, selectedIsVault, onSelect]);

  if (loading) {
    return (
      <div className="nas-browser">
        <div className="nas-browser-loading">NAS 폴더 로딩 중...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="nas-browser">
        <div className="nas-browser-error">{error}</div>
        <button className="settings-action-btn" onClick={onCancel}>닫기</button>
      </div>
    );
  }

  return (
    <div className="nas-browser">
      <div className="nas-browser-header">
        <h4>NAS 폴더 선택</h4>
        <span className="nas-browser-hint">Notology 보관소가 있는 폴더를 선택하세요</span>
      </div>

      <div className="nas-browser-tree">
        {roots.map((node, i) => (
          <FolderTreeItem
            key={node.entry.path}
            node={node}
            path={[i]}
            depth={0}
            selectedPath={selectedPath}
            onToggle={toggleExpand}
            onSelect={handleSelect}
          />
        ))}
      </div>

      <div className="nas-browser-footer">
        {selectedPath && (
          <div className="nas-browser-selection">
            <span className="nas-browser-path">{selectedPath}</span>
            {selectedIsVault && <span className="nas-browser-vault-badge">Notology 보관소</span>}
          </div>
        )}
        <div className="nas-browser-actions">
          <button className="settings-action-btn" onClick={onCancel}>취소</button>
          <button
            className="settings-action-btn primary"
            onClick={handleConfirm}
            disabled={!selectedPath}
          >
            선택
          </button>
        </div>
      </div>
    </div>
  );
}

function FolderTreeItem({
  node, path, depth, selectedPath, onToggle, onSelect,
}: {
  node: FolderNode;
  path: number[];
  depth: number;
  selectedPath: string | null;
  onToggle: (node: FolderNode, path: number[]) => void;
  onSelect: (node: FolderNode) => void;
}) {
  const isSelected = selectedPath === node.entry.path;
  const indent = depth * 20;

  return (
    <>
      <div
        className={`nas-folder-item ${isSelected ? 'selected' : ''} ${node.isVault ? 'is-vault' : ''}`}
        style={{ paddingLeft: `${12 + indent}px` }}
        onClick={() => {
          onSelect(node);
          if (!node.expanded && node.children === null) {
            onToggle(node, path);
          }
        }}
      >
        <button
          className="nas-folder-toggle"
          onClick={(e) => {
            e.stopPropagation();
            onToggle(node, path);
          }}
        >
          {node.loading ? (
            <span className="nas-spinner">&#8635;</span>
          ) : node.expanded ? (
            '▼'
          ) : (
            '▶'
          )}
        </button>

        <span className="nas-folder-icon">
          {node.isVault ? '📦' : '📁'}
        </span>

        <span className="nas-folder-name" style={{ color: '#ff0', minWidth: '100px', display: 'inline-block' }}>
          {node.entry.name || node.entry.path || '(unnamed)'}
        </span>

        {node.isVault && (
          <span className="nas-vault-indicator">보관소</span>
        )}
      </div>

      {node.expanded && node.children && node.children.map((child, i) => (
        <FolderTreeItem
          key={child.entry.path}
          node={child}
          path={[...path, i]}
          depth={depth + 1}
          selectedPath={selectedPath}
          onToggle={onToggle}
          onSelect={onSelect}
        />
      ))}
    </>
  );
}

/** Immutably update a node at the given path in the tree. */
function updateNode(
  roots: FolderNode[],
  path: number[],
  updates: Partial<FolderNode>,
): FolderNode[] {
  if (path.length === 0) return roots;

  const [idx, ...rest] = path;
  return roots.map((node, i) => {
    if (i !== idx) return node;
    if (rest.length === 0) {
      return { ...node, ...updates };
    }
    return {
      ...node,
      children: node.children ? updateNode(node.children, rest, updates) : null,
    };
  });
}
