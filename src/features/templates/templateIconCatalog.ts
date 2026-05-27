/**
 * Stage 5.0.5a-γ5 fix (2026-05-16, HanBin) — lucide-react icon catalog
 * for the template editor.
 *
 * Previously NoteTemplateEditor stored icon names matching the OLD 12
 * templates (`note` / `mtg` / `paper` / `sketch` / etc.) which were
 * rendered via CSS background-image. HanBin: "아이콘 종류 및 이름 다시
 * 정의. 그리고 외관에서 아이콘을 바꿔도 미리보기에 반영되지 않음."
 *
 * This catalog:
 *   - Uses real lucide-react components (renderable anywhere, color
 *     follows currentColor / styled via SVG attrs).
 *   - Categorizes icons by USE rather than by old template type name.
 *   - Keeps backward compat: old names ('note', 'mtg', etc.) resolve to
 *     a sensible lucide fallback via LEGACY_ICON_MAP so existing templates
 *     keep rendering correctly.
 */
import type { LucideIcon } from 'lucide-react';
import {
  // 문서 (Document)
  FileText, ClipboardList, FileSignature, Mail, Files,
  // 사람 (People)
  User, Users, Contact,
  // 시간 (Time)
  Calendar, Clock, Bell,
  // 학술 (Academic)
  BookOpen, FlaskConical, GraduationCap, Lightbulb,
  // 시각 (Visual)
  PenTool, Presentation, Image as ImageIcon,
  // 행정 (Admin)
  Building2, Stamp, Shield, FolderKanban, Briefcase,
  // 일반 (General)
  StickyNote, Bookmark, Star, Tag, Archive, Database, Folder, Hash,
} from 'lucide-react';

export type TemplateIconCategory =
  | 'document'   // 문서
  | 'people'     // 사람
  | 'time'       // 시간
  | 'academic'   // 학술
  | 'visual'     // 시각
  | 'admin'      // 행정
  | 'general';   // 일반

export interface TemplateIconEntry {
  /** Stable identifier — stored in template.icon. */
  id: string;
  /** Lucide component to render. */
  Icon: LucideIcon;
  /** i18n key for display label. */
  labelI18n: string;
  /** Category for grouping in the picker. */
  category: TemplateIconCategory;
}

export const TEMPLATE_ICON_CATALOG: ReadonlyArray<TemplateIconEntry> = [
  // ── 문서 ──
  { id: 'file-text', Icon: FileText, labelI18n: 'tplIconFileText', category: 'document' },
  { id: 'files', Icon: Files, labelI18n: 'tplIconFiles', category: 'document' },
  { id: 'clipboard-list', Icon: ClipboardList, labelI18n: 'tplIconClipboard', category: 'document' },
  { id: 'file-signature', Icon: FileSignature, labelI18n: 'tplIconSignature', category: 'document' },
  { id: 'mail', Icon: Mail, labelI18n: 'tplIconMail', category: 'document' },

  // ── 사람 ──
  { id: 'user', Icon: User, labelI18n: 'tplIconUser', category: 'people' },
  { id: 'users', Icon: Users, labelI18n: 'tplIconUsers', category: 'people' },
  { id: 'contact', Icon: Contact, labelI18n: 'tplIconContact', category: 'people' },

  // ── 시간 ──
  { id: 'calendar', Icon: Calendar, labelI18n: 'tplIconCalendar', category: 'time' },
  { id: 'clock', Icon: Clock, labelI18n: 'tplIconClock', category: 'time' },
  { id: 'bell', Icon: Bell, labelI18n: 'tplIconBell', category: 'time' },

  // ── 학술 ──
  { id: 'book-open', Icon: BookOpen, labelI18n: 'tplIconBook', category: 'academic' },
  { id: 'flask-conical', Icon: FlaskConical, labelI18n: 'tplIconFlask', category: 'academic' },
  { id: 'graduation-cap', Icon: GraduationCap, labelI18n: 'tplIconGraduation', category: 'academic' },
  { id: 'lightbulb', Icon: Lightbulb, labelI18n: 'tplIconLightbulb', category: 'academic' },

  // ── 시각 ──
  { id: 'pen-tool', Icon: PenTool, labelI18n: 'tplIconPenTool', category: 'visual' },
  { id: 'presentation', Icon: Presentation, labelI18n: 'tplIconPresentation', category: 'visual' },
  { id: 'image', Icon: ImageIcon, labelI18n: 'tplIconImage', category: 'visual' },

  // ── 행정 ──
  { id: 'building-2', Icon: Building2, labelI18n: 'tplIconBuilding', category: 'admin' },
  { id: 'stamp', Icon: Stamp, labelI18n: 'tplIconStamp', category: 'admin' },
  { id: 'shield', Icon: Shield, labelI18n: 'tplIconShield', category: 'admin' },
  { id: 'folder-kanban', Icon: FolderKanban, labelI18n: 'tplIconKanban', category: 'admin' },
  { id: 'briefcase', Icon: Briefcase, labelI18n: 'tplIconBriefcase', category: 'admin' },

  // ── 일반 ──
  { id: 'sticky-note', Icon: StickyNote, labelI18n: 'tplIconStickyNote', category: 'general' },
  { id: 'bookmark', Icon: Bookmark, labelI18n: 'tplIconBookmark', category: 'general' },
  { id: 'star', Icon: Star, labelI18n: 'tplIconStar', category: 'general' },
  { id: 'tag', Icon: Tag, labelI18n: 'tplIconTag', category: 'general' },
  { id: 'archive', Icon: Archive, labelI18n: 'tplIconArchive', category: 'general' },
  { id: 'database', Icon: Database, labelI18n: 'tplIconDatabase', category: 'general' },
  { id: 'folder', Icon: Folder, labelI18n: 'tplIconFolder', category: 'general' },
  { id: 'hash', Icon: Hash, labelI18n: 'tplIconHash', category: 'general' },
];

