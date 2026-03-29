import type { ThemeColors, ThemeFonts, ThemeData } from './pptxTypes';

export function parseThemeXml(xmlString: string): ThemeData {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlString, 'application/xml');
  const colors: ThemeColors = {};

  const clrScheme = doc.getElementsByTagName('a:clrScheme')[0];
  if (clrScheme) {
    const tagMap: Record<string, string> = {
      'a:dk1': 'dk1', 'a:dk2': 'dk2', 'a:lt1': 'lt1', 'a:lt2': 'lt2',
      'a:accent1': 'accent1', 'a:accent2': 'accent2', 'a:accent3': 'accent3',
      'a:accent4': 'accent4', 'a:accent5': 'accent5', 'a:accent6': 'accent6',
      'a:hlink': 'hlink', 'a:folHlink': 'folHlink',
    };
    for (const [tag, key] of Object.entries(tagMap)) {
      const el = clrScheme.getElementsByTagName(tag)[0];
      if (el) {
        const srgb = el.getElementsByTagName('a:srgbClr')[0];
        const sys = el.getElementsByTagName('a:sysClr')[0];
        if (srgb) colors[key] = '#' + srgb.getAttribute('val');
        else if (sys) colors[key] = '#' + (sys.getAttribute('lastClr') || sys.getAttribute('val') || '000000');
      }
    }
  }

  colors['tx1'] = colors['dk1'] || '#000000';
  colors['tx2'] = colors['dk2'] || '#44546A';
  colors['bg1'] = colors['lt1'] || '#FFFFFF';
  colors['bg2'] = colors['lt2'] || '#E7E6E6';

  const fonts: ThemeFonts = { majorLatin: 'Calibri Light', minorLatin: 'Calibri', majorEA: '', minorEA: '' };
  const majorFont = doc.getElementsByTagName('a:majorFont')[0];
  if (majorFont) {
    const latin = majorFont.getElementsByTagName('a:latin')[0];
    if (latin) fonts.majorLatin = latin.getAttribute('typeface') || 'Calibri Light';
    const ea = majorFont.getElementsByTagName('a:ea')[0];
    if (ea) fonts.majorEA = ea.getAttribute('typeface') || '';
  }
  const minorFont = doc.getElementsByTagName('a:minorFont')[0];
  if (minorFont) {
    const latin = minorFont.getElementsByTagName('a:latin')[0];
    if (latin) fonts.minorLatin = latin.getAttribute('typeface') || 'Calibri';
    const ea = minorFont.getElementsByTagName('a:ea')[0];
    if (ea) fonts.minorEA = ea.getAttribute('typeface') || '';
  }

  return { colors, fonts };
}
