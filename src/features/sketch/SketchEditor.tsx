import { useRef, useState, useCallback, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { convertFileSrc } from '@tauri-apps/api/core';
import { utilCommands, noteCommands } from '../../core/services/tauriCommands';
import { hoverActions } from '../hover-windows/stores/hoverStore';
import { fileLookupActions } from '../../core/stores/fileLookupStore';
import { useSettingsStore } from '../../core/stores/settingsStore';
import { t } from '../../core/utils/i18n';
import { useSketchInteraction, getHandlePosition, getShapeAnchorPoint } from './useSketchInteraction';
import { MultiSelectPanel, NodePropsPanel, EdgePropsPanel, NodeContextMenu, MultiSelectContextMenu } from '../sketch/SketchPropertiesPanel';
import { SketchTextEditor } from './SketchTextEditor';
import { SketchWikiLinkSearch } from './SketchWikiLinkSearch';
import { startSketchFileDrag } from './sketchFileDragOut';
// v20.10 — useSketchHistory removed (was duplicating useSketchInteraction's
// own undo system, causing Ctrl+Z race).
import { copySelection, readClipboard, applyPaste } from './sketchClipboard';
import { useSlashAttachmentListener } from '../slash-command/useSlashAttachmentListener';
import { GripVertical, Loader2 } from 'lucide-react';
import katex from 'katex';
import type { SketchData, SketchSelection } from '../../core/types';
import {
  useAttachmentSyncStore,
  attachmentSyncActions,
} from '../sync_v2/stores/attachmentSyncStore';

/** Process TipTap HTML to render math nodes with KaTeX for display mode */
function renderMathInHtml(html: string): string {
  if (!html) return html;
  // Replace <span data-math-inline data-formula="...">$...$</span> with KaTeX rendered HTML
  return html
    .replace(/<span[^>]*data-math-inline[^>]*data-formula="([^"]*)"[^>]*>[^<]*<\/span>/g, (_match, formula) => {
      try {
        return katex.renderToString(formula, { throwOnError: false, displayMode: false });
      } catch { return `$${formula}$`; }
    })
    .replace(/<div[^>]*data-math-block[^>]*data-formula="([^"]*)"[^>]*>[^<]*<\/div>/g, (_match, formula) => {
      try {
        return `<div class="math-block-display">${katex.renderToString(formula, { throwOnError: false, displayMode: true })}</div>`;
      } catch { return `$$${formula}$$`; }
    });
}

interface SketchEditorProps {
  data: SketchData;
  onChange: (data: SketchData) => void;
  readOnly?: boolean;
  notePath?: string;
  onSelectionChange?: (selection: SketchSelection | null) => void;
}

