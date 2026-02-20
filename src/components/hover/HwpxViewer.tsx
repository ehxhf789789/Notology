import { useState, useEffect, useCallback, useRef } from 'react';
import JSZip from 'jszip';

interface HwpxViewerProps {
  data: ArrayBuffer;
}

// HWPX units: HWPX uses hwpunit (1/7200 inch) for measurements
// 7200 hwpunit = 1 inch = 96 CSS pixels
const HWPUNIT_PER_PIXEL = 7200 / 96;

interface TextRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  fontSize?: number; // in pt
  fontFamily?: string;
  color?: string;
  backgroundColor?: string;
  superscript?: boolean;
  subscript?: boolean;
}

interface Paragraph {
  runs: TextRun[];
  align?: 'left' | 'center' | 'right' | 'justify';
  lineHeight?: number;
  marginTop?: number;
  marginBottom?: number;
  indent?: number;
  isHeading?: boolean;
  headingLevel?: number;
}

interface TableCell {
  paragraphs: Paragraph[];
  colSpan?: number;
  rowSpan?: number;
  backgroundColor?: string;
  width?: number;
  borderTop?: BorderStyle;
  borderBottom?: BorderStyle;
  borderLeft?: BorderStyle;
  borderRight?: BorderStyle;
  vertAlign?: 'top' | 'middle' | 'bottom';
}

interface BorderStyle {
  width?: number;
  color?: string;
  type?: string;
}

interface TableRow {
  cells: TableCell[];
  height?: number;
}

interface Table {
  rows: TableRow[];
  width?: number;
  colWidths?: number[];
  x?: number;
  y?: number;
}

interface ImageElement {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  src?: string;
}

interface ShapeElement {
  type: 'rect' | 'line' | 'ellipse';
  x: number;
  y: number;
  width: number;
  height: number;
  backgroundColor?: string;
  borderColor?: string;
  borderWidth?: number;
}

interface Section {
  paragraphs: Paragraph[];
  tables: Table[];
  images: ImageElement[];
  shapes: ShapeElement[];
  pageWidth?: number;
  pageHeight?: number;
  marginLeft?: number;
  marginRight?: number;
  marginTop?: number;
  marginBottom?: number;
}

interface CharacterStyle {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  fontSize?: number;
  fontFamily?: string;
  color?: string;
}

// Parse character properties from HWPX
function parseCharProps(charPr: Element | null, defaultStyle?: CharacterStyle): Partial<TextRun> {
  const props: Partial<TextRun> = { ...defaultStyle };

  if (!charPr) return props;

  // Bold
  const bold = charPr.getAttribute('bold');
  if (bold === '1' || bold === 'true') props.bold = true;

  // Italic
  const italic = charPr.getAttribute('italic');
  if (italic === '1' || italic === 'true') props.italic = true;

  // Underline
  const underline = charPr.getAttribute('underline');
  if (underline && underline !== 'none' && underline !== '0') props.underline = true;

  // Strikethrough
  const strike = charPr.getAttribute('strikeout');
  if (strike && strike !== 'none' && strike !== '0') props.strikethrough = true;

  // Font size (in hwpunit, convert to pt: 1pt = 100 hwpunit for font size)
  const height = charPr.getAttribute('height');
  if (height) props.fontSize = parseInt(height) / 100;

  // Font family - check for fontRef or direct font name
  const fontRef = charPr.getAttribute('fontRef');
  const hangulFontRef = charPr.getAttribute('hangulFontRef');
  if (fontRef) props.fontFamily = fontRef;
  else if (hangulFontRef) props.fontFamily = hangulFontRef;

  // Color
  const textColor = charPr.getAttribute('textColor');
  if (textColor && textColor !== '0') {
    // HWPX color format: RGB as decimal or hex
    if (textColor.startsWith('#')) {
      props.color = textColor;
    } else {
      const colorNum = parseInt(textColor);
      if (!isNaN(colorNum)) {
        const r = (colorNum >> 16) & 0xff;
        const g = (colorNum >> 8) & 0xff;
        const b = colorNum & 0xff;
        props.color = `rgb(${r}, ${g}, ${b})`;
      }
    }
  }

  // Background/highlight color
  const highlightColor = charPr.getAttribute('highlightColor');
  if (highlightColor && highlightColor !== '0' && highlightColor !== '-1') {
    const colorNum = parseInt(highlightColor);
    if (!isNaN(colorNum)) {
      const r = (colorNum >> 16) & 0xff;
      const g = (colorNum >> 8) & 0xff;
      const b = colorNum & 0xff;
      props.backgroundColor = `rgb(${r}, ${g}, ${b})`;
    }
  }

  // Superscript/subscript
  const vertAlign = charPr.getAttribute('vertAlign');
  if (vertAlign === 'superscript') props.superscript = true;
  if (vertAlign === 'subscript') props.subscript = true;

  return props;
}

