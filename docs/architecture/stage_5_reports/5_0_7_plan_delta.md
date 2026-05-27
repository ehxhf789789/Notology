# Stage 5.0.7 — Plan delta & HanBin sign-off

> 4-surface deep audit + redesign decision log. Companion to plan §8 (Search & navigation).
>
> Audit performed via 4 parallel `Explore` agents on **2026-05-17**. Decisions
> below ADD TO (not replace) the original plan §8.1–§8.4. Where this delta
> contradicts the plan, this delta wins.

---

## A. What the audit found

### A.1 Search (audit report → §A in agent output)
- **5 tabs today** (not 4 as plan assumed): Frontmatter / Contents / Attachments / Details / **Graph** (lazy-mounted).
- 0 design-system primitives used (17× raw `<button>`, 6× `<input>`, 4× `<select>`).
- 4 hex tag-category colors hardcoded in `search.css` (lines 537/543/549/555 + 617/621/625/629).
- No Cmd-K palette / no global search overlay.
- `searchHelpers.ts:5` has the Korean literal `'전체 타입'` outside i18n.

### A.2 FolderTree
- Indent: `paddingLeft: ${depth * 16 + 8}px` (raw px, JS-driven, line 392).
- DnD: row highlight + 2px border-top only — **no insertion-line indicator**.
- Folder note: `--c-blue` text color only — **no visible dot** (plan wanted a status dot, never landed).
- Context menu: `modalActions.showContextMenu()` (hand-rolled) — does NOT use the 5.0.2b `<ContextMenu>` primitive.
- 2 hand-rolled buttons + 2 hand-rolled badges that match `<Button>` / `<Badge>` shapes.

