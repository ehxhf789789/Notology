import { useEffect, useRef, useCallback } from 'react';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { noteCommands } from '../services/tauriCommands';
import { syncV2Commands } from '../../features/sync_v2/syncV2Commands';
import { useAttachmentStore } from '../../features/sync_v2/stores/attachmentStore';
import { EventBus } from '../infrastructure/eventBus';
import { addPersistentFailedAdd } from '../../features/sync_v2/orphanRemoval';

interface DropTarget {
  id: string;
  element: HTMLElement;
  notePath: string;
  onDrop: (importedPaths: string[], position?: { x: number; y: number }) => void;
}

// Module-level registry of drop targets
const dropTargets = new Map<string, DropTarget>();
let listenerInitialized = false;
let unlistenFn: (() => void) | null = null;

async function initGlobalListener() {
  if (listenerInitialized) return;
  listenerInitialized = true;

  const appWindow = getCurrentWebviewWindow();
  const unlisten = await appWindow.onDragDropEvent(async (event) => {
    console.log('[useDragDrop] Drag-drop event:', event.payload.type, event.payload);
    if (event.payload.type === 'drop') {
      const { paths, position } = event.payload;
      console.log('[useDragDrop] Drop event - paths:', paths?.length, 'position:', position);
      if (!paths || paths.length === 0) return;

      // Convert physical coordinates to CSS coordinates
      // Tauri returns physical pixel coordinates, but DOM APIs use CSS pixels
      const dpr = window.devicePixelRatio || 1;
      const cssX = position.x / dpr;
      const cssY = position.y / dpr;
      console.log('[useDragDrop] Converted to CSS coords:', cssX, cssY, 'DPR:', dpr);

      // Find which drop target the cursor is over
      const target = findDropTarget(cssX, cssY);
      console.log('[useDragDrop] Found target:', target ? target.id : 'null', 'Total registered targets:', dropTargets.size);
      if (!target) {
        console.log('[useDragDrop] No target found. Registered targets:', Array.from(dropTargets.keys()));
        return;
      }

      // Track B Phase B-3 stabilization (2026-05-13): optimistic UI.
      //
      // Previously this awaited `attachmentAdd` for every dropped file
      // before inserting wikilinks. For a 600 MB MP4 that meant ~30 s of
      // silent UI — users assumed the drop failed and re-dragged the file,
      // producing duplicate chips (the bug HanBin reported).
      //
      // New flow:
      //   1. Insert wikilinks immediately using source basenames so the
      //      chip surfaces in the note within one frame.
      //   2. Fire `attachmentAdd` calls in the background. Each populates
      //      the CAS blob + ref JSON + enqueues for NAS push (Fast / Slow
      //      lane by size). On response the `attachment:saved` EventBus
      //      message refreshes the attachment store, which re-colors the
      //      chip from gray (unresolved during processing) to its tier color.
      //   3. Dedup happens in two layers: target.onDrop skips wikilinks
      //      already present in the note body, AND the backend
      //      `add_attachment` returns the existing ref when (sha, note_id)
      //      already match — so even concurrent drops can't produce a
      //      duplicate `AttachmentRef`.
      //   4. Fallback to legacy `importAttachment` (background) only if
      //      `attachmentAdd` rejects (sync engine offline).
      const sourceBasenames = paths.map((p) => p.split(/[\\/]/).pop() || '');

      // Optimistic insert — fires synchronously, no await.
      target.onDrop(sourceBasenames, position);

      // Background processing — never blocks the editor.
      // Mark each basename as "pending" so the WikiLink decoration paints
      // the chip in the amber "processing" state from drop until the
      // AttachmentRef lands in the store (instead of flashing gray first).
      paths.forEach((sourcePath, idx) => {
        const basename = sourceBasenames[idx];
        if (basename) useAttachmentStore.getState().markPending(basename);
        void (async () => {
          let bothFailedError: unknown = null;
          let attachmentAddSucceeded = false;
          console.log('[useDragDrop] attachmentAdd starting for', basename);
          try {
            await syncV2Commands.attachmentAdd(sourcePath, {
              notePath: target.notePath,
            });
            attachmentAddSucceeded = true;
            console.log('[useDragDrop] attachmentAdd success for', basename);
          } catch (err) {
            console.warn(
              '[useDragDrop] attachmentAdd failed, falling back to importAttachment:',
              err,
            );
            try {
              await noteCommands.importAttachment(sourcePath, target.notePath);
              attachmentAddSucceeded = true;
              console.log('[useDragDrop] legacy importAttachment success for', basename);
            } catch (err2) {
              console.error(
                '[useDragDrop] both attachmentAdd and importAttachment failed:',
                err2,
              );
              bothFailedError = err2;
            }
          }

          // Track B Phase B-3 PART 6 (HanBin 2026-05-13): close the
          // unmark/refresh race. The backend emits `attachment:saved`
          // which kicks off `store.refresh()` asynchronously, but if we
          // unmark pending before the new ref is actually in the store
          // the decoration briefly sees (storedIsAttachment=true, no ref,
          // not pending) → orphan ✕ flash. Worse, if a decoration
          // re-render or HMR fires inside that window, the ✕ can stick.
          //
          // Force a synchronous refresh before unmarking so the chip
          // transitions amber → tier-color atomically.
          if (attachmentAddSucceeded) {
            try {
              await useAttachmentStore.getState().refresh();
            } catch (e) {
              console.warn('[useDragDrop] post-add refresh failed:', e);
            }
          }

          if (basename) useAttachmentStore.getState().unmarkPending(basename);

          // Track B Phase B-3 PART 6 (HanBin 2026-05-13): orphan prevention.
          //
          // Both backend paths rejected → the optimistic chip in the doc is
          // now pointing at nothing on disk and nothing on NAS. Two-step
          // notification so the chip cannot survive a transient editor
          // unmount / HMR window:
          //
          //   1. Persist the failure to localStorage with a short TTL. Any
          //      editor that mounts within the window scans this list and
          //      removes matching chips. Catches the case where the failure
          //      fires while ContainerView / HoverEditor is being remounted
          //      (race that HanBin hit 2026-05-13).
          //   2. Emit `attachment:addFailed` for currently-mounted editors.
          //
          // Both run unconditionally so a missed event doesn't strand a chip.
          if (bothFailedError !== null && basename) {
            try {
              addPersistentFailedAdd(target.notePath, basename);
            } catch (e) {
              console.warn('[useDragDrop] persistent failure write failed:', e);
            }
            EventBus.emit('attachment:addFailed', {
              fileName: basename,
              notePath: target.notePath,
              error: String(bothFailedError),
            });
          }
          // Sanity check (HanBin 2026-05-13 "원천 방지"): even if the add
          // path reported success, if no AttachmentRef has appeared in the
          // store after 8 s the chip is effectively orphaned. Two causes
          // observed:
          //   - sync engine was restarting during the call → ref written
          //     locally but never enqueued and lost on the next sweep
          //   - smart-dedup misfire returning an existing ref under a
          //     different `original_name` (now fixed, but defense-in-depth)
          // Don't just log: trigger the same orphan-removal pipeline so
          // the chip cannot accumulate as a "dummy" in the user's note.
          if (attachmentAddSucceeded && basename) {
            setTimeout(() => {
              const ref = useAttachmentStore.getState().resolveByName(basename);
              if (!ref) {
                console.warn(
                  '[useDragDrop] attachment_add reported success but no ref appeared after 8 s — treating as orphan:',
                  basename,
                );
                try {
                  addPersistentFailedAdd(target.notePath, basename);
                } catch {}
                EventBus.emit('attachment:addFailed', {
                  fileName: basename,
                  notePath: target.notePath,
                  error: 'no-ref-after-success',
                });
              }
            }, 8000);
          }
        })();
      });
    }
  });

  unlistenFn = unlisten;
}

