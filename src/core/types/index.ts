export interface FileNode {
  name: string;
  path: string;
  is_dir: boolean;
  is_folder_note: boolean;
  mtime?: number; // Modification time in seconds since UNIX epoch
  children?: FileNode[];
}

export interface FileContent {
  frontmatter: string | null;
  body: string;
}

/**
 * Faceted tags shape that matches the Rust frontmatter struct on disk.
 * Canonical 4 facets after the Q1 cleanup landed in 2026-05-18 — legacy
 * source/method/status arrays are folded into `ctx` by the Rust
 * deserializer (see src-tauri/.../frontmatter/types.rs `deserialize_tags`)
 * so old vaults migrate transparently on first read.
 */
// 🔴 축을 손으로 적지 않는다 (2026-08-29) — 넷만 적어 두어 `key`·`proj`
//    ·`acad` 태그가 형에서부터 없는 것이 되어 있었다.
export type FacetedTags = Partial<Record<FacetNamespace, string[]>> & {
  source?: string[];   // 옛 축 — 읽기만 한다
  method?: string[];
  status?: string[];
};
/** Legacy flat-array tag shape — pre-FacetedTags vaults. Parsers should
 *  accept it but new writes should always emit FacetedTags. */
export type LegacyFlatTags = string[];

export interface NoteFrontmatter {
  created: string;
  modified: string;
  title?: string;
  type?: string;
  cssclasses?: string[];
  /** Polymorphic for backward compat: new writes emit FacetedTags;
   *  legacy notes may still carry a flat string[] until first re-save. */
  tags?: FacetedTags | LegacyFlatTags;
  [key: string]: unknown;
}

/**
 * Stage 5.0.5 T-3 (2026-05-17, HanBin) — shared base for FolderNoteTemplate
 * and NoteTemplate. Both kinds share `id`, `name`, `frontmatter`, and `body`;
 * the kind-specific fields (Folder: `type`+`level`; Note: `prefix`,
 * `namePattern`, custom color/icon, sub-kinds, wizard fields) extend this
 * base. Pulling the common shape out makes future cross-cutting changes
 * (e.g. adding `description`, `version`, or `aliases` to BOTH at once)
 * a single edit instead of two.
 */
export interface BaseTemplate {
  id: string;
  name: string;
  frontmatter: Partial<NoteFrontmatter>;
  body: string;
}

export interface FolderNoteTemplate extends BaseTemplate {
  type: 'A' | 'B';
  level: number;
}

/**
 * Form field declaration for the unified NoteWizard (Stage 5.0.5a, 2026-05-16).
 *
 * A NoteKind can declare which fields the Wizard collects at note creation.
 * The wizard knows how to render each `kind` and produce the merged
 * frontmatter/body without per-template hand-rolled modals.
 */
export type NoteWizardFieldKind =
  | 'title'        // required text, always present implicitly
  | 'text'
  | 'date'         // HTML5 date, defaults to today
  | 'time'         // HH:MM, defaults to nearest 30 min
  | 'url'
  | 'email'
  | 'tel'
  | 'participants' // comma-separated string → string[] in frontmatter
  | 'authors'      // comma-separated string → string[]
  | 'year'         // integer, defaults to current year
  | 'tags';        // FacetedTagSelection (TagInputSection)

export interface NoteWizardField {
  /** Frontmatter key to write into (also form state key). */
  key: string;
  /** Display label — i18n key. */
  labelI18n: string;
  /** Field kind drives rendering + parsing. */
  kind: NoteWizardFieldKind;
  /** If true the user MUST fill it before the wizard can submit. */
  required?: boolean;
  /** Optional placeholder i18n key. */
  placeholderI18n?: string;
}

/**
 * Sub-kind under a parent NoteTemplate. Lets one template (e.g., "Work")
 * parameterize multiple workflows (meeting / report / project / admin / event)
 * without proliferating top-level templates. Stage 5.0.5a IA per HanBin
 * (2026-05-16): top-level = 4 templates, sub-kinds inside Work/Reference.
 */
export interface NoteKind {
  /** Stable id (e.g., 'meeting', 'report', 'paper'). */
  id: string;
  /** Display label i18n key. */
  nameI18n: string;
  /** Optional one-line description i18n key. */
  descriptionI18n?: string;
  /** Optional lucide icon name. */
  icon?: string;
  /** Frontmatter shape produced when this kind is picked.
   *  Merged on top of the parent template's frontmatter. */
  frontmatter: Partial<NoteFrontmatter>;
  /** Markdown body produced when this kind is picked. Supports {{var}}
   *  interpolation from form values. */
  body: string;
  /** Fields the Wizard collects (in addition to the implicit `title`). */
  fields?: NoteWizardField[];
}

