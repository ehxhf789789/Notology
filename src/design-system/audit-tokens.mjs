#!/usr/bin/env node
/**
 * Notology design-system token audit
 * Stage 5.0.1
 *
 * Reports two things:
 *
 *   1. BASELINE (informational, non-blocking)
 *      Counts hardcoded color literals (#xxx / #xxxxxx) and px-based
 *      margin/padding literals across every CSS file in src/.
 *      These are the units that future sub-stages (5.0.3 - 5.0.10)
 *      will migrate to design tokens.
 *
 *   2. TIER-1 LEAKAGE (blocking)
 *      Any --primitive-* reference that appears outside the two
 *      "source" files — src/design-system/tokens.css and
 *      src/styles/base/themes.css — is a hard fail. Tier-1
 *      primitives must NEVER be referenced by component CSS.
 *
 *   Exit code 0 if Tier-1 leakage is 0, else 1.
 *
 * Usage:
 *   node src/design-system/audit-tokens.mjs          # full report
 *   node src/design-system/audit-tokens.mjs --json   # machine-readable
 *
 * Wired into package.json as `npm run audit:tokens`.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
// script lives at src/design-system/audit-tokens.mjs → repo root is two levels up.
const REPO = join(__dirname, '..', '..');
const SRC  = join(REPO, 'src');

const SOURCE_FILES = [
  // Tier-1 primitives may only be referenced from these files.
  join('src', 'design-system', 'tokens.css').split('/').join(sep),
  join('src', 'design-system', 'mobile-tokens.css').split('/').join(sep),
  join('src', 'styles', 'base', 'themes.css').split('/').join(sep),
];

const args = process.argv.slice(2);
const asJSON = args.includes('--json');

/* ---------- file walker ---------- */
function walk(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue;
      walk(full, acc);
    } else if (entry.toLowerCase().endsWith('.css')) {
      acc.push(full);
    }
  }
  return acc;
}

const cssFiles = walk(SRC);

/* ---------- regex patterns ---------- */
// hex literal in a value position — exclude lines that are pure comments
const HEX_RE = /#[0-9a-fA-F]{3,8}\b/g;
// margin/padding raw px in a value (any direction)
const MARGIN_PX_RE = /(?:^|[\s;])(?:margin|padding)(?:-[a-z]+)?\s*:\s*[^;]*?\b\d+px\b/gm;
// --primitive-* reference (var(...) form OR fallback chain)
const PRIMITIVE_USE_RE = /--primitive-[a-z0-9-]+/g;
// Round 2 R7 (2026-05-22): heading absolute px font-size in editor CSS.
// Headers in `.tiptap-editor h1/h2/h3` should land at the tight scale
// agreed in Round 2 (H1 20 / H2 17 / H3 15). Any raw `font-size: NNpx`
// inside an h1/h2/h3 rule that's NOT one of those three is a regression
// signal — the tight-scale rule has been overridden. Reported as a
// non-blocking warning so the user sees drift early.
const TIPTAP_HEADING_FONT_RE = /\.tiptap-editor\s+h[1-6][^{]*\{[^}]*?font-size:\s*(\d+)px/gms;

// Round 2 R7 extension (2026-05-28): paper-pattern + bubble-menu CSS must
// use Tier-2 tokens only — raw color literals or px font-sizes indicate
// drift away from the theme-aware token chain. These files were authored
// in Round 2 and any new color/size that doesn't go through a token is a
// regression candidate. Reported as BLOCKING (exit 1) since the surface
// is small and the rule is unambiguous.
const TOKEN_STRICT_FILES = [
  join('src', 'styles', 'editor-extensions', 'paper-pattern.css').split('/').join(sep),
  join('src', 'styles', 'editor-extensions', 'bubble-menu.css').split('/').join(sep),
];
const RAW_COLOR_RE = /#[0-9a-fA-F]{3,8}\b|\brgba?\s*\(|\bhsla?\s*\(/g;

/* ---------- per-file scan ---------- */
const baseline = {
  hex_literals: 0,
  margin_padding_px: 0,
  files_with_hex: new Set(),
  files_with_margin_px: new Set(),
};

const tier1Leak = []; // { file, line, snippet }
const headingDrift = []; // { file, headerSize } — Round 2 R7 regression watch
const TIGHT_HEADING_SIZES = new Set([20, 17, 15]);
const tokenStrictLeak = []; // { file, line, snippet } — Round 2 R7 extension

for (const file of cssFiles) {
  const rel = relative(REPO, file);
  const isSource = SOURCE_FILES.some(s => rel.endsWith(s));
  const text = readFileSync(file, 'utf8');

  const hexMatches = text.match(HEX_RE) ?? [];
  const marginPxMatches = text.match(MARGIN_PX_RE) ?? [];

  baseline.hex_literals      += hexMatches.length;
  baseline.margin_padding_px += marginPxMatches.length;
  if (hexMatches.length)       baseline.files_with_hex.add(rel);
  if (marginPxMatches.length)  baseline.files_with_margin_px.add(rel);

  if (!isSource) {
    const lines = text.split(/\r?\n/);
    lines.forEach((line, idx) => {
      const m = line.match(PRIMITIVE_USE_RE);
      if (m) {
        for (const ref of m) {
          tier1Leak.push({ file: rel, line: idx + 1, ref, snippet: line.trim() });
        }
      }
    });
  }

  // Round 2 R7 — heading scale drift check.
  let hm;
  while ((hm = TIPTAP_HEADING_FONT_RE.exec(text)) !== null) {
    const size = parseInt(hm[1], 10);
    if (!TIGHT_HEADING_SIZES.has(size)) {
      headingDrift.push({ file: rel, headerSize: size });
    }
  }

  // Round 2 R7 extension — strict token-only files (paper-pattern, bubble-menu).
  if (TOKEN_STRICT_FILES.some(s => rel.endsWith(s))) {
    const lines = text.split(/\r?\n/);
    lines.forEach((line, idx) => {
      // Skip comments — design notes often cite raw colors as examples.
      const trimmed = line.trim();
      if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) return;
      const m = line.match(RAW_COLOR_RE);
      if (m) {
        for (const lit of m) {
          tokenStrictLeak.push({ file: rel, line: idx + 1, lit, snippet: trimmed });
        }
      }
    });
  }
}

