import type {
  SlideShape, ShapeElement, TableElement, GroupShapeElement, ArrowHead, GradientFill,
  SlideBackground, ThemeColors, ThemeFonts,
} from './pptxTypes';
import { parseColor, resolveDirectColor } from './pptxColor';
import { parseGradientFill, parseCustomGeometry } from './pptxGeometry';
import { parseRunProperties, parseBullet, parseTextBody, parseTextBodyProps } from './pptxTextParser';
import { parseTable } from './pptxTableParser';
import { EMU_PER_PIXEL } from '../shared/viewerConstants';

// ─── RelId Prefixing (prevent collision between slide/layout/master) ───

/** Deep-clone shapes and prefix all imageRelIds to avoid relId collisions */
export function prefixShapeRelIds(shapes: SlideShape[], prefix: string): SlideShape[] {
  const prefixRelId = (relId: string | undefined): string | undefined => {
    if (!relId) return relId;
    return `${prefix}:${relId}`;
  };

  const cloneShape = (shape: SlideShape): SlideShape => {
    if (shape.type === 'group') {
      const group = shape as GroupShapeElement;
      return {
        ...group,
        children: group.children.map(cloneShape),
      };
    } else if (shape.type === 'table') {
      return { ...shape }; // tables don't have imageRelId
    } else {
      const se = shape as ShapeElement;
      return {
        ...se,
        imageRelId: prefixRelId(se.imageRelId),
      };
    }
  };

  return shapes.map(cloneShape);
}

/** Prefix all keys in an imageMap */
export function prefixImageMap(imageMap: Map<string, string>, prefix: string): Map<string, string> {
  const prefixed = new Map<string, string>();
  for (const [id, src] of imageMap) {
    prefixed.set(`${prefix}:${id}`, src);
  }
  return prefixed;
}

// ─── Slide Background ───

export function parseSlideBackground(doc: Document, themeColors?: ThemeColors): SlideBackground | undefined {
  const bg = doc.getElementsByTagName('p:bg')[0];
  if (!bg) return undefined;

  const bgPr = bg.getElementsByTagName('p:bgPr')[0];
  if (bgPr) {
    const solidFill = bgPr.getElementsByTagName('a:solidFill')[0];
    if (solidFill) {
      return { color: parseColor(solidFill, themeColors) };
    }

    const gradFill = bgPr.getElementsByTagName('a:gradFill')[0];
    if (gradFill) {
      return { gradient: parseGradientFill(gradFill, themeColors) };
    }

    const blipFill = bgPr.getElementsByTagName('a:blipFill')[0];
    if (blipFill) {
      const blip = blipFill.getElementsByTagName('a:blip')[0];
      const relId = blip?.getAttribute('r:embed');
      if (relId) {
        return { imageRelId: relId };
      }
    }
  }

  const bgRef = bg.getElementsByTagName('p:bgRef')[0];
  if (bgRef) {
    const color = parseColor(bgRef, themeColors);
    if (color) return { color };
  }

  return undefined;
}

// ─── Shape Parsing ───

export function parseTransform(spPr: Element): { x: number; y: number; width: number; height: number; rotation?: number; flipH?: boolean; flipV?: boolean } | null {
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
  const rotation = rot ? parseInt(rot) / 60000 : undefined;

  const flipH = xfrm.getAttribute('flipH') === '1';
  const flipV = xfrm.getAttribute('flipV') === '1';

  return { x, y, width, height, rotation, flipH: flipH || undefined, flipV: flipV || undefined };
}

