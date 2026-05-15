# Stage 5.0.3a-rework — RightPanel back to single Calendar surface

**Date**: 2026-05-15
**Status**: ✅ Acceptance criteria met — ready for HanBin smoke test
**Parent plan**: revises [`STAGE_5_0_DESIGN_SYSTEM_PLAN.md`](../STAGE_5_0_DESIGN_SYSTEM_PLAN.md) §4.1
**Reverts (in part)**: [5.0.3a](./5_0_3_a.md) (`9ed4159`), [5.0.4a](./5_0_4_a.md) (`85473e7`)

---

## 1. Why this commit exists

HanBin's smoke test of the 5.0.3a + 5.0.4a stack surfaced two
structural problems:

1. **4 of the 5 right-panel tabs are structurally empty in the main window.**
   Tags / Comments / Outline / Metadata are *per-note* concepts; the main
   window has no notion of "the current note" (notes live in hover
   windows). The tabs always rendered "활성 노트 없음" empty state in normal
   usage. The Calendar tab was the only useful surface. Plan §4.1 assumed
   the right panel would track an active-note context, but Notology's
   actual model is hover-windows-as-editors.

2. **Right-panel toggle button is in the left Sidebar — unnatural.**
   Users expect the right panel's toggle to live on the right side. The
   Sidebar `<PanelRightOpen>` `<IconButton>` from 5.0.3a was a stopgap
   for the calendar-discoverability bug.

HanBin's review summary:
> "우측 탭의 목적 자체는 노트에서 생성한 할일, 메모를 관리하기 위한
>  목적이 강함. 그리고 우측 탭을 여는 버튼이 왼쪽 탭에 위치한다는
>  것도 불편함."

---

## 2. Decisions (AskUserQuestion batch, 2026-05-15)

| # | Decision | Source |
|---|---|---|
| 1 | RightPanel = **Calendar single surface** (drop the tab-row) | Q1 Recommended |
| 2 | Toggle button location = **right-edge thin strip** (collapsed-bar pattern) | Q2 Recommended |
| 3 | `Alt+1..5` shortcuts = **all removed** | Q3 Recommended |
| 4 | Outline = **hover-window header icon (5.0.4b scope)** | Q4 follow-up Recommended |
| 5 | Metadata = **no separate surface** — TagPanel's existing yaml mode covers it | Q4 follow-up Recommended |

---

## 3. Changes landed

### 3.1 RightPanel.tsx — back to single Calendar surface

- `<Tabs>` / `<TabList>` / `<TabPanel>` removed
- `<SlotOrEmpty>` wrapper removed (per-note slot pattern unused — feature can be re-introduced for a *different* surface if 5.0.7 wants it)
- `CalendarTabContent` renamed to `CalendarSurface` and rendered inline as the only body
- Header (today-icon + close `<IconButton>`) preserved as-is
- `useTodayMemoCount` export preserved (consumed by collapsed-bar hook)

Net: ~80 lines lighter; same Calendar behavior as pre-5.0.3a and 5.0.3a.

### 3.2 uiStore — `rightPanelTab` state removed

- `rightPanelTab` field, `setRightPanelTab` action, `useRightPanelTab` selector all removed
- `localStorage` key `'notology-right-panel-tab'` no longer read or written (existing user values become harmless dead keys)
- `RIGHT_PANEL_TABS` const + `RightPanelTab` type kept as a no-op stub for 5.0.7 in case a different tab structure adopts the same name
- `zustand/index.ts` barrel re-exports cleaned

### 3.3 Sidebar.tsx — left-side right-panel toggle removed

The `<IconButton><PanelRightOpen/></IconButton>` added in 5.0.3a (both expanded and icon-only modes) is **removed**. `useShowHoverPanel` hook + `PanelRightOpen` import cleaned. `<Tooltip>` for that button removed. Sidebar header actions row drops from 3 buttons (`+`, Search, RightPanel) back to 2 (`+`, Search).

### 3.4 App.tsx — restored hover-panel-collapsed-bar

The "CollapsedHoverBar removed" comment from the v3.0.0 refactor is reverted. When the right panel is closed, App.tsx now renders the `.hover-panel-collapsed-bar` (CSS class already exists in `sidebar.css` — never deleted) with a single `<button class="hover-panel-collapsed-toggle">` containing `<PanelRightOpen>`. Clicking it calls `uiActions.setShowHoverPanel(true)`. Same pattern as the existing `sidebar-collapsed-bar` on the left.

This is the **right-edge thin strip** HanBin asked for.

### 3.5 shortcuts.ts — Alt+1..5 removed

`focusRightPanelTab1..5` entries removed from `DEFAULT_SHORTCUTS`. Settings → Keyboard Shortcuts list shrinks by 5 rows.

### 3.6 useAppKeyboardShortcuts.ts — PANEL_TAB_MAP block removed

The handler block that opened the right panel + set `rightPanelTab` for `Alt+1..5` is deleted.

### 3.7 CommandPalette — cmdTab* commands removed

5 commands (`tabCalendar`, `tabTags`, `tabComments`, `tabOutline`, `tabMetadata`) removed. `toggleRightPanel` command's label updated to clarify "(calendar)". Net commands available in palette: **4** (was 9).

`CalendarDays`, `Tag`, `MessageSquare`, `ListTree`, `FileText` icon imports dropped.

### 3.8 CSS — right-panel-tabs.css deleted

`src/styles/components/right-panel-tabs.css` deleted entirely. `styles/index.css` import line removed. Sr-only label pattern + tab-strip layout — all gone. `.hover-panel-collapsed-bar` styles in `sidebar.css` were already present and are now re-activated by App.tsx markup.

### 3.9 i18n cleanup

