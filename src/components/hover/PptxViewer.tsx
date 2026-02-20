import { useState, useEffect, useCallback, useRef } from 'react';
import JSZip from 'jszip';
import { ChevronLeft, ChevronRight } from 'lucide-react';

interface PptxViewerProps {
  data: ArrayBuffer;
}

// EMU (English Metric Units) conversion: 914400 EMU = 1 inch = 96 CSS pixels
const EMU_PER_PIXEL = 914400 / 96;

interface TextRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  fontSize?: number; // in points
  fontFamily?: string;
  color?: string;
}

interface Paragraph {
  runs: TextRun[];
  align?: 'left' | 'center' | 'right' | 'justify';
  bulletChar?: string;
  level?: number;
}

interface TableCell {
  paragraphs: Paragraph[];
  colSpan?: number;
  rowSpan?: number;
  backgroundColor?: string;
  borderColor?: string;
}

interface TableRow {
  cells: TableCell[];
  height?: number;
}

interface TableElement {
  type: 'table';
  x: number;
  y: number;
  width: number;
  height: number;
  rows: TableRow[];
  colWidths: number[];
}

interface ShapeElement {
  type: 'shape' | 'image' | 'line';
  x: number; // in pixels
  y: number;
  width: number;
  height: number;
  paragraphs?: Paragraph[];
  imageSrc?: string;
  imageRelId?: string;
  backgroundColor?: string;
  gradientFill?: GradientFill;
  borderColor?: string;
  borderWidth?: number;
  rotation?: number;
  flipH?: boolean;
  flipV?: boolean;
}

interface GradientFill {
  type: 'linear' | 'radial';
  angle?: number;
  stops: { position: number; color: string }[];
}

interface SlideBackground {
  color?: string;
  gradient?: GradientFill;
  imageRelId?: string;
}

interface SlideData {
  shapes: (ShapeElement | TableElement)[];
  width: number;
  height: number;
  background?: SlideBackground;
}

// Parse color from OOXML (handles srgbClr, schemeClr)
function parseColor(colorNode: Element | null): string | undefined {
  if (!colorNode) return undefined;

  const srgb = colorNode.getElementsByTagName('a:srgbClr')[0];
  if (srgb) {
    const val = srgb.getAttribute('val');
    // Handle alpha/transparency
    const alpha = srgb.getElementsByTagName('a:alpha')[0];
    if (alpha) {
      const alphaVal = parseInt(alpha.getAttribute('val') || '100000') / 100000;
      const r = parseInt(val!.substring(0, 2), 16);
      const g = parseInt(val!.substring(2, 4), 16);
      const b = parseInt(val!.substring(4, 6), 16);
      return `rgba(${r}, ${g}, ${b}, ${alphaVal})`;
    }
    return '#' + val;
  }

  // For scheme colors, use defaults
  const scheme = colorNode.getElementsByTagName('a:schemeClr')[0];
  if (scheme) {
    const val = scheme.getAttribute('val');
    const schemeColors: Record<string, string> = {
      'tx1': '#000000', 'tx2': '#44546A', 'bg1': '#FFFFFF', 'bg2': '#E7E6E6',
      'accent1': '#4472C4', 'accent2': '#ED7D31', 'accent3': '#A5A5A5',
      'accent4': '#FFC000', 'accent5': '#5B9BD5', 'accent6': '#70AD47',
      'dk1': '#000000', 'dk2': '#44546A', 'lt1': '#FFFFFF', 'lt2': '#E7E6E6',
      'hlink': '#0563C1', 'folHlink': '#954F72',
    };
    return schemeColors[val || ''] || undefined;
  }

  return undefined;
}

