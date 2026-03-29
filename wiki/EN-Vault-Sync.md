[◀ Keyboard Shortcuts](EN-Keyboard-Shortcuts) · [<img src="images/icons/home.png" width="16" height="16"> Home](Home) · [Tips & Tricks ▶](EN-Tips-Tricks)

---

# <img src="images/icons/hard-drive.png" width="24" height="24"> Vault & Sync

A vault is the folder where your notes are stored. You can create multiple vaults for different purposes and sync them through a NAS or cloud drive to use across multiple devices.

---

## Vault Concept

A **vault** is a note folder managed by Notology.

| Feature | Description |
|---------|-------------|
| **Regular folder** | A vault is just a regular Windows folder. You can access it directly from File Explorer |
| **Markdown files** | All notes are saved as `.md` (markdown) files |
| **Folder structure** | You can freely create folders inside a vault to organize your notes |
| **Multiple vaults** | Create separate vaults for different purposes |
| **Compatibility** | Since notes are markdown files, they can be opened with any text editor |

---

## Vault Management

### Opening a New Vault

1. Click the **vault name** at the top of the sidebar
2. Select **Open new vault**
3. Choose the folder you want

> 📸 **GIF placeholder** — `images/vault-open-new.gif`
>
> **Shot**: Clicking the vault name at the top of the sidebar and opening a new vault
> **Steps**: ① Click the vault name at the top of the sidebar → ② Select "Open new vault" from the dropdown menu → ③ Folder selection dialog appears → ④ Select the desired folder → ⑤ The new vault loads
> **Screen area**: Full screen (sidebar top click → dropdown → folder selection dialog)
> **Highlight**: The vault name click area at the top of the sidebar, the "Open new vault" menu item
> **Duration**: 5~8s

### Switching Between Recent Vaults

1. Click the **vault name** at the top of the sidebar
2. Select the vault you want from the **recent vault list**

> 📸 **GIF placeholder** — `images/vault-switch.gif`
>
> **Shot**: Switching to another vault via the recent vault list in the sidebar
> **Steps**: ① Click the vault name at the top of the sidebar → ② View the recent vault list in the dropdown → ③ Click a different vault name → ④ The vault switches and the sidebar file tree updates
> **Screen area**: Full screen (sidebar top dropdown + file tree change after vault switch)
> **Highlight**: The items in the recent vault list, the moment the sidebar file tree changes after switching
> **Duration**: 5~8s

### Vault Usage Examples

| Vault | Purpose | Contents |
|-------|---------|----------|
| **Work** | Work-related | Meeting notes, projects, reports, colleague info |
| **Personal** | Personal life | Journal, hobbies, reading notes, ideas |
| **Research** | Study/research | Paper summaries, experiment logs, lecture notes |

> **💡 Tip**: If you want to separate work and personal notes, consider using different vaults. You can also simply organize them into folders within a single vault.

---

## Vault Locking

Notology provides a **locking system** to ensure only one device uses a vault at a time.

| Situation | Behavior |
|-----------|----------|
| **Opening a vault** | A lock is automatically set |
| **Closing the app** | The lock is automatically released |
| **Trying to open from another device** | A warning message is displayed |
| **Force open** | After acknowledging the warning, you can force-open the vault |

> 📸 **GIF placeholder** — `images/vault-lock-warning.gif`
>
> **Shot**: The lock warning message that appears when trying to open a vault already in use on another device
> **Steps**: ① Attempt to open an already-locked vault → ② A lock warning dialog appears → ③ Read the warning message (shows which device is using the vault) → ④ "Force open" or "Cancel" button
> **Screen area**: Full screen (warning dialog displayed in the center)
> **Highlight**: The warning message text and the "Force open" button
> **Duration**: 3~5s

> **Warning**: Editing the same vault simultaneously on two devices can cause file conflicts. Always finish working on one device before opening the vault on another.

---

## NAS / Cloud Drive Sync

Using a NAS sync client or a cloud drive (OneDrive, Google Drive, etc.), you can synchronize your notes across multiple PCs.

### Setup

| Step | Description |
|------|-------------|
| 1 | Install a NAS sync client or cloud drive app on your PC |
| 2 | Configure the **sync folder** in the sync app |
| 3 | In Notology, **open that sync folder as a vault** |

Once set up, any notes you edit on your PC are automatically uploaded to the NAS or cloud, and other PCs can pull the latest content.

### Compatible Sync Tools

| Type | Examples |
|------|----------|
| **NAS** | Sync client provided by your NAS manufacturer |
| **Cloud** | OneDrive, Google Drive, Dropbox, iCloud, etc. |
| **External drive** | USB, external SSD, etc. (manual copy) |

> 📸 **GIF placeholder** — `images/vault-sync-setup.gif`
>
> **Shot**: Setting a sync folder as a Notology vault
> **Steps**: ① Check the sync folder location in the sync app → ② Select "Open new vault" in Notology → ③ Choose the sync folder as the vault → ④ The vault loads and sync status is confirmed
> **Screen area**: Full screen (selecting the vault folder in the Notology app)
> **Highlight**: The moment the sync folder is selected
> **Duration**: 5~8s

### Sync Behavior

| Feature | Description |
|---------|-------------|
| **Auto sync** | Notes are automatically uploaded when saved (with debounce) |
| **Conflict detection** | Detects when the same file is modified in two places |
| **Rename retry** | If a file lock occurs during sync, it automatically retries up to 3 times |

> 📸 **GIF placeholder** — `images/vault-conflict-resolve.gif`
>
> **Shot**: Resolving a sync conflict when one occurs
> **Steps**: ① Conflict notification or conflict file detected → ② Conflict file is displayed (conflict marker in filename) → ③ User reviews and resolves the conflict
> **Screen area**: Sidebar file tree + editor area
> **Highlight**: How the conflicted file is displayed, and the resolution process
> **Duration**: 5~8s

---

## Data Storage Locations

Notology stores its data in the following locations.

| Data | Location | Description |
|------|----------|-------------|
| **Note files** | Vault folder | The folder you specified (`.md` files) |
| **App settings** | `%APPDATA%\com.notology.app\` | Theme, font, recent vault list, etc. |
| **Search index** | `%LOCALAPPDATA%\Notology\indices\` | Index files for full-text search |
| **Preview cache** | `%LOCALAPPDATA%\Notology\preview_cache\` | Cached document preview conversions |

> **💡 Tip**: You can navigate to `%APPDATA%` by typing it directly into the Windows File Explorer address bar.

---

## Backup Tips

Here are some ways to keep your notes safe.

| Method | Description |
|--------|-------------|
| **Folder copy** | Copy the entire vault folder to a USB drive or external hard drive |
| **Cloud sync** | Place your vault folder inside OneDrive, Google Drive, or similar |
| **NAS sync** | Use a NAS sync client for automatic backup |
| **Git** | Version-control your vault folder with Git (recommended for developers) |

Your notes are all **plain markdown files**, so you can always open them with any other markdown editor — even if you stop using Notology. Your data is never locked into a specific app.

---

[◀ Keyboard Shortcuts](EN-Keyboard-Shortcuts) · [<img src="images/icons/home.png" width="16" height="16"> Home](Home) · [Tips & Tricks ▶](EN-Tips-Tricks)
