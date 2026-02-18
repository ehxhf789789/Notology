import type { FolderNoteTemplate, NoteTemplate, NoteFrontmatter } from '../types';
import type { NoteType } from '../types/frontmatter';
import type { FacetedTagSelection } from '../components/TagInputSection';
import { serializeFrontmatter, getCurrentTimestamp } from './frontmatter';
import { createFromTemplate, getBodyTemplate, applyTemplateVariables as applyTemplateVars } from './templateUtils';
import type { LanguageSetting } from './i18n';
import { t } from './i18n';
import yaml from 'js-yaml';

export const DEFAULT_TEMPLATES: FolderNoteTemplate[] = [
  {
    id: 'a-l0',
    name: 'Base - Root (L0)',
    type: 'A',
    level: 0,
    frontmatter: {
      type: 'CONTAINER',
      cssclasses: ['folder-l0'],
    },
    body: '# 무엇에 관한 컨테이너인가요?\n> 설명을 입력하세요\n\n',
  },
  {
    id: 'a-l1',
    name: 'Base - Sub (L1)',
    type: 'A',
    level: 1,
    frontmatter: {
      type: 'CONTAINER',
      cssclasses: ['folder-l1'],
    },
    body: '# 무엇에 관한 폴더인가요?\n> 설명을 입력하세요\n\n',
  },
  {
    id: 'a-l2',
    name: 'Base - Deep (L2+)',
    type: 'A',
    level: 2,
    frontmatter: {
      type: 'CONTAINER',
      cssclasses: ['folder-l2'],
    },
    body: '',
  },
];

export function findTemplateForLevel(
  templates: FolderNoteTemplate[],
  level: number,
  preferredType: 'A' | 'B' = 'A'
): FolderNoteTemplate {
  // First try exact level match with preferred type
  const exact = templates.find(t => t.type === preferredType && t.level === level);
  if (exact) return exact;

  // Fall back to highest level <= requested level with preferred type
  const candidates = templates
    .filter(t => t.type === preferredType && t.level <= level)
    .sort((a, b) => b.level - a.level);

  if (candidates.length > 0) return candidates[0];

  // Fall back to type A if type B not found
  if (preferredType === 'B') {
    return findTemplateForLevel(templates, level, 'A');
  }

  // Ultimate fallback
  return DEFAULT_TEMPLATES[DEFAULT_TEMPLATES.length - 1];
}

export function applyTemplateVariables(
  template: FolderNoteTemplate,
  vars: Record<string, string>,
  language: LanguageSetting = 'ko'
): { frontmatter: string; body: string } {
  // Resolve body with language-aware folder note guide
  let body = template.id === 'a-l0' ? t('folderNoteContainerGuide', language)
    : template.id === 'a-l1' ? t('folderNoteSubGuide', language)
    : template.body;
  for (const [key, value] of Object.entries(vars)) {
    body = body.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value);
  }

  const now = getCurrentTimestamp();
  const fullFm: NoteFrontmatter = {
    created: now,
    modified: now,
    title: vars.title || '',
    ...template.frontmatter,
  };

  return {
    frontmatter: serializeFrontmatter(fullFm),
    body,
  };
}

// *** Note Templates ***

