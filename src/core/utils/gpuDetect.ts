import { invoke } from '@tauri-apps/api/core';
import { relaunch } from '@tauri-apps/plugin-process';

interface GpuConfig {
  disableGpuCompositing?: boolean;
  measured?: boolean;
  avgFps?: number;
  measuredAt?: string;
}

/**
 * Measure rendering FPS using requestAnimationFrame over a given duration.
 * Returns average FPS and number of "jank" frames (>50ms frame time).
 */
function measureFps(durationMs: number = 2000): Promise<{ avgFps: number; jankFrames: number }> {
  return new Promise((resolve) => {
    const frameTimes: number[] = [];
    let lastTime = performance.now();
    const startTime = lastTime;

    function frame() {
      const now = performance.now();
      frameTimes.push(now - lastTime);
      lastTime = now;

      if (now - startTime < durationMs) {
        requestAnimationFrame(frame);
      } else {
        const avgFrameTime = frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length;
        const avgFps = 1000 / avgFrameTime;
        const jankFrames = frameTimes.filter(t => t > 50).length;
        resolve({ avgFps, jankFrames });
      }
    }

    requestAnimationFrame(frame);
  });
}

/**
 * Auto-detect GPU rendering performance on first launch.
 * If FPS is consistently low (GPU driver compatibility issue),
 * saves a config flag and relaunches with --disable-gpu-compositing.
 *
 * This runs only ONCE — subsequent launches skip measurement.
 */
export async function detectGpuPerformance(): Promise<void> {
  try {
    const config: GpuConfig = await invoke('get_gpu_config');

    // Already measured — skip
    if (config.measured) return;

    // Wait for app to fully settle after initial load
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Measure FPS over 2 seconds
    const { avgFps, jankFrames } = await measureFps(2000);

    const needsFix = avgFps < 45 || jankFrames > 10;

    // Save measurement result
    const newConfig: GpuConfig = {
      disableGpuCompositing: needsFix,
      measured: true,
      avgFps: Math.round(avgFps),
      measuredAt: new Date().toISOString(),
    };

    await invoke('set_gpu_config', { config: newConfig });

    // If fix needed, relaunch so Rust applies --disable-gpu-compositing
    if (needsFix) {
      await relaunch();
    }
  } catch (e) {
    console.error('[GPU Detect] Failed:', e);
  }
}
