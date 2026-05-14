import { forwardRef, type InputHTMLAttributes, type ReactNode } from 'react';

export type ToggleSize = 'sm' | 'md';

export interface ToggleProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'size'> {
  label?: ReactNode;
  description?: ReactNode;
  size?: ToggleSize;
}

export const Toggle = forwardRef<HTMLInputElement, ToggleProps>(function Toggle(
  { label, description, size = 'md', disabled, className, id, role = 'switch', ...rest },
  ref,
) {
  const cls = ['ds-toggle', `ds-toggle--${size}`, className ?? ''].filter(Boolean).join(' ');

  return (
    <label className={cls} data-disabled={disabled ? 'true' : undefined} htmlFor={id}>
      <input
        ref={ref}
        type="checkbox"
        role={role}
        disabled={disabled}
        className="ds-toggle__input"
        id={id}
        {...rest}
      />
      <span className="ds-toggle__track" aria-hidden="true">
        <span className="ds-toggle__thumb" />
      </span>
      {(label || description) && (
        <span className="ds-toggle__body">
          {label && <span className="ds-toggle__label">{label}</span>}
          {description && <span className="ds-toggle__desc">{description}</span>}
        </span>
      )}
    </label>
  );
});