function SketchEditor({ data, onChange, readOnly = false, notePath, onSelectionChange }: SketchEditorProps) {
  const openHoverFile = hoverActions.open;
  const theme = useSettingsStore((s) => s.theme);
  const language = useSettingsStore((s) => s.language);

  // R5 v4 (HanBin 2026-05-23) — sync indicator now lives in
  // attachmentSyncStore (global). Surviving hover-window close/reopen:
  // when the user closes a window mid-upload, the spinner state stays
  // alive at the app level and the same files still show as syncing
  // when the window is reopened. The sync-v2:report listener + 30 s
  // safety drain also live in the store (initialised once per process
  // via initAttachmentSyncSubscriptions in App.tsx / HoverWindowApp.tsx).
  const syncingFiles = useAttachmentSyncStore(s => s.syncingFiles);

  // 2026-05-24 (HanBin) — one-shot migration for sketches saved BEFORE
  // the WikiLinkSearch fix. The old WikiLinkSearch.onSelect created
  // `type: 'file'` nodes with `file: <absolute path>` for note refs,
  // which is the same shape as drag-in attachment nodes — leaking
  // notes into the AttachmentRef pipeline. This effect detects any
  // such `type: 'file'` node whose `file` extension is `.md` and the
  // basename matches an existing note, and rewrites it to a proper
  // `type: 'link'` + `url: <noteName>` node. Runs once per mount;
  // the per-vault deduplication is implicit (after migration, no
  // matching nodes remain).
  const migrationRanRef = useRef(false);
  useEffect(() => {
    if (migrationRanRef.current) return;
    if (readOnly) return;
    const offending = data.nodes.filter(n =>
      n.type === 'file'
      && typeof n.file === 'string'
      && /\.md$/i.test(n.file)
    );
    if (offending.length === 0) {
      migrationRanRef.current = true;
      return;
    }
    migrationRanRef.current = true;
    const updated = data.nodes.map(n => {
      if (
        n.type === 'file'
        && typeof n.file === 'string'
        && /\.md$/i.test(n.file)
      ) {
        const basename = n.file.split(/[/\\]/).pop() || n.file;
        const noteName = basename;
        console.log(
          '[SketchEditor] auto-migrating type:file .md → type:link',
          { id: n.id, oldFile: n.file, newUrl: noteName },
        );
        const { file: _omit, ...rest } = n;
        void _omit;
        return {
          ...rest,
          type: 'link' as const,
          url: noteName,
          text: n.text || noteName.replace(/\.md$/i, ''),
        };
      }
      return n;
    });
    onChange({ ...data, nodes: updated });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // run once on mount; data is read fresh inside

  // Seed the global store with files that appear AFTER mount (drag-in,
  // paste, picker, native drop). v20.8 — skip the initial render so
  // already-synced files don't get a spurious spinner.
  const previousFilePathsRef = useRef<Set<string>>(new Set());
  const hasSeededFilePathsRef = useRef(false);
  useEffect(() => {
    const currentSet = new Set<string>();
    for (const n of data.nodes) if (n.type === 'file' && n.file) currentSet.add(n.file);
    if (!hasSeededFilePathsRef.current) {
      previousFilePathsRef.current = currentSet;
      hasSeededFilePathsRef.current = true;
      return;
    }
    const prevSet = previousFilePathsRef.current;
    const newlyAdded: string[] = [];
    currentSet.forEach((p) => { if (!prevSet.has(p)) newlyAdded.push(p); });
    if (newlyAdded.length > 0) {
      attachmentSyncActions.markSyncing(newlyAdded);
    }
    previousFilePathsRef.current = currentSet;
  }, [data.nodes]);

  // Determine effective theme (considering system preference)
  const getEffectiveTheme = () => {
    if (theme === 'system') {
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    return theme;
  };
  const effectiveTheme = getEffectiveTheme();
  const defaultNodeColor = 'node-default';

  // Map legacy hardcoded hex colors → CSS variable keys
  const LEGACY_TO_KEY: Record<string, string> = {
    // Dark hex → key
    '#2d2d2d': 'node-default', '#1e3a5f': 'node-blue', '#1e4d2b': 'node-green',
    '#4d1e1e': 'node-red', '#3d1e4d': 'node-purple', '#4d3a1e': 'node-orange',
    '#2d4a2c': 'node-green', '#5f1e1e': 'node-red', '#3a1e5f': 'node-purple', '#5f3a1e': 'node-orange',
    // Light hex → key
    '#ffffff': 'node-default', '#dbeafe': 'node-blue', '#dcfce7': 'node-green',
    '#fee2e2': 'node-red', '#ede9fe': 'node-purple', '#fff7ed': 'node-orange',
  };
  const NODE_COLOR_KEYS = new Set(['node-default', 'node-blue', 'node-green', 'node-red', 'node-purple', 'node-orange']);

  // Resolve node color: returns CSS var() string for theme-adaptive colors
  const resolveNodeColor = (color: string | undefined): string => {
    const c = (color || 'node-default').toLowerCase();
    // Already a semantic key
    if (NODE_COLOR_KEYS.has(c)) return `var(--${c})`;
    // Legacy hex → key → CSS var
    const key = LEGACY_TO_KEY[c];
    if (key) return `var(--${key})`;
    // Unknown color: pass through as-is (user custom)
    return c;
  };

  // Use CSS variables for SVG strokes — inline SVG inherits CSS custom properties
  const blueColor = 'var(--c-blue)';
  const sepColor = 'var(--sep)';

  // Text color inherits from theme — node backgrounds are designed for readable text in each mode
  const nodeTextColor = effectiveTheme === 'light' ? 'var(--tx-1)' : 'var(--tx-1)';

  const sketchRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  // v20.10 (2026-05-17, HanBin) — removed the duplicate useSketchHistory
  // wrapper. `useSketchInteraction` already has a built-in undo/redo
  // system with its own Ctrl+Z/Y handler. Running both side-by-side
  // produced a race where pressing Ctrl+Z triggered BOTH systems and
  // they undid different things, causing the alternating toggle the
  // user reported. The interaction hook's history now has gesture
  // coalescing + unbounded depth so it covers the requirements alone.
  const [state, actions] = useSketchInteraction({ data, onChange, readOnly, notePath, sketchRef });

  // v20.5 (2026-05-16, HanBin) — track the active SketchTextEditor's
  // TipTap instance so we can wire `slash-attachment-requested` to the
  // sketch-specific spawn-as-node path. Reset when the user exits text
  // edit mode so the listener doesn't fire for stale references.
  const [activeTextEditor, setActiveTextEditor] = useState<{
    editor: import('@tiptap/core').Editor;
    fromNodeId: string;
  } | null>(null);

  // v20.6 (2026-05-16, HanBin) — arrow endpoint rewiring.
  // HanBin: "화살표 끝점을 다른 노드로 이동 기능 추가(시작지점이 아닌
  // 화살표의 끝점을 이동하면 시작지점은 유지되되, 끝점만 특정 점으로
  // 이동)". When a single edge is selected, render two draggable
  // handles at its endpoints. Dragging a handle enters "rewire" mode:
  // we track the cursor in world coords, draw a preview to the cursor
  // from the OTHER endpoint, and on mouseup-over-node remap the edge's
  // fromNode/fromSide OR toNode/toSide to that node.
  const [rewiringEdge, setRewiringEdge] = useState<{
    edgeId: string;
    end: 'from' | 'to';
  } | null>(null);
  const [rewirePreview, setRewirePreview] = useState<{ x: number; y: number } | null>(null);

  // v20.5 (2026-05-16, HanBin) — `//` in a sketch text node → add a new
  // FILE NODE on the canvas (not a wikilink inside the text).
  // HanBin: "스케치 노트의 첨부파일 // 명령어 구조는 달라야 함... 노드로
  // 첨부파일이 추가됨." Resolves the attachment's on-disk path via
  // syncV2Commands, then spawns a file node adjacent to the text node
  // that fired the `//`. Calls parent onChange directly — useSketchInteraction's
  // data-watching effect will record this in its own undo history.
  const dataRefLatest = useRef(data);
  dataRefLatest.current = data;
  const handleAttachmentPickAsNode = useCallback(async ({
    attachment, fromNodeId,
  }: {
    attachment: import('../suggestions/attachmentSuggestion').AttachmentResult;
    fromNodeId: string;
  }) => {
    try {
      const { syncV2Commands } = await import('../sync_v2/syncV2Commands');
      const localPath = await syncV2Commands.attachmentLocalPath(attachment.attachmentId);
      if (!localPath) {
        console.warn('[SketchEditor] attachmentLocalPath returned empty for', attachment);
        return;
      }
      const currentData = dataRefLatest.current;
      const sourceNode = currentData.nodes.find(n => n.id === fromNodeId);
      // Spawn 24px to the right of the source node's right edge,
      // aligned to its vertical center (within 200x180 default size).
      const isImage = attachment.kind === 'image';
      // v20.14 — unified with text-node default (200×100) per HanBin.
      const width = 200;
      const height = isImage ? 150 : 100;
      const spawnX = sourceNode ? sourceNode.x + sourceNode.width + 24 : 80;
      const spawnY = sourceNode ? sourceNode.y : 80;
      const { generateId } = await import('./sketchHelpers');
      const newNode = {
        id: generateId('node'),
        type: 'file' as const,
        x: spawnX,
        y: spawnY,
        width,
        height,
        file: localPath,
        text: attachment.fileName,
      };
      onChange({ ...currentData, nodes: [...currentData.nodes, newNode] });
    } catch (err) {
      console.error('[SketchEditor] failed to add attachment node:', err);
    }
  }, [onChange]);

  // v20.6 (2026-05-16, HanBin) — document mouse handlers for arrow rewire.
  // Run only while `rewiringEdge` is set. mousemove → update preview;
  // mouseup → resolve the drop: if released over a node, remap the edge
  // end to that node + best-side. Otherwise cancel.
  //
  // v20.6 hotfix — read viewport offset/scale through a ref-mirrored
  // snapshot instead of the destructured `state` locals. The previous
  // form referenced `viewportOffset` / `viewportScale` in the deps array
  // BEFORE those locals existed (their destructure happens further down
  // in the component body), triggering a TDZ ReferenceError on first
  // render. Reading via a ref is TDZ-free and also avoids re-installing
  // the document listeners on every pan/zoom tick.
  const viewportRef = useRef({ ox: 0, oy: 0, scale: 1 });
  viewportRef.current = {
    ox: state.viewportOffset.x,
    oy: state.viewportOffset.y,
    scale: state.viewportScale,
  };
  useEffect(() => {
    if (!rewiringEdge || !sketchRef.current) return;
    const sketchEl = sketchRef.current;
    const onMove = (e: MouseEvent) => {
      const rect = sketchEl.getBoundingClientRect();
      const { ox, oy, scale } = viewportRef.current;
      const x = (e.clientX - rect.left - ox) / scale;
      const y = (e.clientY - rect.top - oy) / scale;
      setRewirePreview({ x, y });
    };
    const onUp = (e: MouseEvent) => {
      // Find which node the cursor is over (DOM walk for accuracy).
      const target = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
      const nodeEl = target?.closest('.sketch-node[data-node-id]') as HTMLElement | null;
      const droppedNodeId = nodeEl?.dataset.nodeId || null;
      if (droppedNodeId) {
        const dropNode = dataRefLatest.current.nodes.find(n => n.id === droppedNodeId);
        const edge = dataRefLatest.current.edges?.find(eg => eg.id === rewiringEdge.edgeId);
        if (dropNode && edge) {
          // Pick the side closest to the cursor — same logic as initial
          // connect: top/right/bottom/left based on cursor offset within
          // node bounding box.
          const rect = sketchEl.getBoundingClientRect();
          const { ox, oy, scale } = viewportRef.current;
          const cx = (e.clientX - rect.left - ox) / scale;
          const cy = (e.clientY - rect.top - oy) / scale;
          const localX = cx - dropNode.x;
          const localY = cy - dropNode.y;
          const distLeft   = localX;
          const distRight  = dropNode.width - localX;
          const distTop    = localY;
          const distBottom = dropNode.height - localY;
          const minDist = Math.min(distLeft, distRight, distTop, distBottom);
          const newSide: 'top' | 'right' | 'bottom' | 'left' =
            minDist === distTop ? 'top' :
            minDist === distBottom ? 'bottom' :
            minDist === distLeft ? 'left' : 'right';
          const nextEdge = rewiringEdge.end === 'from'
            ? { ...edge, fromNode: droppedNodeId, fromSide: newSide }
            : { ...edge, toNode: droppedNodeId, toSide: newSide };
          // Skip if it'd create a self-loop (from === to). Self-loops
          // render as a degenerate point; not useful here.
          const valid = nextEdge.fromNode !== nextEdge.toNode;
          if (valid) {
            const currentData = dataRefLatest.current;
            const nextData = {
              ...currentData,
              edges: (currentData.edges || []).map(eg => eg.id === edge.id ? nextEdge : eg),
            };
            onChange(nextData);
          }
        }
      }
      setRewiringEdge(null);
      setRewirePreview(null);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, [rewiringEdge, onChange]);

  // v20.5 (2026-05-16, HanBin) — `/` slash → 첨부파일 in a sketch text node
  // routes through useSlashAttachmentListener with a sketch-specific
  // override. The override receives each picked file's basename + source
  // path, places a placeholder file node at a sensible offset, and lets
  // the listener's background CAS-upload path run unchanged. Once the
  // CAS upload settles, the local _att/ copy mtime'd into place is the
  // same path we placed in node.file, so the node renders correctly.
  useSlashAttachmentListener(
    activeTextEditor?.editor || null,
    notePath || null,
    {
      insertOne: ({ basename, sourcePath }) => {
        const currentData = dataRefLatest.current;
        const sourceNode = activeTextEditor
          ? currentData.nodes.find(n => n.id === activeTextEditor.fromNodeId)
          : null;
        const isImage = /\.(png|jpg|jpeg|gif|webp|svg|bmp|ico)$/i.test(basename);
        const width = isImage ? 250 : 240;
        const height = isImage ? 200 : 160;
        // Stack vertically so multi-pick doesn't stack on top of each
        // other; use the doc's existing node count as a rough offset.
        const stackOffset = currentData.nodes.length * 8;
        const spawnX = sourceNode ? sourceNode.x + sourceNode.width + 24 : 80 + stackOffset;
        const spawnY = sourceNode ? sourceNode.y + stackOffset : 80 + stackOffset;
        // Compute the eventual local path the listener's background
        // import will write to: `${noteDir}/${noteStem}_att/${basename}`.
        // This MUST match `import_attachment` on the Rust side.
        const noteForPath = notePath || '';
        const noteDir = noteForPath.replace(/[/\\][^/\\]+$/, '');
        const noteStem = (noteForPath.split(/[/\\]/).pop() || '').replace(/\.md$/, '');
        const expectedLocal = noteDir && noteStem
          ? `${noteDir}\\${noteStem}_att\\${basename}`
          : sourcePath; // Fallback to the OS source path if we can't compute.
        const newNode = {
          id: `node-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          type: 'file' as const,
          x: spawnX,
          y: spawnY,
          width,
          height,
          file: expectedLocal,
          text: basename,
        };
        onChange({ ...currentData, nodes: [...currentData.nodes, newNode] });
      },
    },
  );

  const {
    selectedNode, selectedEdge, selectedNodes, selectedEdges,
    draggingNode, isPanning, isSelecting, resizingNode, editingNode,
    connectingFrom, connectionPreview, hoveredNode, isDragOver,
    selectionBox, viewportOffset, viewportScale, contextMenu, sketchContextMenu, multiSelectContextMenu, propsExpanded,
  } = state;

  const {
    setSelectedNode, setSelectedEdge, setSelectedNodes, setSelectedEdges,
    setEditingNode, setHoveredNode, setViewportScale, setViewportOffset, setPropsExpanded,
    handleNodeMouseDown, handleConnectionStart, handleResizeStart,
    handleSketchMouseDown, handleSketchDoubleClick, handleEdgeClick,
    handleDragOver, handleDragLeave, handleDrop,
    deleteNode, deleteEdge, updateNodeText, updateNodeProperties,
    updateEdgeProperties, handleNodeDoubleClick, handleNodeContextMenu,
    closeContextMenu, handleSketchContextMenu, closeSketchContextMenu, closeMultiSelectContextMenu,
    addTextNode, addGroupNode, getEdgePath, getConnectionPreviewPath,
    renderNodeText, setSketchRef,
  } = actions;

  // Wiki link search state
  const [wikiLinkSearch, setWikiLinkSearch] = useState<{ active: boolean }>({ active: false });
  const bracketBuffer = useRef<{ key: string; time: number } | null>(null);

  // v20.20 (2026-05-17, HanBin) — canvas-wide text search (Ctrl+F).
  // HanBin requested in-canvas search alongside the design polish work
  // ("검색 기능"). Lightweight UI: a small input overlays the top-right
  // of the viewport, matches are highlighted with a CSS class, Enter /
  // Shift+Enter cycle through matches, and the viewport pan-centers on
  // the current match so it's always visible at the current zoom level.
  // Search lives in React state only — never touches `data` / undo history.
  const [canvasSearch, setCanvasSearch] = useState<{
    active: boolean;
    query: string;
    matchIndex: number;
  }>({ active: false, query: '', matchIndex: 0 });
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  // Strip HTML tags + collapse whitespace so node `text` from TipTap
  // (which can be `<p>foo <strong>bar</strong></p>`) matches on the
  // user-visible text rather than the tag soup.
  const matchNodeText = useCallback((node: typeof data.nodes[0], query: string): boolean => {
    if (!query) return false;
    const raw = node.text || '';
    // Quick exit for plain text (file/group nodes).
    if (!raw.includes('<')) {
      return raw.toLowerCase().includes(query);
    }
    const stripped = raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
    return stripped.includes(query);
  }, []);

  const searchMatches = useMemo(() => {
    if (!canvasSearch.active || !canvasSearch.query.trim()) return [] as string[];
    const q = canvasSearch.query.trim().toLowerCase();
    return data.nodes.filter(n => matchNodeText(n, q)).map(n => n.id);
  }, [canvasSearch.active, canvasSearch.query, data.nodes, matchNodeText]);

  // Clamp matchIndex when the match list changes (query edits / nodes
  // mutate). If we're past the end, wrap to 0.
  useEffect(() => {
    if (canvasSearch.active && searchMatches.length > 0 && canvasSearch.matchIndex >= searchMatches.length) {
      setCanvasSearch(s => ({ ...s, matchIndex: 0 }));
    }
  }, [canvasSearch.active, canvasSearch.matchIndex, searchMatches.length]);

  // Pan-center the viewport on the current match whenever it changes.
  // Read viewport SIZE from the sketchRef's bounding rect; compute the
  // offset that puts the node center at the screen center at the current
  // zoom level. Don't touch zoom — user can keep their preferred scale.
  const currentMatchId = canvasSearch.active && searchMatches.length > 0
    ? searchMatches[Math.min(canvasSearch.matchIndex, searchMatches.length - 1)]
    : null;

  useEffect(() => {
    if (!currentMatchId || !sketchRef.current) return;
    const node = data.nodes.find(n => n.id === currentMatchId);
    if (!node) return;
    const rect = sketchRef.current.getBoundingClientRect();
    const cx = node.x + node.width / 2;
    const cy = node.y + node.height / 2;
    const targetOx = rect.width / 2 - cx * state.viewportScale;
    const targetOy = rect.height / 2 - cy * state.viewportScale;
    setViewportOffset({ x: targetOx, y: targetOy });
    // Intentionally ignore viewportScale changes — only re-pan when the
    // match itself changes. If the user zooms while in search mode, the
    // pan will catch up on next match cycle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentMatchId]);

  // Ctrl+F to open, Escape to close, Enter / Shift+Enter to cycle.
  // The handler is permissive: if the user is editing a node's text
  // (or any other input/contentEditable owns focus), we let the keystroke
  // pass through so the inner editor or browser default handles it.
  // Otherwise — including when no specific element has focus, which is
  // the normal case while the user is panning the canvas — we open the
  // canvas search bar.
  useEffect(() => {
    if (readOnly) return;
    const handler = (e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey;
      if (!ctrl) return;
      if (e.key !== 'f' && e.key !== 'F') return;
      // Bail if a node is being text-edited — TipTap inside the node
      // owns Ctrl+F semantics within that editor (and its own undo).
      if (editingNode) return;
      // Bail if focus is inside another contenteditable / input / textarea
      // that isn't ours (e.g. a wiki-link search popup, modal, etc.).
      const active = document.activeElement as HTMLElement | null;
      if (active) {
        const tag = active.tagName;
        const isFormField = tag === 'INPUT' || tag === 'TEXTAREA' || active.isContentEditable;
        // Our own search input is fine — let the user re-trigger Ctrl+F
        // to re-focus it (then we just focus + select).
        const isOurSearchInput = active === searchInputRef.current;
        if (isFormField && !isOurSearchInput) return;
      }
      e.preventDefault();
      setCanvasSearch(s => ({ active: true, query: s.query, matchIndex: s.matchIndex }));
      requestAnimationFrame(() => {
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      });
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [readOnly, editingNode]);

  // Register sketch-level [[ listener for wiki link search
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (readOnly || editingNode) return;
      if (e.key === '[') {
        const now = Date.now();
        if (bracketBuffer.current && bracketBuffer.current.key === '[' && now - bracketBuffer.current.time < 300) {
          e.preventDefault();
          setWikiLinkSearch({ active: true });
          bracketBuffer.current = null;
        } else {
          bracketBuffer.current = { key: '[', time: now };
        }
      } else {
        bracketBuffer.current = null;
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [readOnly, editingNode]);

  // v20.4 (2026-05-16, HanBin) — document-editing shortcuts (Excalidraw /
  // Obsidian Canvas conventions):
  //   Ctrl+Z         undo
  //   Ctrl+Shift+Z   redo (also Ctrl+Y for Windows muscle memory)
  //   Ctrl+C         copy selected nodes + edges
  //   Ctrl+X         cut (= copy + delete)
  //   Ctrl+V         paste (offset by +24/+24, new ids, new selection)
  //   Ctrl+A         select all nodes
  //   Delete/Backsp  delete selected (canvas-level; node-text Backspace
  //                  is suppressed by editingNode guard above)
  // Skipped when readOnly OR a sketch-node text editor has focus.
  useEffect(() => {
    if (readOnly) return;
    const isCanvasFocused = (target: EventTarget | null): boolean => {
      if (!(target instanceof HTMLElement)) return true;
      // Text editor inside a node owns its own copy/paste — bail out.
      const tag = target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return false;
      if (target.isContentEditable) return false;
      if (target.closest('[contenteditable="true"], .ProseMirror, input, textarea')) return false;
      return true;
    };
    const handler = (e: KeyboardEvent) => {
      if (editingNode) return;
      if (!isCanvasFocused(e.target)) return;
      const ctrl = e.ctrlKey || e.metaKey;

      // v20.10 (2026-05-17, HanBin) — Ctrl+Z / Ctrl+Y handled by
      // useSketchInteraction's built-in keyboard listener (line ~1039).
      // Removed from here so the two handlers don't race.

      // Copy / Cut / Paste
      if (ctrl && (e.key === 'c' || e.key === 'C')) {
        if (selectedNodes.length === 0 && selectedEdges.length === 0 && !selectedNode && !selectedEdge) return;
        e.preventDefault();
        const nodeIds = selectedNodes.length > 0
          ? selectedNodes
          : (selectedNode ? [selectedNode] : []);
        const edgeIds = selectedEdges.length > 0
          ? selectedEdges
          : (selectedEdge ? [selectedEdge] : []);
        copySelection(data, nodeIds, edgeIds);
        return;
      }
      if (ctrl && (e.key === 'x' || e.key === 'X')) {
        if (selectedNodes.length === 0 && !selectedNode) return;
        e.preventDefault();
        const nodeIds = selectedNodes.length > 0
          ? selectedNodes
          : (selectedNode ? [selectedNode] : []);
        const edgeIds = selectedEdges.length > 0
          ? selectedEdges
          : (selectedEdge ? [selectedEdge] : []);
        copySelection(data, nodeIds, edgeIds);
        // Now delete the cut nodes/edges. useSketchInteraction's data-watch
        // effect records this in its undo history automatically.
        const nodeIdSet = new Set(nodeIds);
        const edgeIdSet = new Set(edgeIds);
        const nextData: SketchData = {
          ...data,
          nodes: data.nodes.filter(n => !nodeIdSet.has(n.id)),
          edges: (data.edges || []).filter(eg =>
            !edgeIdSet.has(eg.id) && !nodeIdSet.has(eg.fromNode) && !nodeIdSet.has(eg.toNode)
          ),
        };
        onChange(nextData);
        setSelectedNode(null);
        setSelectedEdge(null);
        setSelectedNodes([]);
        setSelectedEdges([]);
        return;
      }
      if (ctrl && (e.key === 'v' || e.key === 'V')) {
        e.preventDefault();
        void readClipboard().then(payload => {
          if (!payload) return;
          const result = applyPaste(data, payload);
          onChange(result.data);
          setSelectedNodes(result.newNodeIds);
          setSelectedEdges(result.newEdgeIds);
          setSelectedNode(null);
          setSelectedEdge(null);
        });
        return;
      }

      // Select all
      if (ctrl && (e.key === 'a' || e.key === 'A')) {
        e.preventDefault();
        setSelectedNodes(data.nodes.map(n => n.id));
        setSelectedEdges((data.edges || []).map(eg => eg.id));
        setSelectedNode(null);
        setSelectedEdge(null);
        return;
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [
    readOnly, editingNode, data, onChange,
    selectedNode, selectedEdge, selectedNodes, selectedEdges,
    setSelectedNode, setSelectedEdge, setSelectedNodes, setSelectedEdges,
  ]);

  return (
    <div className="sketch-editor">
      {!readOnly && (
        <div className="sketch-toolbar">
          <div className="sketch-toolbar-hint">Double-click to add node</div>
          {canvasSearch.active && (
            <div className="sketch-search-bar" onMouseDown={e => e.stopPropagation()}>
              <svg className="sketch-search-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                <circle cx="7" cy="7" r="5" />
                <path d="M11 11l3 3" />
              </svg>
              <input
                ref={searchInputRef}
                className="sketch-search-input"
                placeholder={t('sketchSearchPlaceholder', language)}
                value={canvasSearch.query}
                onChange={e => setCanvasSearch(s => ({ ...s, query: e.target.value, matchIndex: 0 }))}
                onKeyDown={e => {
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    setCanvasSearch({ active: false, query: '', matchIndex: 0 });
                    return;
                  }
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    if (searchMatches.length === 0) return;
                    const dir = e.shiftKey ? -1 : 1;
                    setCanvasSearch(s => ({
                      ...s,
                      matchIndex: (s.matchIndex + dir + searchMatches.length) % searchMatches.length,
                    }));
                  }
                }}
              />
              <span className="sketch-search-count">
                {canvasSearch.query.trim().length === 0
                  ? ''
                  : searchMatches.length === 0
                    ? t('sketchSearchNoMatch', language)
                    : `${canvasSearch.matchIndex + 1} / ${searchMatches.length}`}
              </span>
              <button
                className="sketch-search-nav"
                disabled={searchMatches.length === 0}
                onClick={() => setCanvasSearch(s => ({
                  ...s,
                  matchIndex: (s.matchIndex - 1 + searchMatches.length) % Math.max(searchMatches.length, 1),
                }))}
                title={t('sketchSearchPrev', language)}
              >
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M4 10l4-4 4 4" />
                </svg>
              </button>
              <button
                className="sketch-search-nav"
                disabled={searchMatches.length === 0}
                onClick={() => setCanvasSearch(s => ({
                  ...s,
                  matchIndex: (s.matchIndex + 1) % Math.max(searchMatches.length, 1),
                }))}
                title={t('sketchSearchNext', language)}
              >
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M4 6l4 4 4-4" />
                </svg>
              </button>
              <button
                className="sketch-search-close"
                onClick={() => setCanvasSearch({ active: false, query: '', matchIndex: 0 })}
                title={t('sketchSearchClose', language)}
              >
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M4 4l8 8M12 4l-8 8" />
                </svg>
              </button>
            </div>
          )}
          <button className="sketch-toolbar-btn" onClick={() => setViewportScale(1)} title={t('sketchResetZoom', language)}>
            {Math.round(viewportScale * 100)}%
          </button>
        </div>
      )}

      <div
        ref={setSketchRef}
        className={`sketch-viewport${isDragOver ? ' drag-over' : ''}${draggingNode || isPanning || isSelecting || resizingNode ? ' is-dragging' : ''}${isPanning ? ' is-panning' : ''}${isSelecting ? ' is-selecting' : ''}${connectingFrom ? ' is-connecting' : ''}`}
        data-drop-target={`sketch-editor-${notePath || 'unknown'}`}
        onMouseDown={handleSketchMouseDown}
        onDoubleClick={handleSketchDoubleClick}
        onContextMenu={handleSketchContextMenu}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <div
          className="sketch-nodes"
          style={{
            transform: `translate(${viewportOffset.x}px, ${viewportOffset.y}px) scale(${viewportScale})`,
            transformOrigin: '0 0',
          }}
        >
          {/* Sort: group nodes first (render behind), then regular nodes */}
          {[...data.nodes].sort((a, b) => {
            const aIsGroup = a.type === 'group' || a.isGroup ? 0 : 1;
            const bIsGroup = b.type === 'group' || b.isGroup ? 0 : 1;
            return aIsGroup - bIsGroup;
          }).map(node => (
            <div
              key={node.id}
              data-node-id={node.id}
              className={`sketch-node${node.type === 'file' ? ' file-node' : ''}${(node.type === 'group' || node.isGroup) ? ' group-node' : ''}${selectedNode === node.id ? ' selected' : ''}${selectedNodes.includes(node.id) ? ' multi-selected' : ''}${editingNode === node.id ? ' editing' : ''}${connectingFrom?.nodeId === node.id ? ' connecting' : ''}${hoveredNode === node.id ? ' hovered' : ''}${node.shape ? ` shape-${node.shape}` : ' shape-process'}${searchMatches.includes(node.id) ? ' search-match' : ''}${currentMatchId === node.id ? ' search-match-current' : ''}`}
              style={{
                left: node.x,
                top: node.y,
                width: node.width,
                height: node.height,
                backgroundColor: (node.type === 'group' || node.isGroup)
                  // v20.16 — group fill = user color at 18% alpha if set,
                  // else theme-aware default (--sketch-group-fill).
                  ? (node.color ? `${node.color}18` : 'var(--sketch-group-fill)')
                  : (node.shape === 'decision' || node.shape === 'io' || node.shape === 'database') ? 'transparent' : resolveNodeColor(node.color),
                color: nodeTextColor,
                // v20.17 (2026-05-17, HanBin) — `--node-border-color` CSS var.
                // Subroutine's side bars (::before / ::after pseudo-elements)
                // can't read inline `borderColor`, so we expose the user's
                // border color through a CSS custom property and the CSS
                // reads `var(--node-border-color, var(--sep))`. Other CSS-
                // bordered shapes (rectangle / file / text) keep using
                // the inline `borderColor` shorthand.
                ['--node-border-color' as never]: node.borderColor || 'var(--sep)',
                ...(node.type === 'group' || node.isGroup ? {
                  // v20.16 — group border: explicit borderColor wins,
                  // else node.color, else theme default.
                  borderColor: node.borderColor || node.color || 'var(--sketch-group-border)',
                  borderWidth: 2,
                  borderStyle: 'solid',
                } : node.borderColor ? {
                  // v20.12 (2026-05-17, HanBin) — user-set border color for
                  // CSS-bordered (rectangle / file / text) nodes. Overrides
                  // the default --sep theme variable. SVG-rendered shapes
                  // (decision / io / database / parallelogram) are tinted
                  // by passing borderColor into getStrokeColor — see below.
                  borderColor: node.borderColor,
                } : {}),
              }}
              onMouseDown={e => handleNodeMouseDown(e, node.id)}
              onContextMenu={e => handleNodeContextMenu(e, node.id)}
              onMouseEnter={() => setHoveredNode(node.id)}
              onMouseLeave={(e) => {
                const relatedTarget = e.relatedTarget as HTMLElement | null;
                if (!relatedTarget || !e.currentTarget.contains(relatedTarget)) {
                  setHoveredNode(null);
                }
              }}
              onDoubleClick={e => {
                if (node.type === 'text' || (node.type !== 'file' && node.type !== 'link' && node.type !== 'group')) {
                  handleNodeDoubleClick(e, node.id);
                }
              }}
            >
              {/* SVG background for special shapes */}
              {(node.shape === 'decision' || node.shape === 'io' || node.shape === 'database') && (() => {
                const w = node.width;
                const h = node.height;
                const isSelected = selectedNode === node.id || selectedNodes.includes(node.id);
                const isHovered = hoveredNode === node.id;
                const strokeWidth = 1.5;
                const inset = strokeWidth / 2;

                const decisionPoints = `${w / 2},${inset} ${w - inset},${h / 2} ${w / 2},${h - inset} ${inset},${h / 2}`;
                const ioPoints = `${w * 0.15 + inset},${inset} ${w - inset},${inset} ${w * 0.85 - inset},${h - inset} ${inset},${h - inset}`;

                // v20.12 (2026-05-17, HanBin) — user-set border color wins
                // over the default sep/blue except during active interaction
                // (connecting/selecting/hovering) where we still show the
                // accent so the affordance is visible. Reading order:
                //   1) interaction state (connecting / selected / hovered)
                //      → blueColor for visual feedback
                //   2) user's borderColor if set
                //   3) sep theme fallback
                const getStrokeColor = () =>
                  (connectingFrom?.nodeId === node.id || isSelected || isHovered)
                    ? blueColor
                    : (node.borderColor || sepColor);

                return (
                  <>
                    {/* Visual SVG (background, non-interactive) */}
                    <svg
                      className="sketch-node-shape-svg"
                      viewBox={`0 0 ${w} ${h}`}
                      preserveAspectRatio="none"
                      style={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        width: w,
                        height: h,
                        pointerEvents: 'none',
                        zIndex: -1,
                        overflow: 'visible',
                      }}
                    >
                      {node.shape === 'decision' ? (
                        <polygon
                          points={decisionPoints}
                          fill={resolveNodeColor(node.color)}
                          stroke={getStrokeColor()}
                          strokeWidth={strokeWidth}
                        />
                      ) : node.shape === 'io' ? (
                        <polygon
                          points={ioPoints}
                          fill={resolveNodeColor(node.color)}
                          stroke={getStrokeColor()}
                          strokeWidth={strokeWidth}
                        />
                      ) : (
                        // Database shape (cylinder)
                        <g>
                          {/* Body fill */}
                          <rect
                            x={inset}
                            y={16}
                            width={w - inset * 2}
                            height={h - 32}
                            fill={resolveNodeColor(node.color)}
                          />
                          {/* Left side */}
                          <path
                            d={`M ${inset} 16 L ${inset} ${h - 16}`}
                            fill="none"
                            stroke={getStrokeColor()}
                            strokeWidth={strokeWidth}
                          />
                          {/* Right side */}
                          <path
                            d={`M ${w - inset} 16 L ${w - inset} ${h - 16}`}
                            fill="none"
                            stroke={getStrokeColor()}
                            strokeWidth={strokeWidth}
                          />
                          {/* Top ellipse */}
                          <ellipse
                            cx={w / 2}
                            cy={16}
                            rx={w / 2 - inset}
                            ry={16 - inset}
                            fill={resolveNodeColor(node.color)}
                            stroke={getStrokeColor()}
                            strokeWidth={strokeWidth}
                          />
                          {/* Bottom ellipse */}
                          <ellipse
                            cx={w / 2}
                            cy={h - 16}
                            rx={w / 2 - inset}
                            ry={16 - inset}
                            fill={resolveNodeColor(node.color)}
                            stroke={getStrokeColor()}
                            strokeWidth={strokeWidth}
                          />
                        </g>
                      )}
                    </svg>
                    {/* Interactive hit area overlay for shape border (allows dragging from border) */}
                    {(node.shape === 'decision' || node.shape === 'io' || node.shape === 'database') && (
                      <svg
                        className="sketch-node-shape-hit-area"
                        viewBox={`0 0 ${w} ${h}`}
                        preserveAspectRatio="none"
                        style={{
                          position: 'absolute',
                          top: 0,
                          left: 0,
                          width: w,
                          height: h,
                          zIndex: 100,
                          overflow: 'visible',
                          pointerEvents: 'none',
                        }}
                      >
                        {/* Stroke area - wider hit area for border dragging */}
                        {node.shape === 'database' ? (
                          <g
                            style={{ pointerEvents: 'stroke', cursor: 'move' }}
                            onMouseEnter={() => setHoveredNode(node.id)}
                            onMouseLeave={() => setHoveredNode(null)}
                          >
                            {/* Cylinder body hit area */}
                            <rect
                              x={0}
                              y={16}
                              width={w}
                              height={h - 32}
                              fill="none"
                              stroke="transparent"
                              strokeWidth={20}
                            />
                            {/* Top ellipse hit area */}
                            <ellipse
                              cx={w / 2}
                              cy={16}
                              rx={w / 2}
                              ry={16}
                              fill="none"
                              stroke="transparent"
                              strokeWidth={20}
                            />
                            {/* Bottom ellipse hit area */}
                            <ellipse
                              cx={w / 2}
                              cy={h - 16}
                              rx={w / 2}
                              ry={16}
                              fill="none"
                              stroke="transparent"
                              strokeWidth={20}
                            />
                          </g>
                        ) : (
                          <polygon
                            points={node.shape === 'decision' ? decisionPoints : ioPoints}
                            fill="none"
                            stroke="transparent"
                            strokeWidth={20}
                            style={{ pointerEvents: 'stroke', cursor: 'move' }}
                            onMouseEnter={() => setHoveredNode(node.id)}
                            onMouseLeave={() => setHoveredNode(null)}
                          />
                        )}
                      </svg>
                    )}
                  </>
                );
              })()}
              {/* Group node label */}
              {(node.type === 'group' || node.isGroup) && (
                <div
                  className="sketch-group-label"
                  onDoubleClick={e => {
                    e.stopPropagation();
                    setEditingNode(node.id);
                  }}
                >
                  {editingNode === node.id ? (
                    <input
                      className="sketch-group-label-input"
                      value={node.groupLabel || ''}
                      onChange={e => updateNodeProperties(node.id, { groupLabel: e.target.value })}
                      onKeyDown={e => { if (e.key === 'Escape' || e.key === 'Enter') setEditingNode(null); }}
                      onBlur={() => setEditingNode(null)}
                      onMouseDown={e => e.stopPropagation()}
                      autoFocus
                    />
                  ) : (
                    <span>{node.groupLabel || 'Group'}</span>
                  )}
                </div>
              )}
              {node.type === 'text' && editingNode === node.id ? (
                <SketchTextEditor
                  node={node}
                  onUpdate={updateNodeText}
                  onExit={() => {
                    setEditingNode(null);
                    setActiveTextEditor(null);
                  }}
                  readOnly={readOnly}
                  textAlign={node.textAlign}
                  notePath={notePath}
                  onAttachmentPickAsNode={handleAttachmentPickAsNode}
                  onReady={({ editor: ed, fromNodeId }) => setActiveTextEditor({ editor: ed, fromNodeId })}
                />
              ) : node.type === 'text' && (
                <div
                  className={`sketch-node-text-display${node.textAlign === 'center' ? ' text-center' : ''}`}
                  onMouseEnter={() => setHoveredNode(node.id)}
                  onContextMenu={e => handleNodeContextMenu(e, node.id)}
                  onDoubleClick={e => handleNodeDoubleClick(e, node.id)}
                  onClick={e => {
                    const target = e.target as HTMLElement;
                    // Handle wiki link clicks
                    if (target.closest('[data-wiki-link]')) {
                      const wikiEl = target.closest('[data-wiki-link]') as HTMLElement;
                      const linkName = wikiEl.getAttribute('data-wiki-link');
                      if (linkName) {
                        e.stopPropagation();
                        openHoverFile(linkName);
                      }
                    }
                    // Legacy sketch wikilink format
                    if (target.classList.contains('sketch-wikilink') && target.dataset.wikilink) {
                      e.stopPropagation();
                      openHoverFile(target.dataset.wikilink);
                    }
                  }}
                  dangerouslySetInnerHTML={{ __html: renderMathInHtml(node.text || '') || `<p class="sketch-placeholder">${t('sketchEnterContent', language)}</p>` }}
                />
              )}
              {/* 2026-05-24 (HanBin) — note-link node rendering. Visually
                  distinct from file attachments: yellow note icon + just
                  the note name (no extension badge), and uses wiki-link
                  resolution to find the actual .md on double-click. No
                  drag-out handle (link nodes can't be exported as files
                  — they're references, not bytes). */}
              {node.type === 'link' && node.url && (
                <div
                  className="sketch-node-file sketch-node-link"
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    // Resolve the note name to an absolute path via the
                    // file-lookup store, then open via the existing
                    // hover-window pipeline. Falls back to opening by
                    // raw name if the lookup misses (broken note ref).
                    const resolved = fileLookupActions.resolveNotePath(node.url!)
                      ?? node.url!;
                    openHoverFile(resolved);
                  }}
                  style={{ cursor: 'pointer' }}
                  title={node.url}
                >
                  <div className="sketch-node-file-icon sketch-node-note-icon">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
                      <polyline points="14 2 14 8 20 8" />
                      <line x1="8" y1="13" x2="16" y2="13" />
                      <line x1="8" y1="17" x2="13" y2="17" />
                    </svg>
                  </div>
                  <div className="sketch-node-file-name">
                    {node.text || node.url.replace(/\.md$/i, '')}
                  </div>
                </div>
              )}
              {node.type === 'file' && node.file && (
                <div
                  className="sketch-node-file"
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    const isPreviewable = /\.(md|pdf|png|jpg|jpeg|gif|webp|svg|bmp|ico|json|py|js|ts|jsx|tsx|css|html|xml|yaml|yml|toml|rs|go|java|c|cpp|h|hpp|cs|rb|php|sh|bash|sql|lua|r|swift|kt|scala|csv|doc|docx|ppt|pptx|xls|xlsx|hwp|hwpx)$/i.test(node.file!);

                    if (isPreviewable) {
                      openHoverFile(node.file!);
                    } else {
                      utilCommands.openInDefaultApp(node.file!);
                    }
                  }}
                  style={{ cursor: 'pointer' }}
                >
                  {(() => {
                    const fileName = node.file.split(/[/\\]/).pop() || '';
                    const ext = node.file.split('.').pop()?.toLowerCase() || '';
                    const imageExts = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp'];
                    if (imageExts.includes(ext)) {
                      return (
                        <div className="sketch-node-file-preview">
                          <img
                            src={convertFileSrc(node.file)}
                            alt={fileName}
                            onError={(e) => {
                              const img = e.currentTarget;
                              img.style.display = 'none';
                              const fallback = img.parentElement?.querySelector('.sketch-node-file-fallback') as HTMLElement;
                              if (fallback) fallback.style.display = 'flex';
                            }}
                          />
                          <div className="sketch-node-file-fallback" style={{ display: 'none', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--tx-3)', fontSize: 12 }}>
                            {t('sketchFileMissing', language) || '파일 없음'}
                          </div>
                          <div className="sketch-node-file-ext-badge">{ext.toUpperCase()}</div>
                        </div>
                      );
                    }
                    if (ext === 'md') {
                      return (
                        <div className="sketch-node-file-icon sketch-node-note-icon">
                          {/* v20.5 (2026-05-16, HanBin) — icons reduced from
                              48→28px so file/text size ratio matches the
                              filename label. HanBin: "아이콘이나 글자가
                              과도하게 크고 일관성 부족". */}
                          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
                            <polyline points="14 2 14 8 20 8" />
                            <line x1="8" y1="13" x2="16" y2="13" />
                            <line x1="8" y1="17" x2="13" y2="17" />
                          </svg>
                        </div>
                      );
                    }
                    return (
                      <div className="sketch-node-file-icon">
                        <svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor">
                          <path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/>
                        </svg>
                        <div className="sketch-node-file-ext">{ext.toUpperCase()}</div>
                      </div>
                    );
                  })()}
                  <div className="sketch-node-file-name">{(() => {
                    const name = node.file.split(/[/\\]/).pop() || 'Attachment';
                    return name.endsWith('.md') ? name.replace(/\.md$/, '') : name;
                  })()}</div>
                  {/* v20.2 (2026-05-16, HanBin) — drag-OUT handle.
                      Reported issue: "텍스트만 드래그 아웃되는 중임".
                      Root cause: HTML5 `dragstart` had already committed
                      `dataTransfer` as text/plain by the time
                      tauri-plugin-drag's `startDrag` ran via Tauri IPC.
                      The OS picked the HTML5 text payload and ignored
                      the (later) IDataObject from the plugin.

                      Fix: SKIP HTML5 drag entirely. No `draggable`, no
                      `onDragStart`. Track mousedown → threshold → call
                      `startDrag` ourselves. Once Rust calls Windows
                      `DoDragDrop` (or NSPasteboard / GTK), the OS owns
                      the cursor with the real file as the payload —
                      File Explorer / KakaoTalk / Outlook receive it
                      as a file, not as text.

                      Still distinct from canvas-move: stopPropagation on
                      our mousedown means the sketch-node's onMouseDown
                      never fires. */}
                  <div
                    className="sketch-node-file-drag-handle"
                    role="button"
                    tabIndex={0}
                    title={t('sketchDragOutHint', language)}
                    aria-label={t('sketchDragOutHint', language)}
                    onClick={(e) => e.stopPropagation()}
                    onDoubleClick={(e) => e.stopPropagation()}
                    onMouseDown={(e) => {
                      // Only respond to primary button.
                      if (e.button !== 0) return;
                      e.stopPropagation();
                      e.preventDefault();
                      const startX = e.clientX;
                      const startY = e.clientY;
                      let dispatched = false;
                      const filePath = node.file!;
                      const onMove = (mv: MouseEvent) => {
                        if (dispatched) return;
                        const dx = mv.clientX - startX;
                        const dy = mv.clientY - startY;
                        // 5px threshold ≈ standard OS drag start distance.
                        if (Math.hypot(dx, dy) < 5) return;
                        dispatched = true;
                        cleanup();
                        // Fire-and-forget — Rust side blocks the message
                        // loop in DoDragDrop until the user releases the
                        // mouse over a target. We don't await; the JS
                        // side is already past the gesture's start.
                        void startSketchFileDrag(filePath);
                      };
                      const onUp = () => cleanup();
                      const cleanup = () => {
                        document.removeEventListener('mousemove', onMove);
                        document.removeEventListener('mouseup', onUp);
                      };
                      document.addEventListener('mousemove', onMove);
                      document.addEventListener('mouseup', onUp);
                    }}
                  >
                    <GripVertical size={12} strokeWidth={2} />
                  </div>
                  {/* v20.3 — sync spinner. Shown while the file is in
                      `syncingFiles` (seeded on drop, drained on successful
                      sync-v2:report). Positioned bottom-left so it
                      doesn't collide with the drag-out handle (top-right). */}
                  {syncingFiles.has(node.file) && (
                    <div className="sketch-node-file-syncing" aria-label={t('syncing', language)}>
                      <Loader2 size={12} className="sketch-node-file-syncing__icon" />
                    </div>
                  )}
                </div>
              )}
              {!readOnly && selectedNode === node.id && (
                <>
                  {/* Floating action bar above node */}
                  <div className="sketch-node-action-bar" onMouseDown={e => e.stopPropagation()}>
                    <button
                      className="sketch-node-action-btn delete"
                      onClick={() => deleteNode(node.id)}
                      title={t('deleteLabel', language)}
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                        <path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" />
                      </svg>
                    </button>
                  </div>
                  {/* Resize zones at corners — centered on bounding box corner */}
                  {(['ne', 'se', 'sw', 'nw'] as const).map(corner => {
                    const half = 12;
                    const isSpecialShape = node.shape === 'decision' || node.shape === 'io' || node.shape === 'database';
                    const pos: React.CSSProperties =
                      corner === 'ne' ? { top: -half, right: -half, cursor: 'nesw-resize' } :
                      corner === 'se' ? { bottom: -half, right: -half, cursor: 'nwse-resize' } :
                      corner === 'sw' ? { bottom: -half, left: -half, cursor: 'nesw-resize' } :
                      { top: -half, left: -half, cursor: 'nwse-resize' };
                    return (
                      <div
                        key={corner}
                        className={`sketch-node-resize${isSpecialShape ? ' visible-dot' : ''}`}
                        style={pos}
                        onMouseDown={e => handleResizeStart(e, node.id, corner)}
                      />
                    );
                  })}
                </>
              )}
              {/* v20.9 (2026-05-16, HanBin) — node connection handle does
                  DOUBLE DUTY now: if an existing edge ends at this exact
                  (node, side), grabbing the handle REWIRES that edge's
                  endpoint instead of starting a new connection. HanBin:
                  "노드의 파란 원 핸들(화살표 끝점)을 타 노드로 옮기면...
                  화살표 끝점만 이동해야 하는 구조". The earlier approach
                  (separate SVG rewire circles on selected edges) didn't
                  match the user's mental model — they grab the handle
                  that's visually AT the arrow end, not the edge first.
                  The rewire-vs-new-connection decision happens here, in
                  the mousedown, so the user gets the right behavior on
                  first interaction without needing to select the edge. */}
              {!readOnly && (hoveredNode === node.id || selectedNode === node.id || connectingFrom?.nodeId === node.id) && (() => {
                const isNodeSelected = selectedNode === node.id || selectedNodes.includes(node.id);
                return (
                  <>
                    {(['top', 'right', 'bottom', 'left'] as const).map(side => {
                      const pos = getHandlePosition(node, side, isNodeSelected);
                      return (
                        <div
                          key={side}
                          className="sketch-node-handle"
                          style={{ left: pos.left, top: pos.top }}
                          onMouseDown={e => {
                            // Look for an existing edge whose endpoint sits
                            // at this exact (node, side). Prefer `to` over
                            // `from` because users typically grab the arrow
                            // HEAD to redirect it; if there's only an edge
                            // starting from this side, rewire its source.
                            const edges = data.edges || [];
                            const edgeWithTo = edges.find(eg => eg.toNode === node.id && eg.toSide === side);
                            const edgeWithFrom = edges.find(eg => eg.fromNode === node.id && eg.fromSide === side);
                            const target = edgeWithTo || edgeWithFrom;
                            if (target) {
                              // Rewire mode — block the default new-connection
                              // start and route through our rewire state.
                              e.preventDefault();
                              e.stopPropagation();
                              setSelectedEdge(target.id);
                              setRewiringEdge({
                                edgeId: target.id,
                                end: edgeWithTo ? 'to' : 'from',
                              });
                              // Seed preview at the current anchor so the
                              // dashed line is visible from frame 1.
                              setRewirePreview(getShapeAnchorPoint(node, side));
                              return;
                            }
                            // No existing edge here → original new-connection
                            // flow (preserved unchanged).
                            handleConnectionStart(e, node.id, side);
                          }}
                          onMouseEnter={() => setHoveredNode(node.id)}
                        />
                      );
                    })}
                  </>
                );
              })()}
            </div>
          ))}
        </div>

        <svg
          ref={svgRef}
          className="sketch-svg"
          style={{
            transform: `translate(${viewportOffset.x}px, ${viewportOffset.y}px) scale(${viewportScale})`,
            transformOrigin: '0 0',
          }}
        >
          {data.edges.map(edge => {
            // v20.16 (2026-05-17, HanBin) — theme-aware default edge color.
            // Old `'#666'` (medium gray) was hardcoded and felt muted in
            // dark mode; now resolves via CSS var so light/dark each get
            // a calibrated value (#707070 light / #9ca3af dark).
            const edgeColor = edge.color || 'var(--sketch-edge-default)';
            const isMultiSelected = selectedEdges.includes(edge.id);
            const displayColor = isMultiSelected ? blueColor : edgeColor;
            const markerId = `arrowhead-${edge.id}`;
            return (
              <g key={edge.id}>
                {/* Extra wide invisible hit area for easier clicking */}
                <path
                  d={getEdgePath(edge)}
                  stroke="transparent"
                  strokeWidth="40"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  fill="none"
                  onClick={e => handleEdgeClick(e, edge.id)}
                  style={{ cursor: readOnly ? 'default' : 'pointer' }}
                />
                {/* Visible arrow line */}
                <path
                  d={getEdgePath(edge)}
                  stroke={displayColor}
                  strokeWidth={selectedEdge === edge.id || isMultiSelected ? '3' : '2'}
                  fill="none"
                  markerEnd={`url(#${markerId})`}
                  className={`sketch-edge${selectedEdge === edge.id || isMultiSelected ? ' selected' : ''}`}
                  style={{ pointerEvents: 'none' }}
                />
                {/* Individual arrowhead marker for this edge */}
                <defs>
                  <marker
                    id={markerId}
                    markerWidth="10"
                    markerHeight="10"
                    refX="9"
                    refY="5"
                    orient="auto"
                    markerUnits="userSpaceOnUse"
                  >
                    <path d="M 0 0 L 10 5 L 0 10 z" fill={displayColor} />
                  </marker>
                </defs>
                {/* v20.13 (2026-05-17, HanBin) — rewire handles moved to
                    an overlay SVG layer below (zIndex > nodes). They
                    used to live here but the parent .sketch-svg sits at
                    z-base while .sketch-nodes is at z-raised, so the
                    handles painted BEHIND nodes when the edge endpoint
                    landed at a node side. User: "화살표 포커싱 상태일때
                    파란색 핸들링이 노드 뒤에 있어서 디자인적 완성도가
                    낮음." */}
              </g>
            );
          })}
          {connectingFrom && connectionPreview && (
            <path
              d={getConnectionPreviewPath()}
              stroke={blueColor}
              strokeWidth="2"
              strokeDasharray="5,5"
              fill="none"
              markerEnd="url(#arrowhead-preview)"
            />
          )}
          {selectionBox && (
            <rect
              x={selectionBox.x}
              y={selectionBox.y}
              width={selectionBox.width}
              height={selectionBox.height}
              fill="rgba(0, 122, 204, 0.1)"
              stroke={blueColor}
              strokeWidth="1"
              strokeDasharray="5,5"
            />
          )}
          <defs>
            {/* Arrowhead for connection preview */}
            <marker
              id="arrowhead-preview"
              markerWidth="10"
              markerHeight="10"
              refX="9"
              refY="5"
              orient="auto"
              markerUnits="userSpaceOnUse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill={blueColor} />
            </marker>
          </defs>
        </svg>

        {/* v20.13 (2026-05-17, HanBin) — overlay SVG dedicated to the
            selected-edge rewire handles + rewire preview line. Sits in
            DOM order AFTER .sketch-nodes and uses a z-index ABOVE
            --z-raised so the blue endpoint handles paint on top of the
            nodes they overlap with. Same viewport transform as the main
            SVG so coordinates remain in world space. pointer-events:
            none on the wrapper; only handle circles re-enable events. */}
        {!readOnly && (rewiringEdge || (selectedEdge && !selectedEdges.includes(selectedEdge))) && (
          <svg
            className="sketch-svg-overlay"
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: 10000,
              height: 10000,
              overflow: 'visible',
              // Higher than .sketch-nodes (var(--z-raised) = 10).
              // Numeric literal so React types accept it without casting.
              zIndex: 100,
              pointerEvents: 'none',
              transform: `translate(${viewportOffset.x}px, ${viewportOffset.y}px) scale(${viewportScale})`,
              transformOrigin: '0 0',
            }}
          >
            {selectedEdge && !selectedEdges.includes(selectedEdge) && (() => {
              const edge = data.edges.find(e => e.id === selectedEdge);
              if (!edge) return null;
              const fromNode = data.nodes.find(n => n.id === edge.fromNode);
              const toNode = data.nodes.find(n => n.id === edge.toNode);
              if (!fromNode || !toNode) return null;
              const fromPt = getShapeAnchorPoint(fromNode, edge.fromSide);
              const toPt = getShapeAnchorPoint(toNode, edge.toSide);
              const handleR = 6;
              return (
                <>
                  <circle
                    cx={fromPt.x}
                    cy={fromPt.y}
                    r={handleR}
                    fill={blueColor}
                    stroke="var(--bg-base)"
                    strokeWidth={2}
                    style={{ cursor: 'grab', pointerEvents: 'auto' }}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setRewiringEdge({ edgeId: edge.id, end: 'from' });
                      setRewirePreview(fromPt);
                    }}
                  />
                  <circle
                    cx={toPt.x}
                    cy={toPt.y}
                    r={handleR}
                    fill={blueColor}
                    stroke="var(--bg-base)"
                    strokeWidth={2}
                    style={{ cursor: 'grab', pointerEvents: 'auto' }}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setRewiringEdge({ edgeId: edge.id, end: 'to' });
                      setRewirePreview(toPt);
                    }}
                  />
                </>
              );
            })()}
            {rewiringEdge && rewirePreview && (() => {
              const edge = data.edges?.find(eg => eg.id === rewiringEdge.edgeId);
              if (!edge) return null;
              const otherEnd = rewiringEdge.end === 'from' ? edge.toNode : edge.fromNode;
              const otherSide = rewiringEdge.end === 'from' ? edge.toSide : edge.fromSide;
              const otherNode = data.nodes.find(n => n.id === otherEnd);
              if (!otherNode) return null;
              const fixed = getShapeAnchorPoint(otherNode, otherSide);
              const dx = rewirePreview.x - fixed.x;
              const dy = rewirePreview.y - fixed.y;
              const dist = Math.sqrt(dx * dx + dy * dy);
              const co = Math.min(dist * 0.5, 100);
              let cp1x = fixed.x, cp1y = fixed.y;
              switch (otherSide) {
                case 'right': cp1x += co; break;
                case 'left': cp1x -= co; break;
                case 'bottom': cp1y += co; break;
                case 'top': cp1y -= co; break;
              }
              const d = `M ${fixed.x} ${fixed.y} C ${cp1x} ${cp1y}, ${rewirePreview.x} ${rewirePreview.y}, ${rewirePreview.x} ${rewirePreview.y}`;
              return (
                <path
                  d={d}
                  stroke={blueColor}
                  strokeWidth="2"
                  strokeDasharray="6,4"
                  fill="none"
                  style={{ pointerEvents: 'none' }}
                />
              );
            })()}
          </svg>
        )}
      </div>

      {/* Properties are accessed via right-click context menu, not floating panel */}

      {/* Node Context Menu */}
      {contextMenu && (() => {
        const node = data.nodes.find(n => n.id === contextMenu.nodeId);
        if (!node) return null;
        return (
          <NodeContextMenu
            contextMenu={contextMenu}
            node={node}
            data={data}
            onChange={onChange}
            updateNodeProperties={updateNodeProperties}
            setEditingNode={setEditingNode}
            deleteNode={deleteNode}
            closeContextMenu={closeContextMenu}
            language={language}
          />
        );
      })()}

      {/* Multi-select Context Menu */}
      {multiSelectContextMenu && (
        <MultiSelectContextMenu
          position={multiSelectContextMenu}
          data={data}
          onChange={onChange}
          selectedNodes={selectedNodes}
          selectedEdges={selectedEdges}
          setSelectedNodes={setSelectedNodes}
          setSelectedEdges={setSelectedEdges}
          closeMenu={closeMultiSelectContextMenu}
          language={language}
        />
      )}

      {/* Sketch Context Menu (right-click on empty area) — portal to body */}
      {sketchContextMenu && createPortal(
        <>
          <div className="sketch-context-backdrop" onClick={closeSketchContextMenu} onContextMenu={e => { e.preventDefault(); closeSketchContextMenu(); }} />
          <div
            className="sketch-context-menu"
            style={{ left: sketchContextMenu.x, top: sketchContextMenu.y }}
          >
            <button
              className="sketch-context-menu-item"
              onClick={() => {
                addTextNode(sketchContextMenu.x, sketchContextMenu.y);
                closeSketchContextMenu();
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M12 20h9M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4L16.5 3.5z" />
              </svg>
              {t('sketchAddText', language)}
            </button>
            <button
              className="sketch-context-menu-item"
              onClick={() => {
                closeSketchContextMenu();
                setWikiLinkSearch({ active: true });
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71" />
                <path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71" />
              </svg>
              {t('sketchAddWikiLink', language)}
            </button>
            <button
              className="sketch-context-menu-item"
              onClick={async () => {
                closeSketchContextMenu();
                if (!notePath) return;
                try {
                  const { open } = await import('@tauri-apps/plugin-dialog');
                  const selected = await open({ multiple: true });
                  if (!selected) return;
                  const files = Array.isArray(selected) ? selected : [selected];
                  const rect = sketchRef.current?.getBoundingClientRect();
                  const cx = rect ? (sketchContextMenu.x - rect.left - viewportOffset.x) / viewportScale : 100;
                  const cy = rect ? (sketchContextMenu.y - rect.top - viewportOffset.y) / viewportScale : 100;
                  let offsetY = 0;
                  const newNodes = [];
                  for (const filePath of files) {
                    try {
                      const attachmentPath = await noteCommands.importAttachment(filePath, notePath);
                      const name = filePath.split(/[/\\]/).pop() || 'file';
                      const ext = name.split('.').pop()?.toLowerCase() || '';
                      const isImage = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp'].includes(ext);
                      newNodes.push({
                        id: `node-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                        type: 'file' as const,
                        x: cx,
                        y: cy + offsetY,
                        // v20.14 — unified with text-node default (200×100).
                        width: 200,
                        height: isImage ? 150 : 100,
                        file: attachmentPath,
                        text: name,
                      });
                      offsetY += isImage ? 170 : 120;
                    } catch (err) {
                      console.error('Failed to import attachment:', err);
                    }
                  }
                  if (newNodes.length > 0) {
                    onChange({ ...data, nodes: [...data.nodes, ...newNodes] });
                  }
                } catch (err) {
                  console.error('File dialog error:', err);
                }
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
              </svg>
              {t('sketchAddAttachment', language)}
            </button>
            <div className="sketch-context-menu-divider" />
            <button
              className="sketch-context-menu-item"
              onClick={() => {
                addGroupNode(sketchContextMenu.x, sketchContextMenu.y);
                closeSketchContextMenu();
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <rect x="3" y="3" width="18" height="18" rx="2" />
              </svg>
              {t('sketchAddGroup', language)}
            </button>
          </div>
        </>,
        document.body
      )}
      {/* Wiki Link Search (portal) — triggered by [[ on sketch.
          2026-05-24 (HanBin) — CRITICAL FIX. Previously this onSelect
          created a `type: 'file'` node with `file: <absolute path>`,
          which made the chosen note look like an external attachment
          and pollute downstream AttachmentRef state (the user observed
          `ddddd.md` rendering as a teal attachment in the graph and
          appearing in the Attachments tab — purely from this code
          path). The data model already distinguishes:
            • `type: 'file'` + `file:` → external file attachment
            • `type: 'link'` + `url:` → internal note reference
          The "위키링크 추가" UI is unambiguously the latter — the user
          is picking a note that exists in the vault. So we emit a
          proper note-link node. Rendering / double-click handling
          mirror the 'file' branch but anchor on `url` and skip
          the AttachmentRef pipeline entirely. */}
      {wikiLinkSearch.active && (
        <SketchWikiLinkSearch
          onSelect={(fileName, _filePath) => {
            const centerX = (-viewportOffset.x + (sketchRef.current?.clientWidth || 520) / 2) / viewportScale;
            const centerY = (-viewportOffset.y + (sketchRef.current?.clientHeight || 400) / 2) / viewportScale;
            const newNode = {
              id: `node-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
              type: 'link' as const,
              x: centerX - 100,
              y: centerY - 50,
              width: 200,
              height: 100,
              // url stores the note's filename (with or without .md).
              // The double-click handler / graph extractor resolve it
              // back to an absolute path via wiki-link resolution.
              url: fileName,
              text: fileName.replace(/\.md$/i, ''),
            };
            onChange({
              ...data,
              nodes: [...data.nodes, newNode],
            });
            setWikiLinkSearch({ active: false });
          }}
          onClose={() => setWikiLinkSearch({ active: false })}
        />
      )}
    </div>
  );
}

export default SketchEditor;
