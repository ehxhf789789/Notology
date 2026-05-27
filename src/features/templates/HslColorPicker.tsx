/**
 * Stage 5.0.5a-γ3 (2026-05-16, HanBin) — inline HSL color picker.
 *
 * Replaces the native `<input type="color">` which on Windows pops an OS
 * dialog that interrupts the editing flow. This picker stays inline:
 *   - Hue / Saturation / Lightness sliders (each with a gradient track
 *     showing where the current color falls on that axis).
 *   - Live hex preview that doubles as a manual hex input.
 *   - Two-way binding: hex typed in is parsed → HSL; sliders update hex.
 *
 * Pure presentational — accepts a hex string and emits a hex string.
 * Renders nothing if value is empty (caller decides when to mount).
 */
import { useEffect, useState } from 'react';

interface HslColorPickerProps {
  /** Current color as `#rrggbb`. Empty string allowed for "not yet picked". */
  value: string;
  /** Emits a normalised `#rrggbb` string. */
  onChange: (hex: string) => void;
}

/** Clamp helper. */
function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

/** Parse `#rgb` / `#rrggbb` → { r, g, b } ∈ [0..255]. Returns null on bad input. */
function parseHex(hex: string): { r: number; g: number; b: number } | null {
  const s = hex.trim().replace(/^#/, '');
  if (s.length === 3) {
    const r = parseInt(s[0] + s[0], 16);
    const g = parseInt(s[1] + s[1], 16);
    const b = parseInt(s[2] + s[2], 16);
    if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return null;
    return { r, g, b };
  }
  if (s.length === 6) {
    const r = parseInt(s.slice(0, 2), 16);
    const g = parseInt(s.slice(2, 4), 16);
    const b = parseInt(s.slice(4, 6), 16);
    if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return null;
    return { r, g, b };
  }
  return null;
}

function rgbToHex(r: number, g: number, b: number): string {
  const toHex = (n: number) => clamp(Math.round(n), 0, 255).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/** RGB [0..255] → HSL with H ∈ [0..360], S/L ∈ [0..100]. */
function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  const rf = r / 255, gf = g / 255, bf = b / 255;
  const max = Math.max(rf, gf, bf);
  const min = Math.min(rf, gf, bf);
  const l = (max + min) / 2;
  let h = 0, s = 0;
  const d = max - min;
  if (d !== 0) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case rf: h = (gf - bf) / d + (gf < bf ? 6 : 0); break;
      case gf: h = (bf - rf) / d + 2; break;
      case bf: h = (rf - gf) / d + 4; break;
    }
    h *= 60;
  }
  return { h, s: s * 100, l: l * 100 };
}

/** HSL → RGB [0..255]. H ∈ [0..360], S/L ∈ [0..100]. */
function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  const sf = s / 100, lf = l / 100;
  const c = (1 - Math.abs(2 * lf - 1)) * sf;
  const hp = (h % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r1 = 0, g1 = 0, b1 = 0;
  if (hp >= 0 && hp < 1) { r1 = c; g1 = x; }
  else if (hp < 2)        { r1 = x; g1 = c; }
  else if (hp < 3)        { g1 = c; b1 = x; }
  else if (hp < 4)        { g1 = x; b1 = c; }
  else if (hp < 5)        { r1 = x; b1 = c; }
  else if (hp < 6)        { r1 = c; b1 = x; }
  const m = lf - c / 2;
  return { r: (r1 + m) * 255, g: (g1 + m) * 255, b: (b1 + m) * 255 };
}

function hexToHsl(hex: string): { h: number; s: number; l: number } | null {
  const rgb = parseHex(hex);
  if (!rgb) return null;
  return rgbToHsl(rgb.r, rgb.g, rgb.b);
}

function hslToHex(h: number, s: number, l: number): string {
  const { r, g, b } = hslToRgb(h, s, l);
  return rgbToHex(r, g, b);
}

const FALLBACK_HEX = '#a78bfa';

