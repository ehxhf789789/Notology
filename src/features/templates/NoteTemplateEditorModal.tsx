/**
 * Stage 5.0.5a (2026-05-16) — modal wrapper for NoteTemplateEditor.
 *
 * HanBin: "커스텀 템플릿이 사용자가 직관적으로 접근할 수 있도록 해야 하며,
 *          (현재는 설정창에 국한되어 있음)"
 *
 * Lifts the editor out of Settings → 템플릿 관리 so it can be opened from
 * the TemplateSelector "+" card (and future entry points: right-click on
 * a card, Cmd+K command, etc.). Listens to modalStore for visibility.
 *
 * Save flow: editor's onSave fires the caller-supplied callback (typically
 * `templateActions.upsertCustomTemplate` which writes to vault-config.yaml
 * — auto-NAS-synced because vault-config lives under the vault root).
 */
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useNoteTemplateEditorModalState, useModalStore } from '../modals/stores/modalStore';
import NoteTemplateEditor from './NoteTemplateEditor';

function NoteTemplateEditorModal() {
  const state = useNoteTemplateEditorModalState();
  const hide = useModalStore((s) => s.hideNoteTemplateEditorModal);
  const overlayRef = useRef<HTMLDivElement>(null);

  // ESC to close.
  // v20 fix (2026-05-16, HanBin) — also defensively swallow Backspace when
  // the focused element is NOT an editable surface (input / textarea /
  // contenteditable). HanBin reported: "본문 편집 중 backspace 시 새 템플릿
  // 만들기 창이 종료되는 오류". Root cause was the WebView falling back to
  // browser-history "back" navigation when Backspace fired on a non-text
  // element (Tauri/WebView2 still bubbles this in some focus states), which
  // unmounted the modal entirely. Capturing it at the document level here
  // blocks that path; real Backspace edits inside inputs / TipTap still
  // work because we early-return when target is editable.
  useEffect(() => {
    if (!state?.visible) return;
    const isEditable = (target: EventTarget | null): boolean => {
      if (!(target instanceof HTMLElement)) return false;
      const tag = target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
      if (target.isContentEditable) return true;
      // ProseMirror sets contenteditable on a wrapper; check ancestors.
      return !!target.closest('[contenteditable="true"], .ProseMirror, input, textarea');
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        hide();
        return;
      }
      if (e.key === 'Backspace' && !isEditable(e.target)) {
        e.preventDefault();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [state?.visible, hide]);

  if (!state?.visible) return null;

  const handleSave = (template: import('../../core/types').NoteTemplate) => {
    state.onSave(template);
    hide();
  };

  // Click on overlay (outside editor) closes; clicks inside editor stop propagation.
  const handleOverlayClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === overlayRef.current) hide();
  };

  return createPortal(
    <div
      ref={overlayRef}
      className="note-template-editor-modal-overlay"
      onClick={handleOverlayClick}
    >
      <div
        className="note-template-editor-modal-container"
        onClick={(e) => e.stopPropagation()}
      >
        <NoteTemplateEditor
          template={state.template}
          onSave={handleSave}
          onCancel={hide}
        />
      </div>
    </div>,
    document.body,
  );
}

export default NoteTemplateEditorModal;
