/**
 * Share API — Cross-platform file and text sharing.
 *
 * Mobile: Invokes Tauri share commands → OS native share sheet.
 * Desktop: Falls back to clipboard copy + toast notification.
 */
import { invoke } from '../../web/core';
import { isNativeMobile } from '../../core/utils/platform';

export interface ShareOptions {
  title?: string;
  text?: string;
  filePath?: string;
  mimeType?: string;
}

/** Share a file via OS share sheet (mobile) or clipboard (desktop). */
export async function shareFile(
  filePath: string,
  mimeType: string = 'application/octet-stream',
  title: string = '파일 공유',
): Promise<void> {
  if (isNativeMobile()) {
    try {
      await invoke('share_file', { path: filePath, mimeType, title });
      return;
    } catch {
      // Fall through to clipboard
    }
  }

  // Desktop fallback: copy path to clipboard
  await navigator.clipboard.writeText(filePath);
}

/** Share text via OS share sheet (mobile) or clipboard (desktop). */
export async function shareText(
  text: string,
  title: string = '공유',
): Promise<void> {
  if (isNativeMobile()) {
    try {
      await invoke('share_text', { text, title });
      return;
    } catch {
      // Fall through to clipboard
    }
  }

  // Desktop fallback or Web Share API
  if (navigator.share) {
    try {
      await navigator.share({ title, text });
      return;
    } catch {
      // User cancelled or not supported
    }
  }

  await navigator.clipboard.writeText(text);
}

/** Share content with auto-detection of type. */
export async function shareContent(options: ShareOptions): Promise<void> {
  if (options.filePath) {
    await shareFile(options.filePath, options.mimeType, options.title);
  } else if (options.text) {
    await shareText(options.text, options.title);
  }
}
