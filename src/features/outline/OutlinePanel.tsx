/**
 * Stage 5.0.4b-4 (2026-05-16) — Outline panel.
 *
 * Reads heading nodes (h1/h2/h3) from the TipTap editor and renders a
 * click-to-jump tree. Indentation reflects heading level; clicking a row
 * dispatches a `scrollIntoView` on the heading's DOM element.
 *
 * Subscribed to editor `update` so the outline stays in sync as the user
 * types. We use a debounced refresh (200ms) to avoid re-scanning on every
 * keystroke — heading changes are rare enough that small latency is fine.
 */
import { useEffect, useMemo, useState, useCallback } from 'react';
import type { Editor } from '@tiptap/react';
import { ListTree } from 'lucide-react';
import { t } from '../../core/utils/i18n';
import { useSettingsStore } from '../../core/stores/settingsStore';

export interface OutlineEntry {
  level: 1 | 2 | 3;
  text: string;
  /** ProseMirror position of the heading node — used for scroll targeting. */
  pos: number;
}

interface OutlinePanelProps {
  editor: Editor | null;
}

function extractHeadings(editor: Editor | null): OutlineEntry[] {
  if (!editor || editor.isDestroyed) return [];
  const out: OutlineEntry[] = [];
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === 'heading') {
      const level = (node.attrs as { level?: number }).level;
      if (level === 1 || level === 2 || level === 3) {
        out.push({ level, text: node.textContent || '(empty)', pos });
      }
    }
    // Don't traverse into headings themselves (their content is the text we already have).
    return node.type.name !== 'heading';
  });
  return out;
}

export function OutlinePanel({ editor }: OutlinePanelProps) {
  const [tick, setTick] = useState(0);
  const language = useSettingsStore(s => s.language);

  // Subscribe to editor updates so the outline reflects the doc state.
  // Debounced — heading nodes don't change every keystroke, and scanning
  // the whole doc on every transaction is wasteful.
  useEffect(() => {
    if (!editor) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onUpdate = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setTick(n => n + 1), 200);
    };
    editor.on('update', onUpdate);
    return () => {
      if (timer) clearTimeout(timer);
      editor.off('update', onUpdate);
    };
  }, [editor]);

  // tick is included so React re-runs the memo when the doc changes.
  const headings = useMemo(() => extractHeadings(editor), [editor, tick]);

  const handleJump = useCallback((entry: OutlineEntry) => {
    if (!editor || editor.isDestroyed) return;
    const node = editor.view.nodeDOM(entry.pos);
    if (node instanceof HTMLElement) {
      node.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    // Also place the cursor at the heading so the user can edit immediately.
    editor.chain().focus().setTextSelection(entry.pos + 1).run();
  }, [editor]);

  if (headings.length === 0) {
    return (
      <div className="outline-panel">
        <div className="outline-panel__header">
          <ListTree size={14} />
          <span>{t('outline', language)}</span>
        </div>
        <div className="outline-panel__empty">
          {t('outlineEmpty', language)}
        </div>
      </div>
    );
  }

  return (
    <div className="outline-panel">
      <div className="outline-panel__header">
        <ListTree size={14} />
        <span>{t('outline', language)}</span>
        <span className="outline-panel__count">{headings.length}</span>
      </div>
      <div className="outline-panel__list" role="list">
        {headings.map((entry, idx) => (
          <button
            key={`${entry.pos}-${idx}`}
            type="button"
            className={`outline-panel__row outline-panel__row--h${entry.level}`}
            onClick={() => handleJump(entry)}
            title={entry.text}
            role="listitem"
          >
            <span className="outline-panel__level-marker">H{entry.level}</span>
            <span className="outline-panel__text">{entry.text}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

export default OutlinePanel;