export interface NoteTemplate extends BaseTemplate {
  prefix: string;
  namePattern: string;
  // Extended template configuration
  customColor?: string; // Hex color for custom color
  icon?: string; // Icon identifier
  // 축을 손으로 적지 않는다 (2026-08-29) — 넷만 적혀 있어 템플릿이
  // `key`·`proj`·`acad` 를 미리 담아 둘 수 없었다.
  tagCategories?: Partial<Record<FacetNamespace, string[]>>;
  /**
   * Stage 5.0.5a (2026-05-16) — sub-kinds. If present, the Wizard shows a
   * second step where the user picks a kind, and the resulting note uses
   * the kind's frontmatter/body merged with the template's defaults.
   * Templates without `kinds` behave like before — title-only form.
   */
  kinds?: NoteKind[];
  /**
   * Fields the Wizard collects when this template has NO sub-kinds (e.g.,
   * Contact). Title is implicit; declare any additional fields here.
   */
  fields?: NoteWizardField[];
  /**
   * 11th hotfix (2026-05-18, HanBin) — special-modals retire. Declarative
   * list of `{{token}}` strings the unified TitleInputModal should collect
   * even when the body doesn't reference them. Legacy MTG/PAPER/LIT/EVENT
   * templates put their participants/authors/date/etc. into FRONTMATTER
   * (via createFromTemplate's type-specific mapping) rather than into the
   * body, so body-scan alone wouldn't surface those inputs. Listing them
   * here ensures the wizard asks for them. Merged (de-duped) with tokens
   * discovered by `scanUserInputVars(template.body)`.
   */
  userInputTokens?: string[];
}

export type ContainerType = 'standard' | 'storage';

export interface ContainerConfig {
  type: ContainerType;
  assignedTemplateId?: string;
  ribbonLabel?: string;
}

// Folder status for progress tracking
export type FolderStatus = 'none' | 'in_progress' | 'completed' | 'on_hold';

export interface FolderStatusConfig {
  status: FolderStatus;
}

export const FOLDER_STATUS_INFO: { status: FolderStatus; label: string; color: string }[] = [
  { status: 'none', label: 'statusNone', color: 'transparent' },
  { status: 'in_progress', label: 'statusInProgress', color: '#60a5fa' },
  { status: 'completed', label: 'statusCompleted', color: '#4ade80' },
  { status: 'on_hold', label: 'statusOnHold', color: '#fbbf24' },
];

export interface BacklinkResult {
  file_path: string;
  file_name: string;
  line_number: number;
  context: string;
}

export interface AppSettings {
  vault_path: string | null;
  sidebar_width: number;
  dev_mode: boolean;
  show_frontmatter: boolean;
  auto_save_delay_ms: number;
  default_template_type: 'A' | 'B';
}

export interface SearchResult {
  path: string;
  title: string;
  /** First (best) snippet — backward compat. New UI should prefer `snippets`. */
  snippet: string;
  /** 2026-05-22 — up to 5 non-overlapping match excerpts. Lets cards
   *  surface "this note matches in N places" instead of only the first. */
  snippets?: string[];
  score: number;
}

export interface NoteFilter {
  note_type?: string;
  tags?: string[];
  created_after?: string;
  created_before?: string;
  modified_after?: string;
  modified_before?: string;
  sort_by?: string;
  sort_order?: string;
}

export interface NoteMetadata {
  path: string;
  title: string;
  note_type: string;
  tags: string[];
  /** 노트 파일이 실제로 가진 태그. `tags` 의 나머지는 **첨부에서 온 것**이라
   *  노트 창 패널에는 없다 (2026-08-29). 없으면 전부 자기 것으로 친다. */
  own_tags?: string[];
  created: string;
  modified: string;
  has_body: boolean;
  comment_count: number;
}

export interface RelationshipData {
  outgoing_links: LinkInfo[];
  incoming_links: LinkInfo[];
}

export interface LinkInfo {
  path: string;
  title: string;
  context: string;
}

