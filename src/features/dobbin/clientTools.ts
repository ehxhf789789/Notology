/**
 * 화면이 가진 도구 — dobbin이 말로 부른다 (사용자 지시, 2026-08-12)
 *
 *   *"녹음 버튼을 dobbin에 만들라는 의미가 아니라, 내가 dobbin에게
 *     녹음해달라고 이야기하거나 비슷한 뉘앙스로 이야기하면 dobbin이
 *     동작할 수 있는 도구로서 만들어두라고. mcp 처럼."*
 *
 * ## 🔴 단추를 하나 더 놓는 것은 답이 아니다
 *
 * 1-3의 규율이 화면에도 적용된다: *"AI에게 물어봐야만 찾을 수 있다면 그
 * 정리는 실패한 것이다."* 뒤집으면 **말로 시킬 수 있는 일에 단추를 놓으면
 * 사람이 그 자리를 외워야 한다.** 사서에게는 말로 시킨다.
 *
 * ## 규약 — MCP와 같은 모양
 *
 * ```
 * 화면 → 서버   X-Client-Tools: record,stop_record      (내가 할 수 있는 일)
 * 서버 → 화면   message.dobbin_action = {tool, args}    (그중 하나를 시킨다)
 * ```
 *
 * 🔴 **할 수 있는 것만 알린다.** `http://` 에서는 브라우저가 마이크를 주지
 *    않으므로 `record` 를 알리지 않는다 — 그러면 dobbin은 못 한다고
 *    정확히 말한다 (5-1: 정확도 > 정직함). 있는 척하는 쪽이 더 나쁘다.
 */

export type ToolAction = { tool: string; args?: Record<string, unknown> };

/** 이 브라우저가 지금 할 수 있는 일. 매 요청에 붙여 보낸다. */
export function clientTools(): string[] {
  const out: string[] = ['pick_audio'];
  if (window.isSecureContext && navigator.mediaDevices?.getUserMedia) {
    out.push('record', 'stop_record');
  }
  return out;
}

type Live = {
  rec: MediaRecorder; chunks: Blob[]; folder: string;
  started: number; paused: number; pausedAt: number | null;
  say: (t: string) => void; onState?: () => void; discard?: boolean;
};
let live: Live | null = null;

export function isRecording() { return live !== null; }
export function isPaused() { return live?.pausedAt != null; }
export function recordFolder() { return live?.folder || ''; }

/** 🔴 일시정지한 시간은 빼고 센다 — 실제로 녹음된 길이를 말해야 한다. */
export function recordingSeconds() {
  if (!live) return 0;
  const paused = live.paused + (live.pausedAt ? Date.now() - live.pausedAt : 0);
  return Math.max(0, Math.floor((Date.now() - live.started - paused) / 1000));
}

export function pauseRecord() {
  if (!live || live.pausedAt != null) return;
  try { live.rec.pause(); } catch { /* 지원 안 하면 그대로 둔다 */ }
  live.pausedAt = Date.now();
  live.onState?.();
}

export function resumeRecord() {
  if (!live || live.pausedAt == null) return;
  live.paused += Date.now() - live.pausedAt;
  live.pausedAt = null;
  try { live.rec.resume(); } catch { /* 무시 */ }
  live.onState?.();
}

export function stopRecord() {
  if (!live) return;
  if (live.pausedAt != null) resumeRecord();      // 멈춘 채로는 못 끝낸다
  live.rec.stop();
}

/** 🔴 버린다. **되돌릴 수 없으므로** 화면이 한 번 더 묻고 부른다. */
export function discardRecord() {
  if (!live) return;
  live.discard = true;
  const say = live.say;
  live.rec.stop();
  say('녹음을 버렸습니다. 저장하지 않았습니다.');
}

/** 녹음을 서버로 보내고 회의록까지 맡긴다. */
async function upload(blob: Blob, folder: string, ext: string) {
  const r = await fetch('/api/record', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-Folder': encodeURIComponent(folder || ''),
      'X-Ext': ext,
    },
    body: blob,
  });
  return r.json();
}

/**
 * dobbin이 시킨 도구를 실행한다.
 * `say` 로 결과를 대화에 되돌려 준다 — **시킨 일은 끝을 말해야 한다.**
 */
export async function runTool(
  action: ToolAction,
  say: (text: string) => void,
  onState?: () => void,
): Promise<void> {
  const args = (action.args || {}) as { folder?: string };

  if (action.tool === 'record') {
    if (live) { say('이미 녹음 중입니다. 「그만」이라고 하시면 멈춥니다.'); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const folder = live?.folder || '';
        const dropped = live?.discard === true;
        live = null; onState?.();
        if (dropped) return;                     // 버리기로 했으면 올리지 않는다
        say('받아쓰는 중입니다… (길이에 따라 몇 분 걸립니다)');
        try {
          const j = await upload(new Blob(chunks, { type: 'audio/webm' }), folder, '.webm');
          say(j?.note
            ? `회의록을 만들었습니다 — ${String(j.note)}`
            : (j?.text ? `받아썼습니다 (${j.lines}줄). 어느 과제 회의였습니까?`
                       : `받아쓰지 못했습니다: ${j?.why ?? j?.error ?? '알 수 없음'}`));
        } catch {
          say('받아쓰기 서버에 닿지 못했습니다. 녹음 파일은 남아 있습니다.');
        }
      };
      rec.start(1000);
      live = { rec, chunks, folder: args.folder || '', started: Date.now(),
               paused: 0, pausedAt: null, say, onState };
      onState?.();
    } catch {
      // 🔴 권한이 거부되면 **그렇다고 말한다.** 조용히 실패하지 않는다.
      say('마이크 권한이 거부되어 녹음을 시작하지 못했습니다. '
        + '주소창의 자물쇠에서 허용해 주시거나, 녹음 파일을 주십시오.');
    }
    return;
  }

  if (action.tool === 'stop_record') {
    if (!live) { say('지금 돌고 있는 녹음이 없습니다.'); return; }
    stopRecord();
    return;
  }

  if (action.tool === 'pick_audio') {
    const el = document.createElement('input');
    el.type = 'file';
    el.accept = 'audio/*,video/*,.m4a,.mp3,.wav,.webm,.mp4';
    el.onchange = async () => {
      const f = el.files?.[0];
      if (!f) return;
      say(`「${f.name}」 를 받아쓰겠습니다…`);
      const j = await upload(f, args.folder || '', '.' + (f.name.split('.').pop() || 'webm'));
      say(j?.note ? `회의록을 만들었습니다 — ${String(j.note)}`
                  : `받아썼습니다 (${j?.lines ?? 0}줄).`);
    };
    el.click();
    return;
  }
}
