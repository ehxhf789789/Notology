import React, { useContext } from 'react';
import type {
  TextRun, Paragraph, Table, DrawingElement, ContentItem, TabStop,
} from './docxTypes';
import { DocGridContext } from './docxTypes';
import { HIGHLIGHT_COLORS } from './docxStyleParser';
import { borderToCSS } from './docxTableParser';

// ==================== Render Components ====================

function RenderRun({ run }: { run: TextRun }) {
  const style: React.CSSProperties = {
    fontWeight: run.bold ? 'bold' : undefined,
    fontStyle: run.italic ? 'italic' : undefined,
    textDecoration: run.underline ? 'underline' : run.strikethrough ? 'line-through' : undefined,
    fontSize: run.fontSize ? `${run.fontSize}pt` : undefined,
    fontFamily: run.fontFamily || undefined,
    fontKerning: run.fontKerning === false ? 'none' : undefined,
    color: run.color || undefined,
    backgroundColor: run.highlight ? HIGHLIGHT_COLORS[run.highlight] : run.backgroundColor,
    verticalAlign: run.superscript ? 'super' : run.subscript ? 'sub' : undefined,
    letterSpacing: run.letterSpacing ? `${run.letterSpacing}px` : undefined,
  };

  if (run.text === '\n') {
    return <br />;
  }

  return <span style={style}>{run.text}</span>;
}

// Render a leader fill between text segments (e.g., dots in TOC: "Title ··· 13")
function TabLeader({ leader, tabStop }: { leader: TabStop['leader']; tabStop: TabStop }) {
  const char = leader === 'dot' ? '·' : leader === 'hyphen' ? '-' : leader === 'underscore' ? '_' : '';
  if (!char) {
    // No leader — just flex spacer
    return <span style={{ flex: 1, minWidth: '1em' }} />;
  }
  return (
    <span style={{
      flex: 1,
      minWidth: '1em',
      overflow: 'hidden',
      whiteSpace: 'nowrap',
      letterSpacing: leader === 'dot' ? '0.15em' : undefined,
      textAlign: tabStop.alignment === 'right' ? 'right' : undefined,
    }}>
      {char.repeat(200)}
    </span>
  );
}

function renderRunContent(run: TextRun, key: number, inlineDrawings?: DrawingElement[], inlineImageIndexRef?: { current: number }) {
  if (run.text === '\uFFFC' && inlineDrawings && inlineImageIndexRef && inlineImageIndexRef.current < inlineDrawings.length) {
    const drawing = inlineDrawings[inlineImageIndexRef.current++];
    if (drawing.imageSrc) {
      const hasCrop = drawing.cropTop || drawing.cropBottom || drawing.cropLeft || drawing.cropRight;
      const imgStyle: React.CSSProperties = {
        width: drawing.width,
        maxWidth: '100%',
        height: 'auto', // Scale proportionally when width is constrained by maxWidth
        verticalAlign: 'middle',
      };
      if (hasCrop) {
        imgStyle.clipPath = `inset(${drawing.cropTop}% ${drawing.cropRight}% ${drawing.cropBottom}% ${drawing.cropLeft}%)`;
      }
      return <img key={key} src={drawing.imageSrc} style={imgStyle} alt="" />;
    }
    return null;
  }
  // Don't render orphaned \uFFFC as visible text
  if (run.text === '\uFFFC') return null;
  return <RenderRun key={key} run={run} />;
}

