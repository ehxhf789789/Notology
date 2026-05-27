/**
 * Stage 5.0.5a-γ4 (2026-05-16) — TipTap WYSIWYG body editor for templates.
 *
 * Replaces the previous "section-headers list" UI (NoteTemplateEditor.tsx)
 * and the raw textarea (TemplateEditor.tsx) which both forced users to
 * either:
 *   (a) think in section labels only — couldn't write a paragraph
 *   (b) hand-write markdown syntax — `***` separators, `# Heading` etc.
 *
 * HanBin: "만드는 것이 간단하고 직관적이어야 함" → templates should be
 * authored the same way notes are authored.
 *
 * Extension set: a focused subset of the note editor's extensions —
 *   StarterKit + Markdown + Highlight + Underline + TaskList + TextAlign +
 *   HeadingWithAlign + CodeBlockWithHighlight + ParagraphWithIndent +
 *   ItalicCJK + TableKit + Superscript + Subscript
 * Intentionally omitted (need note context callbacks):
 *   WikiLink, MediaEmbed, LinkCard, Math, SlashCommand, ImageEmbed
 * Templates don't reference specific notes, so atoms requiring
 * resolveLink / onClickLink / getFileTree etc. are out of scope here.
 *
 * Variable tokens — clickable buttons above the editor insert
 * `{{title}}`, `{{date}}`, etc. at the cursor. On note creation,
 * `applyTemplateVariables` substitutes them with form values.
 */
import { useEffect, useImperativeHandle, forwardRef, useState, useMemo } from 'react';
import { Plus, Search as SearchIcon, ChevronDown } from 'lucide-react';
import { AnchoredPopover } from '../search/FilterChipBar';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from 'tiptap-markdown';
import Highlight from '@tiptap/extension-highlight';
import Subscript from '@tiptap/extension-subscript';
import Superscript from '@tiptap/extension-superscript';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import TextAlign from '@tiptap/extension-text-align';
import { Table, TableRow } from '@tiptap/extension-table';
import TableCellWithColor from '../../core/editor/extensions/TableCellWithColor';
import TableHeaderWithColor from '../../core/editor/extensions/TableHeaderWithColor';
import CodeBlockWithHighlight from '../../core/editor/extensions/CodeBlockWithHighlight';
import ItalicCJK from '../../core/editor/extensions/ItalicCJK';
import ParagraphWithIndent from '../../core/editor/extensions/ParagraphWithIndent';
import HeadingWithAlign from '../../core/editor/extensions/HeadingWithAlign';
// Stage 5.0.5a-γ5 v3 fix (2026-05-16, HanBin) — HR + Callout were missing
// from the template body editor, so authoring a template body diverged
// from authoring a real note ("구분선을 텍스트로 지정이 안 됨"). Now both
// extensions match the main editor exactly.
import HorizontalRuleNoGap from '../../core/editor/extensions/HorizontalRuleNoGap';
import Callout from '../../core/editor/extensions/Callout';
import Placeholder from '@tiptap/extension-placeholder';
import { createLowlight } from 'lowlight';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import { t } from '../../core/utils/i18n';
import type { LanguageSetting } from '../../core/utils/i18n';
import { TEMPLATE_VAR_CATALOG, TEMPLATE_VAR_CATEGORIES, type TemplateVarSpec } from './templateVarCatalog';

// Lowlight instance — minimal language set for template body code blocks.
// Templates are unlikely to need full syntax highlight; users can expand later.
const lowlight = createLowlight();
lowlight.register('javascript', javascript);
lowlight.register('js', javascript);
lowlight.register('typescript', typescript);
lowlight.register('ts', typescript);
lowlight.register('python', python);
lowlight.register('py', python);

export interface TemplateBodyEditorRef {
  /** Returns the current body as markdown. */
  getMarkdown: () => string;
  /** Insert text at the current cursor position (used by variable chip buttons). */
  insertText: (text: string) => void;
}

interface Props {
  /** Initial body in markdown format. */
  initialMarkdown: string;
  /** Language for the placeholder. */
  language: LanguageSetting;
  /** v10 — optional override for the variable catalog. Defaults to
   *  TEMPLATE_VAR_CATALOG (28 vars across 5 categories). */
  variables?: ReadonlyArray<TemplateVarSpec>;
  /** Stage 5.0.5a-γ5 — fires on every doc change with the current
   *  markdown. Used by the live preview pane (parent component owns the
   *  preview's read-only renderer; the editor here pushes updates). */
  onChange?: (markdown: string) => void;
  /**
   * v19 (2026-05-16, HanBin) — which surface to show.
   *   'both'   — chips + editor (legacy default for any other caller)
   *   'vars'   — chip picker only (editor stays mounted, hidden via CSS)
   *   'editor' — editor only (chip toolbar hidden)
   * The parent (NoteTemplateEditor) drives this from its body sub-tab
   * state so we can split the long "vars + tall editor" column into two
   * focused screens without remounting / losing typed body content.
   */
  viewMode?: 'both' | 'vars' | 'editor';
}

