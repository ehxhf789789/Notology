import type { TextRun, NumberingDef, NumberingLevel, StyleNumMap } from './docxTypes';
import { getElements, getElement, getVal, getAttr } from './docxXmlHelpers';
import { TWIP_PER_PIXEL, log } from '../shared/viewerConstants';
import { parseRunProps } from './docxContentParser';

// ==================== Step 6: Numbering ====================

export function parseNumbering(xml: Document): { numbering: Map<string, NumberingDef>; styleNumMap: StyleNumMap } {
  const numbering = new Map<string, NumberingDef>();
  const styleNumMap: StyleNumMap = new Map();
  const abstractNums = getElements(xml.documentElement, 'w:abstractNum');
  const nums = getElements(xml.documentElement, 'w:num');

  const abstractMap = new Map<string, { def: NumberingDef; pStyles: Array<{ styleId: string; ilvl: number }> }>();

  for (const absNum of abstractNums) {
    const abstractNumId = getAttr(absNum, 'abstractNumId');
    if (!abstractNumId) continue;

    const levels = new Map<number, NumberingLevel>();
    const pStyles: Array<{ styleId: string; ilvl: number }> = [];
    const lvlEls = getElements(absNum, 'w:lvl');

    for (const lvl of lvlEls) {
      const ilvl = parseInt(getAttr(lvl, 'ilvl') || '0');
      const numFmt = getVal(getElement(lvl, 'w:numFmt')) || 'decimal';
      const lvlText = getVal(getElement(lvl, 'w:lvlText')) || '';
      const startEl = getElement(lvl, 'w:start');
      const startVal = startEl ? parseInt(getVal(startEl) || '1') : 1;

      // Parse w:pStyle — links a paragraph style to this numbering level
      const pStyleEl = getElement(lvl, 'w:pStyle');
      const pStyleVal = pStyleEl ? getVal(pStyleEl) : undefined;
      if (pStyleVal) {
        pStyles.push({ styleId: pStyleVal, ilvl });
      }

      // Parse indent from level's pPr
      const pPrEl = getElement(lvl, 'w:pPr');
      const indEl = pPrEl ? getElement(pPrEl, 'w:ind') : null;
      const indLeft = indEl ? parseInt(getAttr(indEl, 'left') || getAttr(indEl, 'start') || '0') / TWIP_PER_PIXEL : 0;
      const indHanging = indEl ? parseInt(getAttr(indEl, 'hanging') || '0') / TWIP_PER_PIXEL : 0;

      // Parse w:rPr from level — direct formatting for numbering text
      const lvlRPr = getElement(lvl, 'w:rPr');
      const lvlRunProps = lvlRPr ? parseRunProps(lvlRPr) : undefined;

      levels.set(ilvl, { format: numFmt, text: lvlText, indent: indLeft, hanging: indHanging, pStyle: pStyleVal ?? undefined, start: startVal, runProps: lvlRunProps });
    }

    abstractMap.set(abstractNumId, { def: { levels, abstractNumId }, pStyles });
  }

  for (const num of nums) {
    const numId = getAttr(num, 'numId');
    const abstractNumIdEl = getElement(num, 'w:abstractNumId');
    const abstractNumId = getVal(abstractNumIdEl);

    if (numId && abstractNumId && abstractMap.has(abstractNumId)) {
      const entry = abstractMap.get(abstractNumId)!;

      // Check for w:lvlOverride — per-numId overrides of abstractNum levels
      // Most importantly: w:startOverride changes the starting value for a level
      const lvlOverrides = getElements(num, 'w:lvlOverride');
      if (lvlOverrides.length > 0) {
        // Clone levels and apply overrides
        const clonedLevels = new Map<number, NumberingLevel>();
        for (const [k, v] of entry.def.levels) {
          clonedLevels.set(k, { ...v });
        }
        for (const override of lvlOverrides) {
          const overrideIlvl = parseInt(getAttr(override, 'ilvl') || '0');
          const startOverrideEl = getElement(override, 'w:startOverride');
          if (startOverrideEl) {
            const overrideVal = parseInt(getVal(startOverrideEl) || '1');
            const existing = clonedLevels.get(overrideIlvl);
            if (existing) {
              existing.start = overrideVal;
            }
          }
        }
        const overriddenDef: NumberingDef = { levels: clonedLevels, abstractNumId };
        numbering.set(numId, overriddenDef);
        log(`[DocxViewer] numId=${numId}: lvlOverride applied`, [...clonedLevels.entries()].map(([k, v]) => `ilvl${k}:start=${v.start}`));
      } else {
        numbering.set(numId, entry.def);
      }

      // Build reverse lookup: paragraphStyleId → { numId, ilvl }
      for (const ps of entry.pStyles) {
        styleNumMap.set(ps.styleId, { numId, ilvl: ps.ilvl });
      }
    }
  }

  // Log numbering definitions
  for (const [numId, def] of numbering) {
    const lvlInfo = [...def.levels.entries()].map(([ilvl, lvl]) => `ilvl${ilvl}:start=${lvl.start},fmt=${lvl.format}`).join(', ');
    log(`[DocxViewer] NUM-DEF: numId=${numId}, absId=${def.abstractNumId}, levels=[${lvlInfo}]`);
  }
  log('[DocxViewer] parseNumbering: styleNumMap entries:', [...styleNumMap.entries()].map(([k, v]) => `${k}→num${v.numId}/lvl${v.ilvl}`).join(', '));
  return { numbering, styleNumMap };
}

