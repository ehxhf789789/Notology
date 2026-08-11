/**
 * 녹음 단추 — 심부름의 마지막 조각 (사용자가 제시한 목표 시나리오)
 *
 *   *"우선 데스크탑 음성녹음 권한을 주시면 연결해서 자동으로 녹음하겠습니다"*
 *
 * `errand.py` 가 ①넓게 읽기 ②아는 채로 묻기 ③권한 요청까지 했는데
 * **④끝까지 잇기**가 비어 있었다. 여기서 잇는다:
 * 마이크 → MediaRecorder → `/api/record` → 받아쓰기 → 회의록 노트.
 *
 * ## 🔴 못 하는 것을 정확히 말한다 (5-1: 정확도 > 정직함 > 사람다움)
 *
 * 브라우저는 **보안 컨텍스트**에서만 마이크를 준다. `http://100.110.65.54`
 * 는 아니다. 있는 척하고 눌렀을 때 아무 일도 안 일어나는 것이 최악이다 —
 * 왜 안 되는지와 **어떻게 하면 되는지**를 그 자리에서 말한다.
 */

import { useCallback, useRef, useState } from 'react';
import { Mic, Square, Loader2, Upload } from 'lucide-react';

type Phase = 'idle' | 'rec' | 'sending' | 'done' | 'blocked';

export function RecordButton({ folder, onDone }:
    { folder?: string | null; onDone?: (r: any) => void }) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [secs, setSecs] = useState(0);
  const [msg, setMsg] = useState<string | null>(null);
  const rec = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const tick = useRef<number | null>(null);

  const send = useCallback(async (blob: Blob, ext: string) => {
    setPhase('sending');
    setMsg('받아쓰는 중입니다… (길이에 따라 몇 분 걸립니다)');
    try {
      const r = await fetch('/api/record', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Folder': encodeURIComponent(folder || ''),
          'X-Ext': ext,
        },
        body: blob,
      });
      const j = await r.json();
      setPhase('done');
      setMsg(j?.ok
        ? (j.note ? `회의록을 만들었습니다 — ${String(j.note).split('/').pop()}`
                  : `받아썼습니다 (${j.lines ?? 0}줄). 어느 과제인지 알려주시면 노트로 만들겠습니다.`)
        : `실패했습니다: ${j?.why ?? '알 수 없음'}`);
      onDone?.(j);
    } catch {
      setPhase('done');
      setMsg('서버에 닿지 못했습니다.');
    }
  }, [folder, onDone]);

  const start = useCallback(async () => {
    // 🔴 보안 컨텍스트가 아니면 브라우저가 마이크를 아예 안 준다
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setPhase('blocked');
      setMsg('이 주소(http)에서는 브라우저가 마이크를 주지 않습니다. '
           + 'Tailscale 관리자에서 HTTPS Certificates를 켜고 https 주소로 '
           + '접속하시면 바로 됩니다. 그 전에는 녹음 파일을 주십시오.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      chunks.current = [];
      const mr = new MediaRecorder(stream);
      mr.ondataavailable = (e) => { if (e.data.size) chunks.current.push(e.data); };
      mr.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        send(new Blob(chunks.current, { type: 'audio/webm' }), '.webm');
      };
      mr.start(1000);
      rec.current = mr;
      setPhase('rec'); setSecs(0); setMsg(null);
      tick.current = window.setInterval(() => setSecs((s) => s + 1), 1000);
    } catch {
      setPhase('blocked');
      setMsg('마이크 권한이 거부되었습니다. 브라우저 주소창의 자물쇠에서 허용해 주십시오.');
    }
  }, [send]);

  const stop = useCallback(() => {
    if (tick.current) { clearInterval(tick.current); tick.current = null; }
    rec.current?.stop();
    rec.current = null;
  }, []);

  const pick = useCallback(() => {
    const el = document.createElement('input');
    el.type = 'file';
    el.accept = 'audio/*,video/*,.m4a,.mp3,.wav,.webm,.mp4';
    el.onchange = () => {
      const f = el.files?.[0];
      if (f) send(f, '.' + (f.name.split('.').pop() || 'webm'));
    };
    el.click();
  }, [send]);

  const mm = `${String(Math.floor(secs / 60)).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`;

  return (
    <div className="rec">
      <div className="rec__row">
        {phase === 'rec' ? (
          <button className="rec__btn is-rec" onClick={stop}>
            <Square size={13} /> 그만 ({mm})
          </button>
        ) : phase === 'sending' ? (
          <button className="rec__btn" disabled>
            <Loader2 size={13} className="spin" /> 받아쓰는 중
          </button>
        ) : (
          <button className="rec__btn" onClick={start}>
            <Mic size={13} /> 회의 녹음
          </button>
        )}
        {/* 🔴 녹음이 막혀도 **할 수 있는 길을 남긴다** — 파일을 주면 된다 */}
        <button className="rec__btn rec__btn--ghost" onClick={pick}
                title="이미 녹음한 파일을 주십시오">
          <Upload size={13} /> 녹음 파일
        </button>
      </div>
      {msg && <div className={`rec__msg${phase === 'blocked' ? ' is-warn' : ''}`}>{msg}</div>}
    </div>
  );
}
