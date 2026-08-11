import { syncV2Commands } from '../attachments/attachmentCommands';
import { useState, useRef, useCallback, useEffect } from 'react';
import { useDropTarget } from '../../core/hooks/useDragDrop';
import { generateId, findTextNodeAtPosition } from '../sketch/sketchHelpers';
import { applyFileDrop } from '../sketch/sketchFileDrop';
import { isRecentDragOutDrop } from '../sketch/sketchFileDragOut';
import type { SketchData, SketchNode, SketchEdge } from '../../core/types';

// Shape anchor point calculation (sketch-absolute coordinates)
export function getShapeAnchorPoint(node: SketchNode, side: string): { x: number; y: number } {
  const point = getShapePointStatic(node, side, 2);
  return {
    x: node.x + point.x,
    y: node.y + point.y,
  };
}

// Get shape vertex/edge midpoint in node-local coordinates (static version, no hook dependency)
export function getShapePointStatic(node: SketchNode, side: string, strokeWidth: number = 2): { x: number; y: number } {
  const shape = node.shape || 'process';
  const w = node.width;
  const h = node.height;
  const inset = strokeWidth / 2;

  switch (shape) {
    case 'decision': {
      switch (side) {
        case 'top': return { x: w / 2, y: inset };
        case 'right': return { x: w - inset, y: h / 2 };
        case 'bottom': return { x: w / 2, y: h - inset };
        case 'left': return { x: inset, y: h / 2 };
        default: return { x: w / 2, y: h / 2 };
      }
    }

    case 'io': {
      const skew = w * 0.15;
      const topLeft = { x: skew + inset, y: inset };
      const topRight = { x: w - inset, y: inset };
      const bottomRight = { x: w * 0.85 - inset, y: h - inset };
      const bottomLeft = { x: inset, y: h - inset };

      switch (side) {
        case 'top': return { x: (topLeft.x + topRight.x) / 2, y: inset };
        case 'bottom': return { x: (bottomLeft.x + bottomRight.x) / 2, y: h - inset };
        case 'left': return { x: (topLeft.x + bottomLeft.x) / 2, y: h / 2 };
        case 'right': return { x: (topRight.x + bottomRight.x) / 2, y: h / 2 };
        default: return { x: w / 2, y: h / 2 };
      }
    }

    case 'database': {
      switch (side) {
        case 'top': return { x: w / 2, y: 0 };
        case 'bottom': return { x: w / 2, y: h };
        case 'left': return { x: 0, y: h / 2 };
        case 'right': return { x: w, y: h / 2 };
        default: return { x: w / 2, y: h / 2 };
      }
    }

    case 'subroutine':
    case 'terminal':
    case 'process':
    default: {
      switch (side) {
        case 'top': return { x: w / 2, y: 0 };
        case 'bottom': return { x: w / 2, y: h };
        case 'left': return { x: 0, y: h / 2 };
        case 'right': return { x: w, y: h / 2 };
        default: return { x: w / 2, y: h / 2 };
      }
    }
  }
}

// Calculate handle position (node-local coordinates, for inline styles)
export function getHandlePosition(node: SketchNode, side: string, _isSelected: boolean): { left: number; top: number } {
  const point = getShapePointStatic(node, side, 1.5);
  // Return center point — CSS transform: translate(-50%, -50%) handles centering
  return {
    left: point.x,
    top: point.y,
  };
}

export interface UseSketchInteractionArgs {
  data: SketchData;
  onChange: (data: SketchData) => void;
  readOnly: boolean;
  notePath?: string;
  sketchRef: React.RefObject<HTMLDivElement | null>;
}

export interface SketchInteractionState {
  selectedNode: string | null;
  selectedEdge: string | null;
  selectedNodes: string[];
  selectedEdges: string[];
  draggingNode: string | null;
  isPanning: boolean;
  isSelecting: boolean;
  resizingNode: string | null;
  editingNode: string | null;
  connectingFrom: { nodeId: string; side: 'top' | 'right' | 'bottom' | 'left' } | null;
  connectionPreview: { x: number; y: number } | null;
  hoveredNode: string | null;
  isDragOver: boolean;
  selectionBox: { x: number; y: number; width: number; height: number } | null;
  viewportOffset: { x: number; y: number };
  viewportScale: number;
  contextMenu: { x: number; y: number; nodeId: string } | null;
  sketchContextMenu: { x: number; y: number } | null;
  multiSelectContextMenu: { x: number; y: number } | null;
  propsExpanded: boolean;
}

