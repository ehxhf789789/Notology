import React from 'react';
import type {
  TextRun, Paragraph, Table, ImageElement, EquationElement, TextBoxElement,
  ContentItem, BorderStyle,
} from './hwpxTypes';
import { equationScriptToHtml } from './hwpxEquation';

// ==================== Render Context ====================

export interface HwpxRenderContext {
  resolveImageSrc: (id: string) => string | undefined;
}

// ==================== Render Functions ====================

export const RenderTextRun = React.memo(function RenderTextRun({ run, index }: { run: TextRun; index: number }) {
  // Inline equation — render as formatted math HTML
  if (run.equationHtml) {
    return <span key={index} style={{
      fontFamily: "'Cambria Math', 'Latin Modern Math', 'Times New Roman', serif",
      fontStyle: 'italic',
      display: 'inline',
      verticalAlign: 'middle',
    }} dangerouslySetInnerHTML={{ __html: run.equationHtml }} />;
  }

  // Line break (Shift+Enter) — render as <br/>
  if (run.text === '\n') return <br key={index} />;

  const style: React.CSSProperties = {};
  if (run.bold) style.fontWeight = 'bold';
  if (run.italic) style.fontStyle = 'italic';
  if (run.underline) style.textDecoration = 'underline';
  if (run.strikethrough) style.textDecoration = style.textDecoration ? `${style.textDecoration} line-through` : 'line-through';
  if (run.fontSize) style.fontSize = `${run.fontSize}pt`;
  if (run.fontFamily) style.fontFamily = run.fontFamily;
  if (run.color) style.color = run.color;
  if (run.backgroundColor) style.backgroundColor = run.backgroundColor;
  if (run.superscript) { style.verticalAlign = 'super'; style.fontSize = '0.65em'; style.lineHeight = '0'; }
  if (run.subscript) { style.verticalAlign = 'sub'; style.fontSize = '0.65em'; style.lineHeight = '0'; }
  if (run.letterSpacing) style.letterSpacing = `${run.letterSpacing / 100}em`;
  if (run.charRatio && run.charRatio !== 100) style.transform = `scaleX(${run.charRatio / 100})`;
  return <span key={index} style={style}>{run.text}</span>;
});

export function renderTextRun(run: TextRun, index: number) {
  // Inline equation — render as formatted math HTML
  if (run.equationHtml) {
    return <span key={index} style={{
      fontFamily: "'Cambria Math', 'Latin Modern Math', 'Times New Roman', serif",
      fontStyle: 'italic',
      display: 'inline',
      verticalAlign: 'middle',
    }} dangerouslySetInnerHTML={{ __html: run.equationHtml }} />;
  }

  // Line break (Shift+Enter) — render as <br/>
  if (run.text === '\n') return <br key={index} />;

  const style: React.CSSProperties = {};
  if (run.bold) style.fontWeight = 'bold';
  if (run.italic) style.fontStyle = 'italic';
  if (run.underline) style.textDecoration = 'underline';
  if (run.strikethrough) style.textDecoration = style.textDecoration ? `${style.textDecoration} line-through` : 'line-through';
  if (run.fontSize) style.fontSize = `${run.fontSize}pt`;
  if (run.fontFamily) style.fontFamily = run.fontFamily;
  if (run.color) style.color = run.color;
  if (run.backgroundColor) style.backgroundColor = run.backgroundColor;
  if (run.superscript) { style.verticalAlign = 'super'; style.fontSize = '0.65em'; style.lineHeight = '0'; }
  if (run.subscript) { style.verticalAlign = 'sub'; style.fontSize = '0.65em'; style.lineHeight = '0'; }
  if (run.letterSpacing) style.letterSpacing = `${run.letterSpacing / 100}em`;
  if (run.charRatio && run.charRatio !== 100) style.transform = `scaleX(${run.charRatio / 100})`;
  return <span key={index} style={style}>{run.text}</span>;
}

