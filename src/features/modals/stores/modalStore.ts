import { create } from 'zustand';
import type { ContextMenuState, VaultLockInfo, NoteTemplate } from '../../../core/types';
import type { FacetedTagSelection } from '../../shared/TagInputSection';

export interface TitleInputResult {
  title: string;
  tags?: FacetedTagSelection;
  /**
   * v18 (2026-05-16, HanBin) — wizard-style variable inputs collected
   * inline in this modal. Map of token name (without braces) → value.
   * Populated when the template body contains user-input `{{vars}}` or
   * the template declares explicit `fields`. Caller passes these to
   * `createNoteWithTemplate(..., customVariables)` which substitutes them
   * into both body and frontmatter.
   */
  varValues?: Record<string, string>;
}

export interface TemplateSelectorState {
  visible: boolean;
  /** Click-anchor position. Ignored when `mode === 'centered'`. */
  position: { x: number; y: number };
  callback: (templateId: string) => void;
  /**
   * Stage 5.0.5a (2026-05-16, HanBin) — display mode.
   *   'anchored' (default) — small popover near the click point. Used by
   *     "+ 새 노트" buttons, folder context menus, container view.
   *   'centered'           — full dialog centered on screen with backdrop.
   *     Used by Ctrl+N where there is no click anchor.
   * Visually distinct so a keyboard-invoked picker doesn't look like a
   * stranded button popover.
   */
  mode?: 'anchored' | 'centered';
}

export interface TitleInputModalState {
  visible: boolean;
  callback: (result: TitleInputResult) => void;
  placeholder?: string;
  title?: string;
  templateInfo?: {
    name: string;
    prefix: string;
    description: string;
    noteType: string;
    customColor?: string;
    /** v18 (2026-05-16, HanBin) — lucide icon id from the template (resolved
     *  via `resolveTemplateIcon` at render time). Without this, custom
     *  templates rendered the modal header with a blank icon span because
     *  the legacy `icon-${noteType}` CSS rule doesn't exist for them. */
    icon?: string;
  };
  /**
   * v18 (2026-05-16, HanBin) — user-input variables this modal should
   * collect inline (in addition to the title). Produced by
   * `scanUserInputVars(template.body)` upstream. Passing an empty array
   * (or omitting) keeps the modal as title-only — pre-v18 behavior.
   * Storing as plain token strings (not the full spec) so this state
   * stays serialisable; the modal re-resolves specs from the catalog.
   */
  userInputTokens?: string[];
  /**
   * Hotfix (2026-05-17, HanBin) — pre-filled value for the title input.
   * Used by the migration flow so the existing note's filename appears
   * already in the title box instead of forcing the user to retype it.
   * Omit / undefined → input opens empty (default Ctrl+N behavior).
   */
  initialInputValue?: string;
  /**
   * 10th hotfix (2026-05-17, HanBin) — pre-selected tag chips. Used by
   * the new-note flow to surface the template's pre-defined
   * `tagCategories` as visible chips in the wizard, so the user can
   * see + adjust BEFORE creating the note (previously these were applied
   * silently at save). When provided, the wizard treats its `selectedTags`
   * output as the source of truth — applyNoteTemplateVariables uses
   * userTags exclusively (skips re-applying tagCategories) so user
   * removals are respected.
   */
  initialTags?: import('../../shared/TagInputSection').FacetedTagSelection;
}

export interface ConfirmDeleteState {
  visible: boolean;
  itemName: string;
  itemType: 'note' | 'folder' | 'file';
  onConfirm: () => void;
  count?: number;
  /**
   * Track B Phase B-3 PART 6: optional cancel callback. Fired when the user
   * dismisses the modal via ESC or the Cancel button. Used by the wikilink
   * deletion flow to restore the chip when confirmation is declined.
   */
  onCancel?: () => void;
  /** Optional override of the warning text below the message. */
  warningOverride?: string;
}

export interface AlertModalState {
  visible: boolean;
  title: string;
  message: string;
}

export interface RenameDialogState {
  visible: boolean;
  path: string;
  currentName: string;
  isAttachment: boolean;
  isFolder: boolean;
}

export interface VaultLockModalState {
  visible: boolean;
  holder: VaultLockInfo | null;
  isStale: boolean;
  vaultPath: string;
}

