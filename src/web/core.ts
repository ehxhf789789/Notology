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

// ── 🔴 설정은 **한 번에 받아 memory 에서 준다** (2026-09-05) ─────────
//
// 한빈님이 *"속도 최적화"* 를 드셨는데 계기가 없어 `tools/speed_probe.mjs` 를
// 세워 재니, 느린 것은 **첫 그림 3.5초 하나뿐**이었다 — 그 뒤 걸음은 2~69ms 고
// 자산은 TTFB 46ms · load 205ms 로 이미 빠르다. 범인은 **왕복**이었다:
//
//     invoke:plugin:store|get   **27회 · 합 2219ms**  (열쇠 하나마다 ~85ms)
//     +378 dev_mode · +1211 auto_save_delay_ms · +1373 hover_zoom_enabled
//     … +2047 language · +2127 font_size · +3355 templates · +3449 custom_shortcuts
//
// **전부 설정값이고 줄줄이 하나씩 묻는다.** 서버는 이미 `plugin:store|entries`
// 로 전부 한 번에 준다 — 앞단이 그것을 안 쓰고 있었을 뿐이다.
//
// 🔴 **rid 마다 따로 담는다.** `plugin:store|load` 는 `1` 이 아니라 **rid**
//    (실측 352591)를 주고, `get`/`entries` 가 그 rid 로 **어느 설정 파일인지**
//    고른다 (`vault_api:2707·2721`). rid 를 지어내면 엉뚱한 파일을 읽는다 —
//    그래서 `load` 는 **가로채지 않고** 그대로 서버로 보낸다.
//
// ⚠️ 딴 기기가 그 사이에 설정을 바꾸면 이 판은 새로고침 전까지 옛 값을 본다.
//    설정은 한 사람의 것이고 한 판 안에서만 묵으므로 값을 한다 — 자료·노트에는
//    이 꼴을 쓰지 않는다.
const storeCache = new Map<string, Record<string, unknown>>();
const storeLoading = new Map<string, Promise<Record<string, unknown>>>();

async function storeAll(rid: unknown): Promise<Record<string, unknown>> {
  const k = String(rid ?? '');
  const hit = storeCache.get(k);
  if (hit) return hit;
  let pending = storeLoading.get(k);
  if (!pending) {
    pending = (async () => {
      const r = await fetch(API, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cmd: 'plugin:store|entries',
                               args: rid === undefined ? {} : { rid } }),
      });
      if (!r.ok) throw new Error(`dobbin ${r.status}`);
      const j = await r.json();
      if (j.ok === false) throw new Error(j.detail || j.error || 'dobbin error');
      // 🔴 서버는 `[[k,v], …]` 로 준다 (`store_entries:2721` — 실측). 객체 꼴도
      //    받아 둔다: 한 꼴만 받으면 서버가 바뀌는 날 **설정이 통째로 빈다.**
      // 🔴 **꼴이 아니면 «비었다» 로 읽지 않는다.** 첫 판이 `null` 을 빈 설정으로
      //    캐시했더니 보관함을 못 열어 **앱이 3번 invoke 만에 멈췄다**
      //    (회귀 관문이 62 → 3 으로 잡았다). 「못 받았다」와 「비었다」는 다르다.
      const raw = j.result;
      const ok = Array.isArray(raw) || (raw && typeof raw === 'object');
      if (!ok) throw new Error('entries 가 꼴이 아니다 — 옛 길로 간다');
      const out: Record<string, unknown> = {};
      if (Array.isArray(raw)) {
        for (const e of raw) if (Array.isArray(e)) out[String(e[0])] = e[1];
      } else {
        Object.assign(out, raw as object);
      }
      storeCache.set(k, out);
      return out;
    })();
    pending.catch(() => storeLoading.delete(k));
    storeLoading.set(k, pending);
  }
  return pending;
}

export async function invoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (cmd.startsWith('plugin:event')) return 0 as T;
  if (NO_OP.test(cmd)) return null as T;

  if (cmd.startsWith('plugin:store|')) {
    const op = cmd.slice('plugin:store|'.length);
    const sa = (args ?? {}) as Record<string, unknown>;
    const key = String(sa.key ?? '');
    if (op === 'get' || op === 'has' || op === 'keys' || op === 'entries') {
      try {
        const all = await storeAll(sa.rid);
        // 🔴 **`get` 은 맨값이 아니라 `[값, 있나]` 짝이다**
        //    (`vault_api.store_get:2709` — `return [d.get(k), k in d]`).
        //    실측: `theme` → `["dark", true]` · 없는 열쇠 → `[null, false]`.
        //    `entries` 는 맨값이라 꼴이 다르다 — 맞춰 주지 않으면 **설정이
        //    통째로 깨진다.** 재 보고서야 알았다.
        if (op === 'get')  return [key in all ? all[key] : null, key in all] as T;
        if (op === 'has')  return (key in all) as T;
        if (op === 'keys') return Object.keys(all) as T;
        return Object.entries(all) as T;
      } catch {
        // 🔴 한 번에 받기가 실패하면 **옛 길로 내려간다.** 조용히 «없다» 로
        //    답하면 설정이 통째로 기본값이 된다 — 느린 편이 낫다.
        storeCache.delete(String(sa.rid ?? ''));
      }
    } else if (op === 'set' || op === 'delete') {
      const all = storeCache.get(String(sa.rid ?? ''));
      if (all) { if (op === 'set') all[key] = sa.value; else delete all[key]; }
      // 아래로 내려가 **서버에 남는다** (write-through)
    }
  }

  // 🔴 **이진 파일은 JSON 을 태우지 않는다** (2026-09-03).
  //    xlsx·docx·pptx 뷰어가 통째로 죽어 있었다. 서버에 `read_binary_file`
  //    이 없어 여기 43번째 줄이 `null` 을 돌려주었고, 뷰어가 그 null 로
  //    `bytes.length` 를 읽어 «Cannot read properties of null» 로 터졌다.
  //    화면에는 「문서 미리보기 실패」만 떠서 파일이 깨진 것처럼 보인다.
  //
  //    서버에 명령을 새로 다는 길은 **물렸다.** JSON 숫자 배열은 한 바이트가
  //    서너 글자가 되어 원본의 4배가 그물을 탄다. 실측: 뷰어가 여는 파일
  //    173개 중 최대가 **216.6MB** (pptx) 라 JSON 으로는 ~800MB 다.
  //    어떤 상한을 잡아도 답이 아니다.
  //
  //    `/api/file` 이 이미 날바이트를 준다 — 그림이 그 길로 뜬다
  //    (`convertFileSrc`). 검증된 길을 쓰고 부풀림을 0으로 만든다.
  //    `Uint8Array` 는 `.length` 도 `new Uint8Array(x)` 도 받으므로
  //    부르는 쪽 네 자리를 한 글자도 안 고친다.
  if (cmd === 'read_binary_file') {
    const path = String((args as any)?.path ?? '');
    const r = await fetch(convertFileSrc(path));
    if (r.status === 403) throw new Error('이 기기는 아직 승인되지 않았습니다');
    if (!r.ok) throw new Error(`파일을 못 읽었다 (${r.status})`);
    return new Uint8Array(await r.arrayBuffer()) as T;
  }

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
