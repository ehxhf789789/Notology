import { fileCommands, searchCommands } from '../../core/services/tauriCommands';
import { join } from '../../web/path';
import { load, type Store } from '../../web/store';
import yaml from 'js-yaml';
import type { TagOntology, TagDefinition, TagNode, FacetNamespace, TagStyle } from '../../core/types/tagOntology';
import type { FacetedTagSettings } from '../../core/types';

let cachedOntology: TagOntology | null = null;
let syncedThisSession = false; // Track if we've synced tags this session
let migratedThisSession = false; // Track if we've migrated tag settings this session
let lastKnownOntologyVersion: string | null = null; // Track version for conflict detection

// Extended ontology with version metadata
interface OntologyWithMeta extends TagOntology {
  _meta?: {
    version: string;
    lastModified: string;
  };
}

/**
 * Generate a simple version string based on current time
 */
function generateVersion(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
}

// Hash function for vault path to create safe filename (must match appStore)
function hashVaultPath(vaultPath: string): string {
  const encoded = btoa(unescape(encodeURIComponent(vaultPath)));
  return encoded.replace(/[/+=]/g, '_').slice(0, 64);
}

// Get vault-specific store
async function getVaultStore(vaultPath: string): Promise<Store> {
  const hash = hashVaultPath(vaultPath);
  return await load(`vault_${hash}.json`, { autoSave: true, defaults: {} });
}

/**
 * Load tag ontology from .notology/tag-ontology.yaml
 * Automatically syncs tags from search index on first load
 */
export async function loadTagOntology(vaultPath: string, skipSync = false): Promise<TagOntology> {
  if (cachedOntology) {
    console.log('[loadTagOntology] Returning cached ontology');
    return cachedOntology;
  }

  try {
    console.log('[loadTagOntology] Loading ontology from vault:', vaultPath);

    // Ensure .notology directory exists
    const metaPath = await join(vaultPath, '.notology');
    console.log('[loadTagOntology] .notology path:', metaPath);

    try {
      await fileCommands.ensureDirectory(metaPath);
      console.log('[loadTagOntology] .notology folder created or already exists');
    } catch (e) {
      console.log('[loadTagOntology] ensure_directory error:', e);
      // Continue anyway, will fail on write if directory really doesn't exist
    }

    const ontologyPath = await join(vaultPath, '.notology', 'tag-ontology.yaml');
    console.log('[loadTagOntology] Ontology file path:', ontologyPath);

    let ontology: TagOntology;

    try {
      console.log('[loadTagOntology] Attempting to read ontology file...');
      const yamlContent = await fileCommands.readTextFile(ontologyPath);
      console.log('[loadTagOntology] Successfully read file, length:', yamlContent.length);

      // Parse YAML
      ontology = yaml.load(yamlContent) as TagOntology;
      console.log('[loadTagOntology] Parsed ontology, definitions:', Object.keys(ontology.definitions).length);
    } catch (e) {
      console.log('[loadTagOntology] File read failed, creating default ontology:', e);

      // File doesn't exist, create default ontology
      ontology = {
        definitions: {},
        synonyms: {},
      };

      // Save default ontology
      const yamlContent = yaml.dump(ontology, { lineWidth: -1, noRefs: true });
      console.log('[loadTagOntology] Writing default ontology, YAML length:', yamlContent.length);

      await fileCommands.writeFile(ontologyPath, null, yamlContent);

      console.log('[loadTagOntology] Default ontology file created successfully');
    }

    // Auto-sync tags from search index (only once per session)
    // Then cleanup unused tags (Obsidian-style: tags not in any note are removed)
    if (!skipSync && !syncedThisSession) {
      syncedThisSession = true;
      // Cleanup orphan recent tags from localStorage
      cleanupOrphanRecentTags(ontology);
      // Run sync in background (don't block loading)
      syncTagsFromIndex(vaultPath, ontology).then(async synced => {
        if (synced) {
          console.log('[loadTagOntology] Tags synced from index, cache updated');
        }
        // After sync, cleanup unused tags (Obsidian logic)
        try {
          const removedCount = await cleanupUnusedTags(vaultPath);
          if (removedCount > 0) {
            console.log(`[loadTagOntology] Cleaned up ${removedCount} unused tags`);
          }
        } catch (cleanupErr) {
          console.error('[loadTagOntology] Tag cleanup failed:', cleanupErr);
        }
      }).catch(err => {
        console.error('[loadTagOntology] Background sync failed:', err);
      });
    }

    // Auto-migrate tag settings from Tauri Store to ontology (only once per session)
    // This enables vault portability - tag styles will be stored in the vault
    if (!skipSync && !migratedThisSession) {
      migratedThisSession = true;
      // Run migration in background (don't block loading)
      migrateTagSettingsToOntology(vaultPath, ontology).then(migrated => {
        if (migrated) {
          console.log('[loadTagOntology] Tag settings migrated to ontology');
        }
      }).catch(err => {
        console.error('[loadTagOntology] Tag settings migration failed:', err);
      });
    }

    cachedOntology = ontology;
    return ontology;
  } catch (error) {
    console.error('[loadTagOntology] Failed to load tag ontology:', error);
    console.error('[loadTagOntology] Error details:', JSON.stringify(error));
    // Return empty ontology as fallback
    return {
      definitions: {},
      synonyms: {},
    };
  }
}

