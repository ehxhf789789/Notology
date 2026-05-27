/**
 * FilterChipBar — Stripe-style dynamic filter bar (2026-05-22, HanBin).
 *
 * Replaces the static "always show all controls" filter panel. Inactive
 * filters live behind a `+ Add filter` popover; active filters render as
 * `[× Label | value ▾]` chips. Each chip opens its picker inline.
 *
 * 2026-05-22 follow-up — uses Floating-UI directly (not DS Popover)
 * because DS Popover's cloneElement+ref pattern positioned the popover
 * at (0,0) when the trigger had nested children. Inline `ref={refs.setReference}`
 * is the canonical Floating-UI pattern and avoids the regression.
 */

import { useState, type ReactNode } from 'react';
import { X, Plus } from 'lucide-react';
import {
  useFloating,
  useClick,
  useDismiss,
  useRole,
  useInteractions,
  offset,
  flip,
  shift,
  FloatingPortal,
  FloatingFocusManager,
  useTransitionStyles,
  type Placement,
} from '@floating-ui/react';
import { t, type LanguageSetting } from '../../core/utils/i18n';
import { CHECK } from '../../design-system/components';

export type FilterFieldType = 'select' | 'multi-select' | 'date-range' | 'text';

interface FilterFieldBase {
  id: string;
  label: string;
  type: FilterFieldType;
  isActive: boolean;
  displayValue: string;
  clear: () => void;
}

export interface SelectField extends FilterFieldBase {
  type: 'select';
  options: { value: string; label: string }[];
  value: string;
  setValue: (v: string) => void;
}

export interface MultiSelectField extends FilterFieldBase {
  type: 'multi-select';
  options: { value: string; label: string }[];
  /** Currently checked values. */
  values: string[];
  /** Toggle a single value in / out of the active set. */
  toggleValue: (v: string) => void;
}

export interface DateRangeField extends FilterFieldBase {
  type: 'date-range';
  after: string;
  before: string;
  setAfter: (v: string) => void;
  setBefore: (v: string) => void;
}

export interface TextField extends FilterFieldBase {
  type: 'text';
  value: string;
  setValue: (v: string) => void;
  placeholder?: string;
  /** Optional autocomplete pool — when provided, the picker shows a
   *  filtered suggestion list under the input (substring match). The
   *  parent owns the source so it stays in sync with the live data
   *  (e.g. extensions present in the vault, note paths in metadata). */
  suggestions?: string[];
}

export type FilterField = SelectField | MultiSelectField | DateRangeField | TextField;

/** Chip list — renders only the active chips + Clear-all link. The
 *  +Add button is exposed separately as `<FilterAddButton>` so it can
 *  live in the search toolbar instead of inside the chip bar. The bar
 *  itself only mounts when at least one chip is active, so an empty
 *  state collapses cleanly without a stray Add affordance dangling on
 *  its own row. */
export function FilterChipList({ fields, language }: { fields: FilterField[]; language: LanguageSetting }) {
  const activeFields = fields.filter(f => f.isActive);
  if (activeFields.length === 0) return null;
  return (
    <div className="filter-chip-bar">
      {activeFields.map(field => (
        <FilterChip key={field.id} field={field} language={language} />
      ))}
      <button
        type="button"
        className="filter-chip-bar__clear-all"
        onClick={() => activeFields.forEach(f => f.clear())}
      >
        <X size={12} />
        {t('clearAllFilters', language)}
      </button>
    </div>
  );
}

/** Standalone +Add button — opens a popover listing all inactive
 *  fields. Designed to drop into the search toolbar as the Filter
 *  icon. `triggerClassName` lets the caller restyle the trigger
 *  (e.g. as an IconButton-shaped square instead of a dashed pill). */
export function FilterAddButton({
  fields,
  language,
  triggerClassName,
  icon,
  ariaLabel,
}: {
  fields: FilterField[];
  language: LanguageSetting;
  triggerClassName?: string;
  /** Optional override for the trigger contents (icon-only IconButton style). */
  icon?: ReactNode;
  ariaLabel?: string;
}) {
  return (
    <AddFilterButton
      fields={fields.filter(f => !f.isActive)}
      language={language}
      triggerClassName={triggerClassName}
      icon={icon}
      ariaLabel={ariaLabel}
    />
  );
}

/** Inline anchored popover — uses Floating-UI's canonical
 *  `ref={refs.setReference}` pattern so positioning is reliable
 *  regardless of trigger child complexity. Exported so siblings
 *  (e.g. the contents-sort dropdown) can reuse the exact same
 *  popover behavior + visual chrome. */
