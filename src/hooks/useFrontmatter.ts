import { useState, useEffect, useCallback } from 'react';
import { fileCommands, noteCommands, searchCommands } from '../services/tauriCommands';
import type { Frontmatter, ValidationError } from '../types/frontmatter';
import {
  parseFrontmatter,
  validateFrontmatter,
  frontmatterToYaml,
  updateModifiedTimestamp,
} from '../utils/frontmatterUtils';
import { refreshActions } from '../stores/zustand/refreshStore';
import { markAsSelfSaved } from '../utils/selfSaveTracker';
import { notifyFileSaved, notifySearchIndexUpdated } from '../utils/windowSync';

interface UseFrontmatterReturn {
  frontmatter: Frontmatter | null;
  body: string;
  errors: ValidationError[];
  isValid: boolean;
  isLoading: boolean;
  updateFrontmatter: (fm: Frontmatter) => void;
  saveFrontmatter: () => Promise<void>;
}

export function useFrontmatter(filePath: string | null): UseFrontmatterReturn {
  const incrementSearchRefresh = refreshActions.incrementSearchRefresh;
  const [frontmatter, setFrontmatter] = useState<Frontmatter | null>(null);
  const [body, setBody] = useState<string>('');
  const [errors, setErrors] = useState<ValidationError[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  // Load frontmatter from file
  useEffect(() => {
    if (!filePath) return;

    const loadFrontmatter = async () => {
      try {
        setIsLoading(true);
        const fileContent = await fileCommands.readFile(filePath);

        if (fileContent.frontmatter) {
          const content = `---\n${fileContent.frontmatter}\n---\n\n${fileContent.body}`;
          try {
            const parsed = await parseFrontmatter(content);
            if (parsed.frontmatter) {
              setFrontmatter(parsed.frontmatter);
              setBody(parsed.body);

              // Validate immediately
              const validationErrors = await validateFrontmatter(parsed.frontmatter);
              setErrors(validationErrors);
            } else {
              // Parsing succeeded but returned null frontmatter
              console.warn('Frontmatter parsing returned null for:', filePath);
              setFrontmatter(null);
              setBody(fileContent.body);
              setErrors([{ path: '', message: 'Failed to parse frontmatter' }]);
            }
          } catch (parseError) {
            // Parsing failed - log error and show empty state
            console.error('Frontmatter parse error for', filePath, ':', parseError);
            setFrontmatter(null);
            setBody(fileContent.body);
            setErrors([{ path: '', message: `Parse error: ${parseError}` }]);
          }
        } else {
          setFrontmatter(null);
          setBody(fileContent.body);
          setErrors([]);
        }
      } catch (error) {
        console.error('Failed to load frontmatter:', error);
        setErrors([{ path: '', message: String(error) }]);
      } finally {
        setIsLoading(false);
      }
    };

    loadFrontmatter();
  }, [filePath]);

  // Real-time validation when frontmatter changes
  useEffect(() => {
    if (!frontmatter) {
      setErrors([]);
      return;
    }

    const validate = async () => {
      try {
        const validationErrors = await validateFrontmatter(frontmatter);
        setErrors(validationErrors);
      } catch (error) {
        console.error('Validation error:', error);
        setErrors([{ path: '', message: String(error) }]);
      }
    };

    validate();
  }, [frontmatter]);

  // Update frontmatter (in-memory)
  const updateFrontmatter = useCallback((fm: Frontmatter) => {
    const updated = updateModifiedTimestamp(fm);
    setFrontmatter(updated);
  }, []);

  // Save frontmatter to file
  const saveFrontmatter = useCallback(async () => {
    if (!filePath || !frontmatter) return;

    try {
      const yaml = await frontmatterToYaml(frontmatter);
      await noteCommands.updateFrontmatter(filePath, yaml);

      // Mark as self-saved to prevent false "external change" warnings from file watcher
      markAsSelfSaved(filePath);

      // Notify other windows about save (for cache invalidation)
      notifyFileSaved(filePath).catch(() => {});

      // Re-index in background, then notify all windows
      searchCommands.indexNote(filePath).then(() => {
        incrementSearchRefresh();
        notifySearchIndexUpdated(filePath).catch(() => {});
      }).catch((err) => {
        console.error('Background index failed:', err);
      });
    } catch (error) {
      console.error('Failed to save frontmatter:', error);
      throw error;
    }
  }, [filePath, frontmatter, incrementSearchRefresh]);

  return {
    frontmatter,
    body,
    errors,
    isValid: errors.length === 0,
    isLoading,
    updateFrontmatter,
    saveFrontmatter,
  };
}
