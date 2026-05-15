# Stage 5.0.4-pre — Command & Shortcut Audit

**Date**: 2026-05-15
**Status**: 📋 Audit complete — awaiting HanBin sign-off on the new map before 5.0.4 implementation begins
**Parent plan**: [`STAGE_5_0_DESIGN_SYSTEM_PLAN.md`](../STAGE_5_0_DESIGN_SYSTEM_PLAN.md) §18a (Q3 requirement)
**Predecessor**: [5.0.3b — TitleBar + Sidebar collapse](./5_0_3_b.md) (commit `bff4442`)
**Blocks**: 5.0.4 (editor redesign) — see plan §18a

---

## 0. Why this audit exists

HanBin's Q3 sign-off (2026-05-14): "Re-design the entire command + shortcut
system before 5.0.4 implementation. Current `/`, `//`, `$`, `$$` etc. are
inconsistent. Standard editing shortcuts (Ctrl+Z / Ctrl+Shift+Z / Ctrl+X /
Ctrl+C / Ctrl+V) must work without collision with custom commands."

This is a **read-only audit** — no code changes in this commit. Output is
a complete inventory + collision report + proposed new map. HanBin's
sign-off on the map is required before 5.0.4 implementation lands.

---

## 1. Complete inventory (current state)

### 1.1 App-level shortcuts (28 total)

Source: [`src/core/utils/shortcuts.ts`](../../../src/core/utils/shortcuts.ts) + [`useAppKeyboardShortcuts.ts`](../../../src/core/hooks/useAppKeyboardShortcuts.ts)

| Category | ID | Default keys | Action | Status |
|---|---|---|---|---|
| **Text** | bold | `Ctrl+B` | toggle bold | ✓ standard |
| | italic | `Ctrl+I` | toggle italic | ✓ standard |
| | underline | `Ctrl+U` | toggle underline | ✓ standard |
| | strikethrough | `Ctrl+Shift+X` | toggle strikethrough | ✓ |
| | code | `Ctrl+E` | inline code | ✓ |
| | highlight | `Ctrl+Shift+H` | highlight | ✓ |
| **Heading** | heading1–6 | `Ctrl+1`…`Ctrl+6` | H1…H6 | ✓ |
| **List** | bulletList | `Ctrl+Shift+8` | bullet list | ✓ |
| | orderedList | `Ctrl+Shift+7` | numbered list | ✓ |
| | taskList | `Ctrl+Shift+9` | task list | ✓ |
| | indent | `Tab` | indent (list or paragraph) | ✓ |
| | outdent | `Shift+Tab` | outdent | ✓ |
| **Block** | blockquote | `Ctrl+Shift+B` | blockquote | ✓ |
| | codeBlock | `Ctrl+Shift+E` | code block | ✓ |
| | horizontalRule | `Ctrl+Shift+-` | horizontal rule | ✓ |
| **System** | save | `Ctrl+S` | (no-op — auto-save) | ✓ |
| | undo | `Ctrl+Z` | undo (TipTap) | ✓ |
| | redo | `Ctrl+Shift+Z` | redo (TipTap) | ✓ |
| | deleteNote | `Ctrl+D` | delete current note | ✓ |
| | toggleMemo | `Ctrl+M` | toggle memo panel | ✓ |
| | **toggleMetadata** | `Ctrl+Shift+M` | toggle metadata panel | ⚠️ DEV collision below |
| **Navigation** | newNote | `Ctrl+N` | new note in selected folder | ✓ |
| | **search** | `Ctrl+Shift+F` **or** `Ctrl+K` | open search | ⚠️ Ctrl+K conflict with plan |
| | **calendar** | `Ctrl+Shift+C` | opens right panel | ⚠️ misleading name |
| | toggleSidebar | `Ctrl+ArrowLeft` | toggle sidebar | ✓ |
| | toggleRightPanel | `Ctrl+ArrowRight` | toggle right panel | ✓ |

