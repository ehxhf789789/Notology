# Notology - Claude Code Project Guide

## ⚠️ 아키텍처 원칙 (모든 작업 전 필독)

### 폴더 책임
- `src/core/` : 편집기, 파일트리, 검색, 그래프 — Notology의 본관
- `src/features/{name}/` : sync, mobile, ai, export 등 — 독립 부설 모듈
- `src-tauri/src/core/` : 파일 I/O, 검색 인덱스, 볼트 관리
- `src-tauri/src/features/{name}/` : 동기화, 내보내기 등 부가 기능

### 황금 규칙
1. Core 파일을 직접 수정하지 않는다
   새 기능 때문에 Editor.tsx, FileTree.tsx 등을 건드리는 순간 설계가 무너진다
2. Feature → Core 방향으로만 참조한다
   Core가 Feature를 import하면 안 된다
3. 통신은 EventBus로만 한다
```typescript
   // Core: 이벤트 발행만
   EventBus.emit('file:saved', { path, content })

   // Feature: 이벤트 구독
   EventBus.on('file:saved', ({ path }) => syncToNas(path))
```
4. 새 기능 추가 시 체크리스트
   - [ ] src/features/{name}/ 폴더 생성했는가
   - [ ] Core 파일을 수정하지 않았는가
   - [ ] 이 Feature를 삭제해도 앱이 정상 작동하는가

### 금지 패턴
```typescript
// ❌ 금지: Core 컴포넌트 안에 feature 코드 삽입
// Editor.tsx
const handleSave = async () => {
  await saveFile(content)
  await webdavSync(content)  // ← 금지
}

// ✅ 허용: Feature가 Core 이벤트를 구독
// features/sync/SyncModule.ts
EventBus.on('file:saved', async ({ path }) => {
  await webdavSync(path)
})
```

### 현재 Feature 모듈 목록
- `features/sync/` : WebDAV 기반 NAS 동기화 (구현 예정)
- `features/mobile/` : 모바일 전용 UI 레이어 (구현 예정)
- `features/export/` : PDF/HTML/Docx 내보내기 (구현 예정)
- `features/ai/` : AI 제안 기능 (구현 예정)

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

## Architecture (v2.1+)

### Modular Architecture
The codebase follows a Core + Features architecture:
- **Core** (`src/core/`): Platform essentials — removing a feature must NOT break core
- **Features** (`src/features/`): Independent modules — each can be removed without affecting core
- **Communication**: Core ↔ Feature via Zustand stores (frontend) and Tauri Commands (backend)

### Path Aliases (tsconfig + vite)
```
@core/*      → src/core/*
@features/*  → src/features/*
@services/*  → src/core/services/*
```
New code SHOULD use these aliases. Existing code uses relative paths (both work).

### Frontend Directory Structure
```
src/
├── core/                    # Barrel re-exports to original files
│   ├── app/                 # App.tsx, HoverWindowApp.tsx
│   ├── editor/              # editorConfig, editorPool, editorSaveRegistry
│   ├── stores/              # fileTreeStore, uiStore, settingsStore, refreshStore, etc.
│   ├── services/            # tauriCommands (fileCommands, noteCommands, etc.)
│   ├── layout/              # TitleBar, Sidebar, RightPanel, RibbonBar
│   ├── hooks/               # useDragDrop, useAppKeyboardShortcuts, useModalListeners
│   └── utils/               # i18n, frontmatter, shortcuts, multiWindow, windowSync, etc.
├── features/                # Independent feature modules (barrel re-exports)
│   ├── note-editor/         # ContainerView, EditorToolbar, useContentLoader
│   ├── hover-windows/       # hoverStore, HoverEditor, all viewers (docx/pptx/hwpx/xlsx)
│   ├── search/              # Search, SearchFilters, SearchResultItem
│   ├── canvas/              # CanvasEditor, useCanvasInteraction
│   ├── tags/                # tagOntologyUtils, TagPanel, FacetedTagEditor
│   ├── metadata/            # YamlEditor, useFrontmatter
│   ├── comments/            # CommentPanel, useNoteComments
│   ├── templates/           # templateStore, TemplateEditor, templates
│   ├── graph/               # GraphView
│   ├── calendar/            # Calendar
│   ├── context-menu/        # ContextMenu
│   ├── vault-config/        # vaultConfigStore, VaultSelector, VaultLockModal
│   ├── content-cache/       # contentCacheStore, noteTypeCacheStore
│   ├── modals/              # modalStore, all input/action modals
│   ├── settings/            # Settings, KeyboardShortcuts
│   ├── suggestions/         # wikiLinkSuggestion, attachmentSuggestion
│   ├── folder-tree/         # FolderTree
│   └── shared/              # LoadingScreen, ParticipantInput, TagInputSection
├── components/              # Original component files (source of truth)
├── extensions/              # TipTap extensions (source of truth)
├── hooks/                   # Custom React hooks (source of truth)
├── stores/                  # Zustand stores (source of truth)
├── services/                # Tauri command wrappers (source of truth)
└── utils/                   # Utility functions (source of truth)
```

### Backend Directory Structure (Rust)
```
src-tauri/src/
├── lib.rs                   # Module registration + run() (~160 lines)
├── core/
│   ├── types.rs             # Shared structs (FileNode, FileContent, etc.)
│   └── file_io.rs           # Atomic writes, file locks, backup, rename_with_retry
├── features/
│   ├── note.rs              # Note/file CRUD (25 commands)
│   ├── wikilink.rs          # WikiLink rename, backlinks, parallel update
│   ├── attachment.rs        # Attachment search, delete, canvas link detection
│   ├── tags.rs              # Bulk tag add/rename/delete
│   ├── preview.rs           # LibreOffice → PDF, HWP → SVG
│   ├── note_lock.rs         # Per-note editing locks (Synology safe)
│   ├── cache.rs             # Meta cache, batch frontmatter reads
│   ├── comments.rs          # Comments/memos, calendar memos
│   ├── system.rs            # GPU, NAS detection, URL metadata, window management
│   └── search_commands.rs   # Search index init/query/reindex
├── search/                  # Tantivy full-text search engine
├── frontmatter/             # YAML frontmatter parsing
├── memo/                    # Comments/memos indexing
└── vault_lock.rs            # Multi-device vault locking
```

### Migration Strategy
- `src/core/` and `src/features/` contain **barrel re-export files** (index.ts)
- Original source files remain in their current locations
- New features go directly into `src/features/{name}/` with actual source files
- Over time, source files can be physically moved into core/features structure
- The barrel approach ensures zero breakage during incremental migration

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
