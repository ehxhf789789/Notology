[◀ Sidebar](EN-Sidebar-Explorer) · [<img src="images/icons/home.png" width="16" height="16"> Home](Home) · [Note Management ▶](EN-Note-Management)

---

# <img src="images/icons/app-window.png" width="24" height="24"> Hover Windows

Hover windows are small floating windows that appear on top of the main editor. They let you reference other notes while you keep writing.

---

## Core Concept

A **hover window** is a separate floating window that sits on top of the main editor. Think of it as placing a sticky note on top of your open book for quick reference.

- View other notes while writing in the main editor
- Open multiple hover windows at the same time
- View Markdown notes, PDFs, images, and Office documents

> 📸 **GIF placeholder** — `images/hover-window-concept.gif`
>
> **Shot**: Basic appearance of a hover window floating above the main editor
> **Steps**: ① A note is open in the main editor → ② A hover window floats on top → ③ Click the main editor to write → ④ Click the hover window to read its content
> **Screen area**: Full app window
> **Highlight**: The main editor and hover window visible at the same time
> **Duration**: 5~8s

---

## Opening a Hover Window

There are several ways to open a hover window.

| Action | Opens a hover window |
|--------|---------------------|
| Click a `[[wikilink]]` | Click a wikilink inside a note |
| Double-click in sidebar | Double-click a note in the file explorer |
| Click a search result | Click an item in the search results |
| Click a calendar memo | Click a memo from the calendar in the right panel |
| Right-click → "Open in Hover" | Right-click a note in the sidebar and select this option |

> 📸 **GIF placeholder** — `images/hover-open-wikilink.gif`
>
> **Shot**: Clicking a wikilink inside the editor to open a hover window
> **Steps**: ① A [[note name]] wikilink is visible in the editor → ② Click the wikilink → ③ A hover window opens showing the linked note's content
> **Screen area**: Editor area + hover window
> **Highlight**: The moment the wikilink is clicked and the hover window appears
> **Duration**: 3~5s

> 📸 **GIF placeholder** — `images/hover-open-methods.gif`
>
> **Shot**: Opening hover windows via sidebar double-click and right-click menu
> **Steps**: ① Double-click a note in the sidebar → ② Hover window opens → ③ Close it → ④ Right-click a note → ⑤ Select "Open in Hover" → ⑥ Hover window opens
> **Screen area**: Sidebar + editor area
> **Highlight**: The double-click action and the "Open in Hover" menu item
> **Duration**: 5~8s

---

## Window Controls

### Moving

Grab the hover window's title bar with your mouse and drag it to move it wherever you like.

> 📸 **GIF placeholder** — `images/hover-move.gif`
>
> **Shot**: Dragging the hover window's title bar to reposition it
> **Steps**: ① Hover window is in the center of the screen → ② Start dragging the title bar → ③ Move it to the left → ④ Move it to the lower right → ⑤ Release the mouse
> **Screen area**: Full app window
> **Highlight**: The mouse cursor grabbing the title bar
> **Duration**: 3~5s

### Resizing

Grab a corner or edge of the window and drag to change its size.

### Size Presets

Quickly switch to a predefined size.

| Preset | Size (W x H) | Best for |
|--------|--------------|----------|
| **Small** | 600 x 500 | Quick memo checks |
| **Medium** | 800 x 600 | Reading a typical note |
| **Large** | 1000 x 800 | Editing a long document |
| **Wide** | 1200 x 700 | Notes with tables or code |

> 📸 **GIF placeholder** — `images/hover-resize.gif`
>
> **Shot**: Resizing a hover window by dragging its corner, then switching sizes via preset buttons
> **Steps**: ① Drag a corner to resize → ② Click the preset button → ③ Select "Small" → ④ Click the preset button again → ⑤ Select "Large"
> **Screen area**: Hover window centered (full app window)
> **Highlight**: The size-change animation
> **Duration**: 5~8s

---

## Managing Multiple Windows

### Opening Multiple Notes at Once

You can open several hover windows at the same time. Each window can be moved and resized independently.

