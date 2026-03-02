import type {
  ThemeColors, ThemeFonts, CellBorder, TableCell, TableRow, TableProps, TableElement,
  TableStyleBorder, TableStyleBand, TableStyleDef,
} from './pptxTypes';
import { parseColor, hexToRgb, rgbToHex } from './pptxColor';
import { parseTextBody } from './pptxTextParser';
import { EMU_PER_PIXEL } from '../shared/viewerConstants';

// ─── Border & Table Parsing ───

export function parseBorderLine(lineEl: Element | undefined, themeColors?: ThemeColors): CellBorder | undefined {
  if (!lineEl) return undefined;
  const w = parseInt(lineEl.getAttribute('w') || '0') / EMU_PER_PIXEL;
  if (w <= 0) return undefined;
  const fill = lineEl.getElementsByTagName('a:solidFill')[0];
  const color = fill ? (parseColor(fill, themeColors) || '#000000') : '#000000';
  return { color, width: Math.max(w, 0.5) };
}

export function parseTable(graphicData: Element, themeColors?: ThemeColors, themeFonts?: ThemeFonts): TableElement | null {
  const tbl = graphicData.getElementsByTagName('a:tbl')[0];
  if (!tbl) return null;

  // Parse a:tblPr (table properties)
  const tblPr = tbl.getElementsByTagName('a:tblPr')[0];
  const tblProps: TableProps = {};
  if (tblPr) {
    tblProps.firstRow = tblPr.getAttribute('firstRow') === '1';
    tblProps.lastRow = tblPr.getAttribute('lastRow') === '1';
    tblProps.bandRow = tblPr.getAttribute('bandRow') === '1';
    tblProps.bandCol = tblPr.getAttribute('bandCol') === '1';
    tblProps.firstCol = tblPr.getAttribute('firstCol') === '1';
    tblProps.lastCol = tblPr.getAttribute('lastCol') === '1';
    // tblStyle can be attribute OR child <a:tableStyleId> element
    tblProps.tblStyleId = tblPr.getAttribute('tblStyle') || undefined;
    if (!tblProps.tblStyleId) {
      const tblStyleIdEl = tblPr.getElementsByTagName('a:tableStyleId')[0];
      if (tblStyleIdEl) tblProps.tblStyleId = tblStyleIdEl.textContent?.trim() || undefined;
    }

    // Table-level fill -- direct children only
    for (let fi = 0; fi < tblPr.children.length; fi++) {
      const child = tblPr.children[fi];
      if (child.tagName === 'a:noFill') {
        tblProps.backgroundColor = 'transparent';
        break;
      } else if (child.tagName === 'a:solidFill') {
        tblProps.backgroundColor = parseColor(child, themeColors);
        break;
      } else if (child.tagName === 'a:gradFill') {
        const gs = child.getElementsByTagName('a:gs')[0];
        if (gs) tblProps.backgroundColor = parseColor(gs, themeColors);
        break;
      }
    }
  }

  const tblGrid = tbl.getElementsByTagName('a:tblGrid')[0];
  const colWidths: number[] = [];
  if (tblGrid) {
    const gridCols = tblGrid.getElementsByTagName('a:gridCol');
    for (let i = 0; i < gridCols.length; i++) {
      const w = parseInt(gridCols[i].getAttribute('w') || '0') / EMU_PER_PIXEL;
      colWidths.push(w);
    }
  }

  const rows: TableRow[] = [];
  const trElements: Element[] = [];
  for (let i = 0; i < tbl.children.length; i++) {
    if (tbl.children[i].tagName === 'a:tr') trElements.push(tbl.children[i]);
  }

  for (const tr of trElements) {
    const rowHeight = parseInt(tr.getAttribute('h') || '0') / EMU_PER_PIXEL;
    const cells: TableCell[] = [];

    const tcElements: Element[] = [];
    for (let j = 0; j < tr.children.length; j++) {
      if (tr.children[j].tagName === 'a:tc') tcElements.push(tr.children[j]);
    }

    for (const tc of tcElements) {
      // Skip continuation cells (vertical/horizontal merge)
      const vMerge = tc.getAttribute('vMerge');
      if (vMerge !== null && vMerge !== '0') continue;
      const hMerge = tc.getAttribute('hMerge');
      if (hMerge !== null && hMerge !== '0') continue;

      const txBody = tc.getElementsByTagName('a:txBody')[0];
      const paragraphs = txBody ? parseTextBody(txBody, themeColors, themeFonts) : [];

      const tcPr = tc.getElementsByTagName('a:tcPr')[0];
      let backgroundColor: string | undefined;
      let noFill = false;
      let borders: TableCell['borders'];
      let vertAlign: TableCell['vertAlign'];
      let margins: TableCell['margins'];

      if (tcPr) {
        // CRITICAL: Only check DIRECT children of tcPr for fill
        // getElementsByTagName would find fills inside border elements (a:lnL, a:lnR etc.)
        let cellFillFound = false;
        for (let fi = 0; fi < tcPr.children.length; fi++) {
          const child = tcPr.children[fi];
          if (child.tagName === 'a:noFill') {
            noFill = true;
            cellFillFound = true;
            break;
          } else if (child.tagName === 'a:solidFill') {
            backgroundColor = parseColor(child, themeColors);
            cellFillFound = true;
            break;
          } else if (child.tagName === 'a:gradFill') {
            const gs = child.getElementsByTagName('a:gs')[0];
            if (gs) backgroundColor = parseColor(gs, themeColors);
            cellFillFound = true;
            break;
          }
        }
        // If no explicit fill on cell, keep backgroundColor undefined (use table bg)
        if (!cellFillFound) {
          // No direct fill specified -- transparent (inherits table/style background)
        }

        borders = {
          left: parseBorderLine(tcPr.getElementsByTagName('a:lnL')[0], themeColors),
          right: parseBorderLine(tcPr.getElementsByTagName('a:lnR')[0], themeColors),
          top: parseBorderLine(tcPr.getElementsByTagName('a:lnT')[0], themeColors),
          bottom: parseBorderLine(tcPr.getElementsByTagName('a:lnB')[0], themeColors),
        };

        const anchor = tcPr.getAttribute('anchor');
        if (anchor === 't') vertAlign = 'top';
        else if (anchor === 'b') vertAlign = 'bottom';
        else vertAlign = 'middle';

        // Cell margins
        const marL = parseInt(tcPr.getAttribute('marL') || '91440') / EMU_PER_PIXEL;
        const marR = parseInt(tcPr.getAttribute('marR') || '91440') / EMU_PER_PIXEL;
        const marT = parseInt(tcPr.getAttribute('marT') || '45720') / EMU_PER_PIXEL;
        const marB = parseInt(tcPr.getAttribute('marB') || '45720') / EMU_PER_PIXEL;
        margins = { left: marL, right: marR, top: marT, bottom: marB };
      }

      const gridSpan = parseInt(tc.getAttribute('gridSpan') || '1');
      const rowSpan = parseInt(tc.getAttribute('rowSpan') || '1');

      cells.push({
        paragraphs,
        colSpan: gridSpan > 1 ? gridSpan : undefined,
        rowSpan: rowSpan > 1 ? rowSpan : undefined,
        backgroundColor,
        noFill,
        borders,
        vertAlign,
        margins,
      });
    }

    rows.push({ cells, height: rowHeight > 0 ? rowHeight : undefined });
  }

  const totalWidth = colWidths.reduce((a, b) => a + b, 0);
  const totalHeight = rows.reduce((sum, r) => sum + (r.height || 30), 0);

  return {
    type: 'table',
    x: 0, y: 0,
    width: totalWidth,
    height: totalHeight,
    rows,
    colWidths,
    tblProps: Object.keys(tblProps).length > 0 ? tblProps : undefined,
  };
}