export const DEFAULT_NOTE_TEMPLATES: NoteTemplate[] = [
  {
    id: 'note-general',
    name: 'Note',
    prefix: 'NOTE',
    namePattern: '{{title}}',
    frontmatter: { type: 'NOTE', cssclasses: ['note-type'] },
    body: '# Overview\n\n***\n# Content\n\n***\n',
  },
  {
    id: 'note-sketch',
    name: 'Sketch',
    prefix: 'SKETCH',
    namePattern: '{{title}}',
    frontmatter: { type: 'SKETCH', cssclasses: ['sketch-type'], canvas: true },
    body: '',
  },
  {
    id: 'note-mtg',
    name: 'Meeting',
    prefix: 'MTG',
    namePattern: '{{title}}',
    frontmatter: { type: 'MTG', cssclasses: ['mtg-type'] },
    body: '# Overview\n\n***\n# Agenda\n\n***\n# Minutes\n\n***\n# Decisions\n\n***\n',
  },
  {
    id: 'note-sem',
    name: 'Seminar',
    prefix: 'SEM',
    namePattern: '{{title}}',
    frontmatter: { type: 'SEM', cssclasses: ['sem-type'] },
    body: '# Overview\n\n***\n# Content\n\n***\n# Key Points\n\n***\n',
  },
  {
    id: 'note-event',
    name: 'Event',
    prefix: 'EVENT',
    namePattern: '{{title}}',
    frontmatter: { type: 'EVENT', cssclasses: ['event-type'] },
    body: '# Overview\n\n***\n# Details\n\n***\n# Schedule\n\n***\n',
  },
  {
    id: 'note-ofa',
    name: 'Official Affairs',
    prefix: 'OFA',
    namePattern: '{{title}}',
    frontmatter: { type: 'OFA', cssclasses: ['ofa-type'] },
    body: '# Overview\n\n***\n# Content\n\n***\n# Decisions\n\n***\n',
  },
  {
    id: 'note-paper',
    name: 'Paper',
    prefix: 'PAPER',
    namePattern: '{{title}}',
    frontmatter: { type: 'PAPER', cssclasses: ['paper-type'] },
    body: '# Overview\n\n***\n# Abstract\n\n***\n# Notes\n\n***\n',
  },
  {
    id: 'note-lit',
    name: 'Literature',
    prefix: 'LIT',
    namePattern: '{{title}}',
    frontmatter: { type: 'LIT', cssclasses: ['lit-type'] },
    body: '# Overview\n\n***\n# Summary\n\n***\n# Notes\n\n***\n',
  },
  {
    id: 'note-data',
    name: 'Data',
    prefix: 'DATA',
    namePattern: '{{title}}',
    frontmatter: { type: 'DATA', cssclasses: ['data-type'] },
    body: '# Overview\n\n***\n# Data Description\n\n***\n',
  },
  {
    id: 'note-theo',
    name: 'Theory',
    prefix: 'THEO',
    namePattern: '{{title}}',
    frontmatter: { type: 'THEO', cssclasses: ['theo-type'] },
    body: '# Overview\n\n***\n# Theory\n\n***\n# Applications\n\n***\n',
  },
  {
    id: 'note-contact',
    name: 'Contact',
    prefix: 'CONTACT',
    namePattern: '{{title}}',
    frontmatter: { type: 'CONTACT', cssclasses: ['contact-type'] },
    body: '# Overview\n- **name:** {{name}}\n- **email:** {{email}}\n- **organization:** {{organization}}\n- **role:** {{role}}\n- **phone:** {{phone}}\n- **location:** {{location}}\n\n***\n',
  },
  {
    id: 'note-settings',
    name: 'Settings',
    prefix: 'SETUP',
    namePattern: '{{title}}',
    frontmatter: { type: 'SETUP', cssclasses: ['setup-type'] },
    body: '# Overview\n\n***\n# Context\n\n***\n',
  },
];

function getYYMMDD(): string {
  const now = new Date();
  const yy = String(now.getFullYear()).slice(2);
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return `${yy}${mm}${dd}`;
}