/**
 * Clear the cached ontology (call when ontology file is updated)
 */
export function clearOntologyCache(resetSync = false, resetMigration = false) {
  cachedOntology = null;
  if (resetSync) {
    syncedThisSession = false;
  }
  if (resetMigration) {
    migratedThisSession = false;
  }
}

/**
 * Sync tags from search index to ontology
 * This ensures all tags used in notes are registered in the ontology for autocomplete
 */
export async function syncTagsFromIndex(vaultPath: string, ontology: TagOntology): Promise<boolean> {
  try {
    console.log('[syncTagsFromIndex] Starting tag sync from index...');

    // Query all notes from the search index
    const notes = await searchCommands.queryNotes({ sort_by: 'modified', sort_order: 'desc' }) as Array<{ tags: string[] }>;

    // Collect all unique tags from notes
    const allTags = new Set<string>();
    for (const note of notes) {
      for (const tag of note.tags) {
        allTags.add(tag);
      }
    }

    console.log('[syncTagsFromIndex] Found', allTags.size, 'unique tags in index');

    // Find tags that are not in ontology
    const missingTags: string[] = [];
    for (const tag of allTags) {
      if (!ontology.definitions[tag]) {
        missingTags.push(tag);
      }
    }

    if (missingTags.length === 0) {
      console.log('[syncTagsFromIndex] All tags already in ontology');
      return false;
    }

    console.log('[syncTagsFromIndex] Adding', missingTags.length, 'missing tags to ontology');

    // Add missing tags to ontology
    for (const tagId of missingTags) {
      // Parse namespace and label from tagId (format: "namespace/label")
      const slashIndex = tagId.indexOf('/');
      if (slashIndex === -1) continue; // Skip invalid format

      const namespace = tagId.substring(0, slashIndex);
      const label = tagId.substring(slashIndex + 1);

      // 11th hotfix (2026-05-18, HanBin) — narrowed back to the canonical
      // 4 facets after the Rust-side Q1 cleanup. The wider 7-facet filter
      // (introduced 2026-05-17 as a temporary safety net) is no longer
      // needed: deserialize_tags now folds any legacy source/method/status
      // entries into ctx on read, so the only namespaces reaching this
      // function are the 4 we actually keep.
      if (!['domain', 'who', 'org', 'ctx', 'key', 'proj', 'acad'].includes(namespace)) continue;

      // Add to ontology definitions
      ontology.definitions[tagId] = {
        label: label,
        description: `자동 동기화된 태그: ${label}`,
      };
    }

    // Save updated ontology
    const ontologyPath = await join(vaultPath, '.notology', 'tag-ontology.yaml');
    const yamlContent = yaml.dump(ontology, { lineWidth: -1, noRefs: true });

    await fileCommands.writeFile(ontologyPath, null, yamlContent);

    console.log('[syncTagsFromIndex] Successfully synced', missingTags.length, 'tags');
    return true;
  } catch (error) {
    console.error('[syncTagsFromIndex] Failed to sync tags:', error);
    return false;
  }
}

/**
 * Migrate tag settings from Tauri Store to ontology
 * This enables vault portability - tag styles are stored in the vault's .notology folder
 *
 * Migration is automatic and runs once per session when loading ontology.
 * After migration, tag_settings in Tauri Store can be safely ignored.
 */
