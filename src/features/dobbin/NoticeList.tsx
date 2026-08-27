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
import { markAllSeen } from './noticeStore';
import { hoverActions } from '../hover-windows/stores/hoverStore';
import './notice.css';

export interface Notice {
  id: string; kind: string; at?: string | null; text: string;
  act?: { label: string; go: string };
}

// 🔴 가져오기·세기는 noticeStore 한 자리에서 한다 (2026-08-27) — 두 화면이
//    각자 20초마다 물어 서로 다른 순간의 값을 보이던 것을 합쳤다.
const SEEN_KEY = 'dobbin.noticesSeen';

const ICON: Record<string, React.ReactNode> = {
  ask: <HelpCircle size={13} />,
  done: <Check size={13} />,
  due: <CalendarClock size={13} />,
  today: <CalendarClock size={13} />,
  kept: <Archive size={13} />,
};

export function NoticeList({ list }: { list: Notice[] }) {
  const [seen, setSeen] = useState<Set<string>>(() =>
    new Set(JSON.parse(localStorage.getItem(SEEN_KEY) || '[]')));

  // 열어 두면 본 것으로 친다 — 다만 **줄은 사라지지 않는다**
  useEffect(() => {
    if (!list.length) return;
    const t = setTimeout(() => {
      markAllSeen(list);
      setSeen(new Set(list.map(n => n.id)));
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
