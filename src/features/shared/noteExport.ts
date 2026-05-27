/**
 * Note Export — Convert notes to shareable formats.
 *
 * - Markdown: clean (frontmatter stripped) body text.
 * - Plain text: markdown syntax stripped.
 * - PDF: renders through the live TipTap editor stack so the output
 *   matches the hover-window view (math, code highlight, callouts,
 *   wikilinks, link cards, media embeds, tables, etc.). Implementation
 *   lives in `pdfRender.tsx`; see plan §H for the design.
 */
import { fileCommands } from '../../core/services/tauriCommands';

/** Export note as clean Markdown (frontmatter removed). */
export async function exportAsMarkdown(notePath: string): Promise<string> {
  const content = await fileCommands.readFile(notePath);
  // Return body only (frontmatter is already separated by readFile)
  return content.body.trim();
}

/** Export note as plain text (markdown syntax stripped). */
export async function exportAsText(notePath: string): Promise<string> {
  const md = await exportAsMarkdown(notePath);
  return stripMarkdown(md);
}

/**
 * Export note as PDF. Delegates to the live-render pipeline in
 * `pdfRender.tsx` so the visual exactly matches a hover-window render —
 * piecemeal markdown→HTML conversion would always lag behind editor
 * extensions; this approach inherits them.
 */
export async function exportAsPdf(notePath: string): Promise<void> {
  const { renderAndPrintPdf } = await import('./pdfRender');
  await renderAndPrintPdf(notePath);
}

/** Strip basic markdown syntax from text. */
function stripMarkdown(md: string): string {
  return md
    // Remove headings
    .replace(/^#{1,6}\s+/gm, '')
    // Remove bold/italic
    .replace(/(\*{1,3}|_{1,3})(.*?)\1/g, '$2')
    // Remove inline code
    .replace(/`([^`]+)`/g, '$1')
    // Remove code blocks
    .replace(/```[\s\S]*?```/g, '')
    // Remove links, keep text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    // Remove wikilinks, keep text
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, link, alias) => alias || link)
    // Remove images
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    // Remove blockquotes
    .replace(/^>\s*/gm, '')
    // Remove horizontal rules
    .replace(/^[-*_]{3,}\s*$/gm, '')
    // Remove list markers
    .replace(/^[\s]*[-*+]\s+/gm, '')
    .replace(/^[\s]*\d+\.\s+/gm, '')
    // Collapse multiple blank lines
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