// Parse gradient fill
function parseGradientFill(gradFill: Element): GradientFill | undefined {
  const stops: { position: number; color: string }[] = [];
  const gsLst = gradFill.getElementsByTagName('a:gsLst')[0];

  if (gsLst) {
    const gsElements = gsLst.getElementsByTagName('a:gs');
    for (let i = 0; i < gsElements.length; i++) {
      const gs = gsElements[i];
      const pos = parseInt(gs.getAttribute('pos') || '0') / 1000; // Convert to percentage
      const color = parseColor(gs);
      if (color) {
        stops.push({ position: pos, color });
      }
    }
  }

  if (stops.length === 0) return undefined;

  // Determine gradient type and angle
  const lin = gradFill.getElementsByTagName('a:lin')[0];
  if (lin) {
    const ang = parseInt(lin.getAttribute('ang') || '0') / 60000; // Convert from 60000ths of a degree
    return { type: 'linear', angle: ang, stops };
  }

  const path = gradFill.getElementsByTagName('a:path')[0];
  if (path && path.getAttribute('path') === 'circle') {
    return { type: 'radial', stops };
  }

  return { type: 'linear', angle: 0, stops };
}

// Convert gradient to CSS
function gradientToCSS(gradient: GradientFill): string {
  const colorStops = gradient.stops
    .sort((a, b) => a.position - b.position)
    .map(s => `${s.color} ${s.position}%`)
    .join(', ');

  if (gradient.type === 'radial') {
    return `radial-gradient(circle, ${colorStops})`;
  }

  const angle = gradient.angle || 0;
  return `linear-gradient(${90 - angle}deg, ${colorStops})`;
}

// Parse text run properties
function parseRunProperties(rPr: Element | null): Partial<TextRun> {
  if (!rPr) return {};

  const props: Partial<TextRun> = {};

  // Bold
  const bold = rPr.getAttribute('b');
  if (bold === '1' || bold === 'true') props.bold = true;

  // Italic
  const italic = rPr.getAttribute('i');
  if (italic === '1' || italic === 'true') props.italic = true;

  // Underline
  const underline = rPr.getAttribute('u');
  if (underline && underline !== 'none') props.underline = true;

  // Font size (in hundredths of a point)
  const sz = rPr.getAttribute('sz');
  if (sz) props.fontSize = parseInt(sz) / 100;

  // Font family
  const latin = rPr.getElementsByTagName('a:latin')[0];
  const ea = rPr.getElementsByTagName('a:ea')[0]; // East Asian font
  if (latin) {
    props.fontFamily = latin.getAttribute('typeface') || undefined;
  } else if (ea) {
    props.fontFamily = ea.getAttribute('typeface') || undefined;
  }

  // Color
  const solidFill = rPr.getElementsByTagName('a:solidFill')[0];
  if (solidFill) {
    props.color = parseColor(solidFill);
  }

  return props;
}

// Parse paragraph properties
function parseParagraphAlign(pPr: Element | null): Paragraph['align'] {
  if (!pPr) return undefined;
  const algn = pPr.getAttribute('algn');
  switch (algn) {
    case 'l': return 'left';
    case 'ctr': return 'center';
    case 'r': return 'right';
    case 'just': return 'justify';
    default: return undefined;
  }
}

// Parse bullet/numbering
function parseBullet(pPr: Element | null): { bulletChar?: string; level?: number } {
  if (!pPr) return {};

  const level = parseInt(pPr.getAttribute('lvl') || '0');
  const buChar = pPr.getElementsByTagName('a:buChar')[0];
  const buAutoNum = pPr.getElementsByTagName('a:buAutoNum')[0];
  const buNone = pPr.getElementsByTagName('a:buNone')[0];

  if (buNone) return { level };
  if (buChar) return { bulletChar: buChar.getAttribute('char') || '•', level };
  if (buAutoNum) return { bulletChar: '1.', level }; // Simplified

  return { level };
}