// Parse paragraph alignment
function parseParaAlignment(paraPr: Element | null): Paragraph['align'] {
  if (!paraPr) return undefined;

  const align = paraPr.getAttribute('align');
  switch (align) {
    case 'left': return 'left';
    case 'center': return 'center';
    case 'right': return 'right';
    case 'justify':
    case 'both': return 'justify';
    default: return undefined;
  }
}

// Parse paragraph properties
function parseParaProps(paraPr: Element | null): Partial<Paragraph> {
  const props: Partial<Paragraph> = {};

  if (!paraPr) return props;

  props.align = parseParaAlignment(paraPr);

  // Line height (in %)
  const lineHeight = paraPr.getAttribute('lineHeight');
  if (lineHeight) props.lineHeight = parseInt(lineHeight) / 100;

  // Margins (in hwpunit)
  const marginTop = paraPr.getAttribute('marginTop');
  const marginBottom = paraPr.getAttribute('marginBottom');
  if (marginTop) props.marginTop = parseInt(marginTop) / HWPUNIT_PER_PIXEL;
  if (marginBottom) props.marginBottom = parseInt(marginBottom) / HWPUNIT_PER_PIXEL;

  // Indent
  const indent = paraPr.getAttribute('indent');
  if (indent) props.indent = parseInt(indent) / HWPUNIT_PER_PIXEL;

  // Check if heading (outline level)
  const outlineLevel = paraPr.getAttribute('outlineLevel');
  if (outlineLevel && parseInt(outlineLevel) > 0) {
    props.isHeading = true;
    props.headingLevel = parseInt(outlineLevel);
  }

  return props;
}

// Parse a single paragraph element
function parseParagraph(para: Element, defaultCharStyle?: CharacterStyle): Paragraph {
  const runs: TextRun[] = [];

  // Get paragraph properties
  const paraPr = para.getElementsByTagName('hp:paraPr')[0] ||
                 para.getElementsByTagName('paraPr')[0];
  const paraProps = parseParaProps(paraPr);

  // Get default character properties for this paragraph
  const defCharPr = paraPr?.getElementsByTagName('hp:charPr')[0] ||
                    paraPr?.getElementsByTagName('charPr')[0];
  const defaultProps = parseCharProps(defCharPr, defaultCharStyle);

  // Parse text runs (hp:run elements)
  const runElements = para.getElementsByTagName('hp:run');
  for (let i = 0; i < runElements.length; i++) {
    const run = runElements[i];

    // Get character properties for this run
    const charPr = run.getElementsByTagName('hp:charPr')[0] ||
                   run.getElementsByTagName('charPr')[0];
    const runProps = parseCharProps(charPr, defaultProps as CharacterStyle);

    // Get text content
    const textElements = run.getElementsByTagName('hp:t');
    for (let j = 0; j < textElements.length; j++) {
      const text = textElements[j].textContent;
      if (text) {
        runs.push({
          text,
          ...runProps,
        });
      }
    }

    // Also check for hp:secPr (section properties within run - usually line breaks)
    const secPr = run.getElementsByTagName('hp:secPr');
    if (secPr.length > 0 && runs.length > 0) {
      runs[runs.length - 1].text += '\n';
    }
  }

  // Fallback: if no runs found, try direct text elements
  if (runs.length === 0) {
    const directTexts = para.getElementsByTagName('hp:t');
    for (let i = 0; i < directTexts.length; i++) {
      const text = directTexts[i].textContent;
      if (text) {
        runs.push({ text, ...defaultProps });
      }
    }
  }

  // Last fallback: get any text content
  if (runs.length === 0) {
    const directText = para.textContent?.trim();
    if (directText) {
      runs.push({ text: directText, ...defaultProps });
    }
  }

  return {
    runs,
    ...paraProps,
  };
}

// Parse border style from hp:border element
function parseBorder(borderElement: Element | null): BorderStyle | undefined {
  if (!borderElement) return undefined;

  const width = borderElement.getAttribute('width');
  const color = borderElement.getAttribute('color');
  const type = borderElement.getAttribute('type');

  return {
    width: width ? parseInt(width) / HWPUNIT_PER_PIXEL : 1,
    color: color ? parseHwpColor(color) : '#000000',
    type: type || 'solid',
  };
}

// Parse HWP color format
function parseHwpColor(colorStr: string): string {
  if (!colorStr || colorStr === '0') return '#000000';
  if (colorStr.startsWith('#')) return colorStr;

  const colorNum = parseInt(colorStr);
  if (!isNaN(colorNum)) {
    const r = (colorNum >> 16) & 0xff;
    const g = (colorNum >> 8) & 0xff;
    const b = colorNum & 0xff;
    return `rgb(${r}, ${g}, ${b})`;
  }
  return '#000000';
}

