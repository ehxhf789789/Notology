import React, { createContext, useContext } from 'react';
import type {
  TextRun, Paragraph, TableCell, TableElement, ShapeElement,
  GroupShapeElement, SlideShape, SlideData, ThemeColors, TableStyleDef, TableStyleBand,
} from './pptxTypes';
import { hexToRgb } from './pptxColor';
import { gradientToCSS, PRESET_SHAPE_PATHS, buildConnectorPath } from './pptxGeometry';

// ─── Context ───

export interface PptxSlideContextType {
  imageMap: Map<string, string>;
  themeColors?: ThemeColors;
  tableStylesRef: React.RefObject<Map<string, TableStyleDef>>;
  slideSize: { width: number; height: number };
}

export const PptxSlideContext = createContext<PptxSlideContextType>({
  imageMap: new Map(),
  tableStylesRef: { current: new Map() },
  slideSize: { width: 960, height: 540 },
});

// ─── Utility Functions ───

// CSS transform for rotation + flip
export function buildTransform(s: ShapeElement): string | undefined {
  const transforms: string[] = [];
  if (s.rotation) transforms.push(`rotate(${s.rotation}deg)`);
  if (s.flipH) transforms.push('scaleX(-1)');
  if (s.flipV) transforms.push('scaleY(-1)');
  return transforms.length > 0 ? transforms.join(' ') : undefined;
}

export function buildCellBorderStyle(cell: TableCell, styleBorders?: TableStyleBand['borders'],
  rowIdx?: number, colIdx?: number, totalRows?: number, totalCols?: number): React.CSSProperties {
  const style: React.CSSProperties = {};
  const b = cell.borders;

  // Helper: apply border from cell or style fallback
  const applyBorder = (side: 'left' | 'right' | 'top' | 'bottom', styleSide?: import('./pptxTypes').TableStyleBorder | null) => {
    const cellBorder = b?.[side];
    if (cellBorder) {
      return `${cellBorder.width}px solid ${cellBorder.color}`;
    }
    if (styleSide === null) return 'none'; // explicitly no border
    if (styleSide) return `${styleSide.width}px solid ${styleSide.color}`;
    return undefined;
  };

  // For inside borders, use insideH/insideV from style
  const isInnerH = (side: 'top' | 'bottom') => {
    if (side === 'top' && rowIdx !== undefined && rowIdx > 0) return true;
    if (side === 'bottom' && rowIdx !== undefined && totalRows !== undefined && rowIdx < totalRows - 1) return true;
    return false;
  };
  const isInnerV = (side: 'left' | 'right') => {
    if (side === 'left' && colIdx !== undefined && colIdx > 0) return true;
    if (side === 'right' && colIdx !== undefined && totalCols !== undefined && colIdx < totalCols - 1) return true;
    return false;
  };

  if (b || styleBorders) {
    const leftB = applyBorder('left', isInnerV('left') ? (styleBorders?.insideV ?? styleBorders?.left) : styleBorders?.left);
    const rightB = applyBorder('right', isInnerV('right') ? (styleBorders?.insideV ?? styleBorders?.right) : styleBorders?.right);
    const topB = applyBorder('top', isInnerH('top') ? (styleBorders?.insideH ?? styleBorders?.top) : styleBorders?.top);
    const bottomB = applyBorder('bottom', isInnerH('bottom') ? (styleBorders?.insideH ?? styleBorders?.bottom) : styleBorders?.bottom);
    if (leftB) style.borderLeft = leftB;
    if (rightB) style.borderRight = rightB;
    if (topB) style.borderTop = topB;
    if (bottomB) style.borderBottom = bottomB;
  }
  return style;
}

// Slide background style
export function getSlideBackgroundStyle(slide: SlideData, imageMap: Map<string, string>): React.CSSProperties {
  const bg = slide.background;
  if (!bg) return { backgroundColor: '#ffffff' };

  if (bg.gradient) {
    return { background: gradientToCSS(bg.gradient) };
  }

  if (bg.imageRelId) {
    const imageSrc = imageMap.get(bg.imageRelId);
    if (imageSrc) {
      return {
        backgroundImage: `url(${imageSrc})`,
        backgroundSize: '100% 100%',
        backgroundPosition: '0 0',
        backgroundRepeat: 'no-repeat',
      };
    }
  }

  return { backgroundColor: bg.color || '#ffffff' };
}

