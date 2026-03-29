[◀ Editor Basics](EN-Editor-Basics) · [<img src="images/icons/home.png" width="16" height="16"> Home](Home) · [Wikilinks ▶](EN-Wikilinks)

---

# <img src="images/icons/zap.png" width="24" height="24"> Editor Advanced

Learn about code blocks, section folding, attachments, auto-complete, and other advanced features.

---

## Code Blocks

Use code blocks when writing programming code or scripts. Syntax highlighting makes the code easier to read.

### Creating a Code Block

Type ` ``` ` at the beginning of a line, followed immediately by the language name.

````
```javascript
function hello() {
  console.log("Hello, World!");
}
```
````

### Supported Languages

Over 20 programming languages are supported.

| Category | Languages |
|----------|----------|
| Web | JavaScript, TypeScript, HTML, CSS |
| Systems | C, C++, Rust, Go |
| Scripting | Python, Ruby, Shell (Bash) |
| Data | JSON, YAML, XML, SQL |
| Other | Java, C#, PHP, Markdown, LaTeX |

> 📸 **GIF placeholder** — `images/editor-code-block.gif`
>
> **Shot**: Creating a code block and typing code with syntax highlighting
> **Steps**: ① Type ```javascript on a blank line → ② Code block is created → ③ Type code → ④ Syntax highlighting (colors) is applied automatically → ⑤ Change the language to Python
> **Screen area**: Editor body area only
> **Highlight**: Syntax highlight colors appearing and the language selector dropdown
> **Duration**: 5~8s

### Folding / Unfolding Code Blocks

Click the **arrow button** to the left of a code block to collapse or expand it. Hiding long code blocks makes the document easier to read.

> 📸 **GIF placeholder** — `images/editor-code-fold.gif`
>
> **Shot**: Clicking the arrow to fold and unfold a code block
> **Steps**: ① A long code block is visible → ② Click the left arrow → ③ Code block collapses (shrinks to one line) → ④ Click the arrow again → ⑤ Code block expands
> **Screen area**: Editor body area only
> **Highlight**: The arrow button and the collapse animation
> **Duration**: 3~5s

---

## Section Folding (Heading Collapse)

Click the arrow to the left of a heading to hide all content beneath it.

### How Does It Work?

- Click the **arrow** to the left of a heading to collapse it
- Everything up to the next heading of the same or higher level is hidden
- Example: Collapsing `## Chapter 1` hides `### Subsection` but `## Chapter 2` remains visible

### When It's Useful

| Scenario | How to use it |
|----------|--------------|
| Reading a long document | Collapse sections you're not reading; expand only what you need |
| Getting an overview | Collapse all headings to see the structure like a table of contents |
| Focused writing | Expand only the section you're working on; collapse the rest |

> 📸 **GIF placeholder** — `images/editor-section-fold.gif`
>
> **Shot**: Folding and unfolding headings in a long document to navigate sections
> **Steps**: ① Long document with 3 H2 headings visible → ② Click the first H2 arrow → ③ That section collapses → ④ Collapse the second H2 as well → ⑤ Only headings visible (like a table of contents) → ⑥ Expand the third H2
> **Screen area**: Editor body area only
> **Highlight**: Document length shrinking/expanding as sections are folded/unfolded
> **Duration**: 5~8s

---

## Attachments

You can attach files to your notes. Attached files are automatically organized under an **Attachments** section.

### How to Attach Files

| Method | Description |
|--------|------------|
| Drag and drop | Drag a file into the editor |
| Type `//` | Type `//` in the editor to bring up a file selection list |

> 📸 **GIF placeholder** — `images/editor-attach-drag.gif`
>
> **Shot**: Dragging and dropping a file into the editor to attach it
> **Steps**: ① Select a file in Windows File Explorer → ② Drag it into the editor → ③ Drop → ④ File is automatically added to the "Attachments" section
> **Screen area**: Editor area (with part of Windows File Explorer)
> **Highlight**: The item appearing in the Attachments section
> **Duration**: 5~8s

> 📸 **GIF placeholder** — `images/editor-attach-trigger.gif`
>
> **Shot**: Typing // in the editor to bring up the file picker
> **Steps**: ① Type "//" in the editor → ② File selection dropdown appears → ③ Select a file from the list → ④ File is added to the Attachments section
> **Screen area**: Editor body area (including dropdown)
> **Highlight**: The file selection list appearing when // is typed
> **Duration**: 3~5s

