import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import { Markdown } from 'tiptap-markdown';
import Highlight from '@tiptap/extension-highlight';
import Subscript from '@tiptap/extension-subscript';
import Superscript from '@tiptap/extension-superscript';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import TextAlign from '@tiptap/extension-text-align';
import { Table, TableRow } from '@tiptap/extension-table';
import TableCellWithColor from './extensions/TableCellWithColor';
import TableHeaderWithColor from './extensions/TableHeaderWithColor';
import CodeBlockWithHighlight from './extensions/CodeBlockWithHighlight';
import { createLowlight } from 'lowlight';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import css from 'highlight.js/lib/languages/css';
import json from 'highlight.js/lib/languages/json';
import xml from 'highlight.js/lib/languages/xml';
import bash from 'highlight.js/lib/languages/bash';
import sql from 'highlight.js/lib/languages/sql';
import java from 'highlight.js/lib/languages/java';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import go from 'highlight.js/lib/languages/go';
import rust from 'highlight.js/lib/languages/rust';
import ruby from 'highlight.js/lib/languages/ruby';
import php from 'highlight.js/lib/languages/php';
import swift from 'highlight.js/lib/languages/swift';
import kotlin from 'highlight.js/lib/languages/kotlin';
import yaml from 'highlight.js/lib/languages/yaml';
import markdown from 'highlight.js/lib/languages/markdown';
// Underline is included in StarterKit, no need to import separately
import ItalicCJK from './extensions/ItalicCJK';
import WikiLink from './extensions/WikiLink';
import Callout from './extensions/Callout';
import ParagraphWithIndent from './extensions/ParagraphWithIndent';
import HeadingWithAlign from './extensions/HeadingWithAlign';
import CommentMarks from './extensions/CommentMarks';
import LinkCard from './extensions/LinkCard';
import WikiLinkSuggestion from './extensions/WikiLinkSuggestion';
import { MathInline, MathBlock, MathTrigger } from './extensions/MathExtension';
import { MathCursorPlugin } from './extensions/MathCursorPlugin';
import 'katex/dist/katex.min.css';
import { createWikiLinkSuggestion } from '../../features/suggestions/wikiLinkSuggestion';
import type { FileNode } from '../types';

// Create lowlight instance and register languages manually
const lowlight = createLowlight();
lowlight.register('javascript', javascript);
lowlight.register('js', javascript);
lowlight.register('typescript', typescript);
lowlight.register('ts', typescript);
lowlight.register('python', python);
lowlight.register('py', python);
lowlight.register('css', css);
lowlight.register('json', json);
lowlight.register('html', xml);
lowlight.register('xml', xml);
lowlight.register('bash', bash);
lowlight.register('sh', bash);
lowlight.register('shell', bash);
lowlight.register('sql', sql);
lowlight.register('java', java);
lowlight.register('cpp', cpp);
lowlight.register('c++', cpp);
lowlight.register('csharp', csharp);
lowlight.register('cs', csharp);
lowlight.register('go', go);
lowlight.register('rust', rust);
lowlight.register('rs', rust);
lowlight.register('ruby', ruby);
lowlight.register('rb', ruby);
lowlight.register('php', php);
lowlight.register('swift', swift);
lowlight.register('kotlin', kotlin);
lowlight.register('kt', kotlin);
lowlight.register('yaml', yaml);
lowlight.register('yml', yaml);
lowlight.register('markdown', markdown);
lowlight.register('md', markdown);

export interface EditorConfigOptions {
  placeholder: string;
  onClickLink: (name: string) => void;
  onContextMenu: (name: string, pos: { x: number; y: number }, deleteCallback?: () => void) => void;
  resolveLink: (name: string) => boolean;
  getNoteType?: (name: string) => string | null;
  onEditorContextMenu?: (pos: { x: number; y: number }) => void;
  onCommentClick?: (commentId: string) => void;
  // Getter function for fileTree - avoids extension recreation when tree changes
  getFileTree?: () => FileNode[];
  // Check if a file is an attachment (exists in current note's _att folder)
  isAttachment?: (name: string) => boolean;
  // Current note path - needed for ![[image]] embed rendering
  notePath?: string;
  // Resolve fileName to full file path (for preloading on hover)
  resolveFilePath?: (name: string) => string | null;
}

