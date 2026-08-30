/**
 * 투입 검수 — 확신 있는 것은 꽂고, 모호한 것은 묻는다 (CLAUDE.md 1-2-1)
 *
 * 사용자 요구 (2026-08-11):
 *   *"마구잡이로 파일을 추가하면, 확신이 높은 파일 말고 모호하다고 판단되는
 *     파일들은 dobbin이 버튼에 말풍선으로 질문이 있다는 표시를 해서, 해당
 *     파일의 미리보기를 보여주고, 나는 이렇게 판단했는데 이게 맞느냐"*
 *   *"추가된 마구잡이 파일들 목록과, dobbin이 분석중이라는 로딩 애니메이션,
 *     확신도가 높은 자료는 어떻게 분류했다는 결과와 애매한 것들을 질문하는 UI"*
 *
 * ## 🔴 묻는 방식이 이 화면의 전부다
 *
 * 2-14-3: *"백지 질문 금지 — 내 추정 + 근거를 포함한다. 사람은 확인만."*
 * 그래서 질문 하나에 **네 가지**가 함께 있다:
 *
 * ```
 * 자문의견서_김현승.pdf                 ← 무엇을
 * [미리보기]                            ← 눈으로 확인
 * 제 판단: 표준화 과제 · 공문 · 결의     ← 내 추정
 * 근거: 원본 경로에 「표준화 과제」      ← 왜 그렇게 봤나
 * [맞습니다] [다른 곳] [나중에]         ← 누르기만
 * ```
 *
 * 🔴 **연번은 묶여서 온다** (1-2-1). `스캔_1~3.png` 는 한 질문이다 —
 *    3개로 쪼개면 사람이 병목이 된다.
 */

import { useCallback, useEffect, useState } from 'react';
import { Loader2, Check, FolderInput, HelpCircle } from 'lucide-react';
import { openFile, downloadUrl } from '../../web/files';
import { selectContainer } from '../../core/stores/appActions';
import { hoverActions } from '../hover-windows/stores/hoverStore';
import './intake.css';

