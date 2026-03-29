import { createContext } from 'react';

// Measurement data types for 2-pass rendering
export type PageMeasurements = Map<number, Map<number, number>>; // pageIdx → (itemIdx → height)
export type TableRowMeasurements = Map<number, Map<string, number>>; // pageIdx → ("itemIdx:rowIdx" → height)
export type CellParaMeasurements = Map<number, Map<string, number[]>>; // pageIdx → ("itemIdx:rowIdx:cellIdx" → [childHeights])
export type ViewerPhase = 'loading' | 'measuring' | 'ready';

export interface DocxViewerProps {
  data: ArrayBuffer;
}

// Context for passing section-level linePitch (docGrid) to paragraph renderers
export const DocGridContext = createContext<number>(0); // linePitch in px, 0 = no grid

// ==================== Interfaces ====================

export interface TextRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  fontSize?: number;
  fontFamily?: string; // computed from per-range fonts via buildFontFamily()
  // Per-Unicode-range fonts (OOXML model): ascii=U+0000-007F, hAnsi=extended Latin, eastAsia=CJK, cs=complex script
  // These are merged individually via spread, then fontFamily is computed from the merged result.
  asciiFont?: string;
  hAnsiFont?: string;
  eastAsiaFont?: string;
  csFont?: string;
  color?: string;
  backgroundColor?: string;
  superscript?: boolean;
  subscript?: boolean;
  highlight?: string;
  letterSpacing?: number; // px (from w:spacing w:val in rPr, twips converted)
  fontKerning?: boolean; // false = font-kerning:none (from w:kern w:val="0")
}

export interface TabStop {
  position: number; // px from left edge
  alignment: 'left' | 'center' | 'right' | 'decimal';
  leader?: 'dot' | 'hyphen' | 'underscore' | 'none';
}

export interface Paragraph {
  runs: TextRun[];
  align?: 'left' | 'center' | 'right' | 'justify';
  lineHeightType?: 'auto' | 'exact' | 'atLeast';
  lineHeightValue?: number;
  spaceBefore?: number;
  spaceAfter?: number;
  indent?: number;
  hangingIndent?: number;
  marginLeft?: number;
  marginRight?: number;
  bulletChar?: string;
  numberingText?: string;
  numberingIndent?: number;
  outlineLevel?: number;
  pageBreakBefore?: boolean;
  keepNext?: boolean;
  keepLines?: boolean;
  tabStops?: TabStop[];
  snapToGrid?: boolean; // w:snapToGrid — default true, false opts out of docGrid
  contextualSpacing?: boolean; // w:contextualSpacing — suppress spacing between same-style paras
  styleId?: string; // w:pStyle val — needed for contextualSpacing comparison
  numId?: string; // w:numPr > w:numId — numbering definition ID (from style or direct pPr)
  numIlvl?: number; // w:numPr > w:ilvl — numbering indent level
  numberingRunProps?: Partial<TextRun>; // Resolved run props for numbering text (level rPr merged with runDefaults)
  wordBreakAll?: boolean; // w:wordWrap val="0" → word-break: break-all (CJK char-level wrapping)
  effectiveFontSize?: number; // pt — resolved font size from cascade (used for empty paragraph line-height)
}

export interface BorderStyle {
  width: number;
  color: string;
  style: string;
}

export interface TableCell {
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
  vMerge?: 'restart' | 'continue';
}

export interface TableRow {
  cells: TableCell[];
  height?: number;
  isHeader?: boolean;
}

export interface Table {
  rows: TableRow[];
  width?: number;
  widthType?: 'auto' | 'pct' | 'dxa';
  layoutType?: 'fixed' | 'autofit';
  colWidths: number[];
  alignment?: 'left' | 'center' | 'right';
  cellPadding?: { left: number; right: number; top: number; bottom: number };
  defaultBorders?: {
    top?: BorderStyle;
    bottom?: BorderStyle;
    left?: BorderStyle;
    right?: BorderStyle;
    insideH?: BorderStyle;
    insideV?: BorderStyle;
  };
  styleFontSize?: number; // pt — from table style rPr (for CSS inheritance in <td>)
}