/**
 * Stage 5.0.5a (2026-05-16, HanBin) — modalize NoteTemplateEditor so it
 * can be opened from anywhere (TemplateSelector "+" card, right-click on
 * a template card, future Cmd+K command). Previously only embedded in
 * Settings → 템플릿 관리.
 */
export interface NoteTemplateEditorModalState {
  visible: boolean;
  /** Initial template — undefined for "create new", populated for "edit existing". */
  template?: NoteTemplate;
  onSave: (template: NoteTemplate) => void;
}

/**
 * Stage 5.0.5a-β (2026-05-16, HanBin) — NoteCreationWizard state.
 * Triggered when a template body contains user-input variables
 * (autoFill=false). Single dialog collects title + tags + one input per
 * variable. On submit, caller substitutes the form values into the body
 * before creating the note.
 */
export interface NoteCreationWizardResult {
  title: string;
  /** Map of token → user-entered value (e.g. `{{email}}` → "user@x.com"). */
  varValues: Record<string, string>;
  tags?: FacetedTagSelection;
}
export interface NoteCreationWizardState {
  visible: boolean;
  templateId: string;
  callback: (result: NoteCreationWizardResult | null) => void;
}

interface ModalState {
  // State
  templateSelectorState: TemplateSelectorState | null;
  titleInputModalState: TitleInputModalState | null;
  confirmDeleteState: ConfirmDeleteState | null;
  alertModalState: AlertModalState | null;
  renameDialogState: RenameDialogState | null;
  contextMenu: ContextMenuState | null;
  moveNoteModalPath: string | null;
  bulkMoveNotePaths: string[] | null;
  showVaultSelectorModal: boolean;
  vaultLockModalState: VaultLockModalState | null;
  noteTemplateEditorModalState: NoteTemplateEditorModalState | null;
  noteCreationWizardState: NoteCreationWizardState | null;

  // Actions
  showTemplateSelector: (position: { x: number; y: number }, callback: (templateId: string) => void, mode?: 'anchored' | 'centered') => void;
  hideTemplateSelector: () => void;
  showTitleInputModal: (
    callback: (result: TitleInputResult) => void,
    placeholder?: string,
    title?: string,
    templateInfo?: TitleInputModalState['templateInfo'],
    userInputTokens?: string[],
    initialInputValue?: string,
    initialTags?: TitleInputModalState['initialTags'],
  ) => void;
  hideTitleInputModal: () => void;
  showConfirmDelete: (itemName: string, itemType: 'note' | 'folder' | 'file', onConfirm: () => void, count?: number, options?: { onCancel?: () => void; warningOverride?: string }) => void;
  hideConfirmDelete: () => void;
  showAlertModal: (title: string, message: string) => void;
  hideAlertModal: () => void;
  showRenameDialog: (path: string, currentName: string, isAttachment?: boolean, isFolder?: boolean) => void;
  hideRenameDialog: () => void;
  showContextMenu: (fileName: string, position: { x: number; y: number }, notePath: string, filePath?: string, isFolder?: boolean, fromSearch?: boolean, wikiLinkDeleteCallback?: () => void, hideDelete?: boolean, isAttachment?: boolean) => void;
  /**
   * Stage 5.0.4b-2d v3.2 — atom action-list context menu. Used by atom
   * NodeViews to expose right-click actions (insert line above / below /
   * delete). Each `actions[i]` renders as a menu button.
   */
  showAtomContextMenu: (
    position: { x: number; y: number },
    actions: Array<{ label: string; onClick: () => void; danger?: boolean }>,
  ) => void;
  hideContextMenu: () => void;
  showMoveNoteModal: (notePath: string) => void;
  hideMoveNoteModal: () => void;
  showBulkMoveModal: (paths: string[]) => void;
  hideBulkMoveModal: () => void;
  setShowVaultSelectorModal: (show: boolean) => void;
  setVaultLockModalState: (state: VaultLockModalState | null) => void;
  hideVaultLockModal: () => void;
  /**
   * Stage 5.0.5a — open the note template editor as a modal.
   * `template` undefined → create a new template.
   * `template` provided → edit existing (caller responsible for upsert in onSave).
   */
  showNoteTemplateEditorModal: (template: NoteTemplate | undefined, onSave: (template: NoteTemplate) => void) => void;
  hideNoteTemplateEditorModal: () => void;
  /**
   * Stage 5.0.5a-β — open the note-creation wizard for a template whose
   * body contains user-input variables. Callback receives the form result
   * on submit, or `null` if the user cancels.
   */
  showNoteCreationWizard: (templateId: string, callback: (result: NoteCreationWizardResult | null) => void) => void;
  hideNoteCreationWizard: () => void;
}

