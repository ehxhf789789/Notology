[◀ Hover Windows](EN-Hover-Windows) · [<img src="images/icons/home.png" width="16" height="16"> Home](Home) · [Editor Basics ▶](EN-Editor-Basics)

---

# <img src="images/icons/file-text.png" width="24" height="24"> Note Management

Learn how to create, open, rename, move, and delete notes.

---

## Creating Notes

There are three ways to create a new note.

| Method | Description |
|--------|------------|
| `Ctrl + N` | The fastest way — use the keyboard shortcut |
| Sidebar **+ button** | Click the + button at the bottom of the sidebar |
| Right-click folder → New Note | Create a note inside a specific folder |

> 📸 **GIF placeholder** — `images/note-create-shortcut.gif`
>
> **Shot**: Creating a new note with the Ctrl+N shortcut
> **Steps**: ① Press Ctrl+N → ② New note dialog appears → ③ Enter a name → ④ Select a template → ⑤ Click OK → ⑥ New note opens in the editor
> **Screen area**: Full app window (focus on dialog)
> **Highlight**: Using the shortcut and the dialog appearing
> **Duration**: 5~8s

> 📸 **GIF placeholder** — `images/note-create-contextmenu.gif`
>
> **Shot**: Creating a new note from a folder's right-click menu
> **Steps**: ① Right-click a folder in the sidebar → ② Select "New Note" → ③ Enter a name → ④ Confirm → ⑤ Note created inside that folder
> **Screen area**: Sidebar area (including context menu)
> **Highlight**: The "New Note" menu item
> **Duration**: 5~8s

---

## Choosing a Template

When creating a note, you can pick a template that matches your purpose. Templates give you a pre-built structure so you can start writing right away.

| Template | What is it? | When to use it |
|----------|------------|----------------|
| **Note** | A blank note | General memos, ideas |
| **Sketch** | An infinite canvas (freeform space) | Diagrams, mind maps |
| **Meeting** | Meeting info/agenda structure | Team meetings |
| **Seminar** | Speaker/topic/summary structure | Seminars, lecture notes |
| **Event** | Date/place/attendees structure | Events, schedules |
| **Official Doc** | Sender/receiver/body structure | Formal documents |
| **Paper** | Abstract/intro/methods/results structure | Academic paper notes |
| **Literature** | Author/publication/citation structure | References, books |
| **Data** | Key-value data structure | Data cards |
| **Theory** | Definition/explanation/example structure | Concept notes, study |
| **Contact** | Name/phone/email structure | People info |
| **Config** | Configuration item structure | Settings, rules |

---

## Opening Notes

Here's how to open a saved note.

| Action | Where does it open? |
|--------|-------------------|
| Click in sidebar | Opens in the main editor |
| Double-click in sidebar | Opens in a hover window |
| Click in search results | Opens in a hover window |
| Click a `[[wikilink]]` | Opens in a hover window |
| Click a calendar memo | Opens in a hover window |

> 📸 **GIF placeholder** — `images/note-open-methods.gif`
>
> **Shot**: Demonstrating multiple ways to open a note, one after another
> **Steps**: ① Click a note in the sidebar (opens in editor) → ② Double-click another note (opens in hover window) → ③ Click a wikilink (opens in hover window)
> **Screen area**: Sidebar + editor + hover window
> **Highlight**: How click vs. double-click opens notes in different locations
> **Duration**: 8~12s

---

## Renaming Notes

When you rename a note, all **wikilinks pointing to it are updated automatically** across the entire Vault. No manual fixing needed!

1. **Right-click** the note in the sidebar
2. Select **Rename**
3. Enter the new name and click **OK**
4. Every `[[old name]]` in your Vault automatically becomes `[[new name]]`

> 📸 **GIF placeholder** — `images/note-rename.gif`
>
> **Shot**: Renaming a note and confirming the automatic wikilink update in another note
> **Steps**: ① Right-click a note in the sidebar → ② Select "Rename" → ③ Enter new name → ④ Confirm → ⑤ Open another note to verify the wikilink has changed
> **Screen area**: Sidebar + editor area
> **Highlight**: Comparing the wikilink before and after the rename
> **Duration**: 5~8s

> **💡 Tip**: If you're syncing via a NAS or cloud drive, renaming may occasionally fail due to file locks. Notology automatically retries up to 3 times, and if it still fails, it reverts to the original name.