### Attachments Section

- When you attach a file for the first time, an **Attachments** section is automatically created at the bottom of the note
- If the section already exists, new items are added below the existing list
- Attachments are organized as a bullet list

---

## Inline Suggestions (Auto-Complete)

Typing certain trigger characters brings up an auto-complete list.

| Type this | What appears |
|-----------|-------------|
| `[[` | List of notes in your Vault (to create a wikilink) |
| `@` | Note mention list |
| `//` | List of files in your Vault (to insert an attachment) |

- Use the arrow keys (Up/Down) to select, then press `Enter` to confirm
- Keep typing to narrow the list

> 📸 **GIF placeholder** — `images/editor-suggestions.gif`
>
> **Shot**: Typing [[, @, and // to trigger auto-complete lists
> **Steps**: ① Type "[[" → ② Note list appears → ③ Select a note → ④ Wikilink is completed → ⑤ On a new line, type "@" → ⑥ Mention list appears → ⑦ Select
> **Screen area**: Editor body area (including auto-complete dropdown)
> **Highlight**: The dropdown appearing the moment each trigger character is typed
> **Duration**: 8~12s

---

## Editor Zoom

Make the text larger or smaller.

| Action | How |
|--------|-----|
| Zoom in (larger) | `Ctrl` + mouse wheel up |
| Zoom out (smaller) | `Ctrl` + mouse wheel down |
| Range | 50% – 200% |

> 📸 **GIF placeholder** — `images/editor-zoom.gif`
>
> **Shot**: Using Ctrl+mouse wheel to zoom the editor in and out
> **Steps**: ① Default size (100%) → ② Ctrl+wheel up (zoom in) → ③ Text gets larger → ④ Ctrl+wheel down (zoom out) → ⑤ Text gets smaller
> **Screen area**: Editor body area only
> **Highlight**: The text size changing
> **Duration**: 3~5s

---

## YAML Front Matter

At the very top of a note, you can record metadata between `---` markers.

```yaml
---
type: Note
tags: [project, idea]
created: 2024-01-15
---
```

| Field | Meaning |
|-------|---------|
| `type` | The note's template type |
| `tags` | Tag list (useful for searching) |
| `created` | Creation date |

Front matter is displayed as a gray area in the editor and is used for search and filtering.

---

## Inline Memos (Comments)

You can attach memos to any piece of text. Memos you add can be viewed by date in the calendar on the right panel.

### How to Add a Memo

1. Drag to select the text you want to annotate
2. Right-click → select **Add Memo**
3. Enter the memo content and a date

> 📸 **GIF placeholder** — `images/editor-comment-add.gif`
>
> **Shot**: Selecting text and adding a memo via right-click
> **Steps**: ① Drag to select text → ② Right-click → ③ Select "Add Memo" → ④ Enter memo content → ⑤ Select a date → ⑥ Confirm → ⑦ Text becomes highlighted
> **Screen area**: Editor body area (context menu + memo dialog)
> **Highlight**: The "Add Memo" menu item and the highlighted text after adding
> **Duration**: 5~8s

### Viewing Memos in the Calendar

- Annotated text is highlighted
- View all memos by date in the **Calendar** on the right panel
- Click a memo in the calendar to jump to its location in the note

> 📸 **GIF placeholder** — `images/editor-comment-calendar.gif`
>
> **Shot**: Viewing memos in the right panel calendar and clicking one to navigate to the note
> **Steps**: ① View the calendar in the right panel → ② Click a date that has memos → ③ Memo list appears → ④ Click a memo item → ⑤ Jumps to the memo's location in the note
> **Screen area**: Right panel + editor area
> **Highlight**: The calendar memo markers and the navigation on click
> **Duration**: 5~8s

---

## Auto-Update Notifications

When a new version of Notology is released, a notification appears inside the app. Click the notification to download the latest version.

> 📸 **GIF placeholder** — `images/auto-update.gif`
>
> **Shot**: An update notification appearing and being clicked
> **Steps**: ① Using the app when an update notification banner appears → ② Click the notification → ③ Download/update begins
> **Screen area**: Full app window (focus on the notification banner)
> **Highlight**: The update notification banner
> **Duration**: 3~5s

---

[◀ Editor Basics](EN-Editor-Basics) · [<img src="images/icons/home.png" width="16" height="16"> Home](Home) · [Wikilinks ▶](EN-Wikilinks)
