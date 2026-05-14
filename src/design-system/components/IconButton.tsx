import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';

export type IconButtonVariant = 'ghost' | 'subtle' | 'primary';
export type IconButtonSize = 'sm' | 'md' | 'lg';

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label'> {
  icon: ReactNode;
  /** Required: every icon-only button needs an accessible name. */
  'aria-label': string;
  variant?: IconButtonVariant;
  size?: IconButtonSize;
  pressed?: boolean;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  {
    icon,
    variant = 'ghost',
    size = 'md',
    pressed,
    className,
    type = 'button',
    ...rest
  },
  ref,
) {
  const cls = [
    'ds-icon-btn',
    `ds-icon-btn--${variant}`,
    `ds-icon-btn--${size}`,
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      ref={ref}
      type={type}
      className={cls}
      aria-pressed={pressed}
      {...rest}
    >
      {icon}
    </button>
  );
});
