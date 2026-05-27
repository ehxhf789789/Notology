/**
 * v20 (2026-05-16, HanBin) — sketch node file drag-OUT.
 *
 * Sketch nodes of type 'file' point to absolute paths inside the vault's
 * `_att/` folder (set by `applyFileDrop` at import time). This helper lets
 * the user drag those files OUT to the OS / external apps (File Explorer,
 * KakaoTalk, Outlook, web upload forms, etc.) via the native OS drag-and-
 * drop API.
 *
 * Implementation mirrors the wikilink chip drag-out path
 * (`attachmentDragOut.ts`): instead of HTML5 `setData('text/uri-list')`
 * (which silently fails on WebView2 + Windows for many targets), we use
 * `@crabnebula/tauri-plugin-drag` → IDataObject (Windows) / NSPasteboard
 * (macOS) / GTK target_list (Linux). Wraps the call so SketchEditor stays
 * import-light.
 */
import { startDrag } from '@crabnebula/tauri-plugin-drag';
import { invoke } from '@tauri-apps/api/core';

// 1×1 transparent PNG. The plugin requires a valid PNG data URI for the
// drag cursor preview; empty / missing fails serde deserialisation
// silently. OS adds its own filename + icon overlay during drag.
const TRANSPARENT_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

// R5 v3 (HanBin 2026-05-23) — module-level tracker for the most recently
// started OS-level drag. When a sketch node is dragged OUT, we record the
// file path + timestamp here. The native-drop handler in useSketchInteraction
// can consult this to recognise "same file just got dropped back into the
// canvas it came from" — the OS path representation often differs from the
// in-canvas node `file` field (different separators, canonical form, etc.),
// so this is a more reliable match than path equality.
let lastDragOutFile: string | null = null;
let lastDragOutBasename: string | null = null;
let lastDragOutAt = 0;

export function recordDragOut(filePath: string) {
  lastDragOutFile = filePath;
  lastDragOutBasename = filePath.split(/[/\\]/).pop() || null;
  lastDragOutAt = Date.now();
}

/**
 * Returns true if `dropped` matches the file that was most recently dragged
 * OUT (within the last 3 seconds), by full path OR by basename. Consumes
 * the tracker on a match so a later legitimate drop of the same name still
 * works.
 */
export function isRecentDragOutDrop(dropped: string): boolean {
  if (!lastDragOutFile) return false;
  if (Date.now() - lastDragOutAt > 3000) {
    lastDragOutFile = null;
    lastDragOutBasename = null;
    return false;
  }
  const droppedBasename = dropped.split(/[/\\]/).pop() || '';
  const match = dropped === lastDragOutFile || droppedBasename === lastDragOutBasename;
  if (match) {
    lastDragOutFile = null;
    lastDragOutBasename = null;
  }
  return match;
}

/**
 * Begin a native OS file drag for a single sketch file node.
 * Caller should `event.preventDefault()` first so the browser's default
 * text-drag doesn't run alongside.
 * Returns true if the drag was successfully initiated, false on error.
 *
 * v22 (HanBin 2026-05-23) — accepts node.file paths in any form (absolute,
 * vault-relative, attachment basename). Tries the path as-is first; if it
 * doesn't look like an absolute file path, attempts to resolve via the
 * sync_v2 attachment store. Then verifies the file exists on disk before
 * handing it to the OS (Tauri's startDrag silently swallows missing-file
 * errors on some platforms, producing the symptom "non-md attachments
 * silently don't drag out").
 */
export async function startSketchFileDrag(filePath: string): Promise<boolean> {
  if (!filePath) {
    console.warn('[sketchFileDragOut] empty filePath');
    return false;
  }

  // Resolve to an absolute filesystem path. Order:
  //   1. If it already looks absolute and the file exists → use directly.
  //   2. Else, try the attachment store: maybe filePath is the basename of
  //      a v2 attachment, or a stale legacy path whose real location is
  //      `.attachments/<name>`.
  //   3. Else, give up — log + return false.
  let resolved = filePath;
  let exists = false;
  try {
    exists = await invoke<boolean>('plugin:fs|exists', { path: filePath });
  } catch {
    // fs plugin call form changed; fall through to v2 store lookup.
  }

  if (!exists) {
    try {
      const basename = filePath.split(/[/\\]/).pop() || '';
      const { syncV2Commands } = await import('../sync_v2/syncV2Commands');
      const refs = await syncV2Commands.attachmentListAll();
      const match = refs.find(r =>
        r.originalName === basename ||
        r.displayPath.endsWith(basename) ||
        r.displayPath.endsWith('/' + basename) ||
        r.displayPath.endsWith('\\' + basename)
      );
      if (match) {
        const localPath = await syncV2Commands.attachmentLocalPath(match.attachmentId);
        if (localPath) {
          resolved = localPath;
          exists = true;
          console.log('[sketchFileDragOut] resolved via attachment store:', filePath, '→', resolved);
        }
      }
    } catch (err) {
      console.warn('[sketchFileDragOut] attachment store lookup failed:', err);
    }
  }

  if (!exists) {
    // Last-ditch: hand the OS the original path anyway; some OS file
    // systems are case-insensitive and our exists() check might have
    // false-negatived. startDrag itself will silently fail if truly bad,
    // and we surface that to console.
    console.warn('[sketchFileDragOut] file existence check failed; attempting drag anyway:', resolved);
  }

  recordDragOut(resolved);
  try {
    await startDrag({
      item: [resolved],
      icon: TRANSPARENT_PNG,
    });
    return true;
  } catch (err) {
    console.error('[sketchFileDragOut] startDrag failed:', err, 'path:', resolved);
    return false;
  }
}
