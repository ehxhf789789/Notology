import type { HoverWindow } from '../../core/types';

// Animation timing constants (imported from hoverStore + local open duration)
export const HOVER_WINDOW_OPEN_DURATION = 180;   // CSS: 0.18s (open only - close/minimize from HOVER_ANIMATION)
export const ANIMATION_BUFFER = 20; // Extra buffer for safety

// Conditional logging - only in development
const DEV = import.meta.env.DEV;
const log = DEV ? console.log.bind(console) : () => {};

// ========== Web Animations API Utilities ==========
// Using Web Animations API instead of CSS animations for precise timing control
// Promise-based completion detection is not affected by main thread blocking

export interface AnimationKeyframes {
  opacity: number[];
}

export const ANIMATION_KEYFRAMES = {
  open: { opacity: [0, 1] },
  close: { opacity: [1, 0] },
  minimize: { opacity: [1, 0] },
} as const;

/**
 * Run animation using Web Animations API with Promise-based completion
 * @returns Promise that resolves when animation completes
 */
export function runAnimation(
  el: HTMLElement,
  type: 'open' | 'close' | 'minimize',
  duration: number
): Promise<void> {
  const keyframes = ANIMATION_KEYFRAMES[type];
  const startTime = performance.now();

  // Create animation using Web Animations API (opacity-only for GPU performance)
  const animation = el.animate(
    [
      { opacity: keyframes.opacity[0] },
      { opacity: keyframes.opacity[1] },
    ],
    {
      duration,
      easing: 'ease-out',
      fill: 'forwards', // Keep final state
    }
  );

  return animation.finished.then(() => {
    const elapsed = performance.now() - startTime;
    log(`[WebAnimation] ${type} completed in ${elapsed.toFixed(1)}ms (expected: ${duration}ms)`);
  }).catch((err) => {
    // Animation was cancelled (e.g., element removed)
    log(`[WebAnimation] ${type} cancelled: ${err.message}`);
  });
}

export interface HoverEditorWindowProps {
  window: HoverWindow;
}

// OPTIMIZATION: Custom comparison to prevent unnecessary re-renders
// NOTE: zIndex MUST be included - memo() skips the entire render (including inline styles)
// when comparison returns true, so zIndex changes need to trigger re-render for focus to work
export const hoverWindowPropsAreEqual = (prev: HoverEditorWindowProps, next: HoverEditorWindowProps): boolean => {
  const p = prev.window;
  const n = next.window;
  return (
    p.id === n.id &&
    p.filePath === n.filePath &&
    p.type === n.type &&
    p.position.x === n.position.x &&
    p.position.y === n.position.y &&
    p.size.width === n.size.width &&
    p.size.height === n.size.height &&
    p.zIndex === n.zIndex &&
    p.minimized === n.minimized &&
    p.cached === n.cached &&
    p.contentReloadTrigger === n.contentReloadTrigger &&
    p.noteType === n.noteType
  );
};
