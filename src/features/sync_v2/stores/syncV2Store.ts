// Zustand store for sync_v2 UI state.

import { create } from 'zustand';
import type { SyncState, SyncReport, NoteWithConflicts } from '../../../core/types/sync';
import { syncV2Commands } from '../syncV2Commands';

interface SyncV2State {
  // State
  syncState: SyncState;
  /** NAS reachability — true = Online, false = Offline. */
  online: boolean;
  /** User-facing pause toggle — true = active, false = paused. */
  syncEnabled: boolean;
  conflicts: NoteWithConflicts[];
  lastReport: SyncReport | null;
  /** 5.0.6o (2026-05-17, HanBin) — rolling window of recent sync cycles
   *  for the activity popover's log. Newest first. Capped at MAX_HISTORY
   *  so the store stays small (each report is ~few KB max). Reports with
   *  zero activity (no pushes/pulls/conflicts/errors) are filtered out
   *  before insertion — otherwise the every-5s idle polls flood the log. */
  reportHistory: SyncReport[];
  showConflictList: boolean;
  /** note_id of the conflict being resolved, or null */
  resolvingNoteId: string | null;
  /** Track H: count of refs awaiting bulk-delete confirmation. > 0 means
   *  the banner / modal should be shown. Refreshed after every sync. */
  pendingNasDeletionCount: number;
  /** Whether the Trash panel modal is currently visible. */
  showTrashPanel: boolean;

  // Actions
  setSyncState: (state: SyncState) => void;
  setOnline: (online: boolean) => void;
  setSyncEnabled: (enabled: boolean) => void;
  setConflicts: (conflicts: NoteWithConflicts[]) => void;
  setLastReport: (report: SyncReport | null) => void;
  /** Track H + general: apply a SyncReport's UI-visible side effects
   *  (toast for silent trash, pending banner count). Used by both
   *  the user-triggered triggerSync flow and the background
   *  `sync-v2:report` event listener. */
  applyReport: (report: SyncReport) => void;
  openConflictList: () => void;
  closeConflictList: () => void;
  openBranchPicker: (noteId: string) => void;
  closeBranchPicker: () => void;
  refreshState: () => Promise<void>;
  refreshOnline: () => Promise<void>;
  refreshSyncEnabled: () => Promise<void>;
  refreshConflicts: () => Promise<void>;
  triggerSync: () => Promise<SyncReport | null>;
  toggleSyncEnabled: () => Promise<void>;
}

