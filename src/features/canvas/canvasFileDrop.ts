import type { CanvasData, CanvasNode } from '../../core/types';
import { generateId, IMAGE_EXTS } from './canvasHelpers';

// Shared logic: insert wikilinks into a text node or create file nodes
export function applyFileDrop(
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