// Helper to get elements with namespace variations
function getElementsWithNS(parent: Element, localName: string): Element[] {
  const results: Element[] = [];
  // Try with hp: prefix
  let elements = parent.getElementsByTagName(`hp:${localName}`);
  for (let i = 0; i < elements.length; i++) results.push(elements[i]);
  // Try without prefix
  if (results.length === 0) {
    elements = parent.getElementsByTagName(localName);
    for (let i = 0; i < elements.length; i++) results.push(elements[i]);
  }
  return results;
}

// Get direct children matching a local name pattern (more reliable than getElementsByTagName for nested structures)
function getDirectChildren(parent: Element, localNamePatterns: string[]): Element[] {
  const results: Element[] = [];
  for (let i = 0; i < parent.children.length; i++) {
    const child = parent.children[i];
    const tagName = (child.tagName || child.localName || '').toLowerCase();
    const localName = tagName.includes(':') ? tagName.split(':')[1] : tagName;

    for (const pattern of localNamePatterns) {
      if (localName === pattern || tagName.endsWith(':' + pattern)) {
        results.push(child);
        break;
      }
    }
  }
  return results;
}

// Parse table element
function parseTable(tableElement: Element): Table {
  const rows: TableRow[] = [];
  const colWidths: number[] = [];

  // Parse column widths from table properties
  const colSzElements = getElementsWithNS(tableElement, 'colSz');
  for (let i = 0; i < colSzElements.length; i++) {
    const w = colSzElements[i].getAttribute('w');
    if (w) {
      colWidths.push(parseInt(w) / HWPUNIT_PER_PIXEL);
    }
  }

  // Get direct child row elements - use direct children to avoid nested table issues
  let trElements = getDirectChildren(tableElement, ['tr', 'row']);

  // Fallback: try getElementsByTagName but only for immediate children
  if (trElements.length === 0) {
    trElements = getElementsWithNS(tableElement, 'tr');
  }

  console.log('[HwpxViewer] parseTable: Found', trElements.length, 'tr elements');
  if (trElements.length > 0) {
    console.log('[HwpxViewer] First row tagName:', trElements[0].tagName);
  }

  for (let i = 0; i < trElements.length; i++) {
    const tr = trElements[i];
    const cells: TableCell[] = [];

    // Row height
    const rowHeight = tr.getAttribute('height') || tr.getAttribute('h');

    // Get direct child cell elements - use multiple possible names
    let tcElements = getDirectChildren(tr, ['tc', 'cell']);

    // Debug first row
    if (i === 0) {
      console.log('[HwpxViewer] Row 0 - all child tags:',
        Array.from(tr.children).map(c => c.tagName).join(', '));
      console.log('[HwpxViewer] Row 0 - tcElements found (direct):', tcElements.length);
    }

    // Some HWPX files have an intermediate container (like subList or body) between tr and tc
    if (tcElements.length === 0) {
      // Check if there's an intermediate container
      for (let ci = 0; ci < tr.children.length; ci++) {
        const container = tr.children[ci];
        const containerCells = getDirectChildren(container, ['tc', 'cell']);
        if (containerCells.length > 0) {
          tcElements = containerCells;
          if (i === 0) {
            console.log('[HwpxViewer] Found cells inside intermediate container:', container.tagName);
          }
          break;
        }
      }
    }

    // Fallback: use getElementsByTagName (finds nested elements)
    if (tcElements.length === 0) {
      tcElements = getElementsWithNS(tr, 'tc');
      if (i === 0) {
        console.log('[HwpxViewer] Row 0 - tcElements found (getElementsByTagName):', tcElements.length);
      }
    }

    // Last resort: treat ALL direct children as cells (some formats might not use tc tag)
    if (tcElements.length === 0 && tr.children.length > 0) {
      console.log('[HwpxViewer] Row', i, '- Using all direct children as cells');
      tcElements = Array.from(tr.children);
    }

    if (i === 0 && tcElements.length > 0) {
      console.log('[HwpxViewer] Row 0 - first cell tagName:', tcElements[0].tagName);
      console.log('[HwpxViewer] Row 0 - first cell content preview:', tcElements[0].textContent?.substring(0, 100));
    }

    for (let j = 0; j < tcElements.length; j++) {
      const tc = tcElements[j];
      const cellParagraphs: Paragraph[] = [];

      // Parse paragraphs within cell - be more permissive
      const paraElements = getElementsWithNS(tc, 'p');

      // Also check direct children for paragraphs
      const directParas = getDirectChildren(tc, ['p', 'para', 'paragraph']);
      const allParas = [...paraElements];
      for (const dp of directParas) {
        if (!allParas.includes(dp)) allParas.push(dp);
      }

      for (let k = 0; k < allParas.length; k++) {
        const para = allParas[k];
        // Check if this paragraph belongs to this cell (not a nested table's cell)
        let belongsToThisCell = true;
        let parent: Element | null = para.parentElement;
        while (parent && parent !== tc) {
          const parentTag = (parent.tagName || '').toLowerCase();
          // If we hit another tc before reaching our tc, this paragraph doesn't belong to us
          if (parentTag.includes('tc') || parentTag.includes('cell')) {
            belongsToThisCell = false;
            break;
          }
          parent = parent.parentElement;
        }

        if (belongsToThisCell) {
          cellParagraphs.push(parseParagraph(para));
        }
      }

      // If no paragraphs found but cell has text content, create a simple paragraph
      if (cellParagraphs.length === 0) {
        const textContent = tc.textContent?.trim();
        if (textContent) {
          cellParagraphs.push({ runs: [{ text: textContent }] });
        }
      }

      // Get cell properties - try multiple namespace variations
      const cellPr = tc.getElementsByTagName('hp:cellPr')[0] ||
                     tc.getElementsByTagName('cellPr')[0];
      const colSpan = tc.getAttribute('colSpan') || tc.getAttribute('colspan');
      const rowSpan = tc.getAttribute('rowSpan') || tc.getAttribute('rowspan');

      let backgroundColor: string | undefined;
      let borderTop: BorderStyle | undefined;
      let borderBottom: BorderStyle | undefined;
      let borderLeft: BorderStyle | undefined;
      let borderRight: BorderStyle | undefined;
      let vertAlign: 'top' | 'middle' | 'bottom' | undefined;
      let cellWidth: number | undefined;

      if (cellPr) {
        // Background color
        const fillColor = cellPr.getAttribute('fillColor');
        if (fillColor && fillColor !== '0' && fillColor !== '-1') {
          backgroundColor = parseHwpColor(fillColor);
        }

        // Cell borders
        const borderFill = cellPr.getElementsByTagName('hp:borderFill')[0] ||
                          cellPr.getElementsByTagName('borderFill')[0];
        if (borderFill) {
          borderTop = parseBorder(borderFill.getElementsByTagName('hp:top')[0] ||
                                  borderFill.getElementsByTagName('top')[0]);
          borderBottom = parseBorder(borderFill.getElementsByTagName('hp:bottom')[0] ||
                                     borderFill.getElementsByTagName('bottom')[0]);
          borderLeft = parseBorder(borderFill.getElementsByTagName('hp:left')[0] ||
                                   borderFill.getElementsByTagName('left')[0]);
          borderRight = parseBorder(borderFill.getElementsByTagName('hp:right')[0] ||
                                    borderFill.getElementsByTagName('right')[0]);
        }

        // Vertical alignment
        const vAlign = cellPr.getAttribute('vertAlign');
        if (vAlign === 'top') vertAlign = 'top';
        else if (vAlign === 'bottom') vertAlign = 'bottom';
        else vertAlign = 'middle';

        // Cell width
        const width = cellPr.getAttribute('width');
        if (width) cellWidth = parseInt(width) / HWPUNIT_PER_PIXEL;
      }

      cells.push({
        paragraphs: cellParagraphs,
        colSpan: colSpan ? parseInt(colSpan) : undefined,
        rowSpan: rowSpan ? parseInt(rowSpan) : undefined,
        backgroundColor,
        width: cellWidth,
        borderTop,
        borderBottom,
        borderLeft,
        borderRight,
        vertAlign,
      });
    }

    rows.push({
      cells,
      height: rowHeight ? parseInt(rowHeight) / HWPUNIT_PER_PIXEL : undefined,
    });
  }

  // Calculate table width
  const tableWidth = colWidths.length > 0
    ? colWidths.reduce((a, b) => a + b, 0)
    : undefined;

  return { rows, width: tableWidth, colWidths };
}

