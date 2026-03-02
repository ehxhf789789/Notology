// ==================== XML Helpers ====================

export function getElements(parent: Element, tagName: string): Element[] {
  const colonIdx = tagName.indexOf(':');
  if (colonIdx > 0) {
    const localName = tagName.substring(colonIdx + 1);
    return Array.from(parent.getElementsByTagName(tagName)).concat(
      Array.from(parent.getElementsByTagName(localName))
    );
  }
  return Array.from(parent.getElementsByTagName(tagName));
}

export function getElement(parent: Element, tagName: string): Element | null {
  const elements = getElements(parent, tagName);
  return elements.length > 0 ? elements[0] : null;
}

export function getDirectChildren(parent: Element, tagName: string): Element[] {
  const results: Element[] = [];
  const localName = tagName.includes(':') ? tagName.split(':')[1] : tagName;
  for (let i = 0; i < parent.childNodes.length; i++) {
    const child = parent.childNodes[i];
    if (child.nodeType === 1) {
      const el = child as Element;
      const tag = el.tagName || el.nodeName;
      if (tag === tagName || tag === localName) results.push(el);
    }
  }
  return results;
}

export function getAttr(el: Element | null, name: string): string | null {
  if (!el) return null;
  return el.getAttribute(`w:${name}`) || el.getAttribute(name);
}

export function getVal(el: Element | null): string | null {
  return getAttr(el, 'val');
}