// v10 — default catalog moved to templateVarCatalog.ts (28 vars).

export const TemplateBodyEditor = forwardRef<TemplateBodyEditorRef, Props>(
  function TemplateBodyEditor({ initialMarkdown, language, variables, onChange, viewMode = 'both' }, ref) {
    const editor = useEditor({
      extensions: [
        StarterKit.configure({
          link: false,
          italic: false,
          paragraph: false,
          heading: false,
          codeBlock: false,
          // Disable StarterKit's default HorizontalRule — replaced by
          // HorizontalRuleNoGap below which has Notology's NodeView +
          // `***` / `---` input rules.
          horizontalRule: false,
          // v20.7 — undo history retained for editor lifetime (template
          // editor open). Same rationale as main editor.
          history: {
            depth: 100_000,
            newGroupDelay: 500,
          },
        }),
        Markdown.configure({ html: true, tightLists: true, transformPastedText: true }),
        Placeholder.configure({
          placeholder: t('templateBodyPlaceholder', language),
        }),
        ParagraphWithIndent,
        HeadingWithAlign.configure({ levels: [1, 2, 3, 4, 5, 6] }),
        ItalicCJK,
        Highlight,
        Subscript,
        Superscript,
        TaskList,
        TaskItem.configure({ nested: true }),
        TextAlign.configure({ types: ['heading', 'paragraph'] }),
        Table.configure({ resizable: true }),
        TableRow,
        TableCellWithColor,
        TableHeaderWithColor,
        CodeBlockWithHighlight.configure({ lowlight }),
        HorizontalRuleNoGap,
        Callout,
      ],
      content: '',
      editorProps: {
        attributes: {
          class: 'tiptap-editor template-body-tiptap',
          spellcheck: 'false',
          // 2026-05-25 (HanBin) — exclude from Tab focus chain. See
          // editorPool.ts for the same rule + rationale.
          tabindex: '-1',
        },
      },
      onUpdate: ({ editor: ed }) => {
        if (!onChange) return;
        const md = (ed.storage as any).markdown?.getMarkdown?.();
        if (typeof md === 'string') onChange(md);
      },
    });

    // Set initial content once editor is ready. Markdown extension parses the
    // markdown string into ProseMirror nodes on setContent.
    useEffect(() => {
      if (!editor) return;
      if (initialMarkdown) {
        editor.commands.setContent(initialMarkdown, { emitUpdate: false });
      }
      // Intentionally run once per editor instance — re-running on every
      // initialMarkdown change would clobber user edits.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [editor]);

    useImperativeHandle(ref, () => ({
      getMarkdown: () => {
        if (!editor) return initialMarkdown;
        const md = (editor.storage as any).markdown?.getMarkdown?.();
        return typeof md === 'string' ? md : '';
      },
      insertText: (text: string) => {
        editor?.chain().focus().insertContent(text).run();
      },
    }), [editor, initialMarkdown]);

    const vars = variables ?? TEMPLATE_VAR_CATALOG;
    const varsByCategory = TEMPLATE_VAR_CATEGORIES
      .map(cat => ({ ...cat, entries: vars.filter(v => v.category === cat.id) }))
      .filter(g => g.entries.length > 0);

    // 2026-05-22 — `viewMode` field retained for API back-compat but the
    // body tab now renders full-width editor + variable popover, so the
    // "vars-only" mode collapses to "editor + open popover by default".
    const showEditor = viewMode === 'both' || viewMode === 'editor';

    // Variable picker popover state. 2026-05-22 — replaces the side-by-side
    // chips column. HanBin: "내용이 가리면 상당히 불편하고 심플한 구조가
    // 아니야. IOS 스타일이 적용된게 맞나?" → switched to iOS-native
    // toolbar-button + popover sheet pattern so the editor reclaims full
    // width and the variable picker only steals screen real-estate when
    // explicitly opened.
    const [varsOpen, setVarsOpen] = useState(false);
    const [varsQuery, setVarsQuery] = useState('');

    // 2026-05-22 — Ctrl+scroll text zoom on the body editor. Independent
    // from the hover-window zoom (this state lives only in
    // TemplateBodyEditor; the hover viewer has its own bound to
    // `.hover-editor`). Range clamped 0.6-2.0; one tick = 10%.
    const [bodyZoom, setBodyZoom] = useState(1);
    const handleBodyWheel = (e: React.WheelEvent<HTMLDivElement>) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      e.stopPropagation();
      const delta = e.deltaY > 0 ? -0.1 : 0.1;
      setBodyZoom(z => Math.max(0.6, Math.min(2.0, +(z + delta).toFixed(2))));
    };
    const [collapsedVarsGroups, setCollapsedVarsGroups] = useState<Set<string>>(() => {
      // Default: keep "기본" open (most-used: title/date/year/prefix);
      // other categories collapsed so the picker stays compact.
      const all = new Set(TEMPLATE_VAR_CATEGORIES.map(c => c.id));
      const first = TEMPLATE_VAR_CATEGORIES[0]?.id;
      if (first) all.delete(first);
      return all;
    });
    const isSearchingVars = varsQuery.trim().length > 0;
    const filteredVarsByCategory = useMemo(() => {
      const q = varsQuery.trim().toLowerCase();
      if (!q) return varsByCategory;
      return varsByCategory
        .map(g => ({
          ...g,
          entries: g.entries.filter(v => {
            const label = t(v.labelI18n, language).toLowerCase();
            return v.token.toLowerCase().includes(q) || label.includes(q);
          }),
        }))
        .filter(g => g.entries.length > 0);
    }, [varsByCategory, varsQuery, language]);

    const insertVar = (token: string) => {
      editor?.chain().focus().insertContent(token).run();
      setVarsOpen(false);
      setVarsQuery('');
    };
    const toggleVarsGroup = (id: string) => {
      setCollapsedVarsGroups(prev => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    };

    return (
      <div className="template-body-editor-wrap">
        {/* 2026-05-22 — full-width editor + variable popover toolbar.
            Replaces the side-by-side 200 px chip column. iOS-native
            pattern: editor owns the full panel, picker is a sheet
            opened on demand. */}
        <div className="template-body-editor-toolbar">
          <AnchoredPopover
            open={varsOpen}
            onOpenChange={(next) => {
              setVarsOpen(next);
              if (!next) setVarsQuery('');
            }}
            placement="bottom-start"
            trigger={(refProps) => (
              <button
                type="button"
                className="template-body-vars-trigger"
                aria-label={t('templateBodyVars', language)}
                {...refProps}
              >
                <Plus size={12} strokeWidth={2.5} aria-hidden="true" />
                <span>{t('templateBodyVars', language)}</span>
              </button>
            )}
          >
            <div className="template-body-vars-popover">
              <div className="template-body-vars-popover__search">
                <SearchIcon size={12} strokeWidth={2} aria-hidden="true" />
                <input
                  type="text"
                  value={varsQuery}
                  onChange={(e) => setVarsQuery(e.target.value)}
                  placeholder={t('tplVarSearchPlaceholder', language)}
                  className="template-body-vars-popover__search-input"
                  spellCheck={false}
                  autoFocus
                />
              </div>
              <div className="template-body-vars-popover__list" role="listbox">
                {filteredVarsByCategory.length === 0 && (
                  <div className="template-body-vars-popover__empty">
                    {t('noSearchResultsTemplate', language)}
                  </div>
                )}
                {filteredVarsByCategory.map(group => {
                  const isCollapsed = !isSearchingVars && collapsedVarsGroups.has(group.id);
                  return (
                    <div
                      key={group.id}
                      className={`template-body-vars-popover__group${isCollapsed ? ' is-collapsed' : ''}`}
                    >
                      <button
                        type="button"
                        className="template-body-vars-popover__group-label"
                        onClick={() => toggleVarsGroup(group.id)}
                        aria-expanded={!isCollapsed}
                      >
                        <ChevronDown
                          size={11}
                          strokeWidth={2.5}
                          className="template-body-vars-popover__group-chevron"
                          aria-hidden="true"
                        />
                        <span>{t(group.labelI18n, language)}</span>
                        <span className="template-body-vars-popover__group-count">
                          {group.entries.length}
                        </span>
                      </button>
                      {!isCollapsed && (
                        <div className="template-body-vars-popover__entries">
                          {group.entries.map(v => {
                            const label = t(v.labelI18n, language);
                            const IconComp = v.Icon;
                            const tooltipHint = v.autoFill
                              ? t('tplVarAutoHint', language)
                              : t('tplVarInputHint', language);
                            return (
                              <button
                                type="button"
                                key={v.token}
                                role="option"
                                className={`template-body-vars-popover__row is-${v.autoFill ? 'auto' : 'input'}`}
                                onClick={() => insertVar(v.token)}
                                title={`${label} → ${v.token}  ·  ${tooltipHint}`}
                              >
                                <IconComp size={12} strokeWidth={2} aria-hidden="true" />
                                <span className="template-body-vars-popover__row-label">
                                  {label}
                                </span>
                                <code className="template-body-vars-popover__row-token">
                                  {v.token}
                                </code>
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </AnchoredPopover>
        </div>

        <div
          className="template-body-editor"
          style={{
            display: showEditor ? undefined : 'none',
            // Drives `font-size` of the TipTap content (see CSS rule
            // for `.template-body-editor .template-body-tiptap`).
            ['--body-zoom' as string]: bodyZoom,
          } as React.CSSProperties}
          onWheel={handleBodyWheel}
        >
          <EditorContent editor={editor} />
          {bodyZoom !== 1 && (
            <div
              className="template-body-editor__zoom-badge"
              role="status"
              aria-live="polite"
            >
              {Math.round(bodyZoom * 100)}%
            </div>
          )}
        </div>
      </div>
    );
  },
);

export default TemplateBodyEditor;
