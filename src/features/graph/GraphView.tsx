import { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import ForceGraph from 'force-graph';
import { listen } from '../../web/event';
import { searchCommands, utilCommands } from '../../core/services/tauriCommands';
import { hoverActions } from '../hover-windows/stores/hoverStore';

// File type helpers for attachment handling
const IMAGE_EXTENSIONS = /\.(png|jpg|jpeg|gif|webp|svg|bmp|ico)$/i;
const PDF_EXTENSION = /\.pdf$/i;
import { useVaultPath } from '../../core/stores/fileTreeStore';
import { useGraphSettings, useSettingsStore, useLanguage, useTheme } from '../../core/stores/zustand';
import { useNoteTemplates } from '../templates/stores/templateStore';
import { useSearchReady } from '../../core/stores/refreshStore';
import { getTemplateCustomColor } from '../content-cache/noteTypeHelpers';
import { selectContainer } from '../../core/stores/appActions';
import { tagColor as tagColorShared } from '../search/searchHelpers';
import { t, tf } from '../../core/utils/i18n';
import type { GraphData, GraphSettings } from '../../core/types';
import { DEFAULT_GRAPH_SETTINGS } from '../../core/types';
import { Settings, Search as SearchIcon, X, FileText, Hash, Paperclip, Folder, Calendar, MessageSquare, Link2 } from 'lucide-react';
import { Toggle } from '../../design-system/components/Toggle';
import { resolveGraphColors, type GraphColorPalette } from './graph-colors';

// 5.0.7c (2026-05-17, HanBin) — color resolver pattern. Force-Graph
// renders to canvas, which can't consume CSS vars. We resolve theme-driven
// colors via `resolveGraphColors()` and mutate these `let`-bound maps on
// mount + on theme change inside `<GraphView>`. Canvas callbacks read from
// the mutated maps, so re-paint immediately pulls the new palette.
//
// Initial values match the dark-mode fallbacks so first paint before the
// resolver runs is still visually correct in the common case.
let TAG_NAMESPACE_COLORS: Record<string, string> = {
  domain: '#a78bfa',
  who: '#22d3ee',
  org: '#fb923c',
  ctx: '#34d399',
};
let DEFAULT_TAG_COLOR = '#f59e0b';
let FOLDER_NOTE_COLOR = '#60a5fa';
let NOTE_TYPE_COLORS: Record<string, string> = {
  note: '#a78bfa', sketch: '#f472b6', mtg: '#60a5fa', sem: '#fb923c',
  event: '#f87171', ofa: '#34d399', paper: '#5eead4', lit: '#a3e635',
  data: '#fbbf24', theo: '#818cf8', contact: '#22d3ee', setup: '#9ca3af',
  container: '#60a5fa', task: '#f87171', adm: '#9ca3af',
};

/** Apply a freshly resolved palette to the module-level color maps. */
function applyPalette(p: GraphColorPalette) {
  TAG_NAMESPACE_COLORS = { domain: p.tagDomain, who: p.tagWho, org: p.tagOrg, ctx: p.tagCtx };
  DEFAULT_TAG_COLOR = p.tagFallback;
  FOLDER_NOTE_COLOR = p.folderNote;
  NOTE_TYPE_COLORS = {
    note: p.note, sketch: p.sketch, mtg: p.mtg, sem: p.sem,
    event: p.event, ofa: p.ofa, paper: p.paper, lit: p.lit,
    data: p.data, theo: p.theo, contact: p.contact, setup: p.setup,
    container: p.container, task: p.task, adm: p.adm,
  };
}

interface GraphViewProps {
  containerPath?: string | null;
  refreshTrigger?: number;
}

interface GraphNodeInternal {
  id: string;
  label: string;
  nodeType: string;
  noteType: string;
  path: string;
  isFolderNote: boolean;
  tagNamespace: string;
  memoCount?: number;
  taskCount?: number;
  hasUnresolvedTasks?: boolean;
  // d3-force added
  x?: number;
  y?: number;
  fx?: number;
  fy?: number;
  // computed
  degree?: number;
  _color?: string; // precomputed color
}

interface GraphLinkInternal {
  source: string | GraphNodeInternal;
  target: string | GraphNodeInternal;
  edgeType: string;
}

function GraphView({ containerPath, refreshTrigger }: GraphViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<ForceGraph | null>(null);
  const vaultPath = useVaultPath();
  const searchReady = useSearchReady();
  const graphSettings = useGraphSettings();
  const noteTemplates = useNoteTemplates();
  const language = useLanguage();
  const theme = useTheme();
  const isDark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  const isDarkRef = useRef(isDark);
  isDarkRef.current = isDark;
  // 5.0.7c — refresh the module-level color maps whenever theme flips so
  // subsequent canvas paints pick up the new palette. Initial run on mount.
  useEffect(() => {
    applyPalette(resolveGraphColors(isDark));
  }, [isDark]);
  const [graphData, setGraphData] = useState<GraphData | null>(null);
  const [loading, setLoading] = useState(false);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchHighlightId, setSearchHighlightId] = useState<string | null>(null);
  // Selected tag node for persistent highlight (click to select, click elsewhere to deselect)
  const [selectedTagId, setSelectedTagId] = useState<string | null>(null);
  // Selected folder note for highlight (single click selects, double click navigates)
  const [selectedFolderNoteId, setSelectedFolderNoteId] = useState<string | null>(null);
  // Selected attachment for highlight (single click selects, double click opens)
  const [selectedAttachmentId, setSelectedAttachmentId] = useState<string | null>(null);
  // Selected note for highlight (single click selects, double click opens HoverEditor)
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);

  // v22 (HanBin 2026-05-23) — screen-space position of the selected node's
  // info-bubble. Updated each animation frame so the bubble follows the
  // node as the force simulation jiggles or the user pans/zooms. null when
  // no node is selected → info bubble is hidden.
  const [nodeInfoPos, setNodeInfoPos] = useState<{ x: number; y: number } | null>(null);

  // v22.4 (HanBin 2026-05-23) — local in-flight slider values. The store
  // copy in `graphSettings.physics` is only written on slider RELEASE
  // (mouseup/keyup) so the simulation doesn't churn through every
  // intermediate value while the user is still dragging. The label readout
  // and the thumb position track this local state for live feedback; the
  // graph itself reorganizes once when the user lets go. Null = no
  // pending drag, render the committed store value.
  const [pendingCharge, setPendingCharge] = useState<number | null>(null);
  const [pendingLinkDistance, setPendingLinkDistance] = useState<number | null>(null);

  // Stable ref for hoveredNodeId to avoid re-binding callbacks
  const hoveredNodeIdRef = useRef<string | null>(null);
  hoveredNodeIdRef.current = hoveredNodeId;

  // Stable ref for searchHighlightId
  const searchHighlightIdRef = useRef<string | null>(null);
  searchHighlightIdRef.current = searchHighlightId;

  // Stable ref for selectedTagId
  const selectedTagIdRef = useRef<string | null>(null);
  selectedTagIdRef.current = selectedTagId;

  // Stable ref for selectedFolderNoteId
  const selectedFolderNoteIdRef = useRef<string | null>(null);
  selectedFolderNoteIdRef.current = selectedFolderNoteId;

  // Stable ref for selectedAttachmentId
  const selectedAttachmentIdRef = useRef<string | null>(null);
  selectedAttachmentIdRef.current = selectedAttachmentId;

  // Stable ref for selectedNoteId
  const selectedNoteIdRef = useRef<string | null>(null);
  selectedNoteIdRef.current = selectedNoteId;

  // Stable ref for latest filtered data (used in callbacks without re-binding graph)
  const filteredDataRef = useRef<{ nodes: GraphNodeInternal[]; links: GraphLinkInternal[] }>({ nodes: [], links: [] });

  // v22 (HanBin 2026-05-23) — track the selected node's screen position
  // in an rAF loop so the info bubble follows the node smoothly during
  // simulation, pan, and zoom. Stops when nothing is selected so we
  // don't burn CPU continuously.
  useEffect(() => {
    const selId = selectedNoteId ?? selectedFolderNoteId ?? selectedAttachmentId ?? selectedTagId;
    if (!selId) {
      setNodeInfoPos(null);
      return;
    }
    let rafId = 0;
    let lastX = -1;
    let lastY = -1;
    const tick = () => {
      const node = filteredDataRef.current.nodes.find(n => n.id === selId);
      const g = graphRef.current;
      if (node && g && typeof (g as { graph2ScreenCoords?: unknown }).graph2ScreenCoords === 'function') {
        const nx = node.x;
        const ny = node.y;
        if (typeof nx === 'number' && typeof ny === 'number') {
          const screen = (g as { graph2ScreenCoords: (x: number, y: number) => { x: number; y: number } })
            .graph2ScreenCoords(nx, ny);
          // Only setState when position actually changes ≥1 px to avoid
          // useless re-renders during settled simulation.
          if (Math.abs(screen.x - lastX) >= 1 || Math.abs(screen.y - lastY) >= 1) {
            lastX = screen.x;
            lastY = screen.y;
            setNodeInfoPos({ x: screen.x, y: screen.y });
          }
        }
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [selectedNoteId, selectedFolderNoteId, selectedAttachmentId, selectedTagId]);

  // --- DATA LOADING ---
  const loadGraphData = useCallback(async () => {
    if (!searchReady || !vaultPath) return;
    setLoading(true);
    try {
      // Timeout to prevent infinite loading if Tauri command hangs
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Graph data timeout')), 10000)
      );
      const data = await Promise.race([
        searchCommands.getGraphData(containerPath ?? null, graphSettings.showAttachments),
        timeoutPromise,
      ]);
      // 2026-05-23 (HanBin) — diagnostic. User reported attachments
      // toggle ON but count stays at 0. Log raw counts from backend so
      // we can tell whether the data simply isn't there or whether the
      // frontend filter pipeline is dropping it.
      const attCount = data?.nodes?.filter((n: { nodeType?: string }) => n.nodeType === 'attachment').length ?? 0;
      const noteCount = data?.nodes?.filter((n: { nodeType?: string }) => n.nodeType === 'note').length ?? 0;
      console.log('[GraphView] loadGraphData:', {
        containerPath: containerPath ?? '(vault-wide)',
        showAttachments: graphSettings.showAttachments,
        nodesTotal: data?.nodes?.length ?? 0,
        notes: noteCount,
        attachments: attCount,
        edges: data?.edges?.length ?? 0,
      });
      setGraphData(data);
    } catch (err) {
      console.error('[GraphView] Failed to load graph data:', err);
      setGraphData(null);
    } finally {
      setLoading(false);
    }
  }, [searchReady, vaultPath, containerPath, graphSettings.showAttachments]);

  // Load data on mount & when dependencies change
  useEffect(() => {
    loadGraphData();
  }, [loadGraphData, refreshTrigger]);

  // Listen for vault-files-changed events (Synology NAS sync)
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    listen<{ paths: string[] }>('vault-files-changed', () => {
      // Debounce: batch rapid sync events into one reload
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        loadGraphData();
      }, 1000);
    }).then(fn => { unlisten = fn; });

    return () => {
      if (unlisten) unlisten();
      if (debounceTimer) clearTimeout(debounceTimer);
    };
  }, [loadGraphData]);

  // --- COLOR HELPERS ---
  const getNodeColor = useCallback((node: GraphNodeInternal): string => {
    const colors = graphSettings.nodeColors;
    if (node.nodeType === 'tag') {
      // 🔴 칩과 그래프가 같은 색을 내야 한다 (2026-08-26 사용자: 뷰 불일치는
      //    치명적). 축색의 단일 진실은 searchHelpers.tagColor — 이 표(4축만)
      //    는 key·proj·acad 가 빠져 전부 예비색으로 뭉개고 있었다.
      const c = tagColorShared(node.label || '');
      if (c && !c.startsWith('var(')) return c;   // canvas 는 var() 를 모른다
      return TAG_NAMESPACE_COLORS[node.tagNamespace] || DEFAULT_TAG_COLOR;
    }
    if (node.nodeType === 'attachment') return colors.attachment;
    // Folder notes (containers) get distinct color
    if (node.isFolderNote) return FOLDER_NOTE_COLOR;
    // 5.0.5a-migration A — unmatched type → warning color. Notes whose
    // frontmatter `type:` value isn't owned by any current template are
    // legacy / pending migration; the graph paints them in the same
    // warning tone the search list uses so the visual signal is
    // consistent across surfaces.
    const noteTypeLower = node.noteType?.toLowerCase() || '';
    if (noteTypeLower) {
      let registered = false;
      for (const tpl of noteTemplates) {
        const t = (tpl.frontmatter.type || '').toString().trim().toLowerCase();
        if (t === noteTypeLower) { registered = true; break; }
      }
      if (!registered) return '#f97316'; // --c-warning fallback for canvas
    }
    // Note node: priority order:
    // 1. User-set template customColor (from vault-config)
    // 2. Built-in noteType color map (per template type) — lowercase lookup
    // 3. Settings noteType override
    // 4. Default note color
    const templateColor = getTemplateCustomColor(noteTypeLower, noteTemplates);
    if (templateColor) return templateColor;
    if (noteTypeLower && NOTE_TYPE_COLORS[noteTypeLower]) return NOTE_TYPE_COLORS[noteTypeLower];
    if (noteTypeLower && colors[noteTypeLower]) return colors[noteTypeLower];
    return colors.note;
  }, [graphSettings.nodeColors, noteTemplates]);

  // --- FILTER DATA ---
  const filteredData = useMemo(() => {
    if (!graphData) return { nodes: [] as GraphNodeInternal[], links: [] as GraphLinkInternal[] };

    let nodes = graphData.nodes as unknown as GraphNodeInternal[];
    let edges = graphData.edges;

    if (!graphSettings.showTags) {
      const tagIds = new Set(nodes.filter(n => n.nodeType === 'tag').map(n => n.id));
      nodes = nodes.filter(n => n.nodeType !== 'tag');
      edges = edges.filter(e => !tagIds.has(e.source) && !tagIds.has(e.target));
    }

    if (!graphSettings.showAttachments) {
      const attIds = new Set(nodes.filter(n => n.nodeType === 'attachment').map(n => n.id));
      nodes = nodes.filter(n => n.nodeType !== 'attachment');
      edges = edges.filter(e => !attIds.has(e.source) && !attIds.has(e.target));
    }

    // Compute degree
    const degreeMap = new Map<string, number>();
    for (const e of edges) {
      degreeMap.set(e.source, (degreeMap.get(e.source) || 0) + 1);
      degreeMap.set(e.target, (degreeMap.get(e.target) || 0) + 1);
    }

    const nodesWithDegree: GraphNodeInternal[] = nodes.map(n => ({
      ...n,
      degree: degreeMap.get(n.id) || 0,
    }));

    const links: GraphLinkInternal[] = edges.map(e => ({
      source: e.source,
      target: e.target,
      edgeType: e.edgeType,
    }));

    return { nodes: nodesWithDegree, links };
  }, [graphData, graphSettings.showTags, graphSettings.showAttachments]);

  // Keep refs in sync (used in graph creation effect without adding deps)
  filteredDataRef.current = filteredData;
  const getNodeColorRef = useRef(getNodeColor);
  getNodeColorRef.current = getNodeColor;
  const physicsRef = useRef(graphSettings.physics);
  physicsRef.current = graphSettings.physics;

  // --- NEIGHBOR SET for hover highlighting ---
  // 🔴 **마디마다·프레임마다 전체 간선을 훑고 있었다** (2026-08-30).
  //    `nodeCanvasObject` 안에서 부르므로 한 프레임에 «마디 수 × 간선 수»다 —
  //    뿌리 그래프(마디 1,275 · 간선 3,839)에서 **한 프레임 10ms**를 썼고,
  //    그것만으로 천장이 97fps 였다. 4배 느린 기계면 40ms = 25fps 천장이다.
  //    같은 마디를 물으면 같은 답이므로 **한 번만 만든다** — 실측 103배.
  //    간선이 갈리면 버린다 (`filteredData` 가 바뀌는 그 자리).
  const neighborCacheRef = useRef(new Map<string, Set<string>>());
  /** 🔴 **가라앉는 시간이 곧 사람이 겪는 렉이다** (2026-08-30).
   *
   * `cooldownTicks(200)` 이 크기와 무관하게 붙박이라, 마디가 많아지면 그
   * 200판이 통째로 느려진다. 실측(뿌리 807마디):
   *
   *     CPU 1/1   37fps 가  5초       ← 견딜 만하다
   *     CPU 1/4    9fps 가 14초       ← 사용자가 말한 «렉»
   *
   * 마디가 많을수록 판을 줄인다. 잘라내는 것이 아니라 **큰 그래프는 애초에
   * 적은 판으로도 모양이 선다** — 아래 실측으로 확인했다.
   */
  const tickBudget = (n: number): { cooldown: number; warmup: number } => {
    const o = (window as unknown as { __graphTicks?: number }).__graphTicks;
    if (o) return { cooldown: o, warmup: Math.round(o / 4) };
    if (n > 600) return { cooldown: 60, warmup: 10 };
    if (n > 300) return { cooldown: 100, warmup: 25 };
    return { cooldown: 200, warmup: 50 };
  };

  const getNeighborSet = useCallback((nodeId: string): Set<string> => {
    const hit = neighborCacheRef.current.get(nodeId);
    if (hit) return hit;
    const neighbors = new Set<string>();
    neighbors.add(nodeId);
    const links = filteredDataRef.current.links;
    for (const link of links) {
      const sourceId = typeof link.source === 'string' ? link.source : link.source.id;
      const targetId = typeof link.target === 'string' ? link.target : link.target.id;
      if (sourceId === nodeId) neighbors.add(targetId);
      if (targetId === nodeId) neighbors.add(sourceId);
    }
    neighborCacheRef.current.set(nodeId, neighbors);
    return neighbors;
  }, []);

  // Track last click for double-click detection (force-graph doesn't have onNodeDoubleClick)
  const lastClickRef = useRef<{ nodeId: string; time: number } | null>(null);
  const DOUBLE_CLICK_DELAY = 300; // ms

  // --- NODE CLICK → single click selects/highlights, double click navigates/opens ---
  const handleNodeClick = useCallback((node: GraphNodeInternal, event?: MouseEvent) => {
    // v22.2 (HanBin 2026-05-23) — capture click position directly from the
    // MouseEvent and convert to container-relative coords. This is the most
    // reliable way to anchor the info bubble next to the node — much more
    // robust than calling graph2ScreenCoords (which depends on force-graph
    // exposing that method and on the simulation having stable node.x/y).
    if (event && containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();
      setNodeInfoPos({
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
      });
    }
    const now = Date.now();
    const lastClick = lastClickRef.current;

    // Check for double-click on the same node
    if (lastClick && lastClick.nodeId === node.id && (now - lastClick.time) < DOUBLE_CLICK_DELAY) {
      // Double-click detected
      lastClickRef.current = null;

      if (node.nodeType === 'note' && !node.isFolderNote && node.path) {
        // Regular note: double-click opens HoverEditor
        hoverActions.open(node.path);
        setSelectedNoteId(null);
        return;
      }

      if (node.isFolderNote && node.path) {
        // Folder note: navigate to container
        const folderPath = node.path.replace(/[/\\][^/\\]+$/, ''); // parent directory
        selectContainer(folderPath);
        return;
      }

      if (node.nodeType === 'attachment' && node.path) {
        // Attachment: open based on file type
        const isImage = IMAGE_EXTENSIONS.test(node.path);
        const isPdf = PDF_EXTENSION.test(node.path);

        if (isImage || isPdf) {
          hoverActions.open(node.path);
        } else {
          utilCommands.openInDefaultApp(node.path);
        }
        setSelectedAttachmentId(null);
        return;
      }
      return;
    }

    // Record this click for potential double-click
    lastClickRef.current = { nodeId: node.id, time: now };

    // Tag node: toggle selection for persistent highlight
    if (node.nodeType === 'tag') {
      setSelectedTagId(prev => prev === node.id ? null : node.id);
      setSelectedNoteId(null);
      setSelectedFolderNoteId(null);
      setSelectedAttachmentId(null);
      return;
    }
    // Clear tag selection when clicking other nodes
    setSelectedTagId(null);

    if (!node.path) return;

    if (node.nodeType === 'note' && !node.isFolderNote) {
      // Regular notes: single click highlights connected nodes (toggle)
      setSelectedNoteId(prev => prev === node.id ? null : node.id);
      setSelectedFolderNoteId(null);
      setSelectedAttachmentId(null);
    } else if (node.isFolderNote) {
      // Folder notes: single click selects/highlights (toggle)
      setSelectedNoteId(null);
      setSelectedFolderNoteId(prev => prev === node.id ? null : node.id);
      setSelectedAttachmentId(null);
    } else if (node.nodeType === 'attachment') {
      // Attachments: single click selects/highlights (toggle), double click opens
      setSelectedNoteId(null);
      setSelectedFolderNoteId(null);
      setSelectedAttachmentId(prev => prev === node.id ? null : node.id);
    }
  }, []);

  // --- DESTROY and REBUILD graph ---
  const destroyGraph = useCallback(() => {
    if (graphRef.current) {
      // v22 — remove custom wheel handler before destroying the graph so
      // it doesn't leak between rebuilds (containerPath change, hot reload).
      const canvasEl = containerRef.current?.querySelector('canvas') as
        (HTMLCanvasElement & { __slowZoomHandler?: (e: WheelEvent) => void }) | null;
      if (canvasEl?.__slowZoomHandler) {
        canvasEl.removeEventListener('wheel', canvasEl.__slowZoomHandler, { capture: true } as EventListenerOptions);
        delete canvasEl.__slowZoomHandler;
      }
      graphRef.current._destructor();
      graphRef.current = null;
    }
  }, []);

  // Track whether canvas div is rendered (data must be loaded for it to appear in DOM)
  const hasData = graphData != null && filteredData.nodes.length > 0;

  // Effect 1: Create/destroy graph instance + static config + event handlers + ResizeObserver
  // Runs when containerPath changes OR when canvas div first appears (hasData false→true)
  useEffect(() => {
    destroyGraph();
    if (!containerRef.current) return;

    const container = containerRef.current;
    const graph = new ForceGraph(container);
    graphRef.current = graph;

    graph
      .nodeId('id')
      .linkSource('source')
      .linkTarget('target')
      .backgroundColor('transparent')
      .width(container.clientWidth)
      .height(container.clientHeight)
      .cooldownTicks(200)          // 아래 graphData 에서 크기에 맞춰 다시 준다
      .warmupTicks(50)
      .nodeCanvasObjectMode(() => 'replace')
      .nodeCanvasObject((node: any, ctx: CanvasRenderingContext2D, globalScale: number) => {
        const n = node as GraphNodeInternal;
        const color = n._color || '#6366f1';
        const degree = n.degree || 0;
        const x = n.x || 0;
        const y = n.y || 0;

        // Size calculation
        let baseSize: number;
        if (n.isFolderNote) {
          baseSize = 6;
        } else if (n.nodeType === 'note') {
          baseSize = 4;
        } else if (n.nodeType === 'tag') {
          baseSize = 3.5;
        } else {
          baseSize = 2.5;
        }
        const size = baseSize + Math.min(degree * 0.4, 5);

        // Hover dim effect OR selected node highlight
        const currentHovered = hoveredNodeIdRef.current;
        const currentSelectedTag = selectedTagIdRef.current;
        const currentSelectedNote = selectedNoteIdRef.current;
        const currentSelectedFolderNote = selectedFolderNoteIdRef.current;
        const currentSelectedAttachment = selectedAttachmentIdRef.current;
        const isHovered = currentHovered === n.id;
        const isSelectedTag = currentSelectedTag === n.id;
        const isSelectedFolderNote = currentSelectedFolderNote === n.id;
        const isSelectedAttachment = currentSelectedAttachment === n.id;
        let alpha = 1;
        // Priority: hover > selected tag > selected note > selected folder note > selected attachment
        if (currentHovered) {
          const neighbors = getNeighborSet(currentHovered);
          alpha = neighbors.has(n.id) ? 1 : 0.08;
        } else if (currentSelectedTag) {
          const neighbors = getNeighborSet(currentSelectedTag);
          alpha = neighbors.has(n.id) ? 1 : 0.08;
        } else if (currentSelectedNote) {
          const neighbors = getNeighborSet(currentSelectedNote);
          alpha = neighbors.has(n.id) ? 1 : 0.08;
        } else if (currentSelectedFolderNote) {
          const neighbors = getNeighborSet(currentSelectedFolderNote);
          alpha = neighbors.has(n.id) ? 1 : 0.08;
        } else if (currentSelectedAttachment) {
          const neighbors = getNeighborSet(currentSelectedAttachment);
          alpha = neighbors.has(n.id) ? 1 : 0.08;
        }

        // Search highlight or selected folder note highlight
        const isSearchHighlight = searchHighlightIdRef.current === n.id;

        ctx.globalAlpha = alpha;

        // Search highlight glow ring
        if (isSearchHighlight) {
          ctx.beginPath();
          ctx.arc(x, y, size + 5, 0, 2 * Math.PI);
          ctx.strokeStyle = '#facc15';
          ctx.lineWidth = 2.5;
          ctx.stroke();
          ctx.beginPath();
          ctx.arc(x, y, size + 8, 0, 2 * Math.PI);
          ctx.strokeStyle = 'rgba(250, 204, 21, 0.3)';
          ctx.lineWidth = 2;
          ctx.stroke();
        }

        // Draw node shape based on type
        if (n.nodeType === 'tag') {
          ctx.beginPath();
          ctx.moveTo(x, y - size * 1.2);
          ctx.lineTo(x + size, y);
          ctx.lineTo(x, y + size * 1.2);
          ctx.lineTo(x - size, y);
          ctx.closePath();
          ctx.fillStyle = color;
          ctx.fill();
          ctx.strokeStyle = isDarkRef.current ? 'rgba(255,255,255,0.3)' : 'rgba(0,0,0,0.3)';
          ctx.lineWidth = 0.5;
          ctx.stroke();
        } else if (n.nodeType === 'attachment') {
          const r = size * 0.8;
          const radius = r * 0.25;
          ctx.beginPath();
          ctx.moveTo(x - r + radius, y - r);
          ctx.lineTo(x + r - radius, y - r);
          ctx.quadraticCurveTo(x + r, y - r, x + r, y - r + radius);
          ctx.lineTo(x + r, y + r - radius);
          ctx.quadraticCurveTo(x + r, y + r, x + r - radius, y + r);
          ctx.lineTo(x - r + radius, y + r);
          ctx.quadraticCurveTo(x - r, y + r, x - r, y + r - radius);
          ctx.lineTo(x - r, y - r + radius);
          ctx.quadraticCurveTo(x - r, y - r, x - r + radius, y - r);
          ctx.closePath();
          ctx.fillStyle = color;
          ctx.fill();
        } else if (n.isFolderNote) {
          ctx.beginPath();
          ctx.arc(x, y, size, 0, 2 * Math.PI);
          ctx.fillStyle = color;
          ctx.fill();
          ctx.strokeStyle = isDarkRef.current ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.45)';
          ctx.lineWidth = 1.5;
          ctx.stroke();
          ctx.beginPath();
          ctx.arc(x, y, size + 2.5, 0, 2 * Math.PI);
          ctx.strokeStyle = color;
          ctx.lineWidth = 1;
          ctx.globalAlpha = alpha * 0.5;
          ctx.stroke();
          ctx.globalAlpha = alpha;
        } else {
          ctx.beginPath();
          ctx.arc(x, y, size, 0, 2 * Math.PI);
          ctx.fillStyle = color;
          ctx.fill();
        }

        // Draw memo/task indicator badge
        if (n.nodeType === 'note' && alpha > 0.5) {
          const tasks = n.taskCount || 0;
          const memos = n.memoCount || 0;
          if (tasks > 0) {
            // Red ring for unresolved tasks
            ctx.beginPath();
            ctx.arc(x, y, size + 2, 0, 2 * Math.PI);
            ctx.strokeStyle = '#f87171';
            ctx.lineWidth = 1.5;
            ctx.stroke();
            // Badge at top-right
            const badgeX = x + size * 0.7;
            const badgeY = y - size * 0.7;
            const badgeR = Math.max(3, 4 / globalScale);
            ctx.beginPath();
            ctx.arc(badgeX, badgeY, badgeR, 0, 2 * Math.PI);
            ctx.fillStyle = '#f87171';
            ctx.fill();
            ctx.fillStyle = '#fff';
            ctx.font = `${badgeR * 1.2}px Sans-Serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(String(tasks), badgeX, badgeY);
          } else if (memos > 0) {
            // Amber dot for memos
            const dotX = x + size * 0.7;
            const dotY = y - size * 0.7;
            ctx.beginPath();
            ctx.arc(dotX, dotY, 2.5, 0, 2 * Math.PI);
            ctx.fillStyle = '#fbbf24';
            ctx.fill();
          }
        }

        // Draw label
        const showLabel = isHovered || isSearchHighlight || globalScale > 0.8;
        if (showLabel) {
          const fontSize = isHovered || isSearchHighlight
            ? Math.max(12 / globalScale, 2)
            : Math.max(10 / globalScale, 1.5);
          ctx.font = `${fontSize}px Sans-Serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'top';

          let label = n.label;
          if (n.nodeType === 'tag') label = '#' + label;

          if (isHovered || isSearchHighlight) {
            const maxLen = 40;
            if (label.length > maxLen) label = label.substring(0, maxLen - 2) + '...';
            const textWidth = ctx.measureText(label).width;
            const hPad = 3 / globalScale;
            const vPad = 2 / globalScale;
            const bgHeight = fontSize * 1.4;
            const labelY = y + size + 3;
            ctx.fillStyle = isDarkRef.current ? 'rgba(0,0,0,0.75)' : 'rgba(255,255,255,0.9)';
            ctx.fillRect(x - textWidth / 2 - hPad, labelY - vPad, textWidth + hPad * 2, bgHeight + vPad * 2);
            ctx.fillStyle = isSearchHighlight ? '#facc15' : isDarkRef.current ? '#ffffff' : '#1a1a1a';
            ctx.fillText(label, x, labelY);
          } else {
            if (label.length > 24) label = label.substring(0, 22) + '...';
            ctx.fillStyle = isDarkRef.current
              ? (alpha < 0.5 ? `rgba(200,200,200,${alpha})` : 'rgba(200,200,200,0.9)')
              : (alpha < 0.5 ? `rgba(60,60,60,${alpha})` : 'rgba(60,60,60,0.9)');
            ctx.fillText(label, x, y + size + 3);
          }
        }

        ctx.globalAlpha = 1;
      })
      .nodePointerAreaPaint((node: any, color: string, ctx: CanvasRenderingContext2D) => {
        const n = node as GraphNodeInternal;
        const degree = n.degree || 0;
        const baseSize = n.isFolderNote ? 6 : n.nodeType === 'note' ? 4 : 3;
        const size = baseSize + Math.min(degree * 0.4, 5);
        const x = n.x || 0;
        const y = n.y || 0;
        ctx.beginPath();
        ctx.arc(x, y, size + 3, 0, 2 * Math.PI);
        ctx.fillStyle = color;
        ctx.fill();
      })
      .linkColor((link: any) => {
        const l = link as GraphLinkInternal;
        const dark = isDarkRef.current;
        const currentHovered = hoveredNodeIdRef.current;
        const currentSelectedTag = selectedTagIdRef.current;
        const currentSelectedNote = selectedNoteIdRef.current;
        const currentSelectedFolderNote = selectedFolderNoteIdRef.current;
        const currentSelectedAttachment = selectedAttachmentIdRef.current;
        // Priority: hover > selected tag > selected note > selected folder note > selected attachment
        const highlightId = currentHovered || currentSelectedTag || currentSelectedNote || currentSelectedFolderNote || currentSelectedAttachment;
        if (highlightId) {
          const sourceId = typeof l.source === 'string' ? l.source : l.source.id;
          const targetId = typeof l.target === 'string' ? l.target : l.target.id;
          const neighbors = getNeighborSet(highlightId);
          if (neighbors.has(sourceId) && neighbors.has(targetId)) {
            // Use brighter color for selected tag highlight
            if (!currentHovered && currentSelectedTag) {
              return dark ? 'rgba(250,204,21,0.7)' : 'rgba(180,140,0,0.75)';
            }
            return dark ? 'rgba(150,150,150,0.6)' : 'rgba(80,80,80,0.6)';
          }
          return dark ? 'rgba(150,150,150,0.03)' : 'rgba(100,100,100,0.05)';
        }
        if (l.edgeType === 'contains') return dark ? 'rgba(100,100,255,0.35)' : 'rgba(60,60,180,0.45)';
        if (l.edgeType === 'tag') return dark ? 'rgba(180,160,100,0.25)' : 'rgba(140,110,40,0.4)';
        if (l.edgeType === 'attachment') return dark ? 'rgba(16,185,129,0.25)' : 'rgba(10,130,80,0.4)';
        return dark ? 'rgba(150,150,150,0.3)' : 'rgba(80,80,80,0.4)';
      })
      .linkWidth((link: any) => {
        const l = link as GraphLinkInternal;
        if (l.edgeType === 'contains') return 1.5;
        if (l.edgeType === 'tag') return 0.7;
        return 0.8;
      })
      .linkLineDash((link: any) => {
        const l = link as GraphLinkInternal;
        if (l.edgeType === 'tag') return [2, 2];
        if (l.edgeType === 'contains') return [4, 2];
        return null;
      })
      .linkDirectionalArrowLength((link: any) => {
        const l = link as GraphLinkInternal;
        return l.edgeType === 'wiki_link' ? 3.5 : 0;
      })
      .linkDirectionalArrowRelPos(1)
      .onNodeHover((node: any) => {
        const n = node as GraphNodeInternal | null;
        setHoveredNodeId(n?.id ?? null);
        if (container) {
          container.style.cursor = node ? 'pointer' : 'default';
        }
      })
      .onNodeClick((node: any, event: MouseEvent) => {
        handleNodeClick(node as GraphNodeInternal, event);
      })
      .onBackgroundClick(() => {
        // Clear selections when clicking on empty space
        setSelectedTagId(null);
        setSelectedNoteId(null);
        setSelectedFolderNoteId(null);
        setSelectedAttachmentId(null);
      })
      .onNodeDragEnd((node: any) => {
        // Don't pin nodes on drag - keep them floating for physics simulation
        // Users can double-click to toggle pinned state if needed
      })
      .onNodeRightClick((node: any) => {
        // Right-click to toggle pinned state
        const n = node as GraphNodeInternal;
        if (n.fx !== undefined && n.fy !== undefined) {
          // Currently pinned → unpin
          n.fx = undefined;
          n.fy = undefined;
        } else {
          // Currently floating → pin
          n.fx = n.x;
          n.fy = n.y;
        }
        // Reheat simulation to update
        if (graphRef.current) {
          graphRef.current.d3ReheatSimulation();
        }
      })
      .enableNodeDrag(true)
      .enableZoomInteraction(true)
      .enablePanInteraction(true)
      .minZoom(0.1)
      .maxZoom(20);

    // v22 (HanBin 2026-05-23) — slow the Ctrl+wheel zoom step. force-graph's
    // default d3-zoom wheel handler scales by ~25% per tick which makes
    // precision adjustment impossible. Capture wheel BEFORE d3-zoom (capture
    // phase) and re-dispatch with deltaY divided by 4 so each tick is ~6%.
    // Result: finer control without losing the same gesture (still wheel).
    const canvasEl = containerRef.current?.querySelector('canvas');
    if (canvasEl) {
      const slowZoomHandler = (e: WheelEvent) => {
        if (e.deltaY === 0) return;
        // Don't interfere with non-zoom modifiers (Shift+wheel = horizontal pan).
        e.stopPropagation();
        e.preventDefault();
        // v22.4 (HanBin 2026-05-23) — scrolling/zooming clears the focused
        // node. The info bubble is anchored to a specific node position;
        // when the user starts panning/zooming they're navigating, not
        // inspecting that node anymore, so the bubble becomes stale
        // noise. Clear all four selection slots in one shot.
        setSelectedTagId(null);
        setSelectedNoteId(null);
        setSelectedFolderNoteId(null);
        setSelectedAttachmentId(null);
        const currentZoom = graph.zoom();
        // Logarithmic step — each tick multiplies/divides by a factor close
        // to 1, so zooming feels like a smooth ramp rather than discrete jumps.
        //
        // 🔴 **계수 하나로는 안 된다** (사용자 지적, 2026-08-11:
        //    "노트북 터치패드 감도가 낮은지, 확대가 아주 조금씩 되어서
        //     확대가 거의 안 되는 상황").
        //
        //    마우스 휠은 한 칸에 deltaY가 100 안팎으로 온다 → 0.0015면 ~16%.
        //    터치패드는 손가락을 조금 움직이면 **1~5**로 온다 → 0.0015면 0.7%.
        //    같은 계수를 쓰면 터치패드에서는 아무 일도 안 일어난다.
        //
        //    `deltaMode`로 가른다: 픽셀 단위(0)이고 값이 작으면 터치패드다.
        //    터치패드는 **연속으로 여러 번** 오므로 한 번의 폭을 키워도
        //    거칠어지지 않는다.
        const raw = Math.abs(e.deltaY);
        const trackpad = e.deltaMode === 0 && raw < 50;
        const k = trackpad ? 0.010 : 0.0015;
        const factor = Math.exp(-e.deltaY * k);
        const nextZoom = Math.max(0.1, Math.min(20, currentZoom * factor));
        graph.zoom(nextZoom, 100);  // 100ms transition for smoothness
      };
      canvasEl.addEventListener('wheel', slowZoomHandler, { capture: true, passive: false });
      // Stash on element so cleanup effect can remove. Using a property
      // avoids needing a separate ref or external state.
      (canvasEl as HTMLCanvasElement & { __slowZoomHandler?: typeof slowZoomHandler }).__slowZoomHandler = slowZoomHandler;
    }

    // Set initial data if available
    const data = filteredDataRef.current;
    if (data.nodes.length > 0) {
      const colorMap = new Map<string, string>();
      for (const n of data.nodes) {
        colorMap.set(n.id, getNodeColorRef.current(n));
      }
      const _b = tickBudget(data.nodes.length);
      graph.cooldownTicks(_b.cooldown).warmupTicks(_b.warmup);
      neighborCacheRef.current.clear();
      graph.graphData({
        nodes: data.nodes.map(n => ({ ...n, _color: colorMap.get(n.id) })),
        links: data.links.map(l => ({ ...l })),
      });
    }

    // Set initial physics
    const { chargeStrength, linkDistance, centerStrength } = physicsRef.current;
    const charge = graph.d3Force('charge');
    if (charge && typeof charge.strength === 'function') charge.strength(chargeStrength);
    const linkForce = graph.d3Force('link');
    if (linkForce && typeof linkForce.distance === 'function') linkForce.distance(linkDistance);
    const center = graph.d3Force('center');
    if (center && typeof center.strength === 'function') center.strength(centerStrength);

    // Zoom to fit after stabilization
    setTimeout(() => {
      if (graphRef.current) graphRef.current.zoomToFit(400, 40);
    }, 600);

    // Resize observer
    const observer = new ResizeObserver(entries => {
      for (const entry of entries) {
        if (graphRef.current) {
          graphRef.current.width(entry.contentRect.width);
          graphRef.current.height(entry.contentRect.height);
        }
      }
    });
    observer.observe(container);

    return () => {
      observer.disconnect();
      destroyGraph();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [containerPath, hasData]);

  // Effect 2: Update graph data when filteredData or node colors change (preserves graph instance + node positions)
  useEffect(() => {
    const graph = graphRef.current;
    if (!graph || filteredData.nodes.length === 0) return;

    const colorMap = new Map<string, string>();
    for (const n of filteredData.nodes) {
      colorMap.set(n.id, getNodeColor(n));
    }

    const b = tickBudget(filteredData.nodes.length);
    graph.cooldownTicks(b.cooldown).warmupTicks(b.warmup);
    neighborCacheRef.current.clear();          // 간선이 갈렸으니 이웃도 다시
    graph.graphData({
      nodes: filteredData.nodes.map(n => ({ ...n, _color: colorMap.get(n.id) })),
      links: filteredData.links.map(l => ({ ...l })),
    });

    setTimeout(() => {
      if (graphRef.current) graphRef.current.zoomToFit(400, 40);
    }, 600);
  }, [filteredData, getNodeColor]);

  // Effect 3: Update physics without recreating graph (slider changes preserve node positions).
  // v22.3 (HanBin 2026-05-23) — slider was choppy because every onChange tick
  // called d3ReheatSimulation() which sets alpha=1 (full restart). Each new
  // tick interrupted the previous restart before it could settle, producing
  // the snap-restart-snap cycle the user described as "buggy".
  // Fix: apply force values immediately (cheap, no visual effect alone), then
  // debounce the reheat by 220ms so the simulation only restarts once after
  // the user pauses or releases the slider.
  const physicsReheatTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const graph = graphRef.current;
    if (!graph) return;

    const { chargeStrength, linkDistance, centerStrength } = graphSettings.physics;

    const charge = graph.d3Force('charge');
    if (charge && typeof charge.strength === 'function') charge.strength(chargeStrength);
    const linkForce = graph.d3Force('link');
    if (linkForce && typeof linkForce.distance === 'function') linkForce.distance(linkDistance);
    const center = graph.d3Force('center');
    if (center && typeof center.strength === 'function') center.strength(centerStrength);

    if (physicsReheatTimerRef.current) {
      clearTimeout(physicsReheatTimerRef.current);
    }
    physicsReheatTimerRef.current = setTimeout(() => {
      if (graphRef.current) graphRef.current.d3ReheatSimulation();
      physicsReheatTimerRef.current = null;
    }, 220);

    return () => {
      if (physicsReheatTimerRef.current) {
        clearTimeout(physicsReheatTimerRef.current);
        physicsReheatTimerRef.current = null;
      }
    };
  }, [graphSettings.physics]);

  // Force re-render on hover/search-highlight/selected-tag/selected-folder-note/selected-attachment change (for dim/highlight effect)
  useEffect(() => {
    if (graphRef.current) {
      // Trigger a visual refresh without resetting physics
      graphRef.current.nodeColor(() => ''); // no-op, but forces redraw
    }
  }, [hoveredNodeId, searchHighlightId, selectedTagId, selectedNoteId, selectedFolderNoteId, selectedAttachmentId]);

  // --- SEARCH within graph ---
  const handleSearchNode = useCallback((query: string) => {
    setSearchQuery(query);
    if (!query.trim() || !graphRef.current) {
      setSearchHighlightId(null);
      return;
    }

    const q = query.toLowerCase();
    // Get live nodes from graph instance (has d3-force computed x/y)
    const liveNodes = graphRef.current.graphData().nodes as GraphNodeInternal[];
    const foundNode = liveNodes.find(n => n.label?.toLowerCase().includes(q));
    if (foundNode && foundNode.x !== undefined && foundNode.y !== undefined) {
      setSearchHighlightId(foundNode.id);
      graphRef.current.centerAt(foundNode.x, foundNode.y, 500);
      graphRef.current.zoom(4, 500);
    } else {
      setSearchHighlightId(null);
    }
  }, []);

  // Settings update helper
  const updateSettings = useCallback((updates: Partial<GraphSettings>) => {
    useSettingsStore.getState().setGraphSettings(updates, vaultPath);
  }, [vaultPath]);

  // Cleanup on unmount
  useEffect(() => {
    return () => { destroyGraph(); };
  }, [destroyGraph]);

  if ((loading && !graphData) || !searchReady) {
    return (
      <div className="graph-view-container">
        <div className="graph-loading">{t('graphLoading', language)}</div>
      </div>
    );
  }

  if (!graphData || filteredData.nodes.length === 0) {
    return (
      <div className="graph-view-container">
        <div className="graph-empty">{t('graphNoNotes', language)}</div>
      </div>
    );
  }

  return (
    <div className="graph-view-container">
      <div ref={containerRef} className="graph-view-canvas" />

      {/* Search bar — v22 (HanBin 2026-05-23) iOS-style pill input with
          search icon + clear-X button. Live filter overlay shows match
          count when query is non-empty. */}
      <div className="graph-search-bar">
        <SearchIcon size={14} strokeWidth={2} className="graph-search-bar__icon" aria-hidden="true" />
        <input
          type="text"
          className="graph-search-input"
          placeholder={t('graphSearchPlaceholder', language)}
          value={searchQuery}
          onChange={e => handleSearchNode(e.target.value)}
        />
        {searchQuery && (
          <button
            type="button"
            className="graph-search-bar__clear"
            onClick={() => handleSearchNode('')}
            title={t('clear', language)}
            aria-label={t('clear', language)}
          >
            <X size={12} strokeWidth={2} />
          </button>
        )}
        {searchQuery && (() => {
          const q = searchQuery.toLowerCase();
          const matches = filteredData.nodes.filter(n => n.label.toLowerCase().includes(q)).length;
          return (
            <span className="graph-search-bar__count" aria-live="polite">
              {matches}
            </span>
          );
        })()}
      </div>

      {/* Settings toggle */}
      <button
        className={`graph-settings-toggle${showSettings ? ' is-active' : ''}`}
        onClick={() => setShowSettings(!showSettings)}
        title={t('graphSettings', language)}
        aria-pressed={showSettings}
      >
        <Settings size={14} strokeWidth={2} />
      </button>

      {/* Settings panel — v22 redesign with DS Toggle + neutral colors */}
      {showSettings && (
        <div className="graph-settings-panel">
          <div className="graph-settings-panel__header">
            <span>{t('graphSettings', language)}</span>
            <button
              type="button"
              className="graph-settings-panel__close"
              onClick={() => setShowSettings(false)}
              title={t('close', language)}
              aria-label={t('close', language)}
            >
              <X size={12} strokeWidth={2} />
            </button>
          </div>

          <div className="graph-settings-panel__group">
            <div className="graph-settings-panel__row">
              <span className="graph-settings-panel__row-label">{t('showTags', language)}</span>
              <Toggle
                size="sm"
                checked={graphSettings.showTags}
                onChange={e => updateSettings({ showTags: e.currentTarget.checked })}
                aria-label={t('showTags', language)}
              />
            </div>
            <div className="graph-settings-panel__row">
              <span className="graph-settings-panel__row-label">{t('showAttachments', language)}</span>
              <Toggle
                size="sm"
                checked={graphSettings.showAttachments}
                onChange={e => updateSettings({ showAttachments: e.currentTarget.checked })}
                aria-label={t('showAttachments', language)}
              />
            </div>
          </div>

          <div className="graph-settings-panel__divider" />

          <div className="graph-settings-panel__group">
            <div className="graph-settings-panel__group-label">{t('physics', language)}</div>
            {/* v22.4 (HanBin 2026-05-23) — defer-on-release pattern.
                onChange writes to pendingCharge / pendingLinkDistance
                (local state, no graph re-render). The thumb + readout
                follow the local value so the slider remains responsive,
                but the d3 simulation only reorganizes once when the user
                lets go (onMouseUp / onTouchEnd / onKeyUp commits to the
                store, which triggers Effect 3 a single time). Eliminates
                the mid-drag "exploding nodes" rebound the user saw. */}
            <div className="graph-settings-slider-row">
              <span className="graph-settings-slider-row__label">{t('chargeStrength', language)}</span>
              <input
                type="range"
                className="graph-settings-slider"
                min="-300"
                max="-10"
                value={pendingCharge ?? graphSettings.physics.chargeStrength}
                onChange={e => setPendingCharge(Number(e.target.value))}
                onMouseUp={() => {
                  if (pendingCharge !== null) {
                    updateSettings({ physics: { ...graphSettings.physics, chargeStrength: pendingCharge } });
                    setPendingCharge(null);
                  }
                }}
                onTouchEnd={() => {
                  if (pendingCharge !== null) {
                    updateSettings({ physics: { ...graphSettings.physics, chargeStrength: pendingCharge } });
                    setPendingCharge(null);
                  }
                }}
                onKeyUp={() => {
                  if (pendingCharge !== null) {
                    updateSettings({ physics: { ...graphSettings.physics, chargeStrength: pendingCharge } });
                    setPendingCharge(null);
                  }
                }}
              />
              <span className="graph-settings-slider-row__value">{pendingCharge ?? graphSettings.physics.chargeStrength}</span>
            </div>
            <div className="graph-settings-slider-row">
              <span className="graph-settings-slider-row__label">{t('linkDistance', language)}</span>
              <input
                type="range"
                className="graph-settings-slider"
                min="10"
                max="200"
                value={pendingLinkDistance ?? graphSettings.physics.linkDistance}
                onChange={e => setPendingLinkDistance(Number(e.target.value))}
                onMouseUp={() => {
                  if (pendingLinkDistance !== null) {
                    updateSettings({ physics: { ...graphSettings.physics, linkDistance: pendingLinkDistance } });
                    setPendingLinkDistance(null);
                  }
                }}
                onTouchEnd={() => {
                  if (pendingLinkDistance !== null) {
                    updateSettings({ physics: { ...graphSettings.physics, linkDistance: pendingLinkDistance } });
                    setPendingLinkDistance(null);
                  }
                }}
                onKeyUp={() => {
                  if (pendingLinkDistance !== null) {
                    updateSettings({ physics: { ...graphSettings.physics, linkDistance: pendingLinkDistance } });
                    setPendingLinkDistance(null);
                  }
                }}
              />
              <span className="graph-settings-slider-row__value">{pendingLinkDistance ?? graphSettings.physics.linkDistance}</span>
            </div>
          </div>

          <button
            className="graph-settings-reset-btn"
            onClick={() => updateSettings(DEFAULT_GRAPH_SETTINGS)}
          >
            {t('resetDefaults', language)}
          </button>
        </div>
      )}

      {/* Node info panel — v22.1 speech-bubble. Floats next to the
          focused node and tracks it during simulation / pan / zoom via
          the rAF loop above (sets nodeInfoPos). Tail arrow on the left
          edge points at the node. */}
      {(() => {
        const selId = selectedNoteId ?? selectedFolderNoteId ?? selectedAttachmentId ?? selectedTagId;
        if (!selId) return null;
        const node = filteredData.nodes.find(n => n.id === selId);
        if (!node) return null;
        // Count connections
        const connections = filteredData.links.filter(l => {
          const s = typeof l.source === 'string' ? l.source : l.source.id;
          const t = typeof l.target === 'string' ? l.target : l.target.id;
          return s === selId || t === selId;
        }).length;
        const TypeIconComp = node.nodeType === 'tag' ? Hash
          : node.nodeType === 'attachment' ? Paperclip
          : node.isFolderNote ? Folder
          : FileText;
        const typeLabel = node.nodeType === 'tag' ? t('tag', language)
          : node.nodeType === 'attachment' ? t('attachment', language)
          : node.isFolderNote ? t('folderNote', language)
          : (node.noteType || t('noteType', language)).toUpperCase();
        // Portal to body + position:fixed so the bubble escapes
        // .graph-view-container's overflow:hidden and stacks above
        // RightPanel / Calendar regardless of sibling z-index.
        // nodeInfoPos is container-relative (from graph2ScreenCoords /
        // event.clientX - rect.left); add containerRect offset to convert
        // back into viewport coordinates.
        const containerRect = containerRef.current?.getBoundingClientRect();
        const panel = (
          <div
            className="graph-node-info"
            style={nodeInfoPos && containerRect
              ? {
                  // 24px right offset clears typical node radius; -16px top
                  // anchors the bubble's pointer near node's vertical center.
                  left: Math.max(8, Math.min(window.innerWidth - 296, nodeInfoPos.x + containerRect.left + 24)),
                  top: Math.max(8, nodeInfoPos.y + containerRect.top - 16),
                  right: 'auto',
                }
              : undefined
            }
          >
            <div className="graph-node-info__header">
              <TypeIconComp size={14} strokeWidth={2} className="graph-node-info__type-icon" />
              <span className="graph-node-info__title" title={node.label}>{node.label}</span>
              <button
                type="button"
                className="graph-node-info__close"
                onClick={() => {
                  setSelectedNoteId(null);
                  setSelectedFolderNoteId(null);
                  setSelectedAttachmentId(null);
                  setSelectedTagId(null);
                }}
                title={t('close', language)}
                aria-label={t('close', language)}
              >
                <X size={12} strokeWidth={2} />
              </button>
            </div>
            <div className="graph-node-info__meta">
              <div className="graph-node-info__meta-row">
                <span className="graph-node-info__meta-label">{t('type', language)}</span>
                <span className="graph-node-info__meta-value">{typeLabel}</span>
              </div>
              {node.path && (
                <div className="graph-node-info__meta-row">
                  <span className="graph-node-info__meta-label">{t('path', language)}</span>
                  <span className="graph-node-info__meta-value" title={node.path}>{node.path}</span>
                </div>
              )}
              <div className="graph-node-info__meta-row">
                <Link2 size={11} strokeWidth={2} className="graph-node-info__meta-icon" aria-hidden="true" />
                <span className="graph-node-info__meta-label">{t('connections', language)}</span>
                <span className="graph-node-info__meta-value">{connections}</span>
              </div>
              {(node.memoCount ?? 0) > 0 && (
                <div className="graph-node-info__meta-row">
                  <MessageSquare size={11} strokeWidth={2} className="graph-node-info__meta-icon" aria-hidden="true" />
                  <span className="graph-node-info__meta-label">{t('memos', language)}</span>
                  <span className="graph-node-info__meta-value">{node.memoCount}</span>
                </div>
              )}
              {(node.taskCount ?? 0) > 0 && (
                <div className="graph-node-info__meta-row">
                  <Calendar size={11} strokeWidth={2} className="graph-node-info__meta-icon" aria-hidden="true" />
                  <span className="graph-node-info__meta-label">{t('tasks', language)}</span>
                  <span className="graph-node-info__meta-value">
                    {node.taskCount}
                    {node.hasUnresolvedTasks && ' •'}
                  </span>
                </div>
              )}
            </div>
            {node.nodeType === 'note' && node.path && (
              <button
                type="button"
                className="graph-node-info__open-btn"
                onClick={() => {
                  // 🔴 노트를 열면 그래프의 노드 팝업은 스스로 닫힌다
                  //    (2026-08-26 사용자: "그래프 뷰의 팝업은 자동으로
                  //    닫히는 등 안정화나 최적화가 왜이렇게 안되어 있나").
                  //    더블클릭 길은 이미 닫고 있었다 — 단추 길만 안 닫았다.
                  hoverActions.open(node.path);
                  setSelectedNoteId(null);
                  setSelectedAttachmentId(null);
                }}
              >
                {t('openInHoverWindow', language)}
              </button>
            )}
          </div>
        );
        return createPortal(panel, document.body);
      })()}

      {/* Legend — v22 iOS-style chip bar (lower-left aligned with settings). */}
      <div className="graph-legend-bar">
        {(() => {
          const folderNoteCount = filteredData.nodes.filter(n => n.isFolderNote).length;
          const typeCounts = new Map<string, number>();
          for (const n of filteredData.nodes) {
            if (n.nodeType === 'note' && !n.isFolderNote && n.noteType) {
              const key = n.noteType.toLowerCase();
              typeCounts.set(key, (typeCounts.get(key) || 0) + 1);
            }
          }
          const items = Array.from(typeCounts.entries())
            .sort((a, b) => b[1] - a[1])
            .map(([type, count]) => (
              <span key={type} className="graph-legend-chip">
                <span
                  className="graph-legend-chip__dot"
                  style={{ backgroundColor: NOTE_TYPE_COLORS[type] || graphSettings.nodeColors.note }}
                />
                <span className="graph-legend-chip__label">{type.toUpperCase()}</span>
                <span className="graph-legend-chip__count">{count}</span>
              </span>
            ));
          if (folderNoteCount > 0) {
            items.unshift(
              <span key="__folder__" className="graph-legend-chip">
                <span className="graph-legend-chip__dot graph-legend-chip__dot--folder" style={{ backgroundColor: FOLDER_NOTE_COLOR }} />
                <span className="graph-legend-chip__label">{tf('folderLabel', language, { count: folderNoteCount }).replace(/\s*\(\d+\)\s*$/, '')}</span>
                <span className="graph-legend-chip__count">{folderNoteCount}</span>
              </span>
            );
          }
          return items;
        })()}
        {graphSettings.showTags && (
          <span className="graph-legend-chip">
            <span className="graph-legend-chip__dot graph-legend-chip__dot--diamond" style={{ backgroundColor: DEFAULT_TAG_COLOR }} />
            <span className="graph-legend-chip__label">TAG</span>
            <span className="graph-legend-chip__count">{filteredData.nodes.filter(n => n.nodeType === 'tag').length}</span>
          </span>
        )}
      </div>

      {/* Info bar — summary on lower-right edge */}
      <div className="graph-info-bar">
        <span>{tf('notesCount', language, { count: filteredData.nodes.filter(n => n.nodeType === 'note').length })}</span>
        {graphSettings.showTags && (
          <span>{tf('tagsCountGraph', language, { count: filteredData.nodes.filter(n => n.nodeType === 'tag').length })}</span>
        )}
        {graphSettings.showAttachments && (
          <span>{tf('attachmentsCountGraph', language, { count: filteredData.nodes.filter(n => n.nodeType === 'attachment').length })}</span>
        )}
        <span>{tf('connectionsCount', language, { count: filteredData.links.length })}</span>
      </div>
    </div>
  );
}

export default GraphView;
