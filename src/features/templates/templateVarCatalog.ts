/**
 * Stage 5.0.5a-γ5 v10 (2026-05-16, HanBin) — expanded variable catalog.
 *
 * Previously only 4 inline chips (title/date/year/prefix). HanBin: "변수
 * 종류를 더 상세하게 추가할 것" — adds 25+ variables grouped by category:
 *
 *   기본       — title, date, year, prefix, time, datetime
 *   노트 메타  — id, type, filename, path, today
 *   시간 확장  — month, day, weekday, hour, minute
 *   사람·기관  — name, email, phone, organization, role, location, aliases
 *   문서 메타  — authors, year (academic), venue, doi, url, publisher, source
 *
 * Each variable provides:
 *   token       — the {{...}} placeholder inserted into the body
 *   labelI18n   — short i18n key for display label
 *   Icon        — lucide component
 *   category    — group id (drives picker section)
 *
 * Substitution at note creation:
 *   - Form values from NoteWizard (β stage) drive most fields.
 *   - "Always-available" variables (date / year / today / filename / id /
 *     type) auto-fill from creation context.
 */
import type { LucideIcon } from 'lucide-react';
import {
  Type, Calendar, CalendarDays, Hash, Clock, CalendarClock,
  Fingerprint, FileText, FolderOpen, FileCheck,
  CalendarRange, CalendarFold, CalendarCheck, Timer, AlarmClock,
  User, Mail, Phone, Building2, Briefcase, MapPin, Users,
  BookOpen, Calendar as YearIcon, Newspaper, Link2, Globe, Library, Database,
} from 'lucide-react';

// `'custom'` (2026-05-17 hotfix, HanBin) — synthetic category emitted by
// scanUserInputVars when the body contains a token that isn't in the
// canonical catalog. The wizard renders these as plain-text inputs so
// templates with author-defined variables (e.g. `{{my-field}}`) work
// end-to-end instead of being silently dropped.
export type TemplateVarCategory = 'basic' | 'meta' | 'time' | 'people' | 'document' | 'custom';

export interface TemplateVarSpec {
  token: string;
  labelI18n: string;
  Icon: LucideIcon;
  category: TemplateVarCategory;
  /**
   * v11 (2026-05-16, HanBin) — substitution mode:
   *   `true`  = system 자동 치환 (시간 / 컨텍스트). 사용자 입력 X.
   *   `false` = 본문에 토큰 사용 시 NoteWizard β-stage 가 자동으로
   *             해당 입력 칸을 폼에 추가, 사용자 입력값으로 치환.
   *             변수마다 별도 modal 이 뜨지 않음 — 한 wizard 에 모든
   *             user-input 변수를 모아 한 번에 입력.
   */
  autoFill: boolean;
}

export const TEMPLATE_VAR_CATEGORIES: ReadonlyArray<{ id: TemplateVarCategory; labelI18n: string }> = [
  { id: 'basic',    labelI18n: 'tplVarCatBasic' },
  { id: 'meta',     labelI18n: 'tplVarCatMeta' },
  { id: 'time',     labelI18n: 'tplVarCatTime' },
  { id: 'people',   labelI18n: 'tplVarCatPeople' },
  { id: 'document', labelI18n: 'tplVarCatDocument' },
  { id: 'custom',   labelI18n: 'tplVarCatCustom' },
];

