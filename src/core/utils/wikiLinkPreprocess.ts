import { preprocessCardLinks } from './cardlinkPreprocess';

/**
 * WikiLink Pre-processor
 *
 * Converts wiki-link markdown syntax to HTML spans BEFORE tiptap-markdown
 * parses the content. This prevents markdown from mangling wikilink content
 * (e.g., converting underscores to italics, escaping brackets).
 *
 * Problem: When markdown like [[file_name_here.hwp]] is parsed by tiptap-markdown,
 * the underscores get interpreted as italic markers, breaking the wikilink.
 *
 * Solution: Convert [[...]] to <span data-wiki-link="...">...</span> before parsing.
 */

/**
 * Restore underscores from markdown emphasis markers in wikilink content.
 *
 * Markdown processing converts:
 * - _text_ to *text* (italic markers)
 * - __text__ to **text** (bold markers)
 *
 * Since * is invalid in Windows filenames, we can safely convert back.
 * This handles various edge cases:
 * - (prefix)*SomeText*(suffix) -> (prefix)_SomeText_(suffix)
 * - prefix**bold**suffix -> prefix__bold__suffix
 */
function restoreUnderscoresFromAsterisks(content: string): string {
  let result = content;

  // First handle bold: **text** -> __text__
  // Match **text** where text is non-empty
  result = result.replace(/\*\*([^*]+)\*\*/g, '__$1__');

  // Then handle italic: *text* -> _text_
  // Match *text* patterns where text is non-empty and doesn't start/end with space
  // Be careful not to match already-processed double asterisks
  result = result.replace(/(?<!\*)\*([^\s*][^*]*[^\s*])\*(?!\*)/g, '_$1_')
    // Also handle single character: *X* -> _X_
    .replace(/(?<!\*)\*([^\s*])\*(?!\*)/g, '_$1_');

  return result;
}

/**
 * Extract display text from wikilink content
 * "fileName|displayText" -> { fileName, displayText }
 * "fileName" -> { fileName, displayText: fileName }
 */
function parseWikiLinkContent(content: string): { fileName: string; displayText: string } {
  // First restore underscores from asterisks (fix markdown mangling)
  const fixedContent = restoreUnderscoresFromAsterisks(content);

  const pipeIndex = fixedContent.indexOf('|');
  if (pipeIndex >= 0) {
    return {
      fileName: fixedContent.substring(0, pipeIndex),
      displayText: fixedContent.substring(pipeIndex + 1)
    };
  }
  return { fileName: fixedContent, displayText: fixedContent };
}

/**
 * Escape HTML special characters
 */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Pre-process markdown content to convert wikilinks to HTML spans.
 *
 * Handles:
 * - [[fileName]] -> <span data-wiki-link="fileName">fileName</span>
 * - [[fileName|displayText]] -> <span data-wiki-link="fileName" data-display-text="displayText">displayText</span>
 * - ![[imageName]] -> kept as-is (handled by decoration, but protect from markdown parsing)
 * - Escaped brackets \[\[...\]\] -> converted to normal [[...]] first, then to HTML
 *
 * @param markdown Raw markdown content
 * @returns Processed markdown with wikilinks as HTML spans
 */
