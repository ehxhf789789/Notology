/**
 * 회의 화자 칩 — 분리는 dobbin, 이름은 사람 (2026-09-02 지시)
 *
 * 클로바노트보다 나은 세 가지가 이 컴포넌트의 존재 이유다:
 *   ① 이름을 타이핑하지 않는다 — CONTACT 노트(실존 인물)에서 고른다
 *   ② 한 번 고르면 회의록 전체에 실명(@멘션 위키링크)이 박힌다
 *   ③ 참석자 절이 저절로 채워진다
 *
 * 화자가 없는 노트에서는 아무것도 그리지 않는다 — 조용한 것이 옳다.
 */
import { useCallback, useEffect, useState } from 'react';
import { invoke } from '../../web/core';

type Row = { cluster: string; talk_s: number | null; person: string | null };
type Resp = { speakers: Row[]; contacts?: string[] };

export default function SpeakerBar({ notePath, onRenamed }: {
  notePath: string; onRenamed?: () => void;
}) {
  const [rows, setRows] = useState<Row[]>([]);
  const [contacts, setContacts] = useState<string[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [pick, setPick] = useState('');

  const load = useCallback(async () => {
    try {
      const r = await invoke<Resp>('speakers_of', { note: notePath });
      setRows(r?.speakers || []);
      setContacts(r?.contacts || []);
    } catch { setRows([]); }
  }, [notePath]);
  useEffect(() => { void load(); }, [load]);

  const assign = useCallback(async (cluster: string, person: string) => {
    if (!person.trim()) return;
    const r = await invoke<{ ok: boolean; why?: string }>('write_speaker_name',
      { note: notePath, cluster, person: person.trim() });
    if (r?.ok) { setEditing(null); setPick(''); await load(); onRenamed?.(); }
  }, [notePath, load, onRenamed]);

  if (!rows.length) return null;
  return (
    <div className="speaker-bar">
      <span className="speaker-bar__label">화자</span>
      {rows.map((r) => (
        <span key={r.cluster} className="speaker-chip">
          {editing === r.cluster ? (
            <>
              <input
                autoFocus list="speaker-contacts" value={pick}
                placeholder={`${r.cluster} = 누구?`}
                onChange={(e) => setPick(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void assign(r.cluster, pick);
                  if (e.key === 'Escape') { setEditing(null); setPick(''); }
                }}
              />
              <datalist id="speaker-contacts">
                {contacts.map((c) => <option key={c} value={c} />)}
              </datalist>
            </>
          ) : (
            <button type="button" className={r.person ? 'named' : ''}
              title={r.person ? `${r.cluster} → ${r.person}` : '눌러서 이름 지정'}
              onClick={() => { setEditing(r.cluster); setPick(r.person || ''); }}>
              {r.person ? `@${r.person}` : r.cluster}
              {r.talk_s != null && (
                <em> {Math.round(r.talk_s / 60)}분</em>
              )}
            </button>
          )}
        </span>
      ))}
    </div>
  );
}
