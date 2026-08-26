/**
 * 파일 꺼내기 — 보기·받기·끌어가기 (CLAUDE.md 1-2 ②)
 *
 * 사용자 요구 (2026-08-11):
 *   *"뷰어가 지원되지 않는 확장자라고 하더라도, 첨부파일이 연결 컴퓨터에서
 *     열리고, 다운받고, 드래그로 다른 곳에 전달할 수 없다면 notology가
 *     핵심 기능을 동작하지 못하는 거다."*
 *
 * 맞다. 1-2의 **"꺼내기"** 가 이 시스템의 절반이다. HWP·IFC·zip 은 브라우저가
 * 못 그리지만 **받아서 쓰는 것은 되어야 한다.**
 *
 * 데스크톱 시절의 세 가지가 웹에는 없다:
 * ```
 * openInDefaultApp   OS 앱으로 연다        → 브라우저는 못 한다. **받아서 연다**
 * asset://           파일 프로토콜         → `/api/file` 로 대체
 * 네이티브 드래그      Tauri 플러그인        → HTML5 `DownloadURL`
 * ```
 */

/** 이 앱이 브라우저에서 도는가 (Tauri가 아닌가). */
export function isWeb(): boolean {
  return !(window as unknown as { __TAURI__?: unknown }).__TAURI__;
}

/** 보기용 URL — 브라우저가 그릴 수 있으면 그린다. */
export function fileUrl(path: string): string {
  return '/api/file?path=' + encodeURIComponent(path);
}

/** 받기용 URL — `Content-Disposition: attachment` 로 내려온다.
 *  🔴 **뷰어가 못 여는 형식은 이쪽으로 보낸다.** 못 그린다고 못 쓰는 건 아니다. */
export function downloadUrl(path: string): string {
  return fileUrl(path) + '&download=1';
}

/** 받아서 연다. 브라우저에는 "기본 앱으로 열기"가 없으므로 이것이 그 자리다. */
export function openFile(path: string, name?: string): void {
  const a = document.createElement('a');
  a.href = downloadUrl(path);
  if (name) a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** 클립보드 복사 — 🔴 **HTTP 에서도 된다** (2026-08-26).
 *
 * `navigator.clipboard` 는 보안 컨텍스트(HTTPS·localhost)에만 있다. 이 앱은
 * `http://100.110.65.54` 라 그 API 가 **undefined** 고, writeText 를 부르던
 * 일곱 자리가 전부 조용히 실패하고 있었다 (사용자: *"붙여넣어지지 않음"*).
 * 몰래 textarea 를 만들어 execCommand('copy') 로 내려간다.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (window.isSecureContext && navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* 아래 예비 길로 */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}
