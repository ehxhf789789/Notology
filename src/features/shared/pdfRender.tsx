/**
 * PDF render pipeline (Stage PDF-v2, 2026-05-19).
 *
 * WYSIWYG strategy per HanBin: render the note through the same TipTap
 * editor stack that the hover window uses, capture the resulting DOM,
 * stitch the page's stylesheets into the print iframe, then call
 * `window.print()`. Result is identical to what the user sees while
 * editing — math, code highlight, callouts, wikilinks, link cards,
 * media embeds — all rendered by their canonical extensions, no
 * piecemeal re-implementations.
 *
 * See `docs/architecture/PDF_EXPORT_ENHANCEMENT_PLAN.md` §H for the
 * design + trade-offs.
 */
import { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { EditorContent } from '@tiptap/react';
import type { Editor } from '@tiptap/core';

import { fileCommands } from '../../core/services/tauriCommands';
import { editorPool } from '../../core/editor/editorPool';
import { fileLookupActions } from '../../core/stores/fileLookupStore';
import { noteTypeCacheActions } from '../content-cache/stores/noteTypeCacheStore';
import { useAttachmentStore } from '../sync_v2/stores/attachmentStore';
import { useFileTreeStore } from '../../core/stores/fileTreeStore';
import { parseFrontmatter } from '../../core/utils/frontmatter';

/* ───────────────────────────── helpers ───────────────────────────── */

/** Wait N animation frames. Used to let React commits + node-view
 *  subtree mounts settle before we read DOM. */
function waitFrames(n: number): Promise<void> {
  return new Promise((resolve) => {
    let remaining = n;
    const step = () => {
      remaining -= 1;
      if (remaining <= 0) resolve();
      else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

/** Wait for all `<img>` descendants inside `root` to complete loading.
 *  Returns immediately for already-loaded or broken images. Caps the wait
 *  at `timeoutMs` so a hung remote image can't block the entire export. */
function waitImages(root: Element, timeoutMs = 5000): Promise<void> {
  const imgs = Array.from(root.querySelectorAll('img'));
  if (imgs.length === 0) return Promise.resolve();
  const pending = imgs.filter((img) => !img.complete);
  if (pending.length === 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let remaining = pending.length;
    const done = () => { remaining -= 1; if (remaining <= 0) resolve(); };
    pending.forEach((img) => {
      img.addEventListener('load', done, { once: true });
      img.addEventListener('error', done, { once: true });
    });
    setTimeout(resolve, timeoutMs);
  });
}

/** Read every cssRule from every same-origin stylesheet on the page and
 *  concatenate as inline CSS. Cross-origin sheets throw on `cssRules`
 *  access — we skip them silently. The harvested payload feeds the print
 *  iframe so it gets the exact cascade the editor renders under. */
function harvestCss(): string {
  const parts: string[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      const rules = sheet.cssRules;
      if (!rules) continue;
      for (const rule of Array.from(rules)) {
        parts.push(rule.cssText);
      }
    } catch {
      // CORS-blocked (rare here — all stylesheets are same-origin in
      // a Vite/Tauri build). Skip.
    }
  }
  return parts.join('\n');
}

/** Inside the captured HTML, swap `<!-- pagebreak -->` HTML comments for
 *  a div the print CSS turns into a hard page break. Markdown comments
 *  survive through tiptap-markdown unchanged (html: true), so this is
 *  the user-facing syntax per Q6. */
function applyPageBreaks(html: string): string {
  return html.replace(
    /<!--\s*pagebreak\s*-->/gi,
    '<div class="pdf-pagebreak" aria-hidden="true"></div>',
  );
}

/* ───────────────────────────── render shell ───────────────────────────── */

interface PdfRenderShellProps {
  editor: Editor;
  body: string;
  onSettled: () => void;
}

/**
 * Tiny React component that mounts `<EditorContent>` and triggers content
 * load + settle callbacks. Kept as a regular component so React's commit
 * lifecycle drives node-view subtree mounting (KaTeX render, LinkCard
 * fetch, MediaEmbed image load, etc.).
 */
function PdfRenderShell({ editor, body, onSettled }: PdfRenderShellProps) {
  useEffect(() => {
    let cancelled = false;
    (async () => {
      // setContent runs synchronously but the rendered node-view subtrees
      // commit on the next React tick. Three RAFs cover: ProseMirror
      // re-render → node view React mount → node view effects (KaTeX).
      editor.commands.setContent(body);
      await waitFrames(3);
      // Then settle inflight assets (images) before we read the DOM.
      if (!cancelled) {
        await waitImages(editor.view.dom);
        await new Promise((r) => setTimeout(r, 250));
      }
      if (!cancelled) onSettled();
    })();
    return () => { cancelled = true; };
  }, [editor, body, onSettled]);

  return <EditorContent editor={editor} />;
}

/* ───────────────────────────── orchestration ───────────────────────────── */

interface CapturedNote {
  /** Outer HTML of the editor's `.ProseMirror` root. */
  html: string;
  /** All same-origin CSS rules concatenated. */
  css: string;
  /** Display title pulled from frontmatter (falls back to filename). */
  title: string;
}

async function renderNoteToHtml(notePath: string): Promise<CapturedNote> {
  const fc = await fileCommands.readFile(notePath);
  const body = (fc.body ?? '').trim();
  const fmRaw = fc.frontmatter ?? '';

  let title = notePath.split(/[/\\]/).pop()?.replace(/\.md$/i, '') ?? 'note';
  if (fmRaw) {
    try {
      const parsed = parseFrontmatter(fmRaw);
      if (parsed.title && typeof parsed.title === 'string') title = parsed.title;
    } catch {
      // Use filename fallback.
    }
  }

  // Live-resolver hookup. These mirror useFileResolution but read from
  // the global stores directly (we have no per-window context here).
  const attStore = useAttachmentStore.getState();
  const vaultPath = useFileTreeStore.getState().vaultPath || '';
  const fileTree = useFileTreeStore.getState().fileTree;

  const editor = editorPool.acquire({
    notePath,
    vaultPath,
    onClickLink: () => {},
    onContextMenu: () => {},
    onEditorContextMenu: () => {},
    onCommentClick: () => {},
    getFileTree: () => fileTree,
    resolveLink: (name: string) => {
      if (attStore.resolveByName(name)) return true;
      return fileLookupActions.resolveNotePath(name) !== null
        || fileLookupActions.resolveAttachmentPath(name) !== null;
    },
    getNoteType: (name: string) => noteTypeCacheActions.getNoteType(name),
    isAttachment: (name: string) => {
      if (attStore.resolveByName(name)) return true;
      return attStore.isPending(name);
    },
    resolveFilePath: (name: string) => {
      const attRef = attStore.resolveByName(name);
      if (attRef && vaultPath) {
        const sep = vaultPath.includes('\\') ? '\\' : '/';
        return vaultPath + sep + attRef.displayPath.replace(/\//g, sep);
      }
      return fileLookupActions.resolveNotePath(name)
        ?? fileLookupActions.resolveAttachmentPath(name);
    },
  });
  if (!editor) throw new Error('editor pool unavailable');

  // Off-screen host. We use `visibility: hidden` instead of `display:none`
  // so the render still produces layout boxes (needed for some node-view
  // effects that read offsetHeight, and for image load events).
  const host = document.createElement('div');
  host.className = 'pdf-export-host';
  host.style.cssText = [
    'position: fixed',
    'left: -100000px',
    'top: 0',
    'width: 800px',
    'visibility: hidden',
    'pointer-events: none',
    'z-index: -1',
  ].join('; ');
  document.body.appendChild(host);

  const root = createRoot(host);

  try {
    // Mount + settle.
    await new Promise<void>((resolve) => {
      root.render(
        <PdfRenderShell editor={editor} body={body} onSettled={resolve} />,
      );
    });

    const html = applyPageBreaks(editor.view.dom.outerHTML);
    const css = harvestCss();
    return { html, css, title };
  } finally {
    // Always clean up — pool MUST get the editor back even on error.
    try { root.unmount(); } catch {}
    try { host.remove(); } catch {}
    try {
      editor.off('update');
      editorPool.release(editor);
    } catch {}
  }
}

/* ─────────────────────── HTML scaffolding + print ─────────────────────── */

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const PDF_PRINT_OVERRIDES = `
/* Print-only overrides layered on top of the harvested editor CSS. The
   harvested rules carry screen-mode editor chrome (selection rings,
   focus outlines, drop-zone highlights, etc.) which look weird in a
   static document — neutralise the worst offenders here. */
@page { margin: 18mm 16mm; size: auto; }
html, body {
  margin: 0;
  padding: 0;
  background: #ffffff !important;
  color: #1a1a1a;
}
body {
  font-family: -apple-system, "Apple SD Gothic Neo", "Malgun Gothic",
               "Noto Sans KR", "Segoe UI", system-ui, sans-serif;
  font-size: 12pt;
  line-height: 1.6;
}
.pdf-doc {
  max-width: 100%;
  padding: 0;
  background: transparent;
}
.pdf-doc-title {
  font-size: 20pt;
  font-weight: 700;
  margin: 0 0 0.6em;
  padding: 0 0 0.3em;
  border-bottom: 2px solid #1a1a1a;
  color: #1a1a1a;
}
.pdf-pagebreak {
  display: block;
  page-break-before: always;
  break-before: page;
  height: 0;
  margin: 0;
}
/* The ProseMirror root carries editing UI classes — strip the screen-only
   bits that don't belong in a static document. */
.ProseMirror {
  outline: none !important;
  caret-color: transparent !important;
  min-height: 0 !important;
  padding: 0 !important;
  background: transparent !important;
  color: inherit;
}
.ProseMirror ::selection,
.ProseMirror::selection { background: transparent !important; }
.ProseMirror .ProseMirror-gapcursor,
.ProseMirror .ProseMirror-widget,
.ProseMirror-dropcursor,
.ProseMirror-selectednode { display: none !important; }
/* Toolbars, bubble menus, suggestion popovers — none of these should
   ever appear in print, but they sometimes slip in via portals. */
.tippy-box, .floating-ui, .bubble-menu, .slash-command-popover,
.wiki-link-suggestion, .attachment-suggestion-popover { display: none !important; }
img { max-width: 100%; page-break-inside: avoid; }
h1, h2, h3, h4, h5, h6 { page-break-after: avoid; }
table, pre, blockquote { page-break-inside: avoid; }
/* Hide cursor + selection chrome inside any in-document editor on the
   host page (shouldn't render anyway — iframe is isolated — but defensive). */
@media print {
  body * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
}
`;

function buildPrintDocument(captured: CapturedNote): string {
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(captured.title)}</title>
<meta name="author" content="Notology" />
<style>
${captured.css}
${PDF_PRINT_OVERRIDES}
</style>
</head>
<body>
<div class="pdf-doc">
  <h1 class="pdf-doc-title">${escapeHtml(captured.title)}</h1>
  ${captured.html}
</div>
</body>
</html>`;
}

/* ─────────────────────────────── public API ─────────────────────────────── */

/** Render the note through the live editor stack, then print it via the
 *  OS's PDF printer through a hidden iframe. Resolves when the print
 *  dialog has been dismissed (or the watchdog timeout fires). */
export async function renderAndPrintPdf(notePath: string): Promise<void> {
  const captured = await renderNoteToHtml(notePath);
  const docHtml = buildPrintDocument(captured);

  await new Promise<void>((resolve) => {
    const iframe = document.createElement('iframe');
    iframe.style.cssText = 'position:fixed; right:0; bottom:0; width:0; height:0; border:0;';
    iframe.setAttribute('aria-hidden', 'true');
    // Title fallback for the print dialog's default filename.
    iframe.title = captured.title;
    // Same-origin srcdoc — needed for `cssRules` from harvested sheets
    // to apply without re-fetch.
    iframe.srcdoc = docHtml;

    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      setTimeout(() => {
        try { iframe.remove(); } catch {}
        resolve();
      }, 0);
    };

    iframe.onload = () => {
      const win = iframe.contentWindow;
      if (!win) { cleanup(); return; }
      win.addEventListener('afterprint', cleanup, { once: true });
      const watchdog = setTimeout(cleanup, 60_000);
      win.addEventListener('afterprint', () => clearTimeout(watchdog), { once: true });
      // Tiny defer so the iframe completes its font/layout pass.
      setTimeout(() => {
        try { win.focus(); win.print(); } catch (err) {
          console.warn('[pdfRender] print() failed:', err);
          cleanup();
        }
      }, 100);
    };

    document.body.appendChild(iframe);
  });
}
