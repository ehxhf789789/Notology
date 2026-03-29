[◀ Templates](EN-Templates) · [<img src="images/icons/home.png" width="16" height="16"> Home](Home) · [Settings ▶](EN-Settings)

---

# <img src="images/icons/tag.png" width="24" height="24"> Tag System

Tags are labels you attach to notes to organize them. Unlike folders, you can add multiple tags to a single note, giving you a flexible way to classify and find your notes.

---

## Concept

Tags are stored in the **YAML front matter** `tags` field at the top of each note.

```yaml
---
tags:
  - project
  - in-progress
  - domain:development
---
```

- You can attach multiple tags to a single note
- Tags let you quickly group and search related notes
- In the graph view, you can visualize the relationships between notes that share the same tag

> 📸 **Screenshot placeholder** — `images/tags-concept.png`
>
> **Shot**: A note with tags entered in its YAML front matter
> **Content**: The top of a note showing the `tags:` field with several tags listed below it (e.g., project, in-progress, domain:development)
> **Screen area**: Top of the editor (YAML front matter area)

---

## Adding Tags

### Adding Directly in YAML

Type your tags in the `tags` field of the front matter area at the top of the note.

```yaml
---
tags:
  - new-tag
---
```

### Bulk Adding from Search

Select multiple notes in the search results, then use the bulk action to add a tag to all of them at once.

> 📸 **GIF placeholder** — `images/tags-add.gif`
>
> **Shot**: Adding a tag directly in the YAML front matter, or bulk-adding tags to multiple notes from search results
> **Steps**: ① Type a new tag in the YAML front matter at the top of the note → ② The tag is added (or) ① Open search (Ctrl+Shift+F) → ② Select multiple notes → ③ Execute bulk tag addition
> **Screen area**: Top of the editor (YAML area) or the entire search panel
> **Highlight**: The moment the tag is added, checkboxes when bulk selecting
> **Duration**: 5~8s

---

## Tag Colors

You can assign a unique color to each tag. Color-coded tags stand out in notes and search results.

| Feature | Description |
|---------|-------------|
| **Assign color** | Click a tag to choose a color |
| **Visual distinction** | Give important tags a vivid color for quick identification |
| **Consistency** | Once assigned, the color appears the same across all notes |

> 📸 **GIF placeholder** — `images/tags-colors.gif`
>
> **Shot**: Clicking a tag and selecting a color from the color palette
> **Steps**: ① Click a tag at the top of the note → ② Color picker palette appears → ③ Click a color → ④ The tag color changes
> **Screen area**: Top of the editor (tag area + color palette popup)
> **Highlight**: The color palette popup, and the visual difference in the tag before and after the color change
> **Duration**: 3~5s

---

## Namespace Tags

Add a **prefix** to tags for systematic organization. Use the `prefix:value` format.

| Prefix | Purpose | Examples |
|--------|---------|----------|
| `domain:` | Field/area | `domain:development`, `domain:marketing`, `domain:design` |
| `who:` | Person/assignee | `who:john`, `who:sarah` |
| `org:` | Organization/team | `org:planning`, `org:dev-team`, `org:clientA` |
| `ctx:` | Context/status | `ctx:urgent`, `ctx:on-hold`, `ctx:done` |

### Example

```yaml
---
tags:
  - domain:development
  - who:john
  - org:frontend-team
  - ctx:in-progress
---
```

Using namespaces lets you systematically manage your tags — for example, filtering only tags that start with `domain:` during a search.

> 📸 **GIF placeholder** — `images/tags-namespace.gif`
>
> **Shot**: Showing a note with namespace tags (domain:, who:, etc.) and filtering by prefix in search
> **Steps**: ① View namespace tags in the note's YAML (domain:development, who:john) → ② Open search → ③ Filter by "domain:" prefix in the tag filter → ④ Only notes with that tag are shown
> **Screen area**: Top of the editor (YAML area) → switching to the search panel
> **Highlight**: The prefix:value format of the tags, and the filtered search results
> **Duration**: 5~8s

---

## Searching by Tag

Use the search panel (`Ctrl + Shift + F`) to find notes based on their tags.

| Method | Description |
|--------|-------------|
| **Tag filter** | Select a tag from the tag filter in the search panel |
| **Direct search** | Switch the search field to "Tag" and type the tag name |
| **Combined search** | Use keyword + tag filter together for more precise results |

> 📸 **GIF placeholder** — `images/tags-search.gif`
>
> **Shot**: Selecting a tag filter in the search panel or searching by tag name to find notes
> **Steps**: ① Open search with Ctrl+Shift+F → ② Click the tag filter dropdown → ③ Select a tag → ④ Notes with that tag are listed
> **Screen area**: Entire search panel (search bar + filter + result list)
> **Highlight**: The tag filter dropdown, and the result change after applying the filter
> **Duration**: 5~8s

---

## Tags in Graph View

In the [Graph View](EN-Graph-View), tags appear as **diamond-shaped (◆) nodes**.

- Notes with the same tag are connected through the tag node
- Tag display can be toggled on and off (via the graph settings panel)
- Visually identify which notes belong to the same category

> 📸 **GIF placeholder** — `images/tags-graph.gif`
>
> **Shot**: Showing tag nodes (diamonds) in the graph view with notes connected through shared tags
> **Steps**: ① Open graph view → ② Hover over a tag node (diamond) → ③ Notes with that tag are highlighted → ④ Toggle tag display ON/OFF in the settings panel
> **Screen area**: Entire graph view (graph main area + right settings panel)
> **Highlight**: The diamond-shaped tag node and the highlight effect on connected notes when hovering
> **Duration**: 5~8s

---

## Cleaning Up Unused Tags

You can clean up tags that are no longer used by any note.

- Tags not used in any note are automatically detected
- Bulk-delete unused tags to keep your tag list clean

> 📸 **GIF placeholder** — `images/tags-cleanup.gif`
>
> **Shot**: Detecting and bulk-deleting unused tags
> **Steps**: ① View the list of unused tags → ② Select tags to delete → ③ Execute bulk deletion → ④ The tag list is cleaned up
> **Screen area**: Tag management panel or settings screen
> **Highlight**: How unused tags are displayed, and the list change before and after deletion
> **Duration**: 5~8s

---

## Usage Examples

| Purpose | Recommended Tags | Description |
|---------|-----------------|-------------|
| **Project management** | `domain:project-name`, `ctx:in-progress`, `ctx:done` | Group notes by project and track progress |
| **People management** | `who:name`, `org:team` | Quickly find notes related to specific people |
| **Study notes** | `domain:subject`, `ctx:needs-review` | Classify notes by subject and flag items for review |
| **Daily work** | `ctx:urgent`, `ctx:on-hold`, `domain:schedule` | Manage work priorities with tags |

> **💡 Tip**: Around 3 to 5 tags per note is a good balance. Too many tags can actually make management harder.

---

[◀ Templates](EN-Templates) · [<img src="images/icons/home.png" width="16" height="16"> Home](Home) · [Settings ▶](EN-Settings)
