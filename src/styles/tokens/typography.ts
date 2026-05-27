// Design tokens — Typography
// [fontSize, lineHeight, fontWeight, letterSpacing]

export const typography = {
  fontFamily: {
    sans: "'Pretendard Variable', 'Pretendard', -apple-system, BlinkMacSystemFont, system-ui, sans-serif",
    mono: "'JetBrains Mono', 'Fira Code', monospace",
  },
  // Scale definitions
  display:  ['26px', '34px', 700, '-0.3px'] as const,
  title1:   ['20px', '28px', 600, '-0.2px'] as const,
  title2:   ['17px', '24px', 600, '-0.1px'] as const,
  body:     ['15px', '22px', 400, '0px']    as const,
  bodyBold: ['15px', '22px', 600, '0px']    as const,
  caption:  ['13px', '18px', 400, '0.1px']  as const,
  micro:    ['11px', '14px', 500, '0.3px']  as const,
} as const;