export function renderParagraph(para: Paragraph, key: string) {
  const alignValue = para.align === 'distribute' ? 'justify' : (para.align || 'justify');
  const style: React.CSSProperties = {
    margin: 0, textAlign: alignValue, lineHeight: para.lineHeight || 1.6,
  };
  // DISTRIBUTE_SPACE: justify all lines including the last, preserve spaces for centering
  if (para.align === 'distribute') {
    (style as Record<string, unknown>)['textAlignLast'] = 'justify';
    style.whiteSpace = 'pre-wrap';
  }
  if (para.marginTop != null && para.marginTop > 0) style.marginTop = para.marginTop;
  if (para.marginBottom != null && para.marginBottom > 0) style.marginBottom = para.marginBottom;
  if (para.indent) style.textIndent = para.indent;
  if (para.marginLeft) style.marginLeft = para.marginLeft;

  const hasContent = para.runs.some(run => run.text.trim() || run.equationHtml);
  const hasTabs = para.runs.some(run => run.isTab);

  // Empty paragraph — render as proper blank line with correct height
  if (!hasContent && !hasTabs && !para.bulletChar && !para.numberingText) {
    const fontSize = para.runs[0]?.fontSize;
    if (fontSize) style.fontSize = `${fontSize}pt`;
    return <p key={key} style={style}>&nbsp;</p>;
  }

  // Tab-separated rendering (e.g., TOC entries with dot/dash leaders)
  if (hasTabs) {
    const segments: TextRun[][] = [[]];
    const tabRuns: (TextRun | undefined)[] = [undefined]; // tab run preceding each segment
    for (const run of para.runs) {
      if (run.isTab) {
        tabRuns.push(run);
        segments.push([]);
      } else {
        segments[segments.length - 1].push(run);
      }
    }

    style.display = 'flex';
    style.alignItems = 'baseline';
    style.textIndent = 0; // reset indent for flex layout

    const children: React.ReactNode[] = [];
    let tabIdx = 0;
    for (let si = 0; si < segments.length; si++) {
      if (si > 0) {
        const tabRun = tabRuns[si];
        const tabStop = para.tabStops?.[tabIdx] || para.tabStops?.[0];
        tabIdx++;
        // Prefer inline tab leader (from <hp:tab> attributes) over tabStop definition
        const leader = tabRun?.tabLeader || tabStop?.leader || 'NONE';
        if (leader === 'DOT') {
          children.push(
            <span key={`tl-${si}`} style={{
              flex: 1, overflow: 'hidden', whiteSpace: 'nowrap',
              letterSpacing: '1.5px', opacity: 0.5, margin: '0 4px',
            }}>
              {'·'.repeat(300)}
            </span>
          );
        } else if (leader === 'LONG_DASH' || leader === 'DASH' || leader === 'DASH_DOT' || leader === 'DASH_DOT_DOT' || leader === 'HYPHEN') {
          children.push(
            <span key={`tl-${si}`} style={{
              flex: 1, overflow: 'hidden', whiteSpace: 'nowrap',
              opacity: 0.5, margin: '0 4px',
            }}>
              {(leader === 'LONG_DASH' ? '─' : '-').repeat(300)}
            </span>
          );
        } else if (leader === 'SOLID') {
          children.push(
            <span key={`tl-${si}`} style={{
              flex: 1, overflow: 'hidden', whiteSpace: 'nowrap',
              opacity: 0.5, margin: '0 4px',
            }}>
              {'─'.repeat(300)}
            </span>
          );
        } else {
          children.push(<span key={`tl-${si}`} style={{ flex: 1, minWidth: '1em' }} />);
        }
      }
      if (segments[si].length > 0) {
        children.push(
          <span key={`ts-${si}`} style={{ flexShrink: 0, whiteSpace: si > 0 ? 'nowrap' : undefined }}>
            {segments[si].map((run, ri) => renderTextRun(run, ri))}
          </span>
        );
      }
    }

    return <p key={key} style={style}>{children}</p>;
  }

  // Bullet or numbering prefix
  if (para.bulletChar || para.numberingText) {
    style.display = 'flex';
    style.gap = '4px';
    const prefix = para.bulletChar || para.numberingText || '';
    if (!hasContent) return <p key={key} style={style}>&nbsp;</p>;
    // Apply numbering font: from paraHead charPrIDRef, or fallback to first text run
    const prefixStyle: React.CSSProperties = {
      flexShrink: 0, minWidth: para.bulletChar ? '1em' : 'auto',
      textAlign: 'right', paddingRight: '4px',
    };
    const ns = para.numberingStyle;
    const fontSource = ns && (ns.fontSize || ns.fontFamily || ns.bold)
      ? ns : para.runs.find(r => r.text.trim());
    if (fontSource) {
      if (fontSource.bold) prefixStyle.fontWeight = 'bold';
      if (fontSource.italic) prefixStyle.fontStyle = 'italic';
      if (fontSource.fontSize) prefixStyle.fontSize = `${fontSource.fontSize}pt`;
      if (fontSource.fontFamily) prefixStyle.fontFamily = fontSource.fontFamily;
      if (fontSource.color) prefixStyle.color = fontSource.color;
    }
    return (
      <p key={key} style={style}>
        <span style={prefixStyle}>{prefix}</span>
        <span style={{ flex: 1 }}>{para.runs.map((run, i) => renderTextRun(run, i))}</span>
      </p>
    );
  }

  // Distribute alignment
  if (para.align === 'distribute') {
    // Detect centered equation pattern: [spaces...][equation][...spaces (N)]
    const eqIdx = para.runs.findIndex(r => r.equationHtml);
    if (eqIdx >= 0) {
      const allLeadingWhitespace = para.runs.slice(0, eqIdx).every(r => !r.text.trim() && !r.equationHtml);
      if (allLeadingWhitespace && eqIdx > 0) {
        // Separate equation content from trailing number like "(1)"
        const trailingRuns: TextRun[] = [];
        for (let i = eqIdx + 1; i < para.runs.length; i++) {
          const trimmed = para.runs[i].text.trim();
          if (trimmed) trailingRuns.push({ ...para.runs[i], text: trimmed });
        }
        const eqStyle: React.CSSProperties = {
          margin: style.margin, lineHeight: style.lineHeight,
          marginTop: style.marginTop, marginBottom: style.marginBottom,
          marginLeft: style.marginLeft,
          display: 'flex', alignItems: 'baseline',
        };
        return (
          <p key={key} style={eqStyle}>
            <span style={{ flex: 1, textAlign: 'center' }}>
              {renderTextRun(para.runs[eqIdx], eqIdx)}
            </span>
            {trailingRuns.length > 0 && (
              <span style={{ flexShrink: 0 }}>
                {trailingRuns.map((run, i) => renderTextRun(run, eqIdx + 1 + i))}
              </span>
            )}
          </p>
        );
      }
    }
    // General distribute: insert word-break spaces between runs so CSS justify works
    return (
      <p key={key} style={style}>
        {para.runs.map((run, i) => (
          <React.Fragment key={i}>{renderTextRun(run, i)}{i < para.runs.length - 1 && run.text !== '\n' && para.runs[i + 1]?.text !== '\n' ? ' ' : null}</React.Fragment>
        ))}
      </p>
    );
  }

  return <p key={key} style={style}>{para.runs.map((run, i) => renderTextRun(run, i))}</p>;
}

