/**
 * Track B Phase B-3 — attachment drag-out helper.
 *
 * `../../features/sketch/sketchFileDragOut` wraps the native OS drag-out APIs:
 *   - Windows: IDataObject + DoDragDrop (Ole32) — produces a real file
 *     promise that File Explorer, KakaoTalk, Outlook, etc. accept.
 *   - macOS: NSPasteboard file promise.
 *   - Linux: GTK target_list.
 *
 * HTML5 `setData('text/uri-list')` was confirmed to fail on WebView2 +
 * Windows in Phase B-1 POC (Desktop + KakaoTalk + KakaoWork all dropped
 * only as text). This module is the replacement.
 *
 * Single-surface principle: the only user-facing surface for attachments
 * is the wikilink chip in a note body, so all drag-out paths funnel
 * through this helper. WikiLink's ProseMirror plugin calls
 * `startAttachmentDrag` from its `dragstart` handler.
 */

import { startSketchFileDrag } from '../sketch/sketchFileDragOut';
import { fileUrl, downloadUrl, isWeb } from '../../web/files';
import { useAttachmentStore } from './stores/attachmentStore';
import { syncV2Commands, type AttachmentRefDto } from './attachmentCommands';

/**
 * Begin a native OS file drag for a single attachment, identified by its
 * wikilink name (e.g. `Report.pdf` or `Report_1.pdf`). Optionally takes
 * the current `noteId` to disambiguate collisions (same display name in
 * different notes).
 *
 * Returns `true` if the drag was successfully started, `false` otherwise.
 * Callers should `event.preventDefault()` before awaiting this so the
 * editor's default text-drag doesn't run alongside.
 */
export async function startAttachmentDrag(
  fileName: string,
  noteId?: string,
  ev?: DragEvent,
): Promise<boolean> {
  const ref = useAttachmentStore.getState().resolveByName(fileName, noteId);
  if (!ref) {
    console.warn('[attachmentDragOut] unresolved name, no drag:', fileName);
    return false;
  }
  // 🔴 **웹에는 네이티브 드래그가 없다.** Tauri 플러그인은 데스크톱 것이고
  //    브라우저에서는 아무 일도 안 난다 — 사용자가 *"드래그로 다른 곳에
  //    전달할 수 없다"* 고 한 것이 이것이다.
  //    크롬·엣지는 `DownloadURL` 을 쓰면 **바탕화면·탐색기·카카오톡에
  //    진짜 파일로 떨어진다.** 형식은 `mime:파일명:URL` 이다.
  if (isWeb() && ev?.dataTransfer) {
    const name = ref.filename ?? fileName;
    const url = new URL(downloadUrl(ref.local_path ?? ''), location.origin).href;
    ev.dataTransfer.setData('DownloadURL', `application/octet-stream:${name}:${url}`);
    ev.dataTransfer.setData('text/uri-list', url);
    ev.dataTransfer.setData('text/plain', name);
    ev.dataTransfer.effectAllowed = 'copy';
    return true;
  }
  return startDragForRefs([ref]);
}

/**
 * Multi-file variant — accepts an array of AttachmentRefDto and drags them
 * all in one operation. Native drag-out targets (File Explorer, etc.) drop
 * each file individually. Used by PART 5 multi-chip selection.
 */
export async function startMultiAttachmentDrag(
  refs: AttachmentRefDto[],
): Promise<boolean> {
  if (refs.length === 0) return false;
  return startDragForRefs(refs);
}

/**
 * 1×1 transparent PNG (base64). The `tauri-plugin-drag` Rust side requires
 * `image` to be either a `drag::Image` (with raw bytes) or a base64 PNG with
 * the `data:image/png;base64,` prefix. An empty string fails serde
 * deserialization silently, which is exactly the bug we hit in initial B-3
 * testing — drag-start invocation never reached the OS layer.
 *
 * Future polish: synthesize a per-tier preview (image thumbnail, generic
 * doc icon) so the drag cursor shows a meaningful image. For now any valid
 * PNG works — the OS still adds its own file icon/name overlay during drag.
 */
const TRANSPARENT_PNG_DATA_URI =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

async function startDragForRefs(refs: AttachmentRefDto[]): Promise<boolean> {
  console.log('[attachmentDragOut] starting drag for', refs.length, 'ref(s)');
  try {
    const paths = await Promise.all(
      refs.map((r) => syncV2Commands.attachmentLocalPath(r.attachmentId)),
    );
    console.log('[attachmentDragOut] resolved local paths:', paths);
    // Filter out any failed lookups (shouldn't happen post-hydrate but defensive).
    const validPaths = paths.filter((p): p is string => typeof p === 'string' && p.length > 0);
    if (validPaths.length === 0) {
      console.warn('[attachmentDragOut] no valid paths for refs', refs);
      return false;
    }
    await startSketchFileDrag(validPaths);
    console.log('[attachmentDragOut] startDrag returned successfully');
    return true;
  } catch (err) {
    console.error('[attachmentDragOut] startDrag failed:', err);
    return false;
  }
}
