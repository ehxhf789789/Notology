import type { ThemeColors } from './pptxTypes';

export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const h = hex.replace('#', '');
  return {
    r: parseInt(h.substring(0, 2), 16),
    g: parseInt(h.substring(2, 4), 16),
    b: parseInt(h.substring(4, 6), 16),
  };
}

export function rgbToHex(r: number, g: number, b: number): string {
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  return '#' + [clamp(r), clamp(g), clamp(b)].map(v => v.toString(16).padStart(2, '0')).join('');
}

export function applyColorMods(baseHex: string, modElement: Element): string {
  const { r, g, b } = hexToRgb(baseHex);

  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  let h = 0, s = 0, l = (max + min) / 2;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case rn: h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6; break;
      case gn: h = ((bn - rn) / d + 2) / 6; break;
      case bn: h = ((rn - gn) / d + 4) / 6; break;
    }
  }

  const lumMod = modElement.getElementsByTagName('a:lumMod')[0];
  const lumOff = modElement.getElementsByTagName('a:lumOff')[0];
  const tint = modElement.getElementsByTagName('a:tint')[0];
  const shade = modElement.getElementsByTagName('a:shade')[0];

  if (lumMod) {
    const val = parseInt(lumMod.getAttribute('val') || '100000') / 100000;
    l = l * val;
  }
  if (lumOff) {
    const val = parseInt(lumOff.getAttribute('val') || '0') / 100000;
    l = l + val;
  }

  l = Math.max(0, Math.min(1, l));

  const hue2rgb = (p: number, q: number, t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1/6) return p + (q - p) * 6 * t;
    if (t < 1/2) return q;
    if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
    return p;
  };

  let rr: number, gg: number, bb: number;
  if (s === 0) {
    rr = gg = bb = l;
  } else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    rr = hue2rgb(p, q, h + 1/3);
    gg = hue2rgb(p, q, h);
    bb = hue2rgb(p, q, h - 1/3);
  }

  let finalR = rr * 255, finalG = gg * 255, finalB = bb * 255;

  if (tint) {
    const val = parseInt(tint.getAttribute('val') || '100000') / 100000;
    finalR = finalR * val + 255 * (1 - val);
    finalG = finalG * val + 255 * (1 - val);
    finalB = finalB * val + 255 * (1 - val);
  }
  if (shade) {
    const val = parseInt(shade.getAttribute('val') || '100000') / 100000;
    finalR = finalR * val;
    finalG = finalG * val;
    finalB = finalB * val;
  }

  return rgbToHex(finalR, finalG, finalB);
}

export const DEFAULT_SCHEME_COLORS: ThemeColors = {
  'tx1': '#000000', 'tx2': '#44546A', 'bg1': '#FFFFFF', 'bg2': '#E7E6E6',
  'accent1': '#4472C4', 'accent2': '#ED7D31', 'accent3': '#A5A5A5',
  'accent4': '#FFC000', 'accent5': '#5B9BD5', 'accent6': '#70AD47',
  'dk1': '#000000', 'dk2': '#44546A', 'lt1': '#FFFFFF', 'lt2': '#E7E6E6',
  'hlink': '#0563C1', 'folHlink': '#954F72',
};

