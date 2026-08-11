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
import { Send, Search, CalendarDays, Loader2, ArrowDown, Mic } from 'lucide-react';
import { useDobbinStore, dobbinActions } from './dobbinStore';
import { PenguinFace } from './PenguinFace';
import { clientTools, runTool, isRecording, recordingSeconds } from './clientTools';
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
  const [recTick, setRecTick] = useState(0);
  const [atEnd, setAtEnd] = useState(true);
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

  // 🔴 **보고 있는 자리를 뺏지 않는다.** 옛 대화를 읽는 중에 새 말이
  //    오면 아래로 끌어내리는 것은 방해다. 맨 아래에 있을 때만 따라간다.
  useEffect(() => {
    if (atEnd) endRef.current?.scrollIntoView();
  }, [hist.length, messages.length, atEnd]);

  // 녹음 중에는 1초마다 시간을 새로 그린다
  useEffect(() => {
    if (!isRecording()) return;
    const t = setInterval(() => setRecTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [recTick]);

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
        method: 'POST',
        headers: { 'Content-Type': 'application/json',
                   // 🔴 **내가 할 수 있는 일을 알린다** (MCP 꼴, clientTools.ts).
                   //    이게 없으면 dobbin은 못 하는 것을 하겠다고 말하게 된다.
                   'X-Client-Tools': clientTools().join(',') },
        body: JSON.stringify({ messages: turns }) });
      const j = await r.json();
      const msg = j?.choices?.[0]?.message;
      dobbinActions.push({ role: 'assistant',
        content: msg?.content ?? '(답이 비었습니다)',
        // 🔴 되물으면 누를 것을 함께 받는다 (서버 choices.py)
        choices: msg?.dobbin_choices ?? undefined });
      // 🔴 **시킨 도구를 실행한다.** 말로 시킨 일이 말로 끝나면 안 된다.
      if (msg?.dobbin_action) {
        runTool(msg.dobbin_action,
                (line) => dobbinActions.push({ role: 'assistant', content: line }),
                () => setRecTick((n) => n + 1));
      }
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
    setShowCal(false); setHits(null); setAtEnd(false);
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

      <div className="dsurf__body" ref={bodyRef}
           onScroll={(e) => {
             const el = e.currentTarget;
             setAtEnd(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
           }}>
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

      {/* 🔴 **녹음 중일 때만 보인다.** 평소에는 자리를 차지하지 않는다 —
          녹음은 말로 시키는 일이지 늘 눌러야 하는 단추가 아니다. */}
      {isRecording() && (
        <div className="dsurf__rec">
          <Mic size={13} />
          <span>녹음 중 {String(Math.floor(recordingSeconds() / 60)).padStart(2, '0')}
            :{String(recordingSeconds() % 60).padStart(2, '0')}</span>
          <button onClick={() => runTool({ tool: 'stop_record' },
                    (line) => dobbinActions.push({ role: 'assistant', content: line }),
                    () => setRecTick((n) => n + 1))}>그만</button>
        </div>
      )}


      {/* 🔴 **맨 아래로** (사용자 요청, 2026-08-12): 달력으로 옛 날짜에
          갔다가 되돌아올 길이 없으면 스크롤을 끝까지 끌어야 한다. */}
      {!atEnd && (
        <button className="dsurf__jump" title="가장 최근 대화로"
                onClick={() => { setHits(null); setAtEnd(true);
                                 endRef.current?.scrollIntoView({ behavior: 'smooth' }); }}>
          <ArrowDown size={14} /> 최근 대화로
        </button>
      )}

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
