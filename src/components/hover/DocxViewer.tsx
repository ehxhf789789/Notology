import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import JSZip from 'jszip';

interface DocxViewerProps {
  data: ArrayBuffer;
}

// OOXML units: 1 inch = 914400 EMU, 1 inch = 96 CSS pixels
// 1 point = 1/72 inch = 12700 EMU
const EMU_PER_PIXEL = 914400 / 96;
const TWIP_PER_PIXEL = 1440 / 96; // 1 inch = 1440 twips
const HALF_PT_PER_PIXEL = 2 / 96 * 72; // half-points to pixels

const DEV = import.meta.env.DEV;
const log = DEV ? console.log.bind(console) : (() => {}) as (...args: unknown[]) => void;

// ==================== Interfaces ====================

interface TextRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  fontSize?: number;
  fontFamily?: string;
  color?: string;
  backgroundColor?: string;
  superscript?: boolean;
  subscript?: boolean;
  highlight?: string;
}

interface Paragraph {
  runs: TextRun[];
  align?: 'left' | 'center' | 'right' | 'justify';
  lineHeight?: number;
  spaceBefore?: number;
  spaceAfter?: number;
  indent?: number;
  hangingIndent?: number;
  marginLeft?: number;
  marginRight?: number;
  bulletChar?: string;
  numberingText?: string;
  outlineLevel?: number;
  pageBreakBefore?: boolean;
  keepNext?: boolean;
  keepLines?: boolean;
}

interface BorderStyle {
  width?: number;
  color?: string;
  style?: string;
}

interface TableCell {
  content: ContentItem[];
  colSpan: number;
  rowSpan: number;
  width?: number;
  backgroundColor?: string;
  borderTop?: BorderStyle;
  borderBottom?: BorderStyle;
  borderLeft?: BorderStyle;
  borderRight?: BorderStyle;
  vertAlign?: 'top' | 'center' | 'bottom';
  gridSpan?: number;
  vMerge?: 'restart' | 'continue';
}

interface TableRow {
  cells: TableCell[];
  height?: number;
  isHeader?: boolean;
}

interface Table {
  rows: TableRow[];
  width?: number;
  colWidths: number[];
  alignment?: 'left' | 'center' | 'right';
}

interface ImageElement {
  id: string;
  width: number;
  height: number;
  src?: string;
  inline?: boolean;
  positionH?: number;
  positionV?: number;
  behindText?: boolean;
}

interface DrawingElement {
  type: 'image' | 'shape' | 'textbox';
  width: number;
  height: number;
  inline?: boolean;
  positionH?: number;
  positionV?: number;
  imageId?: string;
  imageSrc?: string;
}

type ContentItem =
  | { type: 'paragraph'; data: Paragraph }
  | { type: 'table'; data: Table }
  | { type: 'image'; data: ImageElement }
  | { type: 'drawing'; data: DrawingElement }
  | { type: 'pageBreak' }
  | { type: 'sectionBreak'; continuous?: boolean };

interface SectionProps {
  pageWidth: number;
  pageHeight: number;
  marginTop: number;
  marginBottom: number;
  marginLeft: number;
  marginRight: number;
  headerMargin?: number;
  footerMargin?: number;
  columns?: number;
}

interface DocumentData {
  content: ContentItem[];
  defaultSection: SectionProps;
  styles: Map<string, StyleDef>;
  numbering: Map<string, NumberingDef>;
  images: Map<string, string>; // relId -> base64 data URL
}

interface StyleDef {
  name: string;
  basedOn?: string;
  paragraph?: Partial<Paragraph>;
  run?: Partial<TextRun>;
}

interface NumberingDef {
  levels: Map<number, { format: string; text: string; indent: number }>;
}

// ==================== XML Namespace Helpers ====================

const NS = {
  w: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  wp: 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing',
  pic: 'http://schemas.openxmlformats.org/drawingml/2006/picture',
};

function getElements(parent: Element, tagName: string): Element[] {
  // Handle both namespaced and non-namespaced tags
  const colonIdx = tagName.indexOf(':');
  if (colonIdx > 0) {
    const localName = tagName.substring(colonIdx + 1);
    return Array.from(parent.getElementsByTagName(tagName)).concat(
      Array.from(parent.getElementsByTagName(localName))
    );
  }
  return Array.from(parent.getElementsByTagName(tagName));
}

function getElement(parent: Element, tagName: string): Element | null {
  const elements = getElements(parent, tagName);
  return elements.length > 0 ? elements[0] : null;
}

function getAttr(el: Element | null, name: string, ns?: string): string | null {
  if (!el) return null;
  if (ns) {
    return el.getAttributeNS(ns, name) || el.getAttribute(`${ns}:${name}`) || el.getAttribute(name);
  }
  return el.getAttribute(name) || el.getAttribute(`w:${name}`);
}

function getVal(el: Element | null): string | null {
  return getAttr(el, 'val');
}

// ==================== Color Parsing ====================

function parseColor(colorVal: string | null, themeColors?: Map<string, string>): string | undefined {
  if (!colorVal || colorVal === 'auto') return undefined;
  if (colorVal.startsWith('#')) return colorVal;
  if (/^[0-9A-Fa-f]{6}$/.test(colorVal)) return `#${colorVal}`;
  // Theme color handling
  if (themeColors?.has(colorVal)) return themeColors.get(colorVal);
  return undefined;
}