export const useSyncV2Store = create<SyncV2State>()((set, get) => ({
  syncState: { type: 'Idle' },
  online: true,
  syncEnabled: true,
  conflicts: [],
  lastReport: null,
  reportHistory: [],
  showConflictList: false,
  resolvingNoteId: null,
  pendingNasDeletionCount: 0,
  showTrashPanel: false,

  setSyncState: (syncState) => set({ syncState }),
  setOnline: (online) => set({ online }),
  setSyncEnabled: (syncEnabled) => set({ syncEnabled }),
  setConflicts: (conflicts) => set({ conflicts }),
  setLastReport: (lastReport) => set({ lastReport }),

  applyReport: (report) => {
    // 5.0.6o — record meaningful cycles into history. "Meaningful" =
    // anything that actually moved data, hit a conflict, or errored.
    // Idle polls (no work done) would otherwise drown the log.
    const isMeaningful =
      report.objects_uploaded > 0
      || report.objects_downloaded > 0
      || report.refs_pushed.length > 0
      || report.refs_pulled.length > 0
      || report.conflicts_detected > 0
      || report.errors.length > 0;
    const MAX_HISTORY = 10;
    set((s) => ({
      lastReport: report,
      pendingNasDeletionCount: report.nas_deleted_pending ?? 0,
      reportHistory: isMeaningful
        ? [report, ...s.reportHistory].slice(0, MAX_HISTORY)
        : s.reportHistory,
    }));
    const silent = report.nas_deleted_trashed ?? 0;
    if (silent > 0) {
      import('../../shared/Toast').then(({ showToast }) => {
        showToast({
          type: 'info',
          title: `노트 ${silent}개가 NAS에서 삭제되어 휴지통으로 이동`,
          description: '동기화 상태 패널 → 🗑 휴지통 열기로 복원 가능 (30일 보관)',
        });
      });
    }
  },
  openConflictList: () => set({ showConflictList: true }),
  closeConflictList: () => set({ showConflictList: false, resolvingNoteId: null }),
  openBranchPicker: (noteId) => set({ resolvingNoteId: noteId }),
  closeBranchPicker: () => set({ resolvingNoteId: null }),

  refreshState: async () => {
    try {
      const syncState = await syncV2Commands.getState();
      set({ syncState });
    } catch (e) {
      // Engine not initialized is expected until 4.10; keep Idle.
      console.debug('[sync_v2] refreshState skipped:', e);
    }
  },

  refreshOnline: async () => {
    try {
      const online = await syncV2Commands.getOnline();
      set({ online });
    } catch (e) {
      console.debug('[sync_v2] refreshOnline skipped:', e);
    }
  },

  refreshSyncEnabled: async () => {
    try {
      const enabled = await syncV2Commands.getEnabled();
      set({ syncEnabled: enabled });
    } catch (e) {
      console.debug('[sync_v2] refreshSyncEnabled skipped:', e);
    }
  },

  toggleSyncEnabled: async () => {
    const current = get().syncEnabled;
    const next = !current;
    // Optimistic flip — backend confirms via "sync-v2:enabled-changed".
    set({ syncEnabled: next });
    try {
      await syncV2Commands.setEnabled(next);
    } catch (e) {
      // Roll back on failure.
      set({ syncEnabled: current });
      console.error('[sync_v2] toggleSyncEnabled failed:', e);
    }
  },

  refreshConflicts: async () => {
    try {
      const conflicts = await syncV2Commands.listConflicts();
      set({ conflicts });
    } catch (e) {
      console.debug('[sync_v2] refreshConflicts skipped:', e);
    }
  },

  triggerSync: async () => {
    try {
      const report = await syncV2Commands.syncNow();
      set({ syncState: { type: 'Idle' } });
      // Delegate UI-visible side effects (lastReport, toast, pending
      // banner) to applyReport so this path and the background
      // `sync-v2:report` listener stay in sync.
      get().applyReport(report);
      return report;
    } catch (e) {
      // User-initiated action: show error in UI
      const message = typeof e === 'string' ? e
        : (e instanceof Error ? e.message : String(e));
      set({
        syncState: {
          type: 'Error',
          message,
          last_attempt: new Date().toISOString(),
        },
      });
      console.error('[sync_v2] triggerSync failed:', e);
      return null;
    }
  },
}));

// Imperative action object for use outside React components
export const syncV2Actions = {
  setSyncState: (s: SyncState) => useSyncV2Store.getState().setSyncState(s),
  setOnline: (o: boolean) => useSyncV2Store.getState().setOnline(o),
  setSyncEnabled: (e: boolean) => useSyncV2Store.getState().setSyncEnabled(e),
  setConflicts: (c: NoteWithConflicts[]) => useSyncV2Store.getState().setConflicts(c),
  openConflictList: () => useSyncV2Store.getState().openConflictList(),
  closeConflictList: () => useSyncV2Store.getState().closeConflictList(),
  openBranchPicker: (id: string) => useSyncV2Store.getState().openBranchPicker(id),
  closeBranchPicker: () => useSyncV2Store.getState().closeBranchPicker(),
  refreshState: () => useSyncV2Store.getState().refreshState(),
  refreshOnline: () => useSyncV2Store.getState().refreshOnline(),
  refreshSyncEnabled: () => useSyncV2Store.getState().refreshSyncEnabled(),
  refreshConflicts: () => useSyncV2Store.getState().refreshConflicts(),
  triggerSync: () => useSyncV2Store.getState().triggerSync(),
  toggleSyncEnabled: () => useSyncV2Store.getState().toggleSyncEnabled(),
};
