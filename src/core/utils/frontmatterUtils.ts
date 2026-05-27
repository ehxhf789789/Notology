import { frontmatterCommands } from '../services/tauriCommands';
import { getCurrentTimestamp } from './frontmatter';
import type {
  Frontmatter,
  ValidationError,
  ParsedNote,
  NoteType,
  State,
  FacetedTags,
} from '../types/frontmatter';

/**
 * Parse markdown content into frontmatter and body
 */
export async function parseFrontmatter(content: string): Promise<ParsedNote> {
  const result = await frontmatterCommands.parseFrontmatter<ParsedNote>(content);
  return result;
}

/**
 * Validate frontmatter against schema
 */
export async function validateFrontmatter(frontmatter: Frontmatter): Promise<ValidationError[]> {
  const frontmatterJson = JSON.stringify(frontmatter);
  const errors = await frontmatterCommands.validateFrontmatter<ValidationError[]>(frontmatterJson);
  return errors;
}

/**
 * Convert frontmatter object to YAML string
 */
export async function frontmatterToYaml(frontmatter: Frontmatter): Promise<string> {
  const frontmatterJson = JSON.stringify(frontmatter);
  const yaml = await frontmatterCommands.frontmatterToYaml(frontmatterJson);
  return yaml;
}

/**
 * Parse YAML string to frontmatter object
 */
export async function yamlToFrontmatter(yamlStr: string): Promise<Frontmatter> {
  const frontmatter = await frontmatterCommands.yamlToFrontmatter<Frontmatter>(yamlStr);
  return frontmatter;
}

/**
 * Generate a new note ID (14-digit timestamp)
 */
export function generateNoteId(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');
  return `${year}${month}${day}${hours}${minutes}${seconds}`;
}

/**
 * Create default frontmatter for a note type
 */
export function createDefaultFrontmatter(noteType: NoteType, title: string): Frontmatter {
  const now = getCurrentTimestamp();
  const id = generateNoteId();

  // Map note type to CSS class
  const cssClassMap: Record<NoteType, string> = {
    'NOTE': 'note-type',
    'MTG': 'mtg-type',
    'PAPER': 'paper-type',
    'THEO': 'theo-type',
    'CONTACT': 'contact-type',
    'CONTAINER': 'container-type',
    'LIT': 'lit-type',
    'EVENT': 'event-type',
    'OFA': 'ofa-type',
    'SEM': 'sem-type',
    'DATA': 'data-type',
    'SETUP': 'setup-type',
    'SKETCH': 'sketch-type',
    'TASK': 'task-type',
    'ADM': 'adm-type',
  };

  const base = {
    id,
    title,
    type: noteType,
    created: now,
    modified: now,
    state: {
      workflow: 'draft' as const,
      confidence: 'unverified' as const,
      maturity: 1,
    },
    tags: {
      domain: [],
      who: [],
      org: [],
      ctx: [],
      source: [],
      method: [],
      status: [],
    },
    relations: [],
    cssclasses: [cssClassMap[noteType]],
  };

  return base as Frontmatter;
}

/**
 * Update the modified timestamp
 */
export function updateModifiedTimestamp(frontmatter: Frontmatter): Frontmatter {
  return {
    ...frontmatter,
    modified: getCurrentTimestamp(),
  };
}

/**
 * Merge faceted tags (combines two tag objects)
 */
export function mergeFacetedTags(tags1: FacetedTags, tags2: FacetedTags): FacetedTags {
  return {
    domain: [...(tags1.domain || []), ...(tags2.domain || [])],
    who: [...(tags1.who || []), ...(tags2.who || [])],
    org: [...(tags1.org || []), ...(tags2.org || [])],
    ctx: [...(tags1.ctx || []), ...(tags2.ctx || [])],
    source: [...(tags1.source || []), ...(tags2.source || [])],
    method: [...(tags1.method || []), ...(tags2.method || [])],
    status: [...(tags1.status || []), ...(tags2.status || [])],
  };
}

/**
 * Get all tags as flat array
 */
export function getFlatTags(tags: FacetedTags): string[] {
  return [
    ...(tags.domain || []),
    ...(tags.who || []),
    ...(tags.org || []),
    ...(tags.ctx || []),
  ];
}

/**
 * Get inverse relation type
 */
export function getInverseRelationType(relationType: string): string {
  const inverseMap: Record<string, string> = {
    'supports': 'supports',
    'refutes': 'refutes',
    'extends': 'extends',
    'implements': 'implements',
    'derives-from': 'derives-from',
    'part-of': 'part-of',
    'is-example-of': 'is-example-of',
    'causes': 'causes',
  };
  return inverseMap[relationType] || relationType;
}

/**
 * Workflow state labels (i18n keys)
 */
export const WORKFLOW_LABELS: Record<string, string> = {
  'draft': 'workflowDraft',
  'in-progress': 'workflowInProgress',
  'review': 'workflowReview',
  'final': 'workflowFinal',
  'archived': 'workflowArchived',
};

/**
 * Confidence state labels (i18n keys)
 */
export const CONFIDENCE_LABELS: Record<string, string> = {
  'unverified': 'confidenceUnverified',
  'verified': 'confidenceVerified',
  'outdated': 'confidenceOutdated',
  'disputed': 'confidenceDisputed',
};

/**
 * Note type labels (i18n keys)
 */
export const NOTE_TYPE_LABELS: Record<NoteType, string> = {
  'NOTE': 'noteTypeNote',
  'MTG': 'noteTypeMtg',
  'PAPER': 'noteTypePaper',
  'THEO': 'noteTypeTheo',
  'TASK': 'noteTypeTask',
  'LIT': 'noteTypeLit',
  'EVENT': 'noteTypeEvent',
  'CONTACT': 'noteTypeContact',
  'CONTAINER': 'noteTypeContainer',
  'ADM': 'noteTypeAdm',
  'OFA': 'noteTypeOfa',
  'SEM': 'noteTypeSem',
  'DATA': 'noteTypeData',
  'SETUP': 'noteTypeSetup',
  'SKETCH': 'noteTypeSketch',
};

/**
 * Facet namespace labels (i18n keys)
 */
export const FACET_LABELS: Record<string, string> = {
  'domain': 'facetLabelDomain',
  'who': 'facetLabelWho',
  'org': 'facetLabelOrg',
  'ctx': 'facetLabelCtx',
  'source': 'facetLabelSource',
  'method': 'facetLabelMethod',
  'status': 'facetLabelStatus',
};
