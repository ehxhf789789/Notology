import type { DrawingElement } from './docxTypes';
import { getElement } from './docxXmlHelpers';
import { EMU_PER_PIXEL } from '../shared/viewerConstants';
import JSZip from 'jszip';

// ==================== Relationships / Images ====================

export async function parseRelationships(zip: JSZip): Promise<Map<string, string>> {
  const images = new Map<string, string>();
  const relsFile = zip.file('word/_rels/document.xml.rels');
  if (!relsFile) return images;

  const relsXml = await relsFile.async('string');
  const parser = new DOMParser();
  const doc = parser.parseFromString(relsXml, 'application/xml');

  const relationships = doc.getElementsByTagName('Relationship');
  for (let i = 0; i < relationships.length; i++) {
    const rel = relationships[i];
    const id = rel.getAttribute('Id');
    const target = rel.getAttribute('Target');
    const type = rel.getAttribute('Type');

    if (id && target && type?.includes('image')) {
      const imagePath = target.startsWith('/') ? target.substring(1) : `word/${target}`;
      const imageFile = zip.file(imagePath);
      if (imageFile) {
        const imageData = await imageFile.async('base64');
        const ext = target.split('.').pop()?.toLowerCase() || 'png';
        const mimeMap: Record<string, string> = {
          png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
          gif: 'image/gif', bmp: 'image/bmp', svg: 'image/svg+xml',
          tif: 'image/tiff', tiff: 'image/tiff',
          emf: 'image/x-emf', wmf: 'image/x-wmf',
        };
        images.set(id, `data:${mimeMap[ext] || 'image/png'};base64,${imageData}`);
      }
    }
  }

  return images;
}

// ==================== Step 9: Drawing/Image (with srcRect) ====================

export function parseDrawing(drawingEl: Element, images: Map<string, string>): DrawingElement | null {
  const inline = getElement(drawingEl, 'wp:inline');
  const anchor = getElement(drawingEl, 'wp:anchor');
  const container = inline || anchor;
  if (!container) return null;

  const extentEl = getElement(container, 'wp:extent');
  const width = extentEl ? parseInt(extentEl.getAttribute('cx') || '0') / EMU_PER_PIXEL : 100;
  const height = extentEl ? parseInt(extentEl.getAttribute('cy') || '0') / EMU_PER_PIXEL : 100;

  const blipEl = getElement(container, 'a:blip');
  const imageId = blipEl ? (blipEl.getAttribute('r:embed') || blipEl.getAttribute('embed')) : null;
  const imageSrc = imageId ? images.get(imageId) : undefined;

  // Step 9: srcRect cropping
  const blipFill = getElement(container, 'pic:blipFill') || getElement(container, 'a:blipFill');
  const srcRectEl = blipFill ? getElement(blipFill, 'a:srcRect') : null;
  let cropTop = 0, cropBottom = 0, cropLeft = 0, cropRight = 0;
  if (srcRectEl) {
    cropTop = parseInt(srcRectEl.getAttribute('t') || '0') / 1000;
    cropBottom = parseInt(srcRectEl.getAttribute('b') || '0') / 1000;
    cropLeft = parseInt(srcRectEl.getAttribute('l') || '0') / 1000;
    cropRight = parseInt(srcRectEl.getAttribute('r') || '0') / 1000;
  }

  return {
    type: 'image',
    width,
    height,
    inline: !!inline,
    imageId: imageId || undefined,
    imageSrc,
    cropTop, cropBottom, cropLeft, cropRight,
  };
}