// ─── Table Style Parser ───

export function parseTableStylesXml(xmlString: string, themeColors?: ThemeColors): Map<string, TableStyleDef> {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlString, 'application/xml');
  const styles = new Map<string, TableStyleDef>();

  const tblStyleElements = doc.getElementsByTagName('a:tblStyle');
  for (let i = 0; i < tblStyleElements.length; i++) {
    const tblStyle = tblStyleElements[i];
    const styleId = tblStyle.getAttribute('styleId') || '';
    const def: TableStyleDef = {};

    const bandNames = ['wholeTbl', 'band1H', 'band2H', 'firstRow', 'lastRow', 'firstCol', 'lastCol'] as const;
    for (const bandName of bandNames) {
      const bandEl = tblStyle.getElementsByTagName(`a:${bandName}`)[0];
      if (bandEl) {
        const band: TableStyleBand = {};
        const tcStyle = bandEl.getElementsByTagName('a:tcStyle')[0];
        if (tcStyle) {
          const fill = tcStyle.getElementsByTagName('a:fill')[0];
          if (fill) {
            const solidFill = fill.getElementsByTagName('a:solidFill')[0];
            if (solidFill) {
              band.fillColor = parseColor(solidFill, themeColors);
            } else {
              // fillRef -- references theme fill by index
              const fillRef = fill.getElementsByTagName('a:fillRef')[0];
              if (fillRef) {
                const refColor = parseColor(fillRef, themeColors);
                if (refColor) band.fillColor = refColor;
              }
            }
          }
          // Also check tcStyle > fillRef (without a:fill wrapper)
          if (!band.fillColor) {
            const fillRef = tcStyle.getElementsByTagName('a:fillRef')[0];
            if (fillRef) {
              const refColor = parseColor(fillRef, themeColors);
              if (refColor) band.fillColor = refColor;
            }
          }
          // Parse tcBdr (border definitions)
          const tcBdr = tcStyle.getElementsByTagName('a:tcBdr')[0];
          if (tcBdr) {
            const parseBorderSide = (sideTag: string): TableStyleBorder | null | undefined => {
              const sideEl = tcBdr.getElementsByTagName(`a:${sideTag}`)[0];
              if (!sideEl) return undefined;
              const ln = sideEl.getElementsByTagName('a:ln')[0];
              if (!ln) return undefined;
              const noFill = ln.getElementsByTagName('a:noFill')[0];
              if (noFill) return null; // explicitly no border
              const solidFill = ln.getElementsByTagName('a:solidFill')[0];
              if (solidFill) {
                const color = parseColor(solidFill, themeColors) || '#000000';
                const width = parseInt(ln.getAttribute('w') || '12700') / EMU_PER_PIXEL;
                return { width, color };
              }
              return undefined;
            };
            band.borders = {
              left: parseBorderSide('left'),
              right: parseBorderSide('right'),
              top: parseBorderSide('top'),
              bottom: parseBorderSide('bottom'),
              insideH: parseBorderSide('insideH'),
              insideV: parseBorderSide('insideV'),
            };
          }
        }
        const tcTxStyle = bandEl.getElementsByTagName('a:tcTxStyle')[0];
        if (tcTxStyle) {
          if (tcTxStyle.getAttribute('b') === 'on') band.fontBold = true;
          band.fontColor = parseColor(tcTxStyle, themeColors);
        }
        def[bandName] = band;
      }
    }

    if (Object.keys(def).length > 0) styles.set(styleId, def);
  }

  return styles;
}