export const useModalStore = create<ModalState>()((set) => ({
  // Initial state
  templateSelectorState: null,
  titleInputModalState: null,
  confirmDeleteState: null,
  alertModalState: null,
  renameDialogState: null,
  contextMenu: null,
  moveNoteModalPath: null,
  bulkMoveNotePaths: null,
  showVaultSelectorModal: false,
  vaultLockModalState: null,
  noteTemplateEditorModalState: null,
  noteCreationWizardState: null,

  // Actions
  showTemplateSelector: (position, callback, mode = 'anchored') =>
    set({ templateSelectorState: { visible: true, position, callback, mode } }),
  hideTemplateSelector: () => set({ templateSelectorState: null }),

  showTitleInputModal: (callback, placeholder, title, templateInfo, userInputTokens, initialInputValue, initialTags) =>
    set({ titleInputModalState: { visible: true, callback, placeholder, title, templateInfo, userInputTokens, initialInputValue, initialTags } }),
  hideTitleInputModal: () => set({ titleInputModalState: null }),

  showConfirmDelete: (itemName, itemType, onConfirm, count, options) =>
    set({ confirmDeleteState: {
      visible: true, itemName, itemType, onConfirm, count,
      onCancel: options?.onCancel,
      warningOverride: options?.warningOverride,
    } }),
  hideConfirmDelete: () => set({ confirmDeleteState: null }),

  showAlertModal: (title, message) =>
    set({ alertModalState: { visible: true, title, message } }),
  hideAlertModal: () => set({ alertModalState: null }),

  showRenameDialog: (path, currentName, isAttachment, isFolder) =>
    set({ renameDialogState: { visible: true, path, currentName, isAttachment: isAttachment || false, isFolder: isFolder || false } }),
  hideRenameDialog: () => set({ renameDialogState: null }),

  showContextMenu: (fileName, position, notePath, filePath, isFolder, fromSearch, wikiLinkDeleteCallback, hideDelete, isAttachment) =>
    set({ contextMenu: { visible: true, position, fileName, notePath, filePath, isFolder, fromSearch, wikiLinkDeleteCallback, hideDelete, isAttachment } }),
  // v3.2 — atom action-list mode for atom-node right-click menus.
  showAtomContextMenu: (position, actions) =>
    set({ contextMenu: { visible: true, position, fileName: '', notePath: '', atomActions: actions } }),
  hideContextMenu: () => set({ contextMenu: null }),

  showMoveNoteModal: (notePath) => {
    set({ moveNoteModalPath: notePath, contextMenu: null });
  },
  hideMoveNoteModal: () => set({ moveNoteModalPath: null }),

  showBulkMoveModal: (paths) => {
    set({ bulkMoveNotePaths: paths });
  },
  hideBulkMoveModal: () => set({ bulkMoveNotePaths: null }),

  setShowVaultSelectorModal: (show) => set({ showVaultSelectorModal: show }),

  setVaultLockModalState: (state) => set({ vaultLockModalState: state }),
  hideVaultLockModal: () => set({ vaultLockModalState: null }),

  showNoteTemplateEditorModal: (template, onSave) =>
    set({ noteTemplateEditorModalState: { visible: true, template, onSave } }),
  hideNoteTemplateEditorModal: () => set({ noteTemplateEditorModalState: null }),

  showNoteCreationWizard: (templateId, callback) =>
    set({ noteCreationWizardState: { visible: true, templateId, callback } }),
  hideNoteCreationWizard: () => set({ noteCreationWizardState: null }),
}));

// Selector hooks for optimized subscriptions
export const useTemplateSelectorState = () =>
  useModalStore((s) => s.templateSelectorState);
