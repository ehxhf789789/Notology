import type { ReactNode } from 'react';

export interface EmptyStateProps {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  /** Typically a `<Button>`. */
  action?: ReactNode;
  className?: string;
}

export function EmptyState({ icon, title, description, action, className }: EmptyStateProps) {
  const cls = ['ds-empty', className ?? ''].filter(Boolean).join(' ');
  return (
    <div className={cls} role="status">
      {icon && <div className="ds-empty__icon" aria-hidden="true">{icon}</div>}
      <div className="ds-empty__title">{title}</div>
      {description && <div className="ds-empty__desc">{description}</div>}
      {action && <div className="ds-empty__action">{action}</div>}
    </div>
  );
}
