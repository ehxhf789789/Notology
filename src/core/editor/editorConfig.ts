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
import { getHTMLFromFragment } from '@tiptap/core';
import { Fragment } from '@tiptap/pm/model';
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
import AttachmentSuggestion from './extensions/AttachmentSuggestion';
import { MathInline, MathBlock, MathTrigger } from './extensions/MathExtension';
import { MathCursorPlugin } from './extensions/MathCursorPlugin';
import { SlashCommand } from './extensions/SlashCommand';
import 'katex/dist/katex.min.css';
import { createWikiLinkSuggestion } from '../../features/suggestions/wikiLinkSuggestion';
import { createAttachmentSuggestion } from '../../features/suggestions/attachmentSuggestion';
import { createSlashCommandSuggestion } from '../../features/slash-command';
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
  /**
   * v20.5 (2026-05-16, HanBin) — override the default `//` attachment-pick
   * behavior. Default inserts a wikilink in the editor; sketch contexts
   * pass an override that creates a CANVAS NODE instead so attachments
   * stay first-class on the sketch surface (not inline references).
   * Receives { editor, range, attachment } and must both clear the
   * trigger text from the editor (via `range`) AND apply its own action.
   */
  onAttachmentPick?: (args: {
    editor: import('@tiptap/core').Editor;
    range: import('@tiptap/core').Range;
    attachment: import('../../features/suggestions/attachmentSuggestion').AttachmentResult;
  }) => void;
  /**
   * v20.21 (2026-05-17, HanBin) — slash-command items to hide. Used by
   * sketch text-node editors to drop items that conflict with sketch
   * UX (e.g. `/위키 링크` types `[[` which is intentionally disabled in
   * sketch context — wikilinks live as canvas nodes there, not inline).
   * Matches SlashCommandItem.id values from features/slash-command/commands.ts.
   */
  slashCommandExclude?: string[];
}

export function getEditorExtensions(options: EditorConfigOptions) {
  return [
    StarterKit.configure({
      link: false, // Disable default link to use LinkCard
      italic: false, // Disable StarterKit's italic to use explicit import
      paragraph: false, // Disable default paragraph to use ParagraphWithIndent
      heading: false, // Disable default heading to use HeadingWithAlign
      codeBlock: false, // Disable default codeBlock to use CodeBlockWithHighlight
      // v20.7 (2026-05-16, HanBin) — undo/redo depth raised to window-
      // lifetime. HanBin: "되돌리기 기억 캐시가 너무 짧음. hover 창이
      // 열려있는 기준으로는 되돌리기 기록이 모두 남아야 함... 모든 노트
      // 에 해당하는 기능". Default depth (100) was capping the history
      // mid-session for any long editing flow. Hover windows have finite
      // lifetime (close → gc) so a high cap is safe. Using a very large
      // number rather than Infinity because TipTap stores history in a
      // ring buffer and accepts only finite ints.
      history: {
        depth: 100_000,
        newGroupDelay: 500,
      },
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
    // v22 (HanBin 2026-05-23) — Ctrl/Cmd+Shift+L/E/R align shortcuts.
    TextAlign.configure({
      types: ['heading', 'paragraph'],
    }).extend({
      addKeyboardShortcuts() {
        return {
          'Mod-Shift-l': () => this.editor.commands.setTextAlign('left'),
          'Mod-Shift-e': () => this.editor.commands.setTextAlign('center'),
          'Mod-Shift-r': () => this.editor.commands.setTextAlign('right'),
        };
      },
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
    // v20.4 (2026-05-16, HanBin) — `//` attachment suggestion. Previously
    // this was only wired into editorPool.ts (main note editor) and was
    // absent from the shared getEditorExtensions(), which meant sketch
    // node text editors didn't get `//` even though they share this same
    // factory. HanBin: "스케치 노트의 노드 내 텍스트 영역은 노트 편집기와
    // 동일하기 때문에, /, //, [[ 기능 구현". Gated on notePath because
    // attachment commands need the host note to file against.
    // v20.5 — optionally takes onAttachmentPick override. Sketch passes
    // one that creates a CANVAS NODE instead of inserting a wikilink.
    ...(options.notePath ? [
      AttachmentSuggestion.configure({
        suggestion: createAttachmentSuggestion({
          getNotePath: () => options.notePath || '',
          onPick: options.onAttachmentPick,
        }),
      }),
    ] : []),
    MathInline,
    MathBlock,
    MathTrigger,
    MathCursorPlugin,
    SlashCommand.configure({
      suggestion: createSlashCommandSuggestion({ excludeIds: options.slashCommandExclude }),
    }),
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