export function getDefaultTableStyle(themeColors?: ThemeColors): TableStyleDef {
  const accent1 = themeColors?.accent1 || '#4472C4';
  const { r, g, b } = hexToRgb(accent1);
  const tint40 = rgbToHex(r + (255 - r) * 0.6, g + (255 - g) * 0.6, b + (255 - b) * 0.6);
  const tint20 = rgbToHex(r + (255 - r) * 0.8, g + (255 - g) * 0.8, b + (255 - b) * 0.8);
  return {
    firstRow: { fillColor: accent1, fontColor: '#FFFFFF', fontBold: true },
    band1H: { fillColor: tint20 },
    band2H: { fillColor: tint40 },
    wholeTbl: { fillColor: '#FFFFFF' },
  };
}

export function getDirectChildElements(parent: Element, tagName: string): Element[] {
  const result: Element[] = [];
  for (let i = 0; i < parent.children.length; i++) {
    const child = parent.children[i];
    if (child.tagName === tagName) {
      result.push(child);
    } else if (child.tagName === 'mc:AlternateContent') {
      // Prefer Fallback for browser compatibility
      let fallback: Element | null = null;
      let choice: Element | null = null;
      for (let j = 0; j < child.children.length; j++) {
        if (child.children[j].tagName === 'mc:Fallback') fallback = child.children[j];
        else if (child.children[j].tagName === 'mc:Choice') choice = child.children[j];
      }
      const container = fallback || choice;
      if (container) {
        for (let j = 0; j < container.children.length; j++) {
          if (container.children[j].tagName === tagName) {
            result.push(container.children[j]);
          }
        }
      }
    }
  }
  return result;
}
