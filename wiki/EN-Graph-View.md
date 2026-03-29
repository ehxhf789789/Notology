[◀ Search](EN-Search) · [<img src="images/icons/home.png" width="16" height="16"> Home](Home) · [Calendar ▶](EN-Calendar)

---

# <img src="images/icons/share-2.png" width="24" height="24"> Graph View

See how your notes are connected through an interactive **network graph**. Quickly spot which notes link to each other and discover hidden relationships at a glance.

---

## Opening Graph View

Click the **Graph View** button at the bottom of the sidebar to open the full-screen graph.

> 📸 **GIF placeholder** — `images/graph-open.gif`
>
> **Shot**: Clicking the Graph View button in the sidebar to open the graph screen
> **Steps**: ① Move cursor to the Graph View button at the bottom of the sidebar → ② Click → ③ Full-screen graph appears
> **Screen area**: Full screen (including sidebar + main area transition)
> **Highlight**: Location of the Graph View button at the bottom of the sidebar
> **Duration**: 3~5s

---

## Concept

The graph view uses a **force-directed layout** to visually map the relationships between your notes. Notes with many connections naturally gravitate toward the center, while less-connected notes drift to the edges.

- The more you link your notes, the richer the graph becomes
- Connections made with wikilinks (`[[Note]]`) appear as lines between nodes
- Tags, attachments, and folder relationships can also be displayed

---

## Node Types

Each item in the graph is represented as a **node**, with different shapes for different types.

| Shape | Type | Description |
|-------|------|-------------|
| ⬤ Circle | **Note** | The more connections a note has, the larger the circle |
| ◆ Diamond | **Tag** | Connected to every note that uses that tag |
| ▢ Rounded square | **Attachment** | A file attached to a note |
| 📁 Folder | **Folder** | A folder that contains notes |

> 📸 **GIF placeholder** — `images/graph-node-types.gif`
>
> **Shot**: Hovering over different node types (circle, diamond, square, folder) in the graph to show the differences
> **Steps**: ① Hover over a note node (circle) → ② Hover over a tag node (diamond) → ③ Hover over an attachment node (square) → ④ Hover over a folder node
> **Screen area**: Graph main area (zoomed in enough to clearly see the nodes)
> **Highlight**: Shape differences between each node type and the labels that appear on hover
> **Duration**: 5~8s

---

## Edge (Connection Line) Types

The lines between nodes are styled differently depending on the relationship.

| Line Style | Relationship | Description |
|------------|-------------|-------------|
| **Solid arrow** ─→ | Wikilink | A direct connection made with `[[Note]]` |
| **Dashed** ┄┄ | Tag | Notes that share the same tag |
| **Solid** ── | Attachment | A file attached to a note |
| **Thin dashed** ····· | Contains | A folder containing a note |

---

## Mouse Controls

You can freely explore the graph using your mouse.

| Action | How To |
|--------|--------|
| **Pan** | Drag on an empty space |
| **Zoom in/out** | Scroll the mouse wheel up or down |
| **Highlight connections** | Hover over a node to highlight its connected nodes |
| **Select a node** | Single-click on a node |
| **Open a note** | Double-click a node to open that note |
| **Pin/unpin a node** | Right-click a node to pin it in place or release it |

> 📸 **GIF placeholder** — `images/graph-interaction.gif`
>
> **Shot**: Demonstrating panning, zooming, hover highlighting, and double-click to open a note
> **Steps**: ① Drag empty space to pan the view → ② Scroll mouse wheel to zoom in/out → ③ Hover over a node to highlight connections → ④ Double-click a node to open the note
> **Screen area**: Entire graph main area
> **Highlight**: The highlight effect when hovering over connected nodes, and the moment a note opens after double-clicking
> **Duration**: 8~12s

> 📸 **GIF placeholder** — `images/graph-pin-node.gif`
>
> **Shot**: Right-clicking a node to pin it in place, then right-clicking again to unpin it
> **Steps**: ① Right-click on a node → ② Node becomes pinned (pin icon or visual indicator) → ③ Drag other nodes to show the graph moves but the pinned node stays put → ④ Right-click the pinned node again to unpin it
> **Screen area**: Graph main area (zoomed in around the node to be pinned)
> **Highlight**: The pinned node remaining stationary while other nodes move around it
> **Duration**: 5~8s

---

## Graph Search

Type a note name into the **search box** at the top of the graph to quickly locate a node.

1. Enter a keyword in the search box
2. Matching nodes are highlighted with a **glowing effect**
3. The view **automatically pans** to center on the matching node

> 📸 **GIF placeholder** — `images/graph-search.gif`
>
> **Shot**: Typing a keyword into the graph search box to find a node
> **Steps**: ① Click the search box at the top of the graph → ② Type a note name keyword → ③ Matching node glows with a highlight effect → ④ The view auto-pans to center on the node
> **Screen area**: Full graph screen (including the search box at the top + the graph area)
> **Highlight**: The glowing highlight effect on the search result node and the automatic centering
> **Duration**: 5~8s

---

## Settings Panel

Use the settings panel on the right side of the graph to adjust display options and physics engine parameters.

### Display Options

| Setting | Description |
|---------|-------------|
| **Show tags** | Show or hide tag nodes (diamonds) |
| **Show attachments** | Show or hide attachment nodes |

### Physics Engine Settings

| Setting | Description |
|---------|-------------|
| **Charge** | The repulsive force between nodes. Higher values push nodes farther apart |
| **Link Distance** | The default distance between connected nodes |
| **Center Strength** | The force pulling nodes toward the center of the screen |
| **Reset** | Resets all physics settings to their default values |

> 📸 **GIF placeholder** — `images/graph-settings.gif`
>
> **Shot**: Toggling tag visibility and adjusting physics engine sliders in the graph settings panel
> **Steps**: ① Open the settings panel on the right → ② Toggle tags OFF → diamond nodes disappear → ③ Toggle tags ON → diamond nodes reappear → ④ Adjust the Charge slider → node spacing changes → ⑤ Click the Reset button
> **Screen area**: Graph main area + right settings panel
> **Highlight**: The graph updating in real time when toggling options, and the node rearrangement animation when adjusting sliders
> **Duration**: 8~12s

---

## Info Bar & Legend

The bottom of the graph displays statistics and a legend for the current graph.

### Info Bar

| Item | Description |
|------|-------------|
| **Notes** | Total number of notes shown in the graph |
| **Tags** | Total number of tags shown in the graph |
| **Attachments** | Total number of attachments shown in the graph |
| **Links** | Total number of connections between nodes |

### Legend Bar

A legend at the bottom of the graph explains the color and shape of each node type.

> 📸 **Screenshot placeholder** — `images/graph-legend.png`
>
> **Shot**: The info bar and legend bar at the bottom of the graph
> **Content**: The info bar showing counts for notes, tags, attachments, and links as numbers + the legend showing colors/shapes for each node type
> **Screen area**: Bottom bar area of the graph screen (roughly the bottom 15%)

---

## Usage Tips

| Tip | Description |
|-----|-------------|
| Find hub notes | The largest circle (node) is the most connected note — your knowledge hub |
| Spot isolated notes | Notes sitting alone at the edges have no connections. Try adding wikilinks to them |
| Discover clusters | Groups of nodes clustered together represent related topics |
| Use tags | Turn on tag display to easily see which notes belong to the same category |

---

[◀ Search](EN-Search) · [<img src="images/icons/home.png" width="16" height="16"> Home](Home) · [Calendar ▶](EN-Calendar)