// ==================== Parse Styles ====================

function parseStyles(xml: Document): Map<string, StyleDef> {
  const styles = new Map<string, StyleDef>();
  const styleEls = getElements(xml.documentElement, 'w:style');

  for (const styleEl of styleEls) {
    const styleId = getAttr(styleEl, 'styleId');
    if (!styleId) continue;

    const nameEl = getElement(styleEl, 'w:name');
    const basedOnEl = getElement(styleEl, 'w:basedOn');
    const pPrEl = getElement(styleEl, 'w:pPr');
    const rPrEl = getElement(styleEl, 'w:rPr');

    const style: StyleDef = {
      name: getVal(nameEl) || styleId,
      basedOn: getVal(basedOnEl) || undefined,
      paragraph: pPrEl ? parseParagraphProps(pPrEl) : undefined,
      run: rPrEl ? parseRunProps(rPrEl) : undefined,
    };

    styles.set(styleId, style);
  }

  return styles;
}

// ==================== Parse Numbering ====================

function parseNumbering(xml: Document): Map<string, NumberingDef> {
  const numbering = new Map<string, NumberingDef>();
  const abstractNums = getElements(xml.documentElement, 'w:abstractNum');
  const nums = getElements(xml.documentElement, 'w:num');

  const abstractMap = new Map<string, NumberingDef>();

  for (const absNum of abstractNums) {
    const abstractNumId = getAttr(absNum, 'abstractNumId');
    if (!abstractNumId) continue;

    const levels = new Map<number, { format: string; text: string; indent: number }>();
    const lvlEls = getElements(absNum, 'w:lvl');

    for (const lvl of lvlEls) {
      const ilvl = parseInt(getAttr(lvl, 'ilvl') || '0');
      const numFmt = getVal(getElement(lvl, 'w:numFmt')) || 'decimal';
      const lvlText = getVal(getElement(lvl, 'w:lvlText')) || '';
      const indEl = getElement(lvl, 'w:pPr');
      const indLeft = indEl ? parseInt(getAttr(getElement(indEl, 'w:ind'), 'left') || '0') / TWIP_PER_PIXEL : 0;

      levels.set(ilvl, { format: numFmt, text: lvlText, indent: indLeft });
    }

    abstractMap.set(abstractNumId, { levels });
  }

  for (const num of nums) {
    const numId = getAttr(num, 'numId');
    const abstractNumIdEl = getElement(num, 'w:abstractNumId');
    const abstractNumId = getVal(abstractNumIdEl);

    if (numId && abstractNumId && abstractMap.has(abstractNumId)) {
      numbering.set(numId, abstractMap.get(abstractNumId)!);
    }
  }

  return numbering;
}

// ==================== Parse Relationships ====================

async function parseRelationships(zip: JSZip): Promise<Map<string, string>> {
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
          png: 'image/png',
          jpg: 'image/jpeg',
          jpeg: 'image/jpeg',
          gif: 'image/gif',
          bmp: 'image/bmp',
          svg: 'image/svg+xml',
        };
        const mime = mimeMap[ext] || 'image/png';
        images.set(id, `data:${mime};base64,${imageData}`);
      }
    }
  }

  return images;
}

// ==================== Parse Run Properties ====================

function parseRunProps(rPr: Element): Partial<TextRun> {
  const run: Partial<TextRun> = {};

  if (getElement(rPr, 'w:b')) run.bold = true;
  if (getElement(rPr, 'w:i')) run.italic = true;
  if (getElement(rPr, 'w:u')) run.underline = true;
  if (getElement(rPr, 'w:strike')) run.strikethrough = true;

  const szEl = getElement(rPr, 'w:sz');
  if (szEl) {
    const sz = parseInt(getVal(szEl) || '24'); // half-points
    run.fontSize = sz / 2; // convert to points
  }

  const colorEl = getElement(rPr, 'w:color');
  if (colorEl) {
    run.color = parseColor(getVal(colorEl));
  }

  const highlightEl = getElement(rPr, 'w:highlight');
  if (highlightEl) {
    run.highlight = getVal(highlightEl) || undefined;
  }

  const shdEl = getElement(rPr, 'w:shd');
  if (shdEl) {
    run.backgroundColor = parseColor(getAttr(shdEl, 'fill'));
  }

  const fontEl = getElement(rPr, 'w:rFonts');
  if (fontEl) {
    run.fontFamily = getAttr(fontEl, 'ascii') || getAttr(fontEl, 'eastAsia') || getAttr(fontEl, 'hAnsi') || undefined;
  }

  const vertAlignEl = getElement(rPr, 'w:vertAlign');
  if (vertAlignEl) {
    const val = getVal(vertAlignEl);
    if (val === 'superscript') run.superscript = true;
    if (val === 'subscript') run.subscript = true;
  }

  return run;
}

// ==================== Parse Paragraph Properties ====================

