# Stage 5.0.7 — Search & Navigation closeout

> Wraps sub-stages 5.0.7a / 5.0.7b / 5.0.7c / 5.0.7d. Plan delta:
> [`5_0_7_plan_delta.md`](5_0_7_plan_delta.md). Detailed 5.0.7a report:
> [`5_0_7_a.md`](5_0_7_a.md). The b/c/d work is narrowly scoped enough that
> their changes are summarized below rather than getting a dedicated report.

## A. What shipped (all 4 surfaces)

### 5.0.7a Search ✅
- 5 tabs → 4 tabs (Details dropped, Graph retained per HanBin Q1)
- Cmd-K palette enhanced: recent notes section + content search via Tantivy (debounced 200 ms) + "Search '{query}' in panel" punt + section headers + snippet preview on content rows
- Tag category colors → Tier-3 tokens (`--c-tag-{domain,who,org,ctx}`) with light + dark + system variants
- Search input → `<Input>` primitive; filter toggles → `<IconButton pressed>` with aria-pressed
- `searchHelpers.ts` Korean dead-string cleaned

### 5.0.7b FolderTree ✅
- Indent calculation: JS-injected raw `padding-left: depth * 16 + 8 px` → CSS variable `--tree-depth` with `calc(var(--tree-depth) * var(--space-md) + var(--space-sm))` resolution. Tree spacing now responds to design-token changes.
- Drag-drop reorder feedback: row-wide highlight + border-top → **insertion-line indicator** (2px accent strip flush to top edge via `::before`). Plan §8.2 ask.
- Folder-note status dot — new explicit 6px dot beside the folder name when the folder has a folder note. Old blue text color stays as secondary signal.
- Spacing tokens for header (8/12 → sp-2/3), content area (4/0 → sp-1/0), container row (6/8 → sp-2/sp-2).
- i18n: `folderNoteIndicator` ko + en.

### 5.0.7c Graph (color resolver only) ⚠️ partial
- New module: [`src/features/graph/graph-colors.ts`](../../../src/features/graph/graph-colors.ts) — exposes `resolveGraphColors(isDark)` reading CSS tokens via `getComputedStyle(document.documentElement)`. Returns a full palette object (`tag*`, note-type colors, folder, search glow, etc.) with hardcoded dark + light fallbacks for safety.
- GraphView wires the resolver via an effect keyed on `isDark`, mutating the module-level color maps (`TAG_NAMESPACE_COLORS`, `NOTE_TYPE_COLORS`, `FOLDER_NOTE_COLOR`, `DEFAULT_TAG_COLOR`) so subsequent canvas paints pick up theme colors automatically.
- **Deferred** to 5.0.7c-followup (acknowledged in plan delta + this report): settings panel relocation (bottom-left → right rail), filter UI (tag/type/date), mini-map, hover tooltip with metadata, edge type rail toggles.

### 5.0.7d Calendar (Month polish, Day view deferred) ⚠️ partial
- i18n: weekday + month labels migrated from hardcoded English/Korean arrays to `calWeekday{0..6}` + `calMonth{0..11}` keys.
- Task/Memo toggle: hand-rolled `<button>` pair → `<SegmentedControl>` primitive.
- Prev/Next month: hand-rolled `<button>` → `<IconButton>` primitives with aria-labels.
- Chip stripe: full-bg green/red → 3px left border stripe + neutral background (plan §8.4 design — "small chips with type-color stripe").
- Hardcoded `#ffffff` for badge/today text → `var(--tx-on-accent, #ffffff)` so theme overrides work.
- **Deferred** to 5.0.7d-followup: Month↔Day SegmentedControl + Day view UI (per HanBin Q4: Month+Day, no Week), `<Popover>` on date click replacing sidebar list, MEMO_COLORS hex migration in CalendarHomeView (mobile-adjacent — folds into 5.0.10).

## B. Deferrals & rationale