export async function migrateTagSettingsToOntology(
  vaultPath: string,
  ontology: TagOntology
): Promise<boolean> {
  try {
    console.log('[migrateTagSettingsToOntology] Starting migration check...');

    // Load tag settings from Tauri Store
    const vaultStore = await getVaultStore(vaultPath);
    const tagSettings = await vaultStore.get<FacetedTagSettings>('tag_settings');

    if (!tagSettings) {
      console.log('[migrateTagSettingsToOntology] No tag_settings found in store');
      return false;
    }

    let migratedCount = 0;
    const namespaces: FacetNamespace[] = ['domain', 'who', 'org', 'ctx', 'key', 'proj', 'acad'];

    for (const namespace of namespaces) {
      const namespaceSettings = tagSettings[namespace];
      if (!namespaceSettings) continue;

      for (const [tagName, config] of Object.entries(namespaceSettings)) {
        if (!config.color && !config.borderColor) continue;

        // Build full tag ID
        const fullTagId = `${namespace}/${tagName}`;

        // Get or create tag definition
        let definition = ontology.definitions[fullTagId];
        if (!definition) {
          // Create new definition if tag doesn't exist
          definition = {
            label: tagName,
            description: `마이그레이션된 태그: ${tagName}`,
          };
          ontology.definitions[fullTagId] = definition;
        }

        // Check if style needs to be updated
        const existingStyle = definition.style;
        const newStyle: TagStyle = {
          color: config.color,
          borderColor: config.borderColor,
        };

        // Only update if style differs or doesn't exist
        const needsUpdate = !existingStyle ||
          existingStyle.color !== newStyle.color ||
          existingStyle.borderColor !== newStyle.borderColor;

        if (needsUpdate) {
          // Prefer existing ontology style (already migrated previously)
          // unless store has newer settings (indicated by having values)
          if (!existingStyle) {
            definition.style = newStyle;
            migratedCount++;
          }
        }
      }
    }

    if (migratedCount === 0) {
      console.log('[migrateTagSettingsToOntology] No new settings to migrate');
      return false;
    }

    // Save updated ontology
    const ontologyPath = await join(vaultPath, '.notology', 'tag-ontology.yaml');
    const yamlContent = yaml.dump(ontology, { lineWidth: -1, noRefs: true });

    await fileCommands.writeFile(ontologyPath, null, yamlContent);

    console.log('[migrateTagSettingsToOntology] Successfully migrated', migratedCount, 'tag styles');
    return true;
  } catch (error) {
    console.error('[migrateTagSettingsToOntology] Migration failed:', error);
    return false;
  }
}

/**
 * Get tag style from ontology (portable across devices)
 */
export function getTagStyle(ontology: TagOntology, namespace: FacetNamespace, tagName: string): TagStyle | null {
  // Strip namespace prefix if present
  let cleanTagName = tagName;
  const namespaces = ['domain', 'who', 'org', 'ctx', 'key', 'proj', 'acad'];
  for (const ns of namespaces) {
    while (cleanTagName.startsWith(`${ns}/`)) {
      cleanTagName = cleanTagName.slice(ns.length + 1);
    }
  }

  const fullTagId = `${namespace}/${cleanTagName}`;
  const definition = ontology.definitions[fullTagId];
  return definition?.style || null;
}

/**
 * Load ontology fresh from disk (bypasses cache for conflict detection)
 */
async function loadOntologyFresh(vaultPath: string): Promise<OntologyWithMeta> {
  const ontologyPath = await join(vaultPath, '.notology', 'tag-ontology.yaml');

  try {
    const yamlContent = await fileCommands.readTextFile(ontologyPath);
    const ontology = yaml.load(yamlContent) as OntologyWithMeta;
    return ontology;
  } catch (e) {
    // File doesn't exist, return empty ontology with metadata
    return {
      definitions: {},
      synonyms: {},
      _meta: {
        version: generateVersion(),
        lastModified: new Date().toISOString(),
      },
    };
  }
}

/**
 * Save ontology with conflict detection
 * Returns true if save was successful, false if conflict was detected and merged
 */
async function saveOntologyWithConflictDetection(
  vaultPath: string,
  ontology: OntologyWithMeta,
  expectedVersion: string | null
): Promise<{ saved: boolean; hadConflict: boolean }> {
  // Load fresh from disk to check for conflicts
  const freshOntology = await loadOntologyFresh(vaultPath);
  const currentVersion = freshOntology._meta?.version;

  // Check for conflict: if we had a known version and it doesn't match current
  const hadConflict = expectedVersion !== null && currentVersion !== null && expectedVersion !== currentVersion;

  if (hadConflict) {
    console.warn('[saveOntologyWithConflictDetection] Conflict detected! Merging changes...');
    console.warn('  Expected version:', expectedVersion);
    console.warn('  Current version:', currentVersion);

    // Merge strategy: prefer our changes for the specific tags we're modifying
    // but keep any other changes from the fresh version
    for (const [tagId, def] of Object.entries(freshOntology.definitions)) {
      if (!ontology.definitions[tagId]) {
        // Tag exists in fresh but not in our copy - keep it
        ontology.definitions[tagId] = def;
      }
      // If tag exists in both, our version wins (for the tag we're modifying)
    }

    // Merge synonyms
    for (const [synonym, target] of Object.entries(freshOntology.synonyms)) {
      if (!ontology.synonyms[synonym]) {
        ontology.synonyms[synonym] = target;
      }
    }
  }

  // Update version and timestamp
  ontology._meta = {
    version: generateVersion(),
    lastModified: new Date().toISOString(),
  };

  // Save to file
  const ontologyPath = await join(vaultPath, '.notology', 'tag-ontology.yaml');
  const yamlContent = yaml.dump(ontology, { lineWidth: -1, noRefs: true });

  await fileCommands.writeFile(ontologyPath, null, yamlContent);

  // Update our known version
  lastKnownOntologyVersion = ontology._meta.version;

  return { saved: true, hadConflict };
}

