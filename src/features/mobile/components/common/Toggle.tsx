/**
 * Toggle — iOS-style switch (51x31px).
 * Knob slides with spring easing, press widens knob.
 */
interface Props {
  value: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}

export function Toggle({ value, onChange, disabled }: Props) {
  return (
    <button
      className={`m-toggle ${value ? 'm-toggle--on' : ''} ${disabled ? 'm-toggle--disabled' : ''}`}
      onClick={() => !disabled && onChange(!value)}
      role="switch"
      aria-checked={value}
    >
      <span className="m-toggle-knob" />
    </button>
  );
}