function parseParagraphProps(pPr: Element): Partial<Paragraph> {
  const para: Partial<Paragraph> = {};

  const jcEl = getElement(pPr, 'w:jc');
  if (jcEl) {
    const val = getVal(jcEl);
    if (val === 'left' || val === 'start') para.align = 'left';
    else if (val === 'center') para.align = 'center';
    else if (val === 'right' || val === 'end') para.align = 'right';
    else if (val === 'both' || val === 'justify') para.align = 'justify';
  }

  const spacingEl = getElement(pPr, 'w:spacing');
  if (spacingEl) {
    const before = getAttr(spacingEl, 'before');
    const after = getAttr(spacingEl, 'after');
    const line = getAttr(spacingEl, 'line');
    const lineRule = getAttr(spacingEl, 'lineRule');

    if (before) para.spaceBefore = parseInt(before) / TWIP_PER_PIXEL;
    if (after) para.spaceAfter = parseInt(after) / TWIP_PER_PIXEL;
    if (line) {
      if (lineRule === 'exact' || lineRule === 'atLeast') {
        para.lineHeight = parseInt(line) / TWIP_PER_PIXEL;
      } else {
        // Default is 240ths of a line
        para.lineHeight = parseInt(line) / 240;
      }
    }
  }

  const indEl = getElement(pPr, 'w:ind');
  if (indEl) {
    const left = getAttr(indEl, 'left');
    const firstLine = getAttr(indEl, 'firstLine');
    const hanging = getAttr(indEl, 'hanging');

    if (left) para.marginLeft = parseInt(left) / TWIP_PER_PIXEL;
    if (firstLine) para.indent = parseInt(firstLine) / TWIP_PER_PIXEL;
    if (hanging) para.hangingIndent = parseInt(hanging) / TWIP_PER_PIXEL;
  }

  const outlineLvlEl = getElement(pPr, 'w:outlineLvl');
  if (outlineLvlEl) {
    para.outlineLevel = parseInt(getVal(outlineLvlEl) || '9');
  }

  if (getElement(pPr, 'w:pageBreakBefore')) {
    para.pageBreakBefore = true;
  }

  if (getElement(pPr, 'w:keepNext')) {
    para.keepNext = true;
  }

  if (getElement(pPr, 'w:keepLines')) {
    para.keepLines = true;
  }

  return para;
}

// ==================== Parse Drawing/Image ====================

function parseDrawing(drawingEl: Element, images: Map<string, string>): DrawingElement | null {
  // Check for inline or anchor
  const inline = getElement(drawingEl, 'wp:inline');
  const anchor = getElement(drawingEl, 'wp:anchor');
  const container = inline || anchor;

  if (!container) return null;

  const extentEl = getElement(container, 'wp:extent');
  const width = extentEl ? parseInt(getAttr(extentEl, 'cx') || '0') / EMU_PER_PIXEL : 100;
  const height = extentEl ? parseInt(getAttr(extentEl, 'cy') || '0') / EMU_PER_PIXEL : 100;

  // Get image reference
  const blipEl = getElement(container, 'a:blip');
  const imageId = blipEl ? (getAttr(blipEl, 'embed', 'r') || getAttr(blipEl, 'r:embed')) : null;
  const imageSrc = imageId ? images.get(imageId) : undefined;

  // Position for anchored images
  let positionH = 0, positionV = 0;
  if (anchor) {
    const posHEl = getElement(anchor, 'wp:positionH');
    const posVEl = getElement(anchor, 'wp:positionV');
    const posOffsetH = posHEl ? getElement(posHEl, 'wp:posOffset') : null;
    const posOffsetV = posVEl ? getElement(posVEl, 'wp:posOffset') : null;
    if (posOffsetH?.textContent) positionH = parseInt(posOffsetH.textContent) / EMU_PER_PIXEL;
    if (posOffsetV?.textContent) positionV = parseInt(posOffsetV.textContent) / EMU_PER_PIXEL;
  }

  return {
    type: 'image',
    width,
    height,
    inline: !!inline,
    positionH,
    positionV,
    imageId: imageId || undefined,
    imageSrc,
  };
}

// ==================== Parse Table ====================

