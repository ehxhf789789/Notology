/**
 * EmptyState — Centered empty placeholder with optional action.
 */
import type { ReactNode } from 'react';

interface Props {
  icon?: ReactNode;
  title: string;
  description?: string;
  actionLabel?: string;
  onAction?: () => void;
}

export function EmptyState({ icon, title, description, actionLabel, onAction }: Props) {
  return (
    <div className="m-empty-state">
      {icon && <div className="m-empty-state-icon">{icon}</div>}
      <p className="m-empty-state-title">{title}</p>
      {description && <p className="m-empty-state-desc">{description}</p>}
      {actionLabel && onAction && (
        <button className="m-empty-state-action" onClick={onAction}>{actionLabel}</button>
      )}
    </div>
  );
}