// Parse image/picture elements
function parseImage(imgElement: Element): ImageElement | null {
  // Get position and size from parent or attributes
  const x = imgElement.getAttribute('x') || '0';
  const y = imgElement.getAttribute('y') || '0';
  const width = imgElement.getAttribute('width') || imgElement.getAttribute('cx') || '0';
  const height = imgElement.getAttribute('height') || imgElement.getAttribute('cy') || '0';
  const binDataRef = imgElement.getAttribute('binaryItemIDRef') ||
                     imgElement.getAttribute('binItemIDRef') ||
                     imgElement.getAttribute('binData');

  if (!binDataRef) return null;

  return {
    id: binDataRef,
    x: parseInt(x) / HWPUNIT_PER_PIXEL,
    y: parseInt(y) / HWPUNIT_PER_PIXEL,
    width: parseInt(width) / HWPUNIT_PER_PIXEL,
    height: parseInt(height) / HWPUNIT_PER_PIXEL,
  };
}

// Parse shape elements (rect, line, etc.)
function parseShape(shapeElement: Element): ShapeElement | null {
  const tagName = shapeElement.tagName.toLowerCase();
  let type: 'rect' | 'line' | 'ellipse' = 'rect';

  if (tagName.includes('line')) type = 'line';
  else if (tagName.includes('ellipse') || tagName.includes('oval')) type = 'ellipse';

  const x = shapeElement.getAttribute('x') || '0';
  const y = shapeElement.getAttribute('y') || '0';
  const width = shapeElement.getAttribute('width') || shapeElement.getAttribute('cx') || '0';
  const height = shapeElement.getAttribute('height') || shapeElement.getAttribute('cy') || '0';

  const fillColor = shapeElement.getAttribute('fillColor');
  const lineColor = shapeElement.getAttribute('lineColor');
  const lineWidth = shapeElement.getAttribute('lineWidth');

  return {
    type,
    x: parseInt(x) / HWPUNIT_PER_PIXEL,
    y: parseInt(y) / HWPUNIT_PER_PIXEL,
    width: parseInt(width) / HWPUNIT_PER_PIXEL,
    height: parseInt(height) / HWPUNIT_PER_PIXEL,
    backgroundColor: fillColor ? parseHwpColor(fillColor) : undefined,
    borderColor: lineColor ? parseHwpColor(lineColor) : undefined,
    borderWidth: lineWidth ? parseInt(lineWidth) / HWPUNIT_PER_PIXEL : undefined,
  };
}

