# Stage 5.0 — Grand closeout

> Plan source: [`STAGE_5_0_DESIGN_SYSTEM_PLAN.md`](../STAGE_5_0_DESIGN_SYSTEM_PLAN.md)
> (committed `129cfdd`, sign-off `defbf53`). Original estimate 14 sessions,
> revised 19 sessions after Q3 + Q7 overrides. This document closes the
> design-system arc and records every per-sub-stage deferral as carry-over
> work.

## A. Sub-stage scoreboard

| # | Scope | Status | Report |
|---|---|---|---|
| 5.0.1 | Design tokens (3-tier) + theme refactor + audit script | ✅ landed | [5_0_1.md](5_0_1.md) |
| 5.0.2a | 14 simple primitives + primitives.css + preview | ✅ landed | [5_0_2_a.md](5_0_2_a.md) |
| 5.0.2b | 9 Floating-UI dependent primitives | ✅ landed | [5_0_2_b.md](5_0_2_b.md) |
| 5.0.3a / 3a-rework | RightPanel tab-row → single Calendar surface | ✅ landed | [5_0_3_a.md](5_0_3_a.md) / [5_0_3_a_rework.md](5_0_3_a_rework.md) |
| 5.0.3b / 3b-simplify | TitleBar 32px + Sidebar single collapse axis | ✅ landed | [5_0_3_b.md](5_0_3_b.md) / [5_0_3_b_simplify.md](5_0_3_b_simplify.md) |
| 5.0.4-pre | Command + shortcut audit (Q3 mandatory gate) — sign-off | ✅ landed | [5_0_4_pre_command_audit.md](5_0_4_pre_command_audit.md) |
| 5.0.4a | `<CommandPalette>` + shortcut map migration + KbdHint OS | ✅ landed | [5_0_4_a.md](5_0_4_a.md) |
| 5.0.4b-1 | `/` slash palette + MathTrigger disable | ✅ landed | [5_0_4_b_1.md](5_0_4_b_1.md) |
| 5.0.4b-2a..e | Math DnD/IME, slash-attachment, MediaEmbed stopEvent, atom UX, LinkCard md serialize | ✅ landed | partial reports + [5_0_4_b_2d.md](5_0_4_b_2d.md) |
| 5.0.4b-3..5 | expanded hover panels, slash palette completion, expanded hover keyboard | ✅ landed | (in-prior-session reports) |
| 5.0.5 | Note creation wizard (T-1..T-5) | ✅ landed | (in-prior-session) |
| 5.0.5a-migration | Legacy template open-time prompt + Settings batch tool + unmatched-type warning | ✅ landed | (in-prior-session) |
| 5.0.6a~g | Settings tab restructure + plugin labels + template card fixes | ✅ landed | (in-prior-session) |
| 5.0.6j / j-2 | ConnectedDevicesPanel multi-device pills + offline dim | ✅ landed | (in-prior-session) |
| 5.0.6k / k-2 | NasFolderBrowser i18n + Button/Input primitives | ✅ landed | (in-prior-session) |
| 5.0.6m-2 | ConnectionVaultSelector inline-style purge → `.vault-popover-panel` system | ✅ landed | (in-prior-session) |
| 5.0.7 plan delta | Search/FolderTree/Graph/Calendar audit + HanBin sign-off | ✅ landed this session | [5_0_7_plan_delta.md](5_0_7_plan_delta.md) |
| 5.0.7a | Search 5탭→4탭 (Details 폐기) + Cmd-K search adapter + tag color tokens + primitive 교체 | ✅ landed this session | [5_0_7_a.md](5_0_7_a.md) |
| 5.0.7b/c/d closeout | FolderTree polish + Graph color resolver + Calendar i18n & chip stripe | ✅ landed this session | [5_0_7_closeout.md](5_0_7_closeout.md) |
| 5.0.8 | Sync/Vault/Conflict UI — Migration Dialog wrap + ConflictListModal + TrashPanel CSS migrate + PathDisplay primitive + sync.css dead-purge | ✅ landed this session | [5_0_8.md](5_0_8.md) |
| 5.0.9 | Viewer chrome — document-viewers-dark.css 폐기, `<HoverWindowChrome>` + `<ViewerToolbar>` primitives, 4 multi-window viewer 마이그레이션 | ✅ landed this session | [5_0_9.md](5_0_9.md) |
| 5.0.10a | Mobile token + i18n (MEMO_COLORS / NOTE_TYPE_COLORS / formatDate / weekday) | ✅ landed this session | [5_0_10.md](5_0_10.md) |
| 5.0.10b/c~f | Mobile primitive canonical + GraphView canvas resolver + parity + polish | ⏸ DEFERRED ~9 sessions | (closeout in [5_0_10.md](5_0_10.md) §E) |
| 5.0.11 | Microcopy + i18n audit + MICROCOPY_GUIDE.md + 7 primitive key promotion + Dialog closeAriaLabel | ✅ landed this session | [5_0_11.md](5_0_11.md) + [MICROCOPY_GUIDE.md](../MICROCOPY_GUIDE.md) |
| 5.0.12 | A11y — universal `prefers-reduced-motion` guard | ✅ landed this session (per-primitive/modal/keyboard fixes deferred) | [5_0_12.md](5_0_12.md) |

