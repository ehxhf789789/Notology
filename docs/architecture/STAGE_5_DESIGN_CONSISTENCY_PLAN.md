# Stage 5 — Full UX Redesign + Design Consistency

**Status**: Drafted 2026-05-14, expanded 2026-05-14,
**confirmed 2026-05-14 (HanBin sign-off)**. Awaiting Stage 4.5 (safety
audit) + Stage 4.6 (attachment migration) completion before kickoff.

**This is NOT a token-cleanup pass.** Scope expanded per HanBin's
2026-05-14 directive: *"the main-window HTML and design as a whole need a
full redesign — simpler, more intuitive, more refined. The current state
is still prototype-level despite recent polish."* Stage 5 therefore opens
with a structural redesign sub-stage (5.0) and then carries the new
structure through the token migration that originally was Stage 5.

## Decision log (2026-05-14)

HanBin sign-off in session 6c67ecfa:
- **Layout redesign confirmed** — Stage 5.0 will produce wireframes and
  component decisions, not just polish existing layout.
- **CSS zoom + native `<video>`/`<audio>` controls incompatibility** —
  integrated into Stage 5.0 as Sub-stage **5.0.5** (px → em / font-size-
  based scaling). No hotfix in interim; users see the existing zoom
  artifact until 5.0 lands.
- **Entry sequencing** updated:
  - Gate A → Stage 4.5 all 5 green
  - Gate B → Stage 4.6 attachment migration done
  - Gate C → Stage 5.0 deliverables (5.0.1–5.0.5) signed off
  - Gate D → Stage 5.1–5.10 execute on signed-off structure

---

## 1. Motivation

Stage 4 has shipped focused improvements to the *attachment* surface — PDF
viewer, office viewers, attachment tab, media embeds, delete UX, migration
modal, conflict resolution polish, CSV viewer. Each lift used the same
design tokens (`--bg-elevated`, `--c-blue`, `--sep-l`, `--fs-12`, `--r-4/6`,
`color-mix(blue X%, transparent)` for hover/selected), but the *rest of the
editor surface* still carries pre-token, ad-hoc styling. The mismatch is
now visible — attachment widgets feel modern, the prose body feels older.

Stage 5 unifies the whole editor + sidebar + modal system around the same
token vocabulary and audits every hardcoded color / font-size / radius /
spacing for replacement.

---

## 2. Scope

### In scope
| Surface | Target | Status today |
|---|---|---|
| **Note embed chip** (`[[…]]`) | Token-driven palette, polished hover/selected, type-tinted dot | Mostly tokens, but hardcoded sync-state colors mix in |
| **Math inline + block** (`$…$`, `$$…$$`) | KaTeX render that matches editor typography + dark/light theme aware | Default KaTeX font, no theme adaptation |
| **Markdown surface** — headings, lists, blockquote, code block, table, callout | Token-driven palette, consistent vertical rhythm | Pre-token (hardcoded grays + arbitrary radii) |
| **Inline formatting** — bold/italic/strike/underline marks, links, footnotes | Subtle token tints, hover preview | Default browser |
| **Comments / memos** | Sidebar panel matches editor card chrome | Standalone styling |
| **Modals + popups + context menus** | One set of card tokens (already in PartialDeleteModal, ConflictListModal, MigrationModal) — propagate to *all* modals | Inconsistent (some use the new tokens, others have hex/rgba) |
| **Toolbars** — editor ribbon, sketch ribbon | 26×26 icon buttons + `color-mix(blue 14%, transparent)` hover (PDF toolbar reference) | Mixed sizes / hover tints |
| **Right panel + sidebar** | Card system matches editor; collapse/expand animations consistent | Ad-hoc |
| **Search + graph + calendar** | Token surfaces; result cards in same vocabulary | Search-attachments tab is the cleanest reference |
| **Frontmatter / YAML editor** | Token-driven inputs, focus rings | Hardcoded outlines |
| **Status bar / titlebar / breadcrumbs** | Token surfaces + tabular-nums for any numeric | Pre-token |

