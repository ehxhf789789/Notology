# Notology - Claude Code Project Guide

## Project Overview
Notology is a personal knowledge management (PKM) application built with Tauri + React + TipTap editor.
It's a markdown-based note-taking app similar to Obsidian, with support for wikilinks, attachments, canvas, and Synology NAS sync.

## Tech Stack
- **Frontend**: React 18, TypeScript, Vite
- **Backend**: Tauri 2.x (Rust)
- **Editor**: TipTap (ProseMirror-based)
- **State Management**: Zustand
- **Styling**: CSS (App.css)
- **Build**: GitHub Actions workflow for Windows releases

## Key Directories
```
src/
├── components/       # React components
│   ├── HoverEditor.tsx    # Main hover window editor (2000+ lines)
│   ├── EditorToolbar.tsx  # Toolbar with formatting buttons
│   ├── EditorContextMenu.tsx  # Right-click context menu
│   ├── HeadingView.tsx    # Custom heading NodeView with fold/unfold
│   ├── CodeBlockView.tsx  # Custom code block NodeView with fold/unfold
│   └── HorizontalRuleView.tsx  # Custom HR NodeView with delete button
├── extensions/       # TipTap extensions
│   ├── HeadingWithAlign.ts      # Heading with collapse support
│   ├── CodeBlockWithHighlight.ts # Code block with syntax highlighting
│   ├── ParagraphWithIndent.ts   # Paragraph with indent/alignment
│   ├── HorizontalRuleNoGap.ts   # HR with keyboard shortcuts
│   └── TableHeaderWithColor.ts  # Table with cell background colors
├── hooks/           # Custom React hooks
│   └── useDragDrop.ts     # File drag-drop handling
├── stores/zustand/  # Zustand stores
├── services/        # Tauri command wrappers
└── utils/           # Utility functions
    ├── editorConfig.ts    # TipTap editor configuration
    └── editorPool.ts      # Editor instance pooling
```

## Important Implementation Patterns

### TipTap Custom Extensions
All custom extensions use `ReactNodeViewRenderer` for custom UI:
```typescript
import { ReactNodeViewRenderer } from '@tiptap/react';
import MyView from '../components/MyView';

export const MyExtension = BaseExtension.extend({
  addNodeView() {
    return ReactNodeViewRenderer(MyView);
  },
  addAttributes() {
    return {
      ...this.parent?.(),
      customAttr: { default: false },
    };
  },
});
```

### Markdown Serialization
Custom attributes must be serialized to HTML when markdown can't represent them:
```typescript
addStorage() {
  return {
    markdown: {
      serialize(state: any, node: any) {
        if (node.attrs.customAttr) {
          // Serialize as HTML to preserve attribute
          state.write(`<tag data-custom="true">content</tag>`);
          state.closeBlock(node);
        } else {
          // Standard markdown
          state.write('# ');
          state.renderInline(node);
          state.closeBlock(node);
        }
      },
    },
  };
}
```

### ProseMirror Decorations for Collapse
Use decorations to hide content under collapsed headings:
```typescript
addProseMirrorPlugins() {
  return [
    new Plugin({
      key: new PluginKey('collapse'),
      props: {
        decorations: (state) => {
          const decorations: Decoration[] = [];
          // Add 'heading-collapsed-content' class to hidden nodes
          decorations.push(Decoration.node(pos, endPos, { class: 'heading-collapsed-content' }));
          return DecorationSet.create(doc, decorations);
        },
      },
    }),
  ];
}
```

### Attachment Handling (HoverEditor.tsx)
When files are dropped, they go to the "첨부파일" (Attachments) section:
1. Find or create "첨부파일" heading
2. If collapsed, expand it first
3. Find the LAST element in the section
4. If it's a bulletList, append to it
5. Otherwise, create a new bulletList at section end

### CSS for Collapsed Content
```css
.heading-collapsed-content {
  display: none !important;
}
```

## Release Workflow
1. Update version in: `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`
2. Commit and push changes
3. Create and push tag: `git tag v1.x.x && git push origin v1.x.x`
4. GitHub Actions builds and creates release automatically

## Common Issues & Solutions

### Table Cell Focus Not Visible with Background Color
Use CSS `::after` pseudo-element overlay:
```css
.tiptap-editor .selectedCell::after {
  content: '';
  position: absolute;
  inset: 0;
  background: rgba(122, 162, 247, 0.3);
  pointer-events: none;
  z-index: 1;
}
```

