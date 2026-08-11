/** web notology 런타임 — 로컬(Tauri) 자리에 서버를 놓는다
 *
 * 데스크톱 notology는 Rust를 `invoke()`로 불렀다. web notology는 같은 자리에
 * dobbin 서버를 놓는다. **호출부 52개 파일은 그대로 둔다** — 경계가 여기
 * 한 곳이어야 본가(데스크톱)의 개선을 나중에 가져올 수 있다.
 *
 *     데스크톱   React → invoke() → Rust 213명령 → 파일시스템·Tantivy
 *     web       React → invoke() → dobbin       → 마운트·PostgreSQL
 *
 * 🔴 **모르는 명령에 null을 주지 않는다.** 그러면 무엇이 아직 없는지 알 수
 *    없다. 서버가 `unimplemented`를 돌려주고 여기서 모은다 — `window.__MISSING__`.
 */
const API = '/api/invoke';

export const missingCommands = new Set<string>();
if (typeof window !== 'undefined') (window as any).__MISSING__ = missingCommands;

/** 브라우저에 없는 것들. 있는 척만 하고 조용히 넘긴다. */
const NO_OP = /^(set_window_icon|create_hover_window|open_mobile_test_window)$/;

/** 🔴 `null`을 주면 죽는 것들 — **모양은 맞추고 값만 비운다.**
 *    브라우저는 자기 GPU를 모르지만, `null`을 돌려주면 앱이
 *    `reading 'measured'`에서 죽는다 (실측). 없는 것을 없다고 말하되
 *    부르는 쪽이 죽지 않게 하는 것이 웹 런타임의 일이다.
 */
const SHAPED: Record<string, unknown> = {
  get_gpu_config: { measured: true, tier: 'web', measuredAt: '', webgl: true },
  set_gpu_config: true,
};

export async function invoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (cmd.startsWith('plugin:event')) return 0 as T;
  if (NO_OP.test(cmd)) return null as T;

  const r = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cmd, args: args ?? {} }),
  });
  if (r.status === 403) throw new Error('이 기기는 아직 승인되지 않았습니다');
  if (!r.ok) throw new Error(`dobbin ${r.status}`);
  const j = await r.json();
  if (j.unimplemented) { missingCommands.add(j.unimplemented); return null as T; }
  if (j.ok === false) throw new Error(j.detail || j.error || 'dobbin error');
  return j.result as T;
}

/** 첨부·이미지는 dobbin이 서빙한다. 브라우저는 파일시스템을 모른다. */
export function convertFileSrc(path: string): string {
  return '/api/file?path=' + encodeURIComponent(path);
}

export const transformCallback = (cb: (v: unknown) => void): number => {
  const id = Math.floor(Math.random() * 1e9);
  (window as any)['_cb' + id] = cb;
  return id;
};

export class Channel<T = unknown> {
  onmessage: ((m: T) => void) | null = null;
  toJSON() { return '__CHANNEL__'; }
}
