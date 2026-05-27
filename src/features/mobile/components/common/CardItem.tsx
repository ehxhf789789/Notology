/**
 * CardItem — Universal list card with icon, title, subtitle, trailing.
 * padding 16px, radius 12px, shadow xs. Hover: shadow sm + translateY(-1px).
 */
import type { ReactNode } from 'react';

interface Props {
  icon?: ReactNode;
  title: string;
  subtitle?: string;
  trailing?: ReactNode;
  colorAccent?: string;
  onPress?: () => void;
  className?: string;
  style?: React.CSSProperties;
}

export function CardItem({ icon, title, subtitle, trailing, colorAccent, onPress, className, style }: Props) {
  return (
    <button
      className={`m-card-item ${className ?? ''}`}
      onClick={onPress}
      style={style}
    >
      {colorAccent && <span className="m-card-item-bar" style={{ background: colorAccent }} />}
      {icon && <span className="m-card-item-icon">{icon}</span>}
      <div className="m-card-item-body">
        <span className="m-card-item-title">{title}</span>
        {subtitle && <span className="m-card-item-subtitle">{subtitle}</span>}
      </div>
      {trailing && <span className="m-card-item-trailing">{trailing}</span>}
    </button>
  );
}
