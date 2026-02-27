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

export interface NoteFrontmatter {
  created: string;
  modified: string;
  title?: string;
  type?: string;
  cssclasses?: string[];
  tags?: string[];
  [key: string]: unknown;
}

export interface FolderNoteTemplate {
  id: string;
  name: string;
  type: 'A' | 'B';
  level: number;
  frontmatter: Partial<NoteFrontmatter>;
  body: string;
}

export interface NoteTemplate {
  id: string;
  name: string;
  prefix: string;
  namePattern: string;
  frontmatter: Partial<NoteFrontmatter>;
  body: string;
  // Extended template configuration
  customColor?: string; // Hex color for custom color
  icon?: string; // Icon identifier
  tagCategories?: { // Predefined tag categories for this template
    domain?: string[];
    who?: string[];
    org?: string[];
    ctx?: string[];
  };
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
  snippet: string;
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

export type SearchMode = 'frontmatter' | 'contents' | 'attachments' | 'details' | 'graph';

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
  canvasNodeId?: string; // Canvas 노드 ID
  canvasTextPosition?: { from: number; to: number }; // 노드 내 텍스트 위치
}

// Canvas selection 정보 (메모 생성용)
export interface CanvasSelection {
  nodeId: string;
  text: string;
  from: number;
  to: number;
}

// Canvas types
export type CanvasNodeType = 'text' | 'file' | 'link' | 'group';

export interface CanvasNode {
  id: string;
  type: CanvasNodeType;
  x: number;
  y: number;
  width: number;
  height: number;
  color?: string;
  borderRadius?: number;
  shape?: 'process' | 'terminal' | 'decision' | 'io' | 'subroutine' | 'database';
  textAlign?: 'top-left' | 'center';
  text?: string;
  file?: string;
  url?: string;
}

export interface CanvasEdge {
  id: string;
  fromNode: string;
  fromSide: 'top' | 'right' | 'bottom' | 'left';
  toNode: string;
  toSide: 'top' | 'right' | 'bottom' | 'left';
  color?: string;
  label?: string;
}

export interface CanvasData {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
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
}

export type CalendarViewMode = 'task' | 'memo';

// Tag Settings Types
export interface TagConfig {
  color?: string;
  borderColor?: string;
}

export type FacetNamespace = 'domain' | 'who' | 'org' | 'ctx';

export interface FacetedTagSettings {
  domain: Record<string, TagConfig>;
  who: Record<string, TagConfig>;
  org: Record<string, TagConfig>;
  ctx: Record<string, TagConfig>;
}

export const DEFAULT_FACETED_TAG_SETTINGS: FacetedTagSettings = {
  domain: {},
  who: {},
  org: {},
  ctx: {},
};

export interface FacetInfo {
  namespace: FacetNamespace;
  label: string;
  description: string;
}

export const FACET_INFOS: FacetInfo[] = [
  { namespace: 'domain', label: 'facetDomain', description: 'facetDomainDesc' },
  { namespace: 'who', label: 'facetWho', description: 'facetWhoDesc' },
  { namespace: 'org', label: 'facetOrg', description: 'facetOrgDesc' },
  { namespace: 'ctx', label: 'facetCtx', description: 'facetCtxDesc' },
];

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
