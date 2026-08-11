/**
 * 오른쪽 탭 — 서류철처럼 하나를 뽑으면 앞엣것이 들어간다
 *
 * 사용자 요구 (2026-08-11):
 *   *"달력 슬라이드를 누르면 해당 슬라이드가 밀려서 열리고, dobbin AI 버튼을
 *     누르면 달력 슬라이드는 들어가고 AI 슬라이드 탭이 밀려나오는 애니메이션"*
 *
 * 🔴 **세 탭이 같은 자리를 나눠 쓴다.** 각자 창을 가지면 화면이 좁아지고,
 *    무엇을 보고 있는지도 흐려진다. 서류철의 탭이 그래서 하나만 앞에 온다.
 *
 * 같은 탭을 다시 누르면 닫힌다 — 열고 닫는 단추가 따로 있으면 하나 더 외워야 한다.
 */
import { create } from 'zustand';
import { uiActions, useUIStore } from './uiStore';

export type RightTab = 'calendar' | 'dobbin' | 'intake';

/** dobbin 탭 안에서 무엇을 펼쳐 놓았나. 🔴 **머리글은 하나뿐이다** —
 *  패널 공용 머리(접기 단추)와 dobbin 자기 머리가 겹쳐 디자인이 깨졌다
 *  (사용자 지적, 2026-08-12). 달력·검색은 **공용 머리 위에** 얹는다. */
export type DobbinView = 'none' | 'cal' | 'search';

interface S { tab: RightTab; view: DobbinView }
export const useRightTabStore = create<S>()(() => ({ tab: 'calendar', view: 'none' }));

export const rightActions = {
  pick: (tab: RightTab) => {
    const open = useUIStore.getState().showHoverPanel;
    const cur = useRightTabStore.getState().tab;
    if (open && cur === tab) { uiActions.setShowHoverPanel(false); return; }
    useRightTabStore.setState({ tab });
    if (!open) uiActions.setShowHoverPanel(true);
  },
  get: () => useRightTabStore.getState().tab,
  /** 같은 것을 다시 누르면 접힌다 */
  view: (v: DobbinView) =>
    useRightTabStore.setState((s) => ({ view: s.view === v ? 'none' : v })),
};
export const useRightTab = () => useRightTabStore((s) => s.tab);
export const useDobbinView = () => useRightTabStore((s) => s.view);
