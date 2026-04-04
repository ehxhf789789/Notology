/**
 * LaTeX Command Dictionary for Math Autocomplete
 *
 * Provides a searchable dictionary of LaTeX commands organized by category.
 * Used by the math autocomplete suggestion system (triggered by \ in math edit mode).
 */

export type LatexCategory =
  | 'greek'
  | 'operator'
  | 'relation'
  | 'arrow'
  | 'function'
  | 'environment'
  | 'accent'
  | 'delimiter';

export interface LatexCommand {
  command: string;
  label: string;
  category: LatexCategory;
  snippet: string;
  preview: string;
}

const CATEGORY_LABELS: Record<LatexCategory, string> = {
  greek: '그리스 문자',
  operator: '연산자',
  relation: '관계',
  arrow: '화살표',
  function: '함수',
  environment: '환경/구조',
  accent: '액센트/장식',
  delimiter: '괄호/구분자',
};

export { CATEGORY_LABELS };

// ── Greek Letters ──
const greekLetters: LatexCommand[] = [
  { command: '\\alpha', label: 'Alpha (α)', category: 'greek', snippet: '\\alpha', preview: '\\alpha' },
  { command: '\\beta', label: 'Beta (β)', category: 'greek', snippet: '\\beta', preview: '\\beta' },
  { command: '\\gamma', label: 'Gamma (γ)', category: 'greek', snippet: '\\gamma', preview: '\\gamma' },
  { command: '\\delta', label: 'Delta (δ)', category: 'greek', snippet: '\\delta', preview: '\\delta' },
  { command: '\\epsilon', label: 'Epsilon (ε)', category: 'greek', snippet: '\\epsilon', preview: '\\epsilon' },
  { command: '\\varepsilon', label: 'Var Epsilon (ε)', category: 'greek', snippet: '\\varepsilon', preview: '\\varepsilon' },
  { command: '\\zeta', label: 'Zeta (ζ)', category: 'greek', snippet: '\\zeta', preview: '\\zeta' },
  { command: '\\eta', label: 'Eta (η)', category: 'greek', snippet: '\\eta', preview: '\\eta' },
  { command: '\\theta', label: 'Theta (θ)', category: 'greek', snippet: '\\theta', preview: '\\theta' },
  { command: '\\iota', label: 'Iota (ι)', category: 'greek', snippet: '\\iota', preview: '\\iota' },
  { command: '\\kappa', label: 'Kappa (κ)', category: 'greek', snippet: '\\kappa', preview: '\\kappa' },
  { command: '\\lambda', label: 'Lambda (λ)', category: 'greek', snippet: '\\lambda', preview: '\\lambda' },
  { command: '\\mu', label: 'Mu (μ)', category: 'greek', snippet: '\\mu', preview: '\\mu' },
  { command: '\\nu', label: 'Nu (ν)', category: 'greek', snippet: '\\nu', preview: '\\nu' },
  { command: '\\xi', label: 'Xi (ξ)', category: 'greek', snippet: '\\xi', preview: '\\xi' },
  { command: '\\pi', label: 'Pi (π)', category: 'greek', snippet: '\\pi', preview: '\\pi' },
  { command: '\\rho', label: 'Rho (ρ)', category: 'greek', snippet: '\\rho', preview: '\\rho' },
  { command: '\\sigma', label: 'Sigma (σ)', category: 'greek', snippet: '\\sigma', preview: '\\sigma' },
  { command: '\\tau', label: 'Tau (τ)', category: 'greek', snippet: '\\tau', preview: '\\tau' },
  { command: '\\upsilon', label: 'Upsilon (υ)', category: 'greek', snippet: '\\upsilon', preview: '\\upsilon' },
  { command: '\\phi', label: 'Phi (φ)', category: 'greek', snippet: '\\phi', preview: '\\phi' },
  { command: '\\varphi', label: 'Var Phi (φ)', category: 'greek', snippet: '\\varphi', preview: '\\varphi' },
  { command: '\\chi', label: 'Chi (χ)', category: 'greek', snippet: '\\chi', preview: '\\chi' },
  { command: '\\psi', label: 'Psi (ψ)', category: 'greek', snippet: '\\psi', preview: '\\psi' },
  { command: '\\omega', label: 'Omega (ω)', category: 'greek', snippet: '\\omega', preview: '\\omega' },
  { command: '\\Gamma', label: 'Gamma (Γ)', category: 'greek', snippet: '\\Gamma', preview: '\\Gamma' },
  { command: '\\Delta', label: 'Delta (Δ)', category: 'greek', snippet: '\\Delta', preview: '\\Delta' },
  { command: '\\Theta', label: 'Theta (Θ)', category: 'greek', snippet: '\\Theta', preview: '\\Theta' },
  { command: '\\Lambda', label: 'Lambda (Λ)', category: 'greek', snippet: '\\Lambda', preview: '\\Lambda' },
  { command: '\\Xi', label: 'Xi (Ξ)', category: 'greek', snippet: '\\Xi', preview: '\\Xi' },
  { command: '\\Pi', label: 'Pi (Π)', category: 'greek', snippet: '\\Pi', preview: '\\Pi' },
  { command: '\\Sigma', label: 'Sigma (Σ)', category: 'greek', snippet: '\\Sigma', preview: '\\Sigma' },
  { command: '\\Phi', label: 'Phi (Φ)', category: 'greek', snippet: '\\Phi', preview: '\\Phi' },
  { command: '\\Psi', label: 'Psi (Ψ)', category: 'greek', snippet: '\\Psi', preview: '\\Psi' },
  { command: '\\Omega', label: 'Omega (Ω)', category: 'greek', snippet: '\\Omega', preview: '\\Omega' },
];

