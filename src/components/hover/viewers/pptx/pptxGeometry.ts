import type { GradientFill, ThemeColors, ShapePathFn } from './pptxTypes';
import { parseColor } from './pptxColor';
import { EMU_PER_PIXEL } from '../shared/viewerConstants';

// ─── Gradient ───

export function parseGradientFill(gradFill: Element, themeColors?: ThemeColors): GradientFill | undefined {
  const stops: { position: number; color: string }[] = [];
  const gsLst = gradFill.getElementsByTagName('a:gsLst')[0];

  if (gsLst) {
    const gsElements = gsLst.getElementsByTagName('a:gs');
    for (let i = 0; i < gsElements.length; i++) {
      const gs = gsElements[i];
      const pos = parseInt(gs.getAttribute('pos') || '0') / 1000;
      const color = parseColor(gs, themeColors);
      if (color) {
        stops.push({ position: pos, color });
      }
    }
  }

  if (stops.length === 0) return undefined;

  const lin = gradFill.getElementsByTagName('a:lin')[0];
  if (lin) {
    const ang = parseInt(lin.getAttribute('ang') || '0') / 60000;
    return { type: 'linear', angle: ang, stops };
  }

  const path = gradFill.getElementsByTagName('a:path')[0];
  if (path && path.getAttribute('path') === 'circle') {
    return { type: 'radial', stops };
  }

  return { type: 'linear', angle: 0, stops };
}

