# Stage 5.0.3b-simplify — Single sidebar collapse axis

**Date**: 2026-05-15
**Status**: ✅ Acceptance criteria met — ready for HanBin smoke test
**Reverts (in part)**: [5.0.3b](./5_0_3_b.md) — bottom collapse toggle removed; hidden-mode rolled back

---

## 1. Why

HanBin smoke test feedback: "사이드바 축소, 확장 버튼은 이미 상단에 있는데 하단에 왜 있는거지?"

5.0.3b shipped two independent collapse axes:
- **Top button** (`<PanelLeftClose>`) — `showSidebar` toggle (hidden mode)
- **Bottom button** (`<ChevronsLeft>`) — `sidebarCollapsed` toggle (icon-only mode)

User cognitive model collapsed them into "축소" with no clear distinction — the bottom button looked like a duplicate of the top. AskUserQuestion (2026-05-15) confirmed: keep icon-only, drop hidden.

---

## 2. Changes landed

### 2.1 Sidebar.tsx

Top button repurposed: `setShowSidebar` → `setSidebarCollapsed`. Icon now reflects collapse state (`<PanelLeftClose>` when expanded, `<PanelLeftOpen>` when icon-only). Tooltip uses `sidebarCollapse` / `sidebarExpand` strings. `aria-pressed` reflects collapsed state.

Bottom `<ChevronsLeft>` / `<ChevronsRight>` `<IconButton>` + `<Tooltip>` removed entirely. Footer is back to: vault-button + sync-status `<Slot>` + settings.

`ChevronsLeft` / `ChevronsRight` imports dropped. `useShowSidebar` / `showSidebar` references dropped (no longer needed in this surface).

### 2.2 App.tsx

`.sidebar-collapsed-bar` thin-strip + `<PanelLeftOpen>` reopen button removed — unreachable now (showSidebar always true). Layout simplified:

```tsx
<div className={`sidebar-wrapper open${sidebarCollapsed ? ' sidebar-wrapper--icon-only' : ''}`}
     style={{ width: sidebarCollapsed ? SIDEBAR_ICON_WIDTH : sidebarWidth }}>
  <Sidebar />
  {!sidebarCollapsed && <div className="divider" onMouseDown={startResize} />}
</div>
```

Imports dropped: `PanelLeftOpen`, `useShowSidebar`, `useSidebarAnimState`. The `sidebarAnimState` slide animation (180ms hide/show) is dead since hidden mode is gone — width transition is now driven by the css `width` animation on `.sidebar-wrapper` directly.

### 2.3 useAppKeyboardShortcuts.ts

`toggleSidebar` (Ctrl+ArrowLeft) handler semantic flipped: `setShowSidebar(!showSidebar)` → `setSidebarCollapsed(!collapsed)`. `useShowSidebar` import dropped; `useUIStore` imported instead for the `getState()` access pattern (same shape we use elsewhere). The shortcut binding key (`Ctrl+ArrowLeft`) and id (`toggleSidebar`) and labels stay — only the action behind it changes.

### 2.4 CommandPalette.tsx

`cmdToggleSidebar` command: `setShowSidebar(!showSidebar)` → `setSidebarCollapsed(!sidebarCollapsed)`. matchText updated to include "축소". Memo dep array `showSidebar` → `sidebarCollapsed`.

### 2.5 uiStore — unchanged

`showSidebar` state, `setShowSidebar` action, `useShowSidebar` selector, `sidebarAnimState` all retained as legacy. They're untouched by user actions now but other code may still import them (defensive). `sidebar-collapsed-bar` + `.sidebar-collapsed-toggle` CSS in `sidebar.css` becomes orphan styles — to be deleted in a chore commit when `sidebar.css` next gets edited (other-track has WT changes there, can't touch cleanly).

---

## 3. Resulting UX

| Action | Result |
|---|---|
| Click top `<PanelLeftClose>` | Sidebar collapses to icon-only (52px) |
| Click top `<PanelLeftOpen>` | Sidebar expands back |
| `Ctrl+ArrowLeft` | Same toggle |
| Cmd+K → "사이드바 토글" → Enter | Same toggle |
| Drag divider (when expanded) | Resize between 200–500px (existing) |
| `Ctrl+→` / right-edge strip | Right panel toggle (unchanged) |

Single button + single keyboard binding + single command-palette entry, all driving one state. Hidden mode (sidebar fully gone) no longer reachable — the icon-only state is the smallest representation.

---

## 4. Files in this commit

```
M src/core/layout/Sidebar.tsx                  (top button repurpose + bottom toggle removed)
M src/core/app/App.tsx                         (collapsed-bar removed, unused imports cleaned)
M src/core/hooks/useAppKeyboardShortcuts.ts    (toggleSidebar semantic flip)
M src/features/command-palette/CommandPalette.tsx (cmdToggleSidebar semantic flip)
A docs/architecture/stage_5_reports/5_0_3_b_simplify.md
```

No backend changes. No other-track files swept. uiStore + sidebar.css left untouched (legacy state safe, orphan CSS for a future chore commit).

---

## 5. Verification

- `npx tsc --noEmit` clean
- `npm run audit:tokens` PASS — Tier-1 leakage = 0, baseline 815/901 across 78 CSS files (unchanged)
- cargo untouched

---

## 6. Smoke test (HanBin)

1. Open app → sidebar expanded with vault tree
2. Click top `|<` button → sidebar collapses to 52px icon rail (was: fully hidden)
3. Top button icon flips to `<PanelLeftOpen>` → click → expanded back
4. F5 reload → sidebar state restored (localStorage `notology-sidebar-collapsed`)
5. `Ctrl+←` → toggle works the same
6. `Ctrl+K` → "사이드바 토글" command → same
7. No bottom-footer toggle button visible anymore — footer has vault + sync-status + settings only
