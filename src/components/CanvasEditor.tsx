import { useState, useRef, useCallback, useEffect } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { noteCommands, utilCommands } from '../services/tauriCommands';
import { useDropTarget } from '../hooks/useDragDrop';
import { hoverActions } from '../stores/zustand/hoverStore';
import { useSettingsStore } from '../stores/zustand/settingsStore';
import { t, tf } from '../utils/i18n';
import type { CanvasData, CanvasNode, CanvasEdge, CanvasSelection } from '../types';

// Collision-resistant unique ID generator
let idCounter = 0;
function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${(++idCounter).toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp'];

// Shape definitions for node styling (shared between properties panel and context menu)
const CANVAS_SHAPES = [
  { value: 'process' as const },
  { value: 'terminal' as const },
  { value: 'decision' as const },
  { value: 'io' as const },
  { value: 'subroutine' as const },
  { value: 'database' as const },
];

// Shape icons - visual representations for intuitive selection
const CANVAS_SHAPE_ICONS: Record<string, React.ReactNode> = {
  process: (
    <svg width="32" height="20" viewBox="0 0 32 20">
      <rect x="1" y="1" width="30" height="18" rx="2" fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  ),
  terminal: (
    <svg width="32" height="20" viewBox="0 0 32 20">
      <rect x="1" y="1" width="30" height="18" rx="9" fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  ),
  decision: (
    <svg width="32" height="20" viewBox="0 0 32 20">
      <polygon points="16,1 31,10 16,19 1,10" fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  ),
  io: (
    <svg width="32" height="20" viewBox="0 0 32 20">
      <polygon points="6,1 31,1 26,19 1,19" fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  ),
  subroutine: (
    <svg width="32" height="20" viewBox="0 0 32 20">
      <rect x="1" y="1" width="30" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <line x1="7" y1="1" x2="7" y2="19" stroke="currentColor" strokeWidth="1.2" />
      <line x1="25" y1="1" x2="25" y2="19" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  ),
  database: (
    <svg width="32" height="20" viewBox="0 0 32 20">
      <ellipse cx="16" cy="4" rx="14" ry="3" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M2,4 L2,16 C2,18.5 8,20 16,20 C24,20 30,18.5 30,16 L30,4" fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  ),
};

// Shared logic: find text node at canvas coordinates
function findTextNodeAtPosition(nodes: CanvasNode[], x: number, y: number): CanvasNode | null {
  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i];
    if (node.type !== 'text') continue;
    if (x >= node.x && x <= node.x + node.width &&
        y >= node.y && y <= node.y + node.height) {
      return node;
    }
  }
  return null;
}

// Shared logic: insert wikilinks into a text node or create file nodes
function applyFileDrop(
  currentData: CanvasData,
  files: { name: string; path: string }[],
  dropX: number,
  dropY: number,
  targetTextNode: CanvasNode | null,
): CanvasData {
  if (targetTextNode) {
    const wikilinks = files.map(f => `[[${f.name}]]`).join('\n');
    const newText = (targetTextNode.text || '') + (targetTextNode.text ? '\n' : '') + wikilinks;
    const updatedNodes = currentData.nodes.map(n =>
      n.id === targetTextNode.id ? { ...n, text: newText } : n
    );
    return { ...currentData, nodes: updatedNodes };
  }

  const newNodes: CanvasNode[] = [];
  let offsetY = 0;

  for (const file of files) {
    const ext = file.name.split('.').pop()?.toLowerCase() || '';
    const isImage = IMAGE_EXTS.includes(ext);

    newNodes.push({
      id: generateId('node'),
      type: 'file',
      x: dropX,
      y: dropY + offsetY,
      width: isImage ? 250 : 240,
      height: isImage ? 200 : 160,
      file: file.path,
      text: file.name,
    });

    offsetY += (isImage ? 220 : 180);
  }

  return { ...currentData, nodes: [...currentData.nodes, ...newNodes] };
}

interface CanvasEditorProps {
  data: CanvasData;
  onChange: (data: CanvasData) => void;
  readOnly?: boolean;
  notePath?: string;
  onSelectionChange?: (selection: CanvasSelection | null) => void;
}

