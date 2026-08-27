/**
 * 알림 — **한 번만 가져온다** (2026-08-27 최적화)
 *
 * 좌측 단추(배지)와 홈(목록)이 각자 20초마다 `/api/notices` 를 두드리고
 * 있었다. 같은 사실을 두 번 묻는 것은 서버에도 낭비이고, 두 화면이 **서로
 * 다른 순간의 값**을 보여줄 수 있다 (배지 2인데 목록은 3).
 *
 * 🔴 자 하나로 모은다: 구독자가 하나라도 있으면 폴링하고, 없으면 멈춘다.
 *    live 이벤트가 오면 즉시 다시 읽는다 (dobbin 이 방금 한 일을 바로 본다).
 */
import { useEffect, useState } from 'react';
import type { Notice } from './NoticeList';

const SEEN_KEY = 'dobbin.noticesSeen';
const POLL_MS = 20000;

let list: Notice[] = [];
let timer: ReturnType<typeof setInterval> | null = null;
let inflight = false;
const subs = new Set<() => void>();

function emit() { subs.forEach((f) => f()); }

async function load() {
  if (inflight) return;                 // 겹쳐 부르지 않는다
  inflight = true;
  try {
    const r = await fetch('/api/notices');
    const j = await r.json();
    const next: Notice[] = j?.notices ?? [];
    // 내용이 같으면 알리지 않는다 — 20초마다 화면을 다시 그릴 이유가 없다
    if (JSON.stringify(next.map(n => n.id)) !== JSON.stringify(list.map(n => n.id))
        || next.length !== list.length) {
      list = next;
      emit();
    } else {
      list = next;
    }
  } catch {
    /* 조용히 — 알림이 못 와도 화면은 산다 */
  } finally {
    inflight = false;
  }
}

function start() {
  if (timer) return;
  void load();
  timer = setInterval(load, POLL_MS);
  window.addEventListener('dobbin:live', load);
  window.addEventListener('dobbin:notices-seen', emit);
}
function stop() {
  if (!timer) return;
  clearInterval(timer); timer = null;
  window.removeEventListener('dobbin:live', load);
  window.removeEventListener('dobbin:notices-seen', emit);
}

function subscribe(fn: () => void) {
  subs.add(fn);
  start();
  return () => { subs.delete(fn); if (!subs.size) stop(); };
}

/** 알림 목록 — 여러 화면이 **같은 순간의 같은 값**을 본다. */
export function useNotices() {
  const [, bump] = useState(0);
  useEffect(() => subscribe(() => bump((n) => n + 1)), []);
  return { list, reload: load };
}

/** 안 본 알림 수. 배지가 쓴다. */
export function useUnseen(): number {
  const { list: l } = useNotices();
  const seen = new Set<string>(JSON.parse(localStorage.getItem(SEEN_KEY) || '[]'));
  return l.filter((n) => !seen.has(n.id)).length;
}

export function markAllSeen(l: Notice[] = list): void {
  localStorage.setItem(SEEN_KEY, JSON.stringify(l.map((n) => n.id).slice(0, 200)));
  window.dispatchEvent(new CustomEvent('dobbin:notices-seen'));
}
