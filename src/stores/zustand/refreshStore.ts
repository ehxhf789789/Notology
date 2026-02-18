import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import type { NoteMetadata } from '../../types';

// Optimistic note patch: allows instant UI updates before Tantivy indexing completes
export interface NotePatch {
  meta: NoteMetadata;
  timestamp: number;
}

interface RefreshState {
  // Triggers
  searchRefreshTrigger: number;
  calendarRefreshTrigger: number;
  ontologyRefreshTrigger: number;
  searchReady: boolean;
  searchIndexing: boolean; // true while background search indexing is in progress

  // Optimistic patch for instant search list updates
  lastNotePatch: NotePatch | null;

  // Actions
  incrementSearchRefresh: () => void;
  refreshCalendar: () => void;
  incrementOntologyRefresh: () => void;
  setSearchReady: (ready: boolean) => void;
  setSearchIndexing: (indexing: boolean) => void;
  batchRefresh: (options: { search?: boolean; calendar?: boolean; ontology?: boolean }) => void;
  patchNote: (meta: NoteMetadata) => void;
}

export const useRefreshStore = create<RefreshState>()(
  subscribeWithSelector((set) => ({
    // Initial state
    searchRefreshTrigger: 0,
    calendarRefreshTrigger: 0,
    ontologyRefreshTrigger: 0,
    searchReady: false,
    searchIndexing: false,
    lastNotePatch: null,

    // Increment search refresh trigger
    incrementSearchRefresh: () => {
      set((state) => ({ searchRefreshTrigger: state.searchRefreshTrigger + 1 }));
    },

    // Refresh calendar
    refreshCalendar: () => {
      set((state) => ({ calendarRefreshTrigger: state.calendarRefreshTrigger + 1 }));
    },

    // Increment ontology refresh trigger
    incrementOntologyRefresh: () => {
      set((state) => ({ ontologyRefreshTrigger: state.ontologyRefreshTrigger + 1 }));
    },

    // Set search ready state
    setSearchReady: (ready: boolean) => {
      set({ searchReady: ready });
    },

    // Set search indexing state (background indexing in progress)
    setSearchIndexing: (indexing: boolean) => {
      set({ searchIndexing: indexing });
    },

    // Batch refresh: increment multiple triggers in a single set() to reduce re-renders
    batchRefresh: (options) => {
      set((state) => ({
        ...(options.search ? { searchRefreshTrigger: state.searchRefreshTrigger + 1 } : {}),
        ...(options.calendar ? { calendarRefreshTrigger: state.calendarRefreshTrigger + 1 } : {}),
        ...(options.ontology ? { ontologyRefreshTrigger: state.ontologyRefreshTrigger + 1 } : {}),
      }));
    },

    // Optimistic patch: instantly update a single note's metadata in Search without Tantivy
    patchNote: (meta) => {
      set({ lastNotePatch: { meta, timestamp: Date.now() } });
    },
  }))
);

// Optimized selector hooks
export const useSearchRefreshTrigger = () =>
  useRefreshStore((state) => state.searchRefreshTrigger);

export const useCalendarRefreshTrigger = () =>
  useRefreshStore((state) => state.calendarRefreshTrigger);

export const useOntologyRefreshTrigger = () =>
  useRefreshStore((state) => state.ontologyRefreshTrigger);

export const useSearchReady = () =>
  useRefreshStore((state) => state.searchReady);

export const useSearchIndexing = () =>
  useRefreshStore((state) => state.searchIndexing);

// Actions (stable references - can be called outside React)
export const refreshActions = {
  incrementSearchRefresh: () =>
    useRefreshStore.getState().incrementSearchRefresh(),
  refreshCalendar: () =>
    useRefreshStore.getState().refreshCalendar(),
  incrementOntologyRefresh: () =>
    useRefreshStore.getState().incrementOntologyRefresh(),
  setSearchReady: (ready: boolean) =>
    useRefreshStore.getState().setSearchReady(ready),
  setSearchIndexing: (indexing: boolean) =>
    useRefreshStore.getState().setSearchIndexing(indexing),
  batchRefresh: (options: { search?: boolean; calendar?: boolean; ontology?: boolean }) =>
    useRefreshStore.getState().batchRefresh(options),
  patchNote: (meta: NoteMetadata) =>
    useRefreshStore.getState().patchNote(meta),
};