export const useNoteTemplateEditorModalState = () =>
  useModalStore((s) => s.noteTemplateEditorModalState);
export const useNoteCreationWizardState = () =>
  useModalStore((s) => s.noteCreationWizardState);
export const useTitleInputModalState = () =>
  useModalStore((s) => s.titleInputModalState);
export const useConfirmDeleteState = () =>
  useModalStore((s) => s.confirmDeleteState);
export const useAlertModalState = () =>
  useModalStore((s) => s.alertModalState);
export const useRenameDialogState = () =>
  useModalStore((s) => s.renameDialogState);
export const useContextMenuState = () =>
  useModalStore((s) => s.contextMenu);
export const useMoveNoteModalPath = () =>
  useModalStore((s) => s.moveNoteModalPath);
export const useShowVaultSelectorModal = () =>
  useModalStore((s) => s.showVaultSelectorModal);
export const useVaultLockModalState = () =>
  useModalStore((s) => s.vaultLockModalState);

// Actions (stable references - can be called outside React)
export const modalActions = {
  showTemplateSelector: (position: { x: number; y: number }, callback: (templateId: string) => void, mode?: 'anchored' | 'centered') =>
    useModalStore.getState().showTemplateSelector(position, callback, mode),
  hideTemplateSelector: () => useModalStore.getState().hideTemplateSelector(),
  showTitleInputModal: (
    callback: (result: TitleInputResult) => void,
    placeholder?: string,
    title?: string,
    templateInfo?: TitleInputModalState['templateInfo'],
    userInputTokens?: string[],
    initialInputValue?: string,
    initialTags?: TitleInputModalState['initialTags'],
  ) =>
    useModalStore.getState().showTitleInputModal(callback, placeholder, title, templateInfo, userInputTokens, initialInputValue, initialTags),
  hideTitleInputModal: () => useModalStore.getState().hideTitleInputModal(),
  showConfirmDelete: (itemName: string, itemType: 'note' | 'folder' | 'file', onConfirm: () => void, count?: number, options?: { onCancel?: () => void; warningOverride?: string }) =>
    useModalStore.getState().showConfirmDelete(itemName, itemType, onConfirm, count, options),
  hideConfirmDelete: () => useModalStore.getState().hideConfirmDelete(),
  showAlertModal: (title: string, message: string) =>
    useModalStore.getState().showAlertModal(title, message),
  hideAlertModal: () => useModalStore.getState().hideAlertModal(),
  showRenameDialog: (path: string, currentName: string, isAttachment?: boolean, isFolder?: boolean) =>
    useModalStore.getState().showRenameDialog(path, currentName, isAttachment, isFolder),
  hideRenameDialog: () => useModalStore.getState().hideRenameDialog(),
  showContextMenu: (fileName: string, position: { x: number; y: number }, notePath: string, filePath?: string, isFolder?: boolean, fromSearch?: boolean, wikiLinkDeleteCallback?: () => void, hideDelete?: boolean, isAttachment?: boolean) =>
    useModalStore.getState().showContextMenu(fileName, position, notePath, filePath, isFolder, fromSearch, wikiLinkDeleteCallback, hideDelete, isAttachment),
  showAtomContextMenu: (
    position: { x: number; y: number },
    actions: Array<{ label: string; onClick: () => void; danger?: boolean }>,
  ) => useModalStore.getState().showAtomContextMenu(position, actions),
  hideContextMenu: () => useModalStore.getState().hideContextMenu(),
  showMoveNoteModal: (notePath: string) => useModalStore.getState().showMoveNoteModal(notePath),
  hideMoveNoteModal: () => useModalStore.getState().hideMoveNoteModal(),
  showBulkMoveModal: (paths: string[]) => useModalStore.getState().showBulkMoveModal(paths),
  hideBulkMoveModal: () => useModalStore.getState().hideBulkMoveModal(),
  setShowVaultSelectorModal: (show: boolean) => useModalStore.getState().setShowVaultSelectorModal(show),
  setVaultLockModalState: (state: VaultLockModalState | null) => useModalStore.getState().setVaultLockModalState(state),
  hideVaultLockModal: () => useModalStore.getState().hideVaultLockModal(),
};