DEV-only (gated by `import.meta.env.DEV`):
- `Ctrl+Shift+M` → opens mobile test window (phone)
- `Ctrl+Shift+T` → opens mobile test window (tablet)

### 1.2 TipTap editor keymaps (custom extensions)

| Extension | Trigger / Key | Action |
|---|---|---|
| **WikiLink** | InputRule `/\[\[(.+?)\]\]$/` | text `[[name]]` → wiki-link node |
| | `Esc` (when selection) | clear marquee selection |
| | `Ctrl/Cmd + drag` | marquee-select attachment chips |
| | `Shift / Ctrl / Cmd + click` | toggle chip in selection |
| **MathExtension** | `$` (single, 300ms debounce) | enter inline math edit |
| | `$$` (two consecutive) | enter block math edit |
| | `Enter` (in inline math) | save inline math |
| | `Ctrl+Enter` (in block math) | save block math |
| | `Esc` | cancel math edit |
| | `Tab` | save math + move out |
| | double-click | re-enter math edit |
| **CodeBlockWithHighlight** | markdown ` ``` ` fence (parser) | create code block |
| | `Mod+Enter` | new paragraph after code block |
| | `Backspace` (empty, at start) | remove code block |
| **Indent** | `Tab` (in list) | sinkListItem |
| | `Tab` (in paragraph) | first-line indent |
| | `Shift+Tab` (in list) | liftListItem |
| | `Shift+Tab` (in paragraph) | hanging indent |
| **MediaEmbed** | text `![[file]]` transform | render as image / video / file embed |

### 1.3 Modal-level handlers

Source: [`useModalListeners.ts`](../../../src/core/hooks/useModalListeners.ts), 12 modals under [`src/features/modals/`](../../../src/features/modals/)

| Modal | Enter | Escape | Tab |
|---|---|---|---|
| TitleInputModal | submit | cancel | default |
| RenameDialog | submit | cancel | default |
| MoveNoteModal | (button-driven) | cancel | default |
| ConfirmDeleteModal | (button-driven) | cancel | default |
| AlertModal | (button-driven) | dismiss | default |
| ContactInputModal | next/submit | cancel | default |
| MeetingInputModal | next/submit | cancel | default |
| EventInputModal | next/submit | cancel | default |
| PaperInputModal | next/submit | cancel | default |
| LiteratureInputModal | next/submit | cancel | default |
| BulkTagModal | — | dismiss | default |
| VaultLockModal | submit | (none — forced) | default |

Reusable hooks:
- `useModalClose(ref, onClose, isOpen)` → click-outside + Escape
- `useEscapeKey(callback, enabled)` → ESC only
- `useEnterKey(callback, enabled)` → Enter only (Shift+Enter excluded)

### 1.4 Context menu (right-click)

[`src/features/context-menu/ContextMenu.tsx`](../../../src/features/context-menu/ContextMenu.tsx) renders shortcut hint strings in menu items but **does not bind those keys** — labels only. Actual binding happens at the app-level via `useAppKeyboardShortcuts`.

### 1.5 Hover-window shortcuts

[`HoverEditor.tsx`](../../../src/features/hover-windows/HoverEditor.tsx) uses the shared `useAppKeyboardShortcuts` (Ctrl+K still triggers search even when focused in a hover window). Escape on hover windows is currently **not bound** — they don't close on ESC.

---

## 2. Collisions & inconsistencies identified

### 2.1 Hard collisions

| Key | Conflict | Severity |
|---|---|---|
| **`Ctrl+Shift+M`** | `toggleMetadata` (always) + `mobile test phone` (DEV only) | 🟠 DEV only — production safe but confusing for devs |
| **`Ctrl+K`** | `search` (currently aliased to `Ctrl+Shift+F`) | 🔴 plan §5.2 wants Ctrl+K = navigation palette, not search |

### 2.2 Semantic mismatches

| Key | Issue | Severity |
|---|---|---|
| **`Ctrl+Shift+C`** (calendar) | Name says "calendar" but actually opens the right panel (which now contains the calendar tab after 5.0.3a) | 🟡 functional but the binding ID is misleading |
| **`Ctrl+S`** (save) | Defined in shortcuts.ts but no actual handler — auto-save covers it. Listing it as a binding implies it does something. | 🟡 dead entry; either remove or wire to "Save now" indicator |
| **Toolbar default OFF** | HanBin's Stage 5.0 plan §18 Q3 sets editor toolbar default-OFF in favor of slash command — but slash command does not yet exist (no `/` InputRule found) | 🟡 plan-implementation gap |

### 2.3 Missing pieces

| Item | Plan wants | Current state |
|---|---|---|
| **`/` slash palette** | Primary insert affordance (block-level callout/code/math/table/divider/embed) | **Does not exist** — no `/` InputRule or SuggestionExtension found |
| **`Cmd+K` palette** | Global navigation: file jump + recent + commands | Aliased to search — same surface |
| **`Esc` on hover windows** | Standard: should minimize or close focused hover window | **Not bound** |

---

## 3. OS-standard shortcuts — verification

Plan §18a explicit requirement: "OS-standard shortcuts (Ctrl+Z/Y/X/C/V/A/F/S) must work without collision."

| Key | Status | Notes |
|---|---|---|
| `Ctrl+Z` | ✅ TipTap default (undo) | Reserved |
| `Ctrl+Y` | ✅ TipTap default (redo) | Reserved — also `Ctrl+Shift+Z` alias |
| `Ctrl+Shift+Z` | ✅ explicit binding | redo |
| `Ctrl+X` | ✅ browser native (cut) | Not overridden |
| `Ctrl+C` | ✅ browser native (copy) | Not overridden |
| `Ctrl+V` | ✅ browser native (paste) | Not overridden — TipTap PasteRules run on top, non-blocking |
| `Ctrl+A` | ✅ browser native (select all) | Not overridden |
| `Ctrl+F` | ✅ browser native (in-page find) | **NOT** overridden by app-level — search uses `Ctrl+Shift+F` |
| `Ctrl+S` | ⚠️ listed as binding but unhandled | Dead — auto-save covers, no visible action |

All OS standards safe. `Ctrl+S` is the only one with a misleading listing.

---

## 4. Proposed new map

### 4.1 Reserved (never override)

```
Ctrl+Z  Ctrl+Y  Ctrl+Shift+Z         — undo / redo
Ctrl+X  Ctrl+C  Ctrl+V  Ctrl+A       — cut / copy / paste / select-all
Ctrl+F                                — browser in-page find (NOT overridden)
Ctrl+S                                — save (dead entry — remove or wire to indicator)
Tab  Shift+Tab                        — indent / outdent (TipTap context-sensitive)
Escape                                — close current modal / cancel current edit
Enter / Shift+Enter                   — submit / newline
```

### 4.2 Text formatting (editor — TipTap defaults preserved)

```
Ctrl+B            bold
Ctrl+I            italic
Ctrl+U            underline
Ctrl+E            inline code
Ctrl+Shift+X      strikethrough
Ctrl+Shift+H      highlight
Ctrl+1..6         heading 1..6
Ctrl+Shift+8/7/9  bullet / ordered / task list
Ctrl+Shift+B      blockquote
Ctrl+Shift+E      code block
Ctrl+Shift+-      horizontal rule
```

No changes. These are the established TipTap conventions and HanBin's existing muscle memory.

### 4.3 Navigation (re-designed)

```
Ctrl+K              ← NEW SEMANTIC: command palette (file jump + recent + commands)
Ctrl+Shift+F        search (kept — full-text search inside a vault)
Ctrl+P              quick file open (alias of Ctrl+K for VS Code parity, optional)
Ctrl+Shift+P        command palette (alias for Ctrl+K, optional)
Ctrl+ArrowLeft      toggle sidebar
Ctrl+ArrowRight     toggle right panel
Ctrl+Shift+E        ← REASSIGN: focus sidebar (file explorer) — same convention as VS Code

