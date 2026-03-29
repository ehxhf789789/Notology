// ==================== Number Formatting ====================

export function formatNumber(num: number, numFormat: string): string {
  const hangulSyllables = ['가', '나', '다', '라', '마', '바', '사', '아', '자', '차', '카', '타', '파', '하'];
  const hangulJamo = ['ㄱ', 'ㄴ', 'ㄷ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅅ', 'ㅇ', 'ㅈ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];
  switch (numFormat) {
    case 'DIGIT':
      return String(num);
    case 'CIRCLED_DIGIT': {
      // ① ② ③ ... ⑳
      if (num >= 1 && num <= 20) return String.fromCharCode(0x2460 + num - 1);
      return String(num);
    }
    case 'ROMAN_CAPITAL': {
      const vals = [1000, 900, 500, 400, 100, 90, 50, 40, 10, 9, 5, 4, 1];
      const syms = ['M', 'CM', 'D', 'CD', 'C', 'XC', 'L', 'XL', 'X', 'IX', 'V', 'IV', 'I'];
      let result = '';
      let n = num;
      for (let i = 0; i < vals.length && n > 0; i++) {
        while (n >= vals[i]) { result += syms[i]; n -= vals[i]; }
      }
      return result || String(num);
    }
    case 'ROMAN_SMALL':
      return formatNumber(num, 'ROMAN_CAPITAL').toLowerCase();
    case 'LATIN_CAPITAL':
      return num >= 1 && num <= 26 ? String.fromCharCode(64 + num) : String(num);
    case 'LATIN_SMALL':
      return num >= 1 && num <= 26 ? String.fromCharCode(96 + num) : String(num);
    case 'CIRCLED_LATIN_SMALL': {
      // ⓐ ⓑ ⓒ ...
      if (num >= 1 && num <= 26) return String.fromCharCode(0x24D0 + num - 1);
      return String.fromCharCode(96 + num);
    }
    case 'HANGUL':
    case 'HANGUL_SYLLABLE': {
      return hangulSyllables[num - 1] || String(num);
    }
    case 'CIRCLED_HANGUL_SYLLABLE': {
      // ㉮ ㉯ ㉰ ... (U+326E+)
      if (num >= 1 && num <= 14) return String.fromCharCode(0x326E + num - 1);
      return hangulSyllables[num - 1] || String(num);
    }
    case 'HANGUL_JAMO': {
      return hangulJamo[num - 1] || String(num);
    }
    default:
      return String(num);
  }
}

// ==================== Tab Mapping Helpers ====================

/** Map numeric leader code from inline <hp:tab> to string */
export function mapTabLeader(val: string): string {
  switch (val) {
    case '0': return 'NONE';
    case '1': return 'SOLID';
    case '2': return 'DOT';
    case '3': return 'DASH';
    case '4': return 'DASH_DOT';
    case '5': return 'DASH_DOT_DOT';
    default: return val; // already a string like 'DASH'
  }
}

/** Map numeric type code from inline <hp:tab> to string */
export function mapTabType(val: string): 'LEFT' | 'RIGHT' | 'CENTER' {
  switch (val) {
    case '0': return 'LEFT';
    case '1': return 'CENTER';
    case '2': return 'RIGHT';
    default: return (val as 'LEFT' | 'RIGHT' | 'CENTER') || 'LEFT';
  }
}
