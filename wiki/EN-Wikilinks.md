[◀ Editor Advanced](EN-Editor-Advanced) · [<img src="images/icons/home.png" width="16" height="16"> Home](Home) · [Canvas ▶](EN-Canvas)

---

# <img src="images/icons/link.png" width="24" height="24"> Wikilinks

Learn about wikilinks — the feature that connects your notes together. Linking notes makes it easy to find related content later.

---

## What Is a Wikilink?

A **wikilink** connects notes using the `[[note name]]` format.

- It works just like clicking a blue link on Wikipedia to jump to another article
- Writing `[[Note B]]` in Note A lets you open Note B with a single click
- You can visualize relationships between linked notes in the [Graph View](EN-Graph-View)

> 📸 **GIF placeholder** — `images/wikilink-concept.gif`
>
> **Shot**: A note containing a [[wikilink]] that opens another note when clicked
> **Steps**: ① A [[note name]] wikilink is visible in the editor → ② The wikilink appears as blue text → ③ Click the wikilink → ④ The linked note opens in a hover window
> **Screen area**: Editor area + hover window
> **Highlight**: The blue wikilink text and the hover window appearing on click
> **Duration**: 3~5s

---

## Creating a Wikilink

### Method 1: Type `[[`

The most common way.

1. Type `[[` in the editor
2. An auto-complete list of your notes appears
3. Select the note you want to link, or type its name directly
4. Close with `]]` (auto-complete closes it automatically)

### Method 2: `@` Mention

1. Type `@` in the editor
2. A note list appears
3. Select the note you want

> 📸 **GIF placeholder** — `images/wikilink-create.gif`
>
> **Shot**: Creating a wikilink by typing [[
> **Steps**: ① Type "[[" in the editor → ② Auto-complete dropdown appears → ③ Type more characters to filter → ④ Use arrow keys to select a note → ⑤ Press Enter → ⑥ Wikilink is completed ([[note name]])
> **Screen area**: Editor body area (including auto-complete dropdown)
> **Highlight**: The auto-complete list appearing and the selection process
> **Duration**: 5~8s

> 📸 **GIF placeholder** — `images/wikilink-mention.gif`
>
> **Shot**: Creating a wikilink using the @ mention
> **Steps**: ① Type "@" → ② Note list appears → ③ Select a note → ④ Mention link is completed
> **Screen area**: Editor body area (including dropdown)
> **Highlight**: The list appearing when @ is typed
> **Duration**: 3~5s

> **💡 Tip**: Keep typing after `[[` or `@` to narrow the list and find the note you want faster.

---

## Clicking a Wikilink

Clicking a wikilink opens the linked note in a **hover window**.

- The note you're currently editing stays open
- You can reference the linked note while continuing to write

> 📸 **GIF placeholder** — `images/wikilink-click.gif`
>
> **Shot**: Clicking a wikilink to open the note in a hover window
> **Steps**: ① A wikilink is visible in the editor → ② Click the wikilink → ③ Hover window opens → ④ Read the content in the hover window → ⑤ Return to the main editor and continue writing
> **Screen area**: Editor area + hover window
> **Highlight**: The click moment and the hover window appearing
> **Duration**: 3~5s

---

## Links to Non-Existent Notes

You can create a wikilink to a note that doesn't exist yet.

- Wikilinks to missing notes appear in a **faded color**
- Clicking such a link lets you create the note on the spot
- This is handy for pre-linking to notes you plan to write later

| Status | How it looks |
|--------|-------------|
| Existing note | Normal blue text |
| Non-existent note | Faded text (click to create the note) |

---

## Automatic Updates on Rename

When you rename a note, **all wikilinks pointing to it across the entire Vault are updated automatically**.

- Example: Rename "Project Plan" to "2024 Project Plan"
- Every `[[Project Plan]]` in your Vault becomes `[[2024 Project Plan]]`
- No need to fix them one by one!

> 📸 **GIF placeholder** — `images/wikilink-auto-update.gif`
>
> **Shot**: Renaming a note and verifying that wikilinks in other notes updated automatically
> **Steps**: ① Rename a note in the sidebar → ② Enter new name → ③ Confirm → ④ Open another note → ⑤ Verify the wikilink now shows the new name
> **Screen area**: Sidebar + editor area
> **Highlight**: Comparing the wikilink before and after the rename
> **Duration**: 5~8s

---

## Bidirectional Links (Backlinks)

Wikilinks are **bidirectional**.

- If Note A contains `[[Note B]]`
- Note B's **backlink** list automatically shows Note A
- You can see "which notes reference this one" in the right panel

In other words, when you link to another note, that note knows about you too.

---

## Integration with Graph View

You can visualize the relationships between wikilinked notes in the [Graph View](EN-Graph-View).

- Each note appears as a dot (node)
- A line is drawn between notes connected by wikilinks
- Frequently referenced notes appear larger

> 📸 **GIF placeholder** — `images/wikilink-graph.gif`
>
> **Shot**: Viewing wikilink relationships in the Graph View
> **Steps**: ① Open Graph View → ② Notes shown as dots → ③ Check the connection lines → ④ Hover over a specific note → ⑤ Connected notes become highlighted
> **Screen area**: Full Graph View screen
> **Highlight**: Connection lines highlighting when hovering over a note
> **Duration**: 5~8s

---

## Usage Examples

### Project Management

```
In [[Project Overview]], link to each phase:
- [[Phase 1: Planning]]
- [[Phase 2: Development]]
- [[Phase 3: Testing]]

Each phase note references related meeting notes like
[[Meeting Notes Jan 15]], [[Meeting Notes Jan 22]].
```

### Knowledge Connections

```
In [[Machine Learning]], link to related concepts:
- Foundations: [[Linear Algebra]], [[Statistics]]
- Algorithms: [[Neural Networks]], [[Decision Trees]]
- Applications: [[Natural Language Processing]], [[Computer Vision]]
```

### Daily Logs

```
In [[2024-01-15 Journal]], log the day's progress and
link to related notes:
- Updated [[Project A]] progress
- Met with [[John Smith]] — see [[Meeting Notes Jan 15]]
```

---

[◀ Editor Advanced](EN-Editor-Advanced) · [<img src="images/icons/home.png" width="16" height="16"> Home](Home) · [Canvas ▶](EN-Canvas)