export function resolveRelPath(basePath: string, target: string): string {
  if (target.startsWith('/')) return target.substring(1);
  const parts = basePath.split('/');
  parts.pop();
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

export function parseArrowHead(endEl: Element | null): ArrowHead | undefined {
  if (!endEl) return undefined;
  const type = endEl.getAttribute('type');
  if (!type || type === 'none') return undefined;
  return {
    type: type as ArrowHead['type'],
    w: (endEl.getAttribute('w') || 'med') as ArrowHead['w'],
    len: (endEl.getAttribute('len') || 'med') as ArrowHead['len'],
  };
}

// Parse p:style for fill/line/font references
export function parseShapeStyle(sp: Element, themeColors?: ThemeColors): { fillColor?: string; lineColor?: string; fontColor?: string; fontRefIdx?: string } {
  const style = sp.getElementsByTagName('p:style')[0];
  if (!style) return {};
  const result: { fillColor?: string; lineColor?: string; fontColor?: string; fontRefIdx?: string } = {};

  const fillRef = style.getElementsByTagName('a:fillRef')[0];
  const fillRefIdx = fillRef ? parseInt(fillRef.getAttribute('idx') || '0') : -1;

  // Debug: always log fillRef info for shapes with p:style
  const cNvPr = sp.getElementsByTagName('p:cNvPr')[0];
  const spName = cNvPr?.getAttribute('name') || '';
  if (spName.includes('\uC721\uAC01\uD615') || spName.includes('hexagon')) {
    console.log('[PptxViewer] parseShapeStyle for hexagon:', {
      spName,
      hasStyle: true,
      hasFillRef: !!fillRef,
      fillRefIdx,
      fillRefXml: fillRef?.outerHTML?.substring(0, 500)
    });
  }

  if (fillRef && fillRefIdx > 0) {
    result.fillColor = parseColor(fillRef, themeColors);
    // Debug: log fillRef details if color couldn't be parsed
    if (!result.fillColor) {
      const schemeClr = fillRef.getElementsByTagName('a:schemeClr')[0];
      const srgbClr = fillRef.getElementsByTagName('a:srgbClr')[0];
      console.log('[PptxViewer] fillRef color not parsed:', {
        idx: fillRefIdx,
        hasSchemeClr: !!schemeClr,
        schemeVal: schemeClr?.getAttribute('val'),
        hasSrgbClr: !!srgbClr,
        srgbVal: srgbClr?.getAttribute('val'),
        themeColorKeys: themeColors ? Object.keys(themeColors) : [],
        fillRefXml: fillRef.outerHTML?.substring(0, 300)
      });
    }
  }

  const lnRef = style.getElementsByTagName('a:lnRef')[0];
  if (lnRef) {
    const idx = parseInt(lnRef.getAttribute('idx') || '0');
    if (idx > 0) {
      result.lineColor = parseColor(lnRef, themeColors);
    }
  }

  const fontRef = style.getElementsByTagName('a:fontRef')[0];
  if (fontRef) {
    result.fontColor = parseColor(fontRef, themeColors);
    result.fontRefIdx = fontRef.getAttribute('idx') || undefined;
  }

  return result;
}

export function parseShapeTree(parent: Element, rels: Map<string, string>, depth: number, themeColors?: ThemeColors, skipPlaceholders = false, themeFonts?: ThemeFonts, groupFill?: string | GradientFill): SlideShape[] {
  const MAX_GROUP_DEPTH = 6;

  // CRITICAL: Process ALL drawable children in document order (= z-order).
  // Previously collected by type (all sp, then all pic, etc.) which broke z-order.
  const orderedChildren: { el: Element; tag: string }[] = [];
  const drawableTags = new Set(['p:sp', 'p:pic', 'p:graphicFrame', 'p:cxnSp', 'p:grpSp']);
  for (let i = 0; i < parent.children.length; i++) {
    const child = parent.children[i];
    if (drawableTags.has(child.tagName)) {
      orderedChildren.push({ el: child, tag: child.tagName });
    } else if (child.tagName === 'mc:AlternateContent') {
      // Prefer mc:Fallback for browser compatibility -- mc:Choice often requires
      // WDP/EMF or other formats that browsers cannot render.
      let fallback: Element | null = null;
      let choice: Element | null = null;
      for (let j = 0; j < child.children.length; j++) {
        if (child.children[j].tagName === 'mc:Fallback') fallback = child.children[j];
        else if (child.children[j].tagName === 'mc:Choice') choice = child.children[j];
      }
      const container = fallback || choice;
      if (container) {
        for (let j = 0; j < container.children.length; j++) {
          const cc = container.children[j];
          if (drawableTags.has(cc.tagName)) {
            orderedChildren.push({ el: cc, tag: cc.tagName });
          }
        }
      }
    }
  }

  const shapes: SlideShape[] = [];

  for (const { el: currentEl, tag } of orderedChildren) {

  // ─── p:sp ───
  if (tag === 'p:sp') {
    const sp = currentEl;
    const nvSpPr = sp.getElementsByTagName('p:nvSpPr')[0];

    // Log each p:sp element being processed
    const cNvPr = nvSpPr?.getElementsByTagName('p:cNvPr')[0];
    const shapeName = cNvPr?.getAttribute('name') || '(unnamed)';
    const shapeId = cNvPr?.getAttribute('id') || '?';
    console.log(`[PptxViewer] Processing p:sp: id=${shapeId}, name="${shapeName}", skipPlaceholders=${skipPlaceholders}`);

    if (nvSpPr) {
      const nvPr = nvSpPr.getElementsByTagName('p:nvPr')[0];
      const phEl = nvPr?.getElementsByTagName('p:ph')[0];
      if (phEl) {
        if (skipPlaceholders) {
          // For layout/master: Skip placeholders with INSTRUCTIONAL TEXT
          // Keep placeholders that are DECORATIVE (have fill but no text)
          const txBody = sp.getElementsByTagName('p:txBody')[0];
          const placeholderText = txBody?.textContent?.trim();

          // Check for visual fill (direct or via style reference)
          const spPrCheck = sp.getElementsByTagName('p:spPr')[0];
          const hasDirectFill = spPrCheck && (
            spPrCheck.getElementsByTagName('a:solidFill')[0] ||
            spPrCheck.getElementsByTagName('a:gradFill')[0] ||
            spPrCheck.getElementsByTagName('a:blipFill')[0] ||
            spPrCheck.getElementsByTagName('a:pattFill')[0]
          );

          // Check p:style for fill reference (many decorative elements use this)
          const styleEl = sp.getElementsByTagName('p:style')[0];
          const fillRefEl = styleEl?.getElementsByTagName('a:fillRef')[0];
          const hasStyleFill = fillRefEl && parseInt(fillRefEl.getAttribute('idx') || '0') > 0;

          const hasFill = hasDirectFill || hasStyleFill;
          const phType = phEl.getAttribute('type') || '(none)';

          console.log('[PptxViewer] Placeholder check:', {
            type: phType,
            hasText: !!placeholderText,
            textPreview: placeholderText?.substring(0, 30),
            hasDirectFill: !!hasDirectFill,
            hasStyleFill: !!hasStyleFill,
            decision: placeholderText ? 'SKIP(text)' : (!hasFill ? 'SKIP(noFill)' : 'KEEP')
          });

          // Decision logic:
          // - Has text (instructional) -> SKIP
          // - No text, has fill -> KEEP (decorative element)
          // - No text, no fill -> SKIP (empty placeholder box)
          if (placeholderText) {
            console.log(`[PptxViewer] SKIP p:sp id=${shapeId} name="${shapeName}" - placeholder with text`);
            continue;
          }
          if (!hasFill) {
            console.log(`[PptxViewer] SKIP p:sp id=${shapeId} name="${shapeName}" - placeholder with no fill`);
            continue;
          }
          console.log(`[PptxViewer] KEEP p:sp id=${shapeId} name="${shapeName}" - decorative placeholder with fill`);
          // Otherwise: decorative placeholder with fill, keep it
        } else {
          // On slide: render placeholder text but skip if no text content
          const txBody = sp.getElementsByTagName('p:txBody')[0];
          if (!txBody) continue;
          const hasText = txBody.textContent?.trim();
          if (!hasText) continue;
        }
      }
    }

    const spPr = sp.getElementsByTagName('p:spPr')[0];
    const txBody = sp.getElementsByTagName('p:txBody')[0];

    if (!spPr) {
      console.log(`[PptxViewer] SKIP p:sp id=${shapeId} name="${shapeName}" - no spPr`);
      continue;
    }

    // Debug: log full p:sp XML for hexagons to see if there's a fill we're missing
    if (shapeName.includes('\uC721\uAC01\uD615') || shapeName.includes('hexagon')) {
      console.log(`[PptxViewer] Hexagon FULL p:sp XML:`, sp.outerHTML?.substring(0, 2000));
    }

    const transform = parseTransform(spPr);
    if (!transform) {
      console.log(`[PptxViewer] SKIP p:sp id=${shapeId} name="${shapeName}" - no transform (xfrm)`);
      continue;
    }

    // If we got here, shape has spPr and transform
    const shape: ShapeElement = {
          type: 'shape',
          ...transform,
        };

        const prstGeom = spPr.getElementsByTagName('a:prstGeom')[0];
        if (prstGeom) {
          shape.shapeType = prstGeom.getAttribute('prst') || undefined;
        }

        // Fill: check DIRECT children of spPr only (not inside a:ln)
        let solidFill: Element | null = null;
        let noFill: Element | null = null;
        let gradFill: Element | null = null;
        let blipFill: Element | null = null;
        let grpFill: Element | null = null;
        for (let fi = 0; fi < spPr.children.length; fi++) {
          const child = spPr.children[fi];
          if (child.tagName === 'a:solidFill') solidFill = child;
          else if (child.tagName === 'a:noFill') noFill = child;
          else if (child.tagName === 'a:gradFill') gradFill = child;
          else if (child.tagName === 'a:blipFill') blipFill = child;
          else if (child.tagName === 'a:grpFill') grpFill = child;
        }

        if (solidFill) {
          shape.backgroundColor = parseColor(solidFill, themeColors);
          // Debug: log if solid fill was found but color couldn't be parsed
          if (!shape.backgroundColor) {
            const schemeClr = solidFill.getElementsByTagName('a:schemeClr')[0];
            const srgbClr = solidFill.getElementsByTagName('a:srgbClr')[0];
            console.log(`[PptxViewer] solidFill found but no color parsed:`, {
              shapeName, shapeId,
              hasSchemeClr: !!schemeClr,
              schemeVal: schemeClr?.getAttribute('val'),
              hasSrgbClr: !!srgbClr,
              srgbVal: srgbClr?.getAttribute('val'),
              themeColorsAvailable: !!themeColors,
              solidFillXml: solidFill.outerHTML?.substring(0, 200)
            });
          }
        }

        if (gradFill) {
          shape.gradientFill = parseGradientFill(gradFill, themeColors);
        }

        // a:grpFill - inherit fill from parent group
        if (grpFill) {
          if (groupFill) {
            console.log(`[PptxViewer] Shape "${shapeName}" has a:grpFill, inheriting from parent group:`, groupFill);
            if (typeof groupFill === 'string') {
              shape.backgroundColor = groupFill;
            } else {
              shape.gradientFill = groupFill;
            }
          } else {
            console.log(`[PptxViewer] Shape "${shapeName}" has a:grpFill but NO groupFill was passed - check parent group!`);
          }
        }

        // Shape image fill (a:blipFill in p:spPr)
        if (blipFill) {
          const blip = blipFill.getElementsByTagName('a:blip')[0];
          const relId = blip?.getAttribute('r:embed') || blip?.getAttribute('r:link');
          if (relId) {
            shape.type = 'image';
            shape.imageRelId = relId;
            // Parse srcRect for crop
            const srcRect = blipFill.getElementsByTagName('a:srcRect')[0];
            if (srcRect) {
              shape.imageCrop = {
                left: parseInt(srcRect.getAttribute('l') || '0') / 1000,
                top: parseInt(srcRect.getAttribute('t') || '0') / 1000,
                right: parseInt(srcRect.getAttribute('r') || '0') / 1000,
                bottom: parseInt(srcRect.getAttribute('b') || '0') / 1000,
              };
            }
          }
        }

        // Border/outline
        const ln = spPr.getElementsByTagName('a:ln')[0];
        let hasExplicitLine = false;
        if (ln) {
          hasExplicitLine = true;
          // Check if line has noFill (explicitly invisible)
          let lnNoFill = false;
          for (let lni = 0; lni < ln.childNodes.length; lni++) {
            if (ln.childNodes[lni].nodeType === 1 && (ln.childNodes[lni] as Element).tagName === 'a:noFill') {
              lnNoFill = true;
              break;
            }
          }
          if (!lnNoFill) {
            const lnFill = ln.getElementsByTagName('a:solidFill')[0];
            if (lnFill) {
              shape.borderColor = parseColor(lnFill, themeColors);
            }
            const lnWidth = parseInt(ln.getAttribute('w') || '0') / EMU_PER_PIXEL;
            if (lnWidth > 0) {
              shape.borderWidth = lnWidth;
            } else if (shape.borderColor) {
              // Line has fill but no explicit width -- use default 1px
              shape.borderWidth = 1;
            }
          }
          const prstDash = ln.getElementsByTagName('a:prstDash')[0];
          if (prstDash) {
            shape.dashStyle = prstDash.getAttribute('val') || undefined;
          }
        }

        // Shadow effects
        const effectLst = spPr.getElementsByTagName('a:effectLst')[0];
        if (effectLst) {
          const outerShdw = effectLst.getElementsByTagName('a:outerShdw')[0];
          const innerShdw = effectLst.getElementsByTagName('a:innerShdw')[0];
          const shdw = outerShdw || innerShdw;
          if (shdw) {
            const blurRad = parseInt(shdw.getAttribute('blurRad') || '0') / EMU_PER_PIXEL;
            const dist = parseInt(shdw.getAttribute('dist') || '0') / EMU_PER_PIXEL;
            const dir = parseInt(shdw.getAttribute('dir') || '0') / 60000;
            const dirRad = (dir * Math.PI) / 180;
            const shdwColor = parseColor(shdw, themeColors) || 'rgba(0,0,0,0.3)';
            shape.shadow = {
              offsetX: Math.round(Math.cos(dirRad) * dist * 10) / 10,
              offsetY: Math.round(Math.sin(dirRad) * dist * 10) / 10,
              blur: Math.round(blurRad * 10) / 10,
              color: shdwColor,
              inset: !!innerShdw && !outerShdw,
            };
          }
        }

        // Custom geometry
        if (!prstGeom) {
          const custGeom = spPr.getElementsByTagName('a:custGeom')[0];
          if (custGeom) {
            const pathLst = custGeom.getElementsByTagName('a:pathLst')[0];
            if (pathLst) shape.customPath = parseCustomGeometry(pathLst, shape.width, shape.height);
          }
        }

        // Parse adjustment values (avLst) for preset shapes
        if (prstGeom) {
          const avLst = prstGeom.getElementsByTagName('a:avLst')[0];
          if (avLst) {
            const adjustValues: Record<string, number> = {};
            const gds = avLst.getElementsByTagName('a:gd');
            for (let g = 0; g < gds.length; g++) {
              const name = gds[g].getAttribute('name') || '';
              const fmla = gds[g].getAttribute('fmla') || '';
              const valMatch = fmla.match(/val\s+(-?\d+)/);
              if (valMatch) adjustValues[name] = parseInt(valMatch[1]);
            }
            shape.adjustValues = adjustValues;
          }
        }

        // p:style fallback for fill (only if no explicit fill type is specified)
        if (!solidFill && !gradFill && !noFill && !blipFill && !grpFill) {
          const styleColors = parseShapeStyle(sp, themeColors);
          console.log(`[PptxViewer] No direct fill, trying p:style fallback:`, {
            shapeName, shapeId,
            styleFillColor: styleColors.fillColor,
            hasStyle: !!sp.getElementsByTagName('p:style')[0]
          });
          if (styleColors.fillColor && !shape.backgroundColor) {
            shape.backgroundColor = styleColors.fillColor;
          }
        }
        // p:style fallback for line (independent of fill, but only if no explicit a:ln)
        if (!hasExplicitLine && !shape.borderColor) {
          const styleColors = parseShapeStyle(sp, themeColors);
          if (styleColors.lineColor) {
            shape.borderColor = styleColors.lineColor;
            if (!shape.borderWidth) shape.borderWidth = 1;
          }
        }

        // Text content
        if (txBody) {
          shape.paragraphs = parseTextBody(txBody, themeColors, themeFonts);
          shape.textBody = parseTextBodyProps(txBody);

          // Apply defaults from p:style (fontRef color + font family)
          const styleColors = parseShapeStyle(sp, themeColors);
          if (shape.paragraphs.length > 0) {
            // Resolve default font from fontRef idx (major/minor -> theme font)
            let defaultFont: string | undefined;
            if (styleColors.fontRefIdx && themeFonts) {
              if (styleColors.fontRefIdx === 'major') {
                defaultFont = themeFonts.majorLatin || themeFonts.majorEA || undefined;
              } else if (styleColors.fontRefIdx === 'minor') {
                defaultFont = themeFonts.minorLatin || themeFonts.minorEA || undefined;
              }
            }

            // Parse lstStyle defaults (a:lstStyle > a:lvl1pPr > a:defRPr)
            const lstStyle = txBody.getElementsByTagName('a:lstStyle')[0];
            const lstDefaults: Partial<import('./pptxTypes').TextRun>[] = [];
            const lstBullets: (string | undefined)[] = [];
            if (lstStyle) {
              for (let lvl = 1; lvl <= 9; lvl++) {
                const lvlPPr = lstStyle.getElementsByTagName(`a:lvl${lvl}pPr`)[0];
                if (lvlPPr) {
                  const defRPr = lvlPPr.getElementsByTagName('a:defRPr')[0];
                  lstDefaults[lvl - 1] = defRPr ? parseRunProperties(defRPr, themeColors, themeFonts) : {};
                  // Parse bullet from lstStyle level
                  const bullet = parseBullet(lvlPPr);
                  lstBullets[lvl - 1] = bullet.bulletChar;
                }
              }
            }

            for (const para of shape.paragraphs) {
              const level = para.level || 0;
              const lstDefault = lstDefaults[level] || lstDefaults[0];
              // Apply lstStyle bullet if paragraph has no explicit bullet and has actual text
              const hasTextContent = para.runs.some(r => r.text && r.text.trim().length > 0);
              if (!para.bulletChar && hasTextContent && (lstBullets[level] !== undefined || lstBullets[0] !== undefined)) {
                para.bulletChar = lstBullets[level] || lstBullets[0];
              }
              for (const run of para.runs) {
                // Apply lstStyle defaults
                if (lstDefault) {
                  if (!run.color && lstDefault.color) run.color = lstDefault.color;
                  if (!run.fontFamily && lstDefault.fontFamily) run.fontFamily = lstDefault.fontFamily;
                  if (run.fontSize === undefined && lstDefault.fontSize) run.fontSize = lstDefault.fontSize;
                  if (run.letterSpacing === undefined && lstDefault.letterSpacing !== undefined) run.letterSpacing = lstDefault.letterSpacing;
                }
                // Apply p:style fontRef color
                if (!run.color && styleColors.fontColor) run.color = styleColors.fontColor;
                // Apply default font from fontRef
                if (!run.fontFamily && defaultFont) run.fontFamily = defaultFont;
                // Final fallback: theme minor font for shapes with no fontRef at all
                if (!run.fontFamily && themeFonts) {
                  run.fontFamily = themeFonts.minorLatin || themeFonts.minorEA || undefined;
                }
              }
            }
          }

          // Parse hyperlinks
          const runs = txBody.getElementsByTagName('a:r');
          let runIdx = 0;
          for (let ri = 0; ri < runs.length; ri++) {
            const rPr = runs[ri].getElementsByTagName('a:rPr')[0];
            if (rPr) {
              const hlinkClick = rPr.getElementsByTagName('a:hlinkClick')[0];
              if (hlinkClick) {
                const rId = hlinkClick.getAttribute('r:id');
                if (rId) {
                  const url = rels.get(rId);
                  if (url && shape.paragraphs) {
                    let totalRuns = 0;
                    for (const para of shape.paragraphs) {
                      for (const run of para.runs) {
                        if (totalRuns === runIdx && url) {
                          run.hyperlink = url;
                        }
                        totalRuns++;
                      }
                    }
                  }
                }
              }
            }
            runIdx++;
          }
        }

        // Include shapes with visible content OR background/border/geometry
        // For layout/master shapes, be more permissive - include if they have a valid transform
        const hasText = shape.paragraphs && shape.paragraphs.some(p => p.runs.some(r => r.text.length > 0));
        const hasVisual = shape.backgroundColor || shape.gradientFill || shape.borderColor || shape.imageRelId || shape.customPath || shape.shapeType;
        const hasValidTransform = shape.width > 0 && shape.height > 0;
        if (skipPlaceholders) {
          console.log('[PptxViewer] Layout/Master shape:', {
            type: shape.type, shapeType: shape.shapeType,
            x: Math.round(shape.x), y: Math.round(shape.y),
            w: Math.round(shape.width), h: Math.round(shape.height),
            bg: shape.backgroundColor, grad: !!shape.gradientFill,
            border: shape.borderColor, hasText, hasVisual, hasValidTransform
          });
        }
        if (hasText || hasVisual || (skipPlaceholders && hasValidTransform)) {
          shapes.push(shape);
        }
  }

  // ─── p:pic ───
  else if (tag === 'p:pic') {
    const pic = currentEl;
    const spPr = pic.getElementsByTagName('p:spPr')[0];
    const blipFill = pic.getElementsByTagName('p:blipFill')[0];

    if (spPr && blipFill) {
      const transform = parseTransform(spPr);
      const blip = blipFill.getElementsByTagName('a:blip')[0];
      const relId = blip?.getAttribute('r:embed') || blip?.getAttribute('r:link');

      if (transform && relId) {
        const shape: ShapeElement = {
          type: 'image',
          ...transform,
          imageRelId: relId,
        };

        // Parse srcRect for cropping
        const srcRect = blipFill.getElementsByTagName('a:srcRect')[0];
        if (srcRect) {
          shape.imageCrop = {
            left: parseInt(srcRect.getAttribute('l') || '0') / 1000,
            top: parseInt(srcRect.getAttribute('t') || '0') / 1000,
            right: parseInt(srcRect.getAttribute('r') || '0') / 1000,
            bottom: parseInt(srcRect.getAttribute('b') || '0') / 1000,
          };
        }

        // Parse duotone effect from blip
        if (blip) {
          const duotone = blip.getElementsByTagName('a:duotone')[0];
          if (duotone) {
            const colors: string[] = [];
            for (let di = 0; di < duotone.childNodes.length; di++) {
              const dChild = duotone.childNodes[di];
              if (dChild.nodeType !== 1) continue;
              // duotone children are direct color elements -- use parseColor on duotone as container
              // but duotone has multiple color children, so we wrap each in a temp approach
              const c = resolveDirectColor(dChild as Element, themeColors);
              if (c) colors.push(c);
            }
            if (colors.length >= 2) {
              shape.duotoneColors = [colors[0], colors[1]];
            }
          }
        }

        shapes.push(shape);
      }
    }
  }

  // ─── p:graphicFrame ───
  else if (tag === 'p:graphicFrame') {
    const gf = currentEl;
    const xfrm = gf.getElementsByTagName('p:xfrm')[0];
    const graphicData = gf.getElementsByTagName('a:graphicData')[0];

    if (xfrm && graphicData) {
      const uri = graphicData.getAttribute('uri') || '';
      const off = xfrm.getElementsByTagName('a:off')[0];
      const ext = xfrm.getElementsByTagName('a:ext')[0];
      const gfX = off ? parseInt(off.getAttribute('x') || '0') / EMU_PER_PIXEL : 0;
      const gfY = off ? parseInt(off.getAttribute('y') || '0') / EMU_PER_PIXEL : 0;
      const gfW = ext ? parseInt(ext.getAttribute('cx') || '0') / EMU_PER_PIXEL : 200;
      const gfH = ext ? parseInt(ext.getAttribute('cy') || '0') / EMU_PER_PIXEL : 100;

      if (uri.includes('/chart') || uri.includes('/diagram')) {
        // Try to find a fallback image via the graphic frame's relationships
        const nvGfPr = gf.getElementsByTagName('p:nvGraphicFramePr')[0];
        const nvPr = nvGfPr?.getElementsByTagName('p:nvPr')[0];
        const extLst = nvPr?.getElementsByTagName('p:extLst')[0];
        let fallbackImageRelId: string | undefined;

        // Check for diagram/chart image fallback via r:id in relationships
        if (extLst) {
          const exts = extLst.getElementsByTagName('p:ext');
          for (let ei = 0; ei < exts.length; ei++) {
            const relIdVal = exts[ei].getElementsByTagName('r:id')?.[0]?.getAttribute('r:id') ||
                          exts[ei].getAttribute('r:id');
            if (relIdVal && rels.has(relIdVal)) {
              const target = rels.get(relIdVal)!;
              if (target.includes('media/') || target.includes('image')) {
                fallbackImageRelId = relIdVal;
                break;
              }
            }
          }
        }

        if (fallbackImageRelId) {
          shapes.push({
            type: 'image', x: gfX, y: gfY, width: gfW, height: gfH,
            imageRelId: fallbackImageRelId,
          });
        } else {
          const label = uri.includes('/chart') ? '[\uCC28\uD2B8]' : '[SmartArt]';
          shapes.push({
            type: 'shape', x: gfX, y: gfY, width: gfW, height: gfH,
            paragraphs: [{ runs: [{ text: label, fontSize: 10, color: '#888' }], align: 'center' }],
            backgroundColor: '#f8f8f8', borderColor: '#ddd', borderWidth: 1,
          });
        }
        continue;
      }

      const table = parseTable(graphicData, themeColors, themeFonts);
      if (table) {
        table.x = gfX;
        table.y = gfY;
        table.frameHeight = gfH;
        // Scale column widths to match graphicFrame width
        if (gfW > 0 && table.width > 0 && Math.abs(table.width - gfW) > 2) {
          const scale = gfW / table.width;
          table.colWidths = table.colWidths.map(w => w * scale);
          table.width = gfW;
        }
        shapes.push(table);
      }
    }
  }

  // ─── p:cxnSp ───
  else if (tag === 'p:cxnSp') {
    const cxn = currentEl;
    const spPr = cxn.getElementsByTagName('p:spPr')[0];

    if (spPr) {
      const transform = parseTransform(spPr);
      if (transform) {
        const ln = spPr.getElementsByTagName('a:ln')[0];
        let borderColor = '#000000';
        let borderWidth = 1;
        let headEnd: ArrowHead | undefined;
        let tailEnd: ArrowHead | undefined;
        let dashStyle: string | undefined;

        if (ln) {
          borderWidth = parseInt(ln.getAttribute('w') || '12700') / EMU_PER_PIXEL;
          const lnFill = ln.getElementsByTagName('a:solidFill')[0];
          if (lnFill) {
            borderColor = parseColor(lnFill, themeColors) || '#000000';
          } else {
            // p:style fallback for connector color
            const styleColors = parseShapeStyle(cxn, themeColors);
            if (styleColors.lineColor) borderColor = styleColors.lineColor;
          }
          headEnd = parseArrowHead(ln.getElementsByTagName('a:headEnd')[0]);
          tailEnd = parseArrowHead(ln.getElementsByTagName('a:tailEnd')[0]);
          const prstDash = ln.getElementsByTagName('a:prstDash')[0];
          if (prstDash) dashStyle = prstDash.getAttribute('val') || undefined;
        }

        // Parse connector type and adjustment values
        const prstGeom = spPr.getElementsByTagName('a:prstGeom')[0];
        const connectorType = prstGeom?.getAttribute('prst') || 'straightConnector1';
        const adjustValues: Record<string, number> = {};
        const avLst = prstGeom?.getElementsByTagName('a:avLst')[0];
        if (avLst) {
          const gds = avLst.getElementsByTagName('a:gd');
          for (let g = 0; g < gds.length; g++) {
            const name = gds[g].getAttribute('name') || '';
            const fmla = gds[g].getAttribute('fmla') || '';
            const valMatch = fmla.match(/val\s+(-?\d+)/);
            if (valMatch) adjustValues[name] = parseInt(valMatch[1]) / 100000;
          }
        }

        shapes.push({
          type: 'line',
          ...transform,
          borderColor,
          borderWidth,
          headEnd,
          tailEnd,
          dashStyle,
          connectorType,
          adjustValues,
        });
      }
    }
  }

  // ─── p:grpSp ───
  else if (tag === 'p:grpSp' && depth < MAX_GROUP_DEPTH) {
    const grpSp = currentEl;
    {
      const grpSpPr = grpSp.getElementsByTagName('p:grpSpPr')[0];
      if (!grpSpPr) continue;

      const xfrm = grpSpPr.getElementsByTagName('a:xfrm')[0];
      if (!xfrm) continue;

      const off = xfrm.getElementsByTagName('a:off')[0];
      const ext = xfrm.getElementsByTagName('a:ext')[0];
      const chOff = xfrm.getElementsByTagName('a:chOff')[0];
      const chExt = xfrm.getElementsByTagName('a:chExt')[0];

      if (!off || !ext || !chOff || !chExt) continue;

      // Extract this group's fill to pass down to children with a:grpFill
      let thisGroupFill: string | GradientFill | undefined;

      // Check if this group has its own fill or inherits from parent
      const grpSolidFill = grpSpPr.getElementsByTagName('a:solidFill')[0];
      const grpGradFill = grpSpPr.getElementsByTagName('a:gradFill')[0];
      const grpGrpFill = grpSpPr.getElementsByTagName('a:grpFill')[0];

      if (grpSolidFill) {
        thisGroupFill = parseColor(grpSolidFill, themeColors);
        console.log('[PptxViewer] Group has solidFill:', thisGroupFill);
      } else if (grpGradFill) {
        thisGroupFill = parseGradientFill(grpGradFill, themeColors);
        console.log('[PptxViewer] Group has gradFill:', thisGroupFill);
      } else if (grpGrpFill && groupFill) {
        // This group inherits from its parent group
        thisGroupFill = groupFill;
        console.log('[PptxViewer] Group inherits from parent via a:grpFill:', thisGroupFill);
      } else {
        // Debug: log when no group fill found
        console.log('[PptxViewer] Group has no fill to pass down. grpSpPr XML:', grpSpPr.outerHTML?.substring(0, 500));
      }

      const group: GroupShapeElement = {
        type: 'group',
        x: parseInt(off.getAttribute('x') || '0') / EMU_PER_PIXEL,
        y: parseInt(off.getAttribute('y') || '0') / EMU_PER_PIXEL,
        width: parseInt(ext.getAttribute('cx') || '0') / EMU_PER_PIXEL,
        height: parseInt(ext.getAttribute('cy') || '0') / EMU_PER_PIXEL,
        childOffsetX: parseInt(chOff.getAttribute('x') || '0') / EMU_PER_PIXEL,
        childOffsetY: parseInt(chOff.getAttribute('y') || '0') / EMU_PER_PIXEL,
        childExtX: parseInt(chExt.getAttribute('cx') || '0') / EMU_PER_PIXEL,
        childExtY: parseInt(chExt.getAttribute('cy') || '0') / EMU_PER_PIXEL,
        children: parseShapeTree(grpSp, rels, depth + 1, themeColors, skipPlaceholders, themeFonts, thisGroupFill),
      };

      const rot = xfrm.getAttribute('rot');
      if (rot) group.rotation = parseInt(rot) / 60000;
      if (xfrm.getAttribute('flipH') === '1') group.flipH = true;
      if (xfrm.getAttribute('flipV') === '1') group.flipV = true;

      shapes.push(group);
    }
  }

  } // end for orderedChildren

  return shapes;
}
