[◀ Note Management](EN-Note-Management) · [<img src="images/icons/home.png" width="16" height="16"> Home](Home) · [Editor Advanced ▶](EN-Editor-Advanced)

---

# <img src="images/icons/type.png" width="24" height="24"> Editor Basics

Learn about the editor's core features: text formatting, headings, lists, tables, images, and more.

---

## Toolbar

The row of buttons at the top of the editor. Click a button to apply formatting instantly. Keyboard shortcuts make it even faster.

> 📸 **GIF placeholder** — `images/editor-toolbar.gif`
>
> **Shot**: Hovering over each button area in the toolbar from left to right
> **Steps**: ① Move the mouse from left to right across the toolbar → ② Text formatting buttons → ③ Heading dropdown → ④ List buttons → ⑤ Insert buttons (table, image, etc.)
> **Screen area**: Editor toolbar area only
> **Highlight**: Tooltips appearing as the mouse passes over each button
> **Duration**: 5~8s

---

## Text Formatting

Style your text by selecting it first, then clicking a button or using a keyboard shortcut.

| Style | Shortcut | Markdown Input | Result |
|-------|----------|---------------|--------|
| **Bold** | `Ctrl + B` | `**text**` | **text** |
| *Italic* | `Ctrl + I` | `*text*` | *text* |
| <u>Underline</u> | `Ctrl + U` | — | Underlined text |
| ~~Strikethrough~~ | `Ctrl + Shift + X` | `~~text~~` | ~~text~~ |
| `Inline code` | `Ctrl + E` | `` `text` `` | `text` |
| Highlight | Select from toolbar | — | Highlighted text |
| Superscript | Select from toolbar | — | text^super^ |
| Subscript | Select from toolbar | — | text~sub~ |

> 📸 **GIF placeholder** — `images/editor-text-formatting.gif`
>
> **Shot**: Selecting text and applying various formatting styles
> **Steps**: ① Type some text → ② Drag to select → ③ Press Ctrl+B for bold → ④ Select other text → ⑤ Press Ctrl+I for italic → ⑥ Click the highlight button
> **Screen area**: Editor body area (with part of the toolbar)
> **Highlight**: The text changing as each style is applied
> **Duration**: 5~8s

---

## Headings (H1 – H6)

There are 6 heading levels. The more `#` symbols you use, the smaller the heading.

| Input | Result | When to use |
|-------|--------|-------------|
| `# Heading` | Heading 1 (largest) | Document title |
| `## Heading` | Heading 2 | Major sections |
| `### Heading` | Heading 3 | Sub-sections |
| `#### Heading` | Heading 4 | Minor sections |
| `##### Heading` | Heading 5 | Detailed items |
| `###### Heading` | Heading 6 (smallest) | Lowest-level items |

> 📸 **GIF placeholder** — `images/editor-headings.gif`
>
> **Shot**: Typing # symbols to create H1–H3 headings
> **Steps**: ① Type "# Big Heading" → ② Press Enter → ③ Type "## Medium Heading" → ④ Press Enter → ⑤ Type "### Small Heading" → ⑥ Compare the heading sizes
> **Screen area**: Editor body area only
> **Highlight**: Headings formatting instantly as you type the # symbol
> **Duration**: 5~8s

### Folding / Unfolding Headings

Click the **arrow button** to the left of a heading to collapse or expand the content beneath it.

- Collapsing hides everything until the next heading of the same level
- Great for reading only the sections you need in a long document

> 📸 **GIF placeholder** — `images/editor-heading-fold.gif`
>
> **Shot**: Clicking the arrow next to a heading to fold and unfold a section
> **Steps**: ① Multiple headings visible in a long document → ② Click the first heading's arrow → ③ Content collapses → ④ Click the arrow again → ⑤ Content expands
> **Screen area**: Editor body area only
> **Highlight**: The arrow button click and the fold/unfold animation
> **Duration**: 3~5s

---

## Lists

### Bullet List

Type `-` followed by a space at the beginning of a line to create a bullet list.

```
- First item
- Second item
  - Sub-item (indent with Tab)
```

### Numbered List

Type `1.` followed by a space at the beginning of a line to create a numbered list.

```
1. First step
2. Second step
3. Third step
```

### Checklist

Type `- [ ]` at the beginning of a line to create a checklist. Click the checkbox to mark items as done.

```
- [ ] Task to do
- [x] Completed task
```

### Indentation

| Shortcut | What it does |
|----------|-------------|
| `Tab` | Indent the list item one level deeper |
| `Shift + Tab` | Outdent the list item one level |

> 📸 **GIF placeholder** — `images/editor-lists.gif`
>
> **Shot**: Creating bullet lists, numbered lists, and checklists one after another
> **Steps**: ① Type "- " to create a bullet list → ② Press Tab for a sub-item → ③ Type "1. " to create a numbered list → ④ Type "- [ ]" to create a checklist → ⑤ Click a checkbox
> **Screen area**: Editor body area only
> **Highlight**: Markdown input converting to lists in real time
> **Duration**: 8~12s

---

## Block Quotes

Type `>` followed by a space at the beginning of a line to create a block quote.

```
> This is a block quote.
> It can span multiple lines.
```

> 📸 **GIF placeholder** — `images/editor-blockquote.gif`
>
> **Shot**: Typing > to create a block quote
> **Steps**: ① Type "> " → ② Block quote styling is applied → ③ Type text → ④ Press Enter to continue on the next line
> **Screen area**: Editor body area only
> **Highlight**: The block quote style appearing the moment > is typed
> **Duration**: 3~5s

---

## Tables

### Creating a Table

