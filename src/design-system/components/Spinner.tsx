import type { HTMLAttributes } from 'react';

export type SpinnerSize = 'sm' | 'md' | 'lg';

export interface SpinnerProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'aria-label'> {
  size?: SpinnerSize;
  /** Screen-reader label. Defaults to "Loading". */
  'aria-label'?: string;
}

export function Spinner({
  size = 'md',
  className,
  'aria-label': ariaLabel = 'Loading',
  ...rest
}: SpinnerProps) {
  const cls = ['ds-spinner', `ds-spinner--${size}`, className ?? ''].filter(Boolean).join(' ');
  return (
    <span
      className={cls}
      role="progressbar"
      aria-label={ariaLabel}
      aria-valuetext="Loading"
      {...rest}
    />
  );
}
