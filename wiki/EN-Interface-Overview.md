[◀ Getting Started](EN-Getting-Started) · [<img src="images/icons/home.png" width="16" height="16"> Home](Home) · [Sidebar ▶](EN-Sidebar-Explorer)

---

# <img src="images/icons/layout.png" width="24" height="24"> Interface Overview

Let's walk through each part of the Notology app screen.

---

## Overall Layout

Notology is divided into **3 main areas**.

```
┌──────────────────────────────────────────────────┐
│                    Title Bar                       │
├──────────┬─────────────────────┬─────────────────┤
│          │                     │                 │
│ Sidebar  │    Editor Area      │  Right Panel    │
│          │                     │                 │
│ · File   │  · Toolbar          │  · Calendar     │
│   Explorer│  · Note editing    │  · Memo list    │
│ · Containers│  · Auto-save     │  · Backlinks    │
│ · Search │                     │                 │
│ · Settings│                    │                 │
│          │                     │                 │
├──────────┴─────────────────────┴─────────────────┤
│                    Status Bar                      │
└──────────────────────────────────────────────────┘
```

- **Sidebar (left)**: Browse and manage your files and folders
- **Editor Area (center)**: The main space where you write and edit notes
- **Right Panel**: Shows supplementary info like the calendar, memos, and backlinks

> 📸 **GIF placeholder** — `images/interface-overview.png`
>
> **Shot**: Full Notology app screen — all 3 areas visible
> **Steps**: Sidebar with folders/notes visible, editor showing note content, calendar displayed on the right
> **Screen area**: Full app window capture
> **Highlight**: Clear view of all three main regions
> **Duration**: Screenshot (static)

---

## Sidebar (Left)

The sidebar is where you browse and manage your files, similar to Windows File Explorer.

| Element | What it does |
|---------|-------------|
| Vault Selector | Shows the current Vault name; click to switch to a different Vault |
| File Explorer | Displays your folders and notes in a tree structure |
| Bottom Buttons | Buttons for creating a new note (+), searching, and opening settings |

> 📸 **GIF placeholder** — `images/sidebar-toggle.gif`
>
> **Shot**: Toggling the sidebar open and closed with Ctrl+Left Arrow
> **Steps**: ① Sidebar is open → ② Press Ctrl+Left Arrow → ③ Sidebar collapses (editor gets wider) → ④ Press Ctrl+Left Arrow again → ⑤ Sidebar reopens
> **Screen area**: Full app window (sidebar area change visible)
> **Highlight**: The editor expanding as the sidebar collapses
> **Duration**: 3~5s

> 📸 **GIF placeholder** — `images/sidebar-folder-tree.gif`
>
> **Shot**: Expanding and collapsing folders in the sidebar to browse notes
> **Steps**: ① Click a folder to expand it → ② Check the notes inside → ③ Expand another folder → ④ Click a note to open it in the editor
> **Screen area**: Sidebar area centered (with some editor visible)
> **Highlight**: Clicking the folder arrow and the note opening in the editor
> **Duration**: 5~8s

For more details, see the [Sidebar & Explorer](EN-Sidebar-Explorer) page.

---

## Editor Area (Center)

This is the main space where you write and edit your notes.

### Toolbar

The row of buttons at the top of the editor. One click applies formatting.

- Text styling (bold, italic, underline, etc.)
- Heading levels (H1 through H6)
- Lists (bullet, numbered, checklist)
- Insert table, image, code block
- Text alignment, callout (colored box)

> 📸 **GIF placeholder** — `images/toolbar-toggle.gif`
>
> **Shot**: Clicking various formatting buttons in the toolbar
> **Steps**: ① Select text → ② Click Bold (B) → ③ Click Italic (I) → ④ Open the Heading (H) dropdown → ⑤ Select H2
> **Screen area**: Editor toolbar + top portion of editor body
> **Highlight**: Text formatting applied after each button click
> **Duration**: 5~8s

### Editing Space

A real-time Markdown editor. Type Markdown syntax and it renders immediately. For example, typing `# Heading` instantly becomes a large heading.

---

## Right Panel

Displays the calendar and supplementary information.

| Element | What it does |
|---------|-------------|
| Calendar | Shows a monthly calendar. Click a date to see memos written on that day |
| Memo List | Displays inline memos (comments) added on the selected date |
| Backlinks | Shows a list of other notes that reference the note you're currently viewing |

> 📸 **GIF placeholder** — `images/right-panel.gif`
>
> **Shot**: Clicking a calendar date in the right panel and checking memos
> **Steps**: ① View the calendar in the right panel → ② Click a date that has memos → ③ Memo list appears → ④ Click a memo to navigate to that note
> **Screen area**: Right panel area only
> **Highlight**: The moment memo list appears after clicking a date
> **Duration**: 5~8s

---

## Hover Windows (Floating Windows)

Small floating windows that appear on top of the main editor. They let you view other notes while you keep writing — extremely handy.

> 📸 **GIF placeholder** — `images/hover-window-intro.gif`
>
> **Shot**: A hover window appearing over the main editor
> **Steps**: ① Click a wikilink ([[...]]) in the main editor → ② Hover window opens → ③ Review content in the hover window → ④ Close the hover window
> **Screen area**: Full app window
> **Highlight**: The hover window floating above the main editor
> **Duration**: 5~8s

For more details, see the [Hover Windows](EN-Hover-Windows) page.

---

## Title Bar

The bar at the very top of the app.

- Displays the name of the currently open note
- Contains the minimize, maximize, and close buttons
- Drag the title bar to move the app window

---

## Common Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl + N` | Create a new note |
| `Ctrl + Shift + F` | Open search |
| `Ctrl + Left Arrow` | Toggle sidebar open/closed |
| `Ctrl + Mouse Wheel` | Zoom editor in/out |
| `Ctrl + B` | Bold text |
| `Ctrl + I` | Italic text |
| `Ctrl + Z` | Undo |
| `Ctrl + Shift + Z` | Redo |

For more shortcuts, see the [Editor Basics](EN-Editor-Basics) page.

---

[◀ Getting Started](EN-Getting-Started) · [<img src="images/icons/home.png" width="16" height="16"> Home](Home) · [Sidebar ▶](EN-Sidebar-Explorer)
