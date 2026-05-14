import type { HTMLAttributes, ReactNode } from 'react';

export type BadgeVariant = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info';
export type BadgeSize = 'sm' | 'md';

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
  size?: BadgeSize;
  outline?: boolean;
  /** Renders as a small colored dot (no text). */
  dot?: boolean;
  icon?: ReactNode;
}

export function Badge({
  variant = 'neutral',
  size = 'md',
  outline,
  dot,
  icon,
  className,
  children,
  ...rest
}: BadgeProps) {
  const cls = [
    'ds-badge',
    `ds-badge--${variant}`,
    `ds-badge--${size}`,
    outline ? 'ds-badge--outline' : '',
    dot ? 'ds-badge--dot' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  if (dot) {
    return <span className={cls} aria-hidden="true" {...rest} />;
  }
  return (
    <span className={cls} {...rest}>
      {icon}
      {children}
    </span>
  );
}
