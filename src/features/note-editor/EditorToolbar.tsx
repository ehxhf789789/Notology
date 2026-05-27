import { memo, useState, useCallback, useEffect, useRef } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import type { Editor } from '@tiptap/react';
import { useSettingsStore, type PaperStyle } from '../../core/stores/settingsStore';
import { t } from '../../core/utils/i18n';
import { modalActions } from '../modals/stores/modalStore';
import TableGridSelector from './TableGridSelector';
import { PaperPatternPopover } from './PaperPatternPopover';

interface EditorToolbarProps {
  editor: Editor | null;
  defaultCollapsed?: boolean;
  /** Round 2 R3 — paper-pattern picker. Omit on sketch notes. */
  paperStyle?: PaperStyle;
  onPaperStyleChange?: (next: PaperStyle) => void;
  vaultPath?: string | null;
}

/* v5.5 (2026-05-16) — HanBin: callout entry-point unification.
   Callout picker (6 types) used to live here, but it duplicates
   `/콜아웃-*` slash commands + right-click context-menu submenu.
   The toolbar is the most-visible surface so its duplication caused
   the worst IA confusion. Slash + context-menu retain callout entry. */

const EditorToolbar = memo(function EditorToolbar({ editor, paperStyle, onPaperStyleChange, vaultPath }: EditorToolbarProps) {
  const language = useSettingsStore(s => s.language);
  const [expanded, setExpanded] = useState(false);
  const [showTableGrid, setShowTableGrid] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Click outside to close.
  //
  // 2026-05-23 (R3 paper-theme fix, HanBin) — earlier this handler collapsed
  // the toolbar whenever the click landed outside `wrapperRef`. The paper
  // pattern AnchoredPopover (and other DS popovers) mount via FloatingPortal
  // at <body> root, which is outside wrapperRef → mousedown on a popover
  // option triggered collapse → trigger unmounted before React's click
  // handler ran → onChange never fired. Treat any element inside a
  // `.ds-popover` (the floating-ui chrome class) as "inside" so popover
  // interactions work.
  useEffect(() => {
    if (!expanded) return;

    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (target.closest('.ds-popover')) return; // popover interaction — ignore
      if (wrapperRef.current && !wrapperRef.current.contains(target)) {
        setExpanded(false);
        setShowTableGrid(false);
      }
    };

    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside);
    }, 0);

    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [expanded]);

  const handleTableInsert = useCallback((rows: number, cols: number) => {
    if (!editor) return;
    editor.chain().focus().insertTable({ rows, cols, withHeaderRow: true }).run();
    setShowTableGrid(false);
  }, [editor]);

  if (!editor) return null;

  return (
    <div
      ref={wrapperRef}
      className={`editor-toolbar-wrapper ${expanded ? 'visible' : ''} ${showTableGrid ? 'dropdown-open' : ''}`}
    >
      {/* Toggle button - expand or collapse */}
      {!expanded ? (
        <button
          className="editor-toolbar-toggle"
          onClick={() => setExpanded(true)}
          title={t('toolbarOpen', language)}
        >
          <ChevronDown size={12} />
        </button>
      ) : (
        <div className="editor-toolbar">
          {/* Collapse button */}
          <button
            className="editor-toolbar-toggle-close"
            onClick={() => { setExpanded(false); setShowCalloutPicker(false); setShowTableGrid(false); }}
            title={t('toolbarClose', language)}
          >
            <ChevronUp size={12} />
          </button>

          {/* Text formatting */}
          <div className="editor-toolbar-group">
            <button
              className={`editor-toolbar-btn ${editor.isActive('bold') ? 'active' : ''}`}
              onClick={() => editor.chain().focus().toggleBold().run()}
              title={`${t('bold', language)} (Ctrl+B)`}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <path d="M15.6 10.79c.97-.67 1.65-1.77 1.65-2.79 0-2.26-1.75-4-4-4H7v14h7.04c2.09 0 3.71-1.7 3.71-3.79 0-1.52-.86-2.82-2.15-3.42zM10 6.5h3c.83 0 1.5.67 1.5 1.5s-.67 1.5-1.5 1.5h-3v-3zm3.5 9H10v-3h3.5c.83 0 1.5.67 1.5 1.5s-.67 1.5-1.5 1.5z"/>
              </svg>
            </button>
            <button
              className={`editor-toolbar-btn ${editor.isActive('italic') ? 'active' : ''}`}
              onClick={() => editor.chain().focus().toggleItalic().run()}
              title={`${t('italic', language)} (Ctrl+I)`}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <path d="M10 4v3h2.21l-3.42 8H6v3h8v-3h-2.21l3.42-8H18V4z"/>
              </svg>
            </button>
            <button
              className={`editor-toolbar-btn ${editor.isActive('strike') ? 'active' : ''}`}
              onClick={() => editor.chain().focus().toggleStrike().run()}
              title={t('strikethrough', language)}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <path d="M10 19h4v-3h-4v3zM5 4v3h5v3h4V7h5V4H5zM3 14h18v-2H3v2z"/>
              </svg>
            </button>
            <button
              className={`editor-toolbar-btn ${editor.isActive('underline') ? 'active' : ''}`}
              onClick={() => editor.chain().focus().toggleUnderline().run()}
              title={`${t('underline', language)} (Ctrl+U)`}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 17c3.31 0 6-2.69 6-6V3h-2.5v8c0 1.93-1.57 3.5-3.5 3.5S8.5 12.93 8.5 11V3H6v8c0 3.31 2.69 6 6 6zm-7 2v2h14v-2H5z"/>
              </svg>
            </button>
            <button
              className={`editor-toolbar-btn ${editor.isActive('highlight') ? 'active' : ''}`}
              onClick={() => editor.chain().focus().toggleHighlight().run()}
              title={t('highlight', language)}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <path d="M15.59 3.59L17 2l5 5-1.59 1.59L15.59 3.59zM12 8l-5 5v4h4l5-5L12 8zm-8 9v3h6l-3-3H4z"/>
              </svg>
            </button>
            <button
              className={`editor-toolbar-btn btn-small ${editor.isActive('subscript') ? 'active' : ''}`}
              onClick={() => editor.chain().focus().toggleSubscript().run()}
              title={t('subscript', language)}
            >
              <span className="toolbar-text-small">X<sub>2</sub></span>
            </button>
            <button
              className={`editor-toolbar-btn btn-small ${editor.isActive('superscript') ? 'active' : ''}`}
              onClick={() => editor.chain().focus().toggleSuperscript().run()}
              title={t('superscript', language)}
            >
              <span className="toolbar-text-small">X<sup>2</sup></span>
            </button>
          </div>

          {/* Headings */}
          <div className="editor-toolbar-group">
            <button
              className={`editor-toolbar-btn ${editor.isActive('heading', { level: 1 }) ? 'active' : ''}`}
              onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
              title={`${t('heading1', language)} (Ctrl+1)`}
            >
              <span className="toolbar-text">H1</span>
            </button>
            <button
              className={`editor-toolbar-btn ${editor.isActive('heading', { level: 2 }) ? 'active' : ''}`}
              onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
              title={`${t('heading2', language)} (Ctrl+2)`}
            >
              <span className="toolbar-text">H2</span>
            </button>
            <button
              className={`editor-toolbar-btn ${editor.isActive('heading', { level: 3 }) ? 'active' : ''}`}
              onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
              title={`${t('heading3', language)} (Ctrl+3)`}
            >
              <span className="toolbar-text">H3</span>
            </button>
          </div>

          {/* Text Alignment.
              v22 (HanBin 2026-05-23) — keyboard shortcuts Ctrl/Cmd+Shift+L
              / E / R wired in editorPool.ts (TextAlign extend); buttons also
              flip to onMouseDown preventDefault + commands.* so they work
              the same way as indent/outdent (focus preserved on click). */}
          <div className="editor-toolbar-group">
            <button
              className={`editor-toolbar-btn ${editor.isActive({ textAlign: 'left' }) ? 'active' : ''}`}
              onMouseDown={e => e.preventDefault()}
              onClick={() => editor.commands.setTextAlign('left')}
              title={`${t('alignLeft', language)} (Ctrl+Shift+L)`}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <path d="M15 15H3v2h12v-2zm0-8H3v2h12V7zM3 13h18v-2H3v2zm0 8h18v-2H3v2zM3 3v2h18V3H3z"/>
              </svg>
            </button>
            <button
              className={`editor-toolbar-btn ${editor.isActive({ textAlign: 'center' }) ? 'active' : ''}`}
              onMouseDown={e => e.preventDefault()}
              onClick={() => editor.commands.setTextAlign('center')}
              title={`${t('alignCenter', language)} (Ctrl+Shift+E)`}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <path d="M7 15v2h10v-2H7zm-4 6h18v-2H3v2zm0-8h18v-2H3v2zm4-6v2h10V7H7zM3 3v2h18V3H3z"/>
              </svg>
            </button>
            <button
              className={`editor-toolbar-btn ${editor.isActive({ textAlign: 'right' }) ? 'active' : ''}`}
              onMouseDown={e => e.preventDefault()}
              onClick={() => editor.commands.setTextAlign('right')}
              title={`${t('alignRight', language)} (Ctrl+Shift+R)`}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <path d="M3 21h18v-2H3v2zm6-4h12v-2H9v2zm-6-4h18v-2H3v2zm6-4h12V7H9v2zM3 3v2h18V3H3z"/>
              </svg>
            </button>
          </div>

          {/* Lists */}
          <div className="editor-toolbar-group">
            <button
              className={`editor-toolbar-btn ${editor.isActive('bulletList') ? 'active' : ''}`}
              onClick={() => {
                if (editor.isActive('codeBlock')) {
                  modalActions.showAlertModal(t('codeBlockWarningTitle', language), t('codeBlockWarningMessage', language));
                  return;
                }
                editor.chain().focus().toggleBulletList().run();
              }}
              title={t('bulletList', language)}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <path d="M4 10.5c-.83 0-1.5.67-1.5 1.5s.67 1.5 1.5 1.5 1.5-.67 1.5-1.5-.67-1.5-1.5-1.5zm0-6c-.83 0-1.5.67-1.5 1.5S3.17 7.5 4 7.5 5.5 6.83 5.5 6 4.83 4.5 4 4.5zm0 12c-.83 0-1.5.68-1.5 1.5s.68 1.5 1.5 1.5 1.5-.68 1.5-1.5-.67-1.5-1.5-1.5zM7 19h14v-2H7v2zm0-6h14v-2H7v2zm0-8v2h14V5H7z"/>
              </svg>
            </button>
            <button
              className={`editor-toolbar-btn ${editor.isActive('orderedList') ? 'active' : ''}`}
              onClick={() => {
                if (editor.isActive('codeBlock')) {
                  modalActions.showAlertModal(t('codeBlockWarningTitle', language), t('codeBlockWarningMessage', language));
                  return;
                }
                editor.chain().focus().toggleOrderedList().run();
              }}
              title={t('orderedList', language)}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <path d="M2 17h2v.5H3v1h1v.5H2v1h3v-4H2v1zm1-9h1V4H2v1h1v3zm-1 3h1.8L2 13.1v.9h3v-1H3.2L5 10.9V10H2v1zm5-6v2h14V5H7zm0 14h14v-2H7v2zm0-6h14v-2H7v2z"/>
              </svg>
            </button>
            {/* Round 2 R4 (2026-05-22) — checklist/taskList button removed per
                user request. TaskList extension itself stays loaded so existing
                checklist content in .md files still renders, but no UI entry
                creates new ones. */}
          </div>

          {/* Block elements */}
          <div className="editor-toolbar-group">
            <button
              className={`editor-toolbar-btn ${editor.isActive('blockquote') ? 'active' : ''}`}
              onClick={() => editor.chain().focus().toggleBlockquote().run()}
              title={t('blockquote', language)}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <path d="M6 17h3l2-4V7H5v6h3zm8 0h3l2-4V7h-6v6h3z"/>
              </svg>
            </button>
            <button
              className={`editor-toolbar-btn ${editor.isActive('codeBlock') ? 'active' : ''}`}
              onClick={() => editor.chain().focus().toggleCodeBlock().run()}
              title={t('codeBlock', language)}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <path d="M9.4 16.6L4.8 12l4.6-4.6L8 6l-6 6 6 6 1.4-1.4zm5.2 0l4.6-4.6-4.6-4.6L16 6l6 6-6 6-1.4-1.4z"/>
              </svg>
            </button>
            <button
              className="editor-toolbar-btn"
              onClick={() => editor.chain().focus().setHorizontalRule().run()}
              title={t('horizontalRule', language)}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <rect x="2" y="11" width="20" height="2"/>
              </svg>
            </button>
          </div>

          {/* Table */}
          <div className="editor-toolbar-group">
            <div className="editor-toolbar-dropdown-wrapper">
              <button
                className={`editor-toolbar-btn ${editor.isActive('table') ? 'active' : ''}`}
                onClick={() => { setShowTableGrid(!showTableGrid); setShowCalloutPicker(false); }}
                title={t('insertTable', language)}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M3 3v18h18V3H3zm8 16H5v-6h6v6zm0-8H5V5h6v6zm8 8h-6v-6h6v6zm0-8h-6V5h6v6z"/>
                </svg>
              </button>
              {showTableGrid && (
                <TableGridSelector
                  onSelect={handleTableInsert}
                  onClose={() => setShowTableGrid(false)}
                />
              )}
            </div>
          </div>

          {/* Indent / Outdent.
              2026-05-23 (HanBin) v2 — earlier version called
              editor.commands.indent() / outdent() for non-list paragraphs,
              but those commands don't exist (IndentExtension was never
              loaded; only ParagraphWithIndent is loaded, which only
              registers setFirstLineIndent / setHangingIndent). The Tab key
              path uses the latter, so we mirror the Tab key here for
              behavioral parity. onMouseDown.preventDefault keeps the
              editor focused so the command runs on the real selection. */}
          <div className="editor-toolbar-group">
            <button
              className="editor-toolbar-btn"
              onMouseDown={e => e.preventDefault()}
              onClick={() => {
                if (editor.isActive('listItem')) {
                  editor.commands.sinkListItem('listItem');
                } else if (editor.isActive('taskItem')) {
                  editor.commands.sinkListItem('taskItem');
                } else {
                  editor.commands.setFirstLineIndent();
                }
              }}
              title={`${t('indent', language)} (Tab)`}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <path d="M3 21h18v-2H3v2zM3 8v8l4-4-4-4zm8 9h10v-2H11v2zM3 3v2h18V3H3zm8 6h10V7H11v2zm0 4h10v-2H11v2z"/>
              </svg>
            </button>
            <button
              className="editor-toolbar-btn"
              onMouseDown={e => e.preventDefault()}
              onClick={() => {
                if (editor.isActive('listItem')) {
                  editor.commands.liftListItem('listItem');
                } else if (editor.isActive('taskItem')) {
                  editor.commands.liftListItem('taskItem');
                } else {
                  editor.commands.setHangingIndent();
                }
              }}
              title={`${t('outdent', language)} (Shift+Tab)`}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <path d="M11 17h10v-2H11v2zm-8-5l4 4V8l-4 4zm0 9h18v-2H3v2zM3 3v2h18V3H3zm8 6h10V7H11v2zm0 4h10v-2H11v2z"/>
              </svg>
            </button>
          </div>

          {/* Round 2 R3 — paper pattern picker on the right edge */}
          {onPaperStyleChange && paperStyle && (
            <div className="editor-toolbar-group editor-toolbar-group--end">
              <PaperPatternPopover
                value={paperStyle}
                onChange={onPaperStyleChange}
                language={language}
                vaultPath={vaultPath ?? null}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
});

export default EditorToolbar;
