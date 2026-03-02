// ─── Interfaces ───

export interface PptxViewerProps {
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
  hyperlink?: string;
  letterSpacing?: number; // in pt
}

export interface Paragraph {
  runs: TextRun[];
  align?: 'left' | 'center' | 'right' | 'justify';
  bulletChar?: string;
  level?: number;
  lineHeight?: number;    // percentage (e.g. 120 = 120%)
  lineHeightPt?: number;  // exact points
  spaceBefore?: number;   // px
  spaceAfter?: number;    // px
  marginLeft?: number;    // px
  indent?: number;        // first line indent px
}

export interface TextBodyProps {
  wrap?: 'none' | 'square';
  paddingLeft: number;
  paddingRight: number;
  paddingTop: number;
  paddingBottom: number;
  verticalAlign?: 'top' | 'middle' | 'bottom';
  verticalText?: boolean;
  autoFit?: boolean;
  fontScale?: number;       // 0-1 ratio from a:normAutofit fontScale
  lnSpcReduction?: number;  // 0-1 ratio from a:normAutofit lnSpcReduction
}

export interface CellBorder {
  color: string;
  width: number;
}

export interface TableCell {
  paragraphs: Paragraph[];
  colSpan?: number;
  rowSpan?: number;
  backgroundColor?: string;
  borderColor?: string;
  borders?: {
    left?: CellBorder;
    right?: CellBorder;
    top?: CellBorder;
    bottom?: CellBorder;
  };
  vertAlign?: 'top' | 'middle' | 'bottom';
  noFill?: boolean;
  margins?: { left: number; right: number; top: number; bottom: number };
}

export interface TableRow {
  cells: TableCell[];
  height?: number;
}

export interface TableProps {
  firstRow?: boolean;
  lastRow?: boolean;
  bandRow?: boolean;
  bandCol?: boolean;
  firstCol?: boolean;
  lastCol?: boolean;
  backgroundColor?: string;
  tblStyleId?: string;
}

export interface TableElement {
  type: 'table';
  x: number;
  y: number;
  width: number;
  height: number;
  rows: TableRow[];
  colWidths: number[];
  frameHeight?: number;
  tblProps?: TableProps;
}

export interface ArrowHead {
  type: 'triangle' | 'stealth' | 'oval' | 'diamond' | 'arrow' | 'none';
  w?: 'sm' | 'med' | 'lg';
  len?: 'sm' | 'med' | 'lg';
}

export interface GradientFill {
  type: 'linear' | 'radial';
  angle?: number;
  stops: { position: number; color: string }[];
}

export interface ShadowProps {
  offsetX: number;
  offsetY: number;
  blur: number;
  color: string;
  inset?: boolean;
}

export interface ShapeElement {
  type: 'shape' | 'image' | 'line';
  x: number;
  y: number;
  width: number;
  height: number;
  paragraphs?: Paragraph[];
  imageSrc?: string;
  imageRelId?: string;
  imageCrop?: { left: number; top: number; right: number; bottom: number };
  backgroundColor?: string;
  gradientFill?: GradientFill;
  borderColor?: string;
  borderWidth?: number;
  rotation?: number;
  flipH?: boolean;
  flipV?: boolean;
  shapeType?: string;
  customPath?: string;
  connectorType?: string;
  adjustValues?: Record<string, number>;
  headEnd?: ArrowHead;
  tailEnd?: ArrowHead;
  dashStyle?: string;
  textBody?: TextBodyProps;
  shadow?: ShadowProps;
  duotoneColors?: [string, string]; // [shadowColor, highlightColor]
}

export interface SlideBackground {
  color?: string;
  gradient?: GradientFill;
  imageRelId?: string;
}

export interface GroupShapeElement {
  type: 'group';
  x: number;
  y: number;
  width: number;
  height: number;
  childOffsetX: number;
  childOffsetY: number;
  childExtX: number;
  childExtY: number;
  rotation?: number;
  flipH?: boolean;
  flipV?: boolean;
  children: (ShapeElement | TableElement | GroupShapeElement)[];
}

export type SlideShape = ShapeElement | TableElement | GroupShapeElement;

export interface SlideData {
  shapes: SlideShape[];
  width: number;
  height: number;
  background?: SlideBackground;
  showMasterSp?: boolean;
}

// ─── Theme ───

export type ThemeColors = Record<string, string>;

export interface ThemeFonts {
  majorLatin: string;
  minorLatin: string;
  majorEA: string;
  minorEA: string;
}

export interface ThemeData {
  colors: ThemeColors;
  fonts: ThemeFonts;
}

// ─── Table Styles ───

export interface TableStyleBorder {
  width: number;
  color: string;
}

export interface TableStyleBand {
  fillColor?: string;
  fontColor?: string;
  fontBold?: boolean;
  borders?: {
    left?: TableStyleBorder | null;   // null = noFill (no border)
    right?: TableStyleBorder | null;
    top?: TableStyleBorder | null;
    bottom?: TableStyleBorder | null;
    insideH?: TableStyleBorder | null;
    insideV?: TableStyleBorder | null;
  };
}

export interface TableStyleDef {
  wholeTbl?: TableStyleBand;
  band1H?: TableStyleBand;
  band2H?: TableStyleBand;
  firstRow?: TableStyleBand;
  lastRow?: TableStyleBand;
  firstCol?: TableStyleBand;
  lastCol?: TableStyleBand;
}

export type ShapePathFn = (w: number, h: number, adj?: Record<string, number>) => string;
