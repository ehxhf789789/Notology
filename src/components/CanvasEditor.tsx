import { useRef } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { utilCommands } from '../services/tauriCommands';
import { hoverActions } from '../stores/zustand/hoverStore';
import { useSettingsStore } from '../stores/zustand/settingsStore';
import { t } from '../utils/i18n';
import { useCanvasInteraction, getHandlePosition } from '../hooks/useCanvasInteraction';
import { MultiSelectPanel, NodePropsPanel, EdgePropsPanel, NodeContextMenu } from '../canvas/CanvasPropertiesPanel';
import type { CanvasData, CanvasSelection } from '../types';

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

  const canvasRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const [state, actions] = useCanvasInteraction({ data, onChange, readOnly, notePath, canvasRef });

  const {
    selectedNode, selectedEdge, selectedNodes, selectedEdges,
    draggingNode, isPanning, isSelecting, resizingNode, editingNode,
    connectingFrom, connectionPreview, hoveredNode, isDragOver,
    selectionBox, viewportOffset, viewportScale, contextMenu, propsExpanded,
  } = state;

  const {
    setSelectedNode, setSelectedEdge, setSelectedNodes, setSelectedEdges,
    setEditingNode, setHoveredNode, setViewportScale, setPropsExpanded,
    handleNodeMouseDown, handleConnectionStart, handleResizeStart,
    handleCanvasMouseDown, handleCanvasDoubleClick, handleEdgeClick,
    handleDragOver, handleDragLeave, handleDrop,
    deleteNode, deleteEdge, updateNodeText, updateNodeProperties,
    updateEdgeProperties, handleNodeDoubleClick, handleNodeContextMenu,
    closeContextMenu, getEdgePath, getConnectionPreviewPath,
    renderNodeText, setCanvasRef,
  } = actions;

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
                const relatedTarget = e.relatedTarget as HTMLElement | null;
                if (!relatedTarget || !e.currentTarget.contains(relatedTarget)) {
                  setHoveredNode(null);
                }
              }}
              onDoubleClick={e => {
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

                const decisionPoints = `${w / 2},${inset} ${w - inset},${h / 2} ${w / 2},${h - inset} ${inset},${h / 2}`;
                const ioPoints = `${w * 0.15 + inset},${inset} ${w - inset},${inset} ${w * 0.85 - inset},${h - inset} ${inset},${h - inset}`;

                const getStrokeColor = () =>
                  connectingFrom?.nodeId === node.id
                    ? '#00d4aa'
                    : isSelected || hoveredNode === node.id
                    ? '#00d4aa'
                    : '#555';

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
                          stroke={getStrokeColor()}
                          strokeWidth={strokeWidth}
                        />
                      ) : node.shape === 'io' ? (
                        <polygon
                          points={ioPoints}
                          fill={node.color || defaultNodeColor}
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
                            fill={node.color || defaultNodeColor}
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
                            fill={node.color || defaultNodeColor}
                            stroke={getStrokeColor()}
                            strokeWidth={strokeWidth}
                          />
                          {/* Bottom ellipse */}
                          <ellipse
                            cx={w / 2}
                            cy={h - 16}
                            rx={w / 2 - inset}
                            ry={16 - inset}
                            fill={node.color || defaultNodeColor}
                            stroke={getStrokeColor()}
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

                      let lineStart = selectionStart;
                      while (lineStart > 0 && value[lineStart - 1] !== '\n') {
                        lineStart--;
                      }

                      const lineEnd = value.indexOf('\n', selectionStart);
                      const currentLine = value.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
                      const headingMatch = currentLine.match(/^(#{1,3})\s+/);

                      let newText: string;
                      let newCursorPos: number;

                      if (headingMatch) {
                        const oldPrefix = headingMatch[0];
                        newText = value.slice(0, lineStart) + prefix + currentLine.slice(oldPrefix.length) + value.slice(lineEnd === -1 ? value.length : lineEnd);
                        newCursorPos = lineStart + prefix.length + (selectionStart - lineStart - oldPrefix.length);
                      } else {
                        newText = value.slice(0, lineStart) + prefix + value.slice(lineStart);
                        newCursorPos = selectionStart + prefix.length;
                      }

                      updateNodeText(node.id, newText);
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

      {/* Multi-selection properties panel */}
      {!readOnly && (selectedNodes.length > 0 || selectedEdges.length > 0) && !selectedNode && !selectedEdge && (
        <MultiSelectPanel
          data={data}
          onChange={onChange}
          selectedNodes={selectedNodes}
          selectedEdges={selectedEdges}
          setSelectedNodes={setSelectedNodes}
          setSelectedEdges={setSelectedEdges}
          language={language}
        />
      )}

      {/* Single node properties panel */}
      {!readOnly && selectedNode && (() => {
        const node = data.nodes.find(n => n.id === selectedNode);
        if (!node) return null;
        return (
          <NodePropsPanel
            node={node}
            selectedNode={selectedNode}
            propsExpanded={propsExpanded}
            setPropsExpanded={setPropsExpanded}
            updateNodeProperties={updateNodeProperties}
            language={language}
          />
        );
      })()}

      {/* Single edge properties panel */}
      {!readOnly && selectedEdge && (() => {
        const edge = data.edges.find(e => e.id === selectedEdge);
        if (!edge) return null;
        return (
          <EdgePropsPanel
            edge={edge}
            selectedEdge={selectedEdge}
            updateEdgeProperties={updateEdgeProperties}
            deleteEdge={deleteEdge}
            language={language}
          />
        );
      })()}

      {/* Node Context Menu */}
      {contextMenu && (() => {
        const node = data.nodes.find(n => n.id === contextMenu.nodeId);
        if (!node) return null;
        return (
          <NodeContextMenu
            contextMenu={contextMenu}
            node={node}
            updateNodeProperties={updateNodeProperties}
            setEditingNode={setEditingNode}
            deleteNode={deleteNode}
            closeContextMenu={closeContextMenu}
            language={language}
          />
        );
      })()}
    </div>
  );
}

export default CanvasEditor;