function parseTable(tblEl: Element, images: Map<string, string>, styles: Map<string, StyleDef>): Table {
  const rows: TableRow[] = [];
  const colWidths: number[] = [];

  // Parse grid columns
  const tblGridEl = getElement(tblEl, 'w:tblGrid');
  if (tblGridEl) {
    const gridCols = getElements(tblGridEl, 'w:gridCol');
    for (const col of gridCols) {
      const w = parseInt(getAttr(col, 'w') || '0') / TWIP_PER_PIXEL;
      colWidths.push(w);
    }
  }

  // Parse rows
  const trEls = getElements(tblEl, 'w:tr');
  for (const tr of trEls) {
    const cells: TableCell[] = [];
    const tcEls = getElements(tr, 'w:tc');

    for (const tc of tcEls) {
      const tcPr = getElement(tc, 'w:tcPr');

      // Grid span (horizontal merge)
      const gridSpanEl = tcPr ? getElement(tcPr, 'w:gridSpan') : null;
      const gridSpan = gridSpanEl ? parseInt(getVal(gridSpanEl) || '1') : 1;

      // Vertical merge
      const vMergeEl = tcPr ? getElement(tcPr, 'w:vMerge') : null;
      let vMerge: 'restart' | 'continue' | undefined;
      if (vMergeEl) {
        vMerge = getVal(vMergeEl) === 'restart' ? 'restart' : 'continue';
      }

      // Cell width
      const tcWEl = tcPr ? getElement(tcPr, 'w:tcW') : null;
      const cellWidth = tcWEl ? parseInt(getAttr(tcWEl, 'w') || '0') / TWIP_PER_PIXEL : undefined;

      // Background color
      const shdEl = tcPr ? getElement(tcPr, 'w:shd') : null;
      const backgroundColor = shdEl ? parseColor(getAttr(shdEl, 'fill')) : undefined;

      // Vertical alignment
      const vAlignEl = tcPr ? getElement(tcPr, 'w:vAlign') : null;
      const vertAlign = vAlignEl ? getVal(vAlignEl) as 'top' | 'center' | 'bottom' : undefined;

      // Parse cell content
      const content = parseBodyContent(tc, images, styles);

      cells.push({
        content,
        colSpan: gridSpan,
        rowSpan: 1, // Will be calculated from vMerge
        width: cellWidth,
        backgroundColor,
        vertAlign,
        gridSpan,
        vMerge,
      });
    }

    // Row height
    const trPr = getElement(tr, 'w:trPr');
    const trHeightEl = trPr ? getElement(trPr, 'w:trHeight') : null;
    const rowHeight = trHeightEl ? parseInt(getVal(trHeightEl) || '0') / TWIP_PER_PIXEL : undefined;
    const isHeader = trPr ? !!getElement(trPr, 'w:tblHeader') : false;

    rows.push({ cells, height: rowHeight, isHeader });
  }

  // Calculate row spans from vMerge
  for (let col = 0; col < colWidths.length; col++) {
    let mergeStart = -1;
    for (let row = 0; row < rows.length; row++) {
      const cell = rows[row].cells[col];
      if (!cell) continue;

      if (cell.vMerge === 'restart') {
        mergeStart = row;
      } else if (cell.vMerge === 'continue' && mergeStart >= 0) {
        if (rows[mergeStart].cells[col]) {
          rows[mergeStart].cells[col].rowSpan++;
        }
      }
    }
  }

  // Table width
  const tblPr = getElement(tblEl, 'w:tblPr');
  const tblWEl = tblPr ? getElement(tblPr, 'w:tblW') : null;
  const tableWidth = tblWEl ? parseInt(getAttr(tblWEl, 'w') || '0') / TWIP_PER_PIXEL : undefined;

  // Table alignment
  const jcEl = tblPr ? getElement(tblPr, 'w:jc') : null;
  const alignment = jcEl ? getVal(jcEl) as 'left' | 'center' | 'right' : undefined;

  return { rows, width: tableWidth, colWidths, alignment };
}

// ==================== Parse Paragraph ====================

function parseParagraph(pEl: Element, images: Map<string, string>, styles: Map<string, StyleDef>): { para: Paragraph; drawings: DrawingElement[] } {
  const runs: TextRun[] = [];
  const drawings: DrawingElement[] = [];
  let paraProps: Partial<Paragraph> = {};

  // Get paragraph properties
  const pPrEl = getElement(pEl, 'w:pPr');
  if (pPrEl) {
    paraProps = parseParagraphProps(pPrEl);

    // Check for style reference
    const pStyleEl = getElement(pPrEl, 'w:pStyle');
    if (pStyleEl) {
      const styleId = getVal(pStyleEl);
      if (styleId && styles.has(styleId)) {
        const style = styles.get(styleId)!;
        if (style.paragraph) {
          paraProps = { ...style.paragraph, ...paraProps };
        }
      }
    }

    // Check for numbering
    const numPrEl = getElement(pPrEl, 'w:numPr');
    if (numPrEl) {
      const ilvlEl = getElement(numPrEl, 'w:ilvl');
      const numIdEl = getElement(numPrEl, 'w:numId');
      // TODO: resolve numbering text from numId and ilvl
      if (ilvlEl) {
        const level = parseInt(getVal(ilvlEl) || '0');
        paraProps.bulletChar = level === 0 ? '•' : '◦';
      }
    }
  }

  // Parse runs
  const rEls = getElements(pEl, 'w:r');
  for (const rEl of rEls) {
    const rPrEl = getElement(rEl, 'w:rPr');
    let runProps: Partial<TextRun> = {};

    if (rPrEl) {
      runProps = parseRunProps(rPrEl);

      // Check for style reference
      const rStyleEl = getElement(rPrEl, 'w:rStyle');
      if (rStyleEl) {
        const styleId = getVal(rStyleEl);
        if (styleId && styles.has(styleId)) {
          const style = styles.get(styleId)!;
          if (style.run) {
            runProps = { ...style.run, ...runProps };
          }
        }
      }
    }

    // Get text content
    const tEls = getElements(rEl, 'w:t');
    for (const tEl of tEls) {
      const text = tEl.textContent || '';
      if (text) {
        runs.push({ text, ...runProps });
      }
    }

    // Check for lastRenderedPageBreak (Word's automatic page break marker)
    const lastRenderedPageBreak = getElement(rEl, 'w:lastRenderedPageBreak');
    if (lastRenderedPageBreak) {
      runs.push({ text: '\u000C' }); // Form feed as page break marker
    }

    // Check for explicit break
    const brEl = getElement(rEl, 'w:br');
    if (brEl) {
      const brType = getAttr(brEl, 'type');
      if (brType === 'page') {
        // Page break within run - add marker
        runs.push({ text: '\u000C' }); // Form feed as page break marker
      } else {
        runs.push({ text: '\n' });
      }
    }

    // Check for tab
    const tabEl = getElement(rEl, 'w:tab');
    if (tabEl) {
      runs.push({ text: '\t' });
    }

    // Check for drawing
    const drawingEl = getElement(rEl, 'w:drawing');
    if (drawingEl) {
      const drawing = parseDrawing(drawingEl, images);
      if (drawing) {
        if (drawing.inline) {
          // Inline image - add placeholder in runs
          runs.push({ text: `\uFFFC` }); // Object replacement character
        }
        drawings.push(drawing);
      }
    }
  }

  // Check for bookmark start (for hyperlinks, etc.)
  // const bookmarkStarts = getElements(pEl, 'w:bookmarkStart');

  const para: Paragraph = {
    runs,
    ...paraProps,
  };

  return { para, drawings };
}