// Parse a text body (txBody) element
function parseTextBody(txBody: Element): Paragraph[] {
  const paragraphs: Paragraph[] = [];
  const pElements = txBody.getElementsByTagName('a:p');

  for (let i = 0; i < pElements.length; i++) {
    const p = pElements[i];
    // Skip if this p is nested inside another p (happens with sub-elements)
    if (p.parentElement?.tagName !== 'p:txBody' && p.parentElement?.tagName !== 'a:txBody') {
      continue;
    }

    const runs: TextRun[] = [];
    const pPr = p.getElementsByTagName('a:pPr')[0];
    const align = parseParagraphAlign(pPr);
    const bullet = parseBullet(pPr);

    // Default paragraph run properties
    const defRPr = pPr?.getElementsByTagName('a:defRPr')[0];
    const defaultProps = parseRunProperties(defRPr);

    // Parse text runs
    const rElements = p.getElementsByTagName('a:r');
    for (let j = 0; j < rElements.length; j++) {
      const r = rElements[j];
      const rPr = r.getElementsByTagName('a:rPr')[0];
      const t = r.getElementsByTagName('a:t')[0];

      if (t && t.textContent) {
        const runProps = parseRunProperties(rPr);
        runs.push({
          text: t.textContent,
          ...defaultProps,
          ...runProps,
        });
      }
    }

    // Also check for field text (a:fld)
    const fldElements = p.getElementsByTagName('a:fld');
    for (let j = 0; j < fldElements.length; j++) {
      const fld = fldElements[j];
      const t = fld.getElementsByTagName('a:t')[0];
      if (t && t.textContent) {
        runs.push({ text: t.textContent, ...defaultProps });
      }
    }

    if (runs.length > 0) {
      paragraphs.push({ runs, align, bulletChar: bullet.bulletChar, level: bullet.level });
    }
  }

  return paragraphs;
}

// Parse table element (a:tbl)
function parseTable(graphicData: Element): TableElement | null {
  const tbl = graphicData.getElementsByTagName('a:tbl')[0];
  if (!tbl) return null;

  // Get table grid columns
  const tblGrid = tbl.getElementsByTagName('a:tblGrid')[0];
  const colWidths: number[] = [];
  if (tblGrid) {
    const gridCols = tblGrid.getElementsByTagName('a:gridCol');
    for (let i = 0; i < gridCols.length; i++) {
      const w = parseInt(gridCols[i].getAttribute('w') || '0') / EMU_PER_PIXEL;
      colWidths.push(w);
    }
  }

  // Parse rows
  const rows: TableRow[] = [];
  const trElements = tbl.getElementsByTagName('a:tr');
  for (let i = 0; i < trElements.length; i++) {
    const tr = trElements[i];
    const rowHeight = parseInt(tr.getAttribute('h') || '0') / EMU_PER_PIXEL;
    const cells: TableCell[] = [];

    const tcElements = tr.getElementsByTagName('a:tc');
    for (let j = 0; j < tcElements.length; j++) {
      const tc = tcElements[j];
      const txBody = tc.getElementsByTagName('a:txBody')[0];
      const paragraphs = txBody ? parseTextBody(txBody) : [];

      // Cell properties
      const tcPr = tc.getElementsByTagName('a:tcPr')[0];
      let backgroundColor: string | undefined;
      let borderColor: string | undefined;

      if (tcPr) {
        const solidFill = tcPr.getElementsByTagName('a:solidFill')[0];
        if (solidFill) {
          backgroundColor = parseColor(solidFill);
        }

        // Parse border
        const lnL = tcPr.getElementsByTagName('a:lnL')[0];
        if (lnL) {
          const borderFill = lnL.getElementsByTagName('a:solidFill')[0];
          if (borderFill) {
            borderColor = parseColor(borderFill);
          }
        }
      }

      const gridSpan = parseInt(tc.getAttribute('gridSpan') || '1');
      const rowSpan = parseInt(tc.getAttribute('rowSpan') || '1');

      cells.push({
        paragraphs,
        colSpan: gridSpan > 1 ? gridSpan : undefined,
        rowSpan: rowSpan > 1 ? rowSpan : undefined,
        backgroundColor,
        borderColor,
      });
    }

    rows.push({ cells, height: rowHeight > 0 ? rowHeight : undefined });
  }

  // Calculate total dimensions
  const totalWidth = colWidths.reduce((a, b) => a + b, 0);
  const totalHeight = rows.reduce((sum, r) => sum + (r.height || 30), 0);

  return {
    type: 'table',
    x: 0,
    y: 0,
    width: totalWidth,
    height: totalHeight,
    rows,
    colWidths,
  };
}