// ── Operators ──
const operators: LatexCommand[] = [
  { command: '\\cdot', label: '점곱 (·)', category: 'operator', snippet: '\\cdot', preview: 'a \\cdot b' },
  { command: '\\times', label: '곱하기 (×)', category: 'operator', snippet: '\\times', preview: 'a \\times b' },
  { command: '\\div', label: '나누기 (÷)', category: 'operator', snippet: '\\div', preview: 'a \\div b' },
  { command: '\\pm', label: '플마 (±)', category: 'operator', snippet: '\\pm', preview: 'a \\pm b' },
  { command: '\\mp', label: '마플 (∓)', category: 'operator', snippet: '\\mp', preview: 'a \\mp b' },
  { command: '\\sum', label: '합 _{아래}^{위}', category: 'operator', snippet: '\\sum_{$1}^{$2}', preview: '\\sum_{i=1}^{n}' },
  { command: '\\prod', label: '곱 _{아래}^{위}', category: 'operator', snippet: '\\prod_{$1}^{$2}', preview: '\\prod_{i=1}^{n}' },
  { command: '\\int', label: '적분 _{아래}^{위}', category: 'operator', snippet: '\\int_{$1}^{$2}', preview: '\\int_{0}^{\\infty}' },
  { command: '\\iint', label: '이중적분', category: 'operator', snippet: '\\iint', preview: '\\iint' },
  { command: '\\iiint', label: '삼중적분', category: 'operator', snippet: '\\iiint', preview: '\\iiint' },
  { command: '\\oint', label: '선적분 (∮)', category: 'operator', snippet: '\\oint', preview: '\\oint' },
  { command: '\\partial', label: '편미분 (∂)', category: 'operator', snippet: '\\partial', preview: '\\partial' },
  { command: '\\nabla', label: '나블라 (∇)', category: 'operator', snippet: '\\nabla', preview: '\\nabla' },
  { command: '\\infty', label: '무한 (∞)', category: 'operator', snippet: '\\infty', preview: '\\infty' },
  { command: '\\cup', label: '합집합 (∪)', category: 'operator', snippet: '\\cup', preview: 'A \\cup B' },
  { command: '\\cap', label: '교집합 (∩)', category: 'operator', snippet: '\\cap', preview: 'A \\cap B' },
  { command: '\\setminus', label: '차집합 (\\)', category: 'operator', snippet: '\\setminus', preview: 'A \\setminus B' },
  { command: '\\oplus', label: '직합 (⊕)', category: 'operator', snippet: '\\oplus', preview: 'A \\oplus B' },
  { command: '\\otimes', label: '텐서곱 (⊗)', category: 'operator', snippet: '\\otimes', preview: 'A \\otimes B' },
];