// ==================== Parse Body Content ====================

function parseBodyContent(parent: Element, images: Map<string, string>, styles: Map<string, StyleDef>): ContentItem[] {
  const content: ContentItem[] = [];

  for (let i = 0; i < parent.children.length; i++) {
    const child = parent.children[i];
    const tagName = child.tagName;

    if (tagName === 'w:p') {
      const { para, drawings } = parseParagraph(child, images, styles);

      // Check for page break before
      if (para.pageBreakBefore) {
        content.push({ type: 'pageBreak' });
      }

      // Check if paragraph contains page breaks (lastRenderedPageBreak or explicit)
      // Split paragraph at page break markers
      const pageBreakChar = '\u000C';
      const hasPageBreak = para.runs.some(r => r.text.includes(pageBreakChar));

      if (hasPageBreak) {
        // Split runs at page breaks
        let currentRuns: TextRun[] = [];

        for (const run of para.runs) {
          if (run.text === pageBreakChar) {
            // Add paragraph with current runs (if any)
            if (currentRuns.length > 0) {
              content.push({
                type: 'paragraph',
                data: { ...para, runs: currentRuns },
              });
            }
            // Add page break
            content.push({ type: 'pageBreak' });
            currentRuns = [];
          } else if (run.text.includes(pageBreakChar)) {
            // Run contains page break mixed with text - split it
            const parts = run.text.split(pageBreakChar);
            for (let pi = 0; pi < parts.length; pi++) {
              if (parts[pi]) {
                currentRuns.push({ ...run, text: parts[pi] });
              }
              if (pi < parts.length - 1) {
                // Add paragraph with current runs
                if (currentRuns.length > 0) {
                  content.push({
                    type: 'paragraph',
                    data: { ...para, runs: currentRuns },
                  });
                }
                content.push({ type: 'pageBreak' });
                currentRuns = [];
              }
            }
          } else {
            currentRuns.push(run);
          }
        }

        // Add remaining runs
        if (currentRuns.length > 0) {
          content.push({
            type: 'paragraph',
            data: { ...para, runs: currentRuns },
          });
        }
      } else {
        // No page breaks - add paragraph as is (skip empty paragraphs only if truly empty)
        content.push({ type: 'paragraph', data: para });
      }

      // Add inline drawings after paragraph
      for (const drawing of drawings) {
        if (!drawing.inline) {
          content.push({ type: 'drawing', data: drawing });
        }
      }
    } else if (tagName === 'w:tbl') {
      const table = parseTable(child, images, styles);
      content.push({ type: 'table', data: table });
    } else if (tagName === 'w:sectPr') {
      // Section properties - check for section break type
      const typeEl = getElement(child, 'w:type');
      const breakType = getVal(typeEl);
      if (breakType !== 'continuous') {
        content.push({ type: 'sectionBreak', continuous: breakType === 'continuous' });
      }
    }
  }

  return content;
}

// ==================== Parse Section Properties ====================

function parseSectionProps(sectPr: Element): SectionProps {
  const pgSzEl = getElement(sectPr, 'w:pgSz');
  const pgMarEl = getElement(sectPr, 'w:pgMar');

  const pageWidth = pgSzEl ? parseInt(getAttr(pgSzEl, 'w') || '12240') / TWIP_PER_PIXEL : 816; // Default letter width
  const pageHeight = pgSzEl ? parseInt(getAttr(pgSzEl, 'h') || '15840') / TWIP_PER_PIXEL : 1056; // Default letter height

  const marginTop = pgMarEl ? parseInt(getAttr(pgMarEl, 'top') || '1440') / TWIP_PER_PIXEL : 96;
  const marginBottom = pgMarEl ? parseInt(getAttr(pgMarEl, 'bottom') || '1440') / TWIP_PER_PIXEL : 96;
  const marginLeft = pgMarEl ? parseInt(getAttr(pgMarEl, 'left') || '1440') / TWIP_PER_PIXEL : 96;
  const marginRight = pgMarEl ? parseInt(getAttr(pgMarEl, 'right') || '1440') / TWIP_PER_PIXEL : 96;
  const headerMargin = pgMarEl ? parseInt(getAttr(pgMarEl, 'header') || '720') / TWIP_PER_PIXEL : 48;
  const footerMargin = pgMarEl ? parseInt(getAttr(pgMarEl, 'footer') || '720') / TWIP_PER_PIXEL : 48;

  return {
    pageWidth,
    pageHeight,
    marginTop,
    marginBottom,
    marginLeft,
    marginRight,
    headerMargin,
    footerMargin,
  };
}