export function AnchoredPopover({
  open,
  onOpenChange,
  trigger,
  children,
  placement = 'bottom-start',
  offsetDistance = 6,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  trigger: (refProps: { ref: (node: HTMLElement | null) => void } & Record<string, unknown>) => ReactNode;
  children: ReactNode;
  placement?: Placement;
  /** v22 — gap (px) between trigger and floating panel. Default 6 px. Pass
   *  2 px (or 0) to glue panels right under their trigger button (e.g.
   *  paper-pattern picker which the user wanted tighter). */
  offsetDistance?: number;
}) {
  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange,
    placement,
    middleware: [offset(offsetDistance), flip({ padding: 8 }), shift({ padding: 8 })],
  });

  const click = useClick(context);
  const dismiss = useDismiss(context, { outsidePressEvent: 'mousedown' });
  const role = useRole(context, { role: 'dialog' });

  const { getReferenceProps, getFloatingProps } = useInteractions([click, dismiss, role]);
  const { isMounted, styles: transitionStyles } = useTransitionStyles(context, {
    duration: { open: 150, close: 100 },
    initial: { opacity: 0 },
  });

  const triggerProps = getReferenceProps({
    ref: refs.setReference as (node: HTMLElement | null) => void,
  }) as { ref: (node: HTMLElement | null) => void } & Record<string, unknown>;

  return (
    <>
      {trigger(triggerProps)}
      {isMounted && (
        <FloatingPortal>
          <FloatingFocusManager context={context} modal={false}>
            <div
              ref={refs.setFloating}
              className="ds-popover"
              style={{ ...floatingStyles, ...transitionStyles }}
              {...getFloatingProps()}
            >
              {children}
            </div>
          </FloatingFocusManager>
        </FloatingPortal>
      )}
    </>
  );
}

function FilterChip({ field, language }: { field: FilterField; language: LanguageSetting }) {
  const [open, setOpen] = useState(false);
  return (
    <AnchoredPopover
      open={open}
      onOpenChange={setOpen}
      trigger={refProps => (
        <button
          type="button"
          className="filter-chip"
          {...refProps}
        >
          <span
            className="filter-chip__remove"
            role="button"
            tabIndex={-1}
            aria-label={t('removeFilter', language)}
            onClick={e => {
              e.stopPropagation();
              field.clear();
            }}
            onMouseDown={e => e.stopPropagation()}
          >
            <X size={11} />
          </span>
          <span className="filter-chip__label">{field.label}</span>
          <span className="filter-chip__separator">|</span>
          <span className="filter-chip__value">{field.displayValue}</span>
        </button>
      )}
    >
      <FieldPicker field={field} onDone={() => setOpen(false)} language={language} />
    </AnchoredPopover>
  );
}

