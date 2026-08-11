/** 파일 꺼내기 — 웹 방식으로 다시 만든다
 *
 * 데스크톱 notology는 `tauri-plugin-drag`로 **OS 네이티브 드래그**를 걸었다.
 * 경로만 주면 플러그인이 알아서 드래그를 시작했다.
 *
 * 🔴 **브라우저는 드래그를 명령으로 시작할 수 없다.** `dragstart` 이벤트
 *    안에서만 무엇을 넘길지 정할 수 있다. 그래서 두 갈래로 나뉜다:
 *
 *      attachDragOut(e, …)   dragstart 안에서 — 진짜 드래그 (Chrome·Edge)
 *      startSketchFileDrag() 이벤트가 없는 자리에서 — 내려받기로 대신한다
 *
 * `DownloadURL`은 놓는 순간 브라우저가 임시 파일을 만들어 OS에 넘긴다.
 * 바탕화면·카카오톡·메일 첨부 다 받는다. **Firefox·Safari는 지원하지 않아**
 * 그쪽은 WebDAV 마운트로 메운다 (전체계획서 4-G).
 */

/** Windows WebDAV 상한이자 브라우저 임시 파일이 감당하기 어려운 크기 (4-G) */
const BIG = 4 * 1024 * 1024 * 1024;

function fileUrl(vpath: string): string {
  return new URL('/api/file?path=' + encodeURIComponent(vpath), location.origin).toString();
}

/** `dragstart` 안에서 부른다. 진짜 드래그로 나간다. */
export function attachDragOut(e: DragEvent | React.DragEvent, vpath: string,
                              filename?: string, mime = 'application/octet-stream',
                              size = 0): void {
  const dt = (e as DragEvent).dataTransfer;
  if (!dt) return;
  const name = filename || vpath.split(/[/\\]/).pop() || 'file';
  const url = fileUrl(vpath);
  if (size > BIG) {
    // 🔴 큰 것은 파일이 아니라 링크로 보낸다. 임시 파일로 4GB를 만들 수 없다.
    dt.setData('text/uri-list', url);
    dt.setData('text/plain', url);
    return;
  }
  dt.setData('DownloadURL', `${mime}:${name}:${url}`);
  dt.setData('text/uri-list', url);
  dt.effectAllowed = 'copy';
  recordDragOut(name);
}

/** 드래그 이벤트가 없는 자리(메뉴·버튼)에서 부른다. 내려받기로 대신한다. */
export async function startSketchFileDrag(vpath: string): Promise<boolean> {
  const name = vpath.split(/[/\\]/).pop() || 'file';
  const a = document.createElement('a');
  a.href = fileUrl(vpath);
  a.download = name;
  a.click();
  recordDragOut(name);
  return true;
}

// ── 되돌아온 드롭 걸러내기 ──────────────────────────────────
// 밖으로 끌어낸 파일을 실수로 다시 캔버스에 놓으면 **같은 파일이 두 번 들어간다.**
// 3초 안에 같은 이름이 돌아오면 무시한다.
let lastOut: string | null = null;
let lastOutAt = 0;

export function recordDragOut(filePath: string): void {
  lastOut = filePath.split(/[/\\]/).pop() || filePath;
  lastOutAt = Date.now();
}

export function isRecentDragOutDrop(dropped: string): boolean {
  if (!lastOut) return false;
  if (Date.now() - lastOutAt > 3000) { lastOut = null; return false; }
  const base = dropped.split(/[/\\]/).pop() || '';
  const match = base === lastOut;
  if (match) lastOut = null;
  return match;
}