Click the **Table button** in the toolbar and select the number of rows and columns you want.

### Editing a Table

| Task | How to do it |
|------|-------------|
| Add a row | Right-click inside the table → Add row (above/below) |
| Delete a row | Right-click inside the table → Delete row |
| Add a column | Right-click inside the table → Add column (left/right) |
| Delete a column | Right-click inside the table → Delete column |
| Cell background color | Select a cell and right-click → Choose a background color |
| Merge cells | Select multiple cells and right-click → Merge cells |

> 📸 **GIF placeholder** — `images/editor-table.gif`
>
> **Shot**: Inserting a table, adding rows/columns, and changing cell background colors
> **Steps**: ① Click the table button in the toolbar → ② Select a 3x3 grid → ③ Table is created → ④ Type text in cells → ⑤ Right-click to add a row → ⑥ Change a cell's background color
> **Screen area**: Editor toolbar + body area
> **Highlight**: The table grid selector and the right-click menu
> **Duration**: 8~12s

---

## Images

Here's how to add images to your notes.

| Method | Description |
|--------|------------|
| Drag and drop | Drag an image file into the editor |
| Paste | Take a screenshot, then press `Ctrl + V` to paste |
| Toolbar | Click the image button and select a file |

> 📸 **GIF placeholder** — `images/editor-image-insert.gif`
>
> **Shot**: Dragging and dropping an image into the editor
> **Steps**: ① Select an image file in Windows File Explorer → ② Drag it into the editor → ③ Image is inserted into the note → ④ Check the inserted image size
> **Screen area**: Editor area (with part of Windows File Explorer)
> **Highlight**: The moment the image is inserted into the editor
> **Duration**: 3~5s

---

## Horizontal Rule

Type `---` to insert a horizontal divider line.

- Hover over the rule to reveal a **delete button**
- Click the delete button to remove the horizontal rule

> 📸 **GIF placeholder** — `images/editor-hr.gif`
>
> **Shot**: Typing --- to create a horizontal rule, then hovering to show the delete button
> **Steps**: ① Type "---" → ② Converts to a horizontal rule → ③ Hover the mouse over the rule → ④ Delete button appears → ⑤ Click the delete button → ⑥ Rule disappears
> **Screen area**: Editor body area only
> **Highlight**: The delete button appearing on hover
> **Duration**: 3~5s

---

## Text Alignment

Align text to the left, center, right, or justify.

| Alignment | Description |
|-----------|------------|
| Left | Default — text aligns to the left edge |
| Center | Text is centered |
| Right | Text aligns to the right edge |
| Justify | Text is stretched to fill both edges evenly |

> 📸 **GIF placeholder** — `images/editor-alignment.gif`
>
> **Shot**: Changing text alignment from left to center to right
> **Steps**: ① Type text (left-aligned by default) → ② Click the center alignment button → ③ Text moves to center → ④ Click the right alignment button → ⑤ Text moves to the right
> **Screen area**: Editor toolbar + body area
> **Highlight**: Text position changing with each alignment button click
> **Duration**: 3~5s

---

## Callouts

Colored boxes for highlighting important information. Click the **Callout button** in the toolbar to insert one.

| Type | Color | When to use |
|------|-------|-------------|
| **Info** | Blue | Reference information, explanations |
| **Warning** | Yellow | Cautions, warnings |
| **Error** | Red | Danger, prohibited actions |
| **Success** | Green | Success, completion |
| **Note** | Gray | General memos |
| **Tip** | Purple | Tips, tricks |

> 📸 **GIF placeholder** — `images/editor-callout.gif`
>
> **Shot**: Inserting a callout and switching its type
> **Steps**: ① Click the callout button in the toolbar → ② Select a callout type (e.g., Info) → ③ Blue callout box appears → ④ Type text inside → ⑤ Change the type to Warning → ⑥ Color changes to yellow
> **Screen area**: Editor toolbar + body area
> **Highlight**: The color difference between each callout type
> **Duration**: 5~8s

---

## Link Cards

Paste a URL and it automatically becomes a beautiful preview card. The card shows the website's title, description, and image.

> 📸 **GIF placeholder** — `images/editor-link-card.gif`
>
> **Shot**: Pasting a URL that auto-generates a link preview card
> **Steps**: ① Paste a URL (Ctrl+V) → ② Brief loading → ③ Converts into a preview card (showing title, description, and image)
> **Screen area**: Editor body area only
> **Highlight**: The moment the URL transforms into a card
> **Duration**: 3~5s

---

## Auto-Save

Your note is **automatically saved 1 second** after you stop typing.

- No need to press a save button
- You can change the auto-save interval in settings
- A status indicator appears while saving

---

## Right-Click Menu (Context Menu)

Right-click inside the editor to get a menu tailored to the current context.

- **With text selected**: Change formatting, copy, paste, add a memo
- **Inside a table**: Add/delete rows and columns, cell background color, merge cells
- **On an image**: Resize, change alignment
- **On a link**: Open link, edit, delete

> 📸 **GIF placeholder** — `images/editor-context-menu.gif`
>
> **Shot**: Selecting text in the editor, then right-clicking to use the context menu
> **Steps**: ① Select text → ② Right-click → ③ Context menu appears → ④ Select "Bold" → ⑤ Formatting applied → ⑥ Right-click inside a table cell → ⑦ Table-specific menu appears
> **Screen area**: Editor body area (including context menu)
> **Highlight**: Different menus appearing based on context
> **Duration**: 5~8s

---

[◀ Note Management](EN-Note-Management) · [<img src="images/icons/home.png" width="16" height="16"> Home](Home) · [Editor Advanced ▶](EN-Editor-Advanced)