### Out of scope
- Stage 4 work (attachment sync) — already in flight, do not redo.
- Brand identity (logo / wordmark / icon set) — separate decision.
- Localization audit — separate stage if needed.
- Performance regression — only optimize when CSS changes obviously slow paint.

---

## 3. Design Principles (extracted from Stage 4 polish)

### 3.1 Token-first
Every value must come from a CSS variable except when explicit RGB is
required for a known media chrome (e.g., the black `#000` letterbox for
`<video>`). The token vocabulary:

| Category | Tokens |
|---|---|
| Surfaces | `--bg-app`, `--bg-base`, `--bg-elevated` |
| Text | `--tx-1` (primary), `--tx-2` (secondary), `--tx-3` (tertiary), `--tx-4` (quaternary) |
| Separators | `--sep-l` (subtle), `--sep` (default) |
| Accents | `--c-blue`, `--c-red`, `--c-amber`, `--c-green`, `--c-purple`, `--c-teal`, `--c-yellow`, `--c-gray` |
| Type sizes | `--fs-11`, `--fs-12`, `--fs-13`, `--fs-14`, `--fs-16`, `--fs-20`, `--fs-24` |
| Radii | `--r-2`, `--r-4`, `--r-6`, `--r-8`, `--r-12`, `--r-pill` |
| Spacing scale | `--sp-1` (4px) – `--sp-5` (20px) |
| Durations | `--dur-150`, `--dur-200`, `--dur-300` |

### 3.2 Interaction states use `color-mix`
- Hover  → `color-mix(in srgb, var(--c-blue) 8–14%, transparent)`
- Active → `color-mix(in srgb, var(--c-blue) 18–22%, transparent)` + border ~60%
- Selected (node) → 2px outline blue + `0 0 0 4px color-mix(blue 18%, transparent)` halo
- Pressed → 26% mix (rare — only for momentary buttons)

### 3.3 Dividers
- Default `0.5px solid var(--sep-l)` — subtle, half-pixel rendering on HiDPI looks crisp
- Card border `1px solid var(--sep-l)` only when emphasis needed
- Never solid black/white

### 3.4 Numeric displays
- `font-variant-numeric: tabular-nums` for any time/count/size
- min-width to prevent jitter as values change (56px works for "100%", "10:34")

### 3.5 Density
- Toolbar buttons: 26×26 px, gap 6 px, padding 6 px 12 px
- Table rows: 32 px height
- Pill buttons (filter chips): 2–4px vertical / 10px horizontal, 999px radius
- Body text: 13–14px, line-height 1.55

### 3.6 Cards (the centered-block pattern from media embeds)
- Block-level, `margin: 10px auto`, `max-width` based on content
- `--bg-elevated` surface with `0.5px solid --sep-l` border
- Soft `0 1px 2px rgba(0,0,0,0.06)` shadow for depth without distraction
- Inside: filename label (12px, `--tx-1` 500 weight) + media

---

## 4. Audit Methodology (Stage 5.1, week 1)

Run automated greps to inventory pre-token CSS:

```bash
# Hardcoded hex colors (excluding #000 / #fff allowlist for letterbox)
rg -n '#[0-9a-fA-F]{3,8}' src/styles/ --type css | grep -v -E '#000|#fff|#FFF|allowlist'

# Hardcoded font-sizes
rg -n 'font-size:\s*\d+(px|rem|em)' src/styles/ --type css | grep -v 'var(--fs-'

# rgba() literals
rg -n 'rgba\(' src/styles/ --type css

# Hardcoded radii
rg -n 'border-radius:\s*\d+px' src/styles/ --type css | grep -v 'var(--r-'
```

Produce `docs/architecture/stage_5_audit.md` with one row per finding:
file, line, current value, proposed token, rationale.

