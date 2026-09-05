import React, { useState, useEffect, useRef } from 'react';
import JSZip from 'jszip';
import { useViewerZoom } from '../shared/useViewerZoom';
import { MIN_ZOOM, MAX_ZOOM } from '../shared/viewerConstants';

import type { SlideData, ThemeColors, ThemeFonts, TableStyleDef, SlideShape, ShapeElement } from './pptxTypes';
import { parseThemeXml } from './pptxTheme';
import { parseTableStylesXml, getDefaultTableStyle } from './pptxTableParser';
import { prefixShapeRelIds, prefixImageMap, parseSlideBackground, parseShapeTree, resolveRelPath } from './pptxShapeParser';
import { parseSlideXml, parseRelsXml, parsePresentationXml } from './pptxParser';
import { PptxSlideContext, PptxShape, getSlideBackgroundStyle } from './PptxRenderHelpers';

export interface PptxViewerProps {
  data: ArrayBuffer;
}

// ─── Component ───

export function PptxViewer({ data }: PptxViewerProps) {
  const [slides, setSlides] = useState<SlideData[]>([]);
  const [slideImages, setSlideImages] = useState<Map<number, Map<string, string>>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [slideSize, setSlideSize] = useState({ width: 960, height: 540 });
  const [visibleSlide, setVisibleSlide] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  // 🔴 **100% 는 «1:1» 이지 «창에 맞춤» 이 아니다** (한빈님 2026-09-05:
  //    *"pptx 가 100% 인데 잘려서 나온다"*). 16:9 와이드 슬라이드는
  //    12,192,000 EMU ÷ 9525 = **1280px** 인데 호버 창 안쪽은 그보다 좁다.
  //    PDF 뷰어는 `fitWidth` 를 받았는데(`PdfJsViewer.tsx:80`) pptx 는 못 받았다 —
  //    **버그가 아니라 빠뜨린 기능**이고, 100% 배지가 「맞음」으로 읽혀 더 헷갈렸다.
  const [fitWidth, setFitWidth] = useState(true);
  const { zoom, setZoom, zoomRef } = useViewerZoom(scrollContainerRef, {
    onZoom: () => { setFitWidth(false); },
  });
  const slideRefs = useRef<(HTMLDivElement | null)[]>([]);
  const tableStylesRef = useRef<Map<string, TableStyleDef>>(new Map());

  useEffect(() => {
    const loadImagesFromRels = async (
      zip: JSZip, rels: Map<string, string>, basePath: string, imageMap: Map<string, string>
    ) => {
      const MIME_MAP: Record<string, string> = {
        'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'png': 'image/png',
        'gif': 'image/gif', 'svg': 'image/svg+xml', 'bmp': 'image/bmp',
        'tif': 'image/tiff', 'tiff': 'image/tiff', 'webp': 'image/webp',
      };
      const SKIP_FORMATS = new Set(['emf', 'wmf', 'wdp']);

      for (const [id, target] of rels) {
        if (imageMap.has(id)) continue;
        if (!target.includes('media/') && !target.includes('image')) continue;
        if (target.startsWith('http://') || target.startsWith('https://')) continue;

        const ext = target.split('.').pop()?.toLowerCase() || '';
        if (SKIP_FORMATS.has(ext)) continue;

        const resolvedPath = resolveRelPath(basePath, target);
        const imageFile = zip.file(resolvedPath);

        if (imageFile) {
          const imageData = await imageFile.async('base64');
          const mimeType = MIME_MAP[ext] || 'image/png';
          imageMap.set(id, `data:${mimeType};base64,${imageData}`);
        }
      }
    };

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

        // Parse theme
        let themeColors: ThemeColors | undefined;
        let themeFonts: ThemeFonts | undefined;
        const themeFile = zip.file('ppt/theme/theme1.xml');
        if (themeFile) {
          const themeXml = await themeFile.async('string');
          const themeData = parseThemeXml(themeXml);
          themeColors = themeData.colors;
          themeFonts = themeData.fonts;
          console.log('[PptxViewer] Theme colors - dk1:', themeColors.dk1, 'dk2:', themeColors.dk2, 'accent1:', themeColors.accent1);
          console.log('[PptxViewer] All theme colors:', JSON.stringify(themeColors));
        }

        // Parse table styles
        let tableStyles = new Map<string, TableStyleDef>();
        const tableStylesFile = zip.file('ppt/tableStyles.xml');
        if (tableStylesFile) {
          const tableStylesXml = await tableStylesFile.async('string');
          tableStyles = parseTableStylesXml(tableStylesXml, themeColors);
        }
        // Add default table style fallback
        const defaultStyleId = '{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}';
        if (!tableStyles.has(defaultStyleId)) {
          tableStyles.set(defaultStyleId, getDefaultTableStyle(themeColors));
        }
        tableStylesRef.current = tableStyles;

        // Layout and master caches
        const layoutCache = new Map<string, { background?: import('./pptxTypes').SlideBackground; shapes: SlideShape[]; imageMap: Map<string, string> }>();
        const masterCache = new Map<string, { background?: import('./pptxTypes').SlideBackground; shapes: SlideShape[]; imageMap: Map<string, string> }>();

        // Find and sort slide files
        const slideFiles: string[] = [];
        zip.forEach((path) => {
          if (path.match(/^ppt\/slides\/slide\d+\.xml$/)) {
            slideFiles.push(path);
          }
        });

        slideFiles.sort((a, b) => {
          const numA = parseInt(a.match(/slide(\d+)/)?.[1] || '0');
          const numB = parseInt(b.match(/slide(\d+)/)?.[1] || '0');
          return numA - numB;
        });

        // Parse each slide
        for (let i = 0; i < slideFiles.length; i++) {
          const slidePath = slideFiles[i];
          const slideXml = await zip.file(slidePath)?.async('string');
          if (!slideXml) continue;

          const slideNum = slidePath.match(/slide(\d+)/)?.[1];
          const relsPath = `ppt/slides/_rels/slide${slideNum}.xml.rels`;
          const relsXml = await zip.file(relsPath)?.async('string');
          const rels = relsXml ? parseRelsXml(relsXml) : new Map<string, string>();

          const content = parseSlideXml(slideXml, defaultSize.width, defaultSize.height, rels, themeColors, themeFonts);

          const imageMap = new Map<string, string>();
          await loadImagesFromRels(zip, rels, slidePath, imageMap);

          // Slide Layout support
          let layoutPath: string | undefined;
          for (const [, target] of rels) {
            if (target.includes('slideLayout')) {
              layoutPath = resolveRelPath(slidePath, target);
              break;
            }
          }

          let masterPath: string | undefined;

          if (layoutPath && !layoutCache.has(layoutPath)) {
            const layoutXml = await zip.file(layoutPath)?.async('string');
            if (layoutXml) {
              const layoutName = layoutPath.match(/slideLayout\d+/)?.[0];
              const layoutRelsPath = `ppt/slideLayouts/_rels/${layoutName}.xml.rels`;
              const layoutRelsXml = await zip.file(layoutRelsPath)?.async('string');
              const layoutRels = layoutRelsXml ? parseRelsXml(layoutRelsXml) : new Map<string, string>();

              const layoutDoc = new DOMParser().parseFromString(layoutXml, 'application/xml');
              const layoutBg = parseSlideBackground(layoutDoc, themeColors);
              console.log('[PptxViewer] Layout background:', layoutPath, layoutBg);
              const layoutSpTree = layoutDoc.getElementsByTagName('p:spTree')[0];

              // Log ALL direct child tag names of layout spTree
              const layoutDirectChildren: string[] = [];
              if (layoutSpTree) {
                for (let ci = 0; ci < layoutSpTree.children.length; ci++) {
                  layoutDirectChildren.push(layoutSpTree.children[ci].tagName);
                }
              }
              console.log('[PptxViewer] Layout spTree direct children:', layoutPath, layoutDirectChildren);
              console.log('[PptxViewer] Layout spTree raw XML snippet:', layoutSpTree?.outerHTML?.substring(0, 3000));

              const layoutShapes = layoutSpTree ? parseShapeTree(layoutSpTree, layoutRels, 0, themeColors, true, themeFonts) : [];
              console.log('[PptxViewer] Parsed layout:', layoutPath, 'shapes:', layoutShapes.length);

              const layoutImageMap = new Map<string, string>();
              await loadImagesFromRels(zip, layoutRels, layoutPath, layoutImageMap);

              for (const [, target] of layoutRels) {
                if (target.includes('slideMaster')) {
                  masterPath = resolveRelPath(layoutPath, target);
                  break;
                }
              }

              if (masterPath && !masterCache.has(masterPath)) {
                const masterXml = await zip.file(masterPath)?.async('string');
                if (masterXml) {
                  const masterName = masterPath.match(/slideMaster\d+/)?.[0];
                  const masterRelsPath = `ppt/slideMasters/_rels/${masterName}.xml.rels`;
                  const masterRelsXml = await zip.file(masterRelsPath)?.async('string');
                  const masterRels = masterRelsXml ? parseRelsXml(masterRelsXml) : new Map<string, string>();

                  const masterDoc = new DOMParser().parseFromString(masterXml, 'application/xml');
                  const masterBg = parseSlideBackground(masterDoc, themeColors);
                  console.log('[PptxViewer] Master background:', masterPath, masterBg);
                  const masterSpTree = masterDoc.getElementsByTagName('p:spTree')[0];

                  // Count all elements before parsing to see what exists
                  const allSpElements = masterSpTree?.getElementsByTagName('p:sp').length || 0;
                  const allPicElements = masterSpTree?.getElementsByTagName('p:pic').length || 0;
                  const allCxnElements = masterSpTree?.getElementsByTagName('p:cxnSp').length || 0;
                  const allGfElements = masterSpTree?.getElementsByTagName('p:graphicFrame').length || 0;
                  const allGrpElements = masterSpTree?.getElementsByTagName('p:grpSp').length || 0;

                  // Log ALL direct child tag names of spTree to find any unhandled types
                  const allDirectChildren: string[] = [];
                  if (masterSpTree) {
                    for (let ci = 0; ci < masterSpTree.children.length; ci++) {
                      allDirectChildren.push(masterSpTree.children[ci].tagName);
                    }
                  }
                  console.log('[PptxViewer] Master spTree direct children:', masterPath, allDirectChildren);

                  // Also log the raw XML to see the actual structure
                  console.log('[PptxViewer] Master spTree raw XML snippet:', masterSpTree?.outerHTML?.substring(0, 3000));

                  console.log('[PptxViewer] Master spTree:', masterPath, {
                    'p:sp': allSpElements, 'p:pic': allPicElements, 'p:cxnSp': allCxnElements,
                    'p:graphicFrame': allGfElements, 'p:grpSp': allGrpElements
                  });

                  const masterShapes = masterSpTree ? parseShapeTree(masterSpTree, masterRels, 0, themeColors, true, themeFonts) : [];
                  console.log('[PptxViewer] Parsed master:', masterPath, 'shapes after parse:', masterShapes.length);

                  const masterImageMap = new Map<string, string>();
                  await loadImagesFromRels(zip, masterRels, masterPath, masterImageMap);

                  masterCache.set(masterPath, { background: masterBg, shapes: masterShapes, imageMap: masterImageMap });
                }
              }

              layoutCache.set(layoutPath, { background: layoutBg, shapes: layoutShapes, imageMap: layoutImageMap });
            }
          }

          // Resolve masterPath if not already found
          if (!masterPath && layoutPath) {
            const layoutName = layoutPath.match(/slideLayout\d+/)?.[0];
            const layoutRelsPath2 = `ppt/slideLayouts/_rels/${layoutName}.xml.rels`;
            const layoutRelsXml2 = await zip.file(layoutRelsPath2)?.async('string');
            if (layoutRelsXml2) {
              const layoutRels2 = parseRelsXml(layoutRelsXml2);
              for (const [, target] of layoutRels2) {
                if (target.includes('slideMaster')) {
                  masterPath = resolveRelPath(layoutPath, target);
                  break;
                }
              }
            }
          }

          // Generate unique prefix for this slide's layout/master to avoid relId collision
          const layoutPrefix = layoutPath ? `L${layoutPath.match(/\d+/)?.[0] || '0'}` : 'L0';
          const masterPrefix = masterPath ? `M${masterPath.match(/\d+/)?.[0] || '0'}` : 'M0';

          // Track background imageRelId source for proper resolution
          let bgSource: 'slide' | 'layout' | 'master' = 'slide';

          // Merge background from layout/master if slide has none
          // Note: Don't prefix here - prefixing is done later after imageMap merge
          if (!content.background && layoutPath) {
            const layout = layoutCache.get(layoutPath);
            if (layout?.background) {
              content.background = { ...layout.background };
              bgSource = 'layout';
            } else if (masterPath) {
              const master = masterCache.get(masterPath);
              if (master?.background) {
                content.background = { ...master.background };
                bgSource = 'master';
              }
            }
          }

          // Merge decorative shapes from layout and master (non-placeholder)
          // Skip if slide says showMasterSp="0"
          if (layoutPath && content.showMasterSp !== false) {
            const layout = layoutCache.get(layoutPath);
            const master = masterPath ? masterCache.get(masterPath) : undefined;

            // Layout/Master shapes are intentionally placed decorative elements
            // Don't filter them - they should be rendered as overlays
            // Only filter truly full-slide SOLID COLOR shapes (not images, as they may have transparency)
            const filterInheritedShapes = (shapes: SlideShape[], source: 'layout' | 'master'): SlideShape[] => {
              return shapes.filter(s => {
                if (s.type !== 'table' && s.type !== 'group') {
                  const se = s as ShapeElement;
                  const wRatio = se.width / defaultSize.width;
                  const hRatio = se.height / defaultSize.height;

                  // Keep all images from layout/master - they're decorative (may have transparency)
                  // Only filter solid color shapes that truly cover the entire slide
                  if (se.type !== 'image' && wRatio > 0.95 && hRatio > 0.95 &&
                      (se.backgroundColor || se.gradientFill) &&
                      !se.paragraphs?.some(p => p.runs.some(r => r.text.length > 0))) {
                    console.log('[PptxViewer] Filtering as BG shape:', source, { w: wRatio.toFixed(2), h: hRatio.toFixed(2), bg: se.backgroundColor });
                    return false;
                  }
                }
                return true;
              });
            };

            // z-order: master (bottom) -> layout -> slide (top)
            // Prefix relIds to avoid collision between slide/layout/master
            const inheritedShapes: SlideShape[] = [];
            if (master?.shapes && master.shapes.length > 0) {
              console.log('[PptxViewer] Master shapes before filter:', master.shapes.length, masterPath);
              const filtered = filterInheritedShapes(master.shapes, 'master');
              console.log('[PptxViewer] Master shapes after filter:', filtered.length);
              inheritedShapes.push(...prefixShapeRelIds(filtered, masterPrefix));
            }
            if (layout?.shapes && layout.shapes.length > 0) {
              console.log('[PptxViewer] Layout shapes before filter:', layout.shapes.length, layoutPath);
              const filtered = filterInheritedShapes(layout.shapes, 'layout');
              console.log('[PptxViewer] Layout shapes after filter:', filtered.length);
              inheritedShapes.push(...prefixShapeRelIds(filtered, layoutPrefix));
            }
            console.log('[PptxViewer] Total inherited shapes:', inheritedShapes.length, 'Slide shapes:', content.shapes.length);
            if (inheritedShapes.length > 0) {
              content.shapes = [...inheritedShapes, ...content.shapes];
            }

            // Merge images from layout/master into slide imageMap WITH PREFIX
            // This ensures each source's relIds don't collide
            if (layout) {
              const prefixedLayoutImages = prefixImageMap(layout.imageMap, layoutPrefix);
              for (const [id, src] of prefixedLayoutImages) {
                imageMap.set(id, src);
              }
            }
            if (master) {
              const prefixedMasterImages = prefixImageMap(master.imageMap, masterPrefix);
              for (const [id, src] of prefixedMasterImages) {
                imageMap.set(id, src);
              }
            }

            // Background image resolve - apply prefix based on source
            if (content.background?.imageRelId && bgSource !== 'slide') {
              const prefix = bgSource === 'layout' ? layoutPrefix : masterPrefix;
              const prefixedRelId = `${prefix}:${content.background.imageRelId}`;
              content.background.imageRelId = prefixedRelId;
            }
          }

          // Background image resolve (for slide-level backgrounds from layout/master cache)
          if (content.background?.imageRelId && !imageMap.has(content.background.imageRelId)) {
            if (layoutPath) {
              const layout = layoutCache.get(layoutPath);
              // Try unprefixed first (original relId from layout/master XML)
              const bgSrc = layout?.imageMap.get(content.background.imageRelId);
              if (bgSrc) imageMap.set(content.background.imageRelId, bgSrc);
            }
          }

          slideContents.push(content);
          allSlideImages.set(i, imageMap);
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

  // ── 창에 맞춘다 — 너비를 재서 배율을 정한다 ────────────────────
  //    ⚠️ 슬라이드 크기는 파일을 읽고 나서야 정해진다(`slideSize`). 그래서
  //       `slideSize` 와 창 너비 **둘 다** 이 효과의 재료다.
  useEffect(() => {
    if (!fitWidth) return;
    const el = scrollContainerRef.current;
    if (!el) return;
    const apply = () => {
      // 🔴 여백을 **짐작하지 않고 읽는다.** 붙박이 24 로 두었더니 실측에서
      //    그려진 너비는 맞는데(974 ≤ 998) **가로 스크롤이 1006 으로 떴다** —
      //    이 통의 실제 좌우 여백이 32 였다. CSS 가 바뀌면 또 어긋난다.
      const cs = getComputedStyle(el);
      const pad = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0) + 2;
      const avail = el.clientWidth - pad;
      if (avail <= 0 || !slideSize.width) return;
      const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, avail / slideSize.width));
      zoomRef.current = z;
      setZoom(z);
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
    // 🔴 `slides.length`·`loading` 이 **재료로 있어야 한다** (실측 2026-09-05).
    //    없이 두었더니 배지는 「맞춤」인데 **배율이 안 먹었다**:
    //        창 안쪽 998px · 슬라이드 1280px · **그려진 너비 1280px**
    //    까닭은 렌더 차례다 — `setSlideSize`(84행)와 `setSlides`(371행)가
    //    한 비동기 함수 안에서 **따로** 일어나고, 그 사이 화면은 `loading`
    //    갈래라 `.pptx-slides-scroll-container` 가 **아직 없다.** 효과가
    //    `ref.current === null` 로 물러난 뒤, `slideSize.width` 는 이미
    //    1280 이라 **다시 돌지 않는다.**
  }, [fitWidth, slideSize.width, slides.length, loading, setZoom, zoomRef]);

  // Zoom via Ctrl+Wheel is handled by useViewerZoom hook

  // Zoom via Ctrl+Drag (drag up = zoom in, drag down = zoom out)
  const dragZoomRef = useRef<{ startY: number; startZoom: number } | null>(null);
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;

    const handleMouseDown = (e: MouseEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        e.stopPropagation();
        dragZoomRef.current = { startY: e.clientY, startZoom: zoomRef.current };
        el.style.cursor = 'ns-resize';
      }
    };

    const handleMouseMove = (e: MouseEvent) => {
      if (!dragZoomRef.current) return;
      e.preventDefault();
      const dy = dragZoomRef.current.startY - e.clientY; // up = positive = zoom in
      const sensitivity = 0.008;
      const newZoom = Math.min(MAX_ZOOM,
        Math.max(MIN_ZOOM, dragZoomRef.current.startZoom + dy * sensitivity));
      setFitWidth(false);          // 손으로 잡으면 맞춤을 놓는다
      setZoom(newZoom);
    };

    const handleMouseUp = () => {
      if (dragZoomRef.current) {
        dragZoomRef.current = null;
        el.style.cursor = '';
      }
    };

    el.addEventListener('mousedown', handleMouseDown, { capture: true });
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      el.removeEventListener('mousedown', handleMouseDown, { capture: true });
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, []);

  // Track visible slide via IntersectionObserver
  useEffect(() => {
    if (slides.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const idx = slideRefs.current.indexOf(entry.target as HTMLDivElement);
            if (idx >= 0) {
              setVisibleSlide(idx);
            }
          }
        }
      },
      {
        root: scrollContainerRef.current,
        threshold: 0.5,
      }
    );

    slideRefs.current.forEach((ref) => {
      if (ref) observer.observe(ref);
    });

    return () => observer.disconnect();
  }, [slides.length, zoom]);

  if (loading) {
    return (
      <div className="office-viewer-container pptx-viewer">
        <div className="pptx-loading">{'\uC2AC\uB77C\uC774\uB4DC \uB85C\uB529 \uC911...'}</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="office-viewer-container pptx-viewer">
        <div className="office-viewer-error">PPTX {'\uD30C\uC2F1 \uC2E4\uD328'}: {error}</div>
      </div>
    );
  }

  if (slides.length === 0) {
    return (
      <div className="office-viewer-container pptx-viewer">
        <div className="office-viewer-error">{'\uC2AC\uB77C\uC774\uB4DC\uB97C \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.'}</div>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="office-viewer-container pptx-viewer">
      <div className="viewer-toolbar pptx-toolbar">
        <span className="pptx-slide-indicator">
          {visibleSlide + 1} / {slides.length}
        </span>
        {/* 🔴 맞춤일 때 «100%» 라 말하면 안 된다 — 그 거짓말이 이 결함을
            찾기 어렵게 했다. PDF 뷰어와 같은 말을 쓴다 (`fit`/`맞춤`). */}
        <span className="pptx-zoom-indicator">
          {fitWidth ? '\uB9DE\uCDA4' : `${Math.round(zoom * 100)}%`}
        </span>
        <button
          type="button"
          className={`pptx-zoom-indicator pptx-fit-btn${fitWidth ? ' active' : ''}`}
          onClick={() => setFitWidth(v => !v)}
          title={'\uCC3D\uC5D0 \uB9DE\uCDA4'}
          aria-pressed={fitWidth}
        >
          {'\u2194'}
        </button>
      </div>

      <div className="pptx-slides-scroll-container" ref={scrollContainerRef}>
        {slides.map((slide, idx) => {
          const imageMap = slideImages.get(idx) || new Map();
          return (
            <PptxSlideContext.Provider
              key={idx}
              value={{ imageMap, themeColors: undefined, tableStylesRef, slideSize }}
            >
              <div
                style={{
                  width: slideSize.width * zoom,
                  height: slideSize.height * zoom,
                  flexShrink: 0,
                }}
              >
                <div
                  ref={el => { slideRefs.current[idx] = el; }}
                  className="pptx-slide"
                  style={{
                    width: slideSize.width,
                    height: slideSize.height,
                    transform: `scale(${zoom})`,
                    transformOrigin: 'top left',
                    position: 'relative',
                    ...getSlideBackgroundStyle(slide, imageMap),
                  }}
                >
                  {slide.shapes.map((shape, si) => <PptxShape key={si} shape={shape} index={si} />)}
                </div>
              </div>
            </PptxSlideContext.Provider>
          );
        })}
      </div>
    </div>
  );
}

export default PptxViewer;
