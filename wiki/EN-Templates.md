[◀ Document Preview](EN-Document-Preview) · [<img src="images/icons/home.png" width="16" height="16"> Home](Home) · [Tags ▶](EN-Tags)

---

# <img src="images/icons/clipboard.png" width="24" height="24"> Templates

Create notes quickly using pre-made structures. Save formats you use repeatedly — like meeting notes, contacts, or research summaries — as templates so you never have to start from scratch.

---

## Concept

A **template** is a pre-built structure used when creating a new note.

- When creating a new note, select a template and its structure is automatically filled in
- Templates include YAML front matter (the info area above the title) and body content
- Choose from 12 built-in templates or create your own custom templates

---

## Built-in Templates (12 types)

Notology comes with a variety of templates for different purposes.

### General

| Icon | Template | Purpose | Includes |
|------|----------|---------|----------|
| 📝 | **Note** | Free-form memo | Title, tags, body |
| 🎨 | **Sketch** | Canvas drawing | Canvas-format note |

### Work

| Icon | Template | Purpose | Includes |
|------|----------|---------|----------|
| 🤝 | **Meeting Notes** | Record meeting content | Date, attendees, agenda, decisions, action items |
| 🎓 | **Seminar** | Organize seminars/lectures | Presenter, topic, key points, Q&A |
| 🎉 | **Event** | Record events/schedules | Date, venue, attendees, program |
| 📃 | **Official Document** | Draft formal documents | Document number, recipient, sender, title, body |

### Research

| Icon | Template | Purpose | Includes |
|------|----------|---------|----------|
| 📑 | **Paper** | Paper review/summary | Author, source, abstract, methodology, results, significance |
| 📚 | **Literature** | Record references | Author, publication info, summary, citation |
| 📊 | **Data** | Record data analysis | Data source, analysis method, results, visualization |
| 🔬 | **Theory** | Organize theories/concepts | Definition, background, key concepts, related theories, application |

### Other

| Icon | Template | Purpose | Includes |
|------|----------|---------|----------|
| 👤 | **Contact** | Manage people info | Name, organization, contact details, notes |
| ⚙️ | **Settings** | Record configurations | Item, value, description |

> 📸 **GIF placeholder** — `images/template-types.gif`
>
> **Shot**: Scrolling through the template list in the note creation dialog and previewing each template
> **Steps**: ① Open the note creation dialog with Ctrl+N → ② Scroll up and down through the template list to view various templates → ③ Hover over each template to show its preview
> **Screen area**: Entire note creation dialog (template list + preview panel)
> **Highlight**: Each template's icon and name, and the preview content shown on selection
> **Duration**: 8~12s

---

## Creating a Note from a Template

1. Press `Ctrl + N` or click the **+ button** at the bottom of the sidebar
2. Enter a note name
3. Select a template from the **template list**
4. Click **Create** and a note with the template structure is generated

> 📸 **GIF placeholder** — `images/template-select.gif`
>
> **Shot**: Opening the note creation dialog with Ctrl+N and selecting a template
> **Steps**: ① Press Ctrl+N → ② Note creation dialog appears → ③ Click a template in the template list → ④ The selected template is highlighted
> **Screen area**: Note creation dialog (center modal)
> **Highlight**: The highlight change when selecting a template
> **Duration**: 3~5s

> 📸 **GIF placeholder** — `images/template-create-note.gif`
>
> **Shot**: The full process of selecting a template, entering a note name, and completing creation
> **Steps**: ① Type a name in the note name input field → ② Select a template → ③ Click the "Create" button → ④ The new note opens with the template structure pre-filled
> **Screen area**: Full screen (dialog → new note opening in the editor)
> **Highlight**: The YAML front matter and body structure automatically filled from the template in the new note
> **Duration**: 5~8s

---

## Custom Templates

In addition to the built-in templates, you can create your own.

### Creating a Custom Template

1. Open **Settings** (click the ⚙ button at the bottom of the sidebar)
2. Select the **Templates** tab
3. Click **Create new template**
4. Fill in the template name, icon, YAML front matter, and body
5. Save

### Structure

Custom templates consist of **YAML front matter** and a **markdown body**.

```yaml
---
tags:
  - project
status: in-progress
assignee: ""
---
# Project Name

## Goals

## Schedule

## Notes
```

### Editing / Deleting

- Go to Settings → Templates tab to **edit** or **delete** existing custom templates

> 📸 **GIF placeholder** — `images/template-custom-create.gif`
>
> **Shot**: The full process of creating a new custom template in Settings > Templates tab
> **Steps**: ① Open Settings (click the ⚙ button) → ② Select the Templates tab → ③ Click "Create new template" → ④ Enter name/icon → ⑤ Write YAML front matter and body → ⑥ Click the Save button
> **Screen area**: Entire settings dialog (Templates tab + edit form)
> **Highlight**: The "Create new template" button, each input field in the edit form, and the Save button
> **Duration**: 8~12s

---

## Enabling / Disabling Templates

You can disable templates you don't use. Disabled templates won't appear in the list when creating a note.

- Go to Settings → Templates tab and use the **toggle switch** on each template to enable or disable it

> 📸 **GIF placeholder** — `images/template-toggle.gif`
>
> **Shot**: Turning a template toggle switch on and off in Settings > Templates tab
> **Steps**: ① In Settings > Templates tab, click a template's toggle switch (OFF) → ② The template becomes disabled → ③ Click the toggle again (ON) → ④ The template is re-enabled
> **Screen area**: Settings dialog, Templates tab (template list area)
> **Highlight**: The toggle switch changing between ON/OFF states
> **Duration**: 3~5s

---

## Storage Containers & Templates

A **Storage container** is linked to a single template, and every note created inside that container automatically uses the same template.

| Feature | Description |
|---------|-------------|
| **Fixed template** | The template chosen at container creation applies to all notes |
| **Automatic application** | The template selection step is skipped when creating notes |
| **Consistent format** | All notes share the same structure, making search and management easier |

> Example: Create a Storage container with the "Contact" template, and every new note in it will be created in the contact format.

> 📸 **GIF placeholder** — `images/template-storage-container.gif`
>
> **Shot**: Creating a Storage container, linking a template, and creating a new note inside it with the template auto-applied
> **Steps**: ① Create a Storage container in the sidebar → ② Select a template (e.g., Contact) → ③ Create a new note inside the container → ④ Confirm the template is automatically applied
> **Screen area**: Full screen (sidebar container + new note opening in the editor)
> **Highlight**: The template structure being applied instantly without a selection step when creating a note
> **Duration**: 8~12s

---

## Usage Tips

| Tip | Description |
|-----|-------------|
| Use for repetitive tasks | Save time by using templates for weekly meeting notes, status reports, and other recurring formats |
| Build databases with Storage | Manage contacts, papers, projects, and more in Storage containers to create structured databases |
| Hide unused templates | Disable built-in templates you don't use to keep the list clean |

---

[◀ Document Preview](EN-Document-Preview) · [<img src="images/icons/home.png" width="16" height="16"> Home](Home) · [Tags ▶](EN-Tags)