## B. Quantitative summary

| Metric | Stage 5.0 result |
|---|---|
| Design-system primitives delivered | **24** (`Button`, `IconButton`, `Input`, `Textarea`, `Checkbox`, `Radio`, `Toggle`, `Spinner`, `Skeleton`, `ProgressBar`, `Badge`, `Card`, `EmptyState`, `KeyboardHint`, `PathDisplay`, `Tooltip`, `Popover`, `Dialog`, `DropdownMenu`, `ContextMenu`, `Tabs`, `SegmentedControl`, `Select`, `Toast`) |
| Feature-domain primitives delivered | **2** (`HoverWindowChrome`, `ViewerToolbar` + 3 helper sub-components `ToolbarZoom`/`ToolbarPageNav`/`ToolbarSheetTabs`) |
| i18n keys (ko + en parity verified) | **1361 each** — 0 orphans |
| New i18n keys added this session | **~120** (across cmdPalette/migration/faststart/conflictList/nasBrowser/calendar/mobile/folder/viewer/microcopy primitive keys) |
| New Tier-3 tokens added | **11** (`--c-tag-{domain,who,org,ctx}`, `--c-memo-stripe-{1..7}`) — all light + dark + system variants |
| Dead CSS purged (sync.css + document-viewers-dark.css) | ~600 lines |
| 4 hover viewer LOC reduction | **−1137** (HoverImageViewer −288, HoverWebViewer −274, HoverCodeViewer −279, HoverPdfViewer −296) |
| Net codebase reduction in viewer dir | **−770** (after `HoverWindowChrome` 370 line investment) |
| `*-dark.css` parallel files in repo | 1 → **0** (token-driven theme is now single source of truth) |
| Sidebar drag-resize precision regression | Fixed earlier (rAF + transition-disable + persist-on-mouseup) |

## C. Q-decision register