export default function HslColorPicker({ value, onChange }: HslColorPickerProps) {
  // Internal HSL state — synced from `value` prop whenever it changes from
  // outside (e.g. theme preset clicked). Local edits propagate via onChange.
  const [hsl, setHsl] = useState(() => hexToHsl(value || FALLBACK_HEX) || { h: 260, s: 90, l: 76 });
  const [hexText, setHexText] = useState(value || FALLBACK_HEX);

  // Sync inward when the parent flips the value (theme swatch click etc.).
  useEffect(() => {
    if (!value) return;
    const parsed = hexToHsl(value);
    if (!parsed) return;
    const currentHex = hslToHex(hsl.h, hsl.s, hsl.l).toLowerCase();
    if (value.toLowerCase() !== currentHex) {
      setHsl(parsed);
      setHexText(value);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const emit = (next: { h: number; s: number; l: number }) => {
    setHsl(next);
    const hex = hslToHex(next.h, next.s, next.l);
    setHexText(hex);
    onChange(hex);
  };

  const onHexChange = (raw: string) => {
    setHexText(raw);
    const parsed = hexToHsl(raw);
    if (parsed) {
      setHsl(parsed);
      // Normalise to 6-digit form on the way out.
      onChange(hslToHex(parsed.h, parsed.s, parsed.l));
    }
  };

  // Track gradients reflect the axis being adjusted, holding the other two
  // values constant. Hue track is the full rainbow regardless of S/L (the
  // thumb's color tells you where you are).
  const hueAtCurrent = `hsl(${hsl.h}, ${hsl.s}%, ${hsl.l}%)`;
  const satTrack = `linear-gradient(to right, hsl(${hsl.h}, 0%, ${hsl.l}%) 0%, hsl(${hsl.h}, 100%, ${hsl.l}%) 100%)`;
  const lightTrack = `linear-gradient(to right, hsl(${hsl.h}, ${hsl.s}%, 0%) 0%, hsl(${hsl.h}, ${hsl.s}%, 50%) 50%, hsl(${hsl.h}, ${hsl.s}%, 100%) 100%)`;
  const hueTrack = 'linear-gradient(to right, #ff0000 0%, #ffff00 17%, #00ff00 33%, #00ffff 50%, #0000ff 67%, #ff00ff 83%, #ff0000 100%)';

  return (
    <div className="hsl-picker">
      <div className="hsl-picker__top">
        <span
          className="hsl-picker__swatch"
          style={{ background: hueAtCurrent }}
          aria-label="Current color"
        />
        <input
          type="text"
          className="hsl-picker__hex"
          value={hexText}
          onChange={e => onHexChange(e.target.value)}
          spellCheck={false}
          maxLength={7}
        />
      </div>
      <div className="hsl-picker__row">
        <span className="hsl-picker__label">H</span>
        <input
          type="range"
          min={0}
          max={360}
          step={1}
          value={Math.round(hsl.h)}
          onChange={e => emit({ ...hsl, h: Number(e.target.value) })}
          style={{ backgroundImage: hueTrack }}
          className="hsl-picker__range"
          aria-label="Hue"
        />
        <span className="hsl-picker__val">{Math.round(hsl.h)}°</span>
      </div>
      <div className="hsl-picker__row">
        <span className="hsl-picker__label">S</span>
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={Math.round(hsl.s)}
          onChange={e => emit({ ...hsl, s: Number(e.target.value) })}
          style={{ backgroundImage: satTrack }}
          className="hsl-picker__range"
          aria-label="Saturation"
        />
        <span className="hsl-picker__val">{Math.round(hsl.s)}%</span>
      </div>
      <div className="hsl-picker__row">
        <span className="hsl-picker__label">L</span>
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={Math.round(hsl.l)}
          onChange={e => emit({ ...hsl, l: Number(e.target.value) })}
          style={{ backgroundImage: lightTrack }}
          className="hsl-picker__range"
          aria-label="Lightness"
        />
        <span className="hsl-picker__val">{Math.round(hsl.l)}%</span>
      </div>
    </div>
  );
}
