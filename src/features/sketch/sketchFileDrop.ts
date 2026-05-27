import type { SketchData, SketchNode } from '../../core/types';
import { generateId, IMAGE_EXTS } from './sketchHelpers';

// Shared logic: insert wikilinks into a text node or create file nodes
export function applyFileDrop(
  currentData: SketchData,
  files: { name: string; path: string }[],
  dropX: number,
  dropY: number,
  targetTextNode: SketchNode | null,
): SketchData {
  if (targetTextNode) {
    const wikilinks = files.map(f => `[[${f.name}]]`).join('\n');
    const newText = (targetTextNode.text || '') + (targetTextNode.text ? '\n' : '') + wikilinks;
    const updatedNodes = currentData.nodes.map(n =>
      n.id === targetTextNode.id ? { ...n, text: newText } : n
    );
    return { ...currentData, nodes: updatedNodes };
  }

  const newNodes: SketchNode[] = [];
  let offsetY = 0;

  // v20.14 (2026-05-17, HanBin) — unified file node size with text node
  // default (200×100). User: "첨부파일 노드도 일반 노드와 사이즈 동일하게
  // 수정. 노드 크기가 너무 큼." Image gets a tiny bit more height (150) so
  // the preview thumbnail isn't squashed; everything else matches the
  // text-node default exactly.
  for (const file of files) {
    const ext = file.name.split('.').pop()?.toLowerCase() || '';
    const isImage = IMAGE_EXTS.includes(ext);

    newNodes.push({
      id: generateId('node'),
      type: 'file',
      x: dropX,
      y: dropY + offsetY,
      width: 200,
      height: isImage ? 150 : 100,
      file: file.path,
      text: file.name,
    });

    offsetY += (isImage ? 170 : 120);
  }

  return { ...currentData, nodes: [...currentData.nodes, ...newNodes] };
}