function _RenderParagraph({ para, inlineDrawings }: { para: Paragraph; inlineDrawings?: DrawingElement[] }) {
  const linePitch = useContext(DocGridContext);

  // OOXML indent model: w:ind left=L, hanging=H
  //   First line starts at: L - H (numbering text here)
  //   Subsequent lines at: L (body text here)
  // CSS mapping: paddingLeft=L, textIndent=-H, marginLeft=0
  const totalLeftIndent = para.numberingIndent || para.marginLeft || 0;

  const style: React.CSSProperties = {
    textAlign: para.align || undefined,
    marginTop: para.spaceBefore || 0,
    marginBottom: para.spaceAfter || 0,
    marginLeft: 0,
    marginRight: para.marginRight || 0,
    textIndent: para.indent
      ? para.indent - (para.hangingIndent || 0)
      : para.hangingIndent ? -para.hangingIndent : undefined,
    paddingLeft: totalLeftIndent || undefined,
    // w:wordWrap val="0" → allow CJK character-level line breaks (common in HWP-converted DOCX).
    // Without this, browser breaks only at word boundaries, causing different line layout than Word.
    wordBreak: para.wordBreakAll ? 'break-all' : undefined,
  };

  // Determine if this paragraph snaps to document grid
  const snapsToGrid = linePitch > 0 && para.snapToGrid !== false;

  // Step 3: lineHeight correct handling with docGrid snapping
  if (para.lineHeightType === 'exact' && para.lineHeightValue) {
    // 'exact' line-height: use specified value. No grid snapping (Word behavior).
    // Clamp to at least the largest font size to prevent text overlap in CSS.
    let minPx = para.lineHeightValue;
    if (para.runs.length > 0) {
      for (const run of para.runs) {
        if (run.fontSize) {
          const px = run.fontSize * (96 / 72); // pt → px
          if (px > minPx) minPx = px;
        }
      }
    }
    style.lineHeight = `${minPx}px`;
  } else if (para.lineHeightType === 'atLeast' && para.lineHeightValue) {
    // 'atLeast': minimum is specified value, snap to grid if applicable
    let minPx = para.lineHeightValue;
    if (para.runs.length > 0) {
      for (const run of para.runs) {
        if (run.fontSize) {
          const px = run.fontSize * (96 / 72);
          if (px > minPx) minPx = px;
        }
      }
    }
    if (snapsToGrid) {
      minPx = Math.ceil(minPx / linePitch) * linePitch;
    }
    style.lineHeight = `${minPx}px`;
  } else if (para.lineHeightType === 'auto' && para.lineHeightValue) {
    if (snapsToGrid) {
      // With docGrid: snap line-height to nearest grid line
      // auto lineHeightValue is a multiplier (e.g., 1.15 = 276/240)
      // Get the largest font size in the paragraph to compute actual line-height
      let maxFontPx = 0;
      for (const run of para.runs) {
        if (run.fontSize) {
          const px = run.fontSize * (96 / 72);
          if (px > maxFontPx) maxFontPx = px;
        }
      }
      if (maxFontPx === 0 && para.effectiveFontSize) {
        maxFontPx = para.effectiveFontSize * (96 / 72);
      }
      if (maxFontPx === 0) maxFontPx = 16; // fallback to 12pt only when no font size found
      const naturalLH = maxFontPx * para.lineHeightValue;
      const snappedLH = Math.ceil(naturalLH / linePitch) * linePitch;
      style.lineHeight = `${snappedLH}px`;
    } else {
      // Without grid: compute px line-height from actual content font size.
      // Avoids CSS strut issue: when parent div inherits large font-size (e.g., 12pt)
      // but content uses smaller font (e.g., 7pt in tables), unitless line-height
      // would create a strut at 12pt × multiplier, inflating all line boxes.
      // Using px eliminates strut dependence on inherited font-size.
      let maxFontPx = 0;
      for (const run of para.runs) {
        if (run.fontSize) {
          const px = run.fontSize * (96 / 72);
          if (px > maxFontPx) maxFontPx = px;
        }
      }
      if (maxFontPx === 0 && para.effectiveFontSize) {
        // Empty paragraph — use cascade font size (e.g., 12pt from table style)
        maxFontPx = para.effectiveFontSize * (96 / 72);
      }
      if (maxFontPx > 0) {
        style.lineHeight = `${maxFontPx * para.lineHeightValue}px`;
      } else {
        style.lineHeight = para.lineHeightValue; // fallback to unitless
      }
    }
  } else if (snapsToGrid) {
    // No explicit line spacing but docGrid active — inherit linePitch from page (CSS inheritance)
    // No need to set explicitly; the page div already has lineHeight: linePitch
  } else {
    // No explicit line spacing, no grid — compute px line-height to avoid strut issues.
    // Use content font size × docDefaults auto multiplier (typically 1.0-1.15)
    let maxFontPx = 0;
    for (const run of para.runs) {
      if (run.fontSize) {
        const px = run.fontSize * (96 / 72);
        if (px > maxFontPx) maxFontPx = px;
      }
    }
    if (maxFontPx === 0 && para.effectiveFontSize) {
      maxFontPx = para.effectiveFontSize * (96 / 72);
    }
    if (maxFontPx > 0) {
      // Default OOXML auto line-height is 1.0 (single spacing)
      const defaultAutoMultiplier = para.lineHeightValue || 1;
      style.lineHeight = `${maxFontPx * defaultAutoMultiplier}px`;
    }
  }

  let prefix = null;
  if (para.bulletChar) {
    const bulletStyle: React.CSSProperties = { marginRight: '0.3em', display: 'inline-block', minWidth: '1em', textAlign: 'center' };
    if (para.numberingRunProps?.fontFamily) bulletStyle.fontFamily = para.numberingRunProps.fontFamily;
    if (para.numberingRunProps?.fontSize) bulletStyle.fontSize = `${para.numberingRunProps.fontSize}pt`;
    prefix = <span style={bulletStyle}>{para.bulletChar}</span>;
  } else if (para.numberingText) {
    const numStyle: React.CSSProperties = { marginRight: '0.3em' };
    if (para.numberingRunProps?.fontFamily) numStyle.fontFamily = para.numberingRunProps.fontFamily;
    if (para.numberingRunProps?.fontSize) numStyle.fontSize = `${para.numberingRunProps.fontSize}pt`;
    if (para.numberingRunProps?.bold) numStyle.fontWeight = 'bold';
    if (para.numberingRunProps?.italic) numStyle.fontStyle = 'italic';
    prefix = <span style={numStyle}>{para.numberingText}</span>;
  }

  const hasContent = para.runs.length > 0 || prefix;
  const inlineImageIndexRef = { current: 0 };

  // Check if paragraph has tab stops with leaders (TOC-style layout)
  const hasTabLeader = para.tabStops?.some(t => t.leader && t.leader !== 'none');
  const hasTab = para.runs.some(r => r.text === '\t');

  if (hasTabLeader && hasTab && para.tabStops) {
    // TOC-style rendering: split runs at tab characters and use flex layout
    // Structure: [segment1] [leader···] [segment2] [leader···] [segment3]
    const segments: { runs: TextRun[]; tabIndex: number }[] = [];
    let currentRuns: TextRun[] = [];
    let tabIdx = 0;

    for (const run of para.runs) {
      if (run.text === '\t') {
        segments.push({ runs: currentRuns, tabIndex: tabIdx });
        currentRuns = [];
        tabIdx++;
      } else {
        currentRuns.push(run);
      }
    }
    segments.push({ runs: currentRuns, tabIndex: tabIdx });

    // Remove textIndent for flex layout (it conflicts)
    style.textIndent = undefined;
    style.display = 'flex';
    style.alignItems = 'baseline';

    let globalRunKey = 0;

    return (
      <p style={style}>
        {prefix}
        {segments.map((seg, segIdx) => {
          const elements: React.ReactNode[] = [];

          // Before this segment (except the first), render the tab leader
          if (segIdx > 0) {
            const tabStop = para.tabStops![Math.min(segIdx - 1, para.tabStops!.length - 1)];
            elements.push(
              <TabLeader key={`leader-${segIdx}`} leader={tabStop.leader || 'none'} tabStop={tabStop} />
            );
          }

          // Determine if this is the last segment after a right-aligned tab
          const prevTab = segIdx > 0 ? para.tabStops![Math.min(segIdx - 1, para.tabStops!.length - 1)] : null;
          const isRightAligned = prevTab?.alignment === 'right';

          // Render runs in this segment
          const segContent = seg.runs.map((run, ri) => {
            const key = globalRunKey++;
            return renderRunContent(run, key, inlineDrawings, inlineImageIndexRef);
          });

          if (isRightAligned) {
            elements.push(
              <span key={`seg-${segIdx}`} style={{ whiteSpace: 'nowrap', flexShrink: 0 }}>
                {segContent}
              </span>
            );
          } else {
            elements.push(
              <span key={`seg-${segIdx}`} style={{ flexShrink: 1 }}>
                {segContent}
              </span>
            );
          }

          return elements;
        })}
        {!hasContent && <>&nbsp;</>}
      </p>
    );
  }

  // Standard paragraph rendering (no tab leaders)
  return (
    <p style={style}>
      {prefix}
      {para.runs.map((run, i) => {
        if (run.text === '\t') {
          // Regular tab — use tab stop position if available, else Word default (0.5in = 48px)
          if (para.tabStops && para.tabStops.length > 0) {
            const tabCount = para.runs.slice(0, i).filter(r => r.text === '\t').length;
            const tabStop = para.tabStops[Math.min(tabCount, para.tabStops.length - 1)];
            return <span key={i} style={{ display: 'inline-block', minWidth: tabStop.position > 0 ? `${tabStop.position}px` : '48px' }}>&nbsp;</span>;
          }
          return <span key={i} style={{ display: 'inline-block', width: '48px' }}>&nbsp;</span>;
        }
        return renderRunContent(run, i, inlineDrawings, inlineImageIndexRef);
      })}
      {!hasContent && <>&nbsp;</>}
    </p>
  );
}

