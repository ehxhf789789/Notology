/**
 * dobbin 대화 — 오른쪽 탭 안에서 (사용자 요청, 2026-08-11)
 *
 *   *"지난대화(날짜별검색) 버튼을 누르면 전체화면으로 되는 게 아니라, 기존
 *     창에서, 달력이 뜨면서 달력의 날짜를 클릭하면(대화 기록이 있는 날짜만
 *     활성화됨), 해당 날짜의 대화로 이동. 기존 창에 대화마다 카카오톡처럼
 *     보낸 시간이 보이도록하고, 날짜별로 대화를 구분. 그리고 기존 창에서
 *     검색 기능 추가(버튼 및 검색창)."*
 *
 * ## 🔴 전체화면으로 덮은 것이 틀렸다
 *
 * 앞서 만든 기록 화면은 창을 통째로 덮었다. 그러면 **자료를 보면서 대화를
 * 되짚을 수가 없다** — 이 서재에서 대화는 자료 옆에 있어야 한다.
 * 같은 창 안에서 날짜로 건너뛰고 찾는다.
 *
 * | | |
 * |---|---|
 * | 날짜 구분선 | 어제와 오늘 사이가 보여야 한다 |
 * | 시간 | 회의 전이었는지 후였는지가 뜻을 바꾼다 |
 * | 달력 | **대화가 있는 날만 켠다** — 빈 날을 누르게 하면 안 된다 |
 * | 검색 | 383마디가 넘으면 스크롤로는 못 찾는다 |
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Send, Search, CalendarDays, X, Loader2 } from 'lucide-react';
import { useDobbinStore, dobbinActions } from './dobbinStore';
import { PenguinFace } from './PenguinFace';
import { RecordButton } from './RecordButton';
import './surface.css';

type Msg = { role: string; content: string; at: string;
             choices?: { label: string; send: string }[] };
const DAY = ['일', '월', '화', '수', '목', '금', '토'];

function dayKey(iso: string) { return new Date(iso).toLocaleDateString('sv'); }
function dayLabel(iso: string) {
  const d = new Date(iso), t = new Date();
  const y = new Date(t); y.setDate(y.getDate() - 1);
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (same(d, t)) return '오늘';
  if (same(d, y)) return '어제';
  return `${d.getFullYear()}. ${d.getMonth() + 1}. ${d.getDate()}. ${DAY[d.getDay()]}`;
}
function timeLabel(iso: string) {
  const d = new Date(iso), h = d.getHours();
  return `${h < 12 ? '오전' : '오후'} ${h % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function DobbinSurface() {
  const { busy, messages } = useDobbinStore();
  const [draft, setDraft] = useState('');
  const [hist, setHist] = useState<Msg[]>([]);
  const [days, setDays] = useState<{ date: string; n: number }[]>([]);
  const [showCal, setShowCal] = useState(false);
  const [q, setQ] = useState('');
  const [showSearch, setShowSearch] = useState(false);
  const [hits, setHits] = useState<Msg[] | null>(null);
  const [month, setMonth] = useState(() => new Date());
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch('/api/conversation', { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit: 500 }) })
      .then(r => r.json()).then(j => setHist(j?.messages ?? [])).catch(() => {});
    fetch('/api/conversation/days', { method: 'POST' })
      .then(r => r.json()).then(j => setDays(j?.days ?? [])).catch(() => {});
  }, []);

  useEffect(() => { endRef.current?.scrollIntoView(); }, [hist.length, messages.length]);

  const send = useCallback(async (text: string) => {
    const t = text.trim();
    if (!t || busy) return;
    setDraft('');
    dobbinActions.push({ role: 'user', content: t });
    dobbinActions.setBusy(true);
    try {
      const turns = [...useDobbinStore.getState().messages]
        .map(m => ({ role: m.role, content: m.content }));
      const r = await fetch('/v1/chat/completions', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: turns }) });
      const j = await r.json();
      const msg = j?.choices?.[0]?.message;
      dobbinActions.push({ role: 'assistant',
        content: msg?.content ?? '(답이 비었습니다)',
        // 🔴 되물으면 누를 것을 함께 받는다 (서버 choices.py)
        choices: msg?.dobbin_choices ?? undefined });
    } catch {
      dobbinActions.push({ role: 'assistant', content: '서버에 닿지 못했습니다.' });
    }
    dobbinActions.setBusy(false);
  }, [busy]);

  const search = useCallback(async () => {
    if (!q.trim()) { setHits(null); return; }
    const r = await fetch('/api/conversation', { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: q.trim() }) });
    const j = await r.json();
    setHits(j?.messages ?? []);
  }, [q]);

  /** 🔴 그 날의 첫 마디로 건너뛴다 — 달력을 누르는 뜻이 그것이다. */
  const jump = useCallback((key: string) => {
    setShowCal(false); setHits(null);
    requestAnimationFrame(() => {
      const el = bodyRef.current?.querySelector(`[data-day="${key}"]`);
      el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }, []);

  const have = new Set(days.map(d => d.date));
  const shown: Msg[] = hits ?? [
    ...hist,
    ...messages.map(m => ({ role: m.role === 'assistant' ? 'dobbin' : 'user',
                            content: m.content, at: new Date().toISOString(),
                            choices: m.choices })),
  ];
  let last = '';

  // 달력 한 달치
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const cells: (Date | null)[] = Array(first.getDay()).fill(null);
  for (let d = 1; d <= new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate(); d++)
    cells.push(new Date(month.getFullYear(), month.getMonth(), d));

  return (
    <div className="dsurf">
      <header className="dsurf__head">
        <PenguinFace mood={busy ? 'thinking' : 'idle'} size={22} />
        <span className="dsurf__name">dobbin</span>
        <button className={`dsurf__icon${showCal ? ' on' : ''}`}
                title="날짜로 찾기" onClick={() => { setShowCal(v => !v); setShowSearch(false); }}>
          <CalendarDays size={15} />
        </button>
        <button className={`dsurf__icon${showSearch ? ' on' : ''}`}
                title="대화 검색" onClick={() => { setShowSearch(v => !v); setShowCal(false); }}>
          <Search size={15} />
        </button>
      </header>

      {/* 🔴 대화가 있는 날만 켠다 — 빈 날을 누르게 하면 안 된다 */}
      {showCal && (
        <div className="dsurf__cal">
          <div className="dsurf__cal-nav">
            <button onClick={() => setMonth(m => new Date(m.getFullYear(), m.getMonth() - 1, 1))}>‹</button>
            <span>{month.getFullYear()}. {month.getMonth() + 1}</span>
            <button onClick={() => setMonth(m => new Date(m.getFullYear(), m.getMonth() + 1, 1))}>›</button>
          </div>
          <div className="dsurf__cal-grid">
            {DAY.map(d => <span key={d} className="dsurf__dow">{d}</span>)}
            {cells.map((d, i) => {
              if (!d) return <span key={i} />;
              const key = d.toLocaleDateString('sv');
              const on = have.has(key);
              const n = days.find(x => x.date === key)?.n ?? 0;
              return (
                <button key={i} disabled={!on}
                        className={`dsurf__day${on ? ' has' : ''}`}
                        title={on ? `${n}마디` : '대화 없음'}
                        onClick={() => jump(key)}>
                  {d.getDate()}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {showSearch && (
        <div className="dsurf__search">
          <Search size={13} />
          <input value={q} autoFocus placeholder="대화 검색…"
                 onChange={e => setQ(e.target.value)}
                 onKeyDown={e => { if (e.key === 'Enter') search();
                                   if (e.key === 'Escape') { setQ(''); setHits(null); } }} />
          {hits && <button className="dsurf__hits"
                           onClick={() => { setQ(''); setHits(null); }}>
            {hits.length}건 · 전체로</button>}
        </div>
      )}

      <div className="dsurf__body" ref={bodyRef}>
        {shown.length === 0 && (
          <div className="dsurf__empty">무엇이든 물어보십시오.</div>
        )}
        {shown.map((m, i) => {
          const key = dayKey(m.at);
          const isNew = key !== last;
          last = key;
          const mine = m.role === 'user';
          return (
            <div key={i} data-day={isNew ? key : undefined}>
              {isNew && <div className="dsurf__daysep"><span>{dayLabel(m.at)}</span></div>}
              <div className={`dsurf__line${mine ? ' mine' : ''}`}>
                <div className="dsurf__bubble">{m.content}</div>
                <time className="dsurf__time">{timeLabel(m.at)}</time>
              </div>
              {/* 🔴 **지난 선택지는 살려 두지 않는다.** 이미 답한 물음의 단추가
                  남아 있으면 눌러도 흐름이 어긋난다 — 마지막 답에만 붙인다. */}
              {!mine && m.choices?.length && i === shown.length - 1 && !busy && (
                <div className="dsurf__picks">
                  {m.choices.map((c) => (
                    <button key={c.label} className="dsurf__pick"
                            onClick={() => c.send ? send(c.send)
                                                  : inputRef.current?.focus()}>
                      {c.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
        {busy && <div className="dsurf__busy"><Loader2 size={13} className="spin" /> 생각하는 중</div>}
        <div ref={endRef} />
      </div>

      {/* 🔴 심부름 ④ — 녹음에서 회의록까지 이 자리에서 끝난다 */}
      <RecordButton folder={null}
                    onDone={(j) => dobbinActions.push({ role: 'assistant',
                      content: j?.note
                        ? `회의록을 만들었습니다 — ${String(j.note)}`
                        : (j?.text ? `받아썼습니다 (${j.lines}줄). 어느 과제 회의였습니까?`
                                   : `받아쓰지 못했습니다: ${j?.why ?? j?.error ?? '알 수 없음'}`) })} />

      <div className="dsurf__input">
        <textarea ref={inputRef} rows={2} value={draft} placeholder="dobbin에게 묻기…  (Enter 전송)"
                  onChange={e => setDraft(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(draft); }
                  }} />
        <button disabled={busy || !draft.trim()} onClick={() => send(draft)}>
          <Send size={14} />
        </button>
      </div>
    </div>
  );
}
