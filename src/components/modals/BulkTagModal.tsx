import { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import type { FacetNamespace } from '../../types';
import type { TagOntology } from '../../types/tagOntology';
import { FACET_INFOS } from '../../types';
import { useVaultPath } from '../../stores/zustand/fileTreeStore';
import { loadTagOntology, searchTags, addNewTag } from '../../utils/tagOntologyUtils';
import { searchCommands } from '../../services/tauriCommands';
import { refreshActions } from '../../stores/zustand/refreshStore';
import { modalActions } from '../../stores/zustand/modalStore';
import { t, tf } from '../../utils/i18n';

interface BulkTagModalProps {
  paths: string[];
  language: 'ko' | 'en';
  onClose: () => void;
  onComplete: () => void;
}

function BulkTagModal({ paths, language, onClose, onComplete }: BulkTagModalProps) {
  const vaultPath = useVaultPath();
  const [activeNamespace, setActiveNamespace] = useState<FacetNamespace>('domain');
  const [inputValue, setInputValue] = useState('');
  const [ontology, setOntology] = useState<TagOntology | null>(null);
  const [suggestions, setSuggestions] = useState<Array<{ id: string; label: string }>>([]);
  const [selectedSuggestionIndex, setSelectedSuggestionIndex] = useState(-1);
  const [selectedTags, setSelectedTags] = useState<Array<{ namespace: FacetNamespace; tag: string }>>([]);
  const [isApplying, setIsApplying] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Load ontology
  useEffect(() => {
    if (vaultPath) {
      loadTagOntology(vaultPath).then(setOntology);
    }
  }, [vaultPath]);

  // Focus input on mount
  useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 100);
  }, []);

  // Update suggestions when input changes
  useEffect(() => {
    if (!ontology || !inputValue.trim()) {
      setSuggestions([]);
      setSelectedSuggestionIndex(-1);
      return;
    }
    const results = searchTags(ontology, inputValue.trim(), activeNamespace);
    // Filter out already selected tags
    const filtered = results
      .filter(r => {
        const tagName = r.id.split('/').pop() || r.id;
        return !selectedTags.some(
          st => st.namespace === activeNamespace && st.tag.toLowerCase() === tagName.toLowerCase()
        );
      })
      .slice(0, 8);
    setSuggestions(filtered);
    setSelectedSuggestionIndex(-1);
  }, [inputValue, activeNamespace, ontology, selectedTags]);

  const addTag = useCallback((namespace: FacetNamespace, tagName: string) => {
    // Clean namespace prefix
    let clean = tagName.trim();
    const namespaces = ['domain', 'who', 'org', 'ctx'];
    for (const ns of namespaces) {
      while (clean.startsWith(`${ns}/`)) {
        clean = clean.slice(ns.length + 1);
      }
    }
    clean = clean.replace(/[^a-zA-Z0-9가-힣ㄱ-ㅎㅏ-ㅣ_-]/g, '');
    if (!clean) return;

    // Check duplicate
    const exists = selectedTags.some(
      st => st.namespace === namespace && st.tag.toLowerCase() === clean.toLowerCase()
    );
    if (!exists) {
      setSelectedTags(prev => [...prev, { namespace, tag: clean }]);
    }
    setInputValue('');
    setSuggestions([]);
  }, [selectedTags]);

  const removeTag = useCallback((index: number) => {
    setSelectedTags(prev => prev.filter((_, i) => i !== index));
  }, []);

  const handleSelectSuggestion = useCallback((tagId: string) => {
    const tagName = tagId.split('/').pop() || tagId;
    addTag(activeNamespace, tagName);
  }, [activeNamespace, addTag]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
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
      } else if (e.key === 'Enter' && selectedSuggestionIndex >= 0) {
        e.preventDefault();
        e.stopPropagation();
        handleSelectSuggestion(suggestions[selectedSuggestionIndex].id);
        return;
      }
    }

    if (e.key === 'Enter' && inputValue.trim()) {
      e.preventDefault();
      e.stopPropagation();
      addTag(activeNamespace, inputValue);
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      if (inputValue) {
        setInputValue('');
        setSuggestions([]);
      } else {
        onClose();
      }
    }
  }, [inputValue, addTag, activeNamespace, suggestions, selectedSuggestionIndex, handleSelectSuggestion, onClose]);

  const handleApply = useCallback(async () => {
    if (selectedTags.length === 0 || !vaultPath) return;
    setIsApplying(true);

    try {
      let totalAffected = 0;
      for (const st of selectedTags) {
        const fullTag = `${st.namespace}/${st.tag}`;
        const result = await searchCommands.bulkAddTags(paths, fullTag);
        totalAffected += result.affected_count;

        // Also add to ontology if new
        if (ontology) {
          const tagIdLower = fullTag.toLowerCase();
          const existsInOntology = Object.keys(ontology.definitions).some(
            key => key.toLowerCase() === tagIdLower
          );
          if (!existsInOntology) {
            try {
              await addNewTag(vaultPath, st.namespace, st.tag);
            } catch (err) {
              console.error('Failed to add tag to ontology:', err);
            }
          }
        }
      }

      refreshActions.incrementOntologyRefresh();
      refreshActions.incrementSearchRefresh();
      modalActions.showAlertModal(
        t('bulkTagTitle', language),
        tf('bulkTagSuccess', language, { count: paths.length })
      );
      onComplete();
    } catch (err) {
      console.error('Bulk add tags failed:', err);
      modalActions.showAlertModal(t('error', language) || 'Error', `${err}`);
    } finally {
      setIsApplying(false);
    }
  }, [selectedTags, paths, vaultPath, ontology, language, onComplete]);

  const getNamespaceColor = (ns: FacetNamespace): string => {
    switch (ns) {
      case 'domain': return '#a78bfa';
      case 'who': return '#22d3ee';
      case 'org': return '#fb923c';
      case 'ctx': return '#34d399';
    }
  };

  return createPortal(
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="bulk-tag-modal" onClick={(e) => e.stopPropagation()}>
        <div className="bulk-tag-modal-header">
          <h3>{t('bulkTagTitle', language)}</h3>
          <span className="bulk-tag-modal-count">
            {tf('addTagsToSelectedNotes', language, { count: paths.length })}
          </span>
        </div>

        {/* Namespace tabs */}
        <div className="bulk-tag-namespace-tabs">
          {FACET_INFOS.map((facet) => (
            <button
              key={facet.namespace}
              className={`bulk-tag-ns-tab ${activeNamespace === facet.namespace ? 'active' : ''}`}
              style={activeNamespace === facet.namespace ? {
                borderBottomColor: getNamespaceColor(facet.namespace),
                color: getNamespaceColor(facet.namespace),
              } : undefined}
              onClick={() => {
                setActiveNamespace(facet.namespace);
                setInputValue('');
                setSuggestions([]);
                inputRef.current?.focus();
              }}
            >
              {t(facet.label, language)}
            </button>
          ))}
        </div>

        {/* Tag input with autocomplete */}
        <div className="bulk-tag-input-wrapper">
          <input
            ref={inputRef}
            type="text"
            className="bulk-tag-input"
            value={inputValue}
            onChange={e => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t('bulkTagSelectPrompt', language)}
            autoComplete="off"
            disabled={isApplying}
          />
          {suggestions.length > 0 && (
            <div className="bulk-tag-suggestions">
              {suggestions.map((suggestion, index) => (
                <button
                  key={suggestion.id}
                  type="button"
                  className={`bulk-tag-suggestion-item ${index === selectedSuggestionIndex ? 'selected' : ''}`}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    handleSelectSuggestion(suggestion.id);
                  }}
                >
                  {suggestion.label}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Selected tags display */}
        {selectedTags.length > 0 && (
          <div className="bulk-tag-selected-list">
            {selectedTags.map((st, idx) => (
              <span
                key={`${st.namespace}-${st.tag}`}
                className="bulk-tag-chip"
                style={{
                  backgroundColor: `color-mix(in srgb, ${getNamespaceColor(st.namespace)} 15%, transparent)`,
                  border: `1px solid color-mix(in srgb, ${getNamespaceColor(st.namespace)} 30%, transparent)`,
                  color: getNamespaceColor(st.namespace),
                }}
              >
                <span className="bulk-tag-chip-ns">{st.namespace}/</span>
                {st.tag}
                <button
                  type="button"
                  className="bulk-tag-chip-remove"
                  onClick={() => removeTag(idx)}
                  disabled={isApplying}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}

        {/* Actions */}
        <div className="bulk-tag-modal-actions">
          <button
            className="bulk-tag-cancel-btn"
            onClick={onClose}
            disabled={isApplying}
          >
            {t('cancel', language)}
          </button>
          <button
            className="bulk-tag-apply-btn"
            onClick={handleApply}
            disabled={selectedTags.length === 0 || isApplying}
          >
            {isApplying ? '...' : t('bulkTagApply', language)}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

export default BulkTagModal;
