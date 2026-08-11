/** 창 — 브라우저에는 창 관리가 없다
 *
 * 🔴 데스크톱 앱을 웹으로 옮길 때 **가장 먼저 죽는 것이 이 자리다.**
 *    `getCurrentWindow()`가 모듈 최상단에서 Tauri 전역을 읽어 흰 화면이 됐다.
 *
 * 최소화·최대화·닫기는 브라우저 크롬이 한다. 앱이 흉내 낼 필요도, 흉내 낼
 * 방법도 없다. **없는 것을 없다고 말하되, 부르는 쪽이 죽지는 않게 한다.**
 */
import { listen, type UnlistenFn } from './event';

class WebWindow {
  onDragDropEvent!: (h: (e: { payload: DragDropPayload }) => void) => Promise<UnlistenFn>;
  label = 'main';
  async show() {} async hide() {} async setFocus() {}
  async minimize() {} async maximize() {} async unmaximize() {}
  async toggleMaximize() {} async close() {}
  async isMaximized() { return false; }
  async isVisible() { return true; }
  async isFullscreen() { return !!document.fullscreenElement; }
  async setFullscreen(v: boolean) {
    if (v) await document.documentElement.requestFullscreen().catch(() => {});
    else await document.exitFullscreen().catch(() => {});
  }
  async setTitle(t: string) { document.title = t; }
  async startDragging() {}
  async theme() { return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'; }
  async onCloseRequested(_h: unknown): Promise<UnlistenFn> { return () => {}; }
  async listen(name: string, h: never) { return listen(name, h); }
  async onFocusChanged(_h: unknown): Promise<UnlistenFn> { return () => {}; }
  async scaleFactor() { return window.devicePixelRatio; }
  async innerSize() { return { width: innerWidth, height: innerHeight }; }
}

const singleton = new WebWindow();
export const getCurrentWindow = () => singleton;
export const getAllWindows = async () => [singleton];
export const getCurrent = getCurrentWindow;
export class Window extends WebWindow {}
export const availableMonitors = async () => [];
export const currentMonitor = async () => null;

/** 브라우저 드래그·드롭 — Tauri의 `onDragDropEvent` 자리
 *
 * 데스크톱은 OS가 파일 드롭을 알려줬다. 브라우저는 DOM 이벤트로 온다.
 * **경로가 아니라 `File` 객체가 온다** — 브라우저는 파일이 어디 있는지 모르고,
 * 알 필요도 없다. 서버로 올리는 것이 유일한 길이다 (전체계획서 N8).
 */
export interface DragDropPayload { type: 'over' | 'drop' | 'leave'; paths?: string[]; files?: File[] }

WebWindow.prototype.onDragDropEvent = async function (
  handler: (e: { payload: DragDropPayload }) => void,
): Promise<UnlistenFn> {
  const over = (ev: DragEvent) => { ev.preventDefault(); handler({ payload: { type: 'over' } }); };
  const drop = (ev: DragEvent) => {
    ev.preventDefault();
    const files = Array.from(ev.dataTransfer?.files ?? []);
    handler({ payload: { type: 'drop', files, paths: files.map((f) => f.name) } });
  };
  const leave = () => handler({ payload: { type: 'leave' } });
  window.addEventListener('dragover', over);
  window.addEventListener('drop', drop);
  window.addEventListener('dragleave', leave);
  return () => {
    window.removeEventListener('dragover', over);
    window.removeEventListener('drop', drop);
    window.removeEventListener('dragleave', leave);
  };
};
