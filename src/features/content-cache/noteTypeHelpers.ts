import type { NoteTemplate } from '../../core/types';

const NOTE_TYPE_PREFIXES = [
  'NOTE', 'SKETCH', 'MTG', 'SEM', 'EVENT', 'OFA',
  'PAPER', 'LIT', 'DATA', 'THEO', 'CONTACT', 'SETUP',
  'TASK', 'ADM',
];

/**
 * v15 fix (2026-05-16, HanBin) — preset cssclasses → actual hex color
 * (NOT a CSS var, since some consumers like the Graph view render to
 * canvas where `var(--...)` doesn't resolve). Values mirror the dark-mode
 * defaults from `note-type-colors.css`.
 */
const PRESET_HEX: Record<string, string> = {
  note:    '#a78bfa',
  sketch:  '#f472b6',
  mtg:     '#60a5fa',
  sem:     '#fb923c',
  event:   '#f87171',
  ofa:     '#34d399',
  paper:   '#5eead4',
  lit:     '#a3e635',
  data:    '#fbbf24',
  theo:    '#818cf8',
  contact: '#22d3ee',
  setup:   '#9ca3af',
  entity:  '#14b8a6',
};

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
  if (!template) return undefined;
  if (template.customColor) return template.customColor;
  // v15b fix (2026-05-16, HanBin) — fall back to preset cssclasses HEX
  // (NOT var(--...)) so the value works in both CSS and canvas contexts.
  // SearchResultItem uses it as `--template-color: #hex` (valid);
  // GraphView passes it to force-graph's canvas fillStyle (also valid).
  // Returning `var(--note-color)` broke canvas rendering (no resolution).
  const css = (template.frontmatter?.cssclasses as string[] | undefined)?.[0];
  if (css?.endsWith('-type')) {
    const kind = css.replace(/-type$/, '');
    if (PRESET_HEX[kind]) return PRESET_HEX[kind];
  }
  return undefined;
}

/**
 * v15 fix — given a note's frontmatter.type, return the CSS class that
 * should be applied to the row for color/border. For built-in types
 * (note/mtg/etc.) this is `{type}-type` directly. For custom types
 * (TEST2 etc.) we look up the template's cssclasses[0] (e.g. 'note-type')
 * so the row inherits that preset's color even though its `type` is unique.
 */
export function resolveNoteTypeCssClass(
  noteType: string | null,
  noteTemplates: NoteTemplate[],
): string {
  if (!noteType) return '';
  const lower = noteType.toLowerCase();
  const builtIn = new Set(['note', 'mtg', 'ofa', 'sem', 'event', 'lit', 'contact', 'setup', 'data', 'theo', 'paper', 'sketch', 'container', 'entity']);
  if (builtIn.has(lower)) return `${lower}-type`;
  // Custom type — look up matching template
  const template = noteTemplates.find(
    (t) =>
      t.frontmatter.type?.toLowerCase() === lower ||
      t.prefix.toLowerCase() === lower,
  );
  const css = (template?.frontmatter?.cssclasses as string[] | undefined)?.[0];
  if (css?.endsWith('-type')) return css;
  return '';
}
