import type { HTMLAttributes, ReactNode } from 'react';

export type ProgressVariant = 'default' | 'success' | 'warning' | 'danger';

export interface ProgressBarProps extends Omit<HTMLAttributes<HTMLDivElement>, 'aria-label'> {
  /** Value 0–100. Omit (or pass null) for an indeterminate bar. */
  value?: number | null;
  label?: ReactNode;
  showValue?: boolean;
  variant?: ProgressVariant;
  /** Required accessible name. */
  'aria-label'?: string;
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  if (n < 0) return 0;
  if (n > 100) return 100;
  return n;
}

export function ProgressBar({
  value,
  label,
  showValue,
  variant = 'default',
  className,
  'aria-label': ariaLabel,
  ...rest
}: ProgressBarProps) {
  const indeterminate = value === null || value === undefined;
  const v = indeterminate ? 0 : clamp01(value);

  const cls = [
    'ds-progress',
    variant !== 'default' ? `ds-progress--${variant}` : '',
    indeterminate ? 'ds-progress--indeterminate' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={cls} {...rest}>
      {(label || showValue) && (
        <div className="ds-progress__header">
          {label && <span>{label}</span>}
          {showValue && !indeterminate && (
            <span className="ds-progress__value">{Math.round(v)}%</span>
          )}
        </div>
      )}
      <div
        className="ds-progress__track"
        role="progressbar"
        aria-label={ariaLabel}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={indeterminate ? undefined : v}
      >
        <div
          className="ds-progress__fill"
          style={indeterminate ? undefined : { width: `${v}%` }}
        />
      </div>
    </div>
  );
}
