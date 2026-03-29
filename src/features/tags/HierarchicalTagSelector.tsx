import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import type { TagOntology, TagNode, FacetNamespace } from '../../core/types/tagOntology';
import {
  getTagsForFacet,
  getTagBreadcrumb,
  searchTags,
  getRecentTags,
  addNewTag,
  removeFromRecentTags,
  deleteTagFromOntology,
  clearOntologyCache,
  clearAllRecentTags,
} from './tagOntologyUtils';
import { searchCommands } from '../../core/services/tauriCommands';
import { refreshActions } from '../../core/stores/refreshStore';
import { useSettingsStore } from '../../core/stores/settingsStore';
import { t, tf } from '../../core/utils/i18n';
import { TagDeleteConfirmDialog, TagRenameDialog } from './TagBulkDialog';
import { findSimilarTags } from '../../core/utils/levenshtein';

interface HierarchicalTagSelectorProps {
  namespace: FacetNamespace;
  ontology: TagOntology;
  onSelect: (tagId: string) => void;
  onClose: () => void;
  vaultPath: string;
}

function HierarchicalTagSelector({
  namespace,
  ontology,
  onSelect,
  onClose,
  vaultPath,
}: HierarchicalTagSelectorProps) {
  const incrementOntologyRefresh = refreshActions.incrementOntologyRefresh;
  const language = useSettingsStore(s => s.language);
  const [searchQuery, setSearchQuery] = useState('');
  const [currentPath, setCurrentPath] = useState<TagNode[]>([]);
  const [recentTags, setRecentTags] = useState<string[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(-1); // Keyboard navigation index
  const [isKeyboardNavActive, setIsKeyboardNavActive] = useState(false); // Track if using keyboard nav
  const [bulkDialog, setBulkDialog] = useState<{ type: 'delete' | 'rename'; tagId: string; tagLabel: string; noteCount: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Load all recent tags (including orphans - users can remove them manually)
    const recent = getRecentTags(namespace);
    setRecentTags(recent);

    // Click outside to close
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [namespace, onClose, ontology]);

  const rootTags = getTagsForFacet(ontology, namespace);
  const currentNode = currentPath.length > 0 ? currentPath[currentPath.length - 1] : null;
  const visibleTags = currentNode?.children || rootTags;

  // Search results for keyboard navigation
  const searchResults = searchQuery.trim()
    ? searchTags(ontology, searchQuery, namespace)
    : [];

  // Typo suggestions when search has few results
  const typoSuggestions = useMemo(() => {
    if (!searchQuery.trim() || searchResults.length >= 3) return [];
    const allLabels = Object.entries(ontology.definitions)
      .filter(([id]) => id.startsWith(`${namespace}/`))
      .map(([, def]) => def.label);
    return findSimilarTags(searchQuery.trim(), allLabels, 2);
  }, [searchQuery, searchResults.length, ontology, namespace]);

  // Reset selectedIndex when search query changes
  useEffect(() => {
    setSelectedIndex(-1);
    setIsKeyboardNavActive(false);
  }, [searchQuery]);

  const handleSelectTag = (tagId: string) => {
    onSelect(tagId);
  };

  // Keyboard navigation handler
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    const items = searchQuery.trim() ? searchResults : visibleTags;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setIsKeyboardNavActive(true);
      setSelectedIndex(prev => (prev < items.length - 1 ? prev + 1 : prev));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setIsKeyboardNavActive(true);
      setSelectedIndex(prev => (prev > 0 ? prev - 1 : 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();

      if (selectedIndex >= 0 && selectedIndex < items.length) {
        // Select the highlighted item
        const item = items[selectedIndex];
        if (searchQuery.trim()) {
          // In search mode, select the tag directly
          handleSelectTag((item as { id: string }).id);
        } else {
          // In hierarchical mode, navigate or select
          handleNavigate(item as TagNode);
        }
      } else if (searchQuery.trim() && searchResults.length === 0) {
        // Create new tag if no results
        handleCreateNewTag();
      } else if (searchQuery.trim() && searchResults.length > 0) {
        // Select first result if nothing is selected
        handleSelectTag(searchResults[0].id);
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  }, [searchQuery, searchResults, visibleTags, selectedIndex, onClose]);

  const handleNavigate = (node: TagNode) => {
    if (node.children && node.children.length > 0) {
      setCurrentPath([...currentPath, node]);
    } else {
      handleSelectTag(node.id);
    }
  };

  const handleBreadcrumbClick = (index: number) => {
    if (index === -1) {
      setCurrentPath([]);
    } else {
      setCurrentPath(currentPath.slice(0, index + 1));
    }
  };

  const handleCreateNewTag = async () => {
    if (!searchQuery.trim()) return;

    try {
      const parentId = currentNode?.id;
      const newTagId = await addNewTag(vaultPath, namespace, searchQuery.trim(), parentId);
      incrementOntologyRefresh(); // Trigger refresh for all components
      onSelect(newTagId);
    } catch (error) {
      console.error('Failed to create tag:', error);
      alert(tf('tagCreateFailed', language, { error: String(error) }));
    }
  };

  const handleRemoveRecentTag = (e: React.MouseEvent, tagId: string) => {
    e.stopPropagation();
    removeFromRecentTags(tagId, namespace);
    setRecentTags(recentTags.filter((id) => id !== tagId));
  };

  const handleDeleteTag = async (e: React.MouseEvent, tagId: string) => {
    e.stopPropagation();
    const tagLabel = ontology.definitions[tagId]?.label || tagId.split('/').pop() || tagId;
    try {
      const notes = await searchCommands.queryNotes({ tags: [tagId] });
      setBulkDialog({ type: 'delete', tagId, tagLabel, noteCount: notes.length });
    } catch (error) {
      console.error('Failed to get note count for tag:', error);
      // Fallback: delete from ontology only
      try {
        await deleteTagFromOntology(vaultPath, tagId);
        incrementOntologyRefresh();
        onClose();
      } catch (e2) {
        console.error('Failed to delete tag:', e2);
      }
    }
  };

  const handleRenameTag = async (e: React.MouseEvent, tagId: string) => {
    e.stopPropagation();
    const tagLabel = ontology.definitions[tagId]?.label || tagId.split('/').pop() || tagId;
    try {
      const notes = await searchCommands.queryNotes({ tags: [tagId] });
      setBulkDialog({ type: 'rename', tagId, tagLabel, noteCount: notes.length });
    } catch (error) {
      console.error('Failed to get note count for tag:', error);
    }
  };

  return (
    <div ref={containerRef} className="hierarchical-tag-selector">
      {/* Search Input */}
      <div className="tag-search">
        <input
          ref={inputRef}
          type="text"
          placeholder={t('tagSearchMeta', language)}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          autoFocus
          autoComplete="off"
        />
      </div>

      {/* Search Results */}
      {searchQuery.trim() && (
        <div className="tag-search-results">
          {searchResults.length === 0 ? (
            <div className="tag-empty">
              <div>{t('noSearchResultsMeta', language)}</div>
              {typoSuggestions.length > 0 && (
                <div className="tag-typo-suggestions">
                  <span className="tag-typo-label">{t('didYouMean', language)}</span>
                  <div className="tag-typo-list">
                    {typoSuggestions.map(s => (
                      <button
                        key={s.tag}
                        className="tag-typo-btn"
                        onClick={() => setSearchQuery(s.tag)}
                      >
                        {s.tag}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <button
                className="tag-create-btn"
                onClick={handleCreateNewTag}
              >
                {tf('createNewTag', language, { query: searchQuery.trim() })}
              </button>
            </div>
          ) : (
            <div className={`tag-list ${isKeyboardNavActive ? 'keyboard-nav-active' : ''}`}>
              {searchResults.map((result, index) => (
                <div key={result.id} className="tag-item-wrapper">
                  <button
                    className={`tag-item ${index === selectedIndex ? 'tag-item-selected' : ''}`}
                    onClick={() => handleSelectTag(result.id)}
                    onMouseEnter={() => {
                      if (!isKeyboardNavActive) {
                        setSelectedIndex(index);
                      }
                    }}
                    onMouseMove={() => {
                      // Re-enable mouse selection when mouse moves
                      if (isKeyboardNavActive) {
                        setIsKeyboardNavActive(false);
                        setSelectedIndex(index);
                      }
                    }}
                  >
                    <div className="tag-item-label">{result.label}</div>
                    <div className="tag-item-breadcrumb">
                      {result.breadcrumb.join(' > ')}
                    </div>
                  </button>
                  <button
                    className="tag-item-rename"
                    onClick={(e) => handleRenameTag(e, result.id)}
                    title={t('tagRename', language)}
                  >
                    ✎
                  </button>
                  <button
                    className="tag-item-delete"
                    onClick={(e) => handleDeleteTag(e, result.id)}
                    title={t('deleteTagFull', language)}
                  >
                    🗑
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Hierarchical Navigation */}
      {!searchQuery.trim() && (
        <>
          {/* Breadcrumb */}
          {currentPath.length > 0 && (
            <div className="tag-breadcrumb">
              <button
                className="breadcrumb-item"
                onClick={() => handleBreadcrumbClick(-1)}
              >
                {t('rootTag', language)}
              </button>
              {currentPath.map((node, index) => (
                <div key={node.id} className="breadcrumb-separator-wrapper">
                  <span className="breadcrumb-separator">/</span>
                  <button
                    className="breadcrumb-item"
                    onClick={() => handleBreadcrumbClick(index)}
                  >
                    {node.label}
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Tag List */}
          <div className={`tag-list ${isKeyboardNavActive ? 'keyboard-nav-active' : ''}`}>
            {visibleTags.length === 0 ? (
              <div className="tag-empty">{t('noSubTags', language)}</div>
            ) : (
              visibleTags.map((tag, index) => (
                <div key={tag.id} className="tag-item-wrapper">
                  <button
                    className={`tag-item ${index === selectedIndex ? 'tag-item-selected' : ''}`}
                    onClick={() => handleNavigate(tag)}
                    onMouseEnter={() => {
                      if (!isKeyboardNavActive) {
                        setSelectedIndex(index);
                      }
                    }}
                    onMouseMove={() => {
                      if (isKeyboardNavActive) {
                        setIsKeyboardNavActive(false);
                        setSelectedIndex(index);
                      }
                    }}
                  >
                    <span className="tag-item-label">{tag.label}</span>
                    {tag.children && tag.children.length > 0 && (
                      <span className="tag-item-arrow">▸</span>
                    )}
                  </button>
                  <button
                    className="tag-item-rename"
                    onClick={(e) => handleRenameTag(e, tag.id)}
                    title={t('tagRename', language)}
                  >
                    ✎
                  </button>
                  <button
                    className="tag-item-delete"
                    onClick={(e) => handleDeleteTag(e, tag.id)}
                    title={t('tagDelete', language)}
                  >
                    ×
                  </button>
                </div>
              ))
            )}
          </div>

          {/* Recent Tags */}
          {currentPath.length === 0 && recentTags.length > 0 && (
            <div className="tag-recent">
              <div className="tag-recent-header">
                <span className="tag-recent-title">{t('recentTags', language)}</span>
                <button
                  className="tag-recent-clear"
                  onClick={() => {
                    clearAllRecentTags();
                    setRecentTags([]);
                  }}
                  title={t('clearRecentTags', language)}
                >
                  {t('clearRecentTags', language)}
                </button>
              </div>
              <div className="tag-recent-list">
                {recentTags.map((tagId) => {
                  const definition = ontology.definitions[tagId];
                  const isOrphan = !definition;
                  // Extract display label: use definition label or extract from tagId (e.g., "domain/ㅇㅇ" -> "ㅇㅇ")
                  const displayLabel = definition?.label || tagId.split('/').pop() || tagId;

                  return (
                    <div key={tagId} className={`tag-chip-small-wrapper ${isOrphan ? 'tag-chip-orphan' : ''}`}>
                      <button
                        className={`tag-chip-small ${isOrphan ? 'tag-chip-small-orphan' : ''}`}
                        onClick={() => !isOrphan && handleSelectTag(tagId)}
                        title={isOrphan ? tf('deletedTag', language, { tag: tagId }) : tagId}
                        disabled={isOrphan}
                      >
                        {displayLabel}
                      </button>
                      <button
                        className="tag-chip-remove"
                        onClick={(e) => handleRemoveRecentTag(e, tagId)}
                        title={t('removeFromRecent', language)}
                      >
                        ×
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </>
      )}

      {/* Bulk operation dialogs */}
      {bulkDialog?.type === 'delete' && (
        <TagDeleteConfirmDialog
          tagId={bulkDialog.tagId}
          tagLabel={bulkDialog.tagLabel}
          namespace={namespace}
          noteCount={bulkDialog.noteCount}
          vaultPath={vaultPath}
          onClose={() => {
            setBulkDialog(null);
            setSearchQuery('');
            onClose();
          }}
        />
      )}
      {bulkDialog?.type === 'rename' && (
        <TagRenameDialog
          tagId={bulkDialog.tagId}
          tagLabel={bulkDialog.tagLabel}
          namespace={namespace}
          noteCount={bulkDialog.noteCount}
          vaultPath={vaultPath}
          onClose={() => {
            setBulkDialog(null);
            setSearchQuery('');
            onClose();
          }}
        />
      )}
    </div>
  );
}

export default HierarchicalTagSelector;
