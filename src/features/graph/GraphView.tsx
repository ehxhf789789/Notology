import { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import ForceGraph from 'force-graph';
import { listen } from '@tauri-apps/api/event';
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
import { t, tf } from '../../core/utils/i18n';
import type { GraphData, GraphSettings } from '../../core/types';
import { DEFAULT_GRAPH_SETTINGS } from '../../core/types';
import { Settings } from 'lucide-react';

// Tag namespace → color mapping (matches CSS .search-tag.tag-* colors)
const TAG_NAMESPACE_COLORS: Record<string, string> = {
  domain: '#a78bfa',
  who: '#22d3ee',
  org: '#fb923c',
  ctx: '#34d399',
};
const DEFAULT_TAG_COLOR = '#f59e0b'; // amber fallback
const FOLDER_NOTE_COLOR = '#60a5fa'; // blue-400 — distinct container color

// Note type → color mapping — matches CSS --*-color variables (App.css dark theme)
// Keys are LOWERCASE — backend sends uppercase, so always .toLowerCase() before lookup
const NOTE_TYPE_COLORS: Record<string, string> = {
  note: '#a78bfa',      // --note-color (violet)
  sketch: '#f472b6',    // --sketch-color (pink)
  mtg: '#60a5fa',       // --mtg-color (blue)
  sem: '#fb923c',       // --sem-color (orange)
  event: '#f87171',     // --event-color (red)
  ofa: '#34d399',       // --ofa-color (emerald)
  paper: '#5eead4',     // --paper-color (teal)
  lit: '#a3e635',       // --lit-color (lime)
  data: '#fbbf24',      // --data-color (amber)
  theo: '#818cf8',      // --theo-color (indigo)
  contact: '#22d3ee',   // --contact-color (cyan)
  setup: '#9ca3af',     // --setup-color (gray)
  container: '#60a5fa', // same as folder note
  task: '#f87171',      // same as event
  adm: '#9ca3af',       // same as setup
};

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
      return TAG_NAMESPACE_COLORS[node.tagNamespace] || DEFAULT_TAG_COLOR;
    }
    if (node.nodeType === 'attachment') return colors.attachment;
    // Folder notes (containers) get distinct color
    if (node.isFolderNote) return FOLDER_NOTE_COLOR;
    // Note node: priority order:
    // 1. User-set template customColor (from vault-config)
    // 2. Built-in noteType color map (per template type) — lowercase lookup
    // 3. Settings noteType override
    // 4. Default note color
    const noteTypeLower = node.noteType?.toLowerCase() || '';
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
  const getNeighborSet = useCallback((nodeId: string): Set<string> => {
    const neighbors = new Set<string>();
    neighbors.add(nodeId);
    const links = filteredDataRef.current.links;
    for (const link of links) {
      const sourceId = typeof link.source === 'string' ? link.source : link.source.id;
      const targetId = typeof link.target === 'string' ? link.target : link.target.id;
      if (sourceId === nodeId) neighbors.add(targetId);
      if (targetId === nodeId) neighbors.add(sourceId);
    }
    return neighbors;
  }, []);

  // Track last click for double-click detection (force-graph doesn't have onNodeDoubleClick)
  const lastClickRef = useRef<{ nodeId: string; time: number } | null>(null);
  const DOUBLE_CLICK_DELAY = 300; // ms

  // --- NODE CLICK → single click selects/highlights, double click navigates/opens ---
  const handleNodeClick = useCallback((node: GraphNodeInternal) => {
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
      .cooldownTicks(200)
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
      .onNodeClick((node: any) => {
        handleNodeClick(node as GraphNodeInternal);
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

    // Set initial data if available
    const data = filteredDataRef.current;
    if (data.nodes.length > 0) {
      const colorMap = new Map<string, string>();
      for (const n of data.nodes) {
        colorMap.set(n.id, getNodeColorRef.current(n));
      }
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

    graph.graphData({
      nodes: filteredData.nodes.map(n => ({ ...n, _color: colorMap.get(n.id) })),
      links: filteredData.links.map(l => ({ ...l })),
    });

    setTimeout(() => {
      if (graphRef.current) graphRef.current.zoomToFit(400, 40);
    }, 600);
  }, [filteredData, getNodeColor]);

  // Effect 3: Update physics without recreating graph (slider changes preserve node positions)
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

    graph.d3ReheatSimulation();
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

      {/* Search bar */}
      <div className="graph-search-bar">
        <input
          type="text"
          className="graph-search-input"
          placeholder={t('graphSearchPlaceholder', language)}
          value={searchQuery}
          onChange={e => handleSearchNode(e.target.value)}
        />
      </div>

      {/* Settings toggle */}
      <button
        className="graph-settings-toggle"
        onClick={() => setShowSettings(!showSettings)}
        title={t('graphSettings', language)}
      >
        <Settings size={16} />
      </button>

      {/* Settings panel */}
      {showSettings && (
        <div className="graph-settings-panel">
          <div className="graph-settings-title">{t('graphSettings', language)}</div>

          <div className="graph-settings-section">
            <label className="graph-settings-label">
              <input
                type="checkbox"
                checked={graphSettings.showTags}
                onChange={e => updateSettings({ showTags: e.target.checked })}
              />
              {t('showTags', language)}
            </label>
            <label className="graph-settings-label">
              <input
                type="checkbox"
                checked={graphSettings.showAttachments}
                onChange={e => updateSettings({ showAttachments: e.target.checked })}
              />
              {t('showAttachments', language)}
            </label>
          </div>

          <div className="graph-settings-section">
            <div className="graph-settings-subtitle">{t('physics', language)}</div>
            <div className="graph-settings-slider-row">
              <span>{t('chargeStrength', language)}</span>
              <input
                type="range"
                min="-300"
                max="-10"
                value={graphSettings.physics.chargeStrength}
                onChange={e => updateSettings({ physics: { ...graphSettings.physics, chargeStrength: Number(e.target.value) } })}
              />
              <span className="graph-settings-slider-value">{graphSettings.physics.chargeStrength}</span>
            </div>
            <div className="graph-settings-slider-row">
              <span>{t('linkDistance', language)}</span>
              <input
                type="range"
                min="10"
                max="200"
                value={graphSettings.physics.linkDistance}
                onChange={e => updateSettings({ physics: { ...graphSettings.physics, linkDistance: Number(e.target.value) } })}
              />
              <span className="graph-settings-slider-value">{graphSettings.physics.linkDistance}</span>
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

      {/* Legend bar - shows note types present in current graph */}
      <div className="graph-legend-bar">
        {(() => {
          // Count folder notes separately
          const folderNoteCount = filteredData.nodes.filter(n => n.isFolderNote).length;
          // Count by noteType (lowercase), excluding folder notes
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
              <span key={type} className="graph-legend-item">
                <span
                  className="graph-legend-dot"
                  style={{ backgroundColor: NOTE_TYPE_COLORS[type] || graphSettings.nodeColors.note }}
                />
                {type.toUpperCase()} ({count})
              </span>
            ));
          // Prepend folder note legend
          if (folderNoteCount > 0) {
            items.unshift(
              <span key="__folder__" className="graph-legend-item">
                <span className="graph-legend-dot graph-legend-folder" style={{ backgroundColor: FOLDER_NOTE_COLOR }} />
                {tf('folderLabel', language, { count: folderNoteCount })}
              </span>
            );
          }
          return items;
        })()}
        {graphSettings.showTags && (
          <span className="graph-legend-item">
            <span className="graph-legend-dot graph-legend-diamond" style={{ backgroundColor: DEFAULT_TAG_COLOR }} />
            TAG ({filteredData.nodes.filter(n => n.nodeType === 'tag').length})
          </span>
        )}
      </div>

      {/* Info bar */}
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
