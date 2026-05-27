/**
 * TextInput — Styled input with focus accent border and optional error.
 */
import { forwardRef } from 'react';

interface Props extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
}

export const TextInput = forwardRef<HTMLInputElement, Props>(
  ({ label, error, className, ...rest }, ref) => {
    return (
      <div className={`m-text-input-wrapper ${error ? 'm-text-input-wrapper--error' : ''}`}>
        {label && <label className="m-text-input-label">{label}</label>}
        <input
          ref={ref}
          className={`m-text-input ${className ?? ''}`}
          {...rest}
        />
        {error && <span className="m-text-input-error">{error}</span>}
      </div>
    );
  }
);
