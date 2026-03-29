import { useState, useEffect, useCallback } from 'react';
import { useModalStore } from './stores/modalStore';
import { useFileTree } from '../../core/stores/fileTreeStore';
import { moveNote } from '../../core/stores/appActions';
import { useSettingsStore } from '../../core/stores/settingsStore';
import { t, tf } from '../../core/utils/i18n';
import type { FileNode } from '../../core/types';

function MoveNoteModal() {
  const moveNoteModalPath = useModalStore(s => s.moveNoteModalPath);
  const bulkMoveNotePaths = useModalStore(s => s.bulkMoveNotePaths);
  const hideMoveNoteModal = useModalStore(s => s.hideMoveNoteModal);
  const hideBulkMoveModal = useModalStore(s => s.hideBulkMoveModal);
  const fileTree = useFileTree();
  const language = useSettingsStore(s => s.language);
  const [selectedDir, setSelectedDir] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [isMoving, setIsMoving] = useState(false);

  // Determine if this is a bulk move or single move
  const isBulk = bulkMoveNotePaths && bulkMoveNotePaths.length > 0;
  const isVisible = !!moveNoteModalPath || isBulk;
  const hideModal = isBulk ? hideBulkMoveModal : hideMoveNoteModal;

  useEffect(() => {
    if (!isVisible) {
      setSelectedDir(null);
      setExpanded(new Set());
    }
  }, [isVisible]);

  useEffect(() => {
    if (!isVisible) return;
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') hideModal();
    };
    document.addEventListener('keydown', handleEsc);
    return () => document.removeEventListener('keydown', handleEsc);
  }, [isVisible, hideModal]);

  const handleBackdropClick = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).classList.contains('move-note-backdrop')) {
      hideModal();
    }
  }, [hideModal]);

  const toggleExpand = (path: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  // Calculate the note's current directory (for single move only)
  const noteDir = moveNoteModalPath?.replace(/[/\\][^/\\]+$/, '') || null;

  // Check if selected directory is the same as current directory (single move only)
  const isCurrentDir = !isBulk && selectedDir === noteDir;

  const handleMove = async () => {
    if (!selectedDir || isMoving || isCurrentDir) return;

    if (isBulk && bulkMoveNotePaths) {
      // Bulk move
      setIsMoving(true);
      try {
        for (const notePath of bulkMoveNotePaths) {
          await moveNote(notePath, selectedDir);
        }
        hideBulkMoveModal();
      } catch (e) {
        console.error('Failed to bulk move notes:', e);
      } finally {
        setIsMoving(false);
      }
    } else if (moveNoteModalPath) {
      // Single move
      setIsMoving(true);
      try {
        await moveNote(moveNoteModalPath, selectedDir);
        hideMoveNoteModal();
      } catch (e) {
        console.error('Failed to move note:', e);
      } finally {
        setIsMoving(false);
      }
    }
  };

  const renderTree = (nodes: FileNode[], depth: number = 0) => {
    return nodes
      .filter(node => node.is_dir)
      .map(node => {
        const isExpanded = expanded.has(node.path);
        const isSelected = selectedDir === node.path;
        const hasChildren = node.children?.some(c => c.is_dir);
        // Highlight the note's own current directory (single move only)
        const isCurrent = !isBulk && node.path === noteDir;

        return (
          <div key={node.path} className="move-tree-item" style={{ paddingLeft: depth * 16 }}>
            <div
              className={`move-tree-row ${isSelected ? 'selected' : ''} ${isCurrent ? 'current' : ''}`}
              onClick={() => setSelectedDir(node.path)}
            >
              {hasChildren ? (
                <span
                  className="move-tree-toggle"
                  onClick={(e) => { e.stopPropagation(); toggleExpand(node.path); }}
                >
                  {isExpanded ? '▾' : '▸'}
                </span>
              ) : (
                <span className="move-tree-toggle-spacer" />
              )}
              <span className="move-tree-name">{node.name}</span>
              {isCurrent && <span className="move-tree-current">{t('currentBadge', language)}</span>}
            </div>
            {isExpanded && node.children && (
              <div className="move-tree-children">
                {renderTree(node.children, depth + 1)}
              </div>
            )}
          </div>
        );
      });
  };

  if (!isVisible) return null;

  const noteName = isBulk
    ? tf('selectedNotesCount', language, { count: bulkMoveNotePaths!.length })
    : (moveNoteModalPath!.split(/[/\\]/).pop()?.replace(/\.md$/, '') || '');

  return (
    <div className="move-note-backdrop" onClick={handleBackdropClick}>
      <div className="move-note-modal">
        <div className="move-note-header">
          <span className="move-note-title">{t('moveNoteTitle', language)} {noteName}</span>
          <button className="move-note-close" onClick={hideModal}>x</button>
        </div>
        <div className="move-note-body">
          <div className="move-note-tree">
            {renderTree(fileTree)}
          </div>
        </div>
        <div className="move-note-footer">
          <button className="move-note-btn cancel" onClick={hideModal}>
            {t('cancel', language)}
          </button>
          <button
            className="move-note-btn confirm"
            onClick={handleMove}
            disabled={!selectedDir || isMoving || isCurrentDir}
          >
            {isMoving ? t('moving', language) : isCurrentDir ? t('currentLocation', language) : t('moveBtn', language)}
          </button>
        </div>
      </div>
    </div>
  );
}

export default MoveNoteModal;