// ── Relations ──
const relations: LatexCommand[] = [
  { command: '\\leq', label: '이하 (≤)', category: 'relation', snippet: '\\leq', preview: 'a \\leq b' },
  { command: '\\geq', label: '이상 (≥)', category: 'relation', snippet: '\\geq', preview: 'a \\geq b' },
  { command: '\\neq', label: '부등 (≠)', category: 'relation', snippet: '\\neq', preview: 'a \\neq b' },
  { command: '\\approx', label: '근사 (≈)', category: 'relation', snippet: '\\approx', preview: 'a \\approx b' },
  { command: '\\equiv', label: '항등 (≡)', category: 'relation', snippet: '\\equiv', preview: 'a \\equiv b' },
  { command: '\\sim', label: '유사 (~)', category: 'relation', snippet: '\\sim', preview: 'a \\sim b' },
  { command: '\\simeq', label: '동형 (≃)', category: 'relation', snippet: '\\simeq', preview: 'a \\simeq b' },
  { command: '\\cong', label: '합동 (≅)', category: 'relation', snippet: '\\cong', preview: 'a \\cong b' },
  { command: '\\propto', label: '비례 (∝)', category: 'relation', snippet: '\\propto', preview: 'a \\propto b' },
  { command: '\\in', label: '원소 (∈)', category: 'relation', snippet: '\\in', preview: 'x \\in A' },
  { command: '\\notin', label: '비원소 (∉)', category: 'relation', snippet: '\\notin', preview: 'x \\notin A' },
  { command: '\\subset', label: '부분집합 (⊂)', category: 'relation', snippet: '\\subset', preview: 'A \\subset B' },
  { command: '\\subseteq', label: '부분집합 (⊆)', category: 'relation', snippet: '\\subseteq', preview: 'A \\subseteq B' },
  { command: '\\supset', label: '상위집합 (⊃)', category: 'relation', snippet: '\\supset', preview: 'A \\supset B' },
  { command: '\\perp', label: '수직 (⊥)', category: 'relation', snippet: '\\perp', preview: 'a \\perp b' },
  { command: '\\parallel', label: '평행 (∥)', category: 'relation', snippet: '\\parallel', preview: 'a \\parallel b' },
];

// ── Arrows ──
const arrows: LatexCommand[] = [
  { command: '\\rightarrow', label: '오른쪽 (→)', category: 'arrow', snippet: '\\rightarrow', preview: 'a \\rightarrow b' },
  { command: '\\leftarrow', label: '왼쪽 (←)', category: 'arrow', snippet: '\\leftarrow', preview: 'a \\leftarrow b' },
  { command: '\\leftrightarrow', label: '양방향 (↔)', category: 'arrow', snippet: '\\leftrightarrow', preview: 'a \\leftrightarrow b' },
  { command: '\\Rightarrow', label: '함의 (⇒)', category: 'arrow', snippet: '\\Rightarrow', preview: 'A \\Rightarrow B' },
  { command: '\\Leftarrow', label: '역함의 (⇐)', category: 'arrow', snippet: '\\Leftarrow', preview: 'A \\Leftarrow B' },
  { command: '\\Leftrightarrow', label: '동치 (⇔)', category: 'arrow', snippet: '\\Leftrightarrow', preview: 'A \\Leftrightarrow B' },
  { command: '\\uparrow', label: '위 (↑)', category: 'arrow', snippet: '\\uparrow', preview: '\\uparrow' },
  { command: '\\downarrow', label: '아래 (↓)', category: 'arrow', snippet: '\\downarrow', preview: '\\downarrow' },
  { command: '\\mapsto', label: '대응 (↦)', category: 'arrow', snippet: '\\mapsto', preview: 'x \\mapsto f(x)' },
  { command: '\\to', label: '→ (약칭)', category: 'arrow', snippet: '\\to', preview: 'f: A \\to B' },
];

