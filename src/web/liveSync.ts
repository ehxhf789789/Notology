/** 변화 알림 받기 — F5를 누르지 않아도 화면이 따라온다
 *
 * 사용자 요구 (2026-08-11):
 *   *"너가 이렇게 수정하게 되면 웹으로 열려있는 notology가 자동으로
 *     리프레시가 되어야 한다고. 이전 화면을 보고 있는 게 아니라.
 *     그 병목이 최소화되지 않으면 충돌이나 오류가 발생할 수 있다. (편집이 되므로)"*
 *
 * 🔴 **이건 편의가 아니라 안전이다.** 이전 화면을 보면서 편집하면
 *    저장할 때 남의 글을 덮는다. 화면이 최신이어야 충돌이 안 난다.
 *
 * 서버가 쓸 때마다 SSE로 밀어준다 (`/api/events`). 폴링하지 않는다 —
 * 기기가 늘수록 서버가 그것만 하게 된다.
 */
type Handler = (ev: { kind: string; path?: string; [k: string]: unknown }) => void;

const handlers = new Set<Handler>();
let source: EventSource | null = null;
let retry = 1000;

export function onLive(h: Handler): () => void {
  handlers.add(h);
  return () => handlers.delete(h);
}

export function startLive(): void {
  if (source) return;
  const open = () => {
    source = new EventSource('/api/events');
    source.onopen = () => { retry = 1000; };
    source.onmessage = (e) => {
      try {
        const ev = JSON.parse(e.data);
        handlers.forEach((h) => { try { h(ev); } catch { /* 한 곳이 죽어도 나머지는 돈다 */ } });
      } catch { /* ping 등 */ }
    };
    // 🔴 끊기면 다시 붙는다. 노트북 덮개를 닫았다 열면 끊긴다 —
    //    거기서 포기하면 그때부터 이전 화면을 보게 된다.
    source.onerror = () => {
      source?.close();
      source = null;
      retry = Math.min(retry * 2, 30000);
      setTimeout(open, retry);
    };
  };
  open();
}