/* ---------- emit ---------- */
if (asJSON) {
  const out = {
    baseline: {
      hex_literals: baseline.hex_literals,
      margin_padding_px: baseline.margin_padding_px,
      files_with_hex: baseline.files_with_hex.size,
      files_with_margin_px: baseline.files_with_margin_px.size,
    },
    tier1_leak_count: tier1Leak.length,
    tier1_leak: tier1Leak.slice(0, 50),
    token_strict_leak_count: tokenStrictLeak.length,
    token_strict_leak: tokenStrictLeak.slice(0, 50),
    heading_drift_count: headingDrift.length,
    files_scanned: cssFiles.length,
  };
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
} else {
  const dim   = (s) => `[2m${s}[0m`;
  const bold  = (s) => `[1m${s}[0m`;
  const red   = (s) => `[31m${s}[0m`;
  const green = (s) => `[32m${s}[0m`;
  const yellow= (s) => `[33m${s}[0m`;

  console.log('');
  console.log(bold('Notology design-token audit — Stage 5.0.1'));
  console.log(dim('---------------------------------------------------------------'));
  console.log(`CSS files scanned         : ${cssFiles.length}`);
  console.log('');
  console.log(bold('Baseline (informational — migration targets for 5.0.3–5.0.10)'));
  console.log(`  hex color literals       : ${baseline.hex_literals.toString().padStart(5)} ` +
              dim(`across ${baseline.files_with_hex.size} files`));
  console.log(`  margin/padding px        : ${baseline.margin_padding_px.toString().padStart(5)} ` +
              dim(`across ${baseline.files_with_margin_px.size} files`));
  console.log('');
  console.log(bold('Tier-1 primitive leakage (BLOCKING — must be 0)'));
  if (tier1Leak.length === 0) {
    console.log(green('  PASS') + dim('  no --primitive-* references outside themes.css / tokens.css'));
  } else {
    console.log(red(`  FAIL  ${tier1Leak.length} references found`));
    for (const lk of tier1Leak.slice(0, 25)) {
      console.log(`    ${yellow(lk.file + ':' + lk.line)} ${dim(lk.ref)}  ${lk.snippet.slice(0, 80)}`);
    }
    if (tier1Leak.length > 25) {
      console.log(dim(`    ... and ${tier1Leak.length - 25} more`));
    }
  }
  console.log('');

  // Round 2 R7 — heading drift watch (informational).
  console.log(bold('Heading scale drift (Round 2 R7 — tight scale = H1 20 / H2 17 / H3 15)'));
  if (headingDrift.length === 0) {
    console.log(green('  PASS') + dim('  all .tiptap-editor h1/h2/h3 rules use tight scale'));
  } else {
    console.log(yellow(`  WARN  ${headingDrift.length} rule(s) drift from tight scale`));
    for (const d of headingDrift.slice(0, 10)) {
      console.log(`    ${yellow(d.file)}  font-size: ${d.headerSize}px`);
    }
  }
  console.log('');

  // Round 2 R7 extension — strict token-only files (BLOCKING).
  console.log(bold('Strict token-only files (Round 2 R7 — BLOCKING — must be 0)'));
  console.log(dim('  scope: ' + TOKEN_STRICT_FILES.map(f => f.split(sep).pop()).join(', ')));
  if (tokenStrictLeak.length === 0) {
    console.log(green('  PASS') + dim('  no raw colors in strict-token files'));
  } else {
    console.log(red(`  FAIL  ${tokenStrictLeak.length} raw color literal(s) found`));
    for (const lk of tokenStrictLeak.slice(0, 25)) {
      console.log(`    ${yellow(lk.file + ':' + lk.line)} ${dim(lk.lit)}  ${lk.snippet.slice(0, 80)}`);
    }
    if (tokenStrictLeak.length > 25) {
      console.log(dim(`    ... and ${tokenStrictLeak.length - 25} more`));
    }
  }
  console.log('');
}

process.exit((tier1Leak.length === 0 && tokenStrictLeak.length === 0) ? 0 : 1);
