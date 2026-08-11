import { useState, useEffect, useRef, useCallback } from 'react';
import type { FacetedTags } from '../../core/types/frontmatter';
import type { TagOntology, FacetNamespace } from '../../core/types/tagOntology';
import { FACET_NAMESPACES } from '../../core/types/tagOntology';
import { loadTagOntology, addToRecentTags, addNewTag } from './tagOntologyUtils';
import HierarchicalTagSelector from './HierarchicalTagSelector';
import { useOntologyRefreshTrigger, refreshActions } from '../../core/stores/refreshStore';
import { useSettingsStore } from '../../core/stores/settingsStore';
import { t } from '../../core/utils/i18n';
import { BookOpen, Users, Building2, Activity } from 'lucide-react';
import type { FacetIconName } from '../../core/types/tagOntology';

const FACET_ICONS: Record<FacetIconName, React.ComponentType<{ size?: number; className?: string }>> = {
  BookOpen, Users, Building2, Activity,
};

interface FacetedTagEditorProps {
  tags: FacetedTags;
  onChange: (tags: FacetedTags) => void;
  vaultPath: string;
}

function FacetedTagEditor({ tags, onChange, vaultPath }: FacetedTagEditorProps) {
  const language = useSettingsStore(s => s.language);
  const ontologyRefreshTrigger = useOntologyRefreshTrigger();
  const incrementOntologyRefresh = refreshActions.incrementOntologyRefresh;
  const [ontology, setOntology] = useState<TagOntology | null>(null);
  const [activeFacet, setActiveFacet] = useState<FacetNamespace | null>(null);
  const [overflowFacets, setOverflowFacets] = useState<Set<FacetNamespace>>(new Set());
  const tagContainerRefs = useRef<Record<string, HTMLDivElement | null>>({});

  // Check overflow for each facet tag container
  const checkOverflow = useCallback(() => {
    const newOverflow = new Set<FacetNamespace>();
    for (const facet of FACET_NAMESPACES) {
      const el = tagContainerRefs.current[facet.namespace];
      if (el && el.scrollWidth > el.clientWidth) {
        newOverflow.add(facet.namespace);
      }
    }
    setOverflowFacets(newOverflow);
  }, []);

  useEffect(() => {
    checkOverflow();
  }, [tags, checkOverflow]);

  // Wheel event → horizontal scroll (native listener to allow preventDefault)
  useEffect(() => {
    const handlers: Array<{ el: HTMLDivElement; handler: (e: WheelEvent) => void }> = [];
    for (const facet of FACET_NAMESPACES) {
      const el = tagContainerRefs.current[facet.namespace];
      if (!el) continue;
      const handler = (e: WheelEvent) => {
        if (el.scrollWidth <= el.clientWidth) return;
        e.preventDefault();
        e.stopPropagation();
        el.scrollLeft += e.deltaY !== 0 ? e.deltaY : e.deltaX;
      };
      el.addEventListener('wheel', handler, { passive: false });
      handlers.push({ el, handler });
    }
    return () => {
      for (const { el, handler } of handlers) {
        el.removeEventListener('wheel', handler);
      }
    };
  }, [tags, ontology]);

  // Strip namespace prefix from tag name
  const stripNamespacePrefix = (tagName: string): string => {
    let clean = tagName;
    const namespaces = ['domain', 'who', 'org', 'ctx', 'key', 'proj', 'acad'];
    for (const ns of namespaces) {
      while (clean.startsWith(`${ns}/`)) {
        clean = clean.slice(ns.length + 1);
      }
    }
    return clean;
  };

  useEffect(() => {
    const loadOntology = async () => {
      // OPTIMIZATION: Use cached ontology for fast loading
      // Cache is only cleared when explicitly needed (tag edit, ontology refresh)
      const ont = await loadTagOntology(vaultPath);
      setOntology(ont);
    };
    loadOntology();
  }, [vaultPath, ontologyRefreshTrigger]);

  const addTag = async (namespace: FacetNamespace, tagId: string) => {
    // Strip namespace prefix if present (e.g., "domain/특허출원" -> "특허출원")
    let cleanTagId = tagId;
    const namespaces = ['domain', 'who', 'org', 'ctx', 'key', 'proj', 'acad'];
    for (const ns of namespaces) {
      while (cleanTagId.startsWith(`${ns}/`)) {
        cleanTagId = cleanTagId.slice(ns.length + 1);
      }
    }

    const currentTags = tags[namespace] || [];

    // Don't add if already exists (case-insensitive comparison)
    const existsInTags = currentTags.some(
      t => t.toLowerCase() === cleanTagId.toLowerCase()
    );
    if (existsInTags) {
      return;
    }

    onChange({
      ...tags,
      [namespace]: [...currentTags, cleanTagId],
    });

    // Add tag to ontology if it doesn't exist (case-insensitive check)
    if (ontology) {
      const fullTagId = `${namespace}/${cleanTagId}`;
      const fullTagIdLower = fullTagId.toLowerCase();
      const existsInOntology = Object.keys(ontology.definitions).some(
        key => key.toLowerCase() === fullTagIdLower
      );
      if (!existsInOntology) {
        try {
          await addNewTag(vaultPath, namespace, cleanTagId);
          incrementOntologyRefresh(); // Trigger refresh for all components
        } catch (error) {
          console.error('Failed to add tag to ontology:', error);
        }
      }
    }

    addToRecentTags(tagId, namespace); // Keep full ID for recent tags (ontology lookup)
    setActiveFacet(null);
  };

  const removeTag = (namespace: FacetNamespace, tagId: string) => {
    const currentTags = tags[namespace] || [];
    const cleanId = stripNamespacePrefix(tagId);
    // Remove both the clean ID and the full ID (for backwards compatibility)
    onChange({
      ...tags,
      [namespace]: currentTags.filter((t) => t !== tagId && t !== cleanId && stripNamespacePrefix(t) !== cleanId),
    });
  };

  const getTagLabel = (namespace: FacetNamespace, tagId: string): string => {
    if (!ontology) return stripNamespacePrefix(tagId);
    // Try full ID first (namespace/tagName), then just tagName
    const fullId = tagId.includes('/') ? tagId : `${namespace}/${tagId}`;
    const def = ontology.definitions[fullId] || ontology.definitions[tagId];
    return def?.label || stripNamespacePrefix(tagId);
  };

  if (!ontology) {
    return <div className="faceted-tag-editor-loading">{t('tagOntologyLoading', language)}</div>;
  }

  return (
    <div className="faceted-tag-editor">
      <h3 className="faceted-tag-editor-title">{t('facetedTags', language)}</h3>

      {FACET_NAMESPACES.map((facet) => {
        const facetTags = tags[facet.namespace] || [];

        return (
          <div key={facet.namespace} className="facet-group">
            <div className="facet-header">
              <div>
                <span className="facet-label">
                  {(() => { const Icon = FACET_ICONS[facet.icon]; return <Icon size={13} className="facet-icon" />; })()}
                  {facet.label}
                </span>
                <span className="facet-description">{facet.description}</span>
              </div>
              <button
                className="facet-add-btn"
                onClick={() =>
                  setActiveFacet(
                    activeFacet === facet.namespace ? null : facet.namespace
                  )
                }
              >
                {t('addBtn', language)}
              </button>
            </div>

            {facetTags.length > 0 && (
              <div className="facet-tags-wrapper">
                <div
                  className={`facet-tags ${overflowFacets.has(facet.namespace) ? 'has-overflow' : ''}`}
                  ref={(el) => { tagContainerRefs.current[facet.namespace] = el; }}
                >
                  {facetTags.map((tagId) => (
                    <div
                      key={tagId}
                      className={`tag-chip tag-${facet.namespace}`}
                    >
                      <span className="tag-label">{getTagLabel(facet.namespace, tagId)}</span>
                      <button
                        className="tag-remove-btn"
                        onClick={() => removeTag(facet.namespace, tagId)}
                        title={t('removeBtn', language)}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
                {overflowFacets.has(facet.namespace) && (
                  <span className="facet-tags-count">{facetTags.length}</span>
                )}
              </div>
            )}

            {activeFacet === facet.namespace && (
              <HierarchicalTagSelector
                namespace={facet.namespace}
                ontology={ontology}
                onSelect={(tagId) => addTag(facet.namespace, tagId)}
                onClose={() => setActiveFacet(null)}
                vaultPath={vaultPath}
              />
            )}
          </div>
        );
      })}

    </div>
  );
}

export default FacetedTagEditor;