export interface HoverWindow {
  id: string;
  filePath: string;
  type: 'editor' | 'pdf' | 'image' | 'code' | 'web' | 'document';
  noteType?: string; // Template type for editor windows (note, sketch, mtg, etc.)
  position: { x: number; y: number };
  size: { width: number; height: number };
  zIndex: number;
  minimized?: boolean;
  contentReloadTrigger?: number; // Incremented to force content reload
  cached?: boolean; // True when window is hidden in cache pool (not destroyed, ready for instant reuse)
  cachedAt?: number; // Timestamp when moved to cache (for cleanup of old cached windows)
}

export interface SnapPreview {
  zone: 'top' | 'left' | 'right' | null;
  bounds: { x: number; y: number; width: number; height: number };
}

export interface ContextMenuState {
  visible: boolean;
  position: { x: number; y: number };
  fileName: string;
  notePath: string;
  filePath?: string;
  isFolder?: boolean;
  fromSearch?: boolean;
  wikiLinkDeleteCallback?: () => void;
  hideDelete?: boolean;
  isAttachment?: boolean;
  /**
   * Stage 5.0.4b-2d v3.2 (2026-05-15) — atom action list mode. Used by
   * atom nodes (MediaEmbed, math, LinkCard) for right-click menus. Each
   * item renders as a button. When set, `fileName` and `notePath` are
   * empty (wiki-link branch of ContextMenu is skipped).
   *
   * Provides "위에 줄 추가" / "아래에 줄 추가" / "삭제" as reliable
   * fallbacks for atoms where natural caret placement is hard to achieve.
   */
  atomActions?: Array<{
    label: string;
    onClick: () => void;
    /** Show in red (delete-style). */
    danger?: boolean;
  }>;
}

export interface AttachmentInfo {
  path: string;
  file_name: string;
  note_path: string;
  note_name: string;
  note_relative_path: string;
  inferred_note_path: string; // Always shows the note path inferred from _att folder
  container: string;
  is_conflict: boolean;       // Synology Drive conflict file
  conflict_original: string;  // Original file path (empty if not conflict)
}

export interface NasPlatformInfo {
  is_nas_synced: boolean;
  platform: string;
  synology_root: string;
  synology_client_running: boolean;
}

// 5.0.7a (2026-05-17, HanBin) — "details" tab dropped per plan delta §C.
// Information surfaced by the old Details tab will live as an inline
// expand on Frontmatter rows in a follow-up sub-stage.
export type SearchMode = 'frontmatter' | 'contents' | 'attachments' | 'graph';

export interface GraphNode {
  id: string;
  label: string;
  nodeType: string;
  noteType: string;
  path: string;
  isFolderNote: boolean;
  tagNamespace: string;
  memoCount: number;
  taskCount: number;
  hasUnresolvedTasks: boolean;
}