// Parse section XML content
function parseSectionXml(xmlString: string): Section {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlString, 'application/xml');
  const paragraphs: Paragraph[] = [];
  const tables: Table[] = [];
  const images: ImageElement[] = [];
  const shapes: ShapeElement[] = [];

  // Debug: Log first 2000 chars of XML to understand structure
  console.log('[HwpxViewer] XML sample:', xmlString.substring(0, 2000));

  // Try to get section properties for page dimensions
  const secPr = doc.getElementsByTagName('hp:secPr')[0] ||
                doc.getElementsByTagName('secPr')[0];
  let pageWidth, pageHeight, marginLeft, marginRight, marginTop, marginBottom;

  if (secPr) {
    const pagePr = secPr.getElementsByTagName('hp:pagePr')[0];
    if (pagePr) {
      const width = pagePr.getAttribute('width');
      const height = pagePr.getAttribute('height');
      if (width) pageWidth = parseInt(width) / HWPUNIT_PER_PIXEL;
      if (height) pageHeight = parseInt(height) / HWPUNIT_PER_PIXEL;
    }

    const pageMargin = secPr.getElementsByTagName('hp:pageMargin')[0];
    if (pageMargin) {
      const left = pageMargin.getAttribute('left');
      const right = pageMargin.getAttribute('right');
      const top = pageMargin.getAttribute('top');
      const bottom = pageMargin.getAttribute('bottom');
      if (left) marginLeft = parseInt(left) / HWPUNIT_PER_PIXEL;
      if (right) marginRight = parseInt(right) / HWPUNIT_PER_PIXEL;
      if (top) marginTop = parseInt(top) / HWPUNIT_PER_PIXEL;
      if (bottom) marginBottom = parseInt(bottom) / HWPUNIT_PER_PIXEL;
    }
  }

  // Parse all paragraphs (skip those inside tables)
  // First, collect all paragraph elements
  let paraElements: Element[] = [];
  const hpP = doc.getElementsByTagName('hp:p');
  for (let i = 0; i < hpP.length; i++) paraElements.push(hpP[i]);
  // Also try without namespace
  if (paraElements.length === 0) {
    const plainP = doc.getElementsByTagName('p');
    for (let i = 0; i < plainP.length; i++) paraElements.push(plainP[i]);
  }

  console.log('[HwpxViewer] Total paragraph elements found:', paraElements.length);

  for (let i = 0; i < paraElements.length; i++) {
    const para = paraElements[i];

    // Skip paragraphs inside tables (they'll be parsed separately)
    let parent: Element | null = para.parentElement;
    let insideTable = false;
    while (parent) {
      const tagLower = (parent.tagName || parent.localName || '').toLowerCase();
      // Check for table cell or table element - be very aggressive
      if (tagLower.includes('tc') || tagLower.includes('tbl') ||
          tagLower.includes('cell') || tagLower.includes('table') ||
          tagLower.includes('tr') || tagLower.includes('row')) {
        insideTable = true;
        break;
      }
      parent = parent.parentElement;
    }

    if (!insideTable) {
      const paragraph = parseParagraph(para);
      if (paragraph.runs.length > 0) {
        paragraphs.push(paragraph);
      }
    }
  }

  console.log('[HwpxViewer] Paragraphs outside tables:', paragraphs.length);

  // Parse tables with position info - try multiple approaches
  let tableElements = getElementsWithNS(doc.documentElement, 'tbl');

  // Also try direct query for any element ending with 'tbl'
  if (tableElements.length === 0) {
    const allElements = doc.getElementsByTagName('*');
    for (let i = 0; i < allElements.length; i++) {
      const el = allElements[i];
      const tagName = (el.tagName || el.localName || '').toLowerCase();
      if (tagName.endsWith('tbl') || tagName.endsWith(':tbl')) {
        tableElements.push(el);
      }
    }
  }

  console.log('[HwpxViewer] Found table elements:', tableElements.length);
  if (tableElements.length > 0) {
    console.log('[HwpxViewer] First table tagName:', tableElements[0].tagName);
    // Log table structure more clearly
    const firstTable = tableElements[0];
    const tableChildren = Array.from(firstTable.children).map(c => c.tagName).join(', ');
    console.log('[HwpxViewer] First table direct children:', tableChildren);
    // If first child looks like a row, log its children
    if (firstTable.children.length > 0) {
      const firstChild = firstTable.children[0];
      const firstChildChildren = Array.from(firstChild.children).map(c => c.tagName).join(', ');
      console.log('[HwpxViewer] First table > first child > children:', firstChildChildren);
    }
  }

  for (let i = 0; i < tableElements.length; i++) {
    const table = parseTable(tableElements[i]);
    console.log('[HwpxViewer] Parsed table', i, '- rows:', table.rows.length, 'cells in first row:', table.rows[0]?.cells.length);

    // Try to get table position from parent ctrl element
    const parent = tableElements[i].parentElement;
    if (parent) {
      const x = parent.getAttribute('x');
      const y = parent.getAttribute('y');
      if (x) table.x = parseInt(x) / HWPUNIT_PER_PIXEL;
      if (y) table.y = parseInt(y) / HWPUNIT_PER_PIXEL;
    }

    tables.push(table);
  }

  console.log('[HwpxViewer] Final parsed:', { paragraphs: paragraphs.length, tables: tables.length });

  // Parse images (hp:img, hp:pic, hp:ole)
  const imgElements = doc.querySelectorAll('[binaryItemIDRef], [binItemIDRef], [binData]');
  imgElements.forEach(img => {
    const imageEl = parseImage(img);
    if (imageEl) {
      images.push(imageEl);
    }
  });

  // Parse shapes (hp:rect, hp:line, hp:ellipse, etc.)
  const shapeTagNames = ['hp:rect', 'hp:line', 'hp:ellipse', 'hp:oval', 'hp:arc'];
  for (const tagName of shapeTagNames) {
    const shapeElements = doc.getElementsByTagName(tagName);
    for (let i = 0; i < shapeElements.length; i++) {
      const shape = parseShape(shapeElements[i]);
      if (shape) {
        shapes.push(shape);
      }
    }
  }

  // Fallback: if no paragraphs found, try plain text extraction
  if (paragraphs.length === 0 && tables.length === 0) {
    const allText = doc.documentElement.textContent?.trim();
    if (allText) {
      const lines = allText.split(/\n+/).filter(line => line.trim());
      for (const line of lines) {
        paragraphs.push({ runs: [{ text: line.trim() }] });
      }
    }
  }

  return {
    paragraphs,
    tables,
    images,
    shapes,
    pageWidth,
    pageHeight,
    marginLeft,
    marginRight,
    marginTop,
    marginBottom,
  };
}