// ─── React Components ───

export const PptxTextRun = React.memo(function PptxTextRun({ run, index }: { run: TextRun; index: number }) {
  const style: React.CSSProperties = {};
  if (run.bold) style.fontWeight = 'bold';
  if (run.italic) style.fontStyle = 'italic';
  if (run.underline && run.strikethrough) {
    style.textDecoration = 'underline line-through';
  } else if (run.underline) {
    style.textDecoration = 'underline';
  } else if (run.strikethrough) {
    style.textDecoration = 'line-through';
  }
  if (run.fontSize) style.fontSize = `${run.fontSize}pt`;
  if (run.fontFamily) {
    // Quote multi-word font names for CSS safety
    const ff = run.fontFamily.includes(' ') ? `"${run.fontFamily}"` : run.fontFamily;
    style.fontFamily = ff;
  }
  if (run.color) style.color = run.color;
  if (run.letterSpacing !== undefined) style.letterSpacing = `${run.letterSpacing}pt`;

  if (run.hyperlink) {
    return (
      <a
        key={index}
        href={run.hyperlink}
        target="_blank"
        rel="noopener noreferrer"
        style={{ ...style, color: style.color || '#0563C1', cursor: 'pointer' }}
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); window.open(run.hyperlink!, '_blank'); }}
      >
        {run.text}
      </a>
    );
  }

  // Empty run (line break placeholder) or explicit line break
  if (!run.text) {
    return <br key={index} />;
  }
  if (run.text === '\n') {
    return <br key={index} />;
  }

  return <span key={index} style={style}>{run.text}</span>;
});

export const PptxParagraph = React.memo(function PptxParagraph({ para, index, inTable = false }: { para: Paragraph; index: number; inTable?: boolean }) {
  const style: React.CSSProperties = {
    textAlign: para.align || 'left',
    paddingLeft: para.level ? para.level * 20 : 0,
    margin: 0,
  };

  // Line height
  // PowerPoint line spacing: 100% = single line (~1.2 in CSS), 150% = 1.5 lines, etc.
  // CSS line-height percentage is relative to font-size, so we need to convert
  if (para.lineHeightPt) {
    style.lineHeight = `${para.lineHeightPt}pt`;
  } else if (para.lineHeight) {
    // PowerPoint% -> CSS: multiply by 1.2 (default line height) and divide by 100
    // e.g., PowerPoint 100% -> CSS 1.2, PowerPoint 150% -> CSS 1.8
    const cssLineHeight = (para.lineHeight * 1.2) / 100;
    style.lineHeight = cssLineHeight.toString();
  } else {
    style.lineHeight = inTable ? '1.2' : '1.2';
  }

  // Space before/after
  if (para.spaceBefore) {
    style.marginTop = para.spaceBefore;
  }
  if (para.spaceAfter) {
    style.marginBottom = para.spaceAfter;
  }

  // Paragraph margin (left/indent)
  if (para.marginLeft) {
    style.marginLeft = para.marginLeft;
  }
  if (para.indent) {
    style.textIndent = para.indent;
  }

  return (
    <p key={index} style={style}>
      {para.bulletChar && <span style={{ marginRight: 8 }}>{para.bulletChar}</span>}
      {para.runs.map((run, i) => <PptxTextRun key={i} run={run} index={i} />)}
    </p>
  );
});

