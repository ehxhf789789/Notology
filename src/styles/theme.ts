/**
 * Theme CSS variable generator.
 * Converts TypeScript design tokens into CSS custom properties
 * injected via a <style> tag at runtime.
 *
 * Namespace: --color-*, --space-*, --radius-*, --shadow-*, --motion-*, --typo-*
 * (avoids collision with existing --bg-*, --tx-*, --sp-* from tokens.css)
 */
import { colors } from './tokens/colors';
import { spacing } from './tokens/spacing';
import { typography } from './tokens/typography';
import { radius } from './tokens/radius';
import { shadows } from './tokens/shadows';
import { motion } from './tokens/motion';

function buildColorVars(mode: 'light' | 'dark'): string {
  const lines: string[] = [];

  // Background
  for (const [key, val] of Object.entries(colors.bg)) {
    lines.push(`  --color-bg-${key}: ${val[mode]};`);
  }
  // Text
  for (const [key, val] of Object.entries(colors.text)) {
    lines.push(`  --color-text-${key}: ${val[mode]};`);
  }
  // Border
  for (const [key, val] of Object.entries(colors.border)) {
    lines.push(`  --color-border-${key}: ${val[mode]};`);
  }
  // Folder palette
  colors.folder.forEach((hex, i) => {
    lines.push(`  --color-folder-${i}: ${hex};`);
  });
  // Accent
  lines.push(`  --color-accent: ${colors.accent[mode]};`);
  // Semantic
  lines.push(`  --color-success: ${colors.success};`);
  lines.push(`  --color-warning: ${colors.warning};`);
  lines.push(`  --color-error: ${colors.error};`);
  // Overlay
  lines.push(`  --color-overlay: ${colors.overlay[mode]};`);

  return lines.join('\n');
}

function buildSpacingVars(): string {
  return Object.entries(spacing)
    .map(([key, val]) => `  --space-${key}: ${val}px;`)
    .join('\n');
}

function buildTypographyVars(): string {
  const lines: string[] = [];
  lines.push(`  --typo-font-sans: ${typography.fontFamily.sans};`);
  lines.push(`  --typo-font-mono: ${typography.fontFamily.mono};`);

  const scales = ['display', 'title1', 'title2', 'body', 'bodyBold', 'caption', 'micro'] as const;
  for (const name of scales) {
    const [fontSize, lineHeight, fontWeight, letterSpacing] = typography[name];
    lines.push(`  --typo-${name}-size: ${fontSize};`);
    lines.push(`  --typo-${name}-line: ${lineHeight};`);
    lines.push(`  --typo-${name}-weight: ${fontWeight};`);
    lines.push(`  --typo-${name}-spacing: ${letterSpacing};`);
  }
  return lines.join('\n');
}

function buildRadiusVars(): string {
  return Object.entries(radius)
    .map(([key, val]) => `  --radius-${key}: ${val}px;`)
    .join('\n');
}

function buildShadowVars(): string {
  return Object.entries(shadows)
    .map(([key, val]) => `  --shadow-${key}: ${val};`)
    .join('\n');
}

function buildMotionVars(): string {
  const lines: string[] = [];
  for (const [key, val] of Object.entries(motion.ease)) {
    lines.push(`  --ease-${key}: ${val};`);
  }
  for (const [key, val] of Object.entries(motion.duration)) {
    lines.push(`  --duration-${key}: ${val};`);
  }
  for (const [key, val] of Object.entries(motion.transition)) {
    lines.push(`  --transition-${key}: ${val};`);
  }
  return lines.join('\n');
}

function buildCSS(): string {
  const shared = [
    buildSpacingVars(),
    buildTypographyVars(),
    buildRadiusVars(),
    buildShadowVars(),
    buildMotionVars(),
  ].join('\n');

  return `/* Auto-generated from design tokens — do not edit manually */
:root {
${buildColorVars('light')}
${shared}
}

[data-theme="dark"] {
${buildColorVars('dark')}
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
${buildColorVars('dark')}
  }
}
`;
}

let injected = false;

/** Inject design-token CSS variables into the document head. Idempotent. */
export function injectThemeCSS(): void {
  if (injected) return;
  const id = 'notology-design-tokens';
  if (document.getElementById(id)) { injected = true; return; }

  const style = document.createElement('style');
  style.id = id;
  style.textContent = buildCSS();
  document.head.appendChild(style);
  injected = true;
}