export function HwpxViewer({ data }: HwpxViewerProps) {
  const [sections, setSections] = useState<Section[]>([]);
  const [images, setImages] = useState<Map<string, string>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [zoom, setZoom] = useState(1);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const loadHwpx = async () => {
      try {
        setLoading(true);
        setError(null);

        const zip = await JSZip.loadAsync(data);
        const loadedSections: Section[] = [];
        const loadedImages = new Map<string, string>();

        // Find section files
        const sectionFiles: string[] = [];
        zip.forEach((path) => {
          if (path.match(/Contents\/section\d+\.xml$/i)) {
            sectionFiles.push(path);
          }
        });

        // Sort sections by number
        sectionFiles.sort((a, b) => {
          const numA = parseInt(a.match(/section(\d+)/i)?.[1] || '0');
          const numB = parseInt(b.match(/section(\d+)/i)?.[1] || '0');
          return numA - numB;
        });

        // Parse each section
        for (const sectionPath of sectionFiles) {
          const sectionXml = await zip.file(sectionPath)?.async('string');
          if (sectionXml) {
            const section = parseSectionXml(sectionXml);
            loadedSections.push(section);
          }
        }

        // If no sections found, try preview text
        if (loadedSections.length === 0) {
          const previewFile = zip.file('Preview/PrvText.txt');
          if (previewFile) {
            const previewText = await previewFile.async('string');
            if (previewText) {
              const lines = previewText.split(/\n/).filter(line => line.trim());
              loadedSections.push({
                paragraphs: lines.map(line => ({ runs: [{ text: line }] })),
                tables: [],
                images: [],
                shapes: [],
              });
            }
          }
        }

        // Load embedded images from BinData folder
        const imagePromises: Promise<void>[] = [];
        zip.forEach((path, file) => {
          if (path.startsWith('BinData/') && !file.dir) {
            const promise = (async () => {
              try {
                const imageData = await file.async('base64');
                const ext = path.split('.').pop()?.toLowerCase() || 'png';
                const mimeType = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' :
                                ext === 'png' ? 'image/png' :
                                ext === 'gif' ? 'image/gif' :
                                ext === 'bmp' ? 'image/bmp' : 'image/png';
                loadedImages.set(path, `data:${mimeType};base64,${imageData}`);
              } catch (e) {
                console.warn('[HwpxViewer] Failed to load image:', path, e);
              }
            })();
            imagePromises.push(promise);
          }
        });

        await Promise.all(imagePromises);

        setSections(loadedSections);
        setImages(loadedImages);
        setLoading(false);
      } catch (err) {
        console.error('[HwpxViewer] Parse failed:', err);
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      }
    };

    loadHwpx();
  }, [data]);

  const handleWheel = useCallback((e: WheelEvent) => {
    if (e.ctrlKey) {
      e.preventDefault();
      const delta = e.deltaY > 0 ? -0.1 : 0.1;
      setZoom(prev => Math.min(3, Math.max(0.25, prev + delta)));
    }
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (container) {
      container.addEventListener('wheel', handleWheel, { passive: false });
      return () => container.removeEventListener('wheel', handleWheel);
    }
  }, [handleWheel]);

  // Render a text run with styling
  const renderTextRun = (run: TextRun, index: number) => {
    const style: React.CSSProperties = {};

    if (run.bold) style.fontWeight = 'bold';
    if (run.italic) style.fontStyle = 'italic';
    if (run.underline) style.textDecoration = 'underline';
    if (run.strikethrough) {
      style.textDecoration = style.textDecoration
        ? `${style.textDecoration} line-through`
        : 'line-through';
    }
    if (run.fontSize) style.fontSize = `${run.fontSize}pt`;
    if (run.fontFamily) style.fontFamily = run.fontFamily;
    if (run.color) style.color = run.color;
    if (run.backgroundColor) style.backgroundColor = run.backgroundColor;
    if (run.superscript) {
      style.verticalAlign = 'super';
      style.fontSize = '0.8em';
    }
    if (run.subscript) {
      style.verticalAlign = 'sub';
      style.fontSize = '0.8em';
    }

    return <span key={index} style={style}>{run.text}</span>;
  };

  // Render a paragraph
  const renderParagraph = (para: Paragraph, index: number) => {
    const style: React.CSSProperties = {
      margin: '0.25em 0',
      textAlign: para.align || 'left',
      lineHeight: para.lineHeight || 1.5,
    };

    if (para.marginTop) style.marginTop = para.marginTop;
    if (para.marginBottom) style.marginBottom = para.marginBottom;
    if (para.indent) style.textIndent = para.indent;

    if (para.isHeading && para.headingLevel) {
      const headingSizes = ['2em', '1.5em', '1.25em', '1.1em', '1em', '0.9em'];
      style.fontSize = headingSizes[para.headingLevel - 1] || '1em';
      style.fontWeight = 'bold';
      style.margin = '1em 0 0.5em 0';
    }

    // Check if paragraph has any content
    const hasContent = para.runs.some(run => run.text.trim());
    if (!hasContent) {
      return <p key={index} style={style}>&nbsp;</p>;
    }

    return (
      <p key={index} style={style}>
        {para.runs.map((run, i) => renderTextRun(run, i))}
      </p>
    );
  };

  // Convert BorderStyle to CSS
  const borderToCSS = (border?: BorderStyle): string => {
    if (!border) return '1px solid #000';
    const width = border.width || 1;
    const color = border.color || '#000';
    const type = border.type === 'double' ? 'double' :
                 border.type === 'dotted' ? 'dotted' :
                 border.type === 'dashed' ? 'dashed' : 'solid';
    return `${Math.max(1, width)}px ${type} ${color}`;
  };

  // Render a table
  const renderTable = (table: Table, index: number) => {
    const tableStyle: React.CSSProperties = {
      borderCollapse: 'collapse',
      width: table.width || '100%',
      tableLayout: table.colWidths && table.colWidths.length > 0 ? 'fixed' : 'auto',
    };

    // If table has absolute position
    if (table.x !== undefined && table.y !== undefined) {
      tableStyle.position = 'absolute';
      tableStyle.left = table.x;
      tableStyle.top = table.y;
    }

    return (
      <table key={index} className="hwpx-table" style={tableStyle}>
        {table.colWidths && table.colWidths.length > 0 && (
          <colgroup>
            {table.colWidths.map((w, i) => (
              <col key={i} style={{ width: w }} />
            ))}
          </colgroup>
        )}
        <tbody>
          {table.rows.map((row, rowIdx) => (
            <tr key={rowIdx} style={{ height: row.height }}>
              {row.cells.map((cell, cellIdx) => (
                <td
                  key={cellIdx}
                  colSpan={cell.colSpan}
                  rowSpan={cell.rowSpan}
                  style={{
                    backgroundColor: cell.backgroundColor,
                    width: cell.width,
                    borderTop: borderToCSS(cell.borderTop),
                    borderBottom: borderToCSS(cell.borderBottom),
                    borderLeft: borderToCSS(cell.borderLeft),
                    borderRight: borderToCSS(cell.borderRight),
                    verticalAlign: cell.vertAlign || 'middle',
                    padding: '4px 8px',
                  }}
                >
                  {cell.paragraphs.map((para, paraIdx) => renderParagraph(para, paraIdx))}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    );
  };

  // Render an image
  const renderImage = (image: ImageElement, index: number) => {
    const src = images.get(`BinData/${image.id}`) ||
                images.get(image.id) ||
                // Try to find by partial match
                Array.from(images.entries()).find(([k]) => k.includes(image.id))?.[1];

    if (!src) return null;

    // If image has position, render absolutely
    if (image.x > 0 || image.y > 0) {
      return (
        <img
          key={`img-${index}`}
          src={src}
          alt=""
          style={{
            position: 'absolute',
            left: image.x,
            top: image.y,
            width: image.width || 'auto',
            height: image.height || 'auto',
            maxWidth: '100%',
          }}
        />
      );
    }

    // Otherwise render inline
    return (
      <img
        key={`img-${index}`}
        src={src}
        alt=""
        className="hwpx-inline-image"
        style={{
          maxWidth: '100%',
          height: 'auto',
          display: 'block',
          margin: '8px auto',
        }}
      />
    );
  };

  // Render a shape
  const renderShape = (shape: ShapeElement, index: number) => {
    const baseStyle: React.CSSProperties = {
      position: 'absolute',
      left: shape.x,
      top: shape.y,
      width: shape.width,
      height: shape.height,
      backgroundColor: shape.backgroundColor,
      border: shape.borderColor ? `${shape.borderWidth || 1}px solid ${shape.borderColor}` : undefined,
    };

    if (shape.type === 'ellipse') {
      baseStyle.borderRadius = '50%';
    }

    if (shape.type === 'line') {
      baseStyle.height = shape.borderWidth || 1;
      baseStyle.backgroundColor = shape.borderColor || '#000';
      baseStyle.border = 'none';
    }

    return <div key={`shape-${index}`} style={baseStyle} />;
  };

  if (loading) {
    return (
      <div className="office-viewer-container hwpx-viewer">
        <div className="hwpx-loading">문서 로딩 중...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="office-viewer-container hwpx-viewer">
        <div className="office-viewer-error">HWPX 파싱 실패: {error}</div>
      </div>
    );
  }

  if (sections.length === 0 || sections.every(s =>
    s.paragraphs.length === 0 && s.tables.length === 0 && s.images.length === 0
  )) {
    return (
      <div className="office-viewer-container hwpx-viewer">
        <div className="office-viewer-error">문서 내용을 찾을 수 없습니다.</div>
      </div>
    );
  }

  // Get page dimensions from first section
  const firstSection = sections[0];
  const pageStyle: React.CSSProperties = {
    width: firstSection.pageWidth || 'auto',
    minHeight: firstSection.pageHeight || 'auto',
    paddingLeft: firstSection.marginLeft || 40,
    paddingRight: firstSection.marginRight || 40,
    paddingTop: firstSection.marginTop || 40,
    paddingBottom: firstSection.marginBottom || 40,
  };

  return (
    <div ref={containerRef} className="office-viewer-container hwpx-viewer">
      <div className="hwpx-zoom-indicator">{Math.round(zoom * 100)}%</div>
      <div
        className="hwpx-content"
        style={{ transform: `scale(${zoom})`, transformOrigin: 'top left' }}
      >
        <div className="hwpx-page" style={pageStyle}>
          {sections.map((section, sectionIdx) => (
            <div key={sectionIdx} className="hwpx-section" style={{ position: 'relative' }}>
              {/* Render shapes first (background) */}
              {section.shapes.map((shape, shapeIdx) => renderShape(shape, shapeIdx))}

              {/* Render positioned images */}
              {section.images.map((img, imgIdx) => renderImage(img, imgIdx))}

              {/* Render paragraphs */}
              {section.paragraphs.map((para, paraIdx) => renderParagraph(para, paraIdx))}

              {/* Render tables */}
              {section.tables.map((table, tableIdx) => renderTable(table, tableIdx))}
            </div>
          ))}

          {/* Fallback: Render remaining images not associated with positions */}
          {images.size > 0 && sections.every(s => s.images.length === 0) && (
            <div className="hwpx-images">
              {Array.from(images.entries()).map(([path, src]) => (
                <img
                  key={path}
                  src={src}
                  alt=""
                  className="hwpx-image"
                  style={{ maxWidth: '100%', margin: '8px 0' }}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default HwpxViewer;
