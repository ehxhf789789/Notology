import { forwardRef, type InputHTMLAttributes, type ReactNode } from 'react';

export interface RadioProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label?: ReactNode;
  description?: ReactNode;
}

export const Radio = forwardRef<HTMLInputElement, RadioProps>(function Radio(
  { label, description, disabled, className, id, ...rest },
  ref,
) {
  const cls = ['ds-check', 'ds-radio', className ?? ''].filter(Boolean).join(' ');

  return (
    <label className={cls} data-disabled={disabled ? 'true' : undefined} htmlFor={id}>
      <input
        ref={ref}
        type="radio"
        disabled={disabled}
        className="ds-check__input"
        id={id}
        {...rest}
      />
      <span className="ds-check__box" aria-hidden="true" />
      {(label || description) && (
        <span className="ds-check__body">
          {label && <span className="ds-check__label">{label}</span>}
          {description && <span className="ds-check__desc">{description}</span>}
        </span>
      )}
    </label>
  );
});
