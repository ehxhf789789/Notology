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
import type { Mood } from './PenguinFace';

export function useDobbinPulse() {
  const busy = useDobbinStore((s) => s.busy);
  const lastMood = useDobbinStore((s) => s.lastMood);
  const unseen = useUnseen();
  // v7 3단계: 반응 표정 표 — 서버 정서 7종을 소비한다 (전에는 뿌듯 하나만).
  // 미안은 «사과하는 동안»(4초) 고개를 숙인다 — 사과하며 폴짝 금지 (v6 ⓐ).
  const [react, setReact] = useState<Mood | null>(null);
  const was = useRef(busy);
  useEffect(() => {
    if (was.current && !busy && lastMood) {
      const f: Mood | null =
        lastMood === '뿌듯' ? 'found' : lastMood === '미안' ? 'sorry' : null;
      if (f) {
        setReact(f);
        const t = setTimeout(() => setReact(null), f === 'sorry' ? 4000 : 900);
        was.current = busy;
        return () => clearTimeout(t);
      }
    }
    was.current = busy;
  }, [busy, lastMood]);
  const ambient: Mood = unseen > 0 ? 'alert' : 'idle';
  const mood: Mood = busy ? 'thinking' : react ?? ambient;
  return { mood, unseen, busy };
}
