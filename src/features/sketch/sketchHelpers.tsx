import type { SketchNode } from '../../core/types';

// Collision-resistant unique ID generator
let idCounter = 0;
export function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${(++idCounter).toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp'];

// Shape definitions for node styling (shared between properties panel and context menu)
export const SKETCH_SHAPES = [
  { value: 'process' as const },
  { value: 'terminal' as const },
  { value: 'decision' as const },
  { value: 'io' as const },
  { value: 'subroutine' as const },
  { value: 'database' as const },
];

// Shape icons - visual representations for intuitive selection
export const SKETCH_SHAPE_ICONS: Record<string, React.ReactNode> = {
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

// Shared logic: find text node at sketch coordinates
export function findTextNodeAtPosition(nodes: SketchNode[], x: number, y: number): SketchNode | null {
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
