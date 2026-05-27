/**
 * useResponsiveLayout — Determines navigation mode based on viewport.
 *
 * NavigationMode:
 *   'bottom-tab'          mobile portrait  — 하단 56px (아이콘+라벨)
 *   'bottom-tab-compact'  mobile landscape — 하단 44px (아이콘만, blur)
 *   'rail'                tablet portrait  — 좌측 72px (아이콘+micro 라벨)
 *   'sidebar'             tablet landscape / desktop — 좌측 260px
 */
import { useState, useEffect } from 'react';

export type NavigationMode = 'bottom-tab' | 'bottom-tab-compact' | 'rail' | 'sidebar';

function detectMode(): NavigationMode {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const isLandscape = w > h;

  // Desktop (≥ 1400)
  if (w >= 1400) return 'sidebar';

  // Tablet landscape (≥ 900 && landscape)
  if (w >= 900 && isLandscape) return 'sidebar';

  // Tablet portrait (≥ 600 && portrait)
  if (w >= 600 && !isLandscape) return 'rail';

  // Mobile landscape (≥ 600 && landscape, or < 900 && landscape)
  if (isLandscape) return 'bottom-tab-compact';

  // Mobile portrait (default)
  return 'bottom-tab';
}

export function useResponsiveLayout(): NavigationMode {
  const [mode, setMode] = useState<NavigationMode>(detectMode);

  useEffect(() => {
    let timeout: ReturnType<typeof setTimeout>;
    const handleResize = () => {
      clearTimeout(timeout);
      timeout = setTimeout(() => setMode(detectMode()), 100);
    };
    window.addEventListener('resize', handleResize);
    return () => {
      clearTimeout(timeout);
      window.removeEventListener('resize', handleResize);
    };
  }, []);

  return mode;
}
