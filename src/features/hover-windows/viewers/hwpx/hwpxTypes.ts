// ==================== Interfaces ====================

export interface HwpxViewerProps {
  data: ArrayBuffer;
}

export interface TextRun {
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
  isTab?: boolean;
  tabLeader?: string;
  tabWidth?: number;
  equationHtml?: string;
  letterSpacing?: number;  // 자간 (% of font size)
  charRatio?: number;      // 장평 (character width %)
}

export interface TabStop {
  pos: number;
  type: 'LEFT' | 'RIGHT' | 'CENTER';
  leader: string;
}

export interface Paragraph {
  runs: TextRun[];
  align?: 'left' | 'center' | 'right' | 'justify' | 'distribute';
  lineHeight?: number | string;
  marginTop?: number;
  marginBottom?: number;
  indent?: number;
  marginLeft?: number;
  isHeading?: boolean;
  headingLevel?: number;
  bulletChar?: string;
  numberingText?: string;
  numberingStyle?: Partial<TextRun>;
  tabStops?: TabStop[];
  pageBreakBefore?: boolean;
}

export interface BorderStyle {
  width?: number;
  color?: string;
  type?: string;
}

export interface TableCell {
  content: ContentItem[];
  colSpan: number;
  rowSpan: number;
  colAddr: number;
  rowAddr: number;
  width: number;
  height: number;
  backgroundColor?: string;
  backgroundImgRef?: string;
  borderTop?: BorderStyle;
  borderBottom?: BorderStyle;
  borderLeft?: BorderStyle;
  borderRight?: BorderStyle;
  vertAlign?: 'top' | 'middle' | 'bottom';
}

export interface TableRow {
  cells: TableCell[];
  height?: number;
}

export interface Table {
  rows: TableRow[];
  width?: number;
  colWidths: number[];
  rowCnt: number;
  colCnt: number;
  caption?: string;
  captionSide?: 'TOP' | 'BOTTOM';
}

export interface ImageElement {
  id: string;
  width: number;
  height: number;
  inline?: boolean;
  src?: string;
  caption?: string;
  captionSide?: 'TOP' | 'BOTTOM';
  horzAlign?: string;
  orgWidth?: number;
  orgHeight?: number;
  imgClip?: { left: number; right: number; top: number; bottom: number };
  imgDimWidth?: number;
  imgDimHeight?: number;
  textWrap?: string;
  vertOffset?: number;
  horzOffset?: number;
  zOrder?: number;
}

export interface EquationElement {
  script: string;
  width: number;
  height: number;
  baseLine?: number;
  baseUnit?: number;
  inline?: boolean;
}

export interface TextBoxElement {
  paragraphs: Paragraph[];
  width: number;
  height: number;
  textWrap?: string;
  vertOffset?: number;
  horzOffset?: number;
  vertRelTo?: string;
  zOrder?: number;
  vertAlign?: string;
}

export interface FootnoteData {
  number: number;
  content: ContentItem[];
  marker?: string;
  pageIndex?: number;
}

export type ContentItem =
  | { type: 'paragraph'; data: Paragraph; pageIndex?: number }
  | { type: 'table'; data: Table; pageIndex?: number }
  | { type: 'image'; data: ImageElement; pageIndex?: number }
  | { type: 'equation'; data: EquationElement; pageIndex?: number }
  | { type: 'textBox'; data: TextBoxElement; pageIndex?: number };

export interface Section {
  content: ContentItem[];
  pageWidth?: number;
  pageHeight?: number;
  marginLeft?: number;
  marginRight?: number;
  marginTop?: number;
  marginBottom?: number;
  headerMargin?: number;
  footerMargin?: number;
  pageNumPos?: string;
  pageNumSideChar?: string;
  pageNumHidden?: boolean;
  pageStartNo?: number;
  pageNumResets?: Map<number, number>; // pageIndex → new start number (from newNum PAGE)
  hiddenPageNumPages?: Set<number>;
  footerContent?: ContentItem[];
  headerContent?: ContentItem[];
  footnotes?: FootnoteData[];
}

// ==================== Header Style Definitions ====================

export interface CharPropDef {
  height: number;
  textColor: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strikethrough: boolean;
  superscript: boolean;
  subscript: boolean;
  hangulFontId: number;
  latinFontId: number;
  spacing?: number;  // 자간 (% of font size, e.g., -5 = tighter)
  ratio?: number;    // 장평 (character width %, e.g., 80 = narrower)
}

export interface NumberingLevelDef {
  format: string;
  numFormat: string;
  textOffset: number;
  start: number;
  charPrIDRef?: number;
}

export interface NumberingDef {
  start: number;
  levels: Map<number, NumberingLevelDef>;
}

export interface BulletDef {
  char: string;
}

export interface ParaPropDef {
  align: 'left' | 'center' | 'right' | 'justify' | 'distribute';
  lineSpacingType: string;
  lineSpacingValue: number;
  indent: number;
  marginLeft: number;
  marginRight: number;
  marginTop: number;
  marginBottom: number;
  headingType?: string;
  headingIdRef?: number;
  headingLevel?: number;
  tabStops?: TabStop[];
  pageBreakBefore?: boolean;
}

export interface BorderFillDef {
  leftBorder: BorderStyle;
  rightBorder: BorderStyle;
  topBorder: BorderStyle;
  bottomBorder: BorderStyle;
  fillColor?: string;
  imgRef?: string;
}

export interface HeaderData {
  charProps: Map<number, CharPropDef>;
  paraProps: Map<number, ParaPropDef>;
  hangulFonts: Map<number, string>;
  latinFonts: Map<number, string>;
  borderFills: Map<number, BorderFillDef>;
  numberings: Map<number, NumberingDef>;
  bullets: Map<number, BulletDef>;
  tabDefs: Map<number, TabStop[]>;
}

/** Auto-numbering counters for PICTURE, TABLE, EQUATION */
export interface AutoNumCounters {
  PICTURE: number;
  TABLE: number;
  EQUATION: number;
  PAGE: number;
  [key: string]: number;
}
