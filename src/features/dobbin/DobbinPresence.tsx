/**
 * dobbin이 거기 있다 — 살아 있는 사서 (CLAUDE.md 1-3의 정신)
 *
 * 사용자 지시 (2026-08-11):
 *   *"dobbin을 좀더 활동적인 AI로서, 도서관 사서 및 관리인으로써 애니메이션
 *     등으로 사용자를 적극적으로 돕도록 설계해줘."*
 *   *"서버로 접속했을 때도 인사말을 사라지는 말풍선으로 먼저 대화를 것도
 *     구현하는 등, 인간 친화적 AI로 설계해."*
 *
 * ## 🔴 살아 있음은 움직임이 아니라 **상태가 보이는 것**이다
 *
 * 그냥 흔들리는 아이콘은 장식이고, 두 번째부터는 거슬린다.
 * dobbin의 애니메이션은 전부 **지금 무슨 일이 일어나는지**를 말한다:
 *
 * | 상태 | 보이는 것 | 뜻 |
 * |---|---|---|
 * | `idle` | 느린 숨 (4초) | 듣고 있다 |
 * | `reading` | 책장이 넘어간다 | 자료를 읽는 중 |
 * | `thinking` | 점 세 개가 차례로 | 답을 만드는 중 |
 * | `found` | 한 번 튀어오름 | 찾았다 |
 * | `alert` | 붉은 맥박 | 지난 기한이 있다 |
 *
 * **상태가 없으면 애니메이션도 없다.** 조용할 때 조용한 것이 살아 있는 것에
 * 더 가깝다 — 늘 움직이는 것은 기계다.
 *
 * ## 🔴 인사는 한 번만, 그리고 스스로 사라진다
 *
 * 매번 인사하면 세 번째부터 닫는 버튼만 찾게 된다 (2-14-3의 질문 규율과
 * 같은 이유). 할 말이 있을 때만 뜨고, 8초 뒤 스스로 사라진다.
 *
 * ## 🔴 그림 파일을 쓰지 않는다
 *
 * 아티팩트 CSP와 같은 이유이자 더 실질적인 이유: 이 앱은 자기 완결이어야
 * 한다. dobbin은 **CSS 도형과 SVG 인라인**으로만 그린다 — 받아올 것이 없다.
 */

import { useEffect, useRef, useState } from 'react';
import { useDobbinStore, dobbinActions } from './dobbinStore';
import './presence.css';

export type Mood = 'idle' | 'reading' | 'thinking' | 'found' | 'alert';

// 🔴 얼굴을 **펭귄**으로 바꿨다 (사용자, 2026-08-11). 상태가 곧 움직임이라는
//    규율은 그대로다 (2-14-2-2) — 장식용 움직임은 없다.
import { PenguinFace } from './PenguinFace';
import './penguin.css';

const Face = PenguinFace;

export function DobbinPresence() {
  const busy = useDobbinStore((s) => s.busy);
  const open = useDobbinStore((s) => s.open);
  const [mood, setMood] = useState<Mood>('idle');
  const [hello, setHello] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  const shown = useRef(false);

  // 답을 만드는 동안은 생각한다. 끝나면 한 번 튀고 가라앉는다.
  useEffect(() => {
    if (busy) { setMood('thinking'); return; }
    setMood((m) => (m === 'thinking' ? 'found' : m));
    const t = setTimeout(() => setMood((m) => (m === 'found' ? 'idle' : m)), 900);
    return () => clearTimeout(t);
  }, [busy]);

  // 🔴 접속했을 때 먼저 말을 건다. **할 말이 있을 때만.**
  useEffect(() => {
    if (shown.current) return;
    shown.current = true;
    let dead = false;
    const t0 = setTimeout(() => {
      fetch('/api/briefing', { method: 'POST' })
        .then((r) => r.json())
        .then((j) => {
          if (dead) return;
          const line = (j?.say || '').split('\n')[0];
          const greet = j?.overdue
            ? `지난 기한 ${j.overdue}건이 있습니다`
            : line || null;
          if (!greet) return;                  // 조용할 땐 조용히 있는다
          if (j?.overdue) setMood('alert');
          setHello(greet);
          setTimeout(() => setLeaving(true), 7000);
          setTimeout(() => { setHello(null); setLeaving(false); }, 8000);
        })
        .catch(() => {});
    }, 1400);                                  // 화면이 자리를 잡은 뒤에 말한다
    return () => { dead = true; clearTimeout(t0); };
  }, []);

  return (
    <button
      className={`dob-presence${open ? ' is-open' : ''} dob-presence--${mood}`}
      onClick={() => dobbinActions.toggle()}
      title="dobbin — 이 서재의 사서 (Ctrl+K)"
      aria-label="dobbin 열기"
    >
      <Face mood={mood} />
      <span className="dob-presence__name">dobbin</span>
      {hello && (
        <span className={`dob-bubble${leaving ? ' is-leaving' : ''}`}
              onClick={(e) => { e.stopPropagation(); setLeaving(true); }}>
          {hello}
        </span>
      )}
    </button>
  );
}