/**
 * Update tag style in ontology with conflict detection
 */
export async function updateTagStyle(
  vaultPath: string,
  namespace: FacetNamespace,
  tagName: string,
  style: TagStyle
): Promise<void> {
  // Strip namespace prefix if present
  let cleanTagName = tagName;
  const namespaces = ['domain', 'who', 'org', 'ctx', 'key', 'proj', 'acad'];
  for (const ns of namespaces) {
    while (cleanTagName.startsWith(`${ns}/`)) {
      cleanTagName = cleanTagName.slice(ns.length + 1);
    }
  }

  const fullTagId = `${namespace}/${cleanTagName}`;

  // Load fresh ontology (for conflict detection)
  const ontology = await loadOntologyFresh(vaultPath);
  const previousVersion = ontology._meta?.version || null;

  // Get or create definition
  let definition = ontology.definitions[fullTagId];
  if (!definition) {
    definition = {
      label: cleanTagName,
      description: `사용자 생성 태그: ${cleanTagName}`,
    };
    ontology.definitions[fullTagId] = definition;
  }

  // Update style
  definition.style = style;

  // Save with conflict detection
  const { hadConflict } = await saveOntologyWithConflictDetection(vaultPath, ontology, previousVersion);

  // Clear cache to reload with new style
  clearOntologyCache();

  if (hadConflict) {
    console.log('[updateTagStyle] Updated style for', fullTagId, '(with merge)');
  } else {
    console.log('[updateTagStyle] Updated style for', fullTagId);
  }
}

/**
 * Remove tag style from ontology with conflict detection
 */
export async function removeTagStyle(
  vaultPath: string,
  namespace: FacetNamespace,
  tagName: string
): Promise<void> {
  // Strip namespace prefix if present
  let cleanTagName = tagName;
  const namespaces = ['domain', 'who', 'org', 'ctx', 'key', 'proj', 'acad'];
  for (const ns of namespaces) {
    while (cleanTagName.startsWith(`${ns}/`)) {
      cleanTagName = cleanTagName.slice(ns.length + 1);
    }
  }

  const fullTagId = `${namespace}/${cleanTagName}`;

  // Load fresh ontology (for conflict detection)
  const ontology = await loadOntologyFresh(vaultPath);
  const previousVersion = ontology._meta?.version || null;

  const definition = ontology.definitions[fullTagId];
  if (!definition || !definition.style) {
    console.log('[removeTagStyle] No style to remove for', fullTagId);
    return;
  }

  // Remove style
  delete definition.style;

  // Save with conflict detection
  const { hadConflict } = await saveOntologyWithConflictDetection(vaultPath, ontology, previousVersion);

  // Clear cache
  clearOntologyCache();

  if (hadConflict) {
    console.log('[removeTagStyle] Removed style for', fullTagId, '(with merge)');
  } else {
    console.log('[removeTagStyle] Removed style for', fullTagId);
  }
}

/**
 * Get tag definition by ID
 */
export function getTagDefinition(ontology: TagOntology, tagId: string): TagDefinition | null {
  return ontology.definitions[tagId] || null;
}

/**
 * Resolve a tag (handle synonyms)
 */
export function resolveTag(ontology: TagOntology, tag: string): string {
  return ontology.synonyms[tag] || tag;
}

/**
 * Get all tags for a specific facet namespace
 */
