/** 이벤트 — Tauri의 창 간 이벤트를 브라우저 안 이벤트로
 *
 * 데스크톱은 Rust와 여러 창이 이벤트를 주고받았다. web notology는 창이
 * 하나뿐이므로 **브라우저 안에서만 돈다.** 서버가 보낼 것이 생기면
 * 그때 SSE를 붙인다 (지금은 그럴 일이 없다 — 서버가 NAS를 직접 든다).
 */
export type UnlistenFn = () => void;
export interface Event<T> { event: string; id: number; payload: T }

const bus = new EventTarget();
let seq = 0;

export async function listen<T>(name: string, handler: (e: Event<T>) => void): Promise<UnlistenFn> {
  const fn = (ev: globalThis.Event) => handler({
    event: name, id: ++seq, payload: (ev as CustomEvent).detail as T,
  });
  bus.addEventListener(name, fn);
  return () => bus.removeEventListener(name, fn);
}

export async function once<T>(name: string, handler: (e: Event<T>) => void): Promise<UnlistenFn> {
  const un = await listen<T>(name, (e) => { un(); handler(e); });
  return un;
}

export async function emit(name: string, payload?: unknown): Promise<void> {
  bus.dispatchEvent(new CustomEvent(name, { detail: payload }));
}

export const emitTo = async (_t: string, name: string, payload?: unknown) => emit(name, payload);
export const TauriEvent = { WINDOW_CLOSE_REQUESTED: 'tauri://close-requested' };
