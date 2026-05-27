import React from 'react';

// Note types with display names. Call sites that render the "all types"
// option (value === '') always override the label with t('allTypes',
// language) — the literal here is just a fallback for completeness.
export const NOTE_TYPES: { value: string; label: string }[] = [
  { value: '', label: 'All' },
  { value: 'NOTE', label: 'Note' },
  { value: 'SKETCH', label: 'Sketch' },
  { value: 'MTG', label: 'Meeting' },
  { value: 'SEM', label: 'Seminar' },
  { value: 'EVENT', label: 'Event' },
  { value: 'OFA', label: 'Official Affairs' },
  { value: 'PAPER', label: 'Paper' },
  { value: 'LIT', label: 'Literature' },
  { value: 'DATA', label: 'Data' },
  { value: 'THEO', label: 'Theory' },
  { value: 'CONTACT', label: 'Contact' },
  { value: 'SETUP', label: 'Settings' },
  { value: 'CONTAINER', label: 'Container' },
];

// Helper function to convert note_type abbreviation to full template name
export function noteTypeToFullName(noteType: string): string {
  const typeMap: Record<string, string> = {
    'NOTE': 'Note',
    'SKETCH': 'Sketch',
    'MTG': 'Meeting',
    'SEM': 'Seminar',
    'EVENT': 'Event',
    'OFA': 'Official Affairs',
    'PAPER': 'Paper',
    'LIT': 'Literature',
    'DATA': 'Data',
    'THEO': 'Theory',
    'CONTACT': 'Contact',
    'SETUP': 'Settings',
    'CONTAINER': 'Container',
  };
  return typeMap[noteType.toUpperCase()] || noteType;
}

// Helper function to get tag category class based on prefix
export function getTagCategoryClass(tag: string): string {
  if (tag.startsWith('domain/')) return 'tag-domain';
  if (tag.startsWith('who/')) return 'tag-who';
  if (tag.startsWith('org/')) return 'tag-org';
  if (tag.startsWith('ctx/')) return 'tag-ctx';
  return '';
}

// Helper function to convert note_type to CSS class.
// v15 fix (2026-05-16, HanBin) — template-aware. Custom user-defined types
// (e.g. 'TEST2') now resolve to their template's cssclasses[0] (e.g. 'note-type')
// so the row inherits the preset's color. Previously they returned '' and
// the note list showed no color border.
export function noteTypeToCssClass(noteType: string): string {
  if (!noteType) return '';
  const type = noteType.toLowerCase();
  const validTypes = ['note', 'mtg', 'ofa', 'sem', 'event', 'lit', 'contact', 'setup', 'data', 'theo', 'paper', 'sketch', 'container', 'entity'];
  if (validTypes.includes(type)) {
    return type + '-type';
  }
  // Custom type — look up via templateStore and use the template's cssclasses.
  // Lazy import to avoid circular dep with the templates feature module.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { useTemplateStore } = require('../templates/stores/templateStore');
    const templates = useTemplateStore.getState().noteTemplates as Array<{
      frontmatter?: { type?: string; cssclasses?: string[] };
      prefix?: string;
    }>;
    const tmpl = templates.find(
      t => t.frontmatter?.type?.toLowerCase() === type || t.prefix?.toLowerCase() === type,
    );
    const css = tmpl?.frontmatter?.cssclasses?.[0];
    if (css && css.endsWith('-type')) return css;
  } catch {
    // Store not available (test/SSR) — silently skip.
  }
  return '';
}

// Helper function to infer note type from filename (for content search results)
export function inferNoteType(fileName: string): string {
  const prefixes = ['NOTE', 'MTG', 'OFA', 'SEM', 'EVENT', 'LIT', 'CONTACT', 'SETUP', 'DATA', 'THEO', 'PAPER', 'SKETCH'];
  for (const prefix of prefixes) {
    if (fileName.toUpperCase().startsWith(prefix + '-') || fileName.toUpperCase() === prefix) {
      return prefix.toLowerCase() + '-type';
    }
  }
  return '';
}

// Format date string for display
export function formatDate(dateStr: string): string {
  if (!dateStr) return '-';
  return dateStr.replace('T', ' ').substring(0, 16);
}

// Highlight query terms in text - returns JSX
export function highlightText(text: string, query: string): React.ReactNode {
  if (!query.trim()) return text;
  const terms = query.trim().split(/\s+/).filter(Boolean);
  const escaped = terms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const regex = new RegExp(`(${escaped.join('|')})`, 'gi');
  const parts = text.split(regex);
  return parts.map((part, i) =>
    regex.test(part) ? React.createElement('mark', { key: i, className: 'search-highlight' }, part) : part
  );
}
