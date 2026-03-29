import { useEffect, useRef, useCallback } from 'react';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { noteCommands } from '../services/tauriCommands';

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

      // Import each file as attachment (parallel processing for better performance)
      const importPromises = paths.map(sourcePath =>
        noteCommands.importAttachment(sourcePath, target.notePath).catch(err => {
          console.error('Failed to import attachment:', err);
          return null;
        })
      );

      const results = await Promise.all(importPromises);
      const importedPaths = results.filter((path): path is string => path !== null);

      if (importedPaths.length > 0) {
        target.onDrop(importedPaths, position);
      }
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
