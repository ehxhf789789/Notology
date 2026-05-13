import { create } from 'zustand';
import type { ContextMenuState, VaultLockInfo } from '../../../core/types';
import type { FacetedTagSelection } from '../../shared/TagInputSection';

export interface TitleInputResult {
  title: string;
  tags?: FacetedTagSelection;
}

export interface TemplateSelectorState {
  visible: boolean;
  position: { x: number; y: number };
  callback: (templateId: string) => void;
}

export interface ContactInputModalState {
  visible: boolean;
  callback: (formData: any) => void;
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
  };
}

export interface MeetingInputModalState {
  visible: boolean;
  callback: (formData: any) => void;
}

export interface PaperInputModalState {
  visible: boolean;
  callback: (formData: any) => void;
}

export interface LiteratureInputModalState {
  visible: boolean;
  callback: (formData: any) => void;
}

export interface EventInputModalState {
  visible: boolean;
  callback: (formData: any) => void;
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

interface ModalState {
  // State
  templateSelectorState: TemplateSelectorState | null;
  contactInputModalState: ContactInputModalState | null;
  titleInputModalState: TitleInputModalState | null;
  meetingInputModalState: MeetingInputModalState | null;
  paperInputModalState: PaperInputModalState | null;
  literatureInputModalState: LiteratureInputModalState | null;
  eventInputModalState: EventInputModalState | null;
  confirmDeleteState: ConfirmDeleteState | null;
  alertModalState: AlertModalState | null;
  renameDialogState: RenameDialogState | null;
  contextMenu: ContextMenuState | null;
  moveNoteModalPath: string | null;
  bulkMoveNotePaths: string[] | null;
  showVaultSelectorModal: boolean;
  vaultLockModalState: VaultLockModalState | null;