Goal: < 50 hex literals remaining (allowlist: `#000` for video letterbox,
`#fff` for image embed paper backgrounds, brand purple in logo asset CSS).

---

## 5. Sequencing (Sub-stages)

Each sub-stage is bounded so it can be merged as an independent PR.
**Sub-stage 5.0 (structural redesign) is the gate** — token migration
applied to the current structure would just polish a prototype-shaped UI.
The redesign defines the target structure; everything after 5.0 fills it
in with tokenized components.

### 5.0 — Main-window structural redesign (2–3 sessions, blocker)

**Goal**: Replace the prototype-feel layout with a deliberate, simpler
information architecture. Reduce visual noise; surface the user's primary
task (note editing) without ceremony; demote sync / status / settings to
secondary surfaces.

**Deliverable order**:

#### 5.0.1 — Audit + critique of the current main window (1 session)
Walk every visible region of `App.tsx → AppLayout` and produce
`docs/architecture/stage_5_main_window_audit.md` with screenshots + a
critique per region. Use these axes:
- **Information density**: too sparse / right / too dense
- **Affordance clarity**: can a first-time user guess what each control does?
- **Visual hierarchy**: which element draws the eye first; should it?
- **Redundancy**: does this control duplicate something elsewhere?
- **Prototype tell**: does it feel scaffolded vs. crafted?

Regions to audit (from current `App.tsx`):
- Titlebar (Notology label / window controls)
- Left sidebar (folder tree + tab switches)
- Center area (note editor + container view)
- Right panel (hover-panel / comments / metadata)
- Bottom-left sync status chip + popover
- Bottom-right anything (currently empty?)
- Modal overlays (12+ different ones)
- Context menus
- Ribbon / toolbar above editor
- Floating selection toolbar
- Search panel (full-pane Search.tsx)
- Graph view, Calendar view, Settings view

For each: 1 paragraph critique + a "redesign brief" (what to do).

#### 5.0.2 — Reference + principles (0.5 session)
Pull design vocabulary from references HanBin already cited as good (Linear,
Notion, Obsidian, Slack), distilled to ~10 principles:
- Quiet by default — color only carries semantic meaning when needed
- One primary action per surface — chrome doesn't compete with content
- Progressive disclosure — second-order controls hide until needed
- Density matched to function (editor: comfortable / sidebar: dense)
- Type scale 11/12/13/14/16/20 — no in-between
- Single accent color (blue) — never two simultaneously
- Animation: 150ms ease for state, 200ms ease-out for entry — never longer
- No tooltips for primary actions (label is the affordance)
- Empty states designed, not omitted
- Modal as scarce resource — inline over modal where possible

Output: `docs/architecture/stage_5_design_principles.md`. This is the
mandate. Every PR after 5.0 must cite the principle(s) it upholds.

