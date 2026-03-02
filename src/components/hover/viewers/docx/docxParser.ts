import JSZip from 'jszip';
import type {
  DocumentData, DocDefaults, StyleDef, ResolvedStyle, SectionProps,
  StyleNumMap, TableStyleMap,
} from './docxTypes';
import { getElement, getDirectChildren, getElements } from './docxXmlHelpers';
import { log } from '../shared/viewerConstants';
import { parseDocDefaults, parseStyles, buildResolvedStyles, buildFontFamily } from './docxStyleParser';
import { parseNumbering } from './docxNumbering';
import { parseRelationships } from './docxDrawing';
import { parseBodyContent } from './docxContentParser';
import { parseSectionProps } from './docxPagination';

// ==================== Parse Document ====================

export async function parseDocx(data: ArrayBuffer): Promise<DocumentData> {
  log('[DocxViewer] parseDocx v3 — abstractNumId counter tracking + StyleNumMap');
  const zip = await JSZip.loadAsync(data);

  const images = await parseRelationships(zip);
  log('[DocxViewer] Loaded images:', images.size);

  // Parse styles + docDefaults
  let styles = new Map<string, StyleDef>();
  let tableStyles: TableStyleMap = new Map();
  let docDefaults: DocDefaults = { run: {}, para: {} };
  let defaultParaStyleId: string | null = null;
  const stylesFile = zip.file('word/styles.xml');
  if (stylesFile) {
    const stylesXml = await stylesFile.async('string');
    const parser = new DOMParser();
    const stylesDoc = parser.parseFromString(stylesXml, 'application/xml');
    const parseResult = parseStyles(stylesDoc);
    styles = parseResult.styles;
    defaultParaStyleId = parseResult.defaultParaStyleId;
    tableStyles = parseResult.tableStyles;
    docDefaults = parseDocDefaults(stylesDoc);
    log('[DocxViewer] Loaded styles:', styles.size, 'defaultParaStyleId:', defaultParaStyleId, 'docDefaults:', docDefaults);
  }

  // Resolve default font size from default paragraph style if docDefaults doesn't have it
  if (!docDefaults.run.fontSize && defaultParaStyleId) {
    const defStyle = styles.get(defaultParaStyleId);
    if (defStyle?.run?.fontSize) {
      docDefaults.run.fontSize = defStyle.run.fontSize;
      log('[DocxViewer] Default font size from style', defaultParaStyleId, ':', defStyle.run.fontSize, 'pt');
    }
  }
  // Resolve default per-range fonts from default paragraph style if docDefaults doesn't have them
  if (defaultParaStyleId) {
    const defStyle = styles.get(defaultParaStyleId);
    if (defStyle?.run) {
      if (!docDefaults.run.asciiFont && defStyle.run.asciiFont) docDefaults.run.asciiFont = defStyle.run.asciiFont;
      if (!docDefaults.run.hAnsiFont && defStyle.run.hAnsiFont) docDefaults.run.hAnsiFont = defStyle.run.hAnsiFont;
      if (!docDefaults.run.eastAsiaFont && defStyle.run.eastAsiaFont) docDefaults.run.eastAsiaFont = defStyle.run.eastAsiaFont;
      if (!docDefaults.run.csFont && defStyle.run.csFont) docDefaults.run.csFont = defStyle.run.csFont;
    }
  }
  // Compute combined fontFamily from per-range fonts (used for page container CSS)
  docDefaults.run.fontFamily = buildFontFamily(docDefaults.run);
  if (docDefaults.run.fontFamily) {
    log('[DocxViewer] Default font family:', docDefaults.run.fontFamily);
  }

  // Resolve default paragraph style's line spacing if docDefaults doesn't have it
  if (!docDefaults.para.lineHeightType && defaultParaStyleId) {
    const defStyle = styles.get(defaultParaStyleId);
    if (defStyle?.paragraph?.lineHeightType) {
      docDefaults.para.lineHeightType = defStyle.paragraph.lineHeightType;
      docDefaults.para.lineHeightValue = defStyle.paragraph.lineHeightValue;
      log('[DocxViewer] Default line spacing from style', defaultParaStyleId, ':', defStyle.paragraph.lineHeightType, defStyle.paragraph.lineHeightValue);
    }
  }
  // Resolve default paragraph spacing (before/after) from default para style
  if (docDefaults.para.spaceAfter === undefined && defaultParaStyleId) {
    const defStyle = styles.get(defaultParaStyleId);
    if (defStyle?.paragraph?.spaceAfter !== undefined) {
      docDefaults.para.spaceAfter = defStyle.paragraph.spaceAfter;
    }
    if (defStyle?.paragraph?.spaceBefore !== undefined && docDefaults.para.spaceBefore === undefined) {
      docDefaults.para.spaceBefore = defStyle.paragraph.spaceBefore;
    }
  }

  // Store defaultParaStyleId in docDefaults so parseParagraph can avoid double-applying it
  if (defaultParaStyleId) {
    docDefaults.defaultParaStyleId = defaultParaStyleId;
  }

  // Build resolved style cache
  const resolvedStyles = buildResolvedStyles(styles, docDefaults);

  // Resolve default paragraph style for applying to unstyled paragraphs
  let defaultParaResolvedStyle: ResolvedStyle | null = null;
  if (defaultParaStyleId && resolvedStyles.has(defaultParaStyleId)) {
    defaultParaResolvedStyle = resolvedStyles.get(defaultParaStyleId)!;
  }

  // Parse numbering
  let numbering = new Map<string, import('./docxTypes').NumberingDef>();
  let styleNumMap: StyleNumMap = new Map();
  const numberingFile = zip.file('word/numbering.xml');
  if (numberingFile) {
    const numberingXml = await numberingFile.async('string');
    const parser = new DOMParser();
    const numberingDoc = parser.parseFromString(numberingXml, 'application/xml');
    const numResult = parseNumbering(numberingDoc);
    numbering = numResult.numbering;
    styleNumMap = numResult.styleNumMap;
    log('[DocxViewer] Loaded numbering:', numbering.size, 'styleNumMap:', styleNumMap.size);
  }

  // Parse main document
  const documentFile = zip.file('word/document.xml');
  if (!documentFile) throw new Error('document.xml not found');

  const documentXml = await documentFile.async('string');
  const parser = new DOMParser();
  const doc = parser.parseFromString(documentXml, 'application/xml');

  const bodyEl = getElement(doc.documentElement, 'w:body');
  if (!bodyEl) throw new Error('document body not found');

  // Parse body's last sectPr (default section)
  let defaultSection: SectionProps = {
    pageWidth: 816, pageHeight: 1056,
    marginTop: 96, marginBottom: 96, marginLeft: 96, marginRight: 96,
  };

  // Find the last sectPr directly under body (not in paragraphs)
  const bodySectPrs = getDirectChildren(bodyEl, 'w:sectPr');
  if (bodySectPrs.length > 0) {
    defaultSection = parseSectionProps(bodySectPrs[bodySectPrs.length - 1]);
  }

  // Parse content
  const numberingCounters = new Map<string, number>();
  const content = parseBodyContent(bodyEl, images, resolvedStyles, numbering, numberingCounters, docDefaults, defaultParaResolvedStyle, styleNumMap, tableStyles);

  // Collect sections from inline sectPr
  const sections: SectionProps[] = [];
  for (const item of content) {
    if (item.type === 'sectionBreak' && item.sectionProps) {
      sections.push(item.sectionProps);
    }
  }
  sections.push(defaultSection); // Last section

  const pageBreakCount = content.filter(c => c.type === 'pageBreak').length;
  log('[DocxViewer] Content items:', content.length, 'Page breaks:', pageBreakCount, 'Sections:', sections.length);

  // ===== Per-section footer page number resolution =====
  // 1) Build rId → target map from .rels
  const rIdToTarget = new Map<string, string>();
  const relsFile2 = zip.file('word/_rels/document.xml.rels');
  if (relsFile2) {
    const relsXml2 = await relsFile2.async('string');
    const relsDoc2 = new DOMParser().parseFromString(relsXml2, 'application/xml');
    const rels = relsDoc2.getElementsByTagName('Relationship');
    for (let ri = 0; ri < rels.length; ri++) {
      const rel = rels[ri];
      const id = rel.getAttribute('Id');
      const target = rel.getAttribute('Target');
      if (id && target) rIdToTarget.set(id, target);
    }
  }

  // 2) Build footer filename → hasPageField map
  let hasFooterPageNumber = false;
  const footerPageMap = new Map<string, boolean>();
  const footerFiles = zip.file(/^word\/footer\d*\.xml$/);
  for (const ff of footerFiles) {
    const fXml = await ff.async('string');
    const hasPage = /PAGE/i.test(fXml) && /fldSimple|instrText/i.test(fXml);
    footerPageMap.set(ff.name, hasPage); // key = 'word/footer4.xml'
    if (hasPage) hasFooterPageNumber = true;
  }

  // 3) Helper: check if a sectPr element's footer references have PAGE fields
  function checkSectPrFooter(sectPrEl: Element): { defaultHasPage?: boolean; firstHasPage?: boolean } | null {
    let hasFooterRef = false;
    let defaultHasPage: boolean | undefined;
    let firstHasPage: boolean | undefined;
    for (let ci = 0; ci < sectPrEl.childNodes.length; ci++) {
      const child = sectPrEl.childNodes[ci];
      if (child.nodeType !== 1) continue;
      const el = child as Element;
      if (el.tagName === 'w:footerReference' || el.localName === 'footerReference') {
        hasFooterRef = true;
        const rId = el.getAttribute('r:id');
        const type = el.getAttribute('w:type');
        if (rId) {
          const target = rIdToTarget.get(rId);
          if (target) {
            const fullPath = target.startsWith('/') ? target.substring(1) : `word/${target}`;
            const hasPage = footerPageMap.get(fullPath) || false;
            if (type === 'default') defaultHasPage = hasPage;
            else if (type === 'first') firstHasPage = hasPage;
          }
        }
      }
    }
    return hasFooterRef ? { defaultHasPage, firstHasPage } : null;
  }

  // 4) Find inline sectPr elements in document order (w:p > w:pPr > w:sectPr)
  const allSectPrInBody = bodyEl.getElementsByTagName('w:sectPr');
  const inlineSectPrs: Element[] = [];
  for (let si = 0; si < allSectPrInBody.length; si++) {
    const el = allSectPrInBody[si];
    const parent = el.parentElement;
    if (parent && (parent.tagName === 'w:pPr' || parent.localName === 'pPr')) {
      inlineSectPrs.push(el);
    }
  }

  // 5) Apply footer info to sections (inline sectPrs map to sections[0..n-2], body-level to sections[n-1])
  for (let si = 0; si < inlineSectPrs.length && si < sections.length - 1; si++) {
    const footerInfo = checkSectPrFooter(inlineSectPrs[si]);
    if (footerInfo) {
      sections[si].hasPageNumberInFooter = footerInfo.defaultHasPage || false;
      sections[si].hasPageNumberInFirstFooter = footerInfo.firstHasPage || false;
    }
  }
  // Body-level sectPr → last section
  if (bodySectPrs.length > 0) {
    const footerInfo = checkSectPrFooter(bodySectPrs[bodySectPrs.length - 1]);
    if (footerInfo) {
      sections[sections.length - 1].hasPageNumberInFooter = footerInfo.defaultHasPage || false;
      sections[sections.length - 1].hasPageNumberInFirstFooter = footerInfo.firstHasPage || false;
    }
  }

  // 6) Resolve inheritance: sections without footerReference inherit from previous section
  let inheritDefault = false;
  let inheritFirst = false;
  for (const section of sections) {
    if (section.hasPageNumberInFooter !== undefined) {
      inheritDefault = section.hasPageNumberInFooter;
      inheritFirst = section.hasPageNumberInFirstFooter || false;
    } else {
      section.hasPageNumberInFooter = inheritDefault;
      section.hasPageNumberInFirstFooter = inheritFirst;
    }
  }

  log('[DocxViewer] Per-section footer PAGE status:');
  for (let si = 0; si < sections.length; si++) {
    const s = sections[si];
    log(`  Section ${si}: hasPageInFooter=${s.hasPageNumberInFooter}, hasPageInFirstFooter=${s.hasPageNumberInFirstFooter}, pageNumStart=${s.pageNumberStart}, titlePage=${s.titlePage}`);
  }

  const pageNumberStart = 1;

  return {
    content,
    sections,
    defaultSection,
    styles,
    resolvedStyles,
    numbering,
    images,
    docDefaults,
    defaultParaResolvedStyle,
    hasFooterPageNumber,
    pageNumberStart,
  };
}
