// Global registry for editor save functions
// Each HoverEditor registers a "flush save" callback on mount.
// On beforeunload (page refresh / close), all registered callbacks
// are called to ensure no unsaved content is lost.

type SaveCallback = () => void;

const registry = new Map<string, SaveCallback>();

/** Register a save callback for a given editor id */
export function registerEditorSave(id: string, saveFn: SaveCallback) {
  registry.set(id, saveFn);
}

/** Unregister when the editor unmounts */
export function unregisterEditorSave(id: string) {
  registry.delete(id);
}

/** Call all registered save callbacks (fire-and-forget) */
export function flushAllEditorSaves() {
  for (const [, saveFn] of registry) {
    try {
      saveFn();
    } catch {
      // Ignore errors during emergency save
    }
  }
}
