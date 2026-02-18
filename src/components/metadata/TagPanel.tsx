import { useState, useEffect, useRef, useCallback } from 'react';
import { useFrontmatter } from '../../hooks/useFrontmatter';
import { useSettingsStore, useDevMode } from '../../stores/zustand/settingsStore';
import { t } from '../../utils/i18n';
import FacetedTagEditor from './FacetedTagEditor';
import YamlEditor from './YamlEditor';
import type { FacetedTags } from '../../types/frontmatter';

interface TagPanelProps {
  filePath: string | null;
  vaultPath: string;
  onSaved?: (tags: FacetedTags) => void;
}

type TagPanelMode = 'tags' | 'yaml';

function TagPanel({ filePath, vaultPath, onSaved }: TagPanelProps) {
  const autoSaveDelay = useSettingsStore((s) => s.autoSaveDelay);
  const language = useSettingsStore((s) => s.language);
  const devMode = useDevMode();
  const [mode, setMode] = useState<TagPanelMode>('tags');
  const [isSaving, setIsSaving] = useState(false);
  const { frontmatter, errors, isLoading, updateFrontmatter, saveFrontmatter } =
    useFrontmatter(filePath);
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isInitialLoadRef = useRef(true);
  const pendingSaveRef = useRef(false);

  // Immediate save helper (for tag changes)
  const saveImmediately = useCallback(async () => {
    if (errors.length > 0 || !frontmatter) return;
    try {
      setIsSaving(true);
      await saveFrontmatter();
      onSaved?.(frontmatter.tags || {});
    } catch (error) {
      console.error('Save failed:', error);
    } finally {
      setIsSaving(false);
    }
  }, [errors, frontmatter, saveFrontmatter, onSaved]);

  // Auto-save when frontmatter changes (with debounce) — for YAML mode
  useEffect(() => {
    if (isInitialLoadRef.current) {
      isInitialLoadRef.current = false;
      return;
    }
    if (errors.length > 0 || !frontmatter) return;

    // If a tag change triggered immediate save, skip debounce
    if (pendingSaveRef.current) {
      pendingSaveRef.current = false;
      saveImmediately();
      return;
    }

    // Debounced save for YAML mode edits
    if (mode === 'yaml') {
      if (autoSaveTimerRef.current) {
        clearTimeout(autoSaveTimerRef.current);
      }
      autoSaveTimerRef.current = setTimeout(async () => {
        try {
          setIsSaving(true);
          await saveFrontmatter();
        } catch (error) {
          console.error('Auto-save failed:', error);
        } finally {
          setIsSaving(false);
        }
      }, autoSaveDelay);
    }

    return () => {
      if (autoSaveTimerRef.current) {
        clearTimeout(autoSaveTimerRef.current);
      }
    };
  }, [frontmatter, errors, saveFrontmatter, autoSaveDelay, mode, saveImmediately]);

  // Reset initial load flag when file changes
  useEffect(() => {
    isInitialLoadRef.current = true;
  }, [filePath]);

  // Keyboard shortcut for manual save (Ctrl+S)
  useEffect(() => {
    const handleKeyDown = async (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        await saveImmediately();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [saveImmediately]);

  // Reset to tags mode when devMode is turned off
  useEffect(() => {
    if (!devMode && mode === 'yaml') {
      setMode('tags');
    }
  }, [devMode, mode]);

  const handleTagChange = (tags: FacetedTags) => {
    if (!frontmatter) return;
    pendingSaveRef.current = true;
    updateFrontmatter({ ...frontmatter, tags });
  };

  if (!filePath) {
    return (
      <div className="tag-panel-empty">
        <p>{t('selectFileForTags', language)}</p>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="tag-panel-loading">
        <p>{t('tagPanelLoading', language)}</p>
      </div>
    );
  }

  if (!frontmatter) {
    return (
      <div className="tag-panel-empty">
        <p>{t('noTags', language)}</p>
      </div>
    );
  }

  return (
    <div className="tag-panel">
      <div className="tag-panel-header">
        <span className="tag-panel-title">{t('tags', language)}</span>
        <div className="tag-panel-header-actions">
          {devMode && (
            <div className="tag-panel-mode-toggle">
              <button
                className={`tag-panel-mode-btn ${mode === 'tags' ? 'active' : ''}`}
                onClick={() => setMode('tags')}
              >
                {t('tagsMode', language)}
              </button>
              <button
                className={`tag-panel-mode-btn ${mode === 'yaml' ? 'active' : ''}`}
                onClick={() => setMode('yaml')}
              >
                {t('yamlMode', language)}
              </button>
            </div>
          )}
          {isSaving && (
            <span className="tag-panel-saving">{t('saving', language)}</span>
          )}
        </div>
      </div>

      <div className="tag-panel-content">
        {mode === 'tags' ? (
          <FacetedTagEditor
            tags={frontmatter.tags || {}}
            onChange={handleTagChange}
            vaultPath={vaultPath}
          />
        ) : (
          <YamlEditor frontmatter={frontmatter} onChange={updateFrontmatter} />
        )}
      </div>
    </div>
  );
}

export default TagPanel;
