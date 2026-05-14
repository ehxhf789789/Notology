import { useId, type HTMLAttributes, type ReactNode } from 'react';

export type SegmentedSize = 'sm' | 'md';

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  icon?: ReactNode;
  disabled?: boolean;
}

export interface SegmentedControlProps<T extends string>
  extends Omit<HTMLAttributes<HTMLDivElement>, 'onChange'> {
  value: T;
  onChange: (value: T) => void;
  options: ReadonlyArray<SegmentedOption<T>>;
  size?: SegmentedSize;
  /** Accessible label for the control as a whole. */
  ariaLabel?: string;
  fullWidth?: boolean;
}

export function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  size = 'md',
  ariaLabel,
  fullWidth,
  className,
  ...rest
}: SegmentedControlProps<T>) {
  const groupId = useId();
  const cls = [
    'ds-seg',
    `ds-seg--${size}`,
    fullWidth ? 'ds-seg--full' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div role="radiogroup" aria-label={ariaLabel} className={cls} {...rest}>
      {options.map((opt) => {
        const selected = opt.value === value;
        const id = `${groupId}-${opt.value}`;
        return (
          <button
            key={opt.value}
            id={id}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={opt.disabled}
            onClick={() => !opt.disabled && onChange(opt.value)}
            className={`ds-seg__btn${selected ? ' ds-seg__btn--selected' : ''}`}
          >
            {opt.icon && <span className="ds-seg__icon">{opt.icon}</span>}
            <span>{opt.label}</span>
          </button>
        );
      })}
    </div>
  );
}