export const PptxTable = React.memo(function PptxTable({ table, index }: { table: TableElement; index: number }) {
  const { tableStylesRef } = useContext(PptxSlideContext);
  const tp = table.tblProps;
  const tblStyles = tableStylesRef.current;
  const styleDef = tp?.tblStyleId ? tblStyles.get(tp.tblStyleId) : undefined;
  const tblBg = tp?.backgroundColor || styleDef?.wholeTbl?.fillColor || 'transparent';

  // Determine cell background: explicit fill > table style > table bg
  const getCellBg = (cell: TableCell, rowIdx: number, _colIdx: number): string | undefined => {
    if (cell.noFill) return 'transparent';
    if (cell.backgroundColor) return cell.backgroundColor;

    if (styleDef) {
      if (tp?.firstRow && rowIdx === 0 && styleDef.firstRow?.fillColor) return styleDef.firstRow.fillColor;
      if (tp?.lastRow && rowIdx === table.rows.length - 1 && styleDef.lastRow?.fillColor) return styleDef.lastRow.fillColor;
      if (tp?.firstCol && _colIdx === 0 && styleDef.firstCol?.fillColor) return styleDef.firstCol.fillColor;
      if (tp?.bandRow) {
        const dataRow = tp.firstRow ? rowIdx - 1 : rowIdx;
        if (dataRow >= 0) {
          const band = dataRow % 2 === 0 ? styleDef.band1H : styleDef.band2H;
          if (band?.fillColor) return band.fillColor;
        }
      }
      if (styleDef.wholeTbl?.fillColor) return styleDef.wholeTbl.fillColor;
    }

    return undefined;
  };

  // Get text style from table style
  const getCellTextStyle = (rowIdx: number, _colIdx: number): React.CSSProperties => {
    if (!styleDef) return {};
    const cellStyle: React.CSSProperties = {};
    if (tp?.firstRow && rowIdx === 0 && styleDef.firstRow) {
      if (styleDef.firstRow.fontColor) cellStyle.color = styleDef.firstRow.fontColor;
      if (styleDef.firstRow.fontBold) cellStyle.fontWeight = 'bold';
    } else if (tp?.lastRow && rowIdx === table.rows.length - 1 && styleDef.lastRow) {
      if (styleDef.lastRow.fontColor) cellStyle.color = styleDef.lastRow.fontColor;
      if (styleDef.lastRow.fontBold) cellStyle.fontWeight = 'bold';
    } else if (tp?.firstCol && _colIdx === 0 && styleDef.firstCol) {
      if (styleDef.firstCol.fontColor) cellStyle.color = styleDef.firstCol.fontColor;
      if (styleDef.firstCol.fontBold) cellStyle.fontWeight = 'bold';
    }
    return cellStyle;
  };

  return (
    <div
      key={index}
      ref={(el) => {
        // Auto-shrink table: apply zoom to fit table within frame height
        if (el) {
          const shrinkTable = () => {
            const frameH = table.frameHeight || table.height;
            const tblEl = el.querySelector('table') as HTMLTableElement;
            if (!tblEl || frameH <= 0) return;
            // Reset zoom first to get true content height
            (tblEl.style as any).zoom = '1';
            const actualH = tblEl.scrollHeight;
            if (actualH > frameH + 2) {
              const ratio = Math.max(frameH / actualH, 0.3);
              (tblEl.style as any).zoom = String(ratio);
            }
          };
          // Run twice: once immediately after paint, once after fonts/layout settle
          requestAnimationFrame(shrinkTable);
          setTimeout(shrinkTable, 100);
        }
      }}
      style={{
        position: 'absolute',
        left: table.x,
        top: table.y,
        width: table.width,
        height: table.frameHeight || table.height,
        overflow: 'hidden',
      }}
    >
      <table
        className="pptx-table"
        style={{
          width: table.width,
          borderCollapse: 'collapse',
          tableLayout: 'fixed',
          backgroundColor: tblBg,
        }}
      >
        <colgroup>
          {table.colWidths.map((w, i) => (
            <col key={i} style={{ width: w }} />
          ))}
        </colgroup>
        <tbody>
          {table.rows.map((row, rowIdx) => (
            <tr key={rowIdx} style={{ height: row.height }}>
              {row.cells.map((cell, cellIdx) => (
                <td
                  key={cellIdx}
                  colSpan={cell.colSpan}
                  rowSpan={cell.rowSpan}
                  style={{
                    backgroundColor: getCellBg(cell, rowIdx, cellIdx),
                    ...buildCellBorderStyle(cell, styleDef?.wholeTbl?.borders, rowIdx, cellIdx, table.rows.length, table.colWidths.length),
                    ...getCellTextStyle(rowIdx, cellIdx),
                    padding: cell.margins
                      ? `${cell.margins.top}px ${cell.margins.right}px ${cell.margins.bottom}px ${cell.margins.left}px`
                      : '5px 10px',
                    verticalAlign: cell.vertAlign || 'middle',
                    wordBreak: 'break-word',
                    overflow: 'hidden',
                  }}
                >
                  {cell.paragraphs.map((para, paraIdx) => <PptxParagraph key={paraIdx} para={para} index={paraIdx} inTable />)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
});

export const PptxShape = React.memo(function PptxShape({ shape, index }: { shape: SlideShape; index: number }) {
  const { imageMap } = useContext(PptxSlideContext);

  // Group shape
  if (shape.type === 'group') {
    const group = shape as GroupShapeElement;
    const scaleX = group.childExtX > 0 ? group.width / group.childExtX : 1;
    const scaleY = group.childExtY > 0 ? group.height / group.childExtY : 1;
    const transforms: string[] = [];
    if (group.rotation) transforms.push(`rotate(${group.rotation}deg)`);
    if (group.flipH) transforms.push('scaleX(-1)');
    if (group.flipV) transforms.push('scaleY(-1)');

    // Use CSS transform scale so text inside groups also scales proportionally
    const needsScale = Math.abs(scaleX - 1) > 0.001 || Math.abs(scaleY - 1) > 0.001;
    const innerW = needsScale ? group.childExtX : group.width;
    const innerH = needsScale ? group.childExtY : group.height;

    if (needsScale) {
      transforms.push(`scale(${scaleX}, ${scaleY})`);
    }

    return (
      <div
        key={index}
        style={{
          position: 'absolute',
          left: group.x,
          top: group.y,
          width: innerW,
          height: innerH,
          transformOrigin: 'top left',
          transform: transforms.length > 0 ? transforms.join(' ') : undefined,
          overflow: 'visible',
        }}
      >
        {group.children.map((child, ci) => {
          const mapped = { ...child } as any;
          mapped.x = child.x - group.childOffsetX;
          mapped.y = child.y - group.childOffsetY;
          // Don't manually scale width/height -- CSS transform handles it
          return <PptxShape key={ci} shape={mapped} index={ci} />;
        })}
      </div>
    );
  }

  // Table
  if (shape.type === 'table') {
    return <PptxTable table={shape as TableElement} index={index} />;
  }

  const shapeElement = shape as ShapeElement;

  // Image
  if (shapeElement.type === 'image') {
    const imageSrc = shapeElement.imageRelId ? imageMap.get(shapeElement.imageRelId) : undefined;
    if (!imageSrc) return null;

    const crop = shapeElement.imageCrop;
    const hasCrop = crop && (crop.left > 0 || crop.top > 0 || crop.right > 0 || crop.bottom > 0);
    const duo = shapeElement.duotoneColors;

    // Build duotone SVG filter if needed
    let duoFilterId: string | undefined;
    let duoFilterSvg: React.ReactNode = null;
    if (duo) {
      duoFilterId = `duo-${index}`;
      const shadow = hexToRgb(duo[0]);
      const highlight = hexToRgb(duo[1]);
      duoFilterSvg = (
        <svg width="0" height="0" style={{ position: 'absolute' }}>
          <defs>
            <filter id={duoFilterId} colorInterpolationFilters="sRGB">
              <feColorMatrix type="saturate" values="0" />
              <feComponentTransfer>
                <feFuncR type="table" tableValues={`${shadow.r / 255} ${highlight.r / 255}`} />
                <feFuncG type="table" tableValues={`${shadow.g / 255} ${highlight.g / 255}`} />
                <feFuncB type="table" tableValues={`${shadow.b / 255} ${highlight.b / 255}`} />
              </feComponentTransfer>
            </filter>
          </defs>
        </svg>
      );
    }
    const imgFilter = duoFilterId ? `url(#${duoFilterId})` : undefined;

    if (hasCrop && crop) {
      const visibleW = 100 - crop.left - crop.right;
      const visibleH = 100 - crop.top - crop.bottom;
      return (
        <div
          key={index}
          style={{
            position: 'absolute',
            left: shapeElement.x,
            top: shapeElement.y,
            width: shapeElement.width,
            height: shapeElement.height,
            overflow: 'hidden',
            transform: buildTransform(shapeElement),
          }}
        >
          {duoFilterSvg}
          <img
            src={imageSrc}
            alt=""
            style={{
              position: 'absolute',
              left: `${(-crop.left / visibleW) * 100}%`,
              top: `${(-crop.top / visibleH) * 100}%`,
              width: `${10000 / visibleW}%`,
              height: `${10000 / visibleH}%`,
              filter: imgFilter,
            }}
          />
        </div>
      );
    }

    return (
      <React.Fragment key={index}>
        {duoFilterSvg}
        <img
          src={imageSrc}
          alt=""
          style={{
            position: 'absolute',
            left: shapeElement.x,
            top: shapeElement.y,
            width: shapeElement.width,
            height: shapeElement.height,
            objectFit: 'fill',
            transform: buildTransform(shapeElement),
            filter: imgFilter,
          }}
        />
      </React.Fragment>
    );
  }

  // Line/connector -- uses buildConnectorPath for bent/curved routing
  if (shapeElement.type === 'line') {
    const w = shapeElement.width || 1;
    const h = shapeElement.height || 1;
    const color = shapeElement.borderColor || '#000';
    const strokeW = Math.max(shapeElement.borderWidth || 1, 0.5);
    const hasHead = shapeElement.headEnd && shapeElement.headEnd.type !== 'none';
    const hasTail = shapeElement.tailEnd && shapeElement.tailEnd.type !== 'none';
    const markerId = `arrow-${index}`;
    const pad = strokeW * 4;
    const svgW = Math.max(w, 1) + pad * 2;
    const svgH = Math.max(h, 1) + pad * 2;

    let strokeDasharray: string | undefined;
    let strokeLinecap: string | undefined;
    if (shapeElement.dashStyle) {
      // OOXML dash patterns: multipliers relative to stroke width
      const dashMul: Record<string, number[]> = {
        'dash': [4, 3], 'dot': [1, 3], 'dashDot': [4, 3, 1, 3],
        'lgDash': [8, 3], 'lgDashDot': [8, 3, 1, 3], 'lgDashDotDot': [8, 3, 1, 3, 1, 3],
        'sysDash': [3, 1], 'sysDot': [1, 1],
        'sysDashDot': [3, 1, 1, 1], 'sysDashDotDot': [3, 1, 1, 1, 1, 1],
      };
      const muls = dashMul[shapeElement.dashStyle];
      if (muls) {
        const sw = Math.max(strokeW, 1);
        strokeDasharray = muls.map(m => Math.max(m * sw, 0.5)).join(' ');
      }
      if (shapeElement.dashStyle.toLowerCase().includes('dot')) {
        strokeLinecap = 'round';
      }
    }

    // Build connector path (straight, bent, or curved)
    const connType = shapeElement.connectorType || 'straightConnector1';
    const adjValues = shapeElement.adjustValues || {};
    const connPath = buildConnectorPath(w, h, connType, adjValues, pad);

    // Arrow marker shapes based on type -- use userSpaceOnUse for absolute sizing
    const renderMarker = (end: import('./pptxTypes').ArrowHead, id: string, isHead: boolean) => {
      // PowerPoint arrow head sizing -- base + proportional to stroke width
      // PPT default (med, 1pt line): ~9px wide, ~11px long
      // For thicker lines, arrow scales but not as fast as lineWidth
      const baseW: Record<string, number> = { 'sm': 6, 'med': 9, 'lg': 14 };
      const baseH: Record<string, number> = { 'sm': 7, 'med': 11, 'lg': 16 };
      const extraW: Record<string, number> = { 'sm': 1.5, 'med': 2.5, 'lg': 4 };
      const extraH: Record<string, number> = { 'sm': 2, 'med': 3, 'lg': 5 };
      const wKey = end.w || 'med';
      const hKey = end.len || 'med';
      const mw = (baseW[wKey] || 9) + (extraW[wKey] || 2.5) * strokeW;
      const mh = (baseH[hKey] || 11) + (extraH[hKey] || 3) * strokeW;
      const refX = isHead ? 1 : mw - 1;
      let markerShape: React.ReactNode;
      if (end.type === 'oval') {
        markerShape = <ellipse cx={mw / 2} cy={mh / 2} rx={mw / 2} ry={mh / 2} fill={color} />;
      } else if (end.type === 'diamond') {
        markerShape = <polygon points={`${mw / 2} 0, ${mw} ${mh / 2}, ${mw / 2} ${mh}, 0 ${mh / 2}`} fill={color} />;
      } else if (end.type === 'stealth') {
        const pts = isHead
          ? `${mw} 0, 0 ${mh / 2}, ${mw} ${mh}, ${mw * 0.65} ${mh / 2}`
          : `0 0, ${mw} ${mh / 2}, 0 ${mh}, ${mw * 0.35} ${mh / 2}`;
        markerShape = <polygon points={pts} fill={color} />;
      } else {
        // triangle (default)
        const pts = isHead
          ? `${mw} 0, 0 ${mh / 2}, ${mw} ${mh}`
          : `0 0, ${mw} ${mh / 2}, 0 ${mh}`;
        markerShape = <polygon points={pts} fill={color} />;
      }
      return (
        <marker key={id} id={id} markerWidth={mw} markerHeight={mh}
          refX={refX} refY={mh / 2} orient="auto" markerUnits="userSpaceOnUse">
          {markerShape}
        </marker>
      );
    };

    return (
      <svg
        key={index}
        style={{
          position: 'absolute',
          left: shapeElement.x - pad,
          top: shapeElement.y - pad,
          width: svgW,
          height: svgH,
          overflow: 'visible',
          transform: buildTransform(shapeElement),
          transformOrigin: 'center',
        }}
      >
        <defs>
          {hasTail && shapeElement.tailEnd && renderMarker(shapeElement.tailEnd, `${markerId}-tail`, false)}
          {hasHead && shapeElement.headEnd && renderMarker(shapeElement.headEnd, `${markerId}-head`, true)}
        </defs>
        <path
          d={connPath}
          fill="none"
          stroke={color}
          strokeWidth={strokeW}
          strokeDasharray={strokeDasharray}
          strokeLinecap={strokeLinecap as any || 'flat'}
          strokeLinejoin="round"
          markerStart={hasHead ? `url(#${markerId}-head)` : undefined}
          markerEnd={hasTail ? `url(#${markerId}-tail)` : undefined}
        />
      </svg>
    );
  }

  // ─── Unified shape rendering (SVG path or div fallback) ───
  const tb = shapeElement.textBody;
  const isNoWrap = tb?.wrap === 'none';
  const vertAlignMap: Record<string, string> = { 'top': 'flex-start', 'middle': 'center', 'bottom': 'flex-end' };
  const hasText = shapeElement.paragraphs?.some(p => p.runs.some(r => r.text.length > 0));

  // Shadow CSS
  const shadowStyle: React.CSSProperties = {};
  if (shapeElement.shadow) {
    const s = shapeElement.shadow;
    if (s.inset) {
      shadowStyle.boxShadow = `inset ${s.offsetX}px ${s.offsetY}px ${s.blur}px ${s.color}`;
    } else {
      shadowStyle.filter = `drop-shadow(${s.offsetX}px ${s.offsetY}px ${s.blur}px ${s.color})`;
    }
  }

  // AutoFit font scale
  const fontScaleStyle: React.CSSProperties = {};
  if (tb?.fontScale && tb.fontScale < 1) {
    fontScaleStyle.fontSize = `${Math.round(tb.fontScale * 100)}%`;
  }
  if (tb?.lnSpcReduction && tb.lnSpcReduction > 0) {
    // Reduce from default 1.2 line height (not percentage of font-size)
    const reducedLineHeight = 1.2 * (1 - tb.lnSpcReduction);
    fontScaleStyle.lineHeight = reducedLineHeight.toFixed(2);
  }

  // Resolve SVG path: customPath > PRESET_SHAPE_PATHS > null (div fallback)
  const shapeType = shapeElement.shapeType;
  let svgPath: string | null = null;
  if (shapeElement.customPath) {
    svgPath = shapeElement.customPath;
  } else if (shapeType && PRESET_SHAPE_PATHS[shapeType]) {
    svgPath = PRESET_SHAPE_PATHS[shapeType](shapeElement.width, shapeElement.height, shapeElement.adjustValues);
  }

  // Auto-shrink text ref callback: use CSS zoom to fit overflowing text
  const autoShrinkRef = (el: HTMLDivElement | null) => {
    if (!el || isNoWrap) return;
    requestAnimationFrame(() => {
      const containerH = el.clientHeight;
      const contentH = el.scrollHeight;
      if (contentH > containerH + 2 && containerH > 0) {
        // Direct ratio calculation: zoom = container / content, clamped to [0.4, 0.95]
        const z = Math.max(Math.min(containerH / contentH, 0.95), 0.4);
        (el.style as any).zoom = String(z);
      }
    });
  };

  // Text overlay for SVG shapes
  const renderTextOverlay = () => {
    if (!hasText) return null;
    return (
      <div ref={autoShrinkRef} style={{
        position: 'relative', zIndex: 1, display: 'flex',
        flexDirection: tb?.verticalText ? 'row' : 'column',
        justifyContent: tb ? vertAlignMap[tb.verticalAlign || 'top'] || 'flex-start' : 'center',
        width: '100%', height: '100%',
        padding: tb ? `${tb.paddingTop}px ${tb.paddingRight}px ${tb.paddingBottom}px ${tb.paddingLeft}px` : '4px 8px',
        boxSizing: 'border-box',
        whiteSpace: isNoWrap ? 'nowrap' : undefined,
        writingMode: tb?.verticalText ? 'vertical-rl' : undefined,
        overflow: isNoWrap ? 'visible' : 'hidden',
        ...fontScaleStyle,
      }}>
        {shapeElement.paragraphs?.map((para, i) => <PptxParagraph key={i} para={para} index={i} />)}
      </div>
    );
  };

  // SVG path rendering
  if (svgPath) {
    const w = shapeElement.width;
    const h = shapeElement.height;
    const strokeColor = shapeElement.borderColor || 'none';
    const strokeW = shapeElement.borderWidth || 0;
    const gradId = `grad-shape-${index}`;
    const hasGradient = !!shapeElement.gradientFill;
    const fillColor = hasGradient ? `url(#${gradId})` : (shapeElement.backgroundColor || 'transparent');

    let strokeDasharray: string | undefined;
    let shapeStrokeLinecap: string | undefined;
    if (shapeElement.dashStyle) {
      const dashMul: Record<string, number[]> = {
        'dash': [4, 3], 'dot': [1, 3], 'dashDot': [4, 3, 1, 3],
        'lgDash': [8, 3], 'lgDashDot': [8, 3, 1, 3], 'lgDashDotDot': [8, 3, 1, 3, 1, 3],
        'sysDash': [3, 1], 'sysDot': [1, 1],
        'sysDashDot': [3, 1, 1, 1], 'sysDashDotDot': [3, 1, 1, 1, 1, 1],
      };
      const muls = dashMul[shapeElement.dashStyle];
      if (muls) {
        const sw = Math.max(strokeW, 1);
        strokeDasharray = muls.map(m => Math.max(m * sw, 0.5)).join(' ');
      }
      if (shapeElement.dashStyle.toLowerCase().includes('dot')) {
        shapeStrokeLinecap = 'round';
      }
    }

    return (
      <div
        key={index}
        style={{
          position: 'absolute',
          left: shapeElement.x,
          top: shapeElement.y,
          width: w,
          height: h,
          transform: buildTransform(shapeElement),
          ...shadowStyle,
        }}
      >
        <svg width={w} height={h} style={{ position: 'absolute', top: 0, left: 0, overflow: 'visible' }}>
          {hasGradient && shapeElement.gradientFill && (
            <defs>
              {shapeElement.gradientFill.type === 'linear' ? (
                <linearGradient id={gradId}
                  x1={`${50 - 50 * Math.cos((shapeElement.gradientFill.angle || 0) * Math.PI / 180)}%`}
                  y1={`${50 - 50 * Math.sin((shapeElement.gradientFill.angle || 0) * Math.PI / 180)}%`}
                  x2={`${50 + 50 * Math.cos((shapeElement.gradientFill.angle || 0) * Math.PI / 180)}%`}
                  y2={`${50 + 50 * Math.sin((shapeElement.gradientFill.angle || 0) * Math.PI / 180)}%`}
                >
                  {shapeElement.gradientFill.stops.map((stop, si) => (
                    <stop key={si} offset={`${stop.position}%`} stopColor={stop.color} />
                  ))}
                </linearGradient>
              ) : (
                <radialGradient id={gradId}>
                  {shapeElement.gradientFill.stops.map((stop, si) => (
                    <stop key={si} offset={`${stop.position}%`} stopColor={stop.color} />
                  ))}
                </radialGradient>
              )}
            </defs>
          )}
          <path d={svgPath} fill={fillColor} stroke={strokeColor} strokeWidth={strokeW}
            strokeDasharray={strokeDasharray} strokeLinecap={shapeStrokeLinecap as any} fillRule="evenodd" />
        </svg>
        {renderTextOverlay()}
      </div>
    );
  }

  // Div fallback (rect without preset, unknown shapes)
  const bgStyle: React.CSSProperties = {};
  if (shapeElement.gradientFill) {
    bgStyle.background = gradientToCSS(shapeElement.gradientFill);
  } else if (shapeElement.backgroundColor) {
    bgStyle.backgroundColor = shapeElement.backgroundColor;
  }
  if (shapeElement.borderColor && shapeElement.borderWidth) {
    const borderStyle = shapeElement.dashStyle
      ? (shapeElement.dashStyle.includes('dot') || shapeElement.dashStyle === 'sysDot' ? 'dotted' : 'dashed')
      : 'solid';
    bgStyle.border = `${shapeElement.borderWidth}px ${borderStyle} ${shapeElement.borderColor}`;
  }

  return (
    <div
      key={index}
      ref={autoShrinkRef}
      className="pptx-shape"
      style={{
        position: 'absolute',
        left: shapeElement.x,
        top: shapeElement.y,
        width: shapeElement.width,
        height: shapeElement.height,
        ...bgStyle,
        ...shadowStyle,
        transform: buildTransform(shapeElement),
        overflow: isNoWrap ? 'visible' : 'hidden',
        display: 'flex',
        flexDirection: tb?.verticalText ? 'row' : 'column',
        justifyContent: tb ? vertAlignMap[tb.verticalAlign || 'top'] || 'flex-start' : 'center',
        padding: tb
          ? `${tb.paddingTop}px ${tb.paddingRight}px ${tb.paddingBottom}px ${tb.paddingLeft}px`
          : '4px 8px',
        boxSizing: 'border-box',
        whiteSpace: isNoWrap ? 'nowrap' : undefined,
        writingMode: tb?.verticalText ? 'vertical-rl' : undefined,
        ...fontScaleStyle,
      }}
    >
      {shapeElement.paragraphs?.map((para, i) => <PptxParagraph key={i} para={para} index={i} />)}
    </div>
  );
});
