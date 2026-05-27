/**
 * v20.9 (2026-05-16, HanBin) — sketch undo/redo history. REWRITTEN as a
 * linear timeline + index instead of prev/next stack pair.
 *
 * Why the rewrite: the prev/next stack form had subtle bugs around the
 * "lastSeen" pointer drifting out of sync with React's `current` prop —
 * after one undo, subsequent Ctrl+Z would toggle between the same two
 * states instead of stepping further back. The timeline form has a
 * single source of truth (timelineRef + indexRef) so the math is
 * impossible to get wrong: undo = indexRef-- + replay, redo = indexRef++
 * + replay. No equality games with React refs.
 *
 * Gesture coalescing: rapid commits (within COALESCE_MS of the previous
 * commit) REPLACE the current timeline entry instead of appending. So a
 * single drag (20-30 onChange calls) becomes ONE undo step. Standard
 * Excalidraw / Obsidian Canvas behavior.
 *
 * Memory: timeline is unbounded for the lifetime of the hover window.
 * HanBin: "hover 창이 열려있는 기준으로는 되돌리기 기록이 모두 남아야
 * 함". Close → component unmount → array GC'd.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { SketchData } from '../../core/types';

const COALESCE_MS = 350;

export interface SketchHistoryApi {
  commit: (next: SketchData) => void;
  setSilent: (next: SketchData) => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
}

export function useSketchHistory(
  current: SketchData,
  onChange: (next: SketchData) => void,
): SketchHistoryApi {
  // Linear timeline. timelineRef.current[indexRef.current] === "state we
  // are currently showing". indexRef can move backward (undo) or forward
  // (redo). New commits truncate everything after indexRef and append.
  const timelineRef = useRef<SketchData[]>([current]);
  const indexRef = useRef<number>(0);
  const lastCommitAtRef = useRef<number>(0);
  // True while we're applying an undo/redo so the parent's setSketchData
  // → useEffect feedback doesn't accidentally push a duplicate timeline
  // entry. Cleared after the effect runs.
  const applyingHistoryRef = useRef(false);

  // Trigger re-render for canUndo / canRedo readers.
  const [, bump] = useState(0);
  const rerender = useCallback(() => bump(b => (b + 1) % 1_000_000), []);

  // Mirror the parent's `current` into the timeline when it changes from
  // OUTSIDE of our control (e.g. file reload, external sync). We detect
  // "outside" by checking against the current timeline entry — if it's
  // a new reference and we didn't just put it there, treat it as a new
  // commit anchored at the present.
  useEffect(() => {
    if (applyingHistoryRef.current) {
      applyingHistoryRef.current = false;
      return;
    }
    const head = timelineRef.current[indexRef.current];
    if (head === current) return; // already aligned
    // External update — append as a fresh entry so undo can step back to
    // what we had before the external change.
    timelineRef.current.length = indexRef.current + 1;
    timelineRef.current.push(current);
    indexRef.current++;
    lastCommitAtRef.current = 0;
    rerender();
  }, [current, rerender]);

  const commit = useCallback((next: SketchData) => {
    const head = timelineRef.current[indexRef.current];
    if (head === next) return;
    const now = Date.now();
    const inGesture = now - lastCommitAtRef.current < COALESCE_MS && indexRef.current > 0;
    if (inGesture) {
      // Replace the current entry — keep the timeline length stable, the
      // pre-gesture state at indexRef-1 is still our undo target.
      timelineRef.current[indexRef.current] = next;
    } else {
      // New gesture: truncate any redo branch, then append.
      timelineRef.current.length = indexRef.current + 1;
      timelineRef.current.push(next);
      indexRef.current++;
    }
    lastCommitAtRef.current = now;
    applyingHistoryRef.current = true; // suppress the upcoming effect
    onChange(next);
    rerender();
  }, [onChange, rerender]);

  const setSilent = useCallback((next: SketchData) => {
    timelineRef.current[indexRef.current] = next;
    applyingHistoryRef.current = true;
    onChange(next);
  }, [onChange]);

  const undo = useCallback(() => {
    if (indexRef.current <= 0) return;
    indexRef.current--;
    const target = timelineRef.current[indexRef.current];
    lastCommitAtRef.current = 0; // close any gesture window
    applyingHistoryRef.current = true;
    onChange(target);
    rerender();
  }, [onChange, rerender]);

  const redo = useCallback(() => {
    if (indexRef.current >= timelineRef.current.length - 1) return;
    indexRef.current++;
    const target = timelineRef.current[indexRef.current];
    lastCommitAtRef.current = 0;
    applyingHistoryRef.current = true;
    onChange(target);
    rerender();
  }, [onChange, rerender]);

  return {
    commit,
    setSilent,
    undo,
    redo,
    canUndo: indexRef.current > 0,
    canRedo: indexRef.current < timelineRef.current.length - 1,
  };
}
