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
import { PenguinFace } from './PenguinFace';
import { IntakePanel } from './IntakePanel';
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

export function DobbinHome() {
  const { ref, narrow } = useNarrow<HTMLDivElement>();
  const [brief, setBrief] = useState<string | null>(null);
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
      .then(j => { if (!dead) setBrief((j?.say || '').trim() || null); })
      .catch(() => { /* 브리핑이 없으면 그 줄은 없다 — 빈 인사를 만들지 않는다 */ });
    return () => { dead = true; };
  }, []);

  return (
    <div ref={ref} className={`dhome${narrow ? ' is-narrow' : ''}`}>
      <header className="dhome__hero">
        <span className="dhome__icon" aria-hidden="true">
          <PenguinFace mood="idle" size={26} />
        </span>
        <div className="dhome__text">
          <h1 className="dhome__title">dobbin</h1>
          <p className="dhome__sub">이 서재를 관리합니다</p>
        </div>
        {/* 🔴 두 자리를 오가는 길을 **각 화면에 하나씩** 둔다 (숨은 조작 금지).
            여기서는 «곁에 두기» — 노트를 보면서 흘끗 볼 때. */}
        {/* 🔴 닫기 단추를 두지 않는다 (2026-08-27 사용자) — 컨테이너를
            누르면 저절로 닫히고, 좌측 dobbin 단추가 토글이다. 오른쪽 위에
            단추를 놓으면 우측 탭(달력)을 가린다. */}
      </header>

      {/* 브리핑 — 할 말이 있을 때만 (2-10-1: 빈 인사는 하지 않는다).
          🔴 죽은 줄이었다: 잘려 보이는데 눌러도 아무 일이 없었다.
             누르면 펼친다 — 잘린 글을 보는 것이 사람이 원한 일이다. */}
      {brief && (
        <button className={`dhome__brief${briefOpen ? ' is-open' : ''}`}
                title={briefOpen ? '접기' : '전부 보기'}
                onClick={() => setBriefOpen(v => !v)}>
          {briefOpen ? brief : brief.split('\n')[0]}
        </button>
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
