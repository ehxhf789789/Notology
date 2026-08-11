/**
 * GraphView — Mobile graph visualization using Canvas.
 * Redesigned: folder-color nodes, hover/select interactions,
 * dot grid background (light mode), improved popup.
 */
import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { invoke } from '../../../web/core';
import { useFileTreeStore } from '../../../core/stores/fileTreeStore';
import { colors as tokenColors } from '../../../styles/tokens/colors';
import { resolveMobileGraphPalette } from './graphColors';
import { BottomSheet } from '../BottomSheet';
import { ActionSheet } from '../components/common/ActionSheet';
import { triggerHaptic } from '../../shared/haptics';
import type { GraphData, GraphNode, GraphEdge } from '../../../core/types';

interface SimNode extends GraphNode {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

interface Props {
  onOpenNote?: (notePath: string, name: string) => void;
  onOpenContainer?: (containerPath: string, name: string) => void;
}

interface SelectedNode {
  node: SimNode;
  screenX: number;
  screenY: number;
  connectionCount: number;
}

export default function GraphView({ onOpenNote, onOpenContainer }: Props = {}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const vaultPath = useFileTreeStore(s => s.vaultPath);
  const [graphData, setGraphData] = useState<GraphData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<SelectedNode | null>(null);
  const simNodesRef = useRef<SimNode[]>([]);
  const edgesRef = useRef<GraphEdge[]>([]);
  const animRef = useRef<number>(0);
  const panRef = useRef({ x: 0, y: 0, scale: 1 });
  const touchRef = useRef<{ startX: number; startY: number; panX: number; panY: number } | null>(null);
  const hoveredRef = useRef<string | null>(null);
  const [activeFilter, setActiveFilter] = useState<string | null>(null);
  const activeFilterRef = useRef<string | null>(null);
  activeFilterRef.current = activeFilter;
  const nodeContainerMapRef = useRef<Map<string, string>>(new Map());

  // Map each node to its full path ancestry (all folder names in path)
  // Also extract top-level container for filter pills
  const { nodeAncestryMap, topLevelContainers } = useMemo(() => {
    const ancestryMap = new Map<string, string[]>(); // nodeId → [folder1, folder2, ...]
    const topSet = new Set<string>();
    if (!graphData || !vaultPath) return { nodeAncestryMap: ancestryMap, topLevelContainers: [] as string[] };

    const vaultNorm = vaultPath.replace(/\\/g, '/').replace(/\/$/, '');
    for (const node of graphData.nodes) {
      if (node.path) {
        const pathNorm = node.path.replace(/\\/g, '/');
        // Get relative path within vault
        const rel = pathNorm.startsWith(vaultNorm)
          ? pathNorm.slice(vaultNorm.length + 1)
          : pathNorm;
        const parts = rel.split('/').filter(Boolean);
        // All folder names in the path (everything except the filename)
        const folders = parts.slice(0, -1);
        ancestryMap.set(node.id, folders);
        // Top-level = first folder
        if (folders.length > 0) topSet.add(folders[0]);
      }
    }
    return { nodeAncestryMap: ancestryMap, topLevelContainers: Array.from(topSet).sort() };
  }, [graphData, vaultPath]);

  // For draw loop: ref-based access
  const nodeAncestryMapRef = useRef<Map<string, string[]>>(new Map());
  nodeAncestryMapRef.current = nodeAncestryMap;

  // Keep old ref name for compatibility in draw()
  nodeContainerMapRef.current = new Map(
    Array.from(nodeAncestryMap.entries()).map(([id, folders]) => [id, folders[0] ?? ''])
  );

  const containers = topLevelContainers;

  useEffect(() => {
    if (!vaultPath) return;
    invoke<GraphData>('get_graph_data', { containerPath: null, includeAttachments: false })
      .then(data => { setGraphData(data); setError(null); })
      .catch(e => setError(String(e)));
  }, [vaultPath]);

  useEffect(() => {
    if (!graphData || graphData.nodes.length === 0) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const w = canvas.offsetWidth;
    const h = canvas.offsetHeight;
    canvas.width = w * window.devicePixelRatio;
    canvas.height = h * window.devicePixelRatio;

    const nodes: SimNode[] = graphData.nodes.map(n => ({
      ...n,
      x: (Math.random() - 0.5) * w * 0.6,
      y: (Math.random() - 0.5) * h * 0.6,
      vx: 0, vy: 0,
    }));
    simNodesRef.current = nodes;
    edgesRef.current = graphData.edges;
    panRef.current = { x: w / 2, y: h / 2, scale: 1 };

    const nodeMap = new Map(nodes.map(n => [n.id, n]));
    let iteration = 0;
    const maxIterations = 200;

    function simulate() {
      const ns = simNodesRef.current;
      const alpha = Math.max(0.01, 1 - iteration / maxIterations);

      for (let i = 0; i < ns.length; i++) {
        for (let j = i + 1; j < ns.length; j++) {
          const dx = ns[j].x - ns[i].x;
          const dy = ns[j].y - ns[i].y;
          const dist = Math.max(1, Math.sqrt(dx * dx + dy * dy));
          const force = (800 / (dist * dist)) * alpha;
          const fx = (dx / dist) * force, fy = (dy / dist) * force;
          ns[i].vx -= fx; ns[i].vy -= fy;
          ns[j].vx += fx; ns[j].vy += fy;
        }
      }

      for (const edge of edgesRef.current) {
        const s = nodeMap.get(edge.source), t = nodeMap.get(edge.target);
        if (!s || !t) continue;
        const dx = t.x - s.x, dy = t.y - s.y;
        const dist = Math.max(1, Math.sqrt(dx * dx + dy * dy));
        const force = (dist - 80) * 0.02 * alpha;
        const fx = (dx / dist) * force, fy = (dy / dist) * force;
        s.vx += fx; s.vy += fy; t.vx -= fx; t.vy -= fy;
      }

      for (const n of ns) {
        n.vx -= n.x * 0.005 * alpha; n.vy -= n.y * 0.005 * alpha;
        n.vx *= 0.7; n.vy *= 0.7;
        n.x += n.vx; n.y += n.vy;
      }
      iteration++;
    }

    function draw() {
      const ctx = canvas!.getContext('2d');
      if (!ctx) return;
      const dpr = window.devicePixelRatio;
      const { x: px, y: py, scale } = panRef.current;
      const isDark = document.documentElement.dataset.theme !== 'light';
      // 5.0.10b — canvas colors come from the resolver so theme swap
      // re-paints with the right palette and there are no raw hex/rgba
      // strings baked into the draw loop.
      const palette = resolveMobileGraphPalette(isDark);

      ctx.clearRect(0, 0, canvas!.width, canvas!.height);
      ctx.save();
      ctx.scale(dpr, dpr);

      // Dot grid background (light mode only — DARK.dotGrid is empty string)
      if (palette.dotGrid) {
        ctx.fillStyle = palette.dotGrid;
        const gridSize = 24;
        for (let gx = 0; gx < w; gx += gridSize) {
          for (let gy = 0; gy < h; gy += gridSize) {
            ctx.beginPath();
            ctx.arc(gx, gy, 0.5, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }

      ctx.translate(px, py);
      ctx.scale(scale, scale);

      const selectedId = hoveredRef.current;
      const currentFilter = activeFilterRef.current;
      const connectedIds = new Set<string>();
      if (selectedId) {
        for (const e of edgesRef.current) {
          if (e.source === selectedId) connectedIds.add(e.target);
          if (e.target === selectedId) connectedIds.add(e.source);
        }
        connectedIds.add(selectedId);
      }

      // Edges
      for (const edge of edgesRef.current) {
        const s = nodeMap.get(edge.source), t = nodeMap.get(edge.target);
        if (!s || !t) continue;
        const highlighted = selectedId && (edge.source === selectedId || edge.target === selectedId);
        ctx.strokeStyle = highlighted ? palette.edgeHighlight : palette.edgeDefault;
        ctx.lineWidth = highlighted ? 1.5 : 1;
        ctx.globalAlpha = selectedId && !highlighted ? 0.15 : 1;
        ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(t.x, t.y); ctx.stroke();
      }
      ctx.globalAlpha = 1;

      // Nodes
      for (const node of simNodesRef.current) {
        const r = node.isFolderNote ? 7 : 5;
        const nodeAncestry = nodeAncestryMapRef.current.get(node.id) ?? [];
        const filterDimmed = currentFilter && !nodeAncestry.includes(currentFilter);
        const dimmed = (selectedId && !connectedIds.has(node.id)) || !!filterDimmed;

        ctx.globalAlpha = dimmed ? 0.15 : 1;
        ctx.beginPath();
        ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
        ctx.fillStyle = getNodeColor(node);
        ctx.fill();
        ctx.strokeStyle = palette.nodeStroke;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      ctx.globalAlpha = 1;

      // Labels
      const showAll = scale > 1.5 || simNodesRef.current.length < 50;
      ctx.textAlign = 'center';
      for (const node of simNodesRef.current) {
        if (!showAll && !node.isFolderNote) continue;
        const labelAncestry = nodeAncestryMapRef.current.get(node.id) ?? [];
        const labelFilterDimmed = currentFilter && !labelAncestry.includes(currentFilter);
        const dimmed = (selectedId && !connectedIds.has(node.id)) || !!labelFilterDimmed;
        if (dimmed) continue;

        const fontSize = 11 / scale;
        ctx.font = `500 ${fontSize}px -apple-system, sans-serif`;

        // Label background pill
        const metrics = ctx.measureText(node.label);
        const lx = node.x, ly = node.y + (node.isFolderNote ? 14 : 12) / scale;
        const pad = 3 / scale;
        ctx.fillStyle = palette.labelBg;
        ctx.beginPath();
        const rr = (fontSize + pad * 2) / 2;
        ctx.roundRect(
          lx - metrics.width / 2 - pad, ly - fontSize / 2 - pad,
          metrics.width + pad * 2, fontSize + pad * 2, rr
        );
        ctx.fill();

        ctx.fillStyle = palette.labelText;
        ctx.fillText(node.label, lx, ly + fontSize * 0.35);
      }

      ctx.restore();
    }

    function loop() {
      if (iteration < maxIterations) simulate();
      draw();
      animRef.current = requestAnimationFrame(loop);
    }
    animRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(animRef.current);
  }, [graphData]);

  // Double-tap zoom
  const lastTapRef = useRef(0);
  // Pinch zoom
  const pinchRef = useRef<{ dist: number; scale: number } | null>(null);
  // Long-press on node
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [longPressNode, setLongPressNode] = useState<SimNode | null>(null);

  const findNodeAtTouch = useCallback((clientX: number, clientY: number): SimNode | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const { x: px, y: py, scale } = panRef.current;
    const gx = (clientX - rect.left - px) / scale;
    const gy = (clientY - rect.top - py) / scale;
    let closest: SimNode | null = null;
    let minDist = 20 / scale;
    for (const node of simNodesRef.current) {
      const dist = Math.sqrt((node.x - gx) ** 2 + (node.y - gy) ** 2);
      if (dist < minDist) { minDist = dist; closest = node; }
    }
    return closest;
  }, []);

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if (e.touches.length === 2) {
      // Pinch start
      const dx = e.touches[1].clientX - e.touches[0].clientX;
      const dy = e.touches[1].clientY - e.touches[0].clientY;
      pinchRef.current = { dist: Math.hypot(dx, dy), scale: panRef.current.scale };
      if (longPressTimerRef.current) { clearTimeout(longPressTimerRef.current); longPressTimerRef.current = null; }
      return;
    }
    if (e.touches.length === 1) {
      touchRef.current = {
        startX: e.touches[0].clientX, startY: e.touches[0].clientY,
        panX: panRef.current.x, panY: panRef.current.y,
      };
      // Long-press detection (500ms)
      const tx = e.touches[0].clientX;
      const ty = e.touches[0].clientY;
      longPressTimerRef.current = setTimeout(() => {
        longPressTimerRef.current = null;
        const node = findNodeAtTouch(tx, ty);
        if (node) {
          triggerHaptic('selection');
          setLongPressNode(node);
        }
      }, 500);
    }
  }, [findNodeAtTouch]);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    // Pinch zoom
    if (e.touches.length === 2 && pinchRef.current) {
      const dx = e.touches[1].clientX - e.touches[0].clientX;
      const dy = e.touches[1].clientY - e.touches[0].clientY;
      const newDist = Math.hypot(dx, dy);
      const ratio = newDist / pinchRef.current.dist;
      panRef.current.scale = Math.max(0.3, Math.min(5, pinchRef.current.scale * ratio));
      return;
    }
    // Single finger pan
    if (e.touches.length === 1 && touchRef.current) {
      const dx = e.touches[0].clientX - touchRef.current.startX;
      const dy = e.touches[0].clientY - touchRef.current.startY;
      // Cancel long-press if moved > 10px
      if (longPressTimerRef.current && Math.hypot(dx, dy) > 10) {
        clearTimeout(longPressTimerRef.current);
        longPressTimerRef.current = null;
      }
      panRef.current.x = touchRef.current.panX + dx;
      panRef.current.y = touchRef.current.panY + dy;
    }
  }, []);

