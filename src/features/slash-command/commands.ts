import type { Editor, Range } from '@tiptap/core';
import type { SlashCommandItem } from '../../core/editor/extensions/SlashCommand';
import { t, type LanguageSetting } from '../../core/utils/i18n';

/**
 * Slash palette commands (Stage 5.0.4b-1).
 *
 * 1-level flat structure per HanBin Q12. Grouping is conceptual only —
 * filtering uses combined Korean + English keywords. Order = HanBin
 * default ordering (structure first, then inline emphasis, then media,
 * then math/code, then advanced).
 */
export function buildSlashCommands(language: LanguageSetting): SlashCommandItem[] {
  return [
    /* ── Structure ── */
    {
      id: 'h1',
      label: t('slashH1', language),
      icon: 'Heading1',
      keywords: 'h1 heading 제목 헤딩 큰 제목',
      shortcut: ['Ctrl', '1'],
      run: (editor, range) =>
        editor.chain().focus().deleteRange(range).toggleHeading({ level: 1 }).run(),
    },
    {
      id: 'h2',
      label: t('slashH2', language),
      icon: 'Heading2',
      keywords: 'h2 heading 제목',
      shortcut: ['Ctrl', '2'],
      run: (editor, range) =>
        editor.chain().focus().deleteRange(range).toggleHeading({ level: 2 }).run(),
    },
    {
      id: 'h3',
      label: t('slashH3', language),
      icon: 'Heading3',
      keywords: 'h3 heading 소제목',
      shortcut: ['Ctrl', '3'],
      run: (editor, range) =>
        editor.chain().focus().deleteRange(range).toggleHeading({ level: 3 }).run(),
    },
    {
      id: 'bulletList',
      label: t('slashBulletList', language),
      icon: 'List',
      keywords: 'bullet list 글머리 목록 리스트',
      shortcut: ['Ctrl', 'Shift', '8'],
      run: (editor, range) =>
        editor.chain().focus().deleteRange(range).toggleBulletList().run(),
    },
    {
      id: 'orderedList',
      label: t('slashOrderedList', language),
      icon: 'ListOrdered',
      keywords: 'ordered numbered list 번호 목록 순서',
      shortcut: ['Ctrl', 'Shift', '7'],
      run: (editor, range) =>
        editor.chain().focus().deleteRange(range).toggleOrderedList().run(),
    },
    {
      id: 'taskList',
      label: t('slashTaskList', language),
      icon: 'ListChecks',
      keywords: 'task todo checklist 체크 할일 목록',
      shortcut: ['Ctrl', 'Shift', '9'],
      run: (editor, range) =>
        editor.chain().focus().deleteRange(range).toggleTaskList().run(),
    },
    {
      id: 'quote',
      label: t('slashQuote', language),
      icon: 'Quote',
      keywords: 'quote blockquote 인용',
      shortcut: ['Ctrl', 'Shift', 'B'],
      run: (editor, range) =>
        editor.chain().focus().deleteRange(range).toggleBlockquote().run(),
    },
    {
      id: 'divider',
      label: t('slashDivider', language),
      icon: 'Minus',
      keywords: 'divider horizontal rule 구분 가로 hr',
      shortcut: ['Ctrl', 'Shift', '-'],
      run: (editor, range) =>
        editor.chain().focus().deleteRange(range).setHorizontalRule().run(),
    },

    /* ── References / embeds ── */
    {
      id: 'wikiLink',
      label: t('slashWikiLink', language),
      icon: 'Link',
      keywords: 'wiki link 위키 링크 노트 참조',
      // Insert `[[` (which the existing WikiLinkSuggestion will catch and open
      // its file-picker popover). User selects a note from that popover.
      run: (editor, range) =>
        editor.chain().focus().deleteRange(range).insertContent('[[').run(),
    },
    {
      id: 'attachment',
      label: t('slashAttachment', language),
      icon: 'Paperclip',
      keywords: 'attachment file 첨부 파일',
      // For now, dispatch a custom event the editor host can listen to (e.g.
      // HoverEditor opens a file picker + inserts an ![[filename]] atom).
      run: (editor, range) => {
        editor.chain().focus().deleteRange(range).run();
        window.dispatchEvent(new CustomEvent('slash-attachment-requested', {
          detail: { editor },
        }));
      },
    },

    /* ── Code / math ── */
    // v5.2 (2026-05-15) — `/인라인 코드` REMOVED per HanBin: markdown
    // backtick convention (`` `text` ``) is already wired via StarterKit's
    // Code mark InputRule, and Ctrl+E toggles inline code on selected text.
    // A slash command duplicates these established affordances without
    // adding new value, AND the exit-from-mark UX was inherently awkward
    // (storedMarks have no visible affordance, and explicit exit keys
    // conflicted with normal typing). Users now type `` `code` `` directly
    // or select text + Ctrl+E.
    {
      id: 'codeBlock',
      label: t('slashCodeBlock', language),
      icon: 'Code2',
      keywords: 'code block 코드 블록',
      shortcut: ['Ctrl', 'Shift', 'E'],
      run: (editor, range) =>
        editor.chain().focus().deleteRange(range).toggleCodeBlock().run(),
    },
    {
      id: 'mathInline',
      label: t('slashMathInline', language),
      icon: 'Sigma',
      keywords: 'math inline formula 수식 인라인',
      run: (editor, range) => {
        editor.chain().focus().deleteRange(range).run();
        insertMathNode(editor, 'mathInline');
      },
    },
    {
      id: 'mathBlock',
      label: t('slashMathBlock', language),
      icon: 'SquareSigma',
      keywords: 'math block formula 수식 블록',
      run: (editor, range) => {
        editor.chain().focus().deleteRange(range).run();
        insertMathNode(editor, 'mathBlock');
      },
    },

    /* ── Callout (Stage 5.0.4b-5: 2026-05-15) — flat list per HanBin Q12 ── */
    {
      id: 'calloutInfo',
      label: t('slashCalloutInfo', language),
      icon: 'Info',
      keywords: 'callout info 정보 콜아웃',
      run: (editor, range) =>
        editor.chain().focus().deleteRange(range).setCallout('info').run(),
    },
    {
      id: 'calloutWarning',
      label: t('slashCalloutWarning', language),
      icon: 'AlertTriangle',
      keywords: 'callout warning 경고 콜아웃 주의',
      run: (editor, range) =>
        editor.chain().focus().deleteRange(range).setCallout('warning').run(),
    },
    {
      id: 'calloutError',
      label: t('slashCalloutError', language),
      icon: 'AlertOctagon',
      keywords: 'callout error 오류 콜아웃',
      run: (editor, range) =>
        editor.chain().focus().deleteRange(range).setCallout('error').run(),
    },
    {
      id: 'calloutSuccess',
      label: t('slashCalloutSuccess', language),
      icon: 'CheckCircle',
      keywords: 'callout success 성공 콜아웃 체크',
      run: (editor, range) =>
        editor.chain().focus().deleteRange(range).setCallout('success').run(),
    },
    {
      id: 'calloutNote',
      label: t('slashCalloutNote', language),
      icon: 'StickyNote',
      keywords: 'callout note 참고 콜아웃 메모',
      run: (editor, range) =>
        editor.chain().focus().deleteRange(range).setCallout('note').run(),
    },
    {
      id: 'calloutTip',
      label: t('slashCalloutTip', language),
      icon: 'Lightbulb',
      keywords: 'callout tip 팁 콜아웃',
      run: (editor, range) =>
        editor.chain().focus().deleteRange(range).setCallout('tip').run(),
    },

    /* ── Table (Stage 5.0.4b-5) — default 3x2, expand via TipTap table commands ── */
    {
      id: 'table',
      label: t('slashTable', language),
      icon: 'Table',
      keywords: 'table 표 테이블',
      run: (editor, range) =>
        editor.chain().focus().deleteRange(range).insertTable({ rows: 2, cols: 3, withHeaderRow: true }).run(),
    },
  ];
}

