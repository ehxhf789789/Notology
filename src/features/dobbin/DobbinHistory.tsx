/**
 * 대화 기록 — 날짜로 묶고 시간을 붙이고 찾을 수 있게 (CLAUDE.md 2-14-13)
 *
 * 사용자 요구 (2026-08-11):
 *   *"dobbin과 대화 기록을 카카오톡처럼, 날짜별로, 시간 표시를 해서 대화
 *     기록을 찾을 수 있거나, 검색할 수 있는 기능도 추가해서, dobbin과 대화한
 *     내용을 모두 저장해서 카카오톡처럼 찾을 수 있는 기능을 추가해줘."*
 *
 * ## 🔴 왜 카카오톡 방식이 맞나
 *
 * 대화는 **시간축의 기록**이다. 목록처럼 훑는 것이 아니라 *"그때 뭐라고
 * 했더라"* 로 되짚는다. 그래서 세 가지가 필요하다:
 *
 * | | 왜 |
 * |---|---|
 * | **날짜 구분선** | 어제와 오늘 사이가 보여야 한다 |
 * | **시간 표시** | 회의 전이었는지 후였는지가 뜻을 바꾼다 |
 * | **검색** | 300마디가 넘으면 스크롤로는 못 찾는다 |
 *
 * 🔴 **지우는 단추는 없다.** 대화는 dobbin이 무엇을 했는지 감시하는 근거이기도
 *    하다 (사용자: *"대화 비우기 같은 버튼은 위험하니까 제거"*).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Search, X, ArrowDown } from 'lucide-react';
import './history.css';

type Msg = { role: string; content: string; lane?: string | null; at: string };

const DAY = ['일', '월', '화', '수', '목', '금', '토'];

/** 「2026년 8월 11일 화요일」 — 카카오톡의 날짜 구분선. */
function dayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const y = new Date(today); y.setDate(y.getDate() - 1);
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (same(d, today)) return '오늘';
  if (same(d, y)) return '어제';
  return `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일 ${DAY[d.getDay()]}요일`;
}

/** 「오후 7:42」 */
function timeLabel(iso: string): string {
  const d = new Date(iso);
  const h = d.getHours();
  const ap = h < 12 ? '오전' : '오후';
  const hh = h % 12 || 12;
  return `${ap} ${hh}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function DobbinHistory({ onClose }: { onClose: () => void }) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Msg[] | null>(null);
  const [loading, setLoading] = useState(true);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch('/api/conversation', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit: 500 }),
    })
      .then(r => r.json())
      .then(j => { setMsgs(j?.messages ?? []); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  // 처음 열면 맨 아래(최근)로 — 카카오톡과 같다
  useEffect(() => {
    if (!loading && !hits) endRef.current?.scrollIntoView();
  }, [loading, hits]);

  const search = useCallback(async () => {
    if (!q.trim()) { setHits(null); return; }
    try {
      const r = await fetch('/api/conversation', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: q.trim() }),
      });
      const j = await r.json();
      setHits(j?.messages ?? []);
    } catch { setHits([]); }
  }, [q]);

  const shown = hits ?? msgs;
  let lastDay = '';

  return (
    <div className="dob-history">
      <header className="dob-history__head">
        <span className="dob-history__title">dobbin과 나눈 이야기</span>
        <span className="dob-history__count">{msgs.length}마디</span>
        <button className="dob-history__x" onClick={onClose} aria-label="닫기">
          <X size={15} />
        </button>
      </header>

      <div className="dob-history__search">
        <Search size={14} />
        <input
          value={q}
          placeholder="대화 검색…  (예: 표준화, 정산, 회의록)"
          onChange={e => setQ(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') search();
                            if (e.key === 'Escape') { setQ(''); setHits(null); } }}
        />
        {hits && (
          <button className="dob-history__clear"
                  onClick={() => { setQ(''); setHits(null); }}>
            {hits.length}건 · 전체로
          </button>
        )}
      </div>

      <div className="dob-history__body">
        {loading && <div className="dob-history__empty">불러오는 중…</div>}
        {!loading && shown.length === 0 && (
          <div className="dob-history__empty">
            {hits ? '그런 말은 없었습니다.' : '아직 나눈 이야기가 없습니다.'}
          </div>
        )}
        {shown.map((m, i) => {
          const day = dayLabel(m.at);
          const newDay = day !== lastDay;
          lastDay = day;
          const mine = m.role === 'user';
          return (
            <div key={i}>
              {/* 🔴 날짜가 바뀌면 선을 긋는다 — 어제와 오늘이 붙어 있으면 못 읽는다 */}
              {newDay && <div className="dob-day"><span>{day}</span></div>}
              <div className={`dob-line${mine ? ' mine' : ''}`}>
                <div className="dob-bubble2">{m.content}</div>
                <time className="dob-time" title={m.at}>{timeLabel(m.at)}</time>
              </div>
            </div>
          );
        })}
        <div ref={endRef} />
      </div>

      {!hits && (
        <button className="dob-history__bottom"
                onClick={() => endRef.current?.scrollIntoView({ behavior: 'smooth' })}>
          <ArrowDown size={13} /> 최근으로
        </button>
      )}
    </div>
  );
}
