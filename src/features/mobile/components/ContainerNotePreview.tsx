/**
 * ContainerNotePreview — Lightweight markdown → React renderer
 * for container note descriptions.
 *
 * Renders headings, blockquotes, paragraphs, bold, italic, links,
 * wiki-links, lists, and inline code WITHOUT loading TipTap.
 *
 * Tap triggers onEdit callback for navigation to full editor.
 */

interface Props {
  markdown: string;
  onEdit?: () => void;
  maxLines?: number;
}

interface MdNode {
  type: 'heading' | 'blockquote' | 'paragraph' | 'list' | 'listItem' | 'hr';
  level?: number;
  children?: MdNode[];
  content?: InlineNode[];
  ordered?: boolean;
}

type InlineNode =
  | { type: 'text'; text: string }
  | { type: 'bold'; children: InlineNode[] }
  | { type: 'italic'; children: InlineNode[] }
  | { type: 'code'; text: string }
  | { type: 'link'; href: string; children: InlineNode[] }
  | { type: 'wikilink'; target: string };

/** Parse inline markdown formatting */
function parseInline(text: string): InlineNode[] {
  const nodes: InlineNode[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    // Bold **text**
    const boldMatch = remaining.match(/^\*\*(.+?)\*\*/);
    if (boldMatch) {
      nodes.push({ type: 'bold', children: parseInline(boldMatch[1]) });
      remaining = remaining.slice(boldMatch[0].length);
      continue;
    }

    // Italic *text*
    const italicMatch = remaining.match(/^\*(.+?)\*/);
    if (italicMatch) {
      nodes.push({ type: 'italic', children: parseInline(italicMatch[1]) });
      remaining = remaining.slice(italicMatch[0].length);
      continue;
    }

    // Inline code `text`
    const codeMatch = remaining.match(/^`(.+?)`/);
    if (codeMatch) {
      nodes.push({ type: 'code', text: codeMatch[1] });
      remaining = remaining.slice(codeMatch[0].length);
      continue;
    }

    // Wiki link [[target]]
    const wikiMatch = remaining.match(/^\[\[(.+?)\]\]/);
    if (wikiMatch) {
      nodes.push({ type: 'wikilink', target: wikiMatch[1] });
      remaining = remaining.slice(wikiMatch[0].length);
      continue;
    }

    // Markdown link [text](url)
    const linkMatch = remaining.match(/^\[(.+?)\]\((.+?)\)/);
    if (linkMatch) {
      nodes.push({ type: 'link', href: linkMatch[2], children: parseInline(linkMatch[1]) });
      remaining = remaining.slice(linkMatch[0].length);
      continue;
    }

    // Plain text — consume until next special char
    const nextSpecial = remaining.slice(1).search(/[\*`\[\]]/);
    const end = nextSpecial === -1 ? remaining.length : nextSpecial + 1;
    nodes.push({ type: 'text', text: remaining.slice(0, end) });
    remaining = remaining.slice(end);
  }

  return nodes;
}

/** Parse markdown string into block-level nodes */
function parseMarkdown(md: string): MdNode[] {
  const lines = md.split('\n');
  const nodes: MdNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Empty line → skip
    if (!line.trim()) { i++; continue; }

    // Heading: # ... ######
    const headingMatch = line.match(/^(#{1,6})\s+(.+)/);
    if (headingMatch) {
      nodes.push({
        type: 'heading',
        level: headingMatch[1].length,
        content: parseInline(headingMatch[2]),
      });
      i++;
      continue;
    }

    // Horizontal rule
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      nodes.push({ type: 'hr' });
      i++;
      continue;
    }

    // Blockquote: > ...
    if (line.startsWith('> ')) {
      const bqLines: string[] = [];
      while (i < lines.length && lines[i].startsWith('> ')) {
        bqLines.push(lines[i].slice(2));
        i++;
      }
      nodes.push({
        type: 'blockquote',
        content: parseInline(bqLines.join('\n')),
      });
      continue;
    }

    // Unordered list: - or * or +
    if (/^[-*+]\s+/.test(line)) {
      const items: MdNode[] = [];
      while (i < lines.length && /^[-*+]\s+/.test(lines[i])) {
        items.push({
          type: 'listItem',
          content: parseInline(lines[i].replace(/^[-*+]\s+/, '')),
        });
        i++;
      }
      nodes.push({ type: 'list', ordered: false, children: items });
      continue;
    }

    // Ordered list: 1. 2. etc
    if (/^\d+\.\s+/.test(line)) {
      const items: MdNode[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
        items.push({
          type: 'listItem',
          content: parseInline(lines[i].replace(/^\d+\.\s+/, '')),
        });
        i++;
      }
      nodes.push({ type: 'list', ordered: true, children: items });
      continue;
    }

    // Paragraph (default)
    const paraLines: string[] = [];
    while (i < lines.length && lines[i].trim() && !lines[i].startsWith('#') && !lines[i].startsWith('>') && !/^[-*+]\s+/.test(lines[i]) && !/^\d+\.\s+/.test(lines[i]) && !/^(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i])) {
      paraLines.push(lines[i]);
      i++;
    }
    if (paraLines.length > 0) {
      nodes.push({
        type: 'paragraph',
        content: parseInline(paraLines.join(' ')),
      });
    }
  }

  return nodes;
}

/** Render inline nodes to React elements */
function renderInline(nodes: InlineNode[]): React.ReactNode {
  return nodes.map((node, i) => {
    switch (node.type) {
      case 'text':
        return node.text;
      case 'bold':
        return <strong key={i}>{renderInline(node.children)}</strong>;
      case 'italic':
        return <em key={i}>{renderInline(node.children)}</em>;
      case 'code':
        return <code key={i} className="cnp-code">{node.text}</code>;
      case 'link':
        return <span key={i} className="cnp-link">{renderInline(node.children)}</span>;
      case 'wikilink':
        return <span key={i} className="cnp-wikilink">{node.target}</span>;
    }
  });
}

/** Render block-level nodes */
function renderBlock(node: MdNode, key: number): React.ReactNode {
  switch (node.type) {
    case 'heading': {
      const Tag = `h${Math.min(node.level ?? 1, 6)}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
      return <Tag key={key} className={`cnp-heading cnp-h${node.level}`}>{node.content && renderInline(node.content)}</Tag>;
    }
    case 'blockquote':
      return (
        <blockquote key={key} className="cnp-blockquote">
          {node.content && renderInline(node.content)}
        </blockquote>
      );
    case 'paragraph':
      return <p key={key} className="cnp-paragraph">{node.content && renderInline(node.content)}</p>;
    case 'list':
      const ListTag = node.ordered ? 'ol' : 'ul';
      return (
        <ListTag key={key} className="cnp-list">
          {node.children?.map((item, j) => (
            <li key={j} className="cnp-list-item">{item.content && renderInline(item.content)}</li>
          ))}
        </ListTag>
      );
    case 'hr':
      return <hr key={key} className="cnp-hr" />;
    default:
      return null;
  }
}

export function ContainerNotePreview({ markdown, onEdit, maxLines }: Props) {
  const nodes = parseMarkdown(markdown);

  // Optionally limit visible nodes
  const visibleNodes = maxLines ? nodes.slice(0, maxLines) : nodes;
  const truncated = maxLines && nodes.length > maxLines;

  return (
    <div className="cnp-root" onClick={onEdit} role={onEdit ? 'button' : undefined} tabIndex={onEdit ? 0 : undefined}>
      {visibleNodes.map((node, i) => renderBlock(node, i))}
      {truncated && <span className="cnp-more">더보기...</span>}
    </div>
  );
}
