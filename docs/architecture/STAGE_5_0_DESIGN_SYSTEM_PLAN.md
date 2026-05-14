# Stage 5.0 — Notology Design System & Full UI/UX Redesign Plan

**Drafted**: 2026-05-14
**Status**: Plan only — implementation deferred to sub-stage commits
**Trigger**: HanBin sign-off — current UI is "기능이 계속 추가되면서 디자인을 기워 넣은 형태", needs full redesign by a professional frontend designer's lens.
**Scope**: Every visible surface across desktop + mobile. Design system, components, screens, microcopy, motion, accessibility.

---

## 0. Why this plan exists (and why it must be a full plan, not a patch)

Stage 4.x (sync, attachment migration, faststart) is feature-complete and stable. Functional debt is paid. What remains is **visual / interaction debt** that accumulated organically:

- **70+ CSS files**, ~3000 LOC, no enforced design tokens — `--c-amber: #f59e0b` hardcoded in [`migration.css`](../../src/styles/features/migration.css), `--bdr-2: rgba(148, 163, 184, 0.2)` re-derived per file.
- **12 modals** in [`src/features/modals/`](../../src/features/modals/) each carrying their own CSS file. No shared modal primitive — every dialog is a unique snowflake.
- **2 sync UI generations** ([`sync.css`](../../src/styles/features/sync.css) + [`sync-v2.css`](../../src/styles/features/sync-v2.css)) coexist with no migration plan.
- **Light/dark theme** split across files (`document-viewers.css` vs `document-viewers-dark.css`) instead of one file with token swaps.
- **Mobile + desktop** are entirely parallel implementations (32 mobile components vs ~130 desktop) with no shared primitive layer.
- **8 viewer surfaces** (Image / Code / PDF / Web / DOCX / HWPX / PPTX / XLSX) — chrome / titlebar / toolbar all bespoke per format.
- **19 TipTap extensions** wired into one giant collapsible toolbar — no information architecture beyond grouping by function.
- **12 note templates** with 12 different input modals — Contact / Meeting / Event / Paper / Literature each get a hand-rolled form.

Patching incrementally has been the pattern for two years. The result is correct but non-cohesive. **Stage 5.0 takes the approach of "design from zero" while keeping all functionality identical** — an interface rewrite, not a feature change.

---

## 1. Current-state analysis

### 1.1 What works well (keep)

- **Modular architecture**: `src/core/` + `src/features/{name}/` separation is solid (CLAUDE.md golden rules). Stage 5.0 fits inside this — no architectural rewrite.
- **Tokens file exists**: [`src/design-system/tokens.css`](../../src/design-system/tokens.css) and [`mobile-tokens.css`](../../src/design-system/mobile-tokens.css) — usable foundation.
- **Theme switching infrastructure**: `useSettingsStore` already has `theme: light|dark|system`. The bones are right.
- **Settings registry + plugin slot system** ([`SettingsRegistry.ts`](../../src/features/settings/SettingsRegistry.ts), [`slotRegistry.ts`](../../src/core/infrastructure/slotRegistry.ts)) — extensibility is built in. New design must preserve these contracts.
- **Korean + English i18n**: `src/utils/i18n.ts` works.
- **Lucide icon library**: single icon source — keep, don't replace.

### 1.2 What's broken or inconsistent (fix)

**Visual debt** (counted, not subjective):

| Issue | Count | Evidence |
|---|---|---|
| CSS files | 70+ | `src/styles/**/*.css` |
| Color literals not from tokens | ~80 | `grep -rn '#[0-9a-fA-F]\{3,6\}' src/styles/` outside `themes.css` |
| Spacing literals (margin/padding in px not tokens) | ~hundreds | `grep -rE 'margin: *[0-9]+px\|padding: *[0-9]+px' src/styles/` |
| Per-modal CSS files instead of shared primitive | 8 | `src/styles/modals/*.css` |
| Light/dark file duplication | 2 explicit + many implicit | `document-viewers-dark.css`, `themes.css` |
| Sync UI duplication | 2 generations | `sync.css` + `sync-v2.css` |
| Inline `style={{...}}` (escapes design system) | unknown | requires audit |
| Heading-modal-* CSS class name patterns shared by unrelated components | n/a | `migration-modal-*` reused for `FaststartMigrationModal` (Stage 4.6.2 — pragmatic but fragile) |
| Different button styles per surface | many | RibbonBar buttons, toolbar buttons, modal buttons all visually distinct |

