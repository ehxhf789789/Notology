import { memo, useState, useCallback, useEffect, useRef } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import type { Editor } from '@tiptap/react';
import type { CalloutType } from '../extensions/Callout';
import { useSettingsStore } from '../stores/zustand/settingsStore';
import { t } from '../utils/i18n';
import { modalActions } from '../stores/zustand/modalStore';
import TableGridSelector from './TableGridSelector';

interface EditorToolbarProps {
  editor: Editor | null;
  defaultCollapsed?: boolean;
}

const CALLOUT_TYPES: { type: CalloutType; label: string }[] = [
  { type: 'info', label: 'Info' },
  { type: 'warning', label: 'Warning' },
  { type: 'error', label: 'Error' },
  { type: 'success', label: 'Success' },
  { type: 'note', label: 'Note' },
  { type: 'tip', label: 'Tip' },
];

const EditorToolbar = memo(function EditorToolbar({ editor }: EditorToolbarProps) {
  const language = useSettingsStore(s => s.language);
  const [expanded, setExpanded] = useState(false);
  const [showCalloutPicker, setShowCalloutPicker] = useState(false);
  const [showTableGrid, setShowTableGrid] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Click outside to close
  useEffect(() => {
    if (!expanded) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setExpanded(false);
        setShowCalloutPicker(false);
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

  const handleCallout = useCallback((type: CalloutType) => {
    if (!editor) return;
    editor.chain().focus().toggleCallout(type).run();
    setShowCalloutPicker(false);
  }, [editor]);

  const handleTableInsert = useCallback((rows: number, cols: number) => {
    if (!editor) return;
    editor.chain().focus().insertTable({ rows, cols, withHeaderRow: true }).run();
    setShowTableGrid(false);
  }, [editor]);

  if (!editor) return null;

  return (
    <div
      ref={wrapperRef}
      className={`editor-toolbar-wrapper ${expanded ? 'visible' : ''} ${showCalloutPicker || showTableGrid ? 'dropdown-open' : ''}`}
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

          {/* Text Alignment */}
          <div className="editor-toolbar-group">
            <button
              className={`editor-toolbar-btn ${editor.isActive({ textAlign: 'left' }) ? 'active' : ''}`}
              onClick={() => editor.chain().focus().setTextAlign('left').run()}
              title={t('alignLeft', language)}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <path d="M15 15H3v2h12v-2zm0-8H3v2h12V7zM3 13h18v-2H3v2zm0 8h18v-2H3v2zM3 3v2h18V3H3z"/>
              </svg>
            </button>
            <button
              className={`editor-toolbar-btn ${editor.isActive({ textAlign: 'center' }) ? 'active' : ''}`}
              onClick={() => editor.chain().focus().setTextAlign('center').run()}
              title={t('alignCenter', language)}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <path d="M7 15v2h10v-2H7zm-4 6h18v-2H3v2zm0-8h18v-2H3v2zm4-6v2h10V7H7zM3 3v2h18V3H3z"/>
              </svg>
            </button>
            <button
              className={`editor-toolbar-btn ${editor.isActive({ textAlign: 'right' }) ? 'active' : ''}`}
              onClick={() => editor.chain().focus().setTextAlign('right').run()}
              title={t('alignRight', language)}
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
            <button
              className={`editor-toolbar-btn ${editor.isActive('taskList') ? 'active' : ''}`}
              onClick={() => {
                if (editor.isActive('codeBlock')) {
                  modalActions.showAlertModal(t('codeBlockWarningTitle', language), t('codeBlockWarningMessage', language));
                  return;
                }
                editor.chain().focus().toggleTaskList().run();
              }}
              title={t('checklist', language)}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H5V5h14v14zM17.99 9l-1.41-1.42-6.59 6.59-2.58-2.57-1.42 1.41 4 3.99z"/>
              </svg>
            </button>
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
            <div className="editor-toolbar-dropdown-wrapper">
              <button
                className={`editor-toolbar-btn ${editor.isActive('callout') ? 'active' : ''}`}
                onClick={() => { setShowCalloutPicker(!showCalloutPicker); setShowTableGrid(false); }}
                title={t('callout', language)}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/>
                </svg>
              </button>
              {showCalloutPicker && (
                <div className="editor-toolbar-dropdown">
                  {CALLOUT_TYPES.map(ct => (
                    <button
                      key={ct.type}
                      className="editor-toolbar-dropdown-item"
                      onClick={() => handleCallout(ct.type)}
                    >
                      {ct.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
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

          {/* Indent */}
          <div className="editor-toolbar-group">
            <button
              className="editor-toolbar-btn"
              onClick={() => {
                if (editor.isActive('listItem')) {
                  editor.chain().focus().sinkListItem('listItem').run();
                } else if (editor.isActive('taskItem')) {
                  editor.chain().focus().sinkListItem('taskItem').run();
                } else {
                  editor.chain().focus().indent().run();
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
              onClick={() => {
                if (editor.isActive('listItem')) {
                  editor.chain().focus().liftListItem('listItem').run();
                } else if (editor.isActive('taskItem')) {
                  editor.chain().focus().liftListItem('taskItem').run();
                } else {
                  editor.chain().focus().outdent().run();
                }
              }}
              title={`${t('outdent', language)} (Shift+Tab)`}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <path d="M11 17h10v-2H11v2zm-8-5l4 4V8l-4 4zm0 9h18v-2H3v2zM3 3v2h18V3H3zm8 6h10V7H11v2zm0 4h10v-2H11v2z"/>
              </svg>
            </button>
          </div>
        </div>
      )}
    </div>
  );
});

export default EditorToolbar;