---

## Moving Notes

There are two ways to move a note to a different folder.

### Drag and Drop

Grab the note in the sidebar and drag it onto the target folder.

> 📸 **GIF placeholder** — `images/note-move-drag.gif`
>
> **Shot**: Moving a note to another folder via drag and drop
> **Steps**: ① Click and hold the note → ② Drag it over another folder → ③ Folder highlights → ④ Release the mouse → ⑤ Note has moved
> **Screen area**: Sidebar area only
> **Highlight**: The target folder highlighting during the drag
> **Duration**: 3~5s

### Right-Click Menu

1. **Right-click** the note
2. Select **Move**
3. Choose the destination folder

> 📸 **GIF placeholder** — `images/note-move-menu.gif`
>
> **Shot**: Moving a note via the "Move" option in the right-click menu
> **Steps**: ① Right-click the note → ② Select "Move" → ③ Folder selection dialog appears → ④ Choose destination folder → ⑤ Confirm → ⑥ Note moved
> **Screen area**: Sidebar + folder selection dialog
> **Highlight**: The "Move" menu item and the folder selection screen
> **Duration**: 5~8s

---

## Deleting Notes

1. **Right-click** the note in the sidebar
2. Select **Delete**
3. If other notes reference this note via wikilinks, a warning message appears
4. Click **OK** to delete

> 📸 **GIF placeholder** — `images/note-delete.gif`
>
> **Shot**: Deleting a note (including the wikilink warning)
> **Steps**: ① Right-click the note → ② Select "Delete" → ③ Wikilink warning dialog appears → ④ Click OK → ⑤ Note disappears from the sidebar
> **Screen area**: Sidebar + warning dialog
> **Highlight**: The wikilink warning message content
> **Duration**: 5~8s

> **Warning**: Deleted notes are permanently removed — they do not go to a recycle bin. Always double-check before deleting important notes!

---

## Folder Management

| Task | How to do it |
|------|-------------|
| Create a new folder | Right-click a parent folder → **New Folder** |
| Rename a folder | Right-click the folder → **Rename** |
| Delete a folder | Right-click the folder → **Delete** (all files inside are also deleted!) |
| Move a folder | Drag and drop in the sidebar |

> 📸 **GIF placeholder** — `images/folder-create.gif`
>
> **Shot**: Creating a new folder and naming it
> **Steps**: ① Right-click a parent folder → ② Select "New Folder" → ③ Enter folder name → ④ Confirm → ⑤ New folder appears in the tree
> **Screen area**: Sidebar area
> **Highlight**: The newly created folder appearing in the tree
> **Duration**: 3~5s

---

## File Actions

| Task | How to do it |
|------|-------------|
| Copy Path | Right-click a note → **Copy Path** (file location is copied to the clipboard) |
| Open in Explorer | Right-click a note → **Open in Explorer** (opens the file location in Windows File Explorer) |

> 📸 **GIF placeholder** — `images/note-file-actions.gif`
>
> **Shot**: Using "Copy Path" and "Open in Explorer" from a note's right-click menu
> **Steps**: ① Right-click a note → ② Click "Copy Path" → ③ Right-click again → ④ Click "Open in Explorer" → ⑤ Windows File Explorer opens to that folder
> **Screen area**: Sidebar + Windows File Explorer
> **Highlight**: Each menu item click and its result
> **Duration**: 5~8s

---

## Bulk Actions from Search

You can manage multiple notes at once from the [Search](EN-Search) panel.

- **Bulk Delete**: Select multiple notes and delete them all at once
- **Bulk Move**: Select multiple notes and move them to another folder at once
- **Bulk Tag**: Add a tag to multiple notes at once

> 📸 **GIF placeholder** — `images/note-bulk-actions.gif`
>
> **Shot**: Selecting multiple notes in search results and performing a bulk move
> **Steps**: ① Open the search panel → ② Enter a keyword → ③ Check multiple notes with checkboxes → ④ Click the bulk move button → ⑤ Select destination folder → ⑥ Move complete
> **Screen area**: Full search screen
> **Highlight**: Checkbox selections and the bulk action button
> **Duration**: 8~12s

For more details, see the [Search](EN-Search) page.

---

[◀ Hover Windows](EN-Hover-Windows) · [<img src="images/icons/home.png" width="16" height="16"> Home](Home) · [Editor Basics ▶](EN-Editor-Basics)
