/**
 * v20.4 (2026-05-16, HanBin) — sketch clipboard (copy / cut / paste).
 *
 * Excalidraw / Obsidian Canvas convention:
 *   - Copy/Cut serialise the selected node + edge subgraph into a JSON
 *     payload kept in module-level state (single-app clipboard) and ALSO
 *     pushed to the system clipboard as JSON text so cross-window paste
 *     works.
 *   - Paste deserialises, regenerates all ids (no collisions with existing
 *     nodes), offsets positions by +20/+20 so the pasted block is visually
 *     distinct from the source, and remaps edges to the new ids.
 *
 * The clipboard payload is keyed under a sentinel "type": "notology/sketch"
 * so we can recognise our own format when the system clipboard contains
 * something else (e.g., plain text from another app).
 */
import type { SketchData, SketchNode, SketchEdge } from '../../core/types';
import { generateId } from './sketchHelpers';

const SENTINEL = 'notology/sketch';

interface ClipboardPayload {
  type: typeof SENTINEL;
  nodes: SketchNode[];
  edges: SketchEdge[];
}

// In-memory copy survives across paste invocations within one session
// even if the system clipboard is replaced by another app afterwards.
let lastInternalCopy: ClipboardPayload | null = null;

/** Serialise the selected subgraph and return the payload + JSON string. */
export function copySelection(
  data: SketchData,
  selectedNodeIds: string[],
  selectedEdgeIds: string[],
): ClipboardPayload | null {
  if (selectedNodeIds.length === 0 && selectedEdgeIds.length === 0) return null;
  const nodeIdSet = new Set(selectedNodeIds);
  const nodes = data.nodes.filter(n => nodeIdSet.has(n.id));
  // Auto-include edges that connect two selected nodes — that's the natural
  // copy expectation. Explicit selected edges are also included.
  const explicitEdgeIds = new Set(selectedEdgeIds);
  const edges = (data.edges || []).filter(e =>
    explicitEdgeIds.has(e.id) || (nodeIdSet.has(e.fromNode) && nodeIdSet.has(e.toNode))
  );
  const payload: ClipboardPayload = { type: SENTINEL, nodes, edges };
  lastInternalCopy = payload;
  // Push to system clipboard as text — async, fire-and-forget. Cross-window
  // paste relies on this; same-window paste reads `lastInternalCopy`
  // synchronously instead so it works even when the OS clipboard API is
  // blocked (some webview contexts).
  try {
    void navigator.clipboard?.writeText(JSON.stringify(payload));
  } catch { /* permissions / context — internal copy still works */ }
  return payload;
}

/**
 * Try to read a sketch clipboard payload. Returns the in-memory copy first
 * (most reliable + most recent), then falls back to the system clipboard
 * if the user copied from another window.
 */
export async function readClipboard(): Promise<ClipboardPayload | null> {
  if (lastInternalCopy) return lastInternalCopy;
  try {
    const text = await navigator.clipboard?.readText();
    if (!text) return null;
    const parsed = JSON.parse(text);
    if (parsed && parsed.type === SENTINEL && Array.isArray(parsed.nodes)) {
      return parsed as ClipboardPayload;
    }
  } catch { /* not JSON or denied — caller treats as no-op */ }
  return null;
}

/**
 * Apply a paste: regenerate ids, offset positions, remap edges, return new
 * data + the ids of the freshly-pasted nodes (for selection update).
 */
export interface PasteResult {
  data: SketchData;
  newNodeIds: string[];
  newEdgeIds: string[];
}

const PASTE_OFFSET = 24;

export function applyPaste(
  current: SketchData,
  payload: ClipboardPayload,
  /** Optional explicit anchor (world coords). If omitted, uses fixed offset. */
  anchor?: { x: number; y: number },
): PasteResult {
  // Compute the bounding-box top-left of the payload so we can position
  // the paste at the requested anchor instead of relative offset, when
  // an anchor is supplied (e.g., paste-at-cursor).
  let minX = Infinity, minY = Infinity;
  for (const n of payload.nodes) {
    if (n.x < minX) minX = n.x;
    if (n.y < minY) minY = n.y;
  }
  if (!isFinite(minX)) { minX = 0; minY = 0; }
  const dx = anchor ? anchor.x - minX : PASTE_OFFSET;
  const dy = anchor ? anchor.y - minY : PASTE_OFFSET;

  // Build id remap so edges follow nodes to their new ids.
  const idMap = new Map<string, string>();
  const newNodes: SketchNode[] = payload.nodes.map(n => {
    const newId = generateId('node');
    idMap.set(n.id, newId);
    return { ...n, id: newId, x: n.x + dx, y: n.y + dy };
  });
  const newEdges: SketchEdge[] = payload.edges
    .map(e => {
      const fromNode = idMap.get(e.fromNode);
      const toNode = idMap.get(e.toNode);
      if (!fromNode || !toNode) return null;
      return { ...e, id: generateId('edge'), fromNode, toNode };
    })
    .filter((e): e is SketchEdge => e !== null);

  return {
    data: {
      ...current,
      nodes: [...current.nodes, ...newNodes],
      edges: [...(current.edges || []), ...newEdges],
    },
    newNodeIds: newNodes.map(n => n.id),
    newEdgeIds: newEdges.map(e => e.id),
  };
}
