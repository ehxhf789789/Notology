import type { NoteTemplate } from '../../core/types';

const NOTE_TYPE_PREFIXES = [
  'NOTE', 'SKETCH', 'MTG', 'SEM', 'EVENT', 'OFA',
  'PAPER', 'LIT', 'DATA', 'THEO', 'CONTACT', 'SETUP',
  'TASK', 'ADM',
];

export function getNoteTypeFromFileName(fileName: string): string | null {
  const upperName = fileName.toUpperCase();
  for (const prefix of NOTE_TYPE_PREFIXES) {
    if (upperName.startsWith(prefix + '-') || upperName === prefix) {
      return prefix.toLowerCase();
    }
  }
  return null;
}

export function getTemplateCustomColor(
  noteType: string | null,
  noteTemplates: NoteTemplate[],
): string | undefined {
  if (!noteType) return undefined;
  const template = noteTemplates.find(
    (t) =>
      t.frontmatter.type?.toLowerCase() === noteType.toLowerCase() ||
      t.prefix.toLowerCase() === noteType.toLowerCase(),
  );
  return template?.customColor;
}