| # | Question | HanBin's decision | Where applied |
|---|---|---|---|
| Q1 (5.0.7) | Search tab merge | 5탭 → 4탭 (Details 폐기, Graph 유지) | 5.0.7a |
| Q2 (5.0.7) | Cmd-K palette | 5.0.7 with Search | 5.0.7a |
| Q3 (5.0.7) | Graph settings panel | 우측 collapsible rail (deferred impl) | 5.0.7c-followup |
| Q4 (5.0.7) | Calendar view modes | Month + Day only | 5.0.7d (Day defer) |
| Q1 (5.0.8) | Migration Dialog aggressiveness | Wrapper only + internal preserved | 5.0.8a |
| Q2 (5.0.8) | Conflict resolution buttons | Keep N-branch picker, update plan text | 5.0.8b |
| Q3 (5.0.8) | sync.css cleanup depth | 온전 정리 | 5.0.8e |
| Q4 (5.0.8) | PathDisplay scope | Minimal (path + onReveal) | 5.0.8d |
| Q1 (5.0.9) | HoverWindowChrome shape | Full JSX wrapper | 5.0.9b |
| Q2 (5.0.9) | ViewerToolbar shape | Slot + helper components | 5.0.9c |
| Q3 (5.0.9) | document-viewers-dark.css purge | 일괄 삭제 + base 통합 | 5.0.9a |
| Q4 (5.0.9) | Office viewer toolbar adoption | Whole 4/4 (5.0.9e deferred per impl risk) | 5.0.9e-followup |
| Q1 (5.0.10) | Q7 Mobile scope this session | 5.0.10a only | 5.0.10a |
| Q2 (5.0.10) | Mobile primitive location | design-system/components/mobile/* | 5.0.10c (deferred) |
| Q3 (5.0.10) | Cmd-K mobile | 폐기 (SearchView already covers) | doc only |
| Q4 (5.0.10) | NoteEditor syntax highlight | 5.0.10b — deferred per stability concern | 5.0.10b-followup |

## D. Carry-over work (all deferrals, prioritized)

| Item | Source | Priority | Estimate |
|---|---|---|---|
| 5.0.10c primitive canonicalization (FAB/BottomSheet/ActionSheet/SwipeableRow/TabBar → design-system/mobile/*) | 5.0.10 | High (unblocks shared primitives) | 3 sessions |
| 5.0.10d desktop parity for SearchView + CalendarHomeView | 5.0.10 | High | 3 sessions |
| 5.0.10e Mobile GraphView color resolver + sync surface real implementation | 5.0.10 | Medium | 2 sessions |
| 5.0.10b NoteEditorView code-block CSS migration + canvas resolver in GraphView | 5.0.10 | Medium | 1.5 sessions |
| 5.0.10f Mobile integration + polish + touch-target audit | 5.0.10 | Low | 1 session |
| 5.0.12-followup per-primitive `:focus-visible` (Checkbox/Radio/Toggle/Tabs/Seg/ContextMenu/TabBar/FAB) | 5.0.12 | High (a11y) | 0.5 session |
| 5.0.12-followup 7 input-modal Dialog migration (AlertModal et al) | 5.0.12 | High | 1.5 sessions |
| 5.0.12-followup ARIA i18n (EditorBubbleMenu + TitleBar) | 5.0.12 | Medium | 0.5 session |
| 5.0.12-followup keyboard nav (FolderTree + Search arrow-key) | 5.0.12 | Medium | 1.5 sessions |
| 5.0.12-followup WCAG AA contrast token tweaks (`--tx-3`/`--c-blue` on `--bg-app`) | 5.0.12 | Medium | 1 session |
| 5.0.11-followup tone reconciliation on 4 mixed prefixes (vault/trash/calendar/conflictList) | 5.0.11 | Medium | 1 session |
| 5.0.11-followup Toast/Select/MathExtension consumer i18n wire | 5.0.11 | Medium | 0.5 session |
| 5.0.11-followup OrphanCleanup/VaultLifecycle/BranchPicker ternary → key promotion | 5.0.11 | Low | 0.5 session |
| 5.0.9e Office viewer ViewerToolbar adoption (DOCX/HWPX/PPTX/XLSX) | 5.0.9 | Medium | 2 sessions |
| 5.0.8-followup per-conflict Card / TrashPanel Card / SyncStatusIndicator Badge | 5.0.8 | Low (needs Card row-variant) | 1 session |
| 5.0.7e ContextMenu primitive system swap (30+ call sites) | 5.0.7 | Medium | 1.5 sessions |
| 5.0.7c-followup Graph settings panel relocation + filter UI + mini-map + hover tooltip | 5.0.7 | Medium | 2 sessions |
| 5.0.7d-followup Calendar Day view + Popover on date click | 5.0.7 | Medium | 1 session |
| 5.0.4b atom UX unification post-audit deltas (full hover keyboard) | 5.0.4 | Low (mostly landed) | 0.5 session |

**Total deferred:** ~25–28 sessions. Most live in 5.0.10 mobile (~9), 5.0.12 a11y followup (~5), and various per-stage polish (~10).

## E. What Stage 5.0 deliberately did NOT do (preserved from plan §17)

- No new features
- No backend changes (Stage 5.0 freeze respected; `src-tauri/` untouched throughout)
- No third-party UI library imports beyond Floating-UI (already accepted per Q6)
- No mobile-first rewrite (mobile parallel to desktop)
- No vendor-locked design system (everything stays in `src/design-system/`)

## F. Architecture invariants reaffirmed by Stage 5.0

1. **Tokens are the only source of truth.** Tier 1 → Tier 2 (themes) → Tier 3 (component overrides) consumed via `var(--*)`. Audit script enforces zero Tier-1 leakage in committed code.
2. **Primitives are i18n-agnostic.** Dialog primitive's `closeAriaLabel` prop (5.0.11) is the canonical pattern: consumers thread their localized labels in. Design system stays loosely coupled.
3. **Korean + English keys ship together.** 5.0.11 verified 1361/1361 parity; the MICROCOPY_GUIDE codifies the rule.
4. **Per-feature CSS files own their selectors.** Cross-feature consolidation (TrashPanel into sync-v2.css, document-viewers-dark merged into document-viewers.css) — but no global "kitchen-sink" file.
5. **HanBin sign-off gates every sub-stage.** 4 Q-decision batches × 4 sub-stages this session (16 decisions). Every redesign Q is documented in the stage report.

## G. Stage 5.0 retrospective

What worked
- Per-sub-stage HanBin sign-off batches kept scope tight + decisions reversible.
- Plan delta docs prefacing each multi-stage block (5.0.4-pre, 5.0.7 plan delta) saved cycles vs implementing without alignment.
- Audit agents dispatched in parallel before each sub-stage gave concrete `file:line` evidence instead of vibes.

What surfaced as friction
- "Card primitive double-styles existing row designs" came up in 3 separate places (5.0.7a ContentResultCard, 5.0.8b per-conflict, 5.0.8 TrashPanel). The Card primitive needs a `density="flat"` or row variant — recorded as 5.0.8-followup.
- 5.0.10 Mobile Q7 override genuinely needs its own dedicated multi-session cycle. Compressing into a single session would have produced shallow work.

## H. Sign-off

Stage 5.0 closes with the design system + token discipline + primitive library + 7 of 12 sub-stages fully implemented + 5 of 12 with documented carry-over scope. The codebase is structurally ready for Stage 6 feature work to ride on top.
