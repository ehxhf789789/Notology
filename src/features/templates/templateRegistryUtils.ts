/**
 * 5.0.5a-migration (2026-05-17, HanBin) — small helpers that ask the
 * NoteTemplate registry whether a note's frontmatter `type:` value
 * belongs to any currently-registered template. Surfaces (search list,
 * detail panel, graph view, hover-open path) consult these to apply the
 * "미확인 템플릿" visual treatment + the migration prompt.
 *
 * The match is case-insensitive because legacy notes shout types
 * (NOTE / MTG / CONTACT) while user-authored templates may use either
 * case.
 */
import { useMemo } from 'react';
import { useTemplateStore } from './stores/templateStore';
import type { NoteTemplate } from '../../core/types';

/**
 * Build a Set of registered type strings (lowercase) from the current
 * NoteTemplate registry. Cheap to recompute — handful of templates only.
 * Use the hook variant `useRegisteredTypes()` inside components so the
 * computation stays bound to the same Zustand subscription used by the
 * template list.
 */
export function buildRegisteredTypesSet(): Set<string> {
  const out = new Set<string>();
  for (const tpl of useTemplateStore.getState().noteTemplates) {
    const tpe = (tpl.frontmatter.type || '').toString().trim().toLowerCase();
    if (tpe) out.add(tpe);
  }
  return out;
}

/**
 * `true` if `noteType` is non-empty AND no registered NoteTemplate owns
 * that `frontmatter.type`. Empty / null types are NOT treated as
 * unmatched — they're just "untyped" and rendered as plain notes.
 */
export function isUnmatchedNoteType(noteType: string | null | undefined, registered?: Set<string>): boolean {
  if (!noteType) return false;
  const t = noteType.trim().toLowerCase();
  if (!t) return false;
  const set = registered ?? buildRegisteredTypesSet();
  return !set.has(t);
}

/**
 * Find the NoteTemplate whose `frontmatter.type` matches `noteType`
 * (case-insensitive). Returns null when no template owns the type
 * (legacy / pending migration).
 */
export function findTemplateByType(
  noteType: string | null | undefined,
  templates: NoteTemplate[],
): NoteTemplate | null {
  if (!noteType) return null;
  const target = noteType.trim().toLowerCase();
  if (!target) return null;
  for (const tpl of templates) {
    const t = (tpl.frontmatter.type || '').toString().trim().toLowerCase();
    if (t === target) return tpl;
  }
  return null;
}

/**
 * React-friendly hook — re-subscribes when templates change.
 *
 * IMPORTANT (2026-05-17 fix): the selector MUST return a value whose
 * identity changes only when the underlying data changes. Returning a
 * freshly-allocated Set on every selector invocation triggered a
 * `getSnapshot should be cached` warning + infinite re-render loop
 * because Zustand uses Object.is to detect changes and a new Set is
 * never `Object.is` to the previous one. Subscribe to the template list
 * (a stable reference between updates) and derive the Set via useMemo.
 */
export function useRegisteredTypes(): Set<string> {
  const noteTemplates = useTemplateStore((s) => s.noteTemplates);
  return useMemo(() => {
    const out = new Set<string>();
    for (const tpl of noteTemplates) {
      const tpe = (tpl.frontmatter.type || '').toString().trim().toLowerCase();
      if (tpe) out.add(tpe);
    }
    return out;
  }, [noteTemplates]);
}