export interface DrawingElement {
  type: 'image';
  width: number;
  height: number;
  inline?: boolean;
  imageId?: string;
  imageSrc?: string;
  cropTop?: number;
  cropBottom?: number;
  cropLeft?: number;
  cropRight?: number;
}

export type ContentItem =
  | { type: 'paragraph'; data: Paragraph }
  | { type: 'table'; data: Table }
  | { type: 'drawing'; data: DrawingElement }
  | { type: 'pageBreak'; breakSource?: 'lrpb' | 'explicit' }
  | { type: 'sectionBreak'; sectionProps?: SectionProps };

export interface SectionProps {
  pageWidth: number;
  pageHeight: number;
  marginTop: number;
  marginBottom: number;
  marginLeft: number;
  marginRight: number;
  linePitch?: number; // w:docGrid linePitch in px — controls line spacing grid for CJK
  footerMargin?: number; // w:pgMar w:footer — distance from page bottom to footer in px
  pageNumberStart?: number; // w:pgNumType w:start — restart page numbering at this value
  titlePage?: boolean; // w:titlePg — first page of section has different (often no) footer
  sectionType?: 'nextPage' | 'continuous' | 'evenPage' | 'oddPage'; // w:type val — how section starts
  hasPageNumberInFooter?: boolean; // resolved: default footer has PAGE field
  hasPageNumberInFirstFooter?: boolean; // resolved: first-page footer has PAGE field
}

export interface DocDefaults {
  run: Partial<TextRun>;
  para: Partial<Paragraph>;
  defaultParaStyleId?: string; // Default paragraph style ID (e.g., "s0", "Normal") — used to avoid double-applying it
}

export interface StyleDef {
  name: string;
  basedOn?: string;
  paragraph?: Partial<Paragraph>;
  run?: Partial<TextRun>;
}

export interface ResolvedStyle {
  paragraph?: Partial<Paragraph>;
  run?: Partial<TextRun>;
}

export interface NumberingLevel {
  format: string;
  text: string;
  indent: number;
  hanging: number;
  pStyle?: string; // w:pStyle — style linked to this numbering level
  start?: number;  // w:start — starting number for this level
  runProps?: Partial<TextRun>; // w:lvl > w:rPr — direct formatting for numbering text
}

export interface NumberingDef {
  levels: Map<number, NumberingLevel>;
  abstractNumId: string; // for counter tracking — Word tracks counters by abstractNum, not numId
}

// Reverse lookup: paragraph style → numbering definition (for style-linked numbering)
// When numbering.xml defines <w:pStyle val="Heading1"/> in a level, any paragraph with
// that style automatically gets numbering, even without explicit w:numPr.
export type StyleNumMap = Map<string, { numId: string; ilvl: number }>;

export interface PageContent {
  items: ContentItem[];
  pageNumber: number;
  section: SectionProps;
  isFirstInSection?: boolean;
  hasSkippedLRPB?: boolean;
  measuredContentHeight?: number; // Actual measured content height from split processing
}

export interface DocumentData {
  content: ContentItem[];
  sections: SectionProps[];
  defaultSection: SectionProps;
  styles: Map<string, StyleDef>;
  resolvedStyles: Map<string, ResolvedStyle>;
  numbering: Map<string, NumberingDef>;
  images: Map<string, string>;
  docDefaults: DocDefaults;
  defaultParaResolvedStyle: ResolvedStyle | null; // resolved default paragraph style (e.g. "Normal")
  hasFooterPageNumber: boolean; // true if any footer contains a PAGE field
  pageNumberStart: number; // starting page number (from w:pgNumType)
}

// Table style borders (from w:style w:type="table" > w:tblPr > w:tblBorders)
export type TableStyleBorders = {
  top?: BorderStyle; bottom?: BorderStyle; left?: BorderStyle; right?: BorderStyle;
  insideH?: BorderStyle; insideV?: BorderStyle;
} | undefined;
export type TableStyleMap = Map<string, { borders?: TableStyleBorders; basedOn?: string }>;
