/**
 * dobbin 홈 — **관리자가 무대에 선다** (docs/UIUX_PLAN.md P0)
 *
 * 사용자 (2026-08-27): *"자료 넣기의 우측 패널 자체가 불편하다"* ·
 * *"dobbin 이 관리자임에도 notology 와 별개로 보조 기능같이 보인다"*.
 *
 * 실측된 원인은 폭이 아니라 **자리**였다 (UIUX_PLAN ②):
 *
 *     우측 패널 280px 고정 · 세 탭이 한 자리 배타 · 닫으면 언마운트
 *     중앙 분기는 검색/컨테이너/빈 화면 셋 — **dobbin 이 없다**
 *
 * 그래서 오늘 할 일(확인할 것·최근 받음)이 280px 에 갇히고 이미 읽은 노트가
 * 전체 폭을 썼다. 중요도와 면적이 반대였다.
 *
 * 🔴 **새 화면을 지어내지 않는다.** 검색이 중앙을 쓰는 그 자리에 같은 규격
 *    (`search-hero` 의 여백·구분선·토큰)으로 서고, 안에는 **이미 있는 부품**
 *    을 넓게 놓는다 — 자료 넣기는 `IntakePanel`, 대화는 `DobbinSurface`.
 *    두 벌로 만들면 어긋난다 (이 저장소가 여러 번 겪은 실수).
 */
import { useEffect, useRef, useState } from 'react';
import { CalendarDays, Search as SearchIcon } from 'lucide-react';
import { PenguinFace, faceOf } from './PenguinFace';
import { IntakePanel } from './IntakePanel';
import { ClusterReview } from './ClusterReview';
import { NoticeList } from './NoticeList';
import { useNotices, markAllSeen } from './noticeStore';
import { DobbinSurface } from './DobbinSurface';
import { uiActions } from '../../core/stores/uiStore';
import { rightActions, useDobbinView } from '../../core/stores/rightTabStore';
import './home.css';

/** 좁아지면 세로로 접는다. 🔴 미디어쿼리로는 못 잰다 — 이 영역의 폭은
 *  창이 아니라 **사이드바·우측 패널이 얼마나 먹었나**로 정해진다. */
function useNarrow<T extends HTMLElement>(px = 900) {
  const ref = useRef<T>(null);
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([e]) => setNarrow(e.contentRect.width < px));
    ro.observe(el);
    return () => ro.disconnect();
  }, [px]);
  return { ref, narrow };
}

/** /api/briefing 이 이미 보내는 전부 (memos.py:2468~) — v7 2단계에서야
 *  화면이 소비한다. 감사(2026-09-08): «j?.say 한 칸만 읽고 나머지를 버렸다». */
type Brief = {
  say?: string; greeting?: string;
  mood?: { mood?: string; cause?: string };
  choices?: { label: string; send: string }[];
  overdue_live?: number; today?: number; inbox?: number;
};

/** /api/brain (v7 2단계 신설) — 없으면(옛 서버) 카드가 조용히 빠진다. */
type Brain = {
  memory?: { main?: number; volatile?: number; faded?: number; dead?: number;
             insights?: string[] };
  tend?: { today?: { label: string; n: number }[]; last?: string;
           quiet?: string[] };
  bench?: { name: string; value: string }[];
  senses?: { name: string; ok: boolean; note?: string }[];
};

