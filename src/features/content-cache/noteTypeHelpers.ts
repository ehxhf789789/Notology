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

/**
 * 🔴 **표에 없으면 만들어낸다** (2026-08-25 · 사용자: *"행정 타입은 hover 창에
 * 색이 반영이 안되고 있다"* · *"행정 창 그대로. 제대로 안하냐?"*).
 *
 * `PRESET_HEX` 는 손으로 적은 13종이고 **`adm` 이 없다.** 그래서 행정 노트가
 * 색을 못 받는다. 실측: ADM 노트 15개가 `cssclasses: adm-type` 을 갖는데
 * 그 이름을 아는 표가 없다.
 *
 * CLAUDE.md 2-2-0 이 태그 색으로 **이미 두 번** 같은 자리에서 어긋났고
 * 그때 끝낸 답이 이것이다:
 *
 *     *"색은 표로 관리하지 않는다. 표에 없으면 만들어낸다 — 이름에서
 *       결정론적으로 색을 뽑는다. 축이 몇 개로 늘어도 회색이 다시 생기지
 *       않는다."*
 *
 * 그 셈을 그대로 쓴다 (`searchHelpers.tagColor` 와 같은 식). 밝기·채도를
 * 고정해 두어 새 타입이 늘어도 화면이 튀지 않는다.
 */
export function derivedTypeHex(kind: string): string {
  let h = 0;
  for (let i = 0; i < kind.length; i++) h = (h * 31 + kind.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 42% 66%)`;
}

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
  // 🔴 **틀을 못 찾아도 색은 준다.** 여기서 `undefined` 를 돌려주면 틀이
  //    아직 안 실렸을 때(보관함을 막 연 순간·틀 파일이 오늘 생긴 경우)
  //    그 타입이 통째로 회색이 된다 — 2026-08-25 의 행정이 그랬다.
  if (!template) return derivedTypeHex(noteType.toLowerCase());
  if (template.customColor) return template.customColor;
  // v15b fix (2026-05-16, HanBin) — fall back to preset cssclasses HEX
  // (NOT var(--...)) so the value works in both CSS and canvas contexts.
  // SearchResultItem uses it as `--template-color: #hex` (valid);
  // GraphView passes it to force-graph's canvas fillStyle (also valid).
  // Returning `var(--note-color)` broke canvas rendering (no resolution).
  const css = (template.frontmatter?.cssclasses as string[] | undefined)?.[0];
  if (css?.endsWith('-type')) {
    const kind = css.replace(/-type$/, '');
    return PRESET_HEX[kind] ?? derivedTypeHex(kind);
  }
  // 🔴 **여기서 `undefined` 를 돌려주면 그 타입은 영영 회색이다.**
  //    표에 없는 이름도 색을 갖는다 — 위 `derivedTypeHex` 머리말.
  return derivedTypeHex(noteType.toLowerCase());
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