export function formatNumber(n: number, format: string): string {
  switch (format) {
    case 'decimal': return n.toString();
    case 'lowerLetter': return String.fromCharCode(96 + ((n - 1) % 26) + 1);
    case 'upperLetter': return String.fromCharCode(64 + ((n - 1) % 26) + 1);
    case 'lowerRoman': return toRoman(n).toLowerCase();
    case 'upperRoman': return toRoman(n);
    case 'decimalEnclosedCircle': return n >= 1 && n <= 20 ? String.fromCharCode(0x2460 + n - 1) : n.toString();
    case 'bullet': return '';
    default: return n.toString();
  }
}

export function toRoman(num: number): string {
  const vals = [1000, 900, 500, 400, 100, 90, 50, 40, 10, 9, 5, 4, 1];
  const syms = ['M', 'CM', 'D', 'CD', 'C', 'XC', 'L', 'XL', 'X', 'IX', 'V', 'IV', 'I'];
  let result = '';
  let n = num;
  for (let i = 0; i < vals.length; i++) {
    while (n >= vals[i]) { result += syms[i]; n -= vals[i]; }
  }
  return result;
}

export function resolveNumberingText(
  numId: string,
  ilvl: number,
  numbering: Map<string, NumberingDef>,
  counters: Map<string, number>
): { text: string; indent: number; hanging: number; runProps?: Partial<TextRun> } | null {
  const numDef = numbering.get(numId);
  if (!numDef) return null;
  const level = numDef.levels.get(ilvl);
  if (!level) return null;

  // Track counters by abstractNumId — Word shares counters across all numIds
  // that reference the same abstractNum (e.g., Heading1 numId=1 and Heading2 numId=2
  // both referencing abstractNum 0 should share level counters).
  const absId = numDef.abstractNumId;

  // Word implicit parent initialization:
  // When a sub-level entry (e.g., ilvl=1) appears before any parent-level entry (ilvl=0),
  // Word implies the parent counter is initialized at its start value.
  // Without this, the first explicit parent entry would get start instead of start+1.
  for (let l = 0; l < ilvl; l++) {
    const parentKey = `${absId}-${l}`;
    if (!counters.has(parentKey)) {
      const parentLevel = numDef.levels.get(l);
      const parentStart = parentLevel?.start || 1;
      counters.set(parentKey, parentStart);
    }
  }

  // Increment counter for this level (respect w:start value)
  const key = `${absId}-${ilvl}`;
  const startVal = level.start || 1;
  const count = (counters.get(key) || (startVal - 1)) + 1;
  counters.set(key, count);

  // Reset deeper levels
  for (let l = ilvl + 1; l <= 8; l++) {
    counters.delete(`${absId}-${l}`);
  }

  if (level.format === 'bullet') {
    return { text: level.text || '\u2022', indent: level.indent, hanging: level.hanging, runProps: level.runProps };
  }

  // Replace %1, %2, etc. with formatted numbers
  let text = level.text;
  for (let l = 0; l <= ilvl; l++) {
    const lCount = counters.get(`${absId}-${l}`) || 1;
    const levelDef = numDef.levels.get(l);
    const fmt = l === ilvl ? level.format : (levelDef?.format || 'decimal');
    text = text.replace(`%${l + 1}`, formatNumber(lCount, fmt));
  }

  return { text, indent: level.indent, hanging: level.hanging, runProps: level.runProps };
}
