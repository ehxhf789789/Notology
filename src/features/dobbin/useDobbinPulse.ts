/**
 * dobbin 의 맥박 — **상태가 있어야 애니메이션이 있다** (2-14-2-2)
 *
 * 좌측 단추 하나가 dobbin 창을 제어하고 알림도 알린다 (2026-08-27 사용자).
 * 🔴 알림은 `noticeStore` 한 자리에서 가져온다 — 배지와 목록이 **같은 순간의
 *    같은 값**을 봐야 한다 (전에는 각자 20초마다 물어 어긋날 수 있었다).
 */
import { useDobbinStore } from './dobbinStore';
import { useUnseen } from './noticeStore';

export function useDobbinPulse() {
  const busy = useDobbinStore((s) => s.busy);
  const unseen = useUnseen();
  const mood: 'idle' | 'thinking' | 'alert' =
    busy ? 'thinking' : unseen > 0 ? 'alert' : 'idle';
  return { mood, unseen, busy };
}