function findDropTarget(x: number, y: number): DropTarget | null {
  console.log('[findDropTarget] Looking for target at:', x, y);

  // Use elementsFromPoint to get all elements at the drop position (front to back order)
  // This properly accounts for z-index, transforms, zoom, and other CSS effects
  const elementsAtPoint = document.elementsFromPoint(x, y);
  console.log('[findDropTarget] Elements at point:', elementsAtPoint.length);

  // For each element (from front to back), check if it's inside a registered drop target
  for (const element of elementsAtPoint) {
    // Walk up the DOM tree to find a registered drop target
    let current: Element | null = element;
    while (current) {
      // Check if this element IS a registered drop target
      for (const [id, target] of dropTargets) {
        if (target.element === current || target.element.contains(element)) {
          console.log('[findDropTarget] Found target via elementsFromPoint:', id);
          return target;
        }
      }

      // Also check for hover-editor class (in case the registered target is the hover-editor itself)
      if (current.classList?.contains('hover-editor')) {
        // Find the registered target for this hover editor
        for (const [id, target] of dropTargets) {
          if (target.element === current) {
            console.log('[findDropTarget] Found hover-editor target:', id);
            return target;
          }
          // Check if target element is a descendant of this hover editor
          if (current.contains(target.element)) {
            console.log('[findDropTarget] Found target inside hover-editor:', id);
            return target;
          }
        }
      }

      current = current.parentElement;
    }
  }

  // Fallback: use bounding rect comparison for targets not in DOM hierarchy
  // (e.g., if drop position is on a blank area within the target bounds)
  console.log('[findDropTarget] Fallback to bounding rect comparison');
  const matchingTargets: Array<{ target: DropTarget; zIndex: number }> = [];

  for (const [id, target] of dropTargets) {
    const rect = target.element.getBoundingClientRect();
    console.log(`[findDropTarget] Checking ${id}:`, rect.left, rect.top, rect.right, rect.bottom);

    if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
      const computedStyle = window.getComputedStyle(target.element);
      let zIndex = parseInt(computedStyle.zIndex) || 0;

      // For hover editors, get actual z-index from the element or its hover-editor parent
      const hoverParent = target.element.closest('.hover-editor');
      if (hoverParent) {
        const parentStyle = window.getComputedStyle(hoverParent);
        zIndex = parseInt(parentStyle.zIndex) || zIndex;
      }

      console.log(`[findDropTarget] Fallback match found: ${id}, zIndex: ${zIndex}`);
      matchingTargets.push({ target, zIndex });
    }
  }

  if (matchingTargets.length === 0) {
    console.log('[findDropTarget] No target found');
    return null;
  }

  // Sort by z-index descending and return the highest one
  matchingTargets.sort((a, b) => b.zIndex - a.zIndex);
  console.log('[findDropTarget] Selected target:', matchingTargets[0].target.id, 'zIndex:', matchingTargets[0].zIndex);
  return matchingTargets[0].target;
}