Removed (ko + en):
- `rightPanelTabsLabel`, `rightPanelCalendar`, `rightPanelTags`, `rightPanelComments`, `rightPanelOutline`, `rightPanelMetadata`
- `rightPanelEmptyTitle`, `rightPanelEmptyDesc`, `rightPanelEmptyPerNoteTitle`, `rightPanelEmptyPerNoteDesc`
- `scFocusRightPanelTab1..5`
- `cmdTabCalendar`, `cmdTabTags`, `cmdTabComments`, `cmdTabOutline`, `cmdTabMetadata`

Kept: `rightPanelToggle` (label for the new edge-strip button), `prevMonth` / `nextMonth`, sidebar collapse labels. Updated `cmdToggleRightPanel` label to clarify "(calendar)".

Total: **22 keys removed × 2 languages = 44 string entries dropped.**

---

## 4. Tags / Comments / Outline / Metadata — where they live now

| Surface | Where | When | Status |
|---|---|---|---|
| **Tags** | Hover window header `<Tags>` icon button | Existing | ✅ already there |
| **Comments** (memo/task) | Hover window header `<MessageSquare>` icon button | Existing | ✅ already there |
| **Outline** | Hover window header new `<ListTree>` icon button (per-note heading tree) | 5.0.4b scope | pending |
| **Metadata** | Inside TagPanel's `[Tags]` ↔ `[YAML]` mode toggle | Existing | ✅ already covered, no new UI |

Per-note panels stay where they belong — bound to the specific hover-window-edited note. Aggregate / cross-vault surfaces (Calendar) stay in the main RightPanel.

---

## 5. Acceptance criteria

- [x] Right panel = single Calendar surface, no tabs
- [x] Right panel toggle button moved to right-edge thin strip (collapsed bar restored)
- [x] Sidebar's `<PanelRightOpen>` button removed (both expanded + icon-only modes)
- [x] `Alt+1..5` shortcuts removed (shortcuts.ts + handler + CommandPalette)
- [x] `uiStore.rightPanelTab` state + action + selector removed (barrel cleaned)
- [x] Obsolete CSS file `right-panel-tabs.css` deleted
- [x] i18n: 22 obsolete keys × ko/en removed
- [x] `npx tsc --noEmit` clean
- [x] `npm run audit:tokens` PASS — Tier-1 leakage = 0, baseline 815/901 across 77 CSS files (was 78; -1 for deleted file)
- [x] cargo untouched
- [x] Calendar behavior preserved 1:1 (no regression to pre-5.0.3a)
- [x] This report written
- [ ] HanBin smoke test (§6)

---

## 6. Smoke test

1. Open app → Sidebar header has **only 2 action buttons** (`+`, Search). PanelRightOpen icon gone.
2. Right panel closed by default. **Right-edge thin strip** with `<PanelRightOpen>` button visible.
3. Click the strip's button → right panel slides open → shows calendar + memo list (single surface, no tabs)
4. Calendar header has close `<IconButton>` (top-right) — click closes panel → strip reappears
5. `Ctrl+→` keyboard shortcut still toggles
6. `Ctrl+K` → command palette opens with **4 commands** + notes (was 9). cmdTab* gone.
7. `Alt+1..5` → no action (bindings removed)
8. Settings → Keyboard Shortcuts → 5 fewer rows in Navigation category
9. Calendar functionality (월 이동, 날짜 클릭, 할일/메모 토글, 노트 클릭 → hover open) all work identically

---

## 7. Files in this commit

```
M src/core/layout/RightPanel.tsx                    (343 → ~270 lines, tabs removed)
M src/core/stores/uiStore.ts                        (rightPanelTab state + action removed)
M src/core/stores/zustand/index.ts                  (barrel cleaned)
M src/core/layout/Sidebar.tsx                       (PanelRightOpen toggle removed)
M src/core/app/App.tsx                              (+ hover-panel-collapsed-bar restoration)
M src/core/utils/shortcuts.ts                       (focusRightPanelTab1..5 removed)
M src/core/hooks/useAppKeyboardShortcuts.ts         (PANEL_TAB_MAP block removed)
M src/features/command-palette/CommandPalette.tsx   (cmdTab* commands removed)
M src/core/utils/i18n.ts                            (22 obsolete keys × ko/en removed)
M src/styles/index.css                              (right-panel-tabs.css import removed)
D src/styles/components/right-panel-tabs.css        (file deleted)
A docs/architecture/stage_5_reports/5_0_3_a_rework.md
```

No backend changes. No other-track files swept.

---

## 8. Plan §4.1 reconciliation

Plan §4.1 said:

> "RightPanel: 280px (current). New: tab-row at top selecting Calendar /
>  Tags / Comments / Outline / Metadata. Replaces today's 'calendar
>  visible by default, others slot-mounted invisibly' pattern. **All
>  right-panel surfaces become discoverable.**"

This is now **reverted** — the 4 per-note tabs were structurally
unsound. Plan §4.1 should be updated to reflect:

> "RightPanel: 280px. Single Calendar surface (vault-wide aggregate
>  task + memo dashboard). Per-note Tags / Comments / Outline /
>  Metadata live inside the corresponding hover window's header
>  toggle buttons (per-note scope = per-hover-window scope).
>  Discoverability via persistent right-edge thin strip with toggle
>  button."

I'll update the parent plan document in the next chore commit (low-priority cleanup).

---

## 9. Carry-forward to 5.0.4b

5.0.4b scope unchanged except:
- **Outline** moves from "Outline panel slot in right panel" → "hover window header `<ListTree>` icon button" — per-note outline, per-hover-window scope. Implementation simpler (no slot registry routing needed).
- Slash palette + bubble menu + toolbar OFF default — unchanged
