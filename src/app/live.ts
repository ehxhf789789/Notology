// 실시간 다리 — SSE 로 온 것을 `window` 사건으로 되쏜다 (2026-08-25)
//
// 🔴 **듣는 귀만 있고 부르는 입이 없었다.**
//    IntakePanel.tsx:78 · FolderTree.tsx:158 이 `dobbin:live` 를 기다리는데
//    그 이름으로 `dispatchEvent` 하는 자리가 저장소·번들 통틀어 0개였다.
//    그래서 자료 넣기 패널은 20초마다 배지 숫자만 다시 세고 카드는 그대로였다.
//
// ⚠️ 서버가 껍데기(`index.html`)에 같은 다리를 얹고 있다
//    (`src/serve/tools.py` `Handler._BRIDGE`) — 이 기계에 node 가 없어
//    번들을 다시 지을 수 없기 때문이다. `__dobbinLiveBridge` 가 둘 다 있어도
//    두 번 열리는 것을 막는다. 번들을 제대로 지으면 서버 쪽 얹기는 지워도 된다.
declare global {
  interface Window { __dobbinLiveBridge?: number }
}

export function startLiveBridge(): void {
  if (window.__dobbinLiveBridge) return;
  window.__dobbinLiveBridge = 1;
  let es: EventSource | null = null;
  let wait = 1000;
  const open = () => {
    try { es = new EventSource('/api/events'); } catch { return; }
    es.onopen = () => { wait = 1000; };
    es.onmessage = (ev) => {
      let d: unknown;
      try { d = JSON.parse(ev.data); } catch { return; }
      window.dispatchEvent(new CustomEvent('dobbin:live', { detail: d }));
    };
    es.onerror = () => {
      try { es?.close(); } catch { /* 닫기가 막혀도 다시 연다 */ }
      es = null;
      wait = Math.min(wait * 2, 30000);
      setTimeout(open, wait);
    };
  };
  open();
}