// ==================== Parse Document ====================

async function parseDocx(data: ArrayBuffer): Promise<DocumentData> {
  const zip = await JSZip.loadAsync(data);

  // Parse relationships first (for images)
  const images = await parseRelationships(zip);
  log('[DocxViewer] Loaded images:', images.size);

  // Parse styles
  let styles = new Map<string, StyleDef>();
  const stylesFile = zip.file('word/styles.xml');
  if (stylesFile) {
    const stylesXml = await stylesFile.async('string');
    const parser = new DOMParser();
    const stylesDoc = parser.parseFromString(stylesXml, 'application/xml');
    styles = parseStyles(stylesDoc);
    log('[DocxViewer] Loaded styles:', styles.size);
  }

  // Parse numbering
  let numbering = new Map<string, NumberingDef>();
  const numberingFile = zip.file('word/numbering.xml');
  if (numberingFile) {
    const numberingXml = await numberingFile.async('string');
    const parser = new DOMParser();
    const numberingDoc = parser.parseFromString(numberingXml, 'application/xml');
    numbering = parseNumbering(numberingDoc);
    log('[DocxViewer] Loaded numbering:', numbering.size);
  }

  // Parse main document
  const documentFile = zip.file('word/document.xml');
  if (!documentFile) {
    throw new Error('document.xml not found');
  }

  const documentXml = await documentFile.async('string');
  const parser = new DOMParser();
  const doc = parser.parseFromString(documentXml, 'application/xml');

  // Get body element
  const bodyEl = getElement(doc.documentElement, 'w:body');
  if (!bodyEl) {
    throw new Error('document body not found');
  }

  // Parse content
  const content = parseBodyContent(bodyEl, images, styles);
  const pageBreakCount = content.filter(c => c.type === 'pageBreak').length;
  log('[DocxViewer] Parsed content items:', content.length, 'Page breaks:', pageBreakCount);

  // Get section properties (last sectPr in body or in last paragraph)
  let defaultSection: SectionProps = {
    pageWidth: 816,
    pageHeight: 1056,
    marginTop: 96,
    marginBottom: 96,
    marginLeft: 96,
    marginRight: 96,
  };

  const sectPrEl = getElement(bodyEl, 'w:sectPr');
  if (sectPrEl) {
    defaultSection = parseSectionProps(sectPrEl);
  }
  log('[DocxViewer] Page size:', defaultSection.pageWidth, 'x', defaultSection.pageHeight);

  return {
    content,
    defaultSection,
    styles,
    numbering,
    images,
  };
}

// ==================== Pagination ====================

interface PageContent {
  items: ContentItem[];
  pageNumber: number;
}

function paginateContent(content: ContentItem[], section: SectionProps): PageContent[] {
  const pages: PageContent[] = [];
  const contentHeight = section.pageHeight - section.marginTop - section.marginBottom;

  let currentPage: ContentItem[] = [];
  let currentHeight = 0;
  let pageNumber = 1;

  // Estimate heights for content items
  const estimateHeight = (item: ContentItem): number => {
    switch (item.type) {
      case 'paragraph': {
        const para = item.data;
        const lineHeight = typeof para.lineHeight === 'number' && para.lineHeight > 3
          ? para.lineHeight
          : (para.runs[0]?.fontSize || 12) * 1.5;

        // Estimate number of lines based on text length and content width
        const contentWidth = section.pageWidth - section.marginLeft - section.marginRight;
        const avgCharWidth = (para.runs[0]?.fontSize || 12) * 0.5;
        const totalChars = para.runs.reduce((sum, r) => sum + r.text.length, 0);
        const estimatedLines = Math.max(1, Math.ceil(totalChars * avgCharWidth / contentWidth));

        const height = estimatedLines * lineHeight + (para.spaceBefore || 0) + (para.spaceAfter || 0);
        return height;
      }
      case 'table': {
        const table = item.data;
        let height = 0;
        for (const row of table.rows) {
          height += row.height || 24; // Default row height
        }
        return height;
      }
      case 'drawing':
      case 'image':
        return (item.data as DrawingElement | ImageElement).height || 100;
      case 'pageBreak':
      case 'sectionBreak':
        return 0; // Forces new page
      default:
        return 20;
    }
  };

  for (const item of content) {
    // Handle explicit page breaks
    if (item.type === 'pageBreak' || (item.type === 'sectionBreak' && !item.continuous)) {
      if (currentPage.length > 0) {
        pages.push({ items: currentPage, pageNumber });
        pageNumber++;
      }
      currentPage = [];
      currentHeight = 0;
      continue;
    }

    const itemHeight = estimateHeight(item);

    // Check if item fits on current page
    if (currentHeight + itemHeight > contentHeight && currentPage.length > 0) {
      // Start new page
      pages.push({ items: currentPage, pageNumber });
      pageNumber++;
      currentPage = [];
      currentHeight = 0;
    }

    currentPage.push(item);
    currentHeight += itemHeight;
  }

  // Add remaining content
  if (currentPage.length > 0) {
    pages.push({ items: currentPage, pageNumber });
  }

  return pages;
}