/**
 * Hook to initialize the global drag-drop listener.
 * Call this once in App.tsx.
 */
export function useDragDropListener() {
  useEffect(() => {
    initGlobalListener();
    return () => {
      if (unlistenFn) {
        unlistenFn();
        unlistenFn = null;
        listenerInitialized = false;
      }
    };
  }, []);
}

/**
 * Hook to register a drop target.
 * The component must render a wrapper with `data-drop-target={id}` attribute.
 *
 * @param id Unique identifier for this drop target
 * @param notePath The note file path (for import_attachment)
 * @param onDrop Callback with imported file paths and drop position
 */
export function useDropTarget(
  id: string,
  notePath: string | null,
  onDrop: (importedPaths: string[], position?: { x: number; y: number }) => void
) {
  const elementRef = useRef<HTMLDivElement>(null);
  const onDropRef = useRef(onDrop);
  onDropRef.current = onDrop;

  const stableOnDrop = useCallback((paths: string[], position?: { x: number; y: number }) => {
    onDropRef.current(paths, position);
  }, []);

  // Custom ref callback that registers the drop target when element is set
  const refCallback = useCallback((element: HTMLDivElement | null) => {
    elementRef.current = element;

    // Only register when we have both element and notePath
    if (element && notePath) {
      const target: DropTarget = {
        id,
        element,
        notePath,
        onDrop: stableOnDrop,
      };
      dropTargets.set(id, target);
    } else if (!element && dropTargets.has(id)) {
      // Only delete if this is a true unmount (element becomes null)
      dropTargets.delete(id);
    }
  }, [id, notePath]); // stableOnDrop uses onDropRef.current internally

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (dropTargets.has(id)) {
        dropTargets.delete(id);
      }
    };
  }, [id]);

  return refCallback;
}
