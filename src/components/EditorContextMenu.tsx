import { useState, useEffect, useRef, useLayoutEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import type { Editor } from '@tiptap/react';
import type { CalloutType } from '../extensions/Callout';
import { useSettingsStore } from '../stores/zustand/settingsStore';
import { t } from '../utils/i18n';
import { modalActions } from '../stores/zustand/modalStore';

interface EditorContextMenuProps {
  editor: Editor;
  position: { x: number; y: number };
  onClose: () => void;
  onAddMemo?: () => void;
  onAddTask?: () => void;
}

const CALLOUT_TYPES: { type: CalloutType; label: string }[] = [
  { type: 'info', label: 'Info' },
  { type: 'warning', label: 'Warning' },
  { type: 'error', label: 'Error' },
  { type: 'success', label: 'Success' },
  { type: 'note', label: 'Note' },
  { type: 'tip', label: 'Tip' },
];

const CELL_COLOR_KEYS: { color: string; key: string }[] = [
  { color: 'transparent', key: 'cellDefault' },
  { color: '#2d2d2d', key: 'cellDarkGray' },
  { color: '#3c3c3c', key: 'cellGray' },
  { color: '#1e3a5f', key: 'cellBlue' },
  { color: '#2d4a2c', key: 'cellGreen' },
  { color: '#5f3a1e', key: 'cellBrown' },
  { color: '#5f1e3a', key: 'cellPurple' },
  { color: '#4a2d2d', key: 'cellRed' },
];

// Submenu component rendered as portal
interface SubmenuPortalProps {
  show: boolean;
  triggerRef: React.RefObject<HTMLDivElement | null>;
  children: React.ReactNode;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}

function SubmenuPortal({ show, triggerRef, children, onMouseEnter, onMouseLeave }: SubmenuPortalProps) {
  const [pos, setPos] = useState({ x: 0, y: 0, openLeft: false });

  useLayoutEffect(() => {
    if (!show || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const submenuWidth = 150;
    const padding = 16;

    // Check if submenu should open to the left
    const openLeft = rect.right + submenuWidth > window.innerWidth - padding;

    setPos({
      // When opening left, add more overlap to prevent gap when mouse moves between menus
      x: openLeft ? rect.left - submenuWidth + 12 : rect.right - 4,
      y: rect.top - 4,
      openLeft,
    });
  }, [show, triggerRef]);

  if (!show) return null;

  return createPortal(
    <div
      className="editor-context-submenu-portal"
      style={{ left: pos.x, top: pos.y }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {children}
    </div>,
    document.body
  );
}

function EditorContextMenu({ editor, position, onClose, onAddMemo, onAddTask }: EditorContextMenuProps) {
  const language = useSettingsStore(s => s.language);
  const menuRef = useRef<HTMLDivElement>(null);
  const headingTriggerRef = useRef<HTMLDivElement>(null);
  const alignTriggerRef = useRef<HTMLDivElement>(null);
  const calloutTriggerRef = useRef<HTMLDivElement>(null);
  const cellColorTriggerRef = useRef<HTMLDivElement>(null);
  const [adjustedPos, setAdjustedPos] = useState(position);
  const [showHeadingSubmenu, setShowHeadingSubmenu] = useState(false);
  const [showAlignSubmenu, setShowAlignSubmenu] = useState(false);
  const [showCalloutSubmenu, setShowCalloutSubmenu] = useState(false);
  const [showCellColorSubmenu, setShowCellColorSubmenu] = useState(false);

  const cellColors = useMemo(() =>
    CELL_COLOR_KEYS.map(c => ({ color: c.color, label: t(c.key, language) })),
    [language]
  );

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      // Check if click is inside main menu or any submenu portal
      const target = e.target as Node;
      const isInsideMenu = menuRef.current?.contains(target);
      const isInsideSubmenu = (target as Element).closest?.('.editor-context-submenu-portal');
      if (!isInsideMenu && !isInsideSubmenu) {
        onClose();
      }
    };
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEsc);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEsc);
    };
  }, [onClose]);

  useLayoutEffect(() => {
    if (!menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    // Add some padding to prevent menu from being too close to edges
    const padding = 16;
    let x = position.x;
    let y = position.y;

    // Adjust horizontal position
    if (x + rect.width > window.innerWidth - padding) {
      x = window.innerWidth - rect.width - padding;
    }
    if (x < padding) {
      x = padding;
    }

    // Adjust vertical position - ensure menu stays within viewport
    // The menu has max-height: min(500px, calc(100vh - 80px)) in CSS
    const maxMenuHeight = Math.min(500, window.innerHeight - 80);
    const availableHeight = window.innerHeight - y - padding;

    if (availableHeight < rect.height) {
      // If not enough space below, try to position above or adjust
      if (position.y > rect.height + padding) {
        // Position above the click point
        y = position.y - rect.height;
      } else {
        // Position at top with padding, scrollbar will handle overflow
        y = padding;
      }
    }

    if (y < padding) {
      y = padding;
    }

    setAdjustedPos({ x, y });
  }, [position]);

  const runCommand = (fn: () => void) => {
    fn();
    onClose();
  };

  // Use portal to render to document.body, escaping any transformed parent's stacking context
  return createPortal(
    <div
      ref={menuRef}
      className="editor-context-menu"
      style={{ left: adjustedPos.x, top: adjustedPos.y }}
    >
      {/* Table operations - show at TOP when inside a table */}
      {editor.isActive('table') && (
        <>
          <button
            className="editor-context-menu-item"
            onClick={() => runCommand(() => editor.chain().focus().addRowBefore().run())}
          >
            <span className="ecm-label">{t('addRowBefore', language)}</span>
          </button>
          <button
            className="editor-context-menu-item"
            onClick={() => runCommand(() => editor.chain().focus().addRowAfter().run())}
          >
            <span className="ecm-label">{t('addRowAfter', language)}</span>
          </button>
          <button
            className="editor-context-menu-item"
            onClick={() => runCommand(() => editor.chain().focus().addColumnBefore().run())}
          >
            <span className="ecm-label">{t('addColumnBefore', language)}</span>
          </button>
          <button
            className="editor-context-menu-item"
            onClick={() => runCommand(() => editor.chain().focus().addColumnAfter().run())}
          >
            <span className="ecm-label">{t('addColumnAfter', language)}</span>
          </button>
          <div className="editor-context-menu-separator" />
          <div
            ref={cellColorTriggerRef}
            className="editor-context-menu-item has-submenu"
            onMouseEnter={() => { setShowCellColorSubmenu(true); setShowHeadingSubmenu(false); setShowCalloutSubmenu(false); }}
            onMouseLeave={() => setShowCellColorSubmenu(false)}
          >
            <span className="ecm-label">{t('cellBgColor', language)}</span>
            <span className="ecm-arrow">▸</span>
          </div>
          <SubmenuPortal
            show={showCellColorSubmenu}
            triggerRef={cellColorTriggerRef}
            onMouseEnter={() => setShowCellColorSubmenu(true)}
            onMouseLeave={() => setShowCellColorSubmenu(false)}
          >
            {cellColors.map(c => (
              <button
                key={c.color}
                className="editor-context-menu-item"
                onClick={() => runCommand(() => {
                  // Try to update tableHeader first (for header cells), then tableCell
                  const chain = editor.chain().focus();
                  if (editor.isActive('tableHeader')) {
                    chain.updateAttributes('tableHeader', { backgroundColor: c.color }).run();
                  } else {
                    chain.updateAttributes('tableCell', { backgroundColor: c.color }).run();
                  }
                })}
              >
                <div className="cell-color-preview" style={{ backgroundColor: c.color }} />
                <span className="ecm-label">{c.label}</span>
              </button>
            ))}
          </SubmenuPortal>
          <div className="editor-context-menu-separator" />
          <button
            className="editor-context-menu-item"
            onClick={() => runCommand(() => editor.chain().focus().deleteRow().run())}
          >
            <span className="ecm-label">{t('deleteRow', language)}</span>
          </button>
          <button
            className="editor-context-menu-item"
            onClick={() => runCommand(() => editor.chain().focus().deleteColumn().run())}
          >
            <span className="ecm-label">{t('deleteColumn', language)}</span>
          </button>
          <button
            className="editor-context-menu-item delete"
            onClick={() => runCommand(() => editor.chain().focus().deleteTable().run())}
          >
            <span className="ecm-label">{t('deleteTable', language)}</span>
          </button>
          <div className="editor-context-menu-separator" />
        </>
      )}

      {/* Memo / Task (only when text is selected) */}
      {!editor.state.selection.empty && onAddMemo && (
        <>
          <button
            className="editor-context-menu-item ecm-memo-item"
            onClick={() => { onAddMemo(); onClose(); }}
          >
            <span className="ecm-label">{t('addMemoContext', language)}</span>
          </button>
          {onAddTask && (
            <button
              className="editor-context-menu-item ecm-memo-item"
              onClick={() => { onAddTask(); onClose(); }}
            >
              <span className="ecm-label">{t('addTaskContext', language)}</span>
            </button>
          )}
          <div className="editor-context-menu-separator" />
        </>
      )}

      {/* Text formatting */}
      <button
        className={`editor-context-menu-item ${editor.isActive('bold') ? 'active' : ''}`}
        onClick={() => runCommand(() => editor.chain().focus().toggleBold().run())}
      >
        <span className="ecm-label">{t('boldShort', language)}</span>
        <span className="ecm-shortcut">Ctrl+B</span>
      </button>
      <button
        className={`editor-context-menu-item ${editor.isActive('italic') ? 'active' : ''}`}
        onClick={() => runCommand(() => editor.chain().focus().toggleItalic().run())}
      >
        <span className="ecm-label">{t('italicShort', language)}</span>
        <span className="ecm-shortcut">Ctrl+I</span>
      </button>
      <button
        className={`editor-context-menu-item ${editor.isActive('strike') ? 'active' : ''}`}
        onClick={() => runCommand(() => editor.chain().focus().toggleStrike().run())}
      >
        <span className="ecm-label">{t('strikethroughShort', language)}</span>
        <span className="ecm-shortcut"></span>
      </button>
      <button
        className={`editor-context-menu-item ${editor.isActive('underline') ? 'active' : ''}`}
        onClick={() => runCommand(() => editor.chain().focus().toggleUnderline().run())}
      >
        <span className="ecm-label">{t('underlineShort', language)}</span>
        <span className="ecm-shortcut">Ctrl+U</span>
      </button>
      <button
        className={`editor-context-menu-item ${editor.isActive('highlight') ? 'active' : ''}`}
        onClick={() => runCommand(() => editor.chain().focus().toggleHighlight().run())}
      >
        <span className="ecm-label">{t('highlightShort', language)}</span>
        <span className="ecm-shortcut"></span>
      </button>

      <div className="editor-context-menu-separator" />

      {/* Heading submenu */}
      <div
        ref={headingTriggerRef}
        className="editor-context-menu-item has-submenu"
        onMouseEnter={() => { setShowHeadingSubmenu(true); setShowAlignSubmenu(false); setShowCalloutSubmenu(false); setShowCellColorSubmenu(false); }}
        onMouseLeave={() => setShowHeadingSubmenu(false)}
      >
        <span className="ecm-label">{t('heading', language)}</span>
        <span className="ecm-arrow">▸</span>
      </div>
      <SubmenuPortal
        show={showHeadingSubmenu}
        triggerRef={headingTriggerRef}
        onMouseEnter={() => setShowHeadingSubmenu(true)}
        onMouseLeave={() => setShowHeadingSubmenu(false)}
      >
        <button
          className={`editor-context-menu-item ${editor.isActive('heading', { level: 1 }) ? 'active' : ''}`}
          onClick={() => runCommand(() => editor.chain().focus().toggleHeading({ level: 1 }).run())}
        >
          <span className="ecm-label">{t('heading1', language)}</span>
        </button>
        <button
          className={`editor-context-menu-item ${editor.isActive('heading', { level: 2 }) ? 'active' : ''}`}
          onClick={() => runCommand(() => editor.chain().focus().toggleHeading({ level: 2 }).run())}
        >
          <span className="ecm-label">{t('heading2', language)}</span>
        </button>
        <button
          className={`editor-context-menu-item ${editor.isActive('heading', { level: 3 }) ? 'active' : ''}`}
          onClick={() => runCommand(() => editor.chain().focus().toggleHeading({ level: 3 }).run())}
        >
          <span className="ecm-label">{t('heading3', language)}</span>
        </button>
      </SubmenuPortal>

      {/* Alignment submenu */}
      <div
        ref={alignTriggerRef}
        className="editor-context-menu-item has-submenu"
        onMouseEnter={() => { setShowAlignSubmenu(true); setShowHeadingSubmenu(false); setShowCalloutSubmenu(false); setShowCellColorSubmenu(false); }}
        onMouseLeave={() => setShowAlignSubmenu(false)}
      >
        <span className="ecm-label">{t('textAlign', language)}</span>
        <span className="ecm-arrow">▸</span>
      </div>
      <SubmenuPortal
        show={showAlignSubmenu}
        triggerRef={alignTriggerRef}
        onMouseEnter={() => setShowAlignSubmenu(true)}
        onMouseLeave={() => setShowAlignSubmenu(false)}
      >
        <button
          className={`editor-context-menu-item ${editor.isActive({ textAlign: 'left' }) ? 'active' : ''}`}
          onClick={() => runCommand(() => editor.chain().focus().setTextAlign('left').run())}
        >
          <span className="ecm-label">{t('alignLeft', language)}</span>
        </button>
        <button
          className={`editor-context-menu-item ${editor.isActive({ textAlign: 'center' }) ? 'active' : ''}`}
          onClick={() => runCommand(() => editor.chain().focus().setTextAlign('center').run())}
        >
          <span className="ecm-label">{t('alignCenter', language)}</span>
        </button>
        <button
          className={`editor-context-menu-item ${editor.isActive({ textAlign: 'right' }) ? 'active' : ''}`}
          onClick={() => runCommand(() => editor.chain().focus().setTextAlign('right').run())}
        >
          <span className="ecm-label">{t('alignRight', language)}</span>
        </button>
      </SubmenuPortal>

      <div className="editor-context-menu-separator" />

      {/* Lists */}
      <button
        className={`editor-context-menu-item ${editor.isActive('bulletList') ? 'active' : ''}`}
        onClick={() => {
          if (editor.isActive('codeBlock')) {
            modalActions.showAlertModal(t('codeBlockWarningTitle', language), t('codeBlockWarningMessage', language));
            onClose();
            return;
          }
          runCommand(() => editor.chain().focus().toggleBulletList().run());
        }}
      >
        <span className="ecm-label">{t('bulletList', language)}</span>
        <span className="ecm-shortcut"></span>
      </button>
      <button
        className={`editor-context-menu-item ${editor.isActive('orderedList') ? 'active' : ''}`}
        onClick={() => {
          if (editor.isActive('codeBlock')) {
            modalActions.showAlertModal(t('codeBlockWarningTitle', language), t('codeBlockWarningMessage', language));
            onClose();
            return;
          }
          runCommand(() => editor.chain().focus().toggleOrderedList().run());
        }}
      >
        <span className="ecm-label">{t('orderedList', language)}</span>
        <span className="ecm-shortcut"></span>
      </button>
      <button
        className={`editor-context-menu-item ${editor.isActive('taskList') ? 'active' : ''}`}
        onClick={() => {
          if (editor.isActive('codeBlock')) {
            modalActions.showAlertModal(t('codeBlockWarningTitle', language), t('codeBlockWarningMessage', language));
            onClose();
            return;
          }
          runCommand(() => editor.chain().focus().toggleTaskList().run());
        }}
      >
        <span className="ecm-label">{t('checklist', language)}</span>
        <span className="ecm-shortcut"></span>
      </button>

      <div className="editor-context-menu-separator" />

      {/* Block elements */}
      <button
        className={`editor-context-menu-item ${editor.isActive('blockquote') ? 'active' : ''}`}
        onClick={() => runCommand(() => editor.chain().focus().toggleBlockquote().run())}
      >
        <span className="ecm-label">{t('blockquote', language)}</span>
        <span className="ecm-shortcut"></span>
      </button>

      {/* Callout submenu */}
      <div
        ref={calloutTriggerRef}
        className="editor-context-menu-item has-submenu"
        onMouseEnter={() => { setShowCalloutSubmenu(true); setShowHeadingSubmenu(false); setShowAlignSubmenu(false); setShowCellColorSubmenu(false); }}
        onMouseLeave={() => setShowCalloutSubmenu(false)}
      >
        <span className="ecm-label">{t('callout', language)}</span>
        <span className="ecm-arrow">▸</span>
      </div>
      <SubmenuPortal
        show={showCalloutSubmenu}
        triggerRef={calloutTriggerRef}
        onMouseEnter={() => setShowCalloutSubmenu(true)}
        onMouseLeave={() => setShowCalloutSubmenu(false)}
      >
        {CALLOUT_TYPES.map(ct => (
          <button
            key={ct.type}
            className="editor-context-menu-item"
            onClick={() => runCommand(() => editor.chain().focus().toggleCallout(ct.type).run())}
          >
            <span className="ecm-label">{ct.label}</span>
          </button>
        ))}
      </SubmenuPortal>

      <button
        className={`editor-context-menu-item ${editor.isActive('code') ? 'active' : ''}`}
        onClick={() => runCommand(() => editor.chain().focus().toggleCode().run())}
      >
        <span className="ecm-label">{t('inlineCode', language)}</span>
        <span className="ecm-shortcut">Ctrl+E</span>
      </button>
      <button
        className={`editor-context-menu-item ${editor.isActive('codeBlock') ? 'active' : ''}`}
        onClick={() => runCommand(() => editor.chain().focus().toggleCodeBlock().run())}
      >
        <span className="ecm-label">{t('codeBlock', language)}</span>
        <span className="ecm-shortcut"></span>
      </button>

      <div className="editor-context-menu-separator" />

      {/* Indent */}
      <button
        className="editor-context-menu-item"
        onClick={() => runCommand(() => {
          if (editor.isActive('listItem')) {
            editor.chain().focus().sinkListItem('listItem').run();
          } else if (editor.isActive('taskItem')) {
            editor.chain().focus().sinkListItem('taskItem').run();
          } else {
            // First-line indent for regular paragraphs
            editor.chain().focus().setFirstLineIndent().run();
          }
        })}
      >
        <span className="ecm-label">{t('indentShort', language)}</span>
        <span className="ecm-shortcut">Tab</span>
      </button>
      <button
        className="editor-context-menu-item"
        onClick={() => runCommand(() => {
          if (editor.isActive('listItem')) {
            editor.chain().focus().liftListItem('listItem').run();
          } else if (editor.isActive('taskItem')) {
            editor.chain().focus().liftListItem('taskItem').run();
          } else {
            // Hanging indent for regular paragraphs
            editor.chain().focus().setHangingIndent().run();
          }
        })}
      >
        <span className="ecm-label">{t('outdentShort', language)}</span>
        <span className="ecm-shortcut">Shift+Tab</span>
      </button>
    </div>,
    document.body
  );
}

export default EditorContextMenu;