#### 5.0.3 — Wireframes for the new main window (1 session)
Low-fidelity ASCII + textual descriptions (not Figma — we have no design
tool budget). For each region, propose:
- Final layout (positions, sizes, what's collapsed/expanded)
- Visible primary actions
- Hidden secondary actions (where they live)
- Empty state
- Loading state
- Error state

Specific high-level shifts to consider (each up for explicit decision):
- **Status chip relocation**: bottom-left → titlebar far-right, next to window controls. Dot-only. Tooltip on hover. (Inspired by IDE patterns.)
- **Sidebar simplification**: collapse tab switches (Files / Search / Graph / Calendar) into a thin icon rail; current row-style tab strip is loud
- **Right panel default-closed**: only opens on explicit user action (comments / properties), not as a "Maybe you want this" companion
- **Single ribbon vs. floating toolbar**: pick one philosophy
- **Modal taxonomy**: classify each existing modal as
  Confirm / Input / Long-form / Picker; pick one component per class
  and migrate all instances
- **Empty editor experience**: when no note is open, what does the user
  see? Currently shows… nothing. Should show: recent notes / templates
  / quick capture

Output: `docs/architecture/stage_5_wireframes.md`.

#### 5.0.4 — Component inventory + decision matrix (0.5 session)
For every React component currently rendered in the main window, decide:
- KEEP as-is
- KEEP, restyle in 5.x
- MERGE with another component
- REPLACE with new component
- REMOVE

Output: a table at `docs/architecture/stage_5_component_decisions.md`.
This table drives the sequencing of 5.1–5.10.

#### 5.0.5 — CSS scaling overhaul: `zoom` → font-size / em (1 session)

**Decision (HanBin sign-off 2026-05-14)**: the seek-visual-desync bug in
inline `<video>`/`<audio>` embeds is caused by `style={{ zoom: ... }}`
applied at `HoverEditor.tsx:881`. CSS `zoom` is a Chromium-only legacy
property and incompatible with native HTML5 media controls' shadow-DOM
hit-testing. Sub-stage 5.0.5 replaces it with font-size / em-based
scaling so the whole editor (including text *and* media) scales
predictably without breaking native controls.

**Why em / font-size rather than `transform: scale()` or wrapper
reverse-zoom**: HanBin explicitly chose the *most compatible + most
stable* path. Em-based scaling is W3C-standard, has zero interaction
with native controls (they have their own font sizing), and aligns
with the token consolidation already happening in 5.1. The trade-off
is breadth: every hardcoded px in the editor must become em-equivalent.
Acceptable because 5.1's token audit is doing this work anyway.

**Method**:
1. Define a single root font-size token `--editor-root-font-size` driven
   by `hoverZoomLevel` (e.g., 100% → `13px`, 80% → `10.4px`, 200% → `26px`).
2. Remove `style={{ zoom: hoverZoomLevel / 100 }}` from `HoverEditor.tsx`.
3. Migrate all editor-scope px values (headings, lists, blockquotes,
   code blocks, tables, wikilink chips, media embed wrappers, toolbars,
   right-panel cards) to em or rem.
4. Native media controls (`<video>` / `<audio>`) inherit user-agent
   sizing and are NOT scaled by editor zoom — this is the intentional
   trade: zoom affects text + chrome, leaves media controls at native
   size (which is what every other modern editor does).
5. Add `Ctrl+0` / `Ctrl+Plus` / `Ctrl+Minus` shortcuts adjusting
   `--editor-root-font-size` instead of triggering `zoom`.

**Pre-requisite**: 5.0.4 component decisions inventory complete (so we
know which components fall in scope vs. out-of-scope — e.g., XlsxViewer
keeps its current CSS `zoom: <value>` since it has its own zoom
controls and its grid cells aren't inline-block media).

**Exit**:
- `zoom: ` removed from `HoverEditor.tsx` and any other editor-scope file
- Ctrl+0/+/- shortcut audit: every shortcut path lands on the root font-
  size token, not on `zoom`
- Manual verification: video seek thumb stays synced with played fill
  at 50%, 100%, 150%, 200% editor zoom
- No regression in canvas / sketch editors (their existing CSS `zoom`
  is preserved — they're out of scope)

**Estimated**: 1 session if 5.0.4 inventory is clean; +1 session if
many px-to-em conversions surface unexpected layout regressions.

---

**Exit criteria for 5.0**: HanBin signs off on the audit, principles,
wireframes, decision matrix, AND the zoom-overhaul plan. Subsequent
sub-stages execute the plan without re-litigating structure.

### 5.1 — Token Audit + Migration Script (1 session)
Output: `stage_5_audit.md` inventory + a `scripts/css-token-migrate.mjs`
that does automatic safe replacements (e.g., `#3b82f6` → `var(--c-blue)`)
for unambiguous cases. Leaves judgement calls (e.g., what shade of gray
maps to which `--tx-*`) for human review.

### 5.2 — Editor Surface (2 sessions)
- Headings h1–h6: token color + size scale, consistent margin
- Bullet/ordered lists: indent rhythm, marker color
- Blockquote: left-bar styling using `--c-blue` + `--bg-elevated` tint
- Code block: monospace token + `--bg-elevated` card + line-number gutter
- Inline code: `--bg-elevated` chip
- Horizontal rule: `0.5px --sep-l`
- Table: 32px rows, 0.5px borders, hover row tint, sticky header

### 5.3 — Inline Embeds Family (1 session)
- Wikilink chip: type-tinted dot (note type colors) — already partial
- Math inline: KaTeX styled to match `--tx-1` / `--fs-13`
- Math block: card wrapper, hover state, error state
- Footnote markers: superscript chip
- Comment marker: small pill with author initials

### 5.4 — Modals + Popups (1 session)
- Audit all modals: MoveNoteModal, TitleInputModal, ContactInputModal,
  MeetingInputModal, PaperInputModal, LiteratureInputModal, EventInputModal,
  VaultLockModal, AlertModal, RenameDialog, TemplateSelector
- Unify on the MigrationModal token set (already polished in Stage 4)
- Context menu: ensure consistent with PDF toolbar tokens

### 5.5 — Toolbar + Ribbon (1 session)
- Editor ribbon: align with PDF toolbar (26×26 icons, 6px gap)
- Sketch ribbon: same
- Floating selection toolbar (bold/italic mini): consistent radii

### 5.6 — Sidebar + RightPanel + TitleBar (1 session)
- Sidebar: folder tree row 28px, hover blue 8%, active blue 14%
- RightPanel: card system for comments / properties
- TitleBar: window controls aligned
- **Sync status indicator** (`SyncV2StatusIndicator.tsx` + `sync-v2.css`) —
  current bottom-left chip is too loud for an idle state:
  - Always shows green dot + "동기화됨" label even in the steady state
  - Tooltip duplicates the label
  - The popover surface is fine; only the *trigger* needs simplification

  **Target redesign**:
  - **Idle**: 6px dot only (no label). Color = `--tx-3` muted gray when fully
    synced, NOT green. Green is loud and reads as "alert: success" which is
    wrong for a quiescent state. (Linear / Slack / Discord all do this.)
  - **Syncing**: 6px dot in `--c-blue` with a subtle pulse (1.2s opacity).
    Optional inline "..." trailing dots after the dot.
  - **Conflict**: 6px dot in `--c-red` + numeric badge (existing — keep).
  - **Error**: 6px dot in `--c-red` (steady).
  - **Paused**: 6px dot in `--tx-4` (very muted) + small ⏸ glyph adjacent.
  - **Offline**: 6px dot in `--c-amber` (network is a transient warning,
    not a failure — amber is correct here).
  - Tooltip on hover: shows the human-readable label (so it's discoverable).
  - Click: opens existing activity popover.
  - Width: collapses from current ~80px (dot+label) to ~16px (dot+8px hit-target).
  - Position: bottom-left corner, 12px from edge.
  - Optional: show the label inline only for ~3s after a state transition,
    then fade to dot-only (Apple-style "transient label").

  **Rationale**: a sync indicator should be invisible when everything's
  fine and conspicuous when something's wrong. Current design is the
  inverse — loud green on idle, no extra emphasis on conflict (the badge
  is the only differential). The redesign inverts the salience curve.

### 5.7 — Search + Graph + Calendar (1 session)
- Search tabs: AttachmentsTab is the reference (already polished)
- Graph: node colors from `--c-*` tokens
- Calendar: day cells, event chips

### 5.8 — Theme Audit (Dark + Light parity) (1 session)
Walk every component in both themes. Document deviations
(e.g., XlsxViewer cells stay white in dark mode — intentional).
Lock down rules in `src/styles/base/themes.css`.

### 5.9 — Density / Compact Mode (optional, 1 session)
Some users prefer denser UI (file managers). Add a `[data-density="compact"]`
attribute on html → reduces all paddings + heights ~75%. Settings toggle.

### 5.10 — Regression Pass (1 session)
- Visual diff against snapshots from Stage 4
- A11y: focus-visible rings on every interactive element
- Keyboard: tab order audit
- Final docs update

---

## 6. Deliverables

| Doc | Sub-stage | Purpose |
|---|---|---|
| `stage_5_main_window_audit.md` | 5.0.1 | Region-by-region critique + redesign brief |
| `stage_5_design_principles.md` | 5.0.2 | ~10 principles, the mandate |
| `stage_5_wireframes.md` | 5.0.3 | Layout proposal per region |
| `stage_5_component_decisions.md` | 5.0.4 | KEEP/MERGE/REPLACE/REMOVE per component |
| `stage_5_audit.md` | 5.1 | Token-migration inventory |
| `design-tokens.md` | 5.1 | Canonical token vocabulary (consolidate `tokens.css` files) |
| `scripts/css-token-migrate.mjs` | 5.1 | Safe-replacement automation |
| Updated `CLAUDE.md` | 5.10 | "Design consistency: every new CSS rule must use tokens; every new component must cite a principle" hard rule |

---

## 7. Risk + Mitigation

| Risk | Mitigation |
|---|---|
| Visual regressions on existing notes | Take screenshots before each sub-stage; visual diff in PR |
| Token name churn breaks third-party CSS plugins (future) | Token names frozen via 5.1 audit; rename only with explicit version bump |
| Dark/light theme drift | 5.8 dedicated pass; CI snapshot in both themes |
| User aesthetics preference differs | Stage 5 polishes *within* the existing direction; if a redesign is wanted, that's Stage 6 (not Stage 5) |

---

## 8. Out-of-Stage Wishlist (capture for later)

- Sketch editor: native pen pressure / palm rejection (Windows Ink hookup)
- Editor: drag-to-reorder list items
- Modal: stacking system (z-index sentinel rather than ad-hoc 9999)
- Toolbar: customizable button set per note type
- Note canvas: link curve smoothing
- Calendar: drag-to-create event
- Mobile: complete polish pass (separate stage)

These are NOT Stage 5 — captured so we don't lose them while doing the
consistency pass.

---

## 9. Entry Criteria (when to start Stage 5)

- [x] Stage 4 attachment sync stabilized
- [x] Media embed (image/video/audio) inline atom node landed
- [x] Migration modal in place
- [x] Conflict resolution flow polished
- [x] Faststart re-mux ported to Rust + integrated into `attachment_add`
- [x] POC cleanup (Track B Phase B-1 dead code removed)
- [ ] **Stage 4.5 safety audit** (see `STAGE_4_5_SAFETY_AUDIT_PLAN.md`)
      — gate: all 5 sub-stages green
- [ ] No open Stage-4-tagged regressions

When Stage 4.5 is green, Stage 5 starts with **Sub-stage 5.0** (structural
redesign — not token cleanup). Token migration (5.1) only begins once 5.0
deliverables are signed off, because applying tokens to the existing
prototype-shaped layout would lock that shape in.

**Two-gate model**:
- **Gate A** (Stage 4.5 complete) → unlocks Stage 5.0 (redesign)
- **Gate B** (Stage 5.0 signed off) → unlocks Stage 5.1–5.10 (execution)

---

## 10. Reference — current "good" examples in the codebase

- [pdf-viewer.css](../../src/styles/viewers/pdf-viewer.css) — toolbar
- [search-attachments.css](../../src/styles/components/search-attachments.css) — table + filter pills + sortable headers
- [migration.css](../../src/styles/features/migration.css) — modal + progress
- [editor-attachments.css `.wiki-image-embed-wrapper`](../../src/styles/components/editor-attachments.css) — embed card pattern
- [sync-v2.css `.sync-v2-conflict-batch-btn`](../../src/styles/features/sync-v2.css) — primary button

These are the "look like this everywhere else" anchors for Stage 5.
