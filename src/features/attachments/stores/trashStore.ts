/** 휴지통 열림 상태 — `sync_v2`에서 갈라 나왔다
 *
 * 원래 동기화 스토어의 플래그 하나에 얹혀 있었다. 동기화를 걷어내면서
 * **휴지통까지 딸려 나갈 뻔했다.** 휴지통은 동기화와 무관하다 —
 * 지운 첨부를 되살리는 곳이고 웹에서도 그대로 필요하다.
 */
import { create } from 'zustand';

interface TrashState { open: boolean }
export const useTrashStore = create<TrashState>(() => ({ open: false }));

export const trashActions = {
  open: () => useTrashStore.setState({ open: true }),
  close: () => useTrashStore.setState({ open: false }),
  toggle: () => useTrashStore.setState((s) => ({ open: !s.open })),
};
