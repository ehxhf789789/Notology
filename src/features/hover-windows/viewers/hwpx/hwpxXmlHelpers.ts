// ==================== XML Helpers ====================

/** Parse HWPX integer that may be uint32-encoded signed int32 (e.g., 4294967281 = -15) */
export function parseHwpInt(val: string): number {
  const n = parseInt(val);
  return n > 0x7FFFFFFF ? n - 0x100000000 : n;
}

export function directChildren(parent: Element, localName: string): Element[] {
  const results: Element[] = [];
  for (let i = 0; i < parent.children.length; i++) {
    const child = parent.children[i];
    const tag = child.localName || child.tagName.split(':').pop() || '';
    if (tag === localName) results.push(child);
  }
  return results;
}

export function directChild(parent: Element, localName: string): Element | null {
  for (let i = 0; i < parent.children.length; i++) {
    const child = parent.children[i];
    const tag = child.localName || child.tagName.split(':').pop() || '';
    if (tag === localName) return child;
  }
  return null;
}

export function findElement(parent: Element, localName: string): Element | null {
  return parent.getElementsByTagName(`hp:${localName}`)[0] ||
         parent.getElementsByTagName(`hh:${localName}`)[0] ||
         parent.getElementsByTagName(`hc:${localName}`)[0] ||
         parent.getElementsByTagName(localName)[0] || null;
}