export function DobbinHome() {
  const { ref, narrow } = useNarrow<HTMLDivElement>();
  const [brief, setBrief] = useState<Brief | null>(null);
  const [brain, setBrain] = useState<Brain | null>(null);
  const [briefOpen, setBriefOpen] = useState(false);
  const { list: notices } = useNotices();
  const report = notices;
  // 홈을 연 것이 곧 «봤다» — 좌측 배지는 그때 내려간다
  useEffect(() => {
    if (!notices.length) return;
    const t = setTimeout(() => {
      markAllSeen(notices);
      window.dispatchEvent(new CustomEvent('dobbin:notices-seen'));
    }, 900);
    return () => clearTimeout(t);
  }, [notices]);
  const dview = useDobbinView();
  const calOn = dview === 'cal';
  const findOn = dview === 'search';

  useEffect(() => {
    let dead = false;
    fetch('/api/briefing')
      .then(r => r.json())
      .then(j => { if (!dead && j) setBrief(j as Brief); })
      .catch(() => { /* 브리핑이 없으면 그 줄은 없다 — 빈 인사를 만들지 않는다 */ });
    fetch('/api/brain')
      .then(r => (r.ok ? r.json() : null))
      .then(j => { if (!dead && j) setBrain(j as Brain); })
      .catch(() => { /* 두뇌 계기판은 덤이다 — 옛 서버면 카드가 없다 */ });
    return () => { dead = true; };
  }, []);
  const say = (brief?.say || '').trim() || null;
  const badges: { k: string; n: number; tone: string }[] = [
    { k: '지난 기한', n: brief?.overdue_live ?? 0, tone: 'warn' },
    { k: '오늘·내일', n: brief?.today ?? 0, tone: 'info' },
    { k: '투입구', n: brief?.inbox ?? 0, tone: 'info' },
  ].filter(b => b.n > 0);

  return (
    <div ref={ref} className={`dhome${narrow ? ' is-narrow' : ''}`}>
      <header className="dhome__hero">
        {/* v7: idle 붙박이 → 브리핑의 바탕 정서 (걱정=alert · 반김=found …).
            cause 는 툴팁 — «왜 그 표정인가»의 근거 숫자가 서버에서 온다. */}
        <span className="dhome__icon" aria-hidden="true"
              title={brief?.mood?.cause || undefined}>
          <PenguinFace mood={faceOf(brief?.mood?.mood)} size={34} />
        </span>
        <div className="dhome__text">
          <h1 className="dhome__title">dobbin</h1>
          <p className="dhome__sub">{brief?.greeting || '이 서재를 관리합니다'}</p>
        </div>
        {badges.length > 0 && (
          <div className="dhome__badges">
            {badges.map(b => (
              <span key={b.k} className={`dhome__badge is-${b.tone}`}>
                {b.k} <b>{b.n}</b>
              </span>
            ))}
          </div>
        )}
        {/* 🔴 두 자리를 오가는 길을 **각 화면에 하나씩** 둔다 (숨은 조작 금지).
            여기서는 «곁에 두기» — 노트를 보면서 흘끗 볼 때. */}
        {/* 🔴 닫기 단추를 두지 않는다 (2026-08-27 사용자) — 컨테이너를
            누르면 저절로 닫히고, 좌측 dobbin 단추가 토글이다. 오른쪽 위에
            단추를 놓으면 우측 탭(달력)을 가린다. */}
      </header>

      {/* 브리핑 — 할 말이 있을 때만 (2-10-1: 빈 인사는 하지 않는다).
          🔴 죽은 줄이었다: 잘려 보이는데 눌러도 아무 일이 없었다.
             누르면 펼친다 — 잘린 글을 보는 것이 사람이 원한 일이다. */}
      {say && (
        <button className={`dhome__brief${briefOpen ? ' is-open' : ''}`}
                title={briefOpen ? '접기' : '전부 보기'}
                onClick={() => setBriefOpen(v => !v)}>
          {briefOpen ? say : say.split('\n')[0]}
        </button>
      )}
      {/* 브리핑이 주는 단추 — 누르면 그 말이 대화로 들어간다 (v7 2단계) */}
      {!!brief?.choices?.length && (
        <div className="dhome__brief-picks">
          {brief.choices.map(c => (
            <button key={c.label} className="dhome__brief-pick"
                    onClick={() => window.dispatchEvent(
                      new CustomEvent('dobbin:ask', { detail: c.send || c.label }))}>
              {c.label}
            </button>
          ))}
        </div>
      )}

      <div className="dhome__body">
        <div className="dhome__main">
          {/* 🔴 알림은 홈 안에 산다 (2026-08-27) — 탭의 벨은 걷었다.
              «확인할 것»은 바로 아래 카드가 맡으므로 여기서는 뺀다 —
              같은 말을 두 번 하지 않는다. */}
          {report.length > 0 && (
            <section className="dhome__report">
              <h2 className="dhome__h2">알림</h2>
              <NoticeList list={report} />
            </section>
          )}
          {/* v7 2단계 — 두뇌 계기판: 전부 서버가 잰 값이다 (/api/brain).
              기억 3층·오늘 일과가 한 일·관문 수치. 옛 서버면 카드가 없다. */}
          {brain && (
            <section className="dhome__report dhome__brain">
              <h2 className="dhome__h2">두뇌</h2>
              <div className="dbrain">
                {brain.memory && (
                  <div className="dbrain__col">
                    <h3>기억</h3>
                    <div className="dbrain__mem">
                      <span title="자주 꺼내 단단해진 기억">주기억 <b>{brain.memory.main ?? 0}</b></span>
                      <span title="쓰면 남고 안 쓰면 흐려지는 층">휘발성 <b>{brain.memory.volatile ?? 0}</b></span>
                      <span title="흐려져 잊힘 문턱 아래">망각 <b>{brain.memory.faded ?? 0}</b></span>
                    </div>
                    {!!brain.memory.insights?.length && (
                      <ul className="dbrain__list">
                        {brain.memory.insights.slice(0, 3).map((s, i) =>
                          <li key={i} title="잠(sleep) 회고가 근거 기억을 인용해 만든 통찰">{s}</li>)}
                      </ul>
                    )}
                  </div>
                )}
                {brain.tend && (
                  <div className="dbrain__col">
                    <h3>오늘 일과{brain.tend.last ? ` · ${brain.tend.last}` : ''}</h3>
                    {brain.tend.today?.length ? (
                      <ul className="dbrain__list">
                        {brain.tend.today.slice(0, 6).map((t, i) =>
                          <li key={i}>{t.label} <b>{t.n}</b></li>)}
                      </ul>
                    ) : <p className="dbrain__quiet">오늘은 아직 한 일이 없습니다</p>}
                    {!!brain.tend.quiet?.length && (
                      <p className="dbrain__starve"
                         title="최근 40회차에 자국이 없는 걸음 — 할 일이 없었거나 자리를 못 받았다">
                        조용한 걸음 {brain.tend.quiet.length}개
                        {brain.tend.quiet.length <= 6 ? ` — ${brain.tend.quiet.join(' · ')}` : ''}
                      </p>
                    )}
                  </div>
                )}
                {!!brain.bench?.length && (
                  <div className="dbrain__col">
                    <h3>관문</h3>
                    <ul className="dbrain__list">
                      {brain.bench.map((b, i) => <li key={i}>{b.name} <b>{b.value}</b></li>)}
                    </ul>
                  </div>
                )}
              </div>
            </section>
          )}
          <ClusterReview />
          <IntakePanel variant="home" />
        </div>
        <div className="dhome__chat">
          {/* 🔴 **만들어 둔 것을 버리지 않는다** (2026-08-27 사용자 지적).
              대화 달력·대화 검색은 DobbinSurface 안에 그대로 살아 있는데,
              패널 머리를 걷으면서 **여는 단추만** 사라졌었다. 여기 단다 —
              대화를 쓰는 자리에 붙는 것이 제자리이기도 하다. */}
          <div className="dhome__chat-head">
            <span className="dhome__chat-title">대화</span>
            <button className={`dhome__chat-btn${calOn ? ' is-on' : ''}`}
                    title="날짜로 대화 찾기"
                    onClick={() => rightActions.view('cal')}>
              <CalendarDays size={15} />
            </button>
            <button className={`dhome__chat-btn${findOn ? ' is-on' : ''}`}
                    title="대화 검색"
                    onClick={() => rightActions.view('search')}>
              <SearchIcon size={15} />
            </button>
          </div>
          <DobbinSurface />
        </div>
      </div>
    </div>
  );
}

export default DobbinHome;
