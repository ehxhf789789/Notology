/**
 * Haptic feedback abstraction.
 * Mobile: navigator.vibrate() (Android) — iOS haptics via future Tauri plugin.
 * Desktop: no-op.
 */
import { isNativeMobile, getNativePlatform } from '../../core/utils/platform';

type HapticType = 'selection' | 'light' | 'medium' | 'heavy';

const VIBRATE_DURATIONS: Record<HapticType, number> = {
  selection: 5,
  light: 10,
  medium: 20,
  heavy: 30,
};

export function triggerHaptic(type: HapticType = 'selection'): void {
  if (!isNativeMobile()) return;

  const platform = getNativePlatform();
  if (platform === 'android' && navigator.vibrate) {
    navigator.vibrate(VIBRATE_DURATIONS[type]);
  }
  // iOS: future Tauri haptics plugin
  // if (platform === 'ios') { invoke('trigger_haptic', { type }); }
}
