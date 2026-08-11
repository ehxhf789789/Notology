/**
 * 편집 잠금 — 같은 노트를 둘이 못 고친다 (CLAUDE.md live.py)
 *
 * 사용자 요구 (2026-08-11):
 *   *"다중 컴퓨터 접근을 고려해서 실시간으로 리프레시하라는 거야. 특정
 *     컴퓨터가 수정 및 편집하고 있으면 충돌을 막는 기능이 필요하다.
 *     google sheet 등처럼 실시간 협업이 가능하도록 설계하던가, 그게
 *     실시간으로 충돌을 방지하기 어렵다면 특정 컴퓨터가 편집중인 내용은
 *     접근못하게 잠그던가"*
 *
 * ## 🔴 왜 협업이 아니라 잠금인가
 *
 * 구글 시트식 실시간 협업은 CRDT나 OT가 필요하다. 그것 자체가 큰 공사이고,
 * **여기서는 값이 적다:**
 *
 * | | 구글 시트 | 이 서재 |
 * |---|---|---|
 * | 쓰는 사람 | 여럿이 동시에 | **한 사람.** 기기만 여럿 |
 * | 부딪히는 빈도 | 잦다 | 드물다 (노트북·사무실을 오갈 뿐) |
 * | 틀렸을 때 | 셀 하나 | **노트 통째로 덮인다** |
 *
 * 한 사람이 기기를 옮겨 다니는 상황에서 필요한 것은 *합치기*가 아니라
 * **"저쪽 창이 아직 열려 있다"고 알려주는 것**이다. 잠금이 그 일을 한다.
 *
 * ## 세 겹으로 막는다 — 하나가 뚫려도 다음이 있다
 *
 * ```
 * ① 화면    남이 잡고 있으면 읽기 전용으로 연다 (여기)
 * ② 서버    잠긴 노트에 쓰기가 오면 409로 거절한다   ← 진짜 방어선
 * ③ mtime   임차를 놓쳐도 읽은 뒤 바뀌었으면 안 덮는다 (live.check_stale)
 * ```
 *
 * 🔴 **②가 본체다.** 화면만 잠그면 옛 번들이나 다른 창이 그대로 덮는다.
 *
 * ## 임차이지 잠금이 아니다
 *
 * 영원한 잠금은 기기가 죽으면 그 노트를 영영 못 연다. 90초짜리 임차를
 * 30초마다 갱신하고, 창을 닫으면 놓는다. 조용하면 저절로 풀린다.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

const RENEW_MS = 30000;

export type LockState =
  | { state: 'none' }
  | { state: 'mine'; until: number }
  | { state: 'theirs'; by: string; secondsLeft: number };

async function call(action: string, path: string): Promise<any> {
  try {
    const r = await fetch('/api/lease', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, path }),
      keepalive: action === 'release',   // 창을 닫아도 놓는 것은 나간다
    });
    return await r.json();
  } catch {
    return null;
  }
}

export function useEditLock(path: string | null): LockState & {
  claim: () => Promise<boolean>;
} {
  const [lock, setLock] = useState<LockState>({ state: 'none' });
  const held = useRef<string | null>(null);

  const claim = useCallback(async () => {
    if (!path) return false;
    const r = await call('acquire', path);
    if (r?.ok) {
      held.current = path;
      setLock({ state: 'mine', until: r.until });
      return true;
    }
    if (r) {
      setLock({ state: 'theirs', by: r.held_by ?? '다른 기기',
                secondsLeft: r.seconds_left ?? 0 });
    }
    return false;
  }, [path]);

  // 노트를 열면 잡고, 30초마다 갱신하고, 떠나면 놓는다
  useEffect(() => {
    if (!path) return;
    let alive = true;
    claim();
    const t = setInterval(() => { if (alive) call('renew', path); }, RENEW_MS);
    const drop = () => { if (held.current) call('release', held.current); };
    window.addEventListener('pagehide', drop);
    return () => {
      alive = false;
      clearInterval(t);
      window.removeEventListener('pagehide', drop);
      drop();
      held.current = null;
    };
  }, [path, claim]);

  return { ...lock, claim };
}