function _RenderTable({ table }: { table: Table }) {
  // Use fixed layout when: explicit 'fixed' tblLayout, or table has explicit dxa width
  const isFixedLayout = table.layoutType === 'fixed' || (table.widthType === 'dxa' && !!table.width);
  const isAutoWidth = !isFixedLayout && (table.widthType === 'auto' || !table.width);
  const widthValue = table.widthType === 'pct' && table.width === undefined
    ? '100%' : (table.width || '100%');

  const tableStyle: React.CSSProperties = {
    borderCollapse: 'collapse',
    width: widthValue,
    marginLeft: table.alignment === 'center' ? 'auto' : table.alignment === 'right' ? 'auto' : 0,
    marginRight: table.alignment === 'center' ? 'auto' : 0,
    tableLayout: isFixedLayout ? 'fixed' : 'auto',
  };

  const cellPad = table.cellPadding || { left: 7.2, right: 7.2, top: 0, bottom: 0 };

  return (
    <table style={tableStyle}>
      {table.colWidths.length > 0 && isFixedLayout && (
        <colgroup>
          {table.colWidths.map((w, i) => (
            <col key={i} style={{ width: w || 'auto' }} />
          ))}
        </colgroup>
      )}
      <tbody>
        {table.rows.map((row, rowIdx) => (
          <tr key={rowIdx} style={{ height: row.height }}>
            {row.cells.map((cell, cellIdx) => {
              if (cell.vMerge === 'continue') return null;

              const cellStyle: React.CSSProperties = {
                padding: `${cellPad.top}px ${cellPad.right}px ${cellPad.bottom}px ${cellPad.left}px`,
                backgroundColor: cell.backgroundColor,
                verticalAlign: cell.vertAlign || 'top',
                width: isAutoWidth ? undefined : cell.width,
                borderTop: borderToCSS(cell.borderTop),
                borderBottom: borderToCSS(cell.borderBottom),
                borderLeft: borderToCSS(cell.borderLeft),
                borderRight: borderToCSS(cell.borderRight),
                wordWrap: 'break-word',
                overflow: 'hidden',
                // Table style font-size: sets CSS inheritance for td content.
                // Without this, unstyled elements (strut, &nbsp;) inherit from
                // page div instead of the table style, causing incorrect line heights.
                fontSize: table.styleFontSize ? `${table.styleFontSize}pt` : undefined,
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

// Measurement variant of RenderContent — wraps each item in a measurable div
export function MeasurableContent({ items }: { items: ContentItem[] }) {
  const rendered: React.ReactNode[] = [];
  let i = 0;
  while (i < items.length) {
    const item = items[i];
    if (item.type === 'paragraph') {
      const inlineDrawings: DrawingElement[] = [];
      let j = i + 1;
      while (j < items.length && items[j].type === 'drawing') {
        const d = (items[j] as { type: 'drawing'; data: DrawingElement }).data;
        if (d.inline) inlineDrawings.push(d);
        j++;
      }
      rendered.push(
        <div key={`m-${i}`} data-item-idx={i} style={{ }}>
          <RenderParagraph para={item.data}
            inlineDrawings={inlineDrawings.length > 0 ? inlineDrawings : undefined} />
        </div>
      );
      // ALL consumed drawings need a measurement marker (to prevent missing indices)
      for (let k = i + 1; k < j; k++) {
        const drawItem = items[k] as { type: 'drawing'; data: DrawingElement };
        if (drawItem.data.inline) {
          // Inline drawing already rendered inside paragraph — zero-height marker
          // This prevents the fallback estimator from double-counting its height
          rendered.push(
            <div key={`m-${k}`} data-item-idx={k} style={{ height: 0, overflow: 'hidden' }} />
          );
        } else if (drawItem.data.imageSrc) {
          // Non-inline drawing — render for measurement
          const hasCrop = drawItem.data.cropTop || drawItem.data.cropBottom || drawItem.data.cropLeft || drawItem.data.cropRight;
          const imgStyle: React.CSSProperties = { maxWidth: '100%', height: 'auto' };
          if (hasCrop) {
            imgStyle.clipPath = `inset(${drawItem.data.cropTop}% ${drawItem.data.cropRight}% ${drawItem.data.cropBottom}% ${drawItem.data.cropLeft}%)`;
          }
          rendered.push(
            <div key={`m-${k}`} data-item-idx={k} style={{ }}>
              <div style={{ textAlign: 'center', margin: '8px 0' }}>
                <img src={drawItem.data.imageSrc} style={imgStyle} alt="" />
              </div>
            </div>
          );
        } else {
          // No imageSrc — zero-height marker
          rendered.push(
            <div key={`m-${k}`} data-item-idx={k} style={{ height: 0, overflow: 'hidden' }} />
          );
        }
      }
      i = j > i + 1 ? j : i + 1;
    } else if (item.type === 'table') {
      rendered.push(
        <div key={`m-${i}`} data-item-idx={i} style={{ }}>
          <RenderTable table={item.data} />
        </div>
      );
      i++;
    } else if (item.type === 'drawing') {
      if (item.data.imageSrc) {
        const hasCrop = item.data.cropTop || item.data.cropBottom || item.data.cropLeft || item.data.cropRight;
        const imgStyle: React.CSSProperties = { maxWidth: '100%', height: 'auto' };
        if (hasCrop) {
          imgStyle.clipPath = `inset(${item.data.cropTop}% ${item.data.cropRight}% ${item.data.cropBottom}% ${item.data.cropLeft}%)`;
        }
        rendered.push(
          <div key={`m-${i}`} data-item-idx={i} style={{ }}>
            <div style={{ textAlign: 'center', margin: '8px 0' }}>
              <img src={item.data.imageSrc} style={imgStyle} alt="" />
            </div>
          </div>
        );
      } else {
        // No imageSrc — zero-height marker to avoid missing index
        rendered.push(
          <div key={`m-${i}`} data-item-idx={i} style={{ height: 0, overflow: 'hidden' }} />
        );
      }
      i++;
    } else {
      i++;
    }
  }
  return <>{rendered}</>;
}

function _RenderContent({ items }: { items: ContentItem[] }) {
  const rendered: React.ReactNode[] = [];
  let i = 0;
  let prevPara: Paragraph | null = null;

  while (i < items.length) {
    const item = items[i];

    switch (item.type) {
      case 'paragraph': {
        const inlineDrawings: DrawingElement[] = [];
        let j = i + 1;
        while (j < items.length && items[j].type === 'drawing') {
          const drawing = (items[j] as { type: 'drawing'; data: DrawingElement }).data;
          if (drawing.inline) inlineDrawings.push(drawing);
          j++;
        }

        // contextualSpacing: suppress spacing between consecutive paragraphs of the same style
        let suppressSpaceBefore = false;
        if (item.data.contextualSpacing && prevPara &&
            prevPara.styleId && item.data.styleId &&
            prevPara.styleId === item.data.styleId) {
          suppressSpaceBefore = true;
        }
        // Also check if previous paragraph had contextualSpacing (suppress its spaceAfter)
        let suppressSpaceAfter = false;
        // Look ahead: find next paragraph
        let nextParaIdx = j;
        while (nextParaIdx < items.length && items[nextParaIdx].type === 'drawing') nextParaIdx++;
        if (item.data.contextualSpacing && nextParaIdx < items.length &&
            items[nextParaIdx].type === 'paragraph') {
          const nextPara = (items[nextParaIdx] as { type: 'paragraph'; data: Paragraph }).data;
          if (nextPara.styleId && item.data.styleId && nextPara.styleId === item.data.styleId) {
            suppressSpaceAfter = true;
          }
        }

        const paraToRender = (suppressSpaceBefore || suppressSpaceAfter)
          ? {
              ...item.data,
              spaceBefore: suppressSpaceBefore ? 0 : item.data.spaceBefore,
              spaceAfter: suppressSpaceAfter ? 0 : item.data.spaceAfter,
            }
          : item.data;

        rendered.push(
          <RenderParagraph
            key={i}
            para={paraToRender}
            inlineDrawings={inlineDrawings.length > 0 ? inlineDrawings : undefined}
          />
        );
        prevPara = item.data;
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
          const hasCrop = drawing.cropTop || drawing.cropBottom || drawing.cropLeft || drawing.cropRight;
          const imgStyle: React.CSSProperties = { maxWidth: '100%', height: 'auto' };
          if (hasCrop) {
            imgStyle.clipPath = `inset(${drawing.cropTop}% ${drawing.cropRight}% ${drawing.cropBottom}% ${drawing.cropLeft}%)`;
          }
          rendered.push(
            <div key={i} style={{ textAlign: 'center', margin: '8px 0' }}>
              <img src={drawing.imageSrc} style={imgStyle} alt="" />
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

// React.memo wrapping for key components
export const RenderParagraph = React.memo(_RenderParagraph);
export const RenderTable = React.memo(_RenderTable);
export const RenderContent = React.memo(_RenderContent);
