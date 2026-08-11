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
}

initializeApp();
