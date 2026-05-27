import type { FolderNoteTemplate, NoteTemplate, NoteFrontmatter, NoteKind } from '../../core/types';
import type { NoteType } from '../../core/types/frontmatter';
import type { FacetedTagSelection } from '../shared/TagInputSection';
import { serializeFrontmatter, getCurrentTimestamp } from '../../core/utils/frontmatter';
import { createFromTemplate, getBodyTemplate, applyTemplateVariables as applyTemplateVars } from './templateUtils';
import type { LanguageSetting } from '../../core/utils/i18n';
import { t } from '../../core/utils/i18n';
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
// Stage 5.0.5a v4 (2026-05-16, HanBin sign-off — ROLE-based architecture) —
// 데이터 ROLE 관점 3 대분류 + Container 시스템 활용.
//
// HanBin 누적 critique:
//   v2 (Work/Reference/Contact/Sketch): "막무가내적 접근"
//   v3 (행정/연구/강의/기타): "sub-kind 가 직관적 아님, 연락처 중복 문제,
//                              데이터 관리 차원 설계 아님"
//   → v4: 데이터의 ROLE 으로 구별. 분류 라벨은 metadata 로.
//
// **3 대분류 (사용자가 노트 생성 시 선택)**:
//
//   Entity   — 글로벌 참조 entity (사람/기관/팀 통합). 어디서나 wikilink 로
//              참조. 중복 없음. 별도 폴더 (/People/, /Orgs/) 권장.
//   Document — 단일 콘텐츠 노트. 기본은 "메모" 1건. 사용자가 직접 docType
//              별 커스텀 템플릿을 추가 (Settings → 템플릿 관리).
//   Sketch   — 캔버스 노트. UI 모드가 다름.
//
// **Container = 폴더 노트** (Stage 4 때 이미 구현된 시스템 활용):
//   - Standard container: 노트 생성 시 wizard 가 3 대분류 선택지 노출
//   - Storage container: 노트 생성 시 wizard skip, 고정 템플릿 자동 적용
//   - 도메인 (행정/연구/강의/기타) 은 Container 의 metadata 로 표현 가능
//
// **커스텀 docType 템플릿** — HanBin 강조 사항:
//   기본은 메모 하나. 사용자가 회의록/공문/논문/강의자료 등을 자유롭게
//   추가. Settings 의 TemplateEditor 가 색/아이콘/디자인 설정 강화 필요
//   (5.0.5a-step4 에서 별도 작업).
//
// Backward compat: 기존 노트 type (MTG/OFA/PAPER/CONTACT/SKETCH/NOTE 등)
// 모두 보존. 신규 생성만 3-template 경로.
//
// Total: 4 top-level cards. Max user-visible cards on any path: 4 + 5 = 9
// (still fewer than the old 12 flat templates).
//
// Backward compat: every old frontmatter `type:` value (MTG/OFA/PAPER/
// CONTACT/SKETCH/NOTE/LIT/SEM/EVENT/DATA/THEO/SETUP) continues to render
// because we preserve those `cssclasses`. New types added: REPORT, PROJECT,
// PATENT, LECTURE, ASSIGNMENT, COURSE — these inherit base CSS until
// dedicated styling lands in 5.0.5b.

/**
 * Entity 통합 폼 (사람/기관/팀 한 곳).
 * HanBin: "Entity의 사람/기관은 분리하지말고 통합해서 저장할 것"
 *
 * `entityKind` 필드로 person/org/team 구별. wizard 가 entityKind 선택 →
 * 해당 sub-type 에 맞는 필드만 활성화 (예: 사람 → email/phone, 기관 → 상위기관).
 * frontmatter.aliases 자동 채움 (participant lookup 호환).
 */
const ENTITY_FIELDS: NoteWizardField[] = [
  // entityKind 는 wizard 가 special-case 처리 (radio/segmented control)
  { key: 'entityKind', labelI18n: 'fieldEntityKind', kind: 'text', required: true },
  { key: 'email', labelI18n: 'fieldEmail', kind: 'email' },
  { key: 'phone', labelI18n: 'fieldPhone', kind: 'tel' },
  { key: 'organization', labelI18n: 'fieldOrganization', kind: 'text' },
  { key: 'role', labelI18n: 'fieldRole', kind: 'text' },
  { key: 'location', labelI18n: 'fieldLocation', kind: 'text' },
  { key: 'tags', labelI18n: 'tags', kind: 'tags' },
];

