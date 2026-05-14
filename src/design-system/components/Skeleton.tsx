import type { CSSProperties, HTMLAttributes } from 'react';

export type SkeletonVariant = 'rect' | 'text' | 'circle';
export type SkeletonRadius = 'sm' | 'md' | 'lg' | 'full';

export interface SkeletonProps extends HTMLAttributes<HTMLDivElement> {
  width?: number | string;
  height?: number | string;
  variant?: SkeletonVariant;
  radius?: SkeletonRadius;
}

export function Skeleton({
  width,
  height,
  variant = 'rect',
  radius,
  className,
  style,
  ...rest
}: SkeletonProps) {
  const variantCls =
    variant === 'text' ? 'ds-skeleton--text' :
    variant === 'circle' ? 'ds-skeleton--circle' :
    '';
  const radiusCls = radius ? `ds-skeleton--${radius}` : '';
  const cls = ['ds-skeleton', variantCls, radiusCls, className ?? '']
    .filter(Boolean)
    .join(' ');

  const inline: CSSProperties = { ...style };
  if (width !== undefined)  inline.width  = typeof width  === 'number' ? `${width}px`  : width;
  if (height !== undefined) inline.height = typeof height === 'number' ? `${height}px` : height;

  return <div className={cls} style={inline} aria-busy="true" aria-live="polite" {...rest} />;
}