### A.3 Graph
- Library: Force-Graph v1.51.1 (canvas — **cannot consume CSS vars** at draw time; needs a color-resolver pattern).
- Settings panel: **bottom-left floating** (plan wants right-rail collapsible).
- Filters today: 3 binary toggles (`showTags`, `showAttachments`) + 3 physics sliders. No per-tag / per-type / date filters.
- Edges: 4 styles (contains / tag / attachment / default-wikilink). Plan distinguishes wikilink vs reference vs attachment — current "wiki_link" + "default" conflated.
- Hover: in-canvas label only — **no tooltip with metadata**.
- Click: single = select, double = open hover window. Plan says "click opens".
- No mini-map.
- Hardcoded hex throughout (NOTE_TYPE_COLORS × 17, FOLDER_NOTE_COLOR, glow #facc15, task #f87171, memo #fbbf24, label #ffffff/#1a1a1a).

### A.4 Calendar
- Month view only (Week & Day missing).
- 2 visible mounts: `RightPanel.tsx` `<CalendarSurface>` + standalone `Calendar.tsx`. Mobile has 2 more (`CalendarView`, `CalendarHomeView`) — out of scope (5.0.10).
- Memo chips: full-bg color, not stripe.
- Click date → sidebar list (RightPanel) or right panel (Calendar.tsx). No `<Popover>`.
- Weekday labels hardcoded in 3 places (none i18n-routed): `['Sun', 'Mon', ...]`, `['S', 'M', ...]`, `['일', '월', ...]`.
- `CalendarHomeView.tsx:14`: `MEMO_COLORS = ['#FF6B6B', '#FF922B', ...]` × 7 raw hex.

---

## B. HanBin decisions (sign-off 2026-05-17)

| # | Question | Decision | Reason |
|---|---|---|---|
| Q1 | Search 탭 구조 | **5탭 → 4탭** (Details만 폐기, **Graph 탭 유지**) | Graph는 별도 surface이지만 Search 안의 탭 형태는 의도. 머지가 아니라 정리. |
| Q2 | Cmd-K palette | **5.0.7에서 Search와 함께 구현** | "Cmd-K가 Search를 보강한다" 메시지가 한 번에 성립. CommandPalette primitive는 5.0.4a에서 이미 깔림 — 검색 어댑터만 붙임. |
| Q3 | Graph settings panel 위치 | **우측 collapsible rail로 이동** (원안) | Filter by tag / type / date 슬롯 확보 + mini-map 좌상단 자리 생김. |
| Q4 | Calendar 뷰 모드 | **Month + Day 2뷰만** (Week 제외) | PKM에서 Week 사용 빈도 낮음. Day는 daily journal 가치 큼. SegmentedControl 토글. |

---

## C. Sub-stage breakdown

### 5.0.7a — Search redesign
**Scope**
1. **Tab structure**: 5탭 → 4탭. Details 탭 제거 (`mode === 'details'` 분기 + `filteredDetailsNotes` state + DetailsResultCard 호출 모두 삭제). Frontmatter / Contents / Attachments / Graph 유지. Details에 있던 메타 정보는 Frontmatter 행 클릭 시 inline-expand 패널로 흡수.
2. **Cmd-K global palette**: 기존 5.0.4a `CommandPalette` 컴포넌트에 검색 어댑터 추가. `Ctrl/Cmd+K` 단축키로 어디서나 호출 → 노트 즉시 검색 + recent files + 명령어 (in-palette navigation). Search 패널과는 별도 surface.
3. **Tag category color tokens**: 4개 raw hex → `--tag-domain` / `--tag-who` / `--tag-org` / `--tag-ctx` Tier-3 토큰. light/dark 양쪽 정의.
4. **Result card primitive**: 그동안 `.search-content-item` / `.search-details-item` raw div → 새 `<SearchResultCard>` 컴포넌트 (design-system `<Card>` 기반). FrontmatterResultRow는 가상 그리드 특성상 raw row 유지 (성능).
5. **Primitive swap**: 검색 input → `<Input>`, 필터 토글 → `<Button variant="ghost">`, 일괄 동작 버튼 → `<Button variant="danger">`, 컨텍스트 메뉴 → 5.0.2b `<ContextMenu>` primitive.
6. **i18n**: `searchHelpers.ts:5` `'전체 타입'` → `t('allTypes', lang)` + 추가 누락 키.

**Out of scope for 5.0.7a**
- FloatingWords tag cloud relocation (Calendar surface가 RightPanel을 점유 중. 5.0.3a-rework에서 RightPanel = Calendar only 결정 그대로). 별도 Tag panel은 5.0.7c Graph rail에 흡수하거나 향후 별도 surface로 검토.

### 5.0.7b — FolderTree polish
**Scope**
1. Indent: JS `paddingLeft` → CSS variable `--tree-indent-depth` 주입 + CSS `calc(var(--tree-indent-depth, 0) * var(--space-md) + var(--space-sm))`.
2. Optional connector lines (CSS `::before` vertical guide line per depth level — togglable via setting).
3. DnD insertion-line indicator: 행 highlight 대신 위/아래 4px 라인. `--c-accent` 색상.
4. Folder-note status dot: `renderFolderIcon`에 6px circular dot 추가 (현재 파란 글자색은 보조 신호로 유지). `--c-accent` 색상.
5. Button/Badge primitive 교체: `expandAll`/`newFolder` → `<Button variant="ghost" size="sm">`. note-count badge → `<Badge variant="neutral" size="sm">`.
6. Spacing token: raw px(`padding: 8px 12px`, `4px 0`, `6px 8px` 등) → `var(--space-*)`.
7. ContextMenu primitive 교체: **deferred** — `modalActions.showContextMenu`는 30+ call site에서 공유. 5.0.7b에서는 시각만 정리. primitive 전환은 별도 mini-stage(5.0.7e).

### 5.0.7c — Graph redesign
**Scope**
1. **Settings panel relocation**: bottom-left floating → 우측 collapsible rail. Rail 폭 280px. Toggle 버튼 graph canvas 우상단.
2. **Filter slots**: 기존 binary toggle 유지 + 새 슬롯:
   - Tag filter (multi-select chip)
   - Type filter (multi-select chip) — registered NoteTemplate들 + "미확인" pseudo-type
   - Date range (created/modified, 2-input)
3. **Color resolver pattern**: `graph-colors.ts` 신규 — 마운트/테마 변경 시 `getComputedStyle(root)`로 토큰 → JS Map 캐시. Force-Graph가 그릴 때 이 Map에서 hex pull. NOTE_TYPE_COLORS / TAG_NAMESPACE_COLORS / FOLDER_NOTE_COLOR / glow / task / memo 모두 통일.
4. **Edge type 분리**: `contains` (folder→note), `tag` (tag→note), `attachment` (attachment→note), `wiki_link` (note→note, default = reference). 4종 모두 width/dash/색상 명시. 우측 rail에 edge 토글.
5. **Hover tooltip**: 캔버스 위 floating tooltip (HTML element, 캔버스 좌표 → 화면 좌표 변환). 노트 제목 + `frontmatter.updatedAt` (있다면).
6. **Mini-map**: 우상단 160×120 mini canvas. 본 graph의 transform을 동기화 + viewport rect 표시. 클릭 시 pan.
7. **Click 동작**: 단일 클릭 = select+highlight 유지 (deliberate inspection), 더블 = open. 플랜 문구 "click opens"는 실제 UX 흐름상 double-click이 옳다고 판단 — 이 부분은 plan §8.3 문구 update.
8. **Primitive 교체**: Search bar/Settings 버튼/Checkbox/Slider → 5.0.2 primitives.

### 5.0.7d — Calendar redesign
**Scope**
1. **View mode**: SegmentedControl `Month / Day`. Default = Month. `calendarStore`에 viewMode 추가.
2. **Day view**: 단일 일자 종일 + 시간대(0~23h) vertical layout. 좌측 시간 gutter + memo 카드. CalendarMemo에 시간 정보가 없으면 "종일" 섹션 top.
3. **Chip stripe**: 현재 full-bg → 4px left border (`stripe-style`) + neutral background. memo/task type별 stripe 색상.
4. **Click date → `<Popover>`**: 날짜 셀 클릭 시 design-system `<Popover>` 안에 day's notes + memos + tasks. RightPanel의 sidebar list는 Popover로 일원화 — sidebar에서는 list 제거.
5. **i18n weekday**: 3곳 hardcoded → `weekdayShort` / `weekdayFull` i18n 키.
6. **MEMO_COLORS 토큰화**: CalendarHomeView의 raw hex 7개 → tokens.css `--memo-color-{1..7}` (모바일도 같이 정리).
7. **SegmentedControl 교체**: Task/Memo 필터 토글 2개 → `<SegmentedControl>`.
8. **Tooltip**: memo chip hover → 본문 preview.

---

## D. Sequencing & estimate

| Sub-stage | Scope summary | Sessions |
|---|---|---|
| 5.0.7a | Search 4-tab + Cmd-K + Card + tokens + primitive | ~1.5 |
| 5.0.7b | FolderTree polish (ContextMenu primitive 제외) | ~0.5 |
| 5.0.7c | Graph right-rail + color resolver + mini-map + tooltip | ~1.5 |
| 5.0.7d | Calendar Month+Day + Popover + i18n + tokens | ~1.0 |
| 5.0.7e *(optional)* | ContextMenu primitive 전체 마이그레이션 | ~0.5 |
| **Total** | **~4.5 sessions** (plan §14 original = 2 sessions for 5.0.7) | |

Estimate growth driven by: Cmd-K palette inclusion (Q2), Graph mini-map + color-resolver (Q3 + library constraint), Calendar Day view (Q4 partial).

---

## E. Acceptance criteria per sub-stage

각 sub-stage 완료 시:
1. tsc clean
2. cargo unchanged (backend touch 금지 — Stage 5.0 freeze)
3. design-tokens audit script PASS (Tier-1 leakage 0)
4. Korean + English i18n 양쪽 갱신
5. 새 primitive(있다면) 모두 design-system index export에서 노출
6. 짧은 report `5_0_7_{a|b|c|d}.md` (before/after 스크린샷 + checklist)
7. HanBin 시각 sign-off

---

## F. What this delta deliberately does NOT change

- 플랜 §8.1의 "Notes / Attachments 2탭 머지" → **취소** (Q1: Details만 폐기 + Graph 유지). FrontmatterResultRow가 가상 그리드인 채로 Contents와 동시 표현이 어렵고, HanBin 판단상 정보 손실 risk가 더 큼.
- 플랜 §8.1의 "FloatingWords → Right-panel Tags tab" → **deferred**. RightPanel은 5.0.3a-rework 결정대로 Calendar 단일 surface 유지. Tag exploration은 5.0.7c Graph rail의 tag filter로 흡수 시도.
- 플랜 §8.4의 "Week view" → **취소** (Q4).
- 5.0.7b ContextMenu primitive 전체 swap → **5.0.7e로 분리**(optional).