export function getEditorExtensions(options: EditorConfigOptions) {
  return [
    StarterKit.configure({
      link: false, // Disable default link to use LinkCard
      italic: false, // Disable StarterKit's italic to use explicit import
      paragraph: false, // Disable default paragraph to use ParagraphWithIndent
      heading: false, // Disable default heading to use HeadingWithAlign
      codeBlock: false, // Disable default codeBlock to use CodeBlockWithHighlight
    }),
    CodeBlockWithHighlight.configure({ lowlight }),
    ParagraphWithIndent, // Custom paragraph with indent support and markdown serialization
    HeadingWithAlign.configure({ levels: [1, 2, 3, 4, 5, 6] }), // Custom heading with alignment support
    ItalicCJK, // CJK-aware Italic extension for Korean/Chinese/Japanese
    Highlight,
    Subscript,
    Superscript,
    TaskList,
    TaskItem.configure({ nested: true }),
    Table.extend({
      // Override table serialization: if any cell has a background color,
      // serialize as HTML instead of markdown table (which loses cell colors).
      addStorage() {
        return {
          markdown: {
            serialize(state: any, node: any, parent: any) {
              // Check if any cell has a background color
              let hasCellColor = false;
              node.descendants?.((child: any) => {
                if ((child.type.name === 'tableCell' || child.type.name === 'tableHeader') && child.attrs.backgroundColor) {
                  hasCellColor = true;
                  return false; // stop iteration
                }
              });

              if (hasCellColor) {
                // Serialize as HTML to preserve cell background colors
                const { getHTMLFromFragment } = require('@tiptap/core');
                const { Fragment } = require('@tiptap/pm/model');
                const html = getHTMLFromFragment(Fragment.from(node), node.type.schema);
                state.write(html);
                state.closeBlock(node);
              } else {
                // Standard markdown table serialization
                state.inTable = true;
                node.forEach((row: any, _p: any, i: number) => {
                  state.write('| ');
                  row.forEach((col: any, _p2: any, j: number) => {
                    if (j) state.write(' | ');
                    const cellContent = col.firstChild;
                    if (cellContent?.textContent?.trim()) {
                      state.renderInline(cellContent);
                    }
                  });
                  state.write(' |');
                  state.ensureNewLine();
                  if (!i) {
                    const delimiterRow = Array.from({ length: row.childCount }).map(() => '---').join(' | ');
                    state.write(`| ${delimiterRow} |`);
                    state.ensureNewLine();
                  }
                });
                state.closeBlock(node);
                state.inTable = false;
              }
            },
            parse: {},
          },
        };
      },
    }).configure({ resizable: false }),
    TableRow,
    TableCellWithColor,
    TableHeaderWithColor,
    TextAlign.configure({
      types: ['heading', 'paragraph'],
    }),
    // Underline is included in StarterKit
    Callout,
    CommentMarks.configure({
      onCommentClick: options.onCommentClick,
    }),
    WikiLink.configure({
      onClickLink: options.onClickLink,
      onContextMenu: options.onContextMenu,
      resolveLink: options.resolveLink,
      getNoteType: options.getNoteType,
      onEditorContextMenu: options.onEditorContextMenu,
      isAttachment: options.isAttachment,
      getNotePath: () => options.notePath || '',
      resolveFilePath: options.resolveFilePath,
    }),
    ...(options.getFileTree ? [
      WikiLinkSuggestion.configure({
        suggestion: createWikiLinkSuggestion(options.getFileTree),
      }),
    ] : []),
    MathInline,
    MathBlock,
    MathTrigger,
    MathCursorPlugin,
    LinkCard, // Put LinkCard BEFORE Markdown for higher paste priority
    Markdown.configure({
      html: true, // Preserve HTML elements (including indent attributes)
      transformPastedText: false, // Disable markdown's paste transformation
    }),
    Placeholder.configure({
      placeholder: options.placeholder,
    }),
  ];
}
