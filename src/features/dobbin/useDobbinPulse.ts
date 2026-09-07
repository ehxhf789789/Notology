/**
 * dobbin 의 맥박 — **상태가 있어야 애니메이션이 있다** (2-14-2-2)
 *
 * 좌측 단추 하나가 dobbin 창을 제어하고 알림도 알린다 (2026-08-27 사용자).
 * 🔴 알림은 `noticeStore` 한 자리에서 가져온다 — 배지와 목록이 **같은 순간의
 *    같은 값**을 봐야 한다 (전에는 각자 20초마다 물어 어긋날 수 있었다).
 *
 * v6 ⓐ (2026-09-08) — 시간축 2층·상태 거짓말 수리:
 *   반응(react): busy 끝 → 서버 정서가 «뿌듯»일 때만 found 한 번 (기권인데
 *   폴짝 금지) → 바탕으로 복귀. 답 만드는 중 검색 단계는 reading 이 정직하나
 *   그 신호(SSE thought)는 문장이라 — 여기선 thinking 하나로 둔다 (지어내지
 *   않는다). 바탕(ambient): alert(알림) > idle. found 복귀처가 idle 고정이던
 *   결함은 바탕 계산이 매 렌더 다시 서므로 구조적으로 사라진다.
 */
import { useEffect, useRef, useState } from 'react';
import { useDobbinStore } from './dobbinStore';
import { useUnseen } from './noticeStore';

export function useDobbinPulse() {
  const busy = useDobbinStore((s) => s.busy);
  const lastMood = useDobbinStore((s) => s.lastMood);
  const unseen = useUnseen();
  const [bounce, setBounce] = useState(false);
  const was = useRef(busy);
  useEffect(() => {
    if (was.current && !busy && lastMood === '뿌듯') {
      setBounce(true);
      const t = setTimeout(() => setBounce(false), 900);
      return () => clearTimeout(t);
    }
    was.current = busy;
  }, [busy, lastMood]);
  useEffect(() => { was.current = busy; }, [busy]);
  const ambient: 'idle' | 'alert' = unseen > 0 ? 'alert' : 'idle';
  const mood: 'idle' | 'thinking' | 'alert' | 'found' =
    busy ? 'thinking' : bounce ? 'found' : ambient;
  return { mood, unseen, busy };
}