// ── Functions ──
const functions: LatexCommand[] = [
  { command: '\\frac', label: '분수 {분자}{분모}', category: 'function', snippet: '\\frac{$1}{$2}', preview: '\\frac{a}{b}' },
  { command: '\\dfrac', label: '큰 분수 {분자}{분모}', category: 'function', snippet: '\\dfrac{$1}{$2}', preview: '\\dfrac{a}{b}' },
  { command: '\\sqrt', label: '제곱근 {값}', category: 'function', snippet: '\\sqrt{$1}', preview: '\\sqrt{x}' },
  { command: '\\sqrt[n]', label: 'n제곱근 [n]{값}', category: 'function', snippet: '\\sqrt[$1]{$2}', preview: '\\sqrt[n]{x}' },
  { command: '\\log', label: '로그', category: 'function', snippet: '\\log', preview: '\\log x' },
  { command: '\\ln', label: '자연로그', category: 'function', snippet: '\\ln', preview: '\\ln x' },
  { command: '\\sin', label: '사인', category: 'function', snippet: '\\sin', preview: '\\sin \\theta' },
  { command: '\\cos', label: '코사인', category: 'function', snippet: '\\cos', preview: '\\cos \\theta' },
  { command: '\\tan', label: '탄젠트', category: 'function', snippet: '\\tan', preview: '\\tan \\theta' },
  { command: '\\lim', label: '극한 _{x \\to 0}', category: 'function', snippet: '\\lim_{$1 \\to $2}', preview: '\\lim_{x \\to 0}' },
  { command: '\\sup', label: '상한', category: 'function', snippet: '\\sup', preview: '\\sup S' },
  { command: '\\inf', label: '하한', category: 'function', snippet: '\\inf', preview: '\\inf S' },
  { command: '\\max', label: '최대', category: 'function', snippet: '\\max', preview: '\\max(a, b)' },
  { command: '\\min', label: '최소', category: 'function', snippet: '\\min', preview: '\\min(a, b)' },
  { command: '\\exp', label: '지수', category: 'function', snippet: '\\exp', preview: '\\exp(x)' },
  { command: '\\det', label: '행렬식', category: 'function', snippet: '\\det', preview: '\\det A' },
  { command: '\\dim', label: '차원', category: 'function', snippet: '\\dim', preview: '\\dim V' },
];

// ── Environments / Structures ──
// &: 열 구분, \\: 줄바꿈
const environments: LatexCommand[] = [
  { command: '\\begin{matrix}', label: '행렬 · &로 열, \\\\로 행 구분', category: 'environment', snippet: '\\begin{matrix} $1 & $2 \\\\ $1 & $2 \\end{matrix}', preview: '\\begin{matrix} a & b \\\\ c & d \\end{matrix}' },
  { command: '\\begin{pmatrix}', label: '괄호 행렬 · ( )', category: 'environment', snippet: '\\begin{pmatrix} $1 & $2 \\\\ $1 & $2 \\end{pmatrix}', preview: '\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}' },
  { command: '\\begin{bmatrix}', label: '대괄호 행렬 · [ ]', category: 'environment', snippet: '\\begin{bmatrix} $1 & $2 \\\\ $1 & $2 \\end{bmatrix}', preview: '\\begin{bmatrix} a & b \\\\ c & d \\end{bmatrix}' },
  { command: '\\begin{vmatrix}', label: '행렬식 · | |', category: 'environment', snippet: '\\begin{vmatrix} $1 & $2 \\\\ $1 & $2 \\end{vmatrix}', preview: '\\begin{vmatrix} a & b \\\\ c & d \\end{vmatrix}' },
  { command: '\\begin{cases}', label: '조건분기 · 값 & if 조건', category: 'environment', snippet: '\\begin{cases} $1 & \\text{if } $2 \\\\ $1 & \\text{otherwise} \\end{cases}', preview: '\\begin{cases} x & \\text{if } x>0 \\\\ -x & \\text{otherwise} \\end{cases}' },
  { command: '\\begin{aligned}', label: '수식정렬 · &= 기준 정렬', category: 'environment', snippet: '\\begin{aligned} $1 &= $2 \\\\ $1 &= $2 \\end{aligned}', preview: '\\begin{aligned} a &= b \\\\ c &= d \\end{aligned}' },
  { command: '\\binom', label: '이항계수 {n}{k}', category: 'environment', snippet: '\\binom{$1}{$2}', preview: '\\binom{n}{k}' },
  { command: '\\text', label: '일반텍스트 {내용}', category: 'environment', snippet: '\\text{$1}', preview: '\\text{where } x > 0' },
  { command: '\\mathbb', label: '칠판체 {R,Z,N,Q}', category: 'environment', snippet: '\\mathbb{$1}', preview: '\\mathbb{R}' },
  { command: '\\mathcal', label: '캘리그래피 {L,F}', category: 'environment', snippet: '\\mathcal{$1}', preview: '\\mathcal{L}' },
  { command: '\\mathbf', label: '볼드체 {v,x}', category: 'environment', snippet: '\\mathbf{$1}', preview: '\\mathbf{v}' },
  { command: '\\mathrm', label: '로만체 {d,e}', category: 'environment', snippet: '\\mathrm{$1}', preview: '\\mathrm{d}x' },
];