export function parseColor(colorNode: Element | null, themeColors?: ThemeColors): string | undefined {
  if (!colorNode) return undefined;

  const srgb = colorNode.getElementsByTagName('a:srgbClr')[0];
  if (srgb) {
    const val = srgb.getAttribute('val');
    if (!val) return undefined;
    let color = '#' + val;

    const hasMods = srgb.getElementsByTagName('a:lumMod')[0] ||
                    srgb.getElementsByTagName('a:tint')[0] ||
                    srgb.getElementsByTagName('a:shade')[0];
    if (hasMods) {
      color = applyColorMods(color, srgb);
    }

    const alpha = srgb.getElementsByTagName('a:alpha')[0];
    if (alpha) {
      const alphaVal = parseInt(alpha.getAttribute('val') || '100000') / 100000;
      const { r, g, b } = hexToRgb(color);
      return `rgba(${r}, ${g}, ${b}, ${alphaVal})`;
    }
    return color;
  }

  const scheme = colorNode.getElementsByTagName('a:schemeClr')[0];
  if (scheme) {
    const val = scheme.getAttribute('val');
    const colors = themeColors || DEFAULT_SCHEME_COLORS;
    let baseColor = colors[val || ''];
    if (!baseColor) return undefined;

    const hasMods = scheme.getElementsByTagName('a:lumMod')[0] ||
                    scheme.getElementsByTagName('a:lumOff')[0] ||
                    scheme.getElementsByTagName('a:tint')[0] ||
                    scheme.getElementsByTagName('a:shade')[0];
    if (hasMods) {
      baseColor = applyColorMods(baseColor, scheme);
    }

    const alpha = scheme.getElementsByTagName('a:alpha')[0];
    if (alpha) {
      const alphaVal = parseInt(alpha.getAttribute('val') || '100000') / 100000;
      const { r, g, b } = hexToRgb(baseColor);
      return `rgba(${r}, ${g}, ${b}, ${alphaVal})`;
    }
    return baseColor;
  }

  // System color (e.g., windowText -> black, window -> white)
  const sysClr = colorNode.getElementsByTagName('a:sysClr')[0];
  if (sysClr) {
    const lastClr = sysClr.getAttribute('lastClr');
    if (lastClr) {
      let color = '#' + lastClr;
      const alpha = sysClr.getElementsByTagName('a:alpha')[0];
      if (alpha) {
        const alphaVal = parseInt(alpha.getAttribute('val') || '100000') / 100000;
        const { r, g, b } = hexToRgb(color);
        return `rgba(${r}, ${g}, ${b}, ${alphaVal})`;
      }
      return color;
    }
    // Fallback by system color name
    const val = sysClr.getAttribute('val');
    if (val === 'windowText') return '#000000';
    if (val === 'window') return '#FFFFFF';
    return '#000000';
  }

  // Preset color (e.g., "black", "white", "red")
  const prstClr = colorNode.getElementsByTagName('a:prstClr')[0];
  if (prstClr) {
    const PRESET_COLORS: Record<string, string> = {
      black: '#000000', white: '#FFFFFF', red: '#FF0000', green: '#008000',
      blue: '#0000FF', yellow: '#FFFF00', cyan: '#00FFFF', magenta: '#FF00FF',
      gray: '#808080', darkGray: '#A9A9A9', lightGray: '#D3D3D3', darkRed: '#8B0000',
      darkGreen: '#006400', darkBlue: '#00008B', navy: '#000080', orange: '#FFA500',
    };
    const val = prstClr.getAttribute('val') || '';
    let color = PRESET_COLORS[val] || '#000000';
    const alpha = prstClr.getElementsByTagName('a:alpha')[0];
    if (alpha) {
      const alphaVal = parseInt(alpha.getAttribute('val') || '100000') / 100000;
      const { r, g, b } = hexToRgb(color);
      return `rgba(${r}, ${g}, ${b}, ${alphaVal})`;
    }
    return color;
  }

  return undefined;
}

// Resolve a direct color element (a:schemeClr, a:srgbClr, a:sysClr, a:prstClr)
// Unlike parseColor which searches children, this handles the element itself
export function resolveDirectColor(el: Element, themeColors?: ThemeColors): string | undefined {
  const tag = el.tagName;
  if (tag === 'a:srgbClr') {
    let color = '#' + (el.getAttribute('val') || '000000');
    const hasMods = el.getElementsByTagName('a:lumMod')[0] || el.getElementsByTagName('a:tint')[0] || el.getElementsByTagName('a:shade')[0];
    if (hasMods) color = applyColorMods(color, el);
    const alpha = el.getElementsByTagName('a:alpha')[0];
    if (alpha) {
      const a = parseInt(alpha.getAttribute('val') || '100000') / 100000;
      const { r, g, b } = hexToRgb(color);
      return `rgba(${r}, ${g}, ${b}, ${a})`;
    }
    return color;
  }
  if (tag === 'a:schemeClr') {
    const val = el.getAttribute('val');
    const colors = themeColors || DEFAULT_SCHEME_COLORS;
    let baseColor = colors[val || ''];
    if (!baseColor) return undefined;
    const hasMods = el.getElementsByTagName('a:lumMod')[0] || el.getElementsByTagName('a:lumOff')[0] || el.getElementsByTagName('a:tint')[0] || el.getElementsByTagName('a:shade')[0];
    if (hasMods) baseColor = applyColorMods(baseColor, el);
    return baseColor;
  }
  if (tag === 'a:sysClr') {
    const lastClr = el.getAttribute('lastClr');
    if (lastClr) return '#' + lastClr;
    const val = el.getAttribute('val');
    return val === 'windowText' ? '#000000' : '#FFFFFF';
  }
  if (tag === 'a:prstClr') {
    const PRESET: Record<string, string> = { black: '#000000', white: '#FFFFFF', red: '#FF0000', green: '#008000', blue: '#0000FF', yellow: '#FFFF00' };
    return PRESET[el.getAttribute('val') || ''] || '#000000';
  }
  // Fallback: try parseColor treating it as a container
  return parseColor(el, themeColors);
}