Ctrl+Shift+C        ← RENAME ID 'calendar' → 'focusCalendarTab' OR drop entirely:
                       since plan §4.1 makes the right-panel toggle the canonical
                       discoverability path, keeping a "jump to calendar tab"
                       shortcut is redundant. Recommendation: REMOVE this binding.
```

Rationale:
- `Ctrl+K` becomes the universal entry point (plan §5.2). Same key family as VS Code / Linear / Slack.
- `Ctrl+Shift+F` stays as classic "search within vault" — same key as VS Code Search.
- `Ctrl+Shift+C` removed because (a) the name was a lie (it opens the right panel), (b) right panel now has its own toggle (`Ctrl+ArrowRight`) and visible Sidebar button after 5.0.3a/b.

### 4.4 Note operations

```
Ctrl+N              new note (in selected folder)
Ctrl+D              delete current note          [keep — but consider Ctrl+Shift+D
                                                  to avoid accidental delete]
Ctrl+M              toggle memo panel
Ctrl+,              open settings                [NEW — VS Code parity]
```

**Pending question**: `Ctrl+D` delete-note is dangerous. VS Code uses Ctrl+D for word-multicursor. Recommendation: change to `Ctrl+Shift+Delete` or move to context menu only.

### 4.5 Editor-internal — the `/` palette (NEW in 5.0.4)

```
/                   open slash command palette inside the editor
                    Type-ahead filters: format / insert / reference / embed / math
                    Arrow + Enter to commit, Esc to cancel