function CanvasEditor({ data, onChange, readOnly = false, notePath, onSelectionChange }: CanvasEditorProps) {
  const openHoverFile = hoverActions.open;
  const theme = useSettingsStore((s) => s.theme);
  const language = useSettingsStore((s) => s.language);

  // Determine effective theme (considering system preference)
  const getEffectiveTheme = () => {
    if (theme === 'system') {
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    return theme;
  };
  const effectiveTheme = getEffectiveTheme();
  const defaultNodeColor = effectiveTheme === 'light' ? '#e8e8e8' : '#2d2d2d';
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
  const [draggingNode, setDraggingNode] = useState<string | null>(null);
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(null);
  const [pendingDrag, setPendingDrag] = useState<{ nodeId: string; x: number; y: number } | null>(null);
  const DRAG_THRESHOLD = 5; // pixels before drag actually starts
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
  const [propsExpanded, setPropsExpanded] = useState(false); // Properties panel collapsed by default
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; nodeId: string } | null>(null);

  const copiedNodesRef = useRef<CanvasNode[]>([]);
  const copiedEdgesRef = useRef<CanvasEdge[]>([]);

  const canvasRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const initializedRef = useRef(false);
  const dataRef = useRef<CanvasData>(data);

  // Double-click detection via mousedown (more reliable than onDoubleClick with drag logic)
  const lastNodeClickRef = useRef<{ nodeId: string; time: number } | null>(null);
  const DOUBLE_CLICK_THRESHOLD = 350; // ms

  // Keep dataRef in sync with data
  useEffect(() => {
    dataRef.current = data;
  }, [data]);

  const handleNodeMouseDown = useCallback((e: React.MouseEvent, nodeId: string) => {
    if (readOnly) return;

    const target = e.target as HTMLElement;
    const isTextarea = target.tagName === 'TEXTAREA';

    e.stopPropagation();

    // If clicking on a different node while editing, exit edit mode
    if (editingNode && editingNode !== nodeId) {
      setEditingNode(null);
    }

    if (e.button === 0 && !isTextarea) {
      // Double-click detection in mousedown (more reliable with drag logic)
      const now = Date.now();
      const lastClick = lastNodeClickRef.current;

      if (lastClick && lastClick.nodeId === nodeId && now - lastClick.time < DOUBLE_CLICK_THRESHOLD) {
        // Double-click detected - enter edit mode for text nodes
        const node = data.nodes.find(n => n.id === nodeId);
        if (node && node.type === 'text') {
          setEditingNode(nodeId);
          lastNodeClickRef.current = null;
          return; // Don't start drag on double-click
        }
      }

      lastNodeClickRef.current = { nodeId, time: now };

      setSelectedNode(nodeId);
      setSelectedEdge(null);
      // Start pending drag instead of immediate drag (threshold will be checked in mousemove)
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
      // Exit edit mode when clicking on empty canvas
      if (editingNode) {
        setEditingNode(null);
      }

      if (connectingFrom) {
        // Cancel connection
        setConnectingFrom(null);
        setConnectionPreview(null);
      } else if (e.shiftKey) {
        // Shift + Left click - start selection box
        const rect = canvasRef.current?.getBoundingClientRect();
        if (rect) {
          const x = (e.clientX - rect.left - viewportOffset.x) / viewportScale;
          const y = (e.clientY - rect.top - viewportOffset.y) / viewportScale;
          setIsSelecting(true);
          setSelectionStart({ x, y });
          setSelectionBox(null);
        }
      } else {
        // Left click - start panning
        e.preventDefault();
        setIsPanning(true);
        setPanStart({ x: e.clientX, y: e.clientY });
        // Clear multi-selection when clicking on empty canvas
        setSelectedNodes([]);
        setSelectedEdges([]);
      }
      setSelectedNode(null);
      setSelectedEdge(null);
    }
  }, [draggingNode, connectingFrom, viewportOffset, viewportScale, editingNode]);

  const handleCanvasDoubleClick = useCallback((e: React.MouseEvent) => {
    if (readOnly || !canvasRef.current) return;
    e.stopPropagation();

    // Calculate click position in canvas coordinates
    const rect = canvasRef.current.getBoundingClientRect();
    const x = (e.clientX - rect.left - viewportOffset.x) / viewportScale;
    const y = (e.clientY - rect.top - viewportOffset.y) / viewportScale;

    // Create new text node at double-click position
    const newNode: CanvasNode = {
      id: generateId('node'),
      type: 'text',
      x: x - 100, // Center the node on cursor
      y: y - 50,
      width: 200,
      height: 100,
      text: '',
    };

    onChange({ ...data, nodes: [...data.nodes, newNode] });
    setSelectedNode(newNode.id);
    setEditingNode(newNode.id);
  }, [readOnly, data, onChange, viewportOffset, viewportScale]);

  const handleMouseMove = useCallback((e: MouseEvent) => {
    // Check pending drag threshold before starting actual drag
    if (pendingDrag && !draggingNode) {
      const dx = Math.abs(e.clientX - pendingDrag.x);
      const dy = Math.abs(e.clientY - pendingDrag.y);
      if (dx >= DRAG_THRESHOLD || dy >= DRAG_THRESHOLD) {
        // Threshold exceeded — promote to actual drag
        setDraggingNode(pendingDrag.nodeId);
        setDragStart({ x: e.clientX, y: e.clientY });
        setPendingDrag(null);
      }
      return; // Don't process other moves while pending
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

        // Handle horizontal resize
        if (resizeHandle.includes('e')) {
          newWidth = Math.max(minWidth, resizeStart.width + dx);
        } else if (resizeHandle.includes('w')) {
          newWidth = Math.max(minWidth, resizeStart.width - dx);
          newX = resizeStart.nodeX + (resizeStart.width - newWidth);
        }

        // Handle vertical resize
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

      // Fixed sensitivity (0.7) - consistent feel regardless of zoom level
      const sensitivity = 0.7;
      setViewportOffset(prev => ({
        x: prev.x + dx * sensitivity,
        y: prev.y + dy * sensitivity
      }));
      setPanStart({ x: e.clientX, y: e.clientY });
    } else if (isSelecting && selectionStart && canvasRef.current) {
      // Update selection box
      const rect = canvasRef.current.getBoundingClientRect();
      const x = (e.clientX - rect.left - viewportOffset.x) / viewportScale;
      const y = (e.clientY - rect.top - viewportOffset.y) / viewportScale;

      const boxX = Math.min(selectionStart.x, x);
      const boxY = Math.min(selectionStart.y, y);
      const boxWidth = Math.abs(x - selectionStart.x);
      const boxHeight = Math.abs(y - selectionStart.y);

      setSelectionBox({ x: boxX, y: boxY, width: boxWidth, height: boxHeight });
    } else if (connectingFrom && canvasRef.current) {
      // Update connection preview
      const rect = canvasRef.current.getBoundingClientRect();
      const x = (e.clientX - rect.left - viewportOffset.x) / viewportScale;
      const y = (e.clientY - rect.top - viewportOffset.y) / viewportScale;
      setConnectionPreview({ x, y });

      // Check if hovering over a node handle to show visual feedback
      data.nodes.forEach(node => {
        const isOverNode = x >= node.x && x <= node.x + node.width && y >= node.y && y <= node.y + node.height;
        if (isOverNode && node.id !== connectingFrom.nodeId) {
          setHoveredNode(node.id);
        }
      });
    }
  }, [pendingDrag, resizingNode, resizeStart, resizeHandle, draggingNode, dragStart, isPanning, panStart, isSelecting, selectionStart, data, onChange, viewportScale, connectingFrom, viewportOffset]);

  const handleMouseUp = useCallback((e: MouseEvent) => {
    // If pending drag never exceeded threshold, it was a click — clear pending state
    if (pendingDrag) {
      setPendingDrag(null);
    }

    // If we were connecting, try to complete the connection
    if (connectingFrom && canvasRef.current) {
      const rect = canvasRef.current.getBoundingClientRect();
      const x = (e.clientX - rect.left - viewportOffset.x) / viewportScale;
      const y = (e.clientY - rect.top - viewportOffset.y) / viewportScale;

      // Find target node and side
      let targetNode: CanvasNode | null = null;
      let targetSide: 'top' | 'right' | 'bottom' | 'left' | null = null;
      const connectionTolerance = 30; // Expand detection area for easier connection

      for (const node of data.nodes) {
        if (node.id === connectingFrom.nodeId) continue;

        // Check if mouse is over or near this node (with tolerance)
        if (x >= node.x - connectionTolerance && x <= node.x + node.width + connectionTolerance &&
            y >= node.y - connectionTolerance && y <= node.y + node.height + connectionTolerance) {
          targetNode = node;

          // Determine which side is closest
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

      // Create edge if valid target found
      if (targetNode && targetSide) {
        const newEdge: CanvasEdge = {
          id: generateId('edge'),
          fromNode: connectingFrom.nodeId,
          fromSide: connectingFrom.side,
          toNode: targetNode.id,
          toSide: targetSide,
        };

        // Remove existing edge between the same two nodes (in either direction)
        // This ensures only one arrow exists between any pair of nodes
        const filteredEdges = data.edges.filter(edge => {
          const sameDirection = edge.fromNode === connectingFrom.nodeId && edge.toNode === targetNode.id;
          const reverseDirection = edge.fromNode === targetNode.id && edge.toNode === connectingFrom.nodeId;
          return !sameDirection && !reverseDirection;
        });

        onChange({ ...data, edges: [...filteredEdges, newEdge] });
      }
    }

    // Handle selection box
    if (isSelecting && selectionBox) {
      // Get visual bounds for special shapes
      const getNodeVisualBounds = (node: CanvasNode) => {
        const shape = node.shape || 'process';
        let left = node.x;
        let top = node.y;
        let right = node.x + node.width;
        let bottom = node.y + node.height;

        // Adjust bounds based on shape
        if (shape === 'database') {
          // Database has 16px ellipse on top and bottom, contained within bounds
          // No adjustment needed - visual is within bounding box
        } else if (shape === 'decision') {
          // Diamond shape - vertices at center of each edge
          // Visual bounds same as bounding box
        } else if (shape === 'io') {
          // Parallelogram with 15% skew
          // Visual bounds same as bounding box
        }

        return { left, top, right, bottom };
      };

      const selectedNodeIds = data.nodes
        .filter(node => {
          // Check if node intersects with selection box using visual bounds
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

      // Check which edges intersect with the selection box
      const selectedEdgeIds = data.edges
        .filter(edge => {
          const fromNode = data.nodes.find(n => n.id === edge.fromNode);
          const toNode = data.nodes.find(n => n.id === edge.toNode);
          if (!fromNode || !toNode) return false;

          // Use shape-aware anchor points for edge selection
          const from = getShapeAnchorPoint(fromNode, edge.fromSide);
          const to = getShapeAnchorPoint(toNode, edge.toSide);

          // Check if edge endpoints or midpoint are in the selection box
          const boxRight = selectionBox.x + selectionBox.width;
          const boxBottom = selectionBox.y + selectionBox.height;

          const isPointInBox = (p: { x: number; y: number }) =>
            p.x >= selectionBox.x && p.x <= boxRight &&
            p.y >= selectionBox.y && p.y <= boxBottom;

          // Check endpoints and several sample points along the edge
          if (isPointInBox(from) || isPointInBox(to)) return true;

          // Sample points along the line (10 points)
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
      // Simple click on empty space - clear multi-selection
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
    // Don't clear hoveredNode here - let mouseEnter/mouseLeave handle it naturally
    // This prevents flickering when mouse is still over a node after mouseUp
    setResizingNode(null);
    setResizeHandle(null);
    setResizeStart(null);
  }, [pendingDrag, connectingFrom, isSelecting, selectionBox, data, onChange, viewportOffset, viewportScale]);

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
  }, [readOnly]);

  // Register drop target for Tauri native events - handleNativeFileDrop is now stable
  const dropTargetRef = useDropTarget(
    `canvas-editor-${notePath || 'unknown'}`,
    notePath ?? null,
    handleNativeFileDrop
  );
  // Combine canvasRef and dropTargetRef - both should now be stable
  const setCanvasRef = useCallback((el: HTMLDivElement | null) => {
    canvasRef.current = el;
    dropTargetRef(el);
  }, [dropTargetRef]);

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

    // Import all files first
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
  }, [readOnly, notePath, onChange, viewportOffset, viewportScale]);

  useEffect(() => {
    if (pendingDrag || draggingNode || isPanning || isSelecting || connectingFrom || resizingNode) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      // Add body class to prevent text selection globally (only when actually dragging)
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
  }, [handleWheel]);


  // Fit all nodes in viewport when canvas loads (runs only once when nodes first become available)
  useEffect(() => {
    // Only run once when nodes first become available
    if (initializedRef.current) return;
    if (!canvasRef.current || data.nodes.length === 0) return;

    initializedRef.current = true;

    // Calculate bounding box of all nodes
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    data.nodes.forEach(node => {
      minX = Math.min(minX, node.x);
      minY = Math.min(minY, node.y);
      maxX = Math.max(maxX, node.x + node.width);
      maxY = Math.max(maxY, node.y + node.height);
    });

    // Add padding
    const padding = 50;
    minX -= padding;
    minY -= padding;
    maxX += padding;
    maxY += padding;

    const contentWidth = maxX - minX;
    const contentHeight = maxY - minY;
    const viewportWidth = canvasRef.current.clientWidth;
    const viewportHeight = canvasRef.current.clientHeight;

    // Calculate scale to fit all content
    const scaleX = viewportWidth / contentWidth;
    const scaleY = viewportHeight / contentHeight;
    const scale = Math.min(scaleX, scaleY, 1); // Don't zoom in more than 100%

    // Center the content
    const offsetX = (viewportWidth - contentWidth * scale) / 2 - minX * scale;
    const offsetY = (viewportHeight - contentHeight * scale) / 2 - minY * scale;

    setViewportScale(scale);
    setViewportOffset({ x: offsetX, y: offsetY });
    // Only depend on nodesLengthRef to check if nodes became available, not on the entire nodes array
  }, [data.nodes.length]);

  const addTextNode = useCallback(() => {
    if (readOnly) return;
    const newNode: CanvasNode = {
      id: generateId('node'),
      type: 'text',
      x: -viewportOffset.x / viewportScale + 100,
      y: -viewportOffset.y / viewportScale + 100,
      width: 200,
      height: 100,
      text: t('canvasNewNode', language),
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

  // Double-click on a text node → enter edit mode
  const handleNodeDoubleClick = useCallback((e: React.MouseEvent, nodeId: string) => {
    if (readOnly) return;
    e.stopPropagation();
    const node = data.nodes.find(n => n.id === nodeId);
    if (node && node.type === 'text') {
      setEditingNode(nodeId);
    }
  }, [readOnly, data.nodes]);

  // Context menu on text node
  const handleNodeContextMenu = useCallback((e: React.MouseEvent, nodeId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, nodeId });
    setSelectedNode(nodeId);
  }, []);

  // Close context menu
  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  // Simple markdown → HTML renderer for view mode
  const renderNodeText = useCallback((text: string): string => {
    if (!text) return '';

    const escapeHtml = (s: string) =>
      s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    const applyInlineFormatting = (line: string): string => {
      let result = escapeHtml(line);
      // Bold: **text**
      result = result.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
      // Italic: *text*
      result = result.replace(/\*(.+?)\*/g, '<em>$1</em>');
      // Wikilink: [[text]] — clickable with data attribute
      result = result.replace(/\[\[(.+?)\]\]/g, '<span class="canvas-wikilink" data-wikilink="$1">$1</span>');
      return result;
    };

    const lines = text.split('\n');
    const htmlParts: string[] = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      // Heading: # ## ###
      const headingMatch = line.match(/^(#{1,3})\s+(.+)$/);
      if (headingMatch) {
        const content = applyInlineFormatting(headingMatch[2]);
        htmlParts.push(`<strong class="canvas-heading canvas-heading-${headingMatch[1].length}">${content}</strong>`);
        i++;
        continue;
      }

      // Blockquote: > text
      if (line.startsWith('> ')) {
        const content = applyInlineFormatting(line.slice(2));
        htmlParts.push(`<blockquote>${content}</blockquote>`);
        i++;
        continue;
      }

      // Unordered list: - item
      if (/^[-*]\s+/.test(line)) {
        const items: string[] = [];
        while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
          items.push(`<li>${applyInlineFormatting(lines[i].replace(/^[-*]\s+/, ''))}</li>`);
          i++;
        }
        htmlParts.push(`<ul>${items.join('')}</ul>`);
        continue;
      }

      // Ordered list: 1. item
      if (/^\d+\.\s+/.test(line)) {
        const items: string[] = [];
        while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
          items.push(`<li>${applyInlineFormatting(lines[i].replace(/^\d+\.\s+/, ''))}</li>`);
          i++;
        }
        htmlParts.push(`<ol>${items.join('')}</ol>`);
        continue;
      }

      // Empty line
      if (line.trim() === '') {
        i++;
        continue;
      }

      // Normal paragraph
      htmlParts.push(`<p>${applyInlineFormatting(line)}</p>`);
      i++;
    }

    return htmlParts.join('');
  }, []);


  // Handle keyboard shortcuts: Delete, Ctrl+C, Ctrl+V, Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (readOnly) return;

      const isEditing = document.activeElement?.tagName === 'TEXTAREA';

      // Escape: exit edit mode
      if (e.key === 'Escape' && editingNode) {
        setEditingNode(null);
        return;
      }

      // Ctrl+C: copy nodes
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
          // Copy edges where both endpoints are in the copied set
          const copiedIds = new Set(nodesToCopy.map(n => n.id));
          copiedEdgesRef.current = data.edges
            .filter(e => copiedIds.has(e.fromNode) && copiedIds.has(e.toNode))
            .map(e => ({ ...e }));
        }
        return;
      }

      // Ctrl+V: paste nodes
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

        // Update copied refs so next paste offsets further
        copiedNodesRef.current = newNodes.map(n => ({ ...n }));
        copiedEdgesRef.current = newEdges.map(e => ({ ...e }));

        // Select the pasted nodes
        setSelectedNodes(newNodes.map(n => n.id));
        setSelectedNode(null);
        setSelectedEdge(null);
        setSelectedEdges([]);
        return;
      }

      // Delete key: remove selected nodes/edges (only when not editing text)
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
      // Explicitly preserve position and size when updating properties like shape/color
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

  // ============================================================================
  // UNIFIED SHAPE GEOMETRY SYSTEM
  // All handle positions and anchor points use the same calculation logic
  // ============================================================================

  // Get shape vertex/edge midpoint in node-local coordinates
  // This is the single source of truth for all shape geometry
  const getShapePoint = useCallback((node: CanvasNode, side: string, strokeWidth: number = 2) => {
    const shape = node.shape || 'process';
    const w = node.width;
    const h = node.height;
    const inset = strokeWidth / 2;

    switch (shape) {
      case 'decision': {
        // Diamond: vertices at midpoints of bounding box edges, inset by stroke
        // SVG polygon: top(w/2, inset), right(w-inset, h/2), bottom(w/2, h-inset), left(inset, h/2)
        switch (side) {
          case 'top': return { x: w / 2, y: inset };
          case 'right': return { x: w - inset, y: h / 2 };
          case 'bottom': return { x: w / 2, y: h - inset };
          case 'left': return { x: inset, y: h / 2 };
          default: return { x: w / 2, y: h / 2 };
        }
      }

      case 'io': {
        // Parallelogram: skewed 15% to the right
        // SVG polygon: TL(skew+inset, inset), TR(w-inset, inset), BR(w*0.85-inset, h-inset), BL(inset, h-inset)
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
        // Cylinder: handles at outer edges of ellipses
        switch (side) {
          case 'top': return { x: w / 2, y: 0 }; // Top of top ellipse
          case 'bottom': return { x: w / 2, y: h }; // Bottom of bottom ellipse
          case 'left': return { x: 0, y: h / 2 };
          case 'right': return { x: w, y: h / 2 };
          default: return { x: w / 2, y: h / 2 };
        }
      }

      case 'subroutine': {
        // Rectangle with internal lines at 12px from edges
        // Handles at the outer edges (same as rectangle)
        switch (side) {
          case 'top': return { x: w / 2, y: 0 };
          case 'bottom': return { x: w / 2, y: h };
          case 'left': return { x: 0, y: h / 2 };
          case 'right': return { x: w, y: h / 2 };
          default: return { x: w / 2, y: h / 2 };
        }
      }

      case 'terminal': {
        // Rounded rectangle (border-radius: 20px)
        // Handles at the outer edges
        switch (side) {
          case 'top': return { x: w / 2, y: 0 };
          case 'bottom': return { x: w / 2, y: h };
          case 'left': return { x: 0, y: h / 2 };
          case 'right': return { x: w, y: h / 2 };
          default: return { x: w / 2, y: h / 2 };
        }
      }

      case 'process':
      default: {
        // Standard rectangle
        switch (side) {
          case 'top': return { x: w / 2, y: 0 };
          case 'bottom': return { x: w / 2, y: h };
          case 'left': return { x: 0, y: h / 2 };
          case 'right': return { x: w, y: h / 2 };
          default: return { x: w / 2, y: h / 2 };
        }
      }
    }
  }, []);

  // Calculate handle position (node-local coordinates, for inline styles)
  const getHandlePosition = useCallback((node: CanvasNode, side: string, isSelected: boolean) => {
    const strokeWidth = isSelected ? 3 : 2;
    const point = getShapePoint(node, side, strokeWidth);
    const halfHandle = 7; // Handle size is 14px
    return {
      left: point.x - halfHandle,
      top: point.y - halfHandle
    };
  }, [getShapePoint]);

  // Calculate anchor point (absolute canvas coordinates, for arrow connections)
  const getShapeAnchorPoint = useCallback((node: CanvasNode, side: string) => {
    const point = getShapePoint(node, side, 2); // Use base strokeWidth for arrows
    return {
      x: node.x + point.x,
      y: node.y + point.y
    };
  }, []);

  const getEdgePath = useCallback((edge: CanvasEdge): string => {
    const fromNode = data.nodes.find(n => n.id === edge.fromNode);
    const toNode = data.nodes.find(n => n.id === edge.toNode);

    if (!fromNode || !toNode) return '';

    const getAnchorPoint = (node: CanvasNode, side: string) => {
      return getShapeAnchorPoint(node, side);
    };

    const from = getAnchorPoint(fromNode, edge.fromSide);
    const to = getAnchorPoint(toNode, edge.toSide);

    const dx = to.x - from.x;
    const dy = to.y - from.y;

    // Control point offset based on direction
    const distance = Math.sqrt(dx * dx + dy * dy);
    const controlOffset = Math.min(distance * 0.5, 100);

    // Calculate control points based on side direction
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

    // Use shape-aware anchor point calculation
    const startPoint = getShapeAnchorPoint(fromNode, connectingFrom.side);
    const startX = startPoint.x;
    const startY = startPoint.y;

    // Create smooth curve for preview
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

  return (
    <div className="canvas-editor">
      {!readOnly && (
        <div className="canvas-toolbar">
          <div className="canvas-toolbar-hint">Double-click to add node</div>
          <button className="canvas-toolbar-btn" onClick={() => setViewportScale(1)} title={t('canvasResetZoom', language)}>
            {Math.round(viewportScale * 100)}%
          </button>
        </div>
      )}

      <div
        ref={setCanvasRef}
        className={`canvas-viewport${isDragOver ? ' drag-over' : ''}${draggingNode || isPanning || isSelecting || resizingNode ? ' is-dragging' : ''}${isPanning ? ' is-panning' : ''}${isSelecting ? ' is-selecting' : ''}${connectingFrom ? ' is-connecting' : ''}`}
        data-drop-target={`canvas-editor-${notePath || 'unknown'}`}
        onMouseDown={handleCanvasMouseDown}
        onDoubleClick={handleCanvasDoubleClick}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <div
          className="canvas-nodes"
          style={{
            transform: `translate(${viewportOffset.x}px, ${viewportOffset.y}px) scale(${viewportScale})`,
            transformOrigin: '0 0',
          }}
        >
          {data.nodes.map(node => (
            <div
              key={node.id}
              className={`canvas-node${node.type === 'file' ? ' file-node' : ''}${selectedNode === node.id ? ' selected' : ''}${selectedNodes.includes(node.id) ? ' multi-selected' : ''}${editingNode === node.id ? ' editing' : ''}${connectingFrom?.nodeId === node.id ? ' connecting' : ''}${hoveredNode === node.id ? ' hovered' : ''}${node.shape ? ` shape-${node.shape}` : ' shape-process'}`}
              style={{
                left: node.x,
                top: node.y,
                width: node.width,
                height: node.height,
                backgroundColor: (node.shape === 'decision' || node.shape === 'io' || node.shape === 'database') ? 'transparent' : (node.color || defaultNodeColor),
              }}
              onMouseDown={e => handleNodeMouseDown(e, node.id)}
              onMouseEnter={() => setHoveredNode(node.id)}
              onMouseLeave={(e) => {
                // Only clear hover if not moving to a child element (like handles)
                const relatedTarget = e.relatedTarget as HTMLElement | null;
                if (!relatedTarget || !e.currentTarget.contains(relatedTarget)) {
                  setHoveredNode(null);
                }
              }}
              onDoubleClick={e => {
                // Enter edit mode on double-click anywhere on the node (for text nodes)
                if (node.type === 'text') {
                  handleNodeDoubleClick(e, node.id);
                }
              }}
            >
              {/* SVG background for special shapes */}
              {(node.shape === 'decision' || node.shape === 'io' || node.shape === 'database') && (() => {
                const w = node.width;
                const h = node.height;
                const isSelected = selectedNode === node.id || selectedNodes.includes(node.id);
                const strokeWidth = isSelected ? 3 : 2;
                const inset = strokeWidth / 2;

                // Calculate shape points for hit testing
                const decisionPoints = `${w / 2},${inset} ${w - inset},${h / 2} ${w / 2},${h - inset} ${inset},${h / 2}`;
                const ioPoints = `${w * 0.15 + inset},${inset} ${w - inset},${inset} ${w * 0.85 - inset},${h - inset} ${inset},${h - inset}`;

                return (
                  <>
                    {/* Visual SVG (background, non-interactive) */}
                    <svg
                      className="canvas-node-shape-svg"
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
                          fill={node.color || defaultNodeColor}
                          stroke={
                            connectingFrom?.nodeId === node.id
                              ? '#00d4aa'
                              : isSelected || hoveredNode === node.id
                              ? '#00d4aa'
                              : '#555'
                          }
                          strokeWidth={strokeWidth}
                        />
                      ) : node.shape === 'io' ? (
                        <polygon
                          points={ioPoints}
                          fill={node.color || defaultNodeColor}
                          stroke={
                            connectingFrom?.nodeId === node.id
                              ? '#00d4aa'
                              : isSelected || hoveredNode === node.id
                              ? '#00d4aa'
                              : '#555'
                          }
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
                            fill={node.color || defaultNodeColor}
                          />
                          {/* Left side */}
                          <path
                            d={`M ${inset} 16 L ${inset} ${h - 16}`}
                            fill="none"
                            stroke={
                              connectingFrom?.nodeId === node.id
                                ? '#00d4aa'
                                : isSelected || hoveredNode === node.id
                                ? '#00d4aa'
                                : '#555'
                            }
                            strokeWidth={strokeWidth}
                          />
                          {/* Right side */}
                          <path
                            d={`M ${w - inset} 16 L ${w - inset} ${h - 16}`}
                            fill="none"
                            stroke={
                              connectingFrom?.nodeId === node.id
                                ? '#00d4aa'
                                : isSelected || hoveredNode === node.id
                                ? '#00d4aa'
                                : '#555'
                            }
                            strokeWidth={strokeWidth}
                          />
                          {/* Top ellipse */}
                          <ellipse
                            cx={w / 2}
                            cy={16}
                            rx={w / 2 - inset}
                            ry={16 - inset}
                            fill={node.color || defaultNodeColor}
                            stroke={
                              connectingFrom?.nodeId === node.id
                                ? '#00d4aa'
                                : isSelected || hoveredNode === node.id
                                ? '#00d4aa'
                                : '#555'
                            }
                            strokeWidth={strokeWidth}
                          />
                          {/* Bottom ellipse */}
                          <ellipse
                            cx={w / 2}
                            cy={h - 16}
                            rx={w / 2 - inset}
                            ry={16 - inset}
                            fill={node.color || defaultNodeColor}
                            stroke={
                              connectingFrom?.nodeId === node.id
                                ? '#00d4aa'
                                : isSelected || hoveredNode === node.id
                                ? '#00d4aa'
                                : '#555'
                            }
                            strokeWidth={strokeWidth}
                          />
                        </g>
                      )}
                    </svg>
                    {/* Interactive hit area overlay for shape border (allows dragging from border) */}
                    {(node.shape === 'decision' || node.shape === 'io' || node.shape === 'database') && (
                      <svg
                        className="canvas-node-shape-hit-area"
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
              {node.type === 'text' && editingNode === node.id ? (
                <textarea
                  className={`canvas-node-text${node.textAlign === 'center' ? ' text-center' : ''}`}
                  value={node.text || ''}
                  onChange={e => updateNodeText(node.id, e.target.value)}
                  onMouseEnter={() => setHoveredNode(node.id)}
                  onContextMenu={e => handleNodeContextMenu(e, node.id)}
                  onMouseDown={e => {
                    e.stopPropagation();
                  }}
                  onMouseUp={e => {
                    const textarea = e.target as HTMLTextAreaElement;
                    const { selectionStart, selectionEnd } = textarea;
                    if (selectionStart !== selectionEnd && onSelectionChange) {
                      const selectedText = (node.text || '').substring(selectionStart, selectionEnd);
                      onSelectionChange({
                        nodeId: node.id,
                        text: selectedText,
                        from: selectionStart,
                        to: selectionEnd,
                      });
                    } else if (onSelectionChange) {
                      onSelectionChange(null);
                    }
                  }}
                  onSelect={e => {
                    const textarea = e.target as HTMLTextAreaElement;
                    const { selectionStart, selectionEnd } = textarea;
                    if (selectionStart !== selectionEnd && onSelectionChange) {
                      const selectedText = (node.text || '').substring(selectionStart, selectionEnd);
                      onSelectionChange({
                        nodeId: node.id,
                        text: selectedText,
                        from: selectionStart,
                        to: selectionEnd,
                      });
                    }
                  }}
                  onDoubleClick={e => e.stopPropagation()}
                  onKeyDown={e => {
                    // Escape to exit edit mode
                    if (e.key === 'Escape') {
                      setEditingNode(null);
                      return;
                    }
                    // Ctrl+1/2/3 for headings
                    if ((e.ctrlKey || e.metaKey) && ['1', '2', '3'].includes(e.key)) {
                      e.preventDefault();
                      const textarea = e.target as HTMLTextAreaElement;
                      const { selectionStart, value } = textarea;
                      const level = parseInt(e.key, 10);
                      const prefix = '#'.repeat(level) + ' ';

                      // Find the start of the current line
                      let lineStart = selectionStart;
                      while (lineStart > 0 && value[lineStart - 1] !== '\n') {
                        lineStart--;
                      }

                      // Check if line already has a heading prefix
                      const lineEnd = value.indexOf('\n', selectionStart);
                      const currentLine = value.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
                      const headingMatch = currentLine.match(/^(#{1,3})\s+/);

                      let newText: string;
                      let newCursorPos: number;

                      if (headingMatch) {
                        // Replace existing heading
                        const oldPrefix = headingMatch[0];
                        newText = value.slice(0, lineStart) + prefix + currentLine.slice(oldPrefix.length) + value.slice(lineEnd === -1 ? value.length : lineEnd);
                        newCursorPos = lineStart + prefix.length + (selectionStart - lineStart - oldPrefix.length);
                      } else {
                        // Add new heading prefix
                        newText = value.slice(0, lineStart) + prefix + value.slice(lineStart);
                        newCursorPos = selectionStart + prefix.length;
                      }

                      updateNodeText(node.id, newText);
                      // Restore cursor position after React re-render
                      setTimeout(() => {
                        textarea.selectionStart = textarea.selectionEnd = Math.max(0, newCursorPos);
                      }, 0);
                    }
                  }}
                  autoFocus
                  disabled={readOnly}
                  placeholder={t('canvasEnterContent', language)}
                />
              ) : node.type === 'text' && (
                <div
                  className={`canvas-node-text-display${node.textAlign === 'center' ? ' text-center' : ''}`}
                  onMouseEnter={() => setHoveredNode(node.id)}
                  onContextMenu={e => handleNodeContextMenu(e, node.id)}
                  onDoubleClick={e => handleNodeDoubleClick(e, node.id)}
                  onClick={e => {
                    // Handle wikilink clicks
                    const target = e.target as HTMLElement;
                    if (target.classList.contains('canvas-wikilink') && target.dataset.wikilink) {
                      e.stopPropagation();
                      openHoverFile(target.dataset.wikilink);
                    }
                  }}
                  dangerouslySetInnerHTML={{ __html: renderNodeText(node.text || '') || `<p class="canvas-placeholder">${t('canvasEnterContent', language)}</p>` }}
                />
              )}
              {node.type === 'file' && node.file && (
                <div
                  className="canvas-node-file"
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    const ext = node.file!.split('.').pop()?.toLowerCase() || '';
                    const isPreviewable = /\.(md|pdf|png|jpg|jpeg|gif|webp|svg|bmp|ico|json|py|js|ts|jsx|tsx|css|html|xml|yaml|yml|toml|rs|go|java|c|cpp|h|hpp|cs|rb|php|sh|bash|sql|lua|r|swift|kt|scala|doc|docx|ppt|pptx|xls|xlsx|hwp|hwpx)$/i.test(node.file!);

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
                        <div className="canvas-node-file-preview">
                          <img src={convertFileSrc(node.file)} alt={fileName} />
                          <div className="canvas-node-file-ext-badge">{ext.toUpperCase()}</div>
                        </div>
                      );
                    }
                    return (
                      <div className="canvas-node-file-icon">
                        <svg width="48" height="48" viewBox="0 0 24 24" fill="currentColor">
                          <path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/>
                        </svg>
                        <div className="canvas-node-file-ext">{ext.toUpperCase()}</div>
                      </div>
                    );
                  })()}
                  <div className="canvas-node-file-name">{node.file.split(/[/\\]/).pop() || 'Attachment'}</div>
                </div>
              )}
              {!readOnly && selectedNode === node.id && (
                <>
                  <button
                    className="canvas-node-delete"
                    onClick={() => deleteNode(node.id)}
                    title={t('deleteLabel', language)}
                  >
                    ×
                  </button>
                  {/* Resize handles - corner only for diagonal resizing */}
                  <div
                    className="canvas-node-resize canvas-node-resize-ne"
                    onMouseDown={e => handleResizeStart(e, node.id, 'ne')}
                  />
                  <div
                    className="canvas-node-resize canvas-node-resize-se"
                    onMouseDown={e => handleResizeStart(e, node.id, 'se')}
                  />
                  <div
                    className="canvas-node-resize canvas-node-resize-sw"
                    onMouseDown={e => handleResizeStart(e, node.id, 'sw')}
                  />
                  <div
                    className="canvas-node-resize canvas-node-resize-nw"
                    onMouseDown={e => handleResizeStart(e, node.id, 'nw')}
                  />
                </>
              )}
              {!readOnly && (hoveredNode === node.id || selectedNode === node.id || connectingFrom?.nodeId === node.id) && (() => {
                const isNodeSelected = selectedNode === node.id || selectedNodes.includes(node.id);
                // All shapes use unified inline position calculation
                return (
                  <>
                    {(['top', 'right', 'bottom', 'left'] as const).map(side => {
                      const pos = getHandlePosition(node, side, isNodeSelected);
                      return (
                        <div
                          key={side}
                          className="canvas-node-handle"
                          style={{ left: pos.left, top: pos.top }}
                          onMouseDown={e => handleConnectionStart(e, node.id, side)}
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
          className="canvas-svg"
          style={{
            transform: `translate(${viewportOffset.x}px, ${viewportOffset.y}px) scale(${viewportScale})`,
            transformOrigin: '0 0',
          }}
        >
          {data.edges.map(edge => {
            const edgeColor = edge.color || '#666';
            const isMultiSelected = selectedEdges.includes(edge.id);
            const displayColor = isMultiSelected ? '#00d4aa' : edgeColor;
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
                  className={`canvas-edge${selectedEdge === edge.id || isMultiSelected ? ' selected' : ''}`}
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
              </g>
            );
          })}
          {connectingFrom && connectionPreview && (
            <path
              d={getConnectionPreviewPath()}
              stroke="#007acc"
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
              stroke="#007acc"
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
              <path d="M 0 0 L 10 5 L 0 10 z" fill="#007acc" />
            </marker>
          </defs>
        </svg>
      </div>

      {!readOnly && (selectedNodes.length > 0 || selectedEdges.length > 0) && !selectedNode && !selectedEdge && (() => {
        const nodeColors = [
          { name: 'Dark Gray', value: '#2d2d2d' },
          { name: 'Blue', value: '#1e3a5f' },
          { name: 'Green', value: '#1e4d2b' },
          { name: 'Red', value: '#4d1e1e' },
          { name: 'Purple', value: '#3d1e4d' },
          { name: 'Orange', value: '#4d3a1e' },
        ];

        const edgeColors = [
          { name: 'Gray', value: '#666' },
          { name: 'Blue', value: '#007acc' },
          { name: 'Green', value: '#00d4aa' },
          { name: 'Red', value: '#e74856' },
          { name: 'Yellow', value: '#f9d71c' },
          { name: 'Purple', value: '#b180d7' },
        ];

        const updateMultipleNodes = (updates: Partial<CanvasNode>) => {
          const updatedNodes = data.nodes.map(node =>
            selectedNodes.includes(node.id) ? { ...node, ...updates } : node
          );
          onChange({ ...data, nodes: updatedNodes });
        };

        const updateMultipleEdges = (updates: Partial<CanvasEdge>) => {
          const updatedEdges = data.edges.map(edge =>
            selectedEdges.includes(edge.id) ? { ...edge, ...updates } : edge
          );
          onChange({ ...data, edges: updatedEdges });
        };

        return (
          <div className="canvas-properties-panel" onMouseDown={e => e.stopPropagation()}>
            <div className="canvas-properties-header">
              {tf('canvasMultiSelect', language, { nodeCount: selectedNodes.length, edgeCount: selectedEdges.length })}
            </div>

            {selectedNodes.length > 0 && (
              <div className="canvas-properties-section">
                <div className="canvas-properties-label">{t('canvasNodeColor', language)}</div>
                <div className="canvas-properties-colors">
                  {nodeColors.map(color => (
                    <button
                      key={color.value}
                      className="canvas-properties-color"
                      style={{ backgroundColor: color.value }}
                      onClick={() => updateMultipleNodes({ color: color.value })}
                      title={color.name}
                    />
                  ))}
                </div>
              </div>
            )}

            {selectedNodes.length > 0 && selectedNodes.some(id => data.nodes.find(n => n.id === id)?.type === 'text') && (
              <div className="canvas-properties-section">
                <div className="canvas-properties-label">{t('canvasTextAlign', language)}</div>
                <div className="canvas-properties-align-btns">
                  <button
                    className="canvas-properties-align-btn"
                    onClick={() => updateMultipleNodes({ textAlign: 'top-left' })}
                    title={t('canvasAlignTopLeft', language)}
                  >
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                      <rect x="1" y="2" width="10" height="2" />
                      <rect x="1" y="6" width="7" height="2" />
                      <rect x="1" y="10" width="9" height="2" />
                    </svg>
                  </button>
                  <button
                    className="canvas-properties-align-btn"
                    onClick={() => updateMultipleNodes({ textAlign: 'center' })}
                    title={t('canvasAlignCenter', language)}
                  >
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                      <rect x="3" y="2" width="10" height="2" />
                      <rect x="5" y="6" width="6" height="2" />
                      <rect x="4" y="10" width="8" height="2" />
                    </svg>
                  </button>
                </div>
              </div>
            )}

            {selectedEdges.length > 0 && (
              <div className="canvas-properties-section">
                <div className="canvas-properties-label">{t('canvasArrowColor', language)}</div>
                <div className="canvas-properties-colors">
                  {edgeColors.map(color => (
                    <button
                      key={color.value}
                      className="canvas-properties-color"
                      style={{ backgroundColor: color.value }}
                      onClick={() => updateMultipleEdges({ color: color.value })}
                      title={color.name}
                    />
                  ))}
                </div>
              </div>
            )}

            <div className="canvas-properties-section">
              <button
                className="canvas-properties-delete-btn"
                onClick={() => {
                  const updatedNodes = data.nodes.filter(n => !selectedNodes.includes(n.id));
                  const updatedEdges = data.edges.filter(e =>
                    !selectedEdges.includes(e.id) &&
                    !selectedNodes.includes(e.fromNode) &&
                    !selectedNodes.includes(e.toNode)
                  );
                  onChange({ nodes: updatedNodes, edges: updatedEdges });
                  setSelectedNodes([]);
                  setSelectedEdges([]);
                }}
              >
                {t('canvasDeleteSelection', language)}
              </button>
            </div>
          </div>
        );
      })()}

      {!readOnly && selectedNode && (() => {
        const node = data.nodes.find(n => n.id === selectedNode);
        if (!node) return null;

        const colors = [
          { value: '#2d2d2d' }, { value: '#1e3a5f' }, { value: '#1e4d2b' },
          { value: '#4d1e1e' }, { value: '#3d1e4d' }, { value: '#4d3a1e' },
        ];

        return (
          <div
            className={`canvas-properties-panel compact${propsExpanded ? ' expanded' : ''}`}
            onMouseDown={e => e.stopPropagation()}
          >
            {/* Compact toolbar row */}
            <div className="canvas-props-toolbar">
              {/* Color picker */}
              <div className="canvas-props-colors-row">
                {colors.map(c => (
                  <button
                    key={c.value}
                    className={`canvas-props-color-btn${node.color === c.value ? ' active' : ''}`}
                    style={{ backgroundColor: c.value }}
                    onClick={() => updateNodeProperties(selectedNode, { color: c.value })}
                  />
                ))}
              </div>
              {/* Align buttons for text nodes */}
              {node.type === 'text' && (
                <div className="canvas-props-align-row">
                  <button
                    className={`canvas-props-icon-btn${(!node.textAlign || node.textAlign === 'top-left') ? ' active' : ''}`}
                    onClick={() => updateNodeProperties(selectedNode, { textAlign: 'top-left' })}
                    title={t('canvasAlignTopLeft', language)}
                  >
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                      <rect x="1" y="3" width="9" height="2" />
                      <rect x="1" y="7" width="6" height="2" />
                      <rect x="1" y="11" width="8" height="2" />
                    </svg>
                  </button>
                  <button
                    className={`canvas-props-icon-btn${node.textAlign === 'center' ? ' active' : ''}`}
                    onClick={() => updateNodeProperties(selectedNode, { textAlign: 'center' })}
                    title={t('canvasAlignCenter', language)}
                  >
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                      <rect x="3" y="3" width="10" height="2" />
                      <rect x="5" y="7" width="6" height="2" />
                      <rect x="4" y="11" width="8" height="2" />
                    </svg>
                  </button>
                </div>
              )}
              {/* Expand toggle */}
              {node.type !== 'file' && (
                <button
                  className="canvas-props-expand-btn"
                  onClick={() => setPropsExpanded(!propsExpanded)}
                  title={propsExpanded ? t('canvasCollapse', language) : t('canvasExpand', language)}
                >
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" style={{ transform: propsExpanded ? 'rotate(180deg)' : 'none' }}>
                    <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="2" />
                  </svg>
                </button>
              )}
            </div>
            {/* Expanded: shape selector */}
            {propsExpanded && node.type !== 'file' && (
              <div className="canvas-props-shapes-grid icons">
                {CANVAS_SHAPES.map(shape => (
                  <button
                    key={shape.value}
                    className={`canvas-props-shape-btn icon${(node.shape || 'process') === shape.value ? ' active' : ''}`}
                    onClick={() => updateNodeProperties(selectedNode, { shape: shape.value })}
                    title={shape.value}
                  >
                    {CANVAS_SHAPE_ICONS[shape.value]}
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })()}

      {!readOnly && selectedEdge && (() => {
        const edge = data.edges.find(e => e.id === selectedEdge);
        if (!edge) return null;

        const edgeColors = [
          { name: 'Gray', value: '#666' },
          { name: 'Blue', value: '#007acc' },
          { name: 'Green', value: '#00d4aa' },
          { name: 'Red', value: '#e74856' },
          { name: 'Yellow', value: '#f9d71c' },
          { name: 'Purple', value: '#b180d7' },
        ];

        return (
          <div className="canvas-properties-panel" onMouseDown={e => e.stopPropagation()}>
            <div className="canvas-properties-header">{t('canvasArrowProperties', language)}</div>

            <div className="canvas-properties-section">
              <div className="canvas-properties-label">{t('canvasColor', language)}</div>
              <div className="canvas-properties-colors">
                {edgeColors.map(color => (
                  <button
                    key={color.value}
                    className={`canvas-properties-color${(edge.color || '#666') === color.value ? ' active' : ''}`}
                    style={{ backgroundColor: color.value }}
                    onClick={() => updateEdgeProperties(selectedEdge, { color: color.value })}
                    title={color.name}
                  />
                ))}
              </div>
            </div>

            <div className="canvas-properties-section">
              <button
                className="canvas-properties-delete-btn"
                onClick={() => deleteEdge(selectedEdge)}
              >
                {t('canvasDeleteArrow', language)}
              </button>
            </div>
          </div>
        );
      })()}

      {/* Node Context Menu */}
      {contextMenu && (() => {
        const node = data.nodes.find(n => n.id === contextMenu.nodeId);
        if (!node) return null;

        const nodeColors = [
          { name: 'Blue', value: '#1e3a5f' },
          { name: 'Green', value: '#2d4a2c' },
          { name: 'Red', value: '#5f1e1e' },
          { name: 'Purple', value: '#3a1e5f' },
          { name: 'Orange', value: '#5f3a1e' },
          { name: 'Default', value: '#2d2d2d' },
        ];

        return (
          <>
            {/* Backdrop to close menu */}
            <div
              className="canvas-context-backdrop"
              onClick={closeContextMenu}
              onContextMenu={e => { e.preventDefault(); closeContextMenu(); }}
            />
            <div
              className="canvas-context-menu"
              style={{ left: contextMenu.x, top: contextMenu.y }}
            >
              <div className="canvas-context-section">
                <div className="canvas-context-label">{t('canvasNodeColor', language)}</div>
                <div className="canvas-context-colors">
                  {nodeColors.map(c => (
                    <button
                      key={c.value}
                      className={`canvas-context-color-btn${(node.color || '#2d2d2d') === c.value ? ' active' : ''}`}
                      style={{ backgroundColor: c.value }}
                      onClick={() => {
                        updateNodeProperties(contextMenu.nodeId, { color: c.value });
                        closeContextMenu();
                      }}
                      title={c.name}
                    />
                  ))}
                </div>
              </div>
              <div className="canvas-context-section">
                <div className="canvas-context-label">{t('canvasShape', language)}</div>
                <div className="canvas-context-shapes">
                  {CANVAS_SHAPES.map(shape => (
                    <button
                      key={shape.value}
                      className={`canvas-context-shape-btn${(node.shape || 'process') === shape.value ? ' active' : ''}`}
                      onClick={() => {
                        updateNodeProperties(contextMenu.nodeId, { shape: shape.value });
                        closeContextMenu();
                      }}
                      title={shape.value}
                    >
                      {CANVAS_SHAPE_ICONS[shape.value]}
                    </button>
                  ))}
                </div>
              </div>
              <div className="canvas-context-divider" />
              <button
                className="canvas-context-item"
                onClick={() => {
                  setEditingNode(contextMenu.nodeId);
                  closeContextMenu();
                }}
              >
                {t('canvasEditNode', language)}
              </button>
              <button
                className="canvas-context-item delete"
                onClick={() => {
                  deleteNode(contextMenu.nodeId);
                  closeContextMenu();
                }}
              >
                {t('canvasDeleteNode', language)}
              </button>
            </div>
          </>
        );
      })()}
    </div>
  );
}

export default CanvasEditor;