function AddFilterButton({
  fields,
  language,
  triggerClassName,
  icon,
  ariaLabel,
}: {
  fields: FilterField[];
  language: LanguageSetting;
  triggerClassName?: string;
  icon?: ReactNode;
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [pickerFieldId, setPickerFieldId] = useState<string | null>(null);
  const pickerField = pickerFieldId ? fields.find(f => f.id === pickerFieldId) ?? null : null;

  const handleDone = () => {
    setOpen(false);
    setPickerFieldId(null);
  };

  // 2026-05-22 — trigger stays visible even when all filters are active
  // (HanBin: filter button vanishing after a chip is set felt jarring).
  // Empty popover shows a friendly "all filters applied" hint so the
  // user knows clicking succeeded but there's nothing left to add.

  const cls = triggerClassName ?? 'filter-chip filter-chip--add';
  const label = ariaLabel ?? t('addFilter', language);

  return (
    <AnchoredPopover
      open={open}
      onOpenChange={next => {
        setOpen(next);
        if (!next) setPickerFieldId(null);
      }}
      trigger={refProps => (
        <button
          type="button"
          className={cls}
          aria-label={label}
          {...refProps}
        >
          {icon ?? <Plus size={12} />}
          {icon ? null : <span>{t('addFilter', language)}</span>}
        </button>
      )}
    >
      {pickerField ? (
        <FieldPicker field={pickerField} onDone={handleDone} language={language} />
      ) : fields.length === 0 ? (
        <div className="filter-chip-popover__empty">
          {t('allFiltersActive', language)}
        </div>
      ) : (
        <div className="filter-chip-popover__field-list" role="menu">
          {fields.map(f => (
            <button
              key={f.id}
              type="button"
              role="menuitem"
              className="filter-chip-popover__field-list-item"
              onClick={() => setPickerFieldId(f.id)}
            >
              {f.label}
            </button>
          ))}
        </div>
      )}
    </AnchoredPopover>
  );
}

function FieldPicker({
  field,
  onDone,
  language,
}: {
  field: FilterField;
  onDone: () => void;
  language: LanguageSetting;
}) {
  if (field.type === 'select') return <SelectPicker field={field} onDone={onDone} />;
  if (field.type === 'multi-select') return <MultiSelectPicker field={field} />;
  if (field.type === 'text') return <TextPicker field={field} onDone={onDone} language={language} />;
  return <DateRangePicker field={field} onDone={onDone} language={language} />;
}

function MultiSelectPicker({ field }: { field: MultiSelectField }) {
  const checked = new Set(field.values);
  return (
    <div className="filter-chip-popover__select filter-chip-popover__multi" role="listbox" aria-multiselectable>
      {field.options.map(opt => {
        const isOn = checked.has(opt.value);
        return (
          <button
            key={opt.value}
            type="button"
            role="option"
            aria-selected={isOn}
            className={`filter-chip-popover__select-option${isOn ? ' is-selected' : ''}`}
            onClick={() => field.toggleValue(opt.value)}
          >
            <span className="filter-chip-popover__check" aria-hidden>{isOn ? CHECK : ''}</span>
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

function TextPicker({
  field,
  onDone,
  language,
}: {
  field: TextField;
  onDone: () => void;
  language: LanguageSetting;
}) {
  const [draft, setDraft] = useState(field.value);
  const [highlightIdx, setHighlightIdx] = useState(-1);

  const matches = (() => {
    if (!field.suggestions || field.suggestions.length === 0) return [];
    const q = draft.trim().toLowerCase();
    const pool = field.suggestions;
    if (!q) return pool.slice(0, 30);
    return pool.filter(s => s.toLowerCase().includes(q)).slice(0, 30);
  })();

  const submit = (v?: string) => {
    field.setValue((v ?? draft).trim());
    onDone();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      if (highlightIdx >= 0 && highlightIdx < matches.length) submit(matches[highlightIdx]);
      else submit();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightIdx(i => Math.min(i + 1, matches.length - 1));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightIdx(i => Math.max(i - 1, -1));
      return;
    }
  };

  return (
    <div className="filter-chip-popover__text">
      <input
        type="text"
        className="filter-chip-popover__text-input"
        value={draft}
        autoFocus
        placeholder={field.placeholder}
        onChange={e => { setDraft(e.target.value); setHighlightIdx(-1); }}
        onKeyDown={handleKeyDown}
        aria-label={field.label}
        aria-autocomplete={field.suggestions ? 'list' : undefined}
      />
      {matches.length > 0 && (
        <div className="filter-chip-popover__suggestions" role="listbox">
          {matches.map((m, i) => (
            <button
              key={m}
              type="button"
              role="option"
              aria-selected={i === highlightIdx}
              className={`filter-chip-popover__suggestion${i === highlightIdx ? ' is-highlight' : ''}`}
              onMouseEnter={() => setHighlightIdx(i)}
              onClick={() => submit(m)}
            >
              {m}
            </button>
          ))}
        </div>
      )}
      {matches.length === 0 && (
        <button
          type="button"
          className="filter-chip-popover__apply"
          onClick={() => submit()}
        >
          {t('apply', language)}
        </button>
      )}
    </div>
  );
}

function SelectPicker({ field, onDone }: { field: SelectField; onDone: () => void }) {
  return (
    <div className="filter-chip-popover__select" role="listbox">
      {field.options.map(opt => {
        const selected = field.value === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            role="option"
            aria-selected={selected}
            className={`filter-chip-popover__select-option${selected ? ' is-selected' : ''}`}
            onClick={() => {
              field.setValue(opt.value);
              onDone();
            }}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

function DateRangePicker({
  field,
  onDone,
  language,
}: {
  field: DateRangeField;
  onDone: () => void;
  language: LanguageSetting;
}) {
  const [tempAfter, setTempAfter] = useState(field.after);
  const [tempBefore, setTempBefore] = useState(field.before);

  return (
    <div className="filter-chip-popover__date-range">
      <input
        type="date"
        className="search-date-input"
        value={tempAfter}
        onChange={e => setTempAfter(e.target.value)}
        aria-label={t('startDate', language)}
      />
      <span className="search-date-separator">~</span>
      <input
        type="date"
        className="search-date-input"
        value={tempBefore}
        onChange={e => setTempBefore(e.target.value)}
        aria-label={t('endDate', language)}
      />
      <button
        type="button"
        className="filter-chip-popover__apply"
        onClick={() => {
          field.setAfter(tempAfter);
          field.setBefore(tempBefore);
          onDone();
        }}
      >
        {t('apply', language)}
      </button>
    </div>
  );
}
