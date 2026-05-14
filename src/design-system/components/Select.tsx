import {
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  useFloating,
  useClick,
  useDismiss,
  useRole,
  useListNavigation,
  useTypeahead,
  useInteractions,
  offset,
  flip,
  size as sizeMiddleware,
  FloatingPortal,
  FloatingFocusManager,
  FloatingList,
  useListItem,
  useTransitionStyles,
} from '@floating-ui/react';

export type SelectSize = 'sm' | 'md' | 'lg';

export interface SelectOption<T extends string> {
  value: T;
  label: ReactNode;
  /** Plain-text label for typeahead matching when `label` is a node. */
  searchText?: string;
  disabled?: boolean;
  icon?: ReactNode;
}

export interface SelectProps<T extends string> {
  value: T | null;
  onChange: (value: T) => void;
  options: ReadonlyArray<SelectOption<T>>;
  placeholder?: ReactNode;
  size?: SelectSize;
  disabled?: boolean;
  invalid?: boolean;
  /** Accessible label (required when no visible label is associated). */
  ariaLabel?: string;
  className?: string;
  /** Pinned width override for the listbox. Defaults to trigger width. */
  listWidth?: number;
}

function Caret() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

export function Select<T extends string>({
  value,
  onChange,
  options,
  placeholder = '선택하세요',
  size = 'md',
  disabled,
  invalid,
  ariaLabel,
  className,
  listWidth,
}: SelectProps<T>) {
  const [open, setOpen] = useState(false);
  const selectedIndex = options.findIndex((o) => o.value === value);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  const listRef = useRef<Array<HTMLElement | null>>([]);
  const listContentRef = useRef<Array<string | null>>(
    options.map((o) => o.searchText ?? (typeof o.label === 'string' ? o.label : '')),
  );

  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: setOpen,
    placement: 'bottom-start',
    middleware: [
      offset(4),
      flip({ padding: 8 }),
      sizeMiddleware({
        apply({ rects, availableHeight, elements }) {
          Object.assign(elements.floating.style, {
            width: listWidth !== undefined ? `${listWidth}px` : `${rects.reference.width}px`,
            maxHeight: `${Math.max(160, Math.min(360, availableHeight - 8))}px`,
          });
        },
        padding: 8,
      }),
    ],
  });

  const click = useClick(context, { event: 'mousedown' });
  const dismiss = useDismiss(context);
  const role = useRole(context, { role: 'listbox' });
  const listNav = useListNavigation(context, {
    listRef,
    activeIndex,
    selectedIndex: selectedIndex >= 0 ? selectedIndex : null,
    onNavigate: setActiveIndex,
    loop: true,
  });
  const typeahead = useTypeahead(context, {
    listRef: listContentRef,
    activeIndex,
    selectedIndex: selectedIndex >= 0 ? selectedIndex : null,
    onMatch: open ? setActiveIndex : (i) => onChange(options[i].value),
  });

  const { getReferenceProps, getFloatingProps, getItemProps } = useInteractions([
    click,
    dismiss,
    role,
    listNav,
    typeahead,
  ]);

  const { isMounted, styles: transitionStyles } = useTransitionStyles(context, {
    duration: { open: 140, close: 100 },
    initial: { opacity: 0, transform: 'scale(0.97)' },
  });

  const selected = selectedIndex >= 0 ? options[selectedIndex] : null;

  const triggerCls = [
    'ds-select',
    `ds-select--${size}`,
    invalid ? 'ds-select--invalid' : '',
    disabled ? 'ds-select--disabled' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <>
      <button
        ref={refs.setReference}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        disabled={disabled}
        className={triggerCls}
        {...getReferenceProps()}
      >
        {selected ? (
          <span className="ds-select__value">
            {selected.icon && <span className="ds-select__value-icon">{selected.icon}</span>}
            {selected.label}
          </span>
        ) : (
          <span className="ds-select__placeholder">{placeholder}</span>
        )}
        <span className="ds-select__caret" aria-hidden="true"><Caret /></span>
      </button>

      {isMounted && (
        <FloatingPortal>
          <FloatingFocusManager
            context={context}
            modal={false}
            initialFocus={selectedIndex >= 0 ? selectedIndex : 0}
            returnFocus
          >
            <div
              ref={refs.setFloating}
              className="ds-select__list"
              style={{ ...floatingStyles, ...transitionStyles }}
              {...getFloatingProps()}
            >
              <FloatingList elementsRef={listRef} labelsRef={listContentRef}>
                {options.map((opt, i) => (
                  <SelectOptionRow
                    key={opt.value}
                    option={opt}
                    isSelected={value === opt.value}
                    isActive={activeIndex === i}
                    getItemProps={getItemProps}
                    onPick={() => {
                      onChange(opt.value);
                      setOpen(false);
                    }}
                  />
                ))}
              </FloatingList>
            </div>
          </FloatingFocusManager>
        </FloatingPortal>
      )}
    </>
  );
}

interface RowProps<T extends string> {
  option: SelectOption<T>;
  isSelected: boolean;
  isActive: boolean;
  getItemProps: (userProps?: Record<string, unknown>) => Record<string, unknown>;
  onPick: () => void;
}

function SelectOptionRow<T extends string>({ option, isSelected, isActive, getItemProps, onPick }: RowProps<T>) {
  const { ref } = useListItem({ label: option.searchText ?? null });
  const cls = [
    'ds-select__option',
    isSelected ? 'ds-select__option--selected' : '',
    isActive ? 'ds-select__option--active' : '',
    option.disabled ? 'ds-select__option--disabled' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      ref={ref}
      role="option"
      aria-selected={isSelected}
      aria-disabled={option.disabled || undefined}
      tabIndex={isActive ? 0 : -1}
      className={cls}
      {...getItemProps({
        onClick: () => { if (!option.disabled) onPick(); },
        onKeyDown: (e: React.KeyboardEvent) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            if (!option.disabled) onPick();
          }
        },
      })}
    >
      {option.icon && <span className="ds-select__option-icon">{option.icon}</span>}
      <span className="ds-select__option-label">{option.label}</span>
      {isSelected && (
        <svg className="ds-select__option-check" width="12" height="12" viewBox="0 0 24 24"
             fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      )}
    </div>
  );
}
