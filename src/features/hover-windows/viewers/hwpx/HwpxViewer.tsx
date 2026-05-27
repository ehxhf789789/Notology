import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import JSZip from 'jszip';
import { useViewerZoom } from '../shared/useViewerZoom';
import { log } from '../shared/viewerConstants';
import { t } from '../../../../core/utils/i18n';
import { useLanguage } from '../../../../core/stores/settingsStore';
import type { HwpxViewerProps, Section, HeaderData, ContentItem, ImageElement, FootnoteData } from './hwpxTypes';
import { parseHeaderXml } from './hwpxHeaderParser';
import { parseSectionXml } from './hwpxParser';
import { paginateSection } from './hwpxPagination';
import {
  renderContentItem, renderParagraph, renderFooterHeader,
  type HwpxRenderContext,
} from './HwpxRenderHelpers';

// ==================== React Component ====================

export function HwpxViewer({ data }: HwpxViewerProps) {
  const language = useLanguage();
  const [sections, setSections] = useState<Section[]>([]);
  const [images, setImages] = useState<Map<string, string>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [currentPageIdx, setCurrentPageIdx] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const { zoom } = useViewerZoom(containerRef);
  const pageRefs = useRef<(HTMLDivElement | null)[]>([]);

  useEffect(() => {
    const loadHwpx = async () => {
      try {
        setLoading(true);
        setError(null);
        const zip = await JSZip.loadAsync(data);
        const loadedSections: Section[] = [];
        const loadedImages = new Map<string, string>();

        let headerData: HeaderData | null = null;
        const headerFile = zip.file('Contents/header.xml');
        if (headerFile) headerData = parseHeaderXml(await headerFile.async('string'));

        const sectionFiles: string[] = [];
        zip.forEach((path) => { if (path.match(/Contents\/section\d+\.xml$/i)) sectionFiles.push(path); });
        sectionFiles.sort((a, b) => {
          const nA = parseInt(a.match(/section(\d+)/i)?.[1] || '0');
          const nB = parseInt(b.match(/section(\d+)/i)?.[1] || '0');
          return nA - nB;
        });

        for (const sp of sectionFiles) {
          const xml = await zip.file(sp)?.async('string');
          if (xml) loadedSections.push(parseSectionXml(xml, headerData));
        }

        if (loadedSections.length === 0) {
          const pf = zip.file('Preview/PrvText.txt');
          if (pf) {
            const text = await pf.async('string');
            if (text) loadedSections.push({
              content: text.split(/\n/).filter(l => l.trim()).map(l => ({
                type: 'paragraph' as const, data: { runs: [{ text: l }] },
              })),
            });
          }
        }

        // Load embedded images
        const imagePromises: Promise<void>[] = [];
        zip.forEach((path, file) => {
          if (path.startsWith('BinData/') && !file.dir) {
            imagePromises.push((async () => {
              try {
                const imgData = await file.async('base64');
                const ext = path.split('.').pop()?.toLowerCase() || 'png';
                const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' :
                            ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' :
                            ext === 'bmp' ? 'image/bmp' : ext === 'wmf' ? 'image/x-wmf' :
                            ext === 'emf' ? 'image/x-emf' : ext === 'svg' ? 'image/svg+xml' : 'image/png';
                const dataUrl = `data:${mime};base64,${imgData}`;
                loadedImages.set(path, dataUrl);
                const fn = path.split('/').pop() || '';
                if (fn) { loadedImages.set(fn, dataUrl); loadedImages.set(fn.replace(/\.[^.]+$/, ''), dataUrl); }
              } catch (e) { console.warn('[HwpxViewer] Image load failed:', path, e); }
            })());
          }
        });
        await Promise.all(imagePromises);

        setSections(loadedSections);
        setImages(loadedImages);
        setLoading(false);
      } catch (err) {
        console.error('[HwpxViewer] Parse failed:', err);
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      }
    };
    loadHwpx();
  }, [data]);

  // Zoom is handled by useViewerZoom hook

  // ==================== Rendering ====================

  const resolveImageSrc = (id: string): string | undefined => {
    return images.get(`BinData/${id}`) || images.get(id) ||
      Array.from(images.entries()).find(([k]) => k.includes(id))?.[1];
  };

  const renderCtx: HwpxRenderContext = { resolveImageSrc };

  // Pre-compute paginated pages with footnote assignment
  const paginatedPages = useMemo(() => {
    if (sections.length === 0) return [];
    const result: { section: Section; pageContent: ContentItem[]; globalPageNum: number; sectionPageIdx: number; pageFootnotes: FootnoteData[]; backgroundImages: ImageElement[]; overlayImages: ImageElement[]; overlayTextBoxes: import('./hwpxTypes').TextBoxElement[] }[] = [];
    let gp = 0;
    for (const section of sections) {
      const sectionPages = paginateSection(section);
      // Distribute footnotes to pages using pageIndex recorded during parsing
      const footnotesByPage = new Map<number, FootnoteData[]>();
      if (section.footnotes) {
        for (const fn of section.footnotes) {
          const pi = fn.pageIndex ?? 0;
          // Clamp to valid page range
          const clampedPi = Math.min(pi, sectionPages.length - 1);
          if (!footnotesByPage.has(clampedPi)) footnotesByPage.set(clampedPi, []);
          footnotesByPage.get(clampedPi)!.push(fn);
        }
      }

      // Apply page start number if specified (only if no per-page resets exist)
      if (section.pageStartNo !== undefined && !section.pageNumResets?.size) gp = section.pageStartNo - 1;

      for (let pi = 0; pi < sectionPages.length; pi++) {
        // Per-page page number reset (from newNum PAGE)
        if (section.pageNumResets?.has(pi)) {
          gp = section.pageNumResets.get(pi)! - 1;
        }
        gp++;
        // Separate behind-text images, overlay images/textboxes from content
        const bgImages: ImageElement[] = [];
        const overlayImgs: ImageElement[] = [];
        const overlayTBs: import('./hwpxTypes').TextBoxElement[] = [];
        const filteredContent: ContentItem[] = [];
        for (const item of sectionPages[pi]) {
          if (item.type === 'image' && (item.data.textWrap === 'BEHIND_TEXT' || item.data.textWrap === 'behindText')) {
            bgImages.push(item.data);
          } else if (item.type === 'image' && item.data.textWrap === 'IN_FRONT_OF_TEXT') {
            overlayImgs.push(item.data);
          } else if (item.type === 'textBox' && item.data.textWrap === 'BEHIND_TEXT') {
            // BEHIND_TEXT text boxes (sidebar labels) — skip, not visible in preview
          } else if (item.type === 'textBox' && item.data.textWrap === 'IN_FRONT_OF_TEXT') {
            overlayTBs.push(item.data);
          } else {
            filteredContent.push(item);
          }
        }
        result.push({
          section, pageContent: filteredContent, globalPageNum: gp, sectionPageIdx: pi,
          pageFootnotes: footnotesByPage.get(pi) || [], backgroundImages: bgImages, overlayImages: overlayImgs, overlayTextBoxes: overlayTBs,
        });
      }
    }
    return result;
  }, [sections]);

  // ==================== Page Navigation ====================

  // IntersectionObserver to track current visible page
  useEffect(() => {
    const root = contentRef.current;
    if (!root || paginatedPages.length === 0) return;
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          const idx = parseInt(entry.target.getAttribute('data-page-idx') || '0');
          setCurrentPageIdx(idx);
          break;
        }
      }
    }, { root, threshold: 0.3 });
    pageRefs.current.forEach(ref => ref && observer.observe(ref));
    return () => observer.disconnect();
  }, [paginatedPages]);

  const jumpToPage = useCallback((idx: number) => {
    const clamped = Math.max(0, Math.min(paginatedPages.length - 1, idx));
    pageRefs.current[clamped]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [paginatedPages.length]);

  const goToPrevPage = useCallback(() => jumpToPage(currentPageIdx - 1), [jumpToPage, currentPageIdx]);
  const goToNextPage = useCallback(() => jumpToPage(currentPageIdx + 1), [jumpToPage, currentPageIdx]);

  // ==================== Component Rendering ====================

  if (loading) return <div className="office-viewer-container hwpx-viewer"><div className="hwpx-loading">{t('viewerHwpxLoading', language)}</div></div>;
  if (error) return <div className="office-viewer-container hwpx-viewer"><div className="office-viewer-error">HWPX {t('viewerPdfLoadError', language)}: {error}</div></div>;
  if (sections.length === 0 || sections.every(s => s.content.length === 0)) {
    return <div className="office-viewer-container hwpx-viewer"><div className="office-viewer-error">{t('viewerHwpxNotFound', language)}</div></div>;
  }

  const s0 = sections[0];
  const pageW = s0.pageWidth || 793;
  const pageH = s0.pageHeight || 1122;
  const mL = s0.marginLeft || 56;
  const mR = s0.marginRight || 56;
  const mT = s0.marginTop || 56;
  const mB = s0.marginBottom || 56;

  return (
    <div ref={containerRef} className="office-viewer-container hwpx-viewer">
      {/* Page navigation toolbar */}
      <div className="viewer-toolbar hwpx-toolbar">
        <button
          className="hwpx-nav-btn"
          onClick={goToPrevPage}
          disabled={currentPageIdx === 0}
          title={t('viewerPdfPrevPage', language)}
          aria-label={t('viewerPdfPrevPage', language)}
        >
          <ChevronLeft size={18} />
        </button>
        <input
          type="number"
          className="hwpx-page-input"
          value={currentPageIdx + 1}
          onChange={e => {
            const val = parseInt(e.target.value);
            if (!isNaN(val)) jumpToPage(val - 1);
          }}
          min={1}
          max={paginatedPages.length}
        />
        <span className="hwpx-page-total">/ {paginatedPages.length}</span>
        <button
          className="hwpx-nav-btn"
          onClick={goToNextPage}
          disabled={currentPageIdx >= paginatedPages.length - 1}
          title={t('viewerPdfNextPage', language)}
          aria-label={t('viewerPdfNextPage', language)}
        >
          <ChevronRight size={18} />
        </button>
        <span className="hwpx-zoom-label">{Math.round(zoom * 100)}%</span>
      </div>
      <div ref={contentRef} className="hwpx-content" style={{ zoom: zoom }}>
        {paginatedPages.map((page, idx) => {
          const { section, pageContent, globalPageNum, sectionPageIdx, pageFootnotes, backgroundImages, overlayImages, overlayTextBoxes } = page;
          const pw = section.pageWidth || pageW;
          const ph = section.pageHeight || pageH;
          const ml = section.marginLeft || mL;
          const mr = section.marginRight || mR;
          const mt = section.marginTop || mT;
          const mb = section.marginBottom || mB;
          const hm = section.headerMargin || 0;
          const fm = section.footerMargin || 0;

          return (
            <div key={idx} className="hwpx-page" data-page-idx={idx}
              ref={el => { pageRefs.current[idx] = el; }}
              style={{
                width: pw, minHeight: ph, position: 'relative', boxSizing: 'border-box', overflow: 'hidden',
              }}>
              {/* Background images (behind text) */}
              {backgroundImages.map((img, bi) => {
                const bgSrc = resolveImageSrc(img.id);
                if (!bgSrc) return null;
                return <img key={`bg-${bi}`} src={bgSrc} alt="" style={{
                  position: 'absolute', zIndex: 0, pointerEvents: 'none',
                  top: img.vertOffset || 0, left: img.horzOffset || 0,
                  width: img.width || pw, height: img.height || 'auto',
                }} />;
              })}

              {/* Overlay images (IN_FRONT_OF_TEXT, e.g. container background pics) */}
              {overlayImages.map((img, oi) => {
                const oSrc = resolveImageSrc(img.id);
                if (!oSrc) return null;
                return <img key={`oi-${oi}`} src={oSrc} alt="" style={{
                  position: 'absolute', zIndex: Math.max(1, img.zOrder || 1), pointerEvents: 'none',
                  top: img.vertOffset || 0, left: img.horzOffset || 0,
                  width: img.width || pw, height: img.height || ph,
                  objectFit: 'fill',
                }} />;
              })}

              {/* Header area — repeated on every page */}
              {section.headerContent && section.headerContent.length > 0 && (
                <div style={{
                  position: 'absolute', top: mt, left: ml, right: mr,
                  height: hm > 0 ? hm : 'auto', overflow: 'hidden', zIndex: 1,
                }}>
                  {renderFooterHeader(section.headerContent, `hdr-${idx}`, renderCtx)}
                </div>
              )}

              {/* Main content area + footnotes in flow layout */}
              <div className="hwpx-section" style={{
                paddingLeft: ml, paddingRight: mr,
                paddingTop: mt + (hm > 0 ? hm : 0),
                paddingBottom: mb + (fm > 0 ? fm : 0),
                position: 'relative', zIndex: 1,
                display: 'flex', flexDirection: 'column',
                boxSizing: 'border-box',
                minHeight: ph,
              }}>
                <div style={{ flex: 1 }}>
                  {(() => {
                    // Group consecutive inline images into flex rows
                    const elements: React.ReactNode[] = [];
                    let i = 0;
                    while (i < pageContent.length) {
                      const item = pageContent[i];
                      if (item.type === 'image' && item.data.inline) {
                        // Collect consecutive inline images
                        const group: ContentItem[] = [item];
                        let j = i + 1;
                        while (j < pageContent.length && pageContent[j].type === 'image' && (pageContent[j] as { type: 'image'; data: ImageElement }).data.inline) {
                          group.push(pageContent[j]);
                          j++;
                        }
                        if (group.length > 1) {
                          elements.push(
                            <div key={`imgrow-${idx}-${i}`} style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', alignItems: 'flex-start', justifyContent: 'center', margin: '8px 0' }}>
                              {group.map((g, gi) => renderContentItem(g, `p${idx}-i${i + gi}`, renderCtx))}
                            </div>
                          );
                        } else {
                          elements.push(renderContentItem(item, `p${idx}-i${i}`, renderCtx));
                        }
                        i = j;
                      } else {
                        elements.push(renderContentItem(item, `p${idx}-i${i}`, renderCtx));
                        i++;
                      }
                    }
                    return elements;
                  })()}
                </div>

                {/* Footnotes — pushed to bottom of content area via flex */}
                {pageFootnotes.length > 0 && (
                  <div style={{ marginTop: 'auto', paddingTop: '8px' }}>
                    <hr style={{ border: 'none', borderTop: '1px solid #999', width: '30%', margin: '0 0 4px 0' }} />
                    {pageFootnotes.map((fn, fi) => (
                      <div key={fi} style={{ fontSize: '0.8em', lineHeight: 1.4, marginBottom: '2px', display: 'flex', gap: '4px' }}>
                        <span style={{ fontSize: '0.75em', verticalAlign: 'super', flexShrink: 0 }}>{fn.marker || fn.number}</span>
                        <span>{fn.content.map((item, ii) => renderContentItem(item, `fn-${idx}-${fi}-${ii}`, renderCtx))}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Footer area — repeated on every page */}
              {section.footerContent && section.footerContent.length > 0 && (
                <div style={{
                  position: 'absolute', bottom: mb, left: ml, right: mr,
                  height: fm > 0 ? fm : 'auto', overflow: 'hidden', zIndex: 1,
                }}>
                  {renderFooterHeader(section.footerContent, `ftr-${idx}`, renderCtx, globalPageNum)}
                </div>
              )}

              {/* Overlay text boxes (IN_FRONT_OF_TEXT, positioned on page) */}
              {overlayTextBoxes.map((tb, ti) => (
                <div key={`otb-${ti}`} style={{
                  position: 'absolute',
                  top: tb.vertOffset || 0, left: tb.horzOffset || 0,
                  width: tb.width > 0 ? tb.width : undefined,
                  height: tb.height > 0 ? tb.height : undefined,
                  zIndex: Math.max(3, tb.zOrder || 3),
                  pointerEvents: 'none', overflow: 'hidden',
                  display: 'flex', flexDirection: 'column',
                  justifyContent: tb.vertAlign === 'BOTTOM' ? 'flex-end' : tb.vertAlign === 'CENTER' ? 'center' : 'flex-start',
                }}>
                  {tb.paragraphs.map((p, pi) => renderParagraph(p, `otb-${idx}-${ti}-p${pi}`))}
                </div>
              ))}

              {/* Page number (hidden by section-level pageHiding or per-page ctrl) */}
              {section.pageNumPos && !section.pageNumHidden && !section.hiddenPageNumPages?.has(sectionPageIdx) && (() => {
                const pos = section.pageNumPos;
                const sc = section.pageNumSideChar || '';
                const numText = sc ? `${sc} ${globalPageNum} ${sc}` : String(globalPageNum);
                const isTop = pos.startsWith('TOP');
                const isCenter = pos.includes('CENTER');
                const isRight = pos.includes('RIGHT');
                // Position in margin area: between footer and page edge
                const bottomPos = Math.max(4, (mb - 16) / 2);
                const topPos = Math.max(4, (mt - 16) / 2);
                const style: React.CSSProperties = {
                  position: 'absolute', left: ml, right: mr,
                  textAlign: isCenter ? 'center' : isRight ? 'right' : 'left',
                  fontSize: '9pt', color: '#666',
                };
                if (isTop) style.top = topPos;
                else style.bottom = bottomPos;
                return <div style={style}>{numText}</div>;
              })()}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default HwpxViewer;
