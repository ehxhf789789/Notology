import { forwardRef, type TextareaHTMLAttributes } from 'react';

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
  noResize?: boolean;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { invalid, noResize, disabled, className, ...rest },
  ref,
) {
  const fieldCls = [
    'ds-field',
    'ds-field--md',
    invalid ? 'ds-field--invalid' : '',
    disabled ? 'ds-field--disabled' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <span className={fieldCls}>
      <textarea
        ref={ref}
        disabled={disabled}
        aria-invalid={invalid || undefined}
        className={`ds-textarea${noResize ? ' ds-textarea--no-resize' : ''}`}
        {...rest}
      />
    </span>
  );
});