/** Insert an empty math atom node and open its edit popup. */
function insertMathNode(editor: Editor, nodeType: 'mathInline' | 'mathBlock') {
  const type = editor.schema.nodes[nodeType];
  if (!type) {
    console.warn(`[slash-command] ${nodeType} node missing from schema`);
    return;
  }
  const node = type.create({ formula: '' });
  const tr = editor.state.tr.replaceSelectionWith(node);
  const insertedPos = tr.selection.from - 1;
  editor.view.dispatch(tr);

  // Open the math edit popup (MathExtension exposes _mathStartEdit on the
  // DOM node — same mechanism that double-click uses).
  setTimeout(() => {
    try {
      const domNode = editor.view.nodeDOM(insertedPos) as HTMLElement | null;
      if (!domNode) return;
      const startEdit = (domNode as unknown as { _mathStartEdit?: () => void })._mathStartEdit;
      if (startEdit) startEdit();
      else domNode.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    } catch (e) {
      console.warn('[slash-command] failed to open math edit popup:', e);
    }
  }, 50);
}

/** Filter commands by query — substring match on label + keywords. */
export function filterCommands(items: SlashCommandItem[], query: string): SlashCommandItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter((it) => {
    const hay = (it.label + ' ' + (it.keywords ?? '')).toLowerCase();
    return hay.includes(q);
  });
}