// ==================== Render Components ====================

const HIGHLIGHT_COLORS: Record<string, string> = {
  yellow: '#ffff00',
  green: '#00ff00',
  cyan: '#00ffff',
  magenta: '#ff00ff',
  blue: '#0000ff',
  red: '#ff0000',
  darkBlue: '#00008b',
  darkCyan: '#008b8b',
  darkGreen: '#006400',
  darkMagenta: '#8b008b',
  darkRed: '#8b0000',
  darkYellow: '#808000',
  darkGray: '#a9a9a9',
  lightGray: '#d3d3d3',
  black: '#000000',
};

function RenderRun({ run, inlineImages }: { run: TextRun; inlineImages?: Map<number, DrawingElement> }) {
  const style: React.CSSProperties = {
    fontWeight: run.bold ? 'bold' : undefined,
    fontStyle: run.italic ? 'italic' : undefined,
    textDecoration: run.underline ? 'underline' : run.strikethrough ? 'line-through' : undefined,
    fontSize: run.fontSize ? `${run.fontSize}pt` : undefined,
    fontFamily: run.fontFamily || undefined,
    color: run.color || undefined,
    backgroundColor: run.highlight ? HIGHLIGHT_COLORS[run.highlight] : run.backgroundColor,
    verticalAlign: run.superscript ? 'super' : run.subscript ? 'sub' : undefined,
  };

  // Handle special characters
  if (run.text === '\t') {
    return <span style={{ ...style, display: 'inline-block', width: '2em' }}>&nbsp;</span>;
  }
  if (run.text === '\n') {
    return <br />;
  }

  return <span style={style}>{run.text}</span>;
}

function RenderParagraph({ para, inlineDrawings }: { para: Paragraph; inlineDrawings?: DrawingElement[] }) {
  const style: React.CSSProperties = {
    textAlign: para.align || 'left',
    lineHeight: typeof para.lineHeight === 'number' && para.lineHeight > 3
      ? `${para.lineHeight}px`
      : para.lineHeight || 1.5,
    marginTop: para.spaceBefore || 0,
    marginBottom: para.spaceAfter || 0,
    marginLeft: para.marginLeft || 0,
    marginRight: para.marginRight || 0,
    textIndent: para.indent ? para.indent - (para.hangingIndent || 0) : undefined,
    paddingLeft: para.hangingIndent || undefined,
  };

  // Render bullet/numbering
  let prefix = null;
  if (para.bulletChar) {
    prefix = <span style={{ marginRight: '0.5em' }}>{para.bulletChar}</span>;
  } else if (para.numberingText) {
    prefix = <span style={{ marginRight: '0.5em' }}>{para.numberingText}</span>;
  }

  // Track inline image index for object replacement characters
  let inlineImageIndex = 0;

  return (
    <p style={style}>
      {prefix}
      {para.runs.map((run, i) => {
        if (run.text === '\uFFFC' && inlineDrawings && inlineImageIndex < inlineDrawings.length) {
          const drawing = inlineDrawings[inlineImageIndex++];
          if (drawing.imageSrc) {
            return (
              <img
                key={i}
                src={drawing.imageSrc}
                style={{
                  width: drawing.width,
                  height: drawing.height,
                  verticalAlign: 'middle',
                }}
                alt=""
              />
            );
          }
          return null;
        }
        return <RenderRun key={i} run={run} />;
      })}
    </p>
  );
}

