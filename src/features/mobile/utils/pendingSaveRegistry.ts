/**
 * Per-path pending save tracker.
 * Prevents race conditions where readFile executes before a previous writeFile completes.
 */
const pending = new Map<string, Promise<void>>();

export function setPendingSave(path: string, promise: Promise<void>): void {
  pending.set(path, promise.finally(() => {
    if (pending.get(path) === promise) pending.delete(path);
  }));
}

export async function awaitPendingSave(path: string): Promise<void> {
  const p = pending.get(path);
  if (p) await p;
}
