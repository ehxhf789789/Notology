/**
 * dobbin 의 맥박 — **상태가 있어야 애니메이션이 있다** (2-14-2-2)
 *
 * 좌측 단추 하나가 dobbin 창을 제어하고 알림도 알린다 (2026-08-27 사용자).
 * 그러려면 그 단추가 **지금 무슨 일이 일어나는지** 알아야 한다:
 *
 *     읽는 중        thinking   책장이 넘어간다
 *     알릴 것 있음    alert      붉게 맥박한다
 *     그 외          idle       느린 숨
 */
import { useEffect, useState } from 'react';
import { useDobbinStore } from './dobbinStore';

const SEEN_KEY = 'dobbin.noticesSeen';

export function useDobbinPulse() {
  const busy = useDobbinStore((s) => s.busy);
  const [unseen, setUnseen] = useState(0);

  useEffect(() => {
    const load = () => fetch('/api/notices').then(r => r.json())
      .then(j => {
        const seen = new Set<string>(
          JSON.parse(localStorage.getItem(SEEN_KEY) || '[]'));
        setUnseen((j?.notices ?? [])
          .filter((n: { id: string }) => !seen.has(n.id)).length);
      }).catch(() => { /* 조용히 — 알림이 못 와도 화면은 산다 */ });
    load();
    const t = setInterval(load, 20000);
    window.addEventListener('dobbin:live', load);
    window.addEventListener('dobbin:notices-seen', load);
    return () => { clearInterval(t);
      window.removeEventListener('dobbin:live', load);
      window.removeEventListener('dobbin:notices-seen', load); };
  }, []);

  const mood: 'idle' | 'thinking' | 'alert' =
    busy ? 'thinking' : unseen > 0 ? 'alert' : 'idle';
  return { mood, unseen, busy };
}
