/**
 * Platform detection utilities for responsive layout.
 * Uses Tauri OS plugin (native) with viewport fallback (dev mode).
 *
 * Breakpoints (Galaxy S23 / Galaxy Tab S11 기준):
 *   Phone:            ≤ 599dp
 *   Tablet portrait:  600dp – 959dp
 *   Tablet landscape: 960dp – 1279dp
 *   Desktop:          ≥ 1280dp
 */

export type Platform = 'mobile' | 'tablet' | 'desktop';

// Breakpoints aligned with Galaxy S23 (360dp) & Galaxy Tab S11 (800×1280dp)
const PHONE_MAX = 599;
const TABLET_LANDSCAPE_MIN = 960;

/** Cached native platform — set once by initPlatform() */
let nativePlatform: 'ios' | 'android' | 'desktop' | null = null;

/**
 * Detect native platform via Tauri OS plugin.
 * Call once at app startup; falls back to 'desktop' if plugin unavailable.
 */
export async function initPlatform(): Promise<'ios' | 'android' | 'desktop'> {
  if (nativePlatform) return nativePlatform;
  try {
    const { platform } = await import('@tauri-apps/plugin-os');
    const p = platform();
    if (p === 'ios') nativePlatform = 'ios';
    else if (p === 'android') nativePlatform = 'android';
    else nativePlatform = 'desktop';
  } catch {
    nativePlatform = 'desktop';
  }
  return nativePlatform;
}

/** Returns cached native platform (call initPlatform() first). */
export function getNativePlatform(): 'ios' | 'android' | 'desktop' {
  return nativePlatform ?? 'desktop';
}

/** True if running on iOS or Android (native mobile app). */
export function isNativeMobile(): boolean {
  return nativePlatform === 'ios' || nativePlatform === 'android';
}

/**
 * Viewport-based platform classification.
 * For native mobile, always returns 'mobile' or 'tablet'.
 */
export function getPlatform(): Platform {
  if (isNativeMobile()) {
    const w = window.innerWidth;
    return w >= TABLET_LANDSCAPE_MIN ? 'tablet' : w > PHONE_MAX ? 'tablet' : 'mobile';
  }
  const w = window.innerWidth;
  if (w <= PHONE_MAX) return 'mobile';
  if (w < TABLET_LANDSCAPE_MIN) return 'tablet';
  return 'desktop';
}

/** True for phone-sized viewport (≤599dp) or native mobile with narrow screen. */
export function isMobile(): boolean {
  if (isNativeMobile()) return window.innerWidth <= PHONE_MAX;
  return getPlatform() === 'mobile';
}

/** True for tablet-sized viewport (600-1279dp) or native mobile with wide screen. */
export function isTablet(): boolean {
  if (isNativeMobile()) return window.innerWidth > PHONE_MAX;
  return getPlatform() === 'tablet';
}

/** True if device supports touch input. */
export function isTouchDevice(): boolean {
  return 'ontouchstart' in window || navigator.maxTouchPoints > 0;
}

/** True if should render mobile app (native mobile OR narrow viewport in dev). */
export function shouldUseMobileApp(): boolean {
  return isNativeMobile() || isMobile();
}
