import { forwardRef, type HTMLAttributes } from 'react';

export type CardDensity = 'compact' | 'cozy' | 'spacious';

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  interactive?: boolean;
  selected?: boolean;
  density?: CardDensity;
  as?: 'div' | 'article' | 'section' | 'li';
}

export const Card = forwardRef<HTMLDivElement, CardProps>(function Card(
  {
    interactive,
    selected,
    density = 'cozy',
    as: Tag = 'div',
    className,
    children,
    tabIndex,
    role,
    ...rest
  },
  ref,
) {
  const cls = [
    'ds-card',
    `ds-card--${density}`,
    interactive ? 'ds-card--interactive' : '',
    selected ? 'ds-card--selected' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  const resolvedTabIndex = interactive && tabIndex === undefined ? 0 : tabIndex;
  const resolvedRole = interactive && !role ? 'button' : role;

  // forwardRef typing is permissive for `as` here — Tag accepts the same div ref shape.
  const Component = Tag as 'div';
  return (
    <Component
      ref={ref}
      className={cls}
      tabIndex={resolvedTabIndex}
      role={resolvedRole}
      aria-pressed={interactive && selected ? true : undefined}
      {...rest}
    >
      {children}
    </Component>
  );
});
