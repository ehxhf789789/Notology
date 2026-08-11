/** 대화 상태 — 열림 여부와 주고받은 말 */
import { create } from 'zustand';
import type { DobbinMessage } from './dobbinClient';

interface DobbinState {
  open: boolean;
  busy: boolean;
  messages: DobbinMessage[];
  error: string | null;
}

export const useDobbinStore = create<DobbinState>(() => ({
  open: false, busy: false, messages: [], error: null,
}));

export const dobbinActions = {
  open: () => useDobbinStore.setState({ open: true }),
  close: () => useDobbinStore.setState({ open: false }),
  toggle: () => useDobbinStore.setState((s) => ({ open: !s.open })),
  push: (m: DobbinMessage) =>
    useDobbinStore.setState((s) => ({ messages: [...s.messages, m] })),
  setBusy: (busy: boolean) => useDobbinStore.setState({ busy }),
  setError: (error: string | null) => useDobbinStore.setState({ error }),
  clear: () => useDobbinStore.setState({ messages: [], error: null }),
};