export function getTagsForFacet(
  ontology: TagOntology,
  namespace: FacetNamespace
): TagNode[] {
  const rootTags: TagNode[] = [];
  const prefix = `${namespace}/`;

  // Find all tags in this namespace
  for (const [tagId, definition] of Object.entries(ontology.definitions)) {
    if (tagId.startsWith(prefix)) {
      // Only include root tags (no broader/parent)
      if (!definition.broader) {
        const node = buildTagNode(ontology, tagId);
        if (node) {
          rootTags.push(node);
        }
      }
    }
  }

  return rootTags.sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * Build a tag node with its children
 */
function buildTagNode(ontology: TagOntology, tagId: string): TagNode | null {
  const definition = ontology.definitions[tagId];
  if (!definition) return null;

  const node: TagNode = {
    id: tagId,
    label: definition.label,
    parent: definition.broader,
  };

  if (definition.children && definition.children.length > 0) {
    node.children = definition.children
      .map((childId) => buildTagNode(ontology, childId))
      .filter((child): child is TagNode => child !== null)
      .sort((a, b) => a.label.localeCompare(b.label));
  }

  return node;
}

/**
 * Get breadcrumb path for a tag
 */
export function getTagBreadcrumb(ontology: TagOntology, tagId: string): string[] {
  const breadcrumb: string[] = [];
  let currentId: string | undefined = tagId;

  while (currentId) {
    const definition: TagDefinition | undefined = ontology.definitions[currentId];
    if (!definition) break;

    breadcrumb.unshift(definition.label);
    currentId = definition.broader;
  }

  return breadcrumb;
}

/**
 * Search tags by query
 */
export function searchTags(
  ontology: TagOntology,
  query: string,
  namespace?: FacetNamespace
): Array<{ id: string; label: string; breadcrumb: string[] }> {
  const results: Array<{ id: string; label: string; breadcrumb: string[] }> = [];
  const lowerQuery = query.toLowerCase();

  for (const [tagId, definition] of Object.entries(ontology.definitions)) {
    // Filter by namespace if specified
    if (namespace && !tagId.startsWith(`${namespace}/`)) {
      continue;
    }

    // Match by label or aliases
    const matches =
      definition.label.toLowerCase().includes(lowerQuery) ||
      tagId.toLowerCase().includes(lowerQuery) ||
      (definition.aliases &&
        definition.aliases.some((alias) => alias.toLowerCase().includes(lowerQuery)));

    if (matches) {
      results.push({
        id: tagId,
        label: definition.label,
        breadcrumb: getTagBreadcrumb(ontology, tagId),
      });
    }
  }

  // Check synonyms
  for (const [synonym, targetId] of Object.entries(ontology.synonyms)) {
    if (synonym.toLowerCase().includes(lowerQuery)) {
      const definition = ontology.definitions[targetId];
      if (definition && (!namespace || targetId.startsWith(`${namespace}/`))) {
        results.push({
          id: targetId,
          label: definition.label,
          breadcrumb: getTagBreadcrumb(ontology, targetId),
        });
      }
    }
  }

  // Remove duplicates and sort
  const uniqueResults = Array.from(
    new Map(results.map((r) => [r.id, r])).values()
  );

  return uniqueResults.sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * Get recently used tags (from local storage)
 */
export function getRecentTags(namespace?: FacetNamespace): string[] {
  try {
    const key = namespace ? `recent-tags-${namespace}` : 'recent-tags';
    const stored = localStorage.getItem(key);
    return stored ? JSON.parse(stored) : [];
  } catch {
    return [];
  }
}

/**
 * Add tag to recent tags
 */
export function addToRecentTags(tagId: string, namespace?: FacetNamespace) {
  try {
    const key = namespace ? `recent-tags-${namespace}` : 'recent-tags';
    const recent = getRecentTags(namespace);

    // Remove if already exists
    const filtered = recent.filter((id) => id !== tagId);

    // Add to front
    filtered.unshift(tagId);

    // Keep only last 10
    const trimmed = filtered.slice(0, 10);

    localStorage.setItem(key, JSON.stringify(trimmed));
  } catch (error) {
    console.error('Failed to save recent tags:', error);
  }
}

/**
 * Remove tag from recent tags
 */
export function removeFromRecentTags(tagId: string, namespace?: FacetNamespace) {
  try {
    const key = namespace ? `recent-tags-${namespace}` : 'recent-tags';
    const recent = getRecentTags(namespace);

    // Filter out the tag to remove
    const filtered = recent.filter((id) => id !== tagId);

    localStorage.setItem(key, JSON.stringify(filtered));
  } catch (error) {
    console.error('Failed to remove from recent tags:', error);
  }
}

/**
 * Remove recent tag entries that no longer exist in the ontology.
 * Returns the number of orphan entries removed.
 */
export function cleanupOrphanRecentTags(ontology: TagOntology): number {
  const namespaces: FacetNamespace[] = ['domain', 'who', 'org', 'ctx', 'key', 'proj', 'acad'];
  let removed = 0;

  for (const ns of namespaces) {
    const key = `recent-tags-${ns}`;
    const raw = localStorage.getItem(key);
    if (!raw) continue;

    try {
      const recent: string[] = JSON.parse(raw);
      const filtered = recent.filter(tagId => {
        // Check both the raw tagId and the full namespace/tagId form
        const fullId = tagId.includes('/') ? tagId : `${ns}/${tagId}`;
        return ontology.definitions[fullId] || ontology.definitions[tagId];
      });
      if (filtered.length < recent.length) {
        removed += recent.length - filtered.length;
        localStorage.setItem(key, JSON.stringify(filtered));
      }
    } catch {
      // Corrupted data, remove it
      localStorage.removeItem(key);
    }
  }

  // Also clean the global recent-tags key
  const globalRaw = localStorage.getItem('recent-tags');
  if (globalRaw) {
    try {
      const recent: string[] = JSON.parse(globalRaw);
      const filtered = recent.filter(tagId => ontology.definitions[tagId]);
      if (filtered.length < recent.length) {
        removed += recent.length - filtered.length;
        localStorage.setItem('recent-tags', JSON.stringify(filtered));
      }
    } catch {
      localStorage.removeItem('recent-tags');
    }
  }

  if (removed > 0) {
    console.log(`[cleanupOrphanRecentTags] Removed ${removed} orphan recent tag entries`);
  }
  return removed;
}

/**
 * Clear all recent tags from localStorage
 */
export function clearAllRecentTags(): void {
  const namespaces = ['domain', 'who', 'org', 'ctx', 'key', 'proj', 'acad'];
  for (const ns of namespaces) {
    localStorage.removeItem(`recent-tags-${ns}`);
  }
  localStorage.removeItem('recent-tags');
}

/**
 * Delete a tag from the ontology
 */
export async function deleteTagFromOntology(
  vaultPath: string,
  tagId: string
): Promise<void> {
  try {
    console.log('[deleteTagFromOntology] Deleting tag:', tagId);

    // Load current ontology
    const ontology = await loadTagOntology(vaultPath);

    // Check if tag exists
    if (!ontology.definitions[tagId]) {
      console.log('[deleteTagFromOntology] Tag not found:', tagId);
      return;
    }

    const definition = ontology.definitions[tagId];

    // If this tag has a parent, remove it from parent's children list
    if (definition.broader) {
      const parentDef = ontology.definitions[definition.broader];
      if (parentDef && parentDef.children) {
        parentDef.children = parentDef.children.filter((id) => id !== tagId);
      }
    }

    // If this tag has children, update their broader reference (orphan them or reassign)
    if (definition.children && definition.children.length > 0) {
      for (const childId of definition.children) {
        const childDef = ontology.definitions[childId];
        if (childDef) {
          // Reassign to grandparent or make root
          childDef.broader = definition.broader;
        }
      }
    }

    // Remove tag from definitions
    delete ontology.definitions[tagId];

    // Remove any synonyms pointing to this tag
    for (const [synonym, targetId] of Object.entries(ontology.synonyms)) {
      if (targetId === tagId) {
        delete ontology.synonyms[synonym];
      }
    }

    // Save back to file
    const ontologyPath = await join(vaultPath, '.notology', 'tag-ontology.yaml');
    const yamlContent = yaml.dump(ontology, { lineWidth: -1, noRefs: true });

    await fileCommands.writeFile(ontologyPath, null, yamlContent);

    // Also remove from recent tags
    const namespace = tagId.split('/')[0] as FacetNamespace;
    removeFromRecentTags(tagId, namespace);

    // Clear cache so it reloads
    clearOntologyCache();
    console.log('[deleteTagFromOntology] Tag deleted successfully:', tagId);
  } catch (error) {
    console.error('[deleteTagFromOntology] Failed to delete tag:', error);
    throw error;
  }
}

/**
 * Rename a tag in the ontology.
 * Updates the definition key, broader/children references, and synonyms.
 */
export async function renameTagInOntology(
  vaultPath: string,
  oldTagId: string,
  newTagId: string,
  newLabel: string
): Promise<void> {
  try {
    const ontology = await loadTagOntology(vaultPath);

    const oldDef = ontology.definitions[oldTagId];
    if (!oldDef) {
      console.log('[renameTagInOntology] Old tag not found:', oldTagId);
      return;
    }

    // Copy definition to new key with updated label
    ontology.definitions[newTagId] = {
      ...oldDef,
      label: newLabel,
    };

    // Update parent's children reference
    if (oldDef.broader) {
      const parentDef = ontology.definitions[oldDef.broader];
      if (parentDef && parentDef.children) {
        parentDef.children = parentDef.children.map(id => id === oldTagId ? newTagId : id);
      }
    }

    // Update children's broader reference
    if (oldDef.children) {
      for (const childId of oldDef.children) {
        const childDef = ontology.definitions[childId];
        if (childDef && childDef.broader === oldTagId) {
          childDef.broader = newTagId;
        }
      }
    }

    // Update synonyms
    for (const [synonym, targetId] of Object.entries(ontology.synonyms)) {
      if (targetId === oldTagId) {
        ontology.synonyms[synonym] = newTagId;
      }
    }

    // Remove old definition
    delete ontology.definitions[oldTagId];

    // Save
    const ontologyPath = await join(vaultPath, '.notology', 'tag-ontology.yaml');
    const yamlContent = yaml.dump(ontology, { lineWidth: -1, noRefs: true });
    await fileCommands.writeFile(ontologyPath, null, yamlContent);

    // Update recent tags in localStorage
    const namespace = oldTagId.split('/')[0] as FacetNamespace;
    const recentKey = `recent-tags-${namespace}`;
    const recentRaw = localStorage.getItem(recentKey);
    if (recentRaw) {
      try {
        const recent: string[] = JSON.parse(recentRaw);
        const updated = recent.map(id => id === oldTagId ? newTagId : id);
        localStorage.setItem(recentKey, JSON.stringify(updated));
      } catch {}
    }

    clearOntologyCache();
  } catch (error) {
    console.error('[renameTagInOntology] Failed:', error);
    throw error;
  }
}

/**
 * Add a new tag to the ontology
 */
export async function addNewTag(
  vaultPath: string,
  namespace: FacetNamespace,
  label: string,
  parentId?: string
): Promise<string> {
  try {
    console.log('[addNewTag] Starting tag creation:', { vaultPath, namespace, label, parentId });

    // Strip any namespace prefix from label (e.g., "domain/태그" -> "태그")
    let cleanLabel = label;
    const namespaces = ['domain', 'who', 'org', 'ctx', 'key', 'proj', 'acad'];
    for (const ns of namespaces) {
      while (cleanLabel.startsWith(`${ns}/`)) {
        cleanLabel = cleanLabel.slice(ns.length + 1);
      }
    }

    // Generate tag ID - remove / from label to avoid hierarchy confusion
    // Allow: a-z, 0-9, 완성형 한글(가-힣), 자음(ㄱ-ㅎ), 모음(ㅏ-ㅣ), hyphen, underscore
    const sanitizedLabel = cleanLabel
      .replace(/\s+/g, '-')
      .replace(/\//g, '-')  // Replace / with -
      .replace(/[^a-zA-Z0-9가-힣ㄱ-ㅎㅏ-ㅣ_-]/g, '');  // Allow Korean (완성형 + 자모) + underscore

    console.log('[addNewTag] Original label:', label, 'Clean:', cleanLabel, 'Sanitized:', sanitizedLabel);

    // If sanitized label is empty, use original clean label
    const finalLabel = sanitizedLabel || cleanLabel;
    const tagId = `${namespace}/${finalLabel}`;

    console.log('[addNewTag] Generated tag ID:', tagId);

    // Load current ontology (this will create .notology folder and default file if needed)
    const ontology = await loadTagOntology(vaultPath);
    console.log('[addNewTag] Loaded ontology, definitions count:', Object.keys(ontology.definitions).length);

    // Check if tag already exists (case-insensitive)
    const existingTagId = Object.keys(ontology.definitions).find(
      key => key.toLowerCase() === tagId.toLowerCase()
    );
    if (existingTagId) {
      console.log('[addNewTag] Tag already exists:', existingTagId);
      return existingTagId; // Return existing tag ID if already exists (case-insensitive match)
    }

    // Create new tag definition
    const newDefinition: TagDefinition = {
      label,
      description: `사용자 생성 태그: ${label}`,
    };

    if (parentId) {
      newDefinition.broader = parentId;

      // Add this tag to parent's children
      const parentDef = ontology.definitions[parentId];
      if (parentDef) {
        if (!parentDef.children) {
          parentDef.children = [];
        }
        parentDef.children.push(tagId);
      }
    }

    // Add to ontology
    ontology.definitions[tagId] = newDefinition;

    // Ensure .notology folder exists before writing
    const metaPath = await join(vaultPath, '.notology');
    console.log('[addNewTag] Ensuring .notology folder exists at:', metaPath);
    try {
      await fileCommands.ensureDirectory(metaPath);
      console.log('[addNewTag] .notology folder created or already exists');
    } catch (e) {
      console.log('[addNewTag] ensure_directory error:', e);
      // Continue anyway, will fail on write if directory really doesn't exist
    }

    // Save back to file
    const ontologyPath = await join(vaultPath, '.notology', 'tag-ontology.yaml');
    console.log('[addNewTag] Writing to ontology path:', ontologyPath);

    const yamlContent = yaml.dump(ontology, { lineWidth: -1, noRefs: true });
    console.log('[addNewTag] YAML content length:', yamlContent.length);

    try {
      await fileCommands.writeFile(ontologyPath, null, yamlContent);
      console.log('[addNewTag] Successfully wrote tag ontology file');
    } catch (e) {
      console.error('[addNewTag] Failed to save tag ontology:', e);
      console.error('[addNewTag] Error details:', JSON.stringify(e));
      throw new Error(`태그 저장 실패: ${JSON.stringify(e)}`);
    }

    // Clear cache so it reloads
    clearOntologyCache();
    console.log('[addNewTag] Tag creation complete:', tagId);

    return tagId;
  } catch (error) {
    console.error('[addNewTag] Failed to add new tag:', error);
    throw error;
  }
}

/**
 * Get all tags that are defined in ontology but not used in any note
 * Returns list of unused tag IDs that can be safely removed
 */
export async function getUnusedTags(vaultPath: string): Promise<string[]> {
  try {
    // Get all tags used in notes from the search index
    const usedTags = await searchCommands.getAllUsedTags();
    const usedTagSet = new Set(usedTags);

    // Load ontology to get all defined tags
    const ontology = await loadTagOntology(vaultPath);
    const definedTags = Object.keys(ontology.definitions);

    // Find tags in ontology that are not used in any note
    const unusedTags = definedTags.filter(tagId => !usedTagSet.has(tagId));

    console.log(`[getUnusedTags] Found ${unusedTags.length} unused tags out of ${definedTags.length} defined`);
    return unusedTags;
  } catch (error) {
    console.error('[getUnusedTags] Failed to get unused tags:', error);
    throw error;
  }
}

/**
 * Remove multiple unused tags from ontology in batch
 * Returns number of tags removed
 */
export async function removeUnusedTags(
  vaultPath: string,
  tagIds: string[]
): Promise<number> {
  if (tagIds.length === 0) return 0;

  try {
    console.log(`[removeUnusedTags] Removing ${tagIds.length} unused tags`);

    // Load current ontology
    const ontology = await loadOntologyFresh(vaultPath);
    const previousVersion = ontology._meta?.version || null;

    let removedCount = 0;

    for (const tagId of tagIds) {
      if (!ontology.definitions[tagId]) continue;

      const definition = ontology.definitions[tagId];

      // If this tag has a parent, remove it from parent's children list
      if (definition.broader) {
        const parentDef = ontology.definitions[definition.broader];
        if (parentDef && parentDef.children) {
          parentDef.children = parentDef.children.filter((id) => id !== tagId);
        }
      }

      // If this tag has children, update their broader reference
      if (definition.children && definition.children.length > 0) {
        for (const childId of definition.children) {
          const childDef = ontology.definitions[childId];
          if (childDef) {
            childDef.broader = definition.broader;
          }
        }
      }

      // Remove tag from definitions
      delete ontology.definitions[tagId];

      // Remove any synonyms pointing to this tag
      for (const [synonym, targetId] of Object.entries(ontology.synonyms)) {
        if (targetId === tagId) {
          delete ontology.synonyms[synonym];
        }
      }

      // Remove from recent tags
      const namespace = tagId.split('/')[0] as FacetNamespace;
      removeFromRecentTags(tagId, namespace);

      removedCount++;
    }

    // Save with conflict detection
    await saveOntologyWithConflictDetection(vaultPath, ontology, previousVersion);

    // Clear cache
    clearOntologyCache();

    console.log(`[removeUnusedTags] Successfully removed ${removedCount} tags`);
    return removedCount;
  } catch (error) {
    console.error('[removeUnusedTags] Failed to remove unused tags:', error);
    throw error;
  }
}

/**
 * Clean up all unused tags from ontology
 * Returns number of tags removed
 */
export async function cleanupUnusedTags(vaultPath: string): Promise<number> {
  const unusedTags = await getUnusedTags(vaultPath);
  if (unusedTags.length === 0) {
    console.log('[cleanupUnusedTags] No unused tags found');
    return 0;
  }

  return await removeUnusedTags(vaultPath, unusedTags);
}
