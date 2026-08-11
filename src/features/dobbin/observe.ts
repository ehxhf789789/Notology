/**
 * 관찰 — dobbin이 사람을 배우는 입구 (CLAUDE.md 2-14-2)
 *
 * 사용자 지시: *"내가 클릭하는 기록, 보는 자료, 검색하는 스타일 등 notology로
 * 내가 하는 활동을 하나하나 분석하고 수집해서 나라는 사람의 패턴을 학습"*
 *
 * ## 🔴 화면을 절대 막지 않는다
 *
 * 클릭마다 부르는 것이라 조금이라도 느리면 앱이 굼떠진다.
 * 세 가지로 막는다:
 *
 * | | |
 * |---|---|
 * | **모아 보낸다** | 2초 동안 쌓았다가 한 번에. 클릭 10번이 요청 1번 |
 * | **기다리지 않는다** | `keepalive` 로 던지고 결과를 안 본다 |
 * | **실패해도 조용하다** | 관찰이 안 돼서 사람이 불편할 이유가 없다 |
 *
 * ## 🔴 무엇을 보내지 않는가가 더 중요하다
 *
 * 본문을 보내지 않는다. **경로와 질의만** 보낸다. 무엇을 봤는지는 앎이
 * 되지만 무엇이 적혀 있었는지는 이미 서버가 안다 — 두 번 저장할 이유가 없고,
 * 로그가 자료의 사본이 되면 그 자체가 관리 대상이 된다.
 */

type Ev = { kind: string; subject?: string; detail?: Record<string, unknown> };

let queue: Ev[] = [];
let timer: number | null = null;

function flush() {
  timer = null;
  if (!queue.length) return;
  const events = queue.slice(0, 50);
  queue = [];
  try {
    fetch('/api/observe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events }),
      keepalive: true,               // 탭을 닫아도 마지막 것은 나간다
    }).catch(() => {});
  } catch { /* 관찰이 실패해도 사람은 아무것도 느끼지 않아야 한다 */ }
}

export function observe(kind: string, subject?: string,
                        detail?: Record<string, unknown>) {
  if (!kind) return;
  // 같은 것을 연달아 두 번 세지 않는다 — 더블클릭·리렌더가 통계를 부풀린다
  const last = queue[queue.length - 1];
  if (last && last.kind === kind && last.subject === subject) return;
  queue.push({ kind, subject, detail });
  if (queue.length >= 25) { flush(); return; }
  if (timer === null) timer = window.setTimeout(flush, 2000);
}

// 탭을 닫거나 숨길 때 남은 것을 보낸다
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });
  window.addEventListener('pagehide', flush);
}
