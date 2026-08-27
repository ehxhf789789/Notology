/**
 * 알림함 — **dobbin 이 먼저 말하고, 쌓인다** (UIUX_PLAN P3)
 *
 * 사용자 (2026-08-27): *"dobbin 이 알림이나 적극적으로 관리할 수 있으며,
 * 내가 그것을 볼 수 있는 구조로."*
 *
 * 🔴 전 판은 말풍선이 8초 뒤 사라졌다 — *"알림도 잘리고, 뭘 하라는 거지?"*
 *    여기서는 사라지지 않고, 줄마다 **무엇을 하면 되는지**가 붙는다.
 *    읽었는지는 사람이 정한다 (마지막으로 본 시각 이후가 «새 것»).
 */
import { useCallback, useEffect, useState } from 'react';
import { Check, HelpCircle, CalendarClock, Archive } from 'lucide-react';
import { uiActions } from '../../core/stores/uiStore';
import { hoverActions } from '../hover-windows/stores/hoverStore';
import './notice.css';

export interface Notice {
  id: string; kind: string; at?: string | null; text: string;
  act?: { label: string; go: string };
}

const SEEN_KEY = 'dobbin.noticesSeen';

/** 배지용 — 안 본 알림 수. 화면 여러 곳이 같은 자를 쓴다. */
export function unseenCount(list: Notice[]): number {
  const seen = new Set<string>(JSON.parse(localStorage.getItem(SEEN_KEY) || '[]'));
  return list.filter(n => !seen.has(n.id)).length;
}

export function markAllSeen(list: Notice[]): void {
  localStorage.setItem(SEEN_KEY, JSON.stringify(list.map(n => n.id).slice(0, 200)));
}

const ICON: Record<string, React.ReactNode> = {
  ask: <HelpCircle size={13} />,
  done: <Check size={13} />,
  due: <CalendarClock size={13} />,
  today: <CalendarClock size={13} />,
  kept: <Archive size={13} />,
};

export function useNotices(pollMs = 20000) {
  const [list, setList] = useState<Notice[]>([]);
  const load = useCallback(() => {
    fetch('/api/notices').then(r => r.json())
      .then(j => setList(j?.notices ?? []))
      .catch(() => { /* 조용히 — 알림이 못 와도 화면은 산다 */ });
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, pollMs);
    const h = () => load();
    window.addEventListener('dobbin:live', h);
    return () => { clearInterval(t); window.removeEventListener('dobbin:live', h); };
  }, [load, pollMs]);
  return { list, reload: load };
}

export function NoticeList({ list }: { list: Notice[] }) {
  const [seen, setSeen] = useState<Set<string>>(() =>
    new Set(JSON.parse(localStorage.getItem(SEEN_KEY) || '[]')));

  // 열어 두면 본 것으로 친다 — 다만 **줄은 사라지지 않는다**
  useEffect(() => {
    if (!list.length) return;
    const t = setTimeout(() => {
      markAllSeen(list);
      setSeen(new Set(list.map(n => n.id)));
      window.dispatchEvent(new CustomEvent('dobbin:notices-seen'));
    }, 1200);
    return () => clearTimeout(t);
  }, [list]);

  const go = (to: string) => {
    if (to === 'home') uiActions.setShowDobbinHome(true);
    else if (to === 'calendar') uiActions.setShowCalendar(true);
    else void hoverActions.open(to);
  };

  if (!list.length) {
    return <div className="ntc__empty">알릴 것이 없습니다.</div>;
  }
  return (
    <div className="ntc">
      {list.map(n => (
        <div key={n.id} className={`ntc__row${seen.has(n.id) ? '' : ' is-new'}`}>
          <span className={`ntc__ico ntc__ico--${n.kind}`}>{ICON[n.kind] ?? null}</span>
          <div className="ntc__body">
            <p className="ntc__text">{n.text}</p>
            {n.act && (
              <button className="ntc__act" onClick={() => go(n.act!.go)}>
                {n.act.label}
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