export function applyNoteTemplateVariables(
  template: NoteTemplate,
  vars: Record<string, string> & { title: string },
  userTags?: FacetedTagSelection,
  language: LanguageSetting = 'ko'
): { fileName: string; frontmatter: string; body: string } {
  const yymmdd = getYYMMDD();
  const title = vars.title.replace(/\s+/g, '_');

  // Build file name from pattern
  let fileName = template.namePattern
    .replace(/\{\{prefix\}\}/g, template.prefix)
    .replace(/\{\{YYMMDD\}\}/g, yymmdd)
    .replace(/\{\{title\}\}/g, title);

  // Map template type to NoteType
  const noteTypeMap: Record<string, NoteType> = {
    'NOTE': 'NOTE',
    'MTG': 'MTG',
    'PAPER': 'PAPER',
    'THEO': 'THEO',
    'LIT': 'LIT',
    'EVENT': 'EVENT',
    'CONTACT': 'CONTACT',
    'OFA': 'OFA',
    'SEM': 'SEM',
    'DATA': 'DATA',
    'SETUP': 'SETUP',
    'SKETCH': 'SKETCH',
  };

  const noteType: NoteType = noteTypeMap[template.frontmatter.type || 'NOTE'] || 'NOTE';

  // Create frontmatter using new structure
  const frontmatter = createFromTemplate(noteType, vars.title, vars);

  // Override type with template's original type to preserve ADM, SEM, DATA, SETUP, etc.
  if (template.frontmatter.type) {
    frontmatter.type = template.frontmatter.type as NoteType;
  }

  // Preserve canvas flag from template for SKETCH notes
  if (template.frontmatter.canvas) {
    (frontmatter as any).canvas = template.frontmatter.canvas;
  }

  // Apply template tag categories to frontmatter tags
  if (template.tagCategories && frontmatter.tags) {
    if (template.tagCategories.domain && template.tagCategories.domain.length > 0) {
      frontmatter.tags.domain = [...template.tagCategories.domain];
    }
    if (template.tagCategories.who && template.tagCategories.who.length > 0) {
      frontmatter.tags.who = [...template.tagCategories.who];
    }
    if (template.tagCategories.org && template.tagCategories.org.length > 0) {
      frontmatter.tags.org = [...template.tagCategories.org];
    }
    if (template.tagCategories.ctx && template.tagCategories.ctx.length > 0) {
      frontmatter.tags.ctx = [...template.tagCategories.ctx];
    }
  }

  // Merge user-selected tags (from note creation modal)
  if (userTags && frontmatter.tags) {
    if (userTags.domain && userTags.domain.length > 0) {
      frontmatter.tags.domain = [...new Set([...(frontmatter.tags.domain || []), ...userTags.domain])];
    }
    if (userTags.who && userTags.who.length > 0) {
      frontmatter.tags.who = [...new Set([...(frontmatter.tags.who || []), ...userTags.who])];
    }
    if (userTags.org && userTags.org.length > 0) {
      frontmatter.tags.org = [...new Set([...(frontmatter.tags.org || []), ...userTags.org])];
    }
    if (userTags.ctx && userTags.ctx.length > 0) {
      frontmatter.tags.ctx = [...new Set([...(frontmatter.tags.ctx || []), ...userTags.ctx])];
    }
  }

  // Get body template (language-aware)
  const bodyTemplate = getBodyTemplate(noteType, language);

  // Prepare template variables with frontmatter fields
  const fm = frontmatter as Record<string, unknown>;
  const templateVars: Record<string, string> = {
    ...vars,
    title: vars.title,
    date: typeof fm.date === 'string' ? fm.date : '',
    time: typeof fm.time === 'string' ? fm.time : (vars.time || ''),
    participants: Array.isArray(fm.participants) ? fm.participants.join(', ') : '',
    authors: Array.isArray(fm.authors) ? fm.authors.join(', ') : '',
    year: fm.year != null ? String(fm.year) : '',
    venue: typeof fm.venue === 'string' ? fm.venue : '',
    doi: typeof fm.doi === 'string' ? fm.doi : '',
    url: typeof fm.url === 'string' ? fm.url : '',
    publisher: typeof fm.publisher === 'string' ? fm.publisher : '',
    source: typeof fm.source === 'string' ? fm.source : '',
    location: typeof fm.location === 'string' ? fm.location : (vars.location || ''),
    organizer: typeof fm.organizer === 'string' ? fm.organizer : '',
    email: typeof fm.email === 'string' ? fm.email : '',
    phone: typeof fm.phone === 'string' ? fm.phone : '',
    organization: typeof fm.organization === 'string' ? fm.organization : '',
    role: typeof fm.role === 'string' ? fm.role : '',
    name: vars.title,
  };

  const body = applyTemplateVars(bodyTemplate, templateVars);

  // Convert frontmatter to YAML
  const frontmatterYaml = yaml.dump(frontmatter, { lineWidth: -1, noRefs: true });

  return {
    fileName,
    frontmatter: frontmatterYaml,
    body,
  };
}
