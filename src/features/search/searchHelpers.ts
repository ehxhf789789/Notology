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

// ── 태그의 색 ────────────────────────────────────────────────
// 🔴 **표를 늘리는 대신 계산한다.** 여기 목록이 CSS 표와 어긋나 태그가
//    회색으로 남는 일이 두 번 연속 일어났다 — 처음엔 `key`·`proj`·`acad`
//    (보관소 6축, CLAUDE.md 3-3), 다음엔 `kind`·`formality`·`funding`·`collab`
//    (2-2-1의 4축). 축은 앞으로도 는다. 손으로 적은 표는 또 어긋난다.
//
//    그래서 **모르는 축도 색을 받는다.** 축 이름에서 결정론적으로 뽑으므로
//    같은 축은 언제나 같은 색이고, 아무도 표를 고치지 않아도 회색이 안 생긴다.
//    (서버의 `src/pipeline/tag_audit.py` 가 같은 규칙을 쓴다)

const AXIS_COLOR: Record<string, string> = {
  ctx: '#57c7a4',    // 과제·학기
  org: '#e0a458',    // 기관
  who: '#7ab0e0',    // 인물
  proj: '#b78ad4',   // 활동
  acad: '#e07a9c',   // 학술
  // 🔴 key 를 회색(#9aa0ab)으로 박았던 것을 걷는다 (2026-08-26 사용자:
  //    "왜 특정 태그는 회색인가"). 「무채색 칩 0개」가 이미 정해진 규칙이고
  //    (2-2-0), 회색은 «색이 빠졌다»로 읽힌다. 표에서 빼면 아래 해시가
  //    축 이름에서 결정론적으로 색을 만든다 — formality 회색도 같이 뺀다.
  domain: '#a78bfa',
  kind: '#6f9e7a',       // 아래는 2-2-1의 4축 (클래스를 설명한다)
  funding: '#c9a45c',
  collab: '#7f9bb5',
};

export function tagAxis(tag: string): string {
  const i = tag.indexOf('/');
  return i > 0 ? tag.slice(0, i) : '';
}

/** 화면에 쓸 이름 — 축을 뗀다. 열이 좁아 `key/Smart_Construction` 은 안 들어간다. */
export function tagLabel(tag: string): string {
  const i = tag.indexOf('/');
  return i > 0 ? tag.slice(i + 1) : tag;
}

/** 축 이름 → 색. 표에 없으면 만들어낸다. */
export function tagColor(tag: string): string {
  const axis = tagAxis(tag);
  if (!axis) return 'var(--text-muted, #8a8f99)';
  if (AXIS_COLOR[axis]) return AXIS_COLOR[axis];
  let h = 0;
  for (let i = 0; i < axis.length; i++) h = (h * 31 + axis.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 42% 66%)`;   // 밝기·채도 고정 — 튀지 않게
}

/** 칩에 그대로 얹는다. CSS 표를 거치지 않으므로 어긋날 수 없다. */
export function tagStyle(tag: string): React.CSSProperties {
  const c = tagColor(tag);
  return { color: c, borderColor: `color-mix(in srgb, ${c} 34%, transparent)`,
           backgroundColor: `color-mix(in srgb, ${c} 14%, transparent)` };
}

// 남겨둔다 — 다른 화면이 아직 클래스로 쓴다.
export function getTagCategoryClass(tag: string): string {
  const axis = tagAxis(tag);
  return axis ? `tag-${axis}` : '';
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
