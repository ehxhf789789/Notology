/**
 * EventBus — Core→Feature 단방향 이벤트 시스템.
 *
 * Core 코드는 이벤트를 emit만 한다.
 * Feature 코드는 이벤트를 on으로 구독한다.
 * Feature가 Core를 import하는 건 OK, Core가 Feature를 import하면 안 된다.
 *
 * 이 파일은 한 번 작성 후 수정하지 않는다.
 * 새 이벤트 타입은 EventMap에 추가만 하면 된다.
 */

/** 이벤트 타입 → 페이로드 매핑. 새 이벤트는 여기에 추가. */
export interface EventMap {
  'file:saved': { path: string };
  'file:deleted': { path: string };
  'file:renamed': { oldPath: string; newPath: string };
  'folder:created': { path: string };
  'folder:deleted': { path: string };
  'folder:renamed': { oldPath: string; newPath: string };
  'attachment:saved': { path: string };
  'attachment:deleted': { path: string };
  /**
   * Track B Phase B-3 PART 6 (HanBin 2026-05-13): attachment_add and its
   * legacy fallback both rejected. The editor that issued the optimistic
   * insert is responsible for removing the orphaned wikilink so the user
   * is never stranded with a chip that points at nothing.
   */
  'attachment:addFailed': { fileName: string; notePath: string; error: string };
  'comments:saved': { notePath: string; commentsPath: string };
  'config:saved': { path: string };
  'vault:opened': { path: string };
  'vault:closed': {};
}

type EventName = keyof EventMap;
type Handler<T> = (payload: T) => void;

const listeners = new Map<string, Set<Handler<any>>>();

export const EventBus = {
  /** Feature에서 호출: 이벤트 구독 */
  on<K extends EventName>(event: K, handler: Handler<EventMap[K]>): () => void {
    if (!listeners.has(event)) {
      listeners.set(event, new Set());
    }
    listeners.get(event)!.add(handler);

    // 구독 해제 함수 반환
    return () => {
      listeners.get(event)?.delete(handler);
    };
  },

  /** Core에서 호출: 이벤트 발행 */
  emit<K extends EventName>(event: K, payload: EventMap[K]): void {
    const handlers = listeners.get(event);
    if (!handlers) return;
    for (const handler of handlers) {
      try {
        handler(payload);
      } catch (e) {
        console.error(`[EventBus] Error in handler for '${event}':`, e);
      }
    }
  },

  /** 모든 리스너 제거 (테스트용) */
  clear(): void {
    listeners.clear();
  },
};