export interface GraphEdge {
  source: string;
  target: string;
  edgeType: string;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface GraphSettings {
  showTags: boolean;
  showAttachments: boolean;
  nodeColors: {
    note: string;
    tag: string;
    attachment: string;
    [key: string]: string;
  };
  physics: {
    chargeStrength: number;
    linkDistance: number;
    centerStrength: number;
  };
}

export const DEFAULT_GRAPH_SETTINGS: GraphSettings = {
  showTags: true,
  showAttachments: false,
  nodeColors: {
    note: '#6366f1',
    tag: '#f59e0b',
    attachment: '#10b981',
  },
  physics: {
    chargeStrength: -120,
    linkDistance: 60,
    centerStrength: 0.05,
  },
};

export interface ContentSearchResult {
  path: string;
  title: string;
  matches: ContentMatch[];
  score: number;
}

export interface ContentMatch {
  line: number;
  text: string;
  highlights: [number, number][];
}

export interface NoteComment {
  id: string;
  content: string;
  position: { from: number; to: number };
  anchorText: string;
  created: string;
  createdTime?: string; // 시간 포함 (ISO 8601)
  resolved: boolean; // 일반 메모: 해결 여부, 할일 메모: 완료 여부
  task?: {
    summary: string;
    dueDate?: string; // YYYY-MM-DD
    dueTime?: string; // HH:MM
    // completed removed - use resolved instead
  };
  // Canvas (스케치) 노트용 필드
  sketchNodeId?: string; // Canvas 노드 ID
  sketchTextPosition?: { from: number; to: number }; // 노드 내 텍스트 위치
}

// Canvas selection 정보 (메모 생성용)
export interface SketchSelection {
  nodeId: string;
  text: string;
  from: number;
  to: number;
}

// Canvas types
export type SketchNodeType = 'text' | 'file' | 'link' | 'group';

export interface SketchNode {
  id: string;
  type: SketchNodeType;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Fill background color (semantic key like 'node-blue' or hex). */
  color?: string;
  /**
   * v20.12 (2026-05-17, HanBin) — node border / outline color. Hex string
   * (e.g. '#007AFF'). Applied as `border-color` on rectangle nodes and as
   * SVG `stroke` on shape-decision / shape-io / shape-database /
   * shape-parallelogram (and any other SVG-rendered shape). Falls back to
   * the theme's `--sep` token when undefined. Synced with edge `color`
   * via the unified "테두리 색상" picker so a node's outline matches the
   * arrow color in a single click.
   */
  borderColor?: string;
  borderRadius?: number;
  shape?: 'process' | 'terminal' | 'decision' | 'io' | 'subroutine' | 'database';
  textAlign?: 'top-left' | 'center';
  text?: string;
  file?: string;
  url?: string;
  // Group node fields
  isGroup?: boolean;
  groupLabel?: string;
}

export interface SketchEdge {
  id: string;
  fromNode: string;
  fromSide: 'top' | 'right' | 'bottom' | 'left';
  toNode: string;
  toSide: 'top' | 'right' | 'bottom' | 'left';
  color?: string;
  label?: string;
}

export interface SketchData {
  nodes: SketchNode[];
  edges: SketchEdge[];
}

// Calendar types
export interface CalendarMemo {
  id: string;
  content: string;
  notePath: string;
  noteTitle: string;
  date: string; // YYYY-MM-DD format
  isTask: boolean;
  resolved: boolean;
  anchorText: string;
  /** "HH:MM" for tasks with a time set; undefined otherwise.
   *  Drives Day-view 24-hour timeline placement. Undefined → "시간 미정" group. */
  dueTime?: string;
}

/** Memo type filter (task vs free-form memo) — NOT a calendar layout mode.
 *  See `CalendarLayoutMode` for month/day switch. */
export type CalendarViewMode = 'task' | 'memo';

/** 2026-05-26 (HanBin) — calendar surface layout. Toggled by SegmentedControl
 *  in CalendarSurface header. `month` = traditional grid + memo list (existing);
 *  `day` = single-day 24-hour timeline of selected date. */
export type CalendarLayoutMode = 'month' | 'day';

// Tag Settings Types
export interface TagConfig {
  color?: string;
  borderColor?: string;
}

/**
 * 🔴 보관소가 실제로 쓰는 **6축** (CLAUDE.md 3-3). 앱은 4개만 알았다.
 *
 * 그래서 `key/Statistical_Analysis` · `acad/컨퍼런스` · `proj/자문회의` 가
 * **색을 못 받고 회색으로 남았다** — 사용자가 "태그도 색이 없는 부분이
 * 있고 자동 관리가 안 되고 있는데?" 라고 한 그 상태다.
 *
 *   org  256건  key 183  who 172  ctx 138  proj 86  acad 40   ← 3-3 실측
 *
 * `domain`은 보관소에 없지만 앱 곳곳이 참조하므로 남겨 둔다.
 */
// 🔴 축 이름표도 여기서 다시 적지 않는다 — `tagOntology` 한 곳이다.
import { FACET_NAMESPACES } from './tagOntology';
export type { FacetNamespace } from './tagOntology';
import type { FacetNamespace } from './tagOntology';

export interface FacetedTagSettings {
  domain: Record<string, TagConfig>;
  key: Record<string, TagConfig>;
  proj: Record<string, TagConfig>;
  acad: Record<string, TagConfig>;
  who: Record<string, TagConfig>;
  org: Record<string, TagConfig>;
  ctx: Record<string, TagConfig>;
}

export const DEFAULT_FACETED_TAG_SETTINGS: FacetedTagSettings = {
  domain: {},
  who: {},
  org: {},
  ctx: {},
  key: {},
  proj: {},
  acad: {},
};

export interface FacetInfo {
  namespace: FacetNamespace;
  label: string;
  description: string;
}

// 🔴 파생이다. 축을 늘릴 곳은 `tagOntology.FACET_NAMESPACES` 한 곳뿐이고
//    여기서 다시 적으면 또 두 벌이 된다 (2026-08-29 사용자: «왜 모든 태그가
//    노트에서 보이지 않나» — 두 벌로 갈라져 절반이 안 보였다).
export const FACET_INFOS: FacetInfo[] = FACET_NAMESPACES.map(
  ({ namespace, label, description }) => ({ namespace, label, description }));

// Tag Color Presets - 10 background colors with good contrast
export interface TagColorPreset {
  id: string;
  bg: string;        // Background color
  text: string;      // Text color for contrast
  label: string;     // Display name
}

// Unified Tag Color Schemes - 10 schemes with matching light bg + dark border
export interface TagColorScheme {
  id: string;
  bg: string;        // Light pastel background
  border: string;    // Dark saturated border
  label: string;     // Display name
}

// 10 Unified Color Schemes (light background + dark border of same color family)
export const TAG_COLOR_SCHEMES: TagColorScheme[] = [
  { id: 'red', bg: '#fecaca', border: '#dc2626', label: 'colorRed' },
  { id: 'orange', bg: '#fed7aa', border: '#ea580c', label: 'colorOrange' },
  { id: 'amber', bg: '#fef08a', border: '#ca8a04', label: 'colorAmber' },
  { id: 'green', bg: '#bbf7d0', border: '#16a34a', label: 'colorGreen' },
  { id: 'teal', bg: '#99f6e4', border: '#0d9488', label: 'colorTeal' },
  { id: 'blue', bg: '#bfdbfe', border: '#2563eb', label: 'colorBlue' },
  { id: 'indigo', bg: '#c7d2fe', border: '#4f46e5', label: 'colorIndigo' },
  { id: 'purple', bg: '#ddd6fe', border: '#9333ea', label: 'colorPurple' },
  { id: 'pink', bg: '#fbcfe8', border: '#db2777', label: 'colorPink' },
  { id: 'slate', bg: '#e2e8f0', border: '#475569', label: 'colorSlate' },
];

// Legacy presets for backward compatibility
export const TAG_BG_PRESETS: TagColorPreset[] = TAG_COLOR_SCHEMES.map(s => ({
  id: s.id,
  bg: s.bg,
  text: '#1a1a1a',
  label: s.label,
}));

// Legacy border presets for backward compatibility
export const TAG_BORDER_PRESETS: TagColorPreset[] = [
  { id: 'none', bg: 'transparent', text: '', label: 'colorNone' },
  ...TAG_COLOR_SCHEMES.map(s => ({
    id: s.id,
    bg: s.border,
    text: '',
    label: s.label,
  })),
];

// Helper to calculate relative luminance of a color
function getLuminance(hexColor: string): number {
  // Remove # if present
  const hex = hexColor.replace('#', '');

  // Parse RGB values
  const r = parseInt(hex.substring(0, 2), 16) / 255;
  const g = parseInt(hex.substring(2, 4), 16) / 255;
  const b = parseInt(hex.substring(4, 6), 16) / 255;

  // Apply sRGB to linear conversion
  const toLinear = (c: number) => c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);