export const TEMPLATE_VAR_CATALOG: ReadonlyArray<TemplateVarSpec> = [
  // ── 기본 (모두 auto-fill — wizard 기본 폼에서 이미 수집되거나 시스템 자동) ──
  { token: '{{title}}',    labelI18n: 'tplVarTitle',    Icon: Type,          category: 'basic', autoFill: true },
  { token: '{{date}}',     labelI18n: 'tplVarDate',     Icon: Calendar,      category: 'basic', autoFill: true },
  { token: '{{year}}',     labelI18n: 'tplVarYear',     Icon: CalendarDays,  category: 'basic', autoFill: true },
  { token: '{{prefix}}',   labelI18n: 'tplVarPrefix',   Icon: Hash,          category: 'basic', autoFill: true },
  { token: '{{time}}',     labelI18n: 'tplVarTime',     Icon: Clock,         category: 'basic', autoFill: true },
  { token: '{{datetime}}', labelI18n: 'tplVarDatetime', Icon: CalendarClock, category: 'basic', autoFill: true },

  // ── 노트 메타 (모두 auto-fill — 생성 시점 context) ──
  { token: '{{id}}',       labelI18n: 'tplVarId',       Icon: Fingerprint,   category: 'meta', autoFill: true },
  { token: '{{type}}',     labelI18n: 'tplVarType',     Icon: FileText,      category: 'meta', autoFill: true },
  { token: '{{filename}}', labelI18n: 'tplVarFilename', Icon: FileCheck,     category: 'meta', autoFill: true },
  { token: '{{path}}',     labelI18n: 'tplVarPath',     Icon: FolderOpen,    category: 'meta', autoFill: true },
  { token: '{{today}}',    labelI18n: 'tplVarToday',    Icon: CalendarCheck, category: 'meta', autoFill: true },

  // ── 시간 확장 (모두 auto-fill — 시스템 시간) ──
  { token: '{{month}}',   labelI18n: 'tplVarMonth',   Icon: CalendarRange, category: 'time', autoFill: true },
  { token: '{{day}}',     labelI18n: 'tplVarDay',     Icon: CalendarFold,  category: 'time', autoFill: true },
  { token: '{{weekday}}', labelI18n: 'tplVarWeekday', Icon: CalendarCheck, category: 'time', autoFill: true },
  { token: '{{hour}}',    labelI18n: 'tplVarHour',    Icon: Timer,         category: 'time', autoFill: true },
  { token: '{{minute}}',  labelI18n: 'tplVarMinute',  Icon: AlarmClock,    category: 'time', autoFill: true },

  // ── 사람·기관 (모두 user-input — 본문 사용 시 wizard 폼에 입력 칸 자동 추가) ──
  { token: '{{name}}',         labelI18n: 'tplVarName',         Icon: User,       category: 'people', autoFill: false },
  { token: '{{email}}',        labelI18n: 'tplVarEmail',        Icon: Mail,       category: 'people', autoFill: false },
  { token: '{{phone}}',        labelI18n: 'tplVarPhone',        Icon: Phone,      category: 'people', autoFill: false },
  { token: '{{organization}}', labelI18n: 'tplVarOrganization', Icon: Building2,  category: 'people', autoFill: false },
  { token: '{{role}}',         labelI18n: 'tplVarRole',         Icon: Briefcase,  category: 'people', autoFill: false },
  { token: '{{location}}',     labelI18n: 'tplVarLocation',     Icon: MapPin,     category: 'people', autoFill: false },
  { token: '{{aliases}}',      labelI18n: 'tplVarAliases',      Icon: Users,      category: 'people', autoFill: false },

  // ── 문서 메타 (모두 user-input) ──
  { token: '{{authors}}',   labelI18n: 'tplVarAuthors',   Icon: Users,     category: 'document', autoFill: false },
  { token: '{{venue}}',     labelI18n: 'tplVarVenue',     Icon: Newspaper, category: 'document', autoFill: false },
  { token: '{{doi}}',       labelI18n: 'tplVarDoi',       Icon: Link2,     category: 'document', autoFill: false },
  { token: '{{url}}',       labelI18n: 'tplVarUrl',       Icon: Globe,     category: 'document', autoFill: false },
  { token: '{{publisher}}', labelI18n: 'tplVarPublisher', Icon: Library,   category: 'document', autoFill: false },
  { token: '{{source}}',    labelI18n: 'tplVarSource',    Icon: Database,  category: 'document', autoFill: false },
];

// Suppress unused-import lint when these aren't directly referenced
// (they're held inside the catalog above).
void BookOpen; void YearIcon;