  // Actions
  showTemplateSelector: (position: { x: number; y: number }, callback: (templateId: string) => void) => void;
  hideTemplateSelector: () => void;
  showContactInputModal: (callback: (formData: any) => void) => void;
  hideContactInputModal: () => void;
  showTitleInputModal: (callback: (result: TitleInputResult) => void, placeholder?: string, title?: string, templateInfo?: TitleInputModalState['templateInfo']) => void;
  hideTitleInputModal: () => void;
  showMeetingInputModal: (callback: (formData: any) => void) => void;
  hideMeetingInputModal: () => void;
  showPaperInputModal: (callback: (formData: any) => void) => void;
  hidePaperInputModal: () => void;
  showLiteratureInputModal: (callback: (formData: any) => void) => void;
  hideLiteratureInputModal: () => void;
  showEventInputModal: (callback: (formData: any) => void) => void;
  hideEventInputModal: () => void;
  showConfirmDelete: (itemName: string, itemType: 'note' | 'folder' | 'file', onConfirm: () => void, count?: number, options?: { onCancel?: () => void; warningOverride?: string }) => void;
  hideConfirmDelete: () => void;
  showAlertModal: (title: string, message: string) => void;
  hideAlertModal: () => void;
  showRenameDialog: (path: string, currentName: string, isAttachment?: boolean, isFolder?: boolean) => void;
  hideRenameDialog: () => void;
  showContextMenu: (fileName: string, position: { x: number; y: number }, notePath: string, filePath?: string, isFolder?: boolean, fromSearch?: boolean, wikiLinkDeleteCallback?: () => void, hideDelete?: boolean, isAttachment?: boolean) => void;
  hideContextMenu: () => void;
  showMoveNoteModal: (notePath: string) => void;
  hideMoveNoteModal: () => void;
  showBulkMoveModal: (paths: string[]) => void;
  hideBulkMoveModal: () => void;
  setShowVaultSelectorModal: (show: boolean) => void;
  setVaultLockModalState: (state: VaultLockModalState | null) => void;
  hideVaultLockModal: () => void;
}

export const useModalStore = create<ModalState>()((set) => ({
  // Initial state
  templateSelectorState: null,
  contactInputModalState: null,
  titleInputModalState: null,
  meetingInputModalState: null,
  paperInputModalState: null,
  literatureInputModalState: null,
  eventInputModalState: null,
  confirmDeleteState: null,
  alertModalState: null,
  renameDialogState: null,
  contextMenu: null,
  moveNoteModalPath: null,
  bulkMoveNotePaths: null,
  showVaultSelectorModal: false,
  vaultLockModalState: null,

  // Actions
  showTemplateSelector: (position, callback) =>
    set({ templateSelectorState: { visible: true, position, callback } }),
  hideTemplateSelector: () => set({ templateSelectorState: null }),

  showContactInputModal: (callback) =>
    set({ contactInputModalState: { visible: true, callback } }),
  hideContactInputModal: () => set({ contactInputModalState: null }),

  showTitleInputModal: (callback, placeholder, title, templateInfo) =>
    set({ titleInputModalState: { visible: true, callback, placeholder, title, templateInfo } }),
  hideTitleInputModal: () => set({ titleInputModalState: null }),

  showMeetingInputModal: (callback) =>
    set({ meetingInputModalState: { visible: true, callback } }),
  hideMeetingInputModal: () => set({ meetingInputModalState: null }),

  showPaperInputModal: (callback) =>
    set({ paperInputModalState: { visible: true, callback } }),
  hidePaperInputModal: () => set({ paperInputModalState: null }),

  showLiteratureInputModal: (callback) =>
    set({ literatureInputModalState: { visible: true, callback } }),
  hideLiteratureInputModal: () => set({ literatureInputModalState: null }),

  showEventInputModal: (callback) =>
    set({ eventInputModalState: { visible: true, callback } }),
  hideEventInputModal: () => set({ eventInputModalState: null }),

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
}));

// Selector hooks for optimized subscriptions
export const useTemplateSelectorState = () =>
  useModalStore((s) => s.templateSelectorState);
export const useContactInputModalState = () =>
  useModalStore((s) => s.contactInputModalState);
export const useTitleInputModalState = () =>
  useModalStore((s) => s.titleInputModalState);
export const useMeetingInputModalState = () =>
  useModalStore((s) => s.meetingInputModalState);
export const usePaperInputModalState = () =>
  useModalStore((s) => s.paperInputModalState);
export const useLiteratureInputModalState = () =>
  useModalStore((s) => s.literatureInputModalState);
export const useEventInputModalState = () =>
  useModalStore((s) => s.eventInputModalState);
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
  showTemplateSelector: (position: { x: number; y: number }, callback: (templateId: string) => void) =>
    useModalStore.getState().showTemplateSelector(position, callback),
  hideTemplateSelector: () => useModalStore.getState().hideTemplateSelector(),
  showContactInputModal: (callback: (formData: any) => void) =>
    useModalStore.getState().showContactInputModal(callback),
  hideContactInputModal: () => useModalStore.getState().hideContactInputModal(),
  showTitleInputModal: (callback: (result: TitleInputResult) => void, placeholder?: string, title?: string, templateInfo?: TitleInputModalState['templateInfo']) =>
    useModalStore.getState().showTitleInputModal(callback, placeholder, title, templateInfo),
  hideTitleInputModal: () => useModalStore.getState().hideTitleInputModal(),
  showMeetingInputModal: (callback: (formData: any) => void) =>
    useModalStore.getState().showMeetingInputModal(callback),
  hideMeetingInputModal: () => useModalStore.getState().hideMeetingInputModal(),
  showPaperInputModal: (callback: (formData: any) => void) =>
    useModalStore.getState().showPaperInputModal(callback),
  hidePaperInputModal: () => useModalStore.getState().hidePaperInputModal(),
  showLiteratureInputModal: (callback: (formData: any) => void) =>
    useModalStore.getState().showLiteratureInputModal(callback),
  hideLiteratureInputModal: () => useModalStore.getState().hideLiteratureInputModal(),
  showEventInputModal: (callback: (formData: any) => void) =>
    useModalStore.getState().showEventInputModal(callback),
  hideEventInputModal: () => useModalStore.getState().hideEventInputModal(),
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
  hideContextMenu: () => useModalStore.getState().hideContextMenu(),
  showMoveNoteModal: (notePath: string) => useModalStore.getState().showMoveNoteModal(notePath),
  hideMoveNoteModal: () => useModalStore.getState().hideMoveNoteModal(),
  showBulkMoveModal: (paths: string[]) => useModalStore.getState().showBulkMoveModal(paths),
  hideBulkMoveModal: () => useModalStore.getState().hideBulkMoveModal(),
  setShowVaultSelectorModal: (show: boolean) => useModalStore.getState().setShowVaultSelectorModal(show),
  setVaultLockModalState: (state: VaultLockModalState | null) => useModalStore.getState().setVaultLockModalState(state),
  hideVaultLockModal: () => useModalStore.getState().hideVaultLockModal(),
};