export interface SketchInteractionActions {
  setSelectedNode: (id: string | null) => void;
  setSelectedEdge: (id: string | null) => void;
  setSelectedNodes: (ids: string[]) => void;
  setSelectedEdges: (ids: string[]) => void;
  setEditingNode: (id: string | null) => void;
  setHoveredNode: (id: string | null) => void;
  setViewportScale: React.Dispatch<React.SetStateAction<number>>;
  // v20.20 (2026-05-17, HanBin) — exposed for canvas text search (Ctrl+F)
  // to pan-center the matched node when the user cycles through results.
  setViewportOffset: React.Dispatch<React.SetStateAction<{ x: number; y: number }>>;
  setPropsExpanded: React.Dispatch<React.SetStateAction<boolean>>;
  setContextMenu: (menu: { x: number; y: number; nodeId: string } | null) => void;
  handleNodeMouseDown: (e: React.MouseEvent, nodeId: string) => void;
  handleConnectionStart: (e: React.MouseEvent, nodeId: string, side: 'top' | 'right' | 'bottom' | 'left') => void;
  handleResizeStart: (e: React.MouseEvent, nodeId: string, handle: 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw') => void;
  handleSketchMouseDown: (e: React.MouseEvent) => void;
  handleSketchDoubleClick: (e: React.MouseEvent) => void;
  handleEdgeClick: (e: React.MouseEvent, edgeId: string) => void;
  handleDragOver: (e: React.DragEvent) => void;
  handleDragLeave: (e: React.DragEvent) => void;
  handleDrop: (e: React.DragEvent) => void;
  addTextNode: (screenX?: number, screenY?: number) => string | null;
  deleteNode: (nodeId: string) => void;
  deleteEdge: (edgeId: string) => void;
  updateNodeText: (nodeId: string, text: string) => void;
  updateNodeProperties: (nodeId: string, properties: Partial<SketchNode>) => void;
  updateEdgeProperties: (edgeId: string, properties: Partial<SketchEdge>) => void;
  handleNodeDoubleClick: (e: React.MouseEvent, nodeId: string) => void;
  handleNodeContextMenu: (e: React.MouseEvent, nodeId: string) => void;
  closeContextMenu: () => void;
  handleSketchContextMenu: (e: React.MouseEvent) => void;
  closeSketchContextMenu: () => void;
  closeMultiSelectContextMenu: () => void;
  addGroupNode: (x: number, y: number) => void;
  getEdgePath: (edge: SketchEdge) => string;
  getConnectionPreviewPath: () => string;
  renderNodeText: (text: string) => string;
  setSketchRef: (el: HTMLDivElement | null) => void;
  copiedNodesRef: React.MutableRefObject<SketchNode[]>;
  copiedEdgesRef: React.MutableRefObject<SketchEdge[]>;
}

export function useSketchInteraction({
  data,
  onChange,
  readOnly,
  notePath,
  sketchRef,
}: UseSketchInteractionArgs): [SketchInteractionState, SketchInteractionActions] {
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
  const [draggingNode, setDraggingNode] = useState<string | null>(null);
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(null);
  const [pendingDrag, setPendingDrag] = useState<{ nodeId: string; x: number; y: number } | null>(null);
  const DRAG_THRESHOLD = 5;
  const [viewportOffset, setViewportOffset] = useState({ x: 0, y: 0 });
  const [viewportScale, setViewportScale] = useState(1);
  const [isPanning, setIsPanning] = useState(false);
  const [panStart, setPanStart] = useState<{ x: number; y: number } | null>(null);
  const [isSelecting, setIsSelecting] = useState(false);
  const [selectionStart, setSelectionStart] = useState<{ x: number; y: number } | null>(null);
  const [selectionBox, setSelectionBox] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const [selectedNodes, setSelectedNodes] = useState<string[]>([]);
  const [selectedEdges, setSelectedEdges] = useState<string[]>([]);
  const [connectingFrom, setConnectingFrom] = useState<{ nodeId: string; side: 'top' | 'right' | 'bottom' | 'left' } | null>(null);
  const [connectionPreview, setConnectionPreview] = useState<{ x: number; y: number } | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [hoveredNode, setHoveredNode] = useState<string | null>(null);
  const [resizingNode, setResizingNode] = useState<string | null>(null);
  const [resizeHandle, setResizeHandle] = useState<'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw' | null>(null);
  const [resizeStart, setResizeStart] = useState<{ x: number; y: number; width: number; height: number; nodeX: number; nodeY: number } | null>(null);
  const [editingNode, setEditingNode] = useState<string | null>(null);
  const [propsExpanded, setPropsExpanded] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; nodeId: string } | null>(null);
  const [sketchContextMenu, setSketchContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [multiSelectContextMenu, setMultiSelectContextMenu] = useState<{ x: number; y: number } | null>(null);

  const copiedNodesRef = useRef<SketchNode[]>([]);
  const copiedEdgesRef = useRef<SketchEdge[]>([]);

  const initializedRef = useRef(false);
  const dataRef = useRef<SketchData>(data);

  // Undo/Redo history
  // v20.10 (2026-05-17, HanBin) — undo history retained for hover window
  // lifetime (was capped at 50). HanBin: "hover 창이 열려있는 기준으로는
  // 되돌리기 기록이 모두 남아야 함". 100k entries is effectively unbounded
  // for any realistic editing session while keeping memory bounded.
  const MAX_HISTORY = 100_000;
  // Gesture coalescing: rapid mutations within COALESCE_MS REPLACE the
  // last entry instead of appending. So a drag (20-30 mousemove commits)
  // is ONE undo step, not 20. HanBin: "되돌리기가 한 칸씩만 동작".
  const COALESCE_MS = 350;
  const historyRef = useRef<SketchData[]>([]);
  const futureRef = useRef<SketchData[]>([]);
  const isUndoRedoRef = useRef(false);
  const lastPushAtRef = useRef<number>(0);

  const pushHistory = useCallback((snapshot: SketchData) => {
    if (isUndoRedoRef.current) return;
    const now = Date.now();
    const inGesture = now - lastPushAtRef.current < COALESCE_MS && historyRef.current.length > 0;
    if (inGesture) {
      // Same gesture window — REPLACE the last entry so a single drag
      // collapses into a single undo step. The pre-gesture state stays
      // at historyRef[length-2] (or earlier) as the undo target.
      historyRef.current = [...historyRef.current.slice(0, -1), snapshot];
    } else {
      // New gesture: append. Bounded by MAX_HISTORY.
      historyRef.current = [...historyRef.current.slice(-(MAX_HISTORY - 1)), snapshot];
    }
    lastPushAtRef.current = now;
    futureRef.current = []; // clear redo stack on new action
  }, []);

  const undo = useCallback(() => {
    if (historyRef.current.length === 0) return;
    const prev = historyRef.current[historyRef.current.length - 1];
    historyRef.current = historyRef.current.slice(0, -1);
    futureRef.current = [...futureRef.current, dataRef.current];
    isUndoRedoRef.current = true;
    // v20.10 — close any open gesture window so the next mutation after
    // an undo starts a fresh history entry instead of getting silently
    // merged into the snapshot we just restored.
    lastPushAtRef.current = 0;
    onChange(prev);
    // v20.11 (2026-05-17, HanBin) — DO NOT reset isUndoRedoRef here.
    // onChange() is synchronous but the data-watching useEffect runs
    // AFTER React commits the re-render, which is AFTER this function
    // returns. Resetting the flag synchronously left the effect seeing
    // false → it treated the undo as a fresh user action and pushed
    // dataRef (the old current) onto history → next Ctrl+Z popped that
    // back, producing the toggle behavior the user reported. The effect
    // now resets the flag itself once it observes the change.
  }, [onChange]);

  const redo = useCallback(() => {
    if (futureRef.current.length === 0) return;
    const next = futureRef.current[futureRef.current.length - 1];
    futureRef.current = futureRef.current.slice(0, -1);
    historyRef.current = [...historyRef.current, dataRef.current];
    isUndoRedoRef.current = true;
    lastPushAtRef.current = 0;
    onChange(next);
    // v20.11 — see undo() comment. Effect resets the flag.
  }, [onChange]);

  // Double-click detection via mousedown
  const lastNodeClickRef = useRef<{ nodeId: string; time: number } | null>(null);
  const DOUBLE_CLICK_THRESHOLD = 350;

  // Track data changes for undo history
  const prevDataRef = useRef<string>('');
  useEffect(() => {
    const serialized = JSON.stringify(data);
    if (prevDataRef.current && prevDataRef.current !== serialized) {
      if (isUndoRedoRef.current) {
        // v20.11 (2026-05-17, HanBin) — this data change came from an
        // undo() or redo() call. Don't push anything; reset the flag so
        // the NEXT data change (a real user mutation) gets recorded.
        isUndoRedoRef.current = false;
      } else {
        try {
          pushHistory(JSON.parse(prevDataRef.current));
        } catch { /* ignore parse errors */ }
      }
    }
    prevDataRef.current = serialized;
    dataRef.current = data;
  }, [data, pushHistory]);

  const handleNodeMouseDown = useCallback((e: React.MouseEvent, nodeId: string) => {
    if (readOnly) return;

    const target = e.target as HTMLElement;
    const isTextarea = target.tagName === 'TEXTAREA';
    const isInEditor = !!target.closest('.ProseMirror') || !!target.closest('.sketch-tiptap-wrapper');

    e.stopPropagation();

    if (editingNode && editingNode !== nodeId) {
      setEditingNode(null);
    }

    // Skip drag initiation when inside TipTap editor (allow text/cell selection)
    if (editingNode === nodeId && isInEditor) return;

    if (e.button === 0 && !isTextarea) {
      const now = Date.now();
      const lastClick = lastNodeClickRef.current;

      if (lastClick && lastClick.nodeId === nodeId && now - lastClick.time < DOUBLE_CLICK_THRESHOLD) {
        const node = data.nodes.find(n => n.id === nodeId);
        if (node && node.type === 'text') {
          setEditingNode(nodeId);
          lastNodeClickRef.current = null;
          return;
        }
      }

      lastNodeClickRef.current = { nodeId, time: now };

      // Ctrl/Shift+click: toggle node in multi-selection
      if (e.ctrlKey || e.shiftKey) {
        const currentNodes = selectedNode && !selectedNodes.includes(selectedNode)
          ? [...selectedNodes, selectedNode] : [...selectedNodes];
        if (currentNodes.includes(nodeId)) {
          // Deselect this node
          const filtered = currentNodes.filter(id => id !== nodeId);
          setSelectedNodes(filtered);
          setSelectedNode(filtered.length === 1 ? filtered[0] : null);
        } else {
          // Add to multi-selection
          const newSelection = [...currentNodes, nodeId];
          setSelectedNodes(newSelection);
          setSelectedNode(null);
        }
        setSelectedEdge(null);
        return;
      }

      // If this node is already multi-selected, keep the multi-selection for group drag
      if (selectedNodes.includes(nodeId)) {
        setSelectedNode(null);
      } else {
        setSelectedNode(nodeId);
        setSelectedNodes([]);
        setSelectedEdges([]);
      }
      setSelectedEdge(null);
      setPendingDrag({ nodeId, x: e.clientX, y: e.clientY });
    } else if (e.button === 0 && isTextarea) {
      setSelectedNode(nodeId);
      setSelectedEdge(null);
    }
  }, [readOnly, editingNode, data.nodes, selectedNodes]);

  const handleConnectionStart = useCallback((e: React.MouseEvent, nodeId: string, side: 'top' | 'right' | 'bottom' | 'left') => {
    if (readOnly) return;
    e.stopPropagation();
    setConnectingFrom({ nodeId, side });
    setSelectedNode(null);
  }, [readOnly]);

  const handleResizeStart = useCallback((e: React.MouseEvent, nodeId: string, handle: 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw') => {
    if (readOnly) return;
    e.stopPropagation();

    const node = data.nodes.find(n => n.id === nodeId);
    if (!node) return;

    setResizingNode(nodeId);
    setResizeHandle(handle);
    setResizeStart({
      x: e.clientX,
      y: e.clientY,
      width: node.width,
      height: node.height,
      nodeX: node.x,
      nodeY: node.y,
    });
  }, [readOnly, data.nodes]);

  const handleSketchMouseDown = useCallback((e: React.MouseEvent) => {
    // Middle button (wheel click) = selection box mode
    if (e.button === 1) {
      e.preventDefault();
      const rect = sketchRef.current?.getBoundingClientRect();
      if (rect) {
        const x = (e.clientX - rect.left - viewportOffset.x) / viewportScale;
        const y = (e.clientY - rect.top - viewportOffset.y) / viewportScale;
        setIsSelecting(true);
        setSelectionStart({ x, y });
        setSelectionBox(null);
      }
      return;
    }

    if (e.button === 0 && !draggingNode) {
      if (editingNode) {
        setEditingNode(null);
      }

      if (connectingFrom) {
        setConnectingFrom(null);
        setConnectionPreview(null);
      } else if (e.shiftKey) {
        // Shift+left click also starts selection box
        const rect = sketchRef.current?.getBoundingClientRect();
        if (rect) {
          const x = (e.clientX - rect.left - viewportOffset.x) / viewportScale;
          const y = (e.clientY - rect.top - viewportOffset.y) / viewportScale;
          setIsSelecting(true);
          setSelectionStart({ x, y });
          setSelectionBox(null);
        }
      } else {
        e.preventDefault();
        setIsPanning(true);
        setPanStart({ x: e.clientX, y: e.clientY });
        setSelectedNodes([]);
        setSelectedEdges([]);
      }
      setSelectedNode(null);
      setSelectedEdge(null);
    }
  }, [draggingNode, connectingFrom, viewportOffset, viewportScale, editingNode, sketchRef]);

  const handleSketchDoubleClick = useCallback((e: React.MouseEvent) => {
    if (readOnly || !sketchRef.current) return;
    e.stopPropagation();

    const rect = sketchRef.current.getBoundingClientRect();
    const x = (e.clientX - rect.left - viewportOffset.x) / viewportScale;
    const y = (e.clientY - rect.top - viewportOffset.y) / viewportScale;

    const newNode: SketchNode = {
      id: generateId('node'),
      type: 'text',
      x: x - 100,
      y: y - 50,
      width: 200,
      height: 100,
      text: '',
    };

    onChange({ ...data, nodes: [...data.nodes, newNode] });
    setSelectedNode(newNode.id);
    setEditingNode(newNode.id);
  }, [readOnly, data, onChange, viewportOffset, viewportScale, sketchRef]);

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (pendingDrag && !draggingNode) {
      const dx = Math.abs(e.clientX - pendingDrag.x);
      const dy = Math.abs(e.clientY - pendingDrag.y);
      if (dx >= DRAG_THRESHOLD || dy >= DRAG_THRESHOLD) {
        setDraggingNode(pendingDrag.nodeId);
        setDragStart({ x: e.clientX, y: e.clientY });
        setPendingDrag(null);
      }
      return;
    }

    if (resizingNode && resizeStart && resizeHandle) {
      const dx = (e.clientX - resizeStart.x) / viewportScale;
      const dy = (e.clientY - resizeStart.y) / viewportScale;

      const minWidth = 80;
      const minHeight = 60;

      const updatedNodes = data.nodes.map(node => {
        if (node.id !== resizingNode) return node;

        let newWidth = resizeStart.width;
        let newHeight = resizeStart.height;
        let newX = resizeStart.nodeX;
        let newY = resizeStart.nodeY;

        if (resizeHandle.includes('e')) {
          newWidth = Math.max(minWidth, resizeStart.width + dx);
        } else if (resizeHandle.includes('w')) {
          newWidth = Math.max(minWidth, resizeStart.width - dx);
          newX = resizeStart.nodeX + (resizeStart.width - newWidth);
        }

        if (resizeHandle.includes('s')) {
          newHeight = Math.max(minHeight, resizeStart.height + dy);
        } else if (resizeHandle.includes('n')) {
          newHeight = Math.max(minHeight, resizeStart.height - dy);
          newY = resizeStart.nodeY + (resizeStart.height - newHeight);
        }

        return { ...node, width: newWidth, height: newHeight, x: newX, y: newY };
      });

      onChange({ ...data, nodes: updatedNodes });
    } else if (draggingNode && dragStart) {
      const dx = (e.clientX - dragStart.x) / viewportScale;
      const dy = (e.clientY - dragStart.y) / viewportScale;

      // If dragging node is part of multi-selection, move all selected nodes
      const movingIds = selectedNodes.includes(draggingNode)
        ? new Set(selectedNodes)
        : new Set([draggingNode]);

      // Group containment: when dragging a group, also move contained non-group nodes
      const groupDragIds = new Set(movingIds);
      for (const id of movingIds) {
        const groupNode = data.nodes.find(n => n.id === id);
        if (groupNode && (groupNode.type === 'group' || groupNode.isGroup)) {
          for (const child of data.nodes) {
            if (child.id === id || child.type === 'group' || child.isGroup) continue;
            if (
              child.x >= groupNode.x &&
              child.y >= groupNode.y &&
              child.x + child.width <= groupNode.x + groupNode.width &&
              child.y + child.height <= groupNode.y + groupNode.height
            ) {
              groupDragIds.add(child.id);
            }
          }
        }
      }

      const updatedNodes = data.nodes.map(node =>
        groupDragIds.has(node.id)
          ? { ...node, x: node.x + dx, y: node.y + dy }
          : node
      );

      onChange({ ...data, nodes: updatedNodes });
      setDragStart({ x: e.clientX, y: e.clientY });
    } else if (isPanning && panStart) {
      const dx = e.clientX - panStart.x;
      const dy = e.clientY - panStart.y;

      const sensitivity = 0.7;
      setViewportOffset(prev => ({
        x: prev.x + dx * sensitivity,
        y: prev.y + dy * sensitivity
      }));
      setPanStart({ x: e.clientX, y: e.clientY });
    } else if (isSelecting && selectionStart && sketchRef.current) {
      const rect = sketchRef.current.getBoundingClientRect();
      const x = (e.clientX - rect.left - viewportOffset.x) / viewportScale;
      const y = (e.clientY - rect.top - viewportOffset.y) / viewportScale;

      const boxX = Math.min(selectionStart.x, x);
      const boxY = Math.min(selectionStart.y, y);
      const boxWidth = Math.abs(x - selectionStart.x);
      const boxHeight = Math.abs(y - selectionStart.y);

      setSelectionBox({ x: boxX, y: boxY, width: boxWidth, height: boxHeight });
    } else if (connectingFrom && sketchRef.current) {
      const rect = sketchRef.current.getBoundingClientRect();
      const x = (e.clientX - rect.left - viewportOffset.x) / viewportScale;
      const y = (e.clientY - rect.top - viewportOffset.y) / viewportScale;
      setConnectionPreview({ x, y });

      data.nodes.forEach(node => {
        const isOverNode = x >= node.x && x <= node.x + node.width && y >= node.y && y <= node.y + node.height;
        if (isOverNode && node.id !== connectingFrom.nodeId) {
          setHoveredNode(node.id);
        }
      });
    }
  }, [pendingDrag, resizingNode, resizeStart, resizeHandle, draggingNode, dragStart, isPanning, panStart, isSelecting, selectionStart, data, onChange, viewportScale, connectingFrom, viewportOffset, sketchRef]);

  const handleMouseUp = useCallback((e: MouseEvent) => {
    if (pendingDrag) {
      setPendingDrag(null);
    }

    if (connectingFrom && sketchRef.current) {
      const rect = sketchRef.current.getBoundingClientRect();
      const x = (e.clientX - rect.left - viewportOffset.x) / viewportScale;
      const y = (e.clientY - rect.top - viewportOffset.y) / viewportScale;

      let targetNode: SketchNode | null = null;
      let targetSide: 'top' | 'right' | 'bottom' | 'left' | null = null;
      const connectionTolerance = 30;

      for (const node of data.nodes) {
        if (node.id === connectingFrom.nodeId) continue;

        if (x >= node.x - connectionTolerance && x <= node.x + node.width + connectionTolerance &&
            y >= node.y - connectionTolerance && y <= node.y + node.height + connectionTolerance) {
          targetNode = node;

          const centerX = node.x + node.width / 2;
          const centerY = node.y + node.height / 2;
          const dx = x - centerX;
          const dy = y - centerY;

          if (Math.abs(dx) > Math.abs(dy)) {
            targetSide = dx > 0 ? 'right' : 'left';
          } else {
            targetSide = dy > 0 ? 'bottom' : 'top';
          }
          break;
        }
      }

      if (targetNode && targetSide) {
        const newEdge: SketchEdge = {
          id: generateId('edge'),
          fromNode: connectingFrom.nodeId,
          fromSide: connectingFrom.side,
          toNode: targetNode.id,
          toSide: targetSide,
        };

        const filteredEdges = data.edges.filter(edge => {
          const sameDirection = edge.fromNode === connectingFrom.nodeId && edge.toNode === targetNode.id;
          const reverseDirection = edge.fromNode === targetNode.id && edge.toNode === connectingFrom.nodeId;
          return !sameDirection && !reverseDirection;
        });

        onChange({ ...data, edges: [...filteredEdges, newEdge] });
      }
    }

    if (isSelecting && selectionBox) {
      const getNodeVisualBounds = (node: SketchNode) => {
        return {
          left: node.x,
          top: node.y,
          right: node.x + node.width,
          bottom: node.y + node.height,
        };
      };

      const selectedNodeIds = data.nodes
        .filter(node => {
          const bounds = getNodeVisualBounds(node);
          const boxRight = selectionBox.x + selectionBox.width;
          const boxBottom = selectionBox.y + selectionBox.height;

          const intersects = !(
            bounds.left > boxRight ||
            bounds.right < selectionBox.x ||
            bounds.top > boxBottom ||
            bounds.bottom < selectionBox.y
          );

          return intersects;
        })
        .map(node => node.id);

      const selectedEdgeIds = data.edges
        .filter(edge => {
          const fromNode = data.nodes.find(n => n.id === edge.fromNode);
          const toNode = data.nodes.find(n => n.id === edge.toNode);
          if (!fromNode || !toNode) return false;

          const from = getShapeAnchorPoint(fromNode, edge.fromSide);
          const to = getShapeAnchorPoint(toNode, edge.toSide);

          const boxRight = selectionBox.x + selectionBox.width;
          const boxBottom = selectionBox.y + selectionBox.height;

          const isPointInBox = (p: { x: number; y: number }) =>
            p.x >= selectionBox.x && p.x <= boxRight &&
            p.y >= selectionBox.y && p.y <= boxBottom;

          if (isPointInBox(from) || isPointInBox(to)) return true;

          for (let i = 1; i < 10; i++) {
            const t = i / 10;
            const sampleX = from.x + (to.x - from.x) * t;
            const sampleY = from.y + (to.y - from.y) * t;
            if (isPointInBox({ x: sampleX, y: sampleY })) return true;
          }

          return false;
        })
        .map(edge => edge.id);

      setSelectedNodes(selectedNodeIds);
      setSelectedEdges(selectedEdgeIds);
    } else if (isSelecting && !selectionBox) {
      setSelectedNodes([]);
      setSelectedEdges([]);
    }

    setDraggingNode(null);
    setDragStart(null);
    setIsPanning(false);
    setPanStart(null);
    setIsSelecting(false);
    setSelectionStart(null);
    setSelectionBox(null);
    setConnectingFrom(null);
    setConnectionPreview(null);
    setResizingNode(null);
    setResizeHandle(null);
    setResizeStart(null);
  }, [pendingDrag, connectingFrom, isSelecting, selectionBox, data, onChange, viewportOffset, viewportScale, sketchRef]);

  const handleWheel = useCallback((e: WheelEvent) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    setViewportScale(prev => Math.max(0.1, Math.min(3, prev * delta)));
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (readOnly || !notePath) return;
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(true);
  }, [readOnly, notePath]);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  }, []);

  // Use refs for viewport state to avoid recreating handleNativeFileDrop
  const viewportOffsetRef = useRef(viewportOffset);
  const viewportScaleRef = useRef(viewportScale);
  const onChangeRef = useRef(onChange);
  // R5 — refs for drag-source guards in handleDrop (sync from state on each render)
  const draggingNodeRef = useRef<string | null>(draggingNode);
  const pendingDragRef = useRef<typeof pendingDrag>(pendingDrag);

  useEffect(() => {
    viewportOffsetRef.current = viewportOffset;
    viewportScaleRef.current = viewportScale;
    onChangeRef.current = onChange;
  }, [viewportOffset, viewportScale, onChange]);

  useEffect(() => {
    draggingNodeRef.current = draggingNode;
    pendingDragRef.current = pendingDrag;
  }, [draggingNode, pendingDrag]);

  // Handle Tauri native drop events - stable callback using refs
  const handleNativeFileDrop = useCallback(async (importedPaths: string[], position?: { x: number; y: number }) => {
    if (readOnly || !sketchRef.current || !notePath) return;

    // R5 v3 (HanBin 2026-05-23) — three-tier guard against same-canvas
    // drag-out-drop-in (which used to create a duplicate node + stuck spinner):
    //   1. Path exact match against existing node `file` fields.
    //   2. Basename match — OS often normalises the path differently
    //      from what's stored in node.file (separator, drive case,
    //      symlink resolution), so basename is a more reliable match.
    //   3. `isRecentDragOutDrop` — module-level tracker set by
    //      startSketchFileDrag; if the user JUST initiated a drag-out
    //      of this file (<3s ago), reject it regardless of name match.
    const currentData = dataRef.current;
    const existingFiles = currentData.nodes
      .filter(n => n.type === 'file' && typeof n.file === 'string' && n.file.length > 0)
      .map(n => n.file as string);
    const existingFullPaths = new Set(existingFiles);
    const existingBasenames = new Set(
      existingFiles.map(f => f.split(/[/\\]/).pop() || '')
    );
    const newPaths = importedPaths.filter(p => {
      if (existingFullPaths.has(p)) return false;
      const basename = p.split(/[/\\]/).pop() || '';
      if (existingBasenames.has(basename)) return false;
      if (isRecentDragOutDrop(p)) return false;
      return true;
    });
    if (newPaths.length === 0) {
      console.log('[handleNativeFileDrop] dropped paths all match existing nodes or recent drag-out, ignored', importedPaths);
      return;
    }

    let dropX = 100;
    let dropY = 100;

    if (position && sketchRef.current) {
      const rect = sketchRef.current.getBoundingClientRect();
      dropX = (position.x - rect.left - viewportOffsetRef.current.x) / viewportScaleRef.current;
      dropY = (position.y - rect.top - viewportOffsetRef.current.y) / viewportScaleRef.current;
    }

    const targetTextNode = findTextNodeAtPosition(currentData.nodes, dropX, dropY);

    // 2026-05-23 (HanBin) — CRITICAL FIX. Previously this handler stored
    // the raw OS-provided path as the sketch node's `file` field, which
    // meant Windows Explorer drops never went through `attachment_add`.
    // No `AttachmentRef` was created → Attachments tab + graph view
    // showed "0 첨부" even though the canvas displayed the file node.
    // The user hit this with dddsaa's HWP/XLSX/PDF.
    //
    // Fix: import every dropped file through the sync_v2 attachment_add
    // command first. That creates the CAS blob + AttachmentRef +
    // `.attachments/<name>` display hardlink, and links the new ref to
    // this sketch note's id. Use the returned displayPath as the sketch
    // node's `file` field so wikilink resolution + drag-out keep working.
    // Imports that fail (file already a Notology attachment, OS permission
    // error, etc.) fall back to the raw path so the user at least sees
    // the node — same as before — but a console.error is logged.
    const importedFiles: { name: string; path: string }[] = [];
    for (const rawPath of newPaths) {
      const basename = rawPath.split(/[/\\]/).pop() || '';
      // Skip the import for paths that are ALREADY inside the vault
      // (e.g. files dragged from `.attachments/`). Storing the raw
      // vault-relative path keeps the sketch node pointed at the
      // existing display hardlink and avoids dedup churn.
      const looksAlreadyImported = rawPath.replace(/\\/g, '/').includes('/.attachments/');
      if (looksAlreadyImported) {
        importedFiles.push({ name: basename, path: rawPath });
        continue;
      }
      try {
        const ref = await syncV2Commands.attachmentAdd(rawPath, { notePath });
        importedFiles.push({ name: basename, path: ref.displayPath });
      } catch (err) {
        console.error('[handleNativeFileDrop] attachmentAdd failed for', rawPath, err);
        importedFiles.push({ name: basename, path: rawPath });
      }
    }

    if (importedFiles.length === 0) return;
    onChangeRef.current(applyFileDrop(dataRef.current, importedFiles, dropX, dropY, targetTextNode));
  }, [readOnly, sketchRef, notePath]);

  // Register drop target for Tauri native events
  const dropTargetRef = useDropTarget(
    `sketch-editor-${notePath || 'unknown'}`,
    notePath ?? null,
    handleNativeFileDrop
  );
  // Combine sketchRef and dropTargetRef
  const setSketchRef = useCallback((el: HTMLDivElement | null) => {
    (sketchRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
    dropTargetRef(el);
  }, [dropTargetRef, sketchRef]);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    if (readOnly || !notePath || !sketchRef.current) return;
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);

    // R5 guard 1: 캔버스 내부 노드 드래그 중이면 무시.
    // in-canvas 이동은 mouse 핸들러가 처리하므로 drop 이벤트로 새 노드를 만들면
    // syncingFiles Set에 영영 stuck되는 무한 스피너 버그 발생.
    if (draggingNodeRef.current || pendingDragRef.current) return;

    // R5 guard 2: 진짜 OS 파일 드롭이 아니면 무시.
    // dataTransfer.types에 "Files"가 들어있어야 외부 OS 드롭으로 인정.
    // (React DnD 내부 페이로드는 application/* MIME으로 들어옴 — 별도 경로)
    if (!e.dataTransfer.types.includes('Files')) return;

    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;

    const rect = sketchRef.current.getBoundingClientRect();
    const dropX = (e.clientX - rect.left - viewportOffset.x) / viewportScale;
    const dropY = (e.clientY - rect.top - viewportOffset.y) / viewportScale;

    // 2026-05-23 (HanBin) — switched from legacy `noteCommands.importAttachment`
    // (which created `<note>_att/` folders deleted by sync_v2 migration) to
    // the sync_v2 `attachmentAdd` API. See the matching comment in
    // `handleNativeFileDrop` above for the full rationale — same bug class.
    const importedFiles: { name: string; path: string }[] = [];
    for (const file of files) {
      try {
        const filePath = (file as any).path;
        if (!filePath) continue;
        const ref = await syncV2Commands.attachmentAdd(filePath, { notePath });
        importedFiles.push({ name: file.name, path: ref.displayPath });
      } catch (err) {
        console.error('[handleDrop] attachmentAdd failed:', err);
      }
    }

    if (importedFiles.length === 0) return;

    const currentData = dataRef.current;
    const targetTextNode = findTextNodeAtPosition(currentData.nodes, dropX, dropY);
    onChange(applyFileDrop(currentData, importedFiles, dropX, dropY, targetTextNode));
  }, [readOnly, notePath, onChange, viewportOffset, viewportScale, sketchRef]);

  // Register mouse/keyboard event listeners
  useEffect(() => {
    if (pendingDrag || draggingNode || isPanning || isSelecting || connectingFrom || resizingNode) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      if (draggingNode || isPanning || isSelecting || resizingNode) {
        document.body.classList.add('sketch-dragging');
      }
      return () => {
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
        document.body.classList.remove('sketch-dragging');
      };
    }
  }, [pendingDrag, draggingNode, isPanning, isSelecting, connectingFrom, resizingNode, handleMouseMove, handleMouseUp]);

  useEffect(() => {
    const el = sketchRef.current;
    if (el) {
      el.addEventListener('wheel', handleWheel, { passive: false });
      return () => el.removeEventListener('wheel', handleWheel);
    }
  }, [handleWheel, sketchRef]);

  // Fit all nodes in viewport when sketch loads
  useEffect(() => {
    if (initializedRef.current) return;
    if (!sketchRef.current || data.nodes.length === 0) return;

    initializedRef.current = true;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    data.nodes.forEach(node => {
      minX = Math.min(minX, node.x);
      minY = Math.min(minY, node.y);
      maxX = Math.max(maxX, node.x + node.width);
      maxY = Math.max(maxY, node.y + node.height);
    });

    const padding = 50;
    minX -= padding;
    minY -= padding;
    maxX += padding;
    maxY += padding;

    const contentWidth = maxX - minX;
    const contentHeight = maxY - minY;
    const viewportWidth = sketchRef.current.clientWidth;
    const viewportHeight = sketchRef.current.clientHeight;

    const scaleX = viewportWidth / contentWidth;
    const scaleY = viewportHeight / contentHeight;
    const scale = Math.min(scaleX, scaleY, 1);

    const offsetX = (viewportWidth - contentWidth * scale) / 2 - minX * scale;
    const offsetY = (viewportHeight - contentHeight * scale) / 2 - minY * scale;

    setViewportScale(scale);
    setViewportOffset({ x: offsetX, y: offsetY });
  }, [data.nodes.length, sketchRef]);

  const addTextNode = useCallback((screenX?: number, screenY?: number): string | null => {
    if (readOnly) return null;
    let cx: number, cy: number;
    if (screenX !== undefined && screenY !== undefined && sketchRef.current) {
      const rect = sketchRef.current.getBoundingClientRect();
      cx = (screenX - rect.left - viewportOffset.x) / viewportScale;
      cy = (screenY - rect.top - viewportOffset.y) / viewportScale;
    } else {
      cx = -viewportOffset.x / viewportScale + 100;
      cy = -viewportOffset.y / viewportScale + 100;
    }
    const nodeId = generateId('node');
    const newNode: SketchNode = {
      id: nodeId,
      type: 'text',
      x: cx,
      y: cy,
      width: 200,
      height: 100,
      text: '',
    };
    const currentData = dataRef.current;
    onChange({ ...currentData, nodes: [...currentData.nodes, newNode] });
    setSelectedNode(nodeId);
    setEditingNode(nodeId);
    return nodeId;
  }, [onChange, readOnly, viewportOffset, viewportScale, sketchRef]);

  const deleteNode = useCallback((nodeId: string) => {
    if (readOnly) return;
    const updatedNodes = data.nodes.filter(n => n.id !== nodeId);
    const updatedEdges = data.edges.filter(e => e.fromNode !== nodeId && e.toNode !== nodeId);
    onChange({ nodes: updatedNodes, edges: updatedEdges });
    setSelectedNode(null);
  }, [data, onChange, readOnly]);

  const handleEdgeClick = useCallback((e: React.MouseEvent, edgeId: string) => {
    if (readOnly) return;
    e.stopPropagation();

    // Ctrl/Shift+click: toggle edge in multi-selection
    if (e.ctrlKey || e.shiftKey) {
      const currentEdges = selectedEdge && !selectedEdges.includes(selectedEdge)
        ? [...selectedEdges, selectedEdge] : [...selectedEdges];
      if (currentEdges.includes(edgeId)) {
        const filtered = currentEdges.filter(id => id !== edgeId);
        setSelectedEdges(filtered);
        setSelectedEdge(filtered.length === 1 ? filtered[0] : null);
      } else {
        setSelectedEdges([...currentEdges, edgeId]);
        setSelectedEdge(null);
      }
      return;
    }

    setSelectedEdge(edgeId);
    setSelectedNode(null);
    setSelectedNodes([]);
    setSelectedEdges([]);
  }, [readOnly, selectedEdge, selectedEdges]);

  const deleteEdge = useCallback((edgeId: string) => {
    if (readOnly) return;
    const updatedEdges = data.edges.filter(e => e.id !== edgeId);
    onChange({ ...data, edges: updatedEdges });
    setSelectedEdge(null);
  }, [data, onChange, readOnly]);

  const updateEdgeProperties = useCallback((edgeId: string, properties: Partial<SketchEdge>) => {
    if (readOnly) return;
    const updatedEdges = data.edges.map(edge =>
      edge.id === edgeId ? { ...edge, ...properties } : edge
    );
    onChange({ ...data, edges: updatedEdges });
  }, [data, onChange, readOnly]);

  const updateNodeText = useCallback((nodeId: string, text: string) => {
    if (readOnly) return;
    const updatedNodes = data.nodes.map(node =>
      node.id === nodeId ? { ...node, text } : node
    );
    onChange({ ...data, nodes: updatedNodes });
  }, [data, onChange, readOnly]);

  const handleNodeDoubleClick = useCallback((e: React.MouseEvent, nodeId: string) => {
    if (readOnly) return;
    e.stopPropagation();
    const node = data.nodes.find(n => n.id === nodeId);
    if (node && (node.type === 'text' || node.text !== undefined)) {
      setEditingNode(nodeId);
    }
  }, [readOnly, data.nodes]);

  const handleNodeContextMenu = useCallback((e: React.MouseEvent, nodeId: string) => {
    e.preventDefault();
    e.stopPropagation();
    // If node is in multi-selection, show multi-select context menu
    if (selectedNodes.includes(nodeId) && selectedNodes.length > 1) {
      setMultiSelectContextMenu({ x: e.clientX, y: e.clientY });
    } else {
      setContextMenu({ x: e.clientX, y: e.clientY, nodeId });
      setSelectedNode(nodeId);
    }
  }, [selectedNodes]);

  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  const handleSketchContextMenu = useCallback((e: React.MouseEvent) => {
    if (readOnly || !sketchRef.current) return;
    e.preventDefault();
    e.stopPropagation();
    setSketchContextMenu({ x: e.clientX, y: e.clientY });
  }, [readOnly, sketchRef]);

  const closeSketchContextMenu = useCallback(() => {
    setSketchContextMenu(null);
  }, []);

  const closeMultiSelectContextMenu = useCallback(() => {
    setMultiSelectContextMenu(null);
  }, []);

  const addGroupNode = useCallback((x: number, y: number) => {
    if (readOnly || !sketchRef.current) return;
    const rect = sketchRef.current.getBoundingClientRect();
    const sketchX = (x - rect.left - viewportOffset.x) / viewportScale;
    const sketchY = (y - rect.top - viewportOffset.y) / viewportScale;

    const newNode: SketchNode = {
      id: generateId('node'),
      type: 'group',
      x: sketchX - 150,
      y: sketchY - 100,
      width: 300,
      height: 200,
      isGroup: true,
      groupLabel: 'Group',
      color: '#4f46e5',
    };

    // Groups render behind regular nodes — insert at beginning
    onChange({ ...data, nodes: [newNode, ...data.nodes] });
    setSelectedNode(newNode.id);
  }, [readOnly, data, onChange, viewportOffset, viewportScale, sketchRef]);

  // Simple markdown -> HTML renderer for view mode
  const renderNodeText = useCallback((text: string): string => {
    if (!text) return '';

    const escapeHtml = (s: string) =>
      s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    const applyInlineFormatting = (line: string): string => {
      let result = escapeHtml(line);
      result = result.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
      result = result.replace(/\*(.+?)\*/g, '<em>$1</em>');
      result = result.replace(/\[\[(.+?)\]\]/g, '<span class="sketch-wikilink" data-wikilink="$1">$1</span>');
      return result;
    };

    const lines = text.split('\n');
    const htmlParts: string[] = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      const headingMatch = line.match(/^(#{1,3})\s+(.+)$/);
      if (headingMatch) {
        const content = applyInlineFormatting(headingMatch[2]);
        htmlParts.push(`<strong class="sketch-heading sketch-heading-${headingMatch[1].length}">${content}</strong>`);
        i++;
        continue;
      }

      if (line.startsWith('> ')) {
        const content = applyInlineFormatting(line.slice(2));
        htmlParts.push(`<blockquote>${content}</blockquote>`);
        i++;
        continue;
      }

      if (/^[-*]\s+/.test(line)) {
        const items: string[] = [];
        while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
          items.push(`<li>${applyInlineFormatting(lines[i].replace(/^[-*]\s+/, ''))}</li>`);
          i++;
        }
        htmlParts.push(`<ul>${items.join('')}</ul>`);
        continue;
      }

      if (/^\d+\.\s+/.test(line)) {
        const items: string[] = [];
        while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
          items.push(`<li>${applyInlineFormatting(lines[i].replace(/^\d+\.\s+/, ''))}</li>`);
          i++;
        }
        htmlParts.push(`<ol>${items.join('')}</ol>`);
        continue;
      }

      if (line.trim() === '') {
        i++;
        continue;
      }

      htmlParts.push(`<p>${applyInlineFormatting(line)}</p>`);
      i++;
    }

    return htmlParts.join('');
  }, []);

  // Handle keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (readOnly) return;

      const isEditing = document.activeElement?.tagName === 'TEXTAREA' || !!document.activeElement?.closest('.ProseMirror');

      if (e.key === 'Escape' && editingNode) {
        setEditingNode(null);
        return;
      }

      // Undo/Redo
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey && !isEditing) {
        e.preventDefault();
        undo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey)) && !isEditing) {
        e.preventDefault();
        redo();
        return;
      }

      if ((e.ctrlKey || e.metaKey) && e.key === 'c' && !isEditing) {
        e.preventDefault();
        const nodesToCopy: SketchNode[] = [];

        if (selectedNodes.length > 0) {
          nodesToCopy.push(...data.nodes.filter(n => selectedNodes.includes(n.id)));
        } else if (selectedNode) {
          const node = data.nodes.find(n => n.id === selectedNode);
          if (node) nodesToCopy.push(node);
        }

        if (nodesToCopy.length > 0) {
          copiedNodesRef.current = nodesToCopy.map(n => ({ ...n }));
          const copiedIds = new Set(nodesToCopy.map(n => n.id));
          copiedEdgesRef.current = data.edges
            .filter(e => copiedIds.has(e.fromNode) && copiedIds.has(e.toNode))
            .map(e => ({ ...e }));
        }
        return;
      }

      if ((e.ctrlKey || e.metaKey) && e.key === 'v' && !isEditing) {
        e.preventDefault();
        if (copiedNodesRef.current.length === 0) return;

        const offset = 20;
        const idMap = new Map<string, string>();

        const newNodes: SketchNode[] = copiedNodesRef.current.map(n => {
          const newId = generateId('node');
          idMap.set(n.id, newId);
          return { ...n, id: newId, x: n.x + offset, y: n.y + offset };
        });

        const newEdges: SketchEdge[] = copiedEdgesRef.current.map(e => ({
          ...e,
          id: generateId('edge'),
          fromNode: idMap.get(e.fromNode) || e.fromNode,
          toNode: idMap.get(e.toNode) || e.toNode,
        }));

        onChange({
          ...data,
          nodes: [...data.nodes, ...newNodes],
          edges: [...data.edges, ...newEdges],
        });

        copiedNodesRef.current = newNodes.map(n => ({ ...n }));
        copiedEdgesRef.current = newEdges.map(e => ({ ...e }));

        setSelectedNodes(newNodes.map(n => n.id));
        setSelectedNode(null);
        setSelectedEdge(null);
        setSelectedEdges([]);
        return;
      }

      if (e.key === 'Delete' && !isEditing) {
        e.preventDefault();

        if (selectedNodes.length > 0) {
          const remainingNodes = data.nodes.filter(n => !selectedNodes.includes(n.id));
          const remainingEdges = data.edges.filter(e =>
            !selectedNodes.includes(e.fromNode) &&
            !selectedNodes.includes(e.toNode) &&
            !selectedEdges.includes(e.id)
          );
          onChange({ nodes: remainingNodes, edges: remainingEdges });
          setSelectedNodes([]);
          setSelectedEdges([]);
        } else if (selectedNode) {
          deleteNode(selectedNode);
        } else if (selectedEdge) {
          deleteEdge(selectedEdge);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [readOnly, selectedNode, selectedEdge, selectedNodes, selectedEdges, data, onChange, deleteNode, deleteEdge, editingNode, undo, redo]);

  const updateNodeProperties = useCallback((nodeId: string, properties: Partial<SketchNode>) => {
    if (readOnly) return;
    const updatedNodes = data.nodes.map(node => {
      if (node.id !== nodeId) return node;
      return {
        ...node,
        ...properties,
        x: node.x,
        y: node.y,
        width: node.width,
        height: node.height,
      };
    });
    onChange({ ...data, nodes: updatedNodes });
  }, [data, onChange, readOnly]);

  const getEdgePath = useCallback((edge: SketchEdge): string => {
    const fromNode = data.nodes.find(n => n.id === edge.fromNode);
    const toNode = data.nodes.find(n => n.id === edge.toNode);

    if (!fromNode || !toNode) return '';

    const from = getShapeAnchorPoint(fromNode, edge.fromSide);
    const to = getShapeAnchorPoint(toNode, edge.toSide);

    const dx = to.x - from.x;
    const dy = to.y - from.y;

    const distance = Math.sqrt(dx * dx + dy * dy);
    const controlOffset = Math.min(distance * 0.5, 100);

    let cp1x = from.x;
    let cp1y = from.y;
    let cp2x = to.x;
    let cp2y = to.y;

    switch (edge.fromSide) {
      case 'right': cp1x += controlOffset; break;
      case 'left': cp1x -= controlOffset; break;
      case 'bottom': cp1y += controlOffset; break;
      case 'top': cp1y -= controlOffset; break;
    }

    switch (edge.toSide) {
      case 'right': cp2x += controlOffset; break;
      case 'left': cp2x -= controlOffset; break;
      case 'bottom': cp2y += controlOffset; break;
      case 'top': cp2y -= controlOffset; break;
    }

    return `M ${from.x} ${from.y} C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${to.x} ${to.y}`;
  }, [data.nodes]);

  const getConnectionPreviewPath = useCallback((): string => {
    if (!connectingFrom || !connectionPreview) return '';

    const fromNode = data.nodes.find(n => n.id === connectingFrom.nodeId);
    if (!fromNode) return '';

    const startPoint = getShapeAnchorPoint(fromNode, connectingFrom.side);
    const startX = startPoint.x;
    const startY = startPoint.y;

    const dx = connectionPreview.x - startX;
    const dy = connectionPreview.y - startY;
    const distance = Math.sqrt(dx * dx + dy * dy);
    const controlOffset = Math.min(distance * 0.5, 100);

    let cp1x = startX;
    let cp1y = startY;

    switch (connectingFrom.side) {
      case 'right': cp1x += controlOffset; break;
      case 'left': cp1x -= controlOffset; break;
      case 'bottom': cp1y += controlOffset; break;
      case 'top': cp1y -= controlOffset; break;
    }

    return `M ${startX} ${startY} Q ${cp1x} ${cp1y}, ${connectionPreview.x} ${connectionPreview.y}`;
  }, [connectingFrom, connectionPreview, data.nodes]);

  const state: SketchInteractionState = {
    selectedNode,
    selectedEdge,
    selectedNodes,
    selectedEdges,
    draggingNode,
    isPanning,
    isSelecting,
    resizingNode,
    editingNode,
    connectingFrom,
    connectionPreview,
    hoveredNode,
    isDragOver,
    selectionBox,
    viewportOffset,
    viewportScale,
    contextMenu,
    sketchContextMenu,
    multiSelectContextMenu,
    propsExpanded,
  };

  const actions: SketchInteractionActions = {
    setSelectedNode,
    setSelectedEdge,
    setSelectedNodes,
    setSelectedEdges,
    setEditingNode,
    setHoveredNode,
    setViewportScale,
    setViewportOffset,
    setPropsExpanded,
    setContextMenu,
    handleNodeMouseDown,
    handleConnectionStart,
    handleResizeStart,
    handleSketchMouseDown,
    handleSketchDoubleClick,
    handleEdgeClick,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    addTextNode,
    deleteNode,
    deleteEdge,
    updateNodeText,
    updateNodeProperties,
    updateEdgeProperties,
    handleNodeDoubleClick,
    handleNodeContextMenu,
    closeContextMenu,
    handleSketchContextMenu,
    closeSketchContextMenu,
    closeMultiSelectContextMenu,
    addGroupNode,
    getEdgePath,
    getConnectionPreviewPath,
    renderNodeText,
    setSketchRef,
    copiedNodesRef,
    copiedEdgesRef,
  };

  return [state, actions];
}