// Parse slide background
function parseSlideBackground(spTree: Element): SlideBackground | undefined {
  // Check for bg element
  const bg = spTree.ownerDocument?.getElementsByTagName('p:bg')[0];
  if (!bg) return undefined;

  const bgPr = bg.getElementsByTagName('p:bgPr')[0];
  if (bgPr) {
    // Solid fill
    const solidFill = bgPr.getElementsByTagName('a:solidFill')[0];
    if (solidFill) {
      return { color: parseColor(solidFill) };
    }

    // Gradient fill
    const gradFill = bgPr.getElementsByTagName('a:gradFill')[0];
    if (gradFill) {
      return { gradient: parseGradientFill(gradFill) };
    }

    // Background image
    const blipFill = bgPr.getElementsByTagName('a:blipFill')[0];
    if (blipFill) {
      const blip = blipFill.getElementsByTagName('a:blip')[0];
      const relId = blip?.getAttribute('r:embed');
      if (relId) {
        return { imageRelId: relId };
      }
    }
  }

  return undefined;
}

// Parse shape transform (position and size)
function parseTransform(spPr: Element): { x: number; y: number; width: number; height: number; rotation?: number } | null {
  const xfrm = spPr.getElementsByTagName('a:xfrm')[0];
  if (!xfrm) return null;

  const off = xfrm.getElementsByTagName('a:off')[0];
  const ext = xfrm.getElementsByTagName('a:ext')[0];

  if (!off || !ext) return null;

  const x = parseInt(off.getAttribute('x') || '0') / EMU_PER_PIXEL;
  const y = parseInt(off.getAttribute('y') || '0') / EMU_PER_PIXEL;
  const width = parseInt(ext.getAttribute('cx') || '0') / EMU_PER_PIXEL;
  const height = parseInt(ext.getAttribute('cy') || '0') / EMU_PER_PIXEL;

  const rot = xfrm.getAttribute('rot');
  const rotation = rot ? parseInt(rot) / 60000 : undefined; // Convert from 60000ths of a degree

  return { x, y, width, height, rotation };
}

// Parse a single slide XML
function parseSlideXml(xmlString: string, defaultWidth: number, defaultHeight: number): SlideData {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlString, 'application/xml');
  const shapes: (ShapeElement | TableElement)[] = [];

  const spTree = doc.getElementsByTagName('p:spTree')[0];
  const background = spTree ? parseSlideBackground(spTree) : undefined;

  // Parse shapes (p:sp)
  const spElements = doc.getElementsByTagName('p:sp');
  for (let i = 0; i < spElements.length; i++) {
    const sp = spElements[i];
    const spPr = sp.getElementsByTagName('p:spPr')[0];
    const txBody = sp.getElementsByTagName('p:txBody')[0];

    if (spPr) {
      const transform = parseTransform(spPr);
      if (transform) {
        const shape: ShapeElement = {
          type: 'shape',
          ...transform,
        };

        // Parse background fill (solid or gradient)
        const solidFill = spPr.getElementsByTagName('a:solidFill')[0];
        if (solidFill) {
          shape.backgroundColor = parseColor(solidFill);
        }

        const gradFill = spPr.getElementsByTagName('a:gradFill')[0];
        if (gradFill) {
          shape.gradientFill = parseGradientFill(gradFill);
        }

        // Parse border/outline
        const ln = spPr.getElementsByTagName('a:ln')[0];
        if (ln) {
          const lnWidth = parseInt(ln.getAttribute('w') || '0') / EMU_PER_PIXEL;
          if (lnWidth > 0) {
            shape.borderWidth = lnWidth;
            const lnFill = ln.getElementsByTagName('a:solidFill')[0];
            if (lnFill) {
              shape.borderColor = parseColor(lnFill);
            }
          }
        }

        // Parse text content
        if (txBody) {
          shape.paragraphs = parseTextBody(txBody);
        }

        // Include shapes with content OR with visible styling
        if ((shape.paragraphs && shape.paragraphs.length > 0) ||
            shape.backgroundColor || shape.gradientFill || shape.borderColor) {
          shapes.push(shape);
        }
      }
    }
  }

  // Parse pictures (p:pic)
  const picElements = doc.getElementsByTagName('p:pic');
  for (let i = 0; i < picElements.length; i++) {
    const pic = picElements[i];
    const spPr = pic.getElementsByTagName('p:spPr')[0];
    const blipFill = pic.getElementsByTagName('p:blipFill')[0];

    if (spPr && blipFill) {
      const transform = parseTransform(spPr);
      const blip = blipFill.getElementsByTagName('a:blip')[0];
      const relId = blip?.getAttribute('r:embed');

      if (transform && relId) {
        shapes.push({
          type: 'image',
          ...transform,
          imageRelId: relId,
        });
      }
    }
  }

  // Parse tables (p:graphicFrame containing a:tbl)
  const graphicFrames = doc.getElementsByTagName('p:graphicFrame');
  for (let i = 0; i < graphicFrames.length; i++) {
    const gf = graphicFrames[i];
    const xfrm = gf.getElementsByTagName('p:xfrm')[0];
    const graphicData = gf.getElementsByTagName('a:graphicData')[0];

    if (xfrm && graphicData) {
      const table = parseTable(graphicData);
      if (table) {
        // Get position from graphicFrame transform
        const off = xfrm.getElementsByTagName('a:off')[0];
        if (off) {
          table.x = parseInt(off.getAttribute('x') || '0') / EMU_PER_PIXEL;
          table.y = parseInt(off.getAttribute('y') || '0') / EMU_PER_PIXEL;
        }
        shapes.push(table);
      }
    }
  }

  // Parse connectors/lines (p:cxnSp)
  const cxnSpElements = doc.getElementsByTagName('p:cxnSp');
  for (let i = 0; i < cxnSpElements.length; i++) {
    const cxn = cxnSpElements[i];
    const spPr = cxn.getElementsByTagName('p:spPr')[0];

    if (spPr) {
      const transform = parseTransform(spPr);
      if (transform) {
        const ln = spPr.getElementsByTagName('a:ln')[0];
        let borderColor = '#000000';
        let borderWidth = 1;

        if (ln) {
          borderWidth = parseInt(ln.getAttribute('w') || '12700') / EMU_PER_PIXEL;
          const lnFill = ln.getElementsByTagName('a:solidFill')[0];
          if (lnFill) {
            borderColor = parseColor(lnFill) || '#000000';
          }
        }

        shapes.push({
          type: 'line',
          ...transform,
          borderColor,
          borderWidth,
        });
      }
    }
  }

  // Sort shapes by their position (top to bottom, left to right)
  shapes.sort((a, b) => a.y - b.y || a.x - b.x);

  return { shapes, width: defaultWidth, height: defaultHeight, background };
}

