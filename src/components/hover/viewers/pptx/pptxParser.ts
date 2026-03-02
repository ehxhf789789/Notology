import type { SlideData, ThemeColors, ThemeFonts } from './pptxTypes';
import { parseSlideBackground, parseShapeTree } from './pptxShapeParser';
import { EMU_PER_PIXEL } from '../shared/viewerConstants';

// ─── Slide Parsing ───

export function parseSlideXml(xmlString: string, defaultWidth: number, defaultHeight: number, rels: Map<string, string>, themeColors?: ThemeColors, themeFonts?: ThemeFonts): SlideData {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlString, 'application/xml');

  const spTree = doc.getElementsByTagName('p:spTree')[0];
  const background = parseSlideBackground(doc, themeColors);

  // Check showMasterSp attribute (default is true if not specified)
  const cSld = doc.getElementsByTagName('p:cSld')[0];
  const showMasterSpAttr = cSld?.getAttribute('showMasterSp');
  const showMasterSp = showMasterSpAttr !== '0';

  // Preserve XML order -- it defines z-order (first = bottom, last = top)
  const shapes = spTree ? parseShapeTree(spTree, rels, 0, themeColors, false, themeFonts) : [];

  return { shapes, width: defaultWidth, height: defaultHeight, background, showMasterSp };
}

export function parseRelsXml(xmlString: string): Map<string, string> {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlString, 'application/xml');
  const rels = new Map<string, string>();

  const relationships = doc.getElementsByTagName('Relationship');
  for (let i = 0; i < relationships.length; i++) {
    const rel = relationships[i];
    const id = rel.getAttribute('Id');
    const target = rel.getAttribute('Target');
    if (id && target) {
      rels.set(id, target);
    }
  }

  return rels;
}

export function parsePresentationXml(xmlString: string): { width: number; height: number } {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlString, 'application/xml');

  const sldSz = doc.getElementsByTagName('p:sldSz')[0];
  if (sldSz) {
    const cx = parseInt(sldSz.getAttribute('cx') || '9144000');
    const cy = parseInt(sldSz.getAttribute('cy') || '6858000');
    return {
      width: cx / EMU_PER_PIXEL,
      height: cy / EMU_PER_PIXEL,
    };
  }

  return { width: 960, height: 540 };
}
