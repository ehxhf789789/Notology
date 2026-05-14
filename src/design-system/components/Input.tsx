import { forwardRef, type InputHTMLAttributes, type ReactNode } from 'react';

export type InputSize = 'sm' | 'md' | 'lg';

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  /** Visual size (renamed from native size attr — use `htmlSize` to set the actual size attribute). */
  size?: InputSize;
  htmlSize?: number;
  invalid?: boolean;
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  {
    size = 'md',
    htmlSize,
    invalid,
    leftIcon,
    rightIcon,
    disabled,
    className,
    type = 'text',
    ...rest
  },
  ref,
) {
  const fieldCls = [
    'ds-field',
    `ds-field--${size}`,
    invalid ? 'ds-field--invalid' : '',
    disabled ? 'ds-field--disabled' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <span className={fieldCls}>
      {leftIcon && <span className="ds-field__icon">{leftIcon}</span>}
      <input
        ref={ref}
        type={type}
        size={htmlSize}
        disabled={disabled}
        aria-invalid={invalid || undefined}
        className="ds-input"
        {...rest}
      />
      {rightIcon && <span className="ds-field__icon">{rightIcon}</span>}
    </span>
  );
});
