import { useState, useRef, useCallback, useEffect } from 'react';
import { noteCommands } from '../../core/services/tauriCommands';
import { useDropTarget } from '../../core/hooks/useDragDrop';
import { generateId, findTextNodeAtPosition } from '../canvas/canvasHelpers';
import { applyFileDrop } from '../canvas/canvasFileDrop';
import type { CanvasData, CanvasNode, CanvasEdge } from '../../core/types';

// Shape anchor point calculation (canvas-absolute coordinates)
export function getShapeAnchorPoint(node: CanvasNode, side: string): { x: number; y: number } {
  const point = getShapePointStatic(node, side, 2);
  return {
    x: node.x + point.x,
    y: node.y + point.y,
  };
}

// Get shape vertex/edge midpoint in node-local coordinates (static version, no hook dependency)
export function getShapePointStatic(node: CanvasNode, side: string, strokeWidth: number = 2): { x: number; y: number } {
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
export function getHandlePosition(node: CanvasNode, side: string, isSelected: boolean): { left: number; top: number } {
  const strokeWidth = isSelected ? 3 : 2;
  const point = getShapePointStatic(node, side, strokeWidth);
  const halfHandle = 7; // Handle size is 14px
  return {
    left: point.x - halfHandle,
    top: point.y - halfHandle,
  };
}

export interface UseCanvasInteractionArgs {
  data: CanvasData;
  onChange: (data: CanvasData) => void;
  readOnly: boolean;
  notePath?: string;
  canvasRef: React.RefObject<HTMLDivElement | null>;
}

export interface CanvasInteractionState {
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
  propsExpanded: boolean;
}

export interface CanvasInteractionActions {
  setSelectedNode: (id: string | null) => void;
  setSelectedEdge: (id: string | null) => void;
  setSelectedNodes: (ids: string[]) => void;
  setSelectedEdges: (ids: string[]) => void;
  setEditingNode: (id: string | null) => void;
  setHoveredNode: (id: string | null) => void;
  setViewportScale: React.Dispatch<React.SetStateAction<number>>;
  setPropsExpanded: React.Dispatch<React.SetStateAction<boolean>>;
  setContextMenu: (menu: { x: number; y: number; nodeId: string } | null) => void;
  handleNodeMouseDown: (e: React.MouseEvent, nodeId: string) => void;
  handleConnectionStart: (e: React.MouseEvent, nodeId: string, side: 'top' | 'right' | 'bottom' | 'left') => void;
  handleResizeStart: (e: React.MouseEvent, nodeId: string, handle: 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw') => void;
  handleCanvasMouseDown: (e: React.MouseEvent) => void;
  handleCanvasDoubleClick: (e: React.MouseEvent) => void;
  handleEdgeClick: (e: React.MouseEvent, edgeId: string) => void;
  handleDragOver: (e: React.DragEvent) => void;
  handleDragLeave: (e: React.DragEvent) => void;
  handleDrop: (e: React.DragEvent) => void;
  addTextNode: () => void;
  deleteNode: (nodeId: string) => void;
  deleteEdge: (edgeId: string) => void;
  updateNodeText: (nodeId: string, text: string) => void;
  updateNodeProperties: (nodeId: string, properties: Partial<CanvasNode>) => void;
  updateEdgeProperties: (edgeId: string, properties: Partial<CanvasEdge>) => void;
  handleNodeDoubleClick: (e: React.MouseEvent, nodeId: string) => void;
  handleNodeContextMenu: (e: React.MouseEvent, nodeId: string) => void;
  closeContextMenu: () => void;
  getEdgePath: (edge: CanvasEdge) => string;
  getConnectionPreviewPath: () => string;
  renderNodeText: (text: string) => string;
  setCanvasRef: (el: HTMLDivElement | null) => void;
  copiedNodesRef: React.MutableRefObject<CanvasNode[]>;
  copiedEdgesRef: React.MutableRefObject<CanvasEdge[]>;
}

export function useCanvasInteraction({
  data,
  onChange,
  readOnly,
  notePath,
  canvasRef,
}: UseCanvasInteractionArgs): [CanvasInteractionState, CanvasInteractionActions] {
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

  const copiedNodesRef = useRef<CanvasNode[]>([]);
  const copiedEdgesRef = useRef<CanvasEdge[]>([]);

  const initializedRef = useRef(false);
  const dataRef = useRef<CanvasData>(data);

  // Double-click detection via mousedown
  const lastNodeClickRef = useRef<{ nodeId: string; time: number } | null>(null);
  const DOUBLE_CLICK_THRESHOLD = 350;

  // Keep dataRef in sync with data
  useEffect(() => {
    dataRef.current = data;
  }, [data]);

  const handleNodeMouseDown = useCallback((e: React.MouseEvent, nodeId: string) => {
    if (readOnly) return;

    const target = e.target as HTMLElement;
    const isTextarea = target.tagName === 'TEXTAREA';

    e.stopPropagation();

    if (editingNode && editingNode !== nodeId) {
      setEditingNode(null);
    }

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

      setSelectedNode(nodeId);
      setSelectedEdge(null);
      setPendingDrag({ nodeId, x: e.clientX, y: e.clientY });
    } else if (e.button === 0 && isTextarea) {
      setSelectedNode(nodeId);
      setSelectedEdge(null);
    }
  }, [readOnly, editingNode, data.nodes]);

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

  const handleCanvasMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button === 0 && !draggingNode) {
      if (editingNode) {
        setEditingNode(null);
      }

      if (connectingFrom) {
        setConnectingFrom(null);
        setConnectionPreview(null);
      } else if (e.shiftKey) {
        const rect = canvasRef.current?.getBoundingClientRect();
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
  }, [draggingNode, connectingFrom, viewportOffset, viewportScale, editingNode, canvasRef]);

  const handleCanvasDoubleClick = useCallback((e: React.MouseEvent) => {
    if (readOnly || !canvasRef.current) return;
    e.stopPropagation();

    const rect = canvasRef.current.getBoundingClientRect();
    const x = (e.clientX - rect.left - viewportOffset.x) / viewportScale;
    const y = (e.clientY - rect.top - viewportOffset.y) / viewportScale;

    const newNode: CanvasNode = {
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
  }, [readOnly, data, onChange, viewportOffset, viewportScale, canvasRef]);

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

      const updatedNodes = data.nodes.map(node =>
        node.id === draggingNode
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
    } else if (isSelecting && selectionStart && canvasRef.current) {
      const rect = canvasRef.current.getBoundingClientRect();
      const x = (e.clientX - rect.left - viewportOffset.x) / viewportScale;
      const y = (e.clientY - rect.top - viewportOffset.y) / viewportScale;

      const boxX = Math.min(selectionStart.x, x);
      const boxY = Math.min(selectionStart.y, y);
      const boxWidth = Math.abs(x - selectionStart.x);
      const boxHeight = Math.abs(y - selectionStart.y);

      setSelectionBox({ x: boxX, y: boxY, width: boxWidth, height: boxHeight });
    } else if (connectingFrom && canvasRef.current) {
      const rect = canvasRef.current.getBoundingClientRect();
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
  }, [pendingDrag, resizingNode, resizeStart, resizeHandle, draggingNode, dragStart, isPanning, panStart, isSelecting, selectionStart, data, onChange, viewportScale, connectingFrom, viewportOffset, canvasRef]);

  const handleMouseUp = useCallback((e: MouseEvent) => {
    if (pendingDrag) {
      setPendingDrag(null);
    }

    if (connectingFrom && canvasRef.current) {
      const rect = canvasRef.current.getBoundingClientRect();
      const x = (e.clientX - rect.left - viewportOffset.x) / viewportScale;
      const y = (e.clientY - rect.top - viewportOffset.y) / viewportScale;

      let targetNode: CanvasNode | null = null;
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
        const newEdge: CanvasEdge = {
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
      const getNodeVisualBounds = (node: CanvasNode) => {
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
  }, [pendingDrag, connectingFrom, isSelecting, selectionBox, data, onChange, viewportOffset, viewportScale, canvasRef]);

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

  useEffect(() => {
    viewportOffsetRef.current = viewportOffset;
    viewportScaleRef.current = viewportScale;
    onChangeRef.current = onChange;
  }, [viewportOffset, viewportScale, onChange]);

  // Handle Tauri native drop events - stable callback using refs
  const handleNativeFileDrop = useCallback((importedPaths: string[], position?: { x: number; y: number }) => {
    if (readOnly || !canvasRef.current) return;

    let dropX = 100;
    let dropY = 100;

    if (position && canvasRef.current) {
      const rect = canvasRef.current.getBoundingClientRect();
      dropX = (position.x - rect.left - viewportOffsetRef.current.x) / viewportScaleRef.current;
      dropY = (position.y - rect.top - viewportOffsetRef.current.y) / viewportScaleRef.current;
    }

    const currentData = dataRef.current;
    const targetTextNode = findTextNodeAtPosition(currentData.nodes, dropX, dropY);
    const files = importedPaths.map(p => {
      const name = p.split(/[/\\]/).pop() || '';
      return { name, path: p };
    });

    onChangeRef.current(applyFileDrop(currentData, files, dropX, dropY, targetTextNode));
  }, [readOnly, canvasRef]);

  // Register drop target for Tauri native events
  const dropTargetRef = useDropTarget(
    `canvas-editor-${notePath || 'unknown'}`,
    notePath ?? null,
    handleNativeFileDrop
  );
  // Combine canvasRef and dropTargetRef
  const setCanvasRef = useCallback((el: HTMLDivElement | null) => {
    (canvasRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
    dropTargetRef(el);
  }, [dropTargetRef, canvasRef]);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    if (readOnly || !notePath || !canvasRef.current) return;
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);

    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;

    const rect = canvasRef.current.getBoundingClientRect();
    const dropX = (e.clientX - rect.left - viewportOffset.x) / viewportScale;
    const dropY = (e.clientY - rect.top - viewportOffset.y) / viewportScale;

    const importedFiles: { name: string; path: string }[] = [];
    for (const file of files) {
      try {
        const filePath = (file as any).path;
        if (!filePath) continue;
        const attachmentPath = await noteCommands.importAttachment(filePath, notePath);
        importedFiles.push({ name: file.name, path: attachmentPath });
      } catch (err) {
        console.error('Failed to import attachment:', err);
      }
    }

    if (importedFiles.length === 0) return;

    const currentData = dataRef.current;
    const targetTextNode = findTextNodeAtPosition(currentData.nodes, dropX, dropY);
    onChange(applyFileDrop(currentData, importedFiles, dropX, dropY, targetTextNode));
  }, [readOnly, notePath, onChange, viewportOffset, viewportScale, canvasRef]);

  // Register mouse/keyboard event listeners
  useEffect(() => {
    if (pendingDrag || draggingNode || isPanning || isSelecting || connectingFrom || resizingNode) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      if (draggingNode || isPanning || isSelecting || resizingNode) {
        document.body.classList.add('canvas-dragging');
      }
      return () => {
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
        document.body.classList.remove('canvas-dragging');
      };
    }
  }, [pendingDrag, draggingNode, isPanning, isSelecting, connectingFrom, resizingNode, handleMouseMove, handleMouseUp]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas) {
      canvas.addEventListener('wheel', handleWheel, { passive: false });
      return () => canvas.removeEventListener('wheel', handleWheel);
    }
  }, [handleWheel, canvasRef]);

  // Fit all nodes in viewport when canvas loads
  useEffect(() => {
    if (initializedRef.current) return;
    if (!canvasRef.current || data.nodes.length === 0) return;

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
    const viewportWidth = canvasRef.current.clientWidth;
    const viewportHeight = canvasRef.current.clientHeight;

    const scaleX = viewportWidth / contentWidth;
    const scaleY = viewportHeight / contentHeight;
    const scale = Math.min(scaleX, scaleY, 1);

    const offsetX = (viewportWidth - contentWidth * scale) / 2 - minX * scale;
    const offsetY = (viewportHeight - contentHeight * scale) / 2 - minY * scale;

    setViewportScale(scale);
    setViewportOffset({ x: offsetX, y: offsetY });
  }, [data.nodes.length, canvasRef]);

  const addTextNode = useCallback(() => {
    if (readOnly) return;
    const newNode: CanvasNode = {
      id: generateId('node'),
      type: 'text',
      x: -viewportOffset.x / viewportScale + 100,
      y: -viewportOffset.y / viewportScale + 100,
      width: 200,
      height: 100,
      text: '',
    };
    onChange({ ...data, nodes: [...data.nodes, newNode] });
  }, [data, onChange, readOnly, viewportOffset, viewportScale]);

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
    setSelectedEdge(edgeId);
    setSelectedNode(null);
  }, [readOnly]);

  const deleteEdge = useCallback((edgeId: string) => {
    if (readOnly) return;
    const updatedEdges = data.edges.filter(e => e.id !== edgeId);
    onChange({ ...data, edges: updatedEdges });
    setSelectedEdge(null);
  }, [data, onChange, readOnly]);

  const updateEdgeProperties = useCallback((edgeId: string, properties: Partial<CanvasEdge>) => {
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
    if (node && node.type === 'text') {
      setEditingNode(nodeId);
    }
  }, [readOnly, data.nodes]);

  const handleNodeContextMenu = useCallback((e: React.MouseEvent, nodeId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, nodeId });
    setSelectedNode(nodeId);
  }, []);

  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  // Simple markdown -> HTML renderer for view mode
  const renderNodeText = useCallback((text: string): string => {
    if (!text) return '';

    const escapeHtml = (s: string) =>
      s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    const applyInlineFormatting = (line: string): string => {
      let result = escapeHtml(line);
      result = result.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
      result = result.replace(/\*(.+?)\*/g, '<em>$1</em>');
      result = result.replace(/\[\[(.+?)\]\]/g, '<span class="canvas-wikilink" data-wikilink="$1">$1</span>');
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
        htmlParts.push(`<strong class="canvas-heading canvas-heading-${headingMatch[1].length}">${content}</strong>`);
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

      const isEditing = document.activeElement?.tagName === 'TEXTAREA';

      if (e.key === 'Escape' && editingNode) {
        setEditingNode(null);
        return;
      }

      if ((e.ctrlKey || e.metaKey) && e.key === 'c' && !isEditing) {
        e.preventDefault();
        const nodesToCopy: CanvasNode[] = [];

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

        const newNodes: CanvasNode[] = copiedNodesRef.current.map(n => {
          const newId = generateId('node');
          idMap.set(n.id, newId);
          return { ...n, id: newId, x: n.x + offset, y: n.y + offset };
        });

        const newEdges: CanvasEdge[] = copiedEdgesRef.current.map(e => ({
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
  }, [readOnly, selectedNode, selectedEdge, selectedNodes, selectedEdges, data, onChange, deleteNode, deleteEdge, editingNode]);

  const updateNodeProperties = useCallback((nodeId: string, properties: Partial<CanvasNode>) => {
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

  const getEdgePath = useCallback((edge: CanvasEdge): string => {
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

  const state: CanvasInteractionState = {
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
    propsExpanded,
  };

  const actions: CanvasInteractionActions = {
    setSelectedNode,
    setSelectedEdge,
    setSelectedNodes,
    setSelectedEdges,
    setEditingNode,
    setHoveredNode,
    setViewportScale,
    setPropsExpanded,
    setContextMenu,
    handleNodeMouseDown,
    handleConnectionStart,
    handleResizeStart,
    handleCanvasMouseDown,
    handleCanvasDoubleClick,
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
    getEdgePath,
    getConnectionPreviewPath,
    renderNodeText,
    setCanvasRef,
    copiedNodesRef,
    copiedEdgesRef,
  };

  return [state, actions];
}
