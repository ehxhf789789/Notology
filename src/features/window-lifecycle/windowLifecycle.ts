/**
 * Frontend wrapper for the Rust WindowDispatcher.
 *
 * Use this for any UI action that changes the window lifecycle —
 * the dispatcher then runs the strict B-policy transitions
 * (flush → hide/show → close → exit) in the right order.
 *
 * See `src-tauri/src/features/window_lifecycle/state.rs` for the
 * authoritative state machine, and `docs/window_lifecycle_cases.md`
 * for the 50-case verification matrix.
 */
import { invoke } from '@tauri-apps/api/core';

/** Subset of backend `Event` the frontend may dispatch. */
export type WindowEventDto = { type: 'switch_vault_requested' };

/** Serializable mirror of backend `WindowMode`. */
export type WindowModeDto =
  | { kind: 'splash' }
  | { kind: 'selector_only'; return_to: string | null }
  | { kind: 'main_only'; vault: string; hovers: string[] }
  | { kind: 'exiting' };

/**
 * Dispatch a lifecycle event. Returns when the backend has finished
 * running the side effects (e.g. for `switch_vault_requested`,
 * after main has been hidden and selector has been shown).
 */
export async function dispatchWindowEvent(event: WindowEventDto): Promise<void> {
  return invoke('dispatch_window_event', { event });
}

/** Diagnostic snapshot of the current window mode. */
export async function getWindowMode(): Promise<WindowModeDto> {
  return invoke('get_window_mode');
}
