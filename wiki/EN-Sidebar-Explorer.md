[◀ Interface](EN-Interface-Overview) · [<img src="images/icons/home.png" width="16" height="16"> Home](Home) · [Hover Windows ▶](EN-Hover-Windows)

---

# <img src="images/icons/panel-left.png" width="24" height="24"> Sidebar & Explorer

Learn how to browse, find, and manage your notes and folders in the sidebar.

---

## Sidebar Overview

> 📸 **GIF placeholder** — `images/sidebar-overview.png`
>
> **Shot**: Full sidebar capture — Vault selector, file explorer, and bottom buttons all visible
> **Steps**: Sidebar showing Vault name at the top, folder/note tree in the middle, +/search/settings buttons at the bottom
> **Screen area**: Sidebar area only
> **Highlight**: Clear view of all sidebar elements
> **Duration**: Screenshot (static)

---

## Vault Selector

Located at the very top of the sidebar, the Vault selector shows the name of the Vault you're currently using.

- Click it to see a list of all Vaults you've registered
- Select a different Vault to switch to its files
- You can add new Vaults or remove ones you no longer use

> 📸 **GIF placeholder** — `images/sidebar-vault-switch.gif`
>
> **Shot**: Clicking the Vault selector to switch to a different Vault
> **Steps**: ① Click the Vault name at the top of the sidebar → ② Dropdown list appears → ③ Select a different Vault → ④ File explorer updates to show the new Vault's contents
> **Screen area**: Sidebar area (including the dropdown)
> **Highlight**: Clicking the Vault name and the file list changing after the switch
> **Duration**: 3~5s

---

## File Explorer

Displays your folders and notes in a tree structure, similar to Windows File Explorer.

### Basic Actions

| Action | What happens |
|--------|-------------|
| Click a folder | The folder expands or collapses (toggle) |
| Click a note | The note opens in the main editor |
| Double-click a note | The note opens in a hover window (floating window) |

> 📸 **GIF placeholder** — `images/sidebar-tree-navigate.gif`
>
> **Shot**: Expanding and collapsing folders while browsing notes
> **Steps**: ① Click a folder arrow → ② Folder expands → ③ Click a note → ④ Content appears in the editor → ⑤ Collapse another folder
> **Screen area**: Sidebar + editor area
> **Highlight**: Folder expand animation and the editor changing when a note is clicked
> **Duration**: 5~8s

### Note Right-Click Menu

Right-click on a note to access a variety of actions.

| Menu Item | What it does |
|-----------|-------------|
| Open | Opens the note in the main editor |
| Open in Hover | Opens the note in a hover window (floating window) |
| Rename | Renames the note (wikilinks in other notes update automatically) |
| Move | Moves the note to a different folder |
| Delete | Deletes the note (warns if other notes reference it via wikilinks) |
| Copy Path | Copies the file path to the clipboard |
| Open in Explorer | Opens the file location in Windows File Explorer |

> 📸 **GIF placeholder** — `images/sidebar-note-contextmenu.gif`
>
> **Shot**: Right-clicking a note in the sidebar and using the context menu
> **Steps**: ① Right-click on a note → ② Context menu appears → ③ Select "Rename" → ④ Enter new name → ⑤ Confirm
> **Screen area**: Sidebar area (including the context menu)
> **Highlight**: All menu items clearly visible
> **Duration**: 5~8s

### Folder Right-Click Menu

| Menu Item | What it does |
|-----------|-------------|
| New Note | Creates a new note inside this folder |
| New Folder | Creates a new sub-folder inside this folder |
| Rename | Renames the folder |
| Delete | Deletes the folder and all files inside it |

> 📸 **GIF placeholder** — `images/sidebar-folder-contextmenu.gif`
>
> **Shot**: Right-clicking a folder and using the context menu
> **Steps**: ① Right-click on a folder → ② Context menu appears → ③ Select "New Note" → ④ Enter note name → ⑤ Note created
> **Screen area**: Sidebar area (including the context menu)
> **Highlight**: Folder right-click menu items
> **Duration**: 5~8s

---

## Drag and Drop

### Internal Move (Within the Sidebar)

Drag a note or folder with the mouse and drop it onto another folder to move it there.

- Drag a note onto a folder to move it inside
- Drag a folder onto another folder to make it a sub-folder

