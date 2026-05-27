/**
 * SketchWikiLinkSearch — Floating search popup for inserting notes as sketch nodes.
 * Triggered by typing [[ on the sketch (outside any text node).
 * Reuses searchNotes() from wikiLinkSuggestion.
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { searchNotes } from '../suggestions/wikiLinkSuggestion';
import { fileTreeActions } from '../../core/stores/fileTreeStore';
import { fileLookupActions } from '../../core/stores/fileLookupStore';

interface SketchWikiLinkSearchProps {
  onSelect: (fileName: string, filePath: string) => void;
  onClose: () => void;
}

export function SketchWikiLinkSearch({ onSelect, onClose }: SketchWikiLinkSearchProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Array<{ fileName: string; path: string }>>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Search on query change
  useEffect(() => {
    const tree = fileTreeActions.getFileTree();
    const found = searchNotes(tree, query);
    setResults(found);
    setSelectedIndex(0);
  }, [query]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex(i => Math.min(i + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex(i => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (results[selectedIndex]) {
        handleItemSelect(results[selectedIndex].fileName);
      }
    }
  }, [results, selectedIndex, onClose]);

  const handleItemSelect = useCallback((fileName: string) => {
    // Resolve to absolute path via fileLookupStore
    const absolutePath = fileLookupActions.resolveNotePath(fileName);
    if (absolutePath) {
      onSelect(fileName, absolutePath);
    }
  }, [onSelect]);

  return createPortal(
    <>
      <div
        className="sketch-wikilink-search-backdrop"
        onClick={onClose}
        onContextMenu={e => { e.preventDefault(); onClose(); }}
      />
      <div className="sketch-wikilink-search" onMouseDown={e => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="sketch-wikilink-search-input"
          type="text"
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="노트 검색..."
          autoComplete="off"
          spellCheck={false}
        />
        {results.length > 0 ? (
          <div className="sketch-wikilink-search-results">
            {results.map((r, i) => (
              <div
                key={r.path}
                className={`sketch-wikilink-search-item${i === selectedIndex ? ' selected' : ''}`}
                onClick={() => handleItemSelect(r.fileName)}
                onMouseEnter={() => setSelectedIndex(i)}
              >
                <span className="sketch-wikilink-search-name">{r.fileName}</span>
                <span className="sketch-wikilink-search-path">{r.path}</span>
              </div>
            ))}
          </div>
        ) : query && (
          <div className="sketch-wikilink-search-empty">검색 결과 없음</div>
        )}
      </div>
    </>,
    document.body
  );
}