function RenderTable({ table }: { table: Table }) {
  const tableStyle: React.CSSProperties = {
    borderCollapse: 'collapse',
    width: table.width || '100%',
    marginLeft: table.alignment === 'center' ? 'auto' : table.alignment === 'right' ? 'auto' : 0,
    marginRight: table.alignment === 'center' ? 'auto' : 0,
  };

  return (
    <table style={tableStyle}>
      <tbody>
        {table.rows.map((row, rowIdx) => (
          <tr key={rowIdx} style={{ height: row.height }}>
            {row.cells.map((cell, cellIdx) => {
              if (cell.vMerge === 'continue') return null;

              const cellStyle: React.CSSProperties = {
                padding: '4px 8px',
                border: '1px solid #000',
                backgroundColor: cell.backgroundColor,
                verticalAlign: cell.vertAlign || 'top',
                width: cell.width,
              };

              return (
                <td
                  key={cellIdx}
                  colSpan={cell.colSpan > 1 ? cell.colSpan : undefined}
                  rowSpan={cell.rowSpan > 1 ? cell.rowSpan : undefined}
                  style={cellStyle}
                >
                  <RenderContent items={cell.content} />
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function RenderContent({ items }: { items: ContentItem[] }) {
  // Group consecutive paragraphs with their following inline drawings
  const rendered: React.ReactNode[] = [];
  let i = 0;

  while (i < items.length) {
    const item = items[i];

    switch (item.type) {
      case 'paragraph': {
        // Collect inline drawings that follow
        const inlineDrawings: DrawingElement[] = [];
        let j = i + 1;
        while (j < items.length && items[j].type === 'drawing') {
          const drawing = (items[j] as { type: 'drawing'; data: DrawingElement }).data;
          if (drawing.inline) {
            inlineDrawings.push(drawing);
          }
          j++;
        }
        rendered.push(
          <RenderParagraph
            key={i}
            para={item.data}
            inlineDrawings={inlineDrawings.length > 0 ? inlineDrawings : undefined}
          />
        );
        i = j > i + 1 ? j : i + 1;
        break;
      }
      case 'table':
        rendered.push(<RenderTable key={i} table={item.data} />);
        i++;
        break;
      case 'drawing': {
        const drawing = item.data;
        if (!drawing.inline && drawing.imageSrc) {
          rendered.push(
            <div key={i} style={{ textAlign: 'center', margin: '8px 0' }}>
              <img
                src={drawing.imageSrc}
                style={{ maxWidth: '100%', height: 'auto' }}
                alt=""
              />
            </div>
          );
        }
        i++;
        break;
      }
      case 'image': {
        const img = item.data;
        if (img.src) {
          rendered.push(
            <div key={i} style={{ textAlign: 'center', margin: '8px 0' }}>
              <img
                src={img.src}
                style={{ width: img.width, height: img.height, maxWidth: '100%' }}
                alt=""
              />
            </div>
          );
        }
        i++;
        break;
      }
      default:
        i++;
    }
  }

  return <>{rendered}</>;
}

// ==================== Main Component ====================

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 3;
const ZOOM_STEP = 0.1;

export function DocxViewer({ data }: DocxViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [docData, setDocData] = useState<DocumentData | null>(null);
  const [pages, setPages] = useState<PageContent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [zoom, setZoom] = useState(1);
  const [currentPage, setCurrentPage] = useState(1);

  // Parse document
  useEffect(() => {
    const loadDocument = async () => {
      try {
        setLoading(true);
        setError(null);

        const documentData = await parseDocx(data);
        setDocData(documentData);

        // Paginate content
        const paginatedPages = paginateContent(documentData.content, documentData.defaultSection);
        setPages(paginatedPages);
        log('[DocxViewer] Total pages:', paginatedPages.length);

      } catch (err) {
        console.error('[DocxViewer] Parse error:', err);
        setError(err instanceof Error ? err.message : 'Failed to parse document');
      } finally {
        setLoading(false);
      }
    };

    loadDocument();
  }, [data]);

  // Zoom handler
  useEffect(() => {
    const handler = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      if (!containerRef.current?.contains(e.target as Node)) return;
      e.preventDefault();
      e.stopPropagation();
      const delta = e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP;
      setZoom(prev => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, prev + delta)));
    };
    document.addEventListener('wheel', handler, { passive: false, capture: true });
    return () => document.removeEventListener('wheel', handler, { capture: true } as EventListenerOptions);
  }, []);

  // Track visible page
  useEffect(() => {
    const scrollContainer = scrollContainerRef.current;
    if (!scrollContainer || pages.length === 0) return;

    const handleScroll = () => {
      const pageElements = scrollContainer.querySelectorAll('.docx-page');
      if (pageElements.length === 0) return;

      const containerRect = scrollContainer.getBoundingClientRect();
      const containerCenter = containerRect.top + containerRect.height / 3;

      let visiblePage = 1;
      for (let i = 0; i < pageElements.length; i++) {
        const pageRect = pageElements[i].getBoundingClientRect();
        if (pageRect.top <= containerCenter && pageRect.bottom > containerCenter) {
          visiblePage = i + 1;
          break;
        } else if (pageRect.top > containerCenter) {
          visiblePage = Math.max(1, i);
          break;
        } else if (i === pageElements.length - 1) {
          visiblePage = pageElements.length;
        }
      }

      setCurrentPage(visiblePage);
    };

    scrollContainer.addEventListener('scroll', handleScroll);
    handleScroll();

    return () => scrollContainer.removeEventListener('scroll', handleScroll);
  }, [pages, zoom]);

  if (loading) {
    return (
      <div className="office-viewer-container docx-viewer" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div>Loading document...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="office-viewer-container docx-viewer" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div className="office-viewer-error">Error: {error}</div>
      </div>
    );
  }

  if (!docData || pages.length === 0) {
    return (
      <div className="office-viewer-container docx-viewer" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div>No content to display</div>
      </div>
    );
  }

  const { defaultSection } = docData;

  return (
    <div ref={containerRef} className="office-viewer-container docx-viewer">
      <div className="docx-toolbar">
        <div className="docx-page-indicator">
          {currentPage} / {pages.length}
        </div>
        <div className="docx-zoom-indicator">{Math.round(zoom * 100)}%</div>
      </div>
      <div ref={scrollContainerRef} className="docx-scroll-container">
        <div
          className="docx-pages-container"
          style={{
            transform: `scale(${zoom})`,
            transformOrigin: 'top center',
          }}
        >
          {pages.map((page, idx) => (
            <div
              key={idx}
              className="docx-page"
              style={{
                width: defaultSection.pageWidth,
                minHeight: defaultSection.pageHeight,
                paddingTop: defaultSection.marginTop,
                paddingBottom: defaultSection.marginBottom,
                paddingLeft: defaultSection.marginLeft,
                paddingRight: defaultSection.marginRight,
                background: 'white',
                boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
                marginBottom: 20,
                boxSizing: 'border-box',
                overflow: 'hidden',
              }}
            >
              <RenderContent items={page.items} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default DocxViewer;