  const rLin = toLinear(r);
  const gLin = toLinear(g);
  const bLin = toLinear(b);

  // Calculate relative luminance (WCAG formula)
  return 0.2126 * rLin + 0.7152 * gLin + 0.0722 * bLin;
}

// Helper to get contrasting text color for a background color
// Uses WCAG contrast ratio calculation for accessibility
export function getTagTextColor(bgColor: string): string {
  // Handle invalid or transparent colors
  if (!bgColor || bgColor === 'transparent' || bgColor.length < 7) {
    return '#ffffff';
  }

  const luminance = getLuminance(bgColor);

  // Use white text for dark backgrounds, dark text for light backgrounds
  // Threshold of 0.179 gives approximately 4.5:1 contrast ratio (WCAG AA)
  return luminance > 0.179 ? '#1a1a1a' : '#ffffff';
}

// ============================================================================
// Vault Lock Types (for Synology Drive multi-device support)
// ============================================================================

export interface VaultLockInfo {
  machine_id: string;
  hostname: string;
  pid: number;
  app_version: string;
  locked_at: string;
  heartbeat: string;
}

export interface LockStatusResponse {
  is_locked: boolean;
  holder: VaultLockInfo | null;
  is_stale: boolean;
  is_mine: boolean;
}

export type LockAcquireResult =
  | { status: 'Success' }
  | { status: 'AlreadyHeld' }
  | { status: 'Denied'; holder: VaultLockInfo; is_stale: boolean }
  | { status: 'Error'; message: string };
