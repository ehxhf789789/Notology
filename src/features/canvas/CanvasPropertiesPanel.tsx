import type { CanvasData, CanvasNode, CanvasEdge } from '../../core/types';
import { t, tf, type LanguageSetting } from '../../core/utils/i18n';
import { CANVAS_SHAPES, CANVAS_SHAPE_ICONS } from './canvasHelpers';

// ============================================================================
// Multi-selection properties panel
// ============================================================================

interface MultiSelectPanelProps {
  data: CanvasData;
  onChange: (data: CanvasData) => void;
  selectedNodes: string[];
  selectedEdges: string[];
  setSelectedNodes: (ids: string[]) => void;
  setSelectedEdges: (ids: string[]) => void;
  language: LanguageSetting;
}

const NODE_COLORS = [
  { name: 'Dark Gray', value: '#2d2d2d' },
  { name: 'Blue', value: '#1e3a5f' },
  { name: 'Green', value: '#1e4d2b' },
  { name: 'Red', value: '#4d1e1e' },
  { name: 'Purple', value: '#3d1e4d' },
  { name: 'Orange', value: '#4d3a1e' },
];

const EDGE_COLORS = [
  { name: 'Gray', value: '#666' },
  { name: 'Blue', value: '#007acc' },
  { name: 'Green', value: '#00d4aa' },
  { name: 'Red', value: '#e74856' },
  { name: 'Yellow', value: '#f9d71c' },
  { name: 'Purple', value: '#b180d7' },
];

export function MultiSelectPanel({
  data, onChange, selectedNodes, selectedEdges,
  setSelectedNodes, setSelectedEdges, language,
}: MultiSelectPanelProps) {
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
            {NODE_COLORS.map(color => (
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
            {EDGE_COLORS.map(color => (
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
}

// ============================================================================
// Single node properties panel (compact)
// ============================================================================

interface NodePropsPanelProps {
  node: CanvasNode;
  selectedNode: string;
  propsExpanded: boolean;
  setPropsExpanded: (expanded: boolean) => void;
  updateNodeProperties: (nodeId: string, properties: Partial<CanvasNode>) => void;
  language: LanguageSetting;
}

const COMPACT_COLORS = [
  { value: '#2d2d2d' }, { value: '#1e3a5f' }, { value: '#1e4d2b' },
  { value: '#4d1e1e' }, { value: '#3d1e4d' }, { value: '#4d3a1e' },
];

export function NodePropsPanel({
  node, selectedNode, propsExpanded, setPropsExpanded,
  updateNodeProperties, language,
}: NodePropsPanelProps) {
  return (
    <div
      className={`canvas-properties-panel compact${propsExpanded ? ' expanded' : ''}`}
      onMouseDown={e => e.stopPropagation()}
    >
      {/* Compact toolbar row */}
      <div className="canvas-props-toolbar">
        {/* Color picker */}
        <div className="canvas-props-colors-row">
          {COMPACT_COLORS.map(c => (
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
}

// ============================================================================
// Single edge properties panel
// ============================================================================

interface EdgePropsPanelProps {
  edge: CanvasEdge;
  selectedEdge: string;
  updateEdgeProperties: (edgeId: string, properties: Partial<CanvasEdge>) => void;
  deleteEdge: (edgeId: string) => void;
  language: LanguageSetting;
}

export function EdgePropsPanel({
  edge, selectedEdge, updateEdgeProperties, deleteEdge, language,
}: EdgePropsPanelProps) {
  return (
    <div className="canvas-properties-panel" onMouseDown={e => e.stopPropagation()}>
      <div className="canvas-properties-header">{t('canvasArrowProperties', language)}</div>

      <div className="canvas-properties-section">
        <div className="canvas-properties-label">{t('canvasColor', language)}</div>
        <div className="canvas-properties-colors">
          {EDGE_COLORS.map(color => (
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
}

// ============================================================================
// Node context menu
// ============================================================================

interface NodeContextMenuProps {
  contextMenu: { x: number; y: number; nodeId: string };
  node: CanvasNode;
  updateNodeProperties: (nodeId: string, properties: Partial<CanvasNode>) => void;
  setEditingNode: (id: string | null) => void;
  deleteNode: (nodeId: string) => void;
  closeContextMenu: () => void;
  language: LanguageSetting;
}

const CONTEXT_NODE_COLORS = [
  { name: 'Blue', value: '#1e3a5f' },
  { name: 'Green', value: '#2d4a2c' },
  { name: 'Red', value: '#5f1e1e' },
  { name: 'Purple', value: '#3a1e5f' },
  { name: 'Orange', value: '#5f3a1e' },
  { name: 'Default', value: '#2d2d2d' },
];

export function NodeContextMenu({
  contextMenu, node, updateNodeProperties,
  setEditingNode, deleteNode, closeContextMenu, language,
}: NodeContextMenuProps) {
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
            {CONTEXT_NODE_COLORS.map(c => (
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
}
