/**
 * graph-colors — Force-Graph color resolver (Stage 5.0.7c).
 *
 * Force-Graph renders to a `<canvas>`. The canvas context (`ctx.fillStyle`,
 * `ctx.strokeStyle`) accepts ONLY raw color strings — no CSS variables. So
 * we resolve every theme-driven color once at theme-change time by reading
 * `getComputedStyle(document.documentElement)` and cache the values as
 * JS strings. GraphView reads from the cached palette during paint.
 *
 * On theme swap (`html[data-theme="..."]` flip), GraphView re-invokes
 * `resolveGraphColors()` and the canvas re-paints with the new palette.
 *
 * Falls back to the hardcoded hex when a token is missing (e.g. during
 * SSR / test, or before tokens.css mounts), so the resolver never throws.
 */

export interface GraphColorPalette {
  // Tag namespace ribbons — defined as Tier-3 `--c-tag-*` tokens in themes.css
  tagDomain: string;
  tagWho: string;
  tagOrg: string;
  tagCtx: string;
  tagFallback: string;

  // Container / folder-note
  folderNote: string;

  // Note types — read `--{type}-color` defined in note-type-colors.css
  note: string;
  sketch: string;
  mtg: string;
  sem: string;
  event: string;
  ofa: string;
  paper: string;
  lit: string;
  data: string;
  theo: string;
  contact: string;
  setup: string;
  container: string;
  task: string;
  adm: string;
  entity: string;

  // Misc graph chrome — search glow, task badge dot, memo dot, label fill/bg
  searchGlow: string;
  taskDot: string;
  memoDot: string;
  labelText: string;
  labelTextHighlight: string;
  labelBg: string;
}

/** Hardcoded fallbacks — identical to pre-5.0.7c constants. */
const FALLBACK_DARK: GraphColorPalette = {
  tagDomain: '#a78bfa',
  tagWho: '#22d3ee',
  tagOrg: '#fb923c',
  tagCtx: '#34d399',
  tagFallback: '#f59e0b',
  folderNote: '#e5e7eb',  /* v22 — neutral light slate for dark theme */
  note: '#a78bfa',
  sketch: '#f472b6',
  mtg: '#60a5fa',
  sem: '#fb923c',
  event: '#f87171',
  ofa: '#34d399',
  paper: '#5eead4',
  lit: '#a3e635',
  data: '#fbbf24',
  theo: '#818cf8',
  contact: '#22d3ee',
  setup: '#9ca3af',
  container: '#60a5fa',
  task: '#f87171',
  adm: '#9ca3af',
  entity: '#60a5fa',
  searchGlow: '#facc15',
  taskDot: '#f87171',
  memoDot: '#fbbf24',
  labelText: '#ffffff',
  labelTextHighlight: '#facc15',
  labelBg: 'rgba(0,0,0,0.75)',
};

const FALLBACK_LIGHT: GraphColorPalette = {
  ...FALLBACK_DARK,
  // Tighter Tailwind palette for light bg
  tagDomain: '#6d28d9',
  tagWho: '#0891b2',
  tagOrg: '#ea580c',
  tagCtx: '#059669',
  // Darker note-type tints for legibility on white
  note: '#7c3aed',
  mtg: '#2563eb',
  sem: '#c2410c',
  event: '#dc2626',
  ofa: '#059669',
  data: '#d97706',
  theo: '#4338ca',
  contact: '#0891b2',
  setup: '#6b7280',
  container: '#2563eb',
  // v22 — folder note neutral slate on light bg
  folderNote: '#1f2937',
  // Labels flip for white bg
  labelText: '#1a1a1a',
  labelBg: 'rgba(255,255,255,0.92)',
};

/** Read a single CSS custom property, return trimmed value or fallback. */
function readVar(root: CSSStyleDeclaration, name: string, fallback: string): string {
  const v = root.getPropertyValue(name);
  return v && v.trim() ? v.trim() : fallback;
}

/**
 * Resolve graph colors from current CSS tokens. Pass `isDark` so missing
 * tokens fall back to the right palette half. Caller should re-invoke
 * after theme change (e.g. inside an effect whose dep array includes the
 * Zustand theme selector).
 */
export function resolveGraphColors(isDark: boolean): GraphColorPalette {
  if (typeof document === 'undefined') {
    return isDark ? FALLBACK_DARK : FALLBACK_LIGHT;
  }
  const root = getComputedStyle(document.documentElement);
  const fb = isDark ? FALLBACK_DARK : FALLBACK_LIGHT;

  return {
    tagDomain: readVar(root, '--c-tag-domain', fb.tagDomain),
    tagWho:    readVar(root, '--c-tag-who',    fb.tagWho),
    tagOrg:    readVar(root, '--c-tag-org',    fb.tagOrg),
    tagCtx:    readVar(root, '--c-tag-ctx',    fb.tagCtx),
    tagFallback: readVar(root, '--c-yellow', fb.tagFallback),
    // v22 (HanBin 2026-05-23) — folder notes were the same `--c-blue` as
    // the legacy accent. Neutralised: read `--tx-1` first (theme-aware dark
    // in light / light in dark) so the folder node stands out by being
    // the strongest contrast in the graph, not by being the only blue node.
    folderNote: readVar(root, '--tx-1', fb.folderNote),
    note:       readVar(root, '--note-color',     fb.note),
    sketch:     readVar(root, '--sketch-color',   fb.sketch),
    mtg:        readVar(root, '--mtg-color',      fb.mtg),
    sem:        readVar(root, '--sem-color',      fb.sem),
    event:      readVar(root, '--event-color',    fb.event),
    ofa:        readVar(root, '--ofa-color',      fb.ofa),
    paper:      readVar(root, '--paper-color',    fb.paper),
    lit:        readVar(root, '--lit-color',      fb.lit),
    data:       readVar(root, '--data-color',     fb.data),
    theo:       readVar(root, '--theo-color',     fb.theo),
    contact:    readVar(root, '--contact-color',  fb.contact),
    setup:      readVar(root, '--setup-color',    fb.setup),
    container:  readVar(root, '--container-color', fb.container),
    task:       readVar(root, '--task-color',     fb.task),
    adm:        readVar(root, '--adm-color',      fb.adm),
    entity:     readVar(root, '--entity-color',   fb.entity),
    searchGlow: readVar(root, '--c-yellow', fb.searchGlow),
    taskDot:    readVar(root, '--c-red',    fb.taskDot),
    memoDot:    readVar(root, '--c-orange', fb.memoDot),
    labelText:  fb.labelText,         // Theme-aware via fb; CSS var not exposed
    labelTextHighlight: readVar(root, '--c-yellow', fb.labelTextHighlight),
    labelBg:    fb.labelBg,
  };
}

/** Helper: NOTE_TYPE → color, with `note` as ultimate fallback. */
export function noteTypeColor(palette: GraphColorPalette, type: string | undefined | null): string {
  if (!type) return palette.note;
  const key = type.toLowerCase() as keyof GraphColorPalette;
  const v = palette[key];
  return typeof v === 'string' ? v : palette.note;
}

/** Helper: tag namespace prefix → color, with `tagFallback` (amber) default. */
export function tagNamespaceColor(palette: GraphColorPalette, tagLabel: string): string {
  if (tagLabel.startsWith('domain/')) return palette.tagDomain;
  if (tagLabel.startsWith('who/'))    return palette.tagWho;
  if (tagLabel.startsWith('org/'))    return palette.tagOrg;
  if (tagLabel.startsWith('ctx/'))    return palette.tagCtx;
  return palette.tagFallback;
}
