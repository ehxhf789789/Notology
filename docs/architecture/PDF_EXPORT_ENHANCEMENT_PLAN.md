# PDF Export Enhancement Plan

> Follow-up to the initial PDF export feature (shipped 2026-05-18).
> Captures the limitations noted in [`noteExport.ts`](../../src/features/shared/noteExport.ts)
> plus additional gaps surfaced on post-ship review, sequenced into
> implementable sub-stages with HanBin sign-off questions for the
> ambiguous calls.

---

## A. What v1 ships (2026-05-18)

| Feature | Status |
|---|---|
| Right-click on note → "PDF로 내보내기..." | ✅ |
| Markdown → HTML conversion (focused subset) | ✅ |
| Hidden iframe + `window.print()` route | ✅ |
| OS native PDF printer (no new deps) | ✅ |
| Print-ready CSS (margins, fonts, page-break hints) | ✅ |
| Doc title from filename | ✅ |
| Headings (h1–h6), paragraphs, bold/italic, inline+fenced code, blockquote, hr, flat lists, links, wikilinks (visual), images (external URL only) | ✅ |
| Cleanup after print (iframe removed, watchdog timeout) | ✅ |

---

## B. Gap inventory (post-v1 audit)

Ranked by user-impact for a typical PKM vault. Severity = how broken
the output looks when the input note relies on the feature.

| # | Gap | Symptom | Severity | Root cause |
|---|---|---|---|---|
| G1 | Local image / attachment embeds (`![[file.png]]`, `![alt](_att/...)`) | Broken-image icon in PDF | HIGH | srcdoc iframe has no base URL → relative paths fail; `asset://` may or may not resolve cross-document |
| G2 | KaTeX math (`$inline$`, `$$block$$`) | Raw `$x^2 + y^2 = z^2$` text instead of typeset formula | HIGH | Converter doesn't recognize math syntax; katex CSS not in print iframe |
| G3 | Markdown tables (`\| col \| col \|`) | Rendered as plain text lines | HIGH | Converter has no table grammar |
| G4 | Code syntax highlighting | `<pre>` block emits with `language-*` class but renders monochrome | MEDIUM | highlight.js CSS not in print iframe; tokens not pre-marked-up |
| G5 | Task list checkboxes (`- [ ]`, `- [x]`) | Renders as `[ ] item` / `[x] item` plain text | MEDIUM | Converter treats them as regular list items |
| G6 | Strikethrough (`~~text~~`) | Tildes survive into output | LOW | Not in inline rules |
| G7 | Highlight mark (`==text==`) | Equals signs survive | LOW | Not in inline rules |
| G8 | TipTap callouts (custom `<div class="callout">`) | Callout body inlined but the callout tone box is gone | LOW | Custom extension; markdown serialize uses HTML fallback |
| G9 | Nested lists | Flattens to single level | LOW | Converter doesn't track indentation depth |
| G10 | Footnotes (`[^1]`, `[^1]: ...`) | Marker survives, definition becomes orphan paragraph | LOW | Not parsed |
| G11 | Frontmatter metadata header (title from `title:`, optional tags/date strip) | Filename used as title; tags lost | LOW | Frontmatter dropped in `exportAsMarkdown` |
| G12 | TOC / heading anchors | No navigation aid in long PDFs | LOW | Not generated |
| G13 | CJK font fallback | Korean glyph quality varies across Print drivers | LOW | Font stack doesn't pin Noto Sans KR |
| G14 | Page numbers / footer | None | LOW | No `@page` counter / running header |
| G15 | Hard page breaks (`<!-- pagebreak -->` or similar) | User can't force a break | LOW | No directive recognized |

**Severity totals:** 3 HIGH (G1–G3), 2 MEDIUM (G4–G5), 10 LOW.

---

## C. Sub-stage plan

Sequenced so each stage stands alone and can ship independently. Stages
A/B/C cover all 3 HIGH items + the 2 MEDIUM items (math + code combined
into one CSS-embed stage). The LOW tail is bundled into a final polish
stage so the user can opt out.

### Stage I — Local image & attachment embedding (G1)

**Effort:** 0.5 session