// ── Accents ──
const accents: LatexCommand[] = [
  { command: '\\hat', label: '모자 (^)', category: 'accent', snippet: '\\hat{$1}', preview: '\\hat{x}' },
  { command: '\\bar', label: '바 (—)', category: 'accent', snippet: '\\bar{$1}', preview: '\\bar{x}' },
  { command: '\\vec', label: '벡터 (→)', category: 'accent', snippet: '\\vec{$1}', preview: '\\vec{v}' },
  { command: '\\dot', label: '점 (˙)', category: 'accent', snippet: '\\dot{$1}', preview: '\\dot{x}' },
  { command: '\\ddot', label: '더블점 (¨)', category: 'accent', snippet: '\\ddot{$1}', preview: '\\ddot{x}' },
  { command: '\\tilde', label: '틸데 (~)', category: 'accent', snippet: '\\tilde{$1}', preview: '\\tilde{x}' },
  { command: '\\overline', label: '위줄', category: 'accent', snippet: '\\overline{$1}', preview: '\\overline{AB}' },
  { command: '\\underline', label: '아래줄', category: 'accent', snippet: '\\underline{$1}', preview: '\\underline{x}' },
  { command: '\\widehat', label: '넓은모자', category: 'accent', snippet: '\\widehat{$1}', preview: '\\widehat{ABC}' },
  { command: '\\widetilde', label: '넓은틸데', category: 'accent', snippet: '\\widetilde{$1}', preview: '\\widetilde{ABC}' },
];

// ── Delimiters ──
const delimiters: LatexCommand[] = [
  { command: '\\left(', label: '왼쪽 괄호', category: 'delimiter', snippet: '\\left( $1 \\right)', preview: '\\left( \\frac{a}{b} \\right)' },
  { command: '\\left[', label: '왼쪽 대괄호', category: 'delimiter', snippet: '\\left[ $1 \\right]', preview: '\\left[ x \\right]' },
  { command: '\\left\\{', label: '왼쪽 중괄호', category: 'delimiter', snippet: '\\left\\{ $1 \\right\\}', preview: '\\left\\{ x \\right\\}' },
  { command: '\\langle', label: '왼쪽 꺾쇠', category: 'delimiter', snippet: '\\langle $1 \\rangle', preview: '\\langle x, y \\rangle' },
  { command: '\\lfloor', label: '바닥 (⌊)', category: 'delimiter', snippet: '\\lfloor $1 \\rfloor', preview: '\\lfloor x \\rfloor' },
  { command: '\\lceil', label: '천장 (⌈)', category: 'delimiter', snippet: '\\lceil $1 \\rceil', preview: '\\lceil x \\rceil' },
  { command: '\\|', label: '이중선 (‖)', category: 'delimiter', snippet: '\\| $1 \\|', preview: '\\| v \\|' },
  { command: '\\ldots', label: '하단 점 (…)', category: 'delimiter', snippet: '\\ldots', preview: '1, 2, \\ldots, n' },
  { command: '\\cdots', label: '중앙 점 (⋯)', category: 'delimiter', snippet: '\\cdots', preview: '1 + 2 + \\cdots + n' },
  { command: '\\vdots', label: '세로 점 (⋮)', category: 'delimiter', snippet: '\\vdots', preview: '\\vdots' },
  { command: '\\ddots', label: '대각 점 (⋱)', category: 'delimiter', snippet: '\\ddots', preview: '\\ddots' },
];

// ── All commands combined ──
export const LATEX_COMMANDS: LatexCommand[] = [
  ...greekLetters,
  ...operators,
  ...relations,
  ...arrows,
  ...functions,
  ...environments,
  ...accents,
  ...delimiters,
];

/**
 * Search LaTeX commands by query string.
 * Prefix matches are ranked higher than substring matches.
 */
export function searchLatexCommands(query: string, limit = 12): LatexCommand[] {
  if (!query) return LATEX_COMMANDS.slice(0, limit);

  const q = query.toLowerCase();
  const prefixMatches: LatexCommand[] = [];
  const substringMatches: LatexCommand[] = [];

  for (const cmd of LATEX_COMMANDS) {
    // Match against command (without leading \) and label
    const cmdName = cmd.command.replace(/^\\+/, '').toLowerCase();
    const labelLower = cmd.label.toLowerCase();

    if (cmdName.startsWith(q) || cmd.command.toLowerCase().startsWith('\\' + q)) {
      prefixMatches.push(cmd);
    } else if (cmdName.includes(q) || labelLower.includes(q)) {
      substringMatches.push(cmd);
    }
  }

  return [...prefixMatches, ...substringMatches].slice(0, limit);
}
