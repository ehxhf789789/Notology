import { useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import type { SketchData, SketchNode, SketchEdge } from '../../core/types';
import { t, tf, type LanguageSetting } from '../../core/utils/i18n';
import { SKETCH_SHAPES, SKETCH_SHAPE_ICONS } from './sketchHelpers';

// ============================================================================
// Multi-selection properties panel
// ============================================================================

interface MultiSelectPanelProps {
  data: SketchData;
  onChange: (data: SketchData) => void;
  selectedNodes: string[];
  selectedEdges: string[];
  setSelectedNodes: (ids: string[]) => void;
  setSelectedEdges: (ids: string[]) => void;
  language: LanguageSetting;
}

/** Semantic node color keys — stored in data, resolved via CSS variables */
const NODE_COLORS = [
  { name: 'Default', value: 'node-default', cssVar: '--node-default' },
  { name: 'Blue', value: 'node-blue', cssVar: '--node-blue' },
  { name: 'Green', value: 'node-green', cssVar: '--node-green' },
  { name: 'Red', value: 'node-red', cssVar: '--node-red' },
  { name: 'Purple', value: 'node-purple', cssVar: '--node-purple' },
  { name: 'Orange', value: 'node-orange', cssVar: '--node-orange' },
];

function getNodeColors() { return NODE_COLORS; }

const GROUP_COLORS = [
  { name: 'Indigo', value: '#4f46e5' },
  { name: 'Green', value: '#16a34a' },
  { name: 'Blue', value: '#2563eb' },
  { name: 'Orange', value: '#ea580c' },
  { name: 'Pink', value: '#db2777' },
  { name: 'Gray', value: '#6b7280' },
];

const EDGE_COLORS = [
  { name: 'Gray', value: '#666' },
  { name: 'Blue', value: '#007AFF' },
  { name: 'Green', value: '#34C759' },
  { name: 'Red', value: '#FF3B30' },
  { name: 'Yellow', value: '#FFCC00' },
  { name: 'Purple', value: '#AF52DE' },
];

export function MultiSelectPanel({
  data, onChange, selectedNodes, selectedEdges,
  setSelectedNodes, setSelectedEdges, language,
}: MultiSelectPanelProps) {
  const updateMultipleNodes = (updates: Partial<SketchNode>) => {
    const updatedNodes = data.nodes.map(node =>
      selectedNodes.includes(node.id) ? { ...node, ...updates } : node
    );
    onChange({ ...data, nodes: updatedNodes });
  };

  const updateMultipleEdges = (updates: Partial<SketchEdge>) => {
    const updatedEdges = data.edges.map(edge =>
      selectedEdges.includes(edge.id) ? { ...edge, ...updates } : edge
    );
    onChange({ ...data, edges: updatedEdges });
  };

  return (
    <div className="sketch-properties-panel" onMouseDown={e => e.stopPropagation()}>
      <div className="sketch-properties-header">
        {tf('canvasMultiSelect', language, { nodeCount: selectedNodes.length, edgeCount: selectedEdges.length })}
      </div>

      {selectedNodes.length > 0 && (
        <div className="sketch-properties-section">
          <div className="sketch-properties-label">{t('sketchNodeColor', language)}</div>
          <div className="sketch-properties-colors">
            {getNodeColors().map(color => (
              <button
                key={color.value}
                className="sketch-properties-color"
                /* v20.11 (2026-05-17, HanBin) — swatches were showing all-grey
                   because backgroundColor was set to the semantic key string
                   (e.g. 'node-blue') which isn't a valid CSS color. Now
                   resolve through the CSS variable so the swatch matches the
                   actual node fill. HanBin: "노드 색상 부분 UX 오류임. 실제로는
                   색상이 있으나 회색으로 보임." */
                style={{ backgroundColor: `var(${color.cssVar})` }}
                onClick={() => updateMultipleNodes({ color: color.value })}
                title={color.name}
              />
            ))}
          </div>
        </div>
      )}

      {selectedNodes.length > 0 && selectedNodes.some(id => data.nodes.find(n => n.id === id)?.type === 'text') && (
        <div className="sketch-properties-section">
          <div className="sketch-properties-label">{t('sketchTextAlign', language)}</div>
          <div className="sketch-properties-align-btns">
            <button
              className="sketch-properties-align-btn"
              onClick={() => updateMultipleNodes({ textAlign: 'top-left' })}
              title={t('sketchAlignTopLeft', language)}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                <rect x="1" y="2" width="10" height="2" />
                <rect x="1" y="6" width="7" height="2" />
                <rect x="1" y="10" width="9" height="2" />
              </svg>
            </button>
            <button
              className="sketch-properties-align-btn"
              onClick={() => updateMultipleNodes({ textAlign: 'center' })}
              title={t('sketchAlignCenter', language)}
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

      {/* v20.12 (2026-05-17, HanBin) — unified "테두리 색상" picker. Was
          two separate sections (노드 색상 fill + 화살표 색상); HanBin
          asked to merge node border + arrow color into one picker because
          they're the same visual concept (outline). The fill picker
          above stays for the node BACKGROUND; this one controls node
          BORDER + edge stroke as one. Applied to whichever of nodes /
          edges are currently selected (or both — multi-selection). */}
      {(selectedNodes.length > 0 || selectedEdges.length > 0) && (
        <div className="sketch-properties-section">
          <div className="sketch-properties-label">{t('sketchBorderColor', language)}</div>
          <div className="sketch-properties-colors">
            {EDGE_COLORS.map(color => (
              <button
                key={color.value}
                className="sketch-properties-color"
                style={{ backgroundColor: color.value }}
                onClick={() => {
                  if (selectedNodes.length > 0) {
                    updateMultipleNodes({ borderColor: color.value });
                  }
                  if (selectedEdges.length > 0) {
                    updateMultipleEdges({ color: color.value });
                  }
                }}
                title={color.name}
              />
            ))}
          </div>
        </div>
      )}

      <div className="sketch-properties-section">
        <button
          className="sketch-properties-delete-btn"
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
          {t('sketchDeleteSelection', language)}
        </button>
      </div>
    </div>
  );
}

// ============================================================================
// Single node properties panel (compact)
// ============================================================================

interface NodePropsPanelProps {
  node: SketchNode;
  selectedNode: string;
  propsExpanded: boolean;
  setPropsExpanded: (expanded: boolean) => void;
  updateNodeProperties: (nodeId: string, properties: Partial<SketchNode>) => void;
  language: LanguageSetting;
}

function getCompactColors() {
  return getNodeColors().map(c => ({ value: c.value }));
}

export function NodePropsPanel({
  node, selectedNode, propsExpanded, setPropsExpanded,
  updateNodeProperties, language,
}: NodePropsPanelProps) {
  const isGroup = node.type === 'group' || node.isGroup;
  const colors = isGroup ? GROUP_COLORS.map(c => ({ value: c.value, cssVar: undefined as string | undefined })) : getCompactColors().map(c => ({ ...c, cssVar: NODE_COLORS.find(nc => nc.value === c.value)?.cssVar }));

  return (
    <div
      className={`sketch-properties-panel compact${propsExpanded ? ' expanded' : ''}`}
      onMouseDown={e => e.stopPropagation()}
    >
      {/* Compact toolbar row */}
      <div className="sketch-props-toolbar">
        {/* Color picker */}
        <div className="sketch-props-colors-row">
          {colors.map(c => (
            <button
              key={c.value}
              className={`sketch-props-color-btn${node.color === c.value ? ' active' : ''}`}
              style={{ backgroundColor: c.cssVar ? `var(${c.cssVar})` : c.value }}
              onClick={() => updateNodeProperties(selectedNode, { color: c.value })}
            />
          ))}
        </div>
        {/* Align buttons for text nodes */}
        {node.type === 'text' && (
          <div className="sketch-props-align-row">
            <button
              className={`sketch-props-icon-btn${(!node.textAlign || node.textAlign === 'top-left') ? ' active' : ''}`}
              onClick={() => updateNodeProperties(selectedNode, { textAlign: 'top-left' })}
              title={t('sketchAlignTopLeft', language)}
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                <rect x="1" y="3" width="9" height="2" />
                <rect x="1" y="7" width="6" height="2" />
                <rect x="1" y="11" width="8" height="2" />
              </svg>
            </button>
            <button
              className={`sketch-props-icon-btn${node.textAlign === 'center' ? ' active' : ''}`}
              onClick={() => updateNodeProperties(selectedNode, { textAlign: 'center' })}
              title={t('sketchAlignCenter', language)}
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                <rect x="3" y="3" width="10" height="2" />
                <rect x="5" y="7" width="6" height="2" />
                <rect x="4" y="11" width="8" height="2" />
              </svg>
            </button>
          </div>
        )}
        {/* Expand toggle — not for groups or file nodes */}
        {!isGroup && node.type !== 'file' && (
          <button
            className="sketch-props-expand-btn"
            onClick={() => setPropsExpanded(!propsExpanded)}
            title={propsExpanded ? t('sketchCollapse', language) : t('sketchExpand', language)}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" style={{ transform: propsExpanded ? 'rotate(180deg)' : 'none' }}>
              <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="2" />
            </svg>
          </button>
        )}
      </div>
      {/* Expanded: shape selector (not for groups) */}
      {propsExpanded && !isGroup && node.type !== 'file' && (
        <div className="sketch-props-shapes-grid icons">
          {SKETCH_SHAPES.map(shape => (
            <button
              key={shape.value}
              className={`sketch-props-shape-btn icon${(node.shape || 'process') === shape.value ? ' active' : ''}`}
              onClick={() => updateNodeProperties(selectedNode, { shape: shape.value })}
              title={shape.value}
            >
              {SKETCH_SHAPE_ICONS[shape.value]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Single edge properties panel
// ============================================================================

interface EdgePropsPanelProps {
  edge: SketchEdge;
  selectedEdge: string;
  updateEdgeProperties: (edgeId: string, properties: Partial<SketchEdge>) => void;
  deleteEdge: (edgeId: string) => void;
  language: LanguageSetting;
}

export function EdgePropsPanel({
  edge, selectedEdge, updateEdgeProperties, deleteEdge, language,
}: EdgePropsPanelProps) {
  // v20.19 (2026-05-17, HanBin) — compact-style edge panel for visual
  // parity with NodePropsPanel. Was a full panel with header + sectioned
  // color grid + delete button; now a single horizontal toolbar row
  // (colors + delete) matching the node compact panel. Label switched
  // from sketchColor to sketchBorderColor for terminology consistency
  // with the unified "테두리 색상" merge in v20.12/v20.15.
  return (
    <div className="sketch-properties-panel compact" onMouseDown={e => e.stopPropagation()}>
      <div className="sketch-props-toolbar">
        <div className="sketch-props-colors-row">
          {EDGE_COLORS.map(color => (
            <button
              key={color.value}
              className={`sketch-props-color-btn${(edge.color || '#666') === color.value ? ' active' : ''}`}
              style={{ backgroundColor: color.value }}
              onClick={() => updateEdgeProperties(selectedEdge, { color: color.value })}
              title={`${t('sketchBorderColor', language)} · ${color.name}`}
            />
          ))}
        </div>
        <button
          className="sketch-props-edge-delete-btn"
          onClick={() => deleteEdge(selectedEdge)}
          title={t('sketchDeleteArrow', language)}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M2 4h12M6 4V2.5A.5.5 0 016.5 2h3a.5.5 0 01.5.5V4M4 4l1 9.5a1 1 0 001 1h4a1 1 0 001-1L12 4" />
          </svg>
        </button>
      </div>
    </div>
  );
}

// ============================================================================
// Node context menu
// ============================================================================

interface NodeContextMenuProps {
  contextMenu: { x: number; y: number; nodeId: string };
  node: SketchNode;
  data: SketchData;
  onChange: (data: SketchData) => void;
  updateNodeProperties: (nodeId: string, properties: Partial<SketchNode>) => void;
  setEditingNode: (id: string | null) => void;
  deleteNode: (nodeId: string) => void;
  closeContextMenu: () => void;
  language: LanguageSetting;
}

function getContextNodeColors(isGroup?: boolean) {
  if (isGroup) return GROUP_COLORS;
  const colors = getNodeColors();
  // Reorder: default last
  return [...colors.slice(1), colors[0]];
}

export function NodeContextMenu({
  contextMenu, node, data, onChange, updateNodeProperties,
  setEditingNode, deleteNode, closeContextMenu, language,
}: NodeContextMenuProps) {
  // Auto-adjust position so menu doesn't overflow viewport
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let x = contextMenu.x;
    let y = contextMenu.y;
    if (rect.right > vw) x = vw - rect.width - 8;
    if (rect.bottom > vh) y = vh - rect.height - 8;
    if (x < 0) x = 8;
    if (y < 0) y = 8;
    if (x !== contextMenu.x || y !== contextMenu.y) {
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
    }
  }, [contextMenu.x, contextMenu.y]);

  const bringToFront = () => {
    const others = data.nodes.filter(n => n.id !== contextMenu.nodeId);
    const target = data.nodes.find(n => n.id === contextMenu.nodeId);
    if (target) onChange({ ...data, nodes: [...others, target] });
    closeContextMenu();
  };
  const sendToBack = () => {
    const others = data.nodes.filter(n => n.id !== contextMenu.nodeId);
    const target = data.nodes.find(n => n.id === contextMenu.nodeId);
    if (target) onChange({ ...data, nodes: [target, ...others] });
    closeContextMenu();
  };
  return createPortal(
    <>
      {/* Backdrop to close menu */}
      <div
        className="sketch-context-backdrop"
        onClick={closeContextMenu}
        onContextMenu={e => { e.preventDefault(); closeContextMenu(); }}
      />
      <div
        ref={menuRef}
        className="sketch-context-menu"
        style={{ left: contextMenu.x, top: contextMenu.y }}
      >
        <div className="sketch-context-section">
          <div className="sketch-context-label">{t('sketchNodeColor', language)}</div>
          <div className="sketch-context-colors">
            {getContextNodeColors(node.type === 'group' || node.isGroup).map(c => (
              <button
                key={c.value}
                className={`sketch-context-color-btn${(node.color || 'node-default') === c.value ? ' active' : ''}`}
                style={{ backgroundColor: (c as any).cssVar ? `var(${(c as any).cssVar})` : c.value }}
                onClick={() => {
                  updateNodeProperties(contextMenu.nodeId, { color: c.value });
                  closeContextMenu();
                }}
                title={c.name}
              />
            ))}
          </div>
        </div>
        {/* v20.12 (2026-05-17, HanBin) — border color picker for single
            node context menu. Same EDGE_COLORS palette as the unified
            picker on the multi-select panel. Sets node.borderColor; the
            shape-specific renderer in SketchEditor reads it to draw the
            outline (CSS border-color for rectangles, SVG stroke for
            decision/io/database/etc.). */}
        <div className="sketch-context-section">
          <div className="sketch-context-label">{t('sketchBorderColor', language)}</div>
          <div className="sketch-context-colors">
            {EDGE_COLORS.map(c => (
              <button
                key={c.value}
                className={`sketch-context-color-btn${(node.borderColor || '') === c.value ? ' active' : ''}`}
                style={{ backgroundColor: c.value }}
                onClick={() => {
                  updateNodeProperties(contextMenu.nodeId, { borderColor: c.value });
                  closeContextMenu();
                }}
                title={c.name}
              />
            ))}
          </div>
        </div>
        {/* Shape selector — not for group nodes */}
        {!(node.type === 'group' || node.isGroup) && (
          <div className="sketch-context-section">
            <div className="sketch-context-label">{t('sketchShape', language)}</div>
            <div className="sketch-context-shapes">
              {SKETCH_SHAPES.map(shape => (
                <button
                  key={shape.value}
                  className={`sketch-context-shape-btn${(node.shape || 'process') === shape.value ? ' active' : ''}`}
                  onClick={() => {
                    updateNodeProperties(contextMenu.nodeId, { shape: shape.value });
                    closeContextMenu();
                  }}
                  title={shape.value}
                >
                  {SKETCH_SHAPE_ICONS[shape.value]}
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="sketch-context-divider" />
        <button className="sketch-context-item" onClick={bringToFront}>
          {t('sketchBringToFront', language)}
        </button>
        <button className="sketch-context-item" onClick={sendToBack}>
          {t('sketchSendToBack', language)}
        </button>
        <div className="sketch-context-divider" />
        <button
          className="sketch-context-item"
          onClick={() => {
            setEditingNode(contextMenu.nodeId);
            closeContextMenu();
          }}
        >
          {(node.type === 'group' || node.isGroup) ? t('sketchRenameGroup', language) : t('sketchEditNode', language)}
        </button>
        <button
          className="sketch-context-item delete"
          onClick={() => {
            deleteNode(contextMenu.nodeId);
            closeContextMenu();
          }}
        >
          {(node.type === 'group' || node.isGroup) ? t('sketchDeleteGroup', language) : t('sketchDeleteNode', language)}
        </button>
      </div>
    </>,
    document.body
  );
}

// ============================================================================
// Multi-select context menu (right-click on multi-selected node)
// ============================================================================

interface MultiSelectContextMenuProps {
  position: { x: number; y: number };
  data: SketchData;
  onChange: (data: SketchData) => void;
  selectedNodes: string[];
  selectedEdges: string[];
  setSelectedNodes: (ids: string[]) => void;
  setSelectedEdges: (ids: string[]) => void;
  closeMenu: () => void;
  language: LanguageSetting;
}

export function MultiSelectContextMenu({
  position, data, onChange, selectedNodes, selectedEdges,
  setSelectedNodes, setSelectedEdges, closeMenu, language,
}: MultiSelectContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let x = position.x;
    let y = position.y;
    if (rect.right > vw) x = vw - rect.width - 8;
    if (rect.bottom > vh) y = vh - rect.height - 8;
    if (x < 0) x = 8;
    if (y < 0) y = 8;
    if (x !== position.x || y !== position.y) {
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
    }
  }, [position.x, position.y]);

  const updateMultipleNodes = (updates: Partial<SketchNode>) => {
    const updatedNodes = data.nodes.map(node =>
      selectedNodes.includes(node.id) ? { ...node, ...updates } : node
    );
    onChange({ ...data, nodes: updatedNodes });
  };

  const deleteSelection = () => {
    const updatedNodes = data.nodes.filter(n => !selectedNodes.includes(n.id));
    const updatedEdges = data.edges.filter(e =>
      !selectedEdges.includes(e.id) &&
      !selectedNodes.includes(e.fromNode) &&
      !selectedNodes.includes(e.toNode)
    );
    onChange({ nodes: updatedNodes, edges: updatedEdges });
    setSelectedNodes([]);
    setSelectedEdges([]);
    closeMenu();
  };

  return createPortal(
    <>
      <div
        className="sketch-context-backdrop"
        onClick={closeMenu}
        onContextMenu={e => { e.preventDefault(); closeMenu(); }}
      />
      <div
        ref={menuRef}
        className="sketch-context-menu"
        style={{ left: position.x, top: position.y }}
      >
        {selectedNodes.length > 0 && (
          <div className="sketch-context-section">
            <div className="sketch-context-label">{t('sketchNodeColor', language)}</div>
            <div className="sketch-context-colors">
              {getNodeColors().map(c => (
                <button
                  key={c.value}
                  className="sketch-context-color-btn"
                  /* v20.11 — same swatch fix as MultiSelectPanel (var(--xxx)
                     instead of semantic key string). */
                  style={{ backgroundColor: `var(${c.cssVar})` }}
                  onClick={() => {
                    updateMultipleNodes({ color: c.value });
                    closeMenu();
                  }}
                  title={c.name}
                />
              ))}
            </div>
          </div>
        )}
        {/* v20.15 (2026-05-17, HanBin) — unified "테두리 색상" picker in
            the MULTI-SELECT context menu (was missed in v20.12 — only
            the MultiSelectPanel sidebar got the merge then). Applies the
            same color to selected nodes' borderColor AND selected edges'
            color so node outline + arrow are visually paired. */}
        {(selectedNodes.length > 0 || selectedEdges.length > 0) && (
          <div className="sketch-context-section">
            <div className="sketch-context-label">{t('sketchBorderColor', language)}</div>
            <div className="sketch-context-colors">
              {EDGE_COLORS.map(c => (
                <button
                  key={c.value}
                  className="sketch-context-color-btn"
                  style={{ backgroundColor: c.value }}
                  onClick={() => {
                    let next = data;
                    if (selectedNodes.length > 0) {
                      const updatedNodes = next.nodes.map(node =>
                        selectedNodes.includes(node.id) ? { ...node, borderColor: c.value } : node
                      );
                      next = { ...next, nodes: updatedNodes };
                    }
                    if (selectedEdges.length > 0) {
                      const updatedEdges = next.edges.map(edge =>
                        selectedEdges.includes(edge.id) ? { ...edge, color: c.value } : edge
                      );
                      next = { ...next, edges: updatedEdges };
                    }
                    onChange(next);
                    closeMenu();
                  }}
                  title={c.name}
                />
              ))}
            </div>
          </div>
        )}
        <div className="sketch-context-divider" />
        <button
          className="sketch-context-item delete"
          onClick={deleteSelection}
        >
          {t('sketchDeleteSelection', language)}
        </button>
      </div>
    </>,
    document.body
  );
}
