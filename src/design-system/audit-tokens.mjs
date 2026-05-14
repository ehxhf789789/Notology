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

/* ---------- per-file scan ---------- */
const baseline = {
  hex_literals: 0,
  margin_padding_px: 0,
  files_with_hex: new Set(),
  files_with_margin_px: new Set(),
};

const tier1Leak = []; // { file, line, snippet }

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
}

process.exit(tier1Leak.length === 0 ? 0 : 1);
