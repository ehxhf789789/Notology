/**
 * Round 2 R3 (HanBin 2026-05-22) — paper pattern selector.
 *
 * Toolbar trigger + 4-option popover (plain / ruled / dot / grid). On
 * change:
 *   1. local UI state updates immediately (data-paper attribute on the
 *      wrapper around <EditorContent />)
 *   2. global settingsStore default is updated (so new notes pick up the
 *      same style)
 *   3. caller's `onChange` callback persists the choice to the note's
 *      frontmatter `paper:` field so re-opens preserve it
 *
 * Sketch (canvas) notes pass `disabled` — the button is hidden.
 */

import { useState, useMemo } from 'react';
import { FileText, Minus, Check } from 'lucide-react';
import { AnchoredPopover } from '../search/FilterChipBar';
import { t } from '../../core/utils/i18n';
import type { LanguageSetting } from '../../core/utils/i18n';
import { useSettingsStore, type PaperStyle } from '../../core/stores/settingsStore';

interface PaperPatternPopoverProps {
  value: PaperStyle;
  onChange: (next: PaperStyle) => void;
  language: LanguageSetting;
  disabled?: boolean;
  vaultPath?: string | null;
}

// v11 (2026-05-23) — dot / grid options removed. Only plain + ruled.
const OPTIONS: ReadonlyArray<{
  value: PaperStyle;
  Icon: typeof FileText;
  labelKey: 'paperPlain' | 'paperRuled';
}> = [
  { value: 'plain', Icon: FileText, labelKey: 'paperPlain' },
  { value: 'ruled', Icon: Minus, labelKey: 'paperRuled' },
];

export function PaperPatternPopover({
  value,
  onChange,
  language,
  disabled,
  vaultPath,
}: PaperPatternPopoverProps) {
  const [open, setOpen] = useState(false);
  const setGlobalPaperStyle = useSettingsStore(s => s.setPaperStyle);

  const currentIcon = useMemo(() => {
    const found = OPTIONS.find(o => o.value === value);
    return found ?? OPTIONS[0];
  }, [value]);

  if (disabled) return null;

  const handlePick = (next: PaperStyle) => {
    onChange(next);
    // Also update the global default so future notes inherit this preference.
    setGlobalPaperStyle(next, vaultPath ?? null);
    setOpen(false);
  };

  return (
    <AnchoredPopover
      open={open}
      onOpenChange={setOpen}
      placement="bottom-end"
      offsetDistance={2}
      trigger={(refProps) => (
        <button
          type="button"
          className={`editor-toolbar-btn paper-pattern-trigger ${open ? 'active' : ''}`}
          aria-label={t('paperPattern', language)}
          title={t('paperPattern', language)}
          {...refProps}
        >
          <currentIcon.Icon size={14} strokeWidth={2} />
        </button>
      )}
    >
      <div className="paper-pattern-popover" role="listbox" aria-label={t('paperPattern', language)}>
        {OPTIONS.map(opt => {
          const selected = opt.value === value;
          return (
            <button
              key={opt.value}
              type="button"
              role="option"
              aria-selected={selected}
              className={`paper-pattern-option${selected ? ' is-selected' : ''}`}
              onClick={() => handlePick(opt.value)}
            >
              <span className={`paper-pattern-option__preview paper-pattern-option__preview--${opt.value}`} aria-hidden="true" />
              <span className="paper-pattern-option__label">{t(opt.labelKey, language)}</span>
              {selected && <Check size={12} strokeWidth={2.5} className="paper-pattern-option__check" aria-hidden="true" />}
            </button>
          );
        })}
      </div>
    </AnchoredPopover>
  );
}