export function preprocessWikiLinks(markdown: string): string {
  if (!markdown) return markdown;

  // 🔴 **옵시디언의 ```cardlink``` 를 먼저 링크 박스로 바꾼다** (2026-08-25).
  //    교보재 노트 82개가 그 꼴을 쓰는데 그동안 전부 코드 덩어리로 보였다.
  //    위키링크보다 **먼저** 해야 한다 — 울타리 안의 주소가 마크다운에
  //    씹히기 전에 HTML 로 빠져나가야 하기 때문이다.
  let result = preprocessCardLinks(markdown);

  // Step 1: Fix escaped brackets and characters (from previous broken saves)
  // Handle various escape patterns that markdown might produce:
  // \[\[ -> [[  and  \]\] -> ]]
  // Also handle double-escaped: \\[\\[ -> [[
  result = result.replace(/\\{1,2}\[\\{1,2}\[/g, '[[');
  result = result.replace(/\\{1,2}\]\\{1,2}\]/g, ']]');

  // Unescape common markdown-escaped characters
  // These might appear if markdown processed the wikilink content:
  // \_  -> _  (escaped underscore)
  // \*  -> *  (escaped asterisk - but we'll convert * to _ later)
  // \(  -> (  (escaped parenthesis)
  // \)  -> )
  // \[  -> [  (single escaped bracket - different from wikilink)
  // \]  -> ]
  result = result.replace(/\\_/g, '_');
  result = result.replace(/\\\*/g, '*');
  result = result.replace(/\\\(/g, '(');
  result = result.replace(/\\\)/g, ')');
  result = result.replace(/(?<!\[)\\(\[)(?!\[)/g, '$1');  // \[ but not part of \[\[
  result = result.replace(/(?<!\])\\(\])(?!\])/g, '$1');  // \] but not part of \]\]

  // Step 2: Convert image embeds ![[...]] to protected placeholders
  // We use a unique marker that won't be processed as markdown
  // Also restore underscores from asterisks in the filename
  //
  // 2026-05-24 (HanBin) — char class is `[^\]\n]+`, not `[^\]]+`.
  // Excluding newline prevents a `![[file` missing its closing `]]` from
  // greedy-matching across paragraphs to the next `]]` it finds. That bug
  // produced multi-line placeholders → multi-line HTML span attributes →
  // tiptap-markdown couldn't parse the span → literal `<span data-…">`
  // text bled into the editor → next save persisted the corruption.
  // Wikilinks (Obsidian / Notology) are always single-line; cross-line
  // matches are corruption, not a valid filename.
  const imageEmbedPlaceholders: string[] = [];
  result = result.replace(/!\[\[([^\]\n]+)\]\]/g, (match, content) => {
    const index = imageEmbedPlaceholders.length;
    // Fix asterisks back to underscores in image embed filenames
    imageEmbedPlaceholders.push(restoreUnderscoresFromAsterisks(content));
    return `\u0000IMG_EMBED_${index}\u0000`;
  });

  // Step 3: Handle wikilinks that might have HTML emphasis tags inside
  // If markdown converted _text_ to <em>text</em>, fix it before processing
  // Pattern: [[prefix<em>text</em>suffix]] -> [[prefix_text_suffix]]
  // (2026-05-24 — same single-line guard as Step 2/4: `\n` excluded.)
  result = result.replace(/\[\[([^\]\n]*?)<em>([^<\n]+)<\/em>([^\]\n]*?)\]\]/g, '[[$1_$2_$3]]');
  result = result.replace(/\[\[([^\]\n]*?)<strong>([^<\n]+)<\/strong>([^\]\n]*?)\]\]/g, '[[$1__$2__$3]]');

  // Step 4: Convert wikilinks [[...]] to HTML spans (protects from markdown processing)
  // Use a non-greedy match to handle nested brackets.
  //
  // 2026-05-24 (HanBin) — char class is `[^\]\n]+`, not `[^\]]+`. See the
  // matching comment on Step 2 for the full rationale. In short: allowing
  // newlines here let a `[[file` typed without its closing `]]` absorb
  // every subsequent paragraph up to the next `]]`, producing a span whose
  // `data-wiki-link` attribute spanned multiple lines. tiptap-markdown
  // can't parse multi-line HTML attributes, so the literal opening
  // `<span data-wiki-link="` text bled into the editor.
  result = result.replace(/\[\[([^\]\n]+)\]\]/g, (match, content) => {
    const { fileName, displayText } = parseWikiLinkContent(content);
    // Show underscores as spaces in display text (only when no custom alias)
    const shownText = displayText === fileName
      ? fileName.replace(/_/g, ' ')
      : displayText;

    if (displayText !== fileName) {
      return `<span data-wiki-link="${escapeHtml(fileName)}" data-display-text="${escapeHtml(displayText)}">${escapeHtml(shownText)}</span>`;
    }
    return `<span data-wiki-link="${escapeHtml(fileName)}">${escapeHtml(shownText)}</span>`;
  });

  // Step 5: Restore image embeds
  imageEmbedPlaceholders.forEach((content, index) => {
    result = result.replace(`\u0000IMG_EMBED_${index}\u0000`, `![[${content}]]`);
  });

  // Step 5.5: Convert HTML-fallback math tags back to $...$ / $$...$$ format.
  // tiptap-markdown's HTML fallback serializes math nodes as:
  //   <span data-math-inline data-formula="...">$...$</span>  (with attributes)
  //   <mathInline></mathInline>  (without attributes — data lost)
  // We extract formula from data-formula attribute or inner text.

  // Handle ANY tag with data-math-inline + data-formula (including empty/self-closing)
  result = result.replace(/<[^>]*data-math-inline[^>]*data-formula="([^"]*)"[^>]*(?:\/>|>[^<]*<\/[^>]+>)/g,
    (_m, formula) => formula ? `$${formula}$` : '');
  result = result.replace(/<[^>]*data-formula="([^"]*)"[^>]*data-math-inline[^>]*(?:\/>|>[^<]*<\/[^>]+>)/g,
    (_m, formula) => formula ? `$${formula}$` : '');

  // Handle ANY tag with data-math-block + data-formula
  result = result.replace(/<[^>]*data-math-block[^>]*data-formula="([^"]*)"[^>]*(?:\/>|>[^<]*<\/[^>]+>)/g,
    (_m, formula) => formula ? `$$${formula}$$` : '');
  result = result.replace(/<[^>]*data-formula="([^"]*)"[^>]*data-math-block[^>]*(?:\/>|>[^<]*<\/[^>]+>)/g,
    (_m, formula) => formula ? `$$${formula}$$` : '');

  // Handle bare <mathInline>...</mathInline> tags (no data-formula — truly lost)
  result = result.replace(/<mathInline><\/mathInline>/g, '');
  result = result.replace(/<mathBlock><\/mathBlock>/g, '');

  // Step 6: Convert block math $$...$$ to HTML divs (before inline to avoid conflicts)
  result = result.replace(/\$\$\n?([\s\S]+?)\n?\$\$/g, (_match, formula) => {
    const trimmed = (formula as string).trim();
    if (!trimmed) return _match;
    return `<div data-math-block data-formula="${escapeHtml(trimmed)}">$$${escapeHtml(trimmed)}$$</div>`;
  });

  // Step 7: Convert inline math $...$ to HTML spans
  result = result.replace(/(?<!\$)\$([^$\n]+?)\$(?!\$)/g, (_match, formula) => {
    const trimmed = (formula as string).trim();
    if (!trimmed) return _match;
    return `<span data-math-inline data-formula="${escapeHtml(trimmed)}">$${escapeHtml(trimmed)}$</span>`;
  });

  return result;
}

/**
 * Check if markdown content contains potentially broken wikilinks
 * (escaped brackets or markdown-mangled content)
 */
export function hasEscapedWikiLinks(markdown: string): boolean {
  if (!markdown) return false;
  // Check for escaped brackets
  return /\\\[\\\[/.test(markdown) || /\\\]\\\]/.test(markdown);
}
