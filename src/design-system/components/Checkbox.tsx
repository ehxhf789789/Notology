import { forwardRef, useEffect, useRef, type InputHTMLAttributes, type ReactNode } from 'react';

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label?: ReactNode;
  description?: ReactNode;
  indeterminate?: boolean;
}

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { label, description, indeterminate, disabled, className, id, ...rest },
  ref,
) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.indeterminate = !!indeterminate;
    }
  }, [indeterminate]);

  const setRefs = (el: HTMLInputElement | null) => {
    inputRef.current = el;
    if (typeof ref === 'function') ref(el);
    else if (ref) ref.current = el;
  };

  const cls = ['ds-check', 'ds-checkbox', className ?? ''].filter(Boolean).join(' ');

  return (
    <label className={cls} data-disabled={disabled ? 'true' : undefined} htmlFor={id}>
      <input
        ref={setRefs}
        type="checkbox"
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