> 📸 **GIF placeholder** — `images/hover-multiple.gif`
>
> **Shot**: Opening 2–3 hover windows simultaneously and arranging them on screen
> **Steps**: ① Open the first hover window → ② Open the second hover window → ③ Move each to a different position → ④ Open the third hover window
> **Screen area**: Full app window
> **Highlight**: Multiple windows floating at the same time
> **Duration**: 5~8s

### Minimizing

When you minimize a hover window, it shrinks to a small button on the right side of the screen. Click that button to restore it.

- Keep several windows open and pull them up only when needed
- Minimized buttons display the note name

> 📸 **GIF placeholder** — `images/hover-minimize.gif`
>
> **Shot**: Minimizing a hover window and restoring it
> **Steps**: ① Hover window is open → ② Click the minimize button → ③ Window shrinks to a small button on the right → ④ Click the small button → ⑤ Hover window restores
> **Screen area**: Full app window (including the right-side minimize bar)
> **Highlight**: The minimize button and the small restore button on the right
> **Duration**: 3~5s

> 📸 **GIF placeholder** — `images/hover-collapsed-bar.gif`
>
> **Shot**: Multiple hover windows minimized, then restoring them one by one
> **Steps**: ① 3+ hover windows are all minimized → ② Several buttons lined up on the right → ③ Click one to restore → ④ Click another to restore
> **Screen area**: Full app window (focus on the right-side minimize bar)
> **Highlight**: Note names displayed on the minimized buttons
> **Duration**: 5~8s

---

## File Type Viewers

The hover window automatically chooses the right viewer based on the file type.

| File Type | Extensions | How it's displayed |
|-----------|-----------|-------------------|
| **Markdown notes** | `.md` | Opens in an editable editor |
| **PDF** | `.pdf` | Opens in a PDF viewer |
| **Images** | `.png`, `.jpg`, `.gif`, etc. | Opens in an image viewer |
| **Office documents** | `.docx`, `.xlsx`, `.pptx`, `.hwpx` | Opens in a document preview (requires LibreOffice) |
| **Code files** | `.js`, `.py`, `.rs`, etc. | Opens in a syntax-highlighted viewer |

> 📸 **GIF placeholder** — `images/hover-file-types.gif`
>
> **Shot**: Opening several different file types in hover windows one after another
> **Steps**: ① Open a .md note (editable) → ② Open a .pdf file (PDF viewer) → ③ Open a .png image (image viewer) → ④ Open a .docx file (document preview)
> **Screen area**: Full app window (focus on the hover window)
> **Highlight**: Different viewers appearing for each file type
> **Duration**: 8~12s

> **💡 Note**: To preview Office documents (.docx, etc.), LibreOffice must be installed on your computer. If it's not installed, you can use the "Open in App" button to open the file in its default program (e.g., Word, Excel).

---

## Caching

The content of the **10 most recently opened** hover windows is stored in memory (cached).

- Reopening the same note shows it instantly (no waiting)
- The cache is cleared when you close the app

---

## Usage Tips

### Writing While Referencing

Keep a hover window open for reference material while you write in the main editor.

1. Open the note you're working on in the main editor
2. **Double-click** a reference note in the sidebar to open it in a hover window
3. Position the hover window to one side of the screen
4. Read from the hover window while writing in the main editor

### Comparing Notes

Place two hover windows side by side to compare notes.

> 📸 **GIF placeholder** — `images/hover-workflow-tips.gif`
>
> **Shot**: A real workflow — writing in the main editor while referencing a hover window
> **Steps**: ① A note is being written in the main editor → ② Double-click a reference note in the sidebar → ③ Hover window opens → ④ Move the hover window to the right → ⑤ Type in the main editor while reading the hover window
> **Screen area**: Full app window
> **Highlight**: Switching back and forth between the main editor and the hover window
> **Duration**: 8~12s

---

[◀ Sidebar](EN-Sidebar-Explorer) · [<img src="images/icons/home.png" width="16" height="16"> Home](Home) · [Note Management ▶](EN-Note-Management)