  const handleTouchEnd = useCallback((e: React.TouchEvent) => {
    if (longPressTimerRef.current) { clearTimeout(longPressTimerRef.current); longPressTimerRef.current = null; }
    pinchRef.current = null;
    touchRef.current = null;

    // Double-tap zoom detection
    if (e.changedTouches.length === 1) {
      const now = Date.now();
      if (now - lastTapRef.current < 300) {
        // Double tap — toggle zoom
        const current = panRef.current.scale;
        panRef.current.scale = current > 1.5 ? 1 : 2.5;
        lastTapRef.current = 0;
      } else {
        lastTapRef.current = now;
      }
    }
  }, []);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    panRef.current.scale = Math.max(0.2, Math.min(5, panRef.current.scale * (e.deltaY > 0 ? 0.9 : 1.1)));
  }, []);

  const handleCanvasClick = useCallback((e: React.MouseEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const { x: px, y: py, scale } = panRef.current;
    const gx = (e.clientX - rect.left - px) / scale;
    const gy = (e.clientY - rect.top - py) / scale;

    let closest: SimNode | null = null;
    let minDist = 20 / scale;
    for (const node of simNodesRef.current) {
      const dist = Math.sqrt((node.x - gx) ** 2 + (node.y - gy) ** 2);
      if (dist < minDist) { minDist = dist; closest = node; }
    }

    if (closest) {
      hoveredRef.current = closest.id;
      const connCount = edgesRef.current.filter(
        e => e.source === closest!.id || e.target === closest!.id
      ).length;
      setSelectedNode({
        node: closest,
        screenX: e.clientX - rect.left,
        screenY: e.clientY - rect.top,
        connectionCount: connCount,
      });
    } else {
      hoveredRef.current = null;
      setSelectedNode(null);
    }
  }, []);

  if (!vaultPath) {
    return <div className="mobile-container-list"><p style={{ padding: 20, color: 'var(--tx-3)' }}>볼트를 선택해주세요</p></div>;
  }
  if (error) {
    return <div className="mobile-container-list"><p style={{ padding: 20, color: 'var(--c-red)' }}>그래프 로드 실패: {error}</p></div>;
  }
  if (graphData && graphData.nodes.length === 0) {
    return <div className="mobile-container-list"><p style={{ padding: 20, color: 'var(--tx-3)' }}>노트가 없습니다</p></div>;
  }

  // Get connected node labels for detail panel
  const connectedNodes = useMemo(() => {
    if (!selectedNode) return [];
    const ids = new Set<string>();
    for (const e of edgesRef.current) {
      if (e.source === selectedNode.node.id) ids.add(e.target);
      if (e.target === selectedNode.node.id) ids.add(e.source);
    }
    return simNodesRef.current.filter(n => ids.has(n.id));
  }, [selectedNode]);

  return (
    <div className="mobile-graph-view">
      {/* Container filter pills */}
      {containers.length > 0 && (
        <div className="m-graph-filter-pills">
          <button
            className={`m-graph-filter-pill ${activeFilter === null ? 'active' : ''}`}
            onClick={() => setActiveFilter(null)}
          >전체</button>
          {containers.map(c => (
            <button
              key={c}
              className={`m-graph-filter-pill ${activeFilter === c ? 'active' : ''}`}
              onClick={() => setActiveFilter(prev => prev === c ? null : c)}
            >{c}</button>
          ))}
        </div>
      )}

      <canvas
        ref={canvasRef}
        className="mobile-graph-canvas"
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onWheel={handleWheel}
        onClick={handleCanvasClick}
      />

      {graphData && (
        <div className="mobile-graph-info-v2">
          {graphData.nodes.length}개 노드 · {graphData.edges.length}개 링크
        </div>
      )}

      {/* Node long-press Action Sheet */}
      {longPressNode && (
        <ActionSheet
          title={longPressNode.label}
          message={`${longPressNode.noteType ?? 'NOTE'} · ${edgesRef.current.filter(e => e.source === longPressNode.id || e.target === longPressNode.id).length}개 연결`}
          actions={[
            {
              label: longPressNode.isFolderNote ? '컨테이너 열기' : '노트 열기',
              onPress: () => {
                const { path, label, isFolderNote } = longPressNode;
                if (isFolderNote && onOpenContainer) {
                  const containerPath = path.replace(/[\\/][^\\/]+$/, '');
                  onOpenContainer(containerPath, label);
                } else if (onOpenNote) {
                  onOpenNote(path, label);
                }
                setLongPressNode(null);
              },
            },
            {
              label: '연결된 노트만 보기',
              onPress: () => {
                hoveredRef.current = longPressNode.id;
                setLongPressNode(null);
              },
            },
          ]}
          onCancel={() => setLongPressNode(null)}
        />
      )}

      {/* Node detail BottomSheet */}
      <BottomSheet
        open={!!selectedNode}
        onClose={() => { setSelectedNode(null); hoveredRef.current = null; }}
        title=""
      >
        {selectedNode && (
          <div style={{ padding: '0 16px 16px' }}>
            <div className="m-graph-detail-title">
              <span style={{ width: 10, height: 10, borderRadius: '50%', background: getNodeColor(selectedNode.node), flexShrink: 0 }} />
              {selectedNode.node.label}
            </div>
            <div className="m-graph-detail-meta">
              {selectedNode.node.noteType && (
                <span className="m-graph-detail-type-badge">{selectedNode.node.noteType}</span>
              )}
              <span>{selectedNode.connectionCount}개 연결</span>
            </div>

            {connectedNodes.length > 0 && (
              <>
                <div className="m-graph-detail-section-title">연결 ({connectedNodes.length})</div>
                {connectedNodes.map(n => (
                  <button
                    key={n.id}
                    className="m-graph-detail-connection"
                    onClick={() => {
                      hoveredRef.current = n.id;
                      setSelectedNode(null);
                    }}
                  >
                    <span style={{ width: 8, height: 8, borderRadius: '50%', background: getNodeColor(n), flexShrink: 0 }} />
                    {n.label}
                  </button>
                ))}
              </>
            )}

            {selectedNode.node.path && (onOpenNote || onOpenContainer) && (
              <button
                className="m-graph-detail-open-btn"
                onClick={() => {
                  const { path, label, isFolderNote } = selectedNode.node;
                  if (isFolderNote && onOpenContainer) {
                    // Folder note → open as container (note-list view)
                    const containerPath = path.replace(/[\\/][^\\/]+$/, '');
                    onOpenContainer(containerPath, label);
                  } else if (onOpenNote) {
                    onOpenNote(path, label);
                  }
                  setSelectedNode(null);
                  hoveredRef.current = null;
                }}
              >
                {selectedNode.node.isFolderNote ? '컨테이너 열기' : '노트 열기'}
              </button>
            )}
          </div>
        )}
      </BottomSheet>
    </div>
  );
}

function getNodeColor(node: GraphNode): string {
  // Use folder palette based on path hash for variety
  if (node.nodeType === 'tag') return tokenColors.folder[5]; // Iris Purple
  const folderColors = tokenColors.folder;
  switch (node.noteType) {
    case 'MTG': return folderColors[4]; // Sky Blue
    case 'SEM': return folderColors[5]; // Iris Purple
    case 'EVENT': return folderColors[1]; // Tangerine
    default: {
      // Hash path to get consistent color
      let hash = 0;
      for (let i = 0; i < node.id.length; i++) hash = ((hash << 5) - hash + node.id.charCodeAt(i)) | 0;
      return folderColors[Math.abs(hash) % folderColors.length];
    }
  }
}
