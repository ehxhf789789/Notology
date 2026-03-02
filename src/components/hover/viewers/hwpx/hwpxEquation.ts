// ==================== Equation Script Renderer ====================

/** Symbol mapping for Hangul equation scripts (sorted longest-first for matching) */
export const EQ_SYMBOLS: [string, string][] = [
  // Multi-char first (longest match) — uppercase Greek
  ['TRIANGLE', 'Δ'], ['APPROX', '≈'], ['EQUIV', '≡'], ['SUBSET', '⊂'], ['SUPSET', '⊃'],
  ['UNION', '∪'], ['INTER', '∩'],
  ['DELTA', 'Δ'], ['SIGMA', 'Σ'], ['OMEGA', 'Ω'], ['THETA', 'Θ'],
  ['GAMMA', 'Γ'], ['LAMBDA', 'Λ'], ['ALPHA', 'Α'], ['BETA', 'Β'],
  ['EPSILON', 'Ε'], ['KAPPA', 'Κ'], ['XI', 'Ξ'], ['PSI', 'Ψ'],
  // Operators & dots
  ['TIMES', '×'], ['CDOTS', '⋯'], ['CDOT', '·'],
  ['LDOTS', '…'], ['VDOTS', '⋮'], ['DDOTS', '⋱'],
  // Lowercase Greek
  ['alpha', 'α'], ['beta', 'β'], ['gamma', 'γ'], ['delta', 'δ'], ['epsilon', 'ε'],
  ['zeta', 'ζ'], ['eta', 'η'], ['theta', 'θ'], ['iota', 'ι'], ['kappa', 'κ'],
  ['lambda', 'λ'], ['mu', 'μ'], ['nu', 'ν'], ['xi', 'ξ'], ['pi', 'π'],
  ['rho', 'ρ'], ['sigma', 'σ'], ['tau', 'τ'], ['upsilon', 'υ'], ['phi', 'φ'],
  ['chi', 'χ'], ['psi', 'ψ'], ['omega', 'ω'],
  // Operators & relations
  ['partial', '∂'], ['infty', '∞'], ['inf', '∞'], ['neq', '≠'],
  ['leq', '≤'], ['geq', '≥'], ['LEQ', '≤'], ['GEQ', '≥'], ['NEQ', '≠'],
  ['INF', '∞'], ['PHI', 'Φ'], ['PI', 'Π'],
  ['cdots', '⋯'], ['ldots', '…'], ['vdots', '⋮'], ['ddots', '⋱'],
  ['pm', '±'], ['mp', '∓'], ['cdot', '·'], ['times', '×'], ['div', '÷'],
  ['rarrow', '→'], ['larrow', '←'], ['darrow', '↓'], ['uarrow', '↑'],
  ['lrarrow', '↔'], ['Rarrow', '⇒'], ['Larrow', '⇐'],
  ['forall', '∀'], ['exists', '∃'], ['in', '∈'], ['notin', '∉'],
  ['nabla', '∇'], ['hbar', 'ℏ'], ['ell', 'ℓ'],
  ['prime', '′'], ['dprime', '″'],
];

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Parse Hangul equation script and convert to HTML with proper math formatting.
 * Handles: subscripts, superscripts, fractions (over), sqrt, sum/prod/int with limits,
 * Greek letters, grouping with braces, rm (roman), backtick (space), # (newline).
 */