### Context Menu Submenu Gap
When submenu opens to the left, increase overlap to prevent gap:
```typescript
x: openLeft ? rect.left - submenuWidth + 12 : rect.right - 4
```

### Blank Lines When Inserting Content
Use direct `tr.insert()` instead of `insertContentAt()`:
```typescript
editor.chain()
  .focus()
  .command(({ tr, state }) => {
    const node = state.schema.nodeFromJSON({ type: 'bulletList', content: [...] });
    tr.insert(position, node);
    return true;
  })
  .run();
```

## i18n
Translations are in `src/utils/i18n.ts`. Support for Korean (ko) and English (en).

## Document Preview System (v1.3.0+)

### Architecture
Office documents (doc/docx/ppt/pptx/xls/xlsx/hwp/hwpx) are previewed via a two-stage pipeline:
1. **Rust backend** (`lib.rs`): LibreOffice headless converts documents to PDF with mtime-based caching
2. **React frontend**: `HoverDocumentViewer.tsx` renders the cached PDF via `<iframe>`

### Rust Backend (`src-tauri/src/lib.rs`)
- `detect_libreoffice_path()` — scans Program Files paths + `where soffice.exe`
- `convert_to_preview_pdf` — Tauri command, cache key = `{path_hash}_{mtime}.pdf` in `%LOCALAPPDATA%\Notology\preview_cache\`
- `check_preview_engine` — returns `{ available, engine, path }` for UI feedback
- `cleanup_preview_cache` — removes old cached PDFs by max age

### Frontend Components
- `HoverDocumentViewer.tsx` — conversion state machine: idle → converting (spinner) → ready (iframe) / error (retry button)
- `previewCommands` in `tauriCommands.ts` — IPC wrappers for preview Tauri commands

### File Type Detection — TWO CODE PATHS (Critical!)
When opening files from wikilinks/attachments, there are **two separate code paths**:
1. **DOM overlay mode** (single-window): `hoverStore.ts` → `detectFileType()` → `openHoverFile()`
2. **Multi-window mode** (separate OS window): `HoverWindowApp.tsx` → `getFileType()` → renders viewer

**Both** must include document extension detection. Missing it in either path causes documents to open as TipTap editors instead of the document viewer.

### isPreviewable Regex (5 files)
The regex that determines if a file opens in internal viewer vs default app exists in:
- `ContextMenu.tsx`, `HoverEditor.tsx`, `Search.tsx`, `CanvasEditor.tsx`, `ContainerView.tsx`

All must include `|doc|docx|ppt|pptx|xls|xlsx|hwp|hwpx` alongside pdf/image extensions.

### Current Strategy & Limitations
- **LibreOffice dependency**: Required externally (not bundled). Shows error UI with "Open in app" fallback button when not installed.
- **Legacy formats** (doc/ppt/xls/hwp): These are complex binary formats. A future strategy may open them directly in the default app instead of attempting preview.
- **Modern formats** (docx/xlsx/pptx/hwpx): Could potentially be rendered with JS libraries (mammoth.js for docx, xlsx for spreadsheets) without LibreOffice dependency. This is under consideration.
- **PDF/Image**: Rendered natively via `<iframe>` / `<img>` with `convertFileSrc()` (Tauri asset protocol)

### WebView2 PDF Rendering
`<embed type="application/pdf">` does NOT work in WebView2 (Tauri's Windows renderer). Use `<iframe>` instead.

## Editor Performance (v1.3.0+)

### Editor Pool (`utils/editorPool.ts`)
- Pre-warms TipTap editor instances for instant note switching
- Pool reuses editors to avoid costly initialization on each note open

### Content Cache (`stores/zustand/contentCacheStore.ts`)
- Caches recently viewed note content in memory
- Reduces filesystem reads when re-opening notes

## Synology NAS Compatibility

### Rename Retry Logic (`RenameDialog.tsx`, `lib.rs`)
- Synology Drive can hold file locks briefly during sync
- `rename_with_retry` in Rust: retries rename up to 3 times with delays
- Frontend rollback: if rename fails after retries, reverts to original name

## Version History
- v1.3.1: Wikilink fix, modal redesign, time selector, legacy format handling
- v1.3.0: Document preview system, editor performance, Synology sync, tag UI improvements
- v1.2.1: Heading/CodeBlock fold/unfold, HR delete button, table cell colors, attachment fixes
- v1.2.0: Dark/light mode polish, i18n, graph contrast
- v1.1.x: Synology NAS sync, conflict prevention
