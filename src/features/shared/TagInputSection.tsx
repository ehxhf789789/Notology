import { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import type { FacetNamespace } from '../../core/types';
import type { TagOntology } from '../../core/types/tagOntology';
import { FACET_INFOS } from '../../core/types';
import { useVaultPath } from '../../core/stores/fileTreeStore';
import { useOntologyRefreshTrigger, refreshActions } from '../../core/stores/refreshStore';
import { loadTagOntology, searchTags, addNewTag } from '../tags/tagOntologyUtils';
import { t } from '../../core/utils/i18n';

// 🔴 축을 손으로 적지 않는다 (2026-08-29). 이 꼴이 네 축뿐이라
//    `key`·`proj`·`acad` 를 새 노트에 붙일 길이 아예 없었다.
//    축 목록은 `tagOntology.FACET_NAMESPACES` 한 곳이다.
export type FacetedTagSelection = Record<FacetNamespace, string[]>;

/** 템플릿의 `tagCategories` 로 씨를 뿌린다. 축을 손으로 적지 않는다. */
export function seedFacetSelection(
  cats?: Record<string, string[] | undefined> | null,
): FacetedTagSelection {
  const out = emptyFacetSelection();
  for (const [k, v] of Object.entries(cats ?? {})) {
    if (Array.isArray(v) && k in out) out[k as FacetNamespace] = [...v];
  }
  return out;
}

/** 빈 고름. 🔴 축을 손으로 적지 말고 이것을 부른다 — 축이 늘면 저절로 는다. */
export function emptyFacetSelection(): FacetedTagSelection {
  return Object.fromEntries(
    FACET_INFOS.map((f) => [f.namespace, [] as string[]]),
  ) as FacetedTagSelection;
}

interface TagInputSectionProps {
  value: FacetedTagSelection;
  onChange: (value: FacetedTagSelection) => void;
  language?: 'ko' | 'en';
  collapsed?: boolean;
}

function TagInputSection({ value, onChange, language = 'ko', collapsed: initialCollapsed = true }: TagInputSectionProps) {
  const vaultPath = useVaultPath();
  const ontologyRefreshTrigger = useOntologyRefreshTrigger();
  const incrementOntologyRefresh = refreshActions.incrementOntologyRefresh;
  const [isCollapsed, setIsCollapsed] = useState(initialCollapsed);
  const [activeFacet, setActiveFacet] = useState<FacetNamespace | null>(null);
  const [inputValue, setInputValue] = useState('');
  const [ontology, setOntology] = useState<TagOntology | null>(null);
  const [suggestions, setSuggestions] = useState<Array<{ id: string; label: string }>>([]);
  const [selectedSuggestionIndex, setSelectedSuggestionIndex] = useState(-1);
  const [suggestionsPosition, setSuggestionsPosition] = useState<{ x: number; y: number; width: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const suggestionsRef = useRef<HTMLDivElement>(null);

  // Load ontology for autocomplete (reload when trigger changes)
  useEffect(() => {
    if (vaultPath) {
      // OPTIMIZATION: Use cached ontology for fast loading
      // Cache is only cleared when explicitly needed (tag edit, ontology refresh)
      loadTagOntology(vaultPath).then(setOntology);
    }
  }, [vaultPath, ontologyRefreshTrigger]);

  // Update suggestions when input changes
  useEffect(() => {
    if (!ontology || !activeFacet || !inputValue.trim()) {
      setSuggestions([]);
      setSelectedSuggestionIndex(-1);
      return;
    }

    const results = searchTags(ontology, inputValue.trim(), activeFacet);
    // Filter out already selected tags and extract just tag name (without namespace prefix)
    const filtered = results
      .filter(r => {
        const tagName = r.id.split('/').pop() || r.id;
        return !value[activeFacet].includes(tagName);
      })
      .slice(0, 8); // Limit to 8 suggestions
    setSuggestions(filtered);
    setSelectedSuggestionIndex(-1);
  }, [inputValue, activeFacet, ontology, value]);

  // Focus input when activeFacet changes
  useEffect(() => {
    if (activeFacet && inputRef.current) {
      inputRef.current.focus();
    }
  }, [activeFacet]);

  // Update suggestions dropdown position
  useEffect(() => {
    if (suggestions.length > 0 && inputRef.current) {
      const rect = inputRef.current.getBoundingClientRect();
      setSuggestionsPosition({
        x: rect.left,
        y: rect.bottom + 2,
        width: rect.width,
      });
    } else {
      setSuggestionsPosition(null);
    }
  }, [suggestions]);

  const handleAddTag = useCallback(async (namespace: FacetNamespace, tag: string) => {
    // Remove any namespace prefix if present (e.g., "domain/태그" -> "태그")
    let cleanTag = tag.trim();
    const namespaces = ['domain', 'who', 'org', 'ctx', 'key', 'proj', 'acad'];
    for (const ns of namespaces) {
      if (cleanTag.startsWith(`${ns}/`)) {
        cleanTag = cleanTag.slice(ns.length + 1);
      }
    }
    // Also handle double prefix case (e.g., "domain/domain/태그" -> "태그")
    for (const ns of namespaces) {
      if (cleanTag.startsWith(`${ns}/`)) {
        cleanTag = cleanTag.slice(ns.length + 1);
      }
    }

    const trimmedTag = cleanTag.replace(/[^a-zA-Z0-9가-힣ㄱ-ㅎㅏ-ㅣ_-]/g, '');
    if (!trimmedTag) return;

    // Case-insensitive check for existing tags
    const existsInValue = value[namespace].some(
      t => t.toLowerCase() === trimmedTag.toLowerCase()
    );

    if (!existsInValue) {
      onChange({
        ...value,
        [namespace]: [...value[namespace], trimmedTag],
      });

      // Add tag to ontology if it doesn't exist (case-insensitive)
      if (vaultPath && ontology) {
        const tagIdLower = `${namespace}/${trimmedTag}`.toLowerCase();
        const existsInOntology = Object.keys(ontology.definitions).some(
          key => key.toLowerCase() === tagIdLower
        );
        if (!existsInOntology) {
          try {
            await addNewTag(vaultPath, namespace, trimmedTag);
            // Trigger refresh for all components
            incrementOntologyRefresh();
          } catch (error) {
            console.error('Failed to add tag to ontology:', error);
          }
        }
      }
    }
    setInputValue('');
    setActiveFacet(null);
  }, [value, onChange, vaultPath, ontology, incrementOntologyRefresh]);

  const handleRemoveTag = useCallback((namespace: FacetNamespace, tag: string) => {
    onChange({
      ...value,
      [namespace]: value[namespace].filter(t => t !== tag),
    });
  }, [value, onChange]);

  const handleSelectSuggestion = useCallback((namespace: FacetNamespace, tagId: string) => {
    // Extract tag name from full ID (e.g., "domain/태그명" -> "태그명")
    const tagName = tagId.split('/').pop() || tagId;
    handleAddTag(namespace, tagName);
    setSuggestions([]);
  }, [handleAddTag]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent, namespace: FacetNamespace) => {
    // Handle arrow navigation in suggestions
    if (suggestions.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedSuggestionIndex(prev =>
          prev < suggestions.length - 1 ? prev + 1 : prev
        );
        return;
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedSuggestionIndex(prev => prev > 0 ? prev - 1 : -1);
        return;
      } else if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        // If no suggestion is selected (index -1), auto-select the first one (index 0)
        const indexToUse = selectedSuggestionIndex >= 0 ? selectedSuggestionIndex : 0;
        handleSelectSuggestion(namespace, suggestions[indexToUse].id);
        return;
      }
    }

    if (e.key === 'Enter' && inputValue.trim() && suggestions.length === 0) {
      e.preventDefault();
      e.stopPropagation(); // Prevent bubbling to parent modal
      handleAddTag(namespace, inputValue);
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      setActiveFacet(null);
      setInputValue('');
      setSuggestions([]);
    }
  }, [inputValue, handleAddTag, suggestions, selectedSuggestionIndex, handleSelectSuggestion]);

  // Strip namespace prefix from tag name for display
  const getDisplayTagName = (tagName: string): string => {
    let clean = tagName;
    const namespaces = ['domain', 'who', 'org', 'ctx', 'key', 'proj', 'acad'];
    for (const ns of namespaces) {
      while (clean.startsWith(`${ns}/`)) {
        clean = clean.slice(ns.length + 1);
      }
    }
    return clean;
  };

  // Count total tags
  const totalTags = value.domain.length + value.who.length + value.org.length + value.ctx.length;

  return (
    <div className="tag-input-section">
      <div
        className="tag-input-section-header"
        onClick={() => setIsCollapsed(!isCollapsed)}
      >
        <span className={`tag-input-collapse-icon ${isCollapsed ? 'collapsed' : ''}`}>▼</span>
        <span className="tag-input-section-title">
          {t('tagsLabel', language)}
        </span>
        {totalTags > 0 && (
          <span className="tag-input-section-count">{totalTags}</span>
        )}
      </div>

      {!isCollapsed && (
        <div className="tag-input-section-content">
          {FACET_INFOS.map((facet) => {
            const tags = value[facet.namespace];
            const isActive = activeFacet === facet.namespace;

            return (
              <div key={facet.namespace} className="tag-input-facet-row">
                <div className="tag-input-facet-label">{t(facet.label, language)}</div>
                <div className="tag-input-facet-content">
                  {tags.map(tag => (
                    <span
                      key={tag}
                      className={`tag-input-chip tag-${facet.namespace}`}
                    >
                      {getDisplayTagName(tag)}
                      <button
                        type="button"
                        className="tag-input-chip-remove"
                        onClick={() => handleRemoveTag(facet.namespace, tag)}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                  {isActive ? (
                    <input
                      ref={inputRef}
                      type="text"
                      className="tag-input-inline"
                      value={inputValue}
                      onChange={e => setInputValue(e.target.value)}
                      onKeyDown={e => handleKeyDown(e, facet.namespace)}
                      onBlur={() => {
                        // Delay to allow click on suggestion
                        setTimeout(() => {
                          if (inputValue.trim() && suggestions.length === 0) {
                            handleAddTag(facet.namespace, inputValue);
                          } else if (!inputValue.trim()) {
                            setActiveFacet(null);
                          }
                          setSuggestions([]);
                        }, 150);
                      }}
                      placeholder={t('tagInput', language)}
                      autoComplete="off"
                    />
                  ) : (
                    <button
                      type="button"
                      className="tag-input-add-btn"
                      onClick={() => setActiveFacet(facet.namespace)}
                    >
                      +
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Suggestions Dropdown - rendered via Portal to avoid overflow clipping */}
      {suggestions.length > 0 && suggestionsPosition && activeFacet && createPortal(
        <div
          ref={suggestionsRef}
          className="tag-input-suggestions"
          style={{
            position: 'fixed',
            left: suggestionsPosition.x,
            top: suggestionsPosition.y,
            width: Math.max(suggestionsPosition.width, 150),
          }}
        >
          {suggestions.map((suggestion, index) => (
            <button
              key={suggestion.id}
              type="button"
              className={`tag-input-suggestion-item ${index === selectedSuggestionIndex ? 'selected' : ''}`}
              onMouseDown={(e) => {
                e.preventDefault();
                handleSelectSuggestion(activeFacet, suggestion.id);
              }}
            >
              {suggestion.label}
            </button>
          ))}
        </div>,
        document.body
      )}

    </div>
  );
}

export default TagInputSection;