export const ICON_CATEGORIES: ReadonlyArray<{ id: TemplateIconCategory; labelI18n: string }> = [
  { id: 'document', labelI18n: 'tplIconCatDocument' },
  { id: 'people',   labelI18n: 'tplIconCatPeople' },
  { id: 'time',     labelI18n: 'tplIconCatTime' },
  { id: 'academic', labelI18n: 'tplIconCatAcademic' },
  { id: 'visual',   labelI18n: 'tplIconCatVisual' },
  { id: 'admin',    labelI18n: 'tplIconCatAdmin' },
  { id: 'general',  labelI18n: 'tplIconCatGeneral' },
];

/**
 * Backward-compat map: old icon name (from the 12-template registry) →
 * new lucide id. Lets existing custom templates keep rendering the right
 * lucide icon without manual migration. The fallback for unknown ids is
 * StickyNote (general note).
 */
const LEGACY_ICON_MAP: Record<string, string> = {
  note: 'sticky-note',
  mtg: 'users',
  ofa: 'file-text',
  sem: 'presentation',
  event: 'calendar',
  contact: 'contact',
  setup: 'tag',
  data: 'database',
  theo: 'lightbulb',
  paper: 'book-open',
  sketch: 'pen-tool',
  lit: 'book-open',
};

const ICON_BY_ID: Record<string, TemplateIconEntry> = (() => {
  const map: Record<string, TemplateIconEntry> = {};
  for (const entry of TEMPLATE_ICON_CATALOG) map[entry.id] = entry;
  return map;
})();

/**
 * Resolve any icon id (new lucide kebab-case, legacy old-template-name,
 * or PascalCase lucide component name) to the catalog entry. Falls back
 * to StickyNote when nothing matches.
 *
 * v14 fix (2026-05-16, HanBin) — also accepts PascalCase (e.g. 'Users',
 * 'FileText') so the built-in `tpl-*` templates' `icon: 'Users'` props
 * resolve to the catalog entry 'users'. Previously these failed match,
 * fell through to fallback, and the icon never reflected the template's
 * declared icon.
 */
export function resolveTemplateIcon(id: string | undefined | null): TemplateIconEntry {
  if (id) {
    // 1. Direct id match (kebab-case as defined in catalog)
    if (ICON_BY_ID[id]) return ICON_BY_ID[id];
    // 2. PascalCase → kebab-case (e.g. 'FileText' → 'file-text', 'Users' → 'users')
    const kebab = id.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/[\s_]+/g, '-').toLowerCase();
    if (ICON_BY_ID[kebab]) return ICON_BY_ID[kebab];
    // 3. Lowercase direct (e.g. 'USERS' → 'users')
    const lower = id.toLowerCase();
    if (ICON_BY_ID[lower]) return ICON_BY_ID[lower];
    // 4. Legacy old-template-name mapping (e.g. 'mtg' → 'users')
    const mapped = LEGACY_ICON_MAP[lower];
    if (mapped && ICON_BY_ID[mapped]) return ICON_BY_ID[mapped];
  }
  return ICON_BY_ID['sticky-note'];
}