export const DEFAULT_NOTE_TEMPLATES: NoteTemplate[] = [
  {
    id: 'tpl-entity',
    name: '개체',
    prefix: 'ENTITY',
    namePattern: '{{title}}',
    // 글로벌 참조 entity. 사람/기관/팀 통합. workScope='entity' 로 검색/필터 분리.
    // v5 fix (2026-05-16, HanBin): type='ENTITY' (was 'CONTACT' — legacy 호환
    // 위해 잠시 썼으나 신규 개체 노트가 검색 결과에 "Contact"로 표시되어 혼란).
    // 새 cssclasses 'entity-type' 도입 (없으면 기본 NOTE 렌더).
    frontmatter: { type: 'ENTITY', cssclasses: ['entity-type'], workScope: 'entity' },
    // v5 fix: body 의 {{name}}/{{email}}/{{organization}} placeholder 제거.
    // NoteWizard (β 단계) 가 아직 없어서 폼 입력값이 없어 치환되지 않은
    // 토큰이 그대로 본문에 남는 문제가 있었음. β 단계에서 wizard 가 들어오면
    // 다시 풍부한 템플릿으로 복원.
    body: '# 개요\n\n***\n# 메모\n\n',
    icon: 'Users',
    fields: ENTITY_FIELDS,
  },
  {
    id: 'tpl-document',
    name: '문서',
    prefix: 'DOC',
    namePattern: '{{title}}',
    // 기본 docType='memo'. 사용자 커스텀 템플릿이 이 자리에 추가됨.
    // (Settings → 템플릿 관리 → 사용자 정의 docType 추가)
    frontmatter: { type: 'NOTE', cssclasses: ['note-type'], docType: 'memo' },
    body: '# 메모\n\n',
    icon: 'FileText',
    fields: [
      { key: 'tags', labelI18n: 'tags', kind: 'tags' },
    ],
  },
  {
    id: 'tpl-sketch',
    name: '스케치',
    prefix: 'SKETCH',
    namePattern: '{{title}}',
    // 캔버스 모드. wizard 가 sketch:true 감지 → form skip → 캔버스 직진.
    frontmatter: { type: 'SKETCH', cssclasses: ['sketch-type'], sketch: true },
    body: '',
    icon: 'PenTool',
    // No `fields` — title only.
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

  // Preserve sketch flag from template for SKETCH notes
  if (template.frontmatter.sketch) {
    (frontmatter as any).sketch = template.frontmatter.sketch;
  }

  // 10th hotfix (2026-05-17, HanBin) — when `userTags` is provided, the
  // wizard ran and was PRE-SEEDED with the template's tagCategories +
  // parsed flat tags upstream (see createNoteFromTemplateInteractive).
  // Therefore `userTags` is the canonical post-edit selection: it already
  // includes template defaults that survived the user's review, AND it
  // EXCLUDES any default the user removed in the wizard. Use it directly
  // — re-applying tagCategories here would resurrect removed defaults.
  //
  // If `userTags` is NOT provided (programmatic create / migration short
  // path), fall back to applying template's tagCategories + flat-tag
  // parsing so the template's defaults still land in the note.
  if (userTags && frontmatter.tags) {
    frontmatter.tags.domain = [...userTags.domain];
    frontmatter.tags.who    = [...userTags.who];
    frontmatter.tags.org    = [...userTags.org];
    frontmatter.tags.ctx    = [...userTags.ctx];
  } else if (frontmatter.tags) {
    // Apply template tag categories to frontmatter tags
    if (template.tagCategories) {
      if (template.tagCategories.domain?.length) frontmatter.tags.domain = [...template.tagCategories.domain];
      if (template.tagCategories.who?.length)    frontmatter.tags.who    = [...template.tagCategories.who];
      if (template.tagCategories.org?.length)    frontmatter.tags.org    = [...template.tagCategories.org];
      if (template.tagCategories.ctx?.length)    frontmatter.tags.ctx    = [...template.tagCategories.ctx];
    }

    // Legacy: template.frontmatter.tags (flat array) — kept for templates
    // still carrying the deprecated "자동 추가 태그" field. Prefix-parsed
    // and merged on top of tagCategories.
    const templateFlatTags = template.frontmatter.tags;
    if (Array.isArray(templateFlatTags) && templateFlatTags.length > 0) {
      const bucket = { domain: [] as string[], who: [] as string[], org: [] as string[], ctx: [] as string[] };
      for (const raw of templateFlatTags) {
        if (typeof raw !== 'string') continue;
        const v = raw.trim();
        if (!v) continue;
        if (v.startsWith('domain/'))      bucket.domain.push(v.slice('domain/'.length));
        else if (v.startsWith('who/'))    bucket.who.push(v.slice('who/'.length));
        else if (v.startsWith('org/'))    bucket.org.push(v.slice('org/'.length));
        else if (v.startsWith('ctx/'))    bucket.ctx.push(v.slice('ctx/'.length));
        else                              bucket.ctx.push(v);
      }
      if (bucket.domain.length) frontmatter.tags.domain = [...new Set([...(frontmatter.tags.domain || []), ...bucket.domain])];
      if (bucket.who.length)    frontmatter.tags.who    = [...new Set([...(frontmatter.tags.who || []),    ...bucket.who])];
      if (bucket.org.length)    frontmatter.tags.org    = [...new Set([...(frontmatter.tags.org || []),    ...bucket.org])];
      if (bucket.ctx.length)    frontmatter.tags.ctx    = [...new Set([...(frontmatter.tags.ctx || []),    ...bucket.ctx])];
    }
  }

  // Get body template (language-aware).
  //
  // v18 fix (2026-05-16, HanBin) — prefer `template.body` (the user's
  // authored template content with their own `{{vars}}`) over the hardcoded
  // `getBodyTemplate(noteType)` fallback. Without this:
  //   - Custom templates (TEST3, etc.) were ignored entirely — every note
  //     got the generic NOTE body, and any `{{email}}` / `{{name}}` etc.
  //     tokens the user added to their template body never appeared in the
  //     created note → wizard inputs collected but discarded.
  //   - Even the new defaults (tpl-entity / tpl-document / tpl-sketch),
  //     which carry their own body, were silently overridden by the legacy
  //     12-template hardcoded bodies.
  // The `getBodyTemplate` fallback stays only as a safety net for the
  // (now-impossible) case where a template has no body field at all.
  const bodyTemplate = (template.body && template.body.trim().length > 0)
    ? template.body
    : getBodyTemplate(noteType, language);

  // Prepare template variables with frontmatter fields.
  //
  // v18 fix (2026-05-16, HanBin) — wizard-collected `vars` MUST win over
  // frontmatter-derived defaults. Previously `...vars` was spread first
  // then the per-field lines pulled values from `fm` and clobbered them —
  // for CUSTOM templates (e.g. TEST3 → noteType='NOTE'), `createFromTemplate`
  // doesn't populate fm.email/phone/role/etc., so the explicit `fm.email`
  // fallback was '' and the user's wizard input was silently discarded.
  // Now: explicit fm-derived fields go FIRST (as defaults), then the wizard
  // vars override at the end. For built-in templates (Contact / Meeting /
  // Paper) the values are already in fm because createFromTemplate copies
  // vars→fm, so the override is a no-op there. `name` falls back to title
  // only if the user didn't supply it.
  const fm = frontmatter as Record<string, unknown>;
  const templateVars: Record<string, string> = {
    title: vars.title,
    name: vars.title, // default fallback if vars.name not provided
    date: typeof fm.date === 'string' ? fm.date : '',
    time: typeof fm.time === 'string' ? fm.time : '',
    participants: Array.isArray(fm.participants) ? fm.participants.join(', ') : '',
    authors: Array.isArray(fm.authors) ? fm.authors.join(', ') : '',
    year: fm.year != null ? String(fm.year) : '',
    venue: typeof fm.venue === 'string' ? fm.venue : '',
    doi: typeof fm.doi === 'string' ? fm.doi : '',
    url: typeof fm.url === 'string' ? fm.url : '',
    publisher: typeof fm.publisher === 'string' ? fm.publisher : '',
    source: typeof fm.source === 'string' ? fm.source : '',
    location: typeof fm.location === 'string' ? fm.location : '',
    organizer: typeof fm.organizer === 'string' ? fm.organizer : '',
    email: typeof fm.email === 'string' ? fm.email : '',
    phone: typeof fm.phone === 'string' ? fm.phone : '',
    organization: typeof fm.organization === 'string' ? fm.organization : '',
    role: typeof fm.role === 'string' ? fm.role : '',
    // Wizard vars LAST so they override the above defaults. For empty
    // strings we keep the default — user "didn't fill it in" shouldn't
    // wipe out a valid frontmatter-derived value (e.g. autoFill date).
    ...Object.fromEntries(
      Object.entries(vars).filter(([, v]) => v !== undefined && v !== null && v !== ''),
    ),
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
