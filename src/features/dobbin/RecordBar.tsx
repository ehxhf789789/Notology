/**
 * 녹음 표시줄 — 화면 위쪽 가운데 (사용자 지시, 2026-08-12)
 *
 *   *"녹음을 시작하게 되면, notology 상단 중앙에 녹음중 표시 (중지 및
 *     저장, 일시정지, 녹음 시간 등)을 UI로 보여주면 되잖아. 녹음을
 *     시작하는 트리거는 dobbin이 대화로 이해하고 하더라도, 중지하거나
 *     저장하는건 간략 컨트롤러를 만들어줘야지."*
 *
 * ## 🔴 시작과 조작은 다른 일이다
 *
 * 앞선 지시(*"단추가 아니라 도구로"*)와 어긋나지 않는다. **부르는 것은
 * 말로, 돌고 있는 것을 다루는 것은 손으로** — 녹음 중에 "그만"이라고
 * 말하려면 그 말이 녹음에 들어간다. 회의 중에는 더욱 그렇다.
 *
 * | | |
 * |---|---|
 * | 언제 뜨나 | **녹음 중에만.** 평소엔 없다 |
 * | 어디에 | 화면 위 가운데 — 무엇을 하든 보인다 |
 * | 무엇이 | 시간 · 일시정지 · 중지하고 저장 · 버리기 |
 * | 지울 때 | 🔴 **한 번 더 묻는다.** 녹음은 되돌릴 수 없다 |
 */

import { useEffect, useState } from 'react';
import { Mic, Pause, Play, Square, Trash2 } from 'lucide-react';
import {
  isRecording, isPaused, recordingSeconds, recordFolder, recordDevice,
  listMics, preferredMic, setPreferredMic,
  pauseRecord, resumeRecord, stopRecord, discardRecord,
} from './clientTools';
import './recordbar.css';

export function RecordBar() {
  const [, tick] = useState(0);
  const [asking, setAsking] = useState(false);
  // 장치 고르기 — 목록·선택(다음 녹음부터). 녹음 중 스트림 교체는
  // 조각이 깨질 수 있어 하지 않는다 — 기억만 하고 그렇게 말한다.
  const [mics, setMics] = useState<{ id: string; label: string }[] | null>(null);
  const [picked, setPicked] = useState('');

  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(t);
  }, []);

  if (!isRecording()) return null;

  const s = recordingSeconds();
  const mm = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  const paused = isPaused();
  const folder = recordFolder();

  return (
    <div className={`recbar${paused ? ' is-paused' : ''}`} role="status">
      <span className="recbar__dot"><Mic size={13} /></span>
      <span className="recbar__what">
        {paused ? '일시정지' : '녹음 중'}
        {folder && <em> · {folder.split('/').pop()}</em>}
      </span>
      {/* 🔴 어느 장치가 듣는지 늘 보인다 — 엉뚱한 마이크를 뒤늦게 아는
          것이 가장 비싼 실패다. 누르면 이 기기의 마이크 목록이 열린다. */}
      {recordDevice() && (
        <button className="recbar__dev" title="이 기기의 마이크 고르기"
                onClick={async () => setMics(mics ? null : await listMics())}>
          {picked ? '다음 녹음부터 적용' : recordDevice().slice(0, 22)}
        </button>
      )}
      {mics && (
        <span className="recbar__mics" role="listbox">
          {mics.map((m) => (
            <button key={m.id}
                    className={m.id === (picked || preferredMic()) ? 'is-on' : ''}
                    onClick={() => {
                      setPreferredMic(m.id); setPicked(m.label); setMics(null);
                    }}>
              {m.label.slice(0, 28)}
            </button>
          ))}
        </span>
      )}
      <span className="recbar__time">{mm}</span>

      <button className="recbar__btn" title={paused ? '이어서' : '일시정지'}
              onClick={() => (paused ? resumeRecord() : pauseRecord())}>
        {paused ? <Play size={13} /> : <Pause size={13} />}
      </button>
      <button className="recbar__btn is-stop" title="중지하고 회의록 만들기"
              onClick={() => stopRecord()}>
        <Square size={12} /> 중지·저장
      </button>
      {/* 🔴 버리는 것은 되돌릴 수 없다 — 한 번 더 묻는다 */}
      {asking ? (
        <span className="recbar__ask">
          버릴까요?
          <button onClick={() => { discardRecord(); setAsking(false); }}>예</button>
          <button onClick={() => setAsking(false)}>아니오</button>
        </span>
      ) : (
        <button className="recbar__btn is-drop" title="버리기"
                onClick={() => setAsking(true)}>
          <Trash2 size={13} />
        </button>
      )}
    </div>
  );
}