export function borderToCSS(border?: BorderStyle): string {
  if (!border || border.type === 'NONE') return 'none';
  const w = Math.max(1, border.width || 1);
  const color = border.color && border.color !== 'none' ? border.color : '#000';
  const type = border.type === 'DOUBLE' ? 'double' : border.type === 'DOTTED' ? 'dotted' : border.type === 'DASHED' ? 'dashed' : 'solid';
  return `${w}px ${type} ${color}`;
}

export function renderTable(table: Table, key: string, ctx: HwpxRenderContext) {
  const totalWidth = table.colWidths.reduce((a, b) => a + b, 0);

  const captionEl = table.caption ? (
    <div style={{ fontSize: '0.85em', color: '#555', textAlign: 'center', padding: '4px 0' }}>{table.caption}</div>
  ) : null;

  return (
    <div key={key} style={{ margin: '2px 0' }}>
      {table.captionSide === 'TOP' && captionEl}
      <table className="hwpx-table" style={{ borderCollapse: 'collapse', width: totalWidth || table.width || '100%', tableLayout: 'fixed' }}>
        {table.colWidths.length > 0 && (
          <colgroup>{table.colWidths.map((w, i) => <col key={i} style={{ width: w }} />)}</colgroup>
        )}
        <tbody>
          {table.rows.map((row, ri) => (
            <tr key={ri} style={{ height: row.height }}>
              {row.cells.map((cell, ci) => {
                const cellStyle: React.CSSProperties = {
                  backgroundColor: cell.backgroundColor,
                  borderTop: borderToCSS(cell.borderTop), borderBottom: borderToCSS(cell.borderBottom),
                  borderLeft: borderToCSS(cell.borderLeft), borderRight: borderToCSS(cell.borderRight),
                  verticalAlign: cell.vertAlign || 'top', padding: '2px 4px',
                  wordBreak: 'break-word', overflow: 'hidden',
                };
                // Cell background image
                if (cell.backgroundImgRef) {
                  const src = ctx.resolveImageSrc(cell.backgroundImgRef);
                  if (src) {
                    cellStyle.backgroundImage = `url(${src})`;
                    cellStyle.backgroundSize = 'contain';
                    cellStyle.backgroundRepeat = 'no-repeat';
                    cellStyle.backgroundPosition = 'center';
                  }
                }
                return (
                  <td key={ci}
                    colSpan={cell.colSpan > 1 ? cell.colSpan : undefined}
                    rowSpan={cell.rowSpan > 1 ? cell.rowSpan : undefined}
                    style={cellStyle}
                  >
                    {cell.content.map((item, ii) => renderContentItem(item, `${key}-r${ri}-c${ci}-i${ii}`, ctx))}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {table.captionSide !== 'TOP' && captionEl}
    </div>
  );
}

export function renderImage(image: ImageElement, key: string, ctx: HwpxRenderContext) {
  const src = ctx.resolveImageSrc(image.id);
  if (!src) return null;

  // Image cropping: imgClip values are ABSOLUTE COORDINATES in imgDim coordinate space
  // Use percentage-based approach so it works regardless of actual image pixel dimensions
  const refW = image.imgDimWidth || image.orgWidth;
  const refH = image.imgDimHeight || image.orgHeight;
  if (image.imgClip && refW && refH && (image.imgClip.right > 0 || image.imgClip.bottom > 0)) {
    const displayW = image.width > 0 ? image.width : 200;
    const displayH = image.height > 0 ? image.height : 200;
    // Calculate crop as percentage of the full image
    const leftPct = image.imgClip.left / refW;
    const topPct = image.imgClip.top / refH;
    const visibleWPct = (image.imgClip.right - image.imgClip.left) / refW;
    const visibleHPct = (image.imgClip.bottom - image.imgClip.top) / refH;
    // Full image size so visible portion = displayW x displayH
    const fullImgW = visibleWPct > 0 ? displayW / visibleWPct : displayW;
    const fullImgH = visibleHPct > 0 ? displayH / visibleHPct : displayH;
    // Offset to show only the visible portion
    const offsetX = -fullImgW * leftPct;
    const offsetY = -fullImgH * topPct;

    const containerStyle: React.CSSProperties = {
      width: displayW, height: displayH,
      overflow: 'hidden', position: 'relative',
      display: image.inline ? 'inline-block' : 'block',
    };
    if (!image.inline) {
      containerStyle.margin = image.horzAlign === 'CENTER' ? '8px auto' : image.horzAlign === 'RIGHT' ? '8px 0 8px auto' : '8px 0';
    }
    const imgEl = (
      <div style={containerStyle}>
        <img src={src} alt={image.caption || ''} style={{
          position: 'absolute',
          width: fullImgW, height: fullImgH,
          left: offsetX, top: offsetY,
        }} />
      </div>
    );

    if (image.caption) {
      const figStyle: React.CSSProperties = { margin: '8px 0', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center' };
      if (image.horzAlign === 'CENTER') figStyle.margin = '8px auto';
      else if (image.horzAlign === 'RIGHT') figStyle.alignItems = 'flex-end';
      const cap = <figcaption style={{ fontSize: '0.85em', color: '#555', marginTop: image.captionSide === 'BOTTOM' ? '4px' : undefined, marginBottom: image.captionSide === 'TOP' ? '4px' : undefined }}>{image.caption}</figcaption>;
      return <figure key={key} style={figStyle}>{image.captionSide === 'TOP' && cap}{imgEl}{image.captionSide !== 'TOP' && cap}</figure>;
    }
    return <div key={key}>{imgEl}</div>;
  }

  // No cropping — simple image render
  const imgStyle: React.CSSProperties = {
    maxWidth: '100%',
    width: image.width > 0 ? image.width : 'auto',
    height: image.height > 0 ? image.height : 'auto',
    display: image.inline ? 'inline' : 'block',
  };

  if (image.caption) {
    const figStyle: React.CSSProperties = { margin: '8px 0', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center' };
    if (image.horzAlign === 'CENTER') figStyle.margin = '8px auto';
    else if (image.horzAlign === 'RIGHT') figStyle.alignItems = 'flex-end';
    const cap = <figcaption style={{ fontSize: '0.85em', color: '#555', marginTop: image.captionSide === 'BOTTOM' ? '4px' : undefined, marginBottom: image.captionSide === 'TOP' ? '4px' : undefined }}>{image.caption}</figcaption>;
    return (
      <figure key={key} style={figStyle}>
        {image.captionSide === 'TOP' && cap}
        <img src={src} alt={image.caption} className="hwpx-inline-image" style={imgStyle} />
        {image.captionSide !== 'TOP' && cap}
      </figure>
    );
  }

  if (!image.inline) {
    imgStyle.margin = image.horzAlign === 'CENTER' ? '8px auto' : image.horzAlign === 'RIGHT' ? '8px 0 8px auto' : '8px 0';
  } else {
    imgStyle.margin = '0 2px';
  }
  return <img key={key} src={src} alt="" className="hwpx-inline-image" style={imgStyle} />;
}

export function renderEquation(eq: EquationElement, key: string) {
  const html = equationScriptToHtml(eq.script);
  const style: React.CSSProperties = {
    display: 'block',
    fontFamily: "'Cambria Math', 'Latin Modern Math', 'STIX Two Math', 'Times New Roman', serif",
    fontStyle: 'italic',
    fontSize: eq.baseUnit ? `${eq.baseUnit / 100}pt` : '11pt',
    textAlign: 'center',
    padding: '8px 0',
    lineHeight: 1.4,
    margin: '4px auto',
  };
  return <div key={key} style={style} title={eq.script} dangerouslySetInnerHTML={{ __html: html }} />;
}

export function renderTextBox(tb: TextBoxElement, key: string) {
  const style: React.CSSProperties = {};
  if (tb.width > 0) style.width = tb.width;
  if (tb.vertAlign === 'BOTTOM') { style.display = 'flex'; style.flexDirection = 'column'; style.justifyContent = 'flex-end'; }
  else if (tb.vertAlign === 'CENTER') { style.display = 'flex'; style.flexDirection = 'column'; style.justifyContent = 'center'; }
  return (
    <div key={key} style={style}>
      {tb.paragraphs.map((p, i) => renderParagraph(p, `${key}-p${i}`))}
    </div>
  );
}

export function renderContentItem(item: ContentItem, key: string, ctx: HwpxRenderContext) {
  switch (item.type) {
    case 'paragraph': return renderParagraph(item.data, key);
    case 'table': return renderTable(item.data, key, ctx);
    case 'image': return renderImage(item.data, key, ctx);
    case 'equation': return renderEquation(item.data, key);
    case 'textBox': return renderTextBox(item.data, key);
  }
}

export function renderFooterHeader(content: ContentItem[] | undefined, key: string, ctx: HwpxRenderContext, pageNum?: number) {
  if (!content || content.length === 0) return null;
  // Replace __PAGE_NUM__ placeholder with actual page number
  const resolvedContent = pageNum !== undefined ? content.map(item => {
    if (item.type !== 'paragraph') return item;
    const hasPlaceholder = item.data.runs.some(r => r.text.includes('__PAGE_NUM__'));
    if (!hasPlaceholder) return item;
    return { ...item, data: { ...item.data, runs: item.data.runs.map(r =>
      r.text.includes('__PAGE_NUM__') ? { ...r, text: r.text.replace('__PAGE_NUM__', String(pageNum)) } : r
    ) } };
  }) : content;
  return (
    <div key={key} style={{ fontSize: '0.85em' }}>
      {resolvedContent.map((item, i) => renderContentItem(item, `${key}-${i}`, ctx))}
    </div>
  );
}