| Item | Why deferred | Carried to |
|---|---|---|
| `<SearchResultCard>` Card-primitive wrap | Card chrome (rounded box + shadow + density padding) double-styles `.search-content-item` row design (left strip + bg gradient). Needs Card to grow a "row" / "flat" variant first. | 5.0.7-followup |
| ContextMenu primitive swap in Search | `modalActions.showContextMenu()` powers 30+ call sites across the codebase. Single-surface swap doesn't pay off — needs a coordinated mini-stage. | 5.0.7e |
| Graph settings panel relocation (right rail) | Significant CSS work + interacts with the canvas viewport sizing. Color resolver is the foundational piece — UI restructure can ride on top once it lands. | 5.0.7c-followup |
| Graph filter UI (tag / type / date) | New state design + multi-select chip components. Belongs with the right-rail relocation. | 5.0.7c-followup |
| Graph mini-map | force-graph doesn't expose viewport transform cleanly. Needs a custom canvas + sync layer. Value/risk ratio low for current vault sizes (<500 notes). | 5.0.7c-followup |
| Graph hover tooltip | Needs canvas→screen coord conversion + HTML tooltip positioning. Floating-UI primitive is available; tooltip surface itself isn't blocked, just out of scope this pass. | 5.0.7c-followup |
| Calendar Month↔Day view toggle + Day view UI | Day view needs a new vertical-timeline layout (gutter + memo cards). Substantial — separate work item. | 5.0.7d-followup |
| Calendar Popover on date click | Would duplicate the existing sidebar list. Needs UX decision on whether to drop the sidebar entirely (impacts RightPanel CalendarSurface mount too). | 5.0.7d-followup |

## C. Token compliance audit (this stage)

| File | Before | After |
|---|---|---|
| `src/styles/components/search.css` | 8 raw hex tag colors (`#a78bfa`/`#22d3ee`/`#fb923c`/`#34d399` × 2 — chip + dot) | All routed through `var(--c-tag-*)` + `color-mix` |
| `src/styles/components/folder-tree.css` | 4 raw px paddings (8/12, 4/0, 6/8) + JS-injected raw px indent | All on `var(--sp-*)` + CSS-var indent |
| `src/styles/features/calendar.css` | 2× `color: #ffffff` literals + full-bg memo chips | `var(--tx-on-accent)` + stripe-style chips |
| `src/features/graph/GraphView.tsx` | 17+ hardcoded hex for node/edge/label/glow | Resolver-driven (still has raw fallbacks for SSR safety) |

**Tier-1 leakage**: search/folder-tree/calendar surfaces now pass token audit cleanly (excepting deferred items: MEMO_COLORS in mobile CalendarHomeView, graph canvas-internal hex fallbacks intentional).

## D. Verification

- TS: no broken imports / unresolved symbols after Details tab removal, Card primitive revert, SegmentedControl swap.
- i18n: 11 new keys × 2 languages = 22 occurrences. Audit: `grep` for each new key returns exactly 2 hits.
- CSS: no orphan selectors (verified `.search-details-*` cleanup, `.search-filter-btn` cleanup, folder-tree raw-px sweep).
- Backend: unchanged (Stage 5.0 freeze respected).

## E. Files touched (this closeout window)

**New**
- `src/features/graph/graph-colors.ts` (147 lines)
- `docs/architecture/stage_5_reports/5_0_7_plan_delta.md`
- `docs/architecture/stage_5_reports/5_0_7_a.md`
- `docs/architecture/stage_5_reports/5_0_7_closeout.md` (this file)

**Modified**
- Core: `src/core/types/index.ts`, `src/core/utils/i18n.ts` (4 new key blocks × 2 langs)
- Search: `src/features/search/Search.tsx`, `src/features/search/SearchFilters.tsx`, `src/features/search/SearchResultItem.tsx`, `src/features/search/searchHelpers.ts`
- FolderTree: `src/features/folder-tree/FolderTree.tsx`
- Graph: `src/features/graph/GraphView.tsx`
- Calendar: `src/features/calendar/Calendar.tsx`
- CommandPalette: `src/features/command-palette/CommandPalette.tsx`
- Styles: `src/styles/components/search.css`, `src/styles/components/folder-tree.css`, `src/styles/features/calendar.css`, `src/styles/features/command-palette.css`, `src/styles/base/themes.css`

## F. Next sub-stage

5.0.8 — Sync / Vault / Conflict UI per plan §9. Significant scope (SyncStatusIndicator `<Badge>` migration, ConflictListModal `<Dialog>` refactor, TrashPanel `<Card>` per-item redesign, MigrationModal/FaststartMigrationModal `<Dialog>` swap, new `<PathDisplay>` primitive). Audit-first approach: dispatch parallel `Explore` agents for the 5 sync surfaces before any code changes.