export function equationScriptToHtml(script: string): string {
  let pos = 0;
  const len = script.length;

  function peek(): string { return pos < len ? script[pos] : ''; }
  function advance(): string { return pos < len ? script[pos++] : ''; }
  function skipSpaces(): void { while (pos < len && script[pos] === ' ') pos++; }

  function matchWord(word: string): boolean {
    if (pos + word.length > len) return false;
    if (script.substring(pos, pos + word.length) !== word) return false;
    // Check character BEFORE: if it's alphanumeric, this isn't a standalone keyword
    if (pos > 0 && /[a-zA-Z0-9]/.test(script[pos - 1])) return false;
    // Check character AFTER: if it's alphanumeric, this isn't a standalone keyword
    const after = pos + word.length;
    if (after < len && /[a-zA-Z0-9]/.test(script[after])) return false;
    pos += word.length;
    return true;
  }

  function parseGroup(): string {
    let html = '';
    while (pos < len && peek() !== '}') {
      html += parseExpr();
    }
    if (peek() === '}') advance();
    return html;
  }

  function parseSingleOrGroup(): string {
    skipSpaces();
    if (peek() === '{') { advance(); return parseGroup(); }
    return parseExpr();
  }

  function parseExpr(): string {
    skipSpaces();
    if (pos >= len) return '';

    const c = peek();

    // Braced group — may be followed by 'over' for fraction
    if (c === '{') {
      advance();
      const content = parseGroup();
      skipSpaces();
      if (matchWord('over')) {
        const denom = parseSingleOrGroup();
        return '<span style="display:inline-flex;flex-direction:column;align-items:center;vertical-align:middle;margin:0 1px">'
          + '<span style="border-bottom:1px solid currentColor;padding:0 3px;line-height:1.3;text-align:center">' + content + '</span>'
          + '<span style="padding:0 3px;line-height:1.3;text-align:center">' + denom + '</span></span>';
      }
      return content;
    }

    // Subscript
    if (c === '_') {
      advance();
      const sub = parseSingleOrGroup();
      return '<sub style="font-size:0.7em;vertical-align:sub">' + sub + '</sub>';
    }

    // Superscript
    if (c === '^') {
      advance();
      const sup = parseSingleOrGroup();
      return '<sup style="font-size:0.7em;vertical-align:super">' + sup + '</sup>';
    }

    // Space / newline
    if (c === '`') { advance(); return ' '; }
    if (c === '#') { advance(); return '<br/>'; }

    // Quoted literal text
    if (c === '"') {
      advance();
      let text = '';
      while (pos < len && peek() !== '"') text += escapeHtml(advance());
      if (peek() === '"') advance();
      return '<span style="font-style:normal">' + text + '</span>';
    }

    // Big operators: sum, prod, int
    if (matchWord('sum')) return '<span style="font-size:1.4em;font-style:normal;vertical-align:middle">Σ</span>';
    if (matchWord('prod')) return '<span style="font-size:1.4em;font-style:normal;vertical-align:middle">Π</span>';
    if (matchWord('int')) return '<span style="font-size:1.4em;font-style:normal;vertical-align:middle">∫</span>';

    // sqrt — radical sign with overline bar
    if (matchWord('sqrt')) {
      const content = parseSingleOrGroup();
      return '<span style="display:inline-flex;align-items:stretch;vertical-align:middle;white-space:nowrap">'
        + '<span style="font-size:1.1em;line-height:1">√</span>'
        + '<span style="border-top:1px solid currentColor;padding:0 2px;line-height:1.2">' + content + '</span></span>';
    }

    // Accent/decoration above or below: bar, dot, ddot, hat, tilde, vec, overline, underline
    if (matchWord('bar') || matchWord('overline')) {
      const content = parseSingleOrGroup();
      return '<span style="text-decoration:overline;text-decoration-thickness:1px">' + content + '</span>';
    }
    if (matchWord('dot')) {
      const content = parseSingleOrGroup();
      return '<span style="display:inline-flex;flex-direction:column;align-items:center;vertical-align:middle">'
        + '<span style="font-size:0.6em;line-height:0.5">·</span>'
        + '<span>' + content + '</span></span>';
    }
    if (matchWord('ddot')) {
      const content = parseSingleOrGroup();
      return '<span style="display:inline-flex;flex-direction:column;align-items:center;vertical-align:middle">'
        + '<span style="font-size:0.6em;line-height:0.5">··</span>'
        + '<span>' + content + '</span></span>';
    }
    if (matchWord('hat')) {
      const content = parseSingleOrGroup();
      return '<span style="display:inline-flex;flex-direction:column;align-items:center;vertical-align:middle">'
        + '<span style="font-size:0.65em;line-height:0.5">^</span>'
        + '<span>' + content + '</span></span>';
    }
    if (matchWord('tilde')) {
      const content = parseSingleOrGroup();
      return '<span style="display:inline-flex;flex-direction:column;align-items:center;vertical-align:middle">'
        + '<span style="font-size:0.7em;line-height:0.5">~</span>'
        + '<span>' + content + '</span></span>';
    }
    if (matchWord('vec')) {
      const content = parseSingleOrGroup();
      return '<span style="display:inline-flex;flex-direction:column;align-items:center;vertical-align:middle">'
        + '<span style="font-size:0.6em;line-height:0.5">→</span>'
        + '<span>' + content + '</span></span>';
    }
    if (matchWord('underline')) {
      const content = parseSingleOrGroup();
      return '<span style="text-decoration:underline">' + content + '</span>';
    }

    // over (standalone, without preceding group — treat as fraction bar)
    if (matchWord('over')) {
      const denom = parseSingleOrGroup();
      return '<span style="display:inline-flex;flex-direction:column;align-items:center;vertical-align:middle;margin:0 1px">'
        + '<span style="border-bottom:1px solid currentColor;padding:0 3px;line-height:1.3"></span>'
        + '<span style="padding:0 3px;line-height:1.3">' + denom + '</span></span>';
    }

    // rm (roman/upright text)
    if (matchWord('rm')) {
      skipSpaces();
      let text: string;
      if (peek() === '{') { advance(); text = parseGroup(); }
      else {
        text = '';
        while (pos < len && /[a-zA-Z0-9]/.test(peek())) text += advance();
      }
      return '<span style="font-style:normal">' + text + '</span>';
    }

    // LEFT/RIGHT delimiters
    if (matchWord('LEFT') || matchWord('left')) {
      skipSpaces();
      const d = peek();
      if ('([|'.includes(d)) { advance(); return escapeHtml(d); }
      if (d === '{') { advance(); return '{'; }
      if (matchWord('lbrace')) return '{';
      return '';
    }
    if (matchWord('RIGHT') || matchWord('right')) {
      skipSpaces();
      const d = peek();
      if (')]|'.includes(d)) { advance(); return escapeHtml(d); }
      if (d === '}') { advance(); return '}'; }
      if (matchWord('rbrace')) return '}';
      return '';
    }

    // Greek letters and symbols (longest match first)
    for (const [key, val] of EQ_SYMBOLS) {
      if (matchWord(key)) return val;
    }

    // Regular character
    advance();
    return escapeHtml(c);
  }

  let result = '';
  while (pos < len) {
    result += parseExpr();
  }
  return result;
}