```

Initial palette categories (from plan §5.2):
- **Format**: heading 1/2/3, bullet/ordered/task list, quote, divider
- **Insert**: callout, code block, table, math block, image, embed, attachment
- **Reference**: wiki link, backlink, citation, mention
- **Math**: inline (`$..$`), block (`$$..$$`) — note: existing `$` trigger remains as a quick path
- **Embed**: link card, file, YouTube, image gallery

The slash palette is **the only `/` consumer**. Inline math `$..$` and block math `$$..$$` retained (different sigil, no conflict).

### 4.6 DEV-only shortcuts

```
Ctrl+Shift+M  (DEV only) → mobile test window — phone
Ctrl+Shift+T  (DEV only) → mobile test window — tablet
```

**Collision with `Ctrl+Shift+M` (toggleMetadata)** in DEV: both fire on the same key in development. **Recommendation**: change DEV shortcuts to `Ctrl+Alt+Shift+M/T` (4-modifier combos won't collide with user shortcuts).

### 4.7 Hover-window shortcuts (5.0.9 carry-forward)

```
Esc            close focused hover window      [NEW — currently unbound]
Ctrl+W         close focused hover window      [NEW — VS Code parity]
Ctrl+M         minimize focused hover window   [conflict with toggleMemo — needs scoping]
```

The hover-window scoping is a 5.0.9 issue but flagged here so 5.0.4 doesn't accidentally consume these keys.

---

## 5. Changes required in 5.0.4 implementation

When 5.0.4 lands, the editor work must include:

1. **`/` slash-command palette** — new SuggestionExtension, opens floating panel using 5.0.2b `<Popover>` + `<DropdownMenu>` primitives, filtered command list
2. **`Ctrl+K` global command palette** — new feature module `src/features/command-palette/`, same `<Popover>` chrome, content = file jump + recent + actions
3. **Remove dead `Ctrl+S` binding** in `DEFAULT_SHORTCUTS`
4. **Rename or remove `Ctrl+Shift+C` calendar binding** (recommendation: remove)
5. **Add `Ctrl+,` settings shortcut** (VS Code parity)
6. **Move DEV mobile-test shortcuts** to `Ctrl+Alt+Shift+M/T` to free `Ctrl+Shift+M` for `toggleMetadata`
7. **Optional**: change `Ctrl+D` delete-note to `Ctrl+Shift+Delete` (HanBin decision)
8. **Optional**: add hover-window `Esc` to close + `Ctrl+W` (defer to 5.0.9 if scope-bound)

### 5.1 Migration in `shortcuts.ts` + `useAppKeyboardShortcuts.ts`

```ts
// shortcuts.ts — DEFAULT_SHORTCUTS edits:
- { id: 'save', ...,           defaultKeys: 'Ctrl+S' }        // REMOVE (dead)
- { id: 'calendar', ...,       defaultKeys: 'Ctrl+Shift+C' }  // REMOVE (right-panel toggle covers it)
+ { id: 'commandPalette',      defaultKeys: 'Ctrl+K' }        // NEW
+ { id: 'settings',            defaultKeys: 'Ctrl+,' }        // NEW
  { id: 'search',              defaultKeys: 'Ctrl+Shift+F' }  // KEEP (drop Ctrl+K alias)
  // ... rest unchanged ...
