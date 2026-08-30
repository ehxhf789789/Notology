/**
 * 묶음 검수 — **159번 묻지 않고 2번 묻는다** (CLAUDE 2-9 · 2026-08-31)
 *
 * 사용자: *"확인 필요라는 과정은 승인 및 검수가 필수적인 상황에만 부여하고 …
 * 굳이 노동력을 요구하는 확인 필요를 늘릴 이유가 없다."*
 * *"심볼릭 추론으로 내 검토 과정을 줄이거나 없앨 수 없나?"*
 *
 * 🔴 무리의 열쇠는 **(후보 종류, 그 경로조합의 실측치)** 다 — dobbin 이
 *    똑같은 근거로 판정한 것들이라 하나가 맞으면 대체로 다 맞는다.
 *    그래서 한 번 물어도 되고, 그것이 사람의 노동을 79배 줄인다.
 *
 * 🔴 **그냥 두면 몇 건이 틀린 채 남는지**를 함께 적는다. 「확인해 주세요」
 *    만으로는 사람이 이 일을 왜 하는지 모른다.
 */
import { useCallback, useEffect, useState } from 'react';
import { invoke } from '../../web/core';
import { hoverActions } from '../hover-windows/stores/hoverStore';

type Sample = { id: number; name: string; folder: string | null };
type Cluster = {
  key: string; doc_type: string; confidence: number;
  count: number; expected_wrong: number; samples: Sample[];
};

/** 🔴 받침에 따라 «로/으로» 를 고른다. 「논문로」 는 사람이 안 쓰는 말이다. */
function ro(w: string): string {
  const ch = (w || '').slice(-1);
  const code = ch.charCodeAt(0) - 0xac00;
  if (code < 0 || code > 11171) return '로';
  const jong = code % 28;
  return jong === 0 || jong === 8 ? '로' : '으로';   // 받침 없거나 ㄹ → 로
}

const TYPES = ['보고서', '계획서', '회의록', '청구서', '영수증', '공문', '논문',
               '발표자료', '제안서', '양식', '데이터셋', '매뉴얼', '이미지', '기타'];

export function ClusterReview() {
  const [cs, setCs] = useState<Cluster[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [pick, setPick] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try { setCs((await invoke<Cluster[]>('review_clusters')) || []); }
    catch { setCs([]); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const answer = useCallback(async (key: string, value: string) => {
    setBusy(key);
    try {
      await invoke('review_resolve', { key, answer: value });
      await load();
    } finally { setBusy(null); }
  }, [load]);

  if (!cs.length) return null;
  return (
    <div className="clrev">
      {cs.map((c) => (
        <div className="clrev__card" key={c.key}>
          <div className="clrev__head">
            <b>「{c.doc_type}」{ro(c.doc_type)} 보이는 자료 {c.count}건</b>
            <span className="clrev__why">
              {'\u00a0'}· 이 조합은 실측 {Math.round(c.confidence * 100)}% —
              그냥 두면 {c.expected_wrong}건이 틀린 채 남습니다
            </span>
          </div>
          <ul className="clrev__samples">
            {c.samples.map((s) => (
              <li key={s.id}>
                <button className="clrev__file"
                        onClick={() => { if (s.folder) void hoverActions.open(s.name); }}
                        title={s.folder || ''}>{s.name}</button>
                {s.folder && <span className="clrev__folder">{s.folder}</span>}
              </li>
            ))}
          </ul>
          <div className="clrev__acts">
            <button className="clrev__ok" disabled={busy === c.key}
                    onClick={() => void answer(c.key, 'ok')}>
              네, {c.count}건 모두 「{c.doc_type}」입니다
            </button>
            <select className="clrev__sel" value={pick[c.key] || ''}
                    onChange={(e) => setPick((p) => ({ ...p, [c.key]: e.target.value }))}>
              <option value="">아니오 — 다른 종류로</option>
              {TYPES.filter((t) => t !== c.doc_type).map((t) =>
                <option key={t} value={t}>{t}</option>)}
            </select>
            {pick[c.key] && (
              <button className="clrev__fix" disabled={busy === c.key}
                      onClick={() => void answer(c.key, pick[c.key])}>
                「{pick[c.key]}」로 고치기
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
