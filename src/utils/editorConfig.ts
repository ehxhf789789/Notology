import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import { Markdown } from 'tiptap-markdown';
import Highlight from '@tiptap/extension-highlight';
import Subscript from '@tiptap/extension-subscript';
import Superscript from '@tiptap/extension-superscript';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import { Table, TableRow, TableHeader } from '@tiptap/extension-table';
import TableCellWithColor from '../extensions/TableCellWithColor';
// Underline is included in StarterKit, no need to import separately
import ItalicCJK from '../extensions/ItalicCJK';
import WikiLink from '../extensions/WikiLink';
import Callout from '../extensions/Callout';
import ParagraphWithIndent from '../extensions/ParagraphWithIndent';
import CommentMarks from '../extensions/CommentMarks';
import LinkCard from '../extensions/LinkCard';
import WikiLinkSuggestion from '../extensions/WikiLinkSuggestion';
import { createWikiLinkSuggestion } from './wikiLinkSuggestion';
import type { FileNode } from '../types';

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
    }),
    ParagraphWithIndent, // Custom paragraph with indent support and markdown serialization
    ItalicCJK, // CJK-aware Italic extension for Korean/Chinese/Japanese
    Highlight,
    Subscript,
    Superscript,
    TaskList,
    TaskItem.configure({ nested: true }),
    Table.configure({ resizable: false }),
    TableRow,
    TableCellWithColor,
    TableHeader,
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