```

```ts
// useAppKeyboardShortcuts.ts — remove the `Ctrl+K` alias inside the
// `search` branch (it currently uses `|| (e.ctrlKey && e.key === 'k' ...)`).
// Add explicit `commandPalette` branch → opens new <CommandPalette> dialog.
// Add explicit `settings` branch → opens Settings modal.
// DEV mobile-test: gate on `e.altKey` too.
```

### 5.2 Text-trigger conventions (plan §18a explicit requirement)

| Trigger | Behavior | Notes |
|---|---|---|
| `/` | open slash palette | NEW in 5.0.4 |
| `[[` | start wiki-link suggestion | existing |
| `![[` | start media-embed (image / video / file) | existing |
| `$..$` | inline math | retained — only `$` sigil, no `/` collision |
| `$$..$$` | block math | retained — only `$` sigil |
| ` ``` ` | code block | retained (markdown fence) |
| `>` | blockquote (TipTap inputRule on space) | TipTap default |
| `-` / `*` | bullet list (on space) | TipTap default |
| `1.` | ordered list (on space) | TipTap default |
| `#` | heading (with space) | TipTap default |
| `---` | horizontal rule | TipTap default |

`//`, single `$` without delimiter, and other ambiguous triggers are **NOT** active inputRules — confirmed by extension search. No further collision.

---

## 6. HanBin sign-off questions

Before 5.0.4 implementation begins, please confirm:

1. **`Ctrl+K` = command palette (NOT search)** — agree? (plan default = yes)
2. **`Ctrl+Shift+F` = search (no more Ctrl+K alias)** — agree?
3. **Remove `Ctrl+Shift+C` calendar binding** entirely (right-panel toggle covers it)? Or keep with renamed ID `focusCalendarTab`?
4. **`Ctrl+,` = settings** (VS Code parity) — agree?
5. **`Ctrl+D` delete-note** — keep as-is, or move to `Ctrl+Shift+Delete` for safety?
6. **DEV mobile-test shortcuts** — change to `Ctrl+Alt+Shift+M/T` to free `Ctrl+Shift+M` for `toggleMetadata`?
7. **Hover-window Esc/Ctrl+W** — include in 5.0.4 scope, or defer to 5.0.9?
8. **`Ctrl+S` save binding** — remove from `DEFAULT_SHORTCUTS` list (it's dead), or wire to "saving…" indicator flash?

---

## 7. Files in this commit

```
A docs/architecture/stage_5_reports/5_0_4_pre_command_audit.md
```

**No code changes.** This is a pure audit + design proposal. Code edits land
in 5.0.4 implementation commits after HanBin signs off on §6 above.

---

## 8. Next sub-stage entry conditions

5.0.4 implementation can begin when:
- HanBin answers the 8 questions in §6
- Final shortcut map agreed
- (Implicit) `<CommandPalette>` design accepted as part of 5.0.4 scope

Estimated 5.0.4 sessions: 3 (was 2 in plan §14, +1 for command audit / palette per plan §18b).
