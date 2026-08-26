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
import './intake.css';

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

export function IntakePanel() {
  const [qs, setQs] = useState<Q[]>([]);
  const [recent, setRecent] = useState<Recent[]>([]);
  const [counts, setCounts] = useState<Counts>({});
  const [busy, setBusy] = useState(false);
  const [folders, setFolders] = useState<string[]>([]);
  const [picking, setPicking] = useState<number | null>(null);
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
      setRecent(j?.recent ?? []);
      setCounts(j?.counts ?? {});
    } catch { /* 조용히 */ }
    setBusy(false);
  }, []);

  useEffect(() => { load(true); }, [load]);

  // 새 파일이 들어오면 다시 읽는다 (SSE)
  useEffect(() => {
    const h = (e: Event) => {
      const d = (e as CustomEvent).detail;
      if (d?.kind === 'inbox-changed') load(true);
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
      {r.folder && (
        <button className="intake__r-loc" title="이 칸으로 이동"
                onClick={() => selectContainer('library:' + r.folder!)}>
          {r.state === 'asking' && <span className="intake__r-dot" />}
          {r.folder}
        </button>
      )}
    </div>
  );

  const got = (counts.by_state?.filed ?? 0) + (counts.by_state?.asking ?? 0)
            + (counts.by_state?.answered ?? 0);

  return (
    <div className="intake">
      <div className="intake__sum">
        <span title="투입구로 들어와 dobbin 이 읽은 파일의 누적입니다">
          <FolderInput size={13} /> 받음 {got}
        </span>
        <span className="ok"><Check size={13} /> 꽂음 {counts.filed ?? 0}</span>
        {qs.length > 0 && (
          <span className="ask"><HelpCircle size={13} /> 확인 {qs.length}</span>
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
      {qs.map((q) => {
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
              {prov ? '여기 두었습니다 · ' : '제 판단 · '}
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
                {folders.slice(0, 40).map((f) => (
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
              </div>
            )}

            <details className="intake-q__more">
              <summary>근거와 파일 보기</summary>
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