**Interaction debt**:

- **Modal dismissal**: some support ESC + backdrop-click + close-X, others only X (no convention).
- **Loading states**: some surfaces show spinners, others go blank (Search, Graph). No standard skeleton/loading component.
- **Empty states**: Mobile has [`EmptyState.tsx`](../../src/features/mobile/components/EmptyState.tsx) primitive; desktop reinvents per surface.
- **Toast system**: [`shared/Toast.tsx`](../../src/features/shared/Toast.tsx) exists but desktop doesn't consistently use it (errors often `console.warn` only).
- **Confirmation patterns**: [`ConfirmDeleteModal`](../../src/features/modals/ConfirmDeleteModal.tsx) for delete; [`AlertModal`](../../src/features/modals/AlertModal.tsx) for warn. No unified `<ConfirmDialog>` primitive.
- **Tooltip / hint copy**: ad-hoc — some buttons have tooltips, most don't.
- **Keyboard shortcuts visibility**: settings panel shows them, but in-context menus rarely do.
- **Right-panel discoverability**: Calendar/Tasks panel visible by default; tag/comment/outline panels accessible only via slot registration → no UI affordance to discover them.
- **Editor toolbar collapse**: default collapsed → first-time users may not find any formatting (HanBin's 2026-05-13 feedback).
- **Hover-window behavior**: dragging, resizing, snapping inconsistent across viewers. Image viewer pans, PDF doesn't.
- **Multi-window state**: hover windows lose state on F5/HMR (Stage 4.x fixed reload bug, but the pattern that allowed it remains fragile).

**Information architecture debt**:

- **Settings tabs** (General / Display / Appearance / Templates / Shortcuts) — 5 tabs, but related options scattered (theme/language/font in Appearance; toolbar-collapse-default in Display; hover-window zoom in Display) — user has to hunt.
- **Note creation flow**: 12 templates × 5 with custom input modals = no consistent "I'm about to create a note" surface. Sketch jumps straight to canvas, Note opens editor with title prompt, Contact opens a form modal.
- **Search surface**: 4 tabs (Frontmatter / Content / Attachments / Details) is heavy; the Details tab is essentially Frontmatter + everything → unclear distinction.
- **Wikilink autocomplete vs slash commands**: two different popups for similar action — inserting a reference. No unified "command palette" pattern.

**Accessibility gaps** (audit-incomplete):

- Many modals use `role="dialog"` + `aria-modal="true"` + `aria-labelledby` correctly (good).
- Focus management on modal open/close inconsistent (some autoFocus the primary action, some don't).
- Color contrast not enforced — themes.css colors not WCAG-checked.
- Keyboard-only navigation through hover windows / right panels not tested.

### 1.3 Scope of "all of Notology" — surfaces to redesign

From the inventory (input doc):

**A. App shell** — TitleBar, Sidebar, RightPanel, Editor area, hover layer
**B. Editor** — Toolbar, bubble menu, slash commands, suggestions, 19 extensions
**C. 12 Modals** — Confirm / Alert / Rename / TitleInput / Move / Contact / Meeting / Event / Paper / Literature / BulkTag / VaultLock
**D. Settings** — 5 tabs + plugin tabs
**E. 12 Note templates + selectors + 5 input forms**
**F. 8 Viewers** — Image / Code / PDF / Web / DOCX / HWPX / PPTX / XLSX
**G. Right panels** — Calendar/Tasks, Tag, Comment, Outline, Metadata/YAML
**H. Special features** — Canvas (Sketch), Graph, Calendar (full), Search, FolderTree
**I. Sync/Vault** — VaultSelector, SyncStatusIndicator, ConflictListModal, BranchPickerModal, TrashPanel, MigrationModal, FaststartMigrationModal
**J. Mobile (32 components)** — separate but parallel surface; redesign keeps mobile shell, refactors shared primitives

Not in Stage 5.0 scope:
- Functional behavior changes (existing features keep working identically)
- Backend (sync_v2, attachment_store, etc.) — purely frontend redesign
- Loss of any current capability — this is a visual / IA refresh, not a feature cut

---

## 2. Design system foundation (Stage 5.0.1)

The core deliverable. Everything else depends on this landing first.

### 2.1 Token taxonomy

Replace ad-hoc CSS variables with a strict three-tier token system in [`src/design-system/tokens.css`](../../src/design-system/tokens.css):

**Tier 1 — Primitives** (raw values, never used directly by components):
```
--primitive-blue-50 ... --primitive-blue-900
--primitive-gray-0 ... --primitive-gray-1000
--primitive-red / amber / green / purple
--primitive-space-0 (0) ... --primitive-space-12 (96px)
--primitive-radius-0 ... --primitive-radius-full
--primitive-font-mono / sans / display
--primitive-fs-10 ... --primitive-fs-32
--primitive-fw-400 / 500 / 600 / 700
--primitive-shadow-1 / 2 / 3
```

**Tier 2 — Semantic** (light + dark variants, what components use):
```
--bg-app / --bg-elev-1 / --bg-elev-2 / --bg-elev-3
--bg-input / --bg-input-hover / --bg-input-active
--tx-1 (primary) / --tx-2 (secondary) / --tx-3 (tertiary) / --tx-disabled
--bdr-1 (subtle) / --bdr-2 (default) / --bdr-3 (strong) / --bdr-focus
--c-accent / --c-accent-hover / --c-accent-pressed
--c-success / --c-warning / --c-danger / --c-info
--c-on-accent / --c-on-success / --c-on-warning / --c-on-danger
--space-xs (4) / -sm (8) / -md (12) / -lg (16) / -xl (24) / -2xl (32) / -3xl (48)
--radius-sm (4) / -md (6) / -lg (10) / -xl (16) / -full (9999)
--fs-caption / -body / -title / -h1 / -h2 / -h3
--lh-tight / -normal / -relaxed
--shadow-pop / -modal / -overlay / -inset
--motion-fast (150ms) / -normal (250ms) / -slow (400ms)
--ease-standard / -accelerate / -decelerate
```

**Tier 3 — Component** (one-off, opt-in for components that need fine control):
```
--btn-primary-bg / --btn-primary-fg
--modal-backdrop-bg / --modal-radius
--toolbar-height
--titlebar-height
```

**Migration rule**: every component CSS file may reference Tier 2 + Tier 3. **Tier 1 is forbidden** outside `tokens.css`.

### 2.2 Color & theme

- Light + dark + system (existing). One `themes.css` with token-based light/dark variants. **No more `*-dark.css` parallel files.**
- Optional accent color (later sub-stage) — user picks from 6 presets.
- Note-type colors ([`base/note-type-colors.css`](../../src/styles/base/note-type-colors.css)) — convert to semantic tokens (`--note-type-meeting`, `--note-type-paper`, etc.) so theme changes propagate.

### 2.3 Typography

- Single font stack default (system UI; fallbacks to Pretendard for Korean, system-ui for Latin).
- Built-in fonts list trimmed to 5 well-tested choices. Custom fonts (existing capability) retained.
- Type scale: caption (12) / body (14) / title (16) / h3 (18) / h2 (22) / h1 (28). Line-heights from tokens.
- Korean character spacing tested at each size — Korean has different optical baseline than Latin; Stage 5.0 audits each surface.

### 2.4 Spacing

- 4px grid (4 / 8 / 12 / 16 / 24 / 32 / 48). `--space-*` tokens. **No more raw `padding: 18px` or `margin: 6px`.**
- Inset / stack / inline spacing patterns documented.

### 2.5 Motion

- 3 standard durations + 3 standard easings (`ease-standard` for most things, `accelerate` for exits, `decelerate` for enters).
- Reduced-motion respected (`prefers-reduced-motion: reduce` → fast/instant transitions).

### 2.6 Iconography

- [Lucide React](https://lucide.dev/) — keep. Curate a "house style" subset (~40 icons). Document the canonical icon for each action so multiple modules don't pick different icons for the same concept (e.g. some use `Edit2` for rename, others `Pencil`).

---

## 3. Component primitive library (Stage 5.0.2)

Build a small set of design-system components that every screen reuses. Live in `src/design-system/components/`.

| Primitive | Replaces today | Notes |
|---|---|---|
| `<Button variant="primary|secondary|ghost|danger" size="sm|md|lg">` | Per-modal `.migration-modal-btn-primary`, RibbonBar buttons, toolbar buttons | Single source of button truth |
| `<IconButton icon=... aria-label=...>` | Many `<button class="icon-only">` patterns | Accessibility-correct icon-only button |
| `<Input>` / `<Textarea>` / `<Select>` / `<Checkbox>` / `<Toggle>` / `<Radio>` | Hand-rolled in every form | Form primitives with consistent focus rings |
| `<Tooltip>` | Inconsistent `title=` attribute usage | Real tooltip with positioning |
| `<Dialog>` (modal primitive) | 12 distinct modal CSS files | Title + body + footer slots; standard ESC/backdrop-click semantics; focus trap |
| `<Popover>` | Hand-rolled positioning in suggestion lists | Floating-UI-backed positioning |
| `<DropdownMenu>` / `<ContextMenu>` | [`ContextMenu.tsx`](../../src/features/context-menu/ContextMenu.tsx) becomes thin wrapper | Keyboard-navigable |
| `<Tabs>` | Settings tabs + Search tabs hand-rolled | One Tabs primitive |
| `<Toast>` | [`shared/Toast.tsx`](../../src/features/shared/Toast.tsx) exists; promote to primitive used everywhere | Replace `console.warn` with toast |
| `<EmptyState icon title description action>` | Mobile has it, desktop reinvents | Used for empty Search / empty Graph / empty Calendar / empty Folder |
| `<Skeleton>` | None today (blank loading) | For Search results loading, hover-window content loading |
| `<Spinner>` | Various — `<div class="spinner">` and inline SVGs | Single primitive |
| `<Badge>` | Sync status, note-type, count badges all hand-rolled | One primitive |
| `<Card>` | Search result rows reinvent | Search/Calendar/Graph cards |
| `<KeyboardHint keys={['Ctrl','K']}>` | Settings panel renders inline; menus don't show | Reusable shortcut display |
| `<SegmentedControl>` | Mobile has it; desktop tab UIs are heavier | For Search mode tabs |
| `<ProgressBar>` | Migration modals each render their own | One primitive |

**Rule**: every modal/dialog landed after Stage 5.0.2 MUST use `<Dialog>`. New screens must use primitives — no raw HTML buttons.

---

## 4. Layout & shell redesign (Stage 5.0.3)

### 4.1 App shell

- **TitleBar**: minimal, 32px tall (currently varies). Logo + window controls. Move "vault name" out of TitleBar into Sidebar header (less crowded).
- **Sidebar**: collapsible to icon-only (~52px). Persist collapsed state per vault. Resizable width 200–400px.
  - Header: vault name + vault switcher dropdown
  - Search affordance always visible (no toggle)
  - RibbonBar simplified: 4 actions (New Note, New Folder, Search, Settings) + overflow menu
  - FolderTree dominant area
  - Footer: sync status badge + (compact) connection indicator
- **Editor area**: main content, no chrome on it. Toolbar floats above (or pinned via setting).
- **RightPanel**: 280px (current). New: tab-row at top selecting Calendar / Tags / Comments / Outline / Metadata. Replaces today's "calendar visible by default, others slot-mounted invisibly" pattern. **All right-panel surfaces become discoverable.**
- **Hover windows**: keep multi-window pattern; standardize chrome (titlebar, drag handle, resize, close, expand-to-fullscreen) via `<HoverWindowChrome>` primitive.

### 4.2 Mobile shell

- Keep current TabBar pattern. Apply new design system. Mobile primitives (Toast, ActionSheet, BottomSheet) get desktop counterparts.
- Mobile + desktop share `<Button>` `<Input>` etc. — eliminates parallel implementations.

---

## 5. Editor redesign (Stage 5.0.4)

### 5.1 Information architecture

The 19-extension toolbar is overwhelming. Redesign:

- **Floating bubble menu** for the most-common operations on text selection: Bold / Italic / Link / Heading / Highlight (5 buttons, no toolbar needed for these).
- **Slash command** as primary insert affordance (already exists for wikilink/attachment/image — extend to ALL block-level inserts: callout, code, math, table, divider, embed, link card, etc.). One unified palette opened by `/`.
- **Toolbar** becomes a **command bar** — slim row, opt-in via setting (default off — slash + bubble menu cover 95% of cases).
- **Right-click context menu** for selection-specific actions (Comment, Reference, Format clear).

### 5.2 Slash command palette (`/`)

Inspired by Notion/Linear:
- Group results: "Format" / "Insert" / "Reference" / "Embed" / "Math" / "Code".
- Live filter as user types.
- Keyboard navigation (arrow keys + Enter).
- Recent items at top.
- Single source for all 19 extensions' UI affordances.

### 5.3 Embed primitives

Each embed type gets a uniform UI shell:
- `<EmbedFrame icon title actions={[reveal, copy-link, remove]}>` — used by image, video, link card, math (block), code, attachment.
- Embeds expand inline (image preview), with a consistent "double-click to enlarge" → opens hover window.
- Math: `$inline$` and `$$block$$` syntax; both rendered with KaTeX. Inline edit on click (current behavior; cleaner UI).
- Code blocks: language picker as `<DropdownMenu>` primitive; copy button + line numbers as setting.
- Web embeds (YouTube/Vimeo/etc.): `<EmbedFrame>` with iframe content; consistent thumbnail before play.
- External link cards: same `<EmbedFrame>` shell; preview fetched once, cached.
- Attachment: `<AttachmentChip filename size icon>` inline — clicking opens hover viewer; `<EmbedFrame>` wraps if user wants larger preview.

### 5.4 Outline / heading collapse

- Heading collapse already implemented (Stage 1.x). UI fold marker is currently subtle — improve discoverability with hover-reveal chevron.
- Outline panel (right-panel tab) shows current note's heading tree; click to jump.

---

## 6. Note creation redesign (Stage 5.0.5)

Current: TemplateSelector → custom input modal per template type → editor opens.

Redesign: **single Note Wizard** per template, but built from primitive form components.

- `<TemplateSelector>` becomes a card grid (icon + name + 1-line description per template).
- For templates that have form-input (Contact / Meeting / Event / Paper / Literature), the wizard renders the form INLINE in a `<Dialog>` with consistent primitive form fields (`<Input>` / `<Select>` / `<DatePicker>` / `<TagInput>`). The 5 hand-rolled modal CSS files collapse to one Dialog using primitives.
- For non-form templates (Note / Sketch / Data / Theory / etc.), the dialog has just a title input + create button (no per-template snowflake UI).
- Sketch template still opens straight into canvas — but the canvas itself uses the new design system (tools panel, color picker, properties).

---

## 7. Settings redesign (Stage 5.0.6)

- Switch from tabs to a left-rail navigation (Notion / VS Code style):
  - **General** (vault info, dev mode, confirm-delete)
  - **Appearance** (theme, accent color, font, density)
  - **Editor** (toolbar visibility, default toolbar mode, slash command preferences)
  - **Hover Windows** (zoom, default size, snap-to-edge)
  - **Templates** (manage 12 templates + custom)
  - **Keyboard Shortcuts**
  - **Sync** (NAS connection, conflict policy, polling tier override)
  - **Plugins** (existing slot — moves under settings rail)
  - **About** (version, license, links)
- Each section uses `<SettingsRow label hint control>` primitive — labels left, controls right, hints under. No more custom layout per section.
- Custom font management: dedicated subsection with proper add/remove UI (drag-drop file upload).
- Theme preview: live miniature preview of editor with current settings as user changes them.

---

## 8. Search & navigation (Stage 5.0.7)

### 8.1 Search

- Current 4 tabs (Frontmatter / Content / Attachments / Details) → **2 tabs** (Notes / Attachments). Frontmatter and Content merge — single results list, with filter controls in a left rail toggling between them. Details was redundant.
- **Cmd/Ctrl+K command palette** — global search + commands + recent files (Linear/VSCode pattern). Opens over any view. Replaces (or supplements) the dedicated Search panel.
- Search results: `<Card>` primitive with consistent metadata layout (title, breadcrumb, snippet, tags, modified-at).
- FloatingWords (tag cloud) → moved into a Right-panel tab (Tags), no longer search-specific.

### 8.2 FolderTree

- Visual hierarchy clearer (indent + connector lines optional).
- Drag-drop visual feedback (insertion indicator line).
- Folder note indicator (📄) replaced with a subtle status dot (current emoji is heavy).
- Right-click `<ContextMenu>` primitive (already planned 5.0.2).

### 8.3 Graph view

- Current: force-graph; node colors by type; legend at corner.
- Redesign:
  - Settings panel as collapsible right-rail inside Graph view (filter by tag, by type, by date range).
  - Edge styling distinguishes wikilinks vs reference vs attachment relations.
  - Mini-map for navigation in dense graphs.
  - Node hover shows tooltip with note title + recent edit; click opens hover window (current behavior, cleaner UI).

### 8.4 Calendar (full)

- Full-screen calendar gets month / week / day views (currently only month).
- Memo entries on date cells become small chips with type-color stripe.
- Click date → `<Popover>` with day's notes + memos + tasks (today's pattern, consistent UI).

---

## 9. Sync, vault, conflict UI (Stage 5.0.8)

- **Single sync surface**: deprecate `sync.css`, keep `sync-v2.css` rules but refactor into design system tokens.
- **SyncStatusIndicator**: `<Badge>` primitive. States: idle (subtle), syncing (animated dot), error (warn color), conflict (danger color with badge count).
- **Conflict resolution UI**: `<ConflictListModal>` already exists (sync_v2/components). Refactor to `<Dialog>` + primitive cards per conflict + 3-button resolution per conflict (Use Local / Use Remote / Smart Merge → opens text-merge view in dialog).
- **TrashPanel**: full panel with `<Card>` per deleted item + restore button + permanent delete.
- **MigrationModal + FaststartMigrationModal**: already use `.migration-modal-*` classes — move both to `<Dialog>` primitive. Drop the per-feature CSS file in favor of design-system Dialog. Stage 4.6.2 polish (backup path block + reveal button) becomes a `<PathDisplay path actions>` primitive.

---

## 10. Viewer redesign (Stage 5.0.9)

8 viewers (Image, Code, PDF, Web, DOCX, HWPX, PPTX, XLSX) currently each ship their own chrome. Redesign:

- `<HoverWindowChrome>` primitive: titlebar + drag handle + resize handle + minimize/close + zoom-controls slot.
- Each viewer plugs into the chrome's content area.
- Toolbars (zoom in/out, page navigation for paged formats, find-in-document) become a `<ViewerToolbar>` primitive with consistent button order.
- Light/dark variants via tokens — drop `document-viewers-dark.css` parallel.
- Image viewer: `<ImageViewer>` with pan + zoom + 1:1 button + fit-to-window.
- Code viewer: same as inline code blocks — `<CodeBlock>` primitive with syntax highlight + copy + language label.
- Document viewers (DOCX/HWPX/PPTX/XLSX): per-format renderer plugged into shared chrome.
- PDF: keep PDF.js renderer; new toolbar + page nav inside chrome.

---

## 11. Mobile (Stage 5.0.10)

- Apply design system tokens to mobile.
- Mobile-specific primitives (`ActionSheet`, `BottomSheet`, `FAB`, `SwipeableRow`, `TabBar`) become canonical `src/design-system/components/mobile/*` and re-exported under `src/features/mobile/` for backward compat with current imports.
- Audit each mobile screen for parity with desktop redesign decisions (tabs / palette / dialog patterns).

---

## 12. Microcopy & i18n (Stage 5.0.11)

- Audit every Korean string for tone consistency (currently mixes formal / informal).
- Add English copy for every Korean string (current i18n is incomplete in places).
- Document a microcopy guide: tone (직설적, 친근), terminology (volt → "볼트", note → "노트", attachment → "첨부").
- Loading / empty / error / success states each get template strings.

---

## 13. Accessibility (Stage 5.0.12)

- WCAG AA color contrast on every theme combination. Tokens that fail get fixed at the source.
- Focus rings: consistent across all interactive elements (`:focus-visible` ring with `--bdr-focus`).
- Keyboard navigation audit: every interactive element reachable, every menu/dialog navigable with arrow + Enter + Esc.
- Screen-reader audit: aria-label / aria-describedby / role correctness.
- Reduced motion: every animation respects `prefers-reduced-motion`.
- Dialog focus trap (currently inconsistent).

---

## 14. Sub-stage breakdown & sequencing

| Sub-stage | Scope | Estimated sessions | Depends on |
|---|---|---|---|
| **5.0.1** Design tokens (3-tier) + theme refactor | tokens.css, themes.css, deletion of `*-dark.css` parallels | 1 | — |
| **5.0.2** Primitive component library | `<Button> <Input> <Select> <Dialog> <Popover> <Tooltip> <Toast> <EmptyState> <Skeleton> <Card> <Badge> <ProgressBar> <Tabs> <SegmentedControl>` etc. | 2 | 5.0.1 |
| **5.0.3** App shell (TitleBar / Sidebar / RightPanel / hover chrome) | Layout files, RibbonBar, RightPanel tabs | 1 | 5.0.2 |
| **5.0.4** Editor (bubble menu, slash palette, embed frames, toolbar collapse policy) | EditorToolbar, slash command palette, embed wrappers | 2 | 5.0.2 |
| **5.0.5** Note creation (TemplateSelector + 5 form modals → 1 wizard) | TemplateSelector, form modals consolidated | 1 | 5.0.2 |
| **5.0.6** Settings rail + sections | Settings.tsx, SettingsRow primitive | 1 | 5.0.2 |
| **5.0.7** Search + Cmd-K palette + folder tree polish + Graph + Calendar | 4 surfaces | 2 | 5.0.2 |
| **5.0.8** Sync / Vault / Conflict UI | sync_v2 components, migration modals, MigrationModal + FaststartMigrationModal | 1 | 5.0.2 |
| **5.0.9** Viewer chrome + toolbars (8 viewers) | Hover viewer wrappers, document viewer toolbars | 1.5 | 5.0.2 + 5.0.3 |
| **5.0.10** Mobile parity | Mobile primitives shared with desktop | 1 | 5.0.2 |
| **5.0.11** Microcopy + i18n audit | Strings across all surfaces | 0.5 | every other landed |
| **5.0.12** Accessibility audit + fixes | Focus, contrast, ARIA, keyboard, motion | 1 | every other landed |

**Total estimate**: ~14 sessions of focused work. Realistically 18–20 with iteration on HanBin's review per sub-stage.

**Critical path**: 5.0.1 → 5.0.2 → (everything else can fan out in parallel after primitives land).

---

## 15. Migration strategy (no big bang)

- **Each sub-stage commits independently** with the full app still working between commits. No "frozen" period.
- **Dual-mount during transition**: when refactoring a screen, the new component mounts side-by-side with the old via a `useFeatureFlag('design-v2.<surface>')` setting. HanBin can toggle per-surface to compare.
- **Old CSS files deleted only after the corresponding new component lands and the flag is removed** — prevents "design half-applied" looking worse than current.
- **Per sub-stage**: small visual diff document with before/after screenshots in `docs/architecture/stage_5_reports/{NN}.md`.

---

## 16. Acceptance criteria (per sub-stage)

A sub-stage is "done" when:

1. New primitive(s) / screen(s) work end-to-end (not behind a flag).
2. Old CSS files for the redesigned surface are deleted (no orphan style debt).
3. `cargo check --lib` clean (backend untouched).
4. `npx tsc --noEmit` clean.
5. Korean + English i18n strings updated.
6. Design system tokens used (no Tier-1 primitives, no raw colors / spacing literals in new code).
7. Accessibility self-audit on the new surface (focus / contrast / keyboard / motion).
8. Short report in `stage_5_reports/{NN}.md` with before/after screenshots + checklist.
9. HanBin sign-off on visual outcome.

---

## 17. What this plan deliberately does NOT do

- **No new features** — purely a redesign. Sketch templates still sketch, search still searches, sync still syncs.
- **No backend changes** — `src-tauri/` untouched (except possibly for config tokens if a settings option demands a new backend hook).
- **No third-party UI library import** — we don't add Radix / Mantine / shadcn. The primitive library is hand-rolled but small; we already have lucide-react for icons. Floating-UI may be the exception (for `<Tooltip>` / `<Popover>` positioning) — single ~30KB dep, accepted.
- **No mobile-first rewrite** — desktop and mobile are parallel; the design system unifies the primitives, but the screens remain separate codebases (per current architecture).
- **No vendor-locked design system** — tokens + components are project-local, not a published package. (If future spinoff needs it, the `src/design-system/` folder is pre-positioned to extract cleanly.)

---

## 18. HanBin sign-off (2026-05-14)

| # | Question | HanBin's answer |
|---|---|---|
| Q1 | 12-sub-stage breakdown? | **Adopt as-written** |
| Q2 | Cmd-K palette primary vs supplement? | **Supplement** — folder tree stays primary, Cmd-K is augmentation |
| Q3 | Default editor toolbar visibility | **OFF (slash-first)** — PLUS new explicit requirement: full audit of ALL keyboard commands and shortcut bindings before 5.0.4 implementation. Current `/`, `//`, `$`, `$$` etc. are inconsistent. Standard editing shortcuts (Ctrl+Z / Ctrl+Shift+Z / Ctrl+X / Ctrl+C / Ctrl+V) must work without collision with custom commands. **Re-design the entire command + shortcut system**, document the new map, then implement. See §18a below. |
| Q4 | Accent color customization scope | (no explicit answer — default applies: defer to 5.0.6 settings sub-stage) |
| Q5 | CSS class-name rename timing | (no explicit answer — default: rename to `<Dialog>`-based in one shot at 5.0.8) |
| Q6 | Floating-UI dep ~30KB | (no explicit answer — default: accepted) |
| Q7 | Mobile parity scope | **Full visual rewrite** (overrides default of token-only). Mobile screens redesigned from scratch using the new design system + primitives. +3 to +5 sessions added to 5.0.10 budget. |
| Q8 | Per-vault design preferences | (no explicit answer — default: future, not Stage 5.0) |

### 18a. New requirement from Q3 — Command & Shortcut Consolidation

Before 5.0.4 (editor) implementation begins, a **command + shortcut audit pass** is required as the first action inside 5.0.4. Specifically:

1. **Inventory every keyboard binding currently active** in Notology — TipTap defaults, our custom extensions, modal-level shortcuts (ESC / Enter), app-level shortcuts (Ctrl+S save, Ctrl+K search, etc.), context-menu accelerators. Source: `src/utils/shortcuts.ts`, `useAppKeyboardShortcuts`, every `editor.commands.*` keymap, every `onKeyDown` in modals.
2. **Inventory every text-trigger command** — `/`, `//`, `$`, `$$`, `[[`, `>` callout, `-` list, `1.` list, `\`\`\`` code block, table syntax, etc. Document what each does.
3. **Identify collisions** — same key binding doing different things in different contexts; same prefix used by multiple unrelated features (`/` for slash command + `//` for inline math?); standard OS shortcuts being overridden silently.
4. **Design the new map** — single canonical command palette via `/` for block-level inserts, `Cmd+K` for navigation, OS-standard shortcuts (Ctrl+Z/Y/X/C/V/A/F/S) reserved and never overridden, function keys + Ctrl+Shift combos for app-level (search / settings / new note). Math `$..$` and `$$..$$` retained but documented as the only special inline syntax.
5. **Document the result** in a sub-stage 5.0.4-pre report (`docs/architecture/stage_5_reports/5_0_4_pre_command_audit.md`) before implementation. HanBin reviews the proposed map; once signed off, implementation proceeds.

This adds ~1 session to 5.0.4 (now estimated 3 sessions instead of 2). Total Stage 5.0 budget revised below.

### 18b. Revised total estimate (after Q3 + Q7 changes)

- **5.0.4 (editor)**: 2 → 3 sessions (+1 for command/shortcut audit)
- **5.0.10 (mobile)**: 1 → 5 sessions (+4 for full rewrite)
- **Stage 5.0 total**: 14 → ~19 sessions (still per-sub-stage shippable; HanBin can pause / re-prioritize between sub-stages)

---

## 19. Reporting cadence

- Per sub-stage: `docs/architecture/stage_5_reports/{NN}.md` (1 page, before/after screenshots, decisions taken, files changed).
- Stage 5.0 closeout: a single `STAGE_5_0_CLOSEOUT.md` summarizing the final design system + screens with HanBin sign-off.
- This plan stays as the spec; sub-stage reports are the implementation log.

---

## 20. Risk register

| Risk | Mitigation |
|---|---|
| 14-session scope underestimates | Each sub-stage independently shippable — no big-bang risk; HanBin can pause / re-prioritize between sub-stages |
| User-visible regression during transition | Feature flags per surface; old + new mount side-by-side until cleanup |
| Dark-mode color contrast regressions | WCAG AA enforced at token level (5.0.1); audit per sub-stage |
| Korean text overflow on narrow primitives | Stage 5.0.1 audit each token's font / line-height with Korean content first |
| Mobile parity drift | Stage 5.0.10 scheduled before 5.0.11 microcopy and 5.0.12 a11y so mobile + desktop go through final passes together |
| Documentation rot | Each sub-stage report is mandatory; the spec stays the source of truth |
| Existing features break (toolbar / extension wiring etc.) | Functionality test per sub-stage — manual smoke tests of all 19 editor extensions, all 12 templates, all 8 viewers |