// Parse slide relationships to get image paths
function parseRelsXml(xmlString: string): Map<string, string> {
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

// Parse presentation.xml for slide dimensions
function parsePresentationXml(xmlString: string): { width: number; height: number } {
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

  // Default 16:9 slide size
  return { width: 960, height: 540 };
}

export function PptxViewer({ data }: PptxViewerProps) {
  const [slides, setSlides] = useState<SlideData[]>([]);
  const [slideImages, setSlideImages] = useState<Map<number, Map<string, string>>>(new Map());
  const [currentSlide, setCurrentSlide] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [zoom, setZoom] = useState(1);
  const [slideSize, setSlideSize] = useState({ width: 960, height: 540 });
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const loadPptx = async () => {
      try {
        setLoading(true);
        setError(null);

        const zip = await JSZip.loadAsync(data);
        const slideContents: SlideData[] = [];
        const allSlideImages = new Map<number, Map<string, string>>();

        // Parse presentation.xml for slide size
        const presentationXml = await zip.file('ppt/presentation.xml')?.async('string');
        let defaultSize = { width: 960, height: 540 };
        if (presentationXml) {
          defaultSize = parsePresentationXml(presentationXml);
          setSlideSize(defaultSize);
        }

        // Find all slide files
        const slideFiles: string[] = [];
        zip.forEach((path) => {
          if (path.match(/^ppt\/slides\/slide\d+\.xml$/)) {
            slideFiles.push(path);
          }
        });

        // Sort slides by number
        slideFiles.sort((a, b) => {
          const numA = parseInt(a.match(/slide(\d+)/)?.[1] || '0');
          const numB = parseInt(b.match(/slide(\d+)/)?.[1] || '0');
          return numA - numB;
        });

        // Parse each slide
        for (let i = 0; i < slideFiles.length; i++) {
          const slidePath = slideFiles[i];
          const slideXml = await zip.file(slidePath)?.async('string');
          if (slideXml) {
            const content = parseSlideXml(slideXml, defaultSize.width, defaultSize.height);
            slideContents.push(content);

            // Parse slide relationships for images
            const slideNum = slidePath.match(/slide(\d+)/)?.[1];
            const relsPath = `ppt/slides/_rels/slide${slideNum}.xml.rels`;
            const relsXml = await zip.file(relsPath)?.async('string');

            if (relsXml) {
              const rels = parseRelsXml(relsXml);
              const imageMap = new Map<string, string>();

              // Load images
              for (const [id, target] of rels) {
                if (target.includes('media/')) {
                  const imagePath = `ppt/slides/${target}`.replace('../', '');
                  const normalizedPath = imagePath.replace(/\/+/g, '/');
                  const imageFile = zip.file(normalizedPath) || zip.file(`ppt/${target.replace('../', '')}`);

                  if (imageFile) {
                    const imageData = await imageFile.async('base64');
                    const ext = target.split('.').pop()?.toLowerCase() || 'png';
                    const mimeType = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' :
                                    ext === 'png' ? 'image/png' :
                                    ext === 'gif' ? 'image/gif' : 'image/png';
                    imageMap.set(id, `data:${mimeType};base64,${imageData}`);
                  }
                }
              }

              allSlideImages.set(i, imageMap);
            }
          }
        }

        setSlides(slideContents);
        setSlideImages(allSlideImages);
        setLoading(false);
      } catch (err) {
        console.error('[PptxViewer] Parse failed:', err);
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      }
    };

    loadPptx();
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

  const goToPrevSlide = () => setCurrentSlide(prev => Math.max(0, prev - 1));
  const goToNextSlide = () => setCurrentSlide(prev => Math.min(slides.length - 1, prev + 1));

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') goToPrevSlide();
      if (e.key === 'ArrowRight') goToNextSlide();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [slides.length]);

  if (loading) {
    return (
      <div className="office-viewer-container pptx-viewer">
        <div className="pptx-loading">슬라이드 로딩 중...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="office-viewer-container pptx-viewer">
        <div className="office-viewer-error">PPTX 파싱 실패: {error}</div>
      </div>
    );
  }

  if (slides.length === 0) {
    return (
      <div className="office-viewer-container pptx-viewer">
        <div className="office-viewer-error">슬라이드를 찾을 수 없습니다.</div>
      </div>
    );
  }

  const currentContent = slides[currentSlide];
  const currentImages = slideImages.get(currentSlide) || new Map();

  // Render a text run with styling
  const renderTextRun = (run: TextRun, index: number) => {
    const style: React.CSSProperties = {};
    if (run.bold) style.fontWeight = 'bold';
    if (run.italic) style.fontStyle = 'italic';
    if (run.underline) style.textDecoration = 'underline';
    if (run.fontSize) style.fontSize = `${run.fontSize}pt`;
    if (run.fontFamily) style.fontFamily = run.fontFamily;
    if (run.color) style.color = run.color;

    return <span key={index} style={style}>{run.text}</span>;
  };

  // Render a paragraph with optional bullet
  const renderParagraph = (para: Paragraph, index: number, inTable = false) => {
    const style: React.CSSProperties = {
      margin: inTable ? '2px 0' : '4px 0',
      textAlign: para.align || 'left',
      paddingLeft: para.level ? para.level * 20 : 0,
    };

    return (
      <p key={index} style={style}>
        {para.bulletChar && <span style={{ marginRight: 8 }}>{para.bulletChar}</span>}
        {para.runs.map((run, i) => renderTextRun(run, i))}
      </p>
    );
  };

  // Render a table element
  const renderTable = (table: TableElement, index: number) => {
    return (
      <table
        key={index}
        className="pptx-table"
        style={{
          position: 'absolute',
          left: table.x,
          top: table.y,
          width: table.width,
          borderCollapse: 'collapse',
          tableLayout: 'fixed',
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
                    backgroundColor: cell.backgroundColor,
                    border: `1px solid ${cell.borderColor || '#ccc'}`,
                    padding: '4px 8px',
                    verticalAlign: 'middle',
                  }}
                >
                  {cell.paragraphs.map((para, paraIdx) => renderParagraph(para, paraIdx, true))}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    );
  };

  // Render a shape element
  const renderShape = (shape: ShapeElement | TableElement, index: number) => {
    // Handle table
    if (shape.type === 'table') {
      return renderTable(shape as TableElement, index);
    }

    const shapeElement = shape as ShapeElement;

    // Handle image
    if (shapeElement.type === 'image') {
      const imageSrc = shapeElement.imageRelId ? currentImages.get(shapeElement.imageRelId) : undefined;
      if (!imageSrc) return null;

      return (
        <img
          key={index}
          src={imageSrc}
          alt=""
          style={{
            position: 'absolute',
            left: shapeElement.x,
            top: shapeElement.y,
            width: shapeElement.width,
            height: shapeElement.height,
            objectFit: 'contain',
            transform: shapeElement.rotation ? `rotate(${shapeElement.rotation}deg)` : undefined,
          }}
        />
      );
    }

    // Handle line/connector
    if (shapeElement.type === 'line') {
      return (
        <div
          key={index}
          style={{
            position: 'absolute',
            left: shapeElement.x,
            top: shapeElement.y,
            width: shapeElement.width || 2,
            height: shapeElement.height || 2,
            backgroundColor: shapeElement.borderColor || '#000',
            transform: shapeElement.rotation ? `rotate(${shapeElement.rotation}deg)` : undefined,
            transformOrigin: 'top left',
          }}
        />
      );
    }

    // Text shape with optional background
    const bgStyle: React.CSSProperties = {};
    if (shapeElement.gradientFill) {
      bgStyle.background = gradientToCSS(shapeElement.gradientFill);
    } else if (shapeElement.backgroundColor) {
      bgStyle.backgroundColor = shapeElement.backgroundColor;
    }

    if (shapeElement.borderColor && shapeElement.borderWidth) {
      bgStyle.border = `${shapeElement.borderWidth}px solid ${shapeElement.borderColor}`;
    }

    return (
      <div
        key={index}
        className="pptx-shape"
        style={{
          position: 'absolute',
          left: shapeElement.x,
          top: shapeElement.y,
          width: shapeElement.width,
          height: shapeElement.height,
          ...bgStyle,
          transform: shapeElement.rotation ? `rotate(${shapeElement.rotation}deg)` : undefined,
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          padding: '8px',
          boxSizing: 'border-box',
        }}
      >
        {shapeElement.paragraphs?.map((para, i) => renderParagraph(para, i))}
      </div>
    );
  };

  // Get slide background style
  const getSlideBackgroundStyle = (): React.CSSProperties => {
    const bg = currentContent.background;
    if (!bg) return { backgroundColor: '#ffffff' };

    if (bg.gradient) {
      return { background: gradientToCSS(bg.gradient) };
    }

    if (bg.imageRelId) {
      const imageSrc = currentImages.get(bg.imageRelId);
      if (imageSrc) {
        return {
          backgroundImage: `url(${imageSrc})`,
          backgroundSize: 'cover',
          backgroundPosition: 'center',
        };
      }
    }

    return { backgroundColor: bg.color || '#ffffff' };
  };

  return (
    <div ref={containerRef} className="office-viewer-container pptx-viewer">
      <div className="pptx-toolbar">
        <button
          className="pptx-nav-btn"
          onClick={goToPrevSlide}
          disabled={currentSlide === 0}
        >
          <ChevronLeft size={20} />
        </button>
        <span className="pptx-slide-indicator">
          {currentSlide + 1} / {slides.length}
        </span>
        <button
          className="pptx-nav-btn"
          onClick={goToNextSlide}
          disabled={currentSlide === slides.length - 1}
        >
          <ChevronRight size={20} />
        </button>
        <span className="pptx-zoom-indicator">{Math.round(zoom * 100)}%</span>
      </div>

      <div className="pptx-slide-container">
        <div
          className="pptx-slide"
          style={{
            width: slideSize.width,
            height: slideSize.height,
            transform: `scale(${zoom})`,
            transformOrigin: 'top center',
            position: 'relative',
            ...getSlideBackgroundStyle(),
          }}
        >
          {currentContent.shapes.map((shape, idx) => renderShape(shape, idx))}
        </div>
      </div>
    </div>
  );
}

export default PptxViewer;
