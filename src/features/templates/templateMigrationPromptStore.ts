/**
 * 5.0.5a-migration B (2026-05-17, HanBin) — open-time migration prompt
 * store. When `hoverActions.open` is asked to open a note whose
 * frontmatter `type:` doesn't match any registered template, it
 * routes the request through this store instead of opening the hover
 * window directly. The modal then either:
 *   • migrates the note to a chosen template and reopens via the same
 *     `hoverActions.open` (this time with `skipMigrationPrompt: true`), or
 *   • lets the user open the note as-is (legacy data preserved).
 *
 * 8th hotfix (2026-05-17, HanBin) — `mode` field added so the same modal
 * can also serve as an EXPLICIT template-convert action triggered from
 * the right-click context menu on any note (not just unmatched ones).
 * `mode === 'explicit-convert'`:
 *   - No "open as-is" button (the user picked convert explicitly)
 *   - Header/description tuned for the deliberate action
 *   - `noteType` carries the current type so the prompt shows
 *     "<current> → <picked>" even when current type IS registered.
 */
import { create } from 'zustand';

export type TemplateMigrationPromptMode = 'unmatched-warning' | 'explicit-convert';

export interface TemplateMigrationPromptPayload {
  path: string;
  noteType: string;
  /** unmatched-warning: opened automatically because the note's type isn't
   *  registered. explicit-convert: user picked "템플릿 변환" from a menu. */
  mode?: TemplateMigrationPromptMode;
  /** Called after the modal resolves so the hover-window flow can resume. */
  onResolved: (action: 'migrated' | 'opened-as-is' | 'cancelled') => void;
}

interface State {
  prompt: TemplateMigrationPromptPayload | null;
  show: (payload: TemplateMigrationPromptPayload) => void;
  hide: () => void;
}

export const useTemplateMigrationPromptStore = create<State>()((set) => ({
  prompt: null,
  show: (payload) => set({ prompt: payload }),
  hide: () => set({ prompt: null }),
}));

export const templateMigrationPromptActions = {
  show: (payload: TemplateMigrationPromptPayload) =>
    useTemplateMigrationPromptStore.getState().show(payload),
  hide: () => useTemplateMigrationPromptStore.getState().hide(),
};
