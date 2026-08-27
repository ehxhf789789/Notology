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
import { PanelRight, X } from 'lucide-react';
import { PenguinFace } from './PenguinFace';
import { IntakePanel } from './IntakePanel';
import { DobbinSurface } from './DobbinSurface';
import { uiActions } from '../../core/stores/uiStore';
import { rightActions } from '../../core/stores/rightTabStore';
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
        {/* 🔴 이름이 동작과 달랐다 (2026-08-27) — «곁에 두기» 는 «둘 다
            보인다» 로 읽히는데 실제로는 홈을 닫고 패널로 옮긴다. 말을 맞춘다. */}
        <button className="dhome__aside" title="좁은 패널로 옮겨 노트를 보며 쓰기"
                onClick={() => { uiActions.setShowDobbinHome(false);
                                 rightActions.pick('dobbin'); }}>
          <PanelRight size={15} /> 패널로
        </button>
        {/* 🔴 나가는 길이 «패널로» 하나뿐이라 갇힌 느낌이었다 */}
        <button className="dhome__aside" title="닫기"
                onClick={() => uiActions.setShowDobbinHome(false)}>
          <X size={15} />
        </button>
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
          <IntakePanel variant="home" />
        </div>
        <div className="dhome__chat">
          <DobbinSurface />
        </div>
      </div>
    </div>
  );
}

export default DobbinHome;