> 📸 **GIF placeholder** — `images/sidebar-drag-note.gif`
>
> **Shot**: Dragging a note to a different folder in the sidebar
> **Steps**: ① Click and hold a note → ② Drag it over another folder → ③ The folder highlights → ④ Release the mouse → ⑤ The note moves into that folder
> **Screen area**: Sidebar area only
> **Highlight**: The target folder highlighting during the drag
> **Duration**: 3~5s

### Importing External Files

Drag files from Windows File Explorer into the Notology sidebar to copy them into your Vault.

- You can import images, PDFs, Office documents, and more
- Imported files are copied into the folder where you drop them

> 📸 **GIF placeholder** — `images/sidebar-drag-external.gif`
>
> **Shot**: Dragging a file from Windows File Explorer into the sidebar
> **Steps**: ① Select a file in Windows File Explorer → ② Drag it onto the Notology sidebar → ③ Drop zone highlights → ④ Release the mouse → ⑤ File appears in the Vault
> **Screen area**: Windows File Explorer + Notology sidebar (side by side)
> **Highlight**: The moment the file is added to the sidebar
> **Duration**: 5~8s

---

## Container Types

Notology has two types of containers.

### Standard

- You can freely create folders (including nested folders)
- Ideal for general note organization

> 📸 **GIF placeholder** — `images/container-standard.png`
>
> **Shot**: A Standard container — multi-level nested folder tree structure
> **Steps**: Tree structure with folders, sub-folders, and notes visible
> **Screen area**: Sidebar area only
> **Highlight**: Nested folder hierarchy
> **Duration**: Screenshot (static)

### Storage

- Stores notes using a single template in a uniform format
- Managed in a flat structure with no folders
- Great for things like contact lists, meeting logs, or data cards

> 📸 **GIF placeholder** — `images/container-storage.png`
>
> **Shot**: A Storage container — flat list of notes with no folders
> **Steps**: Notes created from the same template listed without any folder hierarchy
> **Screen area**: Sidebar area only
> **Highlight**: Flat note list structure
> **Duration**: Screenshot (static)

### Creating a Container

1. Click the **Add Container button** in the sidebar
2. Choose either **Standard** or **Storage**
3. Enter a container name
4. If you chose Storage, also select a template to use

> 📸 **GIF placeholder** — `images/sidebar-container-create.gif`
>
> **Shot**: Creating a new container from the sidebar
> **Steps**: ① Click the add container button → ② Choose type (Standard/Storage) → ③ Enter name → ④ (For Storage) Select template → ⑤ Confirm → ⑥ New container appears in the sidebar
> **Screen area**: Sidebar area + dialog
> **Highlight**: The type selection screen and the sidebar updating after creation
> **Duration**: 5~8s

---

## Toggling the Sidebar

Press `Ctrl + Left Arrow` to open or close the sidebar. Closing the sidebar gives you a wider editor area for focused writing.

> 📸 **GIF placeholder** — `images/sidebar-toggle.gif`
>
> **Shot**: Toggling the sidebar with Ctrl+Left Arrow
> **Steps**: ① Sidebar is open → ② Press Ctrl+Left Arrow → ③ Sidebar closes → ④ Press Ctrl+Left Arrow again → ⑤ Sidebar reopens
> **Screen area**: Full app window (sidebar + editor)
> **Highlight**: The editor width changing as the sidebar opens and closes
> **Duration**: 3~5s

---

## Bottom Buttons

Three buttons at the very bottom of the sidebar.

| Button | Shortcut | What it does |
|--------|----------|-------------|
| **+ (New Note)** | `Ctrl + N` | Creates a new note |
| **Search** | `Ctrl + Shift + F` | Opens the full search panel |
| **Settings** | — | Opens the app settings |

> 📸 **GIF placeholder** — `images/sidebar-bottom-buttons.gif`
>
> **Shot**: Clicking the +, search, and settings buttons one after another
> **Steps**: ① Click the + button → ② New note dialog appears → ③ Cancel → ④ Click the search button → ⑤ Search panel opens → ⑥ Close → ⑦ Click the settings button → ⑧ Settings screen opens
> **Screen area**: Sidebar bottom + each feature's screen
> **Highlight**: The location of each button and what appears when clicked
> **Duration**: 8~12s

---

[◀ Interface](EN-Interface-Overview) · [<img src="images/icons/home.png" width="16" height="16"> Home](Home) · [Hover Windows ▶](EN-Hover-Windows)