**Scope:**
- Detect `![[file.ext]]` (wiki-attachment) and `![alt](relative/path)` in markdown
- Resolve to absolute vault path via the existing AttachmentRef store / `getNoteAttachmentPath`-equivalent helper
- Decision tree per file type:
  - **Image** (png/jpg/jpeg/gif/webp/svg) → read bytes → base64 data URL → embed inline. Self-contained PDF, no broken refs.
  - **Audio/video** (mp3/wav/mp4/webm) → render as `<a>` link with filename + size (PDF can't play media anyway)
  - **PDF/Office** (pdf/docx/pptx/xlsx/hwpx) → render as styled link card with icon + name (matches the editor's embed UX)
- Skip embedding when file > 5MB (configurable cap) → fall back to link to avoid bloating the PDF

**Files touched:**
- [`noteExport.ts`](../../src/features/shared/noteExport.ts) — add `resolveAttachmentEmbed()` helper, wire into image inline rule
- New Tauri command `read_file_bytes(path) -> Vec<u8>` if not already present (currently `readFile` returns parsed markdown, not raw bytes)

**Why base64 not `asset://`:**
Tauri's `asset://localhost/...` URL works inside the main window but `srcdoc` iframes have an opaque origin in some webview implementations (WebView2 / WKWebView differ). Base64 inlining sidesteps the cross-origin uncertainty and produces a portable PDF that survives email / cloud-share without the original vault.

**Open question:** see Q1.

---

### Stage II — KaTeX math rendering (G2)

**Effort:** 0.3 session

**Scope:**
- Add a markdown pre-pass that finds `$...$` (inline) and `$$...$$` (block)
- Use existing `katex` dep: `katex.renderToString(formula, { displayMode })`
- Embed `katex/dist/katex.min.css` content (~30KB) inline in the print HTML's `<style>` block
- Reuse `tryFixLatex` from `MathExtension.ts` for failure recovery (matches in-editor behavior)
- Errors render as `<span class="math-error">{original-text}</span>` styled red — same defensive pattern as the live editor

**Files touched:**
- [`noteExport.ts`](../../src/features/shared/noteExport.ts) — math pre-pass before HTML escape; embed katex CSS
- New helper: `loadKatexCss()` that reads the bundled CSS string once and caches it (Vite's `?raw` import or inline-import)

**Trade-off:** +30KB per PDF document. Acceptable since math content is the point.

---

### Stage III — Markdown tables (G3)

**Effort:** 0.4 session

**Scope:**
- Parse standard GFM table grammar:
  ```
  | col1 | col2 |
  |------|------|
  | a    | b    |
  ```
- Support alignment markers (`:---`, `:---:`, `---:`) → emit `text-align` style on cell
- Emit `<table>` with print CSS: 1px border, alternating row tint, page-break-inside avoid
- Handle escape edge cases (`\|` to embed pipes in cells)

**Files touched:**
- [`noteExport.ts`](../../src/features/shared/noteExport.ts) — new `parseTables()` block pass before paragraph accumulation

---

### Stage IV — Code syntax highlighting (G4)

**Effort:** 0.3 session

**Scope:**
- Use existing `lowlight` instance (configured in [`editorConfig.ts`](../../src/core/editor/editorConfig.ts) with 20+ languages) to tokenize code blocks
- Render to highlighted HTML (lowlight's `highlight()` returns hast, convert to HTML via `hast-util-to-html` — already a transitive dep)
- Embed a print-friendly highlight.js theme CSS (suggest `github.min.css` for light backgrounds; `~10KB`) inline in print iframe
- Fall back to plain `<pre><code>` for unrecognized languages (existing behavior)

**Files touched:**
- [`noteExport.ts`](../../src/features/shared/noteExport.ts) — call `lowlight.highlight(lang, code)` instead of plain escape during fenced-code extraction; embed theme CSS

---

### Stage V — Task list checkboxes + extra inline marks (G5–G7)

**Effort:** 0.2 session

**Scope:**
- Task list: recognize `- [ ]` / `- [x]` / `- [X]` at list-item start; emit `<li class="task"><input type="checkbox" disabled> ...` or simpler glyph (`☐` / `☑`) to avoid form-element print quirks
- Strikethrough: `~~text~~` → `<del>text</del>`
- Highlight: `==text==` → `<mark>text</mark>`

**Files touched:**
- [`noteExport.ts`](../../src/features/shared/noteExport.ts) — extend list regex + inline rules

---

### Stage VI — Polish + frontmatter header (G8–G15)

**Effort:** 0.3 session (bundled cleanup)

**Scope:**
- **Optional frontmatter header**: if `--include-metadata` flag (or user setting), render a small table with `title`, `type`, `tags`, `created` above the body. Off by default per Q4.
- **Callouts**: parse the HTML serialize form (`<div class="callout" data-type="info">...</div>`) and emit print-friendly variant with colored left border + icon glyph
- **Nested lists**: track indentation depth (2-space rule), recursively emit `<ul><li><ul>...`
- **CJK font stack**: add `"Noto Sans KR"`, `"Apple SD Gothic Neo"`, `"Malgun Gothic"` explicitly in the font-family chain
- **Page numbers**: `@page { @bottom-center { content: counter(page); } }` — clean OS-native footnote
- **Hard page break**: recognize `<!-- pagebreak -->` HTML comment → emit `<div style="break-after: page;"></div>`
- **Footnotes**: collect `[^id]: definition` lines, replace inline `[^id]` with superscript `<sup><a href="#fn-id">id</a></sup>`, append a footnotes section before the close `</body>`
- **TOC** *(opt-in)*: if `--include-toc` flag, build a heading tree → list at the top, anchor links to `<h1 id="...">` etc.

**Files touched:**
- [`noteExport.ts`](../../src/features/shared/noteExport.ts) — block-pass extensions + final assembly
- Settings hook (Q4): expose `includeMetadata` / `includeToc` toggles if HanBin signs off

---

## D. Open questions for HanBin

| Q | Question | Default if no answer | Stage |
|---|---|---|---|
| Q1 | Image embed cap — 5MB per image, or no cap? Larger caps = bigger PDF but no broken refs. Smaller cap protects PDF size for vaults with high-res photos. | 5MB cap; fall back to link card for larger | Stage I |
| Q2 | Non-image attachments in PDF — link card with name+icon, or skip silently? | Render as link card (matches editor UX) | Stage I |
| Q3 | KaTeX failure handling — surface the raw `$...$` text in red (current editor behavior) or silently drop the math? | Match editor: red error span with raw formula | Stage II |
| Q4 | Frontmatter header (title/tags/date table above body) — default ON or OFF? Settings toggle worth building? | OFF, no setting (export stays clean by default). Add setting only if you confirm you want a metadata header. | Stage VI |
| Q5 | TOC generation — opt-in setting, default ON for notes >N headings, or skip entirely? | Skip in v2; revisit if requested | Stage VI |
| Q6 | Hard page break syntax — `<!-- pagebreak -->` HTML comment, custom `\page` directive, or skip? | HTML comment — non-intrusive in editor view | Stage VI |
| Q7 | PDF metadata (PDF title, author from frontmatter) — embed via `<meta>` tags so the OS PDF reader shows it? | Yes if trivial; PDF Title = note title, Author = `Notology` | Stage VI |

---

## E. Sequencing + total estimate

```
Stage I  (images)       0.5 ──┐
Stage II (math)         0.3 ──┤
Stage III (tables)      0.4 ──┼── independent; pick any order
Stage IV (code hl)      0.3 ──┤
Stage V  (task/mark)    0.2 ──┘
Stage VI (polish)       0.3       depends on I–V landing
                       ────
Total                  ~2.0 sessions
```

Stages I–V are **embarrassingly parallel** at the spec level — each
touches a different region of `markdownToHtml` and `buildPdfDocument`.
Recommended ship order is **III → II → I → IV → V → VI** by user impact
descending. Tables (III) is the easiest grammar to add and unblocks
the most visible improvement; math (II) matters most for academic notes;
images (I) is the biggest engineering scope so it benefits from going
last among the HIGH-severity items.

---

## F. Non-goals

These came up during scoping but are explicitly **out** of this plan to
keep the v2 scope honest:

- **Multi-note batch export** (export a whole folder to a single PDF). Distinct UX problem — folder selection, ordering, separator pages. Worth its own plan if requested.
- **PDF/A archival format compliance** (font embedding, color profile pinning). Niche; out of scope.
- **Watermarks / page headers / page footers with custom text**. The default footer (page number) covers 90%; custom strings open a settings rabbit hole.
- **PDF outline / bookmarks** (the side-panel TOC most readers render from `<h1>` tags). Web `print()` doesn't reliably emit these in either WebView2 or WKWebView. Skip unless someone adds it on a future PDF lib swap.
- **Form fields** (interactive checkboxes). Plain glyphs (Stage V) cover the visual.
- **Encryption / password-protect**. Out of scope.

---

## G. Decision summary (HanBin sign-off 2026-05-19)

| Item | Decision |
|---|---|
| Q1 image cap | 5MB cap; >5MB falls back to link card. Local images served via `asset://` URLs (no base64 encode unless WebView2 print rejects the protocol — fallback path TBD on first run) |
| Q2 non-image attachments | Render as link card matching the editor's MediaEmbed visual (icon + filename) |
| Q3 math fail | Match editor: red `.math-error` span carrying the raw `$...$` text |
| Q4 frontmatter header | OFF default; no settings toggle |
| Q5 TOC | Skip in v2; revisit if requested |
| Q6 page break syntax | `<!-- pagebreak -->` HTML comment → `<div class="pdf-pagebreak">` with `page-break-before: always` |
| Q7 PDF metadata | Embed via `<title>` + `<meta name="author" content="Notology">` so OS PDF reader picks them up |
| Ship order | **OVERRIDE — WYSIWYG-first strategy** (see §H below) replaces the I→VI piecemeal plan |

---

## H. Strategy override — WYSIWYG via live editor render (2026-05-19)

HanBin direction: *"추천 default를 기반으로 하되, hover note에서 보이는
그대로를 최대한 pdf로 가져가도록 구현할 것."*

The piecemeal v2 converter (Stages I–V hand-rolling parsers for tables /
math / images / code highlight) is **superseded** by a single
implementation that reuses the live TipTap editor's render output:

1. **Acquire** a fresh editor from `editorPool` with live callbacks
   wired (`resolveLink`, `getNoteType`, `isAttachment`, etc.) — same as
   a real hover window would do.
2. **Hidden mount**: render `<EditorContent editor={editor} />` into a
   detached `<div>` parked off-screen (`left: -100000px`). React's node
   views (LinkCard, MediaEmbed, Math, etc.) instantiate just like in a
   real hover; `convertFileSrc(asset://)` resolution, KaTeX typesetting,
   lowlight syntax highlighting all run for free.
3. **Set content** via `editor.commands.setContent(body)` — tiptap-markdown
   parses the note exactly the way it does for the live editor.
4. **Settle**: wait 3 RAFs + 800 ms timeout so React commit + node view
   subtrees + KaTeX `katex.render` + `<img>` load events all complete.
5. **Capture** `editor.view.dom.outerHTML` for the body.
6. **Harvest CSS** via `document.styleSheets` → `cssRules.cssText` so the
   print iframe gets the same CSS cascade the editor displays under
   (editor.css, katex.min.css, code-highlight.css, callout.css,
   wikilink.css, link-card.css, media-embed.css, etc.).
7. **Apply page-break / metadata transforms** on the captured HTML
   (Q6 + Q7).
8. **Build the print HTML doc** with the captured CSS embedded inline,
   open in a hidden iframe, call `iframe.contentWindow.print()`.
9. **Cleanup**: unmount the React root, release editor to pool, remove
   hidden container + iframe.

### Why this beats Stages I–V

Each stage I–V was a re-implementation of work the live editor already
does (table parsing, math rendering, image resolution, code highlighting).
By rendering through the editor itself, those features come along **for
free + WYSIWYG**: every visual choice the user is already used to
(callout color, table cell tint, wiki-link decoration, code theme,
math display vs inline) carries through identically.

### Trade-offs accepted

- **Latency**: ~1s per export (render-and-settle wait). Negligible for
  a deliberate "export to PDF" action.
- **Memory bump**: temporarily holds an extra editor + its node views.
  Released on completion.
- **CSS payload**: harvested stylesheet text can be 100–300 KB inline in
  the iframe. Print performance, not user-visible.
- **Stage V residue**: G6 (strikethrough) and G7 (highlight mark) are
  *already* supported by the live editor (`Highlight` extension, `~~`
  via StarterKit's Strike when enabled). G8 callouts already render via
  the `Callout` extension. So Stage V is mostly redundant under this
  override — the residue (`<!-- pagebreak -->` parsing, frontmatter
  header) folds into the post-capture transform pass.

### Files touched

- `src/features/shared/pdfRender.tsx` — **new**. React-mounted hidden
  editor + DOM capture + CSS harvest + print iframe.
- `src/features/shared/noteExport.ts` — `exportAsPdf` is rewritten to
  delegate to `pdfRender.tsx`. The legacy hand-rolled `markdownToHtml`
  and `inlineMarkdown` helpers are removed (dead code under the new
  path). `exportAsMarkdown` + `exportAsText` retained.
- Document the live-render approach inline in `noteExport.ts`.
