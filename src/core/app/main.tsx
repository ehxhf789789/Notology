import { getCurrentWindow } from '../../web/window'
import { createRoot } from 'react-dom/client'
import '../../styles/tokens.css'
import '../../index.css'
import 'tippy.js/dist/tippy.css'
// 2026-05-25 (HanBin) — bundled Korean fonts. reset.css's `--app-font`
// stack already references "Pretendard" / "Nanum Gothic" / "Noto Sans KR"
// by name, but Notology shipped zero @font-face declarations so Windows
// users without those fonts manually installed got Malgun fallback for
// every option in the Settings font picker. Self-hosting via @fontsource
// (+ the standalone `pretendard` package) makes the picker actually
// work offline (Tauri-compatible).
//
// Why three different packages:
//   - `@fontsource/pretendard` ships LATIN-ONLY (1 subset, no Korean
//     glyphs at U+AC00–D7AF) — its Settings option was a no-op on
//     Windows. The standalone `pretendard` package from the font's
//     designer ships the full Korean glyph set via dynamic subsets,
//     so we use that instead.
//   - `@fontsource/nanum-gothic` ships 92 subsets covering the full
//     Hangul Syllables block — index.css alone works.
//   - `@fontsource/noto-sans-kr` ships 124 subsets — same story.
//
// Browsers fetch only the subsets matching glyphs actually rendered
// (unicode-range), so bundle weight stays reasonable in practice.
import 'pretendard/dist/web/static/pretendard.css'
import '@fontsource/nanum-gothic'
import '@fontsource/noto-sans-kr'
// Initialize editor pool early for fast hover window opening
import '../editor/editorPool'
import { initPlatform, shouldUseMobileApp, isNativeMobile } from '../utils/platform'
import { injectThemeCSS } from '../../styles/theme'
import App from './App.tsx'
import { flushAllEditorSaves } from '../editor/editorSaveRegistry'

// Detect if we're in a hover window based on URL parameter or window label
/**
 * 🔴 web notology의 부팅 — 창 종류 분기가 없다
 *
 * 데스크톱 notology는 창 세 종류를 나눠 띄웠다: 본창 · 보관함 선택창 ·
 * 떠 있는 노트창(hover). URL 파라미터와 창 라벨로 어느 창인지 가려 각각
 * 다른 앱을 렌더했다.
 *
 * **브라우저에는 창이 하나뿐이다.** 그리고 보관함은 서버가 든다 —
 * 고를 것도, 고르는 창도 없다. 그래서 분기가 통째로 사라졌다.
 *
 * (떠 있는 노트창은 남았다. 그건 OS 창이 아니라 **페이지 안 패널**이라
 *  브라우저에서 그대로 된다 — `features/hover-windows`)
 */
// ── 🔴 시험 손잡이 — `?e2e=1` 일 때만 (2026-09-05) ──────────────────
//
//    한빈님께 같은 결의 결함이 되풀이 보고된다 (pptx 가 잘림 · 뷰어가 뒤에서
//    열림 · 엑셀이 죽음 · 코드가 150줄에서 끊김). 넷의 공통점은 **첨부를 눌러
//    뷰어를 여는 길**인데 그 길을 밟는 자동 검사가 **0개**였다 (`tools/*.mjs`
//    여섯을 «하는 일»로 전수로 세니 첨부를 누르는 자도 뷰어를 여는 자도 없다).
//
//    화면 길로만 열려면 시험 자료가 첨부 목록·노트 규약까지 흉내 내야 하고
//    **그 흉내가 틀리면 「뷰어 결함」이 아닌 것으로 붉어진다.** 재려는 것은
//    뷰어 자신이므로 손잡이가 옳은 길이다.
//
// 🔴 **여는 것과 재는 것을 함께 낸다.** 여는 문만 있으면 탐침이 「무엇이 앞에
//    있나」를 눈대중해야 한다 — `windows()` 가 창의 자리·층을 그대로 준다.
//    z 순서 결함은 눈대중으로 못 가른다.
//
// 🔴 **모듈이 뜨자마자 단다.** `initializeApp()` 안(= `await` 들 뒤)에 두었더니
//    `load` 직후 한 번만 묻는 탐침이 «손잡이가 없다» 로 조용히 물러났다.
//
// ⚠️ `?e2e=1` 이 붙어야만 달린다. 하는 일은 **사람이 클릭으로 이미 할 수 있는
//    것**뿐이고(같은 `openHoverFile`), 읽는 것도 창의 자리·층뿐이다.
if (new URLSearchParams(window.location.search).get('e2e') === '1') {
  const store = () => import('../../features/hover-windows/stores/hoverStore');
  const openViewer = async (path: string) => {
    const { useHoverStore } = await store();
    useHoverStore.getState().openHoverFile(path);
  };
  (window as any).__DOBBIN_E2E__ = {
    openViewer,
    windows: async () => {
      const { useHoverStore } = await store();
      return useHoverStore.getState().hoverFiles.map(w => ({
        id: w.id, filePath: w.filePath, type: w.type,
        zIndex: w.zIndex, minimized: !!w.minimized, cached: !!w.cached,
      }));
    },
  };
  // 딴 세션의 `tools/viewer_probe.mjs` 가 찾는 이름 — 한 줄로 두 자를 다 살린다
  (window as any).__DOBBIN_OPEN_VIEWER__ = openViewer;
}


async function initializeApp() {
  const urlParams = new URLSearchParams(window.location.search);

  await initPlatform();
  injectThemeCSS();

  // 보관함을 연다. 어느 것을 열지는 서버가 안다.
  const { initializeApp: initApp } = await import('../stores/appActions');
  await initApp();

  const root = createRoot(document.getElementById('root')!);
  if (shouldUseMobileApp()
      || (import.meta.env.DEV && urlParams.get('mobile') === 'true')) {
    const MobileApp = (await import('../../features/mobile/MobileApp')).default;
    const { AppInitializer } = await import('../stores/appStore');
    root.render(<AppInitializer><MobileApp /></AppInitializer>);
  } else {
    root.render(<App />);
  }


  // 🔴 첫 화면을 걷는다. **그린 다음에** 걷어야 한 프레임도 안 빈다 —
  //    바로 지우면 React가 그리기 전이라 검은 화면이 그대로 보인다.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const boot = document.getElementById('boot');
    if (!boot) return;
    boot.classList.add('gone');
    setTimeout(() => boot.remove(), 320);
  }));
}

initializeApp();