/** 언제 — 「방금 · 3시간 전 · 어제 · 8/25」. 사람이 읽는 말로. */
function when(iso: string): string {
  const t = new Date(iso).getTime();
  if (!t) return '';
  const m = Math.floor((Date.now() - t) / 60000);
  if (m < 2) return '방금';
  if (m < 60) return `${m}분 전`;
  if (m < 24 * 60) return `${Math.floor(m / 60)}시간 전`;
  if (m < 48 * 60) return '어제';
  const d = new Date(t);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

const CARD_MAX = 6;   // 카드로 낼 최대 (그 위는 한 줄로)

type Step = { step: string; note?: string; steps: string[] };
type Recent = { name: string; state: string; at?: string | null;
  folder?: string | null; open?: string | null; note?: string | null; };

type Q = {
  id: number; group: string; count: number; names: string[]; paths: string[];
  guess: { folder?: string | null; doc_type?: string | null; stage?: string | null };
  why: string[]; confidence: number; ask: string; excerpt?: string | null;
  options: { label: string; value: string }[];
};
type Counts = { filed?: number; reading?: number; questions?: number;
                by_state?: Record<string, number> };

// 🔴 그림으로 보여줄 수 있는 것 — PDF는 서버가 첫 장을 뽑아 준다
const THUMBABLE = /\.(pdf|png|jpe?g|gif|webp|svg)$/i;

export function IntakePanel({ variant = 'panel' }: { variant?: 'panel' | 'home' } = {}) {
  const [qs, setQs] = useState<Q[]>([]);
  const [total, setTotal] = useState(0);
  const [recent, setRecent] = useState<Recent[]>([]);
  // 🔴 지금 무슨 걸음인지 (2026-08-30 사용자: «처리중» UI)
  const [prog, setProg] = useState<Record<string, Step>>({});
  const [counts, setCounts] = useState<Counts>({});
  const [busy, setBusy] = useState(false);
  const [folders, setFolders] = useState<string[]>([]);
  const [picking, setPicking] = useState<number | null>(null);
  const [pick, setPick] = useState('');
  const [said, setSaid] = useState<string>('');

  const load = useCallback(async (scan = false) => {
    setBusy(true);
    try {
      if (scan) {
        await fetch('/api/intake', { method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'scan' }) });
      }
      const r = await fetch('/api/intake', { method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'questions' }) });
      const j = await r.json();
      setQs(j?.questions ?? []);
      setTotal(j?.total ?? (j?.questions ?? []).length);
      setRecent(j?.recent ?? []);
      setCounts(j?.counts ?? {});
      // 🔴 걸음은 투입구가 안다 (`/api/inbox` · intake.progress)
      try {
        const ir = await fetch('/api/inbox', { method: 'POST',
          headers: { 'Content-Type': 'application/json' }, body: '{}' });
        setProg(((await ir.json())?.progress ?? {}) as Record<string, Step>);
      } catch { /* 조용히 */ }
    } catch { /* 조용히 */ }
    setBusy(false);
  }, []);

  useEffect(() => { load(true); }, [load]);

  // 새 파일이 들어오면 다시 읽는다 (SSE)
  useEffect(() => {
    const h = (e: Event) => {
      const d = (e as CustomEvent).detail;
      if (d?.kind === 'inbox-changed') {
        // 🔴 화면이 먼저 반응한다 (P5) — 서버 판정(수 초)을 기다리지 않고
        //    «지금 읽고 있다» 줄부터 세운다. 판정이 오면 load 가 갈아 끼운다.
        if (d?.path && d?.step) {
          // 🔴 서버가 걸음을 실어 보내면 **그 자리에서** 갈아 끼운다 —
          //    load 를 기다리면 한 걸음이 늦는다.
          setProg((pv) => ({ ...pv, [String(d.path)]: {
            step: String(d.step), note: d.note ? String(d.note) : '',
            steps: pv[String(d.path)]?.steps
                   ?? ['읽는 중', '해석하는 중', '자리 정하는 중', '노트 쓰는 중', '끝'],
          } }));
        }
        if (d?.path) {
          const nm = String(d.path).split('/').pop() || String(d.path);
          setRecent((prev) => prev.some((r) => r.name === nm) ? prev
            : [{ name: nm, state: 'reading', at: new Date().toISOString(),
                 folder: null, open: null, note: null }, ...prev]);
        }
        load(true);
      }
    };
    window.addEventListener('dobbin:live', h);
    return () => window.removeEventListener('dobbin:live', h);
  }, [load]);

  const answer = useCallback(async (id: number, value: string, folder?: string) => {
    setBusy(true);
    try {
      const r = await fetch('/api/intake', { method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'answer', id, value, folder }) });
      const j = await r.json();
      if (j?.say) setSaid(j.say);
    } catch { /* 조용히 */ }
    setPicking(null);
    load();
  }, [load]);

  // 제안한 자리가 있는 것만 일괄 대상 — «모르겠다» 에 «맞습니다» 는 뜻이 없다
  const sure = qs.filter((q) => {
    const g = (q.guess ?? {}) as { folder?: string; provisional?: string };
    return !!(g.folder || g.provisional);
  });
  const answerMany = useCallback(async (ids: number[]) => {
    setBusy(true);
    try {
      const r = await fetch('/api/intake', { method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'answer_many', ids, value: 'yes' }) });
      const j = await r.json();
      setSaid(j?.say ?? '');
      await load();
    } finally { setBusy(false); }
  }, [load]);

  const pickFolders = useCallback(async (id: number) => {
    if (!folders.length) {
      const r = await fetch('/api/intake', { method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'folders' }) });
      const j = await r.json();
      setFolders(j?.folders ?? []);
    }
    setPicking(id);
  }, [folders.length]);

  /** 최근 받은 한 줄 — 이름은 크게(끌 수 있게), 자리는 작게. */
  const recentRow = (r: Recent) => (
    <div key={r.name + (r.at ?? '')} className="intake__r">
      <span
        className="intake__r-name"
        title="누르면 그 노트가 열립니다 · 끌면 파일로 나갑니다"
        draggable
        onDragStart={(e) => {
          if (!r.open) return;
          const url = new URL(downloadUrl(r.open), location.origin).href;
          e.dataTransfer.setData('DownloadURL',
            `application/octet-stream:${r.name}:${url}`);
          e.dataTransfer.setData('text/uri-list', url);
          e.dataTransfer.effectAllowed = 'copy';
        }}
        onClick={() => {
          if (r.note) void hoverActions.open(r.note);
          else if (r.open) openFile(r.open, r.name);
        }}
      >{r.name}</span>
      {/* 🔴 점만으로는 무슨 뜻인지 모른다 — 글자로 적는다. 그리고 «최근»
          인데 언제인지가 없었다 (2026-08-27 적대 검토). */}
      {(() => {
        // 🔴 **무슨 걸음인지 짚어 보여준다** (2026-08-30 사용자 지시).
        //    「읽는 중…」 하나로 굳어 있으면 멈춘 것과 구별이 안 된다.
        const pk = Object.keys(prog).find(k => k.split('/').pop() === r.name);
        const pv = pk ? prog[pk] : null;
        if (!pv || pv.step === '끝') return null;
        const i = pv.steps.indexOf(pv.step);
        return (
          <span className="intake__steps" title={pv.note || pv.step}>
            {pv.steps.slice(0, -1).map((st, k) => (
              <i key={st}
                 className={'intake__step' + (k < i ? ' is-done' : k === i ? ' is-now' : '')} />
            ))}
            <span className="intake__r-at">{pv.step}{pv.note ? ` · ${pv.note}` : ''}</span>
          </span>
        );
      })()}
      {r.state === 'reading' && !Object.keys(prog).some(k => k.split('/').pop() === r.name)
        && <span className="intake__r-at">읽는 중…</span>}
      {r.at && r.state !== 'reading' && <span className="intake__r-at">{when(r.at)}</span>}
      {r.folder && (
        <button className="intake__r-loc" title="이 칸으로 이동"
                onClick={() => selectContainer('library:' + r.folder!)}>
          {r.state === 'asking' ? '정리 중 · ' : ''}{r.folder}
        </button>
      )}
    </div>
  );

  const got = (counts.by_state?.filed ?? 0) + (counts.by_state?.asking ?? 0)
            + (counts.by_state?.answered ?? 0);

  return (
    <div className={`intake${variant === 'home' ? ' intake--home' : ''}`}>
      <div className="intake__sum">
        {/* 🔴 «받음·꽂음» 은 서가 안에서 쓰는 말이지 사람에게 할 말이 아니다
            (2026-08-27 사용자: 표현을 친화적으로). 무슨 일이 있었는지를
            그대로 적는다. */}
        <span title="넣어 주신 자료 가운데 dobbin 이 읽은 것의 누적입니다">
          <FolderInput size={13} /> 받은 자료 {got}
        </span>
        <span className="ok" title="dobbin 이 스스로 자리를 정해 넣어 둔 것">
          <Check size={13} /> 정리 완료 {counts.filed ?? 0}
        </span>
        {qs.length > 0 && (
          <span className="ask" title="한 번씩 눌러 주시면 끝납니다">
            <HelpCircle size={13} /> 확인 부탁 {qs.length}
          </span>
        )}
        {busy && <span className="busy"><Loader2 size={13} className="spin" /> 읽는 중</span>}
      </div>

      {said && <div className="intake__said">{said}</div>}

      {!busy && qs.length === 0 && recent.length === 0 && (
        <div className="intake__empty">
          창 아무 데나 파일을 놓으시면<br /><span>읽고 정리하겠습니다.</span>
        </div>
      )}

      {/* 🔴 **행동이 먼저 보인다** (2026-08-27 사용자: 자료 넣기 UI/UX 가
          불편하다). 전 판은 발췌 260자와 근거 목록이 카드 위쪽을 다 먹어
          정작 누를 단추가 화면 밖에 있었다. 이제 «어디 두었나 → 단추» 가
          위에 오고, 근거·미리보기·파일은 필요할 때 편다. */}
      {/* 🔴 **100건이어도 무너지지 않는다** (2026-08-27 사용자: 확장성이
          전혀 고려되지 않은 구조다). 카드는 읽고 판단하는 물건이라 여섯 장이
          넘으면 훑는 물건이 된다 — 앞의 여섯만 카드로 두고 나머지는 한 줄씩,
          그리고 «제안대로 모두» 한 번으로 끝낼 길을 준다. */}
      {sure.length > 1 && (
        <div className="intake__bulk">
          <span>제안한 자리가 있는 것이 {sure.length}건입니다.</span>
          <button onClick={() => answerMany(sure.map((q) => q.id))}>
            그대로 모두 확정
          </button>
        </div>
      )}

      {qs.slice(0, CARD_MAX).map((q) => {
        const g = q.guess ?? {};
        const first = q.paths?.[0];
        const canThumb = !!first && THUMBABLE.test(first);
        const prov = (g as { provisional?: string }).provisional;
        const where = g.folder || prov;
        return (
          <div key={q.id} className="intake-q">
            <div className="intake-q__head">
              <span className="intake-q__name">{q.group}</span>
              {q.count > 1 && <span className="intake-q__n">{q.count}건</span>}
            </div>

            <div className="intake-q__guess">
              {prov ? '우선 여기 두었습니다 · ' : '이렇게 보입니다 · '}
              {where ? <b>{where}</b> : <em>어디에 둘지 모르겠습니다</em>}
              {g.doc_type && <span className="intake-q__meta"> · {g.doc_type}</span>}
              <span className="intake-q__conf">{Math.round(q.confidence * 100)}%</span>
            </div>

            {picking === q.id ? (
              <div className="intake-q__picker">
                {/* 새 과제라는 답도 받는다 — 인스턴스 증설은 사람의 결정 (2-2) */}
                <button
                  className="intake-q__newproj"
                  onClick={() => {
                    const nm = window.prompt(
                      '새 과제 이름\n(예: 지식화 연구 → 02_Projects/지식화 연구'
                      + '\n 클래스를 정하려면 01_Tasks/이름 처럼 입력)');
                    if (nm?.trim()) answer(q.id, 'new_project', nm.trim());
                  }}
                >＋ 새 과제</button>
                <button className="intake-q__cancel"
                        onClick={() => setPicking(null)}>취소</button>
                {/* 🔴 마흔 개를 늘어놓는 것은 «고르게 하는» 게 아니라 «훑게
                    하는» 것이다 (2026-08-27 적대 검토). 좁혀서 준다. */}
                <input className="intake-q__find" autoFocus
                       placeholder="칸 이름으로 좁히기…"
                       value={pick} onChange={(e) => setPick(e.target.value)} />
                {folders
                  .filter((f) => !pick.trim()
                    || f.toLowerCase().includes(pick.trim().toLowerCase()))
                  .slice(0, 24)
                  .map((f) => (
                    <button key={f} onClick={() => answer(q.id, 'other', f)}>{f}</button>
                  ))}
              </div>
            ) : (
              <div className="intake-q__opts">
                {q.options.map((o) => (
                  <button key={o.value}
                          className={o.value === 'yes' ? 'primary' : ''}
                          onClick={() => o.value === 'other'
                            ? pickFolders(q.id) : answer(q.id, o.value)}>
                    {o.label}
                  </button>
                ))}
                {/* 🔴 대안 — 표가 갈렸거나 낱말이 두 서가를 부를 때, 2등을
                    단추로 준다 (P4). CDE2026 의 정답이 정확히 2등이었다. */}
                {((g as { alts?: { folder: string; why?: string }[] }).alts ?? [])
                  .slice(0, 2).map((a) => (
                    <button key={a.folder} className="intake-q__alt"
                            title={a.why || ''}
                            onClick={() => answer(q.id, 'other', a.folder)}>
                      {a.folder.split('/').pop()} 쪽입니다
                    </button>
                  ))}
              </div>
            )}

            {/* 🔴 확신이 낮으면 근거를 **펼친 채로** 준다 (2026-08-27).
                «어디에 둘지 모르겠습니다 0%» 인데 근거가 접혀 있으면 사람이
                판단할 재료가 없다 — 행동을 앞세운 것의 부작용이었다. */}
            <details className="intake-q__more" open={q.confidence < 0.45}>
              <summary>왜 그렇게 봤는지 · 파일 보기</summary>
              {canThumb && (
                <div className="intake-q__preview">
                  <img src={`/api/thumb?path=${encodeURIComponent('inbox:' + first)}`}
                       alt="" loading="lazy"
                       onClick={() => window.open(
                         `/api/file?path=${encodeURIComponent('inbox:' + first)}`, '_blank')}
                       title="눌러서 원본 열기"
                       onError={(e) => {
                         (e.target as HTMLElement).parentElement!.style.display = 'none';
                       }} />
                </div>
              )}
              {q.why?.length > 0 && (
                <ul className="intake-q__why">
                  {q.why.map((w, i) => <li key={i}>{w}</li>)}
                </ul>
              )}
              {q.excerpt && (
                <p className="intake-q__excerpt">{q.excerpt.slice(0, 400)}…</p>
              )}
              <div className="intake-q__names">
                {q.names.map((nm, i) => {
                  const vp = q.paths?.[i] ? `inbox:${q.paths[i]}` : null;
                  if (!vp) return <span key={nm}>{nm}</span>;
                  const url = new URL(downloadUrl(vp), location.origin).href;
                  return (
                    <span key={nm} className="intake__r-name"
                          title="누르면 내려받기 · 끌면 파일로 나갑니다"
                          draggable
                          onDragStart={(e) => {
                            e.dataTransfer.setData('DownloadURL',
                              `application/octet-stream:${nm}:${url}`);
                            e.dataTransfer.setData('text/uri-list', url);
                            e.dataTransfer.effectAllowed = 'copy';
                          }}
                          onClick={() => openFile(vp, nm)}
                    >{nm}</span>
                  );
                })}
              </div>
            </details>
          </div>
        );
      })}

      {qs.length > CARD_MAX && (
        <div className="intake__rest">
          {/* 🔴 «그 밖에 N건» 은 **여기 보이는 줄 수**여야 한다 — 총계를
              적으면 131 이라 해놓고 14줄만 보이는 꼴이 된다 (같은 병이
              오늘만 세 번째다). 총계는 아래 한 줄이 따로 말한다. */}
          <b>그 밖에 {qs.length - CARD_MAX}건</b>
          {qs.slice(CARD_MAX).map((q) => {
            const g = q.guess ?? {};
            const where = g.folder || (g as { provisional?: string }).provisional;
            return (
              <div key={q.id} className="intake__rest-row">
                <span className="intake__rest-name" title={q.group}>{q.group}</span>
                <span className="intake__rest-where">{where || '자리 미정'}</span>
                <button disabled={!where} onClick={() => answer(q.id, 'yes')}>확정</button>
                <button onClick={() => pickFolders(q.id)}>다른 곳</button>
              </div>
            );
          })}
          {total > qs.length && (
            <span className="intake__rest-more">
              …그리고 {total - qs.length}건이 더 있습니다. 위에서 처리하시면 이어서 보여드립니다.
            </span>
          )}
        </div>
      )}

      {recent.length > 0 && (
        <div className="intake__recent">
          <b>최근 받음</b>
          {recent.slice(0, 6).map(recentRow)}
          {recent.length > 6 && (
            <details className="intake-q__more">
              <summary>{recent.length - 6}건 더</summary>
              {recent.slice(6).map(recentRow)}
            </details>
          )}
        </div>
      )}
    </div>
  );
}