export function gradientToCSS(gradient: GradientFill): string {
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

// ─── Preset Shape Geometry ───

export function generateStarPath(w: number, h: number, points: number, innerRatio: number): string {
  const cx = w / 2, cy = h / 2;
  const outerRx = w / 2, outerRy = h / 2;
  const innerRx = outerRx * innerRatio, innerRy = outerRy * innerRatio;
  const parts: string[] = [];
  for (let i = 0; i < points * 2; i++) {
    const angle = (Math.PI * i) / points - Math.PI / 2;
    const rx = i % 2 === 0 ? outerRx : innerRx;
    const ry = i % 2 === 0 ? outerRy : innerRy;
    parts.push(`${i === 0 ? 'M' : 'L'}${cx + rx * Math.cos(angle)},${cy + ry * Math.sin(angle)}`);
  }
  return parts.join(' ') + ' Z';
}

export function generateRegularPolygon(w: number, h: number, sides: number): string {
  const cx = w / 2, cy = h / 2;
  const parts: string[] = [];
  for (let i = 0; i < sides; i++) {
    const angle = (2 * Math.PI * i) / sides - Math.PI / 2;
    parts.push(`${i === 0 ? 'M' : 'L'}${cx + (w / 2) * Math.cos(angle)},${cy + (h / 2) * Math.sin(angle)}`);
  }
  return parts.join(' ') + ' Z';
}

export const PRESET_SHAPE_PATHS: Record<string, ShapePathFn> = {
  // Basic shapes
  'rect': (w, h) => `M0,0 L${w},0 L${w},${h} L0,${h} Z`,
  'triangle': (w, h) => `M${w / 2},0 L${w},${h} L0,${h} Z`,
  'rtTriangle': (w, h) => `M0,0 L${w},${h} L0,${h} Z`,
  'diamond': (w, h) => `M${w / 2},0 L${w},${h / 2} L${w / 2},${h} L0,${h / 2} Z`,
  'parallelogram': (w, h) => { const d = w * 0.25; return `M${d},0 L${w},0 L${w - d},${h} L0,${h} Z`; },
  'trapezoid': (w, h) => { const d = w * 0.2; return `M${d},0 L${w - d},0 L${w},${h} L0,${h} Z`; },
  'pentagon': (w, h) => generateRegularPolygon(w, h, 5),
  'hexagon': (w, h) => generateRegularPolygon(w, h, 6),
  'heptagon': (w, h) => generateRegularPolygon(w, h, 7),
  'octagon': (w, h) => generateRegularPolygon(w, h, 8),
  'decagon': (w, h) => generateRegularPolygon(w, h, 10),
  'dodecagon': (w, h) => generateRegularPolygon(w, h, 12),
  'ellipse': (w, h) => `M${w / 2},0 A${w / 2},${h / 2} 0 1 1 ${w / 2},${h} A${w / 2},${h / 2} 0 1 1 ${w / 2},0 Z`,
  'roundRect': (w, h, adj) => {
    const r = Math.min(w, h) * (adj?.['adj'] ?? 16667) / 100000;
    return `M${r},0 L${w - r},0 Q${w},0 ${w},${r} L${w},${h - r} Q${w},${h} ${w - r},${h} L${r},${h} Q0,${h} 0,${h - r} L0,${r} Q0,0 ${r},0 Z`;
  },
  'snipRndRect': (w, h) => { const r = Math.min(w, h) * 0.167; const s = Math.min(w, h) * 0.167; return `M${r},0 L${w - s},0 L${w},${s} L${w},${h - r} Q${w},${h} ${w - r},${h} L${r},${h} Q0,${h} 0,${h - r} L0,${r} Q0,0 ${r},0 Z`; },
  'round1Rect': (w, h) => { const r = Math.min(w, h) * 0.167; return `M0,0 L${w - r},0 Q${w},0 ${w},${r} L${w},${h} L0,${h} Z`; },
  'round2SameRect': (w, h) => { const r = Math.min(w, h) * 0.167; return `M${r},0 L${w - r},0 Q${w},0 ${w},${r} L${w},${h} L0,${h} L0,${r} Q0,0 ${r},0 Z`; },
  'round2DiagRect': (w, h) => { const r = Math.min(w, h) * 0.167; return `M${r},0 L${w},0 L${w},${h - r} Q${w},${h} ${w - r},${h} L0,${h} L0,${r} Q0,0 ${r},0 Z`; },
  'plus': (w, h) => { const a = w * 0.3, b = h * 0.3; return `M${a},0 L${w - a},0 L${w - a},${b} L${w},${b} L${w},${h - b} L${w - a},${h - b} L${w - a},${h} L${a},${h} L${a},${h - b} L0,${h - b} L0,${b} L${a},${b} Z`; },
  'cross': (w, h) => { const a = w * 0.3, b = h * 0.3; return `M${a},0 L${w - a},0 L${w - a},${b} L${w},${b} L${w},${h - b} L${w - a},${h - b} L${w - a},${h} L${a},${h} L${a},${h - b} L0,${h - b} L0,${b} L${a},${b} Z`; },
  'frame': (w, h) => { const t = Math.min(w, h) * 0.125; return `M0,0 L${w},0 L${w},${h} L0,${h} Z M${t},${t} L${t},${h - t} L${w - t},${h - t} L${w - t},${t} Z`; },
  'donut': (w, h) => { const rx = w / 2, ry = h / 2, irx = rx * 0.5, iry = ry * 0.5; return `M${rx},0 A${rx},${ry} 0 1 1 ${rx},${h} A${rx},${ry} 0 1 1 ${rx},0 Z M${rx},${ry - iry} A${irx},${iry} 0 1 0 ${rx},${ry + iry} A${irx},${iry} 0 1 0 ${rx},${ry - iry} Z`; },
  'foldedCorner': (w, h) => { const f = Math.min(w, h) * 0.2; return `M0,0 L${w - f},0 L${w},${f} L${w},${h} L0,${h} Z M${w - f},0 L${w - f},${f} L${w},${f}`; },
  'can': (w, h) => { const ry = h * 0.1; return `M0,${ry} A${w / 2},${ry} 0 0 1 ${w},${ry} L${w},${h - ry} A${w / 2},${ry} 0 0 1 0,${h - ry} Z M0,${ry} A${w / 2},${ry} 0 0 0 ${w},${ry}`; },
  'cube': (w, h) => { const d = Math.min(w, h) * 0.25; return `M0,${d} L${w - d},${d} L${w - d},${h} L0,${h} Z M0,${d} L${d},0 L${w},0 L${w - d},${d} Z M${w - d},${d} L${w},0 L${w},${h - d} L${w - d},${h} Z`; },
  'bevel': (w, h) => { const t = Math.min(w, h) * 0.12; return `M0,0 L${w},0 L${w},${h} L0,${h} Z M${t},${t} L${w - t},${t} L${w - t},${h - t} L${t},${h - t} Z`; },
  'plaque': (w, h) => { const r = Math.min(w, h) * 0.167; return `M0,${r} Q${r},0 ${r * 2},0 L${w - r * 2},0 Q${w - r},0 ${w},${r} L${w},${h - r} Q${w - r},${h} ${w - r * 2},${h} L${r * 2},${h} Q${r},${h} 0,${h - r} Z`; },
  'noSmoking': (w, h) => { const rx = w / 2, ry = h / 2; return `M${rx},0 A${rx},${ry} 0 1 1 ${rx},${h} A${rx},${ry} 0 1 1 ${rx},0 Z`; },
  'blockArc': (w, h) => { const rx = w / 2, ry = h / 2, ir = 0.6; return `M${rx},0 A${rx},${ry} 0 1 1 ${rx},${h} A${rx},${ry} 0 1 1 ${rx},0 Z M${rx},${ry * (1 - ir)} A${rx * ir},${ry * ir} 0 1 0 ${rx},${ry * (1 + ir)} A${rx * ir},${ry * ir} 0 1 0 ${rx},${ry * (1 - ir)} Z`; },

  // Stars
  'star4': (w, h) => generateStarPath(w, h, 4, 0.38),
  'star5': (w, h) => generateStarPath(w, h, 5, 0.38),
  'star6': (w, h) => generateStarPath(w, h, 6, 0.45),
  'star8': (w, h) => generateStarPath(w, h, 8, 0.38),
  'star10': (w, h) => generateStarPath(w, h, 10, 0.38),
  'star12': (w, h) => generateStarPath(w, h, 12, 0.38),
  'star16': (w, h) => generateStarPath(w, h, 16, 0.38),
  'star24': (w, h) => generateStarPath(w, h, 24, 0.38),
  'star32': (w, h) => generateStarPath(w, h, 32, 0.38),
  'irregularSeal1': (w, h) => `M${w * 0.15},${h * 0.35} L${w * 0.3},0 L${w * 0.45},${h * 0.25} L${w * 0.7},${h * 0.05} L${w * 0.65},${h * 0.35} L${w},${h * 0.3} L${w * 0.75},${h * 0.55} L${w * 0.9},${h * 0.85} L${w * 0.6},${h * 0.7} L${w * 0.4},${h} L${w * 0.35},${h * 0.65} L0,${h * 0.7} L${w * 0.2},${h * 0.5} Z`,
  'irregularSeal2': (w, h) => `M0,${h * 0.4} L${w * 0.2},${h * 0.1} L${w * 0.35},${h * 0.25} L${w * 0.5},0 L${w * 0.55},${h * 0.3} L${w * 0.8},${h * 0.15} L${w * 0.7},${h * 0.45} L${w},${h * 0.5} L${w * 0.75},${h * 0.65} L${w * 0.85},${h} L${w * 0.55},${h * 0.75} L${w * 0.3},${h * 0.9} L${w * 0.35},${h * 0.6} L0,${h * 0.7} Z`,

  // Flowchart
  'flowChartProcess': (w, h) => `M0,0 L${w},0 L${w},${h} L0,${h} Z`,
  'flowChartAlternateProcess': (w, h) => { const r = Math.min(w, h) * 0.1; return `M${r},0 L${w - r},0 Q${w},0 ${w},${r} L${w},${h - r} Q${w},${h} ${w - r},${h} L${r},${h} Q0,${h} 0,${h - r} L0,${r} Q0,0 ${r},0 Z`; },
  'flowChartDecision': (w, h) => `M${w / 2},0 L${w},${h / 2} L${w / 2},${h} L0,${h / 2} Z`,
  'flowChartInputOutput': (w, h) => { const d = w * 0.2; return `M${d},0 L${w},0 L${w - d},${h} L0,${h} Z`; },
  'flowChartPredefinedProcess': (w, h) => { const d = w * 0.12; return `M0,0 L${w},0 L${w},${h} L0,${h} Z M${d},0 L${d},${h} M${w - d},0 L${w - d},${h}`; },
  'flowChartTerminator': (w, h) => { const r = h / 2; return `M${r},0 L${w - r},0 A${r},${r} 0 0 1 ${w - r},${h} L${r},${h} A${r},${r} 0 0 1 ${r},0 Z`; },
  'flowChartPreparation': (w, h) => { const d = w * 0.17; return `M${d},0 L${w - d},0 L${w},${h / 2} L${w - d},${h} L${d},${h} L0,${h / 2} Z`; },
  'flowChartManualInput': (w, h) => { const d = h * 0.2; return `M0,${d} L${w},0 L${w},${h} L0,${h} Z`; },
  'flowChartManualOperation': (w, h) => { const d = w * 0.15; return `M0,0 L${w},0 L${w - d},${h} L${d},${h} Z`; },
  'flowChartConnector': (w, h) => `M${w / 2},0 A${w / 2},${h / 2} 0 1 1 ${w / 2},${h} A${w / 2},${h / 2} 0 1 1 ${w / 2},0 Z`,
  'flowChartOffpageConnector': (w, h) => { const d = h * 0.2; return `M0,0 L${w},0 L${w},${h - d} L${w / 2},${h} L0,${h - d} Z`; },
  'flowChartDocument': (w, h) => { const cy = h * 0.85; return `M0,0 L${w},0 L${w},${cy} C${w * 0.75},${h * 1.05} ${w * 0.25},${h * 0.7} 0,${cy} Z`; },
  'flowChartMultidocument': (w, h) => { const d = w * 0.08, dy = h * 0.08; return `M${d * 2},${dy * 2} L${w},${dy * 2} L${w},${h * 0.85} C${w * 0.75},${h * 1.05} ${w * 0.3},${h * 0.7} ${d * 2},${h * 0.85} Z M${d},${dy} L${w - d},${dy} M0,0 L${w - d * 2},0`; },
  'flowChartInternalStorage': (w, h) => { const d = Math.min(w, h) * 0.15; return `M0,0 L${w},0 L${w},${h} L0,${h} Z M${d},0 L${d},${h} M0,${d} L${w},${d}`; },
  'flowChartDelay': (w, h) => `M0,0 L${w * 0.6},0 A${w * 0.4},${h / 2} 0 0 1 ${w * 0.6},${h} L0,${h} Z`,
  'flowChartDisplay': (w, h) => { const d = w * 0.17; return `M${d},0 L${w * 0.7},0 A${w * 0.3},${h / 2} 0 0 1 ${w * 0.7},${h} L${d},${h} L0,${h / 2} Z`; },
  'flowChartSort': (w, h) => `M${w / 2},0 L${w},${h / 2} L${w / 2},${h} L0,${h / 2} Z M0,${h / 2} L${w},${h / 2}`,
  'flowChartExtract': (w, h) => `M${w / 2},0 L${w},${h} L0,${h} Z`,
  'flowChartMerge': (w, h) => `M0,0 L${w},0 L${w / 2},${h} Z`,

  // Callouts
  'wedgeRectCallout': (w, h) => { const tx = w * 0.5, ty = h + h * 0.15; return `M0,0 L${w},0 L${w},${h} L${w * 0.55},${h} L${tx},${ty} L${w * 0.45},${h} L0,${h} Z`; },
  'wedgeRoundRectCallout': (w, h) => { const r = Math.min(w, h) * 0.1, tx = w * 0.5, ty = h + h * 0.15; return `M${r},0 L${w - r},0 Q${w},0 ${w},${r} L${w},${h - r} Q${w},${h} ${w - r},${h} L${w * 0.55},${h} L${tx},${ty} L${w * 0.45},${h} L${r},${h} Q0,${h} 0,${h - r} L0,${r} Q0,0 ${r},0 Z`; },
  'wedgeEllipseCallout': (w, h) => { const rx = w / 2, ry = h / 2; return `M${rx},0 A${rx},${ry} 0 1 1 ${rx},${h} A${rx},${ry} 0 1 1 ${rx},0 Z M${rx},${h} L${rx - w * 0.05},${h + h * 0.15} L${rx + w * 0.05},${h}`; },
  'cloudCallout': (w, h) => `M${w * 0.2},${h * 0.55} A${w * 0.2},${h * 0.2} 0 1 1 ${w * 0.35},${h * 0.3} A${w * 0.2},${h * 0.2} 0 1 1 ${w * 0.6},${h * 0.2} A${w * 0.22},${h * 0.2} 0 1 1 ${w * 0.8},${h * 0.35} A${w * 0.15},${h * 0.18} 0 1 1 ${w * 0.85},${h * 0.6} A${w * 0.18},${h * 0.2} 0 1 1 ${w * 0.7},${h * 0.8} A${w * 0.2},${h * 0.15} 0 1 1 ${w * 0.4},${h * 0.85} A${w * 0.2},${h * 0.2} 0 1 1 ${w * 0.2},${h * 0.55} Z`,

  // Misc
  'heart': (w, h) => `M${w / 2},${h * 0.3} C${w / 2},${h * 0.1} ${w * 0.25},0 0,${h * 0.1} C0,${h * 0.4} ${w / 2},${h * 0.7} ${w / 2},${h} C${w / 2},${h * 0.7} ${w},${h * 0.4} ${w},${h * 0.1} C${w * 0.75},0 ${w / 2},${h * 0.1} ${w / 2},${h * 0.3} Z`,
  'lightningBolt': (w, h) => `M${w * 0.4},0 L${w * 0.55},${h * 0.35} L${w},${h * 0.3} L${w * 0.4},${h * 0.65} L${w * 0.65},${h * 0.6} L0,${h} L${w * 0.35},${h * 0.45} L0,${h * 0.5} Z`,
  'moon': (w, h) => `M${w},0 A${w * 0.6},${h / 2} 0 1 1 ${w},${h} A${w * 0.35},${h / 2} 0 1 0 ${w},0 Z`,
  'cloud': (w, h) => `M${w * 0.2},${h * 0.55} A${w * 0.2},${h * 0.2} 0 1 1 ${w * 0.35},${h * 0.3} A${w * 0.2},${h * 0.2} 0 1 1 ${w * 0.6},${h * 0.2} A${w * 0.22},${h * 0.2} 0 1 1 ${w * 0.8},${h * 0.35} A${w * 0.15},${h * 0.18} 0 1 1 ${w * 0.85},${h * 0.6} A${w * 0.18},${h * 0.2} 0 1 1 ${w * 0.7},${h * 0.8} A${w * 0.2},${h * 0.15} 0 1 1 ${w * 0.4},${h * 0.85} A${w * 0.2},${h * 0.2} 0 1 1 ${w * 0.2},${h * 0.55} Z`,
  'sun': (w, h) => { const cx = w / 2, cy = h / 2, r = Math.min(w, h) * 0.3; let p = `M${cx},${cy - r} A${r},${r} 0 1 1 ${cx},${cy + r} A${r},${r} 0 1 1 ${cx},${cy - r} Z`; for (let i = 0; i < 8; i++) { const a = (Math.PI * i) / 4; const x1 = cx + r * 1.1 * Math.cos(a), y1 = cy + r * 1.1 * Math.sin(a); const x2 = cx + r * 1.6 * Math.cos(a), y2 = cy + r * 1.6 * Math.sin(a); p += ` M${x1},${y1} L${x2},${y2}`; } return p; },
  'smileyFace': (w, h) => `M${w / 2},0 A${w / 2},${h / 2} 0 1 1 ${w / 2},${h} A${w / 2},${h / 2} 0 1 1 ${w / 2},0 Z`,
  'bracketPair': (w, h) => { const r = Math.min(w, h) * 0.2; return `M${r},0 Q0,0 0,${r} L0,${h - r} Q0,${h} ${r},${h} M${w - r},0 Q${w},0 ${w},${r} L${w},${h - r} Q${w},${h} ${w - r},${h}`; },
  'bracePair': (w, h) => { const r = Math.min(w, h) * 0.12; return `M${r},0 Q0,0 0,${r} L0,${h / 2 - r} Q0,${h / 2} ${-r * 0.3},${h / 2} Q0,${h / 2} 0,${h / 2 + r} L0,${h - r} Q0,${h} ${r},${h} M${w - r},0 Q${w},0 ${w},${r} L${w},${h / 2 - r} Q${w},${h / 2} ${w + r * 0.3},${h / 2} Q${w},${h / 2} ${w},${h / 2 + r} L${w},${h - r} Q${w},${h} ${w - r},${h}`; },
  'leftBracket': (w, h) => { const r = Math.min(w, h) * 0.2; return `M${w},0 L${r},0 Q0,0 0,${r} L0,${h - r} Q0,${h} ${r},${h} L${w},${h}`; },
  'rightBracket': (w, h) => { const r = Math.min(w, h) * 0.2; return `M0,0 L${w - r},0 Q${w},0 ${w},${r} L${w},${h - r} Q${w},${h} ${w - r},${h} L0,${h}`; },

  // Arrow shapes
  'rightArrow': (w, h) => { const aw = w * 0.6, ah = h * 0.3; return `M0,${ah} L${aw},${ah} L${aw},0 L${w},${h / 2} L${aw},${h} L${aw},${h - ah} L0,${h - ah} Z`; },
  'leftArrow': (w, h) => { const aw = w * 0.6, ah = h * 0.3; return `M${w},${ah} L${w - aw},${ah} L${w - aw},0 L0,${h / 2} L${w - aw},${h} L${w - aw},${h - ah} L${w},${h - ah} Z`; },
  'upArrow': (w, h) => { const aw = w * 0.3, ah = h * 0.6; return `M${aw},${h} L${aw},${ah} L0,${ah} L${w / 2},0 L${w},${ah} L${w - aw},${ah} L${w - aw},${h} Z`; },
  'downArrow': (w, h) => { const aw = w * 0.3, ah = h * 0.4; return `M${aw},0 L${aw},${ah} L0,${ah} L${w / 2},${h} L${w},${ah} L${w - aw},${ah} L${w - aw},0 Z`; },
  'leftRightArrow': (w, h) => { const hw = w * 0.2, hh = h * 0.3; return `M0,${h / 2} L${hw},0 L${hw},${hh} L${w - hw},${hh} L${w - hw},0 L${w},${h / 2} L${w - hw},${h} L${w - hw},${h - hh} L${hw},${h - hh} L${hw},${h} Z`; },
  'upDownArrow': (w, h) => { const aw = w * 0.3, ah = h * 0.2; return `M${w / 2},0 L${w},${ah} L${w - aw},${ah} L${w - aw},${h - ah} L${w},${h - ah} L${w / 2},${h} L0,${h - ah} L${aw},${h - ah} L${aw},${ah} L0,${ah} Z`; },
  'chevron': (w, h) => { const d = w * 0.2; return `M0,0 L${w - d},0 L${w},${h / 2} L${w - d},${h} L0,${h} L${d},${h / 2} Z`; },
  'homePlate': (w, h) => { const d = w * 0.2; return `M0,0 L${w - d},0 L${w},${h / 2} L${w - d},${h} L0,${h} Z`; },
  'notchedRightArrow': (w, h) => { const aw = w * 0.6, ah = h * 0.3; return `M0,${ah} L${aw},${ah} L${aw},0 L${w},${h / 2} L${aw},${h} L${aw},${h - ah} L0,${h - ah} L${w * 0.15},${h / 2} Z`; },
  'stripedRightArrow': (w, h) => { const aw = w * 0.6, ah = h * 0.3; return `M0,${ah} L${aw},${ah} L${aw},0 L${w},${h / 2} L${aw},${h} L${aw},${h - ah} L0,${h - ah} Z`; },
  'bentUpArrow': (w, h) => { const aw = w * 0.3, ah = h * 0.3; return `M${w / 2},0 L${w},${ah} L${w - aw},${ah} L${w - aw},${h - ah} L${aw},${h - ah} L${aw},${h} L0,${h} L0,${h - ah} L${w / 2 - aw / 2},${h - ah} L${w / 2 - aw / 2},${ah} L${w / 2 - aw},${ah} Z`; },

  // Math
  'mathPlus': (w, h) => { const a = w * 0.3, b = h * 0.3; return `M${a},0 L${w - a},0 L${w - a},${b} L${w},${b} L${w},${h - b} L${w - a},${h - b} L${w - a},${h} L${a},${h} L${a},${h - b} L0,${h - b} L0,${b} L${a},${b} Z`; },
  'mathMinus': (w, h) => { const b = h * 0.35; return `M0,${b} L${w},${b} L${w},${h - b} L0,${h - b} Z`; },
  'mathMultiply': (w, h) => { const d = Math.min(w, h) * 0.15; return `M${d},0 L${w / 2},${h / 2 - d} L${w - d},0 L${w},${d} L${w / 2 + d},${h / 2} L${w},${h - d} L${w - d},${h} L${w / 2},${h / 2 + d} L${d},${h} L0,${h - d} L${w / 2 - d},${h / 2} L0,${d} Z`; },
  'mathDivide': (w, h) => { const b = h * 0.35, r = Math.min(w, h) * 0.1; return `M0,${b} L${w},${b} L${w},${h - b} L0,${h - b} Z M${w / 2},${b - r * 2} A${r},${r} 0 1 1 ${w / 2},${b - r * 2 + 0.01} Z M${w / 2},${h - b + r * 2} A${r},${r} 0 1 1 ${w / 2},${h - b + r * 2 + 0.01} Z`; },
  'mathEqual': (w, h) => { const g = h * 0.15, t = h * 0.15; return `M0,${g} L${w},${g} L${w},${g + t} L0,${g + t} Z M0,${h - g - t} L${w},${h - g - t} L${w},${h - g} L0,${h - g} Z`; },

  // Action buttons (just rectangles with icon inside -- render as rect)
  'actionButtonBlank': (w, h) => `M0,0 L${w},0 L${w},${h} L0,${h} Z`,
};

// ─── Custom Geometry Parser ───

export function parseCustomGeometry(pathLst: Element, shapeW: number, shapeH: number): string {
  const paths = pathLst.getElementsByTagName('a:path');
  const allParts: string[] = [];

  for (let pi = 0; pi < paths.length; pi++) {
    const pathEl = paths[pi];
    const pathW = parseInt(pathEl.getAttribute('w') || '0') || shapeW * EMU_PER_PIXEL;
    const pathH = parseInt(pathEl.getAttribute('h') || '0') || shapeH * EMU_PER_PIXEL;
    const scaleX = shapeW / (pathW / EMU_PER_PIXEL || shapeW);
    const scaleY = shapeH / (pathH / EMU_PER_PIXEL || shapeH);

    for (let ci = 0; ci < pathEl.children.length; ci++) {
      const cmd = pathEl.children[ci];
      const tag = cmd.tagName;
      if (tag === 'a:moveTo') {
        const pt = cmd.getElementsByTagName('a:pt')[0];
        if (pt) allParts.push(`M${parseInt(pt.getAttribute('x') || '0') / EMU_PER_PIXEL * scaleX},${parseInt(pt.getAttribute('y') || '0') / EMU_PER_PIXEL * scaleY}`);
      } else if (tag === 'a:lnTo') {
        const pt = cmd.getElementsByTagName('a:pt')[0];
        if (pt) allParts.push(`L${parseInt(pt.getAttribute('x') || '0') / EMU_PER_PIXEL * scaleX},${parseInt(pt.getAttribute('y') || '0') / EMU_PER_PIXEL * scaleY}`);
      } else if (tag === 'a:cubicBezTo') {
        const pts = cmd.getElementsByTagName('a:pt');
        if (pts.length >= 3) {
          const p = Array.from(pts).map(pt => ({ x: parseInt(pt.getAttribute('x') || '0') / EMU_PER_PIXEL * scaleX, y: parseInt(pt.getAttribute('y') || '0') / EMU_PER_PIXEL * scaleY }));
          allParts.push(`C${p[0].x},${p[0].y} ${p[1].x},${p[1].y} ${p[2].x},${p[2].y}`);
        }
      } else if (tag === 'a:arcTo') {
        // Arc: wR, hR = radii in EMU, stAng, swAng in 60000ths of a degree
        const wR = parseInt(cmd.getAttribute('wR') || '0') / EMU_PER_PIXEL * scaleX;
        const hR = parseInt(cmd.getAttribute('hR') || '0') / EMU_PER_PIXEL * scaleY;
        const stAng = parseInt(cmd.getAttribute('stAng') || '0') / 60000;
        const swAng = parseInt(cmd.getAttribute('swAng') || '0') / 60000;
        if (wR > 0 && hR > 0) {
          const largeArc = Math.abs(swAng) > 180 ? 1 : 0;
          const sweep = swAng > 0 ? 1 : 0;
          const endAng = (stAng + swAng) * Math.PI / 180;
          // Calculate endpoint relative to arc center
          // Since we don't track current point, approximate with relative arc
          const ex = wR * Math.cos(endAng);
          const ey = hR * Math.sin(endAng);
          const sx = wR * Math.cos(stAng * Math.PI / 180);
          const sy = hR * Math.sin(stAng * Math.PI / 180);
          const dx = ex - sx;
          const dy = ey - sy;
          allParts.push(`a${wR},${hR} 0 ${largeArc} ${sweep} ${dx},${dy}`);
        }
      } else if (tag === 'a:close') {
        allParts.push('Z');
      }
    }
  }

  return allParts.join(' ');
}

// ─── Connector Path Builder ───

export function buildConnectorPath(w: number, h: number, connType: string, adj: Record<string, number>, pad: number): string {
  const x1 = pad, y1 = pad, x2 = pad + w, y2 = pad + h;

  if (connType === 'straightConnector1' || !connType) {
    return `M${x1},${y1} L${x2},${y2}`;
  }

  if (connType === 'bentConnector2') {
    return `M${x1},${y1} L${x2},${y1} L${x2},${y2}`;
  }
  if (connType === 'bentConnector3') {
    const a = adj['adj1'] ?? 0.5;
    const midX = x1 + (x2 - x1) * a;
    return `M${x1},${y1} L${midX},${y1} L${midX},${y2} L${x2},${y2}`;
  }
  if (connType === 'bentConnector4') {
    const a1 = adj['adj1'] ?? 0.5;
    const a2 = adj['adj2'] ?? 0.5;
    const midX = x1 + (x2 - x1) * a1;
    const midY = y1 + (y2 - y1) * a2;
    return `M${x1},${y1} L${midX},${y1} L${midX},${midY} L${x2},${midY} L${x2},${y2}`;
  }
  if (connType === 'bentConnector5') {
    const a1 = adj['adj1'] ?? 0.33, a2 = adj['adj2'] ?? 0.5, a3 = adj['adj3'] ?? 0.67;
    const mx1 = x1 + (x2 - x1) * a1, my = y1 + (y2 - y1) * a2, mx2 = x1 + (x2 - x1) * a3;
    return `M${x1},${y1} L${mx1},${y1} L${mx1},${my} L${mx2},${my} L${mx2},${y2} L${x2},${y2}`;
  }

  if (connType === 'curvedConnector2') {
    return `M${x1},${y1} Q${x2},${y1} ${x2},${y2}`;
  }
  if (connType === 'curvedConnector3') {
    const a = adj['adj1'] ?? 0.5;
    const midX = x1 + (x2 - x1) * a;
    return `M${x1},${y1} C${midX},${y1} ${midX},${y2} ${x2},${y2}`;
  }
  if (connType === 'curvedConnector4' || connType === 'curvedConnector5') {
    const a1 = adj['adj1'] ?? 0.5, a2 = adj['adj2'] ?? 0.5;
    const mx = x1 + (x2 - x1) * a1, my = y1 + (y2 - y1) * a2;
    return `M${x1},${y1} C${mx},${y1} ${mx},${my} ${mx},${my} S${x2},${y2} ${x2},${y2}`;
  }

  return `M${x1},${y1} L${x2},${y2}`;
}
